#!/usr/bin/env node
// A stand-in for the `ssh` binary in tests (no sshd, no network). Configured by environment:
//   FAKE_SSH_LOG     file; every invocation appends its argv as one JSON line
//   FAKE_SSH_G       what `ssh -G` prints (default: nothing, i.e. no forwards)
//   FAKE_SSH_INFO    JSON document served as `GET /info` (plus a fixed /version) by the engine this fake "forwards"
//                    (default: a rootless engine with runc); "none" answers 404
//   FAKE_SSH_MASTER  "1": `ssh -O exit` reports a live master (exit 0), else 255
//   FAKE_SSH_ENV_LOG file; the environment variable names of the process are appended (one line)
//   FAKE_SSH_CONF_COPY / FAKE_SSH_SCAN_KEY  a host key scan (`-F <conf> ... true`): the -F config is
//                    copied to the first, and the second (`<type> <base64>`) is stored for the scanned
//                    host in the throwaway known_hosts the config names, like a handshake would
// `-N -L <local>:<remote>` (the engine tunnel) serves /_ping and /info on <local> until it is
// terminated. Every other call (probe, session, scan) just exits 0 after logging.
import { appendFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';

const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_SSH_LOG) appendFileSync(env.FAKE_SSH_LOG, `${JSON.stringify(argv)}\n`);
if (env.FAKE_SSH_ENV_LOG) appendFileSync(env.FAKE_SSH_ENV_LOG, `${Object.keys(env).join(' ')}\n`);

if (argv.includes('-G')) {
  process.stdout.write(env.FAKE_SSH_G ?? '');
  process.exit(0);
}
const f = argv.indexOf('-F');
if (f >= 0 && env.FAKE_SSH_CONF_COPY) copyFileSync(argv[f + 1], env.FAKE_SSH_CONF_COPY);
if (f >= 0 && env.FAKE_SSH_SCAN_KEY && argv.at(-1) === 'true') {
  const conf = readFileSync(argv[f + 1], 'utf8');
  const field = (k) => new RegExp(`^\\s*${k}\\s+(.+)$`, 'm').exec(conf)?.[1].trim();
  const port = field('Port');
  const host = field('HostName');
  appendFileSync(
    field('UserKnownHostsFile'),
    `${port === '22' ? host : `[${host}]:${port}`} ${env.FAKE_SSH_SCAN_KEY}\n`,
  );
  process.exit(255);
}
const o = argv.indexOf('-O');
if (o >= 0) process.exit(argv[o + 1] === 'exit' && env.FAKE_SSH_MASTER === '1' ? 0 : 255);

const l = argv.indexOf('-L');
if (argv.includes('-N') && l >= 0) {
  const spec = argv[l + 1] ?? '';
  const local = spec.slice(0, spec.indexOf(':'));
  const info =
    env.FAKE_SSH_INFO ??
    '{"SecurityOptions":["name=seccomp","name=rootless"],"Runtimes":{"runc":{}}}';
  const server = createServer((req, res) => {
    // dockerode asks for `/info?` and `/version?`
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (path === '/_ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
    } else if (path === '/info' && info !== 'none') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(info);
    } else if (path === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"Version":"27.0.0-fake","ApiVersion":"1.46"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  rmSync(local, { force: true });
  server.listen(local);
  const stop = () => {
    rmSync(local, { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  process.exit(0);
}
