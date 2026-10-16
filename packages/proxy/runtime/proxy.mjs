// abox egress proxy sidecar.
//
// A small, dependency-free HTTP(S) forward proxy that enforces
//   - a domain allowlist (CONNECT tunnels and absolute-form http:// requests),
//   - blocking of private / loopback / link-local / metadata addresses, checked on the
//     RESOLVED address which is then used for the connection (no DNS rebinding),
//   - optional secret injection: for configured hosts the proxy terminates TLS with a
//     per-instance CA, sets a request header and forwards upstream with full
//     certificate verification. The sandbox never sees the secret.
//
// Usage:  node proxy.mjs [/etc/abox-proxy/config.json]
// Logs:   one JSON object per line on stdout (see docs/internal/proxy-contract.md).
//         Secret header values are never logged.
//
// Pure policy code lives in ./lib.mjs (shared with the host-side @abox/proxy package).

/* global process, Buffer, setTimeout, clearTimeout */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import {
  blockedReason,
  compileAllowlist,
  matchAllowlist,
  parseAuthority,
  parseProxyRequestUrl,
  validateProxyConfig,
} from './lib.mjs';

const DEFAULT_CONFIG_PATH = '/etc/abox-proxy/config.json';
const DEFAULT_STATE_DIR = '/run/abox-proxy';
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const CA_VALIDITY_DAYS = 365;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Write one JSON line. Callers pass explicit, non-secret fields only. */
function log(fields) {
  process.stdout.write(`${JSON.stringify({ ts: Date.now(), ...fields })}\n`);
}

/**
 * Log a request decision in the contract format. Only whitelisted fields are copied so
 * nothing else (headers, paths, bodies) can leak into the log by accident.
 */
function logRequest(fields) {
  const entry = {
    event: 'request',
    method: fields.method,
    host: fields.host,
    port: fields.port,
  };
  if (fields.ip !== undefined) entry.ip = fields.ip;
  entry.decision = fields.decision;
  if (fields.reason !== undefined) entry.reason = fields.reason;
  if (fields.mitm) entry.mitm = true;
  if (fields.injected) entry.injected = true;
  log(entry);
}

/** Printable, bounded representation of an untrusted host string for log lines. */
function safeLogHost(raw) {
  let s = String(raw ?? '');
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1); // never log userinfo
  return s.slice(0, 100).replace(/[^\x21-\x7e]/g, '?');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read + validate the config. On any problem print ONE JSON error line (never echoing
 * values, the file may contain secrets) and return undefined.
 */
function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log({ event: 'error', message: 'cannot read config file', code: err?.code ?? 'unknown' });
    return undefined;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // Deliberately no err.message: V8 includes a snippet of the input.
    log({ event: 'error', message: 'config is not valid JSON' });
    return undefined;
  }
  const result = validateProxyConfig(raw);
  if (!result.ok) {
    log({ event: 'error', message: 'invalid config', errors: result.errors });
    return undefined;
  }
  return result.config;
}

// ---------------------------------------------------------------------------
// Secret injection: per-instance CA + leaf certificates (openssl CLI)
// ---------------------------------------------------------------------------

function openssl(args) {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 });
}

/**
 * Generate a throw-away CA and one leaf certificate per injection host, all at startup.
 * The CA is restricted to the injection hosts through critical X.509 name constraints,
 * and the CA private key is deleted from disk once the leaves are signed, so it exists
 * nowhere after startup. Only `ca.crt` remains in `stateDir`.
 *
 * @returns {Map<string, tls.SecureContext>} secure context per injection host
 */
function setupMitm(stateDir, hosts) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(stateDir, 'work-'));
  try {
    const caKey = path.join(work, 'ca.key');
    const caCrt = path.join(work, 'ca.crt');
    const leafKey = path.join(work, 'leaf.key');
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey]);
    const permitted = hosts.map((h) => `permitted;DNS:${h}`).join(',');
    openssl([
      'req',
      '-x509',
      '-new',
      '-sha256',
      '-key',
      caKey,
      '-days',
      String(CA_VALIDITY_DAYS),
      '-subj',
      `/O=abox/CN=abox proxy CA ${randomBytes(4).toString('hex')}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign',
      '-addext',
      `nameConstraints=critical,${permitted}`,
      '-out',
      caCrt,
    ]);
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', leafKey]);
    const keyPem = fs.readFileSync(leafKey);

    /** @type {Map<string, tls.SecureContext>} */
    const contexts = new Map();
    for (const [i, host] of hosts.entries()) {
      const csr = path.join(work, `leaf-${i}.csr`);
      const ext = path.join(work, `leaf-${i}.ext`);
      const crt = path.join(work, `leaf-${i}.crt`);
      fs.writeFileSync(
        ext,
        [
          'basicConstraints=critical,CA:FALSE',
          'keyUsage=critical,digitalSignature',
          'extendedKeyUsage=serverAuth',
          `subjectAltName=DNS:${host}`,
          '',
        ].join('\n'),
      );
      // The SAN carries the host (the CN is limited to 64 characters, hosts are not).
      openssl(['req', '-new', '-key', leafKey, '-subj', '/O=abox/CN=abox proxy leaf', '-out', csr]);
      openssl([
        'x509',
        '-req',
        '-sha256',
        '-in',
        csr,
        '-CA',
        caCrt,
        '-CAkey',
        caKey,
        '-set_serial',
        `0x${randomBytes(8).toString('hex')}`,
        '-days',
        String(CA_VALIDITY_DAYS),
        '-extfile',
        ext,
        '-out',
        crt,
      ]);
      contexts.set(host, tls.createSecureContext({ key: keyPem, cert: fs.readFileSync(crt) }));
    }
    fs.writeFileSync(path.join(stateDir, 'ca.crt'), fs.readFileSync(caCrt), { mode: 0o644 });
    return contexts;
  } finally {
    // Removes the CA key and the leaf key material from disk.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------

// Hop-by-hop headers (RFC 9110 section 7.6.1) plus proxy-specific ones. `expect` is
// answered by our own HTTP server and must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

/**
 * Build the header list (flat [name, value, ...], original casing and order) for the
 * upstream request: drops hop-by-hop headers, headers named by `Connection:`, the
 * client's `Host` (replaced) and any header that is being injected.
 */
function buildUpstreamHeaders(req, { hostHeader, injected, closeConnection }) {
  const connectionTokens = new Set(
    String(req.headers.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const overridden = new Set(injected.map((i) => i.header.toLowerCase()));
  const out = ['Host', hostHeader];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const lower = name.toLowerCase();
    if (
      lower === 'host' ||
      HOP_BY_HOP.has(lower) ||
      connectionTokens.has(lower) ||
      overridden.has(lower)
    )
      continue;
    out.push(name, raw[i + 1]);
  }
  // Re-assert chunked framing explicitly: Node would otherwise not chunk e.g. DELETE.
  if (
    req.headers['transfer-encoding'] !== undefined &&
    req.headers['content-length'] === undefined
  ) {
    out.push('Transfer-Encoding', 'chunked');
  }
  for (const { header, value } of injected) out.push(header, value);
  if (closeConnection) out.push('Connection', 'close');
  return out;
}

function filterResponseHeaders(proxyRes) {
  const out = [];
  const raw = proxyRes.rawHeaders;
  const connectionTokens = new Set(
    String(proxyRes.headers.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = raw[i].toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

/** `Host` header value for a target: omit the default port of the scheme. */
function hostHeaderFor(host, port, defaultPort) {
  const h = host.includes(':') ? `[${host}]` : host;
  return port === defaultPort ? h : `${h}:${port}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  if (!config) {
    process.exitCode = 2;
    return;
  }

  const allowRules = compileAllowlist(config.allow);
  const blockPrivate = config.blockPrivate;
  const exceptions = config.privateExceptions;
  const maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const connectTimeout = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeout = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const stateDir = config.stateDir ?? DEFAULT_STATE_DIR;
  const dnsOverrides = config.dnsOverrides ?? {};
  let upstreamCa;
  if (config.upstreamCaFile) {
    try {
      upstreamCa = fs.readFileSync(config.upstreamCaFile);
    } catch (err) {
      log({ event: 'error', message: 'cannot read upstreamCaFile', code: err?.code ?? 'unknown' });
      process.exitCode = 2;
      return;
    }
  }

  /** @type {Map<string, { header: string, value: string }[]>} */
  const injections = new Map();
  for (const { host, header, value } of config.injections) {
    const list = injections.get(host) ?? [];
    list.push({ header, value });
    injections.set(host, list);
  }

  // Injection hosts that the allowlist would deny are useless: warn (without values).
  for (const host of injections.keys()) {
    if (!allowRules.some((r) => matchAllowlist([r.entry], host, r.port ?? 443).allowed)) {
      log({ event: 'warn', message: 'injection host is not covered by allow', host });
    }
  }

  /** @type {Map<string, tls.SecureContext>} */
  let mitmContexts = new Map();
  if (injections.size > 0) {
    try {
      mitmContexts = setupMitm(stateDir, [...injections.keys()]);
    } catch (err) {
      log({
        event: 'error',
        message: 'failed to generate CA / certificates',
        code: err?.code ?? 'openssl',
      });
      process.exitCode = 1;
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Name resolution + address policy
  // -------------------------------------------------------------------------

  /**
   * Resolve `host` and apply the blockPrivate policy to EVERY address. The caller must
   * connect to one of the returned addresses (never to the name) so a second DNS
   * answer cannot slip past the check.
   *
   * @returns {Promise<{ ok: true, addresses: { address: string, family: 4 | 6 }[] } | { ok: false, reason: string }>}
   */
  async function resolveChecked(host, kind) {
    let addresses;
    if (kind === 'ipv4' || kind === 'ipv6') {
      addresses = [{ address: host, family: kind === 'ipv4' ? 4 : 6 }];
    } else if (dnsOverrides[host]) {
      addresses = dnsOverrides[host].map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
    } else {
      let timer;
      try {
        addresses = await Promise.race([
          dns.promises.lookup(host, { all: true }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })),
              connectTimeout,
            );
          }),
        ]);
      } catch (err) {
        return { ok: false, reason: `dns lookup failed (${err?.code ?? 'error'})` };
      } finally {
        clearTimeout(timer);
      }
    }
    if (addresses.length === 0) return { ok: false, reason: 'dns lookup returned no addresses' };
    if (blockPrivate) {
      for (const { address } of addresses) {
        const why = blockedReason(address, exceptions);
        if (why) return { ok: false, reason: `blocked address ${address} (${why})` };
      }
    }
    // IPv4 first: containers frequently have no IPv6 route.
    const sorted = [...addresses].sort((a, b) => a.family - b.family);
    return { ok: true, addresses: sorted };
  }

  /** `net` lookup function that hands out already-checked addresses. */
  const staticLookup = (addresses) => (_name, options, cb) => {
    if (options?.all) cb(null, addresses);
    else cb(null, addresses[0].address, addresses[0].family);
  };

  /** `net` lookup function that resolves + checks on every (new) upstream connection. */
  const checkedLookup = (host, kind) => (_name, options, cb) => {
    resolveChecked(host, kind).then((r) => {
      if (!r.ok) {
        cb(Object.assign(new Error(r.reason), { code: 'EABOXDENIED' }));
      } else if (options?.all) {
        cb(null, r.addresses);
      } else {
        cb(null, r.addresses[0].address, r.addresses[0].family);
      }
    });
  };

  /** Connect to the first reachable of the (already checked) addresses. */
  function connectUpstream(addresses, port) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + connectTimeout;
      let index = 0;
      const attempt = () => {
        if (index >= addresses.length) {
          reject(Object.assign(new Error('connect failed'), { code: lastCode }));
          return;
        }
        const { address } = addresses[index++];
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
          return;
        }
        // Split the remaining budget over (at most) two more attempts.
        const budget = Math.max(
          200,
          Math.floor(remaining / Math.min(2, addresses.length - index + 1)),
        );
        const socket = net.connect({ host: address, port });
        const timer = setTimeout(
          () => socket.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
          budget,
        );
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.removeAllListeners('error');
          resolve(socket);
        });
        socket.once('error', (err) => {
          clearTimeout(timer);
          lastCode = err.code ?? 'ECONNREFUSED';
          attempt();
        });
      };
      let lastCode = 'ECONNREFUSED';
      attempt();
    });
  }

  // -------------------------------------------------------------------------
  // Policy decision
  // -------------------------------------------------------------------------

  /**
   * Allowlist + address policy for a parsed target.
   * @returns {Promise<{ ok: true, addresses: object[] } | { ok: false, reason: string }>}
   */
  async function authorise(target) {
    const m = matchAllowlist(allowRules, target.host, target.port);
    if (!m.allowed) return { ok: false, reason: m.reason };
    return resolveChecked(target.host, target.kind);
  }

  // -------------------------------------------------------------------------
  // Client-facing helpers
  // -------------------------------------------------------------------------

  const STATUS_TEXT = {
    400: 'Bad Request',
    403: 'Forbidden',
    405: 'Method Not Allowed',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };

  /** Raw HTTP error response on a socket (used for CONNECT and before parsing). */
  function rejectSocket(socket, status, reason) {
    if (socket.destroyed || !socket.writable) return;
    const body = `abox-proxy: ${reason}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n` +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n' +
        'X-Abox-Proxy: denied\r\n\r\n' +
        body,
    );
  }

  function rejectResponse(res, status, reason) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = `abox-proxy: ${reason}\n`;
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
      'X-Abox-Proxy': 'denied',
    });
    res.end(body);
  }

  // -------------------------------------------------------------------------
  // Sockets bookkeeping (graceful shutdown)
  // -------------------------------------------------------------------------

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {}); // errors are handled by their owners; never crash
  };

  // -------------------------------------------------------------------------
  // Forwarding of parsed HTTP requests (plain http:// and decrypted MITM traffic)
  // -------------------------------------------------------------------------

  /**
   * Forward one request upstream and stream the response back.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ transport: typeof http | typeof https, options: object, onDenied: (reason: string) => void }} opts
   */
  function forward(req, res, { transport, options, onDenied }) {
    const upstream = transport.request({ ...options, method: req.method });
    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      if (err?.code === 'EABOXDENIED') {
        onDenied(err.message);
        rejectResponse(res, 403, err.message);
      } else if (err?.code === 'ETIMEDOUT') {
        rejectResponse(res, 504, 'upstream timeout');
      } else {
        rejectResponse(res, 502, `upstream error (${err?.code ?? 'error'})`);
      }
      upstream.destroy();
      // Do not destroy `req`: that would tear down the socket before the error response
      // is flushed. The response carries `Connection: close`; just drain the body.
      req.unpipe(upstream);
      req.resume();
    };
    upstream.setTimeout(connectTimeout);
    upstream.on('socket', (socket) => {
      const arm = () => socket.setTimeout(idleTimeout);
      if (socket.connecting) socket.once('connect', arm);
      else arm();
    });
    upstream.on('timeout', () =>
      upstream.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    );
    upstream.on('error', fail);
    upstream.on('response', (proxyRes) => {
      if (finished) {
        proxyRes.destroy();
        return;
      }
      finished = true;
      proxyRes.on('error', () => res.destroy());
      res.on('close', () => proxyRes.destroy());
      res.writeHead(
        proxyRes.statusCode ?? 502,
        proxyRes.statusMessage ?? '',
        filterResponseHeaders(proxyRes),
      );
      proxyRes.pipe(res);
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  // -------------------------------------------------------------------------
  // Plain HTTP proxying (absolute-form requests)
  // -------------------------------------------------------------------------

  async function handleHttpRequest(req, res) {
    const method = req.method ?? '';
    const parsed = parseProxyRequestUrl(req.url ?? '');
    if (!parsed.ok) {
      logRequest({ method, host: '', port: 0, decision: 'deny', reason: parsed.reason });
      rejectResponse(res, parsed.status, parsed.reason);
      return;
    }
    const { host, port, path: reqPath } = parsed;
    if (method === 'TRACE') {
      logRequest({ method, host, port, decision: 'deny', reason: 'method not allowed' });
      rejectResponse(res, 405, 'method not allowed');
      return;
    }
    if (injections.has(host)) {
      // Never speak plain HTTP to a host whose secret we would inject over TLS only.
      logRequest({ method, host, port, decision: 'deny', reason: 'plain http to injection host' });
      rejectResponse(res, 403, 'plain http to injection host');
      return;
    }
    const auth = await authorise(parsed);
    if (!auth.ok) {
      logRequest({ method, host, port, decision: 'deny', reason: auth.reason });
      rejectResponse(res, 403, auth.reason);
      return;
    }
    logRequest({ method, host, port, ip: auth.addresses[0].address, decision: 'allow' });
    forward(req, res, {
      transport: http,
      onDenied: () => {},
      options: {
        host,
        port,
        path: reqPath,
        headers: buildUpstreamHeaders(req, {
          hostHeader: hostHeaderFor(host, port, 80),
          injected: [],
          closeConnection: true,
        }),
        agent: false, // one connection per request, closed afterwards
        lookup: staticLookup(auth.addresses),
      },
    });
  }

  // -------------------------------------------------------------------------
  // MITM: decrypted requests inside a CONNECT tunnel to an injection host
  // -------------------------------------------------------------------------

  function handleMitmRequest(req, res) {
    const meta = req.socket._abox;
    const method = req.method ?? '';
    if (!meta || typeof req.url !== 'string' || !req.url.startsWith('/')) {
      rejectResponse(res, 400, 'bad request target');
      return;
    }
    if (method === 'TRACE') {
      rejectResponse(res, 405, 'method not allowed');
      return;
    }
    const injected = injections.get(meta.host) ?? [];
    logRequest({
      method,
      host: meta.host,
      port: meta.port,
      ip: meta.ip,
      decision: 'allow',
      mitm: true,
      injected: true,
    });
    forward(req, res, {
      transport: https,
      onDenied: (reason) =>
        logRequest({
          method,
          host: meta.host,
          port: meta.port,
          decision: 'deny',
          reason,
          mitm: true,
        }),
      options: {
        host: meta.host,
        port: meta.port,
        path: req.url,
        servername: meta.host,
        agent: meta.agent,
        // The Host header is pinned to the CONNECT target: no domain fronting through
        // an injection host.
        headers: buildUpstreamHeaders(req, {
          hostHeader: hostHeaderFor(meta.host, meta.port, 443),
          injected,
          closeConnection: false,
        }),
      },
    });
  }

  const configureHttpServer = (server) => {
    server.headersTimeout = 30_000;
    server.requestTimeout = 0; // long uploads (git push) are bounded by the idle timeout
    server.keepAliveTimeout = 30_000;
    server.timeout = idleTimeout;
    server.on('clientError', (_err, socket) => {
      if (socket.writable) rejectSocket(socket, 400, 'malformed request');
      else socket.destroy();
    });
  };

  const mitmServer = http.createServer(handleMitmRequest);
  configureHttpServer(mitmServer);

  /** Terminate TLS for an injection host on the already-open client socket. */
  function startMitm(clientSocket, target, ip) {
    const secureContext = mitmContexts.get(target.host);
    if (!secureContext) {
      clientSocket.destroy();
      return;
    }
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
      ALPNProtocols: ['http/1.1'],
    });
    // Per-tunnel agent: owns the upstream connections of this client connection. Its
    // lookup re-resolves + re-checks the destination for each new upstream connection.
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 8,
      ca: upstreamCa,
      rejectUnauthorized: true,
      lookup: checkedLookup(target.host, 'name'),
    });
    tlsSocket._abox = { host: target.host, port: target.port, ip, agent };
    tlsSocket.on('error', () => {}); // e.g. client does not trust our CA
    tlsSocket.once('close', () => agent.destroy());
    mitmServer.emit('connection', tlsSocket);
  }

  // -------------------------------------------------------------------------
  // CONNECT tunnelling
  // -------------------------------------------------------------------------

  async function handleConnect(req, clientSocket, head) {
    track(clientSocket);
    const parsed = parseAuthority(req.url ?? '');
    if (!parsed.ok) {
      logRequest({
        method: 'CONNECT',
        host: safeLogHost(req.url),
        port: 0,
        decision: 'deny',
        reason: parsed.reason,
      });
      rejectSocket(clientSocket, 400, parsed.reason);
      return;
    }
    const { host, port } = parsed;
    const auth = await authorise(parsed);
    if (!auth.ok) {
      logRequest({ method: 'CONNECT', host, port, decision: 'deny', reason: auth.reason });
      rejectSocket(clientSocket, 403, auth.reason);
      return;
    }
    if (clientSocket.destroyed) return;

    // Injection host: terminate TLS ourselves, upstream connections are made per request.
    if (injections.has(host)) {
      if (head.length > 0) {
        // A client must wait for our 200 before sending its ClientHello.
        logRequest({
          method: 'CONNECT',
          host,
          port,
          decision: 'deny',
          reason: 'early data before tunnel established',
        });
        rejectSocket(clientSocket, 400, 'early data before tunnel established');
        return;
      }
      const ip = auth.addresses[0].address;
      logRequest({ method: 'CONNECT', host, port, ip, decision: 'allow', mitm: true });
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      startMitm(clientSocket, parsed, ip);
      return;
    }

    let upstream;
    try {
      upstream = await connectUpstream(auth.addresses, port);
    } catch (err) {
      logRequest({
        method: 'CONNECT',
        host,
        port,
        ip: auth.addresses[0].address,
        decision: 'allow',
        reason: `connect failed (${err?.code ?? 'error'})`,
      });
      rejectSocket(
        clientSocket,
        err?.code === 'ETIMEDOUT' ? 504 : 502,
        `upstream connect failed (${err?.code ?? 'error'})`,
      );
      return;
    }
    track(upstream);
    if (clientSocket.destroyed) {
      upstream.destroy();
      return;
    }
    logRequest({ method: 'CONNECT', host, port, ip: upstream.remoteAddress, decision: 'allow' });

    const closeBoth = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    clientSocket.on('error', closeBoth);
    upstream.on('error', closeBoth);
    clientSocket.setTimeout(idleTimeout, closeBoth);
    upstream.setTimeout(idleTimeout, closeBoth);
    clientSocket.setNoDelay(true);
    upstream.setNoDelay(true);

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  }

  // -------------------------------------------------------------------------
  // Server
  // -------------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch(() => rejectResponse(res, 502, 'internal error'));
  });
  configureHttpServer(server);
  server.maxConnections = maxConnections;
  server.on('connection', track);
  server.on('connect', (req, socket, head) => {
    handleConnect(req, socket, head).catch(() => {
      rejectSocket(socket, 502, 'internal error');
    });
  });
  let lastDropLog = 0;
  server.on('drop', () => {
    const now = Date.now();
    if (now - lastDropLog > 1000) {
      lastDropLog = now;
      log({
        event: 'warn',
        message: 'connection limit reached, dropping connections',
        maxConnections,
      });
    }
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: 'shutdown', signal });
    server.close();
    mitmServer.close();
    server.closeIdleConnections();
    // Give in-flight transfers a moment, then cut whatever is left.
    const force = setTimeout(() => {
      for (const s of sockets) s.destroy();
      process.exit(0);
    }, 3000);
    server.on('close', () => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A proxy must keep serving despite stray network errors, but anything else is a bug
  // that leaves unknown state behind: fail closed.
  const NETWORK_ERRORS = new Set([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'ECONNABORTED',
    'ENOTCONN',
    'EHOSTUNREACH',
  ]);
  process.on('uncaughtException', (err) => {
    log({ event: 'error', message: 'uncaught exception', code: err?.code ?? 'unknown' });
    if (!NETWORK_ERRORS.has(err?.code)) process.exit(1);
  });

  server.on('error', (err) => {
    log({ event: 'error', message: 'server error', code: err?.code ?? 'unknown' });
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(config.listen.port, config.listen.host, resolve));
  const address = server.address();
  log({
    event: 'ready',
    port: typeof address === 'object' && address ? address.port : config.listen.port,
  });
}

main().catch((err) => {
  log({ event: 'error', message: 'startup failed', code: err?.code ?? 'unknown' });
  process.exitCode = 1;
});
