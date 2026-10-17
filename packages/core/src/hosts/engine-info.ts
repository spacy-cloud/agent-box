import { request } from 'node:http';

/** What the abox host checks need to know about a container engine. */
export interface EngineInfo {
  /** `SecurityOptions` contains `name=rootless` (Docker and the Podman compat API). */
  rootless: boolean;
  /** Names of the OCI runtimes the engine knows (`Runtimes` of `/info`), e.g. `runc`, `runsc`. */
  runtimes: string[];
  /** Engine's own name for the server, when it reports one. */
  name?: string;
}

/**
 * Sockets of the system-wide (rootful) engines. Whoever can talk to one of these is root on that
 * machine, so a host with its own services or data (zone `shared`, `restricted`) must not use them
 * as `engine_socket` unless the profile says `allow_rootful: true`. The engine's own answer
 * (`getEngineInfo().rootless`) is the authoritative check; this list catches the obvious mistake
 * before any connection is made.
 */
const SYSTEM_ENGINE_SOCKETS = new Set([
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/run/podman/podman.sock',
  '/run/podman/podman.sock',
  '/var/run/podman.sock',
]);

export function isSystemEngineSocket(path: string): boolean {
  return SYSTEM_ENGINE_SOCKETS.has(path.replace(/\/{2,}/g, '/'));
}

/** Pure: reads the fields abox cares about from a Docker/Podman `/info` document. */
export function parseEngineInfo(doc: unknown): EngineInfo | undefined {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined;
  const o = doc as Record<string, unknown>;
  const sec = Array.isArray(o['SecurityOptions']) ? (o['SecurityOptions'] as unknown[]) : undefined;
  const rt = o['Runtimes'];
  // An engine that reports neither field is not something we can judge.
  if (sec === undefined && (typeof rt !== 'object' || rt === null)) return undefined;
  const runtimes =
    typeof rt === 'object' && rt !== null && !Array.isArray(rt) ? Object.keys(rt) : [];
  return {
    rootless: (sec ?? []).some((x) => typeof x === 'string' && x.includes('name=rootless')),
    runtimes,
    ...(typeof o['Name'] === 'string' ? { name: o['Name'] } : {}),
  };
}

/**
 * `GET /info` over a (forwarded) unix socket. Returns undefined when the engine does not answer
 * with a usable document; callers decide what that means for them.
 */
export function getEngineInfo(
  socketPath: string,
  timeoutMs = 5000,
): Promise<EngineInfo | undefined> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/info', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        if (body.length < 4 * 1024 * 1024) body += d;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(undefined);
        try {
          resolve(parseEngineInfo(JSON.parse(body)));
        } catch {
          resolve(undefined);
        }
      });
      res.on('error', () => resolve(undefined));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
    req.end();
  });
}
