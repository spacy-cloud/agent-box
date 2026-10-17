/**
 * Size limits of the MCP surface, in one place so the tool schema, the stdio framing, the HTTP body
 * limit and the documentation agree.
 *
 * A file travels inside one JSON-RPC message: `sandbox_write_file` content (UTF-8 text, or base64 which
 * is 4/3 of the bytes) plus JSON escaping. The SDK's stdio reader gives up on - and closes - a
 * connection whose message exceeds its buffer, so a message must never get that big unnoticed.
 */
const MiB = 1024 * 1024;

/** Largest file `sandbox_write_file` writes, in bytes of the decoded content. Bigger: workspace or `sandbox_exec`. */
export const WRITE_FILE_MAX_BYTES = 8 * MiB;

/** Zod length cap of the `content` string: base64 of `WRITE_FILE_MAX_BYTES` (the larger encoding). */
export const WRITE_CONTENT_MAX_CHARS = Math.ceil(WRITE_FILE_MAX_BYTES / 3) * 4;

/**
 * Largest single message accepted over stdio and as an HTTP request body. Room for `WRITE_FILE_MAX_BYTES`
 * of text that needs JSON escaping (up to 4x for typical non-ASCII/control-heavy content); a message above
 * it is answered with an `invalid_input` error instead of ending the connection.
 */
export const MAX_MESSAGE_BYTES = 32 * MiB;

export const BIG_FILE_HINT =
  'For big files put them into the project workspace before the sandbox is created (copy/clone/worktree), create them inside the sandbox with sandbox_exec, or ask the human to copy them in (abox cp).';
