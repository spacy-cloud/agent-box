import { describe, expect, it } from 'vitest';
import {
  canConnect,
  canTrust,
  hostKeyReducer,
  initialHostKeyState,
  primaryFingerprint,
} from '../../src/shared/host-key-flow';
import type { HostKeyState } from '../../src/shared/host-key-flow';
import type { HostKeyView } from '../../src/shared/types';

const FP1 = 'SHA256:' + 'a'.repeat(43);
const FP2 = 'SHA256:' + 'b'.repeat(43);
const view = (status: HostKeyView['status']): HostKeyView => ({
  id: 'srv',
  status,
  hostSpec: 'srv.example.org',
  keys: [
    { type: 'ssh-rsa', fingerprint: FP2 },
    { type: 'ssh-ed25519', fingerprint: FP1 },
  ],
  trusted:
    status === 'changed' ? [{ type: 'ssh-ed25519', fingerprint: 'SHA256:' + 'c'.repeat(43) }] : [],
});
const run = (...actions: Parameters<typeof hostKeyReducer>[1][]): HostKeyState =>
  actions.reduce(hostKeyReducer, initialHostKeyState);

describe('host key dialog state', () => {
  it('an unknown key is not trusted without the explicit confirmation', () => {
    const s = run({ type: 'check' }, { type: 'checked', view: view('unknown') });
    expect(s.phase).toBe('unknown');
    expect(canTrust(s)).toBe(false);
    // trust without confirmation does nothing
    expect(hostKeyReducer(s, { type: 'trust' })).toEqual(s);
    const confirmed = hostKeyReducer(s, { type: 'confirm', value: true });
    expect(canTrust(confirmed)).toBe(true);
    const busy = hostKeyReducer(confirmed, { type: 'trust' });
    expect(busy).toMatchObject({ phase: 'unknown', busy: true });
    expect(canTrust(busy)).toBe(false);
    const done = hostKeyReducer(busy, { type: 'trusted' });
    expect(done).toMatchObject({ phase: 'trusted', justTrusted: true });
    expect(canConnect(done)).toBe(true);
  });

  it('"trusted" cannot be reached without a trust request', () => {
    const s = run({ type: 'check' }, { type: 'checked', view: view('unknown') });
    expect(hostKeyReducer(s, { type: 'trusted' }).phase).toBe('unknown');
    expect(canConnect(s)).toBe(false);
    expect(canConnect(run({ type: 'check' }))).toBe(false);
  });

  it('un-ticking the confirmation disables trusting again', () => {
    let s = run(
      { type: 'check' },
      { type: 'checked', view: view('unknown') },
      { type: 'confirm', value: true },
    );
    s = hostKeyReducer(s, { type: 'confirm', value: false });
    expect(canTrust(s)).toBe(false);
  });

  it('a changed key blocks: no trust, no connect, forgetting needs two steps', () => {
    let s = run({ type: 'check' }, { type: 'checked', view: view('changed') });
    expect(s.phase).toBe('changed');
    expect(canTrust(s)).toBe(false);
    expect(canConnect(s)).toBe(false);
    expect(hostKeyReducer(s, { type: 'confirm', value: true })).toEqual(s);
    expect(hostKeyReducer(s, { type: 'trust' })).toEqual(s);
    // the second confirmation cannot be skipped
    expect(hostKeyReducer(s, { type: 'forgetConfirm' })).toEqual(s);
    s = hostKeyReducer(s, { type: 'forgetRequest' });
    expect(s).toMatchObject({ phase: 'changed', forget: 'ask' });
    // going back resets the stage
    expect(hostKeyReducer(s, { type: 'forgetCancel' })).toMatchObject({ forget: 'none' });
    s = hostKeyReducer(s, { type: 'forgetConfirm' });
    expect(s).toMatchObject({ phase: 'changed', forget: 'busy' });
    // after the removal the key is checked again and shows up as unknown (own confirmation needed)
    s = hostKeyReducer(s, { type: 'forgotten' });
    expect(s.phase).toBe('checking');
    s = hostKeyReducer(s, { type: 'checked', view: view('unknown') });
    expect(s).toMatchObject({ phase: 'unknown', confirmed: false });
    expect(canTrust(s)).toBe(false);
  });

  it('an already trusted key goes straight to trusted (not "just trusted")', () => {
    const s = run({ type: 'check' }, { type: 'checked', view: view('trusted') });
    expect(s).toMatchObject({ phase: 'trusted', justTrusted: false });
  });

  it('failures end in the error phase', () => {
    expect(run({ type: 'check' }, { type: 'failed', message: 'x' })).toEqual({
      phase: 'error',
      message: 'x',
    });
  });

  it('prefers the ed25519 fingerprint', () => {
    expect(primaryFingerprint(view('unknown').keys)?.fingerprint).toBe(FP1);
    expect(primaryFingerprint([])).toBeUndefined();
  });
});
