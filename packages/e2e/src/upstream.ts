/**
 * A local HTTPS upstream for the egress/secret tests: a container on the proxy's egress network that serves
 *   - `GET /headers`          the request headers as JSON (so the test can see what the proxy added),
 *   - `GET /bearer`           200 only with `Authorization: Bearer <token>`,
 *   - `/repo.git/*`           a git repository over smart HTTP (`git http-backend`), Basic auth `x-access-token:<token>`,
 * on https :443 (certificate issued by a throw-away test CA) and plain http :80. Every request is logged as one
 * JSON line, which is the independent evidence of what actually reached the upstream.
 *
 * Because the upstream has a private address, tests reach it through an approved `privateExceptions` entry. The
 * proxy must trust the test CA to verify the upstream, so the proxy image is rebuilt from the real runtime files
 * plus `NODE_EXTRA_CA_CERTS=/opt/e2e-ca.pem` (see `proxyAssetsWithCa`); no proxy code is changed.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DockerProviderOptions } from '@abox/backend-docker';
import { RUN, docker } from './harness.js';

type ProxyAssets = Exclude<NonNullable<DockerProviderOptions['proxy']>, false>;

/** Unique per run: two upstreams with the same network alias would make docker DNS return both addresses. */
export const UPSTREAM_HOST = `up-${RUN}.e2e.test`;
export const OTHER_HOST = `other-${RUN}.e2e.test`;
export const EGRESS_NETWORK = 'abox-egress';
const IMAGE = 'abox-e2e-upstream:1';

const SERVER_MJS = String.raw`
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const TOKEN = process.env.E2E_TOKEN;
const bearer = 'Bearer ' + TOKEN;
const basic = 'Basic ' + Buffer.from('x-access-token:' + TOKEN).toString('base64');

function log(scheme, req) {
  console.log(JSON.stringify({ t: Date.now(), scheme, host: req.headers.host ?? null, sni: req.socket.servername ?? null,
    method: req.method, url: req.url, authorization: req.headers.authorization ?? null,
    xTest: req.headers['x-e2e'] ?? null, remote: req.socket.remoteAddress }));
}

function gitBackend(req, res, url) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const env = {
      PATH: process.env.PATH, HOME: '/root', GIT_PROJECT_ROOT: '/srv/git', GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length),
      REMOTE_USER: 'x-access-token', REMOTE_ADDR: req.socket.remoteAddress ?? '', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com',
    };
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
    if (req.headers['git-protocol']) env.HTTP_GIT_PROTOCOL = req.headers['git-protocol'];
    const child = spawn('git', ['http-backend'], { env });
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => process.stderr.write(c));
    child.on('close', () => {
      const buf = Buffer.concat(out);
      let sep = buf.indexOf('\r\n\r\n'); let sepLen = 4;
      if (sep < 0) { sep = buf.indexOf('\n\n'); sepLen = 2; }
      if (sep < 0) { res.writeHead(500); return res.end('bad cgi output'); }
      const headers = {}; let status = 200;
      for (const line of buf.subarray(0, sep).toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf(':'); if (i < 0) continue;
        const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10); else headers[k] = v;
      }
      res.writeHead(status, headers); res.end(buf.subarray(sep + sepLen));
    });
    child.stdin.end(body);
  });
}

function handler(scheme) {
  return (req, res) => {
    log(scheme, req);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ headers: req.headers }));
    }
    if (url.pathname === '/bearer') {
      if (req.headers.authorization === bearer) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="e2e"' }); return res.end('unauthorized');
    }
    if (url.pathname.startsWith('/repo.git')) {
      if (req.headers.authorization !== basic) { res.writeHead(401, { 'www-authenticate': 'Basic realm="e2e"' }); return res.end('unauthorized'); }
      return gitBackend(req, res, url);
    }
    res.writeHead(404); res.end('not found');
  };
}

https.createServer({ key: fs.readFileSync('/srv/tls/leaf.key'), cert: fs.readFileSync('/srv/tls/leaf.pem') }, handler('https')).listen(443, '0.0.0.0');
http.createServer(handler('http')).listen(80, '0.0.0.0', () => console.log(JSON.stringify({ ready: true })));
`;

const ENTRY_SH = `set -e
git config --global user.email e2e@example.com
git config --global user.name e2e
git config --global init.defaultBranch main
git config --global --add safe.directory '*'
mkdir -p /srv/git
git init -q --bare /srv/git/repo.git
git init -q /tmp/seed
cd /tmp/seed
printf '%s\\n' "$REPO_MARKER" > README
git add -A
git commit -q -m seed
git push -q /srv/git/repo.git HEAD:refs/heads/main
git -C /srv/git/repo.git symbolic-ref HEAD refs/heads/main
cd /srv
exec node /srv/server.mjs
`;

function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) =>
      err
        ? reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`))
        : resolve(stdout),
    );
  });
}

export interface UpstreamRequest {
  t: number;
  scheme: 'http' | 'https';
  host: string | null;
  sni: string | null;
  method: string;
  url: string;
  authorization: string | null;
  xTest: string | null;
  remote: string;
}

export interface Upstream {
  container: string;
  ip: string;
  token: string;
  repoMarker: string;
  caPem: string;
  /** Everything the upstream has seen so far. */
  requests(): Promise<UpstreamRequest[]>;
  stop(): Promise<void>;
}

async function ensureUpstreamImage(): Promise<void> {
  const have = await docker(['image', 'inspect', IMAGE]);
  if (have.code === 0) return;
  const df = `FROM node:24-alpine\nRUN for i in 1 2 3; do apk add --no-cache git git-daemon && break; sleep 1; done; test -x /usr/libexec/git-core/git-http-backend && git --version\n`;
  const r = await docker(['build', '-t', IMAGE, '--label', 'abox.e2e-cache=1', '-'], {
    input: df,
    timeoutMs: 300_000,
  });
  if (r.code !== 0) throw new Error(`building ${IMAGE} failed: ${r.stderr}`);
}

/** Creates `abox-egress` if nobody has yet (the backend would create the same thing on the first allowlist create). */
export async function ensureEgressNetwork(): Promise<void> {
  const r = await docker(['network', 'inspect', EGRESS_NETWORK]);
  if (r.code === 0) return;
  await docker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--label',
    'abox.managed=1',
    '--label',
    'abox.role=network',
    '--label',
    'abox.test=e2e',
    '--label',
    `abox.e2e=${RUN}`,
    EGRESS_NETWORK,
  ]);
}

export async function startUpstream(): Promise<Upstream> {
  await ensureUpstreamImage();
  await ensureEgressNetwork();
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'abox-e2e-tls-'));
  const token = `E2E_TOKEN_${randomBytes(12).toString('hex')}`;
  const repoMarker = `E2E-REPO-MARKER-${randomBytes(6).toString('hex')}`;
  try {
    await sh(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-subj',
        '/CN=abox-e2e-test-ca',
        '-days',
        '2',
      ],
      dir,
    );
    await sh(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'leaf.key',
        '-out',
        'leaf.csr',
        '-subj',
        `/CN=${UPSTREAM_HOST}`,
      ],
      dir,
    );
    writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=DNS:${UPSTREAM_HOST},DNS:${OTHER_HOST}\n`);
    await sh(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        'leaf.csr',
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'leaf.pem',
        '-days',
        '2',
        '-extfile',
        'ext.cnf',
      ],
      dir,
    );
    writeFileSync(join(dir, 'server.mjs'), SERVER_MJS);
    writeFileSync(join(dir, 'entry.sh'), ENTRY_SH, { mode: 0o755 });

    const name = `abox-e2e-upstream-${randomBytes(3).toString('hex')}`;
    const created = await docker([
      'create',
      '--name',
      name,
      '--network',
      EGRESS_NETWORK,
      '--network-alias',
      UPSTREAM_HOST,
      '--network-alias',
      OTHER_HOST,
      '--label',
      'abox.test=e2e',
      '--label',
      `abox.e2e=${RUN}`,
      '-e',
      `E2E_TOKEN=${token}`,
      '-e',
      `REPO_MARKER=${repoMarker}`,
      '--memory',
      '256m',
      '--pids-limit',
      '128',
      IMAGE,
      'sh',
      '/srv/entry.sh',
    ]);
    if (created.code !== 0) throw new Error(`docker create failed: ${created.stderr}`);
    for (const [src, dst] of [
      ['server.mjs', '/srv/server.mjs'],
      ['entry.sh', '/srv/entry.sh'],
    ] as const) {
      const r = await docker(['cp', join(dir, src), `${name}:${dst}`]);
      if (r.code !== 0) throw new Error(`docker cp failed: ${r.stderr}`);
    }
    await sh('mkdir', ['-p', join(dir, 'tls')]);
    for (const f of ['leaf.key', 'leaf.pem']) {
      await sh('cp', [join(dir, f), join(dir, 'tls', f)]);
    }
    const cp = await docker(['cp', join(dir, 'tls'), `${name}:/srv/tls`]);
    if (cp.code !== 0) throw new Error(`docker cp tls failed: ${cp.stderr}`);
    const started = await docker(['start', name]);
    if (started.code !== 0) throw new Error(`docker start failed: ${started.stderr}`);

    const caPem = readFileSync(join(dir, 'ca.pem'), 'utf8');
    const requests = async (): Promise<UpstreamRequest[]> => {
      const logs = await docker(['logs', name]);
      return `${logs.stdout}\n${logs.stderr}`
        .split('\n')
        .filter((l) => l.startsWith('{"t":'))
        .map((l) => JSON.parse(l) as UpstreamRequest);
    };
    // ready line
    const deadline = Date.now() + 60_000;
    for (;;) {
      const logs = await docker(['logs', name]);
      if (`${logs.stdout}${logs.stderr}`.includes('"ready":true')) break;
      const st = await docker(['inspect', '--format', '{{.State.Running}}', name]);
      if (st.stdout.trim() !== 'true')
        throw new Error(`upstream container died: ${logs.stdout}${logs.stderr}`);
      if (Date.now() > deadline)
        throw new Error(`upstream not ready: ${logs.stdout}${logs.stderr}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const ipR = await docker([
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${EGRESS_NETWORK}").IPAddress}}`,
      name,
    ]);
    const ip = ipR.stdout.trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip))
      throw new Error(`could not determine the upstream IP: ${ipR.stdout}${ipR.stderr}`);
    return {
      container: name,
      ip,
      token,
      repoMarker,
      caPem,
      requests,
      async stop() {
        await docker(['rm', '-f', '-v', name]);
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The real proxy runtime files with one extra layer: the test CA as `NODE_EXTRA_CA_CERTS`, so the proxy's
 * (full, unchanged) upstream certificate verification accepts the local upstream.
 */
export function proxyAssetsWithCa(caPem: string): { assets: ProxyAssets; cleanup(): void } {
  const runtime = fileURLToPath(new URL('../../proxy/runtime/', import.meta.url));
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'abox-e2e-proxy-'));
  cpSync(runtime, dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'e2e-ca.pem'), caPem);
  const base = readFileSync(join(runtime, 'Dockerfile'), 'utf8');
  if (!base.includes('USER 10001'))
    throw new Error('proxy Dockerfile changed: adapt proxyAssetsWithCa');
  const dockerfile = base.replace(
    'USER 10001',
    'COPY e2e-ca.pem /opt/e2e-ca.pem\nENV NODE_EXTRA_CA_CERTS=/opt/e2e-ca.pem\nUSER 10001',
  );
  return {
    assets: { runtimeDir: dir, dockerfile, files: ['proxy.mjs', 'lib.mjs', 'e2e-ca.pem'] },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
