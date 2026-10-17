import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from './__tests__/helpers.js';
import { proxyImageFiles, proxyRuntimeDir } from './index.js';

// Real Docker + real network (example.com:443). Everything is labelled abox.test=1 and
// removed afterwards. Run with: ABOX_TEST_DOCKER=1 npx vitest run packages/proxy
const enabled = process.env.ABOX_TEST_DOCKER === '1';

const LABEL = 'abox.test=1';
const run = (...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'docker',
      args,
      { encoding: 'utf8', timeout: 240_000, maxBuffer: 16 << 20 },
      (err, stdout, stderr) =>
        err ? reject(new Error(`docker ${args.join(' ')}\n${stderr}`)) : resolve(stdout.trim()),
    );
  });

/** Minimal "sandbox" client: CONNECT through the proxy, TLS handshake, GET /. */
const CLIENT = `
const net = require('net'), tls = require('tls');
const [host, port] = process.argv.slice(1);
const s = net.connect(3128, 'abox-proxy');
s.setTimeout(20000, () => { console.log('TIMEOUT'); process.exit(3); });
s.on('error', (e) => { console.log('ERR ' + e.code); process.exit(2); });
let buf = '';
s.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\\r\\nHost: ' + host + ':' + port + '\\r\\n\\r\\n');
s.on('data', function onData(d) {
  buf += d;
  if (!buf.includes('\\r\\n\\r\\n')) return;
  s.off('data', onData);
  const status = Number(buf.split(' ')[1]);
  if (status !== 200) { console.log('STATUS ' + status); process.exit(0); }
  const t = tls.connect({ socket: s, servername: host });
  t.on('secureConnect', () => t.write('GET / HTTP/1.1\\r\\nHost: ' + host + '\\r\\nConnection: close\\r\\n\\r\\n'));
  let r = ''; t.on('data', (c) => (r += c));
  t.on('end', () => { console.log('HTTP ' + r.split(' ')[1]); process.exit(0); });
  t.on('error', (e) => { console.log('TLSERR ' + (e.code || e.message)); process.exit(0); });
});
`;
const DIRECT = `
const s = require('net').connect(443, '1.1.1.1');
s.setTimeout(5000, () => { console.log('NO-ROUTE-TIMEOUT'); process.exit(0); });
s.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
s.on('error', (e) => { console.log('NO-ROUTE ' + e.code); process.exit(0); });
`;

describe.skipIf(!enabled)('proxy image in Docker', () => {
  const id = Math.random().toString(16).slice(2, 8);
  const image = `abox/proxy-test:${id}`;
  const egress = `abox-test-egress-${id}`;
  const internal = `abox-test-int-${id}`;
  let dir: string;
  let proxyName: string;

  async function startProxyContainer(name: string, config: object): Promise<string> {
    const cfg = join(dir, `${name}.json`);
    writeFileSync(cfg, JSON.stringify(config));
    // Flags from docs/internal/proxy-contract.md. `docker cp` is refused on a read-only
    // rootfs, so /etc/abox-proxy is an (anonymous) volume.
    await run(
      'create',
      '--name',
      name,
      '--label',
      LABEL,
      '--network',
      egress,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '128m',
      '--pids-limit',
      '64',
      '--tmpfs',
      '/run/abox-proxy:uid=10001,mode=0700',
      '-v',
      '/etc/abox-proxy',
      image,
    );
    await run('network', 'connect', '--alias', 'abox-proxy', internal, name);
    await run('cp', cfg, `${name}:/etc/abox-proxy/config.json`);
    await run('start', name);
    for (let i = 0; i < 50; i++) {
      if ((await run('logs', name)).includes('"event":"ready"')) return name;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`proxy not ready:\n${await run('logs', name)}`);
  }

  const client = (host: string, port: number, extra: string[] = []) =>
    run(
      'run',
      '--rm',
      '--label',
      LABEL,
      '--network',
      internal,
      ...extra,
      'node:24-alpine',
      'node',
      '-e',
      CLIENT,
      host,
      String(port),
    );

  beforeAll(async () => {
    dir = makeTempDir('abox-proxy-docker-');
    const ctx = join(dir, 'ctx');
    mkdirSync(ctx);
    for (const f of proxyImageFiles) copyFileSync(join(proxyRuntimeDir, f), join(ctx, f));
    await run('build', '-q', '--label', LABEL, '-t', image, ctx);
    await run('network', 'create', '--label', LABEL, egress);
    await run('network', 'create', '--internal', '--label', LABEL, internal);
  }, 300_000);

  afterAll(async () => {
    const ids = (await run('ps', '-aq', '--filter', `label=${LABEL}`).catch(() => ''))
      .split('\n')
      .filter(Boolean);
    if (ids.length) await run('rm', '-fv', ...ids).catch(() => undefined);
    await run('network', 'rm', egress, internal).catch(() => undefined);
    await run('rmi', '-f', image).catch(() => undefined);
    removeDir(dir);
  }, 120_000);

  it('runs as uid 10001 with the contract hardening and allows/denies from an internal network', async () => {
    proxyName = await startProxyContainer(`abox-test-proxy-${id}`, {
      allow: ['example.com'],
      blockPrivate: true,
    });
    const info = JSON.parse(await run('inspect', proxyName)) as {
      Config: { User: string };
      HostConfig: {
        ReadonlyRootfs: boolean;
        Memory: number;
        PidsLimit: number;
        CapDrop: string[];
        SecurityOpt: string[];
      };
    }[];
    expect(info[0]?.Config.User).toBe('10001');
    expect(info[0]?.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      Memory: 128 * 1024 * 1024,
      PidsLimit: 64,
      CapDrop: ['ALL'],
    });
    expect(await run('exec', proxyName, 'id', '-u')).toBe('10001');

    // The sandbox only has the internal network: no direct way out.
    const direct = await run(
      'run',
      '--rm',
      '--label',
      LABEL,
      '--network',
      internal,
      'node:24-alpine',
      'node',
      '-e',
      DIRECT,
    );
    expect(direct).toMatch(/^NO-ROUTE/);

    // Allowed public host works end to end (real network).
    expect(await client('example.com', 443)).toMatch(/^HTTP [23]\d\d$/);
    // Not allowlisted.
    expect(await client('example.org', 443)).toBe('STATUS 403');
    // Port outside 80/443 for an entry without port.
    expect(await client('example.com', 8443)).toBe('STATUS 403');
    // Cloud metadata / private literals are never reachable.
    expect(await client('169.254.169.254', 80)).toBe('STATUS 403');

    const logs = (await run('logs', proxyName))
      .split('\n')
      .filter((l) => l.includes('"event":"request"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logs).toContainEqual(
      expect.objectContaining({ host: 'example.com', port: 443, decision: 'allow' }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        host: 'example.org',
        decision: 'deny',
        reason: 'not in allowlist',
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ host: '169.254.169.254', decision: 'deny' }),
    );
    await run('rm', '-fv', proxyName);
  }, 120_000);

  it('injects through the real network: CA copied out of the proxy, TLS verified upstream', async () => {
    const name = await startProxyContainer(`abox-test-proxy-inj-${id}`, {
      allow: ['example.com'],
      injections: [{ host: 'example.com', header: 'X-Abox-Test', value: 'injected-secret-value' }],
    });
    const caFile = join(dir, 'ca.crt');
    // `docker cp` cannot read tmpfs mounts: fetch the CA through exec.
    writeFileSync(caFile, await run('exec', name, 'cat', '/run/abox-proxy/ca.crt'));
    const sandbox = `abox-test-sandbox-${id}`;
    await run(
      'create',
      '--name',
      sandbox,
      '--label',
      LABEL,
      '--network',
      internal,
      '-e',
      'NODE_EXTRA_CA_CERTS=/ca.crt',
      'node:24-alpine',
      'node',
      '-e',
      CLIENT,
      'example.com',
      '443',
    );
    await run('cp', caFile, `${sandbox}:/ca.crt`);
    const out = (await run('start', '-a', sandbox)).trim();
    expect(out).toMatch(/^HTTP [23]\d\d$/);
    const logs = await run('logs', name);
    expect(logs).toContain('"injected":true');
    expect(logs).not.toContain('injected-secret-value');
    await run('rm', '-fv', sandbox, name);
  }, 120_000);
});
