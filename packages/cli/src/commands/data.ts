import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { Option } from 'commander';
import type { ExportParams } from '@abox/core';
import type { Cli } from '../cli.js';
import { commaList, invalid } from '../parse.js';
import { resolveSandboxId } from '../ids.js';
import { safe } from '../format.js';

export function registerData(program: Command, cli: Cli): void {
  program
    .command('snapshot')
    .description('Take a named snapshot of a sandbox (backends that support it)')
    .argument('<id>', 'sandbox id or name')
    .argument('<name>', 'snapshot name')
    .action(async (ref: string, name: string) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const r = await rt.abox.snapshot(cli.caller(), id, name);
      cli.success(
        r,
        () =>
          `snapshot ${r.snapshotId} of ${id}\n  restore with: abox restore ${id} ${r.snapshotId}`,
        () => r.snapshotId,
      );
    });

  program
    .command('restore')
    .description('Restore a sandbox to a snapshot')
    .argument('<id>', 'sandbox id or name')
    .argument('<name>', 'snapshot name or id (as printed by "abox snapshot")')
    .action(async (ref: string, name: string) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const r = await rt.abox.restore(cli.caller(), id, name);
      cli.success(r, () => `restored ${id} to ${r.restored}`);
    });

  program
    .command('export')
    .description('Get the changes of a sandbox out (never applies anything to your project)')
    .argument('<id>', 'sandbox id or name')
    .addOption(
      new Option(
        '--format <format>',
        'diff and patch print text, branch creates a git branch, files copies changed files',
      )
        .choices(['diff', 'patch', 'branch', 'files'])
        .default('diff'),
    )
    .option('-o, --out <path>', 'diff/patch: write to this file; files: target directory')
    .option('--branch <name>', 'branch format: branch name (default abox/<id>-export)')
    .option('--paths <list>', 'only these paths, comma separated (relative to the workspace)')
    .option('--force', 'branch format: overwrite an existing export branch')
    .action(
      async (
        ref: string,
        o: {
          format: ExportParams['format'];
          out?: string;
          branch?: string;
          paths?: string;
          force?: boolean;
        },
      ) => {
        const id = await resolveSandboxId(cli, ref);
        const rt = await cli.rt();
        if (o.format === 'files' && !o.out) {
          throw invalid('--format files needs --out <directory>');
        }
        const paths = commaList(o.paths);
        const params: ExportParams = {
          format: o.format,
          ...(paths.length ? { paths } : {}),
          ...(o.format === 'files' && o.out ? { outDir: cli.resolvePath(o.out) } : {}),
          ...(o.branch ? { branchName: o.branch } : {}),
          ...(o.force ? { force: true } : {}),
        };
        const r = await rt.abox.exportSandbox(cli.caller(), id, params);

        // Risky files first, on stderr, impossible to miss.
        if (r.flagged.length > 0) {
          const bar = '!'.repeat(72);
          cli.err(`${cli.style('red', bar)}\n`);
          cli.err(
            `${cli.style('red', `WARNING: ${r.flagged.length} changed path(s) can run code on your machine once you use them:`)}\n`,
          );
          for (const f of r.flagged)
            cli.err(`  ${cli.style('bold', safe(f.path))}  - ${safe(f.reason)}\n`);
          cli.err('Read these files before you apply or build the export.\n');
          cli.err(`${cli.style('red', bar)}\n`);
        }
        for (const w of r.warnings) cli.warn(safe(w));
        for (const s of r.stats.skipped) cli.warn(`skipped ${safe(s.path)}: ${safe(s.reason)}`);

        let writtenTo: string | undefined;
        if ((o.format === 'diff' || o.format === 'patch') && o.out) {
          writtenTo = cli.resolvePath(o.out);
          await mkdir(dirname(writtenTo), { recursive: true });
          await writeFile(writtenTo, r.content ?? '', { mode: 0o644 });
        }
        const summary = `${r.stats.filesChanged} file(s) changed, +${r.stats.insertions} -${r.stats.deletions}`;
        cli.success(
          { ...r, ...(writtenTo ? { writtenTo } : {}) },
          () => {
            if (o.format === 'diff' || o.format === 'patch') {
              if (writtenTo) return `${summary}; ${o.format} written to ${writtenTo}`;
              cli.info(summary);
              return r.content ?? '';
            }
            if (o.format === 'branch') {
              return `${summary}\nbranch ${r.branch ?? '?'} at ${r.commit?.slice(0, 12) ?? '?'}\n  review: git log -p ${r.branch ?? ''}   merge: git merge ${r.branch ?? ''}`;
            }
            return `${summary}; ${r.written?.length ?? 0} file(s) written to ${r.outDir ?? params.outDir ?? '?'}`;
          },
          () => writtenTo ?? r.branch ?? r.outDir ?? undefined,
        );
      },
    );
}
