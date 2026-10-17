import { describe, expect, it } from 'vitest';
import type { ResolvedTemplate, SandboxView } from '@abox/core';
import { approvalRows, requestTemplateName, riskHints } from '../../src/shared/approval-diff';
import {
  formatBytes,
  formatCpuPercent,
  formatDuration,
  formatMemoryUsage,
  remainingMs,
  shortId,
  usageFraction,
} from '../../src/shared/format';
import { diffLines, hasChanges } from '../../src/shared/line-diff';
import { EMPTY_FILTERS, filterSandboxes } from '../../src/shared/sandbox-filter';
import { overviewRows } from '../../src/shared/overview';
import { mcpClaudeCommand, mcpJsonConfig } from '../../src/shared/mcp-config';

const createRequest = {
  v: 1,
  kind: 'create',
  owner: 'agent:sim',
  context: 'sim',
  profile: 'agent',
  template: {
    name: 'host-shell',
    hash: 'h',
    contentHash: 'c',
    source: { kind: 'builtin', path: '/x/host-shell.yaml' },
    trusted: true,
  },
  host: { id: 'local', zone: 'workstation' },
  isolation: 'none',
  workspace: { mode: 'copy', hostPath: '/home/u/p' },
  mounts: [{ hostPath: '/data/set', target: '/mnt', access: 'ro' }],
  network: { mode: 'open', allow: [], privateExceptions: ['192.168.1.5'] },
  secrets: [{ ref: 'gh-token', inject: 'env' }],
  resources: { cpus: 2, memoryBytes: 2147483648 },
  ttlMs: 3600000,
  policy: 'deadbeef',
};

describe('approval diff', () => {
  const rows = approvalRows(createRequest);
  const row = (p: string) => rows.find((r) => r.path === p);

  it('marks deviations from the safe defaults', () => {
    expect(row('isolation')).toMatchObject({
      standard: 'container',
      requested: 'none',
      changed: true,
    });
    expect(row('network.mode')).toMatchObject({
      standard: 'none',
      requested: 'open',
      changed: true,
    });
    expect(row('mounts')).toMatchObject({ changed: true, requested: '/data/set -> /mnt (ro)' });
    expect(row('secrets')).toMatchObject({ changed: true, requested: 'gh-token (env)' });
    expect(row('network.privateExceptions')?.changed).toBe(true);
    expect(row('network.allow')?.changed).toBe(false);
  });

  it('formats sizes and durations and hides internal fields', () => {
    expect(row('resources.memoryBytes')?.requested).toBe('2.0 GiB');
    expect(row('ttlMs')?.requested).toBe('1h 00m');
    for (const hidden of [
      'v',
      'kind',
      'owner',
      'context',
      'policy',
      'template.hash',
      'template.contentHash',
    ]) {
      expect(row(hidden)).toBeUndefined();
    }
  });

  it('unchanged options keep the standard column', () => {
    const r = approvalRows({
      isolation: 'container',
      network: { mode: 'none', allow: [] },
      mounts: [],
    });
    expect(r.every((x) => !x.changed)).toBe(true);
  });

  it('derives risk hints', () => {
    expect(riskHints('create', createRequest).sort()).toEqual(
      ['isolation_none', 'mount_outside', 'open_network', 'private_address', 'secret'].sort(),
    );
    expect(riskHints('template_trust', { template: { trusted: false } })).toContain(
      'untrusted_template',
    );
    expect(riskHints('create', { network: { mode: 'allowlist', allow: ['a.org'] } })).toEqual([
      'network_destinations',
    ]);
    expect(riskHints('access', { details: { hostPath: '/etc', target: '/x' } })).toContain(
      'mount_outside',
    );
    expect(riskHints('create', null)).toEqual([]);
  });

  it('extracts the template name', () => {
    expect(requestTemplateName(createRequest)).toBe('host-shell');
    expect(requestTemplateName({})).toBeNull();
  });
});

describe('format', () => {
  it('formats durations and bytes', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(61_000)).toBe('1m 01s');
    expect(formatDuration(3_661_000)).toBe('1h 01m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(remainingMs(1000, 5000)).toBe(0);
    expect(shortId('local/ab12cd34')).toBe('ab12cd34');
  });
});

describe('line diff', () => {
  it('shows additions and deletions with context', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(d.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['b']);
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['B', 'd']);
    expect(hasChanges(d)).toBe(true);
    expect(hasChanges(diffLines('x', 'x'))).toBe(false);
  });
});

function sandbox(over: Partial<SandboxView>): SandboxView {
  return {
    id: 'local/aaaaaaaa',
    name: 'n',
    host: 'local',
    owner: 'human',
    template: 'node-dev',
    templateHash: 'h',
    backend: 'docker',
    isolation: 'container',
    state: 'running',
    createdAt: 0,
    expiresAt: 10_000,
    ttlRemainingMs: 10_000,
    expired: false,
    stale: false,
    missingInBackend: false,
    hostReachable: true,
    lastSeenAt: null,
    error: null,
    workspace: null,
    network: { mode: 'none', allow: [] },
    mounts: [],
    resources: { cpus: 2, memoryBytes: 2147483648, ttlMs: 3600000 },
    secretRefs: [],
    effective: null,
    requestId: null,
    ...over,
  };
}

describe('sandbox filters', () => {
  const list = [
    sandbox({ id: 'local/1', name: 'alpha', owner: 'human' }),
    sandbox({
      id: 'local/2',
      name: 'beta',
      owner: 'agent:claude',
      template: 'py-dev',
      state: 'stopped',
    }),
    sandbox({ id: 'local/3', name: 'gamma', owner: 'agent:codex', state: 'failed' }),
  ];
  it('filters by state, owner, template and text', () => {
    expect(
      filterSandboxes(list, { ...EMPTY_FILTERS, state: 'stopped' }).map((s) => s.name),
    ).toEqual(['beta']);
    expect(filterSandboxes(list, { ...EMPTY_FILTERS, state: 'active' }).map((s) => s.name)).toEqual(
      ['alpha', 'beta'],
    );
    expect(filterSandboxes(list, { ...EMPTY_FILTERS, owner: 'agent' }).map((s) => s.name)).toEqual([
      'beta',
      'gamma',
    ]);
    expect(
      filterSandboxes(list, { ...EMPTY_FILTERS, owner: 'agent:codex' }).map((s) => s.name),
    ).toEqual(['gamma']);
    expect(
      filterSandboxes(list, { ...EMPTY_FILTERS, template: 'py-dev' }).map((s) => s.name),
    ).toEqual(['beta']);
    expect(filterSandboxes(list, { ...EMPTY_FILTERS, text: 'ALP' }).map((s) => s.name)).toEqual([
      'alpha',
    ]);
  });
});

describe('overview rows', () => {
  const tpl = {
    network: { mode: 'none', allow: [] },
    resources: { cpus: 2, memoryBytes: 2147483648, ttlMs: 3600000, pids: 100 },
    workspace: { mode: 'copy', access: 'rw', path: '/workspace' },
  } as unknown as ResolvedTemplate;

  it('highlights isolation none, open network, mounts and deviations from the template', () => {
    const rows = overviewRows(
      sandbox({
        isolation: 'none',
        network: { mode: 'open', allow: [] },
        mounts: [{ hostPath: '/data', target: '/d', access: 'rw' }],
        resources: { cpus: 8, memoryBytes: 2147483648, ttlMs: 3600000 },
        secretRefs: [{ ref: 'k', inject: 'env', hosts: [] }],
      }),
      tpl,
    );
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by('isolation')).toMatchObject({ deviates: true, danger: true });
    expect(by('network')).toMatchObject({ deviates: true, danger: true });
    expect(by('mounts')).toMatchObject({ deviates: true, danger: true });
    expect(by('cpus')).toMatchObject({ deviates: true, danger: false });
    expect(by('memory').deviates).toBe(false);
    expect(by('secrets')).toMatchObject({ deviates: true, danger: true });
  });

  it('a default sandbox has no deviations', () => {
    const rows = overviewRows(sandbox({}), tpl);
    expect(rows.some((r) => r.deviates)).toBe(false);
  });
});

describe('mcp config', () => {
  it('builds copyable strings without secrets', () => {
    expect(mcpClaudeCommand('claude-code')).toBe(
      'claude mcp add abox -- abox mcp serve --agent claude-code',
    );
    const json = JSON.parse(mcpJsonConfig('x')) as { mcpServers: { abox: { args: string[] } } };
    expect(json.mcpServers.abox.args).toEqual(['mcp', 'serve', '--agent', 'x']);
  });
});

describe('live usage formatting', () => {
  it('cpu: one decimal below 10 %, whole numbers above, 100 % is one core', () => {
    expect(formatCpuPercent(0)).toBe('0.0 %');
    expect(formatCpuPercent(3.456)).toBe('3.5 %');
    expect(formatCpuPercent(12.4)).toBe('12 %');
    expect(formatCpuPercent(250)).toBe('250 %');
    expect(formatCpuPercent(Number.NaN)).toBe('-');
    expect(formatCpuPercent(-1)).toBe('-');
  });

  it('memory: against the limit the backend enforces, else the configured one, else just the use', () => {
    const MiB = 1024 * 1024;
    expect(formatMemoryUsage(64 * MiB, 256 * MiB)).toBe('64 MiB / 256 MiB');
    expect(formatMemoryUsage(64 * MiB, null, 512 * MiB)).toBe('64 MiB / 512 MiB');
    expect(formatMemoryUsage(64 * MiB, null)).toBe('64 MiB');
    expect(formatMemoryUsage(64 * MiB, 0, 0)).toBe('64 MiB');
  });

  it('bar fill is clamped to 0..1 and never NaN', () => {
    expect(usageFraction(50, 200)).toBe(0.25);
    expect(usageFraction(500, 200)).toBe(1);
    expect(usageFraction(-5, 200)).toBe(0);
    expect(usageFraction(5, 0)).toBe(0);
    expect(usageFraction(Number.NaN, 10)).toBe(0);
  });
});
