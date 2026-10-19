import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AboxError } from '../errors.js';
import { canonicalizePath, checkHostPath } from '../policy/index.js';
import {
  builtinTemplatesDir,
  freeTemplateName,
  otherSpellingExists,
  projectTemplateDraft,
  projectTemplatePath,
  readTemplateFile,
  safeParseTemplateYaml,
  templateNameFromFolder,
  userTemplatePath,
  writeTemplateFile,
} from '../template/index.js';
import type { AgentContext } from '../policy/index.js';
import type { Internals } from './internals.js';
import { templateDraftSchema, templateSaveSchema } from './schemas.js';
import { suggestTemplate } from './suggest.js';
import { catalogFor, isTrusted } from './templates.js';
import type {
  Caller,
  TemplateDraft,
  TemplateDraftInput,
  TemplateSaveInput,
  TemplateSavePlan,
  TemplateSaveResult,
} from './types.js';
import { errMessage, parseInput } from './util.js';

/**
 * The project folder a template is written into, checked like a workspace (canonical path, an existing
 * directory, not one of abox's own trees). Symbolic links are resolved by `canonicalizePath`; `.sandbox`
 * itself must be a real directory (the writer refuses a link).
 */
async function projectFolder(I: Internals, ctx: AgentContext, dir: string): Promise<string> {
  const path = canonicalizePath(dir, { home: I.home, cwd: I.projectDir ?? process.cwd() });
  const check = checkHostPath(path, {
    home: I.home,
    roots: ctx.workspaceRoots,
    kind: 'workspace',
    extraForbidden: I.forbiddenTrees(),
  });
  if (!check.ok) throw new AboxError('policy_denied', check.reason, { hint: check.hint });
  let isDir: boolean;
  try {
    isDir = (await stat(path)).isDirectory();
  } catch (e) {
    throw new AboxError('invalid_input', `project folder ${path} cannot be read: ${errMessage(e)}`);
  }
  if (!isDir) throw new AboxError('invalid_input', `project folder ${path} is not a directory`);
  return path;
}

function parseTemplateText(yaml: string): { name: string } {
  const parsed = safeParseTemplateYaml(yaml);
  if (!parsed.ok) {
    throw new AboxError('template_invalid', 'The template has errors and was not saved', {
      issues: parsed.issues,
    });
  }
  return { name: parsed.spec.name };
}

async function locate(
  I: Internals,
  ctx: AgentContext,
  req: { target: 'user' | 'project'; projectDir?: string | undefined },
  name: string,
): Promise<{ dir: string; path: string; projectDir?: string }> {
  if (req.target === 'project') {
    if (!req.projectDir) {
      throw new AboxError('invalid_input', 'a project folder is needed to save into a project', {
        hint: 'Pass the project folder (GUI: pick it above the template list; CLI: --project).',
      });
    }
    const projectDir = await projectFolder(I, ctx, req.projectDir);
    return { ...projectTemplatePath(projectDir, name), projectDir };
  }
  return userTemplatePath(I.paths.templatesDir, name);
}

/**
 * Human only, read-only. What `saveTemplate` would write and what is there now, for the review (a diff of
 * old and new text) before anything is saved. The same checks as the save, so a path that would be
 * refused is refused here.
 */
export async function planTemplateSave(
  I: Internals,
  caller: Caller,
  input: TemplateSaveInput,
): Promise<TemplateSavePlan> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'template.save_plan');
  const req = parseInput(templateSaveSchema, input, 'template save request');
  const { name } = parseTemplateText(req.yaml);
  const where = await locate(I, ctx, req, name);
  const current = await readTemplateFile(where.path);
  return {
    name,
    target: req.target,
    path: where.path,
    ...(where.projectDir ? { projectDir: where.projectDir } : {}),
    exists: current !== null,
    current,
    shadows:
      req.target === 'user' && existsSync(join(builtinTemplatesDir, `${name}.yaml`))
        ? ['builtin']
        : [],
  };
}

/**
 * Human only, audited (`template.save`). Writes a template to the user template directory or to
 * `<project>/.sandbox/<name>.yaml` (exactly that path: the name is validated, no `..`, no link is followed,
 * the write is atomic, an existing file is only replaced with `overwrite`).
 *
 * A file in a project is written into a place a repository owns, so it needs `humanConfirmed` (CLI `--yes`,
 * GUI dialog). Saving never trusts anything: a project template is untrusted for agents until a human
 * approves its content (`abox template review`, the approval flow), and a changed file is untrusted again.
 */
export async function saveTemplate(
  I: Internals,
  caller: Caller,
  input: TemplateSaveInput,
): Promise<TemplateSaveResult> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'template.save');
  const req = parseInput(templateSaveSchema, input, 'template save request');
  if (req.target === 'project' && caller.humanConfirmed !== true) {
    throw new AboxError(
      'approval_required',
      'saving into a project changes files in that project and needs your confirmation',
      { hint: 'Review the file and repeat with humanConfirmed (CLI: --yes, GUI: the dialog).' },
    );
  }
  const { name } = parseTemplateText(req.yaml);
  const detail: Record<string, unknown> = { name, target: req.target };
  try {
    const where = await locate(I, ctx, req, name);
    detail['path'] = where.path;
    if (await otherSpellingExists(where.dir, name)) {
      throw new AboxError(
        'conflict',
        `${join(where.dir, `${name}.yml`)} already defines "${name}"; a second file would define it twice`,
        { hint: 'Edit that file by hand, or choose another name.' },
      );
    }
    const written = await writeTemplateFile({
      dir: where.dir,
      path: where.path,
      text: req.yaml,
      overwrite: req.overwrite === true,
      dirMode: req.target === 'project' ? 0o755 : 0o700,
      fileMode: req.target === 'project' ? 0o644 : 0o600,
    });
    let trusted = req.target !== 'project';
    if (where.projectDir) {
      try {
        trusted = isTrusted(I, await catalogFor(I, where.projectDir).get(name));
      } catch {
        trusted = false; // does not resolve yet (for example an unknown `extends`): certainly not trusted
      }
    }
    I.audit(ctx.owner, 'template.save', {
      decision: 'allow',
      details: {
        ...detail,
        ...(where.projectDir ? { projectDir: where.projectDir } : {}),
        created: written.created,
        bytes: written.bytes,
        sha256: createHash('sha256').update(req.yaml).digest('hex'),
        trusted,
      },
    });
    return {
      name,
      target: req.target,
      path: where.path,
      ...(where.projectDir ? { projectDir: where.projectDir } : {}),
      created: written.created,
      bytes: written.bytes,
      trusted,
      shadows:
        req.target === 'user' && existsSync(join(builtinTemplatesDir, `${name}.yaml`))
          ? ['builtin']
          : [],
    };
  } catch (e) {
    I.audit(ctx.owner, 'template.save', {
      decision: 'deny',
      details: { ...detail, message: errMessage(e).slice(0, 300) },
    });
    throw e;
  }
}

/**
 * Human only, read-only. The starting point of "template from project": runs the detection of
 * `suggestTemplate` and turns the best built-in or user template into a new template that `extends` it (named
 * after the folder). The project's own `.sandbox` templates are not used as a base, because a user template
 * cannot extend one. Nothing is written. When no marker matches, the draft is a small standalone template.
 */
export async function draftTemplateFromProject(
  I: Internals,
  caller: Caller,
  input: TemplateDraftInput,
): Promise<TemplateDraft> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'template.draft');
  const req = parseInput(templateDraftSchema, input, 'template draft request');
  const suggestion = await suggestTemplate(I, caller, { path: req.path });
  const { templates } = await catalogFor(I, suggestion.path).listAll();
  const reusable = new Map(
    templates.filter((t) => t.source.kind !== 'project').map((t) => [t.name, t] as const),
  );
  const projectTemplates = templates.filter((t) => t.source.kind === 'project').map((t) => t.name);
  const markerHits = [suggestion.primary, ...suggestion.alternatives].filter(
    (e): e is NonNullable<typeof e> => e !== null && e.basis === 'markers',
  );

  const taken = new Set(templates.map((t) => t.name));
  const folder = basename(suggestion.path) || 'project';
  let name = req.name;
  if (name === undefined) name = freeTemplateName(templateNameFromFolder(folder), taken);
  else projectTemplatePath(suggestion.path, name); // validates the grammar

  let base: TemplateDraft['base'];
  let chosen: { template: string; backend: string } | undefined;
  if (req.base !== undefined) {
    const t = reusable.get(req.base);
    if (!t) {
      throw new AboxError(
        'not_found',
        `template "${req.base}" is not a built-in or user template`,
        {
          hint: 'A new template can build on a built-in or user template (abox template ls).',
        },
      );
    }
    const hit = markerHits.find((h) => h.template === t.name);
    chosen = { template: t.name, backend: t.backend };
    base = {
      template: t.name,
      basis: 'chosen',
      files: hit?.files ?? [],
      reason: hit ? hit.reason : `chosen by you`,
    };
  } else {
    const hit = markerHits.find((h) => reusable.has(h.template));
    if (hit) {
      chosen = { template: hit.template, backend: reusable.get(hit.template)!.backend };
      base = { template: hit.template, basis: 'markers', files: hit.files, reason: hit.reason };
    } else {
      base = {
        template: null,
        basis: 'fallback',
        files: [],
        reason: 'no known marker file was found in the folder',
      };
    }
  }
  const yaml = projectTemplateDraft({
    name,
    project: folder,
    ...(chosen ? { base: { ...chosen, reason: base.reason } } : {}),
  });
  // the draft has to be a valid template as it stands
  parseTemplateText(yaml);
  return {
    path: suggestion.path,
    name,
    yaml,
    base,
    alternatives: markerHits.filter(
      (h) => reusable.has(h.template) && h.template !== base.template,
    ),
    projectTemplates,
    skipped: suggestion.skipped,
    truncated: suggestion.truncated,
  };
}
