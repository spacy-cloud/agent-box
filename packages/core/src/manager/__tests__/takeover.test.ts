import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_SESSION_HEARTBEAT_MS, HUMAN_SESSION_TTL_MS, StateStore } from '../../state/index.js';
import type { Abox } from '../abox.js';
import { A, B, EMPTY_WS, HUMAN, HUMAN_YES, created, fakeOf, makeEnv, openAbox } from './harness.js';
import type { OpenOpts, TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox | undefined;

async function setup(o: OpenOpts = {}): Promise<Abox> {
  env = makeEnv();
  abox = await openAbox(env, { fake: { capabilities: { tty: true } }, ...o });
  return abox;
}
afterEach(() => {
  abox?.close();
  abox = undefined;
  env.cleanup();
});

const agentBox = async (a: Abox, caller = A): Promise<string> =>
  created(await a.createSandbox(caller, { template: 'fake-box', workspace: EMPTY_WS })).sandbox.id;

async function audited(a: Abox, action: string): Promise<Array<Record<string, unknown>>> {
  const rows = await a.queryAudit(HUMAN, { action, order: 'asc', limit: 100 });
  return rows.map((r) => ({
    decision: r.decision,
    sandboxId: r.sandboxId,
    actor: r.actor,
    ...r.details,
  }));
}

describe('human takeover of an agent sandbox', () => {
  it('pauses exec, process and write tools of the owner while a human terminal is open, then resumes', async () => {
    const a = await setup();
    const id = await agentBox(a);
    expect((await a.inspectSandbox(A, id)).humanAttached).toBeUndefined();

    const session = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    const view = await a.inspectSandbox(A, id);
    expect(view.humanAttached).toMatchObject({ sessions: 1, actor: 'human' });
    // the human sees the marker in the list too
    const listed = (await a.listSandboxes(HUMAN)).sandboxes.find((s) => s.id === id)!;
    expect(listed.humanAttached?.sessions).toBe(1);

    const paused = { code: 'conflict', message: expect.stringContaining('paused: a human') };
    await expect(a.exec(A, id, { argv: ['true'] })).rejects.toMatchObject(paused);
    await expect(a.startProcess(A, id, { argv: ['sleep', '1'] })).rejects.toMatchObject(paused);
    await expect(a.writeFile(A, id, '/workspace/x.txt', 'x')).rejects.toMatchObject(paused);
    await expect(a.restore(A, id, 'snap')).rejects.toMatchObject(paused);
    // reading keeps working, so the agent can watch what the human does
    await expect(a.listDir(A, id, '/workspace')).resolves.toBeDefined();
    // the human is never blocked by their own terminal
    await expect(a.exec(HUMAN_YES, id, { argv: ['true'] })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(fakeOf(env).execCalls.filter((c) => c.req.argv?.[0] === 'sleep')).toHaveLength(0);

    fakeOf(env).ttyExits.at(-1)!(0);
    await session.wait();
    expect((await a.inspectSandbox(A, id)).humanAttached).toBeUndefined();
    await expect(a.writeFile(A, id, '/workspace/x.txt', 'x')).resolves.toMatchObject({ size: 1 });
    const r = await a.exec(A, id, { argv: ['true'] }, { waitForApprovalMs: 0 });
    expect(['completed', 'pending_approval']).toContain(r.status);
  });

  it('pauses every mutating agent tool of the sandbox: stop, start, delete, snapshot, restore, access_request, ttl', async () => {
    const a = await setup();
    const id = await agentBox(a);
    const session = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    const paused = { code: 'conflict', message: expect.stringContaining('paused: a human') };
    await expect(a.stopSandbox(A, id)).rejects.toMatchObject(paused);
    await expect(a.startSandbox(A, id)).rejects.toMatchObject(paused);
    await expect(a.removeSandbox(A, id)).rejects.toMatchObject(paused);
    await expect(a.snapshot(A, id, 'before')).rejects.toMatchObject(paused);
    await expect(a.restore(A, id, 'before')).rejects.toMatchObject(paused);
    await expect(
      a.accessRequest(A, id, { kind: 'resources', details: { cpus: 1 }, reason: 'more' }),
    ).rejects.toMatchObject(paused);
    await expect(a.extendTtl(A, id, '10m')).rejects.toMatchObject(paused);
    // each refused attempt is audited as a denial with the reason, once per action
    for (const action of [
      'sandbox.stop',
      'sandbox.start',
      'sandbox.remove',
      'sandbox.snapshot',
      'sandbox.restore',
      'sandbox.access_request',
    ]) {
      const rows = await audited(a, action);
      expect(rows, action).toHaveLength(1);
      expect(rows[0], action).toMatchObject({
        decision: 'deny',
        reason: 'human_attached',
        sandboxId: id,
        actor: 'agent:agent-a',
      });
    }
    // nothing happened to the sandbox the human is working in
    const view = await a.inspectSandbox(HUMAN, id);
    expect(view.state).toBe('running');
    expect(fakeOf(env).sandboxes.get(id as never)?.state).toBe('running');
    // reading is still possible
    await expect(a.inspectSandbox(A, id)).resolves.toMatchObject({ id });
    await expect(a.listDir(A, id, '/workspace')).resolves.toBeDefined();
    // the human can still stop it
    await expect(a.stopSandbox(HUMAN, id)).resolves.toMatchObject({ state: 'stopped' });
    await session.close();
    // after the terminal is gone the agent can do all of it again
    await expect(a.startSandbox(A, id)).resolves.toMatchObject({ state: 'running' });
    await expect(a.stopSandbox(A, id)).resolves.toMatchObject({ state: 'stopped' });
    await expect(a.removeSandbox(A, id)).resolves.toMatchObject({ removed: true });
  });

  it('audits start and end of the takeover and the paused attempts (once per burst)', async () => {
    const a = await setup();
    const id = await agentBox(a);
    const session = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    for (let i = 0; i < 3; i++) await a.exec(A, id, { argv: ['true'] }).catch(() => undefined);
    fakeOf(env).ttyExits.at(-1)!(3);
    await session.wait();
    const start = await audited(a, 'sandbox.takeover');
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({
      decision: 'info',
      sandboxId: id,
      actor: 'human',
      agentOwner: 'agent:agent-a',
    });
    const end = await audited(a, 'sandbox.takeover.end');
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ sandboxId: id, exitCode: 3, sessionId: start[0]!['sessionId'] });
    const blocked = await audited(a, 'sandbox.exec');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ decision: 'deny', reason: 'human_attached', sandboxId: id });
  });

  it('close() of the terminal releases the marker too', async () => {
    const a = await setup();
    const id = await agentBox(a);
    const session = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    expect((await a.inspectSandbox(A, id)).humanAttached).toBeDefined();
    await session.close();
    expect((await a.inspectSandbox(A, id)).humanAttached).toBeUndefined();
    expect(await audited(a, 'sandbox.takeover.end')).toHaveLength(1);
  });

  it('two terminals count as two sessions; the sandbox stays paused until the last one ends', async () => {
    const a = await setup();
    const id = await agentBox(a);
    const s1 = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    const s2 = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    expect((await a.inspectSandbox(A, id)).humanAttached?.sessions).toBe(2);
    fakeOf(env).ttyExits[0]!(0);
    await s1.wait();
    expect((await a.inspectSandbox(A, id)).humanAttached?.sessions).toBe(1);
    await expect(a.exec(A, id, { argv: ['true'] })).rejects.toMatchObject({ code: 'conflict' });
    await s2.close();
    expect((await a.inspectSandbox(A, id)).humanAttached).toBeUndefined();
  });

  it('only the sandbox of the agent is paused, not another agent’s, and a human-owned sandbox has no marker', async () => {
    const a = await setup();
    const mine = await agentBox(a, A);
    const theirs = await agentBox(a, B);
    const human = created(
      await a.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }),
    ).sandbox.id;
    const s = await a.attach(HUMAN, mine, { cols: 80, rows: 24 });
    const h = await a.attach(HUMAN, human, { cols: 80, rows: 24 });
    expect((await a.inspectSandbox(B, theirs)).humanAttached).toBeUndefined();
    expect((await a.inspectSandbox(HUMAN, human)).humanAttached).toBeUndefined();
    await expect(a.writeFile(B, theirs, '/workspace/x', 'x')).resolves.toBeDefined();
    await s.close();
    await h.close();
  });

  it('a crashed holder expires: without heartbeat the marker is ignored after the ttl', async () => {
    const a = await setup();
    const id = await agentBox(a);
    await a.attach(HUMAN, id, { cols: 80, rows: 24 }); // never ended, never beats (the clock is faked)
    await expect(a.exec(A, id, { argv: ['true'] })).rejects.toMatchObject({ code: 'conflict' });
    env.clock.t += HUMAN_SESSION_TTL_MS + 1;
    expect((await a.inspectSandbox(A, id)).humanAttached).toBeUndefined();
    const r = await a.exec(A, id, { argv: ['true'] }, { waitForApprovalMs: 0 });
    expect(['completed', 'pending_approval']).toContain(r.status);
  });

  it('a marker written by another process (the GUI) pauses this one: the state database is shared', async () => {
    const a = await setup();
    const id = await agentBox(a);
    const gui = StateStore.open(a.paths.stateDb, { now: env.clock.now });
    try {
      gui.humanSessions.begin({ id: 'gui-1', sandboxId: id, actor: 'human', pid: 4242 });
      await expect(a.exec(A, id, { argv: ['true'] })).rejects.toMatchObject({ code: 'conflict' });
      expect((await a.inspectSandbox(A, id)).humanAttached).toMatchObject({ sessions: 1 });
      // the holder keeps beating: still paused well after the first ttl window
      env.clock.t += HUMAN_SESSION_TTL_MS - 1;
      expect(gui.humanSessions.touch('gui-1')).toBe(true);
      env.clock.t += HUMAN_SESSION_TTL_MS - 1;
      await expect(a.exec(A, id, { argv: ['true'] })).rejects.toMatchObject({ code: 'conflict' });
      gui.humanSessions.end('gui-1');
      expect((await a.inspectSandbox(A, id)).humanAttached).toBeUndefined();
    } finally {
      gui.close();
    }
  });

  it('a live terminal refreshes its heartbeat, so it outlives the ttl', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const a = await setup();
      const id = await agentBox(a);
      const session = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
      for (let i = 0; i < 6; i++) {
        env.clock.t += HUMAN_SESSION_HEARTBEAT_MS;
        vi.advanceTimersByTime(HUMAN_SESSION_HEARTBEAT_MS);
      }
      // 30 s later (more than the ttl): still marked, because the holder kept beating
      expect(env.clock.t - HUMAN_SESSION_TTL_MS).toBeGreaterThan(0);
      await expect(a.exec(A, id, { argv: ['true'] })).rejects.toMatchObject({ code: 'conflict' });
      await session.close();
      // the timer is gone with the terminal
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closing the manager releases its markers', async () => {
    const a = await setup();
    const id = await agentBox(a);
    await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    const other = await openAbox(env, { bare: true, fake: { capabilities: { tty: true } } });
    try {
      expect((await other.inspectSandbox(A, id)).humanAttached?.sessions).toBe(1);
      a.close();
      expect((await other.inspectSandbox(A, id)).humanAttached).toBeUndefined();
    } finally {
      other.close();
      abox = undefined;
    }
  });
});
