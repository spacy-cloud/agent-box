import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { TOOL_NAMES } from '../src/index.js';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let a: Connected;

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, {});
  a = await connect(abox, 'agent-a');
});
afterEach(async () => {
  await a?.close();
  abox?.close();
  env?.cleanup();
});

describe('abox setup is not an agent power', () => {
  it('there is no MCP tool for it, and the manager refuses an agent whatever the surface', async () => {
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).filter((n) => /setup|register|install/i.test(n))).toEqual([]);
    expect(TOOL_NAMES.filter((n) => /setup/i.test(n))).toEqual([]);
    const r = await a.call('setup_apply', { clients: ['codex'] });
    expect(r.isError).toBe(true);
    expect(r.s['code']).toBe('not_found');
    const agent = { contextId: 'agent-a', humanConfirmed: true };
    await expect(abox.setupPlan(agent, { clients: ['codex'] })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(
      abox.setupApply(agent, { clients: ['codex'] }, 'a'.repeat(64)),
    ).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(existsSync(join(env.home, '.codex'))).toBe(false);
  });
});
