/**
 * Template editor back end. Everything that decides something (schema, security rules, backend capabilities,
 * policy dry run, build, create) is the manager's; this file only moves YAML text between the editor, a private
 * scratch directory and the user's template directory.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AboxError,
  MAX_TEMPLATE_BYTES,
  NETWORK_PRESETS,
  TEMPLATE_NAME_RE,
  builtinTemplatesDir,
  listToolPresets,
  safeParseTemplateYaml,
} from '@abox/core';
import type { Abox, AboxPaths, Caller } from '@abox/core';
import { BASE_IMAGES } from '../shared/base-images';
import type {
  Outputs,
  OsFamily,
  TemplateCatalogInfo,
  TemplateSaved,
  TemplateSourceDoc,
  TemplateTestOutcome,
  ToolCheckResult,
} from '../shared/types';

export interface TemplateRuntime {
  abox: Abox;
  paths: AboxPaths;
}

const HUMAN: Caller = { contextId: 'human' };
const OUTPUT_LIMIT = 2000;

export type TemplateChannel =
  | 'templates:catalog'
  | 'templates:source'
  | 'templates:validate'
  | 'templates:save'
  | 'templates:build'
  | 'templates:test';

type TemplateHandlers = {
  'templates:catalog': () => Promise<Outputs['templates:catalog']>;
  'templates:source': (i: { name: string }) => Promise<Outputs['templates:source']>;
  'templates:validate': (i: { yaml: string }) => Promise<Outputs['templates:validate']>;
  'templates:save': (i: { yaml: string; overwrite?: boolean }) => Promise<TemplateSaved>;
  'templates:build': (
    i: { name: string; update?: boolean; progressKey: string },
    ctx: { onProgress?: (key: string, line: string) => void },
  ) => Promise<Outputs['templates:build']>;
  'templates:test': (
    i: { name: string; progressKey: string; confirmed?: boolean },
    ctx: { onProgress?: (key: string, line: string) => void },
  ) => Promise<TemplateTestOutcome>;
};

function truncate(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_LIMIT ? `${t.slice(0, OUTPUT_LIMIT)} …` : t;
}

export function createTemplateHandlers(rt: TemplateRuntime): TemplateHandlers & {
  cleanup(): Promise<void>;
} {
  const { abox, paths } = rt;
  const draftDir = join(paths.runtimeDir, 'gui-drafts');
  let seq = 0;

  async function withDraft<T>(yaml: string, fn: (file: string) => Promise<T>): Promise<T> {
    await mkdir(draftDir, { recursive: true, mode: 0o700 });
    const file = join(draftDir, `draft-${process.pid}-${++seq}.yaml`);
    await writeFile(file, yaml, { mode: 0o600 });
    try {
      return await fn(file);
    } finally {
      await rm(file, { force: true });
    }
  }

  return {
    async 'templates:catalog'() {
      const tools = listToolPresets().map((p) => ({
        name: p.name,
        summary: p.summary,
        version: p.version,
        ...(p.versionHint ? { versionHint: p.versionHint } : {}),
        os: Object.keys(p.install) as OsFamily[],
      }));
      return {
        baseImages: [...BASE_IMAGES],
        tools,
        networkPresets: Object.entries(NETWORK_PRESETS).map(([name, domains]) => ({
          name,
          domains: [...domains],
        })),
        userDir: paths.templatesDir,
      } satisfies TemplateCatalogInfo;
    },

    async 'templates:source'(i) {
      const { templates } = await abox.listTemplates(HUMAN);
      const entry = templates.find((t) => t.name === i.name);
      if (!entry) throw new AboxError('not_found', `template "${i.name}" not found`);
      const st = await stat(entry.source.path);
      if (st.size > MAX_TEMPLATE_BYTES) {
        throw new AboxError('invalid_input', 'the template file is too large to edit here');
      }
      return {
        name: entry.name,
        yaml: await readFile(entry.source.path, 'utf8'),
        source: { kind: entry.source.kind, path: entry.source.path },
        readOnly: entry.source.kind !== 'user',
      } satisfies TemplateSourceDoc;
    },

    'templates:validate': (i) => withDraft(i.yaml, (file) => abox.validateTemplate(HUMAN, file)),

    async 'templates:save'(i) {
      const parsed = safeParseTemplateYaml(i.yaml);
      if (!parsed.ok) {
        throw new AboxError('template_invalid', 'The template has errors and was not saved', {
          issues: parsed.issues,
        });
      }
      const name = parsed.spec.name;
      if (!TEMPLATE_NAME_RE.test(name)) {
        throw new AboxError('invalid_input', `invalid template name "${name}"`);
      }
      const file = join(paths.templatesDir, `${name}.yaml`);
      if (existsSync(file) && i.overwrite !== true) {
        throw new AboxError('conflict', `a user template named "${name}" already exists`, {
          hint: 'Confirm to overwrite it, or choose another name.',
        });
      }
      await mkdir(paths.templatesDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, i.yaml.endsWith('\n') ? i.yaml : `${i.yaml}\n`, { mode: 0o600 });
      await rename(tmp, file);
      const shadows: Array<'builtin'> = existsSync(join(builtinTemplatesDir, `${name}.yaml`))
        ? ['builtin']
        : [];
      return { name, path: file, shadows };
    },

    'templates:build': (i, ctx) =>
      abox.buildTemplate(HUMAN, i.name, {
        ...(i.update ? { update: true } : {}),
        onProgress: (line) => ctx.onProgress?.(i.progressKey, line),
      }),

    async 'templates:test'(i, ctx) {
      const started = Date.now();
      const details = await abox.showTemplate(HUMAN, i.name);
      const caller: Caller = i.confirmed ? { contextId: 'human', humanConfirmed: true } : HUMAN;
      const sandboxName = `tpltest-${randomBytes(3).toString('hex')}`;
      const created = await abox.createSandbox(
        caller,
        {
          template: i.name,
          name: sandboxName,
          host: 'local',
          workspace: { mode: 'empty' },
          overrides: { ttl: '30m' },
        },
        { onProgress: (line) => ctx.onProgress?.(i.progressKey, line), waitForApprovalMs: 0 },
      );
      if (created.status === 'confirmation_required') {
        return { status: 'confirmation_required', reasons: created.reasons, risks: created.risks };
      }
      if (created.status === 'pending_approval') {
        return { status: 'pending_approval', message: created.message };
      }
      const id = created.sandbox.id;
      const tools: ToolCheckResult[] = [];
      let error: string | undefined;
      let removed = false;
      try {
        for (const tool of details.template.tools) {
          const t0 = Date.now();
          try {
            const r = await abox.exec(
              { contextId: 'human', humanConfirmed: true },
              id,
              { command: tool.check, timeoutMs: 60_000 },
              { waitForApprovalMs: 0 },
            );
            if (r.status !== 'completed') {
              tools.push({
                name: tool.name,
                ...(tool.version ? { version: tool.version } : {}),
                check: tool.check,
                ok: false,
                exitCode: null,
                output: r.status,
                durationMs: Date.now() - t0,
              });
              continue;
            }
            tools.push({
              name: tool.name,
              ...(tool.version ? { version: tool.version } : {}),
              check: tool.check,
              ok: r.exitCode === 0 && !r.timedOut,
              exitCode: r.exitCode,
              output: truncate(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`),
              durationMs: Date.now() - t0,
            });
          } catch (e) {
            tools.push({
              name: tool.name,
              ...(tool.version ? { version: tool.version } : {}),
              check: tool.check,
              ok: false,
              exitCode: null,
              output: e instanceof Error ? e.message : String(e),
              durationMs: Date.now() - t0,
            });
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        // The test sandbox never outlives the test.
        try {
          const r = await abox.removeSandbox(HUMAN, id);
          removed = r.removed;
        } catch (e) {
          error ??= `the test sandbox ${id} could not be removed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return {
        status: 'done',
        created: true,
        removed,
        tools,
        ...(error ? { error } : {}),
        durationMs: Date.now() - started,
      };
    },

    async cleanup() {
      await rm(draftDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
