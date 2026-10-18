import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config/config.js';
import { resolvePaths } from '../../config/paths.js';
import type { Abox } from '../abox.js';
import { deriveCacheKey, selectCachesForGc } from '../caches.js';
import type { CacheView } from '../types.js';
import {
  A,
  B,
  EMPTY_WS,
  HUMAN,
  created,
  fakeOf,
  makeEnv,
  openAbox,
  testPolicy,
  writePolicy,
  writeUserTemplates,
} from './harness.js';
import type { TestEnv } from './harness.js';

const DAY = 86_400_000;
const GIB = 1024 ** 3;

const CACHED_BOX = `apiVersion: 1
name: cached-box
description: A fake container-like template with package caches, used by the cache tests only.
backend: docker
base: { os: ubuntu:24.04 }
resources: { cpus: 1, memory: 512m, ttl: 1h }
caches:
  - name: pnpm-store
    path: ~/.local/share/pnpm/store
    env: { npm_config_store_dir: '\${path}' }
  - name: cargo-registry
    path: /opt/cargo/registry
labels: { use-for: cache tests }
`;

let env: TestEnv;
let abox: Abox;

/** The test policy with the cached template for agents, and `cache_max_bytes` 1g for the human. */
function cachePolicy(extra = ''): string {
  return testPolicy(env)
    .replace('templates: [host-shell, fake-box,', 'templates: [cached-box, host-shell, fake-box,')
    .replace('profiles:\n', `profiles:\n  human:\n    cache_max_bytes: 1g\n`)
    .replace('  agent:\n', `  agent:\n${extra}`);
}

async function open(agentExtra = '', config?: string): Promise<void> {
  env = makeEnv();
  writePolicy(env, cachePolicy(agentExtra));
  writeUserTemplates(env);
  writeFileSync(join(resolvePaths(env.env).templatesDir, 'cached-box.yaml'), CACHED_BOX);
  abox = await openAbox(env, {
    bare: true,
    fake: { caches: true },
    ...(config ? { config: parseConfig(config) } : {}),
  });
}

afterEach(() => {
  abox?.close();
  env?.cleanup();
});

function otherProject(): string {
  const dir = join(env.projects, 'other');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'other\n');
  return dir;
}

const withCache = (caller = HUMAN, project?: string, extra: Record<string, unknown> = {}) =>
  abox.createSandbox(caller, {
    template: 'cached-box',
    workspace: { mode: 'copy', path: project ?? env.project },
    ...extra,
  } as never);

describe('deriveCacheKey', () => {
  const base = {
    project: '/p/a',
    owner: 'human',
    stack: 'node-dev',
    name: 'pnpm-store',
    uid: 1000,
  };

  it('is stable and 16 hex digits', () => {
    expect(deriveCacheKey(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveCacheKey({ ...base })).toBe(deriveCacheKey(base));
  });

  it('differs for every part of the identity', () => {
    const keys = new Set([
      deriveCacheKey(base),
      deriveCacheKey({ ...base, project: '/p/b' }),
      deriveCacheKey({ ...base, owner: 'agent:claude-code' }),
      deriveCacheKey({ ...base, stack: 'tauri-dev' }),
      deriveCacheKey({ ...base, name: 'npm-cache' }),
      deriveCacheKey({ ...base, uid: 1001 }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('does not confuse parts that run into each other', () => {
    expect(deriveCacheKey({ ...base, project: '/p/a', stack: 'xy' })).not.toBe(
      deriveCacheKey({ ...base, project: '/p/ax', stack: 'y' }),
    );
  });
});

describe('selectCachesForGc', () => {
  const view = (o: Partial<CacheView> & { key: string }): CacheView => ({
    host: 'local',
    name: 'pnpm-store',
    project: '/p/a',
    stack: 'node-dev',
    owner: 'human',
    sizeBytes: 100,
    createdAt: 0,
    lastUsedAt: 1_000_000,
    inUse: false,
    ...o,
  });
  const pick = (views: CacheView[], cap = 10_000, now = 1_000_000 + DAY) =>
    selectCachesForGc(views, { now, maxAgeMs: 30 * DAY, caps: () => cap }).map(
      (p) => `${p.cache.key}:${p.reason}`,
    );

  it('removes what is unused for longer than the maximum age, never what a sandbox holds', () => {
    const old = 1_000_000 - 40 * DAY;
    expect(
      pick([
        view({ key: 'old', lastUsedAt: old }),
        view({ key: 'busy', lastUsedAt: old, inUse: true }),
        view({ key: 'fresh' }),
      ]),
    ).toEqual(['old:age']);
  });

  it('trims a project above its cap, least recently used first, and stops once it fits', () => {
    const views = [
      view({ key: 'a', sizeBytes: 600, lastUsedAt: 3 }),
      view({ key: 'b', sizeBytes: 600, lastUsedAt: 1 }),
      view({ key: 'c', sizeBytes: 600, lastUsedAt: 2 }),
    ];
    expect(pick(views, 1000, 10)).toEqual(['b:cap', 'c:cap']);
  });

  it('counts per project, owner and host separately', () => {
    const views = [
      view({ key: 'a', sizeBytes: 600 }),
      view({ key: 'b', sizeBytes: 600, project: '/p/b' }),
      view({ key: 'c', sizeBytes: 600, owner: 'agent:x' }),
      view({ key: 'd', sizeBytes: 600, host: 'vps' }),
    ];
    expect(pick(views, 1000)).toEqual([]);
  });

  it('keeps a cache in use even when the project is above the cap', () => {
    const views = [
      view({ key: 'busy', sizeBytes: 5000, inUse: true }),
      view({ key: 'idle', sizeBytes: 100 }),
    ];
    expect(pick(views, 1000)).toEqual(['idle:cap']);
  });

  it('does not count age-removed caches against the cap', () => {
    const views = [
      view({ key: 'old', sizeBytes: 900, lastUsedAt: 1_000_000 - 40 * DAY }),
      view({ key: 'new', sizeBytes: 900 }),
    ];
    expect(pick(views, 1000)).toEqual(['old:age']);
  });
});

describe('creating sandboxes with caches', () => {
  beforeEach(() => open());

  it('mounts the declared caches of the template for a shared project, with their variables', async () => {
    created(await withCache());
    const spec = fakeOf(env).specs.at(-1)!;
    expect(spec.caches?.map((c) => [c.name, c.path])).toEqual([
      ['pnpm-store', '/home/agent/.local/share/pnpm/store'],
      ['cargo-registry', '/opt/cargo/registry'],
    ]);
    expect(spec.caches?.[0]).toMatchObject({
      project: env.project,
      stack: 'cached-box',
      owner: 'human',
    });
    expect(spec.env['npm_config_store_dir']).toBe('/home/agent/.local/share/pnpm/store');
    const inspect = await abox.inspectSandbox(HUMAN, spec.id);
    expect(inspect.effective).toMatchObject({ caches: { status: 'active' } });
  });

  it('a second sandbox of the same project gets the same caches, another project different ones', async () => {
    created(await withCache());
    created(await withCache());
    created(await withCache(HUMAN, otherProject()));
    const [a, b, c] = fakeOf(env).specs.map((s) => s.caches!.map((x) => x.key));
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    expect(new Set([...a!, ...c!]).size).toBe(4);
    // one volume per cache and project, not one per sandbox
    expect(fakeOf(env).cacheVolumes.size).toBe(4);
  });

  it('the agent and the human never share a cache of the same project', async () => {
    created(await withCache(HUMAN));
    created(await withCache(A));
    created(await withCache(B));
    const keys = fakeOf(env).specs.map((s) => s.caches![0]!.key);
    expect(new Set(keys).size).toBe(3);
    expect(fakeOf(env).specs[1]!.caches![0]!.owner).toBe('agent:agent-a');
  });

  it('cache: false is a clean install: no mount, no variable', async () => {
    created(await withCache(HUMAN, undefined, { cache: false }));
    const spec = fakeOf(env).specs.at(-1)!;
    expect(spec.caches).toBeUndefined();
    expect(spec.env['npm_config_store_dir']).toBeUndefined();
    expect(fakeOf(env).cacheVolumes.size).toBe(0);
  });

  it('no project, no cache: an empty workspace has nothing the cache could belong to', async () => {
    created(await abox.createSandbox(HUMAN, { template: 'cached-box', workspace: EMPTY_WS }));
    expect(fakeOf(env).specs.at(-1)!.caches).toBeUndefined();
  });

  it('a template without caches is unaffected', async () => {
    created(
      await abox.createSandbox(HUMAN, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: env.project },
      }),
    );
    expect(fakeOf(env).specs.at(-1)!.caches).toBeUndefined();
  });

  it('records use and audits create and use once per new volume', async () => {
    const first = created(await withCache());
    created(await withCache());
    const log = await abox.queryAudit(HUMAN, {
      action: ['cache.create', 'cache.use'],
      order: 'asc',
    });
    expect(log.filter((e) => e.action === 'cache.create')).toHaveLength(2);
    expect(log.filter((e) => e.action === 'cache.use')).toHaveLength(4);
    expect(log[0]).toMatchObject({
      sandboxId: first.sandbox.id,
      details: { name: 'pnpm-store', stack: 'cached-box', owner: 'human', project: env.project },
    });
  });

  it('opting out of a template that has caches still reuses an equal request (idempotent by request id)', async () => {
    const a = created(await withCache(HUMAN, undefined, { cache: false, requestId: 'r1' }));
    const b = created(await withCache(HUMAN, undefined, { cache: false, requestId: 'r1' }));
    expect(b.idempotent).toBe(true);
    expect(b.sandbox.id).toBe(a.sandbox.id);
  });
});

describe('policy switch', () => {
  it('caches: false in the profile of an agent turns them off for that agent only', async () => {
    await open('    caches: false\n');
    created(await withCache(A));
    created(await withCache(HUMAN));
    const [agent, human] = fakeOf(env).specs;
    expect(agent!.caches).toBeUndefined();
    expect(human!.caches).toHaveLength(2);
    const inspect = await abox.inspectSandbox(A, agent!.id);
    expect(inspect.effective).toMatchObject({ caches: { status: 'disabled_by_policy' } });
  });

  it('shows the switch and the cap in policy_show; the defaults are on and 10g', async () => {
    await open();
    const agent = (await abox.showPolicy(A)).profile;
    expect(agent).toMatchObject({ caches: true, cache_max_bytes: '10g', cacheMaxBytes: 10 * GIB });
    expect((await abox.showPolicy(HUMAN)).profile).toMatchObject({ cache_max_bytes: '1g' });
  });

  it('a backend that cannot keep caches creates the sandbox without them', async () => {
    env = makeEnv();
    writePolicy(env, cachePolicy());
    writeUserTemplates(env);
    writeFileSync(join(resolvePaths(env.env).templatesDir, 'cached-box.yaml'), CACHED_BOX);
    abox = await openAbox(env, { bare: true });
    created(await withCache());
    expect(fakeOf(env).specs.at(-1)!.caches).toBeUndefined();
  });
});

describe('listing and removing', () => {
  beforeEach(() => open());

  it('only a human can list or remove caches; the attempt is audited', async () => {
    created(await withCache(A));
    await expect(abox.listCaches(A)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.removeCaches(A, { all: true })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(fakeOf(env).cacheVolumes.size).toBe(2);
    const denied = await abox.queryAudit(HUMAN, {
      action: ['cache.list_denied', 'cache.remove_denied'],
    });
    expect(denied).toHaveLength(2);
    expect(denied.every((e) => e.decision === 'deny')).toBe(true);
  });

  it('lists size, last use and whether a sandbox holds the cache', async () => {
    const sb = created(await withCache());
    const key = fakeOf(env).specs[0]!.caches![0]!.key;
    fakeOf(env).cacheSizes.set(key, 12_345);
    env.clock.t += 5 * 60_000;
    const r = await abox.listCaches(HUMAN);
    const c = r.caches.find((x) => x.key === key)!;
    expect(c).toMatchObject({
      host: 'local',
      name: 'pnpm-store',
      stack: 'cached-box',
      owner: 'human',
      project: env.project,
      sizeBytes: 12_345,
      inUse: true,
    });
    expect(env.clock.t - c.lastUsedAt).toBeGreaterThanOrEqual(5 * 60_000);
    expect(r.totalBytes).toBe(12_345);
    await abox.removeSandbox(HUMAN, sb.sandbox.id);
    expect((await abox.listCaches(HUMAN)).caches.every((x) => !x.inUse)).toBe(true);
  });

  it('refuses a cache in use by key and keeps it when selected by project or all', async () => {
    const sb = created(await withCache());
    const key = fakeOf(env).specs[0]!.caches![0]!.key;
    await expect(abox.removeCaches(HUMAN, { keys: [key] })).rejects.toMatchObject({
      code: 'conflict',
    });
    const all = await abox.removeCaches(HUMAN, { all: true });
    expect(all.removed).toHaveLength(0);
    expect(all.skipped).toHaveLength(2);
    expect(fakeOf(env).cacheVolumes.size).toBe(2);

    await abox.removeSandbox(HUMAN, sb.sandbox.id);
    const byProject = await abox.removeCaches(HUMAN, { project: env.project });
    expect(byProject.removed).toHaveLength(2);
    expect(fakeOf(env).cacheVolumes.size).toBe(0);
    const log = await abox.queryAudit(HUMAN, { action: 'cache.remove' });
    expect(log).toHaveLength(2);
    expect(log[0]!.details).toMatchObject({ reason: 'manual', project: env.project });
  });

  it('removes by key, by a unique prefix, and only the caches of the named project', async () => {
    const one = created(await withCache());
    const two = created(await withCache(HUMAN, otherProject()));
    await abox.removeSandbox(HUMAN, one.sandbox.id);
    await abox.removeSandbox(HUMAN, two.sandbox.id);
    const [a, , c] = fakeOf(env).specs.flatMap((s) => s.caches!.map((x) => x.key));
    const r = await abox.removeCaches(HUMAN, { keys: [a!.slice(0, 8)] });
    expect(r.removed.map((x) => x.key)).toEqual([a]);
    const left = (await abox.listCaches(HUMAN)).caches.map((x) => x.key);
    expect(left).toContain(c);
    expect(left).not.toContain(a);
    const others = await abox.removeCaches(HUMAN, { project: join(env.projects, 'other') });
    expect(others.removed).toHaveLength(2);
    expect((await abox.listCaches(HUMAN)).caches).toHaveLength(1);
  });

  it('rejects unusable selectors', async () => {
    await expect(abox.removeCaches(HUMAN, {})).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(abox.removeCaches(HUMAN, { all: true, project: '/x' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(abox.removeCaches(HUMAN, { keys: ['zz'] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(abox.removeCaches(HUMAN, { keys: ['abcd1234'] })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('gc and doctor', () => {
  beforeEach(() => open());

  it('gc removes caches unused for caches.max_age and keeps fresh ones and those in use', async () => {
    const old = created(await withCache());
    await abox.removeSandbox(HUMAN, old.sandbox.id);
    env.clock.t += 31 * DAY;
    created(await withCache(HUMAN, otherProject()));
    const dry = await abox.gc(HUMAN, { dryRun: true });
    expect(dry.caches.map((c) => [c.name, c.reason])).toEqual([
      ['cargo-registry', 'age'],
      ['pnpm-store', 'age'],
    ]);
    expect(fakeOf(env).cacheVolumes.size).toBe(4);
    const r = await abox.gc(HUMAN);
    expect(r.caches).toHaveLength(2);
    expect(r.caches.every((c) => c.project === env.project)).toBe(true);
    expect(fakeOf(env).cacheVolumes.size).toBe(2);
    const log = await abox.queryAudit(HUMAN, { action: 'cache.remove' });
    expect(log[0]!.details).toMatchObject({ reason: 'gc-age' });
  });

  it('caches.max_age comes from config.yaml', async () => {
    abox.close();
    env.cleanup();
    await open('', 'caches:\n  max_age: 2d\n');
    const sb = created(await withCache());
    await abox.removeSandbox(HUMAN, sb.sandbox.id);
    env.clock.t += 1 * DAY;
    expect((await abox.gc(HUMAN)).caches).toHaveLength(0);
    env.clock.t += 2 * DAY;
    expect((await abox.gc(HUMAN)).caches).toHaveLength(2);
  });

  it('gc trims a project above the cap of its owner profile, least recently used first', async () => {
    const one = created(await withCache());
    await abox.removeSandbox(HUMAN, one.sandbox.id);
    env.clock.t += 1000;
    const two = created(await withCache(HUMAN, otherProject()));
    await abox.removeSandbox(HUMAN, two.sandbox.id);
    const [a, b] = fakeOf(env).specs[0]!.caches!.map((c) => c.key);
    // the human profile caps a project at 1g: 800m + 800m of one project is too much, the other project is fine
    fakeOf(env).cacheSizes.set(a!, 800 * 1024 ** 2);
    fakeOf(env).cacheSizes.set(b!, 800 * 1024 ** 2);
    const [c, d] = fakeOf(env).specs[1]!.caches!.map((x) => x.key);
    fakeOf(env).cacheSizes.set(c!, 100 * 1024 ** 2);
    fakeOf(env).cacheSizes.set(d!, 100 * 1024 ** 2);
    const r = await abox.gc(HUMAN);
    expect(r.caches).toHaveLength(1);
    expect(r.caches[0]).toMatchObject({ reason: 'cap', project: env.project });
    expect([a, b]).toContain(r.caches[0]!.key);
    expect(fakeOf(env).cacheVolumes.size).toBe(3);
  });

  it('doctor shows the caches and warns about a project above its cap', async () => {
    created(await withCache());
    const [a, b] = fakeOf(env).specs[0]!.caches!.map((c) => c.key);
    fakeOf(env).cacheSizes.set(a!, 700 * 1024 ** 2);
    fakeOf(env).cacheSizes.set(b!, 700 * 1024 ** 2);
    const d = await abox.doctor(HUMAN);
    expect(d.caches).toEqual({ count: 2, totalBytes: 1400 * 1024 ** 2 });
    const check = d.checks.find((c) => c.id === 'caches')!;
    expect(check.title).toContain('2 cache(s)');
    expect(check.title).toContain('1.4 GiB');
    expect(d.checks.some((c) => c.id.startsWith('caches.cap.') && c.severity === 'warning')).toBe(
      true,
    );
  });
});
