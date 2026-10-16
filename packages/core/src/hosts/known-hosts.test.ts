import { describe, expect, it } from 'vitest';
import {
  evaluateHostKey,
  fingerprintOf,
  hostSpecOf,
  normalizeFingerprint,
  type ScannedKey,
} from './known-hosts.js';
import { parseProbeOutput } from './test-host.js';

// Public key blob of an ed25519 test key (generated for this test, not a real host).
const BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const OTHER = 'AAAAC3NzaC1lZDI1NTE5AAAAIGjn6ZcqjUXR3tTMjWq2bYRVVSiXMN0MwTdlNLVAxf31';

const k = (type: string, key: string): ScannedKey => ({
  type,
  key,
  fingerprint: fingerprintOf(key),
});
const st = (type: string, key: string, revoked = false) => ({ type, key, revoked });

describe('fingerprints', () => {
  it('SHA256 of the blob, unpadded base64', () => {
    const fp = fingerprintOf(BLOB);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fingerprintOf(BLOB)).toBe(fp);
    expect(fingerprintOf(OTHER)).not.toBe(fp);
  });

  it('normalizes user input and rejects garbage', () => {
    const fp = fingerprintOf(BLOB);
    expect(normalizeFingerprint(` ${fp} `)).toBe(fp);
    expect(normalizeFingerprint(fp.replace('SHA256:', ''))).toBe(fp);
    expect(normalizeFingerprint(`${fp}=`)).toBe(fp);
    for (const bad of ['', 'SHA256:short', 'MD5:aa:bb', `${fp}\nx`, 'SHA256:' + 'a'.repeat(50)]) {
      expect(() => normalizeFingerprint(bad), bad).toThrow();
    }
  });

  it('host spec uses brackets for non-default ports', () => {
    expect(hostSpecOf('h.example.org', 22)).toBe('h.example.org');
    expect(hostSpecOf('h.example.org', 2222)).toBe('[h.example.org]:2222');
  });
});

describe('evaluateHostKey', () => {
  it('unknown without entries', () => {
    expect(evaluateHostKey([k('ssh-ed25519', BLOB)], [])).toBe('unknown');
  });
  it('trusted when the key matches', () => {
    expect(evaluateHostKey([k('ssh-ed25519', BLOB)], [st('ssh-ed25519', BLOB)])).toBe('trusted');
  });
  it('changed when the same key type differs', () => {
    expect(evaluateHostKey([k('ssh-ed25519', OTHER)], [st('ssh-ed25519', BLOB)])).toBe('changed');
  });
  it('trusted if one type matches and the server also offers further, unstored types', () => {
    expect(
      evaluateHostKey(
        [k('ssh-ed25519', BLOB), k('ssh-rsa', 'AAAAB3Nza')],
        [st('ssh-ed25519', BLOB)],
      ),
    ).toBe('trusted');
  });
  it('changed when a stored type is no longer presented', () => {
    expect(evaluateHostKey([k('ssh-rsa', 'AAAAB3Nza')], [st('ssh-ed25519', BLOB)])).toBe('changed');
  });
  it('changed when any presented key of a stored type mismatches, even if another matches', () => {
    expect(
      evaluateHostKey(
        [k('ssh-ed25519', BLOB), k('ssh-rsa', 'AAAAB3Nzb')],
        [st('ssh-ed25519', BLOB), st('ssh-rsa', 'AAAAB3Nza')],
      ),
    ).toBe('changed');
  });
  it('revoked keys are never trusted', () => {
    expect(evaluateHostKey([k('ssh-ed25519', BLOB)], [st('ssh-ed25519', BLOB, true)])).toBe(
      'changed',
    );
  });
});

describe('probe output', () => {
  it('only takes abox.* lines and the first value of a key', () => {
    const out = parseProbeOutput(
      'welcome to the box\nabox.uid=1000\nabox.user=abox\nabox.uid=0\nPATH=/x\nabox.docker.version=27.1.1\n',
    );
    expect(out).toEqual({ uid: '1000', user: 'abox', 'docker.version': '27.1.1' });
  });
});
