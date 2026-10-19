import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { TOOL_NAMES } from '../src/index.js';
import { closestKey } from '../src/arguments.js';
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

describe('strict tool input: unknown parameters are errors, not dropped', () => {
  it('every tool rejects an unknown top-level parameter and names it', async () => {
    for (const tool of TOOL_NAMES) {
      const r = await a.call(tool, { bogus_param: true });
      expect(r.isError, tool).toBe(true);
      expect(r.s['code'], tool).toBe('invalid_input');
      expect(String(r.s['message']), tool).toContain('unknown parameter "bogus_param"');
    }
    // nothing ran
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
  });

  it('advertises additionalProperties:false in every input schema (also nested objects)', async () => {
    const { tools } = await a.client.listTools();
    for (const t of tools) {
      expect(
        (t.inputSchema as { additionalProperties?: unknown }).additionalProperties,
        t.name,
      ).toBe(false);
    }
    const create = tools.find((t) => t.name === 'sandbox_create')!;
    const props = create.inputSchema.properties as Record<
      string,
      { additionalProperties?: unknown; properties?: Record<string, unknown> }
    >;
    expect(props['workspace']!.additionalProperties).toBe(false);
    expect(props['overrides']!.additionalProperties).toBe(false);
    expect(
      (props['overrides']!.properties as Record<string, { additionalProperties?: unknown }>)[
        'network'
      ]!.additionalProperties,
    ).toBe(false);
  });

  it('suggests the closest valid parameter (branch -> branch_name)', async () => {
    const r = await a.call('sandbox_export', {
      id: 'local/1a2b3c4d',
      format: 'branch',
      branch: 'agent/work',
    });
    expect(r.isError).toBe(true);
    expect(r.s['code']).toBe('invalid_input');
    expect(String(r.s['message'])).toContain(
      'unknown parameter "branch" (did you mean "branch_name"?)',
    );
    expect(r.text).toContain('Unknown parameters are rejected, not ignored');
  });

  it('checks nested objects: overrides, overrides.network, mounts items, workspace, access details', async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown>; expected: string }> = [
      {
        tool: 'sandbox_create',
        args: { template: 'fake-box', overrides: { project_dir: '/x' } },
        expected: 'unknown parameter "overrides.project_dir"',
      },
      {
        tool: 'sandbox_create',
        args: { template: 'fake-box', overrides: { network: { private_exception: ['10.0.0.1'] } } },
        expected:
          'unknown parameter "overrides.network.private_exception" (did you mean "overrides.network.private_exceptions"?)',
      },
      {
        tool: 'sandbox_create',
        args: {
          template: 'fake-box',
          overrides: { mounts: [{ source: '/a', target: '/b', acces: 'ro' }] },
        },
        expected:
          'unknown parameter "overrides.mounts.0.acces" (did you mean "overrides.mounts.0.access"?)',
      },
      {
        tool: 'sandbox_create',
        args: { template: 'fake-box', workspace: { mode: 'empty', pth: '/x' } },
        expected: 'unknown parameter "workspace.pth" (did you mean "workspace.path"?)',
      },
      {
        tool: 'sandbox_create',
        args: { template: 'fake-box', workspaceMode: 'copy' },
        expected: 'unknown parameter "workspaceMode"',
      },
      {
        tool: 'access_request',
        args: {
          id: 'local/1a2b3c4d',
          kind: 'network',
          details: { domain: ['pypi.org'] },
          reason: 'need packages',
        },
        expected: 'unknown parameter "details.domain" (did you mean "details.domains"?)',
      },
    ];
    for (const c of cases) {
      const r = await a.call(c.tool, c.args);
      expect(r.isError, c.expected).toBe(true);
      expect(r.s['code'], c.expected).toBe('invalid_input');
      expect(String(r.s['message']), c.expected).toContain(c.expected);
    }
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
  });

  it('lists the valid parameters when nothing is close, and reports other problems in the same answer', async () => {
    const r = await a.call('sandbox_create', {
      template: 'fake-box',
      overrides: { zzz: 1, cpus: 'many' },
    });
    expect(r.isError).toBe(true);
    expect(String(r.s['message'])).toContain('unknown parameter "overrides.zzz"');
    expect(String(r.s['message'])).toContain('overrides.cpus');
    expect(String(r.s['hint'])).toContain('Valid parameters in overrides: cpus, memory, ttl');
  });

  it('known parameters still work', async () => {
    const r = await a.call('sandbox_create', {
      template: 'fake-box',
      request_id: 'strict-ok',
      overrides: { cpus: 1, network: { mode: 'none' } },
    });
    expect(r.s['ok']).toBe(true);
    const list = await a.call('sandbox_list');
    expect(list.s['ok']).toBe(true);
  });
});

describe('closestKey', () => {
  const valid = ['branch_name', 'format', 'paths', 'max_bytes'];
  it('matches spelling variants, camelCase and truncated names', () => {
    expect(closestKey('branchName', valid)).toBe('branch_name');
    expect(closestKey('branch', valid)).toBe('branch_name');
    expect(closestKey('path', valid)).toBe('paths');
    expect(closestKey('formt', valid)).toBe('format');
    expect(closestKey('maxbytes', valid)).toBe('max_bytes');
  });
  it('returns nothing for unrelated names', () => {
    expect(closestKey('zzz', valid)).toBeUndefined();
    expect(closestKey('', valid)).toBeUndefined();
  });
});
