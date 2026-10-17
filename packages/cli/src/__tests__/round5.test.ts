import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, writePolicy, type TestEnv } from './harness.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

describe('policy validate without a policy.yaml', () => {
  it('says that the built-in policy applies, exits 0 and creates no directories', async () => {
    const r = await run(t, ['policy', 'validate']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('no policy.yaml');
    expect(r.stdout).toContain('built-in default policy applies');
    expect(r.stdout).not.toContain(': valid');
    expect(existsSync(t.aboxHome)).toBe(false);

    const j = await run(t, ['policy', 'validate', '--json']);
    expect(j.code).toBe(0);
    expect(j.json.data).toMatchObject({ ok: true, exists: false, source: 'default' });
    expect(j.json.data.file).toMatch(/policy\.yaml$/);
    expect(existsSync(t.aboxHome)).toBe(false);
  });

  it('still validates an existing policy.yaml, and a named file that does not exist is an error', async () => {
    writePolicy(t, 'version: 1\nprofiles:\n  a: {}\n');
    const ok = await run(t, ['policy', 'validate']);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/policy\.yaml: valid \(hash [0-9a-f]{16}\)/);
    const j = await run(t, ['policy', 'validate', '--json']);
    expect(j.json.data).toMatchObject({ ok: true, exists: true, source: 'file' });
    const missing = await run(t, ['policy', 'validate', `${t.root}/nope.yaml`, '--json']);
    expect(missing.code).toBe(2);
    expect(missing.json.code).toBe('not_found');
  });
});

describe('template validate hints', () => {
  it('a mount-directory hint is not attached to a template with a schema/name problem', async () => {
    const f = t.write(
      'mixed.yaml',
      [
        'apiVersion: 1',
        'name: ok-name',
        'backend: docker',
        'base: { os: "alpine:3.22" }',
        'mounts:',
        '  - { source: ~/.ssh, target: /etc/x, access: ro }',
        '',
      ].join('\n'),
    );
    const r = await run(t, ['template', 'validate', f, '--json']);
    expect(r.code).toBe(2);
    expect(r.json.code).toBe('template_invalid');
    expect(r.json.hint).toBeTruthy();
    expect(r.json.hint).not.toMatch(/project directory|mount/i);
  });
});

describe('policy show for the human profile', () => {
  it('shows that the human is not limited to a part of the file system', async () => {
    const r = await run(t, ['policy', 'show']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('anywhere (forbidden paths excluded)');
  });
});
