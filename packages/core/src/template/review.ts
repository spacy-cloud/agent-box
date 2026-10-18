import { stringify } from 'yaml';
import type { ResolvedTemplate } from '../types.js';

/**
 * Review material for templates that are about to be trusted (project templates from a
 * repository): a canonical text of the resolved template, a unified diff between two such texts and
 * the risky points in plain words. Pure functions; the manager decides what to compare against.
 */

const SETUP_STEP = /^setup #\d+$/;

function formatBytes(bytes: number): string {
  for (const [factor, suffix] of [
    [1024 ** 4, 't'],
    [1024 ** 3, 'g'],
    [1024 ** 2, 'm'],
    [1024, 'k'],
  ] as const) {
    if (bytes >= factor && bytes % factor === 0) return `${bytes / factor}${suffix}`;
  }
  return `${bytes}b`;
}

function formatMs(ms: number): string {
  for (const [factor, suffix] of [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1000, 's'],
  ] as const) {
    if (ms >= factor && ms % factor === 0) return `${ms / factor}${suffix}`;
  }
  return `${ms}ms`;
}

/** The setup commands exactly as the template author wrote them (without the `set -eu` wrapper). */
function setupCommands(t: ResolvedTemplate): string[] {
  return t.build
    .filter((s) => SETUP_STEP.test(s.name))
    .map((s) => s.script.replace(/^set -eu\n/, '').replace(/\n$/, ''));
}

/**
 * Canonical, human-readable text of a resolved template (`extends` applied, defaults filled in),
 * stable across runs, without anything that differs per checkout (source path, hashes). The
 * subject of the review diff: everything that decides what runs, what is shared and what can leave.
 */
export function renderTemplateSnapshot(t: ResolvedTemplate): string {
  const setup = setupCommands(t);
  const doc: Record<string, unknown> = {
    name: t.name,
    description: t.description.trim() || undefined,
    backend: t.backend,
    isolation: t.isolation,
    base: {
      ...(t.base.os !== undefined ? { os: t.base.os } : {}),
      ...(t.base.dockerfile !== undefined ? { dockerfile: t.base.dockerfile } : {}),
    },
    // The Dockerfile verbatim and what else the engine receives with it: a change to any of it shows in the diff.
    dockerfile: t.buildContext ? t.buildContext.dockerfileText : undefined,
    build_context: t.buildContext
      ? {
          files: t.buildContext.files.map((f) =>
            f.type === 'symlink'
              ? `${f.path} -> ${f.target ?? ''}`
              : `${f.path} (${f.size} bytes, sha256 ${f.sha256.slice(0, 12)})`,
          ),
          ...(t.buildContext.filesTruncated
            ? { more: `${t.buildContext.fileCount - t.buildContext.files.length} more files` }
            : {}),
          digest: t.buildContext.digest.slice(0, 16),
        }
      : undefined,
    // Packages and tool presets by their short labels (their scripts come from abox); setup verbatim.
    install: t.build.filter((s) => !SETUP_STEP.test(s.name)).map((s) => s.name),
    setup: setup.length > 0 ? setup : undefined,
    user: { name: t.user.name, uid: t.user.uid, sudo: t.user.sudo },
    workspace: { ...t.workspace },
    resources: {
      cpus: t.resources.cpus,
      memory: formatBytes(t.resources.memoryBytes),
      ...(t.resources.diskBytes !== undefined ? { disk: formatBytes(t.resources.diskBytes) } : {}),
      pids: t.resources.pids,
      ttl: formatMs(t.resources.ttlMs),
    },
    network: {
      mode: t.network.mode,
      ...(t.network.allow.length > 0 ? { allow: t.network.allow } : {}),
    },
    mounts: t.mounts.length > 0 ? t.mounts.map((m) => ({ ...m })) : undefined,
    env: Object.keys(t.env).length > 0 ? sortedRecord(t.env) : undefined,
    secrets:
      t.secrets.length > 0
        ? t.secrets.map((s) => ({
            ref: s.ref,
            inject: s.inject,
            hosts: s.hosts,
            ...(s.path !== undefined ? { path: s.path } : {}),
          }))
        : undefined,
    labels: Object.keys(t.labels).length > 0 ? sortedRecord(t.labels) : undefined,
    caches:
      t.caches.length > 0
        ? t.caches.map((c) => ({
            name: c.name,
            path: c.path,
            ...(Object.keys(c.env).length > 0 ? { env: sortedRecord(c.env) } : {}),
          }))
        : undefined,
    python: t.python,
    vm: t.vm,
  };
  return stringify(doc, { lineWidth: 0, blockQuote: 'literal' });
}

function sortedRecord(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The risky points of a template in plain words (what an approver should look at first):
 * commands run while the image is built, foreign images, mounts, network, secrets, weak isolation.
 */
export function templateRisks(t: ResolvedTemplate): string[] {
  const out: string[] = [];
  const setup = setupCommands(t);
  if (setup.length > 0)
    out.push(
      `runs ${setup.length} setup command${setup.length === 1 ? '' : 's'} as root while the image is built, with network access`,
    );
  if (t.base.dockerfile !== undefined)
    out.push(
      `builds from the Dockerfile ${t.base.dockerfile} from the project: every instruction in it runs at build time` +
        (t.buildContext
          ? `, and every file in ${t.buildContext.dir} (${t.buildContext.fileCount} file${t.buildContext.fileCount === 1 ? '' : 's'}, ${t.buildContext.totalBytes} bytes) can be copied into the image`
          : ''),
    );
  if (t.base.os !== undefined && /^[^/]+\.[^/]+\/|^[^/]+:\d+\//.test(t.base.os))
    out.push(`base image ${t.base.os} comes from a registry outside Docker Hub`);
  if (t.backend === 'process' || t.isolation === 'none')
    out.push('runs directly on the host without isolation: it can read and change your files');
  if (t.user.sudo) out.push('gives the sandbox user sudo (root inside the sandbox)');
  if (t.network.mode === 'open') out.push('network mode open: unrestricted internet access');
  else if (t.network.mode === 'allowlist')
    out.push(
      `network allowlist: ${t.network.allow.length > 0 ? t.network.allow.join(', ') : 'no destinations'}`,
    );
  for (const m of t.mounts)
    out.push(`mounts ${m.source} from the host at ${m.target} (${m.access})`);
  if (t.workspace.mode === 'mount' && t.workspace.access === 'rw')
    out.push('workspace mode mount with write access: changes land in your project directly');
  if (t.workspace.gitignore === false)
    out.push(
      'workspace.gitignore is off: files the project .gitignore lists (.env files, node_modules) are copied into the sandbox as well',
    );
  for (const s of t.secrets)
    out.push(
      s.inject === 'proxy'
        ? `uses secret ${s.ref} (injected by the proxy for ${s.hosts.join(', ') || 'no host'})`
        : `uses secret ${s.ref} injected as ${s.inject === 'env' ? 'an environment variable' : 'a file'}: code in the sandbox can read it`,
    );
  return out;
}

// ---------------------------------------------------------------------------
// Unified diff (Myers)
// ---------------------------------------------------------------------------

type Op = { t: ' ' | '-' | '+'; line: string };

/** Shortest edit script between two line lists (Myers, O(ND)). */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 2);
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (!found) v = v.slice();
  }
  // backtrack
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', line: b[y - 1]! });
      else ops.push({ t: '-', line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface UnifiedDiffOptions {
  fromLabel: string;
  toLabel: string;
  /** Unchanged lines around each change (default 3). */
  context?: number;
}

/** Unified diff of two texts; the empty string when they are equal. */
export function unifiedDiff(from: string, to: string, opts: UnifiedDiffOptions): string {
  const ops = diffLines(splitLines(from), splitLines(to));
  if (!ops.some((o) => o.t !== ' ')) return '';
  const ctx = opts.context ?? 3;
  const out = [`--- ${opts.fromLabel}`, `+++ ${opts.toLabel}`];
  // Line numbers (1-based) of the first line each op refers to.
  const starts: Array<{ a: number; b: number }> = [];
  let aLine = 1;
  let bLine = 1;
  for (const o of ops) {
    starts.push({ a: aLine, b: bLine });
    if (o.t !== '+') aLine++;
    if (o.t !== '-') bLine++;
  }
  // Group the changes: two changes closer than 2*ctx unchanged lines share a hunk.
  const changes = ops.flatMap((o, idx) => (o.t === ' ' ? [] : [idx]));
  let g = 0;
  while (g < changes.length) {
    let h = g;
    while (h + 1 < changes.length && changes[h + 1]! - changes[h]! - 1 <= 2 * ctx) h++;
    const from = Math.max(0, changes[g]! - ctx);
    const to = Math.min(ops.length, changes[h]! + ctx + 1);
    const slice = ops.slice(from, to);
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    const aStart = aCount === 0 ? starts[from]!.a - 1 : starts[from]!.a;
    const bStart = bCount === 0 ? starts[from]!.b - 1 : starts[from]!.b;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    g = h + 1;
  }
  return out.join('\n');
}
