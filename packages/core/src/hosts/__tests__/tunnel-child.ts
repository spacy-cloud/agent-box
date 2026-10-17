// Child process of tunnel.test.ts: opens an engine tunnel (through the fake ssh) and then waits
// until the parent kills it with SIGKILL, which leaves Node no chance to close anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { hostsEnvFromPaths } from '../ssh-args.js';
import { TunnelManager } from '../tunnel.js';

const [runtimeDir, fakeSsh, marker] = process.argv.slice(2);
if (!runtimeDir || !fakeSsh || !marker)
  throw new Error('usage: tunnel-child <runtimeDir> <ssh> <marker>');

const env = hostsEnvFromPaths(
  { configDir: `${runtimeDir}/config`, runtimeDir },
  { sshConfigFile: null, sshBinary: fakeSsh, connectTimeoutSec: 2 },
);
const tunnels = new TunnelManager(env);
const t = await tunnels.get(
  {
    id: 'crash',
    kind: 'ssh',
    hostname: 'crash.example.org',
    zone: 'lab',
    backends: ['docker'],
    tags: [],
    favorite: false,
    portForwards: [],
  },
  { remoteSocket: '/run/user/1000/podman/podman.sock' },
);
const [sshPid] = readFileSync(`${t.localSocket}.pid`, 'utf8').trim().split(/\s+/);
writeFileSync(
  marker,
  JSON.stringify({ ownerPid: process.pid, sshPid: Number(sshPid), socket: t.localSocket }),
);
await new Promise<never>(() => undefined);
