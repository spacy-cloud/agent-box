import type { Command } from 'commander';
import type { ApplyChangesParams, ApplyPlan, ChangeFile, ChangeSelection } from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { safe } from '../format.js';
import { resolveSandboxId } from '../ids.js';
import { collect, invalid } from '../parse.js';

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

function planText(plan: ApplyPlan): string {
  const lines = [
    `target: ${safe(plan.target)} (${plan.targetKind === 'git' ? 'git repository' : 'not a git repository'})`,
  ];
  for (const f of plan.files) {
    const hunks = f.totalHunks > 0 ? `, ${f.hunks}/${f.totalHunks} hunk(s)` : '';
    const flag = f.flagged ? `  [${f.badges.join(', ') || 'flagged'}]` : '';
    lines.push(
      `  ${STATUS_LETTER[f.status]} ${safe(f.path)}  +${f.insertions} -${f.deletions}${hunks}${flag}`,
    );
  }
  lines.push(`${plan.files.length} file(s), +${plan.insertions} -${plan.deletions}`);
  return lines.join('\n');
}

/** Files a `--path` value stands for: the file itself, or the unflagged files below a directory. */
function matches(
  files: ChangeFile[],
  p: string,
): { exact: ChangeFile | undefined; below: ChangeFile[] } {
  const clean = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return {
    exact: files.find((f) => f.path === clean),
    below: files.filter((f) => f.path.startsWith(`${clean}/`)),
  };
}

export function registerApply(program: Command, cli: Cli): void {
  program
    .command('apply')
    .description(
      'Apply the changes of a sandbox to the project it was created from (per file; human only)',
    )
    .argument('<id>', 'sandbox id or name')
    .option(
      '--path <path>',
      'file or directory (relative to the workspace) to apply; repeat for more. Default: every changed file that is not flagged',
      collect,
    )
    .option('--dry-run', 'run every check and show what would be applied, write nothing')
    .option('-y, --yes', 'confirm the plan without asking (required when not interactive)')
    .option(
      '--allow-flagged',
      'also apply the flagged files named with --path (executables, dependency manifests, hooks, CI, build scripts, links, binaries)',
    )
    .option(
      '--allow-non-git',
      'the project is not a git repository: confirm that uncommitted work cannot be detected',
    )
    .action(
      async (
        ref: string,
        o: {
          path?: string[];
          dryRun?: boolean;
          yes?: boolean;
          allowFlagged?: boolean;
          allowNonGit?: boolean;
        },
      ) => {
        const id = await resolveSandboxId(cli, ref);
        const rt = await cli.rt();
        const view = await rt.abox.reviewChanges(cli.caller(), id);
        if (view.target.kind === 'unavailable') {
          throw new CliError('unsupported', view.target.message ?? 'nothing to apply to', {
            hint: 'Use `abox export` to get the changes out instead.',
          });
        }
        if (view.files.length === 0) {
          cli.success({ status: 'nothing_to_apply', sandboxId: id }, () => 'no changes to apply');
          return;
        }

        // -- selection ----------------------------------------------------------------------
        const chosen = new Map<string, ChangeFile>();
        const skippedFlagged: ChangeFile[] = [];
        if (!o.path || o.path.length === 0) {
          for (const f of view.files) {
            if (f.applicable && !f.needsConfirmation) chosen.set(f.path, f);
            else if (f.needsConfirmation) skippedFlagged.push(f);
          }
        } else {
          for (const p of o.path) {
            const m = matches(view.files, p);
            if (!m.exact && m.below.length === 0) {
              throw invalid(
                `no changed file matches ${JSON.stringify(p)}`,
                'List them with `abox export <id>`.',
              );
            }
            for (const f of m.exact ? [m.exact] : m.below) {
              if (!f.applicable) {
                throw invalid(
                  `${JSON.stringify(f.path)} cannot be applied (${f.notApplicable ?? 'not applicable'})`,
                );
              }
              // flagged files inside a directory are never taken along: name them
              if (f.needsConfirmation && f !== m.exact) skippedFlagged.push(f);
              else chosen.set(f.path, f);
            }
          }
        }
        const flagged = [...chosen.values()].filter((f) => f.needsConfirmation);
        for (const f of skippedFlagged) {
          cli.warn(
            `skipped flagged file ${safe(f.path)} (${safe(f.flags[0] ?? f.badges.join(', '))}); name it with --path and --allow-flagged to apply it`,
          );
        }
        if (chosen.size === 0) {
          throw invalid('no file selected', 'Name files with --path.');
        }
        for (const n of view.notices) cli.warn(`${safe(n.path)}: ${safe(n.reason)}`);

        // -- extra confirmations --------------------------------------------------------------
        if (flagged.length > 0 && !o.dryRun) {
          cli.err(
            `${cli.style('red', 'These flagged files can run or fetch code on your machine:')}\n`,
          );
          for (const f of flagged) {
            cli.err(
              `  ${cli.style('bold', safe(f.path))}  - ${safe(f.flags.join('; ') || f.badges.join(', '))}\n`,
            );
          }
          let ok = o.allowFlagged === true;
          if (!ok && cli.interactive) ok = await cli.confirm('Apply these flagged files too?');
          if (!ok) {
            throw new CliError('approval_required', 'flagged files need an explicit confirmation', {
              hint: 'Re-run with --allow-flagged (and --path naming them), or leave them out.',
              details: { flagged: flagged.map((f) => f.path) },
            });
          }
        }
        let allowNonGit = o.allowNonGit === true;
        if (view.target.kind === 'plain' && !o.dryRun && !allowNonGit) {
          cli.warn(
            `${safe(view.target.path ?? '')} is not a git repository: uncommitted work in it cannot be detected`,
          );
          if (cli.interactive) allowNonGit = await cli.confirm('Apply anyway?');
        }
        if (view.target.kind === 'plain' && o.dryRun) allowNonGit = true;

        const selection: ChangeSelection[] = [...chosen.keys()].map((path) => ({ path }));
        const params: ApplyChangesParams = {
          digest: view.digest,
          selection,
          ...(flagged.length > 0 ? { acknowledgeFlagged: flagged.map((f) => f.path) } : {}),
          ...(allowNonGit ? { allowNonGit: true } : {}),
        };

        if (o.dryRun) {
          const r = await rt.abox.applyChanges(cli.caller(), id, { ...params, dryRun: true });
          if (r.status === 'confirmation_required') throw new Error('unexpected confirmation');
          cli.success(r, () => `${planText(r.plan)}\n${r.message}`);
          return;
        }

        const r = await cli.confirmed((caller) => rt.abox.applyChanges(caller, id, params), {
          yes: o.yes,
          explain: async (c) => {
            const plan = (c as { plan?: ApplyPlan }).plan;
            return plan ? { lines: planText(plan).split('\n') } : undefined;
          },
        });
        cli.success(r, () => `${planText(r.plan)}\n${r.message}`);
      },
    );
}
