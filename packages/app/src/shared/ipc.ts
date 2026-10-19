/**
 * The complete IPC surface between renderer and main process.
 *
 * Every request channel has a Zod schema for its input; the main process validates every call
 * against it (`safeParse`, strict objects) before any manager method is invoked. The renderer
 * can only reach channels listed here (the preload script exposes `invoke` for exactly these names).
 *
 * The GUI contains no business logic: each channel maps to one manager (`Abox`) operation, called as
 * the context `human`. Policy, approvals, audit and secret masking stay in `@abox/core`.
 * Only main (and tests) import this file; renderer and preload use `constants.ts` / `channels.ts`.
 */
import { z } from 'zod';
import {
  ACTIVITY_KINDS,
  APPROVAL_STATUSES,
  AUDIT_DECISIONS,
  EXPORT_FORMATS,
  FORWARD_KINDS,
  HOST_BACKENDS,
  HOST_ZONES,
  ISOLATION_LEVELS,
  LOCALES,
  NETWORK_MODES,
  PORT_FORWARD_MAX_PORT,
  PORT_FORWARD_MIN_HOST_PORT,
  SANDBOX_STATES,
  TTY_MAX_COLS,
  TTY_MAX_INPUT,
  TTY_MAX_ROWS,
  WORKSPACE_MODES,
} from './constants';
import { IPC_CHANNEL_NAMES } from './channels';
export * from './constants';

const id = z.string().min(1).max(200);
const shortText = z.string().min(1).max(200);
const duration = z.string().regex(/^\d{1,6}(ms|s|m|h|d)$/, 'duration like 30m, 2h or 1d');
const sizeText = z.string().regex(/^\d{1,6}(\.\d+)?[kmgt]?b?$/i, 'size like 512m or 4g');
const absPath = z.string().min(1).max(4096);
/**
 * A project folder (the directory whose `.sandbox/*.yaml` are project templates): an absolute path, as a
 * native dialog or a recent-folders entry delivers it. The main process canonicalises it and checks it
 * like the CLI does for a human `--project`; relative paths and `~` are refused here.
 */
const projectDir = absPath.refine((p) => p.startsWith('/') && !p.includes('\0'), 'absolute path');
const none = z.undefined();
/** A TCP port inside a sandbox. */
const sandboxPort = z.number().int().min(1).max(PORT_FORWARD_MAX_PORT);
/** The port on 127.0.0.1 of this machine; privileged ports are refused here and again by the manager. */
const forwardHostPort = z.number().int().min(PORT_FORWARD_MIN_HOST_PORT).max(PORT_FORWARD_MAX_PORT);

/**
 * A selection of changed files (and, optionally, of their hunks) as the renderer names it. It carries
 * ids only: the main process recomputes the diff, checks it against `digest` and builds the patch itself.
 */
const changeSelection = z
  .array(
    z
      .object({
        path: z.string().min(1).max(4096),
        hunks: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(100_000).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(5000);
const changesDigest = z.string().regex(/^[0-9a-f]{64}$/, '64 hex digits');

const auditFilter = z
  .object({
    sandboxId: id.optional(),
    actor: shortText.optional(),
    action: shortText.optional(),
    decision: z.enum(AUDIT_DECISIONS).optional(),
    since: z.number().int().nonnegative().optional(),
    until: z.number().int().nonnegative().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

export const createRequestSchema = z
  .object({
    template: shortText,
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits . _ -')
      .optional(),
    host: shortText.optional(),
    /** Folder whose `.sandbox/*.yaml` project templates `template` may name (default: the workspace). */
    projectDir: projectDir.optional(),
    workspace: z
      .object({
        mode: z.enum(WORKSPACE_MODES).optional(),
        path: absPath.optional(),
        ref: shortText.optional(),
        access: z.enum(['ro', 'rw']).optional(),
        /** Exclude patterns of a copy / sync workspace (gitignore-like, see the templates doc). */
        exclude: z.array(z.string().min(1).max(512)).max(256).optional(),
        /** copy / sync: leave out what `.gitignore` files ignore (core default: true). */
        gitignore: z.boolean().optional(),
      })
      .strict()
      .optional(),
    overrides: z
      .object({
        cpus: z.number().positive().max(256).optional(),
        memory: sizeText.optional(),
        ttl: duration.optional(),
        network: z
          .object({
            mode: z.enum(NETWORK_MODES).optional(),
            allow: z.array(shortText).max(100).optional(),
            presets: z.array(shortText).max(20).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** `false`: do not mount the template's package caches (clean install). Absent: use them where allowed. */
    cache: z.boolean().optional(),
    /** The human saw the `confirmation_required` summary and confirmed it. */
    confirmed: z.boolean().optional(),
    /** Correlates `evt:progress` lines with this call. */
    progressKey: z.string().min(1).max(64).optional(),
  })
  .strict();

const ttySize = {
  cols: z.number().int().min(1).max(TTY_MAX_COLS),
  rows: z.number().int().min(1).max(TTY_MAX_ROWS),
};
/** Random session id handed out by the main process (UUID). */
const sessionId = z.string().uuid();
const hostId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'host id like my-server');
const progressKey = z.string().min(1).max(64);
const yamlText = z.string().max(300_000);
/** Key of a package cache (16 hex digits, the manager accepts shorter unique prefixes: the GUI sends full keys). */
const cacheKey = z.string().regex(/^[0-9a-f]{16}$/, '16 hex digits');

const portForward = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'name like web-ui'),
    kind: z.enum(FORWARD_KINDS),
    listen: z.string().min(1).max(300),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

/**
 * Host profile fields. The shape is bounded here; the host module of @abox/core validates every value
 * again against its strict grammars (no secrets exist in this model: `identityFile` is a path only).
 */
/** Name of an OCI runtime (`runsc`, `kata`); the host module validates it again. */
const runtimeName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, 'runtime like runsc');
const hostFields = {
  hostname: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1).max(64),
  sshConfigAlias: z.string().min(1).max(128),
  proxyJump: z.string().min(1).max(500),
  identityFile: z.string().min(1).max(4096),
  zone: z.enum(HOST_ZONES),
  minIsolation: z.enum(ISOLATION_LEVELS),
  backends: z.array(z.enum(HOST_BACKENDS)).max(8),
  engineSocket: z.string().min(1).max(300),
  dataDir: z.string().min(1).max(300),
  /** Hardened OCI runtime per engine on THAT host (`{ docker: 'runsc' }`). */
  runtimes: z.object({ docker: runtimeName.optional(), podman: runtimeName.optional() }).strict(),
  /** Accept a rootful engine on a shared / restricted host (root-equivalent). */
  allowRootful: z.boolean(),
  tags: z.array(z.string().min(1).max(32)).max(20),
  favorite: z.boolean(),
  limits: z
    .object({
      cpus: z.number().positive().max(1024).optional(),
      memory: z
        .string()
        .regex(/^\d{1,6}(\.\d+)?[kmgt]?b?$/i)
        .optional(),
      sandboxes: z.number().int().min(0).max(10_000).optional(),
    })
    .strict(),
  portForwards: z.array(portForward).max(30),
};
const hostPatch = z
  .object({
    hostname: hostFields.hostname.nullable().optional(),
    port: hostFields.port.nullable().optional(),
    user: hostFields.user.nullable().optional(),
    sshConfigAlias: hostFields.sshConfigAlias.nullable().optional(),
    proxyJump: hostFields.proxyJump.nullable().optional(),
    identityFile: hostFields.identityFile.nullable().optional(),
    zone: hostFields.zone.optional(),
    minIsolation: hostFields.minIsolation.nullable().optional(),
    backends: hostFields.backends.optional(),
    engineSocket: hostFields.engineSocket.nullable().optional(),
    dataDir: hostFields.dataDir.nullable().optional(),
    runtimes: hostFields.runtimes.nullable().optional(),
    allowRootful: hostFields.allowRootful.nullable().optional(),
    tags: hostFields.tags.optional(),
    favorite: hostFields.favorite.optional(),
    limits: hostFields.limits.nullable().optional(),
    portForwards: hostFields.portForwards.optional(),
  })
  .strict();

const hostAdd = z
  .object({
    id: hostId,
    hostname: hostFields.hostname.optional(),
    port: hostFields.port.optional(),
    user: hostFields.user.optional(),
    sshConfigAlias: hostFields.sshConfigAlias.optional(),
    proxyJump: hostFields.proxyJump.optional(),
    identityFile: hostFields.identityFile.optional(),
    zone: hostFields.zone.optional(),
    minIsolation: hostFields.minIsolation.optional(),
    backends: hostFields.backends.optional(),
    engineSocket: hostFields.engineSocket.optional(),
    dataDir: hostFields.dataDir.optional(),
    runtimes: hostFields.runtimes.optional(),
    allowRootful: hostFields.allowRootful.optional(),
    tags: hostFields.tags.optional(),
    favorite: hostFields.favorite.optional(),
    limits: hostFields.limits.optional(),
    portForwards: hostFields.portForwards.optional(),
  })
  .strict();

/** channel -> input schema. */
export const IPC = {
  'app:info': none,
  'app:setLocale': z.enum(LOCALES),
  'app:copy': z.string().max(20_000),
  /** Any subset of the GUI preferences; what is left out stays as it is. */
  'app:settings': z
    .object({
      closeToTray: z.boolean().optional(),
      notifications: z
        .object({
          approvals: z.boolean().optional(),
          expiring: z.boolean().optional(),
          failed: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'dialog:pickDirectory': none,
  /**
   * The answer to an ssh passphrase / PIN prompt (`evt:askpass`); `null` cancels. The value is handed to ssh and
   * dropped: it is never logged, audited or kept, and not part of any error text.
   */
  'askpass:answer': z
    .object({ id: z.string().uuid(), value: z.string().max(4096).nullable() })
    .strict(),

  'sandboxes:list': z
    .object({
      state: z.array(z.enum(SANDBOX_STATES)).max(8).optional(),
      template: shortText.optional(),
      owner: shortText.optional(),
      includeRemoved: z.boolean().optional(),
    })
    .strict()
    .optional(),
  'sandboxes:inspect': z.object({ id }).strict(),
  /** Live cpu / memory of the given (running, visible) sandboxes; the view polls it, see `useSandboxUsage`. */
  'sandboxes:stats': z.object({ ids: z.array(id).max(200) }).strict(),
  'sandboxes:start': z.object({ id }).strict(),
  'sandboxes:stop': z.object({ id }).strict(),
  'sandboxes:remove': z.object({ id }).strict(),
  'sandboxes:extend': z.object({ id, ttl: duration, confirmed: z.boolean().optional() }).strict(),
  'sandboxes:create': createRequestSchema,
  /**
   * Fast read-only size check of a workspace folder (what a copy would move); `progressKey` correlates the
   * `evt:progress` lines and `jobs:cancel` with the call.
   */
  'workspace:estimate': z
    .object({
      path: projectDir,
      mode: z.enum(WORKSPACE_MODES).optional(),
      exclude: z.array(z.string().min(1).max(512)).max(256).optional(),
      gitignore: z.boolean().optional(),
      progressKey: progressKey.optional(),
    })
    .strict(),
  /**
   * Capacity and live utilisation of one host (size of the machine, what it uses now, what abox reserves, the host limits);
   * read-only, cached for a few seconds by the manager. One host per call so a slow ssh host does not hold up the others.
   */
  'capacity:host': z.object({ id: hostId }).strict(),
  /**
   * How often a planned sandbox fits on a host and what the host looks like with it (limits, reservations, free now);
   * read-only. `overrides` are the cpu / memory fields of the New-sandbox form.
   */
  'capacity:estimate': z
    .object({
      host: hostId.optional(),
      template: shortText,
      overrides: z
        .object({ cpus: z.number().positive().max(1024).optional(), memory: sizeText.optional() })
        .strict()
        .optional(),
      projectDir: projectDir.optional(),
      workspacePath: absPath.optional(),
    })
    .strict(),
  /** Cancels a running `sandboxes:create` or `workspace:estimate` call by its `progressKey`. */
  'jobs:cancel': z.object({ key: progressKey }).strict(),
  /** `projectDir`: also list the project templates of that folder (`.sandbox/*.yaml`); builtin and user ones always. */
  'templates:list': z.object({ projectDir: projectDir.optional() }).strict().optional(),
  /**
   * Which template fits a project folder (its `.sandbox/*.yaml` first, else marker files such as `package.json`);
   * read-only, from file names only. The main process checks the folder like any project folder.
   */
  'templates:suggest': z.object({ path: projectDir }).strict(),
  'templates:show': z.object({ name: shortText, projectDir: projectDir.optional() }).strict(),
  /**
   * Review material for a project template (what it adds, its risks). `workspacePath`: the workspace of a
   * sandbox being created, where a project template may live; `projectDir`: the folder picked for the list.
   * The main process checks both like the manager.
   */
  'templates:review': z
    .object({
      name: shortText,
      workspacePath: absPath.optional(),
      projectDir: projectDir.optional(),
    })
    .strict(),
  /** Recently used project folders (per user of the app, kept in the app's settings, not in any repository). */
  'projects:recent': none,
  /** Checks a folder like a human `--project` (absolute, exists, a directory) and remembers it as recent. */
  'projects:remember': z.object({ dir: projectDir }).strict(),

  'files:list': z.object({ id, path: z.string().max(4096).optional() }).strict(),
  /** The host side is chosen in a native dialog by the human, never passed by the renderer. */
  'files:copyIn': z.object({ id, sandboxPath: z.string().min(1).max(4096) }).strict(),
  'files:copyOut': z.object({ id, sandboxPath: z.string().min(1).max(4096) }).strict(),
  'export:run': z
    .object({
      id,
      format: z.enum(EXPORT_FORMATS),
      paths: z.array(z.string().min(1).max(4096)).max(500).optional(),
      branchName: z
        .string()
        .regex(/^abox\/[A-Za-z0-9._/-]{1,100}$/, 'branch name must start with abox/')
        .optional(),
    })
    .strict(),
  'export:save': z.object({ id, format: z.enum(['diff', 'patch']) }).strict(),
  /** The sandbox's changes as files and hunks with flags, and the state of the project they would go to. */
  'changes:review': z.object({ id }).strict(),
  /**
   * Applies a selection to the project the sandbox came from (the target is never sent: the manager uses
   * the project recorded at create). `confirmed` is set after the summary dialog; `dryRun` runs all checks only.
   */
  'changes:apply': z
    .object({
      id,
      digest: changesDigest,
      selection: changeSelection,
      acknowledgeFlagged: z.array(z.string().min(1).max(4096)).max(5000).optional(),
      allowNonGit: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  /** The patch of a selection, written to a file the human picks in a save dialog. */
  'changes:savePatch': z.object({ id, digest: changesDigest, selection: changeSelection }).strict(),
  'processes:list': z.object({ id }).strict(),
  'processes:logs': z
    .object({
      processId: id,
      tail: z.number().int().min(1).max(5000).optional(),
    })
    .strict(),
  'sandboxes:logs': z
    .object({
      id,
      tail: z.number().int().min(1).max(5000).optional(),
      sinceTs: z.number().int().nonnegative().optional(),
    })
    .strict(),
  /** The activity timeline of a sandbox (a view of the audit log): newest first, one page at a time. */
  'activity:list': z
    .object({
      id,
      kinds: z.array(z.enum(ACTIVITY_KINDS)).min(1).max(ACTIVITY_KINDS.length).optional(),
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      cursor: z
        .string()
        .regex(/^\d{1,15}$/)
        .optional(),
    })
    .strict(),
  /** The newest activity across all sandboxes (for the overview). */
  'activity:recent': z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      since: z.number().int().nonnegative().optional(),
    })
    .strict(),
  /** The egress log of an allowlist sandbox, grouped by destination (a view of the audit log). */
  'network:log': z
    .object({
      id,
      since: z.number().int().nonnegative().optional(),
      denied: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
  /**
   * "Allow once": destinations (host, host:port, *.host) for this sandbox only. The manager refuses what can not be
   * allowed and asks for the confirmation (`confirmed`) of a wildcard; "allow permanently" is `policy:set` first.
   */
  'network:allow': z
    .object({
      id,
      destinations: z.array(z.string().min(1).max(260)).min(1).max(32),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  /** "Allow permanently": the proposed edit of policy.yaml (text, base hash); writes nothing, the save is `policy:set`. */
  'network:propose': z
    .object({ id, destinations: z.array(z.string().min(1).max(260)).min(1).max(32) })
    .strict(),
  'snapshots:list': z.object({ id }).strict(),
  'snapshots:create': z
    .object({ id, name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'letters, digits . _ -') })
    .strict(),
  'snapshots:restore': z.object({ id, snapshotId: z.string().min(1).max(200) }).strict(),

  // -- port forwards (preview of a dev server). The preview URL is never passed by the renderer: the main
  // process looks the forward up and builds it itself, see `main/preview.ts`. ----------------------------------
  /** Open forwards of the sandbox (also what `sandboxes:inspect` reports as `ports`). */
  'ports:list': z.object({ id }).strict(),
  /** Forward `port` of the sandbox to 127.0.0.1 (`hostPort`: a fixed port, otherwise a free one is picked). */
  'ports:add': z
    .object({
      id,
      port: sandboxPort,
      hostPort: forwardHostPort.optional(),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  'ports:remove': z.object({ id, port: sandboxPort }).strict(),
  /** Opens the forward of that sandbox port in the default browser (loopback only, see `main/preview.ts`). */
  'ports:openPreview': z.object({ id, port: sandboxPort }).strict(),

  'approvals:list': z
    .object({
      status: z.enum(APPROVAL_STATUSES).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict()
    .optional(),
  'approvals:approve': z.object({ id, note: z.string().max(500).optional() }).strict(),
  'approvals:deny': z.object({ id, note: z.string().max(500).optional() }).strict(),
  /** Review of the template a `template_trust` approval is about; the main process reads the approval, the renderer names no path. */
  'approvals:templateReview': z.object({ id }).strict(),
  /** Base image and registry of the template an approval is about (null when it cannot be determined). */
  'approvals:image': z.object({ id }).strict(),

  'audit:query': auditFilter.optional(),
  'audit:exportSave': auditFilter.optional(),
  'audit:verify': none,

  'policy:get': none,
  'policy:validate': z.object({ text: z.string().max(1_000_000) }).strict(),
  /** `baseHash`: content hash of the policy the edit started from; a changed file is refused (`conflict`). */
  'policy:set': z
    .object({ text: z.string().max(1_000_000), baseHash: z.string().max(128).optional() })
    .strict(),
  'policy:revisions': none,
  'policy:revision': z.object({ rev: z.number().int().nonnegative() }).strict(),

  'doctor:run': none,
  /**
   * The scoped readiness check (`abox doctor --for`): can `template` run (on `host`, default this computer),
   * or can the host run sandboxes at all? Read-only; the answer is a list of checks like `doctor:run`.
   */
  'doctor:for': z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('template'),
        template: shortText,
        host: hostId.optional(),
        projectDir: projectDir.optional(),
        workspacePath: absPath.optional(),
      })
      .strict(),
    z.object({ kind: z.literal('host'), host: hostId }).strict(),
  ]),
  /** Package caches of all hosts with their sizes (human only; the sizes can take a moment). */
  'caches:list': none,
  /**
   * Removes package caches: the ones named by `keys` (the manager refuses a cache a sandbox uses), or all of
   * them (those in use are skipped). `host` limits the removal to one host. The renderer names no path or volume.
   */
  'caches:remove': z.union([
    z.object({ keys: z.array(cacheKey).min(1).max(200), host: hostId.optional() }).strict(),
    z.object({ all: z.literal(true), host: hostId.optional() }).strict(),
  ]),
  'reconcile:run': z
    .object({ apply: z.boolean().optional(), removeOrphans: z.boolean().optional() })
    .strict()
    .optional(),
  'tokens:list': none,
  'tokens:create': z
    .object({
      contextId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      label: z.string().min(1).max(100),
    })
    .strict(),
  'tokens:revoke': z.object({ id }).strict(),
  'mcp:config': z
    .object({
      agent: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
        .optional(),
    })
    .strict()
    .optional(),
  /** MCP status for the settings view: agent contexts with their last activity, token usage. */
  'mcp:status': none,

  // -- terminals (sandbox shell and ssh sessions). The renderer never names a command or a path. ----------
  'tty:open': z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('sandbox'), id, ...ttySize }).strict(),
    z.object({ kind: z.literal('ssh'), host: hostId, ...ttySize }).strict(),
  ]),
  'tty:input': z.object({ sessionId, data: z.string().min(1).max(TTY_MAX_INPUT) }).strict(),
  'tty:resize': z.object({ sessionId, ...ttySize }).strict(),
  'tty:close': z.object({ sessionId }).strict(),

  // -- template editor --------------------------------------------------------------------------------------
  'templates:catalog': none,
  'templates:source': z.object({ name: shortText, projectDir: projectDir.optional() }).strict(),
  'templates:validate': z.object({ yaml: yamlText }).strict(),
  'templates:save': z.object({ yaml: yamlText, overwrite: z.boolean().optional() }).strict(),
  'templates:build': z
    .object({ name: shortText, update: z.boolean().optional(), progressKey })
    .strict(),
  'templates:test': z
    .object({ name: shortText, progressKey, confirmed: z.boolean().optional() })
    .strict(),
  /** `dockerfile`: renders the Dockerfile of the SAVED template `name` (the yaml field is ignored for it). */
  'templates:export': z
    .object({ name: shortText, yaml: yamlText, format: z.enum(['yaml', 'dockerfile']).optional() })
    .strict(),

  // -- hosts and ssh (human only: these channels exist only in the GUI, never in MCP) ---------------------------
  'hosts:list': none,
  'hosts:add': hostAdd,
  'hosts:update': z.object({ id: hostId, patch: hostPatch }).strict(),
  'hosts:remove': z.object({ id: hostId }).strict(),
  'hosts:test': z.object({ id: hostId }).strict(),
  'hosts:importPreview': none,
  'hosts:importApply': z.object({ ids: z.array(hostId).min(1).max(200) }).strict(),
  'hosts:keyCheck': z.object({ id: hostId }).strict(),
  'hosts:keyTrust': z
    .object({ id: hostId, fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) })
    .strict(),
  'hosts:keyForget': z.object({ id: hostId }).strict(),
  'hosts:forwards': none,
  'hosts:forwardStart': z.object({ id: hostId, name: shortText }).strict(),
  'hosts:forwardStop': z.object({ id: hostId, name: shortText }).strict(),
} as const;

export type IpcChannel = keyof typeof IPC;
export const IPC_CHANNELS = IPC_CHANNEL_NAMES as readonly IpcChannel[];
export type IpcInput<C extends IpcChannel> = z.input<(typeof IPC)[C]>;
