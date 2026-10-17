import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let a: Connected;

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
  a = await connect(abox, 'agent-a');
});
afterEach(async () => {
  await a.close();
  abox.close();
  env.cleanup();
});

const HUMAN = { contextId: 'human' };

describe('calls to tools that do not exist', () => {
  it('stay not_found for the agent and are audited as mcp.unknown_tool', async () => {
    for (const tool of ['policy_set', 'approve', 'ssh_exec']) {
      const r = await a.call(tool, { text: 'version: 1', api_key: 'sk-SUPERSECRETVALUE' });
      expect(r.isError, tool).toBe(true);
      expect(r.s['code'], tool).toBe('not_found');
    }
    const rows = await abox.queryAudit(HUMAN, { action: 'mcp.unknown_tool', order: 'asc' });
    expect(rows.map((r) => r.details?.['tool'])).toEqual(['policy_set', 'approve', 'ssh_exec']);
    for (const row of rows) {
      expect(row.actor).toBe('agent:agent-a');
      expect(row.decision).toBe('deny');
      expect(row.details).toMatchObject({ context: 'agent-a', argNames: ['text', 'api_key'] });
    }
    // argument values never reach the log
    expect(JSON.stringify(rows)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(rows)).not.toContain('version: 1');
  });

  it('are rate limited so probing cannot flood the audit log', async () => {
    for (let i = 0; i < 30; i++) await a.call(`probe_${i}`);
    await a.call('probe_0'); // the same tool again within a minute: not logged twice
    const rows = await abox.queryAudit(HUMAN, { action: 'mcp.unknown_tool', limit: 100 });
    expect(rows.length).toBe(10);
  });

  it('do not audit real tools, bad arguments or disabled lookups', async () => {
    await a.call('template_show', { name: 'nope' });
    await a.call('sandbox_inspect', { id: 42 });
    const rows = await abox.queryAudit(HUMAN, { action: 'mcp.unknown_tool' });
    expect(rows).toEqual([]);
  });
});
