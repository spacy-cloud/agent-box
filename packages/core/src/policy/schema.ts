import { z } from 'zod';
import { ISOLATION_LEVELS, NETWORK_MODES, WORKSPACE_MODES } from '../types.js';
import { isNetworkPreset } from '../template/network-presets.js';
import { normalizeDomainPattern } from './domains.js';
import { normalizeRegistryPattern } from './images.js';
import { APPROVAL_MODES } from './model.js';
import { tryParseDuration, tryParseSize } from './units.js';

/**
 * Zod schema of policy.yaml (strict: unknown keys are errors, so typos like
 * `allow_preset` can never silently weaken or ignore a rule).
 */

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTEXT_ID = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})?$/;
const TEMPLATE_PATTERN = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const HOST_PATTERN = /^(?:\*|[a-z0-9-]{1,63})$/;
const SECRET_REF = /^(?:\*|[A-Za-z0-9_.:/@-]{1,200})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Syntax check for a root: `~`, `~/x` or absolute; no control chars, no `..` segments. */
export function isValidRootSyntax(root: string): boolean {
  if (root.length === 0 || root.length > 4096 || CONTROL.test(root)) return false;
  if (!(root === '~' || root.startsWith('~/') || root.startsWith('/'))) return false;
  return !root.split('/').includes('..');
}

/** Upper bound of `ports.max` (every forward is a helper process or container). */
export const PORTS_MAX_LIMIT = 32;

const nameSchema = z.string().regex(NAME, 'must match [a-z0-9][a-z0-9._-]* (max 64 chars)');
const rootSchema = z
  .string({
    error: (iss) =>
      iss.input === null
        ? "got null: a bare ~ is YAML null, write the root in quotes ('~' or ~/projects)"
        : undefined,
  })
  .refine(
    isValidRootSyntax,
    'must be an absolute path or start with "~/" (no ".." segments, no control characters)',
  );
const sizeSchema = z
  .string()
  .refine((s) => tryParseSize(s) !== undefined, 'invalid size (expected e.g. 512m, 8g)');
const durationSchema = z
  .string()
  .refine((s) => tryParseDuration(s) !== undefined, 'invalid duration (expected e.g. 30m, 4h, 2d)');
const presetSchema = z.string().refine(isNetworkPreset, 'unknown network preset');
const allowEntrySchema = z
  .string()
  .refine(
    (s) => s.trim() === '*' || normalizeDomainPattern(s) !== undefined,
    'invalid destination (expected example.org or *.example.org; "*" alone means any destination)',
  );

const registrySchema = z
  .string()
  .refine(
    (s) => normalizeRegistryPattern(s) !== undefined,
    'invalid registry (expected a registry host with an optional path such as docker.io/library, ghcr.io or ghcr.io/my-org; "*" alone means any image)',
  );

const isolationSchema = z.enum(ISOLATION_LEVELS);

const isolationObject = z.strictObject({
  min: isolationSchema.optional(),
  network_open: isolationSchema.optional(),
  mounts: isolationSchema.optional(),
  secrets_env: isolationSchema.optional(),
});

export const ProfileSchema = z.strictObject({
  extends: nameSchema.optional(),
  approval: z.enum(APPROVAL_MODES).optional(),
  templates: z.array(z.string().regex(TEMPLATE_PATTERN, 'invalid template name')).optional(),
  limits: z
    .strictObject({
      sandboxes: z.number().int().min(0).max(10_000).optional(),
      cpus: z.number().positive().max(4096).optional(),
      memory: sizeSchema.optional(),
      ttl: durationSchema.optional(),
    })
    .optional(),
  workspace: z
    .strictObject({
      roots: z.array(rootSchema).optional(),
      modes: z.array(z.enum(WORKSPACE_MODES)).optional(),
      /** Soft limit for `copy` / `sync`: larger folders need the human's confirmation (agents: denied). */
      max_copy_bytes: sizeSchema.optional(),
      max_copy_entries: z.number().int().min(1).max(100_000_000).optional(),
    })
    .optional(),
  network: z
    .strictObject({
      modes: z.array(z.enum(NETWORK_MODES)).optional(),
      allow_presets: z.array(presetSchema).optional(),
      allow: z.array(allowEntrySchema).optional(),
    })
    .optional(),
  images: z.strictObject({ registries: z.array(registrySchema).optional() }).optional(),
  mounts: z
    .union([
      z.literal('deny'),
      z.strictObject({
        roots: z.array(rootSchema).optional(),
        access: z.array(z.enum(['ro', 'rw'])).optional(),
      }),
    ])
    .optional(),
  secrets: z
    .strictObject({
      allowed: z.array(z.string().regex(SECRET_REF, 'invalid secret ref')).optional(),
      inject: z.array(z.enum(['proxy', 'env', 'file'])).optional(),
    })
    .optional(),
  isolation: isolationObject.optional(),
  /** Alias used in the concept note (`min_isolation: { network_open: vm }`). `isolation` wins on conflict. */
  min_isolation: isolationObject.optional(),
  hosts: z.array(z.string().regex(HOST_PATTERN, 'invalid host id')).optional(),
  exec: z.strictObject({ approval: z.boolean().optional() }).optional(),
  /** Per-project package caches (pnpm store, cargo registry, ...) for this profile's sandboxes. Default true. */
  caches: z.boolean().optional(),
  /** Most a project's caches may hold (per owner and host); `abox gc` and the next create trim the least recently used. Default 10g. */
  cache_max_bytes: sizeSchema.optional(),
  ports: z
    .strictObject({
      /** `false`, `ask` (default) or `true`. */
      allow: z.union([z.boolean(), z.literal('ask')]).optional(),
      /** Most forwards one sandbox may have open at once. */
      max: z.number().int().min(0).max(PORTS_MAX_LIMIT).optional(),
    })
    .optional(),
});
export type RawProfile = z.infer<typeof ProfileSchema>;

export const ContextSchema = z.strictObject({
  profile: nameSchema,
  hosts: z.array(z.string().regex(HOST_PATTERN, 'invalid host id')).optional(),
});

export const PolicyFileSchema = z.strictObject({
  version: z.literal(1).optional(),
  profiles: z.record(nameSchema, ProfileSchema).optional(),
  contexts: z.record(z.string().regex(CONTEXT_ID, 'invalid context id'), ContextSchema).optional(),
});
export type RawPolicy = z.infer<typeof PolicyFileSchema>;
