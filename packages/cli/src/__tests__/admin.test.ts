import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAbox } from '@abox/runtime';
import {
  makeEnv,
  run,
  sleep,
  writeConfig,
  writePolicy,
  writeScript,
  type TestEnv,
} from './harness.js';

let t: TestEnv;

/** Only the process backend on `local`: no Docker involved, so doctor/gc are deterministic. */
function processOnly(env: TestEnv): void {
  env.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
}

function agentPolicy(env: TestEnv): string {
  return `version: 1
profiles:
  agent:
    approval: medium
    templates: [host-shell]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['${env.home}'], modes: [copy, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
  strict:
    extends: agent
    approval: strict
contexts:
  tester: { profile: agent }
  striker: { profile: strict }
`;
}

beforeEach(() => {
  t = makeEnv();
  processOnly(t);
  writePolicy(t, agentPolicy(t));
});
afterEach(() => t.cleanup());

async function asAgent<T>(
  ctx: string,
  fn: (rt: Awaited<ReturnType<typeof openAbox>>) => Promise<T>,
): Promise<T> {
  const rt = await openAbox({ env: t.env, contextId: ctx });
  try {
    return await fn(rt);
  } finally {
    await rt.close();
  }
}

const createReq = (requestId: string) => ({
  template: 'host-shell',
  requestId,
  workspace: { mode: 'copy' as const, path: t.project },
});

describe('approvals without a GUI', () => {
  it('approves an agent request, then the identical retry succeeds', async () => {
    const first = await asAgent('tester', (rt) =>
      rt.abox.createSandbox(rt.caller, createReq('r-approve'), { waitForApprovalMs: 0 }),
    );
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;

    const ls = await run(t, ['approvals', 'ls', '--json']);
    expect(ls.code).toBe(0);
    const entry = ls.json.data.approvals.find((a: { id: string }) => a.id === first.approvalId);
    expect(entry).toMatchObject({ status: 'pending', requester: 'agent:tester' });
    const human = await run(t, ['approvals', 'ls']);
    expect(human.stdout).toContain(first.approvalId);
    expect(human.stdout).toContain('agent:tester');
    expect((await run(t, ['approvals', 'ls', '-q'])).stdout.trim().split('\n')).toContain(
      first.approvalId,
    );

    const show = await run(t, ['approvals', 'show', first.approvalId]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('requested by');
    expect(show.stdout).toContain('agent:tester');
    expect(show.stdout).toContain('Exact request that would be approved');
    expect(show.stdout).toContain('host-shell');
    expect(show.stdout).toContain('Risks (computed by abox)');

    const approve = await run(t, [
      'approvals',
      'approve',
      first.approvalId,
      '--note',
      'looks fine',
      '--yes',
      '--json',
    ]);
    expect(approve.code, approve.stderr).toBe(0);
    expect(approve.json.data.approval).toMatchObject({
      status: 'approved',
      decidedBy: 'human',
      decisionNote: 'looks fine',
    });

    const retry = await asAgent('tester', (rt) =>
      rt.abox.createSandbox(rt.caller, createReq('r-approve'), { waitForApprovalMs: 0 }),
    );
    expect(retry.status).toBe('created');
    // the approval is used up: nothing is pending any more
    const left = await run(t, ['approvals', 'ls', '--json']);
    expect(left.json.data.approvals).toEqual([]);
    const all = await run(t, ['approvals', 'ls', '--all', '--json']);
    expect(all.json.data.approvals.length).toBeGreaterThan(0);
    if (retry.status === 'created') {
      await run(t, ['rm', '--force', retry.sandbox.id]);
    }
  });

  it('deny makes the retry fail with exit-3 semantics (approval_denied)', async () => {
    const first = await asAgent('tester', (rt) =>
      rt.abox.createSandbox(rt.caller, createReq('r-deny'), { waitForApprovalMs: 0 }),
    );
    if (first.status !== 'pending_approval') throw new Error('expected a pending approval');
    const deny = await run(t, [
      'approvals',
      'deny',
      first.approvalId,
      '--note',
      'no way',
      '--json',
    ]);
    expect(deny.code, deny.stderr).toBe(0);
    expect(deny.json.data.approval.status).toBe('denied');
    await expect(
      asAgent('tester', (rt) =>
        rt.abox.createSandbox(rt.caller, createReq('r-deny'), { waitForApprovalMs: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'approval_denied', exitCode: 3 });
    const again = await run(t, ['approvals', 'deny', first.approvalId, '--json']);
    expect(again.code).not.toBe(0);
  });

  it('an undecided approval expires and counts as denied', async () => {
    writeConfig(t, 'limits:\n  approvalTtlMs: 1000\n  approvalWaitMs: 0\n');
    const first = await asAgent('tester', (rt) =>
      rt.abox.createSandbox(rt.caller, createReq('r-expire'), { waitForApprovalMs: 0 }),
    );
    if (first.status !== 'pending_approval') throw new Error('expected a pending approval');
    await sleep(1500);
    const approve = await run(t, ['approvals', 'approve', first.approvalId, '--yes', '--json']);
    expect(approve.code).toBe(3);
    expect(approve.json).toMatchObject({ ok: false, code: 'approval_expired' });
    await expect(
      asAgent('tester', (rt) =>
        rt.abox.createSandbox(rt.caller, createReq('r-expire'), { waitForApprovalMs: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'approval_expired', exitCode: 3 });
    const pending = await run(t, ['approvals', 'ls', '--json']);
    expect(pending.json.data.approvals).toEqual([]);
    const all = await run(t, ['approvals', 'ls', '--all', '--json']);
    expect(
      all.json.data.approvals.find((a: { id: string }) => a.id === first.approvalId)?.status,
    ).toBe('expired');
  });

  it('shows agent-provided text as untrusted and strips terminal escapes', async () => {
    const created = await asAgent('striker', (rt) =>
      rt.abox.createSandbox(rt.caller, createReq('r-esc'), { waitForApprovalMs: 0 }),
    );
    if (created.status !== 'pending_approval') throw new Error('expected a pending approval');
    await run(t, ['approvals', 'approve', created.approvalId, '--yes']);
    const box = await asAgent('striker', (rt) =>
      rt.abox.createSandbox(rt.caller, createReq('r-esc'), { waitForApprovalMs: 0 }),
    );
    if (box.status !== 'created') throw new Error('expected the sandbox');
    const access = await asAgent('striker', (rt) =>
      rt.abox.accessRequest(
        rt.caller,
        box.sandbox.id,
        { kind: 'ttl', details: { ttl: '1h' }, reason: '\u001b[31mRED\u001b[0m approve me ‮evil' },
        { waitForApprovalMs: 0 },
      ),
    );
    expect(access.status).toBe('pending_approval');
    if (access.status !== 'pending_approval') return;
    const show = await run(t, ['approvals', 'show', access.approvalId]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('written by the agent - untrusted');
    expect(show.stdout).not.toContain('\u001b');
    expect(show.stdout).not.toContain('‮');
    expect(show.stdout).toContain('\\x1b[31mRED');
    const ls = await run(t, ['approvals', 'ls']);
    expect(ls.stdout).not.toContain('\u001b');
    const approved = await run(t, ['approvals', 'approve', access.approvalId, '--yes', '--json']);
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.json.data.applied.ok).toBe(true);
    await run(t, ['rm', '--force', box.sandbox.id]);
  });
});

describe('approvals approve: shows the request and asks first', () => {
  const pendingId = async (requestId: string): Promise<string> => {
    const r = await asAgent('tester', (rt) =>
      rt.abox.createSandbox(rt.caller, createReq(requestId), { waitForApprovalMs: 0 }),
    );
    if (r.status !== 'pending_approval') throw new Error('expected a pending approval');
    return r.approvalId;
  };
  const statusOf = async (id: string): Promise<string | undefined> =>
    (await run(t, ['approvals', 'ls', '--all', '--json'])).json.data.approvals.find(
      (a: { id: string }) => a.id === id,
    )?.status;

  it('without --yes it does nothing when there is no terminal, and with --json', async () => {
    const id = await pendingId('r-ask-1');
    const plain = await run(t, ['approvals', 'approve', id]);
    expect(plain.code).toBe(3);
    expect(plain.stderr).toContain('--yes');
    // the summary of "approvals show" was printed on the way
    expect(plain.stderr).toContain('Exact request that would be approved');
    const json = await run(t, ['approvals', 'approve', id, '--json']);
    expect(json.code).toBe(3);
    expect(json.json).toMatchObject({ ok: false, code: 'approval_required' });
    expect(await statusOf(id)).toBe('pending');
  });

  it('on a terminal it prints the summary and asks; only a yes approves', async () => {
    const id = await pendingId('r-ask-2');
    const no = await run(t, ['approvals', 'approve', id], { tty: true, stdin: 'n\n' });
    expect(no.code).toBe(3);
    expect(no.stderr).toContain('Exact request that would be approved');
    expect(no.stderr).toContain('Risks (computed by abox)');
    expect(no.stderr).toContain('Why approval is needed');
    expect(no.stderr).toContain(`Approve ${id}? [y/N]`);
    expect(await statusOf(id)).toBe('pending');
    const yes = await run(t, ['approvals', 'approve', id], { tty: true, stdin: 'y\n' });
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stdout).toContain('approved');
    expect(await statusOf(id)).toBe('approved');
  });

  it('--yes approves and still prints the summary', async () => {
    const a = await pendingId('r-ask-3');
    const text = await run(t, ['approvals', 'approve', a, '--yes']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stderr).toContain('Exact request that would be approved');
  });

  it('--yes --json approves silently', async () => {
    const b = await pendingId('r-ask-4');
    const json = await run(t, ['approvals', 'approve', b, '--yes', '--json']);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stderr).toBe('');
    expect(json.json.data.approval.status).toBe('approved');
  });

  it('deny stays a plain one-step command', async () => {
    const id = await pendingId('r-ask-5');
    const r = await run(t, ['approvals', 'deny', id]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(await statusOf(id)).toBe('denied');
  });

  it('a decided or unknown approval is reported as before', async () => {
    const id = await pendingId('r-ask-6');
    await run(t, ['approvals', 'deny', id]);
    const again = await run(t, ['approvals', 'approve', id, '--yes', '--json']);
    expect(again.code).not.toBe(0);
    const unknown = await run(t, ['approvals', 'approve', 'nope', '--yes', '--json']);
    expect(unknown.json).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('audit', () => {
  it('lists, filters and exports the audit log and verifies the chain', async () => {
    const c = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
    const id = c.json.data.sandbox.id as string;
    await run(t, ['exec', id, '--', 'true']);
    await run(t, ['rm', '--force', id]);

    const all = await run(t, ['audit', '--json']);
    expect(all.code).toBe(0);
    const actions = all.json.data.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['sandbox.create', 'sandbox.exec', 'sandbox.remove']),
    );
    const seqs = all.json.data.entries.map((e: { seq: number }) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // oldest first

    const bySandbox = await run(t, ['audit', '--sandbox', id, '--json']);
    expect(bySandbox.json.data.entries.length).toBeGreaterThan(1);
    expect(
      bySandbox.json.data.entries.every((e: { sandboxId: string | null }) => e.sandboxId === id),
    ).toBe(true);
    const byAction = await run(t, ['audit', '--action', 'sandbox.exec', '--json']);
    expect(
      byAction.json.data.entries.every((e: { action: string }) => e.action === 'sandbox.exec'),
    ).toBe(true);
    const limited = await run(t, ['audit', '--limit', '2', '--json']);
    expect(limited.json.data.entries).toHaveLength(2);
    expect(limited.json.data.entries[1].seq).toBe(seqs[seqs.length - 1]); // the newest ones
    const since = await run(t, ['audit', '--since', '1h', '--json']);
    expect(since.json.data.entries.length).toBeGreaterThan(0);
    const future = await run(t, ['audit', '--since', '2999-01-01T00:00:00Z', '--json']);
    expect(future.json.data.entries).toEqual([]);

    const jsonl = await run(t, ['audit', '--jsonl', '--action', 'sandbox.create']);
    const lines = jsonl.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ action: 'sandbox.create' });

    const table = await run(t, ['audit', '--limit', '3']);
    expect(table.stdout).toMatch(/^SEQ\s+TIME\s+ACTOR\s+ACTION/);

    const verify = await run(t, ['audit', 'verify', '--json']);
    expect(verify.code).toBe(0);
    expect(verify.json.data.ok).toBe(true);
  });

  it('detects a tampered log (exit 1, check_failed)', async () => {
    await run(t, ['template', 'ls']);
    const created = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
    expect(created.code).toBe(0);
    const db = new DatabaseSync(join(t.aboxHome, 'data', 'state.db'));
    for (const row of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log'")
      .all()) {
      db.exec(`DROP TRIGGER ${(row as { name: string }).name}`);
    }
    db.exec(
      "UPDATE audit_log SET actor = 'mallory' WHERE seq = (SELECT MIN(seq) FROM audit_log WHERE action = 'sandbox.create')",
    );
    db.close();
    const verify = await run(t, ['audit', 'verify', '--json']);
    expect(verify.code).toBe(1);
    expect(verify.json).toMatchObject({ ok: false, code: 'check_failed' });
    const doctor = await run(t, ['doctor', '--json']);
    expect(doctor.code).toBe(1);
    await run(t, ['rm', '--force', created.json.data.sandbox.id]);
  });
});

describe('doctor, reconcile and gc', () => {
  it('doctor is clean when everything agrees', async () => {
    const r = await run(t, ['doctor', '--json']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.json.data.ok).toBe(true);
    expect(r.json.data.backends[0]).toMatchObject({ backend: 'process', available: true });
    const human = await run(t, ['doctor']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('no problems found');
  });

  it('doctor separates advisory notes from warnings: a working process backend is ok with info notes', async () => {
    const r = await run(t, ['doctor', '--json']);
    const check = r.json.data.checks.find((c: { id: string }) => c.id === 'backend.local.process');
    // `level` stays for older readers, `severity` and `notes` are new
    expect(check).toMatchObject({ level: 'ok', severity: 'ok' });
    expect(check.notes.length).toBeGreaterThan(0);
    expect(check.notes.every((n: { severity: string }) => n.severity === 'info')).toBe(true);
    expect(check.detail).toContain('isolation level "none"');
    expect(r.json.data.summary).toMatchObject({ warning: 0, error: 0 });

    const human = await run(t, ['doctor']);
    expect(human.stdout).toMatch(/^✓ backend process on local: ok$/m);
    expect(human.stdout).toMatch(/^ {4}i isolation level "none"/m);
    expect(human.stdout).not.toContain('[warn]');
    expect(human.stdout).toMatch(/no problems found \(\d+ ok\)/);
    expect(human.stdout).not.toContain('data directory:');
    const verbose = await run(t, ['doctor', '--verbose']);
    expect(verbose.code).toBe(0);
    expect(verbose.stdout).toContain('· data directory:');
  });

  it('reports a registered sandbox that vanished from the backend and repairs it', async () => {
    const c = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
    const id = c.json.data.sandbox.id as string;
    const short = id.split('/')[1]!;
    rmSync(join(t.aboxHome, 'data', 'process', 'sandboxes', short), {
      recursive: true,
      force: true,
    });

    const doctor = await run(t, ['doctor', '--json']);
    expect(doctor.code).toBe(1);
    expect(doctor.json).toMatchObject({ ok: false, code: 'check_failed' });
    expect(doctor.json.details.report.reconcile.ghosts.map((g: { id: string }) => g.id)).toContain(
      id,
    );
    const human = await run(t, ['doctor']);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('reconcile --apply');

    const dry = await run(t, ['reconcile', '--json']);
    expect(dry.code).toBe(0);
    expect(dry.json.data.ghosts.map((g: { id: string }) => g.id)).toContain(id);
    expect(dry.json.data.applied.markedStale.length + dry.json.data.applied.removed.length).toBe(0);

    const fix = await run(t, ['reconcile', '--apply', '--json']);
    expect(fix.code).toBe(0);
    const after = await run(t, ['doctor', '--json']);
    expect(after.code, JSON.stringify(after.json)).toBe(0);
  });

  it('gc --dry-run reports without removing and gc removes expired sandboxes', async () => {
    const c = await run(t, [
      'create',
      'host-shell',
      '--workspace',
      '.',
      '--ttl',
      '2s',
      '--yes',
      '--json',
    ]);
    expect(c.code, c.stderr).toBe(0);
    const id = c.json.data.sandbox.id as string;
    await sleep(2600);
    const dry = await run(t, ['gc', '--dry-run', '--json']);
    expect(dry.code).toBe(0);
    expect(dry.json.data).toMatchObject({ dryRun: true });
    expect(dry.json.data.sandboxes).toContain(id);
    expect((await run(t, ['inspect', id, '--json'])).json.data.state).not.toBe('removed');
    const real = await run(t, ['gc', '--json']);
    expect(real.code, real.stderr).toBe(0);
    expect(real.json.data.sandboxes).toContain(id);
    expect(
      (await run(t, ['ls', '--json'])).json.data.sandboxes.map((s: { id: string }) => s.id),
    ).not.toContain(id);
    const human = await run(t, ['gc']);
    expect(human.stdout).toContain('removed:');
    expect((await run(t, ['gc', '--dry-run'])).stdout).toContain('would remove');
  });
});

describe('tokens', () => {
  it('creates a token once, lists it without the value and revokes it', async () => {
    const c = await run(t, ['token', 'create', 'tester', '--label', 'orca', '--json']);
    expect(c.code, c.stderr).toBe(0);
    const token = c.json.data.token as string;
    expect(token.length).toBeGreaterThan(20);
    const q = await run(t, ['token', 'create', 'tester', '-q']);
    expect(q.stdout.trim().length).toBeGreaterThan(20);
    expect(q.stderr).toBe('');

    const human = await run(t, ['token', 'create', 'striker']);
    expect(human.stderr).toContain('shown once');
    expect(human.stdout.trim().length).toBeGreaterThan(20);

    const ls = await run(t, ['token', 'ls', '--json']);
    expect(JSON.stringify(ls.json)).not.toContain(token);
    const mine = ls.json.data.tokens.find((x: { id: string }) => x.id === c.json.data.id);
    expect(mine).toMatchObject({ contextId: 'tester', label: 'orca', revokedAt: null });
    expect((await run(t, ['token', 'ls'])).stdout).toContain('active');

    const rv = await asAgent('tester', async (rt) => rt.abox.verifyAgentToken(token));
    expect(rv).toBe('tester');
    const revoke = await run(t, ['token', 'revoke', c.json.data.id, '--json']);
    expect(revoke.json.data.revoked).toBe(true);
    expect(await asAgent('tester', async (rt) => rt.abox.verifyAgentToken(token))).toBeUndefined();
    expect((await run(t, ['token', 'ls'])).stdout).toContain('revoked');
  });

  it('refuses tokens for unknown contexts and for the human', async () => {
    const unknown = await run(t, ['token', 'create', 'ghost', '--json']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.json.ok).toBe(false);
    const human = await run(t, ['token', 'create', 'human', '--json']);
    expect(human.code).not.toBe(0);
  });
});

describe('secrets', () => {
  it('stores from stdin, lists and removes; the value is never echoed or an argument', async () => {
    const set = await run(t, ['secret', 'set', 'github-token'], { stdin: 'ghp_SUPERSECRET123\n' });
    expect(set.code, set.stderr).toBe(0);
    expect(await t.secrets.get('github-token')).toBe('ghp_SUPERSECRET123');
    expect(set.stdout + set.stderr).not.toContain('SUPERSECRET');

    const tty = await run(t, ['secret', 'set', 'other-token'], {
      stdin: 'typed-value\n',
      tty: true,
    });
    expect(tty.code, tty.stderr).toBe(0);
    expect(await t.secrets.get('other-token')).toBe('typed-value');
    expect(tty.stdout + tty.stderr).not.toContain('typed-value');
    expect(tty.stderr).toContain('input hidden');

    const ls = await run(t, ['secret', 'ls', '--json']);
    expect(ls.json.data.refs).toEqual(['github-token', 'other-token']);
    expect(JSON.stringify(ls.json)).not.toContain('SUPERSECRET');

    const asArg = await run(t, ['secret', 'set', 'x-token', 'value-as-argument', '--json']);
    expect(asArg.code).toBe(2);
    expect(await t.secrets.get('x-token')).toBeUndefined();

    const bad = await run(t, ['secret', 'set', '../etc', '--json'], { stdin: 'v\n' });
    expect(bad.code).toBe(2);
    const empty = await run(t, ['secret', 'set', 'empty-one', '--json'], { stdin: '\n' });
    expect(empty.code).toBe(2);

    const rm = await run(t, ['secret', 'rm', 'github-token']);
    expect(rm.code).toBe(0);
    expect(await t.secrets.get('github-token')).toBeUndefined();
  });
});

describe('init', () => {
  it('creates .sandbox with a valid, untrusted example template and prints agent config', async () => {
    const r = await run(t, ['init', '--agent', 'claude-code', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const file = join(t.project, '.sandbox', 'proj-dev.yaml');
    expect(r.json.data).toMatchObject({
      file,
      template: 'proj-dev',
      created: true,
      agent: 'claude-code',
    });
    expect(existsSync(file)).toBe(true);
    expect(r.json.data.mcpCommand).toBe(
      'claude mcp add abox -- abox mcp serve --agent claude-code',
    );
    expect(r.json.data.mcp.mcpServers.abox.args).toEqual([
      'mcp',
      'serve',
      '--agent',
      'claude-code',
    ]);
    expect(r.json.data.rules).toContain('abox sandboxes'); // AGENTS.md.snippet of agent-kit
    expect(r.json.data.contextDefined).toBe(false);

    const valid = await run(t, ['template', 'validate', 'proj-dev', '--json']);
    expect(valid.code, valid.stderr).toBe(0);
    const list = await run(t, ['template', 'ls', '--json']);
    const entry = list.json.data.templates.find((x: { name: string }) => x.name === 'proj-dev');
    expect(entry).toMatchObject({ trusted: false, source: { kind: 'project' } });

    const again = await run(t, ['init']);
    expect(again.stderr).toContain('not overwritten');
    writeFileSync(file, 'custom');
    await run(t, ['init']);
    expect(readFileSync(file, 'utf8')).toBe('custom');
    await run(t, ['init', '--force']);
    expect(readFileSync(file, 'utf8')).toContain('apiVersion: 1');

    // creating from it asks for approval of the content first
    rmSync(join(t.aboxHome, 'config', 'hosts.yaml'));
    const create = await run(t, ['create', 'proj-dev', '--workspace', '.', '--json'], {
      env: { DOCKER_HOST: 'unix:///nonexistent/abox-test.sock' }, // the decision comes before any engine call
    });
    expect(create.code).toBe(3);
    expect(create.json.code).toBe('approval_required');
  });

  it('prints snippets for every agent', async () => {
    for (const agent of ['claude-code', 'codex', 'cursor', 'orca']) {
      const r = await run(t, ['init', '--agent', agent]);
      expect(r.code, agent).toBe(0);
      expect(r.stdout).toContain('"abox"');
    }
    const orca = await run(t, ['init', '--agent', 'orca']);
    expect(orca.stdout).toContain('--http');
    const bad = await run(t, ['init', '--agent', 'vim', '--json']);
    expect(bad.code).toBe(2);
    // a defined context gets no warning
    const ok = await run(t, ['init', '--agent', 'cursor', '--json'], { env: {} });
    expect(ok.json.data.contextDefined).toBe(false);
  });

  it('works for a project given with --project and names the template after the directory', async () => {
    const other = t.write('home/My Cool App!/readme.md', 'x');
    const dir = join(other, '..');
    const r = await run(t, ['--project', dir, 'init', '--json']);
    expect(r.json.data.template).toBe('my-cool-app-dev');
    expect(existsSync(join(dir, '.sandbox', 'my-cool-app-dev.yaml'))).toBe(true);
  });
});

describe('hosts', () => {
  const sshConfig = `Host vps
  HostName 203.0.113.7
  User deploy
  Port 2222

Host *.internal
  User ignored
`;

  it('adds, lists, validates and removes host profiles', async () => {
    const add = await run(t, [
      'host',
      'add',
      'vps',
      '--hostname',
      'vps.example.org',
      '--user',
      'abox',
      '--port',
      '2201',
      '--zone',
      'lab',
      '--backend',
      'podman',
      '--engine-socket',
      '/run/user/1000/podman/podman.sock',
      '--json',
    ]);
    expect(add.code, add.stderr).toBe(0);
    expect(add.json.data).toMatchObject({
      id: 'vps',
      hostname: 'vps.example.org',
      zone: 'lab',
      backends: ['podman'],
    });
    const ls = await run(t, ['host', 'ls', '--json']);
    expect(ls.json.data.hosts.map((h: { id: string }) => h.id)).toEqual(['local', 'vps']);
    expect(ls.json.data.hosts[1].status).toBe('not tested');
    const human = await run(t, ['host', 'ls']);
    expect(human.stdout).toContain('abox@vps.example.org:2201');
    expect(human.stdout).toContain('podman');

    const dup = await run(t, ['host', 'add', 'vps', '--hostname', 'x.example.org', '--json']);
    expect(dup.code).toBe(2);
    expect(dup.json.code).toBe('conflict');
    const bad = await run(t, ['host', 'add', 'Bad_ID', '--hostname', 'x.example.org', '--json']);
    expect(bad.code).toBe(2);
    const badBackend = await run(t, [
      'host',
      'add',
      'v2',
      '--hostname',
      'x.example.org',
      '--backend',
      'floppy',
      '--json',
    ]);
    expect(badBackend.code).toBe(2);
    const noAddr = await run(t, ['host', 'add', 'v3', '--json']);
    expect(noAddr.code).not.toBe(0);

    const hostsYaml = readFileSync(join(t.aboxHome, 'config', 'hosts.yaml'), 'utf8');
    expect(hostsYaml).toContain('vps.example.org');
    expect(hostsYaml).not.toMatch(/password|passphrase|BEGIN/i);

    const rm = await run(t, ['host', 'rm', 'vps', '--json']);
    expect(rm.json.data.removed).toBe(true);
    expect((await run(t, ['host', 'rm', 'vps', '--json'])).code).toBe(2);
    expect((await run(t, ['host', 'rm', 'local', '--json'])).code).toBe(2);
  });

  it('adds a host with limits (--max-sandboxes, --cpus, --memory) and validates them', async () => {
    const add = await run(t, [
      'host',
      'add',
      'lab1',
      '--hostname',
      'lab1.example.org',
      '--zone',
      'lab',
      '--max-sandboxes',
      '4',
      '--cpus',
      '8',
      '--memory',
      '16g',
      '--json',
    ]);
    expect(add.code, add.stderr).toBe(0);
    expect(add.json.data.limits).toEqual({ sandboxes: 4, cpus: 8, memory: '16g' });
    const hostsYaml = readFileSync(join(t.aboxHome, 'config', 'hosts.yaml'), 'utf8');
    expect(hostsYaml).toMatch(/limits:/);
    expect(hostsYaml).toMatch(/sandboxes: 4/);
    expect(hostsYaml).toMatch(/memory: 16g/);
    const ls = await run(t, ['host', 'ls', '--json']);
    expect(ls.json.data.hosts.find((h: { id: string }) => h.id === 'lab1').limits).toMatchObject({
      sandboxes: 4,
    });

    for (const [flag, value, message] of [
      ['--max-sandboxes', '-1', /--max-sandboxes: expected a whole number/],
      ['--max-sandboxes', '2.5', /--max-sandboxes: expected a whole number/],
      ['--max-sandboxes', '10001', /--max-sandboxes: expected a whole number/],
      ['--cpus', '0', /--cpus: expected a positive number/],
      ['--cpus', 'many', /--cpus: expected a positive number/],
      ['--cpus', '2000', /--cpus: at most 1024/],
      ['--memory', 'lots', /--memory: invalid size/],
      ['--memory', '0', /--memory: invalid size/],
    ] as const) {
      const r = await run(t, [
        'host',
        'add',
        'lab2',
        '--hostname',
        'lab2.example.org',
        flag,
        value,
        '--json',
      ]);
      expect(r.code, `${flag} ${value}`).toBe(2);
      expect(r.json.code).toBe('invalid_input');
      expect(r.json.message).toMatch(message);
    }
    expect(
      (await run(t, ['host', 'ls', '--json'])).json.data.hosts.map((h: { id: string }) => h.id),
    ).toEqual(['local', 'lab1']);
  });

  it('imports from an ssh config (dry run first, imported hosts start in zone shared)', async () => {
    const cfg = t.write('ssh_config', sshConfig);
    const dry = await run(t, ['host', 'import-ssh-config', '--path', cfg, '--dry-run', '--json']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.json.data.hosts.map((h: { alias: string }) => h.alias)).toEqual(['vps']);
    expect(dry.json.data.added).toEqual([]);
    expect((await run(t, ['host', 'ls', '--json'])).json.data.hosts).toHaveLength(1);
    const real = await run(t, ['host', 'import-ssh-config', '--path', cfg, '--json']);
    expect(real.json.data.added).toEqual(['vps']);
    const ls = await run(t, ['host', 'ls', '--json']);
    const vps = ls.json.data.hosts.find((h: { id: string }) => h.id === 'vps');
    expect(vps).toMatchObject({ zone: 'shared', backends: [] });
  });

  it('host test reports an unreachable host as exit 4; trust needs a fingerprint without a terminal', async () => {
    await run(t, [
      'host',
      'add',
      'dead',
      '--hostname',
      '127.0.0.1',
      '--port',
      '1',
      '--user',
      'abox',
    ]);
    const test = await run(t, ['host', 'test', 'dead', '--json']);
    expect(test.code).toBe(4);
    expect(test.json).toMatchObject({ ok: false, code: 'host_unreachable' });
    const trust = await run(t, ['host', 'trust', 'dead', '--json']);
    expect(trust.code).toBe(2);
    expect(trust.json.hint).toContain('--fingerprint');
    const badFp = await run(t, ['host', 'trust', 'dead', '--fingerprint', 'nonsense', '--json']);
    expect(badFp.code).not.toBe(0);
    const unknown = await run(t, ['host', 'test', 'nope', '--json']);
    expect(unknown.code).toBe(2);
    const local = await run(t, ['host', 'test', 'local', '--json']);
    expect(local.code).toBe(2);
  });

  it('ssh runs the system ssh with the hardened arguments and passes its exit code on', async () => {
    const bin = t.write('bin/placeholder', '');
    const argsFile = join(t.root, 'ssh-args.txt');
    writeScript(t, 'bin/ssh', `printf '%s\\n' "$@" > '${argsFile}'\nexit 3`);
    chmodSync(bin, 0o644);
    await run(t, [
      'host',
      'add',
      'box',
      '--hostname',
      'box.example.org',
      '--user',
      'abox',
      '--port',
      '2022',
    ]);
    const env = { PATH: `${join(t.root, 'bin')}:${t.env['PATH']}` };
    const r = await run(t, ['ssh', 'box'], { env });
    expect(r.code).toBe(3);
    const args = readFileSync(argsFile, 'utf8').split('\n');
    expect(args).toContain('box.example.org');
    expect(args.join(' ')).toContain('StrictHostKeyChecking');
    expect(args.join(' ')).toContain('2022');
    const withCmd = await run(t, ['ssh', 'box', '--', 'uptime'], { env });
    expect(readFileSync(argsFile, 'utf8')).toContain('uptime');
    expect(withCmd.code).toBe(3);
    const local = await run(t, ['ssh', 'local', '--json'], { env });
    expect(local.code).toBe(2);
    const ghost = await run(t, ['ssh', 'ghost', '--json'], { env });
    expect(ghost.code).toBe(2);
    // the session is audited, without any content
    const audit = await run(t, ['audit', '--action', 'host.session.open', '--json']);
    expect(audit.json.data.entries.length).toBeGreaterThanOrEqual(1);
  });
});
