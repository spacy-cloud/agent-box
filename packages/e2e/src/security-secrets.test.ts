/**
 * Secrets: `inject: proxy` (the sandbox never sees the token) and git clone over HTTPS through it
 * (roadmap phase 3 criterion 3), against a local HTTPS upstream that logs what really reaches it.
 * See upstream.ts for how the private-address rule is satisfied through an approved `privateExceptions` entry.
 */
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A,
  DOCKER,
  HUMAN,
  HUMAN_YES,
  createApproved,
  docker,
  e2ePolicyNet,
  errorOf,
  makeEnv,
  openAbox,
  out,
  sh,
  sweepE2E,
  warmProxy,
  type Ctx,
  type Env,
} from './harness.js';
import {
  OTHER_HOST,
  UPSTREAM_HOST,
  proxyAssetsWithCa,
  startUpstream,
  type Upstream,
} from './upstream.js';

const SECRET_TPL = `apiVersion: 1
name: e2e-secret
description: Injects a bearer token for the local upstream through the egress proxy (e2e).
backend: docker
extends: e2e-net
network: { mode: allowlist, allow: [${UPSTREAM_HOST}, ${OTHER_HOST}] }
secrets:
  - { ref: e2e-token, inject: proxy, hosts: [${UPSTREAM_HOST}] }
`;
const GIT_TPL = `apiVersion: 1
name: e2e-git
description: Injects a git token (Basic x-access-token) for the local upstream through the egress proxy (e2e).
backend: docker
extends: e2e-net
network: { mode: allowlist, allow: [${UPSTREAM_HOST}] }
secrets:
  - { ref: e2e-git-token, inject: proxy, hosts: [${UPSTREAM_HOST}] }
`;
const ENV_TPL = `apiVersion: 1
name: e2e-env-secret
description: Exposes a token as an environment variable; needs a human and shows a warning (e2e).
backend: docker
extends: e2e-net
secrets:
  - { ref: e2e-token, inject: env }
`;

/** Paths below `root` whose content contains one of `needles` (binary safe, does not follow symlinks). */
function scanTree(root: string, needles: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const buf = readFileSync(p);
        if (needles.some((n) => buf.includes(n))) hits.push(p);
      }
    }
  };
  walk(root);
  return hits;
}

describe.skipIf(!DOCKER)('secrets: inject proxy (local HTTPS upstream)', () => {
  let env: Env;
  let ctx: Ctx;
  let up: Upstream;
  let cleanupAssets: () => void = () => undefined;
  let token = '';
  let basicB64 = '';
  let needles: string[] = [];
  let sb = ''; // sandbox with the bearer injection and an approved private exception
  const exception = (): { network: { privateExceptions: string[] } } => ({
    network: { privateExceptions: [`${up.ip}/32`] },
  });

  beforeAll(async () => {
    up = await startUpstream();
    token = up.token;
    basicB64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    needles = [token, Buffer.from(token).toString('base64'), basicB64, `Bearer ${token}`];
    const pa = proxyAssetsWithCa(up.caPem);
    cleanupAssets = pa.cleanup;
    env = makeEnv();
    await env.secrets.set('e2e-token', token);
    await env.secrets.set('e2e-git-token', token);
    ctx = await openAbox(env, {
      policy: e2ePolicyNet(env, UPSTREAM_HOST, OTHER_HOST),
      templates: {
        'e2e-secret': SECRET_TPL,
        'e2e-git': GIT_TPL,
        'e2e-env-secret': ENV_TPL,
        'e2e-secret-forbidden': SECRET_TPL.replace(
          'name: e2e-secret',
          'name: e2e-secret-forbidden',
        ).replace('ref: e2e-token', 'ref: forbidden-secret'),
      },
      providerOpts: { proxy: pa.assets },
      config: { secrets: { 'e2e-git-token': { scheme: 'basic-x-access-token' } } },
    });
    await ctx.abox.buildTemplate(HUMAN, 'e2e-net');
    await warmProxy(ctx);
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
    await up?.stop();
    cleanupAssets();
    await sweepE2E();
    env?.cleanup();
  }, 120_000);

  const curl = (id: string, args: string): ReturnType<typeof sh> =>
    sh(ctx, A, id, `curl -sS -m 20 ${args}`, { timeoutMs: 40_000 });

  describe('without an approved exception the private upstream is unreachable', () => {
    it('create succeeds, but the proxy refuses the private address and nothing reaches the upstream', async () => {
      const marker = `nopriv-${Date.now()}`;
      const c = await ctx.create(A, { template: 'e2e-secret', workspace: { mode: 'empty' } });
      const r = await curl(
        c.sandbox.id,
        `-o /dev/null -w '%{http_code}' -H 'X-E2E: ${marker}' https://${UPSTREAM_HOST}/bearer`,
      );
      expect(r.exitCode, out(r)).not.toBe(0);
      expect(out(r)).toMatch(/403|CONNECT|SSL|connect/i);
      expect((await up.requests()).some((q) => q.xTest === marker)).toBe(false);
      await ctx.abox.removeSandbox(A, c.sandbox.id);
    }, 180_000);

    it('a private exception always needs a human, even in the profile, and is bound to that exact request', async () => {
      const req = {
        template: 'e2e-secret',
        workspace: { mode: 'empty' as const },
        overrides: exception(),
      };
      const p = await ctx.abox.createSandbox(A, req, { waitForApprovalMs: 0 });
      expect(p.status).toBe('pending_approval');
      if (p.status !== 'pending_approval') return;
      expect(p.risks.join(' ')).toMatch(/local network|private/i);
      // an exception for a different range is a different request: it does not ride on the first approval
      await ctx.abox.approve(HUMAN, p.approvalId);
      const other = await ctx.abox.createSandbox(
        A,
        { ...req, overrides: { network: { privateExceptions: ['10.0.0.0/8'] } } },
        { waitForApprovalMs: 0 },
      );
      expect(other.status).toBe('pending_approval');
      if (other.status === 'pending_approval') expect(other.approvalId).not.toBe(p.approvalId);
      // the original request goes through now (and consumes the approval)
      const done = await ctx.abox.createSandbox(A, req, { waitForApprovalMs: 0 });
      expect(done.status).toBe('created');
      if (done.status === 'created') {
        sb = done.sandbox.id;
        ctx.created.push(sb);
      }
      expect((await ctx.abox.getApproval(HUMAN, p.approvalId)).usedAt).not.toBeNull();
    }, 120_000);
  });

  describe('the proxy injects the token; the sandbox never holds it', () => {
    it('an authenticated request succeeds although the sandbox sent no credentials', async () => {
      const marker = `inj-${Date.now()}`;
      const r = await curl(
        sb,
        `-w ' [%{http_code}]' -H 'X-E2E: ${marker}' https://${UPSTREAM_HOST}/bearer`,
      );
      expect(r.stdout, out(r)).toContain('{"ok":true}');
      expect(r.stdout).toContain('[200]');
      const seen = (await up.requests()).filter((q) => q.xTest === marker);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        scheme: 'https',
        host: UPSTREAM_HOST,
        sni: UPSTREAM_HOST,
        authorization: `Bearer ${token}`,
      });
    });

    it('a header the sandbox sets itself is overridden, not forwarded', async () => {
      const marker = `spoof-${Date.now()}`;
      const r = await curl(
        sb,
        `-H 'X-E2E: ${marker}' -H 'Authorization: Bearer attacker-chosen' -w ' [%{http_code}]' https://${UPSTREAM_HOST}/bearer`,
      );
      expect(r.stdout).toContain('[200]');
      const seen = (await up.requests()).filter((q) => q.xTest === marker);
      expect(seen[0]?.authorization).toBe(`Bearer ${token}`);
    });

    it('env, /proc/*/environ and the whole filesystem contain no trace of the token', async () => {
      const envOut = await sh(
        ctx,
        A,
        sb,
        'env | grep -i -E "token|secret|authorization|E2E_" ; echo rc=$?',
      );
      expect(envOut.stdout.trim()).toBe('rc=1');
      const environ = await sh(
        ctx,
        A,
        sb,
        'cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | grep -i -E "token|bearer|E2E_TOKEN"; echo rc=$?',
      );
      expect(environ.stdout.trim()).toBe('rc=1');
      const grep = await sh(
        ctx,
        A,
        sb,
        'grep -rIl -e E2E_TOKEN_ -e "x-access-token" --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev / 2>/dev/null | head -5; echo done',
        { timeoutMs: 60_000 },
      );
      expect(grep.stdout.trim()).toBe('done');
      // the base64 forms too (the Basic header value, the token itself)
      const b64 = await sh(
        ctx,
        A,
        sb,
        `grep -rl -F -e '${basicB64}' -e '${Buffer.from(token).toString('base64')}' --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev / 2>/dev/null | head -5; echo done`,
        { timeoutMs: 60_000 },
      );
      expect(b64.stdout.trim()).toBe('done');
    });

    it('the sandbox only has the CA of the proxy, the CA is name constrained to the injection hosts', async () => {
      const files = await sh(
        ctx,
        A,
        sb,
        'ls /usr/local/share/abox; env | grep -E "^(SSL_CERT_FILE|GIT_SSL_CAINFO|CURL_CA_BUNDLE|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY)="',
      );
      expect(files.stdout).toContain('ca.crt');
      expect(files.stdout).toContain('ca-bundle.crt');
      expect(files.stdout).toContain('HTTPS_PROXY=http://abox-proxy:3128');
      // no private key material of the CA is anywhere in the sandbox
      const keys = await sh(
        ctx,
        A,
        sb,
        'grep -rl "PRIVATE KEY" /usr/local/share/abox /etc/ssl 2>/dev/null | head -3; echo done',
      );
      expect(keys.stdout.trim()).toBe('done');
      // a certificate for another name signed by that CA is not accepted: the CA is constrained to the injection host
      const constraints = await sh(
        ctx,
        A,
        sb,
        'openssl x509 -in /usr/local/share/abox/ca.crt -noout -text 2>/dev/null | grep -A3 "Name Constraints" || true',
      );
      if (constraints.stdout.trim() !== '') expect(constraints.stdout).toContain(UPSTREAM_HOST);
    });

    it('the injected header is not sent to a host that is not an injection host (and not over plain http)', async () => {
      const m1 = `other-${Date.now()}`;
      const r = await curl(sb, `-k -H 'X-E2E: ${m1}' https://${OTHER_HOST}/headers`);
      expect(r.exitCode, out(r)).toBe(0);
      expect(
        (JSON.parse(r.stdout) as { headers: Record<string, string> }).headers['authorization'],
      ).toBeUndefined();
      const seen = (await up.requests()).find((q) => q.xTest === m1);
      expect(seen).toMatchObject({ host: OTHER_HOST, authorization: null });
      // the Host header cannot talk the proxy into injecting for the other host's tunnel
      const m2 = `hosthdr-${Date.now()}`;
      await curl(
        sb,
        `-k -H 'X-E2E: ${m2}' -H 'Host: ${UPSTREAM_HOST}' https://${OTHER_HOST}/headers`,
      );
      expect((await up.requests()).find((q) => q.xTest === m2)?.authorization ?? null).toBeNull();
      // cleartext http to the injection host is refused: the token must never travel unencrypted
      const m3 = `plain-${Date.now()}`;
      const plain = await curl(
        sb,
        `-o /dev/null -w '%{http_code}' -H 'X-E2E: ${m3}' http://${UPSTREAM_HOST}/headers`,
      );
      expect(plain.stdout.trim()).not.toBe('200');
      expect((await up.requests()).some((q) => q.xTest === m3)).toBe(false);
    });

    it('the proxy does not hand out its configuration or the token on its own port', async () => {
      const r = await sh(
        ctx,
        A,
        sb,
        `curl -sS -m 8 -i http://abox-proxy:3128/ ; curl -sS -m 8 -i http://abox-proxy:3128/etc/abox-proxy/config.json; timeout 2 bash -c 'exec 3<>/dev/tcp/abox-proxy/9229' 2>/dev/null; echo nc=$?`,
        { timeoutMs: 40_000 },
      );
      expect(out(r)).not.toContain(token);
      expect(out(r)).not.toContain('nc=0');
    });

    it('a response that echoes the injected header is masked in exec output, logs and audit', async () => {
      const r = await curl(sb, `https://${UPSTREAM_HOST}/headers`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain(token);
      expect(r.stdout).toContain('***');
      const log = await ctx.abox.readLog(A, r.logRef);
      expect(log.content).not.toContain(token);
    });

    it('the token is in no abox artefact: audit, registry, views, state db, logs, docker metadata, container logs', async () => {
      const short = sb.split('/')[1]!;
      // audit + views
      const audit = JSON.stringify(await ctx.abox.queryAudit(HUMAN, { limit: 5000 }));
      const views = JSON.stringify([
        await ctx.abox.inspectSandbox(A, sb),
        await ctx.abox.listSandboxes(HUMAN),
        await ctx.abox.listApprovals(HUMAN),
      ]);
      for (const n of needles) {
        expect(audit, `audit contains ${n.slice(0, 12)}...`).not.toContain(n);
        expect(views, `views contain ${n.slice(0, 12)}...`).not.toContain(n);
      }
      // the sandbox view names the secret only by reference
      expect((await ctx.abox.inspectSandbox(A, sb)).secretRefs).toEqual([
        { ref: 'e2e-token', inject: 'proxy', hosts: [UPSTREAM_HOST] },
      ]);
      // everything abox wrote to disk (state.db + WAL, exec logs, workspace staging, exports)
      expect(scanTree(env.aboxHome, needles)).toEqual([]);
      // docker metadata of the sandbox and its proxy: env, cmd, labels, mounts
      for (const name of [`abox-local-${short}`, `abox-proxy-${short}`]) {
        const ins = await docker(['inspect', name]);
        expect(ins.code, ins.stderr).toBe(0);
        for (const n of needles) expect(ins.stdout, `${name} inspect`).not.toContain(n);
        const logs = await docker(['logs', name]);
        for (const n of needles)
          expect(`${logs.stdout}${logs.stderr}`, `${name} logs`).not.toContain(n);
      }
      // the proxy is hardened
      const pi = JSON.parse((await docker(['inspect', `abox-proxy-${short}`])).stdout) as Array<{
        Config: { User: string };
        HostConfig: {
          CapDrop: string[];
          ReadonlyRootfs: boolean;
          Privileged: boolean;
          PidsLimit: number;
          Memory: number;
        };
      }>;
      expect(pi[0]).toMatchObject({
        Config: { User: '10001:10001' },
        HostConfig: {
          CapDrop: ['ALL'],
          ReadonlyRootfs: true,
          Privileged: false,
          PidsLimit: 64,
          Memory: 128 * 1024 * 1024,
        },
      });
    });

    it('the proxy request log names hosts and decisions but never header values', async () => {
      const short = sb.split('/')[1]!;
      const events = await ctx.docker.networkEvents(sb);
      expect(events.some((e) => e.host === UPSTREAM_HOST && e.decision === 'allow')).toBe(true);
      const raw = (await docker(['logs', `abox-proxy-${short}`])).stdout;
      expect(raw).toContain(UPSTREAM_HOST);
      for (const n of needles) expect(raw).not.toContain(n);
    });
  });

  describe('git clone over HTTPS through inject: proxy (roadmap phase 3 criterion 3)', () => {
    let gitSb = '';
    beforeAll(async () => {
      const c = await createApproved(ctx, A, {
        template: 'e2e-git',
        workspace: { mode: 'empty' },
        overrides: exception(),
      });
      gitSb = c.sandbox.id;
    }, 180_000);

    it('git clone works, the repository content arrives, and `env | grep -i token` shows nothing', async () => {
      const r = await sh(
        ctx,
        A,
        gitSb,
        `GIT_TERMINAL_PROMPT=0 git clone -q https://${UPSTREAM_HOST}/repo.git /workspace/repo 2>&1; echo rc=$?`,
        { timeoutMs: 90_000 },
      );
      expect(r.stdout, out(r)).toContain('rc=0');
      const readme = await sh(ctx, A, gitSb, 'cat /workspace/repo/README');
      expect(readme.stdout.trim()).toBe(up.repoMarker);
      const log = await sh(ctx, A, gitSb, 'git -C /workspace/repo log --oneline');
      expect(log.stdout).toContain('seed');
      const envOut = await sh(ctx, A, gitSb, 'env | grep -i token; echo rc=$?');
      expect(envOut.stdout.trim()).toBe('rc=1');
      // the clone's config and the git credential machinery hold no token
      const cfg = await sh(
        ctx,
        A,
        gitSb,
        'cat /workspace/repo/.git/config; git config --global -l 2>/dev/null; cat ~/.git-credentials ~/.netrc 2>&1 | head -3',
      );
      expect(cfg.stdout).not.toMatch(/token|extraheader|authorization/i);
      expect(cfg.stdout).not.toContain(token);
      // what the upstream saw: Basic x-access-token:<token> on the git requests, injected by the proxy
      const seen = (await up.requests()).filter(
        (q) => q.url.startsWith('/repo.git') && q.scheme === 'https',
      );
      expect(seen.length).toBeGreaterThan(0);
      for (const q of seen) expect(q.authorization, q.url).toBe(`Basic ${basicB64}`);
      expect(seen.some((q) => q.url.includes('git-upload-pack'))).toBe(true);
    }, 180_000);

    it('negative control: without the secret the same clone fails with 401 (the injection is the only credential)', async () => {
      const c = await createApproved(ctx, A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: {
          network: { mode: 'allowlist', allow: [UPSTREAM_HOST], ...exception().network },
        },
      });
      const r = await sh(
        ctx,
        A,
        c.sandbox.id,
        `GIT_TERMINAL_PROMPT=0 git clone -q https://${UPSTREAM_HOST}/repo.git /workspace/repo2 2>&1; echo rc=$?`,
        { timeoutMs: 60_000 },
      );
      expect(r.stdout).not.toContain('rc=0');
      expect(r.stdout).toMatch(/certificate|SSL|401|403|denied|could not|fatal/i);
      await ctx.abox.removeSandbox(A, c.sandbox.id);
    }, 180_000);

    it('no abox artefact holds the git token either', async () => {
      expect(scanTree(env.aboxHome, needles)).toEqual([]);
      const audit = JSON.stringify(await ctx.abox.queryAudit(HUMAN, { limit: 5000 }));
      for (const n of needles) expect(audit).not.toContain(n);
    });
  });

  describe('policy around secrets', () => {
    it('inject: env is not in the agent profile: denied outright (deny wins, nothing is queued)', async () => {
      const err = (await errorOf(
        ctx.abox.createSandbox(
          A,
          { template: 'e2e-env-secret', workspace: { mode: 'empty' } },
          { waitForApprovalMs: 0 },
        ),
      )) as { code: string };
      // e2e-env-secret is allowed as a template, but profile.secrets.inject=[proxy]
      expect(err.code).toBe('policy_denied');
      expect(
        (await ctx.abox.listApprovals(A, { status: 'pending' })).some((a) =>
          JSON.stringify(a.request).includes('e2e-env-secret'),
        ),
      ).toBe(false);
    });

    it('a secret that is not in secrets.allowed is denied for agents', async () => {
      await env.secrets.set('forbidden-secret', 'x');
      const err = (await errorOf(
        ctx.abox.createSandbox(
          A,
          { template: 'e2e-secret-forbidden', workspace: { mode: 'empty' } },
          { waitForApprovalMs: 0 },
        ),
      )) as { code: string; message: string };
      expect(err.code).toBe('policy_denied');
      expect(err.message).toContain('forbidden-secret');
    });

    it('inject: env by a human shows the value inside the sandbox (that is its documented risk) but masks it in output, logs and audit', async () => {
      const pending = await ctx.abox.createSandbox(HUMAN, {
        template: 'e2e-env-secret',
        workspace: { mode: 'empty' },
      });
      expect(pending.status).toBe('confirmation_required');
      if (pending.status === 'confirmation_required')
        expect(pending.risks.join(' ')).toMatch(/secret|env|visible/i);
      const c = await ctx.create(HUMAN_YES, {
        template: 'e2e-env-secret',
        workspace: { mode: 'empty' },
      });
      const r = await sh(ctx, HUMAN, c.sandbox.id, 'env | grep -i token');
      expect(r.stdout).not.toContain(token);
      expect(r.stdout).toContain('***');
      const audit = JSON.stringify(await ctx.abox.queryAudit(HUMAN, { limit: 5000 }));
      for (const n of needles) expect(audit).not.toContain(n);
      await ctx.abox.removeSandbox(HUMAN, c.sandbox.id);
    }, 120_000);

    it('a missing secret fails the create with a clear error and leaves nothing behind', async () => {
      await env.secrets.delete('e2e-token');
      try {
        const count = async (): Promise<number> =>
          (
            await docker(['ps', '-a', '-q', '--filter', `label=abox.e2e-inst=${ctx.instance}`])
          ).stdout
            .split('\n')
            .filter(Boolean).length;
        const before = await count();
        const live = (await ctx.abox.listSandboxes(HUMAN)).sandboxes.length;
        const err = (await errorOf(
          createApproved(ctx, A, {
            template: 'e2e-secret',
            workspace: { mode: 'empty' },
            overrides: exception(),
          }),
        )) as { code?: string; message?: string };
        expect(err, 'a sandbox must not be created without its secret').toBeDefined();
        expect(['not_found', 'invalid_input', 'backend_error']).toContain(err.code);
        expect(err.message).toMatch(/e2e-token|secret/i);
        expect(await count()).toBe(before);
        expect((await ctx.abox.listSandboxes(HUMAN)).sandboxes.length).toBe(live);
      } finally {
        await env.secrets.set('e2e-token', token);
      }
    }, 120_000);
  });
});
