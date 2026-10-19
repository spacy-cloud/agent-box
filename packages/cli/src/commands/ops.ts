import type { Command } from 'commander';
import type {
  AuditEntry,
  AuditFilter,
  DoctorReport,
  GcOrphansReport,
  OrphanInstanceGroup,
} from '@abox/core';
import { summarizeDoctorChecks } from '@abox/core';
import type { Cli } from '../cli.js';
import { renderDoctorChecks, severityOf, summaryText } from '../doctor-format.js';
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
import { collect, invalid, parseSince, positiveInt } from '../parse.js';

/** `abox doctor --for <template>` / `--for host:<id>`: the scoped readiness check. */
async function doctorFor(cli: Cli, target: string, verbose: boolean): Promise<void> {
  const isHost = target.startsWith('host:');
  const name = isHost ? target.slice('host:'.length) : target;
  if (name === '')
    throw invalid(
      isHost ? '--for host: needs a host id (host:<id>)' : '--for needs a template name',
      'Examples: abox doctor --for flutter-dev, abox doctor --for host:build-server',
    );
  if (isHost && cli.globals.host !== undefined && cli.globals.host !== name)
    throw invalid(
      `--host ${safe(cli.globals.host)} and --for host:${safe(name)} name different hosts`,
      'Use one of them.',
    );
  const rt = await cli.rt();
  const report = await rt.abox.doctorFor(
    cli.caller(),
    isHost
      ? { host: name }
      : {
          template: name,
          hostId: cli.host,
          projectDir: cli.projectDir(),
        },
  );
  const problems = report.checks.filter((c) => severityOf(c) === 'error').length;
  if (!cli.json) {
    cli.out(
      `${cli.style('bold', isHost ? `Can host ${safe(name)} run sandboxes?` : `Can ${safe(name)} run on ${safe(cli.host)}?`)}\n\n`,
    );
    cli.out(
      renderDoctorChecks(report.checks, {
        verbose,
        rerun: `abox doctor --for ${safe(target)} --verbose`,
        width: cli.io.stdout.columns ?? 100,
        style: (k, t) => cli.style(k, t),
      }),
    );
    cli.out(
      `\n${problems === 0 ? (isHost ? 'ready' : 'ready to run') : `not ready: ${problems} problem(s)`} (${summaryText(report.summary)})\n`,
    );
  }
  if (problems > 0) {
    throw new CliError(
      'check_failed',
      `${isHost ? `host ${safe(name)}` : safe(name)} is not ready: ${problems} problem(s)`,
      { hint: 'See the failed checks above.', details: { report } },
    );
  }
  cli.success(report);
}

function detailsText(e: AuditEntry): string {
  if (!e.details) return '';
  return Object.entries(e.details)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "instance X looks active (3 running, newest 46s ago) - probably another abox home in use" */
function activeWarning(g: OrphanInstanceGroup, now: number): string {
  const facts = `${g.running} running${g.newestAt === undefined ? '' : `, newest ${formatDuration(Math.max(0, now - g.newestAt))} ago`}`;
  return g.instance === ''
    ? `some resources without an instance label look active (${facts}) - probably another abox home in use; each is judged by its own state`
    : `instance ${safe(g.instance)} looks active (${facts}) - probably another abox home in use`;
}

function orphanListing(cli: Cli, r: GcOrphansReport): string {
  const lines: string[] = [];
  if (r.resources.length === 0) {
    lines.push('no abox resources of other instances found');
  } else {
    lines.push(
      `${r.resources.length} abox resource(s) of ${plural(r.instances.length, 'instance', 'instances')} that do not belong to this abox home (they may belong to ANOTHER abox home on this machine):`,
    );
    for (const g of r.instances) {
      const newest =
        g.newestAt === undefined
          ? ''
          : `, newest ${formatDuration(Math.max(0, r.now - g.newestAt))} ago`;
      lines.push(
        '',
        `${g.instance === '' ? '(no instance label)' : `instance ${safe(g.instance)}`}: ${g.resources} resource(s), ${g.running} running${newest}`,
      );
      if (g.active) lines.push(cli.style('yellow', `  warning: ${activeWarning(g, r.now)}`));
      if (g.skipReason !== undefined)
        lines.push(
          `  skipped by default; --include-active or --instance${g.instance === '' ? " ''" : ` ${safe(g.instance)}`} selects ${g.selected === 0 ? 'it' : 'the rest'}`,
        );
      lines.push(
        renderTable(
          [
            { header: 'KIND' },
            { header: 'NAME', max: 40 },
            { header: 'ABOX NAME', max: 24 },
            { header: 'STATE' },
            { header: 'AGE' },
            { header: 'ACTION' },
          ],
          r.resources
            .filter((x) => x.instance === g.instance)
            .map((x) => [
              x.kind,
              x.name,
              x.aboxName ?? '-',
              x.state ?? '-',
              x.createdAt === undefined ? '-' : formatDuration(Math.max(0, r.now - x.createdAt)),
              x.skip === undefined ? 'remove' : 'skip (active)',
            ]),
        )
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      );
    }
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
      'Check backends, permissions, the audit chain and leftovers (exit 1 when any check fails; notes and warnings do not change the exit code)',
    )
    .option('-v, --verbose', 'also print the full details of every check')
    .option(
      '--for <target>',
      'check only whether <template> can run (on --host, default local) or a host can run sandboxes (host:<id>)',
    )
    .addHelpText(
      'after',
      `
Every check has a severity:
  ✓ ok        works
  i info      an advisory note, or an optional component that is not installed or not running
  ! warning   something is degraded and you should probably act on it
  ✗ failed    a check failed (the only severity that makes the exit code 1)
--verbose also prints the detail lines of checks that are ok or info.
With --json each check also has "severity", "details" and "notes", and the report a "summary"
(counts per severity); "level" (ok/warn/error) is kept for scripts.

--for answers "can I run this?" with the same checks and severities, for one target only:
  abox doctor --for flutter-dev           template on this machine (or on --host <id>): backend, isolation,
                                          image, free disk space, network presets and package caches against
                                          your profile and the agent profiles, policy rules, room on the host
  abox doctor --for host:build-server     host: reachability, engines (rootless or not), limits, capacity
It is read-only: nothing is built, pulled or started. Exit 1 when a check fails (warnings do not).`,
    )
    .action(async (o: { verbose?: boolean; for?: string }) => {
      if (o.for !== undefined) {
        await doctorFor(cli, o.for, o.verbose === true);
        return;
      }
      const rt = await cli.rt();
      const full = await rt.abox.doctor(cli.caller());
      const host = cli.globals.host;
      const filtered: DoctorReport = host
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
      const report: DoctorReport = { ...filtered, summary: summarizeDoctorChecks(filtered.checks) };
      const rec = report.reconcile;
      const inconsistencies = rec.orphans.length + rec.ghosts.length + rec.interrupted.length;
      const errors = report.checks.filter((c) => severityOf(c) === 'error');
      const problems = errors.length + (inconsistencies > 0 ? 1 : 0);
      if (!cli.json) {
        cli.out(
          renderDoctorChecks(report.checks, {
            verbose: o.verbose === true,
            width: cli.io.stdout.columns ?? 100,
            style: (k, t) => cli.style(k, t),
          }),
        );
        cli.out(
          `\n${problems === 0 ? 'no problems found' : `${problems} problem(s) found`} (${summaryText(report.summary)})\n`,
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
      'Remove expired sandboxes, stale workspaces, unused images, package caches that are old or above their cap, and old logs; with --orphans, find and remove leftovers of other abox homes',
    )
    .option('--dry-run', 'only show what would be removed')
    .option(
      '--orphans',
      'instead of the normal cleanup: list abox containers, networks and volumes whose abox.instance is not this home (e.g. left after ABOX_HOME was deleted), grouped by instance; they may belong to ANOTHER abox home on this machine, so instances with running containers or anything created or started less than an hour ago are listed but skipped; nothing is removed without --yes or a confirmation',
    )
    .option(
      '--instance <id>',
      'with --orphans: only resources of this abox.instance; naming an instance also selects it when it looks active',
    )
    .option(
      '--include-active',
      'with --orphans: also remove instances that have running containers or resources created or started less than an hour ago (probably another abox home in use); on a terminal you must type "yes"',
    )
    .option(
      '-y, --yes',
      'with --orphans: remove the stale instances listed without asking (needed when not on a terminal)',
    )
    .action(
      async (o: {
        dryRun?: boolean;
        orphans?: boolean;
        instance?: string;
        includeActive?: boolean;
        yes?: boolean;
      }) => {
        if (o.orphans) return gcOrphans(cli, o);
        for (const flag of ['instance', 'includeActive', 'yes'] as const)
          if (o[flag] !== undefined)
            throw new CliError(
              'invalid_input',
              `--${flag === 'includeActive' ? 'include-active' : flag} only works together with --orphans`,
            );
        const rt = await cli.rt();
        const r = await rt.abox.gc(cli.caller(), { ...(o.dryRun ? { dryRun: true } : {}) });
        cli.success(r, () => {
          const verb = r.dryRun ? 'would remove' : 'removed';
          const images = r.images.reduce((n, i) => n + i.refs.length, 0);
          const lines = [
            `${verb}: ${r.sandboxes.length} sandbox(es), ${r.workspaces.length} workspace dir(s), ${images} image(s), ${r.caches.length} package cache(s), ${r.logs.files} log file(s) (${formatBytes(r.logs.bytes)})`,
          ];
          if (r.approvalsExpired) lines.push(`${r.approvalsExpired} overdue approval(s) expired`);
          for (const s of r.sandboxes) lines.push(`  sandbox ${s}`);
          for (const c of r.caches)
            lines.push(
              `  cache ${c.key} (${safe(c.stack)}/${safe(c.name)}, ${safe(c.project)}): ${c.reason === 'age' ? 'unused for too long' : 'above the size cap of the project'}${c.sizeBytes === null ? '' : `, ${formatBytes(c.sizeBytes)}`}`,
            );
          for (const e of r.errors) lines.push(`  error: ${safe(e)}`);
          return lines.join('\n');
        });
      },
    );

  /** `abox gc --orphans`: list (default), then remove after --yes or an interactive confirmation. */
  async function gcOrphans(
    cli: Cli,
    o: { dryRun?: boolean; instance?: string; includeActive?: boolean; yes?: boolean },
  ): Promise<void> {
    if (o.dryRun && o.yes)
      throw new CliError('invalid_input', '--dry-run and --yes exclude each other');
    const rt = await cli.rt();
    const filter = {
      ...(o.instance !== undefined ? { instance: o.instance } : {}),
      ...(o.includeActive ? { includeActive: true } : {}),
    };
    const remove = (): Promise<GcOrphansReport> =>
      rt.abox.gcOrphans(cli.caller(), { ...filter, remove: true });
    if (cli.json) {
      cli.success(o.yes ? await remove() : await rt.abox.gcOrphans(cli.caller(), filter));
      return;
    }
    let report = o.yes ? await remove() : await rt.abox.gcOrphans(cli.caller(), filter);
    if (cli.quiet && !o.yes) return;
    if (!cli.quiet) cli.out(`${orphanListing(cli, report)}\n`);
    const selectable = (r: GcOrphansReport): number => r.resources.filter((x) => !x.skip).length;
    if (!o.yes) {
      const n = selectable(report);
      const skippedGroups = report.instances.filter((g) => g.skipReason !== undefined).length;
      if (n === 0 || o.dryRun) {
        if (n === 0 && skippedGroups > 0 && !cli.quiet)
          cli.out(
            `nothing to remove: ${plural(skippedGroups, 'active instance', 'active instances')} skipped (--include-active or --instance <id> selects them)\n`,
          );
        return;
      }
      if (!cli.interactive) {
        cli.out(
          `nothing was removed; re-run with --yes to remove the ${n} resource(s) marked "remove" above${o.includeActive || o.instance !== undefined ? '' : ' (--instance <id> limits it to one instance)'}\n`,
        );
        return;
      }
      const groups = report.instances.filter((g) => g.selected > 0);
      // Resources of instances that look active are only selected on request: make that explicit.
      const activeGroups = (o.includeActive || o.instance !== undefined ? groups : []).filter(
        (g) => g.active,
      );
      const summary = `Remove ${n} resource(s) of ${
        activeGroups.length === 0
          ? plural(groups.length, 'stale instance', 'stale instances')
          : `${plural(groups.length, 'instance', 'instances')}, ${activeGroups.length} of them ACTIVE (running or newer than 1h)`
      }?${skippedGroups > 0 ? ` (${plural(skippedGroups, 'active instance', 'active instances')} skipped)` : ''}`;
      // Active instances need the whole word: a reflexive "y" must not remove another home's sandboxes.
      const answer = await cli.readLine(
        activeGroups.length > 0 ? `${summary} Type "yes" to remove them: ` : `${summary} [y/N] `,
      );
      const go =
        answer !== undefined &&
        (activeGroups.length > 0 ? answer.trim() === 'yes' : /^\s*(y|yes|j|ja)\s*$/i.test(answer));
      if (!go) {
        cli.out('nothing was removed\n');
        return;
      }
      report = await remove();
    }
    cli.success(report, () => {
      const lines = [
        `removed ${report.removed.length} of ${selectable(report)} resource(s)${report.resources.length > selectable(report) ? `, ${report.resources.length - selectable(report)} skipped` : ''}`,
      ];
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
