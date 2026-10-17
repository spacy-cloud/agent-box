import { Transform, type TransformCallback } from 'node:stream';
import { BIG_FILE_HINT } from './limits.js';

/** What the guard knows about a message it refused. */
export interface OversizedMessage {
  /** Size of the whole line in bytes (without the newline). */
  bytes: number;
  /** JSON-RPC id when it could be read from the message, else undefined (a notification, or not found). */
  id?: string | number;
  /** The message was a `tools/call` request (answered as a tool result instead of a JSON-RPC error). */
  toolCall: boolean;
}

const HEAD_BYTES = 512;
const TAIL_BYTES = 256;

function firstId(m: RegExpExecArray | null): string | number | undefined {
  const raw = m?.[1];
  if (raw === undefined) return undefined;
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : Number(raw);
}

/**
 * Line framing in front of the SDK's stdio reader. A line (one JSON-RPC message) above `maxBytes` is
 * dropped as a whole and reported through `onOversized` - the SDK would otherwise close the connection
 * ("ReadBuffer exceeded maximum size"), taking every sandbox call of the agent down with one big message.
 * Lines within the limit pass through unchanged.
 */
export class MessageSizeGuard extends Transform {
  private parts: Buffer[] = [];
  private size = 0;
  private overflow = false;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);

  constructor(
    private readonly maxBytes: number,
    private readonly onOversized: (info: OversizedMessage) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      this.addSegment(chunk.subarray(start, end));
      if (nl === -1) break;
      this.endLine();
      start = nl + 1;
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    // A last line without newline: hand it on (the reader ignores it) unless it is oversized.
    if (this.size > 0 && !this.overflow) this.push(Buffer.concat(this.parts));
    cb();
  }

  private addSegment(seg: Buffer): void {
    if (seg.length === 0) return;
    if (this.size === 0) this.head = Buffer.from(seg.subarray(0, HEAD_BYTES));
    this.size += seg.length;
    if (!this.overflow && this.size > this.maxBytes) {
      this.overflow = true;
      // keep what is needed to find the id, free the rest
      const last = this.parts[this.parts.length - 1];
      this.tail = last ? Buffer.from(last.subarray(-TAIL_BYTES)) : Buffer.alloc(0);
      this.parts = [];
    }
    if (this.overflow) {
      this.tail = Buffer.concat([this.tail, seg]).subarray(-TAIL_BYTES);
    } else {
      this.parts.push(seg);
    }
  }

  private endLine(): void {
    if (this.overflow) {
      const head = this.head.toString('utf8');
      const tail = this.tail.toString('utf8');
      let id: string | number | undefined;
      try {
        // SDK clients put the id last (`...,"jsonrpc":"2.0","id":7}`), others first.
        id =
          firstId(/,\s*"id"\s*:\s*(\d+|"(?:[^"\\]|\\.){0,128}")\s*\}\s*$/.exec(tail)) ??
          firstId(
            /^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*(\d+|"(?:[^"\\]|\\.){0,128}")\s*,/.exec(
              head,
            ),
          );
      } catch {
        id = undefined;
      }
      const bytes = this.size;
      const toolCall = /"method"\s*:\s*"tools\/call"/.test(head);
      this.reset();
      this.onOversized({ bytes, ...(id !== undefined ? { id } : {}), toolCall });
      return;
    }
    if (this.size > 0) this.push(Buffer.concat([...this.parts, Buffer.from('\n')]));
    else this.push(Buffer.from('\n'));
    this.reset();
  }

  private reset(): void {
    this.parts = [];
    this.size = 0;
    this.overflow = false;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
  }
}

/** The answer to an oversized message: a tool error result for a tool call, else a JSON-RPC error. */
export function oversizedResponse(info: OversizedMessage, maxBytes: number): object | undefined {
  if (info.id === undefined) return undefined;
  const mib = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  const message = `message of ${mib(info.bytes)} MiB is larger than the ${mib(maxBytes)} MiB limit of this connection and was not processed`;
  if (info.toolCall) {
    return {
      jsonrpc: '2.0',
      id: info.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `[invalid_input] ${message}\nHint: ${BIG_FILE_HINT}` }],
        structuredContent: { ok: false, code: 'invalid_input', message, hint: BIG_FILE_HINT },
      },
    };
  }
  return { jsonrpc: '2.0', id: info.id, error: { code: -32600, message } };
}
