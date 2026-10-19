import { describe, expect, it } from 'vitest';
import type { ActivityEntry, DoctorReport } from '@abox/core';
import {
  activityBadge,
  activityLabelKey,
  activityResult,
  agentActivity,
  approvalHeadline,
  expiringSoon,
  overviewHosts,
  problemCount,
  problemSandboxes,
  runningSandboxes,
} from '../../src/shared/overview-page';
import type { HostRow } from '../../src/shared/types';
import { sb } from '../renderer/fixtures';

const NOW = 1_000_000_000_000;

describe('sandbox numbers', () => {
  it('counts running sandboxes that their backend still reports', () => {
    const list = [
      sb({ id: 'a', state: 'running' }),
      sb({ id: 'b', state: 'running', stale: true }),
      sb({ id: 'c', state: 'stopped' }),
    ];
    expect(runningSandboxes(list).map((s) => s.id)).toEqual(['a']);
  });

  it('finds the ones that need a look: failed, stale, ghost, unreachable host', () => {
    const list = [
      sb({ id: 'ok' }),
      sb({ id: 'failed', state: 'failed' }),
      sb({ id: 'stale', stale: true }),
      sb({ id: 'ghost', missingInBackend: true }),
      sb({ id: 'away', hostReachable: false }),
      sb({ id: 'gone', state: 'removed', hostReachable: false }),
    ];
    expect(problemSandboxes(list).map((s) => s.id)).toEqual(['failed', 'stale', 'ghost', 'away']);
  });

  it('lists running sandboxes that expire within 15 minutes, soonest first', () => {
    const list = [
      sb({ id: 'later', expiresAt: NOW + 20 * 60_000 }),
      sb({ id: 'b', expiresAt: NOW + 10 * 60_000 }),
      sb({ id: 'a', expiresAt: NOW + 2 * 60_000 }),
      sb({ id: 'stopped', state: 'stopped', expiresAt: NOW + 60_000 }),
    ];
    expect(expiringSoon(list, NOW).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('problemCount', () => {
  const report = (summary: Partial<DoctorReport['summary']>, notes = 0): DoctorReport =>
    ({
      ok: true,
      summary: { ok: 3, info: 0, warning: 0, error: 0, ...summary },
      checks: notes
        ? [
            {
              id: 'x',
              level: 'ok',
              severity: 'ok',
              title: 't',
              notes: Array.from({ length: notes }, () => ({
                severity: 'info' as const,
                message: 'm',
              })),
            },
          ]
        : [],
      backends: [],
    }) as unknown as DoctorReport;

  it('problems are errors and warnings; advisories are counted apart', () => {
    expect(problemCount(report({ error: 1, warning: 2, info: 1 }))).toEqual({
      problems: 3,
      errors: 1,
      warnings: 2,
      info: 1,
    });
    expect(problemCount(report({}, 2))).toMatchObject({ problems: 0, info: 2 });
  });
});

describe('approvalHeadline', () => {
  const access = (request: unknown, kind = 'access') => ({
    kind,
    sandboxId: 'local/x',
    request: { v: 1, kind: 'access_request', request },
  });

  it('a lifetime request is a one-line title that can be decided right there', () => {
    const h = approvalHeadline(
      access({ kind: 'ttl', details: { ttlMs: 5 * 3_600_000 } }),
      'flutter-ci',
    );
    expect(h).toMatchObject({
      key: 'overview.approval.ttl',
      params: { sandbox: 'flutter-ci' },
      quick: true,
    });
  });

  it('a port forward and a few plain destinations are quick, too', () => {
    expect(
      approvalHeadline(access({ kind: 'port', details: { sandboxPort: 5173 } }), 's'),
    ).toMatchObject({ key: 'overview.approval.port', params: { port: 5173 }, quick: true });
    expect(
      approvalHeadline(
        access({ kind: 'network', details: { domains: ['registry.npmjs.org'] } }),
        's',
      ),
    ).toMatchObject({
      key: 'overview.approval.network',
      params: { domains: 'registry.npmjs.org' },
      quick: true,
    });
  });

  it('what the title cannot say needs the details first: open network, private addresses, many destinations', () => {
    const net = (details: unknown) =>
      approvalHeadline(access({ kind: 'network', details }), 's')?.quick;
    expect(net({ mode: 'open', domains: ['a.example'] })).toBe(false);
    expect(net({ domains: ['a.example'], privateExceptions: ['10.0.0.0/8'] })).toBe(false);
    expect(net({ domains: ['a', 'b', 'c', 'd'].map((x) => `${x}.example`) })).toBe(false);
  });

  it('other kinds (create, exec, mounts, template trust) have no quick answer', () => {
    expect(approvalHeadline({ kind: 'create', sandboxId: null, request: {} }, '')).toBeNull();
    expect(
      approvalHeadline({ kind: 'template_trust', sandboxId: null, request: {} }, ''),
    ).toBeNull();
    expect(approvalHeadline(access({ kind: 'mount', details: {} }), 's')).toBeNull();
    expect(approvalHeadline(access({ kind: 'ttl', details: {} }), 's')).toBeNull();
  });
});

describe('overviewHosts', () => {
  const row = (id: string, over: Partial<HostRow['profile']> = {}): HostRow =>
    ({ profile: { id, kind: 'ssh', favorite: false, ...over } }) as unknown as HostRow;

  it('puts this computer first, then favorites, then busy hosts, and caps the list', () => {
    const rows = [
      row('zeta'),
      row('busy'),
      row('fav', { favorite: true }),
      row('local', { kind: 'local' }),
    ];
    const { shown, hidden } = overviewHosts(rows, [sb({ host: 'busy' })], 3);
    expect(shown.map((r) => r.profile.id)).toEqual(['local', 'fav', 'busy']);
    expect(hidden).toBe(1);
  });
});

describe('activity', () => {
  const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
    seq: 1,
    ts: NOW,
    kind: 'exec',
    action: 'sandbox.exec',
    actor: 'agent:x',
    outcome: 'ok',
    summary: '',
    detail: {},
    count: 1,
    sandboxId: 'local/x',
    ...over,
  });

  it('keeps what agents did; leaves out people, the system, approval requests and allowed proxy requests', () => {
    const list = [
      entry({ seq: 6 }),
      entry({ seq: 5, actor: 'human' }),
      entry({ seq: 4, actor: 'system' }),
      entry({ seq: 3, kind: 'approval', action: 'approval.request' }),
      entry({ seq: 2, kind: 'network', action: 'network.egress' }),
      entry({ seq: 1, kind: 'network', action: 'network.egress', outcome: 'denied' }),
    ];
    expect(agentActivity(list).map((e) => e.seq)).toEqual([6, 1]);
    expect(agentActivity(list, 1).map((e) => e.seq)).toEqual([6]);
  });

  it('badge: refusals and errors first, exports are their own kind', () => {
    expect(activityBadge(entry({ outcome: 'denied' }))).toBe('blocked');
    expect(activityBadge(entry({ outcome: 'error' }))).toBe('error');
    expect(activityBadge(entry({ outcome: 'pending' }))).toBe('pending');
    expect(activityBadge(entry({ action: 'sandbox.export', kind: 'lifecycle' }))).toBe('export');
    expect(activityBadge(entry({ outcome: 'info' }))).toBe('ok');
    expect(activityBadge(entry({}))).toBe('ok');
  });

  it("the label is the activity tab's; the proxy has one label per decision", () => {
    expect(activityLabelKey(entry({}))).toBe('activity.action.sandbox.exec');
    expect(activityLabelKey(entry({ action: 'network.egress', outcome: 'denied' }))).toBe(
      'activity.action.network.egress.deny',
    );
    expect(activityLabelKey(entry({ action: 'network.egress' }))).toBe(
      'activity.action.network.egress.allow',
    );
  });

  it('the result is an exit code with its duration, or the files an export changed', () => {
    expect(activityResult(entry({ detail: { exitCode: 2, durationMs: 41_000 } }))).toEqual({
      code: 2,
      time: '41s',
    });
    expect(
      activityResult(entry({ action: 'sandbox.export', detail: { filesChanged: 4 } })),
    ).toEqual({ files: 4 });
    expect(activityResult(entry({}))).toEqual({});
  });
});
