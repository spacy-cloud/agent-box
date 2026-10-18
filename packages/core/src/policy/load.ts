import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument, visit, type Document } from 'yaml';
import type { ZodIssue } from 'zod';
import { AboxError, type ErrorIssue } from '../errors.js';
import { WORKSPACE_MODES } from '../types.js';
import { NETWORK_PRESETS } from '../template/network-presets.js';
import type { ContextDef, Policy, PolicySource, ResolvedProfile } from './model.js';
import { PolicyFileSchema, type RawPolicy, type RawProfile } from './schema.js';
import { DEFAULT_IMAGE_REGISTRIES } from './images.js';
import { ANY_ROOT } from './paths.js';
import { parseDuration, parseSize } from './units.js';

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

/**
 * Built-in profile of the human operator. Broad rights, but:
 * - the roots are `*` (any directory, `ANY_ROOT`): a human is not limited to a part of the file
 *   system, so a project below a symlink that leads off `$HOME` works. An explicit `roots` list
 *   in a `human` profile of policy.yaml replaces it,
 * - forbidden host paths (see paths.ts) stay forbidden for everyone,
 * - isolation `none`, untrusted templates, shared hosts and secret env/file
 *   injection still need an explicit confirmation (`humanConfirmed`).
 * A `human` profile in policy.yaml without `extends` is merged on top of this.
 */
export const BUILTIN_HUMAN_PROFILE: RawProfile = {
  approval: 'open',
  templates: ['*'],
  limits: { sandboxes: 50, cpus: 64, memory: '512g', ttl: '30d' },
  workspace: { roots: [ANY_ROOT], modes: [...WORKSPACE_MODES] },
  network: {
    modes: ['none', 'allowlist', 'open'],
    allow_presets: Object.keys(NETWORK_PRESETS),
    allow: ['*'],
  },
  images: { registries: ['*'] },
  mounts: { roots: [ANY_ROOT], access: ['ro', 'rw'] },
  secrets: { allowed: ['*'], inject: ['proxy', 'env', 'file'] },
  isolation: { min: 'none', network_open: 'none', mounts: 'none', secrets_env: 'none' },
  hosts: ['*'],
  exec: { approval: false },
  ports: { allow: true, max: 16 },
};

/** Defaults of the profile key `ports`: agents need a human's approval, at most this many forwards per sandbox. */
export const DEFAULT_PORTS_ALLOW = 'ask';
export const DEFAULT_PORTS_MAX = 3;

/** Default soft limits of a `copy` / `sync` workspace (`workspace.max_copy_bytes` / `max_copy_entries`). */
export const DEFAULT_MAX_COPY_BYTES = '1g';
export const DEFAULT_MAX_COPY_ENTRIES = 50_000;
/** Default `cache_max_bytes`: what the package caches of one project may hold. */
export const DEFAULT_CACHE_MAX_BYTES = '10g';

/** Agent context ids of the built-in default policy (all use profile `default`). */
export const BUILTIN_AGENT_CONTEXTS: readonly string[] = [
  'default',
  'claude-code',
  'codex',
  'cursor',
  'orca',
];

/**
 * Workspace roots of the built-in `default` profile: the usual project directories (they need not
 * exist). The home directory as a whole is never a root; for agents hidden directories below the
 * home directory (`~/.claude`, `~/.cache`, ...) are refused on top of that (see `checkHostPath`).
 */
export const DEFAULT_WORKSPACE_ROOTS: readonly string[] = Object.freeze([
  '~/projects',
  '~/Projekte',
  '~/src',
  '~/code',
  '~/dev',
  '~/work',
  '~/git',
  '~/repos',
]);

/**
 * Policy used when no policy.yaml exists. The `default` profile may use directories below the
 * usual project folders (`DEFAULT_WORKSPACE_ROOTS`: ~/projects, ~/Projekte, ~/src, ...) as
 * workspace; the home directory as a whole is no root, and the forbidden-path list (`~`,
 * `~/.ssh`, `~/.config`, ...) plus the rule against hidden home directories still apply. Free
 * image names are limited to the official Docker Hub images (`DEFAULT_IMAGE_REGISTRIES`). The agent
 * context `default` lets an MCP/CLI connection started with `--agent <id>` work out of the box for the
 * built-in agent contexts (`BUILTIN_AGENT_CONTEXTS`: default, claude-code, codex, cursor, orca; all
 * mapped to profile `default`); every other context id is unknown and therefore denied.
 * A policy.yaml replaces this policy completely (and so may redefine or drop these contexts).
 */
export const DEFAULT_POLICY_YAML = `# abox built-in default policy (used when no policy.yaml exists)
version: 1
profiles:
  default:
    approval: medium
    templates: [node-dev, py-dev, py-uv, py-offline, rust-dev, tauri-dev, flutter-dev, php-dev, shell-dev, alpine-min]
    limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }
    # Agents: projects below these folders only (the home directory itself is never a root).
    # Add your own with \`abox policy edit\`.
    workspace: { roots: [${DEFAULT_WORKSPACE_ROOTS.join(', ')}], modes: [worktree, clone, copy, empty] }
    network: { modes: [none, allowlist], allow_presets: [npm, pypi, crates, pub, packagist, github], allow: [] }
    # Registries free image names of a template base may come from (the base images of the built-in templates are always fine).
    images: { registries: [${DEFAULT_IMAGE_REGISTRIES.join(', ')}] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: container, network_open: vm, mounts: container, secrets_env: container }
    hosts: [local]
    exec: { approval: false }
    # Preview forwards (127.0.0.1 -> a port in the sandbox): a human approves each one; \`allow\` is false, ask or true.
    ports: { allow: ask, max: 3 }
contexts:
  # Agent contexts of the supported agent integrations (\`abox mcp serve --agent <id>\`), all with the same profile.
  default: { profile: default }
  claude-code: { profile: default }
  codex: { profile: default }
  cursor: { profile: default }
  orca: { profile: default }
`;

export function policyContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `$XDG_CONFIG_HOME/abox/policy.yaml`, falling back to `~/.config/abox/policy.yaml`. */
export function defaultPolicyPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/')
      ? env.XDG_CONFIG_HOME
      : join(home, '.config');
  return join(base, 'abox', 'policy.yaml');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The built-in policy (see `DEFAULT_POLICY_YAML`). */
export function defaultPolicy(): Policy {
  return parsePolicy(DEFAULT_POLICY_YAML, { kind: 'default' });
}

/**
 * The most restrictive policy: only the built-in `human` context, no agent context and no agent
 * profile. Used by the manager when policy.yaml is invalid and no valid revision was ever recorded
 * (degraded mode), so the human can still look at things and clean up while no agent can do anything.
 */
export function restrictivePolicy(): Policy {
  return parsePolicy('version: 1\n', { kind: 'default' });
}

/**
 * Loads policy.yaml. A missing file yields the built-in default policy
 * (`source.kind === 'default'`); any other problem (unreadable, invalid YAML,
 * schema violation, inheritance cycle) throws `AboxError('invalid_input')`
 * with field-path issues (and line numbers where known).
 */
export function loadPolicy(path: string = defaultPolicyPath()): Policy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultPolicy();
    throw new AboxError(
      'invalid_input',
      `cannot read policy file ${path}: ${(e as Error).message}`,
      {
        hint: 'Check file permissions of policy.yaml.',
        cause: e,
      },
    );
  }
  return parsePolicy(text, { kind: 'file', path });
}

/** Parses and validates policy text. Exported for tests and for `abox policy validate`. */
export function parsePolicy(text: string, source: PolicySource): Policy {
  const where = source.kind === 'file' ? source.path : 'built-in default policy';
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const issues: ErrorIssue[] = [];

  for (const err of doc.errors) {
    const pos =
      err.linePos?.[0] ?? (err.pos?.[0] !== undefined ? lc.linePos(err.pos[0]) : undefined);
    issues.push({
      message: err.message.split('\n')[0] ?? err.message,
      line: pos?.line,
      column: pos?.col,
    });
  }
  // `__proto__` keys would silently change the prototype of the parsed object instead of being a key.
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === '__proto__') {
        const off = (pair.key as { range?: [number, number, number] }).range?.[0];
        const pos = off === undefined ? undefined : lc.linePos(off);
        issues.push({
          message: 'the key "__proto__" is not allowed',
          line: pos?.line,
          column: pos?.col,
        });
      }
    },
  });
  if (issues.length > 0) throw invalid(where, issues);

  const json: unknown = doc.toJS({ maxAliasCount: 50 });
  const parsed = PolicyFileSchema.safeParse(json === null || json === undefined ? {} : json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push(...zodIssueToIssues(issue, doc, lc));
    throw invalid(where, issues);
  }

  const raw = parsed.data;
  const profilesRaw: Record<string, RawProfile> = Object.create(null) as Record<string, RawProfile>;
  for (const [name, p] of Object.entries(raw.profiles ?? {})) profilesRaw[name] = normalizeAlias(p);

  const at = (path: Array<string | number>): { line?: number; column?: number } =>
    locate(doc, lc, path);
  const resolved: Record<string, ResolvedProfile> = Object.create(null) as Record<
    string,
    ResolvedProfile
  >;
  const seenMessages = new Set<string>();
  const addIssue = (i: ErrorIssue): void => {
    const key = `${i.path ?? ''}|${i.message}`;
    if (seenMessages.has(key)) return;
    seenMessages.add(key);
    issues.push(i);
  };

  const names = new Set<string>(['human', ...Object.keys(profilesRaw)]);
  for (const name of names) {
    try {
      resolved[name] = applyDefaults(name, resolveChain(name, profilesRaw, []));
    } catch (e) {
      if (e instanceof ChainError) {
        const owner = e.profile;
        addIssue({
          path: `profiles.${owner}.extends`,
          message: e.message,
          ...at(['profiles', owner, 'extends']),
        });
      } else {
        throw e;
      }
    }
  }

  // Contexts: `human` is built in and always uses the `human` profile.
  const contexts: Record<string, ContextDef> = Object.create(null) as Record<string, ContextDef>;
  contexts.human = { profile: 'human' };
  for (const [id, def] of Object.entries(raw.contexts ?? {})) {
    if (id === 'human') {
      if (def.profile !== 'human' || def.hosts !== undefined) {
        addIssue({
          path: 'contexts.human',
          message:
            'context "human" is built in and always uses profile "human"; remove it or define a different context id for agents',
          ...at(['contexts', 'human']),
        });
      }
      continue;
    }
    if (!Object.hasOwn(resolved, def.profile) && !Object.hasOwn(profilesRaw, def.profile)) {
      addIssue({
        path: `contexts.${id}.profile`,
        message: `unknown profile "${def.profile}" (defined: ${[...names].join(', ')})`,
        ...at(['contexts', id, 'profile']),
      });
      continue;
    }
    contexts[id] = def.hosts
      ? { profile: def.profile, hosts: def.hosts }
      : { profile: def.profile };
  }

  if (issues.length > 0) throw invalid(where, issues);
  return { profiles: resolved, contexts, source, contentHash: policyContentHash(text) };
}

function invalid(where: string, issues: ErrorIssue[]): AboxError {
  const first = issues[0];
  const loc = first?.line ? ` (line ${first.line})` : '';
  return new AboxError(
    'invalid_input',
    `invalid policy in ${where}: ${issues.length} problem(s), first: ${first?.path ? first.path + ': ' : ''}${first?.message ?? 'unknown'}${loc}`,
    {
      issues,
      hint: 'Fix policy.yaml (only a human may edit it); `abox policy validate` re-validates it.',
    },
  );
}

// ---------------------------------------------------------------------------
// Zod issue -> ErrorIssue with line numbers
// ---------------------------------------------------------------------------

function zodIssueToIssues(issue: ZodIssue, doc: Document, lc: LineCounter): ErrorIssue[] {
  const base = issue.path.filter(
    (s): s is string | number => typeof s === 'string' || typeof s === 'number',
  );
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((k) => ({
      path: [...base, k].join('.'),
      message: `unknown key "${k}"`,
      ...locate(doc, lc, [...base, k]),
    }));
  }
  return [{ path: base.join('.') || undefined, message: issue.message, ...locate(doc, lc, base) }];
}

/** Finds the 1-based line/column of the deepest node on `path` (the key node for map entries). */
function locate(
  doc: Document,
  lc: LineCounter,
  path: Array<string | number>,
): { line?: number; column?: number } {
  let node: unknown = doc.contents;
  let offset: number | undefined = (doc.contents as { range?: [number, number, number] } | null)
    ?.range?.[0];
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
      if (!pair) break;
      offset = (pair.key as { range?: [number, number, number] }).range?.[0] ?? offset;
      node = pair.value;
    } else if (isSeq(node) && typeof seg === 'number') {
      const item = node.items[seg];
      if (item === undefined) break;
      node = item;
      offset = (item as { range?: [number, number, number] }).range?.[0] ?? offset;
    } else {
      break;
    }
  }
  if (offset === undefined) return {};
  const pos = lc.linePos(offset);
  return { line: pos.line, column: pos.col };
}

// ---------------------------------------------------------------------------
// Profile resolution (extends, merge, defaults)
// ---------------------------------------------------------------------------

class ChainError extends Error {
  constructor(
    message: string,
    readonly profile: string,
  ) {
    super(message);
  }
}

/** `min_isolation` is an accepted alias of `isolation`; `isolation` wins. */
function normalizeAlias(p: RawProfile): RawProfile {
  const { min_isolation, ...rest } = p;
  if (!min_isolation) return rest;
  return { ...rest, isolation: { ...min_isolation, ...(rest.isolation ?? {}) } };
}

function resolveChain(
  name: string,
  profiles: Record<string, RawProfile>,
  stack: string[],
): RawProfile {
  if (stack.includes(name)) {
    throw new ChainError(
      `profile inheritance cycle: ${[...stack, name].join(' -> ')}`,
      stack[stack.length - 1] ?? name,
    );
  }
  const spec: RawProfile | undefined = Object.hasOwn(profiles, name)
    ? profiles[name]
    : name === 'human'
      ? BUILTIN_HUMAN_PROFILE
      : undefined;
  if (!spec) {
    const child = stack[stack.length - 1] ?? name;
    throw new ChainError(
      `unknown profile "${name}" in extends (defined: ${Object.keys(profiles).join(', ') || 'none'})`,
      child,
    );
  }
  let parent: RawProfile = {};
  if (spec.extends !== undefined) {
    parent = resolveChain(spec.extends, profiles, [...stack, name]);
  } else if (name === 'human') {
    parent = BUILTIN_HUMAN_PROFILE;
  }
  return mergeProfiles(parent, spec);
}

/** Child fields override parent fields; arrays are replaced, objects merged one level deep. */
export function mergeProfiles(parent: RawProfile, child: RawProfile): RawProfile {
  const out: RawProfile = { ...parent };
  for (const key of ['approval', 'templates', 'hosts', 'caches', 'cache_max_bytes'] as const) {
    if (child[key] !== undefined) (out as Record<string, unknown>)[key] = child[key];
  }
  for (const key of [
    'limits',
    'workspace',
    'network',
    'images',
    'secrets',
    'isolation',
    'exec',
    'ports',
  ] as const) {
    if (child[key] !== undefined) {
      (out as Record<string, unknown>)[key] = { ...(parent[key] ?? {}), ...child[key] };
    }
  }
  if (child.mounts !== undefined) {
    if (child.mounts === 'deny' || parent.mounts === undefined || parent.mounts === 'deny')
      out.mounts = child.mounts;
    else out.mounts = { ...parent.mounts, ...child.mounts };
  }
  delete out.extends;
  return out;
}

function applyDefaults(name: string, p: RawProfile): ResolvedProfile {
  const memory = p.limits?.memory ?? '8g';
  const ttl = p.limits?.ttl ?? '4h';
  const maxCopy = p.workspace?.max_copy_bytes ?? DEFAULT_MAX_COPY_BYTES;
  const cacheMax = p.cache_max_bytes ?? DEFAULT_CACHE_MAX_BYTES;
  const mounts: ResolvedProfile['mounts'] =
    p.mounts === undefined || p.mounts === 'deny'
      ? null
      : { roots: [...(p.mounts.roots ?? [])], access: [...(p.mounts.access ?? ['ro'])] };
  return {
    name,
    approval: p.approval ?? 'medium',
    templates: [...(p.templates ?? [])],
    limits: {
      sandboxes: p.limits?.sandboxes ?? 3,
      cpus: p.limits?.cpus ?? 4,
      memory,
      ttl,
      memoryBytes: parseSize(memory),
      ttlMs: parseDuration(ttl),
    },
    workspace: {
      roots: [...(p.workspace?.roots ?? [])],
      modes: [...(p.workspace?.modes ?? ['empty'])],
      max_copy_bytes: maxCopy,
      maxCopyBytes: parseSize(maxCopy),
      max_copy_entries: p.workspace?.max_copy_entries ?? DEFAULT_MAX_COPY_ENTRIES,
    },
    network: {
      modes: [...(p.network?.modes ?? ['none'])],
      allow_presets: [...(p.network?.allow_presets ?? [])],
      allow: [...(p.network?.allow ?? [])],
    },
    images: { registries: [...(p.images?.registries ?? DEFAULT_IMAGE_REGISTRIES)] },
    mounts,
    secrets: {
      allowed: [...(p.secrets?.allowed ?? [])],
      inject: [...(p.secrets?.inject ?? ['proxy'])],
    },
    isolation: {
      min: p.isolation?.min ?? 'container',
      network_open: p.isolation?.network_open ?? 'vm',
      mounts: p.isolation?.mounts ?? 'container',
      secrets_env: p.isolation?.secrets_env ?? 'container',
    },
    hosts: [...(p.hosts ?? ['local'])],
    exec: { approval: p.exec?.approval ?? false },
    caches: p.caches ?? true,
    cache_max_bytes: cacheMax,
    cacheMaxBytes: parseSize(cacheMax),
    ports: { allow: p.ports?.allow ?? DEFAULT_PORTS_ALLOW, max: p.ports?.max ?? DEFAULT_PORTS_MAX },
  };
}

export type { RawPolicy, RawProfile };
