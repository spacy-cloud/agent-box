import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

interface Fake {
  opts: Record<string, unknown>;
  handlers: Record<string, () => void>;
  show: Mock<() => void>;
}
const made: Fake[] = [];
let supported = true;

vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return supported;
    }
    private readonly fake: Fake;
    constructor(opts: Record<string, unknown>) {
      this.fake = { opts, handlers: {}, show: vi.fn() };
      made.push(this.fake);
    }
    on(event: string, fn: () => void) {
      this.fake.handlers[event] = fn;
    }
    show() {
      this.fake.show();
    }
  },
}));

const { ElectronNotificationSink } = await import('../../src/main/notification-sink');

const spec = {
  kind: 'approvals' as const,
  title: 'abox: new approval request',
  body: 'ci · Create sandbox',
  target: { view: 'approvals' as const },
};

beforeEach(() => {
  made.length = 0;
  supported = true;
});

describe('Electron notification sink', () => {
  it('shows a plain notification without action buttons and calls back on click', () => {
    const sink = new ElectronNotificationSink();
    const onClick = vi.fn();
    sink.show(spec, onClick);
    expect(made).toHaveLength(1);
    const n = made[0]!;
    expect(n.opts).toMatchObject({ title: spec.title, body: spec.body, urgency: 'normal' });
    // a notification can open the Approvals view, but it can not decide anything
    expect(n.opts).not.toHaveProperty('actions');
    expect(n.opts).not.toHaveProperty('hasReply');
    expect(n.show).toHaveBeenCalledOnce();
    expect(n.handlers['action']).toBeUndefined();
    n.handlers['click']!();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows nothing where the desktop has no notification support', () => {
    supported = false;
    const sink = new ElectronNotificationSink();
    expect(sink.supported).toBe(false);
    sink.show(spec, vi.fn());
    expect(made).toHaveLength(0);
  });
});
