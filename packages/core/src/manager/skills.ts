import { isAbsolute, resolve as resolvePath } from 'node:path';
import { AboxError, isAboxError } from '../errors.js';
import { canonicalizePath, checkHostPath } from '../policy/index.js';
import type { AgentContext, CreateSkill } from '../policy/index.js';
import {
  MAX_SANDBOX_SKILLS,
  SkillCatalog,
  loadSkillDir,
  type ResolvedSkill,
  type SkillSummary,
} from '../skill/index.js';
import { SKILLS_DIR, type ResolvedTemplate, type TemplateSourceKind } from '../types.js';
import type { Internals } from './internals.js';
import { projectDirCandidates, usableProjectDir } from './templates.js';
import type { Caller, SkillDetails, SkillList, SkillListEntry, SkillValidation } from './types.js';

/** Trust records of project skills sit next to those of project templates, under this name prefix. */
const TRUST_NAME_PREFIX = 'skill:';

export function skillCatalogFor(I: Internals, projectDir: string | undefined): SkillCatalog {
  return new SkillCatalog({
    ...(projectDir ? { projectDir } : {}),
    userDir: I.paths.skillsDir,
  });
}

/** The profile lets a request add this skill (the template's own skills need no entry). */
export function skillAllowed(ctx: AgentContext, name: string): boolean {
  return ctx.profile.skills.includes('*') || ctx.profile.skills.includes(name);
}

/** Project skills: only an approved content hash. Others: always. */
export function isSkillTrusted(
  I: Internals,
  s: { source: { kind: TemplateSourceKind }; contentHash: string },
): boolean {
  return s.source.kind !== 'project' || I.state.templateTrust.isTrusted(s.contentHash);
}

/** Records the approval of project skills of an approved request (`template_trust`). */
export function trustSkills(I: Internals, by: string, approvalId: string, skills: unknown): void {
  if (!Array.isArray(skills)) return;
  for (const raw of skills as Array<Record<string, unknown>>) {
    const source = raw['source'] as { kind?: unknown; path?: unknown } | undefined;
    const hash = raw['contentHash'];
    const name = raw['name'];
    if (
      raw['trusted'] !== false ||
      source?.kind !== 'project' ||
      typeof hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(hash) ||
      typeof name !== 'string'
    )
      continue;
    const path = typeof source.path === 'string' ? source.path : name;
    I.state.templateTrust.trust(hash, { path, by, name: `${TRUST_NAME_PREFIX}${name}` });
    I.audit(by, 'skill.trust', {
      decision: 'approved',
      details: { skill: name, contentHash: hash, path, approvalId },
    });
  }
}

function entryOf(I: Internals, ctx: AgentContext, s: SkillSummary): SkillListEntry {
  return {
    name: s.name,
    description: s.description,
    source: s.source,
    ...(s.shadows.length > 0 ? { shadows: s.shadows } : {}),
    trusted: isSkillTrusted(I, s),
    allowed: skillAllowed(ctx, s.name),
    fileCount: s.fileCount,
    totalBytes: s.totalBytes,
    contentHash: s.contentHash,
  };
}

export async function listSkills(
  I: Internals,
  caller: Caller,
  o: { projectDir?: string; workspacePath?: string } = {},
): Promise<SkillList> {
  const ctx = await I.context(caller);
  const dir =
    usableProjectDir(I, ctx, o.projectDir, true) ??
    usableProjectDir(I, ctx, o.workspacePath, true) ??
    usableProjectDir(I, ctx, I.projectDir, false);
  const { skills, problems } = await skillCatalogFor(I, dir).listAll();
  return {
    skills: skills.map((s) => entryOf(I, ctx, s)),
    problems:
      ctx.kind === 'human'
        ? problems.map((p) => ({
            kind: p.kind,
            path: p.path,
            name: p.name,
            message: p.error.message,
            issues: p.error.issues,
          }))
        : [],
  };
}

/** The skill `name` from the first project dir that has it (then the user and builtin skills). */
export async function loadSkill(
  I: Internals,
  name: string,
  dirs: Array<string | undefined>,
): Promise<{ skill: ResolvedSkill; catalog: SkillCatalog }> {
  let lastErr: unknown;
  for (const d of dirs) {
    const catalog = skillCatalogFor(I, d);
    try {
      return { skill: await catalog.get(name), catalog };
    } catch (e) {
      if (isAboxError(e) && e.code === 'not_found') {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  const err = lastErr as AboxError | undefined;
  throw new AboxError('not_found', `skill '${name}' not found`, {
    hint: err?.hint ?? 'List skills with skill_list / `abox skill ls`.',
    details: { name },
  });
}

export async function showSkill(
  I: Internals,
  caller: Caller,
  name: string,
  o: { projectDir?: string; workspacePath?: string } = {},
): Promise<SkillDetails> {
  const ctx = await I.context(caller);
  if (typeof name !== 'string' || name.length === 0 || name.length > 64)
    throw new AboxError('invalid_input', 'skill name required');
  if (o.workspacePath !== undefined) usableProjectDir(I, ctx, o.workspacePath, true);
  const { skill, catalog } = await loadSkill(
    I,
    name,
    projectDirCandidates(I, ctx, o.projectDir, o.workspacePath),
  );
  const shadows = await catalog.getShadowed(skill.name);
  return {
    ...entryOf(I, ctx, {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      shadows,
      fileCount: skill.files.length,
      totalBytes: skill.totalBytes,
      contentHash: skill.contentHash,
    }),
    frontMatter: skill.frontMatter,
    body: skill.body,
    files: skill.files,
    sandboxPath: `${SKILLS_DIR}/${skill.name}`,
  };
}

const PATHLIKE = /[/\\]|^\.\.?$/;

/** `abox skill validate <name|folder>`: every problem of one skill, without throwing for them. */
export async function validateSkillOp(
  I: Internals,
  caller: Caller,
  nameOrPath: string,
  o: { projectDir?: string } = {},
): Promise<SkillValidation> {
  const ctx = await I.context(caller);
  if (typeof nameOrPath !== 'string' || nameOrPath.length === 0 || nameOrPath.length > 4096)
    throw new AboxError('invalid_input', 'a skill name or folder is required');
  let skill: ResolvedSkill;
  try {
    if (PATHLIKE.test(nameOrPath)) {
      const base = I.projectDir ?? process.cwd();
      let p = isAbsolute(nameOrPath) ? nameOrPath : resolvePath(base, nameOrPath);
      // `.../SKILL.md` means its folder
      if (/[/\\]SKILL\.md$/.test(p)) p = p.slice(0, -'/SKILL.md'.length);
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
            `skill folder ${p} is not readable for this context: ${res.reason}`,
          );
      }
      const userDir = canonicalizePath(I.paths.skillsDir, { home: I.home, cwd: I.home });
      skill = await loadSkillDir(p, p.startsWith(`${userDir}/`) ? 'user' : 'project');
    } else {
      skill = (
        await loadSkill(I, nameOrPath, projectDirCandidates(I, ctx, o.projectDir, undefined))
      ).skill;
    }
  } catch (e) {
    if (!isAboxError(e) || e.code !== 'skill_invalid') throw e;
    const path = typeof e.details?.['path'] === 'string' ? e.details['path'] : undefined;
    return {
      ok: false,
      ...(path ? { path } : {}),
      issues: e.issues.length > 0 ? e.issues : [{ message: e.message }],
      warnings: [],
    };
  }
  const warnings: string[] = [];
  if (skill.description.trim().length < 20)
    warnings.push(
      'description is shorter than 20 characters: say what the skill does and when to use it',
    );
  return {
    ok: true,
    name: skill.name,
    path: skill.source.path,
    source: skill.source,
    issues: [],
    warnings,
    contentHash: skill.contentHash,
    fileCount: skill.files.length,
    totalBytes: skill.totalBytes,
  };
}

/**
 * The skills a create gives the sandbox: the template's (in its order), then the requested ones that
 * are not already there. Looked up like the template (the project dirs first). A missing or broken
 * skill fails the create; so does a template skill name that no catalog has.
 */
export async function resolveCreateSkills(
  I: Internals,
  template: Pick<ResolvedTemplate, 'name' | 'skills'>,
  requested: readonly string[],
  dirs: Array<string | undefined>,
): Promise<{ skills: ResolvedSkill[]; policy: CreateSkill[] }> {
  const fromTemplate = template.skills ?? [];
  const names = [...fromTemplate, ...requested.filter((n) => !fromTemplate.includes(n))];
  const unique = [...new Set(names)];
  if (unique.length > MAX_SANDBOX_SKILLS)
    throw new AboxError(
      'invalid_input',
      `a sandbox can get at most ${MAX_SANDBOX_SKILLS} skills (template ${template.name} and the request ask for ${unique.length})`,
    );
  const skills: ResolvedSkill[] = [];
  const policy: CreateSkill[] = [];
  for (const name of unique) {
    let skill: ResolvedSkill;
    try {
      skill = (await loadSkill(I, name, dirs)).skill;
    } catch (e) {
      if (isAboxError(e) && e.code === 'not_found' && fromTemplate.includes(name))
        throw new AboxError(
          'not_found',
          `template '${template.name}' lists skill '${name}', which does not exist`,
          { hint: e.hint ?? 'List skills with `abox skill ls`.', details: { name } },
        );
      throw e;
    }
    skills.push(skill);
    policy.push({
      name: skill.name,
      source: { kind: skill.source.kind, path: skill.source.path },
      contentHash: skill.contentHash,
      trusted: isSkillTrusted(I, skill),
      requested: !fromTemplate.includes(name),
    });
  }
  return { skills, policy };
}
