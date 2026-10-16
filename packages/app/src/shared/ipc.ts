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
  APPROVAL_STATUSES,
  AUDIT_DECISIONS,
  EXPORT_FORMATS,
  LOCALES,
  NETWORK_MODES,
  SANDBOX_STATES,
  WORKSPACE_MODES,
} from './constants';
import { IPC_CHANNEL_NAMES } from './channels';
export * from './constants';

const id = z.string().min(1).max(200);
const shortText = z.string().min(1).max(200);
const duration = z.string().regex(/^\d{1,6}(ms|s|m|h|d)$/, 'duration like 30m, 2h or 1d');
const sizeText = z.string().regex(/^\d{1,6}(\.\d+)?[kmgt]?b?$/i, 'size like 512m or 4g');
const absPath = z.string().min(1).max(4096);
const none = z.undefined();

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
    workspace: z
      .object({
        mode: z.enum(WORKSPACE_MODES).optional(),
        path: absPath.optional(),
        ref: shortText.optional(),
        access: z.enum(['ro', 'rw']).optional(),
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
    /** The human saw the `confirmation_required` summary and confirmed it. */
    confirmed: z.boolean().optional(),
    /** Correlates `evt:progress` lines with this call. */
    progressKey: z.string().min(1).max(64).optional(),
  })
  .strict();

/** channel -> input schema. */
export const IPC = {
  'app:info': none,
  'app:setLocale': z.enum(LOCALES),
  'app:copy': z.string().max(20_000),
  'dialog:pickDirectory': none,

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
  'sandboxes:start': z.object({ id }).strict(),
  'sandboxes:stop': z.object({ id }).strict(),
  'sandboxes:remove': z.object({ id }).strict(),
  'sandboxes:extend': z.object({ id, ttl: duration, confirmed: z.boolean().optional() }).strict(),
  'sandboxes:create': createRequestSchema,
  'templates:list': none,
  'templates:show': z.object({ name: shortText }).strict(),

  'files:list': z.object({ id, path: z.string().max(4096).optional() }).strict(),
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
  'processes:list': z.object({ id }).strict(),
  'processes:logs': z
    .object({
      processId: id,
      tail: z.number().int().min(1).max(5000).optional(),
    })
    .strict(),
  'snapshots:create': z
    .object({ id, name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'letters, digits . _ -') })
    .strict(),
  'snapshots:restore': z.object({ id, snapshotId: z.string().min(1).max(200) }).strict(),

  'approvals:list': z
    .object({
      status: z.enum(APPROVAL_STATUSES).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict()
    .optional(),
  'approvals:approve': z.object({ id, note: z.string().max(500).optional() }).strict(),
  'approvals:deny': z.object({ id, note: z.string().max(500).optional() }).strict(),

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

  'doctor:run': none,
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
} as const;

export type IpcChannel = keyof typeof IPC;
export const IPC_CHANNELS = IPC_CHANNEL_NAMES as readonly IpcChannel[];
export type IpcInput<C extends IpcChannel> = z.input<(typeof IPC)[C]>;
