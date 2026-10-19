import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { AboxError } from '../errors.js';
import { canonicalizePath, checkHostPath } from '../policy/index.js';
import { matchMarkers, scanProjectMarkers } from '../template/index.js';
import type { Internals } from './internals.js';
import { templateSuggestSchema } from './schemas.js';
import { catalogFor, templateAllowed } from './templates.js';
import type {
  Caller,
  TemplateSuggestion,
  TemplateSuggestionEntry,
  TemplateSuggestionInput,
  TemplateSuggestionSkipped,
} from './types.js';
import { errMessage, parseInput } from './util.js';

/**
 * Read-only. Suggests the template for a project folder: its own `.sandbox/*.yaml` templates first (they
 * always win), then the templates that marker files point to (`package.json` -> node-dev, ...), best first.
 * Only names of a few well-known files are looked at (see `scanProjectMarkers`); nothing of the project is
 * read, walked or run. The folder has to pass the path check of a workspace, so an agent can only ask about
 * folders it could use as a workspace, and a template its policy does not allow is never suggested.
 */
export async function suggestTemplate(
  I: Internals,
  caller: Caller,
  input: TemplateSuggestionInput,
): Promise<TemplateSuggestion> {
  const ctx = await I.context(caller);
  const req = parseInput(templateSuggestSchema, input, 'template suggestion request');
  const path = canonicalizePath(req.path, { home: I.home, cwd: I.projectDir ?? process.cwd() });
  const check = checkHostPath(path, {
    home: I.home,
    roots: ctx.workspaceRoots,
    kind: 'workspace',
    extraForbidden: I.forbiddenTrees(),
    ...(ctx.kind === 'human' ? {} : { denyHiddenHomeDirs: true }),
  });
  if (!check.ok) throw new AboxError('policy_denied', check.reason, { hint: check.hint });
  let isDir: boolean;
  try {
    isDir = (await stat(path)).isDirectory();
  } catch (e) {
    throw new AboxError('invalid_input', `project folder ${path} cannot be read: ${errMessage(e)}`);
  }
  if (!isDir) throw new AboxError('invalid_input', `project folder ${path} is not a directory`);

  let scan;
  try {
    scan = await scanProjectMarkers(path);
  } catch (e) {
    throw new AboxError('invalid_input', `project folder ${path} cannot be read: ${errMessage(e)}`);
  }
  const candidates = matchMarkers(scan.files);
  const { templates } = await catalogFor(I, path).listAll();
  const byName = new Map(templates.map((t) => [t.name, t]));

  const entries: TemplateSuggestionEntry[] = [];
  const skipped: TemplateSuggestionSkipped[] = [];

  // The project's own templates win. Among several: the one named like a detected template, then `default`.
  const rank = (name: string): number => {
    const i = candidates.findIndex((c) => c.template === name);
    return i >= 0 ? i : name === 'default' ? candidates.length : candidates.length + 1;
  };
  const own = templates
    .filter((t) => t.source.kind === 'project' && templateAllowed(ctx, t.name))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  for (const t of own) {
    const file = `.sandbox/${basename(t.source.path)}`;
    entries.push({
      template: t.name,
      basis: 'project_template',
      files: [file],
      reason: `the project has its own template ${file}; project templates win over detected markers`,
    });
  }
  const taken = new Set(entries.map((e) => e.template));
  for (const c of candidates) {
    if (taken.has(c.template)) continue;
    const t = byName.get(c.template);
    if (!t) {
      skipped.push({ template: c.template, files: c.markers, why: 'not_found' });
    } else if (!templateAllowed(ctx, c.template)) {
      skipped.push({ template: c.template, files: c.markers, why: 'not_allowed' });
    } else {
      taken.add(c.template);
      entries.push({
        template: c.template,
        basis: 'markers',
        files: c.markers,
        reason: c.reason,
      });
    }
  }
  return {
    path,
    primary: entries[0] ?? null,
    alternatives: entries.slice(1),
    skipped,
    truncated: scan.truncated,
  };
}
