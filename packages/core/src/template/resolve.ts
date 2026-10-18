import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { AboxError, type ErrorIssue } from '../errors.js';
import type {
  AccessMode,
  BackendKind,
  BuildContextInfo,
  BuildStep,
  IsolationLevel,
  OsFamily,
  PackageManager,
  ResolvedTemplate,
  SecretInjection,
  TemplateCache,
  TemplateSourceKind,
  TemplateSpec,
} from '../types.js';
import { expandNetworkPresets } from './network-presets.js';
import { formatPath, templateInvalidError } from './parse.js';
import {
  bootstrapStep,
  parseToolRef,
  renderToolPreset,
  shQuote,
  type RenderedTool,
} from './presets.js';
import { isSafePackageName, parseDuration, parseSize, templateSchema } from './schema.js';

/** Maximum number of `extends` hops (child -> parent -> … ). */
export const MAX_EXTENDS_DEPTH = 5;

/** Restrictive defaults applied to everything a template leaves unspecified. */
export const TEMPLATE_DEFAULTS = {
  user: { name: 'agent', uid: 1000, sudo: false },
  resources: { cpus: 2, memory: '2g', pids: 512, ttl: '2h' },
  workspace: { mode: 'copy', path: '/workspace', access: 'rw' },
  network: { mode: 'none' },
  mountAccess: 'ro',
  secretInject: 'proxy',
} as const;

export function defaultIsolation(backend: BackendKind): IsolationLevel {
  switch (backend) {
    case 'docker':
    case 'podman':
    case 'python':
      return 'container';
    case 'process':
      return 'none';
    case 'vm':
      return 'vm';
  }
}

export interface TemplateSource {
  kind: TemplateSourceKind;
  path?: string;
}

export interface ParentTemplate {
  spec: TemplateSpec;
  source: TemplateSource;
  /** Raw file text; project parents are part of the child's `contentHash`. */
  contentText?: string;
}

/**
 * Finds the parent template named by `extends`. `from` describes the extending template:
 * implementations should only consider locations at or below `from.kind` in the
 * precedence order project > user > builtin, and a template extending its own name
 * (to customise a builtin) must get the next lower location, never itself.
 */
export type TemplateLookup = (
  name: string,
  from: { kind: TemplateSourceKind; name: string; path?: string },
) => Promise<ParentTemplate | undefined> | ParentTemplate | undefined;

export interface ResolveOptions {
  source: TemplateSource;
  /** Raw file text (for `contentHash`). */
  contentText: string;
  /** Needed when the template uses `extends`. */
  lookup?: TemplateLookup;
  /**
   * Reads the build context of `base.dockerfile` (the catalog does). Without it a Dockerfile is
   * only a path: the hashes then do not cover the Dockerfile's content.
   */
  buildContext?: (dockerfile: string, source: TemplateSource) => Promise<BuildContextInfo>;
}

// ---------------------------------------------------------------------------
// OS family detection
// ---------------------------------------------------------------------------

/** Debian-derived official images whose default variant is Debian/Ubuntu based. */
const DEBIAN_DEFAULT_IMAGES = new Set([
  'ubuntu',
  'debian',
  'python',
  'node',
  'golang',
  'rust',
  'ruby',
  'eclipse-temurin',
]);

export function detectOsFamily(os: string | undefined): OsFamily {
  if (!os) return 'unknown';
  const ref = os.toLowerCase().split('@')[0]!;
  const lastSlash = ref.lastIndexOf('/');
  const nameAndTag = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;
  const colon = nameAndTag.indexOf(':');
  const name = colon >= 0 ? nameAndTag.slice(0, colon) : nameAndTag;
  const tag = colon >= 0 ? nameAndTag.slice(colon + 1) : '';
  if (name === 'alpine' || /(^|[-_.])alpine($|[-_.\d])/.test(tag)) return 'alpine';
  if (name === 'fedora' || /^fedora([-_.]|$)/.test(name)) return 'fedora';
  if (name === 'archlinux') return 'arch';
  if (/^(ubuntu|debian)([-_.\d]|$)/.test(name)) return 'debian'; // also VM distro names like ubuntu-24.04
  if (DEBIAN_DEFAULT_IMAGES.has(name)) return 'debian';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Canonical JSON / hashing
// ---------------------------------------------------------------------------

/** JSON with recursively sorted object keys; `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// extends / merge
// ---------------------------------------------------------------------------

function defined<T extends object>(o: T | undefined): Partial<T> {
  const out: Record<string, unknown> = {};
  if (o) for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Merges a parent spec with a child spec (child wins). Rules (Template-Spezifikation,
 * "Vererbung"): lists are appended, scalars/objects are overridden field-wise,
 * `network.allow`/`presets` are a union, `env`/`labels` merge by key. Exceptions that keep
 * the result consistent: a child `base` replaces the parent's `base` as a whole (os and
 * dockerfile are alternatives), a child `tools` entry replaces the parent's entry for the
 * same preset (so `node@22` can be bumped to `node@24`), mounts/secrets are keyed by
 * target/ref, caches are keyed by name, and a child `network.mode` other than `allowlist` drops
 * inherited allow/presets entries.
 */
export function mergeTemplateSpecs(parent: TemplateSpec, child: TemplateSpec): TemplateSpec {
  const out: TemplateSpec = {
    apiVersion: 1,
    name: child.name,
    backend: child.backend,
    base:
      child.base.os !== undefined || child.base.dockerfile !== undefined
        ? { ...child.base }
        : { ...parent.base },
  };
  const description = child.description ?? parent.description;
  if (description !== undefined) out.description = description;
  const isolation = child.isolation ?? parent.isolation;
  if (isolation !== undefined) out.isolation = isolation;

  if (parent.packages || child.packages) {
    const packages: NonNullable<TemplateSpec['packages']> = {};
    for (const m of ['apt', 'apk', 'dnf', 'pacman', 'pip', 'npm'] as PackageManager[]) {
      const list = unique([...(parent.packages?.[m] ?? []), ...(child.packages?.[m] ?? [])]);
      if (list.length > 0) packages[m] = list;
    }
    out.packages = packages;
  }

  if (parent.tools || child.tools) {
    const childNames = new Set((child.tools ?? []).map((t) => parseToolRef(t).name));
    const inherited = (parent.tools ?? []).filter((t) => !childNames.has(parseToolRef(t).name));
    out.tools = unique([...inherited, ...(child.tools ?? [])]);
  }
  if (parent.setup || child.setup) out.setup = [...(parent.setup ?? []), ...(child.setup ?? [])];

  if (parent.user || child.user) out.user = { ...defined(parent.user), ...defined(child.user) };
  if (parent.workspace || child.workspace)
    out.workspace = { ...defined(parent.workspace), ...defined(child.workspace) };
  if (parent.resources || child.resources)
    out.resources = { ...defined(parent.resources), ...defined(child.resources) };
  if (parent.python || child.python)
    out.python = { ...defined(parent.python), ...defined(child.python) };
  if (parent.vm || child.vm) out.vm = { ...defined(parent.vm), ...defined(child.vm) };

  if (parent.network || child.network) {
    const childMode = child.network?.mode;
    const dropInherited = childMode !== undefined && childMode !== 'allowlist';
    const network: NonNullable<TemplateSpec['network']> = {};
    const mode = childMode ?? parent.network?.mode;
    if (mode !== undefined) network.mode = mode;
    const allow = unique([
      ...(dropInherited ? [] : (parent.network?.allow ?? [])),
      ...(child.network?.allow ?? []),
    ]);
    const presets = unique([
      ...(dropInherited ? [] : (parent.network?.presets ?? [])),
      ...(child.network?.presets ?? []),
    ]);
    if (allow.length > 0) network.allow = allow;
    if (presets.length > 0) network.presets = presets;
    out.network = network;
  }

  if (parent.mounts || child.mounts) {
    const childTargets = new Set((child.mounts ?? []).map((m) => m.target));
    out.mounts = [
      ...(parent.mounts ?? []).filter((m) => !childTargets.has(m.target)),
      ...(child.mounts ?? []),
    ];
  }
  if (parent.secrets || child.secrets) {
    const childRefs = new Set((child.secrets ?? []).map((s) => s.ref));
    out.secrets = [
      ...(parent.secrets ?? []).filter((s) => !childRefs.has(s.ref)),
      ...(child.secrets ?? []),
    ];
  }
  if (parent.caches || child.caches) {
    const childNames = new Set((child.caches ?? []).map((c) => c.name));
    out.caches = [
      ...(parent.caches ?? []).filter((c) => !childNames.has(c.name)),
      ...(child.caches ?? []),
    ];
  }
  if (parent.env || child.env) out.env = { ...parent.env, ...child.env };
  if (parent.labels || child.labels) out.labels = { ...parent.labels, ...child.labels };
  return out;
}

function sourceKey(name: string, src: TemplateSource): string {
  return `${src.kind}:${src.path ?? name}`;
}

async function resolveChain(
  spec: TemplateSpec,
  source: TemplateSource,
  lookup: TemplateLookup | undefined,
): Promise<{ merged: TemplateSpec; parents: ParentTemplate[] }> {
  const chain: Array<{ spec: TemplateSpec; source: TemplateSource; contentText?: string }> = [
    { spec, source },
  ];
  const seen = new Set([sourceKey(spec.name, source)]);
  let cur = chain[0]!;
  while (cur.spec.extends) {
    const parentName = cur.spec.extends;
    if (chain.length - 1 >= MAX_EXTENDS_DEPTH) {
      throw invalid(
        'extends',
        `extends chain is deeper than ${MAX_EXTENDS_DEPTH} levels: ${chain.map((c) => c.spec.name).join(' -> ')} -> ${parentName}`,
      );
    }
    if (!lookup) {
      throw invalid(
        'extends',
        `template "${cur.spec.name}" extends "${parentName}" but no template lookup is available`,
      );
    }
    const found = await lookup(parentName, {
      kind: cur.source.kind,
      name: cur.spec.name,
      ...(cur.source.path ? { path: cur.source.path } : {}),
    });
    if (!found) {
      throw invalid(
        'extends',
        `template "${cur.spec.name}" extends unknown template "${parentName}"`,
        'Check the name with `abox template ls`.',
      );
    }
    assertSpec(found.spec);
    const key = sourceKey(found.spec.name, found.source);
    if (seen.has(key)) {
      throw invalid(
        'extends',
        `extends cycle: ${[...chain.map((c) => c.spec.name), found.spec.name].join(' -> ')}`,
      );
    }
    seen.add(key);
    cur = {
      spec: found.spec,
      source: found.source,
      ...(found.contentText !== undefined ? { contentText: found.contentText } : {}),
    };
    chain.push(cur);
  }
  let merged = chain[chain.length - 1]!.spec;
  for (let i = chain.length - 2; i >= 0; i--) merged = mergeTemplateSpecs(merged, chain[i]!.spec);
  return { merged, parents: chain.slice(1) };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function invalid(path: string | undefined, message: string, hint?: string): AboxError {
  const e = templateInvalidError([{ ...(path ? { path } : {}), message }]);
  return hint ? new AboxError('template_invalid', e.message, { issues: e.issues, hint }) : e;
}

class Problems {
  readonly items: ErrorIssue[] = [];
  add(path: string, message: string): void {
    this.items.push({ path, message });
  }
  throwIfAny(): void {
    if (this.items.length > 0) throw templateInvalidError(this.items);
  }
}

function assertSpec(spec: TemplateSpec): void {
  const r = templateSchema.safeParse(spec);
  if (r.success) return;
  throw templateInvalidError(
    r.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const OS_PACKAGE_MANAGER_FAMILY: Record<'apt' | 'apk' | 'dnf' | 'pacman', OsFamily> = {
  apt: 'debian',
  apk: 'alpine',
  dnf: 'fedora',
  pacman: 'arch',
};

const FAMILY_EXAMPLE: Record<OsFamily, string> = {
  debian: 'ubuntu:24.04, debian:12',
  alpine: 'alpine:3.22',
  fedora: 'fedora:42',
  arch: 'archlinux:latest',
  unknown: '',
};

const CONTAINER_BACKENDS: BackendKind[] = ['docker', 'podman', 'python'];

/** Applies `extends`, defaults and renders the build steps. See `ResolvedTemplate`. */
export async function resolveTemplate(
  spec: TemplateSpec,
  opts: ResolveOptions,
): Promise<ResolvedTemplate> {
  assertSpec(spec);
  const { merged, parents } = await resolveChain(spec, opts.source, opts.lookup);
  const problems = new Problems();
  const backend = merged.backend;
  const base = merged.base;

  // --- base ---------------------------------------------------------------
  if (base.os !== undefined && base.dockerfile !== undefined) {
    problems.add('base', 'set either base.os or base.dockerfile, not both');
  }
  if (backend === 'process') {
    if (base.os || base.dockerfile)
      problems.add('base', 'backend "process" runs on the host and has no base image; remove base');
    if (merged.packages && Object.values(merged.packages).some((l) => l && l.length > 0)) {
      problems.add(
        'packages',
        'backend "process" cannot install packages (it runs on the host); remove packages',
      );
    }
    if (merged.tools?.length)
      problems.add(
        'tools',
        'backend "process" cannot install tool presets (it runs on the host); remove tools',
      );
    if (merged.setup?.length)
      problems.add('setup', 'backend "process" has no build step; remove setup');
  }
  if (backend === 'docker' || backend === 'podman') {
    if (!base.os && !base.dockerfile)
      problems.add(
        'base',
        `backend "${backend}" needs base.os (e.g. ubuntu:24.04) or base.dockerfile`,
      );
  }
  if (backend === 'vm' && !base.os && !merged.vm?.image)
    problems.add('base', 'backend "vm" needs base.os (distro name) or vm.image');
  if (base.dockerfile !== undefined && !CONTAINER_BACKENDS.includes(backend)) {
    problems.add(
      'base.dockerfile',
      `base.dockerfile only applies to container backends, not "${backend}"`,
    );
  }
  if (merged.python && backend !== 'python')
    problems.add('python', `the python section only applies to backend "python", not "${backend}"`);
  if (merged.vm && backend !== 'vm')
    problems.add('vm', `the vm section only applies to backend "vm", not "${backend}"`);

  const osFamily = detectOsFamily(base.os);

  // --- packages / tools / setup -> build steps ----------------------------
  const build: BuildStep[] = [];
  const osSteps: BuildStep[] = [];
  const langSteps: BuildStep[] = [];

  for (const manager of ['apt', 'apk', 'dnf', 'pacman'] as const) {
    const pkgs = merged.packages?.[manager];
    if (!pkgs?.length) continue;
    const need = OS_PACKAGE_MANAGER_FAMILY[manager];
    if (osFamily !== need) {
      const detail =
        osFamily === 'unknown'
          ? `cannot determine the OS family of base ${base.os ? `"${base.os}"` : base.dockerfile ? 'dockerfile (install packages inside the Dockerfile)' : '(none)'}`
          : `base.os "${base.os}" is ${osFamily}`;
      problems.add(
        `packages.${manager}`,
        `packages.${manager} needs a base of the ${need} family (${FAMILY_EXAMPLE[need]}), but ${detail}`,
      );
      continue;
    }
    for (const [i, p] of pkgs.entries()) {
      if (!isSafePackageName(manager, p))
        problems.add(`packages.${manager}[${i}]`, `unsafe package name "${p}"`);
    }
    osSteps.push(renderPackageStep(manager, pkgs));
  }
  for (const manager of ['pip', 'npm'] as const) {
    const pkgs = merged.packages?.[manager];
    if (!pkgs?.length) continue;
    for (const [i, p] of pkgs.entries()) {
      if (!isSafePackageName(manager, p))
        problems.add(`packages.${manager}[${i}]`, `unsafe package name "${p}"`);
    }
    langSteps.push(renderPackageStep(manager, pkgs));
  }
  problems.throwIfAny();

  // Tools: render in user order, install toolchains before layered tools.
  const toolRefs = merged.tools ?? [];
  const seenTools = new Set<string>();
  const rendered: RenderedTool[] = [];
  for (const [i, ref] of toolRefs.entries()) {
    const { name } = parseToolRef(ref);
    if (seenTools.has(name)) {
      problems.add(
        `tools[${i}]`,
        `tool preset "${name}" is listed more than once (${toolRefs.filter((t) => parseToolRef(t).name === name).join(', ')})`,
      );
      continue;
    }
    seenTools.add(name);
    rendered.push(renderToolPreset(ref, osFamily, `tools[${i}]`));
  }
  problems.throwIfAny();
  const ordered = [
    ...rendered.filter((r) => r.preset.phase === 0),
    ...rendered.filter((r) => r.preset.phase === 1),
  ];
  const toolSteps: BuildStep[] = [];
  if (ordered.some((r) => r.preset.downloads)) toolSteps.push(bootstrapStep(osFamily));
  toolSteps.push(...ordered.map((r) => r.step));

  const setupSteps: BuildStep[] = (merged.setup ?? []).map((s, i) => ({
    name: `setup #${i + 1}`,
    script: `set -eu\n${s.run.endsWith('\n') ? s.run : `${s.run}\n`}`,
  }));

  build.push(...osSteps, ...toolSteps, ...langSteps, ...setupSteps);

  // --- user / workspace / resources ---------------------------------------
  const user = {
    name: merged.user?.name ?? TEMPLATE_DEFAULTS.user.name,
    uid: merged.user?.uid ?? TEMPLATE_DEFAULTS.user.uid,
    sudo: merged.user?.sudo ?? TEMPLATE_DEFAULTS.user.sudo,
  };
  const workspace = {
    mode: merged.workspace?.mode ?? TEMPLATE_DEFAULTS.workspace.mode,
    path: merged.workspace?.path ?? TEMPLATE_DEFAULTS.workspace.path,
    access: (merged.workspace?.access ?? TEMPLATE_DEFAULTS.workspace.access) as AccessMode,
    ...(merged.workspace?.ref !== undefined ? { ref: merged.workspace.ref } : {}),
    ...(merged.workspace?.gitignore !== undefined ? { gitignore: merged.workspace.gitignore } : {}),
  };
  const resources = {
    cpus: merged.resources?.cpus ?? TEMPLATE_DEFAULTS.resources.cpus,
    memoryBytes: parseSize(merged.resources?.memory ?? TEMPLATE_DEFAULTS.resources.memory),
    ...(merged.resources?.disk !== undefined
      ? { diskBytes: parseSize(merged.resources.disk) }
      : {}),
    pids: merged.resources?.pids ?? TEMPLATE_DEFAULTS.resources.pids,
    ttlMs: parseDuration(merged.resources?.ttl ?? TEMPLATE_DEFAULTS.resources.ttl),
  };

  // --- network ------------------------------------------------------------
  const netMode = merged.network?.mode ?? TEMPLATE_DEFAULTS.network.mode;
  let allow: string[] = [];
  try {
    allow = expandNetworkPresets(merged.network?.presets ?? []);
  } catch (e) {
    problems.add('network.presets', e instanceof Error ? e.message : String(e));
  }
  allow = unique([...allow, ...(merged.network?.allow ?? []).map((d) => d.toLowerCase())]).sort();
  if (netMode !== 'allowlist' && allow.length > 0) {
    problems.add(
      'network.mode',
      `network.allow/presets are only used with mode "allowlist", but the effective mode is "${netMode}"${merged.network?.mode === undefined ? ' (the default)' : ''}; set mode: allowlist or remove the entries`,
    );
  }

  // --- mounts -------------------------------------------------------------
  const mounts = (merged.mounts ?? []).map((m) => ({
    source: m.source,
    target: m.target,
    access: (m.access ?? TEMPLATE_DEFAULTS.mountAccess) as AccessMode,
  }));
  const targets = new Set<string>();
  for (const [i, m] of mounts.entries()) {
    if (targets.has(m.target))
      problems.add(`mounts[${i}].target`, `mount target "${m.target}" is used more than once`);
    targets.add(m.target);
  }

  // --- secrets ------------------------------------------------------------
  const secrets = (merged.secrets ?? []).map((s) => ({
    ref: s.ref,
    inject: (s.inject ?? TEMPLATE_DEFAULTS.secretInject) as SecretInjection,
    hosts: unique((s.hosts ?? []).map((h) => h.toLowerCase())),
    ...(s.path !== undefined ? { path: s.path } : {}),
  }));
  const refs = new Set<string>();
  for (const [i, s] of secrets.entries()) {
    if (refs.has(s.ref))
      problems.add(`secrets[${i}].ref`, `secret "${s.ref}" is listed more than once`);
    refs.add(s.ref);
    if (s.inject === 'proxy' && s.hosts.length === 0) {
      problems.add(
        `secrets[${i}].hosts`,
        `secret "${s.ref}" is injected by the proxy (the default) and needs hosts: [<destination>]`,
      );
    }
    if (s.inject === 'file' && !s.path)
      problems.add(`secrets[${i}].path`, `secret "${s.ref}" uses inject: file and needs a path`);
    if (s.inject !== 'file' && s.path)
      problems.add(
        `secrets[${i}].path`,
        `path only applies to inject: file (secret "${s.ref}" uses ${s.inject})`,
      );
  }

  // --- caches -------------------------------------------------------------
  const caches = resolveCaches(
    merged.caches ?? [],
    backend,
    user.name,
    workspace.path,
    mounts.map((m) => m.target),
    secrets.flatMap((x) => (x.path ? [x.path] : [])),
    problems,
  );

  // --- python / vm --------------------------------------------------------
  let python: ResolvedTemplate['python'];
  if (backend === 'python') {
    const fromBase = /^python:(\d+\.\d+)/.exec(base.os ?? '')?.[1];
    const fromTool = rendered.find((r) => r.tool.name === 'python')?.tool.version;
    const version = merged.python?.version ?? fromBase ?? fromTool;
    if (!version)
      problems.add(
        'python.version',
        'backend "python" needs python.version (or a python:<version> base image)',
      );
    else
      python = {
        version,
        ...(merged.python?.project !== undefined ? { project: merged.python.project } : {}),
      };
  }
  let vm: ResolvedTemplate['vm'];
  if (backend === 'vm') {
    const image = merged.vm?.image ?? base.os;
    if (image) {
      vm = {
        image,
        ...(merged.vm?.cloudInit !== undefined ? { cloudInit: merged.vm.cloudInit } : {}),
        ...(merged.vm?.diskSize !== undefined ? { diskSize: merged.vm.diskSize } : {}),
      };
    }
  }
  problems.throwIfAny();

  // --- env: preset-provided values underneath the template's own ----------
  const presetEnv: Record<string, string> = {};
  for (const r of rendered) Object.assign(presetEnv, r.env);
  const env = { ...presetEnv, ...(merged.env ?? {}) };

  const resolvedBase: ResolvedTemplate['base'] = {
    ...(base.os !== undefined ? { os: base.os } : {}),
    ...(base.dockerfile !== undefined ? { dockerfile: base.dockerfile } : {}),
    osFamily,
  };

  // A Dockerfile is more than its path: its content and the files it can COPY decide what runs.
  const buildContext =
    base.dockerfile !== undefined && opts.buildContext
      ? await opts.buildContext(base.dockerfile, opts.source)
      : undefined;
  const contextDigest = buildContext?.digest;

  const hash = sha256(
    canonicalJson({
      base: resolvedBase,
      build,
      user,
      python,
      vm,
      backend,
      ...(contextDigest ? { buildContext: contextDigest } : {}),
    }),
  );

  // Trust is keyed by `contentHash`. It is the plain hash of the file unless the file pulls in more
  // content: project templates it extends and its Dockerfile context. A change there is a new hash.
  const projectParents = parents.filter(
    (p) => p.source.kind === 'project' && p.contentText !== undefined,
  );
  const contentHash =
    projectParents.length > 0 || contextDigest
      ? sha256(
          canonicalJson({
            file: sha256(opts.contentText),
            ...(projectParents.length > 0
              ? { parents: projectParents.map((p) => sha256(p.contentText ?? '')) }
              : {}),
            ...(contextDigest ? { buildContext: contextDigest } : {}),
          }),
        )
      : sha256(opts.contentText);

  return {
    name: merged.name,
    description: merged.description ?? '',
    backend,
    isolation: merged.isolation ?? defaultIsolation(backend),
    base: resolvedBase,
    build,
    tools: rendered
      .map((r) => r.tool)
      .map((t) => ({
        name: t.name,
        ...(t.version !== undefined ? { version: t.version } : {}),
        check: t.check,
      })),
    user,
    workspace,
    resources,
    network: { mode: netMode, allow: netMode === 'allowlist' ? allow : [] },
    mounts,
    env,
    secrets,
    labels: { ...(merged.labels ?? {}) },
    caches,
    ...(python ? { python } : {}),
    ...(vm ? { vm } : {}),
    source: { kind: opts.source.kind, ...(opts.source.path ? { path: opts.source.path } : {}) },
    ...(buildContext ? { buildContext } : {}),
    hash,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Backends whose sandboxes can mount a cache (the others have no volumes to keep it in). */
const CACHE_BACKENDS: BackendKind[] = ['docker', 'podman', 'python'];

/** True when `a` and `b` are the same path or one is inside the other. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Expands `~/` (the home directory of the template user) and `${path}` in the environment values,
 * normalizes the paths and rejects what cannot work: duplicate names, nested or equal paths, paths
 * that overlap the workspace, a mount or a secret file, and conflicting environment variables.
 */
function resolveCaches(
  declared: NonNullable<TemplateSpec['caches']>,
  backend: BackendKind,
  userName: string,
  workspacePath: string,
  mountTargets: string[],
  secretPaths: string[],
  problems: Problems,
): TemplateCache[] {
  if (declared.length === 0) return [];
  if (!CACHE_BACKENDS.includes(backend)) {
    problems.add(
      'caches',
      `backend "${backend}" has no volumes to keep a package cache in; remove caches (only docker, podman and python can use them)`,
    );
    return [];
  }
  const home = `/home/${userName}`;
  const out: TemplateCache[] = [];
  const names = new Set<string>();
  const envOwner = new Map<string, { value: string; cache: string }>();
  const workspace = posix.normalize(workspacePath);
  for (const [i, c] of declared.entries()) {
    const at = `caches[${i}]`;
    if (names.has(c.name))
      problems.add(`${at}.name`, `cache "${c.name}" is declared more than once`);
    names.add(c.name);
    const expanded = c.path.startsWith('~/') ? posix.join(home, c.path.slice(2)) : c.path;
    const path = posix.normalize(expanded).replace(/(.)\/+$/, '$1');
    if (path === home)
      problems.add(`${at}.path`, `cache path "${c.path}" is the home directory itself`);
    if (path === '/tmp' || path.startsWith('/tmp/'))
      problems.add(
        `${at}.path`,
        `cache path "${c.path}" is inside /tmp, which is a memory filesystem that does not keep anything`,
      );
    if (pathsOverlap(path, workspace))
      problems.add(
        `${at}.path`,
        `cache path "${c.path}" overlaps the workspace ${workspacePath}; a cache must live outside the project`,
      );
    for (const t of mountTargets) {
      if (pathsOverlap(path, posix.normalize(t)))
        problems.add(`${at}.path`, `cache path "${c.path}" overlaps the mount target ${t}`);
    }
    for (const sp of secretPaths) {
      const norm = posix.normalize(sp);
      if (norm === path || norm.startsWith(`${path}/`))
        problems.add(
          `${at}.path`,
          `cache path "${c.path}" contains the secret file ${sp}; a cache must never hold a secret`,
        );
    }
    for (const prev of out) {
      if (pathsOverlap(path, prev.path))
        problems.add(
          `${at}.path`,
          `cache path "${c.path}" overlaps the cache "${prev.name}" (${prev.path}); caches must not be nested`,
        );
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.env ?? {})) {
      const value = v.split('${path}').join(path);
      env[k] = value;
      const other = envOwner.get(k);
      if (other && other.value !== value)
        problems.add(
          `${at}.env.${k}`,
          `environment variable ${k} is set to different values by the caches "${other.cache}" and "${c.name}"`,
        );
      envOwner.set(k, { value, cache: c.name });
    }
    out.push({ name: c.name, path, env });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Package step rendering
// ---------------------------------------------------------------------------

function renderPackageStep(manager: PackageManager, pkgs: string[]): BuildStep {
  const list = pkgs.map(shQuote).join(' ');
  const name = `${manager}: ${pkgs.join(' ')}`;
  const lines: string[] = ['set -eu'];
  switch (manager) {
    case 'apt':
      lines.push(
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update',
        `apt-get install -y --no-install-recommends ${list}`,
        'rm -rf /var/lib/apt/lists/*',
      );
      break;
    case 'apk':
      lines.push(`apk add --no-cache ${list}`);
      break;
    case 'dnf':
      lines.push(
        `dnf install -y --setopt=install_weak_deps=False ${list}`,
        'dnf clean all',
        'rm -rf /var/cache/dnf',
      );
      break;
    case 'pacman':
      lines.push(`pacman -Sy --noconfirm --needed ${list}`, 'rm -rf /var/cache/pacman/pkg/*');
      break;
    case 'pip':
      lines.push(
        'export PIP_BREAK_SYSTEM_PACKAGES=1 PIP_ROOT_USER_ACTION=ignore PIP_NO_CACHE_DIR=1',
        'if command -v pip >/dev/null 2>&1; then PIP=pip; elif command -v python3 >/dev/null 2>&1; then PIP="python3 -m pip"; else echo "pip packages need python (add the python@<version> tool or use a python base image)" >&2; exit 1; fi',
        `$PIP install ${list}`,
      );
      break;
    case 'npm':
      lines.push(
        'command -v npm >/dev/null 2>&1 || { echo "npm packages need node (add the node@<version> tool or use a node base image)" >&2; exit 1; }',
        `npm install -g --no-fund --no-audit ${list}`,
        'npm cache clean --force',
      );
      break;
  }
  return { name, script: `${lines.join('\n')}\n` };
}
