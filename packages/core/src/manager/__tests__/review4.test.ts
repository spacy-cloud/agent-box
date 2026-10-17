import { afterEach, describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import type { HostResolver } from '../internals.js';
import type { Abox } from '../abox.js';
import { A, B, HUMAN, HUMAN_YES, makeEnv, openAbox } from './harness.js';
import type { OpenOpts, TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox | undefined;

async function setup(o: OpenOpts = {}): Promise<Abox> {
  env = makeEnv();
  abox = await openAbox(env, o);
  return abox;
}
afterEach(() => {
  abox?.close();
  abox = undefined;
  env.cleanup();
});

async function rejection(p: Promise<unknown>): Promise<AboxError> {
  try {
    await p;
  } catch (e) {
    return e as AboxError;
  }
  throw new Error('expected a rejection');
}

describe('list with --host', () => {
  const hostResolver: HostResolver = async (id) => {
    if (id === 'local')
      return {
        connection: { host: 'local', kind: 'local' },
        zone: 'workstation',
        backends: ['docker', 'process'],
      };
    if (id === 'bare')
      return { connection: { host: 'bare', kind: 'local' }, zone: 'workstation', backends: [] };
    if (id === 'down')
      throw new AboxError('host_unreachable', 'host "down" is not reachable: timed out');
    throw new AboxError('not_found', `unknown host "${id}"`);
  };

  it('an unknown host is not_found, not an empty list', async () => {
    const a = await setup({ hostResolver });
    const e = await rejection(a.listSandboxes(HUMAN, { host: 'nosuch' }));
    expect(e.code).toBe('not_found');
    expect(e.message).toContain('nosuch');
    expect(e.hint).toContain('abox host ls');
    expect((await rejection(a.listSandboxes(A, { host: 'nosuch' }))).code).toBe('not_found');
  });

  it('an unknown host is not_found without a host resolver as well', async () => {
    const a = await setup();
    expect((await rejection(a.listSandboxes(HUMAN, { host: 'nosuch' }))).code).toBe('not_found');
  });

  it('an unreachable host is reported with the reason instead of an empty list', async () => {
    const a = await setup({ hostResolver });
    const r = await a.listSandboxes(HUMAN, { host: 'down' });
    expect(r.sandboxes).toEqual([]);
    expect(r.unreachableHosts).toEqual(['down']);
    expect(r.hostProblems?.['down']).toContain('not reachable');
  });

  it('a host without a usable backend is reported', async () => {
    const a = await setup({ hostResolver });
    const r = await a.listSandboxes(HUMAN, { host: 'bare' });
    expect(r.unreachableHosts).toEqual(['bare']);
    expect(r.hostProblems?.['bare']).toContain('no usable backend');
  });

  it('a healthy host lists normally and reports no problems', async () => {
    const a = await setup({ hostResolver });
    const r = await a.listSandboxes(HUMAN, { host: 'local' });
    expect(r.unreachableHosts).toEqual([]);
    expect(r.hostProblems).toBeUndefined();
  });
});

describe('workspace already used by another sandbox', () => {
  it('is a conflict that names the sandbox, not "protected path"', async () => {
    const a = await setup();
    const first = await a.createSandbox(HUMAN_YES, {
      template: 'fake-box',
      workspace: { mode: 'mount', path: env.project },
    });
    expect(first.status).toBe('created');
    const id = first.status === 'created' ? first.sandbox.id : '';
    for (const mode of ['clone', 'copy', 'worktree', 'mount'] as const) {
      const e = await rejection(
        a.createSandbox(HUMAN_YES, {
          template: 'fake-box',
          workspace: { mode, path: env.project },
        }),
      );
      expect(e.code, mode).toBe('conflict');
      expect(e.message, mode).toContain(`already used by sandbox ${id}`);
      expect(e.message, mode).toContain('remove it or choose another path/mode');
      expect(e.message, mode).not.toContain('protected path');
      expect(e.details?.['sandboxId']).toBe(id);
    }
    // a different path is fine; so is the same path once the sandbox is gone
    await a.removeSandbox(HUMAN_YES, id);
    const again = await a.createSandbox(HUMAN_YES, {
      template: 'fake-box',
      workspace: { mode: 'copy', path: env.project },
    });
    expect(again.status).toBe('created');
  });

  it('does not reveal the sandboxes of other owners to an agent', async () => {
    const a = await setup();
    const mine = await a.createSandbox(HUMAN_YES, {
      template: 'fake-box',
      workspace: { mode: 'mount', path: env.project },
    });
    expect(mine.status).toBe('created');
    const e = await rejection(
      a.createSandbox(B, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: env.project },
      }),
    );
    expect(e.message).not.toContain(mine.status === 'created' ? mine.sandbox.id : 'x');
    expect(e.code).toBe('policy_denied'); // generic denial, as before
  });
});

describe('unknown MCP tools are audited', () => {
  it('writes mcp.unknown_tool with tool, context and argument names only', async () => {
    const a = await setup();
    expect(await a.auditUnknownTool(A, 'policy_set', ['text', 'api_key'])).toBe(true);
    const rows = await a.queryAudit(HUMAN, { action: 'mcp.unknown_tool' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('agent:agent-a');
    expect(rows[0]!.decision).toBe('deny');
    expect(rows[0]!.details).toMatchObject({
      tool: 'policy_set',
      context: 'agent-a',
      argNames: ['text', 'api_key'],
    });
    expect(JSON.stringify(rows[0])).not.toContain('SECRET');
  });

  it('ignores humans, sanitizes names and rate limits probing', async () => {
    const a = await setup();
    expect(await a.auditUnknownTool(HUMAN, 'approve')).toBe(false);
    expect(await a.auditUnknownTool(A, 'evil‮\ntool'.padEnd(200, 'x'))).toBe(true);
    expect(await a.auditUnknownTool(A, 'same')).toBe(true);
    expect(await a.auditUnknownTool(A, 'same')).toBe(false); // same tool: once a minute
    let written = 2;
    for (let i = 0; i < 40; i++) if (await a.auditUnknownTool(A, `probe_${i}`)) written++;
    expect(written).toBe(10); // at most 10 entries a minute per agent
    // another agent has its own budget
    expect(await a.auditUnknownTool(B, 'probe_0')).toBe(true);
    const rows = await a.queryAudit(HUMAN, { action: 'mcp.unknown_tool', limit: 100 });
    expect(rows).toHaveLength(11);
    const names = rows.map((r) => String(r.details?.['tool']));
    expect(names.every((n) => !/[‮\n]/.test(n) && n.length <= 70)).toBe(true);
  });
});

describe('open network in the human context', () => {
  it('needs confirmation below hardened and is created once confirmed', async () => {
    const a = await setup();
    const req = {
      template: 'fake-box',
      workspace: { mode: 'empty' as const },
      overrides: { network: { mode: 'open' as const } },
    };
    const r = await a.createSandbox(HUMAN, req);
    expect(r.status).toBe('confirmation_required');
    if (r.status === 'confirmation_required') {
      expect(r.reasons.join(' ')).toContain('network mode "open"');
      expect(r.risks.join(' ')).toContain('Unrestricted internet access');
    }
    const ok = await a.createSandbox(HUMAN_YES, req);
    expect(ok.status).toBe('created');
    // agent rules are unchanged: approval in mode medium, and a human confirmation does not count
    const agent = await a.createSandbox({ ...A, humanConfirmed: true }, req, {
      waitForApprovalMs: 0,
    });
    expect(agent.status).toBe('pending_approval');
  });
});
