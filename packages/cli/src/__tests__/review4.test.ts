import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

describe('ls --host', () => {
  it('an unknown host is not_found (exit 2) with a hint, not "no sandboxes"', async () => {
    const r = await run(t, ['--host', 'nosuch', 'ls']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not_found');
    expect(r.stderr).toContain('nosuch');
    expect(r.stderr).toContain('abox host ls');
    const j = await run(t, ['--host', 'nosuch', 'ls', '--json']);
    expect(j.json).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a configured host that cannot be used is reported instead of an empty list', async () => {
    const add = await run(t, [
      'host',
      'add',
      'lab',
      '--hostname',
      '127.0.0.1',
      '--user',
      'nobody',
      '--backend',
      'docker',
    ]);
    expect(add.code, add.stderr).toBe(0);
    const r = await run(t, ['--host', 'lab', 'ls']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('host lab is unreachable');
    expect(r.stdout).toContain('abox host test');
    const j = await run(t, ['--host', 'lab', 'ls', '--json']);
    expect(j.json.data.unreachableHosts).toEqual(['lab']);
    expect(j.json.data.hostProblems.lab).toContain('engine_socket');
    // the local host stays a plain, healthy listing
    const local = await run(t, ['--host', 'local', 'ls', '--json']);
    expect(local.json.data.unreachableHosts).toEqual([]);
  });
});

describe('open network in the human context', () => {
  it('create --net open below hardened is never silent: it needs --yes', async () => {
    const r = await run(t, ['create', 'alpine-min', '--net', 'open', '--json']);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: 'approval_required' });
    expect(r.json.details.reasons.join(' ')).toContain('network mode "open"');
    expect(r.json.details.risks.join(' ')).toContain('Unrestricted internet access');
    expect(r.json.hint).toContain('--yes');
    const asked = await run(t, ['create', 'alpine-min', '--net', 'open'], {
      tty: true,
      stdin: 'n\n',
    });
    expect(asked.code).toBe(3);
    expect(asked.stderr).toContain('Risks:');
    expect(asked.stderr).toContain('Proceed? [y/N]');
    expect((await run(t, ['ls', '--json'])).json.data.sandboxes).toEqual([]);
  });
});

describe('command names in messages', () => {
  it('an invalid policy.yaml points to "abox policy validate"', async () => {
    t.write('abox/config/policy.yaml', 'version: 1\nprofiles: nonsense\n');
    const r = await run(t, ['policy', 'show']);
    expect(r.code).not.toBe(0);
    const text = r.stderr + r.stdout;
    expect(text).not.toContain('policy check');
    expect(text).toContain('abox policy validate');
  });
});
