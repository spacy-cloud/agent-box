import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccessResult,
  Caller,
  NetworkAllowInput,
  NetworkLogOptions,
  NetworkLogView,
  NetworkPolicyProposal,
} from '@abox/core';
import type { AboxRuntime } from '@abox/runtime';
import { makeEnv, run, type RunResult, type TestEnv } from './harness.js';
import { denialNote } from '../commands/network.js';

/**
 * What `abox network ...` prints, asks and passes on, against a stub manager. The manager's own rules (what can be
 * allowed, the log aggregation, the policy edit) are tested in packages/core; the real engine in packages/e2e.
 */
const ID = 'local/1a2b3c4d';
const NOW = Date.parse('2026-10-18T10:00:00');

const LOG: NetworkLogView = {
  sandboxId: ID,
  mode: 'allowlist',
  totals: { allowed: 4, denied: 5, destinations: 3 },
  truncated: false,
  maxEvents: 10_000,
  entries: [
    {
      host: 'registry.example.org',
      port: 443,
      decision: 'deny',
      allowed: 0,
      denied: 3,
      count: 3,
      firstSeen: NOW - 60_000,
      lastSeen: NOW,
      reason: 'not in allowlist',
      reasonKind: 'not_in_allowlist',
      methods: ['CONNECT'],
      summarized: 0,
      allowedNow: false,
      allow: {
        possible: true,
        pattern: 'registry.example.org',
        wildcard: '*.example.org',
      },
    },
    {
      host: 'nas.example.org',
      port: 443,
      decision: 'deny',
      allowed: 0,
      denied: 2,
      count: 2,
      firstSeen: NOW - 90_000,
      lastSeen: NOW - 30_000,
      reason: 'blocked address 192.168.1.5 (private network)',
      reasonKind: 'blocked_address',
      methods: ['CONNECT'],
      summarized: 0,
      allowedNow: false,
      allow: { possible: false, why: 'the name resolves to a private address' },
    },
    {
      host: 'registry.npmjs.org',
      port: 443,
      decision: 'allow',
      allowed: 4,
      denied: 0,
      count: 4,
      firstSeen: NOW - 120_000,
      lastSeen: NOW - 10_000,
      methods: ['CONNECT'],
      summarized: 0,
      allowedNow: true,
    },
  ],
};

const APPLIED = (message = 'allowlist now has 3 destination(s)'): AccessResult =>
  ({ status: 'applied', kind: 'network', sandbox: {} as never, message }) as AccessResult;

interface Stub {
  calls: Array<{ op: string; caller?: Caller; args: unknown[] }>;
  rt: AboxRuntime;
}

function stub(
  o: {
    log?: NetworkLogView;
    proposal?: NetworkPolicyProposal;
    wildcardNeedsConfirmation?: boolean;
  } = {},
): Stub {
  const calls: Stub['calls'] = [];
  const abox = {
    networkLog: (caller: Caller, id: string, opts: NetworkLogOptions) => {
      calls.push({ op: 'log', caller, args: [id, opts] });
      return Promise.resolve(o.log ?? LOG);
    },
    allowNetwork: (caller: Caller, id: string, input: NetworkAllowInput) => {
      calls.push({ op: 'allow', caller, args: [id, input] });
      if (
        (o.wildcardNeedsConfirmation ?? true) &&
        input.destinations.some((d) => d.startsWith('*.')) &&
        !caller.humanConfirmed
      )
        return Promise.resolve({
          status: 'confirmation_required',
          reasons: ['*.example.org allows every subdomain of example.org'],
          risks: ['Prefer the exact host.'],
          items: [],
          message: 'confirm',
        } as AccessResult);
      return Promise.resolve(APPLIED());
    },
    proposeNetworkPolicy: (caller: Caller, id: string, input: NetworkAllowInput) => {
      calls.push({ op: 'propose', caller, args: [id, input] });
      return Promise.resolve(
        o.proposal ?? {
          context: 'agent-a',
          profile: 'agent',
          usedBy: ['agent-a', 'agent-b'],
          added: input.destinations,
          alreadyAllowed: [],
          baseHash: 'base-hash',
          current: 'profiles:\n  agent:\n    network: { allow: [] }\n',
          proposed: `profiles:\n  agent:\n    network: { allow: [${input.destinations.join(', ')}] }\n`,
        },
      );
    },
    setPolicy: (caller: Caller, text: string, opts: { baseHash?: string }) => {
      calls.push({ op: 'setPolicy', caller, args: [text, opts] });
      return Promise.resolve({ revision: 7, changed: true, contentHash: 'abcdef0123456789aaaa' });
    },
  };
  const rt = {
    abox,
    caller: { contextId: 'human' },
    paths: { policyFile: '/tmp/abox-test/policy.yaml' },
    close: () => Promise.resolve(),
  } as unknown as AboxRuntime;
  return { calls, rt };
}

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

const net = (
  s: Stub,
  args: string[],
  o: { tty?: boolean; stdin?: string } = {},
): Promise<RunResult> =>
  run(t, ['network', ...args], { ...o, openRuntime: () => Promise.resolve(s.rt) });

describe('abox network log', () => {
  it('prints a table by destination with the reason, and how to allow what can be allowed', async () => {
    const s = stub();
    const r = await net(s, ['log', ID]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('5 denied, 4 allowed request(s) to 3 destination(s)');
    expect(r.stdout).toMatch(/DESTINATION\s+DECISION\s+DENIED\s+ALLOWED\s+LAST SEEN\s+REASON/);
    expect(r.stdout).toMatch(
      /registry\.example\.org\s+denied\s+3\s+0\s+\S+ \S+\s+not in allowlist/,
    );
    expect(r.stdout).toMatch(/registry\.npmjs\.org\s+allowed\s+0\s+4/);
    expect(r.stdout).toContain(`abox network allow ${ID} registry.example.org`);
    expect(r.stdout).toContain("'*.example.org'");
    expect(r.stdout).toContain('--permanent');
    expect(r.stdout).toContain(
      'cannot be allowed here: nas.example.org: the name resolves to a private address',
    );
    expect(s.calls[0]).toMatchObject({ op: 'log', args: [ID, { limit: 200 }] });
  });

  it('passes --denied, --since and --limit on', async () => {
    const s = stub();
    const before = Date.now();
    const r = await net(s, ['log', ID, '--denied', '--since', '10m', '--limit', '5']);
    expect(r.code, r.stderr).toBe(0);
    const opts = s.calls[0]!.args[1] as NetworkLogOptions;
    expect(opts.denied).toBe(true);
    expect(opts.limit).toBe(5);
    expect(opts.since!).toBeGreaterThan(before - 10 * 60_000 - 5000);
    expect(opts.since!).toBeLessThan(Date.now() - 10 * 60_000 + 5000);
  });

  it('--json prints the view as it is', async () => {
    const r = await net(stub(), ['log', ID, '--json']);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.totals).toEqual(LOG.totals);
    expect(r.json.data.entries[0]).toMatchObject({
      host: 'registry.example.org',
      reasonKind: 'not_in_allowlist',
      allow: { possible: true, pattern: 'registry.example.org' },
    });
  });

  it('explains a sandbox without an allowlist', async () => {
    const none = await net(stub({ log: { ...LOG, mode: 'none', entries: [] } }), ['log', ID]);
    expect(none.stdout).toContain('the network is off (mode none)');
    const open = await net(stub({ log: { ...LOG, mode: 'open', entries: [] } }), ['log', ID]);
    expect(open.stdout).toContain('the network is open');
    const empty = await net(stub({ log: { ...LOG, entries: [] } }), ['log', ID]);
    expect(empty.stdout).toContain('no network requests in the log');
  });

  it('rejects bad options with exit code 2', async () => {
    const s = stub();
    expect((await net(s, ['log', ID, '--limit', '0'])).code).toBe(2);
    expect((await net(s, ['log', ID, '--since', 'yesterday-ish'])).code).toBe(2);
    expect(s.calls).toHaveLength(0);
  });

  it('documents itself in --help', async () => {
    const h = await run(t, ['network', 'log', '--help']);
    expect(h.stdout).toContain('--denied');
    expect(h.stdout).toContain('--since <when>');
    const top = await run(t, ['--help']);
    expect(top.stdout).toContain('network');
  });
});

describe('abox network allow (once)', () => {
  it('allows for the sandbox only and says that the policy is unchanged', async () => {
    const s = stub();
    const r = await net(s, ['allow', ID, 'registry.example.org']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('allowlist now has 3 destination(s)');
    expect(r.stdout).toContain('this sandbox only; policy.yaml unchanged');
    expect(s.calls.map((c) => c.op)).toEqual(['allow']);
    expect(s.calls[0]!.args).toEqual([ID, { destinations: ['registry.example.org'] }]);
    expect(s.calls[0]!.caller).toEqual({ contextId: 'human' });
  });

  it('takes several destinations and --json', async () => {
    const s = stub();
    const r = await net(s, ['allow', ID, 'a.example.org', 'b.example.org:8443', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.data.destinations).toEqual(['a.example.org', 'b.example.org:8443']);
    expect(r.json.data.access.status).toBe('applied');
    expect(r.json.data.policy).toBeUndefined();
  });

  it('a wildcard shows its risks and needs a yes (exit 3 without a terminal)', async () => {
    const s = stub();
    const no = await net(s, ['allow', ID, '*.example.org', '--json']);
    expect(no.code).toBe(3);
    expect(no.json).toMatchObject({ ok: false, code: 'approval_required' });
    expect(no.json.details.reasons[0]).toMatch(/every subdomain of example\.org/);
    expect(s.calls.map((c) => [c.op, c.caller?.humanConfirmed ?? false])).toEqual([
      ['allow', false],
    ]);

    const asked = await net(stub(), ['allow', ID, '*.example.org'], { tty: true, stdin: 'y\n' });
    expect(asked.code, asked.stderr).toBe(0);
    expect(asked.stderr).toContain('Confirmation required');
    expect(asked.stderr).toContain('Prefer the exact host');
    const declined = await net(stub(), ['allow', ID, '*.example.org'], { tty: true, stdin: 'n\n' });
    expect(declined.code).toBe(3);

    const s2 = stub();
    const yes = await net(s2, ['allow', ID, '*.example.org', '--yes']);
    expect(yes.code, yes.stderr).toBe(0);
    expect(s2.calls.map((c) => [c.op, c.caller?.humanConfirmed ?? false])).toEqual([
      ['allow', false],
      ['allow', true],
    ]);
  });
});

describe('abox network allow --permanent', () => {
  it('shows the policy diff, asks, saves with the base hash, then allows the sandbox', async () => {
    const s = stub();
    const r = await net(s, ['allow', ID, 'registry.example.org', '--permanent'], {
      tty: true,
      stdin: 'y\n',
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/profile:\s+agent \(used by: agent-a, agent-b\)/);
    expect(r.stdout).toMatch(/network\.allow \+:\s+registry\.example\.org/);
    expect(r.stdout).toContain('-    network: { allow: [] }');
    expect(r.stdout).toContain('+    network: { allow: [registry.example.org] }');
    expect(r.stderr).toContain(
      'Save this policy (affects every sandbox and agent that uses profile "agent")? [y/N]',
    );
    expect(r.stdout).toContain('policy saved (revision 7');
    expect(s.calls.map((c) => c.op)).toEqual(['propose', 'setPolicy', 'allow']);
    expect(s.calls[1]!.args[1]).toEqual({ baseHash: 'base-hash' });
    expect(String(s.calls[1]!.args[0])).toContain('allow: [registry.example.org]');
  });

  it('writes nothing when declined, and not without a terminal or --yes', async () => {
    const declined = stub();
    const no = await net(declined, ['allow', ID, 'registry.example.org', '--permanent'], {
      tty: true,
      stdin: 'n\n',
    });
    expect(no.code).toBe(0);
    expect(no.stdout).toContain('not saved');
    expect(declined.calls.map((c) => c.op)).toEqual(['propose']);

    const headless = stub();
    const r = await net(headless, ['allow', ID, 'registry.example.org', '--permanent', '--json']);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: 'approval_required' });
    expect(headless.calls.map((c) => c.op)).toEqual(['propose']);

    const yes = stub();
    const ok = await net(yes, [
      'allow',
      ID,
      'registry.example.org',
      '--permanent',
      '--yes',
      '--json',
    ]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.json.data.policy).toMatchObject({ revision: 7 });
    expect(ok.json.data.access.status).toBe('applied');
    expect(yes.calls.map((c) => c.op)).toEqual(['propose', 'setPolicy', 'allow']);
  });

  it('leaves the policy alone when the profile already allows it', async () => {
    const s = stub({
      proposal: {
        context: 'agent-a',
        profile: 'agent',
        usedBy: ['agent-a'],
        added: [],
        alreadyAllowed: ['registry.npmjs.org'],
        baseHash: 'h',
        current: 'x',
        proposed: null,
      },
    });
    const r = await net(s, ['allow', ID, 'registry.npmjs.org', '--permanent']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('profile "agent" already allows registry.npmjs.org');
    expect(s.calls.map((c) => c.op)).toEqual(['propose', 'allow']);
  });
});

describe('abox exec: denied network requests', () => {
  it('denialNote names at most three destinations and the way on', () => {
    expect(
      denialNote(ID, {
        denied: 7,
        hosts: [
          { host: 'a.example.org', port: 443, count: 3 },
          { host: 'b.example.org', port: 8080, count: 2 },
          { host: 'c.example.org', port: 443, count: 1 },
          { host: 'd.example.org', port: 443, count: 1 },
        ],
        moreHosts: 2,
      }),
    ).toBe(
      `network: 7 requests to a.example.org, b.example.org:8080, c.example.org and 3 more denied; see "abox network log ${ID} --denied", allow with "abox network allow ${ID} <domain>"`,
    );
    expect(
      denialNote(ID, {
        denied: 1,
        hosts: [{ host: 'x.example.org', port: 443, count: 1 }],
        moreHosts: 0,
      }),
    ).toMatch(/^network: 1 request to x\.example\.org denied;/);
  });
});
