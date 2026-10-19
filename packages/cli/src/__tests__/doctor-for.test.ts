import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, writePolicy, type TestEnv } from './harness.js';

let t: TestEnv;

/** Only the process backend on `local`: no Docker involved, so the answers are deterministic. */
beforeEach(() => {
  t = makeEnv();
  t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
});
afterEach(() => t.cleanup());

describe('abox doctor --for', () => {
  it('documents the option in the help', async () => {
    const h = await run(t, ['doctor', '--help']);
    expect(h.stdout).toContain('--for <target>');
    expect(h.stdout).toContain('abox doctor --for host:');
  });

  it('checks a template: a readable report for a person, the same checks as JSON', async () => {
    const human = await run(t, ['doctor', '--for', 'host-shell']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('Can host-shell run on local?');
    expect(human.stdout).toMatch(/^✓ template host-shell: found and valid$/m);
    expect(human.stdout).toMatch(/^✓ backend process on local: ok/m);
    expect(human.stdout).toMatch(/ready to run \(\d+ ok/);
    // a scoped check does not run the whole doctor: no state database or audit lines
    expect(human.stdout).not.toContain('audit chain');

    const json = await run(t, ['doctor', '--for', 'host-shell', '--json']);
    expect(json.code).toBe(0);
    expect(json.json.ok).toBe(true);
    expect(json.json.data).toMatchObject({
      scope: { kind: 'template', name: 'host-shell', host: 'local' },
      ok: true,
    });
    expect(json.json.data.summary.error).toBe(0);
    const ids = json.json.data.checks.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['template', 'backend', 'isolation', 'policy']));
    // the same fields as a doctor check, including the legacy level
    expect(json.json.data.checks[0]).toMatchObject({ level: 'ok', severity: 'ok' });
  });

  it('exits 1 with the report when a check fails', async () => {
    const r = await run(t, ['doctor', '--for', 'no-such-template']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^✗ template no-such-template: not found/m);
    expect(r.stdout).toContain('not ready: 1 problem(s)');
    expect(r.stderr).toContain('check_failed');

    const j = await run(t, ['doctor', '--for', 'no-such-template', '--json']);
    expect(j.code).toBe(1);
    expect(j.json).toMatchObject({ ok: false, code: 'check_failed' });
    expect(j.json.details.report.checks[0]).toMatchObject({ id: 'template', severity: 'error' });
  });

  it('checks a host', async () => {
    const r = await run(t, ['doctor', '--for', 'host:local']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Can host local run sandboxes?');
    expect(r.stdout).toMatch(/^✓ host local: available$/m);
    expect(r.stdout).toMatch(/ready \(\d+ ok/);
    const j = await run(t, ['doctor', '--for', 'host:local', '--json']);
    expect(j.json.data.scope).toEqual({ kind: 'host', host: 'local' });
  });

  it('fails for a host that is not configured', async () => {
    const r = await run(t, ['doctor', '--for', 'host:nowhere', '--json']);
    expect(r.code).toBe(1);
    expect(r.json.details.report.checks[0]).toMatchObject({
      id: 'host.nowhere',
      severity: 'error',
    });
  });

  it('rejects an empty target and two different hosts with exit 2', async () => {
    expect((await run(t, ['doctor', '--for', 'host:'])).code).toBe(2);
    const two = await run(t, ['--host', 'a', 'doctor', '--for', 'host:b']);
    expect(two.code).toBe(2);
    expect(two.stderr).toContain('different hosts');
  });

  it('uses --host as the place the template would run', async () => {
    const r = await run(t, ['--host', 'nowhere', 'doctor', '--for', 'host-shell', '--json']);
    expect(r.code).toBe(1);
    expect(r.json.details.report.scope).toMatchObject({ host: 'nowhere' });
  });

  it('still answers when policy.yaml is invalid, and says that creating is refused', async () => {
    writePolicy(t, 'version: 1\nprofiles:\n  p:\n    bogus: 1\n');
    const r = await run(t, ['doctor', '--for', 'host-shell', '--json']);
    expect(r.code).toBe(1);
    const policy = r.json.details.report.checks.find(
      (c: { id: string }) => c.id === 'policy.invalid',
    );
    expect(policy).toMatchObject({ severity: 'error' });
    expect(policy.title).toContain('creating sandboxes is refused');
  });
});
