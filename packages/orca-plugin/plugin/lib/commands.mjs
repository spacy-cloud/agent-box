// @ts-check
/**
 * The plugin's command handlers. Every handler follows the same pattern: read the focused worktree
 * (when needed), call the abox CLI through `abox-cli.mjs`, and report through a desktop
 * notification, because that is the only output a worker command has in Orca's plugin API.
 *
 * Safety rules that are enforced here (and tested):
 *  - nothing is ever approved, confirmed or removed by the plugin; destructive or confirming
 *    commands are only TYPED into a terminal (never with Enter) or shown for the human to run;
 *  - text typed into a terminal is a single validated line, and only when the focused worktree has
 *    exactly ONE terminal (the API has no "active terminal", so any other choice could hit the
 *    prompt of an agent);
 *  - agent-written approval reasons are not displayed; only abox's own `kind` and `risks` are.
 */
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { AboxCliError } from './abox-cli.mjs';
import { formatDuration, isTypableLine, sanitizeInline, shellLine, shortId } from './format.mjs';
import { HostError } from './host.mjs';
import { findLinked, requestIdFor, sandboxNameFor } from './worktree.mjs';

/** Must equal `contributes.commands[].id` in orca-plugin.json (checked by a test). */
export const COMMAND_IDS = Object.freeze([
  'create-sandbox-for-worktree',
  'open-shell',
  'export-diff',
  'cleanup',
  'start-sandbox',
  'stop-sandbox',
  'list-sandboxes',
  'show-approvals',
  'mcp-setup',
  'doctor',
]);

const MAX_LIST_LINES = 8;
const MAX_EXPORT_FILES_KEPT = 20;
const CLEANUP_STATES = new Set(['stopped', 'expired', 'failed', 'exited']);

/**
 * @typedef {import('./config.mjs').PluginConfig} PluginConfig
 * @typedef {ReturnType<import('./abox-cli.mjs').createAboxCli>} AboxCli
 * @typedef {ReturnType<import('./host.mjs').createHost>} Host
 * @typedef {ReturnType<import('./worktree.mjs').createWorktreeCache>} WorktreeCache
 * @typedef {(key: string, params?: Record<string, string | number>) => string} Translate
 *
 * @typedef {object} Runtime
 * @property {PluginConfig} config
 * @property {AboxCli} abox
 * @property {Translate} t
 * @property {string} configPath
 * @property {string[]} warnings
 *
 * @typedef {object} FsApi
 * @property {typeof mkdir} mkdir
 * @property {typeof chmod} chmod
 * @property {typeof writeFile} writeFile
 * @property {typeof readdir} readdir
 * @property {typeof stat} stat
 * @property {typeof rm} rm
 *
 * @typedef {object} CommandDeps
 * @property {Host} host
 * @property {WorktreeCache} cache
 * @property {() => Promise<Runtime>} getRuntime
 * @property {(message: string) => void} [log]
 * @property {FsApi} [fs]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {() => Date} [now]
 */

/**
 * @param {CommandDeps} deps
 */
export function createCommands(deps) {
  const { host, cache } = deps;
  const log = deps.log ?? (() => {});
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  /** @type {FsApi} */
  const fs = deps.fs ?? { mkdir, chmod, writeFile, readdir, stat, rm };
  /** @type {Set<Promise<void>>} */
  const background = new Set();
  /** @type {Set<string>} */
  const warned = new Set();

  /**
   * Runs long work after the command returned: Orca cancels a worker command after 30 s, an image
   * build takes longer. The result is reported with a notification either way.
   * @param {Runtime} rt
   * @param {() => Promise<void>} job
   */
  function runInBackground(rt, job) {
    const p = job()
      .catch((e) => report(rt, e))
      .catch((e) => log(`report failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        background.delete(p);
      });
    background.add(p);
  }

  /**
   * @param {Runtime} rt
   * @param {unknown} err
   */
  async function report(rt, err) {
    const { t } = rt;
    log(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    /** @type {string[]} */
    const lines = [];
    if (err instanceof HostError && err.code === 'capability_missing') {
      lines.push(t('common.capabilityMissing', { capability: err.capability ?? '?' }));
    } else if (err instanceof AboxCliError) {
      if (err.code === 'abox_not_found')
        lines.push(t('error.abox_not_found', { configPath: rt.configPath }));
      else if (err.code === 'timeout') lines.push(t('error.timeout'));
      else if (err.code === 'policy_denied')
        lines.push(t('error.policy_denied', { message: sanitizeInline(err.message) }));
      else lines.push(t('error.generic', { message: sanitizeInline(err.message) }));
      if (err.hint) lines.push(t('common.hint', { hint: sanitizeInline(err.hint) }));
    } else {
      lines.push(
        t('error.generic', {
          message: sanitizeInline(err instanceof Error ? err.message : String(err)),
        }),
      );
    }
    await host.notify(t('common.error'), lines).catch(() => {});
  }

  /**
   * @param {Runtime} rt
   */
  async function warnAboutConfig(rt) {
    for (const warning of rt.warnings) {
      if (warned.has(warning)) continue;
      warned.add(warning);
      await host
        .notify(
          rt.t('common.pluginName'),
          rt.t('common.configWarning', { path: rt.configPath, warning }),
        )
        .catch(() => {});
    }
  }

  /**
   * @param {(rt: Runtime) => Promise<void>} fn
   */
  function command(fn) {
    return async () => {
      /** @type {Runtime | undefined} */
      let rt;
      try {
        rt = await deps.getRuntime();
        await warnAboutConfig(rt);
        await fn(rt);
        return { ok: true };
      } catch (e) {
        if (rt) await report(rt, e).catch(() => {});
        else log(`runtime failed: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false };
      }
    };
  }

  /**
   * The focused worktree as far as the host API shows it.
   * @param {Runtime} rt
   * @param {{quiet?: boolean}} [opts] quiet: no notification when nothing is focused
   */
  async function focused(rt, opts = {}) {
    const ctx = await host.readContext();
    if (!ctx) {
      if (!opts.quiet) await host.notify(rt.t('common.pluginName'), rt.t('common.noWorktree'));
      return null;
    }
    const name = ctx.branch || ctx.displayName;
    return {
      branch: ctx.branch,
      name,
      displayName: ctx.displayName,
      terminals: ctx.terminals,
      path: await cache.resolvePath(ctx.branch),
    };
  }

  /** @typedef {NonNullable<Awaited<ReturnType<typeof focused>>>} Worktree */

  /**
   * The one sandbox that belongs to the focused worktree, or a notification why there is none.
   * @param {Runtime} rt
   * @param {Worktree} wt
   */
  async function linkedSandbox(rt, wt) {
    const { sandboxes } = await rt.abox.listSandboxes();
    const linked = findLinked(sandboxes, { path: wt.path, branch: wt.name });
    const first = linked[0];
    if (!first) {
      await host.notify(rt.t('common.pluginName'), rt.t('link.none'));
      return null;
    }
    if (linked.length > 1) {
      await host.notify(
        rt.t('common.pluginName'),
        rt.t('link.ambiguous', {
          ids: linked.map((s) => shortId(s.id)).join(', '),
          command: shellLine([rt.abox.bin, 'shell', first.id]),
        }),
      );
      return null;
    }
    return first;
  }

  /**
   * Types `line` into the worktree's only terminal (without Enter), or shows it.
   * @param {Runtime} rt
   * @param {Worktree} wt
   * @param {string} line
   * @param {{typed: string, copy: string, extra?: Record<string, string | number>}} keys
   */
  async function deliver(rt, wt, line, keys) {
    const params = { ...keys.extra, command: sanitizeInline(line, 600) };
    const onlyTerminal = wt.terminals.length === 1 ? wt.terminals[0] : undefined;
    if (onlyTerminal && host.has('terminal:send') && isTypableLine(line)) {
      try {
        if (await host.sendText(onlyTerminal, line)) {
          await host.notify(rt.t('common.pluginName'), rt.t(keys.typed, params));
          return 'typed';
        }
      } catch (e) {
        log(`sendText failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await host.notify(rt.t('common.pluginName'), rt.t(keys.copy, params));
    return 'shown';
  }

  /**
   * @param {Runtime} rt
   * @param {string | null} project worktree path, so project templates are listed too
   * @returns {Promise<string | null>}
   */
  async function pickTemplate(rt, project) {
    if (rt.config.defaultTemplate) return rt.config.defaultTemplate;
    const usable = (await rt.abox.listTemplates(project ? { project } : {})).filter(
      (x) => x.usable,
    );
    if (usable.length === 0) {
      await host.notify(rt.t('common.pluginName'), rt.t('create.noTemplates'));
      return null;
    }
    const only = usable[0];
    if (usable.length === 1 && only) return only.name;
    await host.notify(
      rt.t('common.pluginName'),
      rt.t('create.chooseTemplate', {
        names: usable
          .slice(0, 8)
          .map((x) => x.name)
          .join(', '),
        configPath: rt.configPath,
      }),
    );
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // commands
  // ---------------------------------------------------------------------------------------------

  const handlers = {
    /** "Create sandbox for this worktree": `abox create <template> --mode worktree --workspace <path>`. */
    'create-sandbox-for-worktree': command(async (rt) => {
      const wt = await focused(rt);
      if (!wt) return;
      const template = await pickTemplate(rt, wt.path);
      if (!template) return;
      const name = sandboxNameFor(wt.name);
      const requestId = requestIdFor(wt.path ?? `branch:${wt.name}`);
      const bin = rt.abox.bin;

      if (!wt.path) {
        // Unknown path: let the shell find it. `git rev-parse --show-toplevel` is the worktree root.
        const line = shellLine([
          bin,
          'create',
          template,
          '--mode',
          'worktree',
          '--workspace',
          { raw: '"$(git rev-parse --show-toplevel)"' },
          '--name',
          name,
          '--request-id',
          requestId,
        ]);
        await deliver(rt, wt, line, { typed: 'terminal.typed', copy: 'create.noPath' });
        return;
      }

      const workspace = wt.path;
      await host.notify(
        rt.t('common.pluginName'),
        rt.t('create.started', { template: sanitizeInline(template) }),
      );
      runInBackground(rt, async () => {
        try {
          const res = await rt.abox.createSandbox({
            template,
            name,
            workspace,
            project: workspace,
            mode: 'worktree',
            requestId,
            ...(rt.config.ttl ? { ttl: rt.config.ttl } : {}),
          });
          const sb = res.sandbox;
          const id = sb?.id ?? name;
          await host.notify(
            rt.t(res.idempotent ? 'create.titleExisting' : 'create.title', { id: shortId(id) }),
            [
              rt.t('create.body', {
                worktree: sanitizeInline(wt.displayName || wt.name, 80),
                name: sanitizeInline(sb?.name || name, 80),
                state: sanitizeInline(sb?.state ?? 'created', 24),
                ttl: formatDuration(sb?.ttlRemainingMs),
                shell: sanitizeInline(shellLine([bin, 'shell', id]), 200),
              }),
              ...res.warnings.slice(0, 2).map((w) => sanitizeInline(w, 160)),
            ],
          );
        } catch (e) {
          if (e instanceof AboxCliError && e.code === 'approval_required') {
            const details = e.details ?? {};
            const approvalId = details['approvalId'];
            if (typeof approvalId === 'string') {
              await host.notify(
                rt.t('common.pluginName'),
                rt.t('create.pendingApproval', { approvalId: sanitizeInline(approvalId, 64) }),
              );
              return;
            }
            // The manager asks for a confirmation the HUMAN has to give. The plugin never adds --yes.
            const reasons = Array.isArray(details['reasons'])
              ? details['reasons'].map((r) => sanitizeInline(r, 140)).join('; ')
              : sanitizeInline(e.message, 300);
            const confirmLine = shellLine([
              bin,
              'create',
              template,
              '--mode',
              'worktree',
              '--workspace',
              workspace,
              '--project',
              workspace,
              '--name',
              name,
              '--request-id',
              requestId,
              '--yes',
            ]);
            await host.notify(
              rt.t('common.pluginName'),
              rt.t('create.needsConfirmation', {
                reasons,
                command: sanitizeInline(confirmLine, 500),
              }),
            );
            return;
          }
          throw e;
        }
      });
    }),

    /** "Open shell": abox cannot hand a TTY to a plugin, so the command is typed into the terminal. */
    'open-shell': command(async (rt) => {
      const wt = await focused(rt);
      if (!wt) return;
      const sb = await linkedSandbox(rt, wt);
      if (!sb) return;
      if (sb.state !== 'running') {
        await host.notify(
          rt.t('common.pluginName'),
          rt.t('shell.notRunning', {
            id: shortId(sb.id),
            state: sanitizeInline(sb.state, 24),
            command: shellLine([rt.abox.bin, 'start', sb.id]),
          }),
        );
        return;
      }
      await deliver(rt, wt, shellLine([rt.abox.bin, 'shell', sb.id]), {
        typed: 'terminal.typed',
        copy: 'terminal.copy',
      });
    }),

    /** "Export diff": `abox export <id> --format diff`; the diff is saved to a private file, never applied. */
    'export-diff': command(async (rt) => {
      const wt = await focused(rt);
      if (!wt) return;
      const sb = await linkedSandbox(rt, wt);
      if (!sb) return;
      await host.notify(rt.t('common.pluginName'), rt.t('export.started', { id: shortId(sb.id) }));
      runInBackground(rt, async () => {
        const res = await rt.abox.exportSandbox(sb.id, { format: 'diff' });
        if (res.content === null) {
          await host.notify(rt.t('common.pluginName'), rt.t('export.noContent', { id: sb.id }));
          return;
        }
        if (res.content.trim() === '' && res.files === 0) {
          await host.notify(
            rt.t('common.pluginName'),
            rt.t('export.empty', { id: shortId(sb.id) }),
          );
          return;
        }
        const file = await saveExport(sb.id, res.content);
        /** @type {string[]} */
        const lines = [
          rt.t('export.body', {
            files: res.files,
            additions: res.stats.additions ?? 0,
            deletions: res.stats.deletions ?? 0,
            path: sanitizeInline(file, 260),
          }),
        ];
        if (res.flagged.length > 0) {
          lines.push(
            rt.t('export.flagged', {
              count: res.flagged.length,
              paths: res.flagged
                .slice(0, 4)
                .map((p) => sanitizeInline(p, 60))
                .join(', '),
            }),
          );
        }
        if (res.contentLossy) lines.push(rt.t('export.lossy'));
        await host.notify(rt.t('export.title', { id: shortId(sb.id) }), lines);
      });
    }),

    /**
     * "Clean up": lists stopped/expired/failed sandboxes and TYPES `abox rm ...` (no Enter). Removing
     * deletes the sandbox workspace, so the plugin never does it itself.
     */
    cleanup: command(async (rt) => {
      const wt = await focused(rt);
      if (!wt) return;
      const { sandboxes } = await rt.abox.listSandboxes({ all: true });
      const linkedIds = new Set(
        findLinked(sandboxes, { path: wt.path, branch: wt.name }).map((s) => s.id),
      );
      const candidates = sandboxes
        .filter((s) => CLEANUP_STATES.has(s.state) || s.expired || s.stale)
        .sort((a, b) => Number(linkedIds.has(b.id)) - Number(linkedIds.has(a.id)));
      if (candidates.length === 0) {
        await host.notify(rt.t('common.pluginName'), rt.t('cleanup.none'));
        return;
      }
      const shown = candidates.slice(0, 10);
      await host.notify(rt.t('cleanup.title', { count: candidates.length }), [
        ...shown.slice(0, MAX_LIST_LINES).map((s) =>
          rt.t('cleanup.line', {
            id: shortId(s.id),
            name: sanitizeInline(s.name, 30),
            state: sanitizeInline(s.state, 20),
          }),
        ),
        ...(shown.length > MAX_LIST_LINES
          ? [rt.t('list.more', { count: shown.length - MAX_LIST_LINES })]
          : []),
      ]);
      await deliver(rt, wt, shellLine([rt.abox.bin, 'rm', ...shown.map((s) => s.id)]), {
        typed: 'cleanup.typed',
        copy: 'cleanup.copy',
      });
    }),

    'start-sandbox': command(async (rt) => {
      const wt = await focused(rt);
      if (!wt) return;
      const sb = await linkedSandbox(rt, wt);
      if (!sb) return;
      await rt.abox.startSandbox(sb.id);
      await host.notify(rt.t('start.title', { id: shortId(sb.id) }));
    }),

    'stop-sandbox': command(async (rt) => {
      const wt = await focused(rt);
      if (!wt) return;
      const sb = await linkedSandbox(rt, wt);
      if (!sb) return;
      await rt.abox.stopSandbox(sb.id);
      await host.notify(rt.t('stop.title', { id: shortId(sb.id) }));
    }),

    /** Overview of all sandboxes (state, remaining TTL) plus the number of pending approvals. */
    'list-sandboxes': command(async (rt) => {
      const [list, approvals] = await Promise.all([
        rt.abox.listSandboxes(),
        rt.abox.listApprovals().catch(() => null),
      ]);
      /** @type {Set<string>} */
      let linkedIds = new Set();
      try {
        const wt = host.has('workspace:read') ? await focused(rt, { quiet: true }) : null;
        if (wt)
          linkedIds = new Set(
            findLinked(list.sandboxes, { path: wt.path, branch: wt.name }).map((s) => s.id),
          );
      } catch {
        /* no worktree context is fine for an overview */
      }
      const sorted = [...list.sandboxes].sort(
        (a, b) =>
          Number(linkedIds.has(b.id)) - Number(linkedIds.has(a.id)) ||
          (a.ttlRemainingMs ?? Infinity) - (b.ttlRemainingMs ?? Infinity),
      );
      const running = sorted.filter((s) => s.state === 'running').length;
      /** @type {string[]} */
      const lines =
        sorted.length === 0
          ? [rt.t('list.empty')]
          : sorted.slice(0, MAX_LIST_LINES).map((s) =>
              rt.t('list.line', {
                mark: linkedIds.has(s.id) ? '> ' : '',
                id: shortId(s.id),
                name: sanitizeInline(s.name, 30),
                state: sanitizeInline(s.state, 20),
                flags: `${s.expired ? ' expired' : ''}${s.stale ? ' stale' : ''}`,
                ttl: formatDuration(s.ttlRemainingMs),
              }),
            );
      if (sorted.length > MAX_LIST_LINES)
        lines.push(rt.t('list.more', { count: sorted.length - MAX_LIST_LINES }));
      if (list.unreachableHosts.length > 0) {
        lines.push(
          rt.t('list.unreachable', {
            hosts: list.unreachableHosts.map((h) => sanitizeInline(h, 40)).join(', '),
          }),
        );
      }
      if (approvals && approvals.pending.length > 0)
        lines.push(rt.t('list.approvals', { count: approvals.pending.length }));
      await host.notify(rt.t('list.title', { count: sorted.length, running }), lines);
    }),

    /** Pending approvals as a hint. Deciding stays in the abox app or CLI (see README). */
    'show-approvals': command(async (rt) => {
      const { pending } = await rt.abox.listApprovals();
      if (pending.length === 0) {
        await host.notify(rt.t('common.pluginName'), rt.t('approvals.none'));
        return;
      }
      /** @type {string[]} */
      const lines = [];
      for (const a of pending.slice(0, 4)) {
        lines.push(
          rt.t('approvals.line', {
            id: sanitizeInline(a.id, 24),
            kind: sanitizeInline(a.kind, 30),
            requester: sanitizeInline(a.requester, 30),
            sandbox: a.sandboxId ? ` (${shortId(a.sandboxId)})` : '',
          }),
        );
        const risk = a.risks[0];
        if (risk) lines.push(rt.t('approvals.risk', { risk: sanitizeInline(risk, 110) }));
      }
      if (pending.length > 4) lines.push(rt.t('approvals.more', { count: pending.length - 4 }));
      lines.push(rt.t('approvals.decide'));
      await host.notify(rt.t('approvals.title', { count: pending.length }), lines);
    }),

    /** MCP wiring summary. The server and tokens are managed by abox; the plugin only explains. */
    'mcp-setup': command(async (rt) => {
      await host.notify(
        rt.t('mcp.title'),
        rt.t('mcp.body', {
          url: rt.config.mcp.url ?? rt.t('mcp.urlPlaceholder', { configPath: rt.configPath }),
          tokenEnv: rt.config.mcp.tokenEnv,
        }),
      );
    }),

    /** `abox doctor`: exits non-zero when it finds problems and then carries the report in `details`. */
    doctor: command(async (rt) => {
      /** @type {unknown} */
      let report;
      try {
        report = await rt.abox.doctor();
      } catch (e) {
        if (e instanceof AboxCliError && e.details && 'report' in e.details)
          report = e.details['report'];
        else throw e;
      }
      const rawChecks = /** @type {{checks?: unknown}} */ (report)?.checks;
      if (!Array.isArray(rawChecks)) {
        await host.notify(
          rt.t('common.pluginName'),
          rt.t('doctor.raw', { text: sanitizeInline(JSON.stringify(report), 600) }),
        );
        return;
      }
      const checks = /** @type {Array<Record<string, unknown>>} */ (rawChecks);
      const bad = checks.filter((c) => c?.['level'] === 'warn' || c?.['level'] === 'error');
      if (bad.length === 0) {
        await host.notify(rt.t('doctor.ok'));
        return;
      }
      await host.notify(
        rt.t('doctor.title', { count: bad.length }),
        bad.slice(0, 6).map((c) => {
          const detail = c['detail'] ?? c['hint'];
          return `${c['level'] === 'error' ? 'FAIL' : 'warn'}: ${sanitizeInline(c['title'] ?? c['id'], 60)}${detail ? ` - ${sanitizeInline(detail, 110)}` : ''}`;
        }),
      );
    }),
  };

  // ---------------------------------------------------------------------------------------------
  // helpers that need the fs
  // ---------------------------------------------------------------------------------------------

  /** `$XDG_STATE_HOME/abox-orca-plugin/exports` (private, 0700). */
  function exportDir() {
    const xdg = env['XDG_STATE_HOME'];
    const base = xdg && isAbsolute(xdg) ? xdg : join(env['HOME'] || homedir(), '.local', 'state');
    return join(base, 'abox-orca-plugin', 'exports');
  }

  /**
   * @param {string} sandboxId
   * @param {string} content
   */
  async function saveExport(sandboxId, content) {
    const dir = exportDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${sandboxId.replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}.diff`);
    await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await pruneExports(dir).catch((e) =>
      log(`prune failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return file;
  }

  /** @param {string} dir */
  async function pruneExports(dir) {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.diff'));
    const withTime = await Promise.all(
      names.map(async (n) => ({ n, t: (await fs.stat(join(dir, n))).mtimeMs })),
    );
    withTime.sort((a, b) => b.t - a.t);
    for (const old of withTime.slice(MAX_EXPORT_FILES_KEPT))
      await fs.rm(join(dir, old.n), { force: true });
  }

  // ---------------------------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------------------------

  /** @param {unknown} payload */
  async function onWorktreeCreated(payload) {
    const p = /** @type {{worktreeId?: unknown, path?: unknown, branch?: unknown}} */ (
      payload ?? {}
    );
    if (typeof p.worktreeId !== 'string' || typeof p.path !== 'string' || !isAbsolute(p.path))
      return;
    await cache.add({
      worktreeId: p.worktreeId,
      path: p.path,
      branch: typeof p.branch === 'string' ? p.branch : '',
    });
  }

  /** @param {unknown} payload */
  async function onWorktreeRemoved(payload) {
    const p = /** @type {{worktreeId?: unknown}} */ (payload ?? {});
    if (typeof p.worktreeId === 'string') await cache.remove(p.worktreeId);
  }

  return {
    handlers,
    onWorktreeCreated,
    onWorktreeRemoved,
    /** Resolves when all background jobs (create, export) have reported. */
    async idle() {
      while (background.size > 0) await Promise.all([...background]);
    },
  };
}
