import type { Command } from 'commander';
import type { ApprovalView } from '@abox/core';
import type { Cli } from '../cli.js';
import {
  formatRelative,
  formatTime,
  oneLine,
  renderKeyValues,
  renderTable,
  safe,
} from '../format.js';

function quoteBlock(text: string): string {
  const lines = safe(text).split('\n');
  return lines.map((l) => `    | ${l}`).join('\n');
}

function requestSummary(a: ApprovalView): string {
  const r = a.request as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return '';
  const pick = (k: string): unknown => r[k];
  const parts: string[] = [];
  const tpl = pick('template');
  if (typeof tpl === 'string') parts.push(`template ${tpl}`);
  const cmd = pick('argv') ?? pick('command');
  if (cmd !== undefined) parts.push(`run ${Array.isArray(cmd) ? cmd.join(' ') : String(cmd)}`);
  return parts.join(', ');
}

export function registerApprovals(program: Command, cli: Cli): void {
  const a = program
    .command('approvals')
    .description('Requests from agents that wait for your decision');

  a.command('ls')
    .alias('list')
    .description('List pending approvals')
    .option('-a, --all', 'also show decided and expired ones')
    .action(async (o: { all?: boolean }) => {
      const rt = await cli.rt();
      const list = await rt.abox.listApprovals(
        cli.caller(),
        o.all ? { limit: 200 } : { status: 'pending' },
      );
      const now = Date.now();
      cli.success(
        { approvals: list },
        () =>
          list.length === 0
            ? o.all
              ? 'no approvals'
              : 'no pending approvals'
            : renderTable(
                [
                  { header: 'ID' },
                  { header: 'KIND' },
                  { header: 'AGENT' },
                  { header: 'SANDBOX' },
                  { header: 'STATUS' },
                  { header: 'EXPIRES' },
                  { header: 'REQUEST' },
                ],
                list.map((x) => [
                  x.id,
                  x.kind,
                  x.requester,
                  x.sandboxId ?? '-',
                  x.status,
                  x.status === 'pending'
                    ? formatRelative(x.expiresAt, now)
                    : formatTime(x.decidedAt ?? x.expiresAt),
                  oneLine(requestSummary(x)),
                ]),
                cli.width,
              ),
        () => list.map((x) => x.id).join('\n'),
      );
    });

  a.command('show')
    .description('Show everything about one approval before you decide')
    .argument('<id>', 'approval id')
    .action(async (id: string) => {
      const rt = await cli.rt();
      const x = await rt.abox.getApproval(cli.caller(), id);
      cli.success(x, () => {
        const lines = [
          renderKeyValues([
            ['approval', x.id],
            ['kind', x.kind],
            ['requested by', x.requester],
            ['sandbox', x.sandboxId ?? undefined],
            ['status', x.status],
            ['created', formatTime(x.createdAt)],
            ['expires', `${formatTime(x.expiresAt)} (${formatRelative(x.expiresAt, Date.now())})`],
            [
              'decided',
              x.decidedAt ? `${formatTime(x.decidedAt)} by ${x.decidedBy ?? '?'}` : undefined,
            ],
            ['note', x.decisionNote ?? undefined],
          ]),
          '',
          cli.style(
            'bold',
            'Reason (text written by the agent - untrusted, not verified by abox):',
          ),
          x.reason ? quoteBlock(x.reason) : '    (none given)',
          '',
          cli.style('bold', 'Exact request that would be approved:'),
          safe(JSON.stringify(x.request, null, 2))
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n'),
          '',
          cli.style('bold', 'Risks (computed by abox):'),
          ...(x.risks.length ? x.risks.map((r) => `  ! ${safe(r)}`) : ['  (none listed)']),
        ];
        if (x.status === 'pending') {
          lines.push(
            '',
            `Decide with: abox approvals approve ${x.id}   or   abox approvals deny ${x.id}`,
          );
        }
        return lines.join('\n');
      });
    });

  for (const verb of ['approve', 'deny'] as const) {
    a.command(verb)
      .description(
        verb === 'approve'
          ? 'Approve a request (one-time, bound to the exact request)'
          : 'Deny a request',
      )
      .argument('<id>', 'approval id')
      .option('--note <text>', 'note stored with the decision')
      .action(async (id: string, o: { note?: string }) => {
        const rt = await cli.rt();
        const d =
          verb === 'approve'
            ? await rt.abox.approve(cli.caller(), id, o.note)
            : await rt.abox.deny(cli.caller(), id, o.note);
        cli.success(d, () => {
          const lines = [
            `${d.approval.id}: ${d.approval.status} (${d.approval.kind} by ${d.approval.requester})`,
          ];
          if (d.applied)
            lines.push(`  ${d.applied.ok ? 'applied' : 'NOT applied'}: ${safe(d.applied.message)}`);
          return lines.join('\n');
        });
      });
  }
}
