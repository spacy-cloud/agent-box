import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import type { NetworkSpec, PreparedImage, ResolvedTemplate, SandboxSpec } from '@abox/core';
import { simpleExec } from './exec.js';
import { makeSpec, makeTemplate } from './__tests__/helpers.js';
import {
  TEST_LABEL,
  TEST_PID_LABEL,
  TEST_RUN,
  dockerEnabled,
  newProvider,
  sweepTestObjects,
} from './__tests__/harness.js';
import { defaultProxyAssets } from './proxy.js';

const raw = new Docker({ socketPath: '/var/run/docker.sock' });
const proxyAvailable =
  defaultProxyAssets !== undefined && existsSync(`${defaultProxyAssets.runtimeDir}/proxy.mjs`);

const allow = (
  domains: string[],
  over: Partial<NetworkSpec> = {},
  injections: NetworkSpec['injections'] = [],
): NetworkSpec => ({
  mode: 'allowlist',
  allow: domains,
  blockPrivate: true,
  privateExceptions: [],
  injections,
  ...over,
});

// The destinations are two aliases of a tiny web server on `abox-egress`, the network the proxy
// reaches the outside world through: deterministic, no internet needed. The server sits on a private
// address, hence the private exception.
const UP_A = 'a.update-net.test';
const UP_B = 'b.update-net.test';

describe.skipIf(!dockerEnabled || !proxyAvailable)('updateNetwork (real docker)', () => {
  const provider = newProvider();
  let template: ResolvedTemplate;
  let image: PreparedImage;
  let exceptions: string[] = [];
  let upstream: Docker.Container | undefined;
  const ids: string[] = [];

  const create = async (network: NetworkSpec, start = true): Promise<SandboxSpec> => {
    const s = makeSpec(template, image.ref, { network });
    ids.push(s.id);
    await provider.create(s);
    if (start) await provider.start(s.id);
    return s;
  };
  const withException = (domains: string[], injections: NetworkSpec['injections'] = []) =>
    allow(domains, { privateExceptions: exceptions }, injections);

  /** Fetch a URL through the sandbox; true when the web server answered. */
  const reachable = async (s: SandboxSpec, host: string): Promise<boolean> => {
    const r = await provider.exec(s.id, {
      command: `wget -q -T 8 -O- http://${host}/alpine-release`,
      timeoutMs: 20_000,
    });
    return r.exitCode === 0 && /^\d+\.\d+/.test(r.stdout);
  };
  const proxyConfig = async (s: SandboxSpec): Promise<string> => {
    const short = s.id.split('/')[1];
    const r = await simpleExec(raw, `abox-proxy-${short}`, ['cat', '/etc/abox-proxy/config.json']);
    expect(r.exitCode).toBe(0);
    return r.stdout.toString('utf8');
  };

  beforeAll(async () => {
    await provider.init();
    template = makeTemplate({ name: `abox-test-updnet-${TEST_RUN}` });
    image = await provider.prepare(template);
    // The first allowlist sandbox creates `abox-egress`.
    const first = await create(withException([]), false);
    const net = await raw.getNetwork('abox-egress').inspect();
    const subnet = (net.IPAM?.Config ?? []).map((c: { Subnet?: string }) => c.Subnet).find(Boolean);
    exceptions = subnet ? [subnet as string] : ['172.16.0.0/12'];
    // The proxy image has node: a web server that answers every path with a version-like body.
    const proxyImage = (await raw.getContainer(`abox-proxy-${first.id.split('/')[1]}`).inspect())
      .Config.Image;
    upstream = await raw.createContainer({
      name: `abox-dtest-upstream-${TEST_RUN}`,
      Image: proxyImage,
      Labels: { [TEST_LABEL]: TEST_RUN, [TEST_PID_LABEL]: String(process.pid) },
      Entrypoint: [
        'node',
        '-e',
        "require('http').createServer((q,r)=>r.end('3.22.0\\n')).listen(80)",
      ],
      User: 'root',
      HostConfig: { NetworkMode: 'abox-egress' },
      NetworkingConfig: {
        EndpointsConfig: { 'abox-egress': { Aliases: [UP_A, UP_B] } },
      },
    });
    await upstream.start();
  }, 300_000);

  afterAll(async () => {
    for (const id of ids) await provider.remove(id).catch(() => undefined);
    await upstream?.remove({ force: true, v: true }).catch(() => undefined);
    await sweepTestObjects();
  }, 120_000);

  it('a denied domain becomes reachable and a reachable one denied, without recreating the sandbox', async () => {
    const s = await create(withException([UP_A]));
    const before = await raw.getContainer(`abox-local-${s.id.split('/')[1]}`).inspect();
    expect(await reachable(s, UP_A)).toBe(true);
    expect(await reachable(s, UP_B)).toBe(false);

    await provider.updateNetwork(s.id, withException([UP_B]));
    expect(await reachable(s, UP_B)).toBe(true);
    expect(await reachable(s, UP_A)).toBe(false);

    await provider.updateNetwork(s.id, withException([UP_A, UP_B]));
    expect(await reachable(s, UP_A)).toBe(true);
    expect(await reachable(s, UP_B)).toBe(true);

    // the decisions are in the proxy log
    const ev = await provider.networkEvents!(s.id);
    expect(ev.some((e) => e.host === UP_B && e.decision === 'deny')).toBe(true);
    expect(ev.some((e) => e.host === UP_B && e.decision === 'allow')).toBe(true);

    // same container, still running, same network wiring and mode
    const after = await raw.getContainer(`abox-local-${s.id.split('/')[1]}`).inspect();
    expect(after.Id).toBe(before.Id);
    expect(after.State.Running).toBe(true);
    expect(after.HostConfig.NetworkMode).toBe(before.HostConfig.NetworkMode);
    expect(after.Config.Labels['abox.network-mode']).toBe('allowlist');
    expect((await provider.inspect(s.id)).state).toBe('running');
    const cfg = JSON.parse(await proxyConfig(s)) as { allow: string[] };
    expect(cfg.allow).toEqual([UP_A, UP_B]);
  }, 180_000);

  it('private exceptions are part of the rules', async () => {
    const s = await create(allow([UP_A]));
    expect(await reachable(s, UP_A)).toBe(false); // private address, no exception
    await provider.updateNetwork(s.id, withException([UP_A]));
    expect(await reachable(s, UP_A)).toBe(true);
    await provider.updateNetwork(s.id, allow([UP_A]));
    expect(await reachable(s, UP_A)).toBe(false);
  }, 180_000);

  it('a stopped sandbox gets the new rules with its next start', async () => {
    const s = await create(withException([UP_A]));
    expect(await reachable(s, UP_B)).toBe(false);
    await provider.stop(s.id);
    await provider.updateNetwork(s.id, withException([UP_B]));
    const short = s.id.split('/')[1];
    expect((await raw.getContainer(`abox-proxy-${short}`).inspect()).State.Running).toBe(false);
    await provider.start(s.id);
    expect(await reachable(s, UP_B)).toBe(true);
    expect(await reachable(s, UP_A)).toBe(false);
  }, 180_000);

  it('rules that the proxy rejects are refused and the previous rules stay active', async () => {
    const s = await create(withException([UP_A]));
    await expect(
      provider.updateNetwork(s.id, withException(['not a domain!!'])),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const cfg = JSON.parse(await proxyConfig(s)) as { allow: string[] };
    expect(cfg.allow).toEqual([UP_A]);
    const short = s.id.split('/')[1];
    expect((await raw.getContainer(`abox-proxy-${short}`).inspect()).State.Running).toBe(true);
    expect(await reachable(s, UP_A)).toBe(true);
    expect(await reachable(s, UP_B)).toBe(false);
  }, 180_000);

  it('injections: new values replace the old ones and the sandbox gets the new CA', async () => {
    const inj = (value: string): NetworkSpec['injections'] => [
      { host: UP_A, header: 'Authorization', value },
    ];
    const s = await create(withException([UP_A], inj('Bearer FIRST-SECRET-VALUE')));
    const caPath = '/usr/local/share/abox/ca.crt';
    const bundlePath = '/usr/local/share/abox/ca-bundle.crt';
    const ca1 = (await provider.readFile(s.id, caPath, 100_000)).data.toString();
    expect(ca1).toContain('BEGIN CERTIFICATE');
    expect(await proxyConfig(s)).toContain('FIRST-SECRET-VALUE');

    await provider.updateNetwork(s.id, withException([UP_A], inj('Bearer SECOND-SECRET-VALUE')));
    const ca2 = (await provider.readFile(s.id, caPath, 100_000)).data.toString();
    expect(ca2).toContain('BEGIN CERTIFICATE');
    expect(ca2).not.toBe(ca1); // the restarted proxy issued a new CA
    const bundle = (await provider.readFile(s.id, bundlePath, 10 * 1024 * 1024)).data.toString();
    expect(bundle).toContain(ca2.trim());
    expect(bundle).not.toContain(ca1.trim());
    const cfg = await proxyConfig(s);
    expect(cfg).toContain('SECOND-SECRET-VALUE');
    expect(cfg).not.toContain('FIRST-SECRET-VALUE');
    // secrets only live in the config file, never in env or labels
    const c = await raw.getContainer(`abox-local-${s.id.split('/')[1]}`).inspect();
    const p = await raw.getContainer(`abox-proxy-${s.id.split('/')[1]}`).inspect();
    expect(JSON.stringify(c.Config) + JSON.stringify(p.Config)).not.toContain('SECRET-VALUE');
    expect(await reachable(s, UP_A)).toBe(false); // plain http to an injection host is denied

    // dropping the injections keeps the sandbox usable, also across a restart
    await provider.updateNetwork(s.id, withException([UP_A]));
    expect(await proxyConfig(s)).not.toContain('SECOND-SECRET-VALUE');
    await provider.stop(s.id);
    await provider.start(s.id);
    expect(await reachable(s, UP_A)).toBe(true);
  }, 240_000);

  it('adding injections to a sandbox created without them is unsupported', async () => {
    const s = await create(withException([UP_A]));
    await expect(
      provider.updateNetwork(
        s.id,
        withException([UP_A], [{ host: UP_A, header: 'X-Key', value: 'v' }]),
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(await reachable(s, UP_A)).toBe(true); // untouched
  }, 120_000);

  it('none and open sandboxes have no rules to change: unsupported', async () => {
    const none = makeSpec(template, image.ref);
    const open = makeSpec(template, image.ref, {
      network: {
        mode: 'open',
        allow: [],
        blockPrivate: true,
        privateExceptions: [],
        injections: [],
      },
    });
    for (const s of [none, open]) {
      ids.push(s.id);
      await provider.create(s);
    }
    for (const s of [none, open]) {
      await expect(provider.updateNetwork(s.id, allow(['example.com']))).rejects.toMatchObject({
        code: 'unsupported',
        message: expect.stringMatching(/only the rules of an allowlist sandbox/),
      });
    }
  }, 120_000);

  it('the mode of an allowlist sandbox cannot change; unknown and foreign sandboxes are not found', async () => {
    const s = await create(withException([UP_A]));
    await expect(
      provider.updateNetwork(s.id, { ...allow([]), mode: 'open' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(provider.updateNetwork('local/ffffffff', allow([UP_A]))).rejects.toMatchObject({
      code: 'not_found',
    });
    const other = newProvider({ instanceId: 'dtest-someone-else' });
    await expect(other.updateNetwork(s.id, allow([UP_B]))).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await reachable(s, UP_A)).toBe(true);
  }, 120_000);
});
