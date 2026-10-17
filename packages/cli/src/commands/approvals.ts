import { basename, dirname } from 'node:path';
import type { Command } from 'commander';
import type { ApprovalView, TemplateReview } from '@abox/core';
import type { Cli } from '../cli.js';
import {
  formatRelative,
  formatTime,
  oneLine,
  renderKeyValues,
  renderTable,
  safe,
} from '../format.js';
import { reviewLines } from '../review.js';

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

/** The template base of a create / trust request, in one line: image and registry, or the Dockerfile (sanitised when printed). */
function baseLine(base: NonNullable<ApprovalView['base']>): string {
  const parts: string[] = [];
  if (base.os !== undefined)
    parts.push(`image ${base.os}${base.registry ? ` (registry ${base.registry})` : ''}`);
  if (base.dockerfile !== undefined)
    parts.push(`Dockerfile ${base.dockerfile} (the images it builds on cannot be checked)`);
  return parts.join('; ');
}

/** Template named by a `template_trust` approval: name, approved content hash, project directory. */
function trustedTemplateOf(
  a: ApprovalView,
): { name: string; contentHash?: string; projectDir?: string } | undefined {
  if (a.kind !== 'template_trust') return undefined;
  const tpl = (a.request as { template?: unknown } | null)?.template as
    { name?: unknown; contentHash?: unknown; source?: { path?: unknown } } | undefined;
  if (!tpl || typeof tpl.name !== 'string') return undefined;
  const path = typeof tpl.source?.path === 'string' ? tpl.source.path : undefined;
  return {
    name: tpl.name,
    ...(typeof tpl.contentHash === 'string' ? { contentHash: tpl.contentHash } : {}),
    // <project>/.sandbox/<file>.yaml
    ...(path && basename(dirname(path)) === '.sandbox'
      ? { projectDir: dirname(dirname(path)) }
      : {}),
  };
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
      // A template the agent wants trusted: show what it does, as a diff, not just its hash.
      let review: TemplateReview | undefined;
      let reviewError: string | undefined;
      const tpl = trustedTemplateOf(x);
      if (tpl) {
        try {
          review = await rt.abox.reviewTemplate(cli.caller(), tpl.name, {
            projectDir: tpl.projectDir ?? cli.projectDir(),
            ...(tpl.contentHash ? { expectedContentHash: tpl.contentHash } : {}),
          });
        } catch (e) {
          reviewError = e instanceof Error ? e.message : String(e);
        }
      }
      cli.success(review ? { ...x, templateReview: review } : x, () => {
        const lines = [
          renderKeyValues([
            ['approval', x.id],
            ['kind', x.kind],
            ['requested by', x.requester],
            ['sandbox', x.sandboxId ?? undefined],
            ['template base', x.base ? baseLine(x.base) : undefined],
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
          ...(x.items.length
            ? [
                cli.style('bold', 'Why approval is needed (computed by abox):'),
                ...x.items.map((i) => `  - [${safe(i.kind)}] ${safe(i.reason)}`),
                '',
              ]
            : []),
          cli.style('bold', 'Risks (computed by abox):'),
          ...(x.risks.length ? x.risks.map((r) => `  ! ${safe(r)}`) : ['  (none listed)']),
        ];
        if (review) lines.push(...reviewLines(cli, review));
        else if (reviewError)
          lines.push('', `Template review not available: ${oneLine(reviewError)}`);
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
