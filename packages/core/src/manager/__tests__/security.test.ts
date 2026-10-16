import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import {
  A,
  B,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  fakeOf,
  makeEnv,
  openAbox,
  testPolicy,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;
beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, { fake: { capabilities: { snapshots: true }, updateNetwork: true } });
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

const SECRET = 'ghp_SUPERSECRETTOKEN1234567890abcdef';

describe('agents cannot see or touch each other', () => {
  it('every operation on a foreign sandbox is not_found (never policy_denied: no existence leak)', async () => {
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const id = sb.sandbox.id;
    await abox.writeFile(A, id, '/workspace/x.txt', 'private');
    const ops: Array<[string, () => Promise<unknown>]> = [
      ['inspect', () => abox.inspectSandbox(B, id)],
      ['exec', () => abox.exec(B, id, { argv: ['id'] })],
      ['remove', () => abox.removeSandbox(B, id)],
      ['stop', () => abox.stopSandbox(B, id)],
      ['start', () => abox.startSandbox(B, id)],
      ['export', () => abox.exportSandbox(B, id, { format: 'diff' })],
      ['readFile', () => abox.readFile(B, id, '/workspace/x.txt')],
      ['writeFile', () => abox.writeFile(B, id, '/workspace/y.txt', 'evil')],
      ['listDir', () => abox.listDir(B, id, '/workspace')],
      ['snapshot', () => abox.snapshot(B, id, 'snap')],
      ['restore', () => abox.restore(B, id, 'snap')],
      ['extendTtl', () => abox.extendTtl(B, id, '1h')],
      ['access', () => abox.accessRequest(B, id, { kind: 'ttl', details: { ttl: '1h' } })],
      ['startProcess', () => abox.startProcess(B, id, { argv: ['sleep', '1'] })],
      ['listProcesses', () => abox.listProcesses(B, id)],
    ];
    for (const [name, op] of ops) {
      await expect(op(), name).rejects.toMatchObject({ code: 'not_found' });
    }
    // a nonexistent id gives the identical answer
    await expect(abox.inspectSandbox(B, 'local/deadbeef')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(fakeOf(env).execCalls).toHaveLength(0);
    // nothing changed
    expect(fakeOf(env).sandboxes.has(id)).toBe(true);
    expect((await abox.readFile(A, id, '/workspace/x.txt')).content).toBe('private');
  });

  it('lists only own sandboxes; humans see all and orphans', async () => {
    const a = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const b = created(await abox.createSandbox(B, { template: 'fake-box', workspace: EMPTY_WS }));
    expect((await abox.listSandboxes(A)).sandboxes.map((s) => s.id)).toEqual([a.sandbox.id]);
    expect((await abox.listSandboxes(B)).sandboxes.map((s) => s.id)).toEqual([b.sandbox.id]);
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toHaveLength(2);
    // an agent cannot filter its way to somebody else's sandboxes
    expect(
      (await abox.listSandboxes(A, { owner: 'agent:agent-b' })).sandboxes.map((s) => s.id),
    ).toEqual([a.sandbox.id]);
  });

  it('foreign processes, logs and approvals are invisible too', async () => {
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const x = await abox.exec(A, sb.sandbox.id, { argv: ['true'] });
    if (x.status !== 'completed') throw new Error('x');
    await expect(abox.readLog(B, x.logRef)).rejects.toMatchObject({ code: 'not_found' });
    await expect(abox.processLogs(B, 'p00000000')).rejects.toMatchObject({ code: 'not_found' });
    const p = await abox.createSandbox(
      A,
      {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { network: { mode: 'allowlist', allow: ['x.example.org'] } },
      },
      { waitForApprovalMs: 0 },
    );
    if (p.status !== 'pending_approval') throw new Error('x');
    expect(await abox.listApprovals(B)).toEqual([]);
    expect(await abox.listApprovals(A)).toHaveLength(1);
    await expect(abox.getApproval(B, p.approvalId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('agents only see their own audit trail', async () => {
    const a = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    created(await abox.createSandbox(B, { template: 'fake-box', workspace: EMPTY_WS }));
    await expect(abox.inspectSandbox(B, a.sandbox.id)).rejects.toThrow();
    const mine = await abox.queryAudit(A, { limit: 500 });
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) {
      const ok = e.actor === 'agent:agent-a' || e.sandboxId === a.sandbox.id;
      expect(ok, `${e.action} by ${e.actor}`).toBe(true);
    }
    // B's probe of A's sandbox is audited, but not attached to A's sandbox
    const probes = await abox.queryAudit(HUMAN, { action: 'sandbox.lookup' });
    expect(probes[0]?.actor).toBe('agent:agent-b');
    expect(probes[0]?.sandboxId).toBeNull();
    expect(mine.some((e) => e.action === 'sandbox.lookup')).toBe(false);
    expect(await abox.queryAudit(B, { sandboxId: a.sandbox.id })).toEqual([]);
  });
});

describe('agents cannot change rules', () => {
  it('approve, deny and expire are human only', async () => {
    const p = await abox.createSandbox(
      A,
      {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { network: { mode: 'allowlist', allow: ['x.example.org'] } },
      },
      { waitForApprovalMs: 0 },
    );
    if (p.status !== 'pending_approval') throw new Error('x');
    await expect(abox.approve(A, p.approvalId)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.approve(B, p.approvalId)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.deny(A, p.approvalId)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.expireApprovals(A)).rejects.toMatchObject({ code: 'policy_denied' });
    expect((await abox.getApproval(HUMAN, p.approvalId)).status).toBe('pending');
    const denied = await abox.queryAudit(HUMAN, { action: 'approval.approve_denied' });
    expect(denied.map((e) => e.actor).sort()).toEqual(['agent:agent-a', 'agent:agent-b']);
  });

  it('setPolicy by an agent is refused and audited as policy_change_denied; the policy is unchanged', async () => {
    const hash = abox.policyHash;
    const evil = testPolicy(env).replace('mounts: { roots', 'mounts: { roots');
    await expect(abox.setPolicy(A, evil + '\n# widen\n')).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(abox.policyHash).toBe(hash);
    const entries = await abox.queryAudit(HUMAN, { action: 'policy_change_denied' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'agent:agent-a', decision: 'deny' });
    // the agent sees its own attempt in its audit view
    expect((await abox.queryAudit(A, { action: 'policy_change_denied' })).length).toBe(1);
    // the human can
    const ok = await abox.setPolicy(HUMAN, evil + '\n# fine\n');
    expect(ok.changed).toBe(true);
  });

  it('operator functions are human only: tokens, doctor, reconcile, gc, audit export/verify, images', async () => {
    await expect(abox.createAgentToken(A, 'agent-a', 'x')).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(abox.listAgentTokens(A)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.doctor(A)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.reconcile(A, { apply: true })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(abox.gc(A)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.verifyAudit(A)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.exportAudit(A, {}, { write: () => undefined })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(abox.gcImages(A)).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('showPolicy gives an agent only its own profile', async () => {
    const mine = await abox.showPolicy(A);
    expect(mine.contextId).toBe('agent-a');
    expect(mine.profiles).toBeUndefined();
    expect(mine.contexts).toBeUndefined();
    expect(JSON.stringify(mine)).not.toContain('strict-agent');
    const human = await abox.showPolicy(HUMAN);
    expect(Object.keys(human.contexts ?? {})).toContain('agent-b');
  });

  it('the human context never gets a token and a token cannot map to unknown contexts', async () => {
    await expect(abox.createAgentToken(HUMAN, 'human', 'x')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(abox.createAgentToken(HUMAN, 'ghost', 'x')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('secrets never leak', () => {
  it('not into registry rows, audit entries, exec output, logs or file reads', async () => {
    abox.close();
    env.fakes.length = 0;
    abox = await openAbox(env, {
      fake: {
        execHandler: () => ({
          stdout: `token is ${SECRET} and auth is Basic ${Buffer.from(`x-access-token:${SECRET}`).toString('base64')}\n`,
          stderr: `err ${SECRET}`,
        }),
      },
    });
    const O = { contextId: 'open-agent' };
    const sb = created(
      await abox.createSandbox(O, { template: 'fake-secret', workspace: EMPTY_WS }),
    );
    const id = sb.sandbox.id;
    const x = await abox.exec(O, id, {
      command: `curl -H "Authorization: Bearer ${SECRET}" https://github.com && echo --token=abc12345`,
    });
    if (x.status !== 'completed') throw new Error('x');
    expect(x.stdout).not.toContain(SECRET);
    expect(x.stdout).toContain('***');
    expect(x.stderr).not.toContain(SECRET);
    expect(x.stdout).not.toContain(Buffer.from(`x-access-token:${SECRET}`).toString('base64'));
    const log = await abox.readLog(O, x.logRef);
    expect(log.content).not.toContain(SECRET);
    await fakeOf(env).writeFile(id, '/workspace/leak.txt', Buffer.from(`leak ${SECRET}`));
    expect((await abox.readFile(O, id, '/workspace/leak.txt')).content).not.toContain(SECRET);

    const dump = JSON.stringify([
      env.fakes.length,
      await abox.queryAudit(HUMAN, { limit: 5000 }),
      await abox.listSandboxes(HUMAN),
      await abox.inspectSandbox(HUMAN, id),
      await abox.listApprovals(HUMAN),
    ]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('SUPERSECRETTOKEN');
    // and the sqlite file itself
    const rows = JSON.stringify([
      (
        abox as unknown as { I: { state: { db: { prepare(s: string): { all(): unknown[] } } } } }
      ).I.state.db
        .prepare('SELECT * FROM sandboxes')
        .all(),
      (
        abox as unknown as { I: { state: { db: { prepare(s: string): { all(): unknown[] } } } } }
      ).I.state.db
        .prepare('SELECT * FROM audit_log')
        .all(),
      (
        abox as unknown as { I: { state: { db: { prepare(s: string): { all(): unknown[] } } } } }
      ).I.state.db
        .prepare('SELECT * FROM approvals')
        .all(),
    ]);
    expect(rows).not.toContain('SUPERSECRETTOKEN');
    // the command was recorded redacted
    const execAudit = (await abox.queryAudit(HUMAN, { action: 'sandbox.exec' }))[0]!;
    expect(JSON.stringify(execAudit.details)).not.toContain('abc12345');
  });

  it('env-injected secrets reach the sandbox but never the stored records', async () => {
    abox.close();
    abox = await openAbox(env, {});
    const O = { contextId: 'open-agent' };
    const r = await abox.createSandbox(
      O,
      { template: 'fake-env-secret', workspace: EMPTY_WS },
      { waitForApprovalMs: 0 },
    );
    if (r.status !== 'pending_approval') throw new Error('x');
    await abox.approve(HUMAN, r.approvalId);
    const sb = created(
      await abox.createSandbox(
        O,
        { template: 'fake-env-secret', workspace: EMPTY_WS },
        { waitForApprovalMs: 0 },
      ),
    );
    expect(fakeOf(env).specs.at(-1)?.env['GITHUB_TOKEN']).toBe(SECRET);
    expect(JSON.stringify(await abox.inspectSandbox(HUMAN, sb.sandbox.id))).not.toContain(SECRET);
    expect(JSON.stringify(await abox.queryAudit(HUMAN, { limit: 5000 }))).not.toContain(SECRET);
  });
});

describe('input hardening', () => {
  it('rejects malformed requests with invalid_input and field paths', async () => {
    await expect(
      abox.createSandbox(A, { template: 'fake-box', bogus: 1 } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      abox.exec(HUMAN_YES, 'local/00000000', { argv: [], command: 'x' } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    await expect(
      abox.exec(A, sb.sandbox.id, { argv: ['x'], env: { ABOX_X: '1' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      abox.writeFile(A, sb.sandbox.id, '/x', 'y', { mode: 0o4755 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      abox.exportSandbox(A, sb.sandbox.id, { format: 'files', outDir: '/etc/evil' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.exportSandbox(A, sb.sandbox.id, { format: 'branch', branchName: 'main' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.exportSandbox(A, sb.sandbox.id, { format: 'branch', force: true }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('agents cannot read template files outside their workspace roots', async () => {
    await expect(abox.validateTemplate(A, '/etc/passwd.yaml')).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(abox.listTemplates(A, { projectDir: '/etc' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });
});
