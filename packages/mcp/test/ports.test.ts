import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
const conns: Connected[] = [];

const HUMAN = { contextId: 'human' };

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, { fake: { portForward: true } });
});
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  abox.close();
  env.cleanup();
});

async function agent(contextId: string): Promise<{ c: Connected; id: string }> {
  const c = await connect(abox, contextId);
  conns.push(c);
  const made = await c.call('sandbox_create', {
    template: 'fake-net',
    workspace: { mode: 'empty' },
  });
  const id = (made.s['sandbox'] as { id: string }).id;
  await abox.startSandbox({ contextId }, id);
  return { c, id };
}

describe('sandbox_port_forward', () => {
  it('is one of the tools, with the host side left to abox', async () => {
    const { c } = await agent('agent-a');
    const tool = (await c.client.listTools()).tools.find((t) => t.name === 'sandbox_port_forward')!;
    expect(tool.description).toContain('0.0.0.0');
    expect(tool.description).toContain('approves');
    const props = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
    expect(props.sort()).toEqual(['action', 'id', 'port', 'reason']);
    expect(props).not.toContain('host_port');
  });

  it('queues an approval by default; the approver applies it and the agent reads the URL', async () => {
    const { c, id } = await agent('agent-a');
    const r = await c.call('sandbox_port_forward', { id, port: 5173, reason: 'vite preview' });
    expect(r.s).toMatchObject({ ok: false, status: 'pending_approval' });
    expect(r.isError).toBe(false);
    expect(r.s['kinds']).toContain('port_forward');
    expect(r.s['message']).toContain(`abox approvals approve ${r.s['approval_id'] as string}`);
    expect(r.s['message']).toContain('action=list');
    // nothing is open before a human decided
    expect((await c.call('sandbox_port_forward', { id, action: 'list' })).s['ports']).toEqual([]);

    await abox.approve(HUMAN, String(r.s['approval_id']), 'looks fine');
    const listed = await c.call('sandbox_port_forward', { id, action: 'list' });
    expect(listed.s['ports']).toMatchObject([
      {
        sandbox_port: 5173,
        host_address: '127.0.0.1',
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
      },
    ]);
    const insp = await c.call('sandbox_inspect', { id });
    expect((insp.s['ports'] as unknown[]).length).toBe(1);
    expect(insp.text).toContain('Port forwards:');

    // repeating the identical call returns the open forward instead of asking again
    const again = await c.call('sandbox_port_forward', { id, port: 5173, reason: 'vite preview' });
    expect(again.s).toMatchObject({ ok: true, status: 'applied' });
    expect(again.s['port']).toMatchObject({ sandbox_port: 5173 });
    expect(await abox.listApprovals(HUMAN, { status: 'pending' })).toHaveLength(0);
  });

  it('applies at once when the profile says ports.allow true, and removes again', async () => {
    const { c, id } = await agent('agent-free');
    const r = await c.call('sandbox_port_forward', { id, port: 8000, reason: 'php -S preview' });
    expect(r.s).toMatchObject({ ok: true, status: 'applied' });
    expect(r.text).toContain('http://127.0.0.1:');
    const url = (r.s['port'] as { url: string }).url;
    expect(r.text).toContain(url);
    const gone = await c.call('sandbox_port_forward', { id, action: 'remove', port: 8000 });
    expect(gone.s).toMatchObject({ ok: true, removed: true });
    expect((await c.call('sandbox_port_forward', { id, action: 'list' })).s['ports']).toEqual([]);
    const none = await c.call('sandbox_port_forward', { id, action: 'remove', port: 8000 });
    expect(none.s).toMatchObject({ ok: true, removed: false });
  });

  it('is a policy denial when the profile forbids it, with nothing queued', async () => {
    const { c, id } = await agent('agent-nopreview');
    const r = await c.call('sandbox_port_forward', { id, port: 5173, reason: 'x' });
    expect(r.isError).toBe(true);
    expect(r.s['code']).toBe('policy_denied');
    expect(String(r.s['message'])).toContain('ports.allow: false');
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });

  it('respects ports.max', async () => {
    const { c, id } = await agent('agent-free');
    for (const port of [3000, 3001])
      expect((await c.call('sandbox_port_forward', { id, port, reason: 'x' })).s['ok']).toBe(true);
    const third = await c.call('sandbox_port_forward', { id, port: 3002, reason: 'x' });
    expect(third.s['code']).toBe('policy_denied');
    expect(String(third.s['message'])).toContain('ports.max');
  });

  it('validates its input and needs a reason to add', async () => {
    const { c, id } = await agent('agent-free');
    expect((await c.call('sandbox_port_forward', { id, port: 0, reason: 'x' })).s['code']).toBe(
      'invalid_input',
    );
    expect((await c.call('sandbox_port_forward', { id, port: 70000, reason: 'x' })).s['code']).toBe(
      'invalid_input',
    );
    const noPort = await c.call('sandbox_port_forward', { id, reason: 'x' });
    expect(noPort.s['code']).toBe('invalid_input');
    expect(String(noPort.s['message'])).toContain('port is required');
    const noReason = await c.call('sandbox_port_forward', { id, port: 5173 });
    expect(noReason.s['code']).toBe('invalid_input');
    expect(String(noReason.s['message'])).toContain('reason is required');
    const hp = await c.call('sandbox_port_forward', {
      id,
      port: 5173,
      reason: 'x',
      host_port: 8080,
    });
    expect(hp.s['code']).toBe('invalid_input');
    expect(String(hp.s['message'])).toContain('unknown parameter "host_port"');
    expect((await abox.listPortForwards(HUMAN, id)).length).toBe(0);
  });

  it('cannot reach the sandbox of another agent', async () => {
    const { id } = await agent('agent-free');
    const b = await connect(abox, 'agent-b');
    conns.push(b);
    const r = await b.call('sandbox_port_forward', { id, port: 5173, reason: 'x' });
    expect(r.s['code']).toBe('not_found');
    expect((await b.call('sandbox_port_forward', { id, action: 'list' })).s['code']).toBe(
      'not_found',
    );
  });

  it('says why a sandbox without network cannot get one', async () => {
    const c = await connect(abox, 'agent-free');
    conns.push(c);
    const made = await c.call('sandbox_create', {
      template: 'fake-box',
      workspace: { mode: 'empty' },
    });
    const id = (made.s['sandbox'] as { id: string }).id;
    await abox.startSandbox({ contextId: 'agent-free' }, id);
    const r = await c.call('sandbox_port_forward', { id, port: 5173, reason: 'x' });
    expect(r.s['code']).toBe('unsupported');
    expect(String(r.s['message'])).toContain('"none"');
    expect(String(r.s['hint'])).toContain('allowlist');
  });
});
