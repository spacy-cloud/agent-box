import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE = 'abox-test-sshd:3';

const DOCKERFILE = `FROM alpine:3.22
RUN apk add --no-cache openssh-server \\
 && adduser -D -s /bin/sh abox \\
 && echo "abox:$(head -c 24 /dev/urandom | base64)" | chpasswd \\
 && sed -i '/^AllowTcpForwarding/d' /etc/ssh/sshd_config \\
 && printf 'PasswordAuthentication no\\nPermitRootLogin no\\nAllowTcpForwarding yes\\nPerSourcePenalties no\\n' >> /etc/ssh/sshd_config
CMD ["sh", "-c", "mkdir -p /home/abox/.ssh && echo \\"$PUBKEY\\" > /home/abox/.ssh/authorized_keys && chown -R abox:abox /home/abox/.ssh && chmod 700 /home/abox/.ssh && chmod 600 /home/abox/.ssh/authorized_keys && ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
`;

export interface ThrowawaySshd {
  container: string;
  host: string;
  port: number;
  /** Private key of the test user (in a temp dir; never the real ~/.ssh). */
  identityFile: string;
  /** SHA256:… of the server's ed25519 host key. */
  fingerprint(): string;
  /** New host keys + reload: simulates a reinstalled server / man in the middle. */
  rotateHostKeys(): void;
  stop(): void;
}

/** A throwaway sshd in a container, listening on a random loopback port, with one key-only user `abox`. */
export function startSshd(dir: string): ThrowawaySshd {
  const have = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
  if (!have) {
    execFileSync('docker', ['build', '--force-rm', '-t', IMAGE, '-'], {
      input: DOCKERFILE,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const identityFile = join(dir, 'id_test');
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'abox-e2e',
    '-f',
    identityFile,
  ]);
  const pub = readFileSync(`${identityFile}.pub`, 'utf8').trim();
  const container = execFileSync(
    'docker',
    ['run', '-d', '--rm', '-p', '127.0.0.1::22', '-e', `PUBKEY=${pub}`, IMAGE],
    { encoding: 'utf8' },
  ).trim();
  const mapping = execFileSync('docker', ['port', container, '22/tcp'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]!;
  const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
  const sshd: ThrowawaySshd = {
    container,
    host: '127.0.0.1',
    port,
    identityFile,
    fingerprint() {
      const out = execFileSync(
        'docker',
        ['exec', container, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub'],
        { encoding: 'utf8' },
      );
      return /SHA256:\S+/.exec(out)![0];
    },
    rotateHostKeys() {
      execFileSync('docker', [
        'exec',
        container,
        'sh',
        '-c',
        'rm -f /etc/ssh/ssh_host_* && ssh-keygen -A',
      ]);
      execFileSync('docker', ['kill', '-s', 'HUP', container]);
    },
    stop() {
      spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    },
  };
  // wait until sshd answers
  const deadline = Date.now() + 30_000;
  for (;;) {
    const r = spawnSync(
      'ssh-keyscan',
      ['-T', '2', '-p', String(port), '-t', 'ed25519', sshd.host],
      {
        encoding: 'utf8',
      },
    );
    if (r.stdout.includes('ssh-ed25519')) break;
    if (Date.now() > deadline) {
      sshd.stop();
      throw new Error('the test sshd did not come up');
    }
    spawnSync('sleep', ['0.5']);
  }
  return sshd;
}
