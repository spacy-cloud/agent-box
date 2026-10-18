/**
 * The network log and "allow" (issue #16) against the real Docker engine and the real egress proxy.
 * No internet: the allowed destination is a local upstream container on the proxy's egress network
 * (see upstream.ts), reached through an approved private-address exception; the "foreign" destination is a
 * second name of the same container that the sandbox's allowlist does not contain.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePaths } from '@abox/core';
import {
  A,
  B,
  DOCKER,
  HUMAN,
  RUN,
  createApproved,
  e2ePolicy,
  errorOf,
  makeEnv,
  openAbox,
  sh,
  sweepE2E,
  warmProxy,
  writePolicy,
  type Ctx,
  type Env,
} from './harness.js';
import { OTHER_HOST, UPSTREAM_HOST, startUpstream, type Upstream } from './upstream.js';

const THIRD_HOST = `third-${RUN}.e2e.test`;

describe.skipIf(!DOCKER)('network log and allow (real Docker + egress proxy)', () => {
  let env: Env;
  let ctx: Ctx;
  let up: Upstream;
  let id = '';
  const policyFile = (): string => resolvePaths(env.env).policyFile;
  const policyText = (): string => readFileSync(policyFile(), 'utf8');

  /** HTTP status of a request through the sandbox's proxy; `000` when the proxy refused. */
  async function status(
    url: string,
  ): Promise<{ http: string; denied: ReturnType<typeof deniedOf> }> {
    const r = await sh(
      ctx,
      A,
      id,
      `curl -sS -m 15 -o /dev/null -w 'HTTP=%{http_code}' '${url}' 2>/dev/null; echo " EXIT=$?"`,
      { timeoutMs: 40_000 },
    );
    return { http: /HTTP=(\d+)/.exec(r.stdout)?.[1] ?? '?', denied: deniedOf(r.network) };
  }
  const deniedOf = (n: { denied: number; hosts: Array<{ host: string }> } | undefined) =>
    n ? { count: n.denied, hosts: n.hosts.map((h) => h.host) } : undefined;

  beforeAll(async () => {
    up = await startUpstream();
    env = makeEnv();
    ctx = await openAbox(env, {
      // the profile of agent-a/-b allows the upstream, not OTHER_HOST and not THIRD_HOST
      policy: e2ePolicy(env).replace(
        'allow: [example.com] }',
        `allow: [example.com, ${UPSTREAM_HOST}] }`,
      ),
    });
    await ctx.abox.buildTemplate(HUMAN, 'e2e-net');
    await warmProxy(ctx);
    id = (
      await createApproved(ctx, A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: {
          network: {
            mode: 'allowlist',
            allow: [UPSTREAM_HOST],
            // the upstream container has a private address: an exception a human approved
            privateExceptions: [`${up.ip}/32`],
          },
        },
      })
    ).sandbox.id;
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
    await up?.stop();
    await sweepE2E();
    env?.cleanup();
  }, 120_000);

  it('logs an allowed and a denied destination with the right decisions, and exec reports the denial', async () => {
    const ok = await status(`http://${UPSTREAM_HOST}/headers`);
    expect(ok.http).toBe('200');
    expect(ok.denied).toBeUndefined();

    const no = await status(`http://${OTHER_HOST}/headers`);
    expect(no.http).toBe('403');
    // what the command ran into is part of its result
    expect(no.denied).toEqual({ count: 1, hosts: [OTHER_HOST] });
    // https (CONNECT) and a direct IP are denied as well
    await status(`https://${OTHER_HOST}/headers`);
    await status('http://203.0.113.9/');

    const log = await ctx.abox.networkLog(HUMAN, id);
    expect(log.mode).toBe('allowlist');
    const by = (host: string, port: number) =>
      log.entries.find((e) => e.host === host && e.port === port);

    expect(by(UPSTREAM_HOST, 80)).toMatchObject({
      decision: 'allow',
      allowed: 1,
      denied: 0,
      methods: ['GET'],
      allowedNow: true,
    });
    expect(by(UPSTREAM_HOST, 80)!.allow).toBeUndefined();

    expect(by(OTHER_HOST, 80)).toMatchObject({
      decision: 'deny',
      denied: 1,
      reason: 'not in allowlist',
      reasonKind: 'not_in_allowlist',
      methods: ['GET'],
      allowedNow: false,
      allow: { possible: true, pattern: OTHER_HOST },
    });
    expect(by(OTHER_HOST, 443)).toMatchObject({
      decision: 'deny',
      reason: 'not in allowlist',
      methods: ['CONNECT'],
    });
    const ip = by('203.0.113.9', 80)!;
    expect(ip).toMatchObject({ decision: 'deny', reasonKind: 'ip_literal' });
    expect(ip.allow?.possible).toBe(false);
    expect(ip.allow?.why).toMatch(/IP address/);

    const onlyDenied = await ctx.abox.networkLog(HUMAN, id, { denied: true });
    expect(onlyDenied.totals.allowed).toBe(0);
    expect(onlyDenied.entries.map((e) => e.host)).not.toContain(UPSTREAM_HOST);
    // nothing but host, port, method, reason: no path, header or body ever reached the log
    expect(JSON.stringify(log)).not.toMatch(/\/headers|user-agent|curl/i);
    // the same entries are in the audit log
    const audit = await ctx.abox.queryAudit(HUMAN, {
      sandboxId: id,
      action: 'network.egress',
      decision: 'deny',
      limit: 50,
    });
    expect(audit.map((e) => e.details?.['host'])).toEqual(
      expect.arrayContaining([OTHER_HOST, '203.0.113.9']),
    );
  }, 180_000);

  it("the agent reads its own log, can not read another agent's, and can not allow anything", async () => {
    const own = await ctx.abox.networkLog(A, id, { denied: true });
    expect(own.entries.length).toBeGreaterThan(0);
    expect(await errorOf(ctx.abox.networkLog(B, id))).toMatchObject({ code: 'not_found' });
    const denied = await errorOf(ctx.abox.allowNetwork(A, id, { destinations: [OTHER_HOST] }));
    expect(denied).toMatchObject({ code: 'policy_denied' });
    expect((await status(`http://${OTHER_HOST}/headers`)).http).toBe('403');
  }, 120_000);

  it('allow once: the request succeeds for this sandbox, policy.yaml is untouched, everything is audited', async () => {
    const before = policyText();
    const hash = ctx.abox.policyHash;
    const revisions = (await ctx.abox.listPolicyRevisions(HUMAN)).length;

    // wildcards and anything the proxy would never connect to are refused or confirmed first
    expect(
      await errorOf(ctx.abox.allowNetwork(HUMAN, id, { destinations: ['169.254.169.254'] })),
    ).toMatchObject({
      code: 'invalid_input',
    });
    expect(
      await errorOf(ctx.abox.allowNetwork(HUMAN, id, { destinations: ['203.0.113.9'] })),
    ).toMatchObject({
      code: 'invalid_input',
    });
    const wild = await ctx.abox.allowNetwork(HUMAN, id, {
      destinations: [`*.${OTHER_HOST.split('.').slice(1).join('.')}`],
    });
    expect(wild.status).toBe('confirmation_required');

    const r = await ctx.abox.allowNetwork(HUMAN, id, { destinations: [OTHER_HOST] });
    expect(r.status).toBe('applied');
    expect((await status(`http://${OTHER_HOST}/headers`)).http).toBe('200');

    // only this sandbox changed
    expect((await ctx.abox.inspectSandbox(HUMAN, id)).network.allow).toEqual(
      expect.arrayContaining([UPSTREAM_HOST, OTHER_HOST]),
    );
    expect(policyText()).toBe(before);
    expect(ctx.abox.policyHash).toBe(hash);
    expect((await ctx.abox.listPolicyRevisions(HUMAN)).length).toBe(revisions);

    // the log shows it as allowed now: the old denials stay, the newest request was allowed
    const e = (await ctx.abox.networkLog(HUMAN, id)).entries.find(
      (x) => x.host === OTHER_HOST && x.port === 80,
    )!;
    expect(e).toMatchObject({ decision: 'allow', allowedNow: true });
    expect(e.denied).toBeGreaterThanOrEqual(1);
    expect(e.allowed).toBeGreaterThanOrEqual(1);
    expect(e.allow).toBeUndefined();

    const allowed = await ctx.abox.queryAudit(HUMAN, { sandboxId: id, action: 'network.allow' });
    expect(allowed.filter((x) => x.decision === 'allow')).toHaveLength(1);
    expect(allowed.filter((x) => x.decision === 'deny').length).toBeGreaterThanOrEqual(2);
    expect(
      await ctx.abox.queryAudit(HUMAN, { sandboxId: id, action: 'sandbox.access_applied' }),
    ).toHaveLength(1);
  }, 180_000);

  it('allow permanently: a revisioned policy edit with a diff, then the profile covers it', async () => {
    const want = {
      template: 'e2e-net',
      workspace: { mode: 'empty' as const },
      overrides: { network: { mode: 'allowlist' as const, allow: [THIRD_HOST] } },
    };
    // before: a destination beyond the profile needs a human
    const pending = await ctx.abox.createSandbox(A, want, { waitForApprovalMs: 0 });
    expect(pending.status).toBe('pending_approval');

    expect((await status(`http://${THIRD_HOST}/`)).http).toBe('403'); // denied, so it is in the log
    const p = await ctx.abox.proposeNetworkPolicy(HUMAN, id, { destinations: [THIRD_HOST] });
    expect(p).toMatchObject({ context: 'agent-a', profile: 'agent', added: [THIRD_HOST] });
    expect(p.usedBy).toEqual(expect.arrayContaining(['agent-a', 'agent-b']));
    expect(policyText()).toBe(p.current); // a proposal writes nothing
    const was = p.current.split('\n');
    const now = p.proposed!.split('\n');
    const changed = now.filter((l) => !was.includes(l));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain(THIRD_HOST);
    expect(changed[0]).toContain(UPSTREAM_HOST); // the existing entries stay in the list

    const revBefore = (await ctx.abox.listPolicyRevisions(HUMAN)).map((r) => r.rev);
    const saved = await ctx.abox.setPolicy(HUMAN, p.proposed!, { baseHash: p.baseHash });
    expect(saved.changed).toBe(true);
    expect(saved.revision).toBe(Math.max(...revBefore) + 1);
    expect(policyText()).toBe(p.proposed);
    const rev = await ctx.abox.getPolicyRevision(HUMAN, saved.revision);
    expect(rev.content).toBe(p.proposed);
    expect(rev.actor).toBe('human');

    // and for the sandbox itself (what the GUI and CLI do right after)
    expect((await ctx.abox.allowNetwork(HUMAN, id, { destinations: [THIRD_HOST] })).status).toBe(
      'applied',
    );

    // after: the same request no longer needs a human
    const created = await ctx.abox.createSandbox(A, want, { waitForApprovalMs: 0 });
    expect(created.status).toBe('created');
    if (created.status === 'created') ctx.created.push(created.sandbox.id);
    const again = await ctx.abox.proposeNetworkPolicy(HUMAN, id, { destinations: [THIRD_HOST] });
    expect(again).toMatchObject({ added: [], proposed: null, alreadyAllowed: [THIRD_HOST] });
  }, 240_000);

  it('a policy that changed since the proposal is not overwritten', async () => {
    const p = await ctx.abox.proposeNetworkPolicy(HUMAN, id, { destinations: ['late.e2e.test'] });
    writePolicy(env, `${policyText()}\n# edited by someone else\n`);
    expect(
      await errorOf(ctx.abox.setPolicy(HUMAN, p.proposed!, { baseHash: p.baseHash })),
    ).toMatchObject({ code: 'conflict' });
    expect(policyText()).toContain('edited by someone else');
  }, 60_000);
});
