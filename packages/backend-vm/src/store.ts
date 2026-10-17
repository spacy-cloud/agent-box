import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AboxError, parseSandboxId, type NetworkMode, type SandboxId } from '@abox/core';
import { errno, isInside, writeFileAtomic } from './fsutil.js';

/**
 * On-disk layout.
 *
 *   <dataDir>/vm/sandboxes/<short>/            (0700)
 *     meta.json                  source of truth for list/inspect (written last on create)
 *     env.json                   spec env incl. approved `inject: env` secrets, 0600
 *     net.json                   network rules incl. proxy injections (secret values), 0600
 *     disk.qcow2                 copy-on-write overlay of the prepared image
 *     qemu.pid, qemu.log         pid file written by QEMU, QEMU stderr
 *     console.log                last console output of the previous run
 *     proxy/                     egress proxy of `allowlist` sandboxes (config 0600, socket, log, state)
 *     init/                      staged workspace tarball and spec files until first boot
 *
 *   $XDG_RUNTIME_DIR/abox-vm/<hash of dataDir>/<short>/   (0700, short paths: unix sockets are limited to ~100 chars)
 *     qmp.sock, qga.sock         QEMU monitor / guest agent
 *
 *   <cacheDir>/
 *     base/<id>-<hash16>.qcow2   verified vendor images (immutable)
 *     prepared/<templateHash>/   current (build id) and <buildId>/{disk.qcow2 (overlay of the base), meta.json}
 *     locks/
 */

export const SHORT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
export const IMAGE_HASH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Lifecycle state persisted in meta.json (`expired` is derived from `expiresAt`, never stored). */
export type StoredState = 'created' | 'running' | 'stopped';

export interface SandboxMeta {
  version: 1;
  id: SandboxId;
  host: string;
  short: string;
  name: string;
  owner: string;
  template: string;
  templateHash: string;
  createdAt: number;
  expiresAt: number;
  labels: Record<string, string>;
  state: StoredState;
  user: { name: string; uid: number; sudo: boolean };
  workspacePath: string;
  workspaceKind: 'none' | 'copy';
  image: { ref: string; baseId: string };
  resources: { cpus: number; memoryMiB: number; diskBytes: number; pids: number };
  network: {
    mode: NetworkMode;
    allow: string[];
    blockPrivate: boolean;
    privateExceptions: string[];
    injections: number;
  };
  /** True once spec files and the staged workspace were delivered into the guest. */
  provisioned: boolean;
  snapshots: Array<{ name: string; createdAt: number }>;
}

export function isMeta(v: unknown): v is SandboxMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m['version'] === 1 &&
    typeof m['id'] === 'string' &&
    typeof m['host'] === 'string' &&
    typeof m['short'] === 'string' &&
    typeof m['name'] === 'string' &&
    typeof m['owner'] === 'string' &&
    typeof m['template'] === 'string' &&
    typeof m['templateHash'] === 'string' &&
    typeof m['createdAt'] === 'number' &&
    typeof m['expiresAt'] === 'number' &&
    typeof m['labels'] === 'object' &&
    (m['state'] === 'created' || m['state'] === 'running' || m['state'] === 'stopped') &&
    typeof m['user'] === 'object' &&
    typeof m['workspacePath'] === 'string' &&
    typeof m['image'] === 'object' &&
    typeof m['resources'] === 'object' &&
    typeof m['network'] === 'object'
  );
}

export interface NetFile {
  allow: string[];
  blockPrivate: boolean;
  privateExceptions: string[];
  injections: Array<{ host: string; header: string; value: string }>;
}

export class Layout {
  readonly base: string;
  readonly sandboxesDir: string;
  readonly cacheDir: string;
  readonly preparedDir: string;
  readonly locksDir: string;
  /** Parent of the per-sandbox runtime directories (sockets). */
  readonly runRoot: string;

  constructor(dataDir: string, cacheDir: string) {
    const rt = process.env['XDG_RUNTIME_DIR'];
    const runBase =
      rt && rt.startsWith('/') ? rt : join(tmpdir(), `abox-${process.getuid?.() ?? 'u'}`);
    this.runRoot = join(
      runBase,
      'abox-vm',
      createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 10),
    );
    this.base = join(resolve(dataDir), 'vm');
    this.sandboxesDir = join(this.base, 'sandboxes');
    this.cacheDir = resolve(cacheDir);
    this.preparedDir = join(this.cacheDir, 'prepared');
    this.locksDir = join(this.cacheDir, 'locks');
  }

  sandboxDir(short: string): string {
    return join(this.sandboxesDir, short);
  }
  file(short: string, name: string): string {
    return join(this.sandboxDir(short), name);
  }
  metaFile(short: string): string {
    return this.file(short, 'meta.json');
  }
  diskFile(short: string): string {
    return this.file(short, 'disk.qcow2');
  }
  runDir(short: string): string {
    return join(this.runRoot, short);
  }
  /** Epoch second at which the host kills QEMU; read by the watchdog that wraps QEMU (see `HARD_LIMIT_SCRIPT`). */
  hardLimitFile(short: string): string {
    return join(this.runDir(short), 'hardlimit');
  }
  qmpSocket(short: string): string {
    return join(this.runDir(short), 'qmp.sock');
  }
  qgaSocket(short: string): string {
    return join(this.runDir(short), 'qga.sock');
  }
  pidFile(short: string): string {
    return this.file(short, 'qemu.pid');
  }
  proxyDir(short: string): string {
    return this.file(short, 'proxy');
  }
  initDir(short: string): string {
    return this.file(short, 'init');
  }
  /** `prepared/<templateHash>/` holds one directory per build plus a `current` file naming the active one. */
  preparedHashDir(hash: string): string {
    return join(this.preparedDir, hash);
  }
  preparedCurrentFile(hash: string): string {
    return join(this.preparedDir, hash, 'current');
  }
  preparedBuildDir(hash: string, buildId: string): string {
    return join(this.preparedDir, hash, buildId);
  }

  /** Safety net for destructive operations: `p` must lie strictly below the sandboxes directory. */
  assertWithinSandboxes(p: string): void {
    const abs = resolve(p);
    if (abs === this.sandboxesDir || !isInside(this.sandboxesDir, abs)) {
      throw new AboxError('internal', `refusing to touch '${abs}': outside ${this.sandboxesDir}`);
    }
  }

  async ensureBase(): Promise<void> {
    await mkdir(this.sandboxesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.preparedDir, { recursive: true, mode: 0o700 });
    await mkdir(this.locksDir, { recursive: true, mode: 0o700 });
  }

  /** Validates an id for this host and returns its directory name; `undefined` when it cannot belong to us. */
  shortOf(id: SandboxId, hostId: string): string | undefined {
    const { host, short } = parseSandboxId(id);
    if (host !== hostId || !SHORT_RE.test(short)) return undefined;
    return short;
  }

  async readMeta(short: string): Promise<SandboxMeta | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.metaFile(short), 'utf8');
    } catch (e) {
      if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return undefined;
      throw e;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isMeta(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async writeMeta(meta: SandboxMeta): Promise<void> {
    await writeFileAtomic(this.metaFile(meta.short), JSON.stringify(meta, null, 2) + '\n', 0o600);
  }

  async readEnv(short: string): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(short, 'env.json'), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    } catch {
      return {};
    }
  }

  async readNet(short: string): Promise<NetFile | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.file(short, 'net.json'), 'utf8')) as NetFile;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async listShorts(): Promise<string[]> {
    try {
      const entries = await readdir(this.sandboxesDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && SHORT_RE.test(e.name)).map((e) => e.name);
    } catch (e) {
      if (errno(e) === 'ENOENT') return [];
      throw e;
    }
  }
}

/** Serializes lifecycle operations on one sandbox within this process. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
