import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makePki,
  makeTempDir,
  removeDir,
  startProxy,
  type RunningProxy,
} from './__tests__/helpers.js';

// `git clone` / `git push` over HTTPS through the proxy with injection-based auth,
// against a local smart-HTTP server (a tiny Node CGI wrapper around `git http-backend`).

function findHttpBackend(): string | undefined {
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const p = join(execPath, 'git-http-backend');
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

const backend = findHttpBackend();
const TOKEN = 'Basic ' + Buffer.from('x-access-token:git-secret-0f3a9c').toString('base64');

describe.skipIf(!backend)('git over HTTPS through the proxy', () => {
  let dir: string;
  let server: https.Server;
  let serverPort: number;
  let proxy: RunningProxy;
  let unauthenticated = 0;
  let env: NodeJS.ProcessEnv;
  // Must be async: the test server runs in this process, a blocking call would deadlock.
  const git = (args: string[], cwd?: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd, env, encoding: 'utf8', timeout: 60_000 },
        (err, stdout, stderr) =>
          err ? reject(new Error(`git ${args.join(' ')} failed: ${stderr}`)) : resolve(stdout),
      );
    });

  beforeAll(async () => {
    dir = makeTempDir('abox-proxy-git-');
    const pki = makePki(dir, ['git.test']);
    // Bare repository with one commit and a ~3 MB blob.
    const root = join(dir, 'srv');
    mkdirSync(root);
    const bare = join(root, 'repo.git');
    const seed = join(dir, 'seed');
    const gitEnv = {
      ...process.env,
      HOME: dir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['init', '-q', '-b', 'main', seed], { env: gitEnv });
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    writeFileSync(
      join(seed, 'blob.bin'),
      Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => (i * 2654435761) % 251)),
    );
    execFileSync('git', ['add', '.'], { cwd: seed, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: seed, env: gitEnv });
    execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: gitEnv });
    execFileSync('git', ['config', 'http.receivepack', 'true'], { cwd: bare, env: gitEnv });

    server = https.createServer({ key: pki.keyPem, cert: pki.certPem }, (req, res) => {
      if (req.headers.authorization !== TOKEN) {
        unauthenticated++;
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
        res.end('unauthorized');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'https://git.test');
        const cgi = spawn(backend as string, [], {
          env: {
            PATH: process.env.PATH ?? '',
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: req.method ?? 'GET',
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers['content-type'] ?? '',
            CONTENT_LENGTH: String(body.length),
            HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
            REMOTE_USER: 'x-access-token',
            REMOTE_ADDR: '127.0.0.1',
            GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
          },
        });
        cgi.stdin.on('error', () => {});
        cgi.stdin.end(body);
        let head = '';
        let headDone = false;
        cgi.stdout.on('data', (d: Buffer) => {
          if (headDone) {
            res.write(d);
            return;
          }
          head += d.toString('latin1');
          const idx = head.indexOf('\r\n\r\n');
          if (idx === -1) return;
          headDone = true;
          let status = 200;
          const headers: Record<string, string> = {};
          for (const line of head.slice(0, idx).split('\r\n')) {
            const [k, ...v] = line.split(': ');
            if (k?.toLowerCase() === 'status') status = Number.parseInt(v.join(': '), 10);
            else if (k) headers[k] = v.join(': ');
          }
          res.writeHead(status, headers);
          res.write(Buffer.from(head.slice(idx + 4), 'latin1'));
        });
        cgi.on('close', () => res.end());
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    serverPort = (server.address() as AddressInfo).port;

    proxy = await startProxy(dir, {
      allow: [`git.test:${serverPort}`],
      privateExceptions: ['127.0.0.1/32'],
      upstreamCaFile: pki.caFile,
      dnsOverrides: { 'git.test': ['127.0.0.1'] },
      injections: [{ host: 'git.test', header: 'Authorization', value: TOKEN }],
    });
    env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      // Exactly what the Docker backend sets inside the sandbox:
      HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
      HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
      GIT_SSL_CAINFO: join(proxy.stateDir, 'ca.crt'),
    };
  });

  afterAll(async () => {
    await proxy?.stop();
    server?.closeAllConnections();
    server?.close();
    removeDir(dir);
  });

  it('clones through the MITM proxy; the client never holds the token', async () => {
    const dest = join(dir, 'clone');
    await git(['clone', '-q', `https://git.test:${serverPort}/repo.git`, dest]);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('hello\n');
    expect(readFileSync(join(dest, 'blob.bin')).length).toBe(3_000_000);
    expect(unauthenticated).toBe(0);
    expect(JSON.stringify(env)).not.toContain('git-secret');
    expect(proxy.stdout()).not.toContain('git-secret');
    expect(proxy.stdout()).not.toContain(TOKEN);
    const methods = proxy
      .requests()
      .filter((e) => e.injected)
      .map((e) => e.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  it('pushes a large commit (chunked request body) through the proxy', async () => {
    const dest = join(dir, 'clone2');
    await git(['clone', '-q', `https://git.test:${serverPort}/repo.git`, dest]);
    writeFileSync(
      join(dest, 'big.bin'),
      Buffer.from(Array.from({ length: 2_000_000 }, (_, i) => (i * 40503) % 256)),
    );
    await git(['add', '.'], dest);
    await git(['commit', '-q', '-m', 'big'], dest);
    // A tiny postBuffer forces git to use Transfer-Encoding: chunked.
    await git(
      ['-c', 'http.postBuffer=1024', 'push', '-q', 'origin', 'HEAD:refs/heads/pushed'],
      dest,
    );
    const out = await git(['ls-remote', `https://git.test:${serverPort}/repo.git`]);
    expect(out).toContain('refs/heads/pushed');
    expect(unauthenticated).toBe(0);
  });

  it('without the proxy-injected token the server would refuse (sanity check)', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      https
        .get(
          `https://127.0.0.1:${serverPort}/repo.git/info/refs?service=git-upload-pack`,
          { rejectUnauthorized: false },
          (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          },
        )
        .on('error', reject);
    });
    expect(res).toBe(401);
  });
});
