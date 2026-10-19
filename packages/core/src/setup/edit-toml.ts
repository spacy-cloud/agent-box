import { parse as parseToml } from 'smol-toml';
import { AboxError } from '../errors.js';
import { detectEol, isRecord } from './edit-json.js';

/**
 * Minimal, comment-preserving TOML editing for exactly one thing: the `[mcp_servers.<name>]` table
 * of Codex's config. The text is scanned (strings, comments, arrays and inline tables are skipped
 * correctly) to find statements; only the bytes of that table are touched. Anything setup cannot
 * place with certainty (the entry written as an inline table or dotted keys) is refused. The result
 * is verified with a real TOML parser by the caller.
 */

interface Statement {
  kind: 'header' | 'kv';
  /** Header path, or the key path of a key/value line. */
  path: string[];
  start: number;
  /** After the line break. */
  end: number;
  /** `[[array.of.tables]]` */
  array: boolean;
}

function fail(file: string, why: string): never {
  throw new AboxError('unsupported', `cannot edit ${file} safely: ${why}`, {
    hint: 'Edit the file by hand (setup prints the entry it would write).',
  });
}

const BARE = /[A-Za-z0-9_-]/;

class Scanner {
  i = 0;
  constructor(
    readonly t: string,
    readonly file: string,
  ) {}

  private skipSpaces(): void {
    while (this.i < this.t.length && (this.t[this.i] === ' ' || this.t[this.i] === '\t')) this.i++;
  }

  private skipToEol(): void {
    while (this.i < this.t.length && this.t[this.i] !== '\n') this.i++;
  }

  private keyPart(): string {
    const c = this.t[this.i];
    if (c === '"') {
      const start = this.i;
      this.i++;
      while (this.i < this.t.length && this.t[this.i] !== '"') {
        if (this.t[this.i] === '\\') this.i++;
        if (this.t[this.i] === '\n') fail(this.file, 'a key with an unterminated string');
        this.i++;
      }
      this.i++;
      const raw = this.t.slice(start, this.i);
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw.slice(1, -1);
      }
    }
    if (c === "'") {
      const end = this.t.indexOf("'", this.i + 1);
      if (end < 0) fail(this.file, 'a key with an unterminated string');
      const part = this.t.slice(this.i + 1, end);
      this.i = end + 1;
      return part;
    }
    const start = this.i;
    while (this.i < this.t.length && BARE.test(this.t[this.i]!)) this.i++;
    if (this.i === start) fail(this.file, `unexpected character at offset ${this.i}`);
    return this.t.slice(start, this.i);
  }

  private keyPath(): string[] {
    const out: string[] = [];
    for (;;) {
      this.skipSpaces();
      out.push(this.keyPart());
      this.skipSpaces();
      if (this.t[this.i] === '.') {
        this.i++;
        continue;
      }
      return out;
    }
  }

  /** Skips a value up to the end of its last line (not consuming the line break). */
  private skipValue(): void {
    const t = this.t;
    let depth = 0;
    while (this.i < t.length) {
      const c = t[this.i]!;
      if (c === '\n') {
        if (depth === 0) return;
        this.i++;
      } else if (c === '#') {
        this.skipToEol();
      } else if (c === '"' || c === "'") {
        const triple = t.startsWith(c.repeat(3), this.i);
        if (triple) {
          const close = c.repeat(3);
          let j = this.i + 3;
          for (;;) {
            if (j >= t.length) fail(this.file, 'an unterminated multi-line string');
            if (c === '"' && t[j] === '\\') {
              j += 2;
              continue;
            }
            if (t.startsWith(close, j)) {
              j += 3;
              while (t[j] === c) j++; // up to two extra quotes belong to the string
              break;
            }
            j++;
          }
          this.i = j;
        } else {
          let j = this.i + 1;
          while (j < t.length && t[j] !== c && t[j] !== '\n') {
            if (c === '"' && t[j] === '\\') j++;
            j++;
          }
          if (t[j] !== c) fail(this.file, 'an unterminated string');
          this.i = j + 1;
        }
      } else if (c === '[' || c === '{') {
        depth++;
        this.i++;
      } else if (c === ']' || c === '}') {
        depth--;
        this.i++;
      } else {
        this.i++;
      }
    }
  }

  statements(): Statement[] {
    const t = this.t;
    const out: Statement[] = [];
    while (this.i < t.length) {
      const start = this.i;
      this.skipSpaces();
      const c = t[this.i];
      if (c === undefined) break;
      if (c === '\n' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '#') {
        this.skipToEol();
        continue;
      }
      if (c === '[') {
        const array = t[this.i + 1] === '[';
        this.i += array ? 2 : 1;
        const path = this.keyPath();
        this.skipSpaces();
        if (t[this.i] !== ']' || (array && t[this.i + 1] !== ']'))
          fail(this.file, 'a bad table header');
        this.i += array ? 2 : 1;
        this.skipSpaces();
        if (t[this.i] === '#') this.skipToEol();
        if (this.i < t.length && t[this.i] !== '\n' && t[this.i] !== '\r')
          fail(this.file, 'text after a table header');
        if (t[this.i] === '\r') this.i++;
        if (t[this.i] === '\n') this.i++;
        out.push({ kind: 'header', path, start, end: this.i, array });
        continue;
      }
      const path = this.keyPath();
      this.skipSpaces();
      if (t[this.i] !== '=') fail(this.file, `a key without a value at offset ${this.i}`);
      this.i++;
      this.skipValue();
      if (t[this.i] === '\n') this.i++;
      out.push({ kind: 'kv', path, start, end: this.i, array: false });
    }
    return out;
  }
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.every((p, i) => path[i] === p);
}

const bareKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlString = (s: string): string => JSON.stringify(s);
const tomlArray = (a: string[]): string => `[${a.map(tomlString).join(', ')}]`;

export type TomlValue = string | string[];

function tomlValue(v: TomlValue): string {
  return Array.isArray(v) ? tomlArray(v) : tomlString(v);
}

/** Absolute key path of every key/value statement, with the table it sits in. */
function withTables(stmts: Statement[]): Array<{ s: Statement; abs: string[]; table: string[] }> {
  let table: string[] = [];
  const out: Array<{ s: Statement; abs: string[]; table: string[] }> = [];
  for (const s of stmts) {
    if (s.kind === 'header') {
      table = s.path;
      out.push({ s, abs: s.path, table: s.path });
    } else {
      out.push({ s, abs: [...table, ...s.path], table });
    }
  }
  return out;
}

/** The entry is written in a form that is not a plain `[a.b]` table (inline table, dotted keys from a parent). */
function ensureTableForm(
  stmts: Array<{ s: Statement; abs: string[]; table: string[] }>,
  target: string[],
  file: string,
): void {
  for (const { s, abs, table } of stmts) {
    if (s.kind !== 'kv' || startsWith(table, target)) continue;
    if (startsWith(abs, target) || startsWith(target, abs))
      fail(file, `"${target.join('.')}" is written as an inline table or with dotted keys`);
  }
}

const COMMENT = '# abox MCP server (added by "abox setup")';

/**
 * Creates or updates `[<tablePath>]` with `entries`. An existing table keeps its other keys and
 * sub-tables; only the given keys are replaced (or added).
 */
export function tomlUpsertTable(
  text: string,
  tablePath: string[],
  entries: Record<string, TomlValue>,
  file: string,
): string {
  const eol = detectEol(text);
  const all = withTables(new Scanner(text, file).statements());
  ensureTableForm(all, tablePath, file);
  const header = all.find(
    (x) =>
      x.s.kind === 'header' &&
      !x.s.array &&
      x.s.path.length === tablePath.length &&
      startsWith(x.s.path, tablePath),
  );
  if (!header) {
    let out = text;
    if (out !== '' && !out.endsWith('\n')) out += eol;
    if (out.trim() !== '') out += eol;
    out += `${COMMENT}${eol}[${tablePath.map(bareKey).join('.')}]${eol}`;
    for (const [k, v] of Object.entries(entries)) out += `${bareKey(k)} = ${tomlValue(v)}${eol}`;
    return out;
  }
  // the block of the table: up to the next header
  const blockEnd =
    all.find((x) => x.s.kind === 'header' && x.s.start > header.s.start)?.s.start ?? text.length;
  let out = text;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const insertAt = header.s.end;
  const missing: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    const kv = all.find(
      (x) =>
        x.s.kind === 'kv' &&
        x.s.start >= header.s.end &&
        x.s.start < blockEnd &&
        x.abs.length === tablePath.length + 1 &&
        startsWith(x.abs, tablePath) &&
        x.abs[tablePath.length] === k,
    );
    if (kv) {
      const indent = /^[ \t]*/.exec(text.slice(kv.s.start, kv.s.end))![0];
      const hadEol = text.slice(kv.s.start, kv.s.end).endsWith('\n');
      edits.push({
        start: kv.s.start,
        end: kv.s.end,
        text: `${indent}${bareKey(k)} = ${tomlValue(v)}${hadEol ? eol : ''}`,
      });
    } else {
      missing.push(k);
    }
  }
  if (missing.length > 0) {
    let add = missing.map((k) => `${bareKey(k)} = ${tomlValue(entries[k]!)}${eol}`).join('');
    if (!text.slice(0, insertAt).endsWith('\n')) add = eol + add;
    edits.push({ start: insertAt, end: insertAt, text: add });
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Removes `[<tablePath>]` and its sub-tables. Text unchanged when the table is not there. */
export function tomlRemoveTable(text: string, tablePath: string[], file: string): string {
  const all = withTables(new Scanner(text, file).statements());
  const headers = all.filter((x) => x.s.kind === 'header');
  const mine = headers.filter((h) => startsWith(h.s.path, tablePath));
  if (mine.length === 0) {
    ensureTableForm(all, tablePath, file);
    return text;
  }
  ensureTableForm(all, tablePath, file);
  const ranges: Array<[number, number]> = [];
  for (const h of mine) {
    const next = headers.find((x) => x.s.start > h.s.start);
    let start = h.s.start;
    const end = next?.s.start ?? text.length;
    // our own comment line right above the header goes with it
    const prev = text.lastIndexOf('\n', start - 2);
    const line = text.slice(prev + 1, start).replace(/\r?\n$/, '');
    if (line === COMMENT) start = prev + 1;
    ranges.push([start, end]);
  }
  let out = text;
  for (const [s, e] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, s) + out.slice(e);
  }
  // the blank line that separated our table from what came before
  if (ranges.length > 0) {
    const first = Math.min(...ranges.map((r) => r[0]));
    if (first >= out.length || out.slice(first).trim() === '') {
      out = out.slice(0, first).replace(/(\r?\n)\r?\n$/, '$1');
    } else if (/(\r?\n)\r?\n$/.test(out.slice(0, first)) && /^\s*\r?\n/.test(out.slice(first))) {
      out = out.slice(0, first).replace(/\r?\n$/, '') + out.slice(first);
    }
  }
  return out;
}

/** Parses a TOML document (throws a setup error when it is broken). */
export function parseTomlDoc(text: string, file: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new AboxError('invalid_input', `${file} is not valid TOML: ${(e as Error).message}`, {
      hint: 'Fix the file by hand first; setup does not touch a file it cannot parse.',
    });
  }
}

/** The `[<key>.<name>]` tables of a config: name -> raw entry. */
export function tomlServers(
  text: string,
  key: string,
  file: string,
): Record<string, unknown> | undefined {
  const doc = parseTomlDoc(text, file);
  const s = doc[key];
  if (s === undefined) return undefined;
  if (!isRecord(s)) fail(file, `"${key}" is not a table`);
  return s;
}

export function tomlIsEmptySkeleton(text: string, key: string, file: string): boolean {
  const doc = parseTomlDoc(text, file);
  const keys = Object.keys(doc);
  if (keys.length === 0) return true;
  return (
    keys.length === 1 && keys[0] === key && isRecord(doc[key]) && Object.keys(doc[key]).length === 0
  );
}
