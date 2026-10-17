import { userInfo } from 'node:os';
import { AboxError } from '../errors.js';
import { run } from './exec.js';
import type { HostProfile } from './model.js';
import { buildSshArgs, type HostsEnv } from './ssh-args.js';

/** What `ssh -G` reports for a destination (keys lower-case as printed by ssh). */
export interface EffectiveSshConfig {
  hostname: string;
  port: number;
  user?: string;
  proxyJump?: string;
  /** `ProxyCommand` as ssh prints it (tokens like `%h` unexpanded). */
  proxyCommand?: string;
  identityFiles: string[];
  raw: Record<string, string[]>;
}

export function parseSshG(
  stdout: string,
  defaultIdentities: readonly string[] = [],
): EffectiveSshConfig {
  const raw: Record<string, string[]> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf(' ');
    if (i <= 0) continue;
    (raw[line.slice(0, i)] ??= []).push(line.slice(i + 1).trim());
  }
  const first = (k: string) => raw[k]?.[0];
  const proxyJump = first('proxyjump');
  const proxyCommand = first('proxycommand');
  return {
    hostname: first('hostname') ?? '',
    port: Number(first('port') ?? 22),
    ...(first('user') ? { user: first('user')! } : {}),
    ...(proxyJump && proxyJump !== 'none' ? { proxyJump } : {}),
    ...(proxyCommand && proxyCommand !== 'none' ? { proxyCommand } : {}),
    identityFiles: (raw['identityfile'] ?? []).filter((f) => !defaultIdentities.includes(f)),
    raw,
  };
}

/**
 * Effective ssh settings of a profile via `ssh -G` (respects `~/.ssh/config`, `Include`,
 * `Match`, and the profile's own overrides). Does not connect.
 */
export async function getEffectiveSshConfig(
  profile: HostProfile,
  env: HostsEnv,
): Promise<EffectiveSshConfig> {
  const args = buildSshArgs(profile, env, { mode: 'batch', printConfig: true });
  return effectiveFromArgs(args, env);
}

const defaultIdentityCache = new Map<string, Promise<string[]>>();

/**
 * The identity files ssh offers when nothing is configured (they change between OpenSSH
 * versions), taken from `ssh -G -F /dev/null`. Subtracted from `-G` output so only configured
 * keys are reported.
 */
function defaultIdentityFiles(binary: string): Promise<string[]> {
  let p = defaultIdentityCache.get(binary);
  if (!p) {
    p = run(binary, ['-G', '-F', '/dev/null', '--', 'abox-defaults-probe'], { timeoutMs: 10_000 })
      .then((r) => (r.code === 0 ? (parseSshG(r.stdout).raw['identityfile'] ?? []) : []))
      .catch(() => []);
    defaultIdentityCache.set(binary, p);
  }
  return p;
}

export async function sshGForAlias(
  alias: string,
  env: Pick<HostsEnv, 'sshBinary' | 'sshConfigFile'>,
): Promise<EffectiveSshConfig> {
  if (alias.startsWith('-'))
    throw new AboxError('invalid_input', `unsafe alias ${JSON.stringify(alias)}`);
  const args = [
    '-G',
    ...(env.sshConfigFile === null
      ? ['-F', '/dev/null']
      : env.sshConfigFile
        ? ['-F', env.sshConfigFile]
        : []),
    '--',
    alias,
  ];
  return effectiveFromArgs(args, env);
}

async function effectiveFromArgs(
  args: string[],
  env: Pick<HostsEnv, 'sshBinary'>,
): Promise<EffectiveSshConfig> {
  let res;
  try {
    res = await run(env.sshBinary ?? 'ssh', args, { timeoutMs: 10_000 });
  } catch (e) {
    throw new AboxError('backend_unavailable', `cannot run ssh: ${(e as Error).message}`, {
      hint: 'Install the OpenSSH client.',
      cause: e,
    });
  }
  if (res.code !== 0) {
    throw new AboxError(
      'invalid_input',
      `ssh -G failed: ${res.stderr.trim().split('\n')[0] ?? ''}`,
    );
  }
  return parseSshG(res.stdout, await defaultIdentityFiles(env.sshBinary ?? 'ssh'));
}

export function localUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}
