import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactLogLine, redactString, redactValues } from './redact.js';
import { canonicalJson, hashJson } from './canonical.js';

describe('redact', () => {
  it('masks sensitive keys recursively, case-insensitively', () => {
    const input = {
      user: 'alice',
      apiToken: 'abc',
      nested: { Password: 'x', ok: 1, list: [{ authorization: 'Bearer z', keep: 'y' }] },
      PRIVATE_KEY: 'k',
      privateKey: 'k2',
      'private-key': 'k3',
      cookie: 'c',
      credentials: { a: 1 },
      secrets: ['s'],
      passphrase: 'p',
    };
    expect(redact(input)).toEqual({
      user: 'alice',
      apiToken: REDACTED,
      nested: { Password: REDACTED, ok: 1, list: [{ authorization: REDACTED, keep: 'y' }] },
      PRIVATE_KEY: REDACTED,
      privateKey: REDACTED,
      'private-key': REDACTED,
      cookie: REDACTED,
      credentials: REDACTED,
      secrets: REDACTED,
      passphrase: REDACTED,
    });
  });

  it('does not mutate the input and survives cycles and odd values', () => {
    const a: Record<string, unknown> = { token: 't', n: 1n, d: new Date(0), e: new Error('boom') };
    a['self'] = a;
    const out = redact(a) as Record<string, unknown>;
    expect(a['token']).toBe('t');
    expect(out['token']).toBe(REDACTED);
    expect(out['self']).toBe('[circular]');
    expect(out['n']).toBe('1');
    expect(out['d']).toBe('1970-01-01T00:00:00.000Z');
    expect(out['e']).toEqual({ name: 'Error', message: 'boom' });
  });

  it('redactValues masks known secret values inside strings', () => {
    const out = redactValues(
      { cmd: 'curl -H "X: s3cr3t-value" https://x', list: ['s3cr3t-value', 'fine'], n: 3 },
      ['s3cr3t-value', 'ab'],
    );
    expect(out).toEqual({
      cmd: `curl -H "X: ${REDACTED}" https://x`,
      list: [REDACTED, 'fine'],
      n: 3,
    });
    expect(redactString('xxabxx', ['ab'])).toBe('xxabxx'); // too short to be treated as a secret
  });
});

describe('canonicalJson', () => {
  it('is key-order independent and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});

describe('redactLogLine', () => {
  it('masks assignments whose name looks like a credential', () => {
    expect(redactLogLine('Step 4/9 : ENV API_TOKEN=abc123xyz')).toBe(
      `Step 4/9 : ENV API_TOKEN=${REDACTED}`,
    );
    expect(redactLogLine('--build-arg NPM_PASSWORD="p w d" --build-arg X=1')).toBe(
      `--build-arg NPM_PASSWORD=${REDACTED} --build-arg X=1`,
    );
    expect(redactLogLine('Authorization: Bearer abcdefgh12345')).toBe(`Authorization: ${REDACTED}`);
    expect(redactLogLine('{"password": "hunter22"}')).toBe(`{"password": ${REDACTED}}`);
  });

  it('masks the user info of URLs and bare bearer tokens', () => {
    expect(redactLogLine('git clone https://bob:s3cret@example.org/r.git')).toBe(
      `git clone https://${REDACTED}@example.org/r.git`,
    );
    expect(redactLogLine('curl -H "x: Bearer abcdefghijkl"')).toContain(REDACTED);
    expect(redactLogLine('curl -H "x: Bearer abcdefghijkl"')).not.toContain('abcdefghijkl');
  });

  it('masks known values anywhere and leaves ordinary lines alone', () => {
    expect(redactLogLine('using value-9999 here', ['value-9999'])).toBe(`using ${REDACTED} here`);
    const plain = 'Step 2/9 : RUN apt-get install -y curl git (1.2 MB)';
    expect(redactLogLine(plain)).toBe(plain);
    expect(redactLogLine('The author: Alice')).toBe('The author: Alice');
  });
});
