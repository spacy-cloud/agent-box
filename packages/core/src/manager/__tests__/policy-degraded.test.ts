import { chmodSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import type { AboxEvent } from '../types.js';
import {
  A,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  fakeOf,
  makeEnv,
  openAbox,
  testPolicy,
  writePolicy,
  writeUserTemplates,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv | undefined;
let abox: Abox | undefined;
afterEach(() => {
  abox?.close();
  abox = undefined;
  env?.cleanup();
  env = undefined;
});

const BROKEN = 'profiles:\n  p:\n    approval: sometimes\n';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function expectInvalidPolicy(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({
    code: 'policy_denied',
    message: expect.stringContaining('policy.yaml is invalid'),
    details: { reason: 'policy_invalid' },
  });
}

/** An installation that has been used under a valid policy: an agent sandbox, a human sandbox, a pending approval. */
async function usedInstallation(): Promise<{
  agentBox: string;
  humanBox: string;
  approval: string;
}> {
  env = makeEnv();
  abox = await openAbox(env);
  const agentBox = created(
    await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }),
  ).sandbox.id;
  const humanBox = created(
    await abox.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }),
  ).sandbox.id;
  const pending = await abox.createSandbox(
    A,
    {
      template: 'fake-box',
      workspace: EMPTY_WS,
      overrides: { network: { mode: 'allowlist', allow: ['x.example.org'] } },
    },
    { waitForApprovalMs: 0 },
  );
  if (pending.status !== 'pending_approval') throw new Error('expected a pending approval');
  return { agentBox, humanBox, approval: pending.approvalId };
}

/** Closes the manager, breaks policy.yaml and opens again (what the next `abox` command sees). */
async function reopenBroken(text = BROKEN): Promise<Abox> {
  const fake = fakeOf(env!); // the backend (and its sandboxes) outlives the manager process
  abox!.close();
  writePolicy(env!, text);
  abox = await openAbox(env!, { bare: true, providers: { docker: () => fake } });
  return abox;
}

describe('a manager opened while policy.yaml is invalid (degraded mode)', () => {
  it('opens, and the human can look at everything and clean up', async () => {
    const { agentBox, humanBox, approval } = await usedInstallation();
    const good = abox!.policyHash;
    const a = await reopenBroken();
    // the last valid policy resolves the human context; the broken file is not in force
    expect(a.policyHash).toBe(good);

    const list = await a.listSandboxes(HUMAN);
    expect(list.sandboxes.map((s) => s.id).sort()).toEqual([agentBox, humanBox].sort());
    await expect(a.inspectSandbox(HUMAN, agentBox)).resolves.toMatchObject({ id: agentBox });
    await expect(a.listApprovals(HUMAN, { status: 'pending' })).resolves.toHaveLength(1);
    expect((await a.listTemplates(HUMAN)).templates.length).toBeGreaterThan(0);
    await expect(a.showTemplate(HUMAN, 'fake-box')).resolves.toMatchObject({
      template: { name: 'fake-box' },
    });
    await expect(a.validateTemplate(HUMAN, 'fake-box')).resolves.toMatchObject({ ok: true });
    await expect(a.verifyAudit(HUMAN)).resolves.toMatchObject({ ok: true });
    await expect(a.queryAudit(HUMAN, { limit: 5 })).resolves.not.toHaveLength(0);
    expect(a.validatePolicy(BROKEN).ok).toBe(false);
    const view = await a.showPolicy(HUMAN);
    expect(view.policy.contentHash).toBe(good);
    expect(view.policy.reloadError).toMatchObject({ fallback: 'last_valid' });
    expect(view.policy.reloadError?.message).toContain('invalid policy');
    expect(view.policy.reloadError?.issues.length).toBeGreaterThan(0);

    // cleanup: stop, remove, deny
    await expect(a.stopSandbox(HUMAN, humanBox)).resolves.toMatchObject({ state: 'stopped' });
    await expect(a.removeSandbox(HUMAN, humanBox)).resolves.toMatchObject({ removed: true });
    await expect(a.stopSandbox(HUMAN, agentBox)).resolves.toMatchObject({ state: 'stopped' });
    await expect(a.removeSandbox(HUMAN, agentBox)).resolves.toMatchObject({ removed: true });
    await expect(a.deny(HUMAN, approval, 'policy broken')).resolves.toMatchObject({
      approval: { status: 'denied' },
    });
  });

  it('doctor reports the policy as a failed check with the issues', async () => {
    await usedInstallation();
    const a = await reopenBroken();
    const report = await a.doctor(HUMAN);
    const check = report.checks.find((c) => c.id === 'policy.invalid');
    expect(check).toMatchObject({ level: 'error' });
    expect(check?.title).toContain('policy.yaml is invalid');
    expect(check?.detail).toContain('approval');
    expect(check?.hint).toContain('abox policy edit');
    expect(report.ok).toBe(false);
  });

  it('fails closed: nothing that creates or grants runs, for humans and agents alike', async () => {
    const { agentBox, approval } = await usedInstallation();
    const a = await reopenBroken();
    await expectInvalidPolicy(
      a.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }),
    );
    await expectInvalidPolicy(a.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    await expectInvalidPolicy(a.approve(HUMAN, approval));
    await expectInvalidPolicy(
      a.accessRequest(HUMAN_YES, agentBox, { kind: 'ttl', details: { ttl: '10m' } }),
    );
    await expectInvalidPolicy(a.extendTtl(HUMAN_YES, agentBox, '10m'));
    await expectInvalidPolicy(a.buildTemplate(HUMAN, 'fake-box'));
    await expectInvalidPolicy(a.createAgentToken(HUMAN, 'agent-a', 'x'));
    // the approval stays pending, nothing was created
    expect((await a.listApprovals(HUMAN, { status: 'pending' })).map((p) => p.id)).toEqual([
      approval,
    ]);
    expect((await a.listSandboxes(HUMAN)).sandboxes).toHaveLength(2);
  });

  it('every agent tool is refused (even reads and the agent’s own sandbox), with the issues', async () => {
    const { agentBox } = await usedInstallation();
    const a = await reopenBroken();
    for (const call of [
      () => a.listSandboxes(A),
      () => a.inspectSandbox(A, agentBox),
      () => a.exec(A, agentBox, { argv: ['true'] }),
      () => a.removeSandbox(A, agentBox),
      () => a.showPolicy(A),
      () => a.listTemplates(A),
      () => a.readFile(A, agentBox, '/workspace/x'),
    ])
      await expectInvalidPolicy(call());
    const e = await a.listSandboxes(A).catch((x: unknown) => x as { issues: unknown[] });
    expect(e.issues.length).toBeGreaterThan(0);
    // the sandbox is untouched and still the agent's
    expect((await a.inspectSandbox(HUMAN, agentBox)).owner).toBe('agent:agent-a');
  });

  it('does not record the broken file (or the fallback) as a policy revision, and reports it once', async () => {
    await usedInstallation();
    const before = (await abox!.listPolicyRevisions(HUMAN)).length;
    const a = await reopenBroken();
    expect(await a.listPolicyRevisions(HUMAN)).toHaveLength(before);
    expect(await a.queryAudit(HUMAN, { action: 'policy.reload_failed' })).toHaveLength(1);
    // the next command that opens the manager does not report the same broken file again
    a.close();
    abox = await openAbox(env!, { bare: true });
    abox.close();
    abox = await openAbox(env!, { bare: true });
    const entries = await abox.queryAudit(HUMAN, { action: 'policy.reload_failed' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'system', decision: 'error' });
    expect(entries[0]!.details).toMatchObject({ detected: 'startup' });
    expect(JSON.stringify(entries[0]!.details)).toContain('degraded mode');
    // a different broken file is reported again
    abox.close();
    writeFileSync(abox.paths.policyFile, 'profiles: [\n');
    abox = await openAbox(env!, { bare: true });
    expect(await abox.queryAudit(HUMAN, { action: 'policy.reload_failed' })).toHaveLength(2);
    expect(await abox.listPolicyRevisions(HUMAN)).toHaveLength(before);
  });

  it('policy edit works: setPolicy with a valid text ends degraded mode', async () => {
    const { agentBox } = await usedInstallation();
    const a = await reopenBroken();
    await expectInvalidPolicy(a.listSandboxes(A));
    const r = await a.setPolicy(HUMAN, testPolicy(env!).replace('sandboxes: 5', 'sandboxes: 2'));
    expect(r.changed).toBe(true);
    expect((await a.showPolicy(HUMAN)).policy.reloadError).toBeUndefined();
    await expect(a.inspectSandbox(A, agentBox)).resolves.toMatchObject({ id: agentBox });
    expect((await a.showPolicy(A)).profile.limits.sandboxes).toBe(2);
    created(await a.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }));
    // an invalid text is still rejected and changes nothing
    await expect(a.setPolicy(HUMAN, BROKEN)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('deadlines are still enforced', async () => {
    const { humanBox } = await usedInstallation();
    const a = await reopenBroken();
    env!.clock.t += 5 * 3_600_000;
    await a.sweepTtl(HUMAN);
    expect((await a.inspectSandbox(HUMAN, humanBox)).state).toBe('expired');
  });
});

describe('degraded mode without any valid policy on record', () => {
  it('uses the restrictive built-in policy: the human context only, no agent context at all', async () => {
    env = makeEnv();
    writeUserTemplates(env);
    writePolicy(env, BROKEN);
    abox = await openAbox(env, { bare: true });
    const view = await abox.showPolicy(HUMAN);
    expect(view.policy.reloadError).toMatchObject({ fallback: 'built_in' });
    expect(Object.keys(view.contexts ?? {})).toEqual(['human']);
    // the default agent contexts of the built-in default policy are not available
    for (const id of ['default', 'claude-code', 'agent-a'])
      await expectInvalidPolicy(abox.listSandboxes({ contextId: id }));
    await expect(abox.listSandboxes(HUMAN)).resolves.toMatchObject({ sandboxes: [] });
    await expectInvalidPolicy(
      abox.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }),
    );
    await expect(abox.listPolicyRevisions(HUMAN)).resolves.toHaveLength(0);
    // repairing it from this state records the first revision
    await abox.setPolicy(HUMAN, testPolicy(env));
    created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
  });

  it('an unreadable policy.yaml is degraded mode as well', async () => {
    env = makeEnv();
    writeUserTemplates(env);
    writePolicy(env, testPolicy(env));
    chmodSync(env.aboxHome + '/config/policy.yaml', 0o000);
    try {
      abox = await openAbox(env, { bare: true });
      // (root can read anything: then it is simply valid)
      const view = await abox.showPolicy(HUMAN);
      if (view.policy.reloadError) {
        expect(view.policy.reloadError.message).toContain('cannot read policy file');
        await expectInvalidPolicy(abox.listSandboxes(A));
      }
    } finally {
      chmodSync(env.aboxHome + '/config/policy.yaml', 0o600);
    }
  });
});

describe('policy.yaml turns invalid while the manager runs', () => {
  it('agents are refused from then on, the human can still clean up; fixing the file resumes', async () => {
    env = makeEnv();
    abox = await openAbox(env);
    const events: AboxEvent[] = [];
    abox.onEvent((e) => events.push(e));
    const id = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }))
      .sandbox.id;
    const good = abox.policyHash;
    await sleep(520);
    writeFileSync(abox.paths.policyFile, BROKEN);
    await expectInvalidPolicy(abox.listSandboxes(A));
    expect(abox.policyHash).toBe(good);
    expect(events.map((e) => e.type)).toContain('policy.reload_failed');
    const failed = await abox.queryAudit(HUMAN, { action: 'policy.reload_failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.details).toMatchObject({ detected: 'reload' });
    // refused attempts of the agent are audited (once per burst), never with the sandbox id
    const denied = await abox.queryAudit(HUMAN, { action: 'context.resolve', decision: 'deny' });
    expect(denied.some((d) => d.details?.['reason'] === 'policy_invalid')).toBe(true);
    // the human is not locked out
    await expect(abox.inspectSandbox(HUMAN, id)).resolves.toMatchObject({ id });
    expect((await abox.showPolicy(HUMAN)).policy.reloadError?.fallback).toBe('last_valid');
    await expectInvalidPolicy(
      abox.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }),
    );
    // the same broken file is not reported on every request
    await sleep(520);
    await abox.listSandboxes(HUMAN);
    expect(await abox.queryAudit(HUMAN, { action: 'policy.reload_failed' })).toHaveLength(1);
    // fixing the file ends degraded mode on its own
    await sleep(520);
    writeFileSync(abox.paths.policyFile, testPolicy(env).replace('sandboxes: 5', 'sandboxes: 2'));
    await expect(abox.inspectSandbox(A, id)).resolves.toMatchObject({ id });
    expect((await abox.showPolicy(HUMAN)).policy.reloadError).toBeUndefined();
    expect((await abox.showPolicy(A)).profile.limits.sandboxes).toBe(2);
    created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
  });
});
