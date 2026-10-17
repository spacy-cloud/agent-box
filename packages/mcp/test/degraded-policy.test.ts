import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { assertAgentContext } from '../src/stdio.js';
import { connect, makeEnv, openAbox, testPolicy } from './support/harness.js';
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('a broken policy.yaml while the MCP server runs', () => {
  it('every tool answers policy_denied with the problem (fail closed); fixing the file resumes', async () => {
    const c = await a.call('sandbox_create', {
      template: 'fake-box',
      workspace: { mode: 'empty' },
    });
    expect(c.s['ok']).toBe(true);
    const id = (c.s['sandbox'] as { id: string }).id;
    await sleep(520);
    writeFileSync(abox.paths.policyFile, 'profiles:\n  agent:\n    approval: sometimes\n');

    for (const [tool, args] of [
      ['sandbox_list', {}],
      ['sandbox_inspect', { id }],
      ['sandbox_exec', { id, argv: ['true'] }],
      ['sandbox_create', { template: 'fake-box', workspace: { mode: 'empty' } }],
      ['sandbox_delete', { id }],
      ['template_list', {}],
      ['policy_show', {}],
    ] as const) {
      const r = await a.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.s['code'], tool).toBe('policy_denied');
      expect(String(r.s['message']), tool).toContain('policy.yaml is invalid');
      expect(r.text, tool).toContain('Hint:');
    }
    // the human still sees and owns the sandbox
    expect((await abox.inspectSandbox({ contextId: 'human' }, id)).state).toBe('running');

    // a server that is started now says why, instead of "context not defined"
    await expect(assertAgentContext(abox, 'agent-a')).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('policy.yaml is invalid'),
    });

    await sleep(520);
    writeFileSync(abox.paths.policyFile, testPolicy(env));
    expect((await a.call('sandbox_list')).s['ok']).toBe(true);
    await expect(assertAgentContext(abox, 'agent-a')).resolves.toBeUndefined();
  });
});
