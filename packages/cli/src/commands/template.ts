import type { Command } from 'commander';
import { AboxError } from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { formatDuration, oneLine, renderKeyValues, renderTable, safe } from '../format.js';
import { formatIssue } from '../cli.js';
import { reviewLines } from '../review.js';

export function registerTemplate(program: Command, cli: Cli): void {
  const t = program.command('template').description('List, inspect, validate and build templates');

  t.command('ls')
    .alias('list')
    .description('List available templates (builtin, user, project)')
    .action(async () => {
      const rt = await cli.rt();
      const list = await rt.abox.listTemplates(cli.caller(), { projectDir: cli.projectDir() });
      cli.success(
        list,
        () => {
          const rows = list.templates.map((x) => [
            x.name,
            x.backend,
            x.isolation,
            x.networkMode,
            x.shadows
              ? `${x.source.kind} (shadows ${[...new Set(x.shadows.map((h) => h.kind))].join('/')})`
              : x.source.kind,
            x.trusted ? 'yes' : 'NO',
            x.ready ? 'yes' : 'no',
            x.description,
          ]);
          let text = renderTable(
            [
              { header: 'NAME' },
              { header: 'BACKEND' },
              { header: 'ISOLATION' },
              { header: 'NET' },
              { header: 'SOURCE' },
              { header: 'TRUSTED' },
              { header: 'READY' },
              { header: 'DESCRIPTION', max: 70 },
            ],
            rows,
            cli.width,
          );
          if (list.templates.length === 0) text = 'no templates found';
          // READY=no: say why (backend missing, or a validation problem a create would run into).
          const notReady = list.templates.filter((x) => !x.ready);
          if (notReady.length > 0)
            text += `\n\nnot ready:\n${notReady
              .map((x) => `  ${safe(x.name)}: ${oneLine(x.notReadyReason ?? 'unknown reason')}`)
              .join('\n')}`;
          for (const p of list.problems) {
            cli.err(`${cli.style('yellow', 'problem:')} ${safe(p.path)}: ${oneLine(p.message)}\n`);
            for (const i of p.issues) cli.err(`  ${formatIssue(i, p.path)}\n`);
          }
          return text;
        },
        () => list.templates.map((x) => x.name).join('\n'),
      );
    });

  t.command('suggest')
    .description(
      'Suggest the template for a project folder (its .sandbox/*.yaml, else marker files such as package.json); read-only',
    )
    .argument('[path]', 'project folder (default: the project directory)')
    .action(async (path: string | undefined) => {
      const rt = await cli.rt();
      const s = await rt.abox.suggestTemplate(cli.caller(), {
        path: path ? cli.resolvePath(path) : cli.projectDir(),
      });
      cli.success(
        s,
        () => {
          const lines: string[] = [];
          if (s.primary) {
            lines.push(`suggested: ${safe(s.primary.template)}  (${safe(s.primary.reason)})`);
          } else {
            lines.push(
              `no template suggested for ${safe(s.path)}: no known marker file and no project template`,
            );
          }
          for (const a of s.alternatives)
            lines.push(`also possible: ${safe(a.template)}  (${safe(a.reason)})`);
          for (const x of s.skipped)
            lines.push(
              `left out: ${safe(x.template)}  (${x.files.map(safe).join(', ')}; ${x.why === 'not_allowed' ? 'not allowed by the policy' : 'no such template'})`,
            );
          if (s.truncated)
            lines.push('note: the folder is large, only its first entries were looked at');
          return lines.join('\n');
        },
        () => s.primary?.template,
      );
    });

  t.command('new')
    .description(
      'Start a new template from a project folder: the detected built-in template becomes its "extends" (like "suggest"), the new template is named after the folder. Prints the YAML, or saves it with --save',
    )
    .requiredOption('--from-project <dir>', 'the project folder')
    .option('--name <name>', 'name of the new template (default: from the folder name)')
    .option(
      '--base <template>',
      'build on this built-in or user template instead of the detected one',
    )
    .option(
      '--save <where>',
      '"user" (the user template directory) or "project" (<dir>/.sandbox/<name>.yaml); without it nothing is written',
    )
    .option('--overwrite', 'with --save: replace a template file of that name')
    .option('-y, --yes', 'with --save project: write into the project without asking')
    .action(
      async (opts: {
        fromProject: string;
        name?: string;
        base?: string;
        save?: string;
        overwrite?: boolean;
        yes?: boolean;
      }) => {
        if (opts.save !== undefined && opts.save !== 'user' && opts.save !== 'project') {
          throw new CliError(
            'invalid_input',
            `--save takes "user" or "project", not "${opts.save}"`,
          );
        }
        if (opts.save === undefined && (opts.overwrite || opts.yes)) {
          throw new CliError('invalid_input', '--overwrite and --yes only make sense with --save');
        }
        const rt = await cli.rt();
        const dir = cli.resolvePath(opts.fromProject);
        const draft = await rt.abox.draftTemplateFromProject(cli.caller(), {
          path: dir,
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.base ? { base: opts.base } : {}),
        });
        const basis =
          draft.base.template === null
            ? `no base template (${draft.base.reason}); a standalone starting point`
            : `extends ${draft.base.template} (${draft.base.reason})`;
        cli.info(`template "${safe(draft.name)}" for ${safe(draft.path)}: ${basis}`);
        for (const a of draft.alternatives)
          cli.info(`also possible as a base: ${safe(a.template)}  (${safe(a.reason)}); use --base`);
        if (draft.projectTemplates.length > 0)
          cli.info(
            `the project already has its own template(s): ${draft.projectTemplates.map(safe).join(', ')} (not used as a base)`,
          );
        if (opts.save === undefined) {
          cli.success(
            { draft },
            () => draft.yaml,
            () => draft.yaml,
          );
          return;
        }
        const target = opts.save;
        const plan = await rt.abox.planTemplateSave(cli.caller(), {
          yaml: draft.yaml,
          target,
          ...(target === 'project' ? { projectDir: draft.path } : {}),
        });
        if (plan.exists && !opts.overwrite) {
          throw new CliError('conflict', `${safe(plan.path)} already exists`, {
            hint: 'Choose another --name, or repeat with --overwrite to replace it.',
          });
        }
        let confirmed = false;
        if (target === 'project') {
          confirmed = opts.yes === true;
          if (!confirmed && cli.interactive) {
            cli.err(`This writes ${safe(plan.path)} into the project.\n`);
            confirmed = await cli.confirm('Write it?');
          }
          if (!confirmed) {
            throw new CliError(
              'approval_required',
              'writing into a project needs your confirmation',
              {
                hint: cli.interactive
                  ? 'Declined.'
                  : 'Repeat with --yes to write it (non-interactive).',
              },
            );
          }
        }
        const r = await rt.abox.saveTemplate(cli.caller(confirmed), {
          yaml: draft.yaml,
          target,
          ...(target === 'project' ? { projectDir: draft.path } : {}),
          ...(opts.overwrite ? { overwrite: true } : {}),
        });
        cli.success(
          { draft, saved: r },
          () =>
            [
              `${r.created ? 'saved' : 'replaced'} ${safe(r.path)}`,
              r.target === 'project'
                ? r.trusted
                  ? 'This exact content is trusted already.'
                  : `Not trusted yet: agents cannot use it until you approve it (see what it does: abox template review ${r.name} --project ${safe(r.projectDir ?? '')}).`
                : `Edit it, then check it: abox template validate ${r.name}`,
            ].join('\n'),
          () => r.path,
        );
      },
    );

  t.command('show')
    .description('Show a resolved template')
    .argument('<name>', 'template name')
    .action(async (name: string) => {
      const rt = await cli.rt();
      const d = await rt.abox.showTemplate(cli.caller(), name, { projectDir: cli.projectDir() });
      cli.success(d, () => {
        const x = d.template;
        const lines = [
          renderKeyValues([
            ['name', x.name],
            ['description', x.description],
            [
              'backend',
              `${x.backend} (isolation ${x.isolation})${d.backendAvailable ? '' : ' - backend not available'}`,
            ],
            ['source', `${x.source.kind}${x.source.path ? ` ${x.source.path}` : ''}`],
            [
              'trusted',
              d.trusted
                ? 'yes'
                : `NO - project template not approved yet (see what it does: abox template review ${x.name})`,
            ],
            ['allowed', d.allowed ? 'yes' : 'no (policy profile)'],
            ['base', x.base.os ?? x.base.dockerfile ?? '-'],
            [
              'build context',
              x.buildContext
                ? `${safe(x.buildContext.dir)} (${x.buildContext.fileCount} file${x.buildContext.fileCount === 1 ? '' : 's'}, ${x.buildContext.totalBytes} bytes)`
                : undefined,
            ],
            ['user', `${x.user.name} (uid ${x.user.uid})${x.user.sudo ? ' sudo' : ''}`],
            ['workspace', `${x.workspace.mode} -> ${x.workspace.path} (${x.workspace.access})`],
            [
              'resources',
              `${x.resources.cpus} cpu, ${Math.round(x.resources.memoryBytes / 1048576)} MiB, ${x.resources.pids} pids, ttl ${formatDuration(x.resources.ttlMs)}`,
            ],
            [
              'network',
              `${x.network.mode}${x.network.allow.length ? ` [${x.network.allow.join(', ')}]` : ''}`,
            ],
            [
              'tools',
              x.tools
                .map((tool) => tool.name + (tool.version ? `@${tool.version}` : ''))
                .join(', ') || undefined,
            ],
            ['secrets', x.secrets.map((s) => `${s.ref} (${s.inject})`).join(', ') || undefined],
            ['skills', x.skills?.join(', ') || undefined],
            ['hash', x.hash.slice(0, 16)],
          ]),
        ];
        const lim = d.effectiveLimits;
        if (lim.exceedsProfile.length > 0) {
          lines.push(`exceeds your profile "${lim.profile}": ${lim.exceedsProfile.join('; ')}`);
        }
        for (const w of d.warnings) lines.push(`warning: ${safe(w)}`);
        return lines.join('\n');
      });
    });

  t.command('review')
    .description(
      'Show what a (project) template does before you trust it: a diff against its last trusted version, the template it extends or the built-in/user template it shadows',
    )
    .argument('<name>', 'template name')
    .action(async (name: string) => {
      const rt = await cli.rt();
      const r = await rt.abox.reviewTemplate(cli.caller(), name, { projectDir: cli.projectDir() });
      cli.success(r, () => {
        const lines = reviewLines(cli, r).slice(1);
        lines.push(
          '',
          r.trusted
            ? 'This exact content is trusted.'
            : 'Not trusted yet: "abox create" asks you before it uses this content; an agent needs your approval.',
        );
        return lines.join('\n');
      });
    });

  t.command('validate')
    .description('Validate a template by name or YAML file')
    .argument('<name|file>', 'template name or path')
    .action(async (nameOrPath: string) => {
      const rt = await cli.rt();
      const arg = looksLikePath(nameOrPath) ? cli.resolvePath(nameOrPath) : nameOrPath;
      let v;
      try {
        v = await rt.abox.validateTemplate(cli.caller(), arg, { projectDir: cli.projectDir() });
      } catch (e) {
        // A file that cannot be parsed at all: keep the position info and name the file.
        if (e instanceof AboxError && e.issues.length > 0) {
          throw new CliError(e.code, e.message, {
            ...(e.hint ? { hint: e.hint } : {}),
            issues: e.issues,
            details: { file: arg, ...(e.details ?? {}) },
          });
        }
        throw e;
      }
      const file = v.source?.path ?? (looksLikePath(nameOrPath) ? arg : undefined);
      if (!v.ok) {
        const issues = v.issues.map((i) => ({
          kind: i.kind,
          ...(i.path ? { path: i.path } : {}),
          ...(i.line !== undefined ? { line: i.line } : {}),
          ...(i.column !== undefined ? { column: i.column } : {}),
          message: i.message,
          ...(file ? { file } : {}),
        }));
        const onlyPolicy = v.issues.length > 0 && v.issues.every((i) => i.kind === 'policy');
        // The policy hint (e.g. about mount directories) belongs to policy problems only: next to a
        // schema or name error it would send the user to the wrong place.
        const hint = onlyPolicy ? v.policy?.hint : 'Fix the listed fields and validate again.';
        const reasons = v.policy?.reasons ?? [];
        throw new CliError(
          onlyPolicy ? 'policy_denied' : 'template_invalid',
          `${v.name ?? nameOrPath}: ${v.issues.length} problem(s)`,
          {
            issues: issues as never,
            ...(hint ? { hint } : {}),
            details: { file, warnings: v.warnings, ...(onlyPolicy ? { reasons } : {}) },
          },
        );
      }
      cli.success(
        v,
        () => {
          const lines = [`${v.name ?? nameOrPath}: valid${file ? ` (${safe(file)})` : ''}`];
          if (v.policy) {
            lines.push(
              `policy: a create with the defaults would be ${v.policy.decision}${v.warnings.length === 0 && v.policy.reasons.length ? ` (${v.policy.reasons.map(oneLine).join('; ')})` : ''}`,
            );
          }
          for (const w of v.warnings) lines.push(`warning: ${safe(w)}`);
          return lines.join('\n');
        },
        () => undefined,
      );
    });

  t.command('build')
    .description('Build (or fetch) the environment image of a template')
    .argument('<name>', 'template name')
    .option('--update', 'ignore the pinned base and the cache; fetch the newest base')
    .option('-y, --yes', 'also build an unapproved project template')
    .action(async (name: string, opts: { update?: boolean; yes?: boolean }) => {
      if (cli.globals.host && cli.globals.host !== 'local') {
        throw new AboxError('unsupported', 'template builds run on the local host', {
          hint: 'Images for remote hosts are built when a sandbox is created there.',
        });
      }
      const rt = await cli.rt();
      const signal = cli.abortSignal();
      let r;
      try {
        r = await rt.abox.buildTemplate(opts.yes ? cli.caller(true) : cli.caller(), name, {
          projectDir: cli.projectDir(),
          ...(opts.update ? { update: true } : {}),
          signal,
          onProgress: (line) => cli.info(`  ${safe(line)}`),
        });
      } catch (e) {
        if (!(e instanceof AboxError) || e.code !== 'untrusted_template') throw e;
        // Show what the template does, so --yes is an informed decision.
        const review = await rt.abox
          .reviewTemplate(cli.caller(), name, { projectDir: cli.projectDir() })
          .catch(() => undefined);
        if (!review) throw e;
        if (!cli.json) for (const line of reviewLines(cli, review)) cli.err(`${line}\n`);
        throw new CliError(e.code, e.message, {
          hint: `Review the diff above, then repeat with --yes to build it.`,
          details: { ...(e.details ?? {}), templateReview: review },
        });
      }
      cli.success(
        r,
        () =>
          r.cached
            ? `${r.template}: image up to date (cached, ${formatDuration(r.durationMs)})`
            : `${r.template}: image built in ${formatDuration(r.durationMs)} (${r.image.ref})`,
        () => r.image.ref,
      );
    });

  t.command('gc')
    .description('Remove environment images no template or sandbox uses any more')
    .action(async () => {
      const rt = await cli.rt();
      const r = await rt.abox.gcImages(cli.caller(), { projectDir: cli.projectDir() });
      cli.success(r, () => {
        const n = r.removed.reduce((a, b) => a + b.refs.length, 0);
        return n === 0
          ? 'nothing to remove'
          : `removed ${n} image(s): ${r.removed.flatMap((x) => x.refs).join(', ')}`;
      });
    });
}

function looksLikePath(s: string): boolean {
  return s.includes('/') || /\.ya?ml$/i.test(s);
}
