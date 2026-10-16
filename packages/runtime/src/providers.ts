import { join } from 'node:path';
import {
  loadConfig,
  resolvePaths,
  type AboxConfig,
  type AboxPaths,
  type BackendKind,
  type ProviderFactory,
} from '@abox/core';
import { createDockerProvider, createPodmanProvider } from '@abox/backend-docker';
import { createProcessProvider } from '@abox/backend-process';

/** What a provider-factory maker may use to configure its backend. */
export interface ProviderContext {
  env: NodeJS.ProcessEnv;
  paths: AboxPaths;
  config: AboxConfig;
}

/** Turns the runtime context into the `ProviderFactory` the manager calls once per host. */
export type ProviderFactoryMaker = (ctx: ProviderContext) => ProviderFactory;

const registry = new Map<BackendKind, ProviderFactoryMaker>();

/** Socket of a container engine: config.yaml, then the environment, then the default location. */
export function engineSocket(
  kind: 'docker' | 'podman',
  ctx: ProviderContext,
  forwarded?: string,
): string {
  if (forwarded) return forwarded;
  const configured = ctx.config.backends[kind].socket;
  if (configured) return configured;
  const { env } = ctx;
  if (kind === 'docker') {
    const host = env['DOCKER_HOST'];
    if (host?.startsWith('unix://')) return host.slice('unix://'.length);
    if (host) return host; // unusable for dockerode (tcp://...) -> the backend reports backend_unavailable
    return '/var/run/docker.sock';
  }
  const host = env['CONTAINER_HOST'];
  if (host?.startsWith('unix://')) return host.slice('unix://'.length);
  const runtime = env['XDG_RUNTIME_DIR'] ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return join(runtime, 'podman', 'podman.sock');
}

registry.set(
  'docker',
  (ctx) => (host) =>
    createDockerProvider(host, { socketPath: engineSocket('docker', ctx, host.engineSocket) }),
);
registry.set(
  'podman',
  (ctx) => (host) =>
    createPodmanProvider(host, { socketPath: engineSocket('podman', ctx, host.engineSocket) }),
);
registry.set(
  'process',
  (ctx) => (host) => createProcessProvider(host, { dataDir: host.dataDir ?? ctx.paths.dataDir }),
);

// TODO(lead): register the two remaining backends once their packages are finished:
//   import { createVmProvider } from '@abox/backend-vm';
//   registerProvider('vm', ({ paths }) => (host) =>
//     createVmProvider(host, { dataDir: paths.dataDir, cacheDir: paths.cacheDir }));
//   import { createPythonProvider } from '@abox/backend-python';
//   registerProvider('python', (ctx) => (host) => createPythonProvider(host, { ... }));

/** Registers (or replaces) the backend `kind`. Call before `openAbox`. */
export function registerProvider(kind: BackendKind, maker: ProviderFactoryMaker): void {
  registry.set(kind, maker);
}

/** Removes a registered backend (tests; a surface that wants to run without it). */
export function unregisterProvider(kind: BackendKind): boolean {
  return registry.delete(kind);
}

export function registeredBackends(): BackendKind[] {
  return [...registry.keys()];
}

/**
 * The provider factories for every registered backend, as `Abox.open({providers})` expects them.
 * Used by the CLI/MCP (through `openAbox`) and by the GUI main process.
 */
export function providerFactories(
  opts: { env?: NodeJS.ProcessEnv; paths?: AboxPaths; config?: AboxConfig } = {},
): Partial<Record<BackendKind, ProviderFactory>> {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? resolvePaths(env);
  const config = opts.config ?? loadConfig(paths.configFile);
  const ctx: ProviderContext = { env, paths, config };
  const out: Partial<Record<BackendKind, ProviderFactory>> = {};
  for (const [kind, maker] of registry) out[kind] = maker(ctx);
  return out;
}
