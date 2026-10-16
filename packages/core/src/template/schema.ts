import { z } from 'zod';
import {
  BACKEND_KINDS,
  ISOLATION_LEVELS,
  NETWORK_MODES,
  WORKSPACE_MODES,
  type PackageManager,
  type TemplateSpec,
} from '../types.js';
import { NETWORK_PRESETS, isNetworkPreset } from './network-presets.js';

// ---------------------------------------------------------------------------
// Value grammars (exported so resolve/validate can re-check programmatic specs)
// ---------------------------------------------------------------------------

export const TEMPLATE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62})$/;
const SIZE_RE = /^(\d+(?:\.\d+)?)(?:([kmgt])(?:i?b)?|b)?$/i;
const DURATION_PART_RE = /(\d+)([smhd])/g;
const DURATION_RE = /^(?:\d+[smhd])+$/;
/** `name` or `name@version`. */
export const TOOL_REF_RE = /^([a-z][a-z0-9-]*)(?:@([A-Za-z0-9][A-Za-z0-9._+-]*))?$/;
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** The last label must start with a letter, which rules out IPv4 addresses. */
const DOMAIN_TLD = '[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** `example.org`, `*.example.org`, optional `:port`. At least two labels after an optional `*.`. */
export const DOMAIN_PATTERN_RE = new RegExp(
  `^(?:\\*\\.)?(?:${DOMAIN_LABEL}\\.)+${DOMAIN_TLD}(?::(\\d{1,5}))?$`,
  'i',
);
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_REF_RE = /^[a-z0-9-]+$/;
const USER_NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
/** Image reference / distro name. Must not start with `-` (option injection) and has a conservative charset. */
const IMAGE_REF_RE = /^[a-z0-9][A-Za-z0-9._/:@+-]{0,254}$/;
const PY_VERSION_RE = /^\d+(?:\.\d+){0,2}$/;

const SAFE_PKG_RE = /^[a-zA-Z0-9][a-zA-Z0-9.+_:=~-]*$/;
/** npm additionally allows scopes (`@types/node`) and a version suffix (`typescript@5.6`). */
const SAFE_NPM_PKG_RE =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9.+_~-]*(?:@[a-zA-Z0-9][a-zA-Z0-9.+_~-]*)?$/;

/** Package names are interpolated into shell commands; only a safe charset is accepted. */
export function isSafePackageName(manager: PackageManager, name: string): boolean {
  if (name.length > 214) return false;
  return manager === 'npm' ? SAFE_NPM_PKG_RE.test(name) : SAFE_PKG_RE.test(name);
}

const SIZE_UNITS: Record<string, number> = {
  '': 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/** Parses `512m`, `4g`, `1.5g`, `2048k`, plain bytes. Returns bytes (integer). Throws `RangeError` on bad input. */
export function parseSize(str: string): number {
  const m = SIZE_RE.exec(str.trim());
  if (!m) throw new RangeError(`invalid size "${str}" (examples: 512m, 4g, 1.5g)`);
  const unit = (m[2] ?? '').toLowerCase();
  const bytes = Math.floor(Number(m[1]) * (SIZE_UNITS[unit] ?? 1));
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new RangeError(`invalid size "${str}": must be greater than zero`);
  return bytes;
}

const DURATION_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses `30s`, `15m`, `2h`, `1d` and combinations like `1h30m`. Returns milliseconds. Throws `RangeError` on bad input. */
export function parseDuration(str: string): number {
  const s = str.trim();
  if (!DURATION_RE.test(s))
    throw new RangeError(`invalid duration "${str}" (examples: 30s, 15m, 2h, 1d, 1h30m)`);
  let ms = 0;
  for (const m of s.matchAll(DURATION_PART_RE)) ms += Number(m[1]) * (DURATION_UNITS[m[2]!] ?? 0);
  if (!Number.isSafeInteger(ms) || ms <= 0)
    throw new RangeError(`invalid duration "${str}": must be greater than zero`);
  return ms;
}

function tryParse<T>(fn: () => T): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Returns the `:port` of a domain pattern, if any. */
export function domainPatternPort(pattern: string): number | undefined {
  const m = DOMAIN_PATTERN_RE.exec(pattern);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Zod building blocks
// ---------------------------------------------------------------------------

const strOf = (what: string) =>
  z.string({ error: `${what} must be a string (quote the value in YAML)` });

const sizeString = (what: string, minBytes = 1) =>
  strOf(what).superRefine((v, ctx) => {
    const r = tryParse(() => parseSize(v));
    if (!r.ok) ctx.addIssue({ code: 'custom', message: `${what}: ${r.message}` });
    else if (r.value < minBytes)
      ctx.addIssue({
        code: 'custom',
        message: `${what} "${v}" is too small (minimum ${minBytes} bytes)`,
      });
  });

const durationString = (what: string) =>
  strOf(what).superRefine((v, ctx) => {
    const r = tryParse(() => parseDuration(v));
    if (!r.ok) ctx.addIssue({ code: 'custom', message: `${what}: ${r.message}` });
  });

const domainPattern = (what: string) =>
  strOf(what).superRefine((v, ctx) => {
    if (!DOMAIN_PATTERN_RE.test(v)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid domain pattern "${v}" (use example.org, *.example.org or host:port; bare TLD wildcards like *.org and IP addresses are not allowed)`,
      });
      return;
    }
    const port = domainPatternPort(v);
    if (port !== undefined && (port < 1 || port > 65535))
      ctx.addIssue({ code: 'custom', message: `invalid port in "${v}"` });
  });

const absolutePath = (what: string) =>
  strOf(what).superRefine((v, ctx) => {
    if (!v.startsWith('/'))
      ctx.addIssue({ code: 'custom', message: `${what} must be an absolute path (got "${v}")` });
    else if (v.includes('\0'))
      ctx.addIssue({ code: 'custom', message: `${what} must not contain NUL bytes` });
    else if (v.split('/').includes('..'))
      ctx.addIssue({
        code: 'custom',
        message: `${what} must not contain ".." segments (got "${v}")`,
      });
  });

const packageList = (manager: PackageManager) =>
  z.array(
    strOf(`packages.${manager} entry`).superRefine((v, ctx) => {
      if (!isSafePackageName(manager, v)) {
        ctx.addIssue({
          code: 'custom',
          message: `unsafe package name "${v}" for ${manager} (allowed: letters, digits and . + _ : = ~ - ; must start with a letter or digit)`,
        });
      }
    }),
  );

const packagesSchema = z.strictObject({
  apt: packageList('apt').optional(),
  apk: packageList('apk').optional(),
  dnf: packageList('dnf').optional(),
  pacman: packageList('pacman').optional(),
  pip: packageList('pip').optional(),
  npm: packageList('npm').optional(),
});

const imageRef = (what: string) =>
  strOf(what).superRefine((v, ctx) => {
    if (!IMAGE_REF_RE.test(v))
      ctx.addIssue({
        code: 'custom',
        message: `invalid ${what} "${v}" (letters, digits and . _ / : @ + - only; must not start with "-")`,
      });
  });

const baseSchema = z
  .strictObject({
    os: imageRef('base.os').optional(),
    dockerfile: strOf('base.dockerfile')
      .superRefine((v, ctx) => {
        if (v.startsWith('/'))
          ctx.addIssue({
            code: 'custom',
            message: 'base.dockerfile must be relative to the template file, not absolute',
          });
        if (v.includes('\0') || v.length === 0)
          ctx.addIssue({ code: 'custom', message: 'base.dockerfile must be a non-empty path' });
      })
      .optional(),
  })
  .default({});

const toolRef = strOf('tool').superRefine((v, ctx) => {
  if (!TOOL_REF_RE.test(v))
    ctx.addIssue({
      code: 'custom',
      message: `invalid tool reference "${v}" (use "name" or "name@version", e.g. node@24)`,
    });
});

const mountSource = strOf('mounts[].source').superRefine((v, ctx) => {
  if (!(v.startsWith('/') || v === '~' || v.startsWith('~/'))) {
    ctx.addIssue({
      code: 'custom',
      message: `mount source must be absolute or start with "~/" (got "${v}")`,
    });
  } else if (v.includes('\0')) {
    ctx.addIssue({ code: 'custom', message: 'mount source must not contain NUL bytes' });
  }
});

const accessMode = z.enum(['ro', 'rw'], { error: 'access must be "ro" or "rw"' });

const envSchema = z.record(
  z.string().regex(ENV_KEY_RE, { error: 'env keys must match [A-Za-z_][A-Za-z0-9_]*' }),
  z.string({
    error: 'env values must be strings (quote numbers and booleans in YAML, e.g. "3000")',
  }),
);

const labelsSchema = z.record(
  z
    .string()
    .regex(LABEL_KEY_RE, { error: 'label keys may contain letters, digits and . _ / - only' })
    .refine((k) => !/^abox[./]/i.test(k), {
      error: 'label keys starting with "abox." are reserved for abox itself',
    }),
  z
    .string({ error: 'label values must be strings' })
    .max(256, { error: 'label values are limited to 256 characters' }),
);

export const templateSchema = z.strictObject({
  apiVersion: z.literal(1, {
    error: 'apiVersion must be 1 (the only version this abox understands)',
  }),
  name: strOf('name').regex(TEMPLATE_NAME_RE, {
    error:
      'name must match ^[a-z0-9]([a-z0-9-]{0,62})$ (lowercase letters, digits and "-", max 63 characters)',
  }),
  description: strOf('description')
    .max(2000, { error: 'description is limited to 2000 characters' })
    .optional(),
  backend: z.enum(BACKEND_KINDS, { error: `backend must be one of: ${BACKEND_KINDS.join(', ')}` }),
  isolation: z
    .enum(ISOLATION_LEVELS, { error: `isolation must be one of: ${ISOLATION_LEVELS.join(', ')}` })
    .optional(),
  base: baseSchema,
  packages: packagesSchema.optional(),
  tools: z.array(toolRef).optional(),
  setup: z
    .array(
      z.strictObject({
        run: strOf('setup[].run').refine((v) => v.trim().length > 0, {
          error: 'setup command must not be empty',
        }),
      }),
    )
    .optional(),
  user: z
    .strictObject({
      name: strOf('user.name')
        .regex(USER_NAME_RE, { error: 'user.name must match ^[a-z_][a-z0-9_-]{0,31}$' })
        .optional(),
      uid: z
        .number({ error: 'user.uid must be a number' })
        .int({ error: 'user.uid must be an integer' })
        .min(0)
        .max(65534)
        .optional(),
      sudo: z.boolean({ error: 'user.sudo must be true or false' }).optional(),
    })
    .optional(),
  workspace: z
    .strictObject({
      mode: z
        .enum(WORKSPACE_MODES, {
          error: `workspace.mode must be one of: ${WORKSPACE_MODES.join(', ')}`,
        })
        .optional(),
      path: absolutePath('workspace.path').optional(),
      access: accessMode.optional(),
      ref: strOf('workspace.ref')
        .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/, {
          error: 'workspace.ref must be a plain git ref (letters, digits and . _ / -)',
        })
        .optional(),
    })
    .optional(),
  resources: z
    .strictObject({
      cpus: z
        .number({ error: 'resources.cpus must be a number' })
        .positive({ error: 'resources.cpus must be greater than 0' })
        .max(256)
        .optional(),
      memory: sizeString('resources.memory', 16 * 1024 ** 2).optional(),
      disk: sizeString('resources.disk').optional(),
      pids: z
        .number({ error: 'resources.pids must be a number' })
        .int({ error: 'resources.pids must be an integer' })
        .min(8, { error: 'resources.pids must be at least 8' })
        .max(4_194_304)
        .optional(),
      ttl: durationString('resources.ttl').optional(),
    })
    .optional(),
  network: z
    .strictObject({
      mode: z
        .enum(NETWORK_MODES, { error: `network.mode must be one of: ${NETWORK_MODES.join(', ')}` })
        .optional(),
      allow: z.array(domainPattern('network.allow entry')).optional(),
      presets: z
        .array(
          strOf('network.presets entry').refine(isNetworkPreset, {
            error: `unknown network preset (known: ${Object.keys(NETWORK_PRESETS).join(', ')})`,
          }),
        )
        .optional(),
    })
    .optional(),
  mounts: z
    .array(
      z.strictObject({
        source: mountSource,
        target: absolutePath('mounts[].target'),
        access: accessMode.optional(),
      }),
    )
    .optional(),
  env: envSchema.optional(),
  secrets: z
    .array(
      z.strictObject({
        ref: strOf('secrets[].ref').regex(SECRET_REF_RE, {
          error: 'secret ref must match [a-z0-9-]+',
        }),
        inject: z
          .enum(['proxy', 'env', 'file'], {
            error: 'secrets[].inject must be one of: proxy, env, file',
          })
          .optional(),
        hosts: z.array(domainPattern('secrets[].hosts entry')).optional(),
        path: absolutePath('secrets[].path').optional(),
      }),
    )
    .optional(),
  labels: labelsSchema.optional(),
  extends: strOf('extends')
    .regex(TEMPLATE_NAME_RE, {
      error: 'extends must be a template name (^[a-z0-9]([a-z0-9-]{0,62})$)',
    })
    .optional(),
  python: z
    .strictObject({
      version: strOf('python.version')
        .regex(PY_VERSION_RE, { error: 'python.version must look like 3.13 or 3.13.1' })
        .optional(),
      project: strOf('python.project').min(1).optional(),
    })
    .optional(),
  vm: z
    .strictObject({
      image: imageRef('vm.image').optional(),
      cloudInit: strOf('vm.cloudInit').min(1).optional(),
      diskSize: sizeString('vm.diskSize').optional(),
    })
    .optional(),
});

export type TemplateSchemaOutput = z.output<typeof templateSchema>;

// Compile-time assertion: the schema output and `TemplateSpec` are assignable both ways.
type AssertTrue<T extends true> = T;
type _SchemaToSpec = AssertTrue<TemplateSchemaOutput extends TemplateSpec ? true : false>;
type _SpecToSchema = AssertTrue<TemplateSpec extends TemplateSchemaOutput ? true : false>;
export type _TemplateTypeAssertions = [_SchemaToSpec, _SpecToSchema];

/** Validates an already-parsed object. Throws `ZodError`; use `parseTemplateYaml` for positioned errors. */
export function parseTemplateObject(input: unknown): TemplateSpec {
  return templateSchema.parse(input);
}
