import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument, visit, type Document } from 'yaml';
import { AboxError, type ErrorIssue } from '../errors.js';
import type { AboxPaths } from '../config/paths.js';
import { isolationAtLeast, type HostId } from '../types.js';
import { parseSize } from '../template/schema.js';
import { sleepSync } from '../state/db.js';
import {
  LOCAL_HOST_ID,
  ZONE_DEFAULTS,
  type HostProfile,
  type HostProfileInput,
  type HostProfilePatch,
  type ResolvedHostProfile,
  type ResolvedHostLimits,
} from './model.js';
import {
  HostsFileSchema,
  profileToRaw,
  rawToProfile,
  validateHostProfile,
  zodIssuesToErrorIssues,
} from './schema.js';

const FILE_HEADER =
  '# abox host profiles. Metadata only: never put passwords, passphrases or private keys here.\n' +
  '# Agents cannot read or change this file through MCP; use the abox CLI or the app.\n';

/** The implicit `local` host (used when hosts.yaml does not define it). */
export function defaultLocalProfile(): HostProfile {
  return rawToProfile(LOCAL_HOST_ID, { kind: 'local' });
}

/**
 * Parses and validates hosts.yaml text. Invalid input throws `AboxError('invalid_input')`
 * with field-path issues (and line numbers where known). The result always contains `local`.
 */
export function parseHostsYaml(text: string, where = 'hosts.yaml'): Map<HostId, HostProfile> {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const issues: ErrorIssue[] = [];
  for (const err of doc.errors) {
    const pos =
      err.linePos?.[0] ?? (err.pos?.[0] !== undefined ? lc.linePos(err.pos[0]) : undefined);
    issues.push({
      message: err.message.split('\n')[0] ?? err.message,
      line: pos?.line,
      column: pos?.col,
    });
  }
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === '__proto__') {
        issues.push({ message: 'the key "__proto__" is not allowed' });
      }
    },
  });
  if (issues.length > 0) throw invalid(where, issues);

  const json: unknown = doc.toJS({ maxAliasCount: 50 });
  const parsed = HostsFileSchema.safeParse(json === null || json === undefined ? {} : json);
  if (!parsed.success) {
    throw invalid(
      where,
      zodIssuesToErrorIssues(parsed.error.issues).map((i) => ({
        ...i,
        ...(i.path ? locate(doc, lc, i.path.split('.')) : {}),
      })),
    );
  }
  const hosts = new Map<HostId, HostProfile>();
  hosts.set(LOCAL_HOST_ID, defaultLocalProfile());
  for (const [id, raw] of Object.entries(parsed.data.hosts ?? {}))
    hosts.set(id, rawToProfile(id, raw));
  return hosts;
}

function invalid(where: string, issues: ErrorIssue[]): AboxError {
  const first = issues[0];
  const loc = first?.line ? ` (line ${first.line})` : '';
  return new AboxError(
    'invalid_input',
    `invalid hosts file ${where}: ${issues.length} problem(s), first: ${first?.path ? first.path + ': ' : ''}${first?.message ?? 'unknown'}${loc}`,
    {
      issues,
      hint: 'Fix hosts.yaml or restore it from a backup; abox never edits it into an invalid state.',
    },
  );
}

function locate(
  doc: Document,
  lc: LineCounter,
  path: string[],
): { line?: number; column?: number } {
  let node: unknown = doc.contents;
  let offset: number | undefined;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg);
      if (!pair) break;
      offset = (pair.key as { range?: [number, number, number] }).range?.[0] ?? offset;
      node = pair.value;
    } else if (isSeq(node) && /^\d+$/.test(seg)) {
      const item = node.items[Number(seg)];
      if (item === undefined) break;
      node = item;
      offset = (item as { range?: [number, number, number] }).range?.[0] ?? offset;
    } else break;
  }
  if (offset === undefined) return {};
  const pos = lc.linePos(offset);
  return { line: pos.line, column: pos.col };
}

export interface HostRegistryOptions {
  /** Path of hosts.yaml. */
  file: string;
}

/**
 * Reads and writes `hosts.yaml`. Synchronous and cheap: the file is re-read when it changed
 * on disk, so CLI, MCP server and GUI see each other's edits. Writes are atomic (temp file +
 * rename), mode 0600, and serialised across processes by a lock file. Comments in the file
 * survive edits of other hosts.
 *
 * Agents never manage hosts: nothing in this class is meant to be reachable from MCP tools.
 */
export class HostRegistry {
  readonly file: string;
  private cache?: { sig: string; hosts: Map<HostId, HostProfile> };

  constructor(opts: HostRegistryOptions) {
    this.file = opts.file;
  }

  static fromPaths(paths: Pick<AboxPaths, 'hostsFile'>): HostRegistry {
    return new HostRegistry({ file: paths.hostsFile });
  }

  /** All hosts, `local` first, then by id. */
  list(): HostProfile[] {
    const hosts = [...this.load().values()];
    return hosts.sort((a, b) =>
      a.id === LOCAL_HOST_ID ? -1 : b.id === LOCAL_HOST_ID ? 1 : a.id.localeCompare(b.id),
    );
  }

  get(id: HostId): HostProfile | undefined {
    const p = this.load().get(id);
    return p ? structuredClone(p) : undefined;
  }

  has(id: HostId): boolean {
    return this.load().has(id);
  }

  /** Like `get` but throws `not_found` with the list of known hosts. */
  require(id: HostId): HostProfile {
    const p = this.get(id);
    if (!p) {
      throw new AboxError('not_found', `unknown host "${id}"`, {
        hint: `Known hosts: ${[...this.load().keys()].join(', ')}. Add one with "abox host add".`,
      });
    }
    return p;
  }

  add(input: HostProfileInput): HostProfile {
    const profile = normalizeInput(input);
    return this.mutate((hosts) => {
      if (
        hosts.has(profile.id) &&
        !(profile.id === LOCAL_HOST_ID && !this.fileDefines(profile.id))
      ) {
        throw new AboxError('conflict', `host "${profile.id}" already exists`, {
          hint: 'Use update to change it or choose another id.',
        });
      }
      return { op: 'set', profile };
    });
  }

  update(id: HostId, patch: HostProfilePatch): HostProfile {
    return this.mutate((hosts) => {
      const current = hosts.get(id);
      if (!current) {
        throw new AboxError('not_found', `unknown host "${id}"`, { hint: 'Use add to create it.' });
      }
      const merged: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      const profile = normalizeInput({ ...(merged as HostProfileInput), id, kind: current.kind });
      return { op: 'set', profile };
    });
  }

  /** Removes a profile. `local` cannot be removed (its entry can be changed with `update`). */
  remove(id: HostId): boolean {
    if (id === LOCAL_HOST_ID) {
      throw new AboxError('conflict', 'the host "local" always exists and cannot be removed');
    }
    if (!this.load().has(id)) return false;
    this.mutate((hosts) => (hosts.has(id) ? { op: 'delete', id } : { op: 'none' }));
    return true;
  }

  /**
   * Effective settings of a host: zone defaults applied (`shared` -> at least `hardened`,
   * `restricted` -> `vm`; an explicit `min_isolation` can only raise this), limits parsed.
   */
  resolve(id: HostId): ResolvedHostProfile {
    return resolveProfile(this.require(id));
  }

  private fileDefines(id: HostId): boolean {
    try {
      const doc = parseDocument(readFileSync(this.file, 'utf8'));
      return doc.hasIn(['hosts', id]);
    } catch {
      return false;
    }
  }

  private load(): Map<HostId, HostProfile> {
    let sig = 'missing';
    try {
      const st = statSync(this.file);
      sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw this.readError(e);
    }
    if (this.cache?.sig === sig) return this.cache.hosts;
    let hosts: Map<HostId, HostProfile>;
    if (sig === 'missing') {
      hosts = new Map([[LOCAL_HOST_ID, defaultLocalProfile()]]);
    } else {
      let text: string;
      try {
        text = readFileSync(this.file, 'utf8');
      } catch (e) {
        throw this.readError(e);
      }
      hosts = parseHostsYaml(text, this.file);
    }
    this.cache = { sig, hosts };
    return hosts;
  }

  private readError(e: unknown): AboxError {
    return new AboxError(
      'invalid_input',
      `cannot read hosts file ${this.file}: ${(e as Error).message}`,
      {
        hint: 'Check the file permissions of hosts.yaml.',
        cause: e,
      },
    );
  }

  private mutate(
    plan: (
      hosts: Map<HostId, HostProfile>,
    ) => { op: 'set'; profile: HostProfile } | { op: 'delete'; id: HostId } | { op: 'none' },
  ): HostProfile {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    return withFileLock(`${this.file}.lock`, () => {
      this.cache = undefined;
      const hosts = this.load();
      const action = plan(hosts);
      if (action.op === 'none') return defaultLocalProfile();
      let text: string;
      try {
        text = readFileSync(this.file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw this.readError(e);
        text = FILE_HEADER;
      }
      const doc = parseDocument(text);
      if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
        throw invalid(this.file, [
          { message: 'file is not a valid YAML mapping; fix it by hand first' },
        ]);
      }
      if (action.op === 'set') {
        const node = doc.createNode(profileToRaw(action.profile)) as unknown as {
          items: Array<{ key: { value: string }; value: unknown }>;
        };
        for (const pair of node.items) {
          const v = pair.value as { flow?: boolean } | null;
          if (
            (isSeq(v) || isMap(v)) &&
            ['backends', 'tags', 'limits'].includes(String(pair.key.value))
          ) {
            (v as { flow: boolean }).flow = true;
          }
        }
        doc.setIn(['hosts', action.profile.id], node);
      } else {
        doc.deleteIn(['hosts', action.id]);
        const h = doc.get('hosts');
        if (isMap(h) && h.items.length === 0) doc.delete('hosts');
      }
      const out = doc.toString({ lineWidth: 0 });
      // Validate what we are about to write; never persist a file we could not load again.
      parseHostsYaml(out, this.file);
      atomicWrite(this.file, out);
      this.cache = undefined;
      return action.op === 'set' ? structuredClone(action.profile) : defaultLocalProfile();
    });
  }
}

function normalizeInput(input: HostProfileInput): HostProfile {
  const base = rawToProfile(input.id, {
    kind: input.kind ?? (input.id === LOCAL_HOST_ID ? 'local' : 'ssh'),
    ...(input.zone !== undefined ? { zone: input.zone } : {}),
    ...(input.backends !== undefined ? { backends: input.backends } : {}),
  });
  const profile: HostProfile = {
    ...base,
    ...stripUndefined(input as unknown as Record<string, unknown>),
  } as HostProfile;
  profile.tags = [...(input.tags ?? base.tags)];
  profile.portForwards = (input.portForwards ?? base.portForwards).map((f) => ({ ...f }));
  profile.favorite = input.favorite ?? base.favorite;
  return validateHostProfile(profile);
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Zone defaults + limits for a profile. Pure. */
export function resolveProfile(profile: HostProfile): ResolvedHostProfile {
  const zone = ZONE_DEFAULTS[profile.zone];
  const minIsolation =
    profile.minIsolation && isolationAtLeast(profile.minIsolation, zone.minIsolation)
      ? profile.minIsolation
      : zone.minIsolation;
  const limits: ResolvedHostLimits = {};
  if (profile.limits?.cpus !== undefined) limits.cpus = profile.limits.cpus;
  if (profile.limits?.memory !== undefined) {
    limits.memory = profile.limits.memory;
    limits.memoryBytes = parseSize(profile.limits.memory);
  }
  if (profile.limits?.sandboxes !== undefined) limits.sandboxes = profile.limits.sandboxes;
  return {
    host: profile.id,
    profile,
    zone: profile.zone,
    minIsolation,
    requiresApproval: zone.requiresApproval,
    limits,
    backends: [...profile.backends],
  };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function withFileLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15_000) unlinkSync(lock); // stale lock of a crashed process
      } catch {
        /* raced with the owner */
      }
      if (Date.now() > deadline) {
        throw new AboxError('conflict', `could not lock ${lock}`, {
          hint: 'Another abox process is writing hosts.yaml; retry, or remove the stale lock file.',
        });
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
}
