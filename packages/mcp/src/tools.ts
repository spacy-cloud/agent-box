import { SANDBOX_STATES, WORKSPACE_MODES, NETWORK_MODES } from '@abox/core';
import type {
  AccessRequestInput,
  CreateSandboxRequest,
  ExecParams,
  PendingApproval,
  ProcessView,
  SandboxView,
} from '@abox/core';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BIG_FILE_HINT, WRITE_CONTENT_MAX_CHARS, WRITE_FILE_MAX_BYTES } from './limits.js';
import { durationMs } from './runtime.js';
import type { Runtime } from './runtime.js';
import { fail, invalidInput, ok, truncateText } from './results.js';
import type { ToolOutcome } from './results.js';

// ---------------------------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------------------------

const sandboxId = z
  .string()
  .min(1)
  .max(64)
  .describe('Sandbox id as returned by sandbox_create (looks like local/1a2b3c4d).');
const processId = z
  .string()
  .min(1)
  .max(64)
  .describe('Process id from sandbox_process_start (p1a2b3c4d).');
const duration = z.union([z.number().positive(), z.string().min(1).max(32)]);
const argvSchema = z
  .array(z.string().max(131072))
  .min(1)
  .max(2000)
  .optional()
  .describe('Program and arguments, NO shell (preferred), e.g. ["pnpm","test"].');
const cmdSchema = z
  .string()
  .min(1)
  .max(262144)
  .optional()
  .describe(
    'Shell command line (run with /bin/sh -c). Use only when you need pipes or redirects; give exactly one of argv and cmd.',
  );
const cwdSchema = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe('Working directory inside the sandbox.');
const envSchema = z
  .record(z.string().max(128), z.string().max(32768))
  .optional()
  .describe('Extra environment variables. Never put secrets here.');

/**
 * No workspace given -> an empty one. The server's own working directory is never shared by default
 * (same rule as `abox create`); sharing a project needs an explicit `path`.
 */
function resolveWorkspace(
  w:
    | {
        mode?: string;
        path?: string;
        ref?: string;
        access?: 'ro' | 'rw';
        exclude?: string[];
        gitignore?: boolean;
      }
    | undefined,
): NonNullable<CreateSandboxRequest['workspace']> {
  if (!w || (w.mode === undefined && w.path === undefined && w.ref === undefined)) {
    return { mode: 'empty', ...(w?.access ? { access: w.access } : {}) };
  }
  if (w.path === undefined && w.mode !== 'empty') {
    throw invalidInput(
      `workspace${w.mode ? ` mode "${w.mode}"` : ''} needs a project path`,
      'Pass workspace.path (the host project directory), or omit workspace (or use mode "empty") for an empty workspace.',
    );
  }
  return w as NonNullable<CreateSandboxRequest['workspace']>;
}

// ---------------------------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------------------------

type Shape = z.ZodRawShape;
export type Handler<S extends Shape> = (
  args: z.infer<z.ZodObject<S>>,
  rt: Runtime,
) => Promise<ToolOutcome>;

export interface ToolDef<S extends Shape> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  handler: Handler<S>;
}

/** Wraps a tool into the SDK registration; the transport-level runner is injected by server.ts. */
export type Register = <S extends Shape>(def: ToolDef<S>) => void;

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// ---------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h}h`;
}

function briefSandbox(s: SandboxView): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    template: s.template,
    backend: s.backend,
    isolation: s.isolation,
    state: s.state,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    ttlRemainingMs: s.ttlRemainingMs,
    expired: s.expired,
    stale: s.stale,
    error: s.error,
    workspace: s.workspace,
    network: s.network,
    mounts: s.mounts,
    resources: s.resources,
    ...(s.humanAttached ? { humanAttached: s.humanAttached } : {}),
  };
}

function sandboxLine(s: SandboxView): string {
  const ws = s.workspace ? ` workspace=${s.workspace.mode}:${s.workspace.sandboxPath}` : '';
  const net = ` network=${s.network.mode}${s.network.allow.length ? `(${s.network.allow.length} allowed)` : ''}`;
  const paused = s.humanAttached ? ' PAUSED: a human is working in this sandbox' : '';
  return `${s.id} "${s.name}" [${s.state}${s.stale ? ',stale' : ''}] template=${s.template} isolation=${s.isolation} ttl_left=${fmtMs(s.ttlRemainingMs)}${net}${ws}${paused}`;
}

function processLine(p: ProcessView): string {
  return `${p.id} [${p.status}${p.exitCode !== null ? ` exit=${p.exitCode}` : ''}] ${p.command}`;
}

/** The pending-approval answer shared by create, exec, process start and access requests. */
export function pendingOutcome(p: PendingApproval, tool: string, requestId?: string): ToolOutcome {
  const again = requestId
    ? 'with the same request_id'
    : tool === 'sandbox_create'
      ? 'with identical arguments (pass a request_id next time)'
      : 'with identical arguments';
  const retry =
    tool === 'access_request'
      ? 'then check with sandbox_inspect; do not repeat the request'
      : `then call ${tool} again ${again}`;
  const message = `ask the human to approve with: abox approvals approve ${p.approvalId} — ${retry}`;
  const lines = [
    ...(p.reasons.length ? ['Why approval is needed:', ...p.reasons.map((r) => `- ${r}`)] : []),
    ...(p.risks.length ? ['Risks (computed by abox):', ...p.risks.map((r) => `- ${r}`)] : []),
    `Expires: ${new Date(p.expiresAt).toISOString()} (undecided = denied).`,
  ];
  return {
    ok: false,
    message,
    data: {
      status: 'pending_approval',
      approvalId: p.approvalId,
      kind: p.kind,
      kinds: p.kinds,
      reasons: p.reasons,
      risks: p.risks,
      expiresAt: p.expiresAt,
    },
    text: lines.join('\n'),
  };
}

function unexpectedStatus(status: string): ToolOutcome {
  return fail(
    'policy_denied',
    `this operation needs a human confirmation (${status}) that agents cannot give`,
    undefined,
    'Hint: Ask the human to do it with the abox CLI or GUI.',
  );
}

// ---------------------------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------------------------

export function registerTools(register: Register): void {
  // -- templates ------------------------------------------------------------------------------
  register({
    name: 'template_list',
    title: 'List templates',
    description:
      "List sandbox templates you may use (language/tooling, isolation, network). Call this first and pick one by its description; never invent a template name. Pass workspace_path (the project you will share) to include that project's own templates from its .sandbox directory; they are marked project=true and need human approval until trusted. A project template named like a built-in one hides it (shadows=[builtin]).",
    input: {
      filter: z
        .string()
        .max(100)
        .optional()
        .describe('Case-insensitive text to match in name, description or use-for.'),
      all: z
        .boolean()
        .optional()
        .describe('Also list templates your profile does not allow (default: only usable ones).'),
      workspace_path: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Host project path, the same as workspace.path of sandbox_create: also lists the templates of that project (<path>/.sandbox/*.yaml). Must be below your workspace roots.',
        ),
    },
    annotations: READ,
    async handler(args, rt) {
      const list = await rt.abox.listTemplates(
        rt.caller,
        args.workspace_path !== undefined ? { workspacePath: args.workspace_path } : {},
      );
      const f = args.filter?.trim().toLowerCase();
      const matching = list.templates.filter((t) =>
        f ? [t.name, t.description, t.useFor ?? ''].some((x) => x.toLowerCase().includes(f)) : true,
      );
      const usableOf = (t: (typeof matching)[number]): boolean => t.allowed && t.ready;
      const shown = (args.all ? matching : matching.filter(usableOf)).map((t) => ({
        name: t.name,
        description: t.description.replace(/\s+/g, ' ').trim(),
        useFor: t.useFor,
        backend: t.backend,
        isolation: t.isolation,
        networkMode: t.networkMode,
        usable: usableOf(t),
        source: t.source.kind,
        // project templates come from a repository: a human must approve their content before first use
        project: t.source.kind === 'project',
        trusted: t.trusted,
        needsApproval: !t.trusted,
        // a template that hides one of the same name from a lower level (a project `alpine-min` over the built-in one)
        ...(t.shadows ? { shadows: [...new Set(t.shadows.map((x) => x.kind))] } : {}),
        allowed: t.allowed,
        backendAvailable: t.backendAvailable,
        ready: t.ready,
        ...(t.notReadyReason ? { notReadyReason: t.notReadyReason } : {}),
      }));
      const hidden = matching.length - shown.length;
      return ok(
        `${shown.length} usable template(s)${hidden ? `; ${hidden} more not allowed for you or without backend (all=true shows them)` : ''}`,
        { templates: shown, hiddenCount: hidden },
        shown
          .map(
            (t) =>
              `- ${t.name}${t.project ? ' (project template)' : ''}${t.shadows ? ` (SHADOWS the ${t.shadows.join('/')} template of the same name: this is not the standard one)` : ''}${t.usable ? '' : ` (not usable${t.notReadyReason && t.allowed ? `: ${t.notReadyReason}` : ''})`}${t.needsApproval ? ' (needs human approval first)' : ''}: ${t.description} [isolation=${t.isolation}, network=${t.networkMode}]`,
          )
          .join('\n'),
      );
    },
  });

  register({
    name: 'template_show',
    title: 'Show template',
    description:
      'Show one template in detail with the limits that apply to you (resources, network, mounts, TTL). For a template of a project (source=project) pass the same workspace_path as for template_list; trusted says whether a human approved its current content.',
    input: {
      name: z.string().min(1).max(64).describe('Template name from template_list.'),
      workspace_path: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Host project path, the same as workspace.path of sandbox_create: also looks for the template in <path>/.sandbox. Must be below your workspace roots.',
        ),
    },
    annotations: READ,
    async handler(args, rt) {
      const d = await rt.abox.showTemplate(
        rt.caller,
        args.name,
        args.workspace_path !== undefined ? { workspacePath: args.workspace_path } : {},
      );
      const lim = d.effectiveLimits;
      return ok(
        `Template ${d.template.name}: ${d.allowed ? 'allowed' : 'NOT allowed'} for you` +
          (lim.exceedsProfile.length
            ? `; exceeds your profile: ${lim.exceedsProfile.join(', ')}`
            : ''),
        {
          template: d.template,
          ...(d.shadows ? { shadows: [...new Set(d.shadows.map((x) => x.kind))] } : {}),
          trusted: d.trusted,
          allowed: d.allowed,
          backendAvailable: d.backendAvailable,
          capabilities: d.capabilities,
          effectiveLimits: d.effectiveLimits,
          warnings: d.warnings,
        },
        `cpus=${lim.cpus} memory=${Math.round(lim.memoryBytes / 1048576)}MiB ttl=${fmtMs(lim.ttlMs)} pids=${lim.pids} profile=${lim.profile}` +
          (d.warnings.length ? `\nWarnings:\n${d.warnings.map((w) => `- ${w}`).join('\n')}` : ''),
      );
    },
  });

  // -- sandbox lifecycle -----------------------------------------------------------------------
  register({
    name: 'sandbox_create',
    title: 'Create sandbox',
    description:
      'Create an isolated sandbox from a template (without workspace the sandbox starts empty; pass workspace.path to share a project). Pass a fresh request_id so a retry returns the same sandbox. If it answers status=pending_approval, tell the human to approve, then repeat the identical call.',
    input: {
      template: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Template name from template_list (default: defaults.template of the config).'),
      name: z.string().max(64).optional().describe('Short label (letters, digits, . _ -).'),
      host: z
        .string()
        .max(32)
        .optional()
        .describe('Host id; default local. Only hosts your context allows.'),
      workspace: z
        .strictObject({
          mode: z
            .enum(WORKSPACE_MODES)
            .optional()
            .describe(
              'worktree|clone (git, preferred), copy (plain dir), empty, sync, mount (edits the host dir directly!).',
            ),
          path: z
            .string()
            .min(1)
            .max(4096)
            .optional()
            .describe('Host project path (not needed for empty).'),
          ref: z.string().min(1).max(256).optional().describe('Git ref for worktree/clone.'),
          access: z.enum(['ro', 'rw']).optional(),
          exclude: z
            .array(z.string().min(1).max(512))
            .max(256)
            .optional()
            .describe('Exclude patterns for copy/sync, on top of .gitignore.'),
          gitignore: z
            .boolean()
            .optional()
            .describe(
              'copy/sync only (an error for other modes): leave out what the project .gitignore files ignore (node_modules, build output, .env). Default true; false copies everything.',
            ),
        })
        .optional(),
      overrides: z
        .strictObject({
          cpus: z.number().positive().max(1024).optional(),
          memory: z
            .union([z.string().max(32), z.number().positive()])
            .optional()
            .describe('e.g. "4g" or bytes.'),
          ttl: duration.optional().describe('Duration string like "2h" or seconds.'),
          network: z
            .strictObject({
              mode: z.enum(NETWORK_MODES).optional(),
              allow: z
                .array(z.string().min(1).max(260))
                .max(256)
                .optional()
                .describe('Extra allowed destinations.'),
              presets: z
                .array(z.string().min(1).max(64))
                .max(32)
                .optional()
                .describe('Network presets such as npm, pypi, github.'),
              private_exceptions: z.array(z.string().min(1).max(64)).max(32).optional(),
            })
            .optional(),
          mounts: z
            .array(
              z.strictObject({
                source: z.string().min(1).max(4096),
                target: z.string().min(1).max(4096),
                access: z.enum(['ro', 'rw']).optional(),
              }),
            )
            .max(32)
            .optional()
            .describe('Extra host mounts; usually need approval.'),
        })
        .optional(),
      ttl: duration
        .optional()
        .describe('Lifetime: duration string like "2h" or seconds (same as overrides.ttl).'),
      request_id: z
        .string()
        .max(128)
        .optional()
        .describe(
          'Idempotency key: the same request_id returns the same sandbox. Also used to retry after approval.',
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(args, rt) {
      const o = args.overrides;
      if (
        args.ttl !== undefined &&
        o?.ttl !== undefined &&
        JSON.stringify(args.ttl) !== JSON.stringify(o.ttl)
      ) {
        throw invalidInput('ttl and overrides.ttl differ; give only one', 'Use the top-level ttl.');
      }
      const ttl = args.ttl ?? o?.ttl;
      const overrides: NonNullable<CreateSandboxRequest['overrides']> = {};
      if (o?.cpus !== undefined) overrides.cpus = o.cpus;
      if (o?.memory !== undefined) overrides.memory = o.memory;
      if (ttl !== undefined) overrides.ttl = durationMs(ttl, 'ttl');
      if (o?.network) {
        const n = o.network;
        overrides.network = {
          ...(n.mode ? { mode: n.mode } : {}),
          ...(n.allow ? { allow: n.allow } : {}),
          ...(n.presets ? { presets: n.presets } : {}),
          ...(n.private_exceptions ? { privateExceptions: n.private_exceptions } : {}),
        };
      }
      if (o?.mounts) overrides.mounts = o.mounts;
      const template = args.template ?? rt.abox.config.defaults.template;
      if (!template) {
        throw invalidInput(
          'template is required',
          'Pick one from template_list; no default template is configured.',
        );
      }
      const req: CreateSandboxRequest = {
        template,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.host !== undefined ? { host: args.host } : {}),
        workspace: resolveWorkspace(args.workspace),
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(args.request_id !== undefined ? { requestId: args.request_id } : {}),
      };
      const res = await rt.abox.createSandbox(rt.caller, req, {
        signal: rt.signal,
        onProgress: (line) => rt.progress(line),
        ...(rt.limits.approvalWaitMs !== undefined
          ? { waitForApprovalMs: rt.limits.approvalWaitMs }
          : {}),
      });
      if (res.status === 'pending_approval')
        return pendingOutcome(res, 'sandbox_create', args.request_id);
      if (res.status !== 'created') return unexpectedStatus(res.status);
      return ok(
        `${res.idempotent ? 'Existing sandbox returned (same request_id)' : 'Sandbox created'}: ${res.sandbox.id}`,
        {
          status: 'created',
          idempotent: res.idempotent,
          sandbox: briefSandbox(res.sandbox),
          warnings: res.warnings,
        },
        [sandboxLine(res.sandbox), ...res.warnings.map((w) => `Warning: ${w}`)].join('\n'),
      );
    },
  });

  register({
    name: 'sandbox_list',
    title: 'List sandboxes',
    description:
      'List your own sandboxes with state and remaining lifetime. Use it to find leftovers to delete.',
    input: { state: z.enum(SANDBOX_STATES).optional().describe('Only sandboxes in this state.') },
    annotations: READ,
    async handler(args, rt) {
      const r = await rt.abox.listSandboxes(rt.caller, args.state ? { state: args.state } : {});
      return ok(
        `${r.sandboxes.length} sandbox(es)`,
        {
          sandboxes: r.sandboxes.map(briefSandbox),
          ...(r.unreachableHosts.length ? { unreachableHosts: r.unreachableHosts } : {}),
        },
        r.sandboxes.map(sandboxLine).join('\n'),
      );
    },
  });

  register({
    name: 'sandbox_inspect',
    title: 'Inspect sandbox',
    description:
      'Show state, effective limits (what policy granted vs. what the backend reports), network, mounts, TTL, processes and pending approvals of one of your sandboxes.',
    input: { id: sandboxId },
    annotations: READ,
    async handler(args, rt) {
      const r = await rt.abox.inspectSandbox(rt.caller, args.id);
      const { processes, pendingApprovals, ...view } = r;
      return ok(
        `${r.id} is ${r.state}`,
        { sandbox: view, processes, pendingApprovals },
        [
          sandboxLine(r),
          ...(processes.length
            ? ['Processes:', ...processes.map((p) => `- ${processLine(p)}`)]
            : []),
          ...(pendingApprovals ? [`Pending approvals: ${pendingApprovals}`] : []),
        ].join('\n'),
      );
    },
  });

  register({
    name: 'sandbox_start',
    title: 'Start sandbox',
    description:
      'Resume one of your stopped sandboxes (its workspace and files are kept). Expired sandboxes cannot be started: extend the TTL before it ends (access_request kind ttl) or create a new one.',
    input: { id: sandboxId },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const s = await rt.abox.startSandbox(rt.caller, args.id);
      return ok(`Sandbox ${s.id} is ${s.state}`, { sandbox: briefSandbox(s) }, sandboxLine(s));
    },
  });

  register({
    name: 'sandbox_stop',
    title: 'Stop sandbox',
    description:
      'Stop a sandbox (processes end; workspace is kept until sandbox_delete). Prefer sandbox_delete when you are done.',
    input: { id: sandboxId },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const s = await rt.abox.stopSandbox(rt.caller, args.id);
      return ok(`Sandbox ${s.id} is ${s.state}`, { sandbox: briefSandbox(s) });
    },
  });

  register({
    name: 'sandbox_delete',
    title: 'Delete sandbox',
    description:
      'Remove a sandbox and its workspace copy for good. Export results first (sandbox_export). Always clean up when finished, also after errors.',
    input: { id: sandboxId },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const r = await rt.abox.removeSandbox(rt.caller, args.id);
      return ok(r.removed ? `Sandbox ${r.id} deleted` : `Sandbox ${r.id} was already deleted`, {
        id: r.id,
        removed: r.removed,
      });
    },
  });

  // -- exec -----------------------------------------------------------------------------------
  register({
    name: 'sandbox_exec',
    title: 'Run command',
    description:
      'Run a command in the sandbox and wait for it to finish. Output is capped (~64 KiB per stream) and marked truncated; redirect long output to a file and read it with sandbox_read_file. For servers or long jobs use sandbox_process_start. If a human has taken over the sandbox in a terminal this answers conflict "paused": wait and retry later.',
    input: {
      id: sandboxId,
      argv: argvSchema,
      cmd: cmdSchema,
      cwd: cwdSchema,
      env: envSchema,
      timeout: duration
        .optional()
        .describe(
          'Seconds or a duration string like "90s", "5m". Capped by policy; a timeout kills the process.',
        ),
      stdin: z
        .string()
        .max(8 * 1024 * 1024)
        .optional()
        .describe('Text sent to standard input.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, rt) {
      const params = commandParams(args);
      const exec: ExecParams = {
        ...params,
        ...(args.timeout !== undefined ? { timeoutMs: durationMs(args.timeout, 'timeout') } : {}),
        ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
        maxOutputBytes: rt.limits.maxOutputBytes,
      };
      const res = await rt.abox.exec(rt.caller, args.id, exec, execOptions(rt));
      if (res.status === 'pending_approval') return pendingOutcome(res, 'sandbox_exec');
      if (res.status !== 'completed') return unexpectedStatus(res.status);
      const out = capStreams(res.stdout, res.stderr, rt.limits.maxOutputBytes);
      const truncated = res.truncated || out.truncated;
      const data = {
        status: 'completed',
        exitCode: res.exitCode,
        stdout: out.stdout,
        stderr: out.stderr,
        truncated,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        ...(truncated
          ? {
              hint: 'Output was cut. Do not re-run to see more: redirect to a file (cmd "... > /tmp/out.txt 2>&1") and use sandbox_read_file, or run it with sandbox_process_start and read sandbox_process_logs with tail/since.',
            }
          : {}),
      };
      const text = [
        out.stdout ? `--- stdout ---\n${out.stdout}` : '',
        out.stderr ? `--- stderr ---\n${out.stderr}` : '',
        truncated
          ? '[output truncated: redirect to a file and use sandbox_read_file, or use sandbox_process_logs]'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (res.timedOut) {
        return fail(
          'timeout',
          `command timed out after ${fmtMs(res.durationMs)} and was killed`,
          {
            ...data,
            hint: 'Raise timeout deliberately, or run it with sandbox_process_start and read sandbox_process_logs.',
          },
          text,
        );
      }
      return ok(`exit code ${res.exitCode}`, data, text);
    },
  });

  register({
    name: 'sandbox_process_start',
    title: 'Start background process',
    description:
      'Start a long-running process (server, watcher, long build) in the background. Returns process_id; read output with sandbox_process_logs and end it with sandbox_process_stop.',
    input: { id: sandboxId, argv: argvSchema, cmd: cmdSchema, cwd: cwdSchema, env: envSchema },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, rt) {
      const res = await rt.abox.startProcess(
        rt.caller,
        args.id,
        commandParams(args),
        execOptions(rt),
      );
      if (res.status === 'pending_approval') return pendingOutcome(res, 'sandbox_process_start');
      if (res.status !== 'started') return unexpectedStatus(res.status);
      return ok(
        `Process ${res.process.id} started`,
        { status: 'started', processId: res.process.id, process: res.process },
        processLine(res.process),
      );
    },
  });

  register({
    name: 'sandbox_process_logs',
    title: 'Read process logs',
    description:
      'Read output of a background process. Use tail for the last N lines, or since (byte offset = next_offset of the previous call) to read only new output.',
    input: {
      process_id: processId,
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Byte offset to continue from (next_offset of an earlier call).'),
      tail: z.number().int().positive().max(100000).optional().describe('Only the last N lines.'),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap for this call; limited by policy.'),
    },
    annotations: READ,
    async handler(args, rt) {
      const r = await rt.abox.processLogs(rt.caller, args.process_id, {
        ...(args.since !== undefined ? { sinceBytes: args.since } : {}),
        ...(args.tail !== undefined ? { tail: args.tail } : {}),
        maxBytes: Math.min(
          args.max_bytes ?? rt.limits.maxOutputBytes,
          rt.limits.maxOutputBytes * 4,
        ),
      });
      const c = truncateText(r.content, rt.limits.maxOutputBytes * 4);
      const truncated = r.truncated || c.truncated;
      return ok(
        `process ${r.process.id} is ${r.process.status}; ${Buffer.byteLength(c.text)} bytes${truncated ? ' (truncated)' : ''}`,
        {
          process: r.process,
          content: c.text,
          nextOffset: r.nextOffset,
          size: r.size,
          truncated,
          ...(truncated
            ? { hint: 'Use tail=N for the end of the log, or since=<next_offset> to page forward.' }
            : {}),
        },
        c.text,
      );
    },
  });

  register({
    name: 'sandbox_process_stop',
    title: 'Stop background process',
    description: 'Stop a background process started with sandbox_process_start (TERM, then KILL).',
    input: { process_id: processId },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const p = await rt.abox.stopProcess(rt.caller, args.process_id);
      return ok(`Process ${p.id} is ${p.status}`, { process: p }, processLine(p));
    },
  });

  // -- files ----------------------------------------------------------------------------------
  register({
    name: 'sandbox_read_file',
    title: 'Read file',
    description:
      'Read a file inside the sandbox (paths are sandbox paths; relative paths start at the workspace). Large files are cut at max_bytes and marked truncated; binary files come back base64-encoded.',
    input: {
      id: sandboxId,
      path: z.string().min(1).max(4096).describe('Path inside the sandbox.'),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Default 64 KiB; limited by policy.'),
    },
    annotations: READ,
    async handler(args, rt) {
      const r = await rt.abox.readFile(rt.caller, args.id, args.path, {
        maxBytes: Math.min(
          args.max_bytes ?? rt.limits.maxOutputBytes,
          rt.limits.maxOutputBytes * 4,
        ),
      });
      return ok(
        `${r.path}: ${r.size} bytes${r.truncated ? ' (truncated)' : ''}${r.encoding === 'base64' ? ', binary (base64)' : ''}`,
        {
          path: r.path,
          size: r.size,
          truncated: r.truncated,
          encoding: r.encoding,
          content: r.content,
          ...(r.truncated
            ? {
                hint: 'File is larger than max_bytes; read a part with a command (head/tail/sed) via sandbox_exec.',
              }
            : {}),
        },
        r.content,
      );
    },
  });

  register({
    name: 'sandbox_write_file',
    title: 'Write file',
    description:
      'Write a file inside the sandbox (sandbox paths only; creates or overwrites). Never write secrets. Use encoding=base64 for binary content. Up to 8 MiB of content per call; for bigger files put them in the project workspace or create them inside the sandbox with sandbox_exec. Writes run as the sandbox user: root-owned and abox-managed paths are refused.',
    input: {
      id: sandboxId,
      path: z.string().min(1).max(4096).describe('Path inside the sandbox.'),
      content: z
        .string()
        .max(
          WRITE_CONTENT_MAX_CHARS,
          `content is too large (limit ${WRITE_FILE_MAX_BYTES / (1024 * 1024)} MiB of decoded content). ${BIG_FILE_HINT}`,
        ),
      mode: z
        .string()
        .regex(/^(?:0o?)?[0-7]{3,4}$/, 'octal permission string such as "644" or "755"')
        .optional(),
      encoding: z
        .enum(['utf8', 'base64'])
        .optional()
        .describe('Encoding of content; default utf8.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const mode =
        args.mode !== undefined
          ? Number.parseInt(args.mode.replace(/^0o?/, '') || '0', 8)
          : undefined;
      const bytes =
        args.encoding === 'base64'
          ? Math.floor((args.content.length * 3) / 4) -
            (args.content.endsWith('==') ? 2 : args.content.endsWith('=') ? 1 : 0)
          : Buffer.byteLength(args.content, 'utf8');
      if (bytes > WRITE_FILE_MAX_BYTES) {
        throw invalidInput(
          `content is ${bytes} bytes; sandbox_write_file writes at most ${WRITE_FILE_MAX_BYTES} bytes (${WRITE_FILE_MAX_BYTES / (1024 * 1024)} MiB) per call`,
          BIG_FILE_HINT,
        );
      }
      const r = await rt.abox.writeFile(rt.caller, args.id, args.path, args.content, {
        ...(mode !== undefined ? { mode } : {}),
        ...(args.encoding ? { encoding: args.encoding } : {}),
      });
      return ok(`Wrote ${r.size} bytes to ${r.path}`, { path: r.path, size: r.size });
    },
  });

  register({
    name: 'sandbox_list_dir',
    title: 'List directory',
    description: 'List a directory inside the sandbox (default: the workspace).',
    input: {
      id: sandboxId,
      path: z.string().max(4096).optional().describe('Path inside the sandbox; default workspace.'),
    },
    annotations: READ,
    async handler(args, rt) {
      const entries = await rt.abox.listDir(rt.caller, args.id, args.path);
      const MAX = 1000;
      const shown = entries.slice(0, MAX);
      return ok(
        `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${entries.length > MAX ? ` (first ${MAX} shown)` : ''}`,
        { entries: shown, truncated: entries.length > MAX },
        shown
          .map(
            (e) =>
              `${e.type === 'dir' ? 'd' : e.type === 'symlink' ? 'l' : '-'} ${String(e.size).padStart(10)} ${e.name}`,
          )
          .join('\n'),
      );
    },
  });

  // -- snapshots / export -------------------------------------------------------------------
  register({
    name: 'sandbox_snapshot',
    title: 'Snapshot sandbox',
    description:
      'Save the sandbox state under a name before a risky step. Answers code=unsupported when the backend cannot snapshot; then carry on.',
    input: {
      id: sandboxId,
      name: z.string().min(1).max(64).describe('Snapshot name (letters, digits, . _ -).'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const r = await rt.abox.snapshot(rt.caller, args.id, args.name);
      return ok(`Snapshot ${r.snapshotId} created`, { snapshotId: r.snapshotId, name: args.name });
    },
  });

  register({
    name: 'sandbox_restore',
    title: 'Restore snapshot',
    description:
      'Reset the sandbox to a snapshot (discards changes made since). Pass snapshot_id from sandbox_snapshot (or its name).',
    input: {
      id: sandboxId,
      snapshot_id: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('snapshot_id returned by sandbox_snapshot.'),
      name: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Snapshot name, if snapshot_id is not at hand.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const ref = args.snapshot_id ?? args.name;
      if (!ref)
        throw invalidInput(
          'give snapshot_id (or name)',
          'Use the snapshot_id returned by sandbox_snapshot.',
        );
      const r = await rt.abox.restore(rt.caller, args.id, ref);
      return ok(`Restored snapshot ${r.restored}`, { restored: r.restored });
    },
  });

  register({
    name: 'sandbox_export',
    title: 'Export result',
    description:
      'Hand results back: diff or patch (text), branch (git branch abox/... in the source repo) or files (copied to an abox-owned directory). Nothing is applied to the host project. Show it to the human and report every flagged path (CI files, hooks, build scripts).',
    input: {
      id: sandboxId,
      format: z.enum(['diff', 'patch', 'branch', 'files']),
      paths: z
        .array(z.string().min(1).max(4096))
        .max(1000)
        .optional()
        .describe('Only these paths (relative to the workspace).'),
      branch_name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('format=branch: name; must start with abox/.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const r = await rt.abox.exportSandbox(rt.caller, args.id, {
        format: args.format,
        ...(args.paths ? { paths: args.paths } : {}),
        ...(args.branch_name ? { branchName: args.branch_name } : {}),
      });
      let content = r.content;
      let truncated = false;
      if (content !== undefined) {
        const cap = Math.max(rt.limits.maxOutputBytes * 4, 256 * 1024);
        const c = truncateText(content, cap);
        content = c.text;
        truncated = c.truncated;
      }
      const flagged = r.flagged ?? [];
      const summary = `${args.format} export: ${r.files.length} changed file(s)${flagged.length ? `, ${flagged.length} FLAGGED` : ''}${truncated ? ' (content truncated)' : ''}`;
      return ok(
        summary,
        {
          sandboxId: r.sandboxId,
          format: r.format,
          ...(content !== undefined ? { content } : {}),
          contentLossy: r.contentLossy,
          branch: r.branch,
          commit: r.commit,
          outDir: r.outDir,
          written: r.written,
          files: r.files,
          flagged,
          stats: r.stats,
          warnings: r.warnings,
          truncated,
          ...(truncated
            ? {
                hint: 'The diff is large; export with paths=[...] for parts, or format=files/branch.',
              }
            : {}),
        },
        [
          ...(flagged.length
            ? [
                'FLAGGED paths (can run code on the host once used - point them out to the human):',
                ...flagged.map((f) => `- ${JSON.stringify(f)}`),
              ]
            : []),
          ...(r.branch ? [`branch: ${r.branch}${r.commit ? ` (${r.commit})` : ''}`] : []),
          ...(r.outDir ? [`files written to: ${r.outDir}`] : []),
          ...r.warnings.map((w) => `Warning: ${w}`),
          ...(content !== undefined ? [content] : []),
        ].join('\n'),
      );
    },
  });

  // -- access / policy ------------------------------------------------------------------------
  register({
    name: 'access_request',
    title: 'Request more access',
    description:
      'Ask for more rights for a running sandbox: kind=ttl (details.ttl), resources (details.cpus/memory, up to your limits) or network (details.domains/presets, only for an allowlist sandbox). mount and a new network mode are unsupported on a running sandbox: create a new one. Beyond your profile a human decides; give an honest reason. Do not repeat a pending request; poll with sandbox_inspect.',
    input: {
      id: sandboxId,
      kind: z.enum(['network', 'mount', 'resources', 'ttl']),
      details: z
        .strictObject({
          mode: z.enum(NETWORK_MODES).optional(),
          domains: z
            .array(z.string().min(1).max(260))
            .max(256)
            .optional()
            .describe(
              'network: destinations to allow, e.g. ["pypi.org","files.pythonhosted.org"].',
            ),
          presets: z.array(z.string().min(1).max(64)).max(32).optional(),
          private_exceptions: z.array(z.string().min(1).max(64)).max(32).optional(),
          source: z.string().min(1).max(4096).optional().describe('mount: host path.'),
          target: z.string().min(1).max(4096).optional().describe('mount: path in the sandbox.'),
          access: z.enum(['ro', 'rw']).optional(),
          cpus: z.number().positive().max(1024).optional(),
          memory: z.union([z.string().max(32), z.number().positive()]).optional(),
          ttl: duration.optional().describe('ttl: additional lifetime, e.g. "1h".'),
        })
        .describe('Fields depend on kind.'),
      reason: z
        .string()
        .min(1)
        .max(4000)
        .describe('Why you need it. Shown to the human as untrusted text.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async handler(args, rt) {
      const req = accessInput(args.kind, args.details, args.reason);
      const res = await rt.abox.accessRequest(rt.caller, args.id, req, {
        waitForApprovalMs: rt.limits.approvalWaitMs ?? 0,
        signal: rt.signal,
      });
      if (res.status === 'pending_approval') return pendingOutcome(res, 'access_request');
      if (res.status !== 'applied') return unexpectedStatus(res.status);
      return ok(res.message || `Access (${res.kind}) applied`, {
        status: 'applied',
        kind: res.kind,
        sandbox: briefSandbox(res.sandbox),
      });
    },
  });

  register({
    name: 'policy_show',
    title: 'Show my limits',
    description:
      'Show the limits of your own profile (templates, resources, network, mounts, TTL, approvals). Read-only; agents cannot change policy.',
    input: {},
    annotations: READ,
    async handler(_args, rt) {
      const v = await rt.abox.showPolicy(rt.caller);
      return ok(
        `Context ${v.contextId} (${v.kind}), profile ${v.profile.name}`,
        {
          contextId: v.contextId,
          owner: v.owner,
          kind: v.kind,
          profile: v.profile,
          allowedHosts: v.allowedHosts,
          policy: {
            contentHash: v.policy.contentHash,
            source: v.policy.source,
            revision: v.policy.revision,
          },
        },
        'Policy can only be changed by the human (abox policy edit).',
      );
    },
  });
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function commandParams(a: {
  argv?: string[] | undefined;
  cmd?: string | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
}): Pick<ExecParams, 'argv' | 'command' | 'cwd' | 'env'> {
  if ((a.argv === undefined) === (a.cmd === undefined)) {
    throw invalidInput(
      'give exactly one of argv and cmd',
      'Prefer argv (no shell): argv=["pnpm","test"].',
    );
  }
  return {
    ...(a.argv !== undefined ? { argv: a.argv } : {}),
    ...(a.cmd !== undefined ? { command: a.cmd } : {}),
    ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
    ...(a.env !== undefined ? { env: a.env } : {}),
  };
}

function execOptions(rt: Runtime): { signal: AbortSignal; waitForApprovalMs?: number } {
  return {
    signal: rt.signal,
    ...(rt.limits.approvalWaitMs !== undefined
      ? { waitForApprovalMs: rt.limits.approvalWaitMs }
      : {}),
  };
}

/** Defense in depth: the manager already caps, this keeps the combined result bounded for any manager config. */
function capStreams(
  stdout: string,
  stderr: string,
  max: number,
): { stdout: string; stderr: string; truncated: boolean } {
  const a = truncateText(stdout, max);
  const b = truncateText(stderr, max);
  return { stdout: a.text, stderr: b.text, truncated: a.truncated || b.truncated };
}

const DETAIL_KEYS: Record<string, string[]> = {
  network: ['mode', 'domains', 'presets', 'private_exceptions'],
  mount: ['source', 'target', 'access'],
  resources: ['cpus', 'memory'],
  ttl: ['ttl'],
};

function accessInput(
  kind: 'network' | 'mount' | 'resources' | 'ttl',
  d: Record<string, unknown>,
  reason: string,
): AccessRequestInput {
  const allowed = DETAIL_KEYS[kind]!;
  const extra = Object.keys(d).filter((k) => d[k] !== undefined && !allowed.includes(k));
  if (extra.length) {
    throw invalidInput(
      `details for kind ${kind} do not take: ${extra.join(', ')}`,
      `kind ${kind} uses: ${allowed.join(', ')}`,
    );
  }
  switch (kind) {
    case 'network':
      return {
        kind,
        details: {
          ...(d['mode'] ? { mode: d['mode'] as 'none' | 'allowlist' | 'open' } : {}),
          ...(d['domains'] ? { domains: d['domains'] as string[] } : {}),
          ...(d['presets'] ? { presets: d['presets'] as string[] } : {}),
          ...(d['private_exceptions']
            ? { privateExceptions: d['private_exceptions'] as string[] }
            : {}),
        },
        reason,
      };
    case 'mount':
      return {
        kind,
        details: {
          source: d['source'] as string,
          target: d['target'] as string,
          ...(d['access'] ? { access: d['access'] as 'ro' | 'rw' } : {}),
        },
        reason,
      };
    case 'resources':
      return {
        kind,
        details: {
          ...(d['cpus'] !== undefined ? { cpus: d['cpus'] as number } : {}),
          ...(d['memory'] !== undefined ? { memory: d['memory'] as string | number } : {}),
        },
        reason,
      };
    case 'ttl': {
      if (d['ttl'] === undefined)
        throw invalidInput('details.ttl is required for kind ttl', 'e.g. {"ttl":"1h"}');
      return {
        kind,
        details: { ttl: durationMs(d['ttl'] as string | number, 'details.ttl') },
        reason,
      };
    }
  }
}
