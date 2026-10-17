import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AboxError, parseSandboxId, type SandboxId } from '@abox/core';
import { errno, isInside, writeFileAtomic } from './fsutil.js';

/**
 * On-disk layout (all below `<dataDir>/process/`):
 *
 *   images/<hash>                 marker that `prepare()` saw this template hash
 *   sandboxes/<short>/
 *     meta.json                   source of truth for list/inspect (written last on create)
 *     env.json                    spec env incl. approved `inject: env` secrets, mode 0600
 *     root/                       the sandbox filesystem root
 *     run/<pid>                   one marker per process group started by exec/spawn
 *     snapshots/<name>/           copies of root/ (see snapshot())
 *
 * The directory name `<short>` is the part of the sandbox id after `<host>/`.
 */

export const SHORT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
export const IMAGE_HASH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const USER_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

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
  /** Sandbox path of the workspace; default cwd of exec. */
  workspacePath: string;
  workspaceKind: 'none' | 'copy';
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
    typeof m['workspacePath'] === 'string'
  );
}

export class Layout {
  readonly base: string;
  readonly imagesDir: string;
  readonly sandboxesDir: string;

  constructor(dataDir: string) {
    this.base = join(resolve(dataDir), 'process');
    this.imagesDir = join(this.base, 'images');
    this.sandboxesDir = join(this.base, 'sandboxes');
  }

  sandboxDir(short: string): string {
    return join(this.sandboxesDir, short);
  }
  rootDir(short: string): string {
    return join(this.sandboxDir(short), 'root');
  }
  metaFile(short: string): string {
    return join(this.sandboxDir(short), 'meta.json');
  }
  envFile(short: string): string {
    return join(this.sandboxDir(short), 'env.json');
  }
  runDir(short: string): string {
    return join(this.sandboxDir(short), 'run');
  }
  snapshotsDir(short: string): string {
    return join(this.sandboxDir(short), 'snapshots');
  }

  /**
   * Safety net for destructive operations: asserts that `p` lies strictly below
   * the sandboxes directory (never the data dir itself or anything outside it).
   */
  assertWithinSandboxes(p: string): void {
    const abs = resolve(p);
    if (abs === this.sandboxesDir || !isInside(this.sandboxesDir, abs)) {
      throw new AboxError('internal', `refusing to touch '${abs}': outside ${this.sandboxesDir}`);
    }
  }

  async ensureBase(): Promise<void> {
    await mkdir(this.imagesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.sandboxesDir, { recursive: true, mode: 0o700 });
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
      const parsed: unknown = JSON.parse(await readFile(this.envFile(short), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    } catch {
      return {};
    }
  }

  /** Names of all directories under `sandboxes/` (without validating their content). */
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

/** Serializes read-modify-write cycles on one sandbox's meta.json within this process. */
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
