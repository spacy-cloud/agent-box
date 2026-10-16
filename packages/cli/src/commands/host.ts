import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { Option } from 'commander';
import {
  AboxError,
  HOST_BACKEND_KINDS,
  HOST_ZONES,
  ISOLATION_LEVELS,
  auditSession,
  checkHostKey,
  forgetHostKey,
  importSshConfig,
  sshBinary,
  sshSessionArgs,
  testHost,
  trustHostKey,
  type HostBackendKind,
  type HostProfile,
  type HostProfileInput,
  type IsolationLevel,
} from '@abox/core';
import type { Cli } from '../cli.js';
import { CliExit } from '../errors.js';
import { formatRelative, renderKeyValues, renderTable, safe } from '../format.js';
import { collect, commaList, invalid } from '../parse.js';

function address(p: HostProfile): string {
  if (p.kind === 'local') return 'this machine';
  if (p.sshConfigAlias) return `${p.user ? `${p.user}@` : ''}${p.sshConfigAlias} (ssh config)`;
  return `${p.user ? `${p.user}@` : ''}${p.hostname ?? '?'}${p.port ? `:${p.port}` : ''}`;
}

export function registerHost(program: Command, cli: Cli): void {
  const open = () => cli.rt({ reconcileOnOpen: false });
  const host = program.command('host').description('Hosts where sandboxes can run (human only)');

  host
    .command('ls')
    .alias('list')
    .description('List host profiles')
    .action(async () => {
      const rt = await open();
      const hosts = rt.hostRegistry.list();
      const now = Date.now();
      const rows = hosts.map((h) => {
        const c = h.kind === 'local' ? undefined : rt.hostCache.get(h.id, Number.POSITIVE_INFINITY);
        const status =
          h.kind === 'local'
            ? 'local'
            : c
              ? `${c.ok ? 'reachable' : 'unreachable'} ${formatRelative(c.ts, now)}`
              : 'not tested';
        return { h, status };
      });
      cli.success(
        { hosts: rows.map(({ h, status }) => ({ ...h, status })) },
        () =>
          renderTable(
            [
              { header: 'ID' },
              { header: 'KIND' },
              { header: 'ADDRESS' },
              { header: 'ZONE' },
              { header: 'BACKENDS' },
              { header: 'STATUS' },
            ],
            rows.map(({ h, status }) => [
              h.id,
              h.kind,
              address(h),
              h.zone,
              h.backends.join(',') || '-',
              status,
            ]),
            cli.width,
          ),
        () => hosts.map((h) => h.id).join('\n'),
      );
    });

  host
    .command('add')
    .description(
      'Add an SSH host profile (metadata only; keys stay with ssh-agent / your key files)',
    )
    .argument('<id>', 'short id, e.g. vps (a-z, 0-9, -)')
    .option('--hostname <name>', 'DNS name or IP address')
    .option('--user <name>', 'login user (use a dedicated unprivileged one)')
    .option('--port <n>', 'ssh port')
    .addOption(
      new Option('--zone <zone>', 'trust zone: workstation, lab, shared, restricted').choices([
        ...HOST_ZONES,
      ]),
    )
    .option(
      '--backend <kind>',
      'container engine / backend on the host (repeatable or comma separated)',
      collect,
    )
    .option('--engine-socket <path>', 'engine socket path ON THE HOST (rootless docker/podman)')
    .option('--identity-file <path>', 'private key path (never its contents)')
    .option('--ssh-alias <alias>', 'use this Host alias from ~/.ssh/config')
    .option('--proxy-jump <hops>', 'jump hosts, [user@]host[:port], comma separated')
    .addOption(
      new Option('--min-isolation <level>', 'minimum isolation required on this host').choices([
        ...ISOLATION_LEVELS,
      ]),
    )
    .option('--data-dir <path>', 'working directory root on the host (process/vm backends)')
    .option('--tag <tag>', 'tag (repeatable)', collect)
    .action(
      async (
        id: string,
        o: {
          hostname?: string;
          user?: string;
          port?: string;
          zone?: HostProfile['zone'];
          backend?: string[];
          engineSocket?: string;
          identityFile?: string;
          sshAlias?: string;
          proxyJump?: string;
          minIsolation?: IsolationLevel;
          dataDir?: string;
          tag?: string[];
        },
      ) => {
        const rt = await open();
        const backends = commaList(o.backend);
        for (const b of backends) {
          if (!(HOST_BACKEND_KINDS as readonly string[]).includes(b)) {
            throw invalid(
              `--backend: unknown backend "${safe(b)}"`,
              `Use one of: ${HOST_BACKEND_KINDS.join(', ')}.`,
            );
          }
        }
        if (o.port !== undefined && !/^\d{1,5}$/.test(o.port))
          throw invalid(`--port: expected a port number, got "${safe(o.port)}"`);
        const input: HostProfileInput = {
          id,
          ...(o.hostname ? { hostname: o.hostname } : {}),
          ...(o.user ? { user: o.user } : {}),
          ...(o.port ? { port: Number(o.port) } : {}),
          ...(o.zone ? { zone: o.zone } : {}),
          ...(backends.length ? { backends: backends as HostBackendKind[] } : {}),
          ...(o.engineSocket ? { engineSocket: o.engineSocket } : {}),
          ...(o.identityFile ? { identityFile: o.identityFile } : {}),
          ...(o.sshAlias ? { sshConfigAlias: o.sshAlias } : {}),
          ...(o.proxyJump ? { proxyJump: o.proxyJump } : {}),
          ...(o.minIsolation ? { minIsolation: o.minIsolation } : {}),
          ...(o.dataDir ? { dataDir: o.dataDir } : {}),
          ...(o.tag?.length ? { tags: o.tag } : {}),
        };
        const p = rt.hostRegistry.add(input);
        rt.audit('host.add', { host: p.id, zone: p.zone, backends: p.backends });
        cli.success(
          p,
          () =>
            `added host ${p.id} (${address(p)}, zone ${p.zone})\n  next: abox host test ${p.id}   then   abox host trust ${p.id}`,
          () => p.id,
        );
      },
    );

  host
    .command('rm')
    .alias('remove')
    .description('Remove a host profile (its sandboxes are not touched)')
    .argument('<id>', 'host id')
    .action(async (id: string) => {
      const rt = await open();
      const removed = rt.hostRegistry.remove(id);
      if (!removed) throw new AboxError('not_found', `unknown host "${safe(id)}"`);
      await rt.tunnels.close(id);
      rt.audit('host.remove', { host: id });
      cli.success({ id, removed }, () => `removed host ${id}`);
    });

  host
    .command('test')
    .description('Check reachability, host key, login and available backends')
    .argument('[id]', 'host id (default: --host)')
    .action(async (idArg?: string) => {
      const rt = await open();
      const id = idArg ?? cli.globals.host ?? 'local';
      const profile = rt.hostRegistry.require(id);
      if (profile.kind === 'local') {
        throw invalid('"local" is this machine; use "abox doctor" for its backends');
      }
      const r = await testHost(profile, rt.hostsEnv);
      const ok = r.reachable && r.authOk && r.hostKey === 'trusted';
      if (!ok) {
        const reason =
          r.hostKey === 'unknown'
            ? 'the host key is not trusted yet'
            : r.hostKey === 'changed'
              ? 'the host key CHANGED'
              : !r.reachable
                ? 'not reachable'
                : 'login failed';
        if (!cli.json) cli.out(`${describeHostTest(cli, r)}\n`);
        throw new AboxError(
          'host_unreachable',
          `host ${id}: ${reason}${r.error ? ` (${safe(r.error)})` : ''}`,
          {
            hint:
              r.hostKey === 'unknown'
                ? `Compare the fingerprint, then run "abox host trust ${id}".`
                : r.hostKey === 'changed'
                  ? `Verify the new fingerprint out of band; "abox host forget-key ${id}" then "abox host trust ${id}".`
                  : undefined,
            details: { result: r },
          },
        );
      }
      cli.success(r, () => describeHostTest(cli, r));
    });

  host
    .command('trust')
    .description('Confirm the SSH host key of a host (compare its fingerprint first)')
    .argument('<id>', 'host id')
    .option(
      '--fingerprint <SHA256:…>',
      'the fingerprint you verified; required when not interactive',
    )
    .action(async (id: string, o: { fingerprint?: string }) => {
      const rt = await open();
      const profile = rt.hostRegistry.require(id);
      let fingerprint = o.fingerprint;
      if (!fingerprint && !cli.interactive) {
        throw invalid(
          'a fingerprint is needed to trust a host non-interactively',
          `Run "abox host test ${id}" to see it, verify it out of band, then pass --fingerprint SHA256:…`,
        );
      }
      if (!fingerprint) {
        const check = await checkHostKey(profile, rt.hostsEnv);
        if (check.status === 'changed') {
          throw new AboxError(
            'host_unreachable',
            `host key of ${id} changed; refusing to trust a new key`,
            {
              hint: `Verify out of band, then "abox host forget-key ${id}" and trust again.`,
              details: {
                presented: check.keys.map((k) => k.fingerprint),
                stored: check.trusted.map((k) => k.fingerprint),
              },
            },
          );
        }
        if (check.status === 'trusted') {
          cli.success(
            { host: id, added: false, fingerprints: check.trusted.map((k) => k.fingerprint) },
            () => `${id}: host key already trusted`,
          );
          return;
        }
        cli.err(`Host keys presented by ${id} (${check.hostSpec}):\n`);
        for (const k of check.keys) cli.err(`  ${k.fingerprint}  (${k.type})\n`);
        const typed = await cli.readLine(
          'Type the fingerprint you verified (SHA256:…), empty to cancel: ',
        );
        if (!typed || typed.trim() === '') throw invalid('cancelled; nothing was trusted');
        fingerprint = typed.trim();
      }
      const r = await trustHostKey(profile, fingerprint, rt.hostsEnv);
      cli.success({ host: id, ...r }, () =>
        r.added ? `trusted ${r.fingerprint} for ${id}` : `${id}: host key was already trusted`,
      );
    });

  host
    .command('forget-key')
    .description('Forget the stored host key (needed after a legitimate server key change)')
    .argument('<id>', 'host id')
    .action(async (id: string) => {
      const rt = await open();
      const removed = await forgetHostKey(rt.hostRegistry.require(id), rt.hostsEnv);
      cli.success({ host: id, removed }, () =>
        removed ? `forgot the host key of ${id}` : `${id}: no stored key`,
      );
    });

  host
    .command('import-ssh-config')
    .description(
      'Propose host profiles from ~/.ssh/config (read-only; imported hosts start in zone "shared")',
    )
    .option('--dry-run', 'only show what would be imported')
    .option('--path <file>', 'ssh config file (default ~/.ssh/config)')
    .action(async (o: { dryRun?: boolean; path?: string }) => {
      const rt = await open();
      const r = await importSshConfig({
        registry: rt.hostRegistry,
        dryRun: o.dryRun === true,
        ...(o.path ? { path: cli.resolvePath(o.path) } : {}),
        env: { ...(rt.hostsEnv.sshBinary ? { sshBinary: rt.hostsEnv.sshBinary } : {}) },
      });
      if (!o.dryRun && r.added.length > 0) rt.audit('host.import', { hosts: r.added });
      cli.success(
        r,
        () => {
          const lines: string[] = [];
          if (r.hosts.length === 0) lines.push('nothing to import');
          else {
            lines.push(
              renderTable(
                [
                  { header: 'ALIAS' },
                  { header: 'ID' },
                  { header: 'HOSTNAME' },
                  { header: 'USER' },
                  { header: 'ZONE' },
                ],
                r.hosts.map((h) => [
                  h.alias,
                  h.profile.id,
                  h.effective.hostname ?? '-',
                  h.effective.user ?? '-',
                  h.profile.zone,
                ]),
                cli.width,
              ),
            );
            lines.push(
              o.dryRun
                ? '\ndry run: nothing was written'
                : `\nadded: ${r.added.join(', ') || 'none'}`,
            );
            lines.push(
              'imported hosts have no backends yet; set one with "abox host add" (backends + engine socket) and use a dedicated unprivileged user',
            );
          }
          for (const w of r.warnings) lines.push(`warning: ${safe(w)}`);
          return lines.join('\n');
        },
        () => r.added.join('\n'),
      );
    });

  program
    .command('ssh')
    .description(
      "Open an SSH session to a host profile (uses the system ssh, abox's own known_hosts)",
    )
    .argument('<host>', 'host id')
    .argument('[command...]', 'remote command (put "--" before it)')
    .action(async (id: string, _cmd: string[]) => {
      const rt = await open();
      const profile = rt.hostRegistry.require(id);
      if (profile.kind !== 'ssh')
        throw invalid('"local" is this machine; there is nothing to ssh to');
      const args = [
        ...sshSessionArgs(profile, rt.hostsEnv),
        ...(_cmd.length ? ['--', ..._cmd] : []),
      ];
      const session = auditSession(profile, rt.hostsEnv);
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(sshBinary(rt.hostsEnv), args, { stdio: 'inherit', env: cli.env });
        child.on('error', (e) =>
          reject(
            new AboxError('backend_unavailable', `cannot start ssh: ${e.message}`, {
              hint: 'Install OpenSSH.',
            }),
          ),
        );
        child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
      }).finally(() => session.end());
      if (code !== 0) throw new CliExit(code);
    });
}

function describeHostTest(cli: Cli, r: Awaited<ReturnType<typeof testHost>>): string {
  const lines = [
    renderKeyValues([
      ['host', r.host],
      [
        'reachable',
        r.reachable ? `yes${r.latencyMs !== undefined ? ` (${r.latencyMs} ms)` : ''}` : 'no',
      ],
      ['host key', r.hostKey],
      ['fingerprints', r.fingerprints.join('\n') || undefined],
      [
        'login',
        r.authOk
          ? `ok${r.remoteUser ? ` as ${r.remoteUser}${r.uid !== undefined ? ` (uid ${r.uid})` : ''}` : ''}`
          : 'failed or skipped',
      ],
      [
        'docker',
        r.backends.docker
          ? r.backends.docker.ok
            ? `${r.backends.docker.version ?? 'ok'}${r.backends.docker.rootless ? ', rootless' : ''}`
            : (r.backends.docker.error ?? 'not usable')
          : undefined,
      ],
      [
        'podman',
        r.backends.podman
          ? r.backends.podman.ok
            ? `${r.backends.podman.version ?? 'ok'}${r.backends.podman.rootless ? ', rootless' : ''}`
            : (r.backends.podman.error ?? 'not usable')
          : undefined,
      ],
      [
        'engine socket',
        r.engineSocket
          ? `${r.engineSocket.path} (${r.engineSocket.exists ? 'exists' : 'missing'})`
          : undefined,
      ],
      ['candidates', r.engineSocketCandidates.join(', ') || undefined],
    ]),
  ];
  for (const w of r.warnings) lines.push(`${cli.style('yellow', 'warning:')} ${safe(w)}`);
  return lines.join('\n');
}
