import type { Command } from 'commander';
import { Option } from 'commander';
import {
  AboxError,
  NETWORK_MODES,
  SANDBOX_STATES,
  WORKSPACE_MODES,
  describeFit,
  type CreateSandboxRequest,
  type FitEstimate,
  type ResourceUsage,
  type TemplateSuggestion,
  type SandboxState,
  type SandboxView,
  type WorkspaceMode,
} from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError, CliExit, describeError } from '../errors.js';
import {
  formatBytes,
  formatDuration,
  formatRelative,
  formatTime,
  renderKeyValues,
  renderTable,
  safe,
} from '../format.js';
import { resolveSandboxId, resolveSnapshot } from '../ids.js';
import { commaList, durationMs, invalid, positiveNumber, sizeBytes } from '../parse.js';
import { reviewLines } from '../review.js';

function ttlText(s: SandboxView): string {
  if (s.state === 'removed' || s.state === 'failed') return '-';
  return s.expired ? 'expired' : formatDuration(s.ttlRemainingMs);
}

function stateText(s: SandboxView): string {
  const flags = [
    s.stale ? 'stale' : '',
    s.expired && s.state !== 'expired' ? 'expired' : '',
    s.humanAttached ? 'human attached' : '',
  ].filter(Boolean);
  const base = flags.length ? `${s.state} (${flags.join(',')})` : s.state;
  return base;
}

/** CPU and memory cells of `ls --stats`; `-` for a sandbox without data (stopped, backend without stats). */
function usageCells(u: ResourceUsage | undefined): string[] {
  if (!u) return ['-', '-'];
  const mem = u.memoryLimitBytes
    ? `${formatBytes(u.memoryBytes)} / ${formatBytes(u.memoryLimitBytes)}`
    : formatBytes(u.memoryBytes);
  return [`${u.cpuPercent.toFixed(1)}%`, mem];
}

/** How long the estimate may delay a create (it is a courtesy: no answer is no estimate). */
const ESTIMATE_MAX_MS = 8000;

/** The fit estimate of the sandbox a create is about to make; undefined when it cannot be made quickly. */
async function estimateBeforeCreate(
  rt: Awaited<ReturnType<Cli['rt']>>,
  cli: Cli,
  req: CreateSandboxRequest,
): Promise<FitEstimate | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const o = req.overrides;
    return await Promise.race([
      rt.abox.estimateFit(cli.caller(), {
        ...(req.host ? { hostId: req.host } : {}),
        template: req.template,
        ...(o?.cpus !== undefined || o?.memory !== undefined
          ? {
              overrides: {
                ...(o.cpus !== undefined ? { cpus: o.cpus } : {}),
                ...(o.memory !== undefined ? { memory: o.memory } : {}),
              },
            }
          : {}),
        ...(req.projectDir ? { projectDir: req.projectDir } : {}),
        ...(req.workspace?.path ? { workspacePath: req.workspace.path } : {}),
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ESTIMATE_MAX_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined; // a bad template or host is reported by the create itself
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The template `create --auto` takes for `dir`, and why. Fails clearly when nothing matches (or the only matches
 * are templates that do not exist or that the policy does not allow): a guess would be a wrong sandbox.
 */
async function autoTemplate(
  rt: Awaited<ReturnType<Cli['rt']>>,
  cli: Cli,
  dir: string,
): Promise<{ template: string; suggestion: TemplateSuggestion }> {
  const suggestion = await rt.abox.suggestTemplate(cli.caller(), { path: dir });
  const primary = suggestion.primary;
  if (!primary) {
    const left = suggestion.skipped.map(
      (x) =>
        `${x.template} (${x.files.join(', ')}; ${x.why === 'not_allowed' ? 'not allowed by the policy' : 'no such template'})`,
    );
    throw new AboxError(
      'not_found',
      `--auto found no template for ${safe(suggestion.path)}${left.length > 0 ? `; matched but unusable: ${left.join('; ')}` : ': no known marker file (package.json, Cargo.toml, pubspec.yaml, pyproject.toml, composer.json, ...) and no .sandbox/*.yaml'}`,
      { hint: 'Name the template ("abox template ls" lists them) or add a .sandbox/<name>.yaml.' },
    );
  }
  cli.info(
    `auto: using template ${safe(primary.template)} for ${safe(suggestion.path)}: ${safe(primary.reason)}`,
  );
  if (suggestion.alternatives.length > 0)
    cli.info(`  also possible: ${suggestion.alternatives.map((a) => safe(a.template)).join(', ')}`);
  return { template: primary.template, suggestion };
}

export function registerSandbox(program: Command, cli: Cli): void {
  program
    .command('create')
    .description('Create a sandbox from a template')
    .argument(
      '[template]',
      'template name (see "abox template ls"); default: defaults.template of config.yaml',
    )
    .option(
      '--auto',
      'pick the template from the project: its .sandbox/*.yaml first, else marker files (package.json, Cargo.toml, ...) in --workspace (default: the project directory); says which and why',
    )
    .option('--name <name>', 'sandbox name')
    .option(
      '--from-snapshot <snapshot>',
      'start from the files of a snapshot (an id from "abox snapshot ls --all", or <sandbox>:<name>): its template is the default, the workspace stays as the snapshot has it; network, limits and policy are those of this command',
    )
    .option(
      '-w, --workspace <path>',
      'host project directory to give the sandbox (e.g. "-w ."); without it the workspace is empty - nothing of the current directory is shared',
    )
    .addOption(
      new Option(
        '--mode <mode>',
        'how the workspace is delivered (default: the template\'s mode with --workspace, "empty" without)',
      ).choices([...WORKSPACE_MODES]),
    )
    .option('--ref <ref>', 'git ref for clone/worktree workspaces (needs --workspace)')
    .option(
      '--exclude <patterns>',
      'leave these out of a copy/sync workspace (on top of .gitignore), comma separated, gitignore-like (e.g. "node_modules,*.log"; needs --workspace)',
    )
    .option(
      '--gitignore',
      'copy/sync workspace: leave out what .gitignore files ignore (node_modules, build output, .env...); the default',
    )
    .option(
      '--no-gitignore',
      'copy/sync workspace: copy everything, ignored files included (needs --workspace)',
    )
    .option(
      '--no-cache',
      'do not mount the template\'s package caches (pnpm store, Cargo registry, ...): a clean install; see "abox cache"',
    )
    .addOption(new Option('--net <mode>', 'network mode').choices([...NETWORK_MODES]))
    .option(
      '--allow <domains>',
      'extra allowed destinations, comma separated (with --net allowlist)',
    )
    .option('--ttl <duration>', 'lifetime, e.g. 2h')
    .option('--cpus <n>', 'CPU limit')
    .option('--memory <size>', 'memory limit, e.g. 4g')
    .option('--request-id <id>', 'idempotency key: repeating the call returns the same sandbox')
    .option('-y, --yes', 'confirm risky settings without asking (required when not interactive)')
    .action(
      async (
        templateArg: string | undefined,
        o: {
          auto?: boolean;
          name?: string;
          fromSnapshot?: string;
          workspace?: string;
          mode?: WorkspaceMode;
          ref?: string;
          exclude?: string;
          gitignore?: boolean;
          cache?: boolean;
          net?: (typeof NETWORK_MODES)[number];
          allow?: string;
          ttl?: string;
          cpus?: string;
          memory?: string;
          requestId?: string;
          yes?: boolean;
        },
      ) => {
        const rt = await cli.rt();
        if (o.auto && templateArg) {
          throw invalid(
            '--auto and a template name exclude each other',
            'Either name the template, or let --auto pick it from the project.',
          );
        }
        if (o.auto && o.fromSnapshot) {
          throw invalid(
            '--auto and --from-snapshot exclude each other',
            'A sandbox created from a snapshot uses the template of that snapshot.',
          );
        }
        // The folder to look at is the one that is shared (-w), else the project directory; sharing stays opt-in.
        const auto = o.auto
          ? await autoTemplate(
              rt,
              cli,
              o.workspace ? cli.resolvePath(o.workspace) : cli.projectDir(),
            )
          : undefined;
        const fromSnapshot = o.fromSnapshot
          ? await resolveSnapshot(cli, o.fromSnapshot)
          : undefined;
        const template =
          auto?.template ??
          templateArg ??
          fromSnapshot?.template ??
          rt.abox.config.defaults.template;
        if (!template) {
          throw invalid(
            'no template given',
            'Pass a template ("abox template ls" lists them), use --auto, or set defaults.template in config.yaml.',
          );
        }
        const network: NonNullable<NonNullable<CreateSandboxRequest['overrides']>['network']> = {};
        if (o.net) network.mode = o.net;
        const allow = commaList(o.allow);
        if (allow.length > 0) network.allow = allow;
        const overrides: NonNullable<CreateSandboxRequest['overrides']> = {};
        if (Object.keys(network).length > 0) overrides.network = network;
        if (o.ttl) overrides.ttl = durationMs(o.ttl, '--ttl');
        if (o.cpus) overrides.cpus = positiveNumber(o.cpus, '--cpus');
        if (o.memory) {
          sizeBytes(o.memory, '--memory');
          overrides.memory = o.memory;
        }
        // Never fall back to the current directory silently: sharing a project is an explicit choice.
        const workspace: NonNullable<CreateSandboxRequest['workspace']> = {};
        if (o.workspace) {
          workspace.path = cli.resolvePath(o.workspace);
          if (o.mode) workspace.mode = o.mode;
        } else {
          if ((o.mode && o.mode !== 'empty') || o.ref || o.exclude || o.gitignore !== undefined) {
            throw invalid(
              `${o.ref ? '--ref' : o.exclude ? '--exclude' : o.gitignore !== undefined ? (o.gitignore ? '--gitignore' : '--no-gitignore') : `--mode ${o.mode}`} needs a project directory`,
              'Add --workspace <path> (for example "-w ."), or leave both out for an empty workspace.',
            );
          }
          workspace.mode = 'empty';
        }
        if (o.ref) workspace.ref = o.ref;
        const exclude = commaList(o.exclude);
        if (exclude.length > 0) workspace.exclude = exclude;
        if (o.gitignore !== undefined) workspace.gitignore = o.gitignore;
        const req: CreateSandboxRequest = {
          template,
          ...(o.name ? { name: o.name } : {}),
          ...(cli.globals.host ? { host: cli.globals.host } : {}),
          workspace,
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
          ...(o.requestId ? { requestId: o.requestId } : {}),
          ...(o.cache === false ? { cache: false } : {}),
          projectDir: cli.projectDir(),
        };
        // Does it fit? One line on stderr for a person, the whole estimate in --json. A ceiling from limits and
        // reservations, not a prediction of speed. Not asked for scripts that read neither.
        const estimate =
          cli.interactive || cli.json ? await estimateBeforeCreate(rt, cli, req) : undefined;
        if (estimate && cli.interactive && !cli.quiet) {
          const line = describeFit(estimate);
          cli.err(
            `${estimate.tone === 'info' ? line : cli.style(estimate.tone === 'warn' ? 'yellow' : 'red', line)}\n`,
          );
          for (const w of estimate.warnings) cli.err(`  ! ${safe(w.message)}\n`);
        }
        const signal = cli.abortSignal();
        const started = Date.now();
        const r = await cli.confirmed(
          (caller) => {
            const opts = { signal, onProgress: (line: string) => cli.info(`  ${safe(line)}`) };
            return fromSnapshot
              ? rt.abox.createFromSnapshot(
                  caller,
                  { sandboxId: fromSnapshot.sandboxId, snapshotId: fromSnapshot.id },
                  req,
                  opts,
                )
              : rt.abox.createSandbox(caller, req, opts);
          },
          {
            yes: o.yes,
            // A project template is foreign input: show what it does before the human trusts it.
            explain: async (c) => {
              if (!c.items.some((i) => i.kind === 'template_trust')) return undefined;
              const review = await rt.abox.reviewTemplate(cli.caller(), template, {
                projectDir: cli.projectDir(),
                ...(workspace.path ? { workspacePath: workspace.path } : {}),
              });
              return { lines: reviewLines(cli, review), details: { templateReview: review } };
            },
          },
        );
        if (r.status === 'pending_approval') {
          throw new CliError('approval_required', r.message, {
            hint: `Approve with "abox approvals approve ${r.approvalId}" and repeat the command.`,
            details: { approvalId: r.approvalId, reasons: r.reasons, risks: r.risks },
          });
        }
        const elapsed = Date.now() - started;
        for (const w of r.warnings) cli.warn(safe(w));
        cli.success(
          {
            ...r,
            durationMs: elapsed,
            ...(estimate ? { estimate } : {}),
            ...(auto ? { auto: auto.suggestion } : {}),
          },
          () =>
            `created ${r.sandbox.id}${r.sandbox.name ? ` (${safe(r.sandbox.name)})` : ''} from ${safe(r.sandbox.template)}${fromSnapshot ? ` (snapshot ${safe(fromSnapshot.name)})` : ''} in ${formatDuration(elapsed)}${r.idempotent ? ' (already existed)' : ''}\n` +
            `  state ${r.sandbox.state}, network ${r.sandbox.network.mode}, expires in ${formatDuration(r.sandbox.ttlRemainingMs)}\n` +
            `  next: abox exec ${r.sandbox.id} -- <command>   |   abox shell ${r.sandbox.id}`,
          () => r.sandbox.id,
        );
      },
    );

  program
    .command('ls')
    .alias('list')
    .description('List sandboxes')
    .addOption(new Option('--state <state>', 'only this state').choices([...SANDBOX_STATES]))
    .option('-a, --all', 'include removed and failed sandboxes')
    .option('--stats', 'show live CPU and memory use of running sandboxes (takes a second)')
    .action(async (o: { state?: SandboxState; all?: boolean; stats?: boolean }) => {
      const rt = await cli.rt();
      const list = await rt.abox.listSandboxes(cli.caller(), {
        ...(o.state ? { state: o.state } : {}),
        ...(cli.globals.host ? { host: cli.globals.host } : {}),
        ...(o.all ? { includeRemoved: true } : {}),
      });
      const usage = o.stats
        ? (
            await rt.abox.sandboxStats(
              cli.caller(),
              list.sandboxes.filter((s) => s.state === 'running' && !s.stale).map((s) => s.id),
            )
          ).usage
        : undefined;
      cli.success(
        usage ? { ...list, usage } : list,
        () => {
          const lines: string[] = [];
          if (list.sandboxes.length === 0) lines.push('no sandboxes');
          else {
            lines.push(
              renderTable(
                [
                  { header: 'ID' },
                  { header: 'NAME' },
                  { header: 'TEMPLATE' },
                  { header: 'STATE' },
                  { header: 'OWNER' },
                  { header: 'TTL', right: true },
                  ...(usage
                    ? [
                        { header: 'CPU', right: true },
                        { header: 'MEMORY', right: true },
                      ]
                    : []),
                  { header: 'CREATED' },
                ],
                list.sandboxes.map((s) => [
                  s.id,
                  s.name,
                  s.template,
                  stateText(s),
                  s.owner,
                  ttlText(s),
                  ...(usage ? usageCells(usage[s.id]) : []),
                  formatTime(s.createdAt),
                ]),
                cli.width,
              ),
            );
          }
          if (list.orphans.length > 0) {
            lines.push(
              '',
              `${list.orphans.length} orphaned backend sandbox(es) not in the registry: ${list.orphans.map((x) => x.id).join(', ')}`,
              'see "abox doctor" / "abox reconcile"',
            );
          }
          for (const h of list.unreachableHosts) {
            const why = list.hostProblems?.[h];
            const shown = list.sandboxes.some((s) => s.host === h);
            lines.push(
              `host ${safe(h)} is unreachable${why ? ` (${safe(why)})` : ''}${shown ? '; its sandboxes are shown as last known (stale)' : ': this list may be incomplete'}`,
              '  check it with "abox host test"',
            );
          }
          return lines.join('\n');
        },
        () => list.sandboxes.map((s) => s.id).join('\n'),
      );
    });

  program
    .command('inspect')
    .description('Show everything about one sandbox')
    .argument('<id>', 'sandbox id or name')
    .action(async (ref: string) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const s = await rt.abox.inspectSandbox(cli.caller(), id);
      cli.success(s, () => {
        const lines = [
          renderKeyValues([
            ['id', s.id],
            ['name', s.name],
            ['state', stateText(s)],
            ['template', `${s.template} (${s.backend}, isolation ${s.isolation})`],
            ['owner', s.owner],
            ['host', `${s.host}${s.hostReachable ? '' : ' (unreachable)'}`],
            ['created', formatTime(s.createdAt)],
            [
              'expires',
              `${formatTime(s.expiresAt)} (${s.expired ? 'expired' : formatRelative(s.expiresAt, Date.now())})`,
            ],
            ['user', userOf(s.effective)],
            [
              'network',
              `${s.network.mode}${s.network.allow.length ? ` [${s.network.allow.join(', ')}]` : ''}`,
            ],
            [
              'resources',
              `${s.resources.cpus} cpu, ${formatBytes(s.resources.memoryBytes)}${s.resources.pids ? `, ${s.resources.pids} pids` : ''}, ttl ${formatDuration(s.resources.ttlMs)}`,
            ],
            [
              'workspace',
              s.workspace
                ? `${s.workspace.mode} ${s.workspace.sandboxPath} (${s.workspace.access})${s.workspace.source ? ` from ${s.workspace.source}` : ''}${s.workspace.branch ? ` branch ${s.workspace.branch}` : ''}`
                : undefined,
            ],
            [
              'mounts',
              s.mounts.map((m) => `${m.hostPath} -> ${m.target} (${m.access})`).join('; ') ||
                undefined,
            ],
            ['secrets', s.secretRefs.map((r) => `${r.ref} (${r.inject})`).join(', ') || undefined],
            ['processes', s.processes.length ? `${s.processes.length}` : undefined],
            ['ports', s.ports.map((p) => `${p.sandboxPort} -> ${p.url}`).join('; ') || undefined],
            ['approvals', s.pendingApprovals ? `${s.pendingApprovals} pending` : undefined],
            ['error', s.error ?? undefined],
            ['request id', s.requestId ?? undefined],
          ]),
        ];
        if (s.missingInBackend)
          lines.push('note: the backend does not report this sandbox (run "abox reconcile")');
        return lines.join('\n');
      });
    });

  for (const [verb, past] of [
    ['stop', 'stopped'],
    ['start', 'started'],
  ] as const) {
    program
      .command(verb)
      .description(`${verb === 'stop' ? 'Stop' : 'Start'} a sandbox`)
      .argument('<id...>', 'sandbox id(s) or name(s)')
      .action(async (refs: string[]) => {
        const rt = await cli.rt();
        const results: SandboxView[] = [];
        const errors: Array<{ id: string; error: unknown }> = [];
        for (const ref of refs) {
          try {
            const id = await resolveSandboxId(cli, ref);
            results.push(
              verb === 'stop'
                ? await rt.abox.stopSandbox(cli.caller(), id)
                : await rt.abox.startSandbox(cli.caller(), id),
            );
          } catch (e) {
            errors.push({ id: ref, error: e });
          }
        }
        finishMany(
          cli,
          results.map((s) => ({ id: s.id, sandbox: s })),
          errors,
          (r) => `${past} ${r.id} (${r.sandbox.state})`,
        );
      });
  }

  program
    .command('rm')
    .alias('remove')
    .description('Remove sandboxes and everything that belongs to them')
    .argument('<id...>', 'sandbox id(s) or name(s)')
    .option('-f, --force', 'also remove running sandboxes (they are stopped first)')
    .action(async (refs: string[], o: { force?: boolean }) => {
      const rt = await cli.rt();
      const results: Array<{ id: string; removed: boolean }> = [];
      const errors: Array<{ id: string; error: unknown }> = [];
      for (const ref of refs) {
        try {
          const id = await resolveSandboxId(cli, ref);
          const s = await rt.abox.inspectSandbox(cli.caller(), id);
          if (s.state === 'running' && !o.force) {
            throw new AboxError('conflict', `${id} is running`, {
              hint: `Stop it first ("abox stop ${id}") or use --force.`,
            });
          }
          if (s.state === 'running') {
            try {
              await rt.abox.stopSandbox(cli.caller(), id);
            } catch (e) {
              cli.warn(
                `could not stop ${id} cleanly (${describeError(e).body.message}); removing anyway`,
              );
            }
          }
          results.push(await rt.abox.removeSandbox(cli.caller(), id));
        } catch (e) {
          errors.push({ id: ref, error: e });
        }
      }
      finishMany(cli, results, errors, (r) =>
        r.removed ? `removed ${r.id}` : `${r.id} was already removed`,
      );
    });

  program
    .command('extend')
    .description('Give a sandbox more time (added to its current expiry)')
    .argument('<id>', 'sandbox id or name')
    .argument('<duration>', 'additional time, e.g. 1h')
    .option('-y, --yes', 'confirm without asking')
    .action(async (ref: string, duration: string, o: { yes?: boolean }) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const ms = durationMs(duration, '<duration>');
      const r = await cli.confirmed((caller) => rt.abox.extendTtl(caller, id, ms), { yes: o.yes });
      if (r.status === 'pending_approval') {
        throw new CliError('approval_required', r.message, {
          details: { approvalId: r.approvalId, reasons: r.reasons },
        });
      }
      cli.success(
        r,
        () => `${safe(r.message)}\n  expires in ${formatDuration(r.sandbox.ttlRemainingMs)}`,
      );
    });
}

function userOf(effective: Record<string, unknown> | null): string | undefined {
  const provider = effective?.['provider'] as Record<string, unknown> | undefined;
  const user = provider?.['user'];
  return typeof user === 'string' ? user : undefined;
}

/**
 * Reports a batch: all ok -> `{results}`; any failure -> the first failure's exit code (the
 * per-id outcome is in `details.results` / `details.errors` with --json).
 */
export function finishMany<T extends { id: string }>(
  cli: Cli,
  results: T[],
  errors: Array<{ id: string; error: unknown }>,
  line: (r: T) => string,
): void {
  if (errors.length === 0) {
    cli.success(
      { results },
      () => results.map(line).join('\n'),
      () => results.map((r) => r.id).join('\n'),
    );
    return;
  }
  if (results.length + errors.length === 1) throw errors[0]!.error;
  const described = errors.map((e) => ({ id: e.id, ...describeError(e.error) }));
  const first = described[0]!;
  if (!cli.json) {
    for (const r of results) cli.out(`${line(r)}\n`);
    for (const d of described) {
      cli.err(
        `${cli.style('red', 'error')} [${d.body.code}] ${safe(d.id)}: ${safe(d.body.message)}${d.body.hint ? ` (${safe(d.body.hint)})` : ''}\n`,
      );
    }
    throw new CliExit(first.exitCode);
  }
  throw new CliError(
    first.body.code,
    `${errors.length} of ${results.length + errors.length} failed: ${first.body.message}`,
    {
      ...(first.body.hint ? { hint: first.body.hint } : {}),
      details: {
        results,
        errors: described.map((d) => ({ id: d.id, code: d.body.code, message: d.body.message })),
      },
    },
  );
}
