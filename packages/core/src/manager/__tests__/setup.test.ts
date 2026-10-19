import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import { A, HUMAN, HUMAN_YES, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, {});
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

describe('Abox.setup*: human only, confirmed, audited', () => {
  it('an agent can use none of it, and the refusals are audited', async () => {
    await expect(abox.setupDetect(A)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.setupPlan(A, { clients: ['codex'] })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(
      abox.setupApply({ ...A, humanConfirmed: true }, { clients: ['codex'] }, 'a'.repeat(64)),
    ).rejects.toMatchObject({
      code: 'policy_denied',
    });
    const denied = await abox.queryAudit(HUMAN, {
      action: ['setup.apply_denied', 'setup.detect_denied', 'setup.plan_denied'],
    });
    expect(denied.map((e) => e.action).sort()).toEqual(
      expect.arrayContaining(['setup.apply_denied', 'setup.detect_denied', 'setup.plan_denied']),
    );
    expect(existsSync(join(env.home, '.codex'))).toBe(false);
  });

  it('a human previews, confirms with the digest, and the change is audited', async () => {
    const plan = await abox.setupPlan(HUMAN, { clients: ['codex'], command: '/opt/abox' });
    expect(plan.steps.map((s) => (s.type === 'file' ? s.path : ''))).toContain(
      join(env.home, '.codex', 'config.toml'),
    );
    expect(existsSync(join(env.home, '.codex'))).toBe(false);

    await expect(
      abox.setupApply(HUMAN, { clients: ['codex'], command: '/opt/abox' }, plan.digest),
    ).rejects.toMatchObject({
      code: 'approval_required',
    });
    await expect(
      abox.setupApply(HUMAN_YES, { clients: ['codex'], command: '/opt/abox' }, 'nope'),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    // a plan for something else is not the one that was confirmed
    await expect(
      abox.setupApply(HUMAN_YES, { clients: ['cursor'], command: '/opt/abox' }, plan.digest),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    const res = await abox.setupApply(
      HUMAN_YES,
      { clients: ['codex'], command: '/opt/abox' },
      plan.digest,
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(env.home, '.codex', 'config.toml'), 'utf8')).toContain(
      'command = "/opt/abox"',
    );

    const audit = await abox.queryAudit(HUMAN, { action: ['setup.apply'] });
    expect(audit.some((e) => e.decision === 'allow')).toBe(true);
    const text = JSON.stringify(audit);
    expect(text).toContain('config.toml');
    expect(text).not.toContain('mcp_servers'); // paths and statuses, never the content
    // backups live below the data directory, private
    expect(res.backups).toEqual([]); // nothing existed before
  });

  it('warns when the agent context is not in policy.yaml', async () => {
    const plan = await abox.setupPlan(HUMAN, { clients: ['codex'] });
    expect(plan.warnings.join('\n')).toContain(
      'agent context "codex" is not defined in policy.yaml',
    );
  });

  it('uninstall is a plan of its own and audited as setup.uninstall', async () => {
    const req = { clients: ['cursor'] as const };
    const p = await abox.setupPlan(HUMAN, { clients: [...req.clients], command: '/opt/abox' });
    await abox.setupApply(HUMAN_YES, { clients: [...req.clients], command: '/opt/abox' }, p.digest);
    const u = await abox.setupPlan(HUMAN, { clients: [...req.clients], uninstall: true });
    expect(u.uninstall).toBe(true);
    await abox.setupApply(HUMAN_YES, { clients: [...req.clients], uninstall: true }, u.digest);
    expect(existsSync(join(env.home, '.cursor', 'mcp.json'))).toBe(false);
    expect((await abox.queryAudit(HUMAN, { action: ['setup.uninstall'] })).length).toBe(1);
  });
});
