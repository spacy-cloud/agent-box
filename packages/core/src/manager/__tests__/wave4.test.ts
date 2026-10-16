import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config/config.js';
import { AboxError } from '../../errors.js';
import { FakeProvider } from './fake-provider.js';
import type { NetworkEvent } from '../../types.js';
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
  writeProjectTemplate,
} from './harness.js';
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

async function newBox(
  a: Abox,
  caller = HUMAN_YES,
  template = 'fake-box',
  extra: Record<string, unknown> = {},
): Promise<string> {
  return created(await a.createSandbox(caller, { template, workspace: EMPTY_WS, ...extra })).sandbox
    .id;
}

async function actionsOf(a: Abox, action: string): Promise<Array<Record<string, unknown>>> {
  const rows = await a.queryAudit(HUMAN, { action, order: 'asc', limit: 5000 });
  return rows.map((r) => ({
    decision: r.decision,
    sandboxId: r.sandboxId,
    actor: r.actor,
    ...r.details,
  }));
}

// ---------------------------------------------------------------------------

describe('built-in agent contexts (no policy.yaml)', () => {
  it.each(['claude-code', 'codex', 'cursor', 'orca', 'default'])(
    'context %s works with the built-in default policy',
    async (ctxId) => {
      const a = await setup({ bare: true });
      const who = { contextId: ctxId };
      const r = await a.createSandbox(who, { template: 'alpine-min', workspace: EMPTY_WS });
      expect(r.status).toBe('created');
      if (r.status === 'created') expect(r.sandbox.owner).toBe(`agent:${ctxId}`);
      const pol = await a.showPolicy(who);
      expect(pol.profile.name).toBe('default');
      // not defined -> still denied
      await expect(a.showPolicy({ contextId: 'some-other-agent' })).rejects.toMatchObject({
        code: 'policy_denied',
      });
    },
  );

  it('a policy.yaml replaces them', async () => {
    const a = await setup({
      bare: true,
      policyText:
        'version: 1\nprofiles:\n  p: { templates: [alpine-min] }\ncontexts:\n  mine: { profile: p }\n',
    });
    await expect(a.showPolicy({ contextId: 'claude-code' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect((await a.showPolicy({ contextId: 'mine' })).profile.name).toBe('p');
  });
});

// ---------------------------------------------------------------------------

describe('invalid templates are template_invalid, not not_found (F2)', () => {
  it('create / show / build report file, line and column', async () => {
    const a = await setup();
    writeProjectTemplate(env, 'proj-bad', 'network: { mode: wormhole }\n');
    for (const call of [
      () => a.createSandbox(HUMAN_YES, { template: 'proj-bad', workspace: EMPTY_WS }),
      () => a.showTemplate(HUMAN, 'proj-bad'),
      () => a.buildTemplate(HUMAN_YES, 'proj-bad'),
    ]) {
      const e = (await call().catch((x: unknown) => x)) as AboxError;
      expect(e).toBeInstanceOf(AboxError);
      expect(e.code).toBe('template_invalid');
      expect(e.exitCode).toBe(2);
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues[0]).toMatchObject({ path: 'network.mode', line: expect.any(Number) });
      expect(e.issues[0]!.column).toEqual(expect.any(Number));
      expect(String(e.details?.['path'])).toContain('proj-bad.yaml');
    }
    // a name that does not exist at all is still not_found
    await expect(a.showTemplate(HUMAN, 'nonexistent-template')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ---------------------------------------------------------------------------

describe('allowlist entries with a port (F5)', () => {
  it('are accepted for create overrides and access requests and passed on unchanged', async () => {
    const a = await setup({ fake: { updateNetwork: true } });
    const id = await newBox(a, HUMAN_YES, 'fake-net', {
      overrides: { network: { allow: ['example.org:8443', '*.corp.example.org:9000'] } },
    });
    const spec = fakeOf(env).specs.at(-1)!;
    expect(spec.network.allow).toEqual(
      expect.arrayContaining(['example.org:8443', '*.corp.example.org:9000']),
    );
    // already covered -> no-op; a different port is not covered by a port entry
    const same = await a.accessRequest(HUMAN_YES, id, {
      kind: 'network',
      details: { domains: ['example.org:8443'] },
    });
    expect(same.status).toBe('applied');
    const other = await a.accessRequest(HUMAN_YES, id, {
      kind: 'network',
      details: { domains: ['example.org:9443'] },
    });
    expect(other.status).toBe('applied');
    expect(fakeOf(env).networkUpdates.at(-1)!.allow).toContain('example.org:9443');
  });

  it('an agent asking for a port beyond its profile needs an approval; invalid ports are denied', async () => {
    const a = await setup();
    const r = await a.createSandbox(
      A,
      {
        template: 'fake-net',
        workspace: EMPTY_WS,
        overrides: { network: { allow: ['registry.npmjs.org:8443'] } },
      },
      { waitForApprovalMs: 0 },
    );
    expect(r.status).toBe('pending_approval');
    await expect(
      a.createSandbox(A, {
        template: 'fake-net',
        workspace: EMPTY_WS,
        overrides: { network: { allow: ['example.org:99999'] } },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });
});

// ---------------------------------------------------------------------------

describe('proxy egress decisions reach the audit log (F4)', () => {
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

  it('after exec, once per event, with decision, host, port and reason', async () => {
    const a = await setup({ fake: { networkEvents: true } });
    const id = await newBox(a, HUMAN_YES, 'fake-net');
    const fake = fakeOf(env);
    const t = env.clock.t;
    fake.addNetEvents(
      id,
      ev(t + 1, 'registry.npmjs.org', 'allow'),
      ev(t + 2, 'evil.example', 'deny', 'not in allowlist'),
    );
    await a.exec(HUMAN, id, { argv: ['true'] });
    let rows = await actionsOf(a, 'network.egress');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      decision: 'allow',
      sandboxId: id,
      actor: 'human',
      host: 'registry.npmjs.org',
      port: 443,
      method: 'CONNECT',
    });
    expect(rows[1]).toMatchObject({
      decision: 'deny',
      host: 'evil.example',
      reason: 'not in allowlist',
    });
    // collecting again does not duplicate; new events are added
    await a.exec(HUMAN, id, { argv: ['true'] });
    await a.inspectSandbox(HUMAN, id);
    expect(await actionsOf(a, 'network.egress')).toHaveLength(2);
    fake.addNetEvents(id, ev(t + 3, 'other.example', 'deny', 'not in allowlist'));
    await a.inspectSandbox(HUMAN, id);
    rows = await actionsOf(a, 'network.egress');
    expect(rows.map((r) => r['host'])).toEqual([
      'registry.npmjs.org',
      'evil.example',
      'other.example',
    ]);
  });

  it('events with the same millisecond are neither lost nor duplicated', async () => {
    const a = await setup({ fake: { networkEvents: true } });
    const id = await newBox(a, HUMAN_YES, 'fake-net');
    const fake = fakeOf(env);
    const t = env.clock.t + 5;
    fake.addNetEvents(id, ev(t, 'a.example', 'deny'));
    await a.inspectSandbox(HUMAN, id);
    fake.addNetEvents(id, ev(t, 'b.example', 'deny'), ev(t, 'c.example', 'allow'));
    await a.inspectSandbox(HUMAN, id);
    await a.inspectSandbox(HUMAN, id);
    const rows = await actionsOf(a, 'network.egress');
    expect(rows.map((r) => r['host'])).toEqual(['a.example', 'b.example', 'c.example']);
  });

  it('is collected on stop, remove (before the proxy is gone), queryAudit and TTL expiry', async () => {
    const a = await setup({ fake: { networkEvents: true } });
    const fake = () => fakeOf(env);
    const t = env.clock.t;
    // stop
    const s1 = await newBox(a, HUMAN_YES, 'fake-net');
    fake().addNetEvents(s1, ev(t + 1, 'stop.example', 'deny'));
    await a.stopSandbox(HUMAN, s1);
    // remove
    const s2 = await newBox(a, HUMAN_YES, 'fake-net');
    fake().addNetEvents(s2, ev(t + 2, 'remove.example', 'deny'));
    await a.removeSandbox(HUMAN, s2);
    // queryAudit with a sandbox filter
    const s3 = await newBox(a, HUMAN_YES, 'fake-net');
    fake().addNetEvents(s3, ev(t + 3, 'query.example', 'deny'));
    const viaQuery = await a.queryAudit(HUMAN, { sandboxId: s3, action: 'network.egress' });
    expect(viaQuery.map((e) => e.details?.['host'])).toEqual(['query.example']);
    // TTL sweep
    const s4 = await newBox(a, HUMAN_YES, 'fake-net');
    fake().addNetEvents(s4, ev(t + 4, 'ttl.example', 'deny'));
    env.clock.t += 2 * 3600_000;
    await a.sweepTtl(HUMAN);
    const hosts = (await actionsOf(a, 'network.egress')).map((r) => r['host']);
    expect(hosts).toEqual(
      expect.arrayContaining(['stop.example', 'remove.example', 'query.example', 'ttl.example']),
    );
    expect(hosts.filter((h) => h === 'ttl.example')).toHaveLength(1);
    expect(s4).toBeTruthy();
  });

  it('agent sandboxes: the owner sees the entries, another agent does not; never any secret', async () => {
    const a = await setup({ fake: { networkEvents: true } });
    const id = await newBox(a, A, 'fake-net');
    fakeOf(env).addNetEvents(id, ev(env.clock.t + 1, 'denied.example', 'deny', 'not in allowlist'));
    await a.exec(A, id, { argv: ['true'] });
    const own = await a.queryAudit(A, { action: 'network.egress' });
    expect(own).toHaveLength(1);
    expect(own[0]!.actor).toBe('agent:agent-a');
    expect(await a.queryAudit(B, { action: 'network.egress' })).toHaveLength(0);
    expect(JSON.stringify(own)).not.toMatch(/ghp_/);
  });

  it('a flood of events is summarized, denies are always listed one by one', async () => {
    const a = await setup({ fake: { networkEvents: true } });
    const id = await newBox(a, HUMAN_YES, 'fake-net');
    const t = env.clock.t;
    const fake = fakeOf(env);
    for (let i = 0; i < 1000; i++)
      fake.addNetEvents(id, ev(t + 1 + i, `h${i % 10}.example`, 'allow'));
    fake.addNetEvents(id, ev(t + 2000, 'evil.example', 'deny'));
    await a.inspectSandbox(HUMAN, id);
    const rows = await actionsOf(a, 'network.egress');
    expect(rows.filter((r) => r['decision'] === 'allow')).toHaveLength(200);
    expect(rows.filter((r) => r['decision'] === 'deny')).toHaveLength(1);
    const summary = await actionsOf(a, 'network.egress.summary');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ count: 800, allowed: 800, denied: 0 });
  });

  it('a backend failure does not break the operation and nothing is lost', async () => {
    const a = await setup({ fake: { networkEvents: true } });
    const id = await newBox(a, HUMAN_YES, 'fake-net');
    const fake = fakeOf(env);
    const real = fake.networkEvents!;
    fake.networkEvents = () =>
      Promise.reject(new AboxError('backend_error', 'proxy log unreadable'));
    fake.addNetEvents(id, ev(env.clock.t + 1, 'later.example', 'deny'));
    const r = await a.exec(HUMAN, id, { argv: ['true'] });
    expect(r.status).toBe('completed');
    expect(await actionsOf(a, 'network.egress')).toHaveLength(0);
    fake.networkEvents = real;
    await a.inspectSandbox(HUMAN, id);
    expect(await actionsOf(a, 'network.egress')).toHaveLength(1);
  });

  it('sandboxes without allowlist mode or without provider support are not polled', async () => {
    const a = await setup({ fake: { networkEvents: true } });
    const none = await newBox(a, HUMAN_YES, 'fake-box');
    await a.exec(HUMAN, none, { argv: ['true'] });
    expect(fakeOf(env).networkEventCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('attach', () => {
  it('is human only, audited on open and close (no content), needs a running sandbox', async () => {
    const a = await setup({ fake: { capabilities: { tty: true } } });
    const id = await newBox(a, A);
    await expect(a.attach(A, id, { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(await actionsOf(a, 'sandbox.attach_denied')).toHaveLength(1);

    const session = await a.attach(HUMAN, id, { cols: 100, rows: 30, argv: ['bash', '-l'] });
    expect(fakeOf(env).ttyCalls.at(-1)).toMatchObject({
      cols: 100,
      rows: 30,
      argv: ['bash', '-l'],
    });
    session.stream.write('echo SECRET-TYPED-TEXT\n');
    const open = await actionsOf(a, 'sandbox.attach');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ decision: 'allow', sandboxId: id, actor: 'human', cols: 100 });
    fakeOf(env).ttyExits.at(-1)!(7);
    expect(await session.wait()).toBe(7);
    await session.close();
    const end = await actionsOf(a, 'sandbox.attach.end');
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ sandboxId: id, exitCode: 7 });
    expect(typeof end[0]!['durationMs']).toBe('number');
    expect(JSON.stringify(await a.queryAudit(HUMAN, { limit: 500 }))).not.toContain(
      'SECRET-TYPED-TEXT',
    );

    await a.stopSandbox(HUMAN, id);
    await expect(a.attach(HUMAN, id, { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('close without a known exit code is still audited once; bad input and backends without tty are rejected', async () => {
    const a = await setup({ fake: { capabilities: { tty: true } } });
    const id = await newBox(a, HUMAN_YES);
    const s = await a.attach(HUMAN, id, { cols: 80, rows: 24 });
    await s.close();
    await s.close();
    expect(await actionsOf(a, 'sandbox.attach.end')).toHaveLength(1);
    await expect(
      a.attach(HUMAN, id, { cols: '80' as unknown as number, rows: 24 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // an unknown size (0, as under some pseudo terminals) falls back to 80x24, a huge one is capped
    const odd = await a.attach(HUMAN, id, { cols: 0, rows: 99999 });
    expect(fakeOf(env).ttyCalls.at(-1)).toMatchObject({ cols: 80, rows: 1000 });
    await odd.close();
    await expect(a.attach(HUMAN, id, { cols: 80, rows: 24, argv: [] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(a.attach(HUMAN, 'local/nope', { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a backend without a terminal is unsupported', async () => {
    const a = await setup();
    const id = await newBox(a, HUMAN_YES);
    await expect(a.attach(HUMAN, id, { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

// ---------------------------------------------------------------------------

describe('copyIn / copyOut', () => {
  it('copyIn: human only, canonical path, forbidden sources are policy_denied with a hint', async () => {
    const a = await setup();
    const id = await newBox(a, A);
    const file = join(env.project, 'src', 'a.txt');
    await expect(a.copyIn(A, id, file, '/workspace/')).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(fakeOf(env).copyCalls).toHaveLength(0);

    await a.copyIn(HUMAN, id, join(env.project, 'src', '..', 'src', 'a.txt'), '/workspace/');
    expect(fakeOf(env).copyCalls).toEqual([{ dir: 'in', id, host: file, sandbox: '/workspace/' }]);
    const audit = await actionsOf(a, 'sandbox.copy_in');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decision: 'allow',
      hostPath: file,
      sandboxPath: '/workspace/',
      files: 1,
      bytes: 2,
    });

    // a directory: files and bytes are summed
    await a.copyIn(HUMAN, id, env.project, 'sub');
    const dirAudit = (await actionsOf(a, 'sandbox.copy_in')).at(-1)!;
    expect(dirAudit).toMatchObject({ directory: true, files: 2, sandboxPath: '/workspace/sub' });

    for (const bad of [
      join(env.home, '.ssh', 'id_ed25519'),
      join(env.home, '.ssh'),
      env.home,
      '/etc/passwd',
      abox!.paths.dataDir,
      join(abox!.paths.configDir, 'policy.yaml'),
      '/var/run/docker.sock',
    ]) {
      const e = (await a
        .copyIn(HUMAN, id, bad, '/workspace/')
        .catch((x: unknown) => x)) as AboxError;
      expect(e, bad).toBeInstanceOf(AboxError);
      expect(e.code, bad).toBe('policy_denied');
      expect(e.hint, bad).toBeTruthy();
    }
    expect(fakeOf(env).copyCalls).toHaveLength(2);
    expect(
      (await actionsOf(a, 'sandbox.copy_in')).filter((r) => r['decision'] === 'deny').length,
    ).toBe(7);

    await expect(a.copyIn(HUMAN, id, join(env.project, 'missing'), '/x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('copyOut: human only; destination must not be abox data, another sandbox dir or a protected path', async () => {
    const a = await setup();
    const id = await newBox(a, HUMAN_YES, 'fake-box', {
      workspace: { mode: 'copy', path: env.project },
    });
    const other = await newBox(a, HUMAN_YES);
    const dest = join(env.project, 'out', 'result.txt');
    await expect(a.copyOut(A, id, '/workspace/a.txt', dest)).rejects.toMatchObject({
      code: 'policy_denied',
    });

    await a.copyOut(HUMAN, id, '/workspace/a.txt', dest);
    expect(readFileSync(dest, 'utf8')).toContain('copied out');
    const audit = await actionsOf(a, 'sandbox.copy_out');
    expect(audit[0]).toMatchObject({
      decision: 'allow',
      hostPath: dest,
      sandboxPath: '/workspace/a.txt',
      files: 1,
    });
    expect(Number(audit[0]!['bytes'])).toBeGreaterThan(0);

    const sandboxesDir = join(abox!.paths.dataDir, 'sandboxes');
    mkdirSync(sandboxesDir, { recursive: true });
    for (const bad of [
      join(env.home, '.ssh', 'authorized_keys'),
      join(abox!.paths.configDir, 'policy.yaml'),
      join(abox!.paths.dataDir, 'state.db'),
      join(abox!.paths.cacheDir, 'x'),
      join(sandboxesDir, 'whatever'),
      '/etc/cron.d/evil',
      env.home,
    ]) {
      const e = (await a
        .copyOut(HUMAN, id, '/workspace/a.txt', bad)
        .catch((x: unknown) => x)) as AboxError;
      expect(e, bad).toBeInstanceOf(AboxError);
      expect(e.code, bad).toBe('policy_denied');
      expect(e.hint, bad).toBeTruthy();
    }
    expect(existsSync(join(env.home, '.ssh', 'authorized_keys'))).toBe(false);
    expect(existsSync(join(abox!.paths.configDir, 'policy.yaml.x'))).toBe(false);
    expect(fakeOf(env).copyCalls.filter((c) => c.dir === 'out')).toHaveLength(1);
    expect(other).toBeTruthy();
  });

  it('a removed or foreign sandbox is not_found / policy_denied for agents', async () => {
    const a = await setup();
    const id = await newBox(a, A);
    await expect(a.copyOut(B, id, '/x', join(env.project, 'x'))).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await a.removeSandbox(HUMAN, id);
    await expect(a.copyOut(HUMAN, id, '/x', join(env.project, 'x'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ---------------------------------------------------------------------------

describe('sandboxLogs', () => {
  it('owner only, masks secrets, passes tail and sinceTs', async () => {
    const calls: Array<{ tail?: number; sinceTs?: number }> = [];
    const a = await setup({
      fake: {
        logs: (_id, o) => {
          calls.push(o);
          return 'started\ntoken=ghp_SUPERSECRETTOKEN1234567890abcdef\ndone\n';
        },
      },
    });
    const id = (await createApproved(a, A, { template: 'fake-env-secret', workspace: EMPTY_WS }))
      .sandbox.id;
    const text = await a.sandboxLogs(A, id, { tail: 50, sinceTs: 123 });
    expect(text).toContain('started');
    expect(text).not.toContain('ghp_SUPERSECRETTOKEN');
    expect(text).toContain('***');
    expect(calls).toEqual([{ tail: 50, sinceTs: 123 }]);
    expect(await actionsOf(a, 'sandbox.logs')).toHaveLength(1);
    await a.sandboxLogs(A, id); // a poll right after the first read is not audited again
    expect(await actionsOf(a, 'sandbox.logs')).toHaveLength(1);
    await expect(a.sandboxLogs(B, id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await a.sandboxLogs(HUMAN, id)).toContain('done');
    await expect(a.sandboxLogs(A, id, { tail: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('a backend without logs is unsupported', async () => {
    const a = await setup();
    const id = await newBox(a, HUMAN_YES);
    await expect(a.sandboxLogs(HUMAN, id)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('listSnapshots', () => {
  it('tracks snapshots per sandbox, owner only, forgotten with the sandbox', async () => {
    const a = await setup({ fake: { capabilities: { snapshots: true } } });
    const id = await newBox(a, A);
    expect(await a.listSnapshots(A, id)).toEqual([]);
    await a.snapshot(A, id, 'one');
    env.clock.t += 10;
    await a.snapshot(A, id, 'two');
    const list = await a.listSnapshots(A, id);
    expect(list.map((s) => s.name)).toEqual(['one', 'two']);
    expect(list[0]).toMatchObject({ id: 'one', name: 'one', createdAt: expect.any(Number) });
    await expect(a.listSnapshots(B, id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await a.listSnapshots(HUMAN, id)).length).toBe(2);
    await a.removeSandbox(A, id);
    await expect(a.listSnapshots(A, id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('policy revisions', () => {
  it('human only; list newest first and fetch the text of one', async () => {
    const a = await setup();
    const first = await a.listPolicyRevisions(HUMAN);
    expect(first.length).toBeGreaterThanOrEqual(1);
    const newText = `${(await a.showPolicy(HUMAN)) && readFileSync(a.paths.policyFile, 'utf8')}\n# changed\n`;
    writeFileSync(a.paths.policyFile, newText);
    await a.setPolicy(HUMAN, newText);
    const list = await a.listPolicyRevisions(HUMAN);
    expect(list.length).toBe(first.length + 1);
    expect(list[0]!.rev).toBeGreaterThan(list[1]!.rev);
    expect(list[0]).toMatchObject({
      actor: 'human',
      contentHash: expect.any(String),
      ts: expect.any(Number),
    });
    const detail = await a.getPolicyRevision(HUMAN, list[0]!.rev);
    expect(detail.content).toContain('# changed');
    expect(detail.contentHash).toBe(list[0]!.contentHash);
    await expect(a.getPolicyRevision(HUMAN, 99999)).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.getPolicyRevision(HUMAN, 0)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(a.listPolicyRevisions(A)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(a.getPolicyRevision(A, list[0]!.rev)).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });
});

// ---------------------------------------------------------------------------

describe('doctor and optional backends', () => {
  const brokenPodman = (host: ConstructorParameters<typeof FakeProvider>[0]): FakeProvider => {
    const p = new FakeProvider(host, { kind: 'podman', now: env.clock.now });
    p.status = () =>
      Promise.resolve({ ok: false, version: '', details: [], warnings: ['podman socket missing'] });
    return p;
  };

  it('an unusable Podman nobody needs is a warning, not a failure', async () => {
    const a = await setup({ providers: { podman: brokenPodman } });
    const d = await a.doctor(HUMAN);
    const c = d.checks.find((x) => x.id === 'backend.local.podman')!;
    expect(c.level).toBe('warn');
    expect(c.title).toContain('optional');
    expect(d.ok).toBe(true);
    expect(d.checks.filter((x) => x.level === 'error')).toEqual([]);
  });

  it('is an error when podman is the default backend', async () => {
    const a = await setup({
      providers: { podman: brokenPodman },
      config: parseConfig('backends:\n  default: podman\n'),
    });
    const d = await a.doctor(HUMAN);
    expect(d.checks.find((x) => x.id === 'backend.local.podman')!.level).toBe('error');
    expect(d.ok).toBe(false);
  });

  it('is an error when one of the user templates uses it', async () => {
    const a = await setup({ providers: { podman: brokenPodman } });
    writeFileSync(
      join(a.paths.templatesDir, 'my-podman.yaml'),
      'apiVersion: 1\nname: my-podman\ndescription: A template on podman for the doctor test.\nbackend: podman\nbase: { os: ubuntu:24.04 }\n',
    );
    const d = await a.doctor(HUMAN);
    expect(d.checks.find((x) => x.id === 'backend.local.podman')!.level).toBe('error');
    expect(d.ok).toBe(false);
  });
});
