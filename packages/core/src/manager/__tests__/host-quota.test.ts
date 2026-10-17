import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxRegistry, StateStore } from '../../state/index.js';
import type { HostResolver } from '../internals.js';
import type { Abox } from '../abox.js';
import {
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  makeEnv,
  openAbox,
  testPolicy,
  writePolicy,
  writeUserTemplates,
} from './harness.js';
import type { TestEnv } from './harness.js';
import type { FakeOptions } from './fake-provider.js';

const GIB = 1024 ** 3;
const SRV = { contextId: 'agent-srv' };

let env: TestEnv;
let one: Abox;
let two: Abox;

type HostLimits = { cpus?: number; memory?: string; sandboxes?: number };

/** Host `srv` (zone lab, fake docker backend) with the given limits; `local` is unlimited. */
function resolver(limits: HostLimits): HostResolver {
  return async (id) => ({
    connection: { host: id, kind: 'local' },
    zone: id === 'srv' ? 'lab' : 'workstation',
    backends: ['docker', 'process'],
    ...(id === 'srv' ? { limits } : {}),
  });
}

async function open(limits: HostLimits, fake: FakeOptions = {}): Promise<void> {
  env = makeEnv();
  writePolicy(
    env,
    `${testPolicy(env).replace('hosts: [local]', 'hosts: [local, srv]')}  agent-srv: { profile: agent }\n`,
  );
  writeUserTemplates(env);
  one = await openAbox(env, { bare: true, hostResolver: resolver(limits), fake });
  two = await openAbox(env, { bare: true, hostResolver: resolver(limits), fake });
}
afterEach(() => {
  one?.close();
  two?.close();
  env.cleanup();
});

const make = (
  a: Abox,
  o: {
    cpus?: number;
    memory?: string;
    host?: string;
    requestId?: string;
    caller?: typeof SRV;
  } = {},
) =>
  a.createSandbox(o.caller ?? HUMAN_YES, {
    template: 'fake-box',
    host: o.host ?? 'srv',
    workspace: EMPTY_WS,
    overrides: {
      ttl: '20m',
      ...(o.cpus !== undefined ? { cpus: o.cpus } : {}),
      ...(o.memory !== undefined ? { memory: o.memory } : {}),
    },
    ...(o.requestId ? { requestId: o.requestId } : {}),
  });

async function denial(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error('expected a rejection');
}

describe('host limits cpus / memory / sandboxes are quotas of the whole host', () => {
  beforeEach(() => open({ cpus: 4, memory: '4g', sandboxes: 5 }));

  it('the sum over the sandboxes of the host decides, not the single request', async () => {
    created(await make(one, { cpus: 2, memory: '1g' }));
    created(await make(one, { cpus: 1, memory: '1g' }));
    // 1 cpu and 2g are left
    const e = await denial(make(one, { cpus: 2, memory: '512m' }));
    expect(e.code).toBe('policy_denied');
    expect(e.message).toContain('exceeds what is left of the host limit on "srv"');
    expect(e.message).toContain('applies to all sandboxes there together and 3 are reserved');
    const m = await denial(make(one, { cpus: 0.5, memory: '3g' }));
    expect(m.code).toBe('policy_denied');
    expect(m.message).toContain('requested memory 3g exceeds what is left');
    // the other host is not affected by what runs on srv
    created(await make(one, { host: 'local', cpus: 2 }));
    // exactly what is left still fits
    created(await make(one, { cpus: 1, memory: '2g' }));
    expect((await denial(make(one, { cpus: 0.5, memory: '128m' }))).code).toBe('policy_denied');
  });

  it('stopped sandboxes keep their reservation; removed ones give it back', async () => {
    const a = created(await make(one, { cpus: 2 })).sandbox.id;
    const b = created(await make(one, { cpus: 2 })).sandbox.id;
    await one.stopSandbox(HUMAN, a);
    expect((await denial(make(one, { cpus: 1 }))).code).toBe('policy_denied');
    // starting it again can therefore never exceed the host limit
    await one.startSandbox(HUMAN, a);
    await one.removeSandbox(HUMAN, a);
    created(await make(one, { cpus: 2 }));
    expect((await denial(make(one, { cpus: 1 }))).code).toBe('policy_denied');
    await one.removeSandbox(HUMAN, b);
    created(await make(one, { cpus: 2 }));
  });

  it('expired sandboxes no longer count', async () => {
    created(await make(one, { cpus: 4 }));
    expect((await denial(make(one, { cpus: 1 }))).code).toBe('policy_denied');
    env.clock.t += 25 * 60_000; // ttl 20m
    await one.sweepTtl(HUMAN);
    created(await make(one, { cpus: 4 }));
  });

  it('parallel creates (two instances on one database) cannot overshoot the cpu quota', async () => {
    const settled = await Promise.allSettled(
      [one, two, one, two, one, two, one, two].map((a, i) =>
        make(a, { cpus: 1, requestId: `p${i}` }),
      ),
    );
    const ok = settled.filter((s) => s.status === 'fulfilled');
    expect(ok).toHaveLength(4);
    for (const s of settled)
      if (s.status === 'rejected') expect(s.reason).toMatchObject({ code: 'policy_denied' });
    const listed = (await one.listSandboxes(HUMAN, { host: 'srv' })).sandboxes;
    expect(listed.reduce((n, s) => n + s.resources.cpus, 0)).toBeLessThanOrEqual(4);
    // the refusals that happened inside the claim are audited with their reasons
    const denied = await one.queryAudit(HUMAN, { action: 'sandbox.create', decision: 'deny' });
    expect(denied.length).toBeGreaterThan(0);
  });

  it('parallel creates cannot overshoot the memory quota or the sandbox count either', async () => {
    const mem = await Promise.allSettled(
      [one, two, one, two, one, two].map((a, i) =>
        make(a, { memory: '1536m', requestId: `m${i}` }),
      ),
    );
    // 4g / 1.5g: two fit
    expect(mem.filter((s) => s.status === 'fulfilled')).toHaveLength(2);
    for (const s of mem)
      if (s.status === 'rejected') expect(s.reason).toMatchObject({ code: 'policy_denied' });
    expect(
      (await one.listSandboxes(HUMAN, { host: 'srv' })).sandboxes.reduce(
        (n, s) => n + s.resources.memoryBytes,
        0,
      ),
    ).toBeLessThanOrEqual(4 * GIB);
  });

  it('the same request id still returns the same sandbox under the quota (idempotent)', async () => {
    const results = await Promise.all(
      [one, two, one, two].map((a) => make(a, { cpus: 2, requestId: 'same' })),
    );
    expect(new Set(results.map((r) => created(r).sandbox.id)).size).toBe(1);
    // it reserved 2 cpus once, not four times
    created(await make(one, { cpus: 2 }));
  });
});

describe('host sandbox count under parallel creates', () => {
  beforeEach(() => open({ sandboxes: 2 }));
  it('holds the limit', async () => {
    const settled = await Promise.allSettled(
      [one, two, one, two, one].map((a, i) => make(a, { requestId: `c${i}` })),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(2);
    for (const s of settled)
      if (s.status === 'rejected') {
        expect(s.reason).toMatchObject({ code: 'policy_denied' });
        expect(String((s.reason as Error).message)).toContain('its limit is 2');
      }
  });
});

describe('access_request resources counts the other sandboxes of the host', () => {
  beforeEach(() => open({ cpus: 4, memory: '4g' }, { updateResources: true }));

  const grow = (a: Abox, id: string, cpus: number) =>
    a.accessRequest(SRV, id, { kind: 'resources', details: { cpus } });

  it('a resize that fits next to the others is applied; one that does not is denied', async () => {
    const a = created(await make(one, { cpus: 1, caller: SRV })).sandbox.id;
    created(await make(one, { cpus: 2, caller: SRV }));
    expect((await grow(one, a, 2)).status).toBe('applied');
    const e = await denial(grow(one, a, 3));
    expect(e.code).toBe('policy_denied');
    expect(e.message).toContain('exceeds what is left of the host limit on "srv"');
    expect((await one.inspectSandbox(HUMAN, a)).resources.cpus).toBe(2);
    // shrinking is always possible and frees the room
    expect((await grow(one, a, 1)).status).toBe('applied');
    created(await make(one, { cpus: 1, caller: SRV }));
  });

  it('parallel resizes cannot overshoot: the reservation is taken inside one transaction', async () => {
    const ids = [
      created(await make(one, { cpus: 1, caller: SRV })).sandbox.id,
      created(await make(one, { cpus: 1, caller: SRV })).sandbox.id,
      created(await make(one, { cpus: 1, caller: SRV })).sandbox.id,
    ];
    // each one alone fits (2 + 1 + 1 = 4), both together do not (2 + 2 + 1 = 5)
    const settled = await Promise.allSettled([grow(one, ids[0]!, 2), grow(two, ids[1]!, 2)]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'policy_denied' });
    const listed = (await one.listSandboxes(HUMAN, { host: 'srv' })).sandboxes;
    expect(listed.reduce((n, s) => n + s.resources.cpus, 0)).toBe(4);
  });

  it('a backend that refuses the resize leaves the reservation as it was', async () => {
    await open({ cpus: 4 }, { updateResources: true, failUpdateResources: 'busy (fake)' });
    const a = created(await make(one, { cpus: 1, caller: SRV })).sandbox.id;
    await expect(grow(one, a, 3)).rejects.toMatchObject({
      message: expect.stringContaining('busy'),
    });
    expect((await one.inspectSandbox(HUMAN, a)).resources.cpus).toBe(1);
    created(await make(one, { cpus: 3, caller: SRV }));
  });
});

describe('workspace in use is decided atomically', () => {
  beforeEach(() => open({}));

  const mount = (a: Abox, path: string, i: number) =>
    a.createSandbox(HUMAN_YES, {
      template: 'fake-box',
      workspace: { mode: 'mount', path },
      requestId: `w${i}`,
    });

  it('four parallel mount creates for one directory: exactly one wins', async () => {
    const settled = await Promise.allSettled(
      [one, two, one, two].map((a, i) => mount(a, env.project, i)),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled)
      if (s.status === 'rejected') {
        expect(s.reason).toMatchObject({ code: 'conflict' });
        expect(String((s.reason as Error).message)).toContain('is already used by sandbox');
      }
    expect(
      (await one.listSandboxes(HUMAN, { host: 'local' })).sandboxes.filter(
        (s) => s.state !== 'failed',
      ),
    ).toHaveLength(1);
  });

  it('a directory and one inside it exclude each other the same way; other directories do not', async () => {
    const inner = `${env.project}/src`;
    const settled = await Promise.allSettled([
      mount(one, env.project, 10),
      mount(two, inner, 11),
      mount(one, env.datasets, 12),
    ]);
    const states = settled.map((s) => s.status);
    expect(states.filter((s) => s === 'fulfilled')).toHaveLength(2);
    expect(states[2]).toBe('fulfilled');
  });

  it('a mount create mixed with parallel copy creates of the same directory is still exclusive', async () => {
    const settled = await Promise.allSettled([
      mount(one, env.project, 20),
      mount(two, env.project, 21),
      one.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: env.project },
        requestId: 'w22',
      }),
    ]);
    // at most one mount holds the directory; the copy either got in before the mount claimed it or is refused
    expect(settled.slice(0, 2).filter((s) => s.status === 'fulfilled')).toHaveLength(1);
  });

  it('a create whose process died holds nothing (and counts for no quota)', async () => {
    const store = StateStore.open(one.paths.stateDb, { now: env.clock.now });
    try {
      store.sandboxes.upsert({
        id: 'local/dead0001',
        host: 'local',
        name: 'dead',
        owner: 'human',
        template: 'fake-box',
        templateHash: 'h',
        backend: 'docker',
        isolation: 'container',
        state: 'preparing',
        createdAt: env.clock.t,
        expiresAt: env.clock.t + 60_000,
        workspace: { mode: 'mount', claim: env.project },
        effective: {
          resources: { cpus: 64, memoryBytes: 64 * GIB, ttlMs: 60_000 },
          creator: { pid: 2 ** 31 - 2, host: hostname(), startedAt: env.clock.t },
        },
      });
    } finally {
      store.close();
    }
    created(
      await one.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'mount', path: env.project },
      }),
    );
  });

  it('a failed create releases the directory', async () => {
    await open({}, { failCreate: true });
    await expect(mount(one, env.project, 30)).rejects.toBeDefined();
    // the failed row does not hold the directory: another create gets past the workspace check
    const again = await denial(mount(two, env.project, 31));
    expect(again.code).not.toBe('conflict');
  });

  it('another owner is told nothing about who holds the directory', async () => {
    const holder = created(
      await one.createSandbox(
        { contextId: 'agent-a' },
        { template: 'fake-box', workspace: { mode: 'mount', path: env.project } },
      ),
    );
    expect(holder.sandbox.workspace?.mode).toBe('mount');
    const e = await denial(
      two.createSandbox(
        { contextId: 'agent-b' },
        { template: 'fake-box', workspace: { mode: 'mount', path: env.project } },
      ),
    );
    expect(e.code).toBe('policy_denied');
    expect(e.message).not.toContain(holder.sandbox.id);
  });
});

describe('the claim decides again, inside the registry transaction', () => {
  // The policy evaluation is a snapshot. Another process can claim in the moment between that
  // snapshot and our claim: simulated by writing the competitor's row from a second connection
  // right before the claim runs (what a parallel `abox create` does).
  let restore = (): void => undefined;
  afterEach(() => restore());

  function raceWith(
    insert: (store: StateStore, ids: { host: string }) => void,
    host = 'srv',
  ): void {
    const store = StateStore.open(one.paths.stateDb, { now: env.clock.now });
    const original = SandboxRegistry.prototype.claim;
    let done = false;
    const spy = vi.spyOn(SandboxRegistry.prototype, 'claim').mockImplementation(function (
      this: SandboxRegistry,
      ...args: Parameters<SandboxRegistry['claim']>
    ) {
      if (!done) {
        done = true;
        insert(store, { host });
      }
      return original.apply(this, args);
    });
    restore = () => {
      spy.mockRestore();
      store.close();
    };
  }

  const competitor = (
    store: StateStore,
    o: { host: string; cpus?: number; memoryBytes?: number; workspace?: Record<string, unknown> },
  ): void => {
    store.sandboxes.upsert({
      id: `${o.host}/cafe0001`,
      host: o.host,
      name: 'competitor',
      owner: 'human',
      template: 'fake-box',
      templateHash: 'h',
      backend: 'docker',
      isolation: 'container',
      state: 'preparing',
      createdAt: env.clock.t,
      expiresAt: env.clock.t + 60_000,
      ...(o.workspace ? { workspace: o.workspace } : {}),
      effective: {
        resources: { cpus: o.cpus ?? 1, memoryBytes: o.memoryBytes ?? GIB, ttlMs: 60_000 },
        creator: { pid: process.pid, host: hostname(), startedAt: env.clock.t },
      },
    });
  };

  it('cpu quota: a competitor that claimed after our evaluation wins, we are refused and audited', async () => {
    await open({ cpus: 4 });
    created(await make(one, { cpus: 2 }));
    raceWith((store, ids) => competitor(store, { host: ids.host, cpus: 1 }));
    // evaluation saw 2 reserved (2 + 2 <= 4); the competitor makes it 3 (3 + 2 > 4)
    const e = await denial(make(one, { cpus: 2 }));
    expect(e.code).toBe('policy_denied');
    expect(e.message).toContain('exceeds what is left of the host limit on "srv"');
    const rows = await one.queryAudit(HUMAN, { action: 'sandbox.create', decision: 'deny' });
    expect(rows[0]?.details).toMatchObject({ code: 'host_quota' });
    // nothing of ours was registered
    const mine = (await one.listSandboxes(HUMAN, { host: 'srv' })).sandboxes.filter(
      (s) => s.name !== 'competitor',
    );
    expect(mine).toHaveLength(1);
  });

  it('memory quota and sandbox count are decided in the claim too', async () => {
    await open({ memory: '2g', sandboxes: 2 });
    raceWith((store, ids) => competitor(store, { host: ids.host, memoryBytes: GIB + GIB / 2 }));
    const m = await denial(make(one, { memory: '1g' }));
    expect(m.message).toContain('requested memory 1g exceeds what is left');
    restore();
    raceWith((store, ids) => {
      competitor(store, { host: ids.host, memoryBytes: 1 });
      store.sandboxes.upsert({
        ...store.sandboxes.get(`${ids.host}/cafe0001`)!,
        id: `${ids.host}/cafe0002`,
      });
    });
    const c = await denial(make(one, { memory: '128m' }));
    expect(c.message).toContain('its limit is 2');
  });

  it('workspace: a mount that was claimed in the meantime keeps the directory', async () => {
    await open({});
    raceWith(
      (store, ids) =>
        competitor(store, {
          host: ids.host,
          workspace: { mode: 'mount', claim: env.project },
        }),
      'local',
    );
    const e = await denial(
      one.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'mount', path: env.project },
      }),
    );
    expect(e.code).toBe('conflict');
    expect(e.message).toContain('is already used by sandbox local/cafe0001');
    const rows = await one.queryAudit(HUMAN, { action: 'sandbox.create', decision: 'deny' });
    expect(rows[0]?.details).toMatchObject({ code: 'workspace_in_use' });
  });
});
