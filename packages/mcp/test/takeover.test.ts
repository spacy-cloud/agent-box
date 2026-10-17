import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '@abox/core';
import type { Abox } from '@abox/core';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let a: Connected;
let gui: StateStore;

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
  a = await connect(abox, 'agent-a');
  // the GUI is a separate process: it only shares the state database with the MCP server
  gui = StateStore.open(abox.paths.stateDb);
});
afterEach(async () => {
  await a.close();
  gui.close();
  abox.close();
  env.cleanup();
});

describe('human takeover seen from the MCP server', () => {
  it('pauses exec, process start and file writes with a clear conflict while a human terminal is open', async () => {
    const c = await a.call('sandbox_create', {
      template: 'fake-box',
      workspace: { mode: 'empty' },
    });
    const id = (c.s['sandbox'] as { id: string }).id;
    expect((await a.call('sandbox_inspect', { id })).s['sandbox']).not.toHaveProperty(
      'human_attached',
    );

    gui.humanSessions.begin({ id: 'gui-1', sandboxId: id, actor: 'human', pid: process.pid });

    const exec = await a.call('sandbox_exec', { id, argv: ['true'] });
    expect(exec.isError).toBe(true);
    expect(exec.s).toMatchObject({ ok: false, code: 'conflict' });
    expect(exec.s['message']).toMatch(/paused: a human is working in sandbox/);
    expect(exec.text).toMatch(/Stop sending commands/);
    expect(exec.s['details']).toMatchObject({ reason: 'human_attached', sessions: 1 });
    for (const [tool, args] of [
      ['sandbox_process_start', { id, argv: ['sleep', '1'] }],
      ['sandbox_write_file', { id, path: '/workspace/x.txt', content: 'x' }],
      ['sandbox_stop', { id }],
      ['sandbox_start', { id }],
      ['sandbox_delete', { id }],
      ['sandbox_snapshot', { id, name: 'before' }],
      ['sandbox_restore', { id, snapshot_id: 'before' }],
      ['access_request', { id, kind: 'ttl', details: { ttl: '10m' }, reason: 'more time' }],
    ] as const) {
      const r = await a.call(tool, args);
      expect(r.s, tool).toMatchObject({ ok: false, code: 'conflict' });
    }
    // the agent can still look: inspect (with the marker), list and read
    const view = await a.call('sandbox_inspect', { id });
    expect(view.s['sandbox'].human_attached).toMatchObject({ sessions: 1, actor: 'human' });
    expect(view.text).toMatch(/PAUSED: a human is working/);
    expect((await a.call('sandbox_list_dir', { id, path: '/workspace' })).isError).toBe(false);
    expect(env.fakes.at(-1)!.execCalls).toHaveLength(0);

    expect((await a.call('sandbox_inspect', { id })).s['sandbox']).toMatchObject({
      state: 'running',
    });

    gui.humanSessions.end('gui-1');
    const again = await a.call('sandbox_exec', { id, argv: ['true'] });
    expect(again.s['code']).not.toBe('conflict');
    expect((await a.call('sandbox_inspect', { id })).s['sandbox']).not.toHaveProperty(
      'human_attached',
    );
  });
});
