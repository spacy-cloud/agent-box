/**
 * Network hardening ("Pruefen der Haertung": network none, allowlist, direct IP, private addresses, docker host).
 * Real Docker, real egress proxy. External dependencies, all skipped with a note when unavailable:
 * example.com (allowed-domain check), *.nip.io (public wildcard DNS used to make allowlisted NAMES resolve to
 * private addresses, which is the DNS-rebinding defence of the proxy).
 */
import { writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A,
  B,
  DOCKER,
  HUMAN,
  HUMAN_YES,
  RUN,
  docker,
  dockerProvider,
  e2ePolicyNet,
  errorOf,
  makeEnv,
  openAbox,
  sh,
  sleep,
  sweepE2E,
  TOOLS_INSTALL,
  warmProxy,
  type Ctx,
  type Env,
} from './harness.js';
import { UPSTREAM_HOST, startUpstream, type Upstream } from './upstream.js';

async function resolves(name: string): Promise<boolean> {
  try {
    await lookup(name);
    return true;
  } catch {
    return false;
  }
}

interface Probe {
  /** HTTP status as printed by curl (`000` when no HTTP response arrived). */
  http: string;
  exit: number;
  text: string;
}

describe.skipIf(!DOCKER)('network hardening (real Docker + egress proxy)', () => {
  let env: Env;
  let ctx: Ctx;
  let up: Upstream;
  let exampleReachable = false;
  let nipReachable = false;

  /** One curl probe inside the sandbox, honouring the sandbox's proxy environment unless `--noproxy` is given. */
  async function probe(id: string, url: string, flags = ''): Promise<Probe> {
    const r = await sh(
      ctx,
      A,
      id,
      `curl -sS -m 15 -o /dev/null -w 'HTTP=%{http_code}' ${flags} '${url}' 2>/tmp/err; echo " EXIT=$?"; cat /tmp/err`,
      { timeoutMs: 40_000 },
    );
    const m = /HTTP=(\d+) EXIT=(\d+)/.exec(r.stdout);
    return { http: m?.[1] ?? '?', exit: Number(m?.[2] ?? -1), text: r.stdout };
  }
  const denied = (p: Probe): boolean => p.exit !== 0 || /^(4|5)\d\d$/.test(p.http);

  beforeAll(async () => {
    exampleReachable = await resolves('example.com');
    nipReachable = await resolves('10.0.0.1.nip.io');
    up = await startUpstream();
    env = makeEnv();
    ctx = await openAbox(env, {
      policy: e2ePolicyNet(env, UPSTREAM_HOST, undefined, ['"*.nip.io"']),
    });
    await ctx.abox.buildTemplate(HUMAN, 'e2e-net');
    await warmProxy(ctx);
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
    await up?.stop();
    await sweepE2E();
    env?.cleanup();
  }, 120_000);

  // =========================================================================================================
  describe('network mode none (the default)', () => {
    let id = '';
    beforeAll(async () => {
      id = (await ctx.create(A, { template: 'e2e-net', workspace: { mode: 'empty' } })).sandbox.id;
    });

    it('has no interface but loopback, no route, no proxy environment', async () => {
      expect((await sh(ctx, A, id, 'ls /sys/class/net')).stdout.trim()).toBe('lo');
      expect(
        (
          await sh(
            ctx,
            A,
            id,
            'tail -n +2 /proc/net/route | wc -l; cat /proc/net/ipv6_route | grep -v "^0*" | wc -l',
          )
        ).stdout
          .trim()
          .split('\n')[0],
      ).toBe('0');
      expect(
        (await sh(ctx, A, id, 'env | grep -i -E "^(https?|all)_proxy="; echo rc=$?')).stdout.trim(),
      ).toBe('rc=1');
      const raw = JSON.parse(
        (
          await docker([
            'inspect',
            '--format',
            '{{json .NetworkSettings.Networks}}',
            `abox-local-${id.split('/')[1]}`,
          ])
        ).stdout,
      ) as Record<string, unknown>;
      expect(Object.keys(raw)).toEqual(['none']);
    });

    it('no DNS: system resolver, direct queries to public resolvers, TCP and UDP', async () => {
      await sh(ctx, A, id, TOOLS_INSTALL);
      for (const cmd of [
        'getent hosts example.com',
        'node /workspace/dnsq.js example.com',
        'node /workspace/dnsq.js example.com 8.8.8.8',
        'node /workspace/dnsq.js example.com 1.1.1.1',
        'node /workspace/dnsq.js example.com 127.0.0.11',
        'node /workspace/dnsq.js example.org',
      ]) {
        const r = await sh(ctx, A, id, `${cmd} 2>&1; echo rc=$?`, { timeoutMs: 30_000 });
        expect(r.stdout, cmd).not.toMatch(/rc=0\s*$/);
        expect(r.stdout, cmd).not.toContain('ANSWER');
      }
    });

    it('no connection: neither by name nor by IP, neither IPv4 nor IPv6, neither TCP nor a raw socket', async () => {
      for (const target of [
        'http://example.com',
        'https://1.1.1.1',
        'http://93.184.216.34',
        'http://[2606:4700:4700::1111]',
        'http://169.254.169.254/latest/meta-data/',
      ]) {
        const p = await probe(id, target, '--noproxy "*"');
        expect(p.exit, `${target}: ${p.text}`).not.toBe(0);
        expect(p.http).toBe('000');
      }
      const nc = await sh(
        ctx,
        A,
        id,
        '/workspace/tcp.sh 1.1.1.1 443; echo rc=$?; /workspace/tcp.sh 8.8.8.8 53; echo rc=$?',
      );
      expect(nc.stdout).not.toContain('rc=0');
      // sanity: the tools themselves work (a loopback server answers), so the failures above are about the network
      const lo = await sh(
        ctx,
        A,
        id,
        `node -e "require('net').createServer((s) => s.end('hi')).listen(9099, '127.0.0.1')" & sleep 1; /workspace/tcp.sh 127.0.0.1 9099; echo rc=$?`,
      );
      expect(lo.stdout).toContain('rc=0');
    });

    it('no capabilities at all, so no raw sockets and no interface changes', async () => {
      const r = await sh(ctx, A, id, 'grep -E "CapEff|CapBnd" /proc/self/status');
      expect(r.stdout).toMatch(/CapEff:\s+0000000000000000/);
      expect(r.stdout).toMatch(/CapBnd:\s+0000000000000000/);
    });

    it('accessRequest cannot turn a none sandbox into an allowlist one (mode changes are unsupported)', async () => {
      const err = (await errorOf(
        ctx.abox.accessRequest(
          A,
          id,
          { kind: 'network', details: { mode: 'allowlist', domains: ['example.com'] } },
          { waitForApprovalMs: 0 },
        ),
      )) as { code: string };
      expect(['unsupported', 'policy_denied']).toContain(err.code);
      expect((await sh(ctx, A, id, 'ls /sys/class/net')).stdout.trim()).toBe('lo');
    });

    it('an agent cannot ask for network mode open; the profile says allowlist at most', async () => {
      const err = (await errorOf(
        ctx.abox.createSandbox(
          A,
          {
            template: 'e2e-net',
            workspace: { mode: 'empty' },
            overrides: { network: { mode: 'open' } },
          },
          { waitForApprovalMs: 0 },
        ),
      )) as { code: string; message: string };
      expect(err.code).toBe('policy_denied');
      expect(err.message).toMatch(/open/);
    });
  });

  // =========================================================================================================
  describe('network mode allowlist (egress proxy sidecar)', () => {
    let id = '';
    let short = '';
    beforeAll(async () => {
      const c = await ctx.create(A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: { network: { mode: 'allowlist', allow: ['example.com'] } },
      });
      id = c.sandbox.id;
      short = id.split('/')[1]!;
    }, 120_000);

    it('topology: sandbox only on an internal network without gateway; the proxy bridges internal and egress', async () => {
      const sbNets = JSON.parse(
        (
          await docker([
            'inspect',
            '--format',
            '{{json .NetworkSettings.Networks}}',
            `abox-local-${short}`,
          ])
        ).stdout,
      ) as Record<string, { Gateway: string }>;
      expect(Object.keys(sbNets)).toEqual([`abox-int-${short}`]);
      const net = JSON.parse(
        (await docker(['network', 'inspect', `abox-int-${short}`])).stdout,
      ) as Array<{ Internal: boolean; IPAM: { Config: Array<{ Gateway?: string }> } }>;
      expect(net[0]!.Internal).toBe(true);
      const proxyNets = JSON.parse(
        (
          await docker([
            'inspect',
            '--format',
            '{{json .NetworkSettings.Networks}}',
            `abox-proxy-${short}`,
          ])
        ).stdout,
      ) as Record<string, unknown>;
      expect(Object.keys(proxyNets).sort()).toEqual([`abox-int-${short}`, 'abox-egress'].sort());
      const e = (await sh(ctx, A, id, 'env | grep -i proxy | sort')).stdout;
      expect(e).toContain('HTTPS_PROXY=http://abox-proxy:3128');
      expect(e).toContain('NO_PROXY=localhost,127.0.0.1');
      // the proxy container is hardened like the sandbox
      const pi = JSON.parse((await docker(['inspect', `abox-proxy-${short}`])).stdout) as Array<{
        HostConfig: {
          CapDrop: string[];
          ReadonlyRootfs: boolean;
          SecurityOpt: string[];
          Privileged: boolean;
        };
        Config: { User: string };
      }>;
      expect(pi[0]).toMatchObject({
        Config: { User: '10001:10001' },
        HostConfig: { CapDrop: ['ALL'], ReadonlyRootfs: true, Privileged: false },
      });
      expect(pi[0]!.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
    });

    it('an allowed domain works through the proxy (https CONNECT and plain http)', async (ctx2) => {
      if (!exampleReachable) return ctx2.skip();
      const https = await probe(id, 'https://example.com/');
      expect(https, https.text).toMatchObject({ http: '200', exit: 0 });
      const http = await probe(id, 'http://example.com/');
      expect(http.exit, http.text).toBe(0);
      expect(Number(http.http)).toBeLessThan(400);
      const events = await ctx.docker.networkEvents(id);
      const allow = events.filter((e) => e.host === 'example.com' && e.decision === 'allow');
      expect(allow.length).toBeGreaterThanOrEqual(1);
      expect(allow[0]).toMatchObject({ port: 443, method: 'CONNECT' });
      expect(allow[0]!.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$|:/);
    });

    it('other domains are denied with 403 and recorded by the proxy', async () => {
      const tried: string[] = [];
      for (const url of [
        'https://example.org/',
        'https://example.net/',
        'https://www.example.com/', // an allowlist entry covers the host itself, not its subdomains
        'https://sub.example.com/',
        'https://example.com.evil.test/',
        'https://evilexample.com/',
        'https://example.com@example.org/', // userinfo trick: the host is example.org
        'http://example.org/',
        'https://example.com:8443/', // not an allowed port
        'http://example.com:22/',
      ]) {
        tried.push(url);
        const p = await probe(id, url);
        expect(denied(p), `${url} was not denied: ${p.text}`).toBe(true);
        expect(p.text, url).toMatch(/403|CONNECT tunnel failed|Received HTTP code 403|HTTP=403/);
      }
      const events = await ctx.docker.networkEvents(id);
      const denies = events.filter((e) => e.decision === 'deny');
      for (const host of [
        'example.org',
        'example.net',
        'www.example.com',
        'sub.example.com',
        'example.com.evil.test',
        'evilexample.com',
      ]) {
        const d = denies.find((e) => e.host === host);
        expect(d, `no deny event for ${host}`).toBeDefined();
        expect(d!.reason).toMatch(/allow/i);
      }
      const port = denies.find((e) => e.host === 'example.com' && e.port === 8443);
      expect(port, 'port rule: example.com:8443 must be denied and logged').toBeDefined();
    });

    it('a Host header that names an allowed host does not smuggle a request to a denied one', async () => {
      const p = await probe(id, 'http://example.org/', '-H "Host: example.com"');
      expect(denied(p), p.text).toBe(true);
    });

    it('denied egress is audited by the manager (queryAudit), not only in the proxy container log', async () => {
      // The audit log is where a human looks. A denied egress to audit-probe.example.org must be an audit entry of its own
      // (the exec entry that merely contains the command line does not count).
      await probe(id, 'https://audit-probe.example.org/');
      await sleep(500);
      const all = await ctx.abox.queryAudit(HUMAN, { limit: 5000 });
      const hit = all.filter(
        (e) =>
          !e.action.startsWith('sandbox.exec') &&
          !e.action.startsWith('process.') &&
          JSON.stringify(e).includes('audit-probe.example.org'),
      );
      expect(
        hit.length,
        'no audit entry for the denied egress (Abox never reads provider.networkEvents)',
      ).toBeGreaterThan(0);
      expect(hit[0]!.decision).toBe('deny');
    });

    it('direct IP access fails without the proxy (no route out of the internal network)', async () => {
      for (const target of [
        'https://1.1.1.1',
        'http://8.8.8.8',
        'https://93.184.216.34',
        'http://[2606:4700:4700::1111]',
      ]) {
        const p = await probe(id, target, '--noproxy "*"');
        expect(p.exit, `${target}: ${p.text}`).not.toBe(0);
        expect(p.http).toBe('000');
      }
      await sh(ctx, A, id, TOOLS_INSTALL);
      const nc = await sh(ctx, A, id, '/workspace/tcp.sh 1.1.1.1 443; echo rc=$?');
      expect(nc.stdout).not.toContain('rc=0');
      // no default route (the internal network has no gateway): only the connected subnet is in the route table
      const route = await sh(ctx, A, id, 'cat /proc/net/route');
      const defaults = route.stdout
        .split('\n')
        .slice(1)
        .filter((l) => l.trim() !== '' && l.split(/\s+/)[1] === '00000000');
      expect(defaults, route.stdout).toEqual([]);
    });

    it('IP literals are denied by the proxy as well (also the real IP of an allowed domain)', async (ctx2) => {
      for (const url of [
        'https://1.1.1.1/',
        'http://1.1.1.1/',
        'https://[2606:4700:4700::1111]/',
      ]) {
        const p = await probe(id, url);
        expect(denied(p), `${url}: ${p.text}`).toBe(true);
      }
      if (!exampleReachable) return ctx2.skip();
      const ip = (await lookup('example.com', { family: 4 })).address;
      const p = await probe(id, `https://${ip}/`, '-H "Host: example.com" -k');
      expect(denied(p), `${ip}: ${p.text}`).toBe(true);
      const events = await ctx.docker.networkEvents(id);
      expect(events.some((e) => e.host === '1.1.1.1' && e.decision === 'deny')).toBe(true);
    });

    it('metadata, RFC1918, loopback and the docker host are refused by the proxy (literals, odd encodings, localhost)', async () => {
      const bridgeGw = (
        (
          await docker([
            'network',
            'inspect',
            '--format',
            '{{(index .IPAM.Config 0).Gateway}}',
            'bridge',
          ])
        ).stdout || '172.17.0.1'
      ).trim();
      const targets = [
        'http://169.254.169.254/latest/meta-data/',
        'https://169.254.169.254/',
        'http://10.0.0.1/',
        'https://10.0.0.1/',
        'http://192.168.0.1/',
        'http://172.16.0.1/',
        'http://100.64.0.1/',
        `http://${bridgeGw}:2375/version`,
        `https://${bridgeGw}/`,
        'http://localhost/',
        'https://localhost/',
        'http://127.0.0.1/',
        'http://[::1]/',
        'http://0.0.0.0/',
        'http://2852039166/', // 169.254.169.254 as one decimal number
        'http://0xA9FEA9FE/',
        'http://0251.0376.0251.0376/',
        'http://169.254.169.254./',
        'http://[::ffff:169.254.169.254]/',
        'http://[::ffff:a9fe:a9fe]/',
        'http://metadata.google.internal/',
        'http://instance-data/',
      ];
      for (const url of targets) {
        const p = await probe(id, url);
        expect(denied(p), `${url} was not denied: ${p.text}`).toBe(true);
        expect(p.http, url).not.toMatch(/^2/);
      }
    });

    it('allowlisted NAMES that resolve to private addresses are refused (the proxy checks the resolved address)', async (ctx2) => {
      // upstream.e2e.test is in the profile allowlist and resolves (docker DNS on abox-egress) to a private address
      const c = await ctx.create(A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: { network: { mode: 'allowlist', allow: [UPSTREAM_HOST] } },
      });
      const marker = `priv-${Date.now()}`;
      const p = await probe(
        c.sandbox.id,
        `https://${UPSTREAM_HOST}/headers`,
        `-k -H 'X-E2E: ${marker}'`,
      );
      expect(denied(p), p.text).toBe(true);
      expect((await up.requests()).some((q) => q.xTest === marker)).toBe(false);
      const ev = (await ctx.docker.networkEvents(c.sandbox.id)).find(
        (e) => e.host === UPSTREAM_HOST,
      );
      expect(ev).toMatchObject({ decision: 'deny' });
      expect(ev!.reason).toMatch(/private|blocked|address/i);
      await ctx.abox.removeSandbox(A, c.sandbox.id);

      if (!nipReachable) return ctx2.skip();
      const names = [
        '169.254.169.254',
        '10.0.0.1',
        '192.168.0.1',
        '127.0.0.1',
        '100.64.0.1',
        '0.0.0.0',
      ].map((ip) => `${ip}.nip.io`);
      const c2 = await ctx.create(A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: { network: { mode: 'allowlist', allow: names } },
      });
      for (const name of names) {
        const q = await probe(c2.sandbox.id, `https://${name}/`);
        expect(denied(q), `${name}: ${q.text}`).toBe(true);
        const e2 = (await ctx.docker.networkEvents(c2.sandbox.id)).find((e) => e.host === name);
        expect(e2, name).toMatchObject({ decision: 'deny' });
        expect(e2!.reason, name).toMatch(/private|blocked|address/i);
      }
      await ctx.abox.removeSandbox(A, c2.sandbox.id);
    }, 180_000);

    it('the docker host is unreachable: no engine socket in the sandbox, no TCP to the engine through any route', async () => {
      expect(
        (
          await sh(
            ctx,
            A,
            id,
            'ls -l /var/run/docker.sock /run/docker.sock /var/run/podman 2>&1; echo rc=$?',
          )
        ).stdout,
      ).not.toMatch(/rc=0/);
      expect(
        (
          await sh(
            ctx,
            A,
            id,
            'find / -xdev \\( -type s -o -name "docker*.sock" \\) 2>/dev/null | head',
          )
        ).stdout.trim(),
      ).toBe('');
      const mounts = (await sh(ctx, A, id, 'cat /proc/self/mountinfo')).stdout;
      expect(mounts).not.toMatch(/docker\.sock|containerd\.sock|podman\.sock/);
      const gws = new Set<string>();
      for (const n of ['bridge', 'abox-egress']) {
        const gw = (
          await docker([
            'network',
            'inspect',
            '--format',
            '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
            n,
          ])
        ).stdout.trim();
        if (gw) gws.add(gw);
      }
      for (const gw of gws) {
        for (const port of [2375, 2376]) {
          const r = await sh(ctx, A, id, `/workspace/tcp.sh ${gw} ${port} 2; echo rc=$?`);
          expect(r.stdout, `${gw}:${port}`).not.toContain('rc=0');
          const viaProxy = await probe(id, `http://${gw}:${port}/version`);
          expect(denied(viaProxy), `${gw}:${port} via proxy: ${viaProxy.text}`).toBe(true);
        }
      }
    });

    it('a service on the docker host is not reachable through the proxy either (name -> gateway IP)', async (ctx2) => {
      if (!nipReachable) return ctx2.skip();
      const gw = (
        await docker([
          'network',
          'inspect',
          '--format',
          '{{(index .IPAM.Config 0).Gateway}}',
          'abox-egress',
        ])
      ).stdout.trim();
      if (!gw) return ctx2.skip();
      // A service in the docker host's network namespace, listening on the egress gateway address only (not the LAN).
      const name = `abox-e2e-hostsvc-${RUN}`;
      const started = await docker([
        'run',
        '-d',
        '--name',
        name,
        '--network',
        'host',
        '--label',
        'abox.test=e2e',
        '--label',
        `abox.e2e=${RUN}`,
        'node:24-alpine',
        'node',
        '-e',
        `require('net').createServer((s)=>{console.log('HIT');s.end('HTTP/1.0 200 OK\\r\\n\\r\\nhost-service')}).listen(80,'${gw}',()=>console.log('LISTENING'))`,
      ]);
      if (started.code !== 0) return ctx2.skip();
      try {
        for (let i = 0; i < 50 && !(await docker(['logs', name])).stdout.includes('LISTENING'); i++)
          await sleep(200);
        const hits = async (): Promise<number> =>
          (await docker(['logs', name])).stdout.split('\n').filter((l) => l === 'HIT').length;
        // premise: a plain container on the egress network reaches that host service (else the test proves little)
        const control = await docker([
          'run',
          '--rm',
          '--network',
          'abox-egress',
          '--label',
          'abox.test=e2e',
          '--label',
          `abox.e2e=${RUN}`,
          'alpine:3.22',
          'wget',
          '-q',
          '-T',
          '3',
          '-O-',
          `http://${gw}:80/`,
        ]);
        const reachableFromBridge = control.stdout.includes('host-service');
        const before = await hits();
        const dn = `${gw}.nip.io`;
        const c = await ctx.create(A, {
          template: 'e2e-net',
          workspace: { mode: 'empty' },
          overrides: { network: { mode: 'allowlist', allow: [dn] } },
        });
        const p = await probe(c.sandbox.id, `http://${dn}/`);
        expect(denied(p), p.text).toBe(true);
        const q = await probe(c.sandbox.id, `https://${dn}/`);
        expect(denied(q), q.text).toBe(true);
        expect(
          await hits(),
          `the host service was contacted through the proxy (control reachable: ${reachableFromBridge})`,
        ).toBe(before);
        const ev = (await ctx.docker.networkEvents(c.sandbox.id)).find((e) => e.host === dn);
        expect(ev).toMatchObject({ decision: 'deny' });
        await ctx.abox.removeSandbox(A, c.sandbox.id);
      } finally {
        await docker(['rm', '-f', name]);
      }
    }, 120_000);

    it('allowlist entries with a port (host:port) are accepted by the policy engine like by the template schema and the proxy', async () => {
      writeFileSync(
        join(env.aboxHome, 'config', 'templates', 'e2e-hostport.yaml'),
        `apiVersion: 1
name: e2e-hostport
description: Allowlists example.com on a non-default port (e2e).
backend: docker
extends: e2e-net
network: { mode: allowlist, allow: ['example.com:8443'] }
`,
      );
      const v = await ctx.abox.validateTemplate(HUMAN, 'e2e-hostport');
      expect(v.issues.filter((i) => i.kind === 'schema')).toEqual([]); // the template schema accepts host:port
      const r = await errorOf(
        ctx.create(HUMAN_YES, { template: 'e2e-hostport', workspace: { mode: 'empty' } }),
      );
      expect(
        r,
        'policy rejects "example.com:8443" as "not a valid domain pattern" although schema and proxy support it',
      ).toBeUndefined();
    }, 120_000);

    it('DNS is not a channel out: no resolver reachable from the internal network', async () => {
      await sh(ctx, A, id, TOOLS_INSTALL);
      for (const cmd of [
        'getent hosts example.com',
        'node /workspace/dnsq.js example.com',
        'node /workspace/dnsq.js example.com 8.8.8.8',
        'node /workspace/dnsq.js exfil-0123456789.example.org 127.0.0.11',
        'node /workspace/dnsq.js example.org 127.0.0.11 txt',
      ]) {
        const r = await sh(ctx, A, id, `${cmd} 2>&1; echo rc=$?`, { timeoutMs: 30_000 });
        expect(r.stdout, `${cmd}\n${r.stdout}`).not.toContain('ANSWER');
        expect(r.stdout, cmd).not.toMatch(/^\d+\.\d+\.\d+\.\d+\s+\S+/m);
      }
    });

    it('another sandbox and its proxy are not reachable from this one', async () => {
      const other = await ctx.create(B, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: { network: { mode: 'allowlist', allow: ['example.com'] } },
      });
      const oshort = other.sandbox.id.split('/')[1]!;
      const ips = (
        await docker([
          'inspect',
          '--format',
          '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
          `abox-local-${oshort}`,
          `abox-proxy-${oshort}`,
        ])
      ).stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      expect(ips.length).toBeGreaterThanOrEqual(2);
      for (const ip of ips) {
        const r = await sh(
          ctx,
          A,
          id,
          `/workspace/tcp.sh ${ip} 3128 2; echo rc=$?; /workspace/tcp.sh ${ip} 80 2; echo rc80=$?`,
        );
        expect(r.stdout, ip).not.toContain('rc=0');
        expect(r.stdout, ip).not.toContain('rc80=0');
      }
      await ctx.abox.removeSandbox(B, other.sandbox.id);
    }, 120_000);

    it('docker backend: widening the allowlist of a running sandbox needs approval, is then applied to the proxy and takes effect', async () => {
      const sb = await ctx.create(A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: { network: { mode: 'allowlist', allow: ['example.com'] } },
      });
      const sid = sb.sandbox.id;
      const short = sid.split('/')[1]!;
      const proxyAllow = async (): Promise<string[]> =>
        (
          JSON.parse(
            (await docker(['exec', `abox-proxy-${short}`, 'cat', '/etc/abox-proxy/config.json']))
              .stdout,
          ) as { allow: string[] }
        ).allow;
      expect(await proxyAllow()).toEqual(['example.com']);
      if (exampleReachable) expect(denied(await probe(sid, 'https://example.org/'))).toBe(true);

      const pending = await ctx.abox.accessRequest(
        A,
        sid,
        { kind: 'network', details: { domains: ['example.org'] }, reason: 'e2e: need example.org' },
        { waitForApprovalMs: 0 },
      );
      expect(pending.status).toBe('pending_approval');
      if (pending.status !== 'pending_approval') return;
      expect(await proxyAllow()).toEqual(['example.com']); // nothing applied before the human decided
      const dec = await ctx.abox.approve(HUMAN, pending.approvalId, 'ok for e2e');
      expect(dec.applied).toMatchObject({ ok: true });

      expect((await proxyAllow()).sort()).toEqual(['example.com', 'example.org']);
      // the sandbox itself was not recreated and keeps its wiring
      expect((await ctx.docker.inspect(sid)).state).toBe('running');
      expect(
        Object.keys(
          (JSON.parse(
            (
              await docker([
                'inspect',
                '--format',
                '{{json .NetworkSettings.Networks}}',
                `abox-local-${short}`,
              ])
            ).stdout,
          ) as Record<string, unknown>) ?? {},
        ),
      ).toEqual([`abox-int-${short}`]);
      if (exampleReachable) {
        const p = await probe(sid, 'https://example.org/');
        expect(p.exit, p.text).toBe(0);
        expect(denied(await probe(sid, 'https://example.net/'))).toBe(true);
      }
      await ctx.abox.removeSandbox(A, sid);
    }, 180_000);

    it('manager flow for network access requests (provider with updateNetwork): approval needed, applied after approve, deny sticks', async () => {
      const w = makeEnv();
      const calls: Array<{ id: string; allow: string[]; privateExceptions: string[] }> = [];
      const inst = 'updnet';
      const base = dockerProvider({ instance: inst });
      const withUpdate = new Proxy(base, {
        get(t, prop) {
          if (prop === 'updateNetwork') {
            return async (sid: string, net: { allow: string[]; privateExceptions: string[] }) => {
              calls.push({
                id: sid,
                allow: [...net.allow],
                privateExceptions: [...net.privateExceptions],
              });
            };
          }
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const c = await openAbox(w, {
        policy: e2ePolicyNet(w, UPSTREAM_HOST),
        instance: inst,
        providers: { docker: () => withUpdate },
      });
      try {
        await c.abox.buildTemplate(HUMAN, 'e2e-net');
        const sb = await c.create(A, {
          template: 'e2e-net',
          workspace: { mode: 'empty' },
          overrides: { network: { mode: 'allowlist', allow: ['example.com'] } },
        });
        const pending = await c.abox.accessRequest(
          A,
          sb.sandbox.id,
          { kind: 'network', details: { domains: ['example.org'] }, reason: 'need example.org' },
          { waitForApprovalMs: 0 },
        );
        expect(pending.status).toBe('pending_approval');
        if (pending.status !== 'pending_approval') return;
        expect(calls).toEqual([]); // nothing applied before the human decided
        expect(await errorOf(c.abox.approve(A, pending.approvalId))).toMatchObject({
          code: 'policy_denied',
        });
        const dec = await c.abox.approve(HUMAN, pending.approvalId, 'ok for e2e');
        expect(dec.applied).toMatchObject({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.allow).toEqual(expect.arrayContaining(['example.com', 'example.org']));
        expect(calls[0]!.privateExceptions).toEqual([]);
        const audit = await c.abox.queryAudit(HUMAN, { sandboxId: sb.sandbox.id, limit: 500 });
        expect(
          audit.some(
            (e) =>
              JSON.stringify(e.details).includes('example.org') && /access|network/.test(e.action),
          ),
        ).toBe(true);
        // a private-address exception is a separate question, and a "no" sticks
        const req = {
          kind: 'network' as const,
          details: { privateExceptions: ['10.0.0.0/8'] },
          reason: 'please',
        };
        const p2 = await c.abox.accessRequest(A, sb.sandbox.id, req, { waitForApprovalMs: 0 });
        expect(p2.status).toBe('pending_approval');
        if (p2.status !== 'pending_approval') return;
        await c.abox.deny(HUMAN, p2.approvalId, 'no');
        expect(
          await errorOf(c.abox.accessRequest(A, sb.sandbox.id, req, { waitForApprovalMs: 0 })),
        ).toMatchObject({ code: 'approval_denied' });
        expect(calls).toHaveLength(1);
      } finally {
        await c.close();
        w.cleanup();
      }
    }, 180_000);

    it('removing the sandbox removes the proxy container and the internal network', async () => {
      const c = await ctx.create(A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        overrides: { network: { mode: 'allowlist', allow: ['example.com'] } },
      });
      const s = c.sandbox.id.split('/')[1]!;
      expect(
        (await docker(['ps', '-a', '-q', '--filter', `name=abox-proxy-${s}`])).stdout.trim(),
      ).not.toBe('');
      await ctx.abox.removeSandbox(A, c.sandbox.id);
      expect(
        (await docker(['ps', '-a', '-q', '--filter', `name=abox-proxy-${s}`])).stdout.trim(),
      ).toBe('');
      expect(
        (await docker(['network', 'ls', '-q', '--filter', `name=abox-int-${s}`])).stdout.trim(),
      ).toBe('');
      expect(
        (
          await docker([
            'volume',
            'ls',
            '-q',
            '--filter',
            'dangling=true',
            '--filter',
            `label=abox.e2e-inst=${ctx.instance}`,
          ])
        ).stdout.trim(),
      ).toBe('');
    }, 120_000);
  });
});
