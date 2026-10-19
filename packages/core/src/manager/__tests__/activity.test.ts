import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../state/audit-log.js';
import type { NetworkEvent } from '../../types.js';
import type { Abox } from '../abox.js';
import { toActivity } from '../activity.js';
import {
  A,
  B,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  createApproved,
  created,
  fakeOf,
  makeEnv,
  openAbox,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox | undefined;

async function setup(): Promise<Abox> {
  env = makeEnv();
  abox = await openAbox(env, { fake: { networkEvents: true, updateNetwork: true } });
  return abox;
}
afterEach(() => {
  abox?.close();
  abox = undefined;
  env?.cleanup();
});

const ev = (
  ts: number,
  host: string,
  decision: 'allow' | 'deny',
  reason?: string,
): NetworkEvent => ({
  ts,
  host,
  port: 443,
  method: 'CONNECT',
  decision,
  ...(reason ? { reason } : {}),
});

function row(
  seq: number,
  action: string,
  decision: AuditEntry['decision'],
  details: Record<string, unknown>,
): AuditEntry {
  return {
    seq,
    ts: seq * 10,
    actor: 'human',
    action,
    sandboxId: 'local/aaaaaaaa',
    decision,
    details,
    prevHash: '',
    hash: '',
  };
}

describe('toActivity', () => {
  it('maps audit entries to kinds, outcomes and clipped whitelisted facts, newest first as given', () => {
    const out = toActivity([
      row(5, 'sandbox.write_file', 'allow', {
        path: '/workspace/a.txt',
        size: 12,
        mode: 0o644,
        content: 'SECRET',
      }),
      row(4, 'sandbox.exec', 'allow', {
        command: 'pnpm test',
        envKeys: ['TOKEN', 'CI'],
        exitCode: 0,
        durationMs: 41000,
        stdoutBytes: 99,
        logRef: 'exec:x',
      }),
      row(3, 'sandbox.exec', 'deny', { reasons: ['command not allowed'] }),
      row(2, 'sandbox.lookup', 'deny', { reason: 'not_found' }),
      row(1, 'approval.request', 'approval', {
        approvalId: 'ap1',
        kind: 'exec',
        for: 'sandbox.exec',
        reasons: ['x', 'y'],
      }),
    ]);
    expect(out.map((e) => [e.kind, e.outcome, e.action])).toEqual([
      ['file', 'ok', 'sandbox.write_file'],
      ['exec', 'ok', 'sandbox.exec'],
      ['exec', 'denied', 'sandbox.exec'],
      ['approval', 'pending', 'approval.request'],
    ]);
    expect(out[0]).toMatchObject({
      subject: '/workspace/a.txt',
      detail: { size: 12, mode: '644' },
    });
    expect(JSON.stringify(out[0])).not.toContain('SECRET');
    expect(out[1]!.detail).toEqual({ env: 'TOKEN CI', exitCode: 0, durationMs: 41000 });
    expect(out[2]!.detail).toEqual({ reason: 'command not allowed' });
    expect(out[3]).toMatchObject({ approvalId: 'ap1', subject: 'sandbox.exec' });
  });

  it('merges a run of identical proxy decisions into one item and keeps different ones apart', () => {
    const eg = (seq: number, host: string, d: 'allow' | 'deny') =>
      row(seq, 'network.egress', d, { host, port: 443, eventTs: seq * 100 });
    const out = toActivity([
      eg(5, 'a.example', 'deny'),
      eg(4, 'a.example', 'deny'),
      eg(3, 'a.example', 'allow'),
      eg(2, 'b.example', 'allow'),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      count: 2,
      ts: 500,
      from: 400,
      outcome: 'denied',
      subject: 'a.example',
    });
  });

  it('cuts on the event time of proxy entries', () => {
    const out = toActivity(
      [row(2, 'network.egress', 'allow', { host: 'a.example', port: 443, eventTs: 50 })],
      { since: 100 },
    );
    expect(out).toEqual([]);
  });
});

describe('Abox.activity', () => {
  it('lists commands, files, network decisions, approvals and lifecycle steps of one sandbox, filterable and paged', async () => {
    const a = await setup();
    const id = created(
      await a.createSandbox(HUMAN_YES, { template: 'fake-net', workspace: EMPTY_WS }),
    ).sandbox.id;
    const other = created(
      await a.createSandbox(HUMAN_YES, { template: 'fake-net', workspace: EMPTY_WS }),
    ).sandbox.id;
    await a.exec(HUMAN_YES, id, { command: 'echo hello' });
    await a.exec(HUMAN_YES, other, { command: 'echo other' });
    await a.writeFile(HUMAN, id, '/workspace/out.txt', 'file content that must not show');
    fakeOf(env).netEvents.set(id, [
      ev(Date.now(), 'registry.npmjs.org', 'allow'),
      ev(Date.now(), 'evil.example', 'deny', 'not in allowlist'),
    ]);
    await a.stopSandbox(HUMAN, id);

    const v = await a.activity(HUMAN, id);
    const kinds = v.entries.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['exec', 'file', 'network', 'lifecycle']));
    expect(v.entries.every((e) => e.sandboxId === id)).toBe(true);
    expect(v.entries.map((e) => e.seq)).toEqual(
      [...v.entries.map((e) => e.seq)].sort((x, y) => y - x),
    );
    expect(JSON.stringify(v)).not.toContain('must not show');
    expect(v.entries.find((e) => e.action === 'sandbox.write_file')).toMatchObject({
      subject: '/workspace/out.txt',
      detail: { size: 31 },
    });
    expect(
      v.entries.find((e) => e.action === 'network.egress' && e.outcome === 'denied'),
    ).toMatchObject({
      subject: 'evil.example',
      detail: { reason: 'not in allowlist' },
    });

    const only = await a.activity(HUMAN, id, { kinds: ['exec', 'file'] });
    expect(new Set(only.entries.map((e) => e.kind))).toEqual(new Set(['exec', 'file']));

    const p1 = await a.activity(HUMAN, id, { limit: 2 });
    expect(p1.entries.length).toBeLessThanOrEqual(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await a.activity(HUMAN, id, { limit: 2, cursor: p1.nextCursor! });
    expect(Math.max(...p2.entries.map((e) => e.seq))).toBeLessThan(
      Math.min(...p1.entries.map((e) => e.seq)),
    );

    const future = await a.activity(HUMAN, id, { since: Date.now() + 60_000 });
    expect(future.entries).toEqual([]);
  });

  it('never leaks a secret value that the audit log masked', async () => {
    const a = await setup();
    const id = created(
      await a.createSandbox(HUMAN_YES, { template: 'fake-net', workspace: EMPTY_WS }),
    ).sandbox.id;
    await a.exec(HUMAN_YES, id, {
      command: 'curl -H "Authorization: Bearer x" https://example.org',
      env: { API_TOKEN: 'hunter2hunter2' },
    });
    const v = await a.activity(HUMAN, id, { kinds: ['exec'] });
    const text = JSON.stringify(v);
    expect(text).not.toContain('hunter2hunter2');
    expect(v.entries[0]!.detail['env']).toBe('API_TOKEN');
  });

  it('an agent sees its own sandboxes only; another one is not_found', async () => {
    const a = await setup();
    const mine = (await createApproved(a, A, { template: 'fake-box', workspace: EMPTY_WS })).sandbox
      .id;
    const v = await a.activity(A, mine);
    expect(v.entries.some((e) => e.kind === 'lifecycle')).toBe(true);
    await expect(a.activity(B, mine)).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.activity(A, 'local/00000000')).rejects.toMatchObject({ code: 'not_found' });
    const human = created(
      await a.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }),
    ).sandbox.id;
    await expect(a.activity(A, human)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses bad options', async () => {
    const a = await setup();
    const id = created(
      await a.createSandbox(HUMAN_YES, { template: 'fake-box', workspace: EMPTY_WS }),
    ).sandbox.id;
    for (const o of [
      { since: -1 },
      { limit: 0 },
      { limit: 1.5 },
      { cursor: 'x' },
      { kinds: [] },
      { kinds: ['nope' as never] },
    ])
      await expect(a.activity(HUMAN, id, o)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('Abox.recentActivity', () => {
  it('lists the newest activity of all sandboxes with names, skips allowed requests and reads, and respects ownership', async () => {
    const a = await setup();
    const mine = (await createApproved(a, A, { template: 'fake-net', workspace: EMPTY_WS }))
      .sandbox;
    const theirs = created(
      await a.createSandbox(HUMAN_YES, { template: 'fake-net', workspace: EMPTY_WS }),
    ).sandbox;
    await a.writeFile(HUMAN, theirs.id, '/workspace/x', 'x');
    await a.readFile(HUMAN, theirs.id, '/workspace/x');
    fakeOf(env).netEvents.set(mine.id, [
      ev(Date.now(), 'ok.example', 'allow'),
      ev(Date.now(), 'bad.example', 'deny', 'not in allowlist'),
    ]);
    await a.activity(A, mine.id); // collects the proxy decisions

    const all = await a.recentActivity(HUMAN, { limit: 50 });
    expect(new Set(all.entries.map((e) => e.sandboxId))).toEqual(new Set([mine.id, theirs.id]));
    expect(all.entries.find((e) => e.sandboxId === theirs.id)!.sandboxName).toBe(theirs.name);
    expect(all.entries.some((e) => e.action === 'sandbox.read_file')).toBe(false);
    expect(all.entries.some((e) => e.action === 'network.egress' && e.outcome === 'ok')).toBe(
      false,
    );
    expect(all.entries.some((e) => e.subject === 'bad.example')).toBe(true);

    const own = await a.recentActivity(A);
    expect(own.entries.length).toBeGreaterThan(0);
    expect(own.entries.every((e) => e.sandboxId === mine.id)).toBe(true);
    expect((await a.recentActivity(HUMAN, { limit: 1 })).entries).toHaveLength(1);
    await expect(a.recentActivity(HUMAN, { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
