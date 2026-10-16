import { posix } from 'node:path';
import { AboxError, type ErrorIssue } from '../errors.js';
import { isolationAtLeast, type ProviderCapabilities, type ResolvedTemplate } from '../types.js';
import { templateInvalidError } from './parse.js';

/** Issue found by `validateTemplate`. `unsupported` = valid template the backend cannot deliver. */
export interface TemplateIssue extends ErrorIssue {
  kind: 'invalid' | 'unsupported';
}

export interface ValidationResult {
  ok: boolean;
  issues: TemplateIssue[];
  warnings: string[];
}

export interface ValidateOptions {
  /** Backend capabilities; without them only static checks run. */
  capabilities?: ProviderCapabilities;
  /** Treat a missing/short agent description as an error instead of a warning. */
  strictDescription?: boolean;
}

export const MIN_DESCRIPTION_LENGTH = 20;

// ---------------------------------------------------------------------------
// Path rules (static; the real canonical-path check happens in the policy layer)
// ---------------------------------------------------------------------------

const HOME = '/\0home';

/** `~/x/../y` -> `~/y`; returns undefined when the path escapes the home directory. */
function normalizeMountSource(src: string): string | undefined {
  if (src === '~' || src.startsWith('~/')) {
    const n = posix.normalize(HOME + src.slice(1));
    if (n !== HOME && !n.startsWith(`${HOME}/`)) return undefined;
    return `~${n.slice(HOME.length)}`.replace(/(.)\/+$/, '$1');
  }
  return posix.normalize(src).replace(/(.)\/+$/, '$1');
}

function isInside(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

const FORBIDDEN_SOURCE_TREES: Array<[string, string]> = [
  ['/proc', 'kernel and process internals'],
  ['/sys', 'kernel and device internals'],
  ['/dev', 'host devices'],
  ['/etc', 'host system configuration'],
  ['/run', 'runtime sockets (container engines, D-Bus)'],
  ['/var/run', 'runtime sockets (container engines, D-Bus)'],
  ['/boot', 'boot files'],
  ['/root', 'the root user home'],
  ['/var/lib/docker', 'container engine storage'],
  ['/var/lib/containers', 'container engine storage'],
  ['/var/lib/containerd', 'container engine storage'],
  ['~/.ssh', 'SSH keys'],
  ['~/.gnupg', 'GPG keys'],
  ['~/.aws', 'cloud credentials'],
  ['~/.kube', 'cluster credentials'],
  ['~/.docker', 'container registry credentials'],
  ['~/.config/gcloud', 'cloud credentials'],
  ['~/.config/gh', 'GitHub credentials'],
  ['~/.config/abox', 'abox configuration and secrets'],
  ['~/.local/share/abox', 'abox state and secrets'],
  ['~/.local/state/abox', 'abox state'],
  ['~/.password-store', 'password store'],
  ['~/.netrc', 'network credentials'],
  ['~/.npmrc', 'package registry tokens'],
  ['~/.pypirc', 'package registry tokens'],
  ['~/.git-credentials', 'git credentials'],
];

/** Exactly these paths are rejected because they contain forbidden trees. */
const FORBIDDEN_SOURCE_EXACT: Array<[string, string]> = [
  ['/', 'the whole host file system'],
  ['/var', 'it contains /var/run and /var/lib/docker'],
  ['/var/lib', 'it contains container engine storage'],
  ['~', 'the home directory contains SSH keys and credentials'],
  ['~/.config', 'it contains credentials and abox configuration'],
  ['~/.local', 'it contains abox state'],
  ['~/.local/share', 'it contains abox state'],
];

/** Credential directories rejected at any depth, regardless of the home directory location. */
const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.netrc',
  '.git-credentials',
  '.password-store',
]);

function checkMountSource(source: string): string | undefined {
  const norm = normalizeMountSource(source);
  if (norm === undefined) return `mount source "${source}" escapes the home directory`;
  if (/\.sock(et)?$/i.test(norm)) {
    return `mount source "${source}" is a unix socket; sockets (docker.sock, podman.sock, containerd.sock, …) can never be mounted`;
  }
  for (const [p, why] of FORBIDDEN_SOURCE_EXACT) {
    if (norm === p) return `mount source "${source}" is not allowed: ${why}`;
  }
  for (const [p, why] of FORBIDDEN_SOURCE_TREES) {
    if (isInside(norm, p)) return `mount source "${source}" is not allowed: ${p} exposes ${why}`;
  }
  const seg = norm.split('/').find((s) => SENSITIVE_SEGMENTS.has(s));
  if (seg) return `mount source "${source}" is not allowed: ${seg} holds credentials`;
  return undefined;
}

const FORBIDDEN_TARGET_TREES = [
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/run',
  '/var/run',
  '/boot',
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
];

function checkSandboxPath(what: string, p: string): string | undefined {
  const norm = posix.normalize(p).replace(/(.)\/+$/, '$1');
  if (norm === '/') return `${what} must not be the file system root`;
  for (const t of FORBIDDEN_TARGET_TREES) {
    if (isInside(norm, t)) return `${what} "${p}" is inside ${t}, which must stay untouched`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Env heuristics
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|KEY/i;
const SECRET_VALUE_RES: RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^sk-[A-Za-z0-9_-]{20,}/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

// ---------------------------------------------------------------------------

/**
 * Checks a resolved template against security rules and (optionally) backend
 * capabilities. Never throws for template problems; see `assertTemplateValid`.
 */
export function validateTemplate(
  t: ResolvedTemplate,
  opts: ValidateOptions = {},
): ValidationResult {
  const issues: TemplateIssue[] = [];
  const warnings: string[] = [];
  const bad = (path: string, message: string) => issues.push({ kind: 'invalid', path, message });
  const unsupported = (path: string, message: string) =>
    issues.push({ kind: 'unsupported', path, message });
  const caps = opts.capabilities;

  // --- security rules -----------------------------------------------------
  if (t.user.uid === 0 || t.user.name === 'root') {
    bad(
      'user',
      'the sandbox user must not be root (user.uid 0 / name "root" is rejected); use an unprivileged user such as agent (uid 1000)',
    );
  }
  if (t.user.sudo)
    warnings.push(
      'user.sudo is enabled: code in the sandbox can become root inside it, which weakens isolation inside the sandbox',
    );

  const wsProblem = checkSandboxPath('workspace.path', t.workspace.path);
  if (wsProblem) bad('workspace.path', wsProblem);

  t.mounts.forEach((m, i) => {
    const src = checkMountSource(m.source);
    if (src) bad(`mounts[${i}].source`, src);
    const tgt = checkSandboxPath('mount target', m.target);
    if (tgt) bad(`mounts[${i}].target`, tgt);
    if (posix.normalize(m.target) === posix.normalize(t.workspace.path)) {
      bad(`mounts[${i}].target`, `mount target "${m.target}" collides with workspace.path`);
    }
  });

  for (const [key, value] of Object.entries(t.env)) {
    if (SECRET_KEY_RE.test(key)) {
      bad(
        `env.${key}`,
        `env variable ${key} looks like a secret; do not store secrets in templates, reference them with \`secrets:\` instead`,
      );
    } else if (SECRET_VALUE_RES.some((re) => re.test(value))) {
      bad(
        `env.${key}`,
        `the value of env variable ${key} looks like a credential; reference secrets with \`secrets:\` instead`,
      );
    }
    if (key.startsWith('ABOX_'))
      bad(`env.${key}`, 'env variables starting with ABOX_ are reserved for abox');
  }

  if (t.network.mode === 'allowlist' && t.network.allow.length === 0) {
    bad(
      'network.allow',
      'network.mode is "allowlist" but no domains are listed (add network.allow or network.presets, or use mode "none")',
    );
  }
  if (t.network.mode === 'open') {
    warnings.push(
      'network.mode is "open": the sandbox has unrestricted internet access and can send anything it can read to any host',
    );
  }
  if (t.isolation === 'none' || (caps && caps.isolation === 'none')) {
    warnings.push(
      'isolation "none": the sandbox is NOT isolated from the host; commands run with the permissions of the abox user',
    );
  }

  t.secrets.forEach((s, i) => {
    if (s.inject === 'proxy') {
      if (t.network.mode !== 'allowlist') {
        bad(
          `secrets[${i}].inject`,
          `secret "${s.ref}" is injected by the egress proxy, which only runs with network.mode "allowlist" (current: "${t.network.mode}")`,
        );
      } else {
        for (const h of s.hosts) {
          if (!hostCovered(h, t.network.allow)) {
            warnings.push(
              `secret "${s.ref}": host ${h} is not covered by network.allow; requests to it would be blocked`,
            );
          }
        }
      }
    }
    if (s.inject === 'env') {
      warnings.push(
        `secret "${s.ref}" is injected as an environment variable: code in the sandbox can read and leak it (prefer inject: proxy)`,
      );
    }
    if (s.inject === 'file') {
      warnings.push(
        `secret "${s.ref}" is injected as a file: code in the sandbox can read and leak it (prefer inject: proxy)`,
      );
    }
  });

  // --- agent-facing description ------------------------------------------
  const desc = t.description.trim();
  if (desc.length < MIN_DESCRIPTION_LENGTH) {
    const msg = `description is ${desc.length === 0 ? 'missing' : 'too short'} (at least ${MIN_DESCRIPTION_LENGTH} characters): agents pick templates by reading it`;
    if (opts.strictDescription) bad('description', msg);
    else warnings.push(msg);
  }
  if (!t.labels['use-for'])
    warnings.push('labels.use-for is missing: it is shown to agents in the template list');

  // --- backend capabilities ----------------------------------------------
  if (caps) {
    const be = t.backend;
    if (!isolationAtLeast(caps.isolation, t.isolation)) {
      unsupported(
        'isolation',
        `template requires isolation "${t.isolation}" but backend "${be}" delivers only "${caps.isolation}"`,
      );
    }
    if (!caps.networkModes.includes(t.network.mode)) {
      unsupported(
        'network.mode',
        `backend "${be}" does not support network mode "${t.network.mode}" (supported: ${caps.networkModes.join(', ') || 'none'})`,
      );
    } else if (t.network.mode === 'allowlist' && !caps.networkFilter) {
      unsupported(
        'network.mode',
        `network.mode "allowlist" needs the egress filter, which backend "${be}" cannot provide`,
      );
    }
    if (t.mounts.length > 0 && !caps.mounts) {
      unsupported('mounts', `backend "${be}" does not support additional host mounts`);
    }
    if (!caps.nonRootUser) {
      unsupported(
        'user',
        `backend "${be}" cannot run as a non-root user, which every template requires`,
      );
    }
    for (const [i, s] of t.secrets.entries()) {
      if (!caps.secretInjection.includes(s.inject)) {
        unsupported(
          `secrets[${i}].inject`,
          `backend "${be}" does not support secret injection "${s.inject}" (supported: ${caps.secretInjection.join(', ') || 'none'})`,
        );
      }
    }
    if (t.base.osFamily !== 'unknown' && !caps.osFamilies.includes(t.base.osFamily)) {
      unsupported(
        'base.os',
        `backend "${be}" cannot prepare ${t.base.osFamily}-family base images (supported: ${caps.osFamilies.join(', ') || 'none'})`,
      );
    }
    if (t.build.length > 0 && caps.osFamilies.length === 0) {
      unsupported(
        'build',
        `backend "${be}" has no environment build step but the template installs packages, tools or setup commands`,
      );
    }
    if (caps.remote && (t.workspace.mode === 'mount' || t.mounts.length > 0)) {
      unsupported(
        'workspace.mode',
        `backend "${be}" runs on a remote host; host mounts and workspace mode "mount" are impossible`,
      );
    }
    if (t.workspace.mode === 'mount' && !caps.workspaceDelivery.includes('bind') && !caps.remote) {
      unsupported(
        'workspace.mode',
        `backend "${be}" cannot bind-mount the workspace (supported delivery: ${caps.workspaceDelivery.join(', ') || 'none'})`,
      );
    }
    if (t.workspace.mode === 'copy' && !caps.workspaceDelivery.includes('copy')) {
      unsupported(
        'workspace.mode',
        `backend "${be}" cannot copy the workspace into the sandbox (supported delivery: ${caps.workspaceDelivery.join(', ') || 'none'})`,
      );
    }
    if (t.resources.diskBytes !== undefined && !caps.limits.disk) {
      unsupported(
        'resources.disk',
        `backend "${be}" cannot enforce a disk limit; remove resources.disk`,
      );
    }
    if (!caps.limits.memory) warnings.push(`backend "${be}" does not enforce resources.memory`);
    if (!caps.limits.cpus) warnings.push(`backend "${be}" does not enforce resources.cpus`);
    if (!caps.limits.pids) warnings.push(`backend "${be}" does not enforce resources.pids`);
  }

  return { ok: issues.length === 0, issues, warnings };
}

/**
 * Throws when the template is not valid: `unsupported` if only capability problems
 * were found, `template_invalid` otherwise. Returns the warnings on success.
 */
export function assertTemplateValid(t: ResolvedTemplate, opts: ValidateOptions = {}): string[] {
  const r = validateTemplate(t, opts);
  if (r.ok) return r.warnings;
  const onlyUnsupported = r.issues.every((i) => i.kind === 'unsupported');
  if (!onlyUnsupported) throw templateInvalidError(r.issues.map(stripKind), t.source.path);
  const first = r.issues[0]!;
  throw new AboxError(
    'unsupported',
    `Template "${t.name}" cannot run on backend "${t.backend}": ${first.message}${r.issues.length > 1 ? ` (+${r.issues.length - 1} more)` : ''}`,
    {
      issues: r.issues.map(stripKind),
      hint: 'Pick a different template or backend (`abox template list`, `abox doctor`).',
    },
  );
}

function stripKind(i: TemplateIssue): ErrorIssue {
  const { kind: _kind, ...rest } = i;
  return rest;
}

/** Does a destination host fall under one of the allowlist patterns? */
function hostCovered(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  const hostOnly = h.replace(/:\d+$/, '');
  return allow.some((p) => {
    const pat = p.replace(/:\d+$/, '');
    if (pat.startsWith('*.')) return hostOnly.endsWith(pat.slice(1)) || hostOnly === pat.slice(2);
    return hostOnly === pat;
  });
}
