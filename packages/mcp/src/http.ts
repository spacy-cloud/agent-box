import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AboxError } from '@abox/core';
import type { Abox } from '@abox/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { startTtlWatch, type McpLimits } from './runtime.js';
import { createMcpServer } from './server.js';

export interface ServeHttpOptions {
  abox: Abox;
  /** Loopback only: `127.0.0.1`, `::1` (or `localhost`, bound as 127.0.0.1). Anything else is refused. */
  host: string;
  /** 0 = pick a free port (see `address`). */
  port: number;
  onListening?: (address: HttpAddress) => void;
  /**
   * Browser origins allowed in addition to loopback origins. They get exact-origin CORS headers (never `*`).
   * Requests without an Origin header (CLI/SDK clients) are unaffected.
   */
  allowedOrigins?: string[];
  limits?: McpLimits;
  /** How often expired sandboxes are stopped in the background, ms (default 15 s, 0 = never). */
  ttlWatchMs?: number;
  /** Max concurrent sessions overall (default 64) and per token (default 16). */
  maxSessions?: number;
  maxSessionsPerToken?: number;
  /** Sessions idle for this long are closed (default 30 min). */
  sessionIdleMs?: number;
  /** Max request body in bytes (default 32 MiB: write_file allows 16 MiB, base64 inflates). */
  maxBodyBytes?: number;
}

export interface HttpAddress {
  host: string;
  port: number;
  /** MCP endpoint, e.g. http://127.0.0.1:7421/mcp */
  url: string;
}

export interface HttpServerHandle {
  address: HttpAddress;
  close(): Promise<void>;
}

export const MCP_PATH = '/mcp';

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackBindHost(host: string): boolean {
  return (
    host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** Parses `host[:port]` / `[v6]:port`. */
function splitHostHeader(h: string): { name: string; port: string } | undefined {
  const m = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h.trim());
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), port: m[2] ?? '' };
}

function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return LOOPBACK_NAMES.has(h) || /^127(?:\.\d{1,3}){3}$/.test(h);
}

function normalizeOrigin(o: string): string | undefined {
  try {
    const u = new URL(o);
    return u.origin === 'null' ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** sha256 of the bearer token that created the session: only that token may use it. */
  tokenDigest: Buffer;
  contextId: string;
  lastSeen: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function serveHttp(opts: ServeHttpOptions): Promise<HttpServerHandle> {
  if (!isLoopbackBindHost(opts.host)) {
    throw new AboxError(
      'invalid_input',
      `refusing to bind the MCP HTTP server to "${opts.host}": only loopback addresses are allowed`,
      {
        hint: 'Use 127.0.0.1 or ::1. For remote access use an SSH tunnel instead of exposing the port.',
      },
    );
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new AboxError('invalid_input', `invalid port ${String(opts.port)}`);
  }
  const bindHost = opts.host === 'localhost' ? '127.0.0.1' : opts.host.replace(/^\[|\]$/g, '');
  const allowedOrigins = new Set(
    (opts.allowedOrigins ?? []).map(normalizeOrigin).filter((x): x is string => x !== undefined),
  );
  const maxSessions = opts.maxSessions ?? 64;
  const maxPerToken = opts.maxSessionsPerToken ?? 16;
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const maxBody = opts.maxBodyBytes ?? 32 * 1024 * 1024;
  const sessions = new Map<string, Session>();
  let boundPort = 0;

  const dropSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.server.close().catch(() => undefined);
  };

  // -- header checks -------------------------------------------------------------------------
  const hostAllowed = (req: IncomingMessage): boolean => {
    const h = req.headers.host;
    if (typeof h !== 'string') return false;
    const p = splitHostHeader(h);
    if (!p) return false;
    const nameOk = LOOPBACK_NAMES.has(p.name) || /^127(?:\.\d{1,3}){3}$/.test(p.name);
    return nameOk && p.port === String(boundPort);
  };

  const originState = (req: IncomingMessage): 'none' | 'allowed' | 'cors' | 'denied' => {
    const o = req.headers.origin;
    if (o === undefined) return 'none';
    if (typeof o !== 'string') return 'denied';
    const n = normalizeOrigin(o);
    if (n !== undefined && allowedOrigins.has(n)) return 'cors';
    if (isLoopbackOrigin(o)) return 'allowed'; // accepted, but no CORS headers: a browser cannot read the reply
    return 'denied';
  };

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const n = normalizeOrigin(String(req.headers.origin ?? ''));
    return n
      ? {
          'access-control-allow-origin': n,
          vary: 'Origin',
          'access-control-expose-headers': 'mcp-session-id',
        }
      : {};
  };

  // -- request handling -----------------------------------------------------------------------
  const sendJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    if (res.headersSent) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(text);
  };
  const unauthorized = (res: ServerResponse): void =>
    sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="abox"' });
  const forbidden = (res: ServerResponse): void => sendJson(res, 403, { error: 'forbidden' });
  const rpcError = (res: ServerResponse, status: number, code: number, message: string): void =>
    sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          reject(new HttpError(413, 'request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const bearer = (req: IncomingMessage): string | undefined => {
    const a = req.headers.authorization;
    if (typeof a !== 'string') return undefined;
    const m = /^Bearer ([A-Za-z0-9._~+/=-]{8,512})$/i.exec(a.trim());
    return m?.[1];
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1. DNS-rebinding protection: Host and Origin must be loopback (or an explicitly allowed origin).
    if (!hostAllowed(req)) return forbidden(res);
    const origin = originState(req);
    if (origin === 'denied') return forbidden(res);
    const cors = origin === 'cors' ? corsHeaders(req) : {};
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') {
      if (origin !== 'cors') return forbidden(res);
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
        'access-control-allow-headers':
          'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    // 2. Authentication on every request: the token decides the agent context.
    const token = bearer(req);
    if (!token) return unauthorized(res);
    let contextId: string | undefined;
    try {
      contextId = opts.abox.verifyAgentToken(token);
    } catch (e) {
      process.stderr.write(
        `abox-mcp: token verification failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return sendJson(res, 500, { error: 'internal error' });
    }
    if (!contextId) return unauthorized(res);

    // 3. Routing.
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) return sendJson(res, 404, { error: 'not found' });
    const method = req.method ?? '';
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      return sendJson(
        res,
        405,
        { error: 'method not allowed' },
        { allow: 'POST, GET, DELETE, OPTIONS' },
      );
    }

    const tokenDigest = digest(token);
    const sidHeader = req.headers['mcp-session-id'];
    const sid = typeof sidHeader === 'string' ? sidHeader : undefined;
    if (Array.isArray(sidHeader)) return rpcError(res, 400, -32000, 'bad session header');

    // 4. Existing session: only the token that created it may use it. Unknown and foreign sessions are
    //    indistinguishable (404), so a session id leaks nothing.
    if (sid !== undefined) {
      const s = sessions.get(sid);
      if (
        !s ||
        s.tokenDigest.length !== tokenDigest.length ||
        !timingSafeEqual(s.tokenDigest, tokenDigest)
      ) {
        return rpcError(res, 404, -32001, 'session not found');
      }
      s.lastSeen = Date.now();
      const body = method === 'POST' ? await readBody(req) : undefined;
      await s.transport.handleRequest(req, res, body);
      return;
    }

    // 5. No session: only POST initialize may create one.
    if (method !== 'POST') return rpcError(res, 400, -32000, 'missing Mcp-Session-Id header');
    const body = await readBody(req);
    const first = Array.isArray(body) ? body[0] : body;
    if (!isInitializeRequest(first) || Array.isArray(body)) {
      return rpcError(res, 400, -32000, 'a session must start with an initialize request');
    }
    let mine = 0;
    for (const s of sessions.values()) if (s.tokenDigest.equals(tokenDigest)) mine++;
    if (sessions.size >= maxSessions) return rpcError(res, 503, -32000, 'too many sessions');
    if (mine >= maxPerToken) return rpcError(res, 429, -32000, 'too many sessions for this token');

    const server = createMcpServer({
      abox: opts.abox,
      contextId,
      ...(opts.limits ? { limits: opts.limits } : {}),
    });
    const session: Session = {
      transport: undefined as unknown as StreamableHTTPServerTransport,
      server,
      tokenDigest,
      contextId,
      lastSeen: Date.now(),
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    session.transport = transport;
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    transport.onerror = (e) => process.stderr.write(`abox-mcp: transport error: ${e.message}\n`);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    if (!transport.sessionId) void server.close().catch(() => undefined);
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return rpcError(res, e.status, -32000, e.message);
      process.stderr.write(
        `abox-mcp: http error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 120_000;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen({ host: bindHost, port: opts.port }, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const a = httpServer.address() as AddressInfo;
  boundPort = a.port;
  const hostLabel = a.family === 'IPv6' ? `[${bindHost}]` : bindHost;
  const address: HttpAddress = {
    host: bindHost,
    port: a.port,
    url: `http://${hostLabel}:${a.port}${MCP_PATH}`,
  };

  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [id, s] of sessions) if (now - s.lastSeen > idleMs) dropSession(id);
    },
    Math.min(60_000, Math.max(1000, Math.floor(idleMs / 2))),
  );
  sweep.unref();
  const stopTtlWatch = startTtlWatch(opts.abox, opts.ttlWatchMs);

  opts.onListening?.(address);

  let closing: Promise<void> | undefined;
  return {
    address,
    close(): Promise<void> {
      closing ??= (async () => {
        clearInterval(sweep);
        stopTtlWatch();
        const all = [...sessions.values()];
        sessions.clear();
        await Promise.allSettled(all.map((s) => s.server.close()));
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}
