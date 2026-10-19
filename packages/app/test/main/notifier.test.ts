import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalView } from '@abox/core';
import { Notifier } from '../../src/main/notifier';
import type { NotificationSpec, NotifierDeps } from '../../src/main/notifier';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/shared/constants';
import type { NotificationPrefs } from '../../src/shared/constants';
import type { Locale } from '../../src/shared/ipc';

function approval(over: Partial<ApprovalView> & { id: string }): ApprovalView {
  return {
    kind: 'create',
    requester: 'agent:ci',
    sandboxId: null,
    status: 'pending',
    reason: 'because',
    risks: [],
    items: [],
    kinds: [],
    reasons: [],
    base: null,
    request: { template: { name: 'host-shell' } },
    createdAt: 0,
    expiresAt: 1,
    decidedAt: null,
    decidedBy: null,
    ...over,
  } as ApprovalView;
}

interface Shown {
  spec: NotificationSpec;
  click(): void;
}

function setup(over: Partial<NotifierDeps> = {}, initial: Partial<NotificationPrefs> = {}) {
  const shown: Shown[] = [];
  const opened: unknown[] = [];
  const prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, ...initial };
  let locale: Locale = 'en';
  const n = new Notifier({
    sink: { show: (spec, click) => void shown.push({ spec, click }) },
    prefs: () => prefs,
    locale: () => locale,
    open: (t) => void opened.push(t),
    mergeMs: 1000,
    minGapMs: 10_000,
    ...over,
  });
  return { n, shown, opened, prefs, setLocale: (l: Locale) => (locale = l) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('approval notifications', () => {
  it('shows who asks, what kind and about what, then opens that approval on click', () => {
    const { n, shown, opened } = setup();
    n.approvalsArrived([approval({ id: 'a1' })]);
    expect(shown).toHaveLength(0); // merged for a moment first
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(1);
    const { spec, click } = shown[0]!;
    expect(spec.kind).toBe('approvals');
    expect(spec.title).toBe('abox: new approval request');
    expect(spec.body).toContain('ci · Create sandbox · host-shell');
    expect(spec.body).toContain('Review and decide in abox.');
    click();
    expect(opened).toEqual([{ view: 'approvals', approvalId: 'a1' }]);
  });

  it('merges a burst into one notification that opens the queue', () => {
    const { n, shown, opened } = setup();
    n.approvalsArrived([approval({ id: 'a1' }), approval({ id: 'a2', requester: 'agent:b' })]);
    vi.advanceTimersByTime(400);
    n.approvalsArrived([approval({ id: 'a3', kind: 'exec' }), approval({ id: 'a4' })]);
    n.approvalsArrived([approval({ id: 'a5' })]);
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(1);
    const { spec, click } = shown[0]!;
    expect(spec.title).toBe('abox: 5 new approval requests');
    expect(spec.body.split('\n')).toHaveLength(5); // three requests, "and 2 more", the hint
    expect(spec.body).toContain('… and 2 more');
    click();
    expect(opened).toEqual([{ view: 'approvals' }]);
  });

  it('shows at most one notification per kind in the minimum gap and merges what arrives meanwhile', () => {
    const { n, shown } = setup();
    n.approvalsArrived([approval({ id: 'a1' })]);
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(1);
    // an agent filing requests in a loop
    for (let i = 2; i < 12; i++) {
      n.approvalsArrived([approval({ id: `a${i}` })]);
      vi.advanceTimersByTime(500);
    }
    expect(shown).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(shown).toHaveLength(2);
    expect(shown[1]!.spec.title).toBe('abox: 10 new approval requests');
  });

  it('drops requests that were decided before the notification was due', () => {
    const { n, shown } = setup();
    n.approvalsArrived([approval({ id: 'a1' }), approval({ id: 'a2' })]);
    n.approvalsSettled(new Set(['a2'])); // a1 was approved in the meantime
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.spec.title).toBe('abox: new approval request');
    expect(shown[0]!.click).toBeTypeOf('function');
    n.approvalsArrived([approval({ id: 'a9' })]);
    n.approvalsSettled(new Set());
    vi.advanceTimersByTime(20_000);
    expect(shown).toHaveLength(1);
  });

  it('sends nothing for a kind that is off, also not what was queued before it was switched off', () => {
    const { n, shown, prefs } = setup({}, { approvals: false });
    n.approvalsArrived([approval({ id: 'a1' })]);
    vi.advanceTimersByTime(60_000);
    expect(shown).toHaveLength(0);

    prefs.approvals = true;
    n.approvalsArrived([approval({ id: 'a2' })]);
    prefs.approvals = false; // switched off before the merge window ended
    vi.advanceTimersByTime(60_000);
    expect(shown).toHaveLength(0);
  });

  it('the other kinds are independent of each other', () => {
    const { n, shown } = setup({}, { approvals: false });
    n.createsFailed([{ actor: 'agent:ci', template: 'node', code: 'backend_error' }]);
    vi.advanceTimersByTime(1000);
    expect(shown.map((s) => s.spec.kind)).toEqual(['failed']);
  });

  it('never carries the agent reason, a command or environment into the text', () => {
    const { n, shown } = setup();
    n.approvalsArrived([
      approval({
        id: 'a1',
        kind: 'exec',
        sandboxId: 'local/ab12cd34',
        reason: 'token=SECRET-REASON-123',
        request: {
          template: undefined,
          extra: { argv: ['curl', '-H', 'Authorization: Bearer SECRET-ARGV-456'] },
          env: { API_KEY: 'SECRET-ENV-789' },
        },
      }),
    ]);
    vi.advanceTimersByTime(1000);
    const text = `${shown[0]!.spec.title}\n${shown[0]!.spec.body}`;
    expect(text).toContain('Run command');
    expect(text).toContain('local/ab12cd34');
    expect(text).not.toMatch(/SECRET/);
  });

  it('makes agent-influenced names safe and short', () => {
    const { n, shown } = setup();
    n.approvalsArrived([
      approval({
        id: 'a1',
        requester: `agent:ci\u202e\nspoof${'x'.repeat(200)}`,
        request: { template: { name: `evil\u0007${'y'.repeat(200)}` } },
        kind: 'something_new',
      }),
    ]);
    vi.advanceTimersByTime(1000);
    const body = shown[0]!.spec.body;
    expect(body.includes('\u202e') || body.includes('\u0007')).toBe(false);
    expect(body).toContain('\\u202e');
    const first = body.split('\n')[0]!;
    expect(first.length).toBeLessThan(220);
    expect(first).toContain('Request type: something_new');
  });

  it('labels a port forward by its port and sandbox', () => {
    const { n, shown } = setup();
    n.approvalsArrived([
      approval({
        id: 'a1',
        kind: 'access',
        sandboxId: 'local/ab12cd34',
        request: { request: { kind: 'port', details: { sandboxPort: 5173 } } },
      }),
    ]);
    vi.advanceTimersByTime(1000);
    expect(shown[0]!.spec.body).toContain('Port forward (preview) · Port 5173 · local/ab12cd34');
  });

  it('uses the language of the moment it is shown', () => {
    const { n, shown, setLocale } = setup();
    n.approvalsArrived([approval({ id: 'a1' })]);
    setLocale('de');
    vi.advanceTimersByTime(1000);
    expect(shown[0]!.spec.title).toBe('abox: neue Freigabe-Anfrage');
    expect(shown[0]!.spec.body).toContain('Sandbox erstellen');
  });

  it('survives a sink that throws (no notification service)', () => {
    const { n } = setup({
      sink: {
        show: () => {
          throw new Error('no dbus');
        },
      },
    });
    n.approvalsArrived([approval({ id: 'a1' })]);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it('dispose drops everything queued', () => {
    const { n, shown } = setup();
    n.approvalsArrived([approval({ id: 'a1' })]);
    n.dispose();
    vi.advanceTimersByTime(60_000);
    expect(shown).toHaveLength(0);
  });
});

describe('expiring and failed notifications', () => {
  it('one expiring sandbox opens its detail view, several open the list', () => {
    const { n, shown, opened } = setup({ now: () => 1_000_000 });
    n.sandboxesExpiring([{ id: 'local/aa', name: 'build', expiresAt: 1_000_000 + 9 * 60_000 }]);
    vi.advanceTimersByTime(1000);
    expect(shown[0]!.spec.title).toBe('abox: sandbox expires soon');
    expect(shown[0]!.spec.body).toContain('build expires in 9m 00s');
    shown[0]!.click();
    expect(opened.at(-1)).toEqual({ view: 'detail', sandboxId: 'local/aa' });

    vi.advanceTimersByTime(20_000);
    n.sandboxesExpiring([
      { id: 'local/bb', name: 'b', expiresAt: 1_000_000 + 60_000 },
      { id: 'local/cc', name: 'c', expiresAt: 1_000_000 + 120_000 },
    ]);
    vi.advanceTimersByTime(20_000);
    expect(shown[1]!.spec.title).toBe('abox: 2 sandboxes expire soon');
    shown[1]!.click();
    expect(opened.at(-1)).toEqual({ view: 'sandboxes' });
  });

  it('failed creations name the agent, template and error code, never the message', () => {
    const { n, shown, opened } = setup();
    n.createsFailed([
      { actor: 'agent:ci', sandboxId: 'local/dd', template: 'node', code: 'backend_error' },
    ]);
    vi.advanceTimersByTime(1000);
    expect(shown[0]!.spec.title).toBe('abox: sandbox creation failed');
    expect(shown[0]!.spec.body).toContain('ci · node · backend_error');
    shown[0]!.click();
    expect(opened).toEqual([{ view: 'detail', sandboxId: 'local/dd' }]);
  });

  it('ignores creations the human started themselves', () => {
    const { n, shown } = setup();
    n.createsFailed([{ actor: 'human', code: 'timeout' }]);
    vi.advanceTimersByTime(60_000);
    expect(shown).toHaveLength(0);
  });
});
