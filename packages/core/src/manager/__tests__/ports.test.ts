import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import type { AccessResult } from '../types.js';
import { A, B, EMPTY_WS, HUMAN, createApproved, fakeOf, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';
import type { FakeOptions } from './fake-provider.js';

let env: TestEnv;
let abox: Abox;

const FREE = { contextId: 'ports-free-agent' };
const OFF = { contextId: 'ports-off-agent' };
const STRICT = { contextId: 'strict-agent' };

async function setup(fake: FakeOptions = { portForward: true }): Promise<void> {
  abox?.close();
  abox = await openAbox(env, { fake });
}

beforeEach(async () => {
  env = makeEnv();
  await setup();
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

/** A running sandbox; `fake-net` has network mode allowlist (the default `fake-box` has none). */
async function running(caller = A, template = 'fake-net'): Promise<string> {
  const id = (await createApproved(abox, caller, { template, workspace: EMPTY_WS })).sandbox.id;
  await abox.startSandbox(caller, id);
  return id;
}
const req = (port: number, hostPort?: number) => ({
  kind: 'port' as const,
  details: { port, ...(hostPort !== undefined ? { hostPort } : {}) },
  reason: 'preview the vite dev server',
});
function pendingId(r: AccessResult): string {
  if (r.status !== 'pending_approval') throw new Error(`expected pending, got ${r.status}`);
  return r.approvalId;
}

describe('port forwards: agents', () => {
  it('need a human by default; the approval is bound to the exact port and applied by the approver', async () => {
    const id = await running();
    const r = await abox.accessRequest(A, id, req(5173));
    const approvalId = pendingId(r);
    expect(fakeOf(env).portForwards.get(id) ?? []).toHaveLength(0);
    const view = await abox.getApproval(HUMAN, approvalId);
    expect(view.kinds).toContain('port_forward');
    expect(view.reasons.join(' ')).toContain('port 5173');
    expect(view.requester).toBe('agent:agent-a');

    // approving applies it: the forward exists although the agent never asked again
    const dec = await abox.approve(HUMAN, approvalId, 'ok');
    expect(dec.applied?.ok).toBe(true);
    const ports = await abox.listPortForwards(A, id);
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({
      sandboxPort: 5173,
      hostAddress: '127.0.0.1',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
    });
    expect((await abox.inspectSandbox(A, id)).ports).toHaveLength(1);

    // another port is another request: the approval does not cover it
    const other = await abox.accessRequest(A, id, req(3000));
    expect(other.status).toBe('pending_approval');
    expect((await abox.listPortForwards(A, id)).map((p) => p.sandboxPort)).toEqual([5173]);

    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.port.add'] });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ decision: 'approved', actor: 'human' });
    expect(JSON.stringify(audit[0]?.details)).toContain('"sandboxPort":5173');
  });

  it('a repeated request after approval is the same forward (idempotent)', async () => {
    const id = await running();
    const approvalId = pendingId(await abox.accessRequest(A, id, req(5173)));
    await abox.approve(HUMAN, approvalId);
    const again = await abox.accessRequest(A, id, req(5173));
    expect(again.status).toBe('applied');
    if (again.status === 'applied') {
      expect(again.port?.sandboxPort).toBe(5173);
      expect(again.message).toContain('already forwarded');
    }
    expect(await abox.listApprovals(HUMAN, { status: 'pending' })).toHaveLength(0);
    expect(fakeOf(env).portForwards.get(id)).toHaveLength(1);
  });

  it('a denied approval opens nothing', async () => {
    const id = await running();
    const approvalId = pendingId(await abox.accessRequest(A, id, req(5173)));
    await abox.deny(HUMAN, approvalId, 'no');
    expect(await abox.listPortForwards(A, id)).toEqual([]);
    await expect(abox.accessRequest(A, id, req(5173))).rejects.toMatchObject({
      code: 'approval_denied',
    });
  });

  it('ports.allow true: no question, a free host port is picked and reported', async () => {
    const id = await running(FREE);
    const r = await abox.accessRequest(FREE, id, req(5173));
    expect(r.status).toBe('applied');
    if (r.status !== 'applied') return;
    expect(r.port).toMatchObject({ sandboxPort: 5173, hostAddress: '127.0.0.1' });
    expect(r.message).toContain(r.port!.url);
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });

  it('approval mode strict asks as well', async () => {
    const id = await running(STRICT);
    const r = await abox.accessRequest(STRICT, id, req(5173));
    expect(r.status).toBe('pending_approval');
    const view = await abox.getApproval(HUMAN, pendingId(r));
    expect(view.kinds).toEqual(expect.arrayContaining(['port_forward', 'strict_mode']));
  });

  it('ports.allow false is a policy denial that queues nothing', async () => {
    const id = await running(OFF);
    await expect(abox.accessRequest(OFF, id, req(5173))).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('ports.allow: false'),
    });
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
    expect(fakeOf(env).portForwards.get(id) ?? []).toHaveLength(0);
  });

  it('ports.max limits the open forwards per sandbox', async () => {
    const id = await running(FREE);
    expect((await abox.accessRequest(FREE, id, req(3000))).status).toBe('applied');
    expect((await abox.accessRequest(FREE, id, req(3001))).status).toBe('applied');
    await expect(abox.accessRequest(FREE, id, req(3002))).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('ports.max'),
    });
    // closing one makes room
    expect((await abox.removePortForward(FREE, id, 3000)).removed).toBe(true);
    expect((await abox.accessRequest(FREE, id, req(3002))).status).toBe('applied');
  });

  it('cannot choose the host port', async () => {
    const id = await running(FREE);
    await expect(abox.accessRequest(FREE, id, req(5173, 8080))).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('cannot choose the host port'),
    });
  });

  it('only see and change their own sandboxes', async () => {
    const id = await running(A);
    await expect(abox.accessRequest(B, id, req(5173))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(abox.listPortForwards(B, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(abox.removePortForward(B, id, 5173)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects ports that are not TCP ports before anything is queued', async () => {
    const id = await running();
    for (const bad of [0, 65536, 1.5, -3]) {
      await expect(abox.accessRequest(A, id, req(bad))).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });
});

describe('port forwards: humans', () => {
  it('forward directly, with a fixed or an auto-picked host port', async () => {
    const id = await running(HUMAN);
    const fixed = await abox.accessRequest(HUMAN, id, req(5173, 8080));
    expect(fixed.status).toBe('applied');
    if (fixed.status === 'applied') expect(fixed.port?.url).toBe('http://127.0.0.1:8080/');
    const auto = await abox.accessRequest(HUMAN, id, req(3000));
    expect(auto.status).toBe('applied');
    expect((await abox.listPortForwards(HUMAN, id)).map((p) => p.sandboxPort)).toEqual([
      3000, 5173,
    ]);
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });

  it('never bind a privileged host port', async () => {
    const id = await running(HUMAN);
    for (const hostPort of [80, 443, 1023]) {
      await expect(abox.accessRequest(HUMAN, id, req(5173, hostPort))).rejects.toMatchObject({
        code: 'policy_denied',
        message: expect.stringContaining('privileged ports'),
      });
    }
    expect(fakeOf(env).portForwards.get(id) ?? []).toHaveLength(0);
  });

  it('a human can forward and remove a port of an agent sandbox', async () => {
    const id = await running(A);
    expect((await abox.accessRequest(HUMAN, id, req(5173))).status).toBe('applied');
    expect((await abox.listPortForwards(A, id)).map((p) => p.sandboxPort)).toEqual([5173]);
    expect((await abox.removePortForward(HUMAN, id, 5173)).removed).toBe(true);
    expect(await abox.listPortForwards(A, id)).toEqual([]);
  });
});

describe('port forwards: what a sandbox can have them', () => {
  it('a stopped sandbox is a conflict that explains the lifetime', async () => {
    const id = await running(HUMAN);
    await abox.stopSandbox(HUMAN, id);
    await expect(abox.accessRequest(HUMAN, id, req(5173))).rejects.toMatchObject({
      code: 'conflict',
      hint: expect.stringContaining('end when a sandbox stops'),
    });
  });

  it('network mode none has no path from the host: unsupported, with the way out, nothing queued', async () => {
    const id2 = await running(A, 'fake-box');
    expect((await abox.inspectSandbox(A, id2)).network.mode).toBe('none');
    const e = await abox.accessRequest(A, id2, req(5173)).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'unsupported', message: expect.stringContaining('"none"') });
    expect((e as { hint: string }).hint).toContain('allowlist');
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });

  it('an allowlist sandbox works (the same fake backend, mode allowlist)', async () => {
    const id = await running(HUMAN, 'fake-net');
    const r = await abox.accessRequest(HUMAN, id, req(5173));
    expect(r.status).toBe('applied');
  });

  it('a backend without port forwards is unsupported and queues nothing', async () => {
    await setup({});
    const id = await running(A);
    await expect(abox.accessRequest(A, id, req(5173))).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('cannot forward ports'),
    });
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });
});

describe('port forwards end with the sandbox', () => {
  it('stop closes them and the audit log keeps a summary, not connections', async () => {
    const id = await running(HUMAN);
    await abox.accessRequest(HUMAN, id, req(5173, 8081));
    await abox.stopSandbox(HUMAN, id);
    expect(fakeOf(env).portForwards.get(id) ?? []).toHaveLength(0);
    const closed = await abox.queryAudit(HUMAN, { action: ['sandbox.port.close'] });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.details).toMatchObject({ reason: 'stop', sandboxPort: 5173, hostPort: 8081 });
    expect((await abox.inspectSandbox(HUMAN, id)).ports).toEqual([]);
  });

  it('remove audits the closing, and expiry does too', async () => {
    const a = await running(HUMAN);
    await abox.accessRequest(HUMAN, a, req(5173));
    await abox.removeSandbox(HUMAN, a);
    const b = await running(HUMAN);
    await abox.accessRequest(HUMAN, b, req(3000));
    env.clock.t += 2 * 3600_000 + 1;
    await abox.sweepTtl(HUMAN);
    const reasons = (await abox.queryAudit(HUMAN, { action: ['sandbox.port.close'] })).map(
      (e) => (e.details as { reason: string }).reason,
    );
    expect(reasons.sort()).toEqual(['expired', 'remove']);
  });

  it('closing one by hand is audited with its counts and is not an error twice', async () => {
    const id = await running(HUMAN);
    await abox.accessRequest(HUMAN, id, req(5173));
    const gone = await abox.removePortForward(HUMAN, id, 5173);
    expect(gone).toMatchObject({ removed: true, port: { sandboxPort: 5173, connections: 0 } });
    expect(await abox.removePortForward(HUMAN, id, 5173)).toEqual({ removed: false });
    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.port.remove'] });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ reason: 'requested', connections: 0 });
    await expect(abox.removePortForward(HUMAN, id, 70000)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('emits sandbox.ports events for add and remove', async () => {
    const id = await running(HUMAN);
    const seen: string[] = [];
    abox.onEvent((e) => {
      if (e.type === 'sandbox.ports') seen.push(String(e.data?.['action']));
    });
    await abox.accessRequest(HUMAN, id, req(5173));
    await abox.removePortForward(HUMAN, id, 5173);
    expect(seen).toEqual(['add', 'remove']);
  });
});
