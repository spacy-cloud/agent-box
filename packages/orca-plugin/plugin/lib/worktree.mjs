// @ts-check
/**
 * Worktree <-> sandbox linkage. Orca's host API deliberately does not expose the path of the
 * focused worktree (`workspace.readContext` returns branch, display name and terminal ids only),
 * so the link is built from two things the plugin can know:
 *
 *   1. a deterministic sandbox NAME derived from the branch (`wt-<slug>`), and
 *   2. the worktree PATH, remembered from `worktree.created` events (plugin storage) and used for
 *      `--workspace` and for matching `workspace.source` of existing sandboxes.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const CACHE_KEY = 'worktrees';
const CACHE_LIMIT = 500;

/**
 * @param {string} value
 * @param {number} [max]
 */
export function slugify(value, max = 32) {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'worktree';
}

/** Sandbox name for a branch (or display name when the HEAD is detached). */
export function sandboxNameFor(/** @type {string} */ branchOrName) {
  return `wt-${slugify(branchOrName)}`;
}

/**
 * Idempotency key: repeating "create" for the same worktree returns the same sandbox.
 * @param {string} identity the worktree path, or `branch:<name>` when the path is unknown
 */
export function requestIdFor(identity) {
  return `orca-wt-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

/**
 * Sandboxes that belong to a worktree: same `workspace.source`, or the derived name.
 * Removed/failed sandboxes never count.
 * @param {Array<import('./abox-cli.mjs').SandboxSummary>} sandboxes
 * @param {{path?: string | null, branch: string}} wt
 */
export function findLinked(sandboxes, wt) {
  const name = sandboxNameFor(wt.branch);
  const path = wt.path ? resolve(wt.path) : null;
  return sandboxes.filter((s) => {
    if (s.state === 'removed' || s.state === 'failed') return false;
    if (path && s.workspace?.source && resolve(s.workspace.source) === path) return true;
    return s.name === name;
  });
}

/**
 * @typedef {object} StorageApi
 * @property {(key: string) => Promise<unknown>} get
 * @property {(key: string, value: unknown) => Promise<void>} set
 */

/**
 * Persistent map `worktreeId -> {path, branch}` kept in the plugin's own storage.
 * @param {StorageApi | null} storage null when the `storage` capability is missing
 */
export function createWorktreeCache(storage) {
  /** @returns {Promise<Record<string, {path: string, branch: string}>>} */
  async function read() {
    if (!storage) return {};
    const raw = await storage.get(CACHE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    /** @type {Record<string, {path: string, branch: string}>} */
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      const rec = /** @type {{path?: unknown, branch?: unknown}} */ (v);
      if (rec && typeof rec.path === 'string' && typeof rec.branch === 'string')
        out[id] = { path: rec.path, branch: rec.branch };
    }
    return out;
  }
  return {
    /** @param {{worktreeId: string, path: string, branch: string}} wt */
    async add(wt) {
      if (!storage) return;
      const map = await read();
      delete map[wt.worktreeId];
      map[wt.worktreeId] = { path: wt.path, branch: wt.branch };
      const ids = Object.keys(map);
      for (const id of ids.slice(0, Math.max(0, ids.length - CACHE_LIMIT))) delete map[id];
      await storage.set(CACHE_KEY, map);
    },
    /** @param {string} worktreeId */
    async remove(worktreeId) {
      if (!storage) return;
      const map = await read();
      if (!(worktreeId in map)) return;
      delete map[worktreeId];
      await storage.set(CACHE_KEY, map);
    },
    /**
     * The path of the worktree on `branch`, only when exactly one remembered worktree has it
     * (two repositories can both have a `main`).
     * @param {string} branch
     * @returns {Promise<string | null>}
     */
    async resolvePath(branch) {
      if (!branch) return null;
      const paths = new Set(
        Object.values(await read())
          .filter((w) => w.branch === branch)
          .map((w) => w.path),
      );
      return paths.size === 1 ? ([...paths][0] ?? null) : null;
    },
  };
}
