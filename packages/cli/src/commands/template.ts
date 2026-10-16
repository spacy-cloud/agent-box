import type { Command } from 'commander';
import { AboxError } from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { formatDuration, oneLine, renderKeyValues, renderTable, safe } from '../format.js';
import { formatIssue } from '../cli.js';

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
            x.source.kind,
            x.trusted ? 'yes' : 'NO',
            x.backendAvailable ? 'yes' : 'no',
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
          for (const p of list.problems) {
            cli.err(`${cli.style('yellow', 'problem:')} ${safe(p.path)}: ${oneLine(p.message)}\n`);
            for (const i of p.issues) cli.err(`  ${formatIssue(i, p.path)}\n`);
          }
          return text;
        },
        () => list.templates.map((x) => x.name).join('\n'),
      );
    });

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
            ['trusted', d.trusted ? 'yes' : 'NO - project template not approved yet'],
            ['allowed', d.allowed ? 'yes' : 'no (policy profile)'],
            ['base', x.base.os ?? x.base.dockerfile ?? '-'],
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
        const reasons = v.policy?.reasons ?? [];
        throw new CliError(
          onlyPolicy ? 'policy_denied' : 'template_invalid',
          `${v.name ?? nameOrPath}: ${v.issues.length} problem(s)`,
          {
            issues: issues as never,
            ...(v.policy?.hint ? { hint: v.policy.hint } : {}),
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
      const r = await rt.abox.buildTemplate(opts.yes ? cli.caller(true) : cli.caller(), name, {
        projectDir: cli.projectDir(),
        ...(opts.update ? { update: true } : {}),
        signal,
        onProgress: (line) => cli.info(`  ${safe(line)}`),
      });
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
