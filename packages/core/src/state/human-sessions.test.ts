import { describe, expect, it } from 'vitest';
import { HUMAN_SESSION_TTL_MS } from './human-sessions.js';
import { StateStore } from './store.js';

function open(): { s: StateStore; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  return { s: StateStore.open(':memory:', { now: () => clock.t }), clock };
}
const row = (id: string, sandboxId = 'local/aaaaaaaa') => ({
  id,
  sandboxId,
  actor: 'human',
  pid: 7,
});

describe('human sessions (takeover markers)', () => {
  it('lists live sessions per sandbox and ends them', () => {
    const { s } = open();
    s.humanSessions.begin(row('a'));
    s.humanSessions.begin(row('b'));
    s.humanSessions.begin(row('c', 'local/bbbbbbbb'));
    expect(s.humanSessions.active('local/aaaaaaaa').map((r) => r.id)).toEqual(['a', 'b']);
    expect([...s.humanSessions.activeSandboxIds()].sort()).toEqual([
      'local/aaaaaaaa',
      'local/bbbbbbbb',
    ]);
    expect(s.humanSessions.end('a')).toBe(true);
    expect(s.humanSessions.end('a')).toBe(false);
    expect(s.humanSessions.active('local/aaaaaaaa').map((r) => r.id)).toEqual(['b']);
    expect(s.humanSessions.deleteAll('local/aaaaaaaa')).toBe(1);
    expect(s.humanSessions.active('local/aaaaaaaa')).toEqual([]);
    s.close();
  });

  it('a session without heartbeat expires; touch keeps it alive; prune deletes the dead', () => {
    const { s, clock } = open();
    s.humanSessions.begin(row('a'));
    s.humanSessions.begin(row('b'));
    clock.t += HUMAN_SESSION_TTL_MS - 1;
    expect(s.humanSessions.touch('a')).toBe(true);
    clock.t += 2;
    expect(s.humanSessions.active('local/aaaaaaaa').map((r) => r.id)).toEqual(['a']);
    expect(s.humanSessions.prune()).toBe(1);
    expect(s.humanSessions.get('b')).toBeUndefined();
    expect(s.humanSessions.touch('b')).toBe(false);
    s.close();
  });
});
