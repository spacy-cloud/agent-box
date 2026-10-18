// abox port forwarder: the sidecar that publishes one port of a sandbox on 127.0.0.1 of the host.
//
// Dependency-free Node.js ESM, run by the container backend inside the `abox/forward` image (see
// forward.ts). The container sits on the sandbox's network and listens on FWD_LISTEN_PORT; the
// engine publishes that port on 127.0.0.1 of the host only. Every accepted connection is piped to
// FWD_TARGET_HOST:FWD_TARGET_PORT (the sandbox). It connects nowhere else and has no other
// behaviour: no DNS, no proxying, no way to reach anything but that one address.
//
// Configuration (environment):
//   FWD_TARGET_HOST   IP address of the sandbox on the shared network (required)
//   FWD_TARGET_PORT   TCP port in the sandbox (required)
//   FWD_LISTEN_PORT   port inside this container (default 8080)
//   FWD_LISTEN_HOST   address it listens on (default 0.0.0.0: inside its own container; the engine publishes on 127.0.0.1 only)
//   FWD_EXPIRES       sandbox deadline, epoch seconds (the container ends itself then)
//   FWD_EXPIRES_FILE  file with a later deadline, written by `extendExpiry` (default /etc/abox-fwd/expires)
//
// Output (stdout, JSON lines; no per-connection lines):
//   {"event":"ready","port":8080,"target":"up"|"down"}      once, after the first probe of the target
//   {"event":"stats","connections":N,"rejected":N,"failed":N,"active":N,"target":"up"|"down"|"unknown"}
//                                                            running totals; at most four lines a second, none while idle
//   {"event":"expired"}                                      right before it ends itself at the deadline
//
// Browser protection: a connection that starts like an HTTP/1.x request is only passed on when its
// Host header names the loopback (`127.0.0.1`, `localhost`, `*.localhost`, `[::1]`). A web page on
// another origin that points its own name at 127.0.0.1 (DNS rebinding) sends a different Host and
// gets a 403 instead of reaching the dev server. Traffic that does not start like HTTP (TLS, other
// protocols) is passed on untouched. This guards against browsers; it is not authentication, and
// any local process can still connect.

/* global process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval */

import { connect, createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Longest request head that is buffered while the Host header is checked. */
export const MAX_HEAD_BYTES = 16 * 1024;
/** How long a client may take to send the head of an HTTP request. */
export const HEAD_TIMEOUT_MS = 10_000;
/** A client that sends nothing for this long is treated as speaking a server-first protocol. */
export const FIRST_BYTES_TIMEOUT_MS = 1_500;
/** Most connections at once. */
export const MAX_CONNECTIONS = 256;

const METHOD = /^[A-Z]{3,10} /;

/** Do the first bytes look like the start of an HTTP/1.x request line? */
export function looksLikeHttp(buf) {
  return METHOD.test(buf.subarray(0, 12).toString('latin1'));
}

/** Is `hostname` (no port, lower case, brackets kept for IPv6) a loopback name? */
export function isLoopbackName(hostname) {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/** The host name of an authority (`host:port`, `[v6]:port`, `host`), lower case. */
export function hostnameOf(authority) {
  const a = authority.trim().toLowerCase();
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end < 0 ? a : a.slice(0, end + 1);
  }
  const colon = a.lastIndexOf(':');
  return colon < 0 ? a : a.slice(0, colon);
}

/**
 * Checks the head of an HTTP request (everything before the blank line). Returns `{ ok: true }`, or
 * `{ ok: false, reason }` when a Host header names something else than the loopback, appears more
 * than once, or an absolute request target does. A request without Host (HTTP/1.0) passes: a
 * browser always sends one.
 */
export function checkRequestHead(head) {
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const target = requestLine.split(' ')[1] ?? '';
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(target);
  if (absolute && !isLoopbackName(hostnameOf(absolute[1] ?? ''))) {
    return { ok: false, reason: `the request target names ${absolute[1]}` };
  }
  const hosts = [];
  for (const line of lines.slice(1)) {
    const m = /^host[ \t]*:(.*)$/i.exec(line);
    if (m) hosts.push((m[1] ?? '').trim());
  }
  if (hosts.length > 1) return { ok: false, reason: 'more than one Host header' };
  if (hosts.length === 1 && !isLoopbackName(hostnameOf(hosts[0] ?? ''))) {
    return { ok: false, reason: `the Host header names ${hosts[0]}` };
  }
  return { ok: true };
}

function httpReply(status, text, body) {
  const payload = `${body}\n`;
  return (
    `HTTP/1.1 ${status} ${text}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    'Cache-Control: no-store\r\n' +
    'Connection: close\r\n\r\n' +
    payload
  );
}

function readDeadline(env, file) {
  let expires = Number(env.FWD_EXPIRES) || 0;
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (/^\d{1,15}$/.test(text)) expires = Math.max(expires, Number(text));
  } catch {
    // no extension file: the deadline from the environment stands
  }
  return expires;
}

/**
 * Starts the forwarder. Returns `{ server, stats, close, ready }`; `ready` resolves once it listens
 * and has probed the target. `onExpired` is called when the deadline passed (after the forwarder
 * closed itself).
 */
export function startForwarder(
  env = process.env,
  { log = (o) => console.log(JSON.stringify(o)), onExpired = () => process.exit(0) } = {},
) {
  const listenPort = Number(env.FWD_LISTEN_PORT || 8080);
  const targetHost = env.FWD_TARGET_HOST ?? '';
  const targetPort = Number(env.FWD_TARGET_PORT);
  if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('FWD_TARGET_HOST and FWD_TARGET_PORT are required');
  }
  const expiresFile = env.FWD_EXPIRES_FILE || '/etc/abox-fwd/expires';
  const stats = { connections: 0, rejected: 0, failed: 0, active: 0, target: 'unknown' };
  let dirty = false;
  let closed = false;
  const timers = [];

  const printStats = () => {
    if (!dirty) return;
    dirty = false;
    log({ event: 'stats', ...stats });
  };
  let flush;
  const touch = () => {
    dirty = true;
    // a burst of connections is one line, a quiet forwarder prints nothing
    if (flush === undefined) {
      flush = setTimeout(() => {
        flush = undefined;
        printStats();
      }, 250);
      flush.unref();
    }
  };

  const sockets = new Set();
  const server = createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    stats.connections += 1;
    stats.active += 1;
    touch();
    client.on('error', () => client.destroy());
    client.on('close', () => {
      stats.active -= 1;
      touch();
    });

    let buf = Buffer.alloc(0);
    let http = false;
    let done = false;
    let firstTimer;
    let headTimer;
    const clearTimers = () => {
      clearTimeout(firstTimer);
      clearTimeout(headTimer);
    };
    const reject = (status, text, body) => {
      if (done) return;
      done = true;
      clearTimers();
      client.removeAllListeners('data');
      stats.rejected += 1;
      touch();
      client.end(httpReply(status, text, body));
    };
    const pass = () => {
      if (done) return;
      done = true;
      clearTimers();
      client.removeAllListeners('data');
      client.pause();
      const upstream = connect({ host: targetHost, port: targetPort });
      upstream.setNoDelay(true);
      let connected = false;
      upstream.once('connect', () => {
        connected = true;
        stats.target = 'up';
        touch();
        if (buf.length > 0) upstream.write(buf);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', (e) => {
        if (connected) {
          // broke in the middle of a conversation: nothing to explain, just end it
          upstream.destroy();
          client.destroy();
          return;
        }
        stats.failed += 1;
        stats.target =
          e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' ? 'down' : stats.target;
        touch();
        if (http && client.writable) {
          client.end(
            httpReply(
              502,
              'Bad Gateway',
              `abox: nothing answers on port ${targetPort} inside the sandbox (${e.code ?? 'error'}).\n` +
                'Start the server there and let it listen on 0.0.0.0; a server bound to 127.0.0.1 only is not reachable from outside.',
            ),
          );
        } else {
          client.destroy();
        }
        upstream.destroy();
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    };

    firstTimer = setTimeout(() => {
      // nothing came: a protocol where the server speaks first
      if (!done && buf.length === 0) pass();
    }, FIRST_BYTES_TIMEOUT_MS);
    headTimer = setTimeout(() => {
      if (!done) reject(408, 'Request Timeout', 'abox: the request head did not arrive in time');
    }, HEAD_TIMEOUT_MS);

    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      http = looksLikeHttp(buf);
      if (!http) {
        pass();
        return;
      }
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > MAX_HEAD_BYTES)
          reject(431, 'Request Header Fields Too Large', 'abox: request head too large');
        return;
      }
      const verdict = checkRequestHead(buf.subarray(0, end).toString('latin1'));
      if (!verdict.ok) {
        reject(
          403,
          'Forbidden',
          `abox: refused (${verdict.reason}). This port is only meant for 127.0.0.1 / localhost.`,
        );
        return;
      }
      pass();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;

  const probe = () =>
    new Promise((resolve) => {
      const s = connect({ host: targetHost, port: targetPort });
      const finish = (state) => {
        s.destroy();
        stats.target = state;
        resolve(state);
      };
      s.setTimeout(2000, () => finish('down'));
      s.once('connect', () => finish('up'));
      s.once('error', () => finish('down'));
    });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearInterval(t);
    dirty = true;
    printStats();
    server.close();
    for (const c of sockets) c.destroy();
  };

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, env.FWD_LISTEN_HOST || '0.0.0.0', async () => {
      const target = await probe();
      log({ event: 'ready', port: listenPort, target });
      resolve();
    });
  });

  timers.push(
    setInterval(() => {
      const expires = readDeadline(env, expiresFile);
      if (expires > 0 && Date.now() / 1000 >= expires) {
        log({ event: 'expired' });
        close();
        onExpired();
      }
    }, 2000),
  );
  for (const t of timers) t.unref();

  return { server, stats, close, ready };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let fwd;
  try {
    fwd = startForwarder();
  } catch (e) {
    console.error(`abox-forward: ${e.message}`);
    process.exit(2);
  }
  const stop = () => {
    fwd.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  fwd.ready.catch((e) => {
    console.error(`abox-forward: ${e.message}`);
    process.exit(1);
  });
}
