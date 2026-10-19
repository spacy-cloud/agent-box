import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { AboxError, isAboxError } from '../errors.js';
import type { ErrorIssue } from '../errors.js';
import type { SandboxProvider } from '../provider.js';
import { canonicalizePath, checkHostPath, evaluateCreate } from '../policy/index.js';
import type { AgentContext } from '../policy/index.js';
import {
  MAX_TEMPLATE_BYTES,
  TemplateCatalog,
  annotateIssuePositions,
  safeParseTemplateYaml,
  templateInvalidError,
  validateTemplate as validateResolvedTemplate,
} from '../template/index.js';
import type { TemplateIssue } from '../template/index.js';
import { renderTemplateSnapshot, templateRisks, unifiedDiff } from '../template/index.js';
import type {
  BackendKind,
  ProviderCapabilities,
  ResolvedTemplate,
  TemplateSourceKind,
} from '../types.js';
import { redactLogLine } from '../state/redact.js';
import type { Internals } from './internals.js';
import type {
  BuildResult,
  BuildTemplateOptions,
  Caller,
  EffectiveLimits,
  GcImagesResult,
  TemplateDetails,
  TemplateList,
  TemplateListEntry,
  TemplateReview,
  TemplateValidation,
  TemplateValidationIssue,
} from './types.js';
import { errMessage } from './util.js';

export function templateAllowed(ctx: AgentContext, name: string): boolean {
  return ctx.profile.templates.includes('*') || ctx.profile.templates.includes(name);
}

export function isTrusted(
  I: Internals,
  t: Pick<ResolvedTemplate, 'source' | 'contentHash'>,
): boolean {
  return t.source.kind !== 'project' || I.state.templateTrust.isTrusted(t.contentHash);
}

/**
 * Project directory a caller may use. Humans: anything. Agents: only below their workspace roots
 * (and never abox's own directories), so an agent cannot make abox read templates from elsewhere.
 */
export function usableProjectDir(
  I: Internals,
  ctx: AgentContext,
  dir: string | undefined,
  explicit: boolean,
): string | undefined {
  if (!dir) return undefined;
  let canonical: string;
  try {
    canonical = canonicalizePath(dir, { home: I.home, cwd: I.projectDir ?? I.home });
  } catch (e) {
    if (explicit) throw e;
    return undefined;
  }
  if (ctx.kind === 'human') return canonical;
  const res = checkHostPath(canonical, {
    home: I.home,
    roots: ctx.workspaceRoots,
    kind: 'workspace',
    extraForbidden: I.forbiddenTrees(),
    denyHiddenHomeDirs: true,
  });
  if (res.ok) return canonical;
  if (explicit) {
    throw new AboxError(
      'policy_denied',
      `project directory ${canonical} is not allowed: ${res.reason}`,
      {
        ...(res.hint ? { hint: res.hint } : {}),
      },
    );
  }
  return undefined;
}

export function catalogFor(I: Internals, projectDir: string | undefined): TemplateCatalog {
  return new TemplateCatalog({
    ...(projectDir ? { projectDir } : {}),
    userDir: I.paths.templatesDir,
  });
}

/** Project dirs to search for a create/show: explicit, workspace path, the instance's project dir. */
export function projectDirCandidates(
  I: Internals,
  ctx: AgentContext,
  explicit: string | undefined,
  workspacePath: string | undefined,
): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  const add = (d: string | undefined, isExplicit: boolean): void => {
    const u = usableProjectDir(I, ctx, d, isExplicit);
    if (u && !out.includes(u)) out.push(u);
  };
  add(explicit, true);
  add(workspacePath, false);
  add(I.projectDir, false);
  if (out.length === 0) out.push(undefined);
  return out;
}

export async function loadTemplate(
  I: Internals,
  ctx: AgentContext,
  name: string,
  dirs: Array<string | undefined>,
): Promise<{ template: ResolvedTemplate; catalog: TemplateCatalog }> {
  let lastErr: unknown;
  for (const d of dirs) {
    const catalog = catalogFor(I, d);
    try {
      return { template: await catalog.get(name), catalog };
    } catch (e) {
      if (isAboxError(e) && e.code === 'not_found') {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  const err = lastErr as AboxError | undefined;
  throw new AboxError('not_found', `template '${name}' not found`, {
    hint: err?.hint ?? 'List templates with template_list / `abox template ls`.',
  });
}

/**
 * Capability and security checks of a resolved template against one provider. The process backend
 * runs as the abox user and cannot switch users: its `nonRootUser` gap is only an error when abox itself runs as root.
 */
export function checkTemplateForProvider(
  template: ResolvedTemplate,
  provider: SandboxProvider,
): { issues: TemplateIssue[]; warnings: string[] } {
  const caps = provider.capabilities();
  const r = validateResolvedTemplate(template, { capabilities: caps });
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const issues = r.issues.filter(
    (i) =>
      !(
        i.kind === 'unsupported' &&
        i.path === 'user' &&
        caps.isolation === 'none' &&
        !runningAsRoot
      ),
  );
  return { issues, warnings: r.warnings };
}

export function throwForIssues(template: ResolvedTemplate, issues: TemplateIssue[]): void {
  if (issues.length === 0) return;
  const strip = (i: TemplateIssue): ErrorIssue => {
    const { kind: _k, ...rest } = i;
    return rest;
  };
  if (issues.some((i) => i.kind === 'invalid')) {
    throw templateInvalidError(issues.map(strip), template.source.path);
  }
  const first = issues[0]!;
  throw new AboxError(
    'unsupported',
    `template '${template.name}' cannot run on backend '${template.backend}': ${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`,
    {
      issues: issues.map(strip),
      hint: 'Pick a different template or backend (template_list, `abox doctor`).',
    },
  );
}

function effectiveLimits(ctx: AgentContext, t: ResolvedTemplate): EffectiveLimits {
  const p = ctx.profile.limits;
  const exceeds: string[] = [];
  if (t.resources.cpus > p.cpus) exceeds.push(`cpus ${t.resources.cpus} > ${p.cpus}`);
  if (t.resources.memoryBytes > p.memoryBytes) exceeds.push(`memory > ${p.memory}`);
  if (t.resources.ttlMs > p.ttlMs) exceeds.push(`ttl > ${p.ttl}`);
  return {
    cpus: Math.min(t.resources.cpus, p.cpus),
    memoryBytes: Math.min(t.resources.memoryBytes, p.memoryBytes),
    ttlMs: Math.min(t.resources.ttlMs, p.ttlMs),
    pids: t.resources.pids,
    exceedsProfile: exceeds,
    profile: ctx.profile.name,
    sandboxes: p.sandboxes,
  };
}

// ---------------------------------------------------------------------------

/**
 * Whether sandboxes can be created from `t` here, and if not, why: the backend must be usable and
 * the template must pass the same validation (security rules, backend capabilities) as a create.
 */
export async function templateReadiness(
  I: Internals,
  t: ResolvedTemplate,
): Promise<{ ready: boolean; reason?: string }> {
  if (!I.providerFactories[t.backend])
    return { ready: false, reason: `backend ${t.backend} is not available in this abox instance` };
  let provider: SandboxProvider | undefined;
  let unusable: string | undefined;
  try {
    provider = I.providerFor(await I.resolveHost('local'), t.backend);
  } catch (e) {
    unusable = `backend ${t.backend} is not usable: ${errMessage(e)}`;
  }
  const issues = provider
    ? checkTemplateForProvider(t, provider).issues
    : validateResolvedTemplate(t, {}).issues;
  if (issues.length > 0) {
    const first = issues[0]!;
    return {
      ready: false,
      reason: `${first.path ? `${first.path}: ` : ''}${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more; abox template validate ${t.name})` : ''}`,
    };
  }
  return unusable ? { ready: false, reason: unusable } : { ready: true };
}

export async function listTemplates(
  I: Internals,
  caller: Caller,
  o: { projectDir?: string; workspacePath?: string } = {},
): Promise<TemplateList> {
  const ctx = await I.context(caller);
  const dir =
    usableProjectDir(I, ctx, o.projectDir, true) ??
    usableProjectDir(I, ctx, o.workspacePath, true) ??
    usableProjectDir(I, ctx, I.projectDir, false);
  const catalog = catalogFor(I, dir);
  const { templates, problems } = await catalog.listAll();
  const entries: TemplateListEntry[] = [];
  for (const s of templates) {
    let contentHash = '';
    let hash = '';
    let trusted = s.source.kind !== 'project';
    let readiness: { ready: boolean; reason?: string };
    try {
      const t = await catalog.get(s.name);
      contentHash = t.contentHash;
      hash = t.hash;
      if (s.source.kind === 'project') trusted = I.state.templateTrust.isTrusted(t.contentHash);
      readiness = await templateReadiness(I, t);
    } catch (e) {
      // listed above, so only a file that changed meanwhile or a missing Dockerfile gets here
      readiness = { ready: false, reason: errMessage(e) };
      if (s.source.kind === 'project') trusted = false;
    }
    entries.push({
      name: s.name,
      description: s.description,
      ...(s.useFor ? { useFor: s.useFor } : {}),
      backend: s.backend,
      isolation: s.isolation,
      networkMode: s.networkMode,
      source: s.source,
      ...(s.shadows.length > 0 ? { shadows: s.shadows } : {}),
      trusted,
      allowed: templateAllowed(ctx, s.name),
      backendAvailable: I.providerFactories[s.backend] !== undefined,
      ready: readiness.ready,
      ...(readiness.reason ? { notReadyReason: readiness.reason } : {}),
      contentHash,
      hash,
    });
  }
  return {
    templates: entries,
    problems:
      ctx.kind === 'human'
        ? problems.map((p) => ({
            kind: p.kind,
            path: p.path,
            message: p.error.message,
            issues: p.error.issues,
          }))
        : [],
  };
}

export async function showTemplate(
  I: Internals,
  caller: Caller,
  name: string,
  o: { projectDir?: string; workspacePath?: string } = {},
): Promise<TemplateDetails> {
  const ctx = await I.context(caller);
  if (typeof name !== 'string' || name.length === 0 || name.length > 64)
    throw new AboxError('invalid_input', 'template name required');
  // A workspace path the caller names is checked like the one of a create (a denied path is an error here).
  if (o.workspacePath !== undefined) usableProjectDir(I, ctx, o.workspacePath, true);
  const { template, catalog } = await loadTemplate(
    I,
    ctx,
    name,
    projectDirCandidates(I, ctx, o.projectDir, o.workspacePath),
  );
  let capabilities: ProviderCapabilities | undefined;
  const { hidden: shadows } = await catalog.getShadowed(template.name);
  const warnings: string[] = shadows.length > 0 ? [shadowWarning(template, shadows)] : [];
  if (I.providerFactories[template.backend]) {
    try {
      const host = await I.resolveHost('local');
      const provider = I.providerFor(host, template.backend);
      capabilities = provider.capabilities();
      warnings.push(...checkTemplateForProvider(template, provider).warnings);
    } catch (e) {
      warnings.push(`backend ${template.backend} is not usable: ${errMessage(e)}`);
    }
  } else {
    warnings.push(`backend ${template.backend} is not available in this abox instance`);
  }
  return {
    template,
    ...(shadows.length > 0 ? { shadows } : {}),
    trusted: isTrusted(I, template),
    allowed: templateAllowed(ctx, template.name),
    backendAvailable: I.providerFactories[template.backend] !== undefined,
    ...(capabilities ? { capabilities } : {}),
    effectiveLimits: effectiveLimits(ctx, template),
    warnings,
  };
}

/**
 * Canonical text of the project template at `path` for the trust record, provided the file still
 * has exactly the approved content (`contentHash`). Best effort: undefined when it cannot be read.
 */
export async function trustSnapshot(
  I: Internals,
  path: string | undefined,
  contentHash: string,
): Promise<string | undefined> {
  if (!path || basename(dirname(path)) !== '.sandbox') return undefined;
  try {
    const t = await catalogFor(I, dirname(dirname(path))).loadFile(path, 'project');
    return t.contentHash === contentHash ? renderTemplateSnapshot(t) : undefined;
  } catch {
    return undefined;
  }
}

const KIND_WORD: Record<TemplateSourceKind, string> = {
  project: 'project',
  user: 'user',
  builtin: 'built-in',
};

/** "shadows built-in template alpine-min": what a template of the same name in a higher-precedence place does. */
function shadowPhrase(name: string, hidden: Array<{ kind: TemplateSourceKind }>): string {
  const kinds = [...new Set(hidden.map((h) => KIND_WORD[h.kind]))].join(' and ');
  return `shadows the ${kinds} template ${name}`;
}

function shadowWarning(
  template: Pick<ResolvedTemplate, 'name' | 'source'>,
  hidden: Array<{ kind: TemplateSourceKind }>,
): string {
  return `this ${template.source.kind} template ${shadowPhrase(template.name, hidden)} of the same name: a sandbox created from "${template.name}" uses this version, not the ${hidden[0] ? KIND_WORD[hidden[0].kind] : ''} one`;
}

/**
 * Review material for a template that is about to be trusted. Compared against (first match): the
 * last trusted version of the same template (what changed since the approval), the template it
 * `extends` (what it adds to a known template), the user or builtin template of the same name it
 * shadows (a project `alpine-min.yaml` is compared with the built-in `alpine-min`), else nothing
 * (the full content).
 */
export async function reviewTemplate(
  I: Internals,
  caller: Caller,
  name: string,
  o: { projectDir?: string; workspacePath?: string; expectedContentHash?: string } = {},
): Promise<TemplateReview> {
  const ctx = await I.context(caller);
  if (typeof name !== 'string' || name.length === 0 || name.length > 64)
    throw new AboxError('invalid_input', 'template name required');
  const { template, catalog } = await loadTemplate(
    I,
    ctx,
    name,
    projectDirCandidates(I, ctx, o.projectDir, o.workspacePath),
  );
  const text = renderTemplateSnapshot(template);
  const shadowed = await catalog.getShadowed(template.name);
  const toLabel = `${template.source.kind} template ${template.name}${template.source.path ? ` (${template.source.path})` : ''}`;

  let against: TemplateReview['against'] = { kind: 'none', label: 'nothing (new content)' };
  let baseline = '';
  let fromLabel = '/dev/null';
  const previous =
    template.source.kind === 'project'
      ? I.state.templateTrust.previousVersion({
          name: template.name,
          ...(template.source.path ? { path: template.source.path } : {}),
          exceptHash: template.contentHash,
        })
      : undefined;
  if (previous) {
    baseline = previous.snapshot;
    against = {
      kind: 'previous',
      template: template.name,
      label: `the version of ${template.name} trusted on ${new Date(previous.trustedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC by ${previous.trustedBy}`,
    };
    fromLabel = `trusted version of ${template.name} (${previous.contentHash.slice(0, 12)})`;
  } else {
    const parent = await catalog.getParent(template.name).catch(() => undefined);
    if (parent) {
      baseline = renderTemplateSnapshot(parent);
      against = {
        kind: 'extends',
        template: parent.name,
        label: `${parent.source.kind} template ${parent.name}, which it extends`,
      };
      fromLabel = `${parent.source.kind} template ${parent.name}`;
    } else if (shadowed.template && shadowed.source) {
      baseline = renderTemplateSnapshot(shadowed.template);
      against = {
        kind: 'shadows',
        template: shadowed.template.name,
        label: `${shadowed.source.kind} template ${shadowed.template.name}, which it shadows (same name)`,
      };
      fromLabel = `${shadowed.source.kind} template ${shadowed.template.name}`;
    }
  }
  return {
    template: template.name,
    source: template.source,
    ...(shadowed.hidden.length > 0 ? { shadows: shadowed.hidden } : {}),
    contentHash: template.contentHash,
    trusted: isTrusted(I, template),
    against,
    diff: unifiedDiff(baseline, text, { fromLabel, toLabel, context: 4 }),
    risks: [
      ...(shadowed.hidden.length > 0
        ? [
            `${shadowPhrase(template.name, shadowed.hidden)}: sandboxes created from "${template.name}" in this project get this version instead`,
          ]
        : []),
      ...templateRisks(template),
    ],
    ...(template.buildContext ? { buildContext: template.buildContext } : {}),
    ...(o.expectedContentHash !== undefined && o.expectedContentHash !== template.contentHash
      ? { changedSinceRequest: true }
      : {}),
  };
}

const PATHLIKE = /[/\\]|\.ya?ml$/i;

export async function validateTemplateOp(
  I: Internals,
  caller: Caller,
  nameOrPath: string,
  o: { projectDir?: string } = {},
): Promise<TemplateValidation> {
  const ctx = await I.context(caller);
  if (typeof nameOrPath !== 'string' || nameOrPath.length === 0 || nameOrPath.length > 4096) {
    throw new AboxError('invalid_input', 'a template name or file path is required');
  }
  const issues: TemplateValidationIssue[] = [];
  const out: TemplateValidation = { ok: false, issues, warnings: [] };
  let text: string | undefined;
  let template: ResolvedTemplate | undefined;
  let catalog: TemplateCatalog;
  let filePath: string | undefined;

  try {
    if (PATHLIKE.test(nameOrPath)) {
      const base = I.projectDir ?? process.cwd();
      let p = isAbsolute(nameOrPath) ? nameOrPath : resolvePath(base, nameOrPath);
      p = canonicalizePath(p, { home: I.home, cwd: base });
      if (ctx.kind === 'agent') {
        const res = checkHostPath(p, {
          home: I.home,
          roots: ctx.workspaceRoots,
          kind: 'workspace',
          extraForbidden: I.forbiddenTrees(),
          denyHiddenHomeDirs: true,
        });
        if (!res.ok)
          throw new AboxError(
            'policy_denied',
            `template file ${p} is not readable for this context: ${res.reason}`,
          );
      }
      const st = await stat(p).catch(() => undefined);
      if (!st?.isFile()) throw new AboxError('not_found', `template file not found: ${p}`);
      if (st.size > MAX_TEMPLATE_BYTES)
        throw new AboxError(
          'template_invalid',
          `template file is larger than ${MAX_TEMPLATE_BYTES} bytes`,
        );
      text = await readFile(p, 'utf8');
      filePath = p;
      const parsed = safeParseTemplateYaml(text);
      if (!parsed.ok) {
        for (const i of parsed.issues) issues.push({ ...i, kind: 'schema' });
        return out;
      }
      const dir =
        usableProjectDir(I, ctx, o.projectDir, true) ??
        usableProjectDir(I, ctx, I.projectDir, false);
      catalog = catalogFor(I, dir);
      const inUserDir = p.startsWith(
        `${canonicalizePath(I.paths.templatesDir, { home: I.home, cwd: I.home })}/`,
      );
      template = await catalog.loadFile(p, inUserDir ? 'user' : 'project');
    } else {
      const loaded = await loadTemplate(
        I,
        ctx,
        nameOrPath,
        projectDirCandidates(I, ctx, o.projectDir, undefined),
      );
      template = loaded.template;
      catalog = loaded.catalog;
      if (template.source.path) {
        filePath = template.source.path;
        text = await readFile(template.source.path, 'utf8').catch(() => undefined);
      }
    }
  } catch (e) {
    if (!isAboxError(e)) throw e;
    if (e.code === 'policy_denied' || e.code === 'not_found') throw e;
    const list = e.issues.length > 0 ? e.issues : [{ message: e.message }];
    for (const i of list)
      issues.push({ ...i, kind: e.code === 'template_invalid' ? 'schema' : 'invalid' });
    return out;
  }

  out.name = template.name;
  out.source = template.source;
  const collected: TemplateValidationIssue[] = [];
  const warnings: string[] = [];

  // backend capabilities + security rules
  let provider: SandboxProvider | undefined;
  let caps: ProviderCapabilities | undefined;
  let host: Awaited<ReturnType<Internals['resolveHost']>> | undefined;
  try {
    host = await I.resolveHost('local');
    provider = I.providerFor(host, template.backend);
    caps = provider.capabilities();
  } catch (e) {
    warnings.push(
      `backend '${template.backend}' is not available here, so capabilities were not checked: ${errMessage(e)}`,
    );
  }
  if (provider) {
    const r = checkTemplateForProvider(template, provider);
    for (const i of r.issues) collected.push({ path: i.path, message: i.message, kind: i.kind });
    warnings.push(...r.warnings);
  } else {
    const r = validateResolvedTemplate(template, {});
    for (const i of r.issues) collected.push({ path: i.path, message: i.message, kind: i.kind });
    warnings.push(...r.warnings);
  }

  // policy dry run with the template's own defaults
  try {
    const hostRes = host ?? (await I.resolveHost('local'));
    const base = I.projectDir ?? I.home;
    const mounts = template.mounts.map((m) => ({
      hostPath: canonicalizePath(m.source, { home: I.home, cwd: base }),
      target: m.target,
      access: m.access,
    }));
    const ev = evaluateCreate({
      context: ctx,
      template,
      templateTrusted: isTrusted(I, template),
      templateSource: template.source,
      host: I.hostInfo(hostRes, caps?.remote ?? false),
      providerIsolation: caps?.isolation ?? template.isolation,
      workspace: { mode: 'empty' },
      mounts,
      network: { mode: template.network.mode, allow: template.network.allow },
      secrets: template.secrets.map((s) => ({ ref: s.ref, inject: s.inject })),
      resources: { cpus: template.resources.cpus, memoryBytes: template.resources.memoryBytes },
      ttlMs: template.resources.ttlMs,
      currentSandboxCount: 0,
      currentHostSandboxCount: 0,
      paths: { home: I.home, extraForbidden: I.forbiddenTrees() },
    });
    if (ev.decision === 'deny') {
      out.policy = { decision: 'deny', reasons: ev.reasons, ...(ev.hint ? { hint: ev.hint } : {}) };
      for (const r of ev.reasons) collected.push({ message: r, kind: 'policy' });
    } else if (ev.decision === 'approval') {
      out.policy = { decision: 'approval', reasons: ev.reasons };
      warnings.push(...ev.reasons.map((r) => `would need approval: ${r}`));
    } else {
      out.policy = { decision: 'allow', reasons: [] };
    }
  } catch (e) {
    warnings.push(`policy check skipped: ${errMessage(e)}`);
  }

  // positions: map dotted paths back to the file
  const annotated = text
    ? annotateIssuePositions(
        text,
        collected.map(({ kind: _k, ...i }) => i),
      )
    : collected;
  collected.forEach((c, idx) => {
    const a = annotated[idx];
    issues.push({
      ...c,
      ...(a?.line !== undefined ? { line: a.line } : {}),
      ...(a?.column !== undefined ? { column: a.column } : {}),
    });
  });
  out.warnings = warnings;
  out.ok = issues.length === 0;
  void filePath;
  return out;
}

// ---------------------------------------------------------------------------

export async function buildTemplate(
  I: Internals,
  caller: Caller,
  name: string,
  o: BuildTemplateOptions = {},
): Promise<BuildResult> {
  const ctx = await I.context(caller);
  I.requirePolicyValid(ctx, 'template.build', 'building images');
  if (typeof name !== 'string' || name.length === 0 || name.length > 64)
    throw new AboxError('invalid_input', 'template name required');
  const { template } = await loadTemplate(
    I,
    ctx,
    name,
    projectDirCandidates(I, ctx, o.projectDir, undefined),
  );
  if (!templateAllowed(ctx, template.name)) {
    I.audit(ctx.owner, 'image.build', {
      decision: 'deny',
      details: { template: template.name, reason: 'template not allowed' },
    });
    throw new AboxError(
      'policy_denied',
      `template '${template.name}' is not allowed for profile '${ctx.profile.name}'`,
      {
        hint: `Allowed templates: ${ctx.profile.templates.join(', ') || 'none'}.`,
      },
    );
  }
  if (!isTrusted(I, template) && !(ctx.kind === 'human' && caller.humanConfirmed === true)) {
    I.audit(ctx.owner, 'image.build', {
      decision: 'deny',
      details: {
        template: template.name,
        contentHash: template.contentHash,
        reason: 'untrusted project template',
      },
    });
    throw new AboxError(
      'untrusted_template',
      `template '${template.name}' comes from a project and its content has not been approved`,
      {
        hint:
          ctx.kind === 'human'
            ? 'Review it, then repeat with humanConfirmed (--yes), or approve it through a create request.'
            : 'Ask the human to approve the template (it is queued as an approval when you create a sandbox from it).',
      },
    );
  }
  const host = await I.resolveHost('local');
  const provider = I.providerFor(host, template.backend);
  throwForIssues(template, checkTemplateForProvider(template, provider).issues);

  const pin = o.update ? undefined : I.state.templatePins.get(template.hash);
  const started = Date.now();
  // The build output is the template author's text (it echoes `ENV` lines and whatever the steps print):
  // credentials in it are masked before any caller (CLI, GUI) sees a line, and in the error as well.
  const mask = (text: string): string => redactLogLine(text);
  const onProgress = o.onProgress;
  I.audit(ctx.owner, 'image.build_start', {
    decision: 'info',
    details: {
      template: template.name,
      templateHash: template.hash,
      backend: template.backend,
      update: o.update === true,
      networkAccess: true,
      note: 'image build runs with network access, independent of the sandbox network policy',
    },
  });
  try {
    const image = await provider.prepare(template, {
      ...(o.update ? { update: true } : {}),
      ...(pin?.pinnedBase ? { pinnedBase: pin.pinnedBase } : {}),
      ...(onProgress ? { onProgress: (line: string) => onProgress(mask(line)) } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (image.pinnedBase || !pin) {
      I.state.templatePins.put({
        templateHash: template.hash,
        template: template.name,
        backend: template.backend,
        pinnedBase: image.pinnedBase ?? pin?.pinnedBase ?? null,
        imageRef: image.ref,
      });
    }
    const durationMs = Date.now() - started;
    I.audit(ctx.owner, 'image.build', {
      decision: 'allow',
      details: {
        template: template.name,
        templateHash: template.hash,
        backend: template.backend,
        cached: image.cached,
        durationMs,
        pinnedBase: image.pinnedBase,
        imageRef: image.ref,
      },
    });
    return {
      template: template.name,
      templateHash: template.hash,
      backend: template.backend,
      image,
      cached: image.cached,
      durationMs,
      ...(image.pinnedBase ? { pinnedBase: image.pinnedBase } : {}),
    };
  } catch (e) {
    I.audit(ctx.owner, 'image.build', {
      decision: 'error',
      details: {
        template: template.name,
        templateHash: template.hash,
        message: mask(errMessage(e)),
      },
    });
    throw maskBuildError(e, mask);
  }
}

/** The same error with credentials removed from its message and from the tail of the build log it carries. */
function maskBuildError(e: unknown, mask: (text: string) => string): unknown {
  if (!isAboxError(e)) return e;
  const log = e.details?.['log'];
  if (mask(e.message) === e.message && (typeof log !== 'string' || mask(log) === log)) return e;
  return new AboxError(e.code, mask(e.message), {
    ...(e.hint ? { hint: e.hint } : {}),
    ...(e.issues.length > 0 ? { issues: e.issues } : {}),
    ...(e.details
      ? { details: { ...e.details, ...(typeof log === 'string' ? { log: mask(log) } : {}) } }
      : {}),
  });
}

export async function gcImages(
  I: Internals,
  caller: Caller,
  o: { projectDir?: string } = {},
): Promise<GcImagesResult> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'image.gc');
  return gcImagesInternal(I, ctx.owner, o.projectDir);
}

/** Keep images of every template in the catalog and of every sandbox that still exists. */
export async function gcImagesInternal(
  I: Internals,
  actor: string,
  projectDir?: string,
): Promise<GcImagesResult> {
  const catalog = catalogFor(I, projectDir ?? I.projectDir);
  const keepByBackend = new Map<BackendKind, Set<string>>();
  const keepAll = new Set<string>();
  const { templates } = await catalog.listAll();
  for (const s of templates) {
    try {
      const t = await catalog.get(s.name);
      keepAll.add(t.hash);
    } catch {
      /* unreadable template: its image is not kept by this entry */
    }
  }
  for (const r of I.state.sandboxes.list({
    state: ['preparing', 'created', 'running', 'stopped', 'expired'],
  }))
    keepAll.add(r.templateHash);
  const removed: GcImagesResult['removed'] = [];
  const host = await I.resolveHost('local');
  for (const backend of host.backends) {
    if (!I.providerFactories[backend]) continue;
    try {
      const provider = I.providerFor(host, backend);
      keepByBackend.set(backend, keepAll);
      const refs = await provider.gcImages([...keepAll]);
      if (refs.length > 0) removed.push({ backend, host: host.connection.host, refs });
    } catch (e) {
      I.audit(actor, 'image.gc', {
        decision: 'error',
        details: { backend, message: errMessage(e) },
      });
    }
  }
  for (const pin of I.state.templatePins.list())
    if (!keepAll.has(pin.templateHash)) I.state.templatePins.delete(pin.templateHash);
  I.audit(actor, 'image.gc', {
    decision: 'allow',
    details: { removed: removed.flatMap((r) => r.refs), kept: keepAll.size },
  });
  return { removed, kept: [...keepAll] };
}
