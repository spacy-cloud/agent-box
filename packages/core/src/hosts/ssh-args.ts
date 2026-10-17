import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AboxError } from '../errors.js';
import type { AboxPaths } from '../config/paths.js';
import { LOCAL_HOST_ID, type HostAudit, type HostProfile, type PortForward } from './model.js';
import { isHostname, isSshAlias, validateHostProfile } from './schema.js';

/**
 * Everything the ssh helpers need from the environment. Build it once with
 * `hostsEnvFromPaths` and pass it around.
 */
export interface HostsEnv {
  /**
   * abox's own known_hosts. It is the ONLY file consulted for host keys unless
   * `userKnownHostsFile` is set: a key counts as trusted only after a human confirmed its
   * fingerprint in abox (see `trustHostKey`).
   */
  knownHostsFile: string;
  /**
   * Optional read-only extra file (typically `~/.ssh/known_hosts`) consulted in addition to
   * the abox file when the user opted in. New keys are never written there.
   */
  userKnownHostsFile?: string;
  /** Sockets live below this: `<runtimeDir>/ssh/` (multiplexing, generated config), `<runtimeDir>/tunnels/<host>.sock`. */
  runtimeDir: string;
  /**
   * The user's ssh config that abox includes AFTER its own hardening (default
   * `~/.ssh/config`), so aliases, `HostName`, `ProxyJump`, identities keep working while the
   * hardening wins ("first value wins"). `null` includes nothing (tests, hermetic setups).
   */
  sshConfigFile?: string | null;
  sshBinary?: string;
  sshKeyscanBinary?: string;
  sshKeygenBinary?: string;
  /** ControlMaster reuse for batch/interactive calls (default true). */
  multiplex?: boolean;
  connectTimeoutSec?: number;
  audit?: HostAudit;
  now?: () => number;
}

export function hostsEnvFromPaths(
  paths: Pick<AboxPaths, 'configDir' | 'runtimeDir'>,
  overrides: Partial<HostsEnv> = {},
): HostsEnv {
  return {
    knownHostsFile: join(paths.configDir, 'known_hosts'),
    runtimeDir: paths.runtimeDir,
    ...overrides,
  };
}

export type SshMode = 'batch' | 'interactive' | 'tunnel';

export interface SshArgsOptions {
  mode: SshMode;
  /**
   * Fixed remote command string. MUST be a constant of this package (the probe), never
   * built from user input: ssh hands it to the remote login shell.
   */
  remoteCommand?: string;
  /** Extra forwards (`-L/-R/-D`) from validated port-forward profiles. */
  forwardings?: readonly PortForward[];
  /** Raw `-L local:remote` style specs produced by this package (engine tunnel). */
  rawForwards?: ReadonlyArray<{ flag: '-L' | '-R' | '-D'; spec: string }>;
  /**
   * The command a HUMAN typed after `abox ssh <host> --`, passed to ssh as separate arguments after
   * the destination (ssh joins them with spaces for the remote shell, like `ssh host cmd args`).
   * Interactive mode only; never fill it from anything an agent or a server sent.
   */
  userCommand?: readonly string[];
  noMultiplex?: boolean;
  /** `ssh -G` (print effective config): no connection options, user config only. */
  printConfig?: boolean;
}

const CONTROL_PATH_MAX = 104; // sun_path is 108 bytes; ssh appends ".XXXXXXXXXXXXXXXX"
const CONTROL_PATH_SUFFIX = '/ssh/'.length + 8 + 1 + 40 + 17;

function quoteRaw(v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"]/.test(v)) {
    throw new AboxError('invalid_input', `unsafe value for an ssh option: ${JSON.stringify(v)}`);
  }
  return /\s/.test(v) ? `"${v}"` : v;
}

/** Escapes a value for `-o Key=Value` / config files: `%` is a token character, whitespace needs quotes. */
export function optValue(v: string): string {
  return quoteRaw(v.replaceAll('%', '%%'));
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** Whether the control socket path would fit into `sun_path`. */
export function controlPathFits(runtimeDir: string): boolean {
  return runtimeDir.length + CONTROL_PATH_SUFFIX <= CONTROL_PATH_MAX;
}

/** `--` target of ssh for a profile: the config alias, else the hostname. */
export function sshDestination(profile: HostProfile): string {
  const dest = profile.sshConfigAlias ?? profile.hostname;
  if (dest === undefined) {
    throw new AboxError(
      'invalid_input',
      `host "${profile.id}" has neither hostname nor ssh_config_alias`,
    );
  }
  if (
    dest.startsWith('-') ||
    !(profile.sshConfigAlias !== undefined ? isSshAlias(dest) : isHostname(dest))
  ) {
    throw new AboxError('invalid_input', `unsafe ssh destination: ${JSON.stringify(dest)}`);
  }
  return dest;
}

/** `-L/-R/-D` flag and spec of a saved forward. Bind addresses are always explicit loopback. */
export function forwardArgs(f: PortForward): string[] {
  const listen = /^\d+$/.test(f.listen) ? `127.0.0.1:${f.listen}` : f.listen;
  if (f.kind === 'dynamic') return ['-D', listen];
  if (f.target === undefined) {
    throw new AboxError('invalid_input', `forward "${f.name}" needs a target`);
  }
  return [f.kind === 'local' ? '-L' : '-R', `${listen}:${f.target}`];
}

function userConfigPath(env: HostsEnv): string | undefined {
  if (env.sshConfigFile === null) return undefined;
  return env.sshConfigFile ?? join(homedir(), '.ssh', 'config');
}

export interface HardenedConfigOptions {
  /** known_hosts the connection is checked against (default `env.knownHostsFile`). */
  knownHostsFile?: string;
  /** Extra blocks placed first, e.g. the scan target (internal). */
  prelude?: string;
}

/**
 * Text of the generated ssh config (`-F`). `-J` hops and `ProxyCommand`s do not inherit `-o`
 * options from the command line, but they do inherit `-F`; hence the hardening lives in a
 * `Host *` block here as well, so jump hosts get strict host keys and no agent forwarding too.
 * The user's own config is included last: where both set a value, the hardening wins.
 */
export function renderHardenedConfig(
  env: HostsEnv,
  mode: SshMode,
  o: HardenedConfigOptions = {},
): string {
  const khf = o.knownHostsFile ?? env.knownHostsFile;
  const files = [khf, ...(env.userKnownHostsFile ? [env.userKnownHostsFile] : [])];
  const lines = [
    '# Generated by abox. Do not edit; it is rewritten on demand.',
    ...(o.prelude ? [o.prelude] : []),
    'Host *',
    '  ForwardAgent no',
    '  ForwardX11 no',
    '  ForwardX11Trusted no',
    '  PermitLocalCommand no',
    '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${files.map((f) => optValue(f)).join(' ')}`,
    '  GlobalKnownHostsFile /dev/null',
    '  CheckHostIP no',
    '  UpdateHostKeys no',
    '  VerifyHostKeyDNS no',
    '  HashKnownHosts no',
    '  ServerAliveInterval 15',
    '  ServerAliveCountMax 3',
    `  ConnectTimeout ${env.connectTimeoutSec ?? 10}`,
  ];
  if (mode !== 'interactive') {
    lines.push(
      '  BatchMode yes',
      '  PasswordAuthentication no',
      '  KbdInteractiveAuthentication no',
      '  LogLevel ERROR',
    );
  }
  const user = userConfigPath(env);
  if (user) lines.push('', 'Match all', `Include ${optValue(user)}`);
  // SendEnv accumulates over all config sources instead of "first value wins", and a user config
  // (or a distribution's `SendEnv LANG LC_*`) must not hand local variables to the server. A
  // clearing entry only works AFTER everything it has to clear, hence last, behind the Include.
  lines.push('', 'Match all', '  SendEnv -*');
  return `${lines.join('\n')}\n`;
}

/** Writes (once, by content hash) the generated config and returns its path. */
export function ensureHardenedConfig(env: HostsEnv, mode: SshMode): string {
  const text = renderHardenedConfig(env, mode);
  const dir = join(env.runtimeDir, 'ssh');
  const name = `abox-${mode}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.conf`;
  const path = join(dir, name);
  if (existsSync(path)) return path;
  mkdirSync(env.runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeConfigFile(path, text);
  return path;
}

export function writeConfigFile(path: string, text: string): void {
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * Builds the hardened ssh argv (without the `ssh` binary) for a profile.
 *
 * Invariants, independent of the mode:
 * - argv only, never a shell string; the profile is re-validated here;
 * - the destination follows `--` and cannot start with `-`;
 * - agent and X11 forwarding off, `PermitLocalCommand=no`;
 * - strict host keys against abox's own known_hosts (`StrictHostKeyChecking=yes`), also for
 *   jump hosts (through the generated `-F` config);
 * - `identity_file` (`-i`) applies to the destination only; jump hosts use the user's ssh
 *   config or the agent.
 *
 * `batch`: non-interactive (`BatchMode=yes`, no tty), connection reuse via ControlMaster.
 * `interactive`: prompts for passphrases/FIDO touch work (no BatchMode), tty by ssh default.
 * `tunnel`: `-N`, dedicated process without multiplexing, `ExitOnForwardFailure=yes`.
 *
 * Side effect: writes the generated config file below `<runtimeDir>/ssh/` (mode 0600, once).
 */
export function buildSshArgs(profile: HostProfile, env: HostsEnv, opts: SshArgsOptions): string[] {
  if (profile.kind !== 'ssh' || profile.id === LOCAL_HOST_ID) {
    throw new AboxError('invalid_input', `host "${profile.id}" is not an ssh host`);
  }
  validateHostProfile(profile);
  if (opts.userCommand !== undefined && (opts.mode !== 'interactive' || opts.remoteCommand)) {
    throw new AboxError('internal', 'userCommand is only for interactive sessions');
  }
  const dest = sshDestination(profile);
  const args: string[] = [];
  const o = (key: string, value: string) => args.push('-o', `${key}=${value}`);

  // Overrides from the profile. They take precedence over ~/.ssh/config (first value wins).
  const overrides: string[] = [];
  if (profile.user) overrides.push('-l', profile.user);
  if (profile.port !== undefined) overrides.push('-p', String(profile.port));
  if (profile.proxyJump) overrides.push('-J', profile.proxyJump);
  if (profile.identityFile)
    overrides.push('-i', expandHome(profile.identityFile), '-o', 'IdentitiesOnly=yes');

  if (opts.printConfig) {
    const user = userConfigPath(env);
    return ['-G', '-F', user && existsSync(user) ? user : '/dev/null', ...overrides, '--', dest];
  }

  args.push('-F', ensureHardenedConfig(env, opts.mode), ...overrides);

  // Hardening on the command line as well (visible, and first in precedence for the destination).
  args.push('-a', '-x');
  o('ForwardAgent', 'no');
  o('ForwardX11', 'no');
  o('ForwardX11Trusted', 'no');
  o('PermitLocalCommand', 'no');
  const hasForwards =
    (opts.forwardings?.length ?? 0) > 0 ||
    (opts.rawForwards?.length ?? 0) > 0 ||
    opts.mode === 'tunnel';
  if (!hasForwards) o('ClearAllForwardings', 'yes');

  const files = [env.knownHostsFile, ...(env.userKnownHostsFile ? [env.userKnownHostsFile] : [])];
  o('StrictHostKeyChecking', 'yes');
  o('UserKnownHostsFile', files.map((f) => optValue(f)).join(' '));
  o('GlobalKnownHostsFile', '/dev/null');
  o('CheckHostIP', 'no');
  o('UpdateHostKeys', 'no');
  o('VerifyHostKeyDNS', 'no');
  o('HashKnownHosts', 'no');

  o('ServerAliveInterval', '15');
  o('ServerAliveCountMax', '3');
  o('ConnectTimeout', String(env.connectTimeoutSec ?? 10));

  if (opts.mode === 'interactive') {
    o('BatchMode', 'no');
  } else {
    o('BatchMode', 'yes');
    o('PasswordAuthentication', 'no');
    o('KbdInteractiveAuthentication', 'no');
    o('LogLevel', 'ERROR');
    args.push('-T');
  }

  const mux =
    opts.mode !== 'tunnel' &&
    !opts.noMultiplex &&
    env.multiplex !== false &&
    controlPathFits(env.runtimeDir);
  if (mux) {
    // The control socket is keyed by host/port/user (%C) and by everything else that changes
    // how we authenticate, so a master with another identity or jump chain is never reused.
    const mid = createHash('sha256')
      .update(
        JSON.stringify([
          profile.identityFile,
          profile.proxyJump,
          profile.sshConfigAlias,
          userConfigPath(env),
        ]),
      )
      .digest('hex')
      .slice(0, 8);
    o('ControlMaster', 'auto');
    o('ControlPath', quoteRaw(`${join(env.runtimeDir, 'ssh').replaceAll('%', '%%')}/${mid}-%C`));
    o('ControlPersist', '60');
  } else {
    o('ControlMaster', 'no');
    o('ControlPath', 'none');
  }

  if (opts.mode === 'tunnel') {
    args.push('-N');
    o('ExitOnForwardFailure', 'yes');
    o('StreamLocalBindUnlink', 'yes');
  }

  for (const f of opts.forwardings ?? []) args.push(...forwardArgs(f));
  for (const f of opts.rawForwards ?? []) args.push(f.flag, f.spec);

  args.push('--', dest);
  if (opts.remoteCommand !== undefined) args.push(opts.remoteCommand);
  // The destination ends ssh's option parsing, so what follows is the command even when it
  // starts with a dash (`abox ssh host -- uptime -a`). No second `--`: the remote shell would
  // receive it as part of the command line.
  if (opts.userCommand !== undefined) args.push(...opts.userCommand);
  return args;
}

/**
 * Argv for an interactive session (terminal tab / `abox ssh <host>`): tty, passphrase and
 * FIDO prompts work, host keys are still strict, agent forwarding stays off. Run the
 * returned args with `env.sshBinary ?? 'ssh'` (e.g. in a pty). Optional forwards apply to
 * this session only. `command` is what a human typed after `--`: it follows the destination
 * as it is (no extra `--`).
 */
export function sshSessionArgs(
  profile: HostProfile,
  env: HostsEnv,
  opts: { forwardings?: readonly PortForward[]; command?: readonly string[] } = {},
): string[] {
  return buildSshArgs(profile, env, {
    mode: 'interactive',
    forwardings: opts.forwardings,
    ...(opts.command?.length ? { userCommand: opts.command } : {}),
  });
}

/**
 * Argv to run saved port forwards (`-N`, no shell, fails when a forward cannot be set up).
 * Pass one profile forward by name or a list; default is all forwards of the profile.
 */
export function portForwardArgs(
  profile: HostProfile,
  env: HostsEnv,
  which?: string | readonly string[],
): string[] {
  const names = which === undefined ? undefined : typeof which === 'string' ? [which] : which;
  const forwards = names
    ? names.map((n) => {
        const f = profile.portForwards.find((x) => x.name === n);
        if (!f) throw new AboxError('not_found', `host "${profile.id}" has no port forward "${n}"`);
        return f;
      })
    : profile.portForwards;
  if (forwards.length === 0) {
    throw new AboxError('invalid_input', `host "${profile.id}" has no port forwards`);
  }
  return buildSshArgs(profile, env, { mode: 'tunnel', forwardings: forwards });
}

export function sshBinary(env: HostsEnv): string {
  return env.sshBinary ?? 'ssh';
}

/**
 * Audit helper for interactive sessions that the caller spawns itself (pty in the app, `abox ssh`):
 * emits `host.session.open` now and `host.session.close` (with `durationMs`) when `end()` is
 * called. Never records session content.
 */
export function auditSession(profile: HostProfile, env: HostsEnv): { end: () => void } {
  const now = env.now ?? Date.now;
  const started = now();
  env.audit?.('host.session.open', { host: profile.id, user: profile.user });
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      env.audit?.('host.session.close', {
        host: profile.id,
        user: profile.user,
        durationMs: now() - started,
      });
    },
  };
}
