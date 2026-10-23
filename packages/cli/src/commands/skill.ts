import type { Command } from 'commander';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { formatIssue } from '../cli.js';
import { oneLine, renderKeyValues, renderTable, safe } from '../format.js';

export function registerSkill(program: Command, cli: Cli): void {
  const s = program
    .command('skill')
    .description('List, inspect and validate skills (folders with a SKILL.md for agents)');

  s.command('ls')
    .alias('list')
    .description('List available skills (builtin, user, project)')
    .action(async () => {
      const rt = await cli.rt();
      const list = await rt.abox.listSkills(cli.caller(), { projectDir: cli.projectDir() });
      cli.success(
        list,
        () => {
          const rows = list.skills.map((x) => [
            x.name,
            x.shadows
              ? `${x.source.kind} (shadows ${[...new Set(x.shadows.map((h) => h.kind))].join('/')})`
              : x.source.kind,
            x.trusted ? 'yes' : 'NO',
            String(x.fileCount),
            x.description,
          ]);
          const text =
            list.skills.length === 0
              ? 'no skills found'
              : renderTable(
                  [
                    { header: 'NAME' },
                    { header: 'SOURCE' },
                    { header: 'TRUSTED' },
                    { header: 'FILES' },
                    { header: 'DESCRIPTION', max: 80 },
                  ],
                  rows,
                  cli.width,
                );
          for (const p of list.problems) {
            cli.err(`${cli.style('yellow', 'problem:')} ${safe(p.path)}: ${oneLine(p.message)}\n`);
            for (const i of p.issues) cli.err(`  ${formatIssue(i)}\n`);
          }
          return text;
        },
        () => list.skills.map((x) => x.name).join('\n'),
      );
    });

  s.command('show')
    .description('Show a skill: where it comes from, its files and its instructions')
    .argument('<name>', 'skill name')
    .action(async (name: string) => {
      const rt = await cli.rt();
      const d = await rt.abox.showSkill(cli.caller(), name, { projectDir: cli.projectDir() });
      cli.success(d, () => {
        const extra = Object.entries(d.frontMatter).map(
          ([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string],
        );
        const lines = [
          renderKeyValues([
            ['name', d.name],
            ['description', d.description],
            [
              'source',
              `${d.source.kind} ${d.source.path}${d.shadows ? ` (shadows ${d.shadows.map((h) => h.kind).join('/')})` : ''}`,
            ],
            [
              'trusted',
              d.trusted
                ? 'yes'
                : 'NO - project skill not approved yet (an agent that uses it asks for your approval)',
            ],
            ['files', d.files.map((f) => `${f.path}${f.executable ? ' (x)' : ''}`).join(', ')],
            ['size', `${d.totalBytes} bytes`],
            ['in a sandbox', d.sandboxPath],
            ...extra,
            ['hash', d.contentHash.slice(0, 16)],
          ]),
          '',
          safe(d.body),
        ];
        return lines.join('\n');
      });
    });

  s.command('validate')
    .description('Validate a skill by name or folder')
    .argument('<name|folder>', 'skill name, or a path to the skill folder (or its SKILL.md)')
    .action(async (nameOrPath: string) => {
      const rt = await cli.rt();
      const isPath = nameOrPath.includes('/') || nameOrPath === '.' || nameOrPath === '..';
      const arg = isPath ? cli.resolvePath(nameOrPath) : nameOrPath;
      const v = await rt.abox.validateSkill(cli.caller(), arg, { projectDir: cli.projectDir() });
      const folder = v.path ?? (isPath ? arg : undefined);
      if (!v.ok) {
        throw new CliError(
          'skill_invalid',
          `${v.name ?? nameOrPath}: ${v.issues.length} problem(s)`,
          {
            // `file` is the file inside the skill folder; it replaces the relative `path`
            issues: v.issues.map((i) => ({
              ...(i.line !== undefined ? { line: i.line } : {}),
              ...(i.column !== undefined ? { column: i.column } : {}),
              message: i.message,
              ...(folder ? { file: i.path ? `${folder}/${i.path}` : folder } : {}),
            })) as never,
            hint: 'Fix the listed problems and validate again.',
            details: { ...(folder ? { path: folder } : {}), warnings: v.warnings },
          },
        );
      }
      cli.success(
        v,
        () =>
          [
            `${v.name}: valid (${safe(folder ?? '')}, ${v.fileCount} file${v.fileCount === 1 ? '' : 's'}, ${v.totalBytes} bytes)`,
            ...v.warnings.map((w) => `warning: ${safe(w)}`),
          ].join('\n'),
        () => undefined,
      );
    });
}
