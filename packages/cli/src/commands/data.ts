import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { Option } from 'commander';
import type { ExportParams, SnapshotEntry, SnapshotView } from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError, CliExit } from '../errors.js';
import { commaList, invalid } from '../parse.js';
import { resolveSandboxId } from '../ids.js';
import { formatBytes, formatRelative, renderTable, safe } from '../format.js';

/** Column "CLONE": can a new sandbox be created from it, and if not, why. */
function cloneText(s: Pick<SnapshotView, 'cloneable' | 'cloneBlocked'>): string {
  if (s.cloneable) return 'yes';
  return s.cloneBlocked === 'secrets' ? 'no (holds secrets)' : 'no';
}

/** The entry a `snapshot rm` argument names: an id, or (with --sandbox) a name or id of that sandbox's. */
function pickSnapshot(
  all: SnapshotEntry[],
  name: string,
  sandboxId: string | undefined,
): SnapshotEntry {
  const pool = sandboxId ? all.filter((s) => s.sandboxId === sandboxId) : all;
  const byId = pool.filter((s) => s.id === name);
  const hits = byId.length > 0 ? byId : sandboxId ? pool.filter((s) => s.name === name) : [];
  if (hits.length === 0) {
    throw new CliError('not_found', `no snapshot "${safe(name)}"`, {
      hint: '"abox snapshot ls --all" lists the snapshots with their ids.',
    });
  }
  // Several snapshots of one name: the newest (what "abox restore <name>" takes as well).
  return hits.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
}

export function registerData(program: Command, cli: Cli): void {
  const snapshot = program
    .command('snapshot')
    .description(
      'Take a named snapshot of a sandbox (backends that support it); "snapshot ls" and "snapshot rm" list and delete them',
    )
    .argument('<id>', 'sandbox id or name')
    .argument('<name>', 'snapshot name')
    .addHelpText(
      'after',
      `
A snapshot is a copy of the whole sandbox: its files, including the workspace if that lives in the
sandbox (copy/empty modes), but not mounts, volumes or running processes. Anything the sandbox can
read is in it, secrets that were placed inside it (inject: env / file) included. Restore it with
"abox restore", start a new sandbox from it with "abox create --from-snapshot", free the space
with "abox snapshot rm". A sandbox name that is "ls" or "rm" needs its id here.`,
    )
    .action(async (ref: string, name: string) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const r = await rt.abox.snapshot(cli.caller(), id, name);
      cli.success(
        r,
        () =>
          `snapshot ${r.snapshotId} of ${id}\n  restore with: abox restore ${id} ${r.snapshotId}\n  new sandbox from it: abox create --from-snapshot ${r.snapshotId}`,
        () => r.snapshotId,
      );
    });

  snapshot
    .command('ls')
    .alias('list')
    .description('List the snapshots of a sandbox, or all of them with --all')
    .argument('[id]', 'sandbox id or name')
    .option(
      '-a, --all',
      'every snapshot of every sandbox, also those of deleted sandboxes, with the total size',
    )
    .action(async (ref: string | undefined, o: { all?: boolean }) => {
      if ((ref === undefined) === (o.all !== true)) {
        throw invalid(
          'name a sandbox or use --all',
          '"abox snapshot ls <sandbox>" lists one sandbox, "abox snapshot ls --all" every snapshot.',
        );
      }
      const rt = await cli.rt();
      const now = Date.now();
      if (ref !== undefined) {
        const id = await resolveSandboxId(cli, ref);
        const snapshots = await rt.abox.listSnapshots(cli.caller(), id);
        cli.success(
          { snapshots },
          () =>
            snapshots.length === 0
              ? 'no snapshots'
              : renderTable(
                  [
                    { header: 'ID' },
                    { header: 'NAME' },
                    { header: 'SIZE', right: true },
                    { header: 'AGE' },
                    { header: 'CLONE' },
                  ],
                  snapshots.map((s) => [
                    s.id,
                    safe(s.name),
                    s.sizeBytes === undefined ? '?' : formatBytes(s.sizeBytes),
                    formatRelative(s.createdAt, now),
                    cloneText(s),
                  ]),
                  cli.width,
                ),
          () => snapshots.map((s) => s.id).join('\n'),
        );
        return;
      }
      const r = await rt.abox.listAllSnapshots(cli.caller());
      cli.success(
        r,
        () => {
          const lines: string[] = [];
          if (r.snapshots.length === 0) lines.push('no snapshots');
          else {
            lines.push(
              renderTable(
                [
                  { header: 'ID' },
                  { header: 'SANDBOX' },
                  { header: 'NAME' },
                  { header: 'SIZE', right: true },
                  { header: 'AGE' },
                  { header: 'CLONE' },
                ],
                r.snapshots.map((s) => [
                  s.id,
                  s.orphaned
                    ? `${s.sandboxId} (deleted)`
                    : `${s.sandboxId}${s.sandboxName ? ` (${safe(s.sandboxName)})` : ''}`,
                  safe(s.name),
                  s.sizeBytes === undefined ? '?' : formatBytes(s.sizeBytes),
                  formatRelative(s.createdAt, now),
                  cloneText(s),
                ]),
                cli.width,
              ),
              '',
              `${r.snapshots.length} snapshot(s), ${formatBytes(r.totalBytes)} in total${
                r.snapshots.some((s) => s.orphaned)
                  ? `; ${r.snapshots.filter((s) => s.orphaned).length} of deleted sandboxes ("abox snapshot rm --orphans")`
                  : ''
              }`,
            );
          }
          for (const u of r.unreachable)
            lines.push(
              `${safe(u.backend)} on ${safe(u.host)} could not be asked: ${safe(u.error)}`,
            );
          return lines.join('\n');
        },
        () => r.snapshots.map((s) => s.id).join('\n'),
      );
    });

  snapshot
    .command('rm')
    .alias('remove')
    .description('Delete snapshots by id, or by name of one sandbox, or those of deleted sandboxes')
    .argument(
      '[snapshot...]',
      'snapshot ids from "abox snapshot ls --all" (with --sandbox: names or ids)',
    )
    .option('--sandbox <id>', 'the sandbox whose snapshots are named (id or name)')
    .option('--orphans', 'every snapshot whose sandbox no longer exists')
    .option('-y, --yes', 'delete without asking (needed when not on a terminal)')
    .action(async (names: string[], o: { sandbox?: string; orphans?: boolean; yes?: boolean }) => {
      if (names.length > 0 === (o.orphans === true)) {
        throw invalid(
          'name the snapshots to delete, or use --orphans',
          '"abox snapshot ls --all" lists them with their ids.',
        );
      }
      if (o.orphans && o.sandbox) throw invalid('--orphans cannot be combined with --sandbox');
      const rt = await cli.rt();
      const all = (await rt.abox.listAllSnapshots(cli.caller())).snapshots;
      const sandboxId = o.sandbox ? await resolveSandboxId(cli, o.sandbox) : undefined;
      const picked: SnapshotEntry[] = o.orphans
        ? all.filter((s) => s.orphaned)
        : names.map((n) => pickSnapshot(all, n, sandboxId));
      const unique = [...new Map(picked.map((s) => [`${s.sandboxId}|${s.id}`, s])).values()];
      if (unique.length === 0) {
        cli.success({ removed: [], errors: [] }, () => 'no snapshots to delete');
        return;
      }
      const bytes = unique.reduce((n, s) => n + (s.sizeBytes ?? 0), 0);
      const what = `${unique.length} snapshot(s), ${formatBytes(bytes)}`;
      if (!o.yes) {
        if (!cli.interactive) {
          throw invalid(
            `deleting ${what} needs --yes when not on a terminal`,
            'Add --yes, or run the command in a terminal to be asked.',
          );
        }
        for (const s of unique) cli.err(`  ${s.id}  ${safe(s.name)}  (${s.sandboxId})\n`);
        if (!(await cli.confirm(`Delete ${what}? This cannot be undone.`))) {
          cli.out('nothing was deleted\n');
          return;
        }
      }
      const r = await rt.abox.deleteSnapshots(
        cli.caller(),
        unique.map((s) => ({ backend: s.backend, sandboxId: s.sandboxId, snapshotId: s.id })),
      );
      for (const e of r.errors) cli.warn(`${safe(e.ref.snapshotId)}: ${safe(e.message)}`);
      cli.success(
        r,
        () => `deleted ${r.removed.length} of ${unique.length} snapshot(s)`,
        () => r.removed.map((x) => x.snapshotId).join('\n'),
      );
      if (r.errors.length > 0) throw new CliExit(1);
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
