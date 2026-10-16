import type { Command } from 'commander';
import type { AuditEntry, AuditFilter, DoctorReport, GcOrphansReport } from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import {
  formatBytes,
  formatDuration,
  formatRelative,
  formatTime,
  oneLine,
  renderTable,
  safe,
  truncate,
} from '../format.js';
import { resolveSandboxId } from '../ids.js';
import { collect, parseSince, positiveInt } from '../parse.js';

function detailsText(e: AuditEntry): string {
  if (!e.details) return '';
  return Object.entries(e.details)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

function orphanListing(r: GcOrphansReport, now: number): string {
  const lines: string[] = [];
  if (r.resources.length === 0) {
    lines.push('no abox resources of other instances found');
  } else {
    lines.push(
      `${r.resources.length} abox resource(s) that do not belong to this abox home (they may belong to ANOTHER abox home on this machine):`,
      renderTable(
        [
          { header: 'KIND' },
          { header: 'NAME', max: 40 },
          { header: 'INSTANCE', max: 20 },
          { header: 'ABOX NAME', max: 24 },
          { header: 'STATE' },
          { header: 'AGE' },
        ],
        r.resources.map((x) => [
          x.kind,
          x.name,
          x.instance || '(none)',
          x.aboxName ?? '-',
          x.state ?? '-',
          x.createdAt === undefined ? '-' : formatDuration(Math.max(0, now - x.createdAt)),
        ]),
      ),
    );
  }
  const unsupported = r.skipped.filter((s) => s.reason === 'not supported');
  if (unsupported.length > 0)
    lines.push(
      `not searched (not supported): ${unsupported.map((s) => `${s.backend} on ${safe(s.host)}`).join(', ')}`,
    );
  for (const s of r.skipped.filter((s) => s.reason !== 'not supported'))
    lines.push(`not searched: ${s.backend} on ${safe(s.host)}: ${oneLine(s.reason)}`);
  return lines.join('\n');
}

export function registerOps(program: Command, cli: Cli): void {
  // -- audit ---------------------------------------------------------------------------------
  const audit = program
    .command('audit')
    .description('Show the audit log (who did what, tamper-evident)')
    .option('--sandbox <id>', 'only entries about this sandbox')
    .option('--since <when>', 'only newer entries: a duration (1h, 2d) or an ISO date')
    .option('--action <name>', 'only this action (repeatable)', collect)
    .option('--actor <who>', 'only this actor (human, agent:<id>, system)')
    .option('--limit <n>', 'at most N entries (newest)', '50')
    .option('--jsonl', 'print entries as JSON Lines (one object per line)')
    .action(
      async (o: {
        sandbox?: string;
        since?: string;
        action?: string[];
        actor?: string;
        limit: string;
        jsonl?: boolean;
      }) => {
        const rt = await cli.rt();
        const filter: AuditFilter = {
          limit: positiveInt(o.limit, '--limit'),
          ...(o.sandbox ? { sandboxId: await resolveSandboxId(cli, o.sandbox) } : {}),
          ...(o.since ? { since: parseSince(o.since, Date.now()) } : {}),
          ...(o.action?.length ? { action: o.action } : {}),
          ...(o.actor ? { actor: o.actor } : {}),
        };
        if (o.jsonl) {
          // Newest N entries, oldest first.
          const newest = await rt.abox.queryAudit(cli.caller(), { ...filter, order: 'desc' });
          for (const e of newest.reverse()) cli.out(`${JSON.stringify(e)}\n`);
          return;
        }
        const entries = (
          await rt.abox.queryAudit(cli.caller(), { ...filter, order: 'desc' })
        ).reverse();
        cli.success(
          { entries },
          () =>
            entries.length === 0
              ? 'no audit entries'
              : renderTable(
                  [
                    { header: 'SEQ', right: true },
                    { header: 'TIME' },
                    { header: 'ACTOR' },
                    { header: 'ACTION' },
                    { header: 'SANDBOX' },
                    { header: 'DECISION' },
                    { header: 'DETAILS', max: 200 },
                  ],
                  entries.map((e) => [
                    String(e.seq),
                    formatTime(e.ts),
                    e.actor,
                    e.action,
                    e.sandboxId ?? '-',
                    e.decision ?? '-',
                    truncate(detailsText(e), 200),
                  ]),
                  cli.width,
                ),
          () => entries.map((e) => String(e.seq)).join('\n'),
        );
      },
    );

  audit
    .command('verify')
    .description('Check the hash chain of the audit log for tampering')
    .action(async () => {
      const rt = await cli.rt();
      const v = await rt.abox.verifyAudit(cli.caller());
      if (!v.ok) {
        throw new CliError(
          'check_failed',
          `audit log is NOT intact: broken at entry ${v.brokenAt}${v.reason ? ` (${v.reason})` : ''}`,
          {
            hint: 'The log was changed after it was written. Keep a copy of state.db for analysis.',
            details: { verification: v },
          },
        );
      }
      cli.success(v, () => `audit log intact (${v.checked} entries)`);
    });

  // -- doctor / reconcile / gc ----------------------------------------------------------------
  program
    .command('doctor')
    .description(
      'Check backends, permissions, the audit chain and leftovers (exit 1 when any check fails; warnings do not change the exit code)',
    )
    .action(async () => {
      const rt = await cli.rt();
      const full = await rt.abox.doctor(cli.caller());
      const host = cli.globals.host;
      const report: DoctorReport = host
        ? {
            ...full,
            backends: full.backends.filter((b) => b.host === host),
            checks: full.checks.filter(
              (c) =>
                !/^(backend|host|reconcile\.unreachable)\./.test(c.id) ||
                c.id.split('.')[1] === host,
            ),
          }
        : full;
      const rec = report.reconcile;
      const inconsistencies = rec.orphans.length + rec.ghosts.length + rec.interrupted.length;
      const errors = report.checks.filter((c) => c.level === 'error');
      const problems = errors.length + (inconsistencies > 0 ? 1 : 0);
      if (!cli.json) {
        const mark = (l: string): string =>
          l === 'ok'
            ? cli.style('green', 'ok  ')
            : l === 'warn'
              ? cli.style('yellow', 'warn')
              : cli.style('red', 'FAIL');
        for (const c of report.checks) {
          cli.out(
            `[${mark(c.level)}] ${safe(c.title)}${c.detail ? ` - ${oneLine(c.detail)}` : ''}\n`,
          );
          if (c.hint && c.level !== 'ok')
            cli.out(`       ${cli.style('dim', 'hint:')} ${safe(c.hint)}\n`);
        }
        cli.out(
          `\n${problems === 0 ? 'no problems found' : `${problems} problem(s) found`}${report.checks.some((c) => c.level === 'warn') ? ' (see warnings above)' : ''}\n`,
        );
      }
      if (problems > 0) {
        // One rule for scripts: any failed check is exit 1 (code check_failed); the report says which one.
        throw new CliError(
          'check_failed',
          `doctor found ${problems} problem(s)${inconsistencies > 0 ? `; ${rec.interrupted.length} interrupted create(s), ${rec.orphans.length} orphan(s), ${rec.ghosts.length} ghost(s)` : ''}`,
          {
            hint:
              inconsistencies > 0
                ? 'Run "abox reconcile --apply" to clean up.'
                : 'See the failed checks above.',
            details: { report },
          },
        );
      }
      cli.success(report);
    });

  program
    .command('reconcile')
    .description('Compare the registry with the backends; with --apply, clean up leftovers')
    .option(
      '--apply',
      'repair: remove leftovers of interrupted creates, mark missing sandboxes removed',
    )
    .option(
      '--remove-orphans',
      'with --apply: also remove backend sandboxes unknown to the registry',
    )
    .action(async (o: { apply?: boolean; removeOrphans?: boolean }) => {
      const rt = await cli.rt();
      const r = await rt.abox.reconcile(cli.caller(), {
        ...(o.apply ? { apply: true } : {}),
        ...(o.removeOrphans ? { removeOrphans: true } : {}),
      });
      cli.success(r, () => {
        const lines: string[] = [];
        const section = (title: string, items: Array<{ id: string; detail: string }>): void => {
          if (items.length)
            lines.push(`${title}:`, ...items.map((i) => `  ${i.id}  ${safe(i.detail)}`));
        };
        section('interrupted creates', r.interrupted);
        section('orphans (in the backend, not in the registry)', r.orphans);
        section('ghosts (in the registry, not in the backend)', r.ghosts);
        section('expired (not removed yet)', r.expired);
        for (const u of r.unreachable)
          lines.push(`unreachable: ${u.backend} on ${u.host}: ${safe(u.error)}`);
        if (r.pendingApprovals) lines.push(`${r.pendingApprovals} pending approval(s)`);
        if (o.apply) {
          const a = r.applied;
          lines.push(
            `applied: removed ${a.removed.length}, marked failed ${a.markedFailed.length}, marked stale ${a.markedStale.length}, orphans removed ${a.orphansRemoved.length}`,
          );
        } else if (r.interrupted.length + r.orphans.length + r.ghosts.length > 0) {
          lines.push('nothing was changed; run with --apply to clean up');
        }
        return lines.length ? lines.join('\n') : 'registry and backends agree';
      });
    });

  program
    .command('gc')
    .description(
      'Remove expired sandboxes, stale workspaces, unused images and old logs; with --orphans, find and remove leftovers of other abox homes',
    )
    .option('--dry-run', 'only show what would be removed')
    .option(
      '--orphans',
      'instead of the normal cleanup: list abox containers, networks and volumes whose abox.instance is not this home (e.g. left after ABOX_HOME was deleted); they may belong to ANOTHER abox home on this machine; nothing is removed without --yes or a confirmation',
    )
    .option('--instance <id>', 'with --orphans: only resources of this abox.instance')
    .option('-y, --yes', 'with --orphans: remove what is listed without asking')
    .action(
      async (o: { dryRun?: boolean; orphans?: boolean; instance?: string; yes?: boolean }) => {
        if (o.orphans) return gcOrphans(cli, o);
        for (const flag of ['instance', 'yes'] as const)
          if (o[flag] !== undefined)
            throw new CliError('invalid_input', `--${flag} only works together with --orphans`);
        const rt = await cli.rt();
        const r = await rt.abox.gc(cli.caller(), { ...(o.dryRun ? { dryRun: true } : {}) });
        cli.success(r, () => {
          const verb = r.dryRun ? 'would remove' : 'removed';
          const images = r.images.reduce((n, i) => n + i.refs.length, 0);
          const lines = [
            `${verb}: ${r.sandboxes.length} sandbox(es), ${r.workspaces.length} workspace dir(s), ${images} image(s), ${r.logs.files} log file(s) (${formatBytes(r.logs.bytes)})`,
          ];
          if (r.approvalsExpired) lines.push(`${r.approvalsExpired} overdue approval(s) expired`);
          for (const s of r.sandboxes) lines.push(`  sandbox ${s}`);
          for (const e of r.errors) lines.push(`  error: ${safe(e)}`);
          return lines.join('\n');
        });
      },
    );

  /** `abox gc --orphans`: list (default), then remove after --yes or an interactive confirmation. */
  async function gcOrphans(
    cli: Cli,
    o: { dryRun?: boolean; instance?: string; yes?: boolean },
  ): Promise<void> {
    if (o.dryRun && o.yes)
      throw new CliError('invalid_input', '--dry-run and --yes exclude each other');
    const rt = await cli.rt();
    const filter = o.instance !== undefined ? { instance: o.instance } : {};
    const remove = (): Promise<GcOrphansReport> =>
      rt.abox.gcOrphans(cli.caller(), { ...filter, remove: true });
    if (cli.json) {
      cli.success(o.yes ? await remove() : await rt.abox.gcOrphans(cli.caller(), filter));
      return;
    }
    let report = o.yes ? await remove() : await rt.abox.gcOrphans(cli.caller(), filter);
    if (cli.quiet && !o.yes) return;
    if (!cli.quiet) cli.out(`${orphanListing(report, Date.now())}\n`);
    if (!o.yes) {
      if (report.resources.length === 0 || o.dryRun) return;
      if (!cli.interactive) {
        cli.out('nothing was removed; re-run with --yes to remove the resources listed above\n');
        return;
      }
      if (!(await cli.confirm(`Remove ${report.resources.length} resource(s)?`))) {
        cli.out('nothing was removed\n');
        return;
      }
      report = await remove();
    }
    cli.success(report, () => {
      const lines = [`removed ${report.removed.length} of ${report.resources.length} resource(s)`];
      for (const e of report.errors) lines.push(`  error: ${safe(e)}`);
      return lines.join('\n');
    });
  }

  // -- tokens ---------------------------------------------------------------------------------
  const token = program
    .command('token')
    .description('Tokens for the MCP HTTP server (one per client)');

  token
    .command('create')
    .description('Create a token for an agent context; the token is shown once')
    .argument('<context>', 'agent context from policy.yaml (e.g. orca)')
    .option('--label <text>', 'what the token is for', 'created with abox token create')
    .action(async (context: string, o: { label: string }) => {
      const rt = await cli.rt();
      const t = await rt.abox.createAgentToken(cli.caller(), context, o.label);
      if (!cli.json && !cli.quiet) {
        cli.err(`token ${t.id} for context ${safe(context)} - it is shown once, store it now:\n`);
      }
      cli.success(
        t,
        () => t.token,
        () => t.token,
      );
    });

  token
    .command('ls')
    .alias('list')
    .description('List tokens (never their values)')
    .action(async () => {
      const rt = await cli.rt();
      const list = await rt.abox.listAgentTokens(cli.caller());
      cli.success(
        { tokens: list },
        () =>
          list.length === 0
            ? 'no tokens'
            : renderTable(
                [
                  { header: 'ID' },
                  { header: 'CONTEXT' },
                  { header: 'LABEL' },
                  { header: 'CREATED' },
                  { header: 'LAST USED' },
                  { header: 'STATUS' },
                ],
                list.map((t) => [
                  t.id,
                  t.contextId,
                  t.label,
                  formatTime(t.createdAt),
                  t.lastUsedAt ? formatRelative(t.lastUsedAt, Date.now()) : 'never',
                  t.revokedAt ? 'revoked' : 'active',
                ]),
                cli.width,
              ),
        () => list.map((t) => t.id).join('\n'),
      );
    });

  token
    .command('revoke')
    .description('Revoke a token')
    .argument('<id>', 'token id')
    .action(async (id: string) => {
      const rt = await cli.rt();
      const revoked = await rt.abox.revokeAgentToken(cli.caller(), id);
      cli.success({ id, revoked }, () =>
        revoked ? `revoked ${id}` : `${id} was not an active token`,
      );
    });
}
