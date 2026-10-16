import { isIP } from 'node:net';
import { z } from 'zod';
import { AboxError, type ErrorIssue } from '../errors.js';
import { ISOLATION_LEVELS } from '../types.js';
import { parseSize } from '../template/schema.js';
import {
  FORWARD_KINDS,
  HOST_BACKEND_KINDS,
  HOST_ZONES,
  LOCAL_HOST_ID,
  type HostProfile,
} from './model.js';

// ---------------------------------------------------------------------------
// Value grammars. Everything that ends up in an ssh argv (or in the fixed remote
// probe) is checked against these. They are deliberately conservative: no leading
// `-` (option injection), no whitespace, quotes, `;`, `$`, backticks or newlines.
// ---------------------------------------------------------------------------

export const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DNS_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';
const DNS_NAME_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);
/** `ssh_config` alias: exact name, no wildcard characters. */
const ALIAS_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** Absolute path on the remote host or the local abox runtime dir (no `:` because of `-L a:b`, no `%`). */
const SAFE_ABS_PATH_RE = /^\/[A-Za-z0-9_.@+=,/-]{1,200}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,31}$/u;
const FORWARD_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isHostId(v: string): boolean {
  return HOST_ID_RE.test(v);
}

export function isDnsName(v: string): boolean {
  return v.length <= 253 && DNS_NAME_RE.test(v);
}

/** DNS name, IPv4 or IPv6 literal (no zone id). */
export function isHostname(v: string): boolean {
  return isDnsName(v) || (isIP(v) === 6 && !v.includes('%'));
}

export function isSshAlias(v: string): boolean {
  return ALIAS_RE.test(v);
}

export function isSshUser(v: string): boolean {
  return USER_RE.test(v);
}

export function isSafeAbsPath(v: string): boolean {
  return SAFE_ABS_PATH_RE.test(v);
}

/** Local key path: absolute or `~/…`, no control characters, no `%` (ssh token expansion). */
export function isIdentityPath(v: string): boolean {
  if (v.length > 4096 || CONTROL_CHARS_RE.test(v) || v.includes('%') || v.includes('"'))
    return false;
  return v.startsWith('/') || v.startsWith('~/');
}

function parsePort(v: string): number | undefined {
  if (!/^\d{1,5}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/** `[user@]host[:port]` or `[user@][v6][:port]`. */
export function isJumpHop(v: string): boolean {
  let rest = v;
  const at = rest.indexOf('@');
  if (at >= 0) {
    if (!isSshUser(rest.slice(0, at))) return false;
    rest = rest.slice(at + 1);
  }
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) return false;
    const inner = rest.slice(1, end);
    if (isIP(inner) === 0 && !isSshAlias(inner)) return false;
    const tail = rest.slice(end + 1);
    return tail === '' || (tail.startsWith(':') && parsePort(tail.slice(1)) !== undefined);
  }
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) {
    if (parsePort(rest.slice(colon + 1)) === undefined) return false;
    rest = rest.slice(0, colon);
  }
  return isSshAlias(rest) && !rest.includes('..');
}

export function isProxyJump(v: string): boolean {
  if (v.length > 512) return false;
  const hops = v.split(',');
  return hops.length <= 8 && hops.every((h) => isJumpHop(h));
}

export interface ParsedJumpHop {
  user?: string;
  host: string;
  port?: number;
}

export function parseJumpHop(hop: string): ParsedJumpHop {
  let rest = hop;
  let user: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    const tail = rest.slice(end + 1);
    if (tail.startsWith(':')) port = parsePort(tail.slice(1));
    rest = rest.slice(1, end);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon >= 0) {
      port = parsePort(rest.slice(colon + 1));
      rest = rest.slice(0, colon);
    }
  }
  return {
    ...(user !== undefined ? { user } : {}),
    host: rest,
    ...(port !== undefined ? { port } : {}),
  };
}

/** Listen address of a forward: `port`, `loopback:port` or an absolute socket path. */
export function isForwardListen(v: string): boolean {
  if (v.startsWith('/')) return isSafeAbsPath(v);
  const m = /^(?:(127\.0\.0\.1|localhost|\[::1\]):)?(\d{1,5})$/.exec(v);
  return (
    m !== null && parsePort(m[2]!) !== undefined && (m[1] === undefined || LOOPBACK_HOSTS.has(m[1]))
  );
}

/** Forward target: `host:port`, `[v6]:port` or an absolute socket path. */
export function isForwardTarget(v: string): boolean {
  if (v.startsWith('/')) return isSafeAbsPath(v);
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_][A-Za-z0-9._-]*):(\d{1,5})$/.exec(v);
  if (!m || parsePort(m[2]!) === undefined) return false;
  const host = m[1]!;
  return host.startsWith('[') ? isIP(host.slice(1, -1)) === 6 : isDnsName(host);
}

// ---------------------------------------------------------------------------
// Zod schema of hosts.yaml (snake_case, strict)
// ---------------------------------------------------------------------------

const str = (what: string, ok: (v: string) => boolean, hint: string) =>
  z.string().refine(ok, { message: `invalid ${what}: ${hint}` });

const PortForwardSchema = z
  .strictObject({
    name: str('forward name', (v) => FORWARD_NAME_RE.test(v), 'use [a-z0-9-], max 32 characters'),
    kind: z.enum(FORWARD_KINDS),
    listen: z.union([
      z.number().int().min(1).max(65535).transform(String),
      str(
        'listen address',
        isForwardListen,
        'use "port", "127.0.0.1:port" or an absolute socket path',
      ),
    ]),
    target: str('target', isForwardTarget, 'use "host:port" or an absolute socket path').optional(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === 'dynamic' && f.target !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'dynamic forwards have no target',
      });
    }
    if (f.kind !== 'dynamic' && f.target === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: `${f.kind} forwards need a target`,
      });
    }
    if (f.kind === 'dynamic' && f.listen.startsWith('/')) {
      ctx.addIssue({
        code: 'custom',
        path: ['listen'],
        message: 'dynamic forwards listen on a port',
      });
    }
  });

const LimitsSchema = z.strictObject({
  cpus: z.number().positive().max(1024).optional(),
  memory: z
    .string()
    .refine(
      (v) => {
        try {
          parseSize(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'invalid size (examples: 512m, 4g)' },
    )
    .optional(),
  sandboxes: z.number().int().min(0).max(10_000).optional(),
});

export const RawHostSchema = z
  .strictObject({
    kind: z.enum(['local', 'ssh']).optional(),
    hostname: str('hostname', isHostname, 'DNS name, IPv4 or IPv6 address').optional(),
    port: z.number().int().min(1).max(65535).optional(),
    user: str('user', isSshUser, 'letters, digits, ._- (no leading -)').optional(),
    ssh_config_alias: str(
      'ssh_config_alias',
      isSshAlias,
      'plain alias without wildcards',
    ).optional(),
    proxy_jump: str(
      'proxy_jump',
      isProxyJump,
      'use [user@]host[:port], comma separated',
    ).optional(),
    identity_file: str(
      'identity_file',
      isIdentityPath,
      'absolute path or ~/…, no % or quotes',
    ).optional(),
    zone: z.enum(HOST_ZONES).optional(),
    min_isolation: z.enum(ISOLATION_LEVELS).optional(),
    backends: z.array(z.enum(HOST_BACKEND_KINDS)).max(HOST_BACKEND_KINDS.length).optional(),
    engine_socket: str(
      'engine_socket',
      isSafeAbsPath,
      'absolute path without spaces, quotes or ":"',
    ).optional(),
    data_dir: str(
      'data_dir',
      isSafeAbsPath,
      'absolute path without spaces, quotes or ":"',
    ).optional(),
    tags: z
      .array(str('tag', (v) => TAG_RE.test(v), 'letters, digits, ._-'))
      .max(32)
      .optional(),
    favorite: z.boolean().optional(),
    limits: LimitsSchema.optional(),
    port_forwards: z.array(PortForwardSchema).max(64).optional(),
  })
  .superRefine((h, ctx) => {
    const add = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (h.kind === 'local') {
      for (const k of [
        'hostname',
        'port',
        'user',
        'ssh_config_alias',
        'proxy_jump',
        'identity_file',
      ] as const) {
        if (h[k] !== undefined) add(k, `not allowed for kind "local"`);
      }
      if (h.port_forwards?.length) add('port_forwards', 'not allowed for kind "local"');
    } else if (h.kind === 'ssh' && h.hostname === undefined && h.ssh_config_alias === undefined) {
      add('hostname', 'an ssh host needs "hostname" or "ssh_config_alias"');
    }
    if (h.backends && new Set(h.backends).size !== h.backends.length)
      add('backends', 'duplicate backend');
    if (h.port_forwards) {
      const names = new Set<string>();
      h.port_forwards.forEach((f, i) => {
        if (names.has(f.name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['port_forwards', i, 'name'],
            message: `duplicate forward "${f.name}"`,
          });
        }
        names.add(f.name);
      });
    }
  });

export type RawHost = z.infer<typeof RawHostSchema>;

export const HostsFileSchema = z
  .strictObject({
    version: z.literal(1).optional(),
    hosts: z
      .record(
        z.string().refine((id) => HOST_ID_RE.test(id), {
          message: 'invalid host id: use [a-z0-9-], starting with a letter or digit',
        }),
        RawHostSchema,
      )
      .optional(),
  })
  .superRefine((f, ctx) => {
    for (const [id, h] of Object.entries(f.hosts ?? {})) {
      if (id === LOCAL_HOST_ID && h.kind === 'ssh') {
        ctx.addIssue({
          code: 'custom',
          path: ['hosts', id, 'kind'],
          message: 'the host "local" must have kind "local"',
        });
      }
      if (id !== LOCAL_HOST_ID && h.kind === 'local') {
        ctx.addIssue({
          code: 'custom',
          path: ['hosts', id, 'kind'],
          message: 'kind "local" is reserved for the host "local"',
        });
      }
    }
  });

export type RawHostsFile = z.infer<typeof HostsFileSchema>;

// ---------------------------------------------------------------------------
// raw <-> profile
// ---------------------------------------------------------------------------

export function rawToProfile(id: string, raw: RawHost): HostProfile {
  const kind = raw.kind ?? (id === LOCAL_HOST_ID ? 'local' : 'ssh');
  const profile: HostProfile = {
    id,
    kind,
    zone: raw.zone ?? (kind === 'local' ? 'workstation' : 'shared'),
    backends: raw.backends ?? (kind === 'local' ? ['docker', 'process'] : []),
    tags: raw.tags ?? [],
    favorite: raw.favorite ?? false,
    portForwards: (raw.port_forwards ?? []).map((f) => ({
      name: f.name,
      kind: f.kind,
      listen: f.listen,
      ...(f.target !== undefined ? { target: f.target } : {}),
    })),
  };
  if (raw.hostname !== undefined) profile.hostname = raw.hostname;
  if (raw.port !== undefined) profile.port = raw.port;
  if (raw.user !== undefined) profile.user = raw.user;
  if (raw.ssh_config_alias !== undefined) profile.sshConfigAlias = raw.ssh_config_alias;
  if (raw.proxy_jump !== undefined) profile.proxyJump = raw.proxy_jump;
  if (raw.identity_file !== undefined) profile.identityFile = raw.identity_file;
  if (raw.min_isolation !== undefined) profile.minIsolation = raw.min_isolation;
  if (raw.engine_socket !== undefined) profile.engineSocket = raw.engine_socket;
  if (raw.data_dir !== undefined) profile.dataDir = raw.data_dir;
  if (raw.limits !== undefined) profile.limits = { ...raw.limits };
  return profile;
}

/** Inverse of `rawToProfile`; omits empty/default values so the file stays readable. */
export function profileToRaw(p: HostProfile): RawHost {
  const raw: RawHost = { kind: p.kind };
  if (p.hostname !== undefined) raw.hostname = p.hostname;
  if (p.port !== undefined) raw.port = p.port;
  if (p.user !== undefined) raw.user = p.user;
  if (p.sshConfigAlias !== undefined) raw.ssh_config_alias = p.sshConfigAlias;
  if (p.proxyJump !== undefined) raw.proxy_jump = p.proxyJump;
  if (p.identityFile !== undefined) raw.identity_file = p.identityFile;
  raw.zone = p.zone;
  if (p.minIsolation !== undefined) raw.min_isolation = p.minIsolation;
  raw.backends = [...p.backends];
  if (p.engineSocket !== undefined) raw.engine_socket = p.engineSocket;
  if (p.dataDir !== undefined) raw.data_dir = p.dataDir;
  if (p.tags.length > 0) raw.tags = [...p.tags];
  if (p.favorite) raw.favorite = true;
  if (p.limits !== undefined && Object.keys(p.limits).length > 0) raw.limits = { ...p.limits };
  if (p.portForwards.length > 0) {
    raw.port_forwards = p.portForwards.map((f) => ({
      name: f.name,
      kind: f.kind,
      listen: f.listen,
      ...(f.target !== undefined ? { target: f.target } : {}),
    }));
  }
  return raw;
}

export function zodIssuesToErrorIssues(
  issues: readonly z.core.$ZodIssue[],
  base: Array<string | number> = [],
): ErrorIssue[] {
  const out: ErrorIssue[] = [];
  for (const issue of issues) {
    const path = [
      ...base,
      ...issue.path.filter((s): s is string | number => typeof s !== 'symbol'),
    ];
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys)
        out.push({ path: [...path, k].join('.'), message: `unknown key "${k}"` });
    } else {
      out.push({ path: path.join('.') || undefined, message: issue.message });
    }
  }
  return out;
}

/**
 * Validates a profile object (programmatic use: CLI flags, GUI forms, tests). Throws
 * `AboxError('invalid_input')` with field paths in the YAML spelling (`proxy_jump`, …).
 * The ssh argument builder calls this too, so no unvalidated value reaches an argv.
 */
export function validateHostProfile(profile: HostProfile): HostProfile {
  const issues: ErrorIssue[] = [];
  if (!HOST_ID_RE.test(profile.id)) {
    issues.push({
      path: 'id',
      message: `invalid host id "${profile.id}": use [a-z0-9-], starting with a letter or digit`,
    });
  }
  if (profile.id === LOCAL_HOST_ID && profile.kind !== 'local') {
    issues.push({ path: 'kind', message: 'the host "local" must have kind "local"' });
  }
  if (profile.id !== LOCAL_HOST_ID && profile.kind === 'local') {
    issues.push({ path: 'kind', message: 'kind "local" is reserved for the host "local"' });
  }
  const parsed = RawHostSchema.safeParse(profileToRaw(profile));
  if (!parsed.success) issues.push(...zodIssuesToErrorIssues(parsed.error.issues));
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new AboxError(
      'invalid_input',
      `invalid host profile "${profile.id}": ${first.path ? first.path + ': ' : ''}${first.message}`,
      { issues, hint: 'See docs for the hosts.yaml fields.' },
    );
  }
  return profile;
}
