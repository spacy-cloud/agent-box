import { AboxError } from '../errors.js';
import type { ProxyInjection, ResolvedTemplate } from '../types.js';
import type { SecretStore } from './store.js';

export type SecretScheme = 'bearer' | 'basic-x-access-token' | 'raw';

/** Host-side per-secret configuration (not part of templates). */
export interface SecretConfigEntry {
  /** Header the proxy sets. Default `Authorization`. */
  header?: string;
  /** How the value is placed in the header. Default depends on the host (see {@link defaultScheme}). */
  scheme?: SecretScheme;
  /**
   * Narrows the destination hosts. The effective hosts are the INTERSECTION of the template
   * hosts and these: host-side configuration can restrict a template, never widen it.
   */
  hosts?: string[];
  /** Environment variable name for `inject: env` (default: derived from the ref, `github-token` -> `GITHUB_TOKEN`). */
  env?: string;
}

export type SecretConfig = Record<string, SecretConfigEntry>;
export type TemplateSecrets = ResolvedTemplate['secrets'];

const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'expect',
]);

/** Normalizes a destination host: lowercase, no trailing dot; rejects wildcards, ports, paths. */
export function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(h)) {
    throw new AboxError(
      'invalid_input',
      `invalid secret destination host ${JSON.stringify(host.slice(0, 100))}`,
      {
        hint: 'use exact host names without wildcard, scheme, port or path',
      },
    );
  }
  return h;
}

/** `basic-x-access-token` for github.com and gitlab hosts (git over HTTPS), `bearer` otherwise. */
export function defaultScheme(host: string): SecretScheme {
  if (
    host === 'github.com' ||
    host === 'gitlab.com' ||
    host.startsWith('gitlab.') ||
    host.endsWith('.gitlab.com')
  ) {
    return 'basic-x-access-token';
  }
  return 'bearer';
}

function headerValue(scheme: SecretScheme, token: string): string {
  switch (scheme) {
    case 'bearer':
      return `Bearer ${token}`;
    case 'basic-x-access-token':
      return `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
    case 'raw':
      return token;
  }
}

function checkHeader(name: string, ref: string): void {
  if (
    !HEADER_RE.test(name) ||
    FORBIDDEN_HEADERS.has(name.toLowerCase()) ||
    name.toLowerCase().startsWith('proxy-')
  ) {
    throw new AboxError(
      'invalid_input',
      `secret ${ref}: header ${JSON.stringify(name)} is not allowed`,
    );
  }
}

async function fetchSecret(store: SecretStore, ref: string): Promise<string> {
  const v = await store.get(ref);
  if (v === undefined || v === '') {
    throw new AboxError('invalid_input', `secret ${ref} not found in keyring`, {
      hint: `store it with: abox secret set ${ref}`,
      details: { ref },
    });
  }
  return v;
}

/**
 * Builds proxy header injections for `inject: proxy` secrets. The sandbox never sees the value.
 *
 * Host policy: the template must list at least one host for every proxy secret (a proxy secret
 * without hosts would be injectable nowhere or, worse, everywhere). If `secretConfig[ref].hosts`
 * is given, the effective hosts are the intersection with the template's hosts; an empty
 * intersection is an error. One injection is produced per host.
 */
export async function buildProxyInjections(
  secrets: TemplateSecrets,
  store: SecretStore,
  secretConfig: SecretConfig = {},
): Promise<ProxyInjection[]> {
  const out: ProxyInjection[] = [];
  for (const s of secrets) {
    if (s.inject !== 'proxy') continue;
    const cfg = secretConfig[s.ref] ?? {};
    const tplHosts = s.hosts.map(normalizeHost);
    if (tplHosts.length === 0) {
      throw new AboxError(
        'invalid_input',
        `secret ${s.ref} uses inject: proxy but lists no hosts`,
        {
          hint: 'add the destination hosts to the secret in the template (hosts: [github.com])',
        },
      );
    }
    let hosts = [...new Set(tplHosts)];
    if (cfg.hosts) {
      const allowed = new Set(cfg.hosts.map(normalizeHost));
      hosts = hosts.filter((h) => allowed.has(h));
      if (hosts.length === 0) {
        throw new AboxError(
          'invalid_input',
          `secret ${s.ref}: configured hosts do not overlap with the template hosts`,
          {
            hint: 'the secret configuration can only narrow the hosts a template declares',
          },
        );
      }
    }
    const header = cfg.header ?? 'Authorization';
    checkHeader(header, s.ref);
    const token = await fetchSecret(store, s.ref);
    if (/[\r\n\0]/.test(token)) {
      throw new AboxError(
        'invalid_input',
        `secret ${s.ref} contains line breaks or NUL and cannot be used as a header value`,
      );
    }
    for (const host of hosts) {
      out.push({ host, header, value: headerValue(cfg.scheme ?? defaultScheme(host), token) });
    }
  }
  return out;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FORBIDDEN_ENV =
  /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|PYTHONPATH|PYTHONSTARTUP|NODE_OPTIONS|PERL5OPT|RUBYOPT|LD_.*|DYLD_.*)$/;

/** `github-token` -> `GITHUB_TOKEN`. */
export function envNameFor(ref: string): string {
  const n = ref
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return /^[0-9]/.test(n) ? `_${n}` : n;
}

/** Values for approved `inject: env` secrets (the sandbox can read them). */
export async function buildEnvSecrets(
  secrets: TemplateSecrets,
  store: SecretStore,
  secretConfig: SecretConfig = {},
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const s of secrets) {
    if (s.inject !== 'env') continue;
    const name = secretConfig[s.ref]?.env ?? envNameFor(s.ref);
    if (!ENV_NAME_RE.test(name) || FORBIDDEN_ENV.test(name)) {
      throw new AboxError(
        'invalid_input',
        `secret ${s.ref}: environment variable name ${JSON.stringify(name)} is not allowed`,
      );
    }
    if (name in env)
      throw new AboxError('conflict', `two secrets map to the environment variable ${name}`);
    env[name] = await fetchSecret(store, s.ref);
  }
  return env;
}

/** Files for approved `inject: file` secrets, shaped like `SandboxSpec['files']`. */
export async function buildFileSecrets(
  secrets: TemplateSecrets,
  store: SecretStore,
): Promise<Array<{ sandboxPath: string; content: Buffer; mode: number }>> {
  const files: Array<{ sandboxPath: string; content: Buffer; mode: number }> = [];
  const seen = new Set<string>();
  for (const s of secrets) {
    if (s.inject !== 'file') continue;
    const p = s.path;
    if (
      !p ||
      !p.startsWith('/') ||
      p.includes('\0') ||
      p.split('/').some((x) => x === '..' || x === '.') ||
      p.endsWith('/')
    ) {
      throw new AboxError(
        'invalid_input',
        `secret ${s.ref}: inject: file needs a normalized absolute path`,
        {
          hint: 'set path: /run/secrets/name in the template',
        },
      );
    }
    if (seen.has(p)) throw new AboxError('conflict', `two secrets are written to ${p}`);
    seen.add(p);
    files.push({
      sandboxPath: p,
      content: Buffer.from(await fetchSecret(store, s.ref), 'utf8'),
      mode: 0o400,
    });
  }
  return files;
}
