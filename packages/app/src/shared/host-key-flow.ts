/**
 * State machine of the host-key dialog. Pure, so the rules can be tested without a window:
 *
 * - An unknown key is trusted only after the user ticked "I compared this fingerprint" (explicit confirmation).
 * - A changed key blocks everything. The only way forward is "forget the stored key", which needs a second
 *   confirmation, and afterwards the server's key is shown again as an unknown key that needs its own confirmation.
 * - Nothing is ever accepted silently: every transition into `trusted` comes from a user-initiated `trust`.
 */
import type { HostKeyView } from './types';

export type Fingerprint = { type: string; fingerprint: string };

export type HostKeyState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'unknown'; keys: Fingerprint[]; confirmed: boolean; busy: boolean }
  | { phase: 'changed'; presented: Fingerprint[]; stored: Fingerprint[]; forget: ForgetStage }
  | { phase: 'trusted'; keys: Fingerprint[]; justTrusted: boolean }
  | { phase: 'error'; message: string };

/** `ask` = the second confirmation is showing. */
export type ForgetStage = 'none' | 'ask' | 'busy';

export type HostKeyAction =
  | { type: 'check' }
  | { type: 'checked'; view: HostKeyView }
  | { type: 'confirm'; value: boolean }
  | { type: 'trust' }
  | { type: 'trusted' }
  | { type: 'forgetRequest' }
  | { type: 'forgetCancel' }
  | { type: 'forgetConfirm' }
  | { type: 'forgotten' }
  | { type: 'failed'; message: string };

export const initialHostKeyState: HostKeyState = { phase: 'idle' };

export function hostKeyReducer(state: HostKeyState, action: HostKeyAction): HostKeyState {
  switch (action.type) {
    case 'check':
      return { phase: 'checking' };
    case 'checked': {
      const v = action.view;
      if (v.status === 'trusted') return { phase: 'trusted', keys: v.keys, justTrusted: false };
      if (v.status === 'unknown') {
        return { phase: 'unknown', keys: v.keys, confirmed: false, busy: false };
      }
      return { phase: 'changed', presented: v.keys, stored: v.trusted, forget: 'none' };
    }
    case 'confirm':
      return state.phase === 'unknown' && !state.busy ? { ...state, confirmed: action.value } : state;
    case 'trust':
      // Without the explicit confirmation nothing happens.
      return state.phase === 'unknown' && state.confirmed && !state.busy
        ? { ...state, busy: true }
        : state;
    case 'trusted':
      return state.phase === 'unknown' && state.busy
        ? { phase: 'trusted', keys: state.keys, justTrusted: true }
        : state;
    case 'forgetRequest':
      return state.phase === 'changed' && state.forget === 'none'
        ? { ...state, forget: 'ask' }
        : state;
    case 'forgetCancel':
      return state.phase === 'changed' && state.forget === 'ask' ? { ...state, forget: 'none' } : state;
    case 'forgetConfirm':
      // Only the second confirmation (stage `ask`) starts the removal.
      return state.phase === 'changed' && state.forget === 'ask' ? { ...state, forget: 'busy' } : state;
    case 'forgotten':
      return state.phase === 'changed' && state.forget === 'busy' ? { phase: 'checking' } : state;
    case 'failed':
      return { phase: 'error', message: action.message };
  }
}

/** The trust button is enabled only for an unknown key after the explicit confirmation. */
export function canTrust(state: HostKeyState): boolean {
  return state.phase === 'unknown' && state.confirmed && !state.busy;
}

/** A session may only start once the key is trusted. */
export function canConnect(state: HostKeyState): boolean {
  return state.phase === 'trusted';
}

/** Preferred fingerprint to show first and to pass to `trust` (ed25519 when offered). */
export function primaryFingerprint(keys: readonly Fingerprint[]): Fingerprint | undefined {
  return keys.find((k) => k.type === 'ssh-ed25519') ?? keys[0];
}
