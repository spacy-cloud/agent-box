/**
 * Best-effort masking of known secret values in text coming out of a sandbox (logs,
 * command output). Replaces each value and common encodings of it with `***`:
 * the raw value, URL-encoded and JSON-escaped forms, base64 / base64url (including
 * the infix forms that appear when the value is embedded at any byte offset), and
 * the HTTP basic form `base64("x-access-token:" + value)`.
 *
 * Limitations: values shorter than 6 characters are ignored (they would mask ordinary
 * text); other encodings (hex, gzip, split output, obfuscation by the sandbox) are not
 * detected. This is a safety net, not a guarantee.
 */
export const MIN_MASKED_LENGTH = 6;
const MASK = '***';

function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_');
}

function base64Infixes(data: Buffer): string[] {
  const out: string[] = [];
  // complete encoding including padding
  out.push(data.toString('base64'));
  out.push(toUrlSafe(data.toString('base64')));
  out.push(toUrlSafe(data.toString('base64')).replace(/=+$/, ''));
  // value embedded at byte offset 0,1,2 of a longer base64 stream: only the characters
  // that are fully determined by the value bytes are stable
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), data])
      .toString('base64')
      .replace(/=+$/, '');
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + data.length)) / 6);
    const part = enc.slice(start, end);
    if (part.length >= MIN_MASKED_LENGTH) {
      out.push(part, toUrlSafe(part));
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** Returns all strings that should be masked for one secret value. */
export function secretForms(value: string): string[] {
  if (value.length < MIN_MASKED_LENGTH) return [];
  const forms = new Set<string>([value]);
  const url = encodeURIComponent(value);
  if (url !== value) forms.add(url);
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value) forms.add(json);
  for (const f of base64Infixes(Buffer.from(value, 'utf8'))) forms.add(f);
  for (const f of base64Infixes(Buffer.from(`x-access-token:${value}`, 'utf8'))) forms.add(f);
  return [...forms].filter((f) => f.length >= MIN_MASKED_LENGTH);
}

/** Creates a masking function for the given secret values. */
export function createSecretMasker(values: string[]): (text: string) => string {
  const needles = new Set<string>();
  for (const v of values) for (const f of secretForms(v)) needles.add(f);
  if (needles.size === 0) return (text) => text;
  const sorted = [...needles].sort((a, b) => b.length - a.length);
  const re = new RegExp(sorted.map(escapeRe).join('|'), 'g');
  return (text) => text.replace(re, MASK);
}
