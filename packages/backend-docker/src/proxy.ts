import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import type { NetworkSpec } from '@abox/core';
import { buildImage } from './build.js';
import { LABEL, PROXY_PORT } from './labels.js';
import { tarFromEntries, type MemEntry } from './tar.js';

/** What the egress proxy package ships (see docs/internal/proxy-contract.md). */
export interface ProxyAssets {
  /** Directory containing `proxy.mjs` (and any helper modules). */
  runtimeDir: string;
  /** Dockerfile text for the proxy image. */
  dockerfile: string;
  /** Files of `runtimeDir` that form the build context (default: everything except Dockerfile/.d.mts). */
  files?: readonly string[];
  /** Image tag computed by `@abox/proxy` (default: computed here from files + Dockerfile). */
  tag?: string;
}

export async function loadProxyAssets(): Promise<ProxyAssets | undefined> {
  try {
    const mod = (await import('@abox/proxy')) as unknown as {
      proxyRuntimeDir?: unknown;
      proxyImageDockerfile?: unknown;
      proxyImageFiles?: unknown;
      proxyImageTag?: unknown;
    };
    if (
      typeof mod.proxyRuntimeDir === 'string' &&
      typeof mod.proxyImageDockerfile === 'string' &&
      existsSync(path.join(mod.proxyRuntimeDir, 'proxy.mjs'))
    ) {
      const files = Array.isArray(mod.proxyImageFiles)
        ? (mod.proxyImageFiles as unknown[]).filter(
            (f): f is string => typeof f === 'string' && f !== 'Dockerfile',
          )
        : undefined;
      let tag: string | undefined;
      if (typeof mod.proxyImageTag === 'function') {
        try {
          const t = (mod.proxyImageTag as () => unknown)();
          if (typeof t === 'string') tag = t;
        } catch {
          // fall back to the locally computed tag
        }
      }
      return {
        runtimeDir: mod.proxyRuntimeDir,
        dockerfile: mod.proxyImageDockerfile,
        ...(files ? { files } : {}),
        ...(tag ? { tag } : {}),
      };
    }
  } catch {
    // proxy package not built / not available: allowlist mode is reported as unsupported
  }
  return undefined;
}

/** Resolved once at import time; `undefined` when the proxy runtime is missing. */
export const defaultProxyAssets: ProxyAssets | undefined = await loadProxyAssets();

/** UID:GID the proxy container runs as (the unprivileged `proxy` user created by the proxy Dockerfile). */
export const PROXY_USER_UID = 10001;
export const PROXY_USER = `${PROXY_USER_UID}:${PROXY_USER_UID}`;
export const PROXY_CONFIG_DIR = '/etc/abox-proxy';
export const PROXY_CONFIG_PATH = `${PROXY_CONFIG_DIR}/config.json`;
export const PROXY_RUN_DIR = '/run/abox-proxy';
export const PROXY_CA_PATH = `${PROXY_RUN_DIR}/ca.crt`;

async function readRuntimeFiles(dir: string): Promise<Array<{ name: string; data: Buffer }>> {
  const out: Array<{ name: string; data: Buffer }> = [];
  const walk = async (rel: string): Promise<void> => {
    for (const ent of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(r);
      else if (ent.isFile() && r !== 'Dockerfile' && !r.endsWith('.d.mts'))
        out.push({ name: r, data: await fs.readFile(path.join(dir, r)) });
    }
  };
  await walk('');
  return out;
}

/** Tag of the proxy image for these assets: `abox/proxy:<first 12 hex of sha256(runtime + Dockerfile)>`. */
export async function proxyImageTag(
  assets: ProxyAssets,
): Promise<{ tag: string; files: Array<{ name: string; data: Buffer }> }> {
  let files = await readRuntimeFiles(assets.runtimeDir);
  if (assets.files) files = files.filter((f) => assets.files?.includes(f.name));
  if (assets.tag) return { tag: assets.tag, files };
  const h = createHash('sha256');
  h.update(assets.dockerfile);
  for (const f of files) {
    h.update('\0');
    h.update(f.name);
    h.update('\0');
    h.update(f.data);
  }
  return { tag: `abox/proxy:${h.digest('hex').slice(0, 12)}`, files };
}

/** Make sure the proxy image exists locally (build it from the shipped Dockerfile otherwise). */
export async function ensureProxyImage(
  docker: Docker,
  assets: ProxyAssets,
  extraLabels: Record<string, string>,
  onProgress?: (line: string) => void,
): Promise<string> {
  const { tag, files } = await proxyImageTag(assets);
  try {
    await docker.getImage(tag).inspect();
    return tag;
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 404) throw e;
  }
  const entries: MemEntry[] = [
    { name: 'Dockerfile', data: Buffer.from(assets.dockerfile, 'utf8') },
  ];
  for (const f of files) entries.push({ name: f.name, data: f.data });
  const context = await tarFromEntries(entries);
  try {
    await buildImage(docker, Readable.from([context]), {
      tag,
      labels: { [LABEL.managed]: '1', [LABEL.role]: 'proxy', ...extraLabels },
      ...(onProgress ? { onProgress } : {}),
    });
  } catch (e) {
    if (e instanceof AboxError) {
      throw new AboxError('backend_error', `Could not build the egress proxy image: ${e.message}`, {
        ...(e.details ? { details: e.details } : {}),
        cause: e,
      });
    }
    throw e;
  }
  return tag;
}

/** The JSON the proxy reads from `/etc/abox-proxy/config.json`. Contains secrets: file only. */
export function proxyConfigJson(net: NetworkSpec): string {
  return JSON.stringify({
    listen: { host: '0.0.0.0', port: PROXY_PORT },
    allow: net.allow,
    blockPrivate: net.blockPrivate,
    privateExceptions: net.privateExceptions,
    injections: net.injections.map((i) => ({ host: i.host, header: i.header, value: i.value })),
  });
}

export interface ProxyLogEvent {
  ts?: number;
  event?: string;
  method?: string;
  host?: string;
  port?: number;
  ip?: string;
  decision?: 'allow' | 'deny';
  reason?: string;
}

/** Parse one stdout line of the proxy; returns undefined for non-JSON lines. */
export function parseProxyLine(line: string): ProxyLogEvent | undefined {
  const s = line.trim();
  if (!s.startsWith('{')) return undefined;
  try {
    const o = JSON.parse(s) as unknown;
    return typeof o === 'object' && o !== null ? (o as ProxyLogEvent) : undefined;
  } catch {
    return undefined;
  }
}
