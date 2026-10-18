import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../config/paths.js';
import type { AuditEntry } from '../../state/audit-log.js';
import type { NetworkEvent } from '../../types.js';
import type { Abox } from '../abox.js';
import { MAX_LOG_EVENTS, aggregateNetworkLog, classifyReason } from '../network-log.js';
import { A, B, EMPTY_WS, HUMAN, HUMAN_YES, created, fakeOf, makeEnv, openAbox } from './harness.js';
import type { OpenOpts, TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox | undefined;

async function setup(o: OpenOpts = {}): Promise<Abox> {
  env = makeEnv();
  abox = await openAbox(env, { fake: { networkEvents: true, updateNetwork: true }, ...o });
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
  over: Partial<NetworkEvent> = {},
): NetworkEvent => ({
  ts,
  host,
  port: 443,
  method: 'CONNECT',
  decision,
  ...(reason ? { reason } : {}),
  ...over,
});

async function newBox(a: Abox, caller = HUMAN_YES, template = 'fake-net'): Promise<string> {
  return created(await a.createSandbox(caller, { template, workspace: EMPTY_WS })).sandbox.id;
}
const policyText = (): string => readFileSync(resolvePaths(env.env).policyFile, 'utf8');

/** Synthetic audit entries for the pure aggregation. */
function row(
  seq: number,
  action: 'network.egress' | 'network.egress.summary',
  decision: 'allow' | 'deny' | 'info',
  details: Record<string, unknown>,
): AuditEntry {
  return {
    seq,
    ts: seq,
    actor: 'human',
    action,
    sandboxId: 'local/aaaaaaaa',
    decision,
    details,
    prevHash: '',
    hash: '',
  };
}
const egress = (
  seq: number,
  eventTs: number,
  host: string,
  decision: 'allow' | 'deny',
  extra: Record<string, unknown> = {},
): AuditEntry =>
  row(seq, 'network.egress', decision, { host, port: 443, method: 'CONNECT', eventTs, ...extra });

const OPTS = { limit: 200, allow: ['registry.npmjs.org'], mode: 'allowlist' as const };

describe('classifyReason', () => {
  it.each([
    ['not in allowlist', 'not_in_allowlist'],
    ['port not allowed', 'port_not_allowed'],
    ['ip literal not allowed', 'ip_literal'],
    ['blocked address 10.0.0.5 (private network)', 'blocked_address'],
    ['blocked address 169.254.169.254 (link-local / cloud metadata)', 'blocked_address'],
    ['dns lookup failed (ENOTFOUND)', 'dns_failed'],
    ['plain http to injection host', 'plain_http_injection'],
    ['method not allowed', 'method_not_allowed'],
    ['connect failed (ECONNREFUSED)', 'connect_failed'],
    ['invalid host: ambiguous numeric host', 'invalid_request'],
    ['early data before tunnel established', 'invalid_request'],
    ['something new', 'other'],
  ])('%s -> %s', (reason, kind) => {
    expect(classifyReason(reason)).toBe(kind);
  });
  it('has no kind without a reason', () => {
    expect(classifyReason(undefined)).toBeUndefined();
    expect(classifyReason('')).toBeUndefined();
  });
});

describe('aggregateNetworkLog', () => {
  it('groups by host and port with counts, first and last time, methods and the last decision', () => {
    const r = aggregateNetworkLog(
      [
        egress(1, 100, 'a.example', 'deny', { reason: 'not in allowlist' }),
        egress(2, 200, 'a.example', 'deny', { reason: 'not in allowlist', method: 'GET' }),
        egress(3, 300, 'registry.npmjs.org', 'allow'),
        egress(4, 400, 'a.example', 'allow'),
        row(5, 'network.egress', 'deny', {
          host: 'a.example',
          port: 8080,
          method: 'CONNECT',
          eventTs: 500,
          reason: 'port not allowed',
        }),
      ],
      OPTS,
    );
    expect(r.totals).toEqual({ allowed: 2, denied: 3, destinations: 3 });
    expect(r.truncated).toBe(false);
    // newest first
    expect(r.entries.map((e) => `${e.host}:${e.port}`)).toEqual([
      'a.example:8080',
      'a.example:443',
      'registry.npmjs.org:443',
    ]);
    const a = r.entries.find((e) => e.host === 'a.example' && e.port === 443)!;
    expect(a).toMatchObject({
      decision: 'allow', // the most recent request was allowed (allow once happened since)
      allowed: 1,
      denied: 2,
      count: 3,
      firstSeen: 100,
      lastSeen: 400,
      reason: 'not in allowlist',
      reasonKind: 'not_in_allowlist',
      methods: ['CONNECT', 'GET'],
      allowedNow: false,
    });
    expect(a.allow).toMatchObject({ possible: true, pattern: 'a.example' });
  });

  it('offers host:port for a port other than 80 and 443, the wildcard only as a separate field', () => {
    const r = aggregateNetworkLog(
      [
        row(1, 'network.egress', 'deny', {
          host: 'api.service.example.org',
          port: 8443,
          method: 'CONNECT',
          eventTs: 10,
          reason: 'port not allowed',
        }),
        egress(2, 20, 'registry.example.org', 'deny', { reason: 'not in allowlist' }),
      ],
      OPTS,
    );
    const p = r.entries.find((e) => e.port === 8443)!;
    expect(p.allow).toEqual({
      possible: true,
      pattern: 'api.service.example.org:8443',
      wildcard: '*.service.example.org:8443',
    });
    const q = r.entries.find((e) => e.host === 'registry.example.org')!;
    expect(q.allow).toEqual({
      possible: true,
      pattern: 'registry.example.org',
      wildcard: '*.example.org',
    });
  });

  it('gives no wildcard for a two-label name or a public suffix parent', () => {
    const r = aggregateNetworkLog(
      [
        egress(1, 10, 'example.org', 'deny', { reason: 'not in allowlist' }),
        egress(2, 20, 'example.co.uk', 'deny', { reason: 'not in allowlist' }),
      ],
      OPTS,
    );
    expect(r.entries.find((e) => e.host === 'example.org')!.allow).toEqual({
      possible: true,
      pattern: 'example.org',
    });
    expect(r.entries.find((e) => e.host === 'example.co.uk')!.allow).toEqual({
      possible: true,
      pattern: 'example.co.uk',
    });
  });

  it('explains why a denial can not be allowed (private address, IP, metadata name, dns)', () => {
    const r = aggregateNetworkLog(
      [
        egress(1, 10, 'intranet.example.org', 'deny', {
          reason: 'blocked address 10.1.2.3 (private network)',
        }),
        egress(2, 20, '169.254.169.254', 'deny', { reason: 'ip literal not allowed' }),
        egress(3, 30, 'metadata.google.internal', 'deny', { reason: 'not in allowlist' }),
        egress(4, 40, 'typo.example.org', 'deny', { reason: 'dns lookup failed (ENOTFOUND)' }),
        egress(5, 50, '', 'deny', { reason: 'invalid host' }),
      ],
      OPTS,
    );
    const by = (h: string) => r.entries.find((e) => e.host === h)!;
    expect(by('intranet.example.org').allow).toMatchObject({ possible: false });
    expect(by('intranet.example.org').allow?.why).toMatch(/private-address exception/);
    expect(by('169.254.169.254').allow?.why).toMatch(/IP address/);
    expect(by('metadata.google.internal').allow).toMatchObject({ possible: false });
    expect(by('metadata.google.internal').allow?.why).toMatch(/metadata/);
    expect(by('typo.example.org').allow?.why).toMatch(/did not resolve/);
    expect(by('').allow?.possible).toBe(false);
    for (const e of r.entries) expect(e.allow?.pattern).toBeUndefined();
  });

  it('marks destinations the allowlist covers now and offers nothing for them', () => {
    const r = aggregateNetworkLog(
      [
        egress(1, 10, 'registry.npmjs.org', 'deny', { reason: 'not in allowlist' }),
        egress(2, 20, 'x.example', 'deny', { reason: 'not in allowlist' }),
      ],
      { ...OPTS, allow: ['registry.npmjs.org', '*.example'] },
    );
    // `*.example` is no valid pattern but the matching is the same one as the policy's
    const npm = r.entries.find((e) => e.host === 'registry.npmjs.org')!;
    expect(npm.allowedNow).toBe(true);
    expect(npm.allow).toBeUndefined();
  });

  it('offers no actions when the network is not an allowlist', () => {
    for (const mode of ['none', 'open'] as const) {
      const r = aggregateNetworkLog(
        [egress(1, 10, 'a.example', 'deny', { reason: 'not in allowlist' })],
        { ...OPTS, mode },
      );
      expect(r.entries[0]!.allow).toBeUndefined();
    }
  });

  it('filters by time and by decision on the event, not on the group', () => {
    const entries = [
      egress(1, 100, 'a.example', 'deny', { reason: 'not in allowlist' }),
      egress(2, 200, 'a.example', 'allow'),
      egress(3, 300, 'b.example', 'allow'),
    ];
    const since = aggregateNetworkLog(entries, { ...OPTS, since: 150 });
    expect(since.totals).toEqual({ allowed: 2, denied: 0, destinations: 2 });
    const denied = aggregateNetworkLog(entries, { ...OPTS, denied: true });
    expect(denied.totals).toEqual({ allowed: 0, denied: 1, destinations: 1 });
    expect(denied.entries[0]).toMatchObject({ host: 'a.example', count: 1, firstSeen: 100 });
  });

  it('counts the destinations of an overflow summary without time or method', () => {
    const r = aggregateNetworkLog(
      [
        egress(1, 10, 'a.example', 'deny', { reason: 'not in allowlist' }),
        row(2, 'network.egress.summary', 'info', {
          count: 300,
          fromEventTs: 20,
          toEventTs: 90,
          byHost: [
            { host: 'a.example', port: 443, decision: 'deny', count: 100 },
            { host: 'cdn.example', port: 443, decision: 'allow', count: 200 },
          ],
        }),
      ],
      OPTS,
    );
    expect(r.totals).toEqual({ allowed: 200, denied: 101, destinations: 2 });
    const a = r.entries.find((e) => e.host === 'a.example')!;
    expect(a).toMatchObject({ denied: 101, summarized: 100, firstSeen: 10, lastSeen: 90 });
    const denied = aggregateNetworkLog(
      [
        row(2, 'network.egress.summary', 'info', {
          fromEventTs: 20,
          toEventTs: 90,
          byHost: [{ host: 'cdn.example', port: 443, decision: 'allow', count: 200 }],
        }),
      ],
      { ...OPTS, denied: true },
    );
    expect(denied.entries).toEqual([]);
    // a summary that ended before `since` is out
    expect(
      aggregateNetworkLog(
        [
          row(2, 'network.egress.summary', 'info', {
            fromEventTs: 20,
            toEventTs: 90,
            byHost: [{ host: 'a.example', port: 443, decision: 'deny', count: 5 }],
          }),
        ],
        { ...OPTS, since: 100 },
      ).entries,
    ).toEqual([]);
  });

  it('limits the number of destinations and says so', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      egress(i + 1, i + 1, `h${i}.example`, 'deny', { reason: 'not in allowlist' }),
    );
    const r = aggregateNetworkLog(entries, { ...OPTS, limit: 10 });
    expect(r.entries).toHaveLength(10);
    expect(r.entries[0]!.host).toBe('h29.example');
    expect(r.totals.destinations).toBe(30);
    expect(r.truncated).toBe(true);
  });

  it('ignores malformed details instead of failing', () => {
    const r = aggregateNetworkLog(
      [
        row(1, 'network.egress', 'deny', {}),
        row(2, 'network.egress.summary', 'info', { byHost: 'nope' }),
        row(3, 'network.egress.summary', 'info', { byHost: [null, 3, { count: -1 }] }),
      ],
      OPTS,
    );
    expect(r.totals.denied).toBe(1);
    expect(r.entries[0]).toMatchObject({ host: '', port: 0 });
  });
});

describe('Abox.networkLog', () => {
  it('shows the proxy decisions of a sandbox, grouped, with reasons and what can be allowed', async () => {
    const a = await setup();
    const id = await newBox(a);
    const t = env.clock.t;
    fakeOf(env).addNetEvents(
      id,
      ev(t + 1, 'registry.npmjs.org', 'allow'),
      ev(t + 2, 'evil.example', 'deny', 'not in allowlist'),
      ev(t + 3, 'evil.example', 'deny', 'not in allowlist'),
      ev(t + 4, 'db.internal.example', 'deny', 'blocked address 10.0.0.9 (private network)'),
    );
    const log = await a.networkLog(HUMAN, id);
    expect(log.mode).toBe('allowlist');
    expect(log.totals).toEqual({ allowed: 1, denied: 3, destinations: 3 });
    const evil = log.entries.find((e) => e.host === 'evil.example')!;
    expect(evil).toMatchObject({
      decision: 'deny',
      denied: 2,
      count: 2,
      reasonKind: 'not_in_allowlist',
      allowedNow: false,
    });
    expect(evil.allow).toMatchObject({ possible: true, pattern: 'evil.example' });
    expect(log.entries.find((e) => e.host === 'db.internal.example')!.allow?.possible).toBe(false);
    expect(log.entries.find((e) => e.host === 'registry.npmjs.org')!.allowedNow).toBe(true);

    const onlyDenied = await a.networkLog(HUMAN, id, { denied: true });
    expect(onlyDenied.totals).toEqual({ allowed: 0, denied: 3, destinations: 2 });
    const recent = await a.networkLog(HUMAN, id, { since: t + 4 });
    expect(recent.entries.map((e) => e.host)).toEqual(['db.internal.example']);
    // never anything but host, port, method, reason: no request body, path, header or secret
    expect(JSON.stringify(log)).not.toMatch(/ghp_|authorization|cookie/i);
  });

  it('is still there when the sandbox is gone (it is the audit log)', async () => {
    const a = await setup();
    const id = await newBox(a);
    fakeOf(env).addNetEvents(id, ev(env.clock.t + 1, 'late.example', 'deny', 'not in allowlist'));
    await a.removeSandbox(HUMAN, id);
    const log = await a.networkLog(HUMAN, id);
    expect(log.entries.map((e) => e.host)).toEqual(['late.example']);
  });

  it('says what a sandbox without an allowlist has: nothing is logged, no actions', async () => {
    const a = await setup();
    const none = await newBox(a, HUMAN_YES, 'fake-box');
    const log = await a.networkLog(HUMAN, none);
    expect(log).toMatchObject({ mode: 'none', entries: [], totals: { destinations: 0 } });
    const open = created(
      await a.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { network: { mode: 'open' } },
      }),
    ).sandbox.id;
    expect((await a.networkLog(HUMAN, open)).mode).toBe('open');
  });

  it('an agent reads the log of its own sandboxes only', async () => {
    const a = await setup();
    const mine = await newBox(a, A);
    const theirs = await newBox(a, B);
    fakeOf(env).addNetEvents(mine, ev(env.clock.t + 1, 'mine.example', 'deny', 'not in allowlist'));
    fakeOf(env).addNetEvents(
      theirs,
      ev(env.clock.t + 1, 'theirs.example', 'deny', 'not in allowlist'),
    );
    expect((await a.networkLog(A, mine)).entries.map((e) => e.host)).toEqual(['mine.example']);
    await expect(a.networkLog(A, theirs)).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.networkLog(B, mine)).rejects.toMatchObject({ code: 'not_found' });
    // the human sees both
    expect((await a.networkLog(HUMAN, theirs)).entries).toHaveLength(1);
  });

  it('rejects bad options', async () => {
    const a = await setup();
    const id = await newBox(a);
    await expect(a.networkLog(HUMAN, id, { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(a.networkLog(HUMAN, id, { since: -1 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(a.networkLog(HUMAN, 'nonsense')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('looks at no more than the newest MAX_LOG_EVENTS entries and says it was cut', async () => {
    const a = await setup();
    const id = await newBox(a);
    const fake = fakeOf(env);
    const t = env.clock.t;
    // each collection writes at most 500 denials one by one: 21 rounds are more than the cap
    const rounds = Math.ceil(MAX_LOG_EVENTS / 500) + 1;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < 500; i++)
        fake.addNetEvents(
          id,
          ev(t + r * 1000 + i + 1, `h${r}-${i}.example`, 'deny', 'not in allowlist'),
        );
      await a.inspectSandbox(HUMAN, id);
    }
    const log = await a.networkLog(HUMAN, id, { limit: 1000 });
    expect(log.truncated).toBe(true);
    expect(log.maxEvents).toBe(MAX_LOG_EVENTS);
    expect(log.totals.denied).toBe(MAX_LOG_EVENTS);
    // the oldest destinations fell out, the newest are in
    expect(log.entries.some((e) => e.host === `h${rounds - 1}-499.example`)).toBe(true);
    expect(log.entries.some((e) => e.host === 'h0-0.example')).toBe(false);
  }, 120_000);
});

describe('Abox.allowNetwork ("allow once")', () => {
  it('adds the destination to this sandbox only: proxy updated, policy.yaml untouched, audited', async () => {
    const a = await setup();
    const id = await newBox(a);
    const other = await newBox(a);
    const before = policyText();
    const hashBefore = a.policyHash;
    fakeOf(env).addNetEvents(
      id,
      ev(env.clock.t + 1, 'api.good.example', 'deny', 'not in allowlist'),
    );
    const r = await a.allowNetwork(HUMAN, id, { destinations: ['api.good.example'] });
    expect(r.status).toBe('applied');
    expect(fakeOf(env).networkUpdates).toHaveLength(1);
    expect(fakeOf(env).networkUpdates[0]).toMatchObject({ id });
    expect(fakeOf(env).networkUpdates[0]!.allow).toContain('api.good.example');
    // this sandbox only
    expect((await a.inspectSandbox(HUMAN, id)).network.allow).toContain('api.good.example');
    expect((await a.inspectSandbox(HUMAN, other)).network.allow).not.toContain('api.good.example');
    // policy untouched
    expect(policyText()).toBe(before);
    expect(a.policyHash).toBe(hashBefore);
    // the log now shows it as allowed, nothing to offer
    const e = (await a.networkLog(HUMAN, id)).entries.find((x) => x.host === 'api.good.example')!;
    expect(e).toMatchObject({ allowedNow: true });
    expect(e.allow).toBeUndefined();
    // audit: the generic access entry and the log's own
    const audit = await a.queryAudit(HUMAN, { sandboxId: id, action: 'network.allow' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ decision: 'allow', actor: 'human' });
    expect(audit[0]!.details).toMatchObject({
      scope: 'sandbox',
      source: 'network_log',
      destinations: ['api.good.example'],
      wildcard: false,
    });
    expect(
      await a.queryAudit(HUMAN, { sandboxId: id, action: 'sandbox.access_applied' }),
    ).toHaveLength(1);
  });

  it('takes host:port, normalizes the name and says when nothing changes', async () => {
    const a = await setup();
    const id = await newBox(a);
    await a.allowNetwork(HUMAN, id, { destinations: ['API.Good.Example:8443'] });
    expect((await a.inspectSandbox(HUMAN, id)).network.allow).toContain('api.good.example:8443');
    const again = await a.allowNetwork(HUMAN, id, { destinations: ['api.good.example:8443'] });
    expect(again).toMatchObject({ status: 'applied', message: expect.stringMatching(/already/) });
    expect(fakeOf(env).networkUpdates).toHaveLength(1);
  });

  it.each([
    ['1.2.3.4', /IP address/],
    ['169.254.169.254', /IP address/],
    ['127.1', /IP address/],
    ['metadata.google.internal', /metadata/],
    ['*.internal.corp.internal', /internal/],
    ['printer.local', /internal/],
    ['foo.localhost', /internal/],
    ['*.lan', /not a valid/],
    ['*', /not a valid/],
    ['*.com', /not a valid/],
    ['https://evil.example/path', /not a valid/],
    ['localhost', /not a valid/],
    ['evil.example:99999', /not a valid/],
  ])('refuses %s', async (destination, why) => {
    const a = await setup();
    const id = await newBox(a);
    const err = await a
      .allowNetwork(HUMAN_YES, id, { destinations: [destination] })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'invalid_input' });
    expect(String(err.message)).toMatch(why);
    expect(fakeOf(env).networkUpdates).toHaveLength(0);
    // refusals are audited
    const audit = await a.queryAudit(HUMAN, { sandboxId: id, action: 'network.allow' });
    expect(audit[0]).toMatchObject({ decision: 'deny' });
  });

  it('refuses a name the log shows resolving to a private address', async () => {
    const a = await setup();
    const id = await newBox(a);
    fakeOf(env).addNetEvents(
      id,
      ev(
        env.clock.t + 1,
        'nas.example.org',
        'deny',
        'blocked address 192.168.1.5 (private network)',
      ),
    );
    const err = await a
      .allowNetwork(HUMAN_YES, id, { destinations: ['nas.example.org'] })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'policy_denied' });
    expect(String(err.message)).toMatch(/private-address exception/);
    expect(fakeOf(env).networkUpdates).toHaveLength(0);
  });

  it('explains a sandbox without an allowlist instead of pretending', async () => {
    const a = await setup();
    const none = await newBox(a, HUMAN_YES, 'fake-box');
    const err = await a
      .allowNetwork(HUMAN, none, { destinations: ['a.example.org'] })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'unsupported' });
    expect(String(err.message)).toMatch(/network of sandbox .* is off/);
    expect(String(err.hint)).toMatch(/allowlist/);
    const open = created(
      await a.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { network: { mode: 'open' } },
      }),
    ).sandbox.id;
    await expect(
      a.allowNetwork(HUMAN, open, { destinations: ['a.example.org'] }),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('a wildcard needs an explicit confirmation, the exact host does not', async () => {
    const a = await setup();
    const id = await newBox(a);
    const first = await a.allowNetwork(HUMAN, id, { destinations: ['*.good.example'] });
    expect(first.status).toBe('confirmation_required');
    if (first.status !== 'confirmation_required') return;
    expect(first.reasons.join(' ')).toMatch(/every subdomain of good\.example/);
    expect(first.risks.join(' ')).toMatch(/Prefer the exact host/);
    expect(fakeOf(env).networkUpdates).toHaveLength(0);
    const second = await a.allowNetwork(HUMAN_YES, id, { destinations: ['*.good.example'] });
    expect(second.status).toBe('applied');
    expect((await a.inspectSandbox(HUMAN, id)).network.allow).toContain('*.good.example');
    const audit = await a.queryAudit(HUMAN, { sandboxId: id, action: 'network.allow' });
    expect(audit[0]!.details).toMatchObject({ wildcard: true });
  });

  it('is for humans: an agent is refused, audited, and pointed to access_request', async () => {
    const a = await setup();
    const id = await newBox(a, A);
    const err = await a.allowNetwork(A, id, { destinations: ['api.good.example'] }).catch((e) => e);
    expect(err).toMatchObject({ code: 'policy_denied' });
    expect(String(err.hint)).toMatch(/access_request/);
    expect(fakeOf(env).networkUpdates).toHaveLength(0);
    const audit = await a.queryAudit(HUMAN, { action: 'network.allow' });
    expect(audit[0]).toMatchObject({ decision: 'deny', actor: 'agent:agent-a' });
    // not even for its own sandbox, and nothing on another agent's
    await expect(
      a.allowNetwork(B, id, { destinations: ['api.good.example'] }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(
      a.proposeNetworkPolicy(A, id, { destinations: ['api.good.example'] }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('keeps unknown fields and empty lists out', async () => {
    const a = await setup();
    const id = await newBox(a);
    await expect(a.allowNetwork(HUMAN, id, { destinations: [] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      a.allowNetwork(HUMAN, id, { destinations: ['a.example.org'], extra: 1 } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('Abox.proposeNetworkPolicy ("allow permanently")', () => {
  it('proposes adding the destination to the profile of the owner and saves through setPolicy (revisioned)', async () => {
    const a = await setup();
    const id = await newBox(a, A);
    const p = await a.proposeNetworkPolicy(HUMAN, id, {
      destinations: ['api.good.example', 'registry.npmjs.org'],
    });
    expect(p).toMatchObject({
      context: 'agent-a',
      profile: 'agent',
      added: ['api.good.example'],
      alreadyAllowed: ['registry.npmjs.org'], // a preset of the profile
    });
    expect(p.usedBy).toEqual(expect.arrayContaining(['agent-a', 'agent-b']));
    expect(p.usedBy).not.toContain('strict-agent'); // profile `strict` extends agent, it is another profile
    expect(p.baseHash).toBe(a.policyHash);
    // nothing was written
    expect(policyText()).toBe(p.current);
    const proposed = p.proposed!;
    expect(proposed).toContain('allow: [api.good.example]');
    // exactly one line changed
    const was = p.current.split('\n');
    const now = proposed.split('\n');
    expect(now).toHaveLength(was.length);
    expect(now.filter((l, i) => l !== was[i])).toHaveLength(1);

    const before = (await a.listPolicyRevisions(HUMAN))[0]!.rev;
    const set = await a.setPolicy(HUMAN, proposed, { baseHash: p.baseHash });
    expect(set.revision).toBe(before + 1);
    expect(set.changed).toBe(true);
    expect(policyText()).toBe(proposed);
    // a second proposal sees it as allowed now
    const again = await a.proposeNetworkPolicy(HUMAN, id, { destinations: ['api.good.example'] });
    expect(again).toMatchObject({
      added: [],
      alreadyAllowed: ['api.good.example'],
      proposed: null,
    });
    // and the agent can now ask for it without a human decision
    const sb = await newBox(a, A);
    const asked = await a.accessRequest(A, sb, {
      kind: 'network',
      details: { domains: ['api.good.example'] },
    });
    expect(asked.status).toBe('applied');
  });

  it('a save on a policy that changed since the proposal is refused', async () => {
    const a = await setup();
    const id = await newBox(a, A);
    const p = await a.proposeNetworkPolicy(HUMAN, id, { destinations: ['api.good.example'] });
    await a.setPolicy(HUMAN, `${p.current}\n# edited meanwhile\n`);
    await expect(a.setPolicy(HUMAN, p.proposed!, { baseHash: p.baseHash })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('uses the same refusals as allow once', async () => {
    const a = await setup();
    const id = await newBox(a, A);
    await expect(
      a.proposeNetworkPolicy(HUMAN, id, { destinations: ['169.254.169.254'] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const none = await newBox(a, HUMAN_YES, 'fake-box');
    await expect(
      a.proposeNetworkPolicy(HUMAN, none, { destinations: ['api.good.example'] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('a human-owned sandbox: the built-in human profile allows everything, so nothing to change', async () => {
    const a = await setup();
    const id = await newBox(a);
    const p = await a.proposeNetworkPolicy(HUMAN, id, { destinations: ['api.good.example'] });
    expect(p).toMatchObject({ context: 'human', profile: 'human', added: [], proposed: null });
    expect(p.alreadyAllowed).toEqual(['api.good.example']);
  });
});

describe('exec reports what the proxy denied while the command ran', () => {
  it('adds the denied destinations, most frequent first, only when there were denials', async () => {
    const a = await setup();
    const id = await newBox(a);
    const quiet = await a.exec(HUMAN, id, { argv: ['true'] });
    expect(quiet.status === 'completed' && quiet.network).toBeFalsy();
    const t = env.clock.t;
    fakeOf(env).addNetEvents(
      id,
      ev(t + 1, 'registry.example.org', 'deny', 'not in allowlist'),
      ev(t + 2, 'registry.example.org', 'deny', 'not in allowlist'),
      ev(t + 3, 'other.example.org', 'deny', 'not in allowlist'),
      ev(t + 4, 'registry.npmjs.org', 'allow'),
    );
    const r = await a.exec(HUMAN, id, { argv: ['true'] });
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    expect(r.network).toEqual({
      denied: 3,
      hosts: [
        { host: 'registry.example.org', port: 443, count: 2 },
        { host: 'other.example.org', port: 443, count: 1 },
      ],
      moreHosts: 0,
    });
    // the next command does not repeat it
    const next = await a.exec(HUMAN, id, { argv: ['true'] });
    expect(next.status === 'completed' && next.network).toBeFalsy();
  });

  it('counts denials of a flood that was summarized and caps the host list', async () => {
    const a = await setup();
    const id = await newBox(a);
    const t = env.clock.t;
    for (let i = 0; i < 700; i++)
      fakeOf(env).addNetEvents(
        id,
        ev(t + 1 + i, `h${i % 8}.example.org`, 'deny', 'not in allowlist'),
      );
    const r = await a.exec(HUMAN, id, { argv: ['true'] });
    if (r.status !== 'completed') throw new Error('not completed');
    expect(r.network?.denied).toBe(700);
    expect(r.network?.hosts).toHaveLength(5);
    expect(r.network?.moreHosts).toBe(3);
  });
});
