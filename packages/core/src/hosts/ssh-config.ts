import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AboxError } from '../errors.js';
import { LOCAL_HOST_ID, type HostProfile } from './model.js';
import type { HostRegistry } from './registry.js';
import { isHostId, isIdentityPath, isProxyJump, validateHostProfile } from './schema.js';
import { localUserName, sshGForAlias, type EffectiveSshConfig } from './effective.js';

/**
 * Read-only reader for OpenSSH client configuration. It never writes to ~/.ssh.
 *
 * Supported: `Host` (several patterns, `!negation`, `*`/`?`), `HostName`, `User`, `Port`,
 * `ProxyJump`, `IdentityFile`, `Include` (globs; relative paths resolve against the directory of
 * the including config, i.e. `~/.ssh` for the default). Settings of matching wildcard blocks
 * (`Host *`) apply to an alias like in ssh: the first value wins. `Match` blocks are NOT
 * evaluated (reported as warning); use `useSshG` to let `ssh -G` compute the effective values.
 */

const MAX_INCLUDE_DEPTH = 16;
const ACCUMULATE = new Set(['identityfile']);

interface Block {
  patterns: string[]; // [] for the global section (matches everything)
  skip: boolean; // Match blocks
  options: Array<[string, string[]]>;
}

export interface ParsedSshConfig {
  blocks: Block[];
  warnings: string[];
}

export function expandTilde(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** Splits a config line into tokens, honouring double quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      inQ = !inQ;
      has = true;
    } else if (!inQ && c === '#') {
      break;
    } else if (!inQ && /\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function splitKeyword(line: string): { key: string; args: string[] } | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  const m = /^([A-Za-z0-9]+)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (!m) return undefined;
  return { key: m[1]!.toLowerCase(), args: tokenize(m[2]!) };
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (const ch of glob) {
    re += ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchesPatterns(patterns: readonly string[], name: string): boolean {
  let positive = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(name)) return false;
    } else if (globToRegExp(p).test(name)) {
      positive = true;
    }
  }
  return positive;
}

function isWildcardPattern(p: string): boolean {
  return p.startsWith('!') || /[*?]/.test(p);
}

/** Expands a (possibly globbed) path into existing files, sorted like glob(3). */
export function expandGlob(pattern: string): string[] {
  if (!/[*?]/.test(pattern)) return existsSync(pattern) ? [pattern] : [];
  const parts = pattern.split('/');
  let bases: string[] = [pattern.startsWith('/') ? '/' : '.'];
  for (const part of parts) {
    if (part === '') continue;
    const next: string[] = [];
    for (const base of bases) {
      if (!/[*?]/.test(part)) {
        const p = join(base, part);
        if (existsSync(p)) next.push(p);
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      const re = globToRegExp(part);
      for (const n of names.sort()) {
        if (n.startsWith('.') && !part.startsWith('.')) continue;
        if (re.test(n)) next.push(join(base, n));
      }
    }
    bases = next;
  }
  return bases.filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
}

export function parseSshConfigFile(path: string, baseDir?: string): ParsedSshConfig {
  const blocks: Block[] = [{ patterns: [], skip: false, options: [] }];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const state = { current: blocks[0]! };

  const parseFile = (file: string, depth: number): void => {
    const real = resolve(file);
    if (depth > MAX_INCLUDE_DEPTH || seen.has(`${depth}:${real}`)) {
      warnings.push(`Include depth/loop limit reached at ${real}`);
      return;
    }
    let text: string;
    try {
      text = readFileSync(real, 'utf8');
    } catch (e) {
      warnings.push(`cannot read ${real}: ${(e as Error).message}`);
      return;
    }
    seen.add(`${depth}:${real}`);
    const outer = state.current;
    for (const line of text.split(/\r?\n/)) {
      const kw = splitKeyword(line);
      if (!kw) continue;
      if (kw.key === 'host') {
        state.current = { patterns: kw.args, skip: false, options: [] };
        blocks.push(state.current);
      } else if (kw.key === 'match') {
        state.current = { patterns: [], skip: true, options: [] };
        blocks.push(state.current);
        if (!kw.args.every((a) => a.toLowerCase() === 'all')) {
          warnings.push(`Match block "${kw.args.join(' ')}" in ${basename(real)} is not evaluated`);
        }
      } else if (kw.key === 'include') {
        for (const arg of kw.args) {
          const expanded = expandTilde(arg);
          const full = isAbsolute(expanded) ? expanded : join(baseDir ?? dirname(path), expanded);
          for (const f of expandGlob(full)) parseFile(f, depth + 1);
        }
      } else if (!state.current.skip) {
        state.current.options.push([kw.key, kw.args]);
      }
    }
    state.current = outer; // an included file does not change the Host context of its includer
  };

  parseFile(path, 0);
  return { blocks, warnings };
}

/** Effective static settings for one alias: all matching blocks in order, first value wins. */
export function effectiveForAlias(cfg: ParsedSshConfig, alias: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const b of cfg.blocks) {
    if (b.skip) continue;
    if (b.patterns.length > 0 && !matchesPatterns(b.patterns, alias)) continue;
    for (const [k, v] of b.options) {
      if (ACCUMULATE.has(k)) (out[k] ??= []).push(...v);
      else out[k] ??= v;
    }
  }
  return out;
}

export function aliasesOf(cfg: ParsedSshConfig): { aliases: string[]; skippedPatterns: string[] } {
  const aliases: string[] = [];
  const skippedPatterns: string[] = [];
  for (const b of cfg.blocks) {
    for (const p of b.patterns) {
      if (isWildcardPattern(p)) {
        if (!skippedPatterns.includes(p)) skippedPatterns.push(p);
      } else if (!aliases.includes(p)) aliases.push(p);
    }
  }
  return { aliases, skippedPatterns };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportedHost {
  alias: string;
  profile: HostProfile;
  /** Values as ssh will use them (static parse, or `ssh -G` with `useSshG`). */
  effective: {
    hostname?: string;
    user?: string;
    port?: number;
    proxyJump?: string;
    identityFile?: string;
  };
  warnings: string[];
}

export interface ImportResult {
  path: string;
  hosts: ImportedHost[];
  skipped: Array<{ pattern: string; reason: string }>;
  /** Ids written to the registry (empty for dry runs). */
  added: string[];
  warnings: string[];
}

export interface ImportSshConfigOptions {
  /** Default `~/.ssh/config`. */
  path?: string;
  /** Default true. With `false` and a `registry`, new profiles are added. */
  dryRun?: boolean;
  registry?: HostRegistry;
  /** Ask `ssh -G <alias>` for hostname/port/user/jump instead of the static parse. */
  useSshG?: boolean;
  env?: { sshBinary?: string; sshConfigFile?: string };
  /** Zone of imported hosts (default `shared`, the safe choice). */
  zone?: HostProfile['zone'];
}

export function idFromAlias(alias: string, taken: ReadonlySet<string>): string | undefined {
  let id = alias
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  if (id === '') return undefined;
  if (id === LOCAL_HOST_ID) id = 'local-ssh';
  let candidate = id;
  for (let n = 2; taken.has(candidate); n++) candidate = `${id}-${n}`;
  return isHostId(candidate) ? candidate : undefined;
}

/**
 * Proposes host profiles from `~/.ssh/config` (read-only; the file is never modified).
 *
 * Safety defaults: zone `shared` (Mindest-Isolation `hardened`, approval needed), `backends: []`
 * (an imported host is SSH-only until the user declares a container engine and `engine_socket`),
 * only the identity file PATH is taken over, never key contents. The profile keeps
 * `ssh_config_alias`, so the user's config stays the source of truth for everything else.
 * The login user of an alias is often an administrator: set a dedicated unprivileged `user`
 * before using a host for sandboxes (`testHost` warns about root/docker group).
 */
export async function importSshConfig(opts: ImportSshConfigOptions = {}): Promise<ImportResult> {
  const path = opts.path ?? join(homedir(), '.ssh', 'config');
  if (!existsSync(path)) {
    return { path, hosts: [], skipped: [], added: [], warnings: [`${path} does not exist`] };
  }
  const cfg = parseSshConfigFile(path);
  const { aliases, skippedPatterns } = aliasesOf(cfg);
  const result: ImportResult = {
    path,
    hosts: [],
    skipped: skippedPatterns.map((pattern) => ({ pattern, reason: 'wildcard or negated pattern' })),
    added: [],
    warnings: [...cfg.warnings],
  };
  const taken = new Set<string>(
    opts.registry ? opts.registry.list().map((h) => h.id) : [LOCAL_HOST_ID],
  );
  const dryRun = opts.dryRun ?? opts.registry === undefined;
  const localUser = localUserName();

  for (const alias of aliases) {
    const stat = effectiveForAlias(cfg, alias);
    const warnings: string[] = [];
    let hostname = stat['hostname']?.[0]?.replaceAll('%h', alias).replaceAll('%%', '%');
    let user = stat['user']?.[0];
    let port = stat['port']?.[0] ? Number(stat['port'][0]) : undefined;
    let proxyJump = stat['proxyjump']?.[0];
    let identity = stat['identityfile']?.[0];
    if (opts.useSshG) {
      try {
        const eff: EffectiveSshConfig = await sshGForAlias(alias, opts.env ?? {});
        hostname = eff.hostname || hostname;
        port = eff.port;
        proxyJump = eff.proxyJump;
        if (user !== undefined || (eff.user && eff.user !== localUser)) user = eff.user;
        identity = eff.identityFiles[0] ?? identity;
      } catch (e) {
        warnings.push(`ssh -G failed, using static values: ${(e as Error).message}`);
      }
    }
    if (proxyJump?.toLowerCase() === 'none') proxyJump = undefined;
    if (port === 22) port = undefined;
    if (identity && !isIdentityPath(identity)) {
      warnings.push(
        `IdentityFile "${identity}" is not importable (token or relative path); left to ssh_config`,
      );
      identity = undefined;
    }
    if (proxyJump && !isProxyJump(proxyJump)) {
      warnings.push(`ProxyJump "${proxyJump}" is not importable; left to ssh_config`);
      proxyJump = undefined;
    }
    if ((stat['identityfile']?.length ?? 0) > 1)
      warnings.push('several IdentityFile entries; only the first is recorded');
    if (stat['proxycommand'] && stat['proxycommand'][0]?.toLowerCase() !== 'none') {
      warnings.push('uses ProxyCommand (honoured by ssh through the alias, not editable here)');
    }
    if (user === undefined)
      warnings.push(
        'no User configured: ssh will use your local user name; set a dedicated sandbox user',
      );

    const id = idFromAlias(alias, taken);
    if (!id) {
      result.skipped.push({ pattern: alias, reason: 'cannot derive a valid host id' });
      continue;
    }
    const profile: HostProfile = {
      id,
      kind: 'ssh',
      sshConfigAlias: alias,
      ...(hostname && hostname !== alias ? { hostname } : {}),
      ...(user ? { user } : {}),
      ...(port ? { port } : {}),
      ...(proxyJump ? { proxyJump } : {}),
      ...(identity ? { identityFile: identity } : {}),
      zone: opts.zone ?? 'shared',
      backends: [],
      tags: ['imported'],
      favorite: false,
      portForwards: [],
    };
    try {
      validateHostProfile(profile);
    } catch (e) {
      result.skipped.push({ pattern: alias, reason: (e as AboxError).message });
      continue;
    }
    taken.add(id);
    result.hosts.push({
      alias,
      profile,
      effective: {
        ...(hostname ? { hostname } : {}),
        ...(user ? { user } : {}),
        ...(port ? { port } : {}),
        ...(proxyJump ? { proxyJump } : {}),
        ...(identity ? { identityFile: identity } : {}),
      },
      warnings,
    });
  }

  if (!dryRun) {
    if (!opts.registry)
      throw new AboxError('invalid_input', 'importSshConfig needs a registry when dryRun is false');
    for (const h of result.hosts) {
      opts.registry.add(h.profile);
      result.added.push(h.profile.id);
    }
  }
  return result;
}
