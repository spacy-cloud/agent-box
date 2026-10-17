import { readFileSync } from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { AboxError } from '../errors.js';
import type { ErrorIssue } from '../errors.js';

const MINUTE = 60_000;

const socketSchema = z.strictObject({
  /** Unix socket path overriding auto-detection. */
  socket: z.string().min(1).optional(),
  /**
   * OCI runtime for isolation level `hardened` (e.g. `runsc` for gVisor, `kata-runtime`).
   * Used only if the engine actually lists it; otherwise sandboxes stay at `container`.
   */
  runtime: z.string().min(1).optional(),
});

const secretSchema = z.strictObject({
  /** Header the proxy sets, default depends on `scheme`. */
  header: z.string().min(1).optional(),
  scheme: z.enum(['bearer', 'basic-x-access-token', 'raw']).optional(),
  /** Destination hosts the secret may be injected for. */
  hosts: z.array(z.string().min(1)).optional(),
});

export const configSchema = z.strictObject({
  backends: z
    .strictObject({
      /** Removed: a template names its backend itself (`backend:`), so there is nothing to default. */
      default: z
        .never({
          error:
            'backends.default was removed: every template names its backend (backend: docker|podman|process|python|vm); only socket paths are configured here',
        })
        .optional(),
      docker: socketSchema.prefault({}),
      podman: socketSchema.prefault({}),
    })
    .prefault({}),
  defaults: z
    .strictObject({
      /** Template used by `abox create` / `sandbox_create` when none is given. Unset = a template is required. */
      template: z.string().min(1).optional(),
    })
    .prefault({}),
  limits: z
    .strictObject({
      execMaxOutputBytes: z.number().int().positive().default(65_536),
      execTimeoutMs: z.number().int().positive().default(120_000),
      approvalWaitMs: z.number().int().nonnegative().default(30_000),
      approvalTtlMs: z
        .number()
        .int()
        .positive()
        .default(15 * MINUTE),
    })
    .prefault({}),
  /** Per secret reference (keychain entry name) injection settings. */
  secrets: z.record(z.string().min(1), secretSchema).prefault({}),
  logs: z
    .strictObject({
      retentionDays: z.number().int().nonnegative().default(3),
    })
    .prefault({}),
});

export type AboxConfig = z.infer<typeof configSchema>;
export type SecretConfig = z.infer<typeof secretSchema>;

/** All defaults (what a missing or empty `config.yaml` yields). */
export function defaultConfig(): AboxConfig {
  return configSchema.parse({});
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join('.');
}

/** Parse and validate `config.yaml` text. `source` is only used in messages. */
export function parseConfig(text: string, source = 'config.yaml'): AboxConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    const issue: ErrorIssue = { message: e instanceof Error ? e.message : String(e) };
    if (e instanceof YAMLParseError && e.linePos?.[0]) {
      issue.line = e.linePos[0].line;
      issue.column = e.linePos[0].col;
    }
    throw new AboxError('invalid_input', `${source}: invalid YAML: ${issue.message}`, {
      issues: [issue],
      hint: `Fix the syntax of ${source}.`,
    });
  }
  if (raw === null || raw === undefined) raw = {};
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues: ErrorIssue[] = result.error.issues.map((i) => ({
      path: formatPath(i.path),
      message: i.message,
    }));
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    throw new AboxError('invalid_input', `${source}: invalid configuration: ${summary}`, {
      issues,
      hint: `Fix the listed fields in ${source}.`,
    });
  }
  return result.data;
}

/** Load `config.yaml`; a missing file yields the defaults. */
export function loadConfig(file: string): AboxConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw new AboxError('invalid_input', `cannot read ${file}: ${(e as Error).message}`, {
      cause: e,
    });
  }
  return parseConfig(text, file);
}
