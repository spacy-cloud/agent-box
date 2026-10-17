// @ts-check
/**
 * Text helpers: sanitising untrusted strings, shell quoting for text that is typed into a terminal,
 * and fitting text into Orca's notification limits (title 120, body 1000 characters).
 */

export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_BODY_MAX = 1000;
/** Orca's limit for one `terminal.sendText` call is 4096 characters. */
export const TERMINAL_TEXT_MAX = 4096;

// C0 and C1 controls, DEL, bidi overrides/isolates, line/paragraph separators, zero-width characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Makes a string safe to show in a notification: no control or bidi characters, single line,
 * bounded length. Use it for everything that comes from outside the plugin (sandbox names, abox
 * messages, paths). Agent-written approval reasons are not shown at all.
 * @param {unknown} value
 * @param {number} [max]
 */
export function sanitizeInline(value, max = 200) {
  const text = String(value ?? '')
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * @param {string} title
 * @param {string[] | string} body
 */
export function fitNotification(title, body) {
  const bodyText = Array.isArray(body) ? body.join('\n') : body;
  return {
    title: sanitizeInline(title, NOTIFICATION_TITLE_MAX),
    body:
      bodyText.length > NOTIFICATION_BODY_MAX
        ? `${bodyText.slice(0, NOTIFICATION_BODY_MAX - 1)}…`
        : bodyText,
  };
}

/**
 * POSIX single-quote quoting for one word. Throws on NUL and newlines: text that is typed into a
 * terminal must never contain a character that acts as Enter.
 * @param {string} word
 */
export function shellQuote(word) {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\r\n]/.test(word)) throw new Error('cannot quote a value with NUL or line breaks');
  if (word.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Joins already-safe shell words. Each element is either a plain string that gets quoted, or
 * `{raw: '...'}` for a shell fragment the plugin wrote itself (for example `"$PWD"`).
 * @param {Array<string | {raw: string}>} words
 */
export function shellLine(words) {
  return words.map((w) => (typeof w === 'string' ? shellQuote(w) : w.raw)).join(' ');
}

/**
 * Text may be typed into a terminal only if it is a single printable line. This is the guard that
 * keeps a sandbox name or path from smuggling an Enter (or an escape sequence) into the terminal.
 * @param {string} text
 */
export function isTypableLine(text) {
  return (
    text.length > 0 &&
    text.length <= TERMINAL_TEXT_MAX &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)
  );
}

/** @param {number | null | undefined} ms */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '?';
  if (ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

/**
 * Short id for lists: `local/ab12cd34` stays as is (it is already short).
 * @param {string} id
 */
export function shortId(id) {
  return sanitizeInline(id, 40);
}
