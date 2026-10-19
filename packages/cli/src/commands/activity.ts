import type { Command } from 'commander';
import { ACTIVITY_KINDS } from '@abox/core';
import type { ActivityEntry, ActivityKind, ActivityView } from '@abox/core';
import type { Cli } from '../cli.js';
import { formatTime, oneLine, renderTable, safe } from '../format.js';
import { resolveSandboxId } from '../ids.js';
import { commaList, invalid, parseSince, positiveInt } from '../parse.js';

function kindsOf(value: string | undefined): ActivityKind[] | undefined {
  const list = commaList(value);
  if (list.length === 0) return undefined;
  for (const k of list)
    if (!(ACTIVITY_KINDS as readonly string[]).includes(k))
      throw invalid(`--kind: unknown kind "${safe(k)}"`, `Use: ${ACTIVITY_KINDS.join(', ')}`);
  return list as ActivityKind[];
}

/** The facts worth a column: the first of them that the entry has, as `key=value`. */
function note(e: ActivityEntry): string {
  const d = e.detail;
  const parts: string[] = [];
  if (e.count > 1) parts.push(`${e.count}x`);
  if (d['exitCode'] !== undefined) parts.push(`exit ${d['exitCode']}`);
  if (typeof d['size'] === 'number') parts.push(`${d['size']} bytes`);
  for (const k of ['reason', 'message', 'note'])
    if (typeof d[k] === 'string') {
      parts.push(String(d[k]));
      break;
    }
  if (e.approvalId) parts.push(`approval ${e.approvalId}`);
  return parts.join(', ');
}

function text(id: string, v: ActivityView): string {
  if (v.entries.length === 0) return `sandbox ${id}: no activity`;
  return [
    renderTable(
      [
        { header: 'TIME' },
        { header: 'KIND' },
        { header: 'OUTCOME' },
        { header: 'ACTOR', max: 16 },
        { header: 'WHAT', max: 70 },
        { header: 'NOTES', max: 60 },
      ],
      v.entries.map((e) => [
        formatTime(e.ts),
        e.kind,
        e.outcome,
        e.actor,
        oneLine(e.summary),
        oneLine(note(e)),
      ]),
    ),
    ...(v.nextCursor ? [`more: pass --cursor ${v.nextCursor} for older entries`] : []),
  ].join('\n');
}

export function registerActivity(program: Command, cli: Cli): void {
  program
    .command('activity')
    .description('Timeline of what happened in a sandbox: commands, files, network, approvals')
    .argument('<sandbox>', 'sandbox id or name')
    .option('--kind <kinds>', `only these kinds, comma separated: ${ACTIVITY_KINDS.join(', ')}`)
    .option('--since <when>', 'only newer entries: a duration (10m, 2h) or an ISO date')
    .option('--limit <n>', 'audit entries per page, newest first (at most 500)', '100')
    .option('--cursor <cursor>', 'continue behind the last entry of the previous page')
    .addHelpText(
      'after',
      `
The timeline is derived from the audit log (nothing else is stored), so it has the audit log's rules: secrets
are masked, file writes show path and size but never content, environment variables only their names. Runs of
identical proxy decisions are merged. See "abox audit" for the raw entries.
`,
    )
    .action(
      async (ref: string, o: { kind?: string; since?: string; limit: string; cursor?: string }) => {
        const id = await resolveSandboxId(cli, ref);
        const rt = await cli.rt();
        const kinds = kindsOf(o.kind);
        const view = await rt.abox.activity(cli.caller(), id, {
          ...(kinds ? { kinds } : {}),
          ...(o.since ? { since: parseSince(o.since, Date.now()) } : {}),
          limit: positiveInt(o.limit, '--limit'),
          ...(o.cursor ? { cursor: o.cursor } : {}),
        });
        cli.success(view, () => text(id, view));
      },
    );
}
