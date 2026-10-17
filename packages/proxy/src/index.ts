import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkEvent } from '@abox/core';

export {
  compileAllowEntry,
  compileAllowlist,
  formatIp,
  isBlockedAddress,
  blockedReason,
  matchAllowlist,
  normalizeHost,
  parseAuthority,
  parseCidr,
  parseIp,
  parseProxyRequestUrl,
  validateProxyConfig,
  DEFAULT_PORTS,
} from '../runtime/lib.mjs';
export type {
  AllowMatch,
  AllowRule,
  ProxyConfig,
  ProxyConfigInput,
  ProxyConfigValidation,
  ProxyInjection,
} from '../runtime/lib.mjs';

/**
 * Absolute path of `packages/proxy/runtime/`. Contains `proxy.mjs`, `lib.mjs` and
 * `Dockerfile` - the image build context. Works from `src/` and from `dist/`.
 */
export const proxyRuntimeDir: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'runtime',
);

/** Files that make up the image build context (relative to `proxyRuntimeDir`). */
export const proxyImageFiles = ['proxy.mjs', 'lib.mjs', 'Dockerfile'] as const;

/** Keep in sync with `runtime/Dockerfile` (a test asserts equality). */
export const proxyImageDockerfile = `FROM node:24-alpine
RUN apk add --no-cache openssl \\
 && adduser -D -H -u 10001 -s /sbin/nologin proxy \\
 && mkdir -p /etc/abox-proxy /run/abox-proxy \\
 && chown 10001:10001 /etc/abox-proxy /run/abox-proxy \\
 && chmod 0700 /etc/abox-proxy /run/abox-proxy
COPY proxy.mjs lib.mjs /opt/abox-proxy/
USER 10001
ENTRYPOINT ["node","/opt/abox-proxy/proxy.mjs"]
`;

/**
 * Content-addressed image tag: `abox/proxy:<first 12 hex of sha256(proxy.mjs + lib.mjs +
 * Dockerfile)>`. Changes whenever the proxy code or the image recipe changes.
 */
export function proxyImageTag(): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(join(proxyRuntimeDir, 'proxy.mjs')));
  hash.update(readFileSync(join(proxyRuntimeDir, 'lib.mjs')));
  hash.update(proxyImageDockerfile);
  return `abox/proxy:${hash.digest('hex').slice(0, 12)}`;
}

/**
 * Parse one stdout line of the proxy. Returns a `NetworkEvent` for request decisions,
 * `{ event: 'ready' }` once the proxy listens (and the CA is written), and `undefined`
 * for everything else (other events, malformed lines).
 */
export function parseProxyLogLine(
  line: string,
): NetworkEvent | { event: 'ready'; port?: number } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof obj !== 'object' || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  if (o.event === 'ready') {
    return typeof o.port === 'number' ? { event: 'ready', port: o.port } : { event: 'ready' };
  }
  if (o.event !== 'request') return undefined;
  if (
    typeof o.ts !== 'number' ||
    typeof o.host !== 'string' ||
    typeof o.port !== 'number' ||
    typeof o.method !== 'string' ||
    (o.decision !== 'allow' && o.decision !== 'deny')
  ) {
    return undefined;
  }
  const event: NetworkEvent = {
    ts: o.ts,
    host: o.host,
    port: o.port,
    method: o.method,
    decision: o.decision,
  };
  if (typeof o.ip === 'string') event.ip = o.ip;
  if (typeof o.reason === 'string') event.reason = o.reason;
  return event;
}
