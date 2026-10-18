import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '@abox/core';
import type { Abox } from '@abox/core';
import { TOOL_NAMES } from '../src/index.js';
import { connect, makeEnv, openAbox, testPolicy } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let a: Connected;

const HUMAN = { contextId: 'human' };

const CACHED = `apiVersion: 1
name: cached-box
description: A fake container-like template with a package cache, used by the MCP tests only.
backend: docker
base: { os: ubuntu:24.04 }
resources: { cpus: 1, memory: 512m, ttl: 1h }
caches:
  - { name: store, path: ~/.cache/store, env: { STORE_DIR: '\${path}' } }
labels: { use-for: MCP cache tests }
`;

async function setup(profileExtra = ''): Promise<void> {
  env = makeEnv();
  abox = await openAbox(env, {
    fake: { capabilities: { caches: true } },
    policy: testPolicy(env)
      .replace('templates: [host-shell,', 'templates: [cached-box, host-shell,')
      .replace('    hosts: [local]\n', `    hosts: [local]\n${profileExtra}`),
  });
  writeFileSync(join(resolvePaths(env.env).templatesDir, 'cached-box.yaml'), CACHED);
  a = await connect(abox, 'agent-a');
}
afterEach(async () => {
  await a?.close();
  abox?.close();
  env?.cleanup();
});

const lastSpec = () => env.fakes.at(-1)!.specs.at(-1)!;

describe('package caches over MCP', () => {
  beforeEach(() => setup());

  it('gives the agent no way to list, read or remove caches', async () => {
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).filter((n) => /cache/i.test(n))).toEqual([]);
    expect(TOOL_NAMES.filter((n) => /cache/i.test(n))).toEqual([]);
    for (const tool of ['cache_ls', 'cache_list', 'cache_rm', 'cache_remove']) {
      const r = await a.call(tool, { key: 'abcd1234', all: true });
      expect(r.isError, tool).toBe(true);
      expect(r.s['code'], tool).toBe('not_found');
    }
    const rows = await abox.queryAudit(HUMAN, { action: 'mcp.unknown_tool', order: 'asc' });
    expect(rows.map((r) => r.details?.['tool'])).toEqual([
      'cache_ls',
      'cache_list',
      'cache_rm',
      'cache_remove',
    ]);
  });

  it('and the manager refuses the agent context as well, whatever the surface', async () => {
    await expect(abox.listCaches({ contextId: 'agent-a' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(abox.removeCaches({ contextId: 'agent-a' }, { all: true })).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('sandbox_create advertises cache and mounts the template cache by default', async () => {
    const { tools } = await a.client.listTools();
    const create = tools.find((t) => t.name === 'sandbox_create')!;
    expect((create.inputSchema.properties as Record<string, unknown>)['cache']).toMatchObject({
      type: 'boolean',
    });
    const r = await a.call('sandbox_create', {
      template: 'cached-box',
      workspace: { mode: 'copy', path: env.project },
    });
    expect(r.s['ok'], r.text).toBe(true);
    expect(lastSpec().caches?.map((c) => [c.name, c.path, c.owner])).toEqual([
      ['store', '/home/agent/.cache/store', 'agent:agent-a'],
    ]);
    expect(lastSpec().env['STORE_DIR']).toBe('/home/agent/.cache/store');
  });

  it('cache: false is a clean install, true changes nothing', async () => {
    const off = await a.call('sandbox_create', {
      template: 'cached-box',
      cache: false,
      workspace: { mode: 'copy', path: env.project },
    });
    expect(off.s['ok'], off.text).toBe(true);
    expect(lastSpec().caches).toBeUndefined();
    expect(lastSpec().env['STORE_DIR']).toBeUndefined();
    const on = await a.call('sandbox_create', {
      template: 'cached-box',
      cache: true,
      workspace: { mode: 'copy', path: env.project },
    });
    expect(on.s['ok'], on.text).toBe(true);
    expect(lastSpec().caches).toHaveLength(1);
    const bad = await a.call('sandbox_create', { template: 'cached-box', cache: 'no' });
    expect(bad.isError).toBe(true);
  });

  it('policy_show tells the agent whether caches are on and their cap', async () => {
    const r = await a.call('policy_show');
    expect(r.s['profile']).toMatchObject({ caches: true, cache_max_bytes: 10 * 1024 ** 3 });
  });
});

describe('package caches switched off by the policy', () => {
  beforeEach(() => setup('    caches: false\n'));

  it('an agent cannot turn them back on', async () => {
    const r = await a.call('sandbox_create', {
      template: 'cached-box',
      cache: true,
      workspace: { mode: 'copy', path: env.project },
    });
    expect(r.s['ok'], r.text).toBe(true);
    expect(lastSpec().caches).toBeUndefined();
    expect((await a.call('policy_show')).s['profile']).toMatchObject({ caches: false });
  });
});
