import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { proxyRuntimeDir } from '../index.js';

export function makeTempDir(prefix = 'abox-proxy-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

export interface Pki {
  caFile: string;
  caPem: string;
  keyPem: string;
  certPem: string;
}

/** Throw-away CA + server certificate (SAN = `names`) for local TLS test servers. */
export function makePki(dir: string, names: string[], label = 'pki'): Pki {
  const caKey = join(dir, `${label}-ca.key`);
  const caFile = join(dir, `${label}-ca.crt`);
  const key = join(dir, `${label}.key`);
  const csr = join(dir, `${label}.csr`);
  const crt = join(dir, `${label}.crt`);
  const ext = join(dir, `${label}.ext`);
  openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caFile,
    '-days',
    '2',
    '-subj',
    `/CN=abox test ca ${label}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csr,
    '-subj',
    '/CN=abox test server',
  ]);
  writeFileSync(
    ext,
    `basicConstraints=CA:FALSE\nsubjectAltName=${names.map((n) => `DNS:${n}`).join(',')}\n`,
  );
  openssl([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    caFile,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    ext,
    '-out',
    crt,
  ]);
  return {
    caFile,
    caPem: readFileSync(caFile, 'utf8'),
    keyPem: readFileSync(key, 'utf8'),
    certPem: readFileSync(crt, 'utf8'),
  };
}

export interface ProxyEvent {
  ts: number;
  event: string;
  [key: string]: unknown;
}

export interface RunningProxy {
  port: number;
  stateDir: string;
  child: ChildProcess;
  /** Everything the proxy wrote to stdout so far. */
  stdout(): string;
  /** stdout parsed as JSON lines. */
  events(): ProxyEvent[];
  requests(): ProxyEvent[];
  /** Wait until a request event matching `predicate` appears. */
  waitForRequest(predicate: (e: ProxyEvent) => boolean, timeoutMs?: number): Promise<ProxyEvent>;
  stop(): Promise<number | null>;
}

/** Spawn `runtime/proxy.mjs` with a temp config and wait for the ready event. */
export async function startProxy(
  dir: string,
  config: Record<string, unknown>,
): Promise<RunningProxy> {
  const stateDir = join(dir, `state-${Math.random().toString(16).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });
  const configFile = join(dir, `config-${Math.random().toString(16).slice(2)}.json`);
  const full = { listen: { host: '127.0.0.1', port: 0 }, stateDir, ...config };
  writeFileSync(configFile, JSON.stringify(full), { mode: 0o600 });
  const child = spawn(process.execPath, [join(proxyRuntimeDir, 'proxy.mjs'), configFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr?.setEncoding('utf8').on('data', (c: string) => (err += c));
  const events = (): ProxyEvent[] =>
    out
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as ProxyEvent);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const ready = events().find((e) => e.event === 'ready');
    if (ready) {
      const running: RunningProxy = {
        port: ready.port as number,
        stateDir,
        child,
        stdout: () => out + err,
        events,
        requests: () => events().filter((e) => e.event === 'request'),
        async waitForRequest(predicate, timeoutMs = 5000) {
          const end = Date.now() + timeoutMs;
          while (Date.now() < end) {
            const hit = events().find((e) => e.event === 'request' && predicate(e));
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 20));
          }
          throw new Error(`no matching request event in:\n${out}`);
        },
        async stop() {
          if (child.exitCode !== null) return child.exitCode;
          child.kill('SIGTERM');
          const [code] = (await once(child, 'exit')) as [number | null];
          return code;
        },
      };
      return running;
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`proxy did not become ready (exit ${child.exitCode}):\n${out}\n${err}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run the proxy expecting it to exit (invalid config). */
export async function runProxyExpectingExit(
  configFile: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [join(proxyRuntimeDir, 'proxy.mjs'), configFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stdout, stderr };
}

export interface RawResponse {
  status: number;
  headers: string;
  body: string;
  socket: net.Socket;
}

/** Send raw bytes to the proxy and read the response head (+ whatever body arrives). */
export function rawRequest(
  proxyPort: number,
  payload: string,
  keepOpen = false,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let data = '';
    const finish = () => {
      const idx = data.indexOf('\r\n\r\n');
      const head = idx === -1 ? data : data.slice(0, idx);
      const body = idx === -1 ? '' : data.slice(idx + 4);
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0);
      resolve({ status, headers: head, body, socket });
    };
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => {
      data += c;
      if (keepOpen && data.includes('\r\n\r\n')) finish();
    });
    socket.on('end', () => !keepOpen && finish());
    socket.on('error', reject);
    socket.write(payload);
  });
}

/** Plain CONNECT; resolves with the status and (when 200) the open tunnel socket. */
export async function connectThroughProxy(
  proxyPort: number,
  authority: string,
): Promise<{ status: number; headers: string; body: string; socket: net.Socket }> {
  return rawRequest(proxyPort, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`, true);
}

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
  httpVersion: string;
}

export interface TestServer {
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

function recorder(
  reply?: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
) {
  const seen: Seen[] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body,
        httpVersion: req.httpVersion,
      });
      if (reply) {
        reply(req, res, body);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream': 'yes' });
      res.end(JSON.stringify({ headers: req.headers, url: req.url, method: req.method, body }));
    });
  };
  return { seen, handler };
}

export async function startHttpServer(reply?: Parameters<typeof recorder>[0]): Promise<TestServer> {
  const { seen, handler } = recorder(reply);
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as net.AddressInfo).port,
    seen,
    close: () => closeServer(server),
  };
}

export async function startHttpsServer(
  pki: Pick<Pki, 'keyPem' | 'certPem'>,
  reply?: Parameters<typeof recorder>[0],
): Promise<TestServer & { tlsErrors: number }> {
  const { seen, handler } = recorder(reply);
  const server = https.createServer({ key: pki.keyPem, cert: pki.certPem }, handler);
  const result = {
    port: 0,
    seen,
    tlsErrors: 0,
    close: () => closeServer(server),
  };
  server.on('tlsClientError', () => result.tlsErrors++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  result.port = (server.address() as net.AddressInfo).port;
  return result;
}

function closeServer(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export interface HttpsResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * HTTPS request through the proxy: CONNECT, TLS to the origin (verified against `ca`),
 * then one or more sequential requests over the same tunnel.
 */
export async function httpsViaProxy(opts: {
  proxyPort: number;
  host: string;
  port: number;
  ca: string;
  requests: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    chunked?: boolean;
  }[];
}): Promise<HttpsResult[]> {
  const tunnel = await connectThroughProxy(opts.proxyPort, `${opts.host}:${opts.port}`);
  if (tunnel.status !== 200) {
    tunnel.socket.destroy();
    throw new Error(`CONNECT failed: ${tunnel.status} ${tunnel.body}`);
  }
  const tlsSocket = tls.connect({ socket: tunnel.socket, servername: opts.host, ca: opts.ca });
  await once(tlsSocket, 'secureConnect');
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () =>
    tlsSocket;
  const results: HttpsResult[] = [];
  try {
    for (const r of opts.requests) {
      results.push(
        await new Promise<HttpsResult>((resolve, reject) => {
          const req = https.request(
            {
              agent,
              host: opts.host,
              port: opts.port,
              method: r.method ?? 'GET',
              path: r.path ?? '/',
              headers: r.headers,
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString('utf8'),
                }),
              );
            },
          );
          req.on('error', reject);
          if (r.body !== undefined) {
            if (r.chunked) {
              const buf = Buffer.from(r.body);
              const mid = Math.floor(buf.length / 2);
              req.write(buf.subarray(0, mid));
              req.write(buf.subarray(mid));
              req.end();
            } else {
              req.end(r.body);
            }
          } else {
            req.end();
          }
        }),
      );
    }
  } finally {
    agent.destroy();
    tlsSocket.destroy();
    tunnel.socket.destroy();
  }
  return results;
}

/** Plain HTTP request in absolute-form through the proxy. */
export function httpViaProxy(opts: {
  proxyPort: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.proxyPort,
        method: opts.method ?? 'GET',
        path: opts.url,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
