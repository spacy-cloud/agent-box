import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import type { PortForwardTarget } from '@abox/core';
import { buildImage } from './build.js';
import { LABEL } from './labels.js';
import { tarFromEntries } from './tar.js';
import { statusOf } from './errors.js';

/**
 * The port forwarder sidecar (`runtime/forward.mjs`): one tiny container per forward, on the
 * sandbox's network, that listens on `FORWARD_PORT` and pipes every connection to the sandbox
 * port. The engine publishes `FORWARD_PORT` on `127.0.0.1` of the host. The container outlives the
 * abox process that created it (the CLI is short-lived) and is removed with the sandbox. It is
 * built from the program shipped in this package on top of the same Node base image as the egress
 * proxy (no registry image of a third party).
 */

/** Port the forwarder listens on inside its container (unprivileged, so above 1024). */
export const FORWARD_PORT = 8080;
/** The unprivileged user the forwarder runs as (created by the Dockerfile). */
export const FORWARD_UID = 10001;
/** Directory (a volume, root-owned) with the deadline file `extendExpiry` writes. */
export const FORWARD_CONFIG_DIR = '/etc/abox-fwd';
export const FORWARD_EXPIRES_PATH = `${FORWARD_CONFIG_DIR}/expires`;

/** Absolute path of `packages/backend-docker/runtime/`. Works from `src/` and from `dist/`. */
export const forwardRuntimeDir: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'runtime',
);

/** The image recipe. Keep the base image equal to the egress proxy's: it is already on the engine. */
export const forwardDockerfile = `FROM node:24-alpine
RUN adduser -D -H -u ${FORWARD_UID} -s /sbin/nologin fwd \\
 && mkdir -p ${FORWARD_CONFIG_DIR} \\
 && chmod 0755 ${FORWARD_CONFIG_DIR}
COPY forward.mjs /opt/abox-fwd/forward.mjs
USER ${FORWARD_UID}
ENTRYPOINT ["node","/opt/abox-fwd/forward.mjs"]
`;

/** `abox/forward:<first 12 hex of sha256(forward.mjs + Dockerfile)>`: changes with the program or the recipe. */
export function forwardImageTag(
  script: Buffer = readFileSync(join(forwardRuntimeDir, 'forward.mjs')),
): string {
  const h = createHash('sha256');
  h.update(forwardDockerfile);
  h.update('\0');
  h.update(script);
  return `abox/forward:${h.digest('hex').slice(0, 12)}`;
}

/** Make sure the forwarder image exists on the engine (build it from the shipped program otherwise). */
export async function ensureForwardImage(
  docker: Docker,
  onProgress?: (line: string) => void,
): Promise<string> {
  const script = readFileSync(join(forwardRuntimeDir, 'forward.mjs'));
  const tag = forwardImageTag(script);
  try {
    await docker.getImage(tag).inspect();
    return tag;
  } catch (e) {
    if (statusOf(e) !== 404) throw e;
  }
  const context = await tarFromEntries([
    { name: 'Dockerfile', data: Buffer.from(forwardDockerfile, 'utf8') },
    { name: 'forward.mjs', data: script },
  ]);
  try {
    await buildImage(docker, Readable.from([context]), {
      tag,
      // shared infrastructure like the proxy image: no instance id, never removed by a provider
      labels: { [LABEL.managed]: '1', [LABEL.role]: 'forward' },
      ...(onProgress ? { onProgress } : {}),
    });
  } catch (e) {
    if (e instanceof AboxError) {
      throw new AboxError(
        'backend_error',
        `Could not build the port forwarder image: ${e.message}`,
        {
          ...(e.details ? { details: e.details } : {}),
          cause: e,
        },
      );
    }
    throw e;
  }
  return tag;
}

/** What a forwarder printed last (its log is a few JSON lines: ready, stats, expired). */
export interface ForwardLogState {
  ready: boolean;
  expired: boolean;
  target: PortForwardTarget;
  connections: number;
  rejected: number;
  failed: number;
}

/** Reads the state out of a forwarder's log text; unknown lines are ignored. */
export function parseForwardLog(log: string): ForwardLogState {
  const state: ForwardLogState = {
    ready: false,
    expired: false,
    target: 'unknown',
    connections: 0,
    rejected: 0,
    failed: 0,
  };
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const target = (v: unknown): PortForwardTarget => (v === 'up' || v === 'down' ? v : 'unknown');
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    if (o['event'] === 'ready') {
      state.ready = true;
      state.target = target(o['target']);
    } else if (o['event'] === 'stats') {
      state.target = target(o['target']);
      state.connections = num(o['connections']);
      state.rejected = num(o['rejected']);
      state.failed = num(o['failed']);
    } else if (o['event'] === 'expired') {
      state.expired = true;
    }
  }
  return state;
}
