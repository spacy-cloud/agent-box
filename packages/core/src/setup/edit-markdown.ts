import { AboxError } from '../errors.js';
import { detectEol } from './edit-json.js';

/**
 * The rules snippet in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` sits between two marker comments, so
 * setup can update or remove exactly its own text and never touches what the user wrote.
 */
export const RULES_BEGIN =
  '<!-- abox:begin - managed by "abox setup"; remove it with "abox setup --uninstall" -->';
export const RULES_END = '<!-- abox:end -->';

const BEGIN_RE = /^<!-- abox:begin\b.*-->[ \t]*$/m;

interface Found {
  start: number;
  end: number;
}

function find(text: string, file: string): Found | undefined {
  const b = BEGIN_RE.exec(text);
  const endAt = text.indexOf(RULES_END);
  if (!b) {
    if (endAt >= 0) throw broken(file);
    return undefined;
  }
  if (endAt < b.index) throw broken(file);
  if (
    BEGIN_RE.exec(text.slice(endAt + RULES_END.length)) ||
    text.indexOf(RULES_END, endAt + 1) >= 0
  )
    throw broken(file);
  let end = endAt + RULES_END.length;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  return { start: b.index, end };
}

function broken(file: string): AboxError {
  return new AboxError('unsupported', `the abox rules block in ${file} is damaged`, {
    hint: 'It needs exactly one "<!-- abox:begin ... -->" and one "<!-- abox:end -->" line. Fix or remove the block by hand.',
  });
}

export function hasRulesBlock(text: string, file: string): boolean {
  return find(text, file) !== undefined;
}

export function blockText(rules: string, eol: string): string {
  return `${RULES_BEGIN}${eol}${rules.trimEnd().replace(/\r?\n/g, eol)}${eol}${RULES_END}${eol}`;
}

/** Adds the block at the end, or replaces the existing one in place. */
export function upsertRulesBlock(text: string, rules: string, file: string): string {
  const eol = detectEol(text);
  const block = blockText(rules, eol);
  const found = find(text, file);
  if (found) return text.slice(0, found.start) + block + text.slice(found.end);
  let out = text;
  if (out !== '' && !out.endsWith('\n')) out += eol;
  if (out.trim() !== '') out += eol;
  return out + block;
}

/** Removes the block and the blank line that separated it. Unchanged when there is none. */
export function removeRulesBlock(text: string, file: string): string {
  const found = find(text, file);
  if (!found) return text;
  let before = text.slice(0, found.start);
  const after = text.slice(found.end);
  const blankBefore = /\r?\n\r?\n$/.test(before);
  if (blankBefore && (after.trim() === '' || /^\r?\n/.test(after))) {
    before = before.replace(/\r?\n$/, '');
  }
  return before + after;
}
