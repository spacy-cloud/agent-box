import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN, makeEnv, runBin, writeConfig, type TestEnv } from './harness.js';

/**
 * Package caches through the real CLI against a real Docker engine (ABOX_TEST_DOCKER=1; run it
 * targeted with --no-file-parallelism): a node-dev sandbox installs a tiny dependency with pnpm, a
 * second sandbox of the same project finds it in the project's cache and does not contact the
 * registry again, a sandbox of another project (or one created with --no-cache) starts with an empty
 * store. Everything lives below a private ABOX_HOME (its own instance id on the engine) and fixture
 * directories, and is removed again.
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const PACKAGE_JSON = (name: string): string =>
  `${JSON.stringify({ name, version: '1.0.0', private: true, dependencies: { 'left-pad': '1.3.0' } }, null, 2)}\n`;

// A lock file makes `pnpm install --frozen-lockfile` fetch nothing but the tarball itself.
const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==}
    deprecated: use String.prototype.padStart()

snapshots:

  left-pad@1.3.0: {}
`;

describe.runIf(DOCKER)('package caches (Docker, node-dev, pnpm)', () => {
  let t: TestEnv;
  let fixtures: string;
  let projA: string;
  let projB: string;
  const created: string[] = [];

  const project = (name: string): string => {
    const dir = join(fixtures, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), PACKAGE_JSON(name));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), LOCKFILE);
    return dir;
  };
  const create = async (name: string, proj: string, ...extra: string[]): Promise<void> => {
    const r = await runBin(
      t,
      ['create', 'node-dev', '-w', proj, '--mode', 'copy', '--name', name, '--yes', ...extra],
      { timeoutMs: 300_000 },
    );
    expect(r.code, r.stderr).toBe(0);
    created.push(name);
  };
  // pnpm asks the registry for its own newest version once in a while: that is not a download.
  const sh = (name: string, script: string) =>
    runBin(
      t,
      ['exec', name, '--', 'sh', '-c', `export npm_config_update_notifier=false; ${script}`],
      {
        timeoutMs: 300_000,
      },
    );
  const registryRequests = async (name: string): Promise<number> => {
    const r = await runBin(t, ['audit', '--sandbox', name, '--action', 'network.egress', '--json']);
    expect(r.code, r.stderr).toBe(0);
    return (r.json.data.entries as Array<{ details: { host?: string } }>).filter(
      (e) => e.details?.host === 'registry.npmjs.org',
    ).length;
  };
  interface Listed {
    key: string;
    name: string;
    project: string;
    stack: string;
    inUse: boolean;
    sizeBytes: number | null;
  }
  const caches = async (): Promise<Listed[]> => {
    const r = await runBin(t, ['cache', 'ls', '--json']);
    expect(r.code, r.stderr).toBe(0);
    return r.json.data.caches as Listed[];
  };

  beforeAll(async () => {
    execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(BIN)).toBe(true);
    t = makeEnv();
    const base = existsSync('/tmp/claude-1000') ? '/tmp/claude-1000' : tmpdir();
    fixtures = mkdtempSync(join(base, 'abox-caches-fixture-'));
    projA = project('proj-a');
    projB = project('proj-b');
    const built = await runBin(t, ['template', 'build', 'node-dev', '--json'], {
      timeoutMs: 900_000,
    });
    expect(built.code, built.stderr).toBe(0);
  }, 960_000);

  afterAll(async () => {
    for (const id of created) await runBin(t, ['rm', '--force', id]).catch(() => undefined);
    await runBin(t, ['cache', 'rm', '--all']).catch(() => undefined);
    rmSync(fixtures, { recursive: true, force: true });
    t.cleanup();
  }, 300_000);

  it('the first sandbox downloads the dependency into the project cache', async () => {
    await create('c1', projA);
    const list = await caches();
    expect(list.map((c) => c.name).sort()).toEqual(['npm-cache', 'pnpm-store']);
    expect(list.every((c) => c.project === projA && c.stack === 'node-dev' && c.inUse)).toBe(true);
    const r = await sh('c1', 'cd /workspace && pnpm install --frozen-lockfile 2>&1');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/downloaded 1/);
    expect(await registryRequests('c1')).toBeGreaterThan(0);
    const v = await sh(
      'c1',
      `cd /workspace && node -e "console.log(JSON.stringify(require('left-pad')('x', 3)))"`,
    );
    expect(v.stdout.trim()).toBe('"  x"');
    // the store lives in the cache volume, not in the sandbox
    const store = (await caches()).find((c) => c.name === 'pnpm-store')!;
    expect(store.sizeBytes).toBeGreaterThan(0);
  }, 300_000);

  it('a second sandbox of the same project (while the first still runs) does not download again', async () => {
    await create('c2', projA);
    const r = await sh('c2', 'cd /workspace && pnpm install --frozen-lockfile 2>&1');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/downloaded 0/);
    expect(r.stdout).toMatch(/reused 1/);
    expect(await registryRequests('c2')).toBe(0);
    // same two caches, shared
    expect(await caches()).toHaveLength(2);
  }, 300_000);

  it('the cache outlives the sandboxes: a third one installs offline', async () => {
    for (const id of ['c1', 'c2']) {
      const r = await runBin(t, ['rm', '--force', id]);
      expect(r.code, r.stderr).toBe(0);
      created.splice(created.indexOf(id), 1);
    }
    expect((await caches()).every((c) => !c.inUse)).toBe(true);
    await create('c3', projA);
    const r = await sh('c3', 'cd /workspace && pnpm install --frozen-lockfile --offline 2>&1');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(await registryRequests('c3')).toBe(0);
  }, 300_000);

  it('a cache is no part of the workspace: nothing in it shows up in an export', async () => {
    const w = await sh(
      'c3',
      'echo planted > ~/.npm/planted && echo planted > ~/.local/share/pnpm/store/planted && cd /workspace && echo changed >> package.json',
    );
    expect(w.code, w.stderr).toBe(0);
    const r = await runBin(t, ['export', 'c3', '--format', 'diff', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const files = (r.json.data.files as Array<{ path: string }>).map((f) => f.path);
    expect(files).toContain('package.json');
    expect(files.filter((p) => p.includes('planted'))).toEqual([]);
    expect(r.json.data.content).not.toContain('planted');
    // the cache dirs are not below the workspace: nothing of the workspace is shadowed either
    const mounts = await sh('c3', 'grep -c " /workspace" /proc/mounts || true');
    expect(mounts.stdout.trim()).toBe('0');
  }, 120_000);

  it('--no-cache starts with an empty store (offline install fails) and does not touch the cache', async () => {
    const before = (await caches()).map((c) => c.key).sort();
    await create('c4', projA, '--no-cache');
    const store = await sh(
      'c4',
      'echo "[$npm_config_store_dir]"; test -e ~/.local/share/pnpm/store && echo has-store || echo no-store',
    );
    expect(store.stdout).toBe('[]\nno-store\n');
    const r = await sh('c4', 'cd /workspace && pnpm install --frozen-lockfile --offline 2>&1');
    expect(r.code).not.toBe(0);
    expect((await caches()).map((c) => c.key).sort()).toEqual(before);
  }, 300_000);

  it('another project gets its own, empty cache; nothing of project A is visible there', async () => {
    await create('c5', projB);
    const list = await caches();
    expect(list).toHaveLength(4);
    expect(new Set(list.map((c) => c.key)).size).toBe(4);
    const b = list.filter((c) => c.project === projB);
    expect(b.map((c) => c.name).sort()).toEqual(['npm-cache', 'pnpm-store']);
    const files = await sh('c5', 'find ~/.local/share/pnpm/store ~/.npm -type f | wc -l');
    expect(files.stdout).toBe('0\n');
    const r = await sh('c5', 'cd /workspace && pnpm install --frozen-lockfile --offline 2>&1');
    expect(r.code).not.toBe(0);
  }, 300_000);

  it('rm refuses a cache a sandbox uses, and removes a project`s caches once nothing uses them', async () => {
    const key = (await caches()).find((c) => c.project === projB)!.key;
    const busy = await runBin(t, ['cache', 'rm', key]);
    expect(busy.code).toBe(2);
    expect(busy.stderr).toContain('in use');
    const skipped = await runBin(t, ['--project', projB, 'cache', 'rm', '--json']);
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(skipped.json.data.removed).toHaveLength(0);
    expect(skipped.json.data.skipped).toHaveLength(2);

    expect((await runBin(t, ['rm', '--force', 'c5'])).code).toBe(0);
    created.splice(created.indexOf('c5'), 1);
    const gone = await runBin(t, ['--project', projB, 'cache', 'rm', '--json']);
    expect(gone.code, gone.stderr).toBe(0);
    expect(gone.json.data.removed).toHaveLength(2);
    const left = await caches();
    expect(left.map((c) => c.project)).toEqual([projA, projA]);

    // the audit log knows who created, used and removed which cache
    const log = await runBin(t, ['audit', '--action', 'cache.remove', '--json']);
    expect(log.json.data.entries).toHaveLength(2);
    expect(log.json.data.entries[0].details).toMatchObject({ project: projB, reason: 'manual' });
  }, 300_000);

  it('gc removes caches that nobody used for caches.max_age', async () => {
    // age out everything of project A: no sandbox but c3 and c4 exist; remove them first
    for (const id of ['c3', 'c4']) {
      await runBin(t, ['rm', '--force', id]);
      created.splice(created.indexOf(id), 1);
    }
    const dry = await runBin(t, ['gc', '--dry-run', '--json']);
    expect(dry.json.data.caches).toHaveLength(0); // fresh: nothing to do
    writeConfig(t, 'caches:\n  max_age: 1s\n');
    await new Promise((r) => setTimeout(r, 1500));
    const r = await runBin(t, ['gc', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.caches.map((c: { reason: string }) => c.reason)).toEqual(['age', 'age']);
    expect(await caches()).toHaveLength(0);
  }, 300_000);
});
