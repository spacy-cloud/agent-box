import type { Command } from 'commander';
import { Option } from 'commander';
import {
  AboxError,
  NETWORK_MODES,
  SANDBOX_STATES,
  WORKSPACE_MODES,
  type CreateSandboxRequest,
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
import { resolveSandboxId } from '../ids.js';
import { commaList, durationMs, positiveNumber, sizeBytes } from '../parse.js';

function ttlText(s: SandboxView): string {
  if (s.state === 'removed' || s.state === 'failed') return '-';
  return s.expired ? 'expired' : formatDuration(s.ttlRemainingMs);
}

function stateText(s: SandboxView): string {
  const flags = [
    s.stale ? 'stale' : '',
    s.expired && s.state !== 'expired' ? 'expired' : '',
  ].filter(Boolean);
  const base = flags.length ? `${s.state} (${flags.join(',')})` : s.state;
  return base;
}

export function registerSandbox(program: Command, cli: Cli): void {
  program
    .command('create')
    .description('Create a sandbox from a template')
    .argument('<template>', 'template name (see "abox template ls")')
    .option('--name <name>', 'sandbox name')
    .option('-w, --workspace <path>', 'host project directory to give the sandbox (e.g. .)')
    .addOption(
      new Option('--mode <mode>', 'how the workspace is delivered').choices([...WORKSPACE_MODES]),
    )
    .option('--ref <ref>', 'git ref for clone/worktree workspaces')
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
        template: string,
        o: {
          name?: string;
          workspace?: string;
          mode?: WorkspaceMode;
          ref?: string;
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
        const workspace: NonNullable<CreateSandboxRequest['workspace']> = {};
        if (o.workspace) workspace.path = cli.resolvePath(o.workspace);
        if (o.mode) workspace.mode = o.mode;
        if (o.ref) workspace.ref = o.ref;
        const req: CreateSandboxRequest = {
          template,
          ...(o.name ? { name: o.name } : {}),
          ...(cli.globals.host ? { host: cli.globals.host } : {}),
          ...(Object.keys(workspace).length > 0 ? { workspace } : {}),
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
          ...(o.requestId ? { requestId: o.requestId } : {}),
          projectDir: cli.projectDir(),
        };
        const signal = cli.abortSignal();
        const started = Date.now();
        const r = await cli.confirmed(
          (caller) =>
            rt.abox.createSandbox(caller, req, {
              signal,
              onProgress: (line) => cli.info(`  ${safe(line)}`),
            }),
          { yes: o.yes },
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
          { ...r, durationMs: elapsed },
          () =>
            `created ${r.sandbox.id}${r.sandbox.name ? ` (${safe(r.sandbox.name)})` : ''} from ${safe(r.sandbox.template)} in ${formatDuration(elapsed)}${r.idempotent ? ' (already existed)' : ''}\n` +
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
    .action(async (o: { state?: SandboxState; all?: boolean }) => {
      const rt = await cli.rt();
      const list = await rt.abox.listSandboxes(cli.caller(), {
        ...(o.state ? { state: o.state } : {}),
        ...(cli.globals.host ? { host: cli.globals.host } : {}),
        ...(o.all ? { includeRemoved: true } : {}),
      });
      cli.success(
        list,
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
                  { header: 'CREATED' },
                ],
                list.sandboxes.map((s) => [
                  s.id,
                  s.name,
                  s.template,
                  stateText(s),
                  s.owner,
                  ttlText(s),
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
            lines.push(
              `host ${safe(h)} is unreachable; its sandboxes are shown as last known (stale)`,
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
