import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox, NetworkEvent } from '@abox/core';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let a: Connected;
let b: Connected;

const HUMAN = { contextId: 'human' };

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, { fake: { networkEvents: true, updateNetwork: true } });
  a = await connect(abox, 'agent-a');
  b = await connect(abox, 'agent-b');
});
afterEach(async () => {
  await a.close();
  await b.close();
  abox.close();
  env.cleanup();
});

const ev = (
  host: string,
  decision: 'allow' | 'deny',
  reason?: string,
  port = 443,
  ts = Date.now(),
): NetworkEvent => ({
  ts,
  host,
  port,
  method: 'CONNECT',
  decision,
  ...(reason ? { reason } : {}),
});

async function newNet(c: Connected, template = 'fake-net'): Promise<string> {
  const r = await c.call('sandbox_create', {
    template,
    request_id: `r-${Math.random().toString(36).slice(2)}`,
    workspace: { mode: 'empty' },
  });
  expect(r.isError, r.text).toBe(false);
  return (r.s['sandbox'] as { id: string }).id;
}

describe('sandbox_network_log', () => {
  it('lists the destinations of the own sandbox with counts, reasons and how to ask', async () => {
    const id = await newNet(a);
    env.fakes[0]!.addNetEvents(
      id,
      ev('registry.npmjs.org', 'allow'),
      ev('pypi.example.org', 'deny', 'not in allowlist'),
      ev('pypi.example.org', 'deny', 'not in allowlist'),
      ev('nas.example.org', 'deny', 'blocked address 192.168.1.5 (private network)'),
    );
    const r = await a.call('sandbox_network_log', { id });
    expect(r.isError, r.text).toBe(false);
    expect(r.s['mode']).toBe('allowlist');
    expect(r.s['totals']).toEqual({ allowed: 1, denied: 3, destinations: 3 });
    const entries = r.s['entries'] as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const pypi = entries.find((e) => e['host'] === 'pypi.example.org')!;
    expect(pypi).toMatchObject({
      port: 443,
      decision: 'deny',
      denied: 2,
      count: 2,
      reason: 'not in allowlist',
      reason_kind: 'not_in_allowlist',
      can_request: true,
      request_domain: 'pypi.example.org',
    });
    expect(typeof pypi['first_seen_at']).toBe('string'); // ISO timestamp
    const nas = entries.find((e) => e['host'] === 'nas.example.org')!;
    expect(nas['can_request']).toBe(false);
    expect(String(nas['why_not'])).toMatch(/private-address exception/);
    expect(r.text).toContain('access_request kind=network domains=["pypi.example.org"]');
    expect(r.text).toContain('cannot be requested');
    // the registry is allowed: no advice
    const npm = entries.find((e) => e['host'] === 'registry.npmjs.org')!;
    expect(npm['can_request']).toBeUndefined();
    expect(npm['allowed_now']).toBe(true);
  });

  it('filters: denied only, a time window, a limit', async () => {
    const id = await newNet(a);
    const now = Date.now();
    env.fakes[0]!.addNetEvents(
      id,
      ev('one.example.org', 'deny', 'not in allowlist', 443, now + 1),
      ev('two.example.org', 'deny', 'not in allowlist', 443, now + 2),
      ev('registry.npmjs.org', 'allow', undefined, 443, now + 3),
    );
    const denied = await a.call('sandbox_network_log', { id, denied: true });
    expect((denied.s['entries'] as unknown[]).length).toBe(2);
    expect((await a.call('sandbox_network_log', { id, since: '1h' })).s['totals']).toMatchObject({
      destinations: 3,
    });
    expect((await a.call('sandbox_network_log', { id, since: '1s' })).s['totals']).toMatchObject({
      destinations: 3,
    });
    expect((await a.call('sandbox_network_log', { id, since: 'soon' })).s['code']).toBe(
      'invalid_input',
    );
    const one = await a.call('sandbox_network_log', { id, limit: 1 });
    expect((one.s['entries'] as unknown[]).length).toBe(1);
    expect(one.s['truncated']).toBe(true);
  });

  it('says plainly when the sandbox has no allowlist', async () => {
    const id = await newNet(a, 'fake-box');
    const r = await a.call('sandbox_network_log', { id });
    expect(r.isError).toBe(false);
    expect(r.s['mode']).toBe('none');
    expect(r.s['message']).toMatch(/Network is off/);
    expect(r.s['entries']).toEqual([]);
  });

  it('reads own sandboxes only: a foreign or unknown id is not_found', async () => {
    const mine = await newNet(a);
    const theirs = await newNet(b);
    env.fakes[0]!.addNetEvents(theirs, ev('secret-host.example.org', 'deny', 'not in allowlist'));
    const foreign = await a.call('sandbox_network_log', { id: theirs });
    expect(foreign.isError).toBe(true);
    expect(foreign.s['code']).toBe('not_found');
    expect(foreign.text).not.toContain('secret-host');
    expect((await a.call('sandbox_network_log', { id: 'local/00000000' })).s['code']).toBe(
      'not_found',
    );
    expect((await a.call('sandbox_network_log', { id: mine })).isError).toBe(false);
  });

  it('takes strict input: unknown or mistyped parameters are errors', async () => {
    const id = await newNet(a);
    for (const args of [
      { id, bogus: 1 },
      { id, limit: 0 },
      { id, limit: 5000 },
      { id, denied: 'yes' },
      { id, since: '' },
      { id, allow: ['x.example.org'] },
    ]) {
      const r = await a.call('sandbox_network_log', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.s['code']).toBe('invalid_input');
    }
  });

  it('is a read: it changes neither the allowlist nor the policy, and an agent can not allow anything', async () => {
    const id = await newNet(a);
    env.fakes[0]!.addNetEvents(id, ev('pypi.example.org', 'deny', 'not in allowlist'));
    await a.call('sandbox_network_log', { id });
    expect(env.fakes[0]!.networkUpdates).toHaveLength(0);
    // there is no tool that allows: the only way is access_request, which a human decides beyond the profile
    const tools = (await a.client.listTools()).tools.map((t) => t.name);
    expect(tools.filter((t) => /allow|network/.test(t))).toEqual(['sandbox_network_log']);
    const ask = await a.call('access_request', {
      id,
      kind: 'network',
      details: { domains: ['pypi.example.org'] },
      reason: 'needs the package index',
    });
    expect(ask.s['status']).toBe('pending_approval');
    expect(env.fakes[0]!.networkUpdates).toHaveLength(0);
    // the human decides, the log then shows the destination as allowed
    await abox.approve(HUMAN, String(ask.s['approval_id']), 'ok');
    expect(env.fakes[0]!.networkUpdates).toHaveLength(1);
    const after = await a.call('sandbox_network_log', { id });
    const e = (after.s['entries'] as Array<Record<string, unknown>>).find(
      (x) => x['host'] === 'pypi.example.org',
    )!;
    expect(e['allowed_now']).toBe(true);
    expect(e['can_request']).toBeUndefined();
  });
});

describe('sandbox_exec reports denied network requests', () => {
  it('ends with a concise hint that names the destination and access_request', async () => {
    const id = await newNet(a);
    const fake = env.fakes[0]!;
    const ts = Date.now();
    fake.addNetEvents(
      id,
      ev('registry.example.org', 'deny', 'not in allowlist', 443, ts + 1),
      ev('registry.example.org', 'deny', 'not in allowlist', 443, ts + 2),
    );
    const r = await a.call('sandbox_exec', { id, argv: ['true'] });
    expect(r.isError, r.text).toBe(false);
    expect(r.s['network_hint']).toBe(
      'network: 2 requests to registry.example.org denied; ask with access_request kind=network (details.domains) or check sandbox_network_log',
    );
    expect(r.s['network']).toEqual({
      denied: 2,
      hosts: [{ host: 'registry.example.org', port: 443, count: 2 }],
      more_hosts: 0,
    });
    expect(r.text).toContain('[network: 2 requests to registry.example.org denied;');
    // quiet commands have no such field
    const quiet = await a.call('sandbox_exec', { id, argv: ['true'] });
    expect(quiet.s['network_hint']).toBeUndefined();
  });

  it('names at most three destinations, the others as a number, and a non-default port', async () => {
    const id = await newNet(a);
    const ts = Date.now();
    env.fakes[0]!.addNetEvents(
      id,
      ...['a', 'b', 'c', 'd', 'e'].map((h, i) =>
        ev(`${h}.example.org`, 'deny', 'not in allowlist', i === 0 ? 8443 : 443, ts + i + 1),
      ),
    );
    const r = await a.call('sandbox_exec', { id, argv: ['true'] });
    expect(r.s['network_hint']).toMatch(
      /^network: 5 requests to a\.example\.org:8443, b\.example\.org, c\.example\.org and 2 more denied;/,
    );
  });
});
