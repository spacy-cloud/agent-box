import { z } from 'zod';
import { NETWORK_MODES, WORKSPACE_MODES } from '../types.js';

const durationOrMs = z.union([z.string().min(1).max(32), z.number().int().positive()]);
const sizeOrBytes = z.union([z.string().min(1).max(32), z.number().int().positive()]);
const domain = z.string().min(1).max(260);
const hostPathStr = z.string().min(1).max(4096);
const sandboxPathStr = z.string().min(1).max(4096);

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export const createRequestSchema = z.strictObject({
  template: z.string().min(1).max(64),
  name: z.string().regex(NAME_RE, 'use letters, digits . _ - (max 64)').optional(),
  host: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'invalid host id')
    .optional(),
  workspace: z
    .strictObject({
      mode: z.enum(WORKSPACE_MODES).optional(),
      path: hostPathStr.optional(),
      ref: z.string().min(1).max(256).optional(),
      access: z.enum(['ro', 'rw']).optional(),
      exclude: z.array(z.string().min(1).max(512)).max(256).optional(),
    })
    .optional(),
  overrides: z
    .strictObject({
      cpus: z.number().positive().max(1024).optional(),
      memory: sizeOrBytes.optional(),
      ttl: durationOrMs.optional(),
      network: z
        .strictObject({
          mode: z.enum(NETWORK_MODES).optional(),
          allow: z.array(domain).max(256).optional(),
          presets: z.array(z.string().min(1).max(64)).max(32).optional(),
          privateExceptions: z.array(z.string().min(1).max(64)).max(32).optional(),
        })
        .optional(),
      mounts: z
        .array(
          z.strictObject({
            source: hostPathStr,
            target: sandboxPathStr,
            access: z.enum(['ro', 'rw']).optional(),
          }),
        )
        .max(32)
        .optional(),
    })
    .optional(),
  requestId: z.string().regex(REQUEST_ID_RE, 'use letters, digits . _ : @ - (max 128)').optional(),
  projectDir: hostPathStr.optional(),
});

export const workspaceEstimateSchema = z.strictObject({
  path: hostPathStr,
  mode: z.enum(WORKSPACE_MODES).optional(),
  exclude: z.array(z.string().min(1).max(512)).max(256).optional(),
});

const envSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'invalid variable name'),
    z.string().max(32768),
  )
  .refine((e) => Object.keys(e).length <= 256, 'at most 256 variables')
  .refine(
    (e) => Object.keys(e).every((k) => !k.startsWith('ABOX_')),
    'variables starting with ABOX_ are reserved',
  );

export const execSchema = z
  .strictObject({
    argv: z.array(z.string().max(131072)).min(1).max(2000).optional(),
    command: z.string().min(1).max(262144).optional(),
    cwd: sandboxPathStr.optional(),
    env: envSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 3600_000)
      .optional(),
    stdin: z
      .string()
      .max(8 * 1024 * 1024)
      .optional(),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .optional(),
  })
  .refine(
    (e) => (e.argv === undefined) !== (e.command === undefined),
    'set exactly one of argv and command',
  )
  .refine(
    (e) => e.argv === undefined || (typeof e.argv[0] === 'string' && e.argv[0] !== ''),
    'argv[0] must be a program name',
  );

export const processStartSchema = z
  .strictObject({
    argv: z.array(z.string().max(131072)).min(1).max(2000).optional(),
    command: z.string().min(1).max(262144).optional(),
    cwd: sandboxPathStr.optional(),
    env: envSchema.optional(),
  })
  .refine(
    (e) => (e.argv === undefined) !== (e.command === undefined),
    'set exactly one of argv and command',
  );

export const accessSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('network'),
    details: z.strictObject({
      mode: z.enum(NETWORK_MODES).optional(),
      domains: z.array(domain).max(256).optional(),
      presets: z.array(z.string().min(1).max(64)).max(32).optional(),
      privateExceptions: z.array(z.string().min(1).max(64)).max(32).optional(),
    }),
    reason: z.string().max(4000).optional(),
  }),
  z.strictObject({
    kind: z.literal('mount'),
    details: z.strictObject({
      source: hostPathStr,
      target: sandboxPathStr,
      access: z.enum(['ro', 'rw']).optional(),
    }),
    reason: z.string().max(4000).optional(),
  }),
  z.strictObject({
    kind: z.literal('resources'),
    details: z.strictObject({
      cpus: z.number().positive().max(1024).optional(),
      memory: sizeOrBytes.optional(),
    }),
    reason: z.string().max(4000).optional(),
  }),
  z.strictObject({
    kind: z.literal('ttl'),
    details: z.strictObject({ ttl: durationOrMs }),
    reason: z.string().max(4000).optional(),
  }),
]);

export const exportSchema = z.strictObject({
  format: z.enum(['diff', 'patch', 'branch', 'files']),
  paths: z.array(z.string().min(1).max(4096)).max(1000).optional(),
  outDir: hostPathStr.optional(),
  branchName: z.string().min(1).max(200).optional(),
  force: z.boolean().optional(),
});

export const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
