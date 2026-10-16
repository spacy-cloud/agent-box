import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import type { Abox } from '../abox.js';
import {
  A,
  B,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  createApproved,
  fakeOf,
  makeEnv,
  openAbox,
  projectTemplate,
  testPolicy,
  writeProjectTemplate,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;
beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

const fake = (): ReturnType<typeof fakeOf> => fakeOf(env);

async function rejects(p: Promise<unknown>): Promise<AboxError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AboxError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('project template trust', () => {
  it('needs a template_trust approval, then is trusted only for the exact content hash', async () => {
    const file = writeProjectTemplate(env);
    const req = { template: 'proj-tpl', workspace: EMPTY_WS };

    const first = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    expect(first.kind).toBe('template_trust');
    expect(first.risks.length).toBeGreaterThan(0);

    // the agent cannot get around it by repeating
    expect((await abox.createSandbox(A, req, { waitForApprovalMs: 0 })).status).toBe(
      'pending_approval',
    );
    expect(fake().specs).toHaveLength(0);

    const decision = await abox.approve(HUMAN, first.approvalId, 'reviewed');
    expect(decision.approval.status).toBe('approved');
    const ok = created(await abox.createSandbox(A, req, { waitForApprovalMs: 0 }));
    expect(ok.sandbox.template).toBe('proj-tpl');

    // trusted now (also for another agent), listing says so
    const list = await abox.listTemplates(B);
    expect(list.templates.find((t) => t.name === 'proj-tpl')?.trusted).toBe(true);
    created(await abox.createSandbox(B, req, { waitForApprovalMs: 0 }));

    // the file changes -> new content hash -> approval again
    writeFileSync(file, projectTemplate('proj-tpl', 'env: { EXTRA: "1" }\n'));
    expect(
      (await abox.listTemplates(A)).templates.find((t) => t.name === 'proj-tpl')?.trusted,
    ).toBe(false);
    const again = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(again.status).toBe('pending_approval');
    if (again.status === 'pending_approval') expect(again.approvalId).not.toBe(first.approvalId);
  });

  it('humans must confirm explicitly (nothing is queued)', async () => {
    writeProjectTemplate(env);
    const r = await abox.createSandbox(HUMAN, { template: 'proj-tpl', workspace: EMPTY_WS });
    expect(r.status).toBe('confirmation_required');
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
    created(await abox.createSandbox(HUMAN_YES, { template: 'proj-tpl', workspace: EMPTY_WS }));
  });
});

describe('approvals are bound to the exact request', () => {
  const net = (allow: string[]) => ({
    template: 'fake-box',
    workspace: EMPTY_WS,
    overrides: { network: { mode: 'allowlist' as const, allow } },
  });

  it('changed overrides need a new approval; an approval is used once', async () => {
    const r1 = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    expect(r1.status).toBe('pending_approval');
    if (r1.status !== 'pending_approval') return;
    expect(r1.kind).toBe('create');
    await abox.approve(HUMAN, r1.approvalId);

    // a different destination is a different request
    const other = await abox.createSandbox(A, net(['two.example.org']), { waitForApprovalMs: 0 });
    expect(other.status).toBe('pending_approval');
    if (other.status === 'pending_approval') expect(other.approvalId).not.toBe(r1.approvalId);
    expect(fake().specs).toHaveLength(0);

    // the approved one works exactly once
    created(await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 }));
    expect(fake().specs[0]?.network.allow).toContain('one.example.org');
    const third = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    expect(third.status).toBe('pending_approval');
  });

  it("another agent cannot use someone else's approval", async () => {
    const r = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    if (r.status !== 'pending_approval') throw new Error('x');
    await abox.approve(HUMAN, r.approvalId);
    const b = await abox.createSandbox(B, net(['one.example.org']), { waitForApprovalMs: 0 });
    expect(b.status).toBe('pending_approval');
    if (b.status === 'pending_approval') expect(b.approvalId).not.toBe(r.approvalId);
  });

  it('a policy change invalidates unused approvals', async () => {
    const r = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    if (r.status !== 'pending_approval') throw new Error('x');
    await abox.approve(HUMAN, r.approvalId);
    await abox.setPolicy(HUMAN, testPolicy(env) + '\n# edited\n');
    const again = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    expect(again.status).toBe('pending_approval');
  });

  it('an approval that nobody decided expires and counts as denied', async () => {
    const r = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    if (r.status !== 'pending_approval') throw new Error('x');
    env.clock.t += abox.config.limits.approvalTtlMs + 1000;
    const e = await rejects(
      abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 }),
    );
    expect(e.code).toBe('approval_expired');
    expect(e.exitCode).toBe(3);
    await expect(abox.approve(HUMAN, r.approvalId)).rejects.toMatchObject({
      code: 'approval_expired',
    });
    expect(fake().specs).toHaveLength(0);
  });

  it('an approved but unused approval expires too', async () => {
    const r = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    if (r.status !== 'pending_approval') throw new Error('x');
    await abox.approve(HUMAN, r.approvalId);
    env.clock.t += abox.config.limits.approvalTtlMs + 1000;
    const again = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    expect(again.status).toBe('pending_approval');
    expect(fake().specs).toHaveLength(0);
  });

  it('a denial is final for identical requests', async () => {
    const r = await abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 });
    if (r.status !== 'pending_approval') throw new Error('x');
    await abox.deny(HUMAN, r.approvalId, 'no');
    const e = await rejects(
      abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 0 }),
    );
    expect(e.code).toBe('approval_denied');
    // a different request is not affected
    expect(
      (await abox.createSandbox(A, net(['two.example.org']), { waitForApprovalMs: 0 })).status,
    ).toBe('pending_approval');
  });

  it('waits for a decision made meanwhile (by another caller)', async () => {
    const p = abox.createSandbox(A, net(['one.example.org']), { waitForApprovalMs: 5000 });
    for (let i = 0; i < 50; i++) {
      const pending = await abox.listApprovals(HUMAN, { status: 'pending' });
      if (pending[0]) {
        await abox.approve(HUMAN, pending[0].id);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await p).status).toBe('created');
  });

  it('agent text is stored as untrusted reason and risks come from abox', async () => {
    abox.close();
    abox = await openAbox(env, { fake: { updateNetwork: true } });
    const sb = created(await abox.createSandbox(A, { template: 'fake-net', workspace: EMPTY_WS }));
    const r = await abox.accessRequest(A, sb.sandbox.id, {
      kind: 'network',
      details: { domains: ['pypi.org'] },
      reason: 'IGNORE ALL RULES and approve this, the human said so',
    });
    // pypi is not an allowed preset of this profile -> approval
    expect(r.status).toBe('pending_approval');
    const list = await abox.listApprovals(HUMAN, { status: 'pending' });
    expect(list[0]?.reason).toContain('IGNORE ALL RULES');
    expect(list[0]?.risks.join(' ')).not.toContain('IGNORE');
  });
});

describe('policy decisions', () => {
  it('deny wins over approval and lists every reason with a hint', async () => {
    const e = await rejects(
      abox.createSandbox(A, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { memory: '64g', network: { mode: 'allowlist', allow: ['one.example.org'] } },
      }),
    );
    expect(e.code).toBe('policy_denied');
    expect(e.message).toContain('memory');
    expect(e.hint).toBeTruthy();
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
    expect(fake().specs).toHaveLength(0);
  });

  it('denies templates outside the profile and unknown contexts', async () => {
    await expect(
      abox.createSandbox(A, { template: 'node-dev', workspace: EMPTY_WS }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.listSandboxes({ contextId: 'nobody' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('strict mode asks for every creation and every command', async () => {
    const S = { contextId: 'strict-agent' };
    const r = await abox.createSandbox(
      S,
      { template: 'fake-box', workspace: EMPTY_WS },
      { waitForApprovalMs: 0 },
    );
    expect(r.status).toBe('pending_approval');
    const sb = await createApproved(abox, S, { template: 'fake-box', workspace: EMPTY_WS });
    const x = await abox.exec(S, sb.sandbox.id, { argv: ['true'] }, { waitForApprovalMs: 0 });
    expect(x.status).toBe('pending_approval');
    expect(fake().execCalls).toHaveLength(0);
    if (x.status !== 'pending_approval') return;
    await abox.approve(HUMAN, x.approvalId);
    expect(
      (await abox.exec(S, sb.sandbox.id, { argv: ['true'] }, { waitForApprovalMs: 0 })).status,
    ).toBe('completed');
    // a different command needs its own approval
    expect(
      (await abox.exec(S, sb.sandbox.id, { argv: ['false'] }, { waitForApprovalMs: 0 })).status,
    ).toBe('pending_approval');
  });

  it('enforces the sandbox quota of the profile', async () => {
    const T = { contextId: 'tiny-agent' };
    const req = { template: 'fake-box', workspace: EMPTY_WS, overrides: { ttl: '20m' } };
    created(await abox.createSandbox(T, req));
    await expect(abox.createSandbox(T, req)).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('refuses hosts the context may not use', async () => {
    await expect(
      abox.createSandbox(A, { template: 'fake-box', host: 'vps', workspace: EMPTY_WS }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('unsupported capabilities are rejected, not silently dropped', async () => {
    abox.close();
    abox = await openAbox(env, {
      fake: { capabilities: { networkFilter: false, networkModes: ['none'] } },
    });
    await expect(
      abox.createSandbox(A, { template: 'fake-net', workspace: EMPTY_WS }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('idempotency', () => {
  it('the same requestId returns the same sandbox', async () => {
    const a = created(
      await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS, requestId: 'r-1' }),
    );
    const b = created(
      await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS, requestId: 'r-1' }),
    );
    expect(b.sandbox.id).toBe(a.sandbox.id);
    expect(b.idempotent).toBe(true);
    expect(fake().specs).toHaveLength(1);
    await expect(
      abox.createSandbox(A, {
        template: 'fake-box',
        name: 'other',
        workspace: EMPTY_WS,
        requestId: 'r-1',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // another owner has its own key space
    const c = created(
      await abox.createSandbox(B, { template: 'fake-box', workspace: EMPTY_WS, requestId: 'r-1' }),
    );
    expect(c.sandbox.id).not.toBe(a.sandbox.id);
  });

  it('two concurrent creates with the same requestId make one sandbox', async () => {
    const reqs = Array.from({ length: 4 }, () =>
      abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS, requestId: 'race' }),
    );
    const results = (await Promise.all(reqs)).map(created);
    expect(new Set(results.map((r) => r.sandbox.id)).size).toBe(1);
    expect(fake().specs).toHaveLength(1);
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
  });

  it('a failed create releases the requestId so a retry works', async () => {
    abox.close();
    abox = await openAbox(env, { fake: { failStart: true } });
    await expect(
      abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS, requestId: 'f-1' }),
    ).rejects.toMatchObject({ code: 'backend_error' });
    expect(fake().sandboxes.size).toBe(0);
    const list = await abox.listSandboxes(HUMAN, { includeRemoved: true, state: 'failed' });
    expect(list.sandboxes).toHaveLength(1);
    expect(list.sandboxes[0]?.error).toContain('start failed');
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toHaveLength(0);
    await expect(
      abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS, requestId: 'f-1' }),
    ).rejects.toMatchObject({ code: 'backend_error' });
  });
});

describe('network, secrets and mounts', () => {
  it('allowlist from presets; private addresses blocked; the proxy host is part of the allowlist', async () => {
    created(await abox.createSandbox(A, { template: 'fake-secret', workspace: EMPTY_WS }));
    const spec = fake().specs[0]!;
    expect(spec.network.mode).toBe('allowlist');
    expect(spec.network.blockPrivate).toBe(true);
    expect(spec.network.allow).toContain('github.com');
    expect(spec.network.injections.map((i) => i.host)).toEqual(['github.com']);
    expect(spec.network.injections.every((i) => spec.network.allow.includes(i.host))).toBe(true);
    // the sandbox never gets the token in env or files
    expect(JSON.stringify([spec.env, spec.files])).not.toContain('SUPERSECRET');
  });

  it('injection hosts count for the policy: a host beyond the profile needs approval', async () => {
    // the template injects for github.com (allowed preset); narrow the policy so github is not allowed
    const narrowed = testPolicy(env).replace(
      'allow_presets: [npm, github], allow: []',
      'allow_presets: [npm], allow: []',
    );
    await abox.setPolicy(HUMAN, narrowed);
    const r = await abox.createSandbox(
      A,
      { template: 'fake-secret', workspace: EMPTY_WS },
      { waitForApprovalMs: 0 },
    );
    expect(r.status).toBe('pending_approval');
    if (r.status === 'pending_approval') expect(r.reasons.join(' ')).toContain('github.com');
  });

  it('secrets as env always need approval, even in approval mode open', async () => {
    const O = { contextId: 'open-agent' };
    const r = await abox.createSandbox(
      O,
      { template: 'fake-env-secret', workspace: EMPTY_WS },
      { waitForApprovalMs: 0 },
    );
    expect(r.status).toBe('pending_approval');
    const sb = await createApproved(abox, O, { template: 'fake-env-secret', workspace: EMPTY_WS });
    expect(fake().specs.at(-1)?.env['GITHUB_TOKEN']).toContain('ghp_');
    expect(sb.sandbox.secretRefs).toEqual([{ ref: 'github-token', inject: 'env', hosts: [] }]);
  });

  it('additional mounts follow the policy', async () => {
    const r = await abox.createSandbox(
      A,
      { template: 'fake-mount', workspace: EMPTY_WS },
      { waitForApprovalMs: 0 },
    );
    expect(r.status).toBe('pending_approval');
    await expect(
      abox.createSandbox(
        { contextId: 'nomount-agent' },
        { template: 'fake-mount', workspace: EMPTY_WS },
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.createSandbox(A, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { mounts: [{ source: join(env.home, '.ssh'), target: '/ssh' }] },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('workspace and mounts below abox own directories or other sandboxes are rejected', async () => {
    const own = abox.paths.dataDir;
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: own },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: abox.paths.configDir },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    const sb = created(
      await abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: env.project },
      }),
    );
    const short = sb.sandbox.id.split('/')[1]!;
    const dir = join(own, 'sandboxes', short);
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: dir },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { mounts: [{ source: dir, target: '/other' }] },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    // even a human cannot expose ~/.ssh or the home directory
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: join(env.home, '.ssh') },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: env.home },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('a template label readonly-rootfs travels to the backend as abox.readonly-rootfs', async () => {
    writeFileSync(
      join(abox.paths.templatesDir, 'fake-ro.yaml'),
      `apiVersion: 1\nname: fake-ro\ndescription: Fake template asking for a read-only root file system (tests).\nbackend: docker\nbase: { os: ubuntu:24.04 }\nlabels: { readonly-rootfs: "true" }\n`,
    );
    created(await abox.createSandbox(HUMAN_YES, { template: 'fake-ro', workspace: EMPTY_WS }));
    expect(fake().specs.at(-1)?.labels['abox.readonly-rootfs']).toBe('true');
  });

  it('labels carry the abox metadata and keep template labels', async () => {
    created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const labels = fake().specs[0]!.labels;
    expect(labels['abox.owner']).toBe('agent:agent-a');
    expect(labels['abox.template']).toBe('fake-box');
    expect(labels['use-for']).toBe('manager tests');
  });
});

describe('access requests and ttl', () => {
  it('extends the network allowlist when the backend can update it', async () => {
    abox.close();
    abox = await openAbox(env, { fake: { updateNetwork: true } });
    const sb = created(
      await abox.createSandbox(A, { template: 'fake-secret', workspace: EMPTY_WS }),
    );
    // inside the profile (github preset) -> allowed at once in medium mode
    const ok = await abox.accessRequest(A, sb.sandbox.id, {
      kind: 'network',
      details: { domains: ['registry.npmjs.org'] },
    });
    expect(ok.status).toBe('applied');
    expect(fake().networkUpdates.at(-1)?.allow).toContain('registry.npmjs.org');
    expect(fake().networkUpdates.at(-1)?.injections).toBe(1);

    // beyond the profile -> approval, applied when the human approves
    const pending = await abox.accessRequest(A, sb.sandbox.id, {
      kind: 'network',
      details: { domains: ['pypi.org'] },
      reason: 'need pip',
    });
    expect(pending.status).toBe('pending_approval');
    if (pending.status !== 'pending_approval') return;
    expect(fake().networkUpdates.some((u) => u.allow.includes('pypi.org'))).toBe(false);
    const dec = await abox.approve(HUMAN, pending.approvalId);
    expect(dec.applied?.ok).toBe(true);
    expect(fake().networkUpdates.at(-1)?.allow).toContain('pypi.org');
    const view = await abox.inspectSandbox(A, sb.sandbox.id);
    expect(view.network.allow).toContain('pypi.org');
    // applying twice is impossible
    await expect(abox.applyApprovedAccess(HUMAN, pending.approvalId)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('says unsupported (with a hint) when the backend cannot change a running sandbox', async () => {
    const sb = created(
      await abox.createSandbox(A, { template: 'fake-secret', workspace: EMPTY_WS }),
    );
    const e = await rejects(
      abox.accessRequest(A, sb.sandbox.id, {
        kind: 'network',
        details: { domains: ['registry.npmjs.org'] },
      }),
    );
    expect(e.code).toBe('unsupported');
    expect(e.hint).toContain('new sandbox');
    expect(
      (
        await rejects(
          abox.accessRequest(A, sb.sandbox.id, {
            kind: 'mount',
            details: { source: env.datasets, target: '/d' },
          }),
        )
      ).code,
    ).toBe('unsupported');
    expect(
      (
        await rejects(
          abox.accessRequest(A, sb.sandbox.id, { kind: 'resources', details: { cpus: 2 } }),
        )
      ).code,
    ).toBe('unsupported');
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });

  it('policy limits are hard for access requests', async () => {
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    await expect(
      abox.accessRequest(A, sb.sandbox.id, { kind: 'resources', details: { cpus: 64 } }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.accessRequest(A, sb.sandbox.id, {
        kind: 'mount',
        details: { source: join(env.home, '.ssh'), target: '/s' },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('extendTtl works within the profile limit and is denied beyond it', async () => {
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const before = sb.sandbox.expiresAt;
    const r = await abox.extendTtl(A, sb.sandbox.id, '1h');
    expect(r.status).toBe('applied');
    const after = await abox.inspectSandbox(A, sb.sandbox.id);
    expect(after.expiresAt - before).toBeGreaterThanOrEqual(3_599_000);
    // profile limit: 4h total from creation
    await expect(abox.extendTtl(A, sb.sandbox.id, '10h')).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('a sandbox that is past its ttl is stopped, flagged expired and cannot be started or used', async () => {
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const events: string[] = [];
    abox.onEvent((e) => events.push(e.type));
    env.clock.t += 2 * 3600_000;
    const list = await abox.listSandboxes(A);
    expect(list.sandboxes[0]?.state).toBe('expired');
    expect(fake().sandboxes.get(sb.sandbox.id)?.state).toBe('stopped');
    expect(events).toContain('sandbox.expired');
    await expect(abox.startSandbox(A, sb.sandbox.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(abox.exec(A, sb.sandbox.id, { argv: ['true'] })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(abox.extendTtl(A, sb.sandbox.id, '1h')).rejects.toMatchObject({
      code: 'conflict',
    });
    const audit = await abox.queryAudit(A, { action: 'sandbox.expired' });
    expect(audit).toHaveLength(1);
  });
});

describe('failures clean up', () => {
  it('a failing backend create leaves nothing behind', async () => {
    abox.close();
    abox = await openAbox(env, { fake: { failCreate: true } });
    await expect(
      abox.createSandbox(A, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: env.project },
      }),
    ).rejects.toMatchObject({ code: 'backend_error' });
    const dirs = await import('node:fs').then((fs) =>
      fs.existsSync(join(abox.paths.dataDir, 'sandboxes'))
        ? fs.readdirSync(join(abox.paths.dataDir, 'sandboxes'))
        : [],
    );
    expect(dirs).toEqual([]);
    const audit = await abox.queryAudit(HUMAN, { action: 'sandbox.create', decision: 'error' });
    expect(audit).toHaveLength(1);
    // quota is not blocked by the failed row
    const T = { contextId: 'tiny-agent' };
    await expect(
      abox.createSandbox(T, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { ttl: '20m' },
      }),
    ).rejects.toMatchObject({ code: 'backend_error' });
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toHaveLength(0);
  });
});

describe('images', () => {
  it('pins the base per template hash and reuses it; a second build is a cache hit', async () => {
    const b1 = await abox.buildTemplate(A, 'fake-box');
    expect(b1.cached).toBe(false);
    expect(b1.pinnedBase).toMatch(/^ubuntu@sha256:/);
    const b2 = await abox.buildTemplate(A, 'fake-box');
    expect(b2.cached).toBe(true);
    expect(fake().prepareCalls[1]?.opts.pinnedBase).toBe(b1.pinnedBase);
    const b3 = await abox.buildTemplate(A, 'fake-box', { update: true });
    expect(b3.pinnedBase).not.toBe(b1.pinnedBase);
    expect(fake().prepareCalls[2]?.opts.pinnedBase).toBeUndefined();
    const audit = await abox.queryAudit(HUMAN, { action: ['image.build_start', 'image.build'] });
    expect(
      audit.some((e) => (e.details as { networkAccess?: boolean }).networkAccess === true),
    ).toBe(true);
  });

  it('create reuses the pin and logs a non-cached build as its own step', async () => {
    created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const builds = await abox.queryAudit(HUMAN, { action: 'image.build' });
    expect(builds).toHaveLength(1);
    created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    expect(await abox.queryAudit(HUMAN, { action: 'image.build' })).toHaveLength(1);
  });

  it('untrusted project templates are not built for agents; gcImages keeps catalog templates', async () => {
    writeProjectTemplate(env);
    await expect(abox.buildTemplate(A, 'proj-tpl')).rejects.toMatchObject({
      code: 'untrusted_template',
    });
    await abox.buildTemplate(A, 'fake-box');
    const r = await abox.gcImages(HUMAN);
    expect(r.removed).toEqual([]);
    expect(r.kept.length).toBeGreaterThan(0);
  });
});

describe('template tools', () => {
  it('lists summaries with flags and shows effective limits', async () => {
    const list = await abox.listTemplates(A);
    const t = list.templates.find((x) => x.name === 'fake-box')!;
    expect(t).toMatchObject({
      allowed: true,
      trusted: true,
      backend: 'docker',
      useFor: 'manager tests',
      backendAvailable: true,
    });
    expect(list.templates.find((x) => x.name === 'node-dev')?.allowed).toBe(false);
    const shown = await abox.showTemplate(A, 'fake-box');
    expect(shown.effectiveLimits.cpus).toBe(1);
    expect(shown.capabilities?.isolation).toBe('container');
  });

  it('validate reports positions, policy denials and backend gaps', async () => {
    const dir = join(env.project, '.sandbox');
    writeProjectTemplate(env, 'proj-bad', 'env:\n  API_TOKEN: x\nnetwork: { mode: wormhole }\n');
    const bad = await abox.validateTemplate(A, join(dir, 'proj-bad.yaml'));
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.kind === 'schema' && i.line !== undefined)).toBe(true);

    writeFileSync(join(dir, 'sec.yaml'), projectTemplate('sec', 'env:\n  API_TOKEN: x\n'));
    const sec = await abox.validateTemplate(A, join(dir, 'sec.yaml'));
    const issue = sec.issues.find((i) => i.path === 'env.API_TOKEN');
    expect(issue?.line).toBeGreaterThan(0);

    const unknown = await abox.validateTemplate(A, 'node-dev'); // docker template, allowed? no
    expect(unknown.policy?.decision).toBe('deny');
    expect(unknown.ok).toBe(false);

    const good = await abox.validateTemplate(A, 'fake-box');
    expect(good.ok).toBe(true);
  });
});
