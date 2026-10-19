import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { AboxError } from '../errors.js';

/** The part of an MCP server entry that setup owns. */
export interface McpEntry {
  command: string;
  args: string[];
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isRecord(a) && isRecord(b) && !(a instanceof Date) && !(b instanceof Date)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false } as const;

/** Parses JSON with comments and trailing commas. Throws when the file is broken (it is never touched then). */
export function parseJsonc(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { ...PARSE_OPTIONS, allowEmptyContent: true });
  if (errors.length > 0) {
    throw new AboxError('invalid_input', `${file} is not valid JSON (with comments)`, {
      hint: 'Fix the file by hand first; setup does not touch a file it cannot parse.',
    });
  }
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new AboxError('unsupported', `${file} does not contain a JSON object at the top level`, {
      hint: 'Setup only edits files whose top level is an object.',
    });
  }
  return value;
}

export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function indentUnit(text: string): string {
  let indent = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    if (m[1]!.startsWith('\t')) return '\t';
    const n = m[1]!.length;
    if (indent === 0 || n < indent) indent = n;
  }
  return ' '.repeat(indent > 0 ? indent : 2);
}

function serversOf(
  root: Record<string, unknown>,
  key: string,
  file: string,
): Record<string, unknown> | undefined {
  const s = root[key];
  if (s === undefined) return undefined;
  if (!isRecord(s))
    throw new AboxError('unsupported', `"${key}" in ${file} is not an object`, {
      hint: 'Fix or remove that value by hand; setup does not guess.',
    });
  return s;
}

/** The server entries of a config file: name -> raw entry. */
export function jsonServers(
  text: string,
  key: string,
  file: string,
): Record<string, unknown> | undefined {
  return serversOf(parseJsonc(text, file), key, file);
}

/** JSON text of `value`: objects one key per line, arrays of scalars on one line. */
function pretty(value: unknown, indent: string, unit: string, eol: string): string {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const inner = indent + unit;
    const lines = keys.map(
      (k) => `${inner}${JSON.stringify(k)}: ${pretty(value[k], inner, unit, eol)}`,
    );
    return `{${eol}${lines.join(`,${eol}`)}${eol}${indent}}`;
  }
  return JSON.stringify(value);
}

function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, offset))![0];
}

function startsOwnLine(text: string, offset: number): boolean {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(start, offset).trim() === '';
}

function treeOf(text: string, file: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, PARSE_OPTIONS);
  if (errors.length > 0 || !root || root.type !== 'object') {
    throw new AboxError('invalid_input', `${file} is not a JSON object`, {
      hint: 'Fix the file by hand first.',
    });
  }
  return root;
}

/** Adds `"name": value` as the last property of an object node, leaving everything else alone. */
function insertProperty(
  text: string,
  obj: Node,
  name: string,
  value: unknown,
  unit: string,
  eol: string,
): string {
  const parentIndent = lineIndent(text, obj.offset);
  const first = obj.children?.[0];
  const childIndent =
    first && startsOwnLine(text, first.offset)
      ? lineIndent(text, first.offset)
      : parentIndent + unit;
  const prop = `${JSON.stringify(name)}: ${pretty(value, childIndent, unit, eol)}`;
  const last = obj.children?.[obj.children.length - 1];
  if (!last) {
    const open = text.slice(obj.offset, obj.offset + obj.length);
    // keep a comment inside an empty object where it is: only a bare `{ }` is rewritten
    if (open.replace(/\s+/g, '') === '{}') {
      return `${text.slice(0, obj.offset)}{${eol}${childIndent}${prop}${eol}${parentIndent}}${text.slice(obj.offset + obj.length)}`;
    }
    const close = obj.offset + obj.length - 1;
    return `${text.slice(0, close)}${childIndent}${prop}${eol}${parentIndent}${text.slice(close)}`;
  }
  const end = last.offset + last.length;
  // a comma and a comment on the same line belong to the last property: the new one goes below them
  let pos = end;
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  const trailingComma = text[pos] === ',';
  if (trailingComma) pos++;
  const afterValue = pos;
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  if (text.startsWith('//', pos)) {
    while (pos < text.length && text[pos] !== '\n' && text[pos] !== '\r') pos++;
  } else if (text.startsWith('/*', pos)) {
    const close = text.indexOf('*/', pos + 2);
    if (close >= 0 && !text.slice(pos, close).includes('\n')) pos = close + 2;
    else pos = afterValue;
  } else {
    pos = afterValue;
  }
  if (trailingComma) {
    return `${text.slice(0, pos)}${eol}${childIndent}${prop},${text.slice(pos)}`;
  }
  return `${text.slice(0, end)},${text.slice(end, pos)}${eol}${childIndent}${prop}${text.slice(pos)}`;
}

/**
 * Sets `<key>.<name>` to `entry`. Unrelated entries, comments and formatting stay byte for byte;
 * when the entry exists only `command` and `args` change (extra fields such as `env` stay).
 */
export function jsonSetServer(
  text: string,
  key: string,
  name: string,
  entry: McpEntry,
  file: string,
): string {
  const eol = detectEol(text);
  if (text.trim() === '') {
    return `{${eol}  ${JSON.stringify(key)}: ${pretty({ [name]: entry }, '  ', '  ', eol)}${eol}}${eol}`;
  }
  const rootValue = parseJsonc(text, file);
  const unit = indentUnit(text);
  const existing = serversOf(rootValue, key, file)?.[name];
  const root = treeOf(text, file);
  if (rootValue[key] === undefined)
    return insertProperty(text, root, key, { [name]: entry }, unit, eol);
  const servers = findNodeAtLocation(root, [key])!;
  if (existing === undefined) return insertProperty(text, servers, name, entry, unit, eol);
  if (!isRecord(existing))
    throw new AboxError('unsupported', `"${key}.${name}" in ${file} is not an object`, {
      hint: 'Fix or remove that entry by hand.',
    });
  let t = text;
  for (const prop of ['args', 'command'] as const) {
    if (deepEqual(existing[prop], entry[prop])) continue;
    const tree = treeOf(t, file);
    const node = findNodeAtLocation(tree, [key, name, prop]);
    if (node) {
      t = `${t.slice(0, node.offset)}${pretty(entry[prop], lineIndent(t, node.offset), unit, eol)}${t.slice(node.offset + node.length)}`;
    } else {
      t = insertProperty(t, findNodeAtLocation(tree, [key, name])!, prop, entry[prop], unit, eol);
    }
  }
  return t;
}

/**
 * Removes the whole line(s) of a property that sits alone on its line, with its comma and a comment
 * on the same line, and the comma of the previous property when this one was the last without one.
 * That is exactly what `jsonSetServer` inserted, so a set followed by a remove restores the text.
 * Undefined when the property shares its line with other things.
 */
function removeOwnLines(text: string, obj: Node, name: string): string | undefined {
  const props = obj.children ?? [];
  const idx = props.findIndex((p) => p.children?.[0]?.value === name);
  const prop = props[idx];
  if (!prop || !startsOwnLine(text, prop.offset)) return undefined;
  let pos = prop.offset + prop.length;
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  const comma = text[pos] === ',';
  if (comma) pos++;
  const afterComma = pos;
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  if (text.startsWith('//', pos)) {
    while (pos < text.length && text[pos] !== '\n' && text[pos] !== '\r') pos++;
  } else if (text.startsWith('/*', pos)) {
    const close = text.indexOf('*/', pos + 2);
    if (close < 0 || text.slice(pos, close).includes('\n')) return undefined;
    pos = close + 2;
    while (text[pos] === ' ' || text[pos] === '\t') pos++;
  } else {
    pos = afterComma;
    while (text[pos] === ' ' || text[pos] === '\t') pos++;
  }
  if (pos < text.length && text[pos] !== '\n' && text[pos] !== '\r') return undefined;
  const lineStart = text.lastIndexOf('\n', prop.offset - 1) + 1;
  let lineEnd = pos;
  if (text[lineEnd] === '\r') lineEnd++;
  if (text[lineEnd] === '\n') lineEnd++;
  let out = text.slice(0, lineStart) + text.slice(lineEnd);
  if (props.length === 1) {
    // the container is empty now: `{}` again, as it was when setup first filled it
    const newEnd = obj.offset + obj.length - (lineEnd - lineStart);
    if (out.slice(obj.offset + 1, newEnd - 1).trim() === '')
      out = `${out.slice(0, obj.offset)}{}${out.slice(newEnd)}`;
  }
  if (!comma && idx > 0) {
    const prev = props[idx - 1]!;
    let p = prev.offset + prev.length;
    while (text[p] === ' ' || text[p] === '\t') p++;
    if (text[p] === ',') out = out.slice(0, p) + out.slice(p + 1);
  }
  return out;
}

/** Removes `<key>.<name>` (the empty container stays). Text unchanged when it is not there. */
export function jsonRemoveServer(text: string, key: string, name: string, file: string): string {
  const root = parseJsonc(text, file);
  if (serversOf(root, key, file)?.[name] === undefined) return text;
  const servers = findNodeAtLocation(treeOf(text, file), [key]);
  const own = servers ? removeOwnLines(text, servers, name) : undefined;
  if (own !== undefined) return own;
  return applyEdits(text, modify(text, [key, name], undefined, {}));
}

/** Does the raw entry run `<command> mcp serve`? (For finding duplicates under another name.) */
export function runsAboxMcp(entry: unknown, command: string): boolean {
  if (!isRecord(entry)) return false;
  const c = entry['command'];
  const a = entry['args'];
  if (typeof c !== 'string' || !Array.isArray(a)) return false;
  const base = c.split(/[\\/]/).pop() ?? c;
  const wanted = command.split(/[\\/]/).pop() ?? command;
  if (base !== 'abox' && base !== wanted) return false;
  const i = a.indexOf('mcp');
  return i >= 0 && a[i + 1] === 'serve';
}

/** True when the entry's own command/args are what setup would write. */
export function entryMatches(entry: unknown, want: McpEntry): boolean {
  return (
    isRecord(entry) && entry['command'] === want.command && deepEqual(entry['args'], want.args)
  );
}

/** The document has no content beyond an empty server container (what setup leaves after a removal). */
export function jsonIsEmptySkeleton(text: string, key: string, file: string): boolean {
  const root = parseJsonc(text, file);
  const keys = Object.keys(root);
  if (keys.length === 0) return true;
  if (keys.length !== 1 || keys[0] !== key) return false;
  const s = root[key];
  return isRecord(s) && Object.keys(s).length === 0;
}
