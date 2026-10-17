import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliVersion } from '../version.js';
import { makeEnv, run, writeConfig, writePolicy, type TestEnv } from './harness.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

describe('basics', () => {
  it('prints the version and help with the exit codes', async () => {
    const v = await run(t, ['--version']);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toBe(cliVersion());
    const h = await run(t, ['--help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('Exit codes:');
    for (const c of [
      'template',
      'create',
      'exec',
      'shell',
      'cp',
      'approvals',
      'policy',
      'audit',
      'mcp',
      'token',
      'doctor',
      'init',
      'host',
      'secret',
      'completion',
    ]) {
      expect(h.stdout).toContain(c);
    }
    const sub = await run(t, ['help', 'create']);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain('--workspace');
  });

  it('reports usage errors with exit code 2 and the stable JSON shape', async () => {
    const r = await run(t, ['frobnicate', '--json']);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(typeof r.json.message).toBe('string');
    const missing = await run(t, ['inspect', '--json']);
    expect(missing.code).toBe(2);
    expect(missing.json.code).toBe('invalid_input');
    const human = await run(t, ['frobnicate']);
    expect(human.code).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('invalid_input');
    const badOpt = await run(t, ['create', 'alpine-min', '--net', 'wide-open', '--json']);
    expect(badOpt.code).toBe(2);
    expect(badOpt.json.message).toContain('wide-open');
  });

  it('explains the missing -- before an exec command', async () => {
    const r = await run(t, ['--json', 'exec', 'local/aaaaaaaa', 'ls', '-l']);
    expect(r.code).toBe(2);
    expect(r.json.hint).toContain('--');
  });

  it('accepts --json before and after the subcommand', async () => {
    const a = await run(t, ['--json', 'template', 'ls']);
    const b = await run(t, ['template', 'ls', '--json']);
    expect(a.json.ok).toBe(true);
    expect(b.json.ok).toBe(true);
    expect(a.json.data.templates.map((x: { name: string }) => x.name)).toEqual(
      b.json.data.templates.map((x: { name: string }) => x.name),
    );
  });

  it('lists templates (human and JSON) and shows one', async () => {
    const r = await run(t, ['template', 'ls', '--json']);
    expect(r.code).toBe(0);
    const names = r.json.data.templates.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['alpine-min', 'node-dev', 'host-shell']));
    expect(r.json.data.templates[0]).toHaveProperty('trusted');
    const human = await run(t, ['template', 'ls']);
    expect(human.stdout).toMatch(/^NAME\s+BACKEND\s+ISOLATION/);
    expect(human.stdout.includes('\u001b[')).toBe(false); // no colours when piped
    const q = await run(t, ['template', 'ls', '--quiet']);
    expect(q.stdout.split('\n')).toContain('alpine-min');
    const show = await run(t, ['template', 'show', 'node-dev']);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('node-dev');
    expect(show.stdout).toContain('allowlist');
    const missing = await run(t, ['template', 'show', 'nope', '--json']);
    expect(missing.code).toBe(2);
    expect(missing.json.code).toBe('not_found');
  });

  it('validates templates with file:line:col field: message', async () => {
    const bad = t.write(
      'bad.yaml',
      [
        'apiVersion: 1',
        'name: Bad_Name',
        'backend: docker',
        'base: { os: ubuntu:24.04 }',
        'resources:',
        '  cpus: lots',
        'bogus: 1',
        '',
      ].join('\n'),
    );
    const human = await run(t, ['template', 'validate', bad]);
    expect(human.code).toBe(2);
    expect(human.stderr).toContain(`${bad}:2:`);
    expect(human.stderr).toMatch(
      new RegExp(`${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:6:\\d+ resources\\.cpus: `),
    );
    expect(human.stderr).toContain('bogus');
    const json = await run(t, ['template', 'validate', bad, '--json']);
    expect(json.code).toBe(2);
    expect(json.json.ok).toBe(false);
    expect(json.json.code).toBe('template_invalid');
    const cpus = json.json.issues.find((i: { path?: string }) => i.path === 'resources.cpus');
    expect(cpus).toMatchObject({ line: 6, file: bad });
    expect(cpus.column).toBeGreaterThan(0);

    const syntax = t.write('syntax.yaml', 'apiVersion: 1\nname: [unclosed\n');
    const s = await run(t, ['template', 'validate', syntax, '--json']);
    expect(s.code).toBe(2);
    expect(s.json.issues[0].line).toBeGreaterThan(0);

    const ok = await run(t, ['template', 'validate', 'alpine-min', '--json']);
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ ok: true, data: { ok: true, name: 'alpine-min' } });
  });

  it('maps policy denial to exit code 3 (forbidden workspace path)', async () => {
    const r = await run(t, ['create', 'alpine-min', '--workspace', '/etc', '--json']);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: 'policy_denied' });
    const human = await run(t, ['create', 'alpine-min', '--workspace', '/etc']);
    expect(human.code).toBe(3);
    expect(human.stderr).toContain('policy_denied');
  });

  it('maps an unavailable backend to exit code 4', async () => {
    const env = { DOCKER_HOST: 'unix:///nonexistent/abox-test.sock' };
    const build = await run(t, ['template', 'build', 'alpine-min', '--json'], { env });
    expect(build.code).toBe(4);
    expect(build.json).toMatchObject({ ok: false, code: 'backend_unavailable' });
    expect(build.json.hint).toBeTruthy();
    const create = await run(t, ['create', 'alpine-min', '--workspace', '.', '--json'], { env });
    expect(create.code).toBe(4);
    const doctor = await run(t, ['doctor', '--json'], { env });
    expect(doctor.code).toBe(1); // any failed check is exit 1, backend or not
    expect(doctor.json.ok).toBe(false);
    expect(
      doctor.json.details.report.backends.some(
        (b: { backend: string; available: boolean }) => b.backend === 'docker' && !b.available,
      ),
    ).toBe(true);
  });

  it('rejects bad flag values with exit code 2', async () => {
    for (const args of [
      ['create', 'alpine-min', '--ttl', 'soon'],
      ['create', 'alpine-min', '--ttl', '9999999999999999h'],
      ['create', 'alpine-min', '--ttl', '99999999999999999999ms'],
      ['create', 'alpine-min', '--cpus', '-3'],
      ['create', 'alpine-min', '--memory', 'lots'],
      ['exec', 'local/aaaaaaaa', '--env', 'NOVALUE', '--', 'true'],
      ['audit', '--since', 'yesterday-ish'],
      ['audit', '--limit', '0'],
    ]) {
      const r = await run(t, ['--json', ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.json.code).toBe('invalid_input');
    }
  });

  it('says "too large" for a duration beyond the safe integer range', async () => {
    for (const ttl of ['9999999999999999h', '99999999999999999999ms']) {
      const r = await run(t, ['--json', 'create', 'alpine-min', '--ttl', ttl]);
      expect(r.code).toBe(2);
      expect(r.json.message).toMatch(/too large/);
    }
  });

  it('does not touch the real abox directories', async () => {
    await run(t, ['template', 'ls']);
    expect(t.aboxHome).toContain('abox-cli-');
  });
});

describe('policy', () => {
  it('shows and validates the policy', async () => {
    const show = await run(t, ['policy', 'show']);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('built-in default');
    const json = await run(t, ['policy', 'show', '--json']);
    expect(json.json.data.profiles.human).toBeTruthy();
    const ctx = await run(t, ['policy', 'show', '--context', 'default', '--json']);
    expect(ctx.code).toBe(0);
    expect(ctx.json.data.contextProfile.name).toBe('default');
    const unknown = await run(t, ['policy', 'show', '--context', 'ghost', '--json']);
    expect(unknown.code).toBe(2);

    const good = await run(t, ['policy', 'validate', '--json']);
    expect(good.code).toBe(0);
    const bad = t.write(
      'bad-policy.yaml',
      'version: 1\nprofiles:\n  p:\n    approval: sometimes\n',
    );
    const r = await run(t, ['policy', 'validate', bad]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/bad-policy\.yaml:\d+/);
    const rj = await run(t, ['policy', 'validate', bad, '--json']);
    expect(rj.json.issues.length).toBeGreaterThan(0);
  });

  it('edits the policy: validates, shows a diff, asks, saves', async () => {
    writePolicy(
      t,
      'version: 1\nprofiles:\n  agent:\n    templates: [alpine-min]\ncontexts:\n  bot: { profile: agent }\n',
    );
    const good = t.write(
      'edit-good.sh',
      '#!/bin/sh\nprintf "  other: { profile: agent }\\n" >> "$1"\n',
    );
    const bad = t.write('edit-bad.sh', '#!/bin/sh\nprintf "garbage: [\\n" >> "$1"\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(good, 0o755);
    chmodSync(bad, 0o755);

    const refused = await run(t, ['policy', 'edit', '--json'], { env: { EDITOR: good } });
    expect(refused.code).toBe(2); // --json is not supported for the interactive edit

    const invalid = await run(t, ['policy', 'edit', '--yes'], { env: { EDITOR: bad } });
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('invalid');

    const noTty = await run(t, ['policy', 'edit'], { env: { EDITOR: good } });
    expect(noTty.code).toBe(3); // saving needs confirmation

    const denied = await run(t, ['policy', 'edit'], {
      env: { EDITOR: good },
      tty: true,
      stdin: 'n\n',
    });
    expect(denied.stdout).toContain('not saved');

    const ok = await run(t, ['policy', 'edit'], { env: { EDITOR: good }, tty: true, stdin: 'y\n' });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^\+\s+other: \{ profile: agent \}/m);
    expect(ok.stdout).toContain('policy saved');
    const show = await run(t, ['policy', 'show', '--json']);
    expect(Object.keys(show.json.data.contexts)).toContain('other');

    const none = await run(t, ['policy', 'edit', '--yes'], { env: { EDITOR: 'true' } });
    expect(none.stdout).toContain('no changes');
    const noEditor = await run(t, ['policy', 'edit', '--yes'], { env: {} });
    expect(noEditor.code).toBe(2);
  });
});

describe('config.yaml defaults', () => {
  it('create without a template needs defaults.template; with it the default is used', async () => {
    const none = await run(t, ['create', '--yes', '--json']);
    expect(none.code).toBe(2);
    expect(none.json).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(none.json.hint).toContain('defaults.template');
    writeConfig(t, 'defaults:\n  template: host-shell\n');
    const ok = await run(t, ['create', '--yes', '--json']);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.json.data.sandbox.template).toBe('host-shell');
    await run(t, ['rm', '--force', ok.json.data.sandbox.id]);
  });

  it('backends.default was removed: the config is refused with an explanation', async () => {
    writeConfig(t, 'backends:\n  default: podman\n');
    const r = await run(t, ['ls', '--json']);
    expect(r.code).not.toBe(0);
    expect(r.json.message).toContain('backends.default was removed');
  });

  it('doctor documents its exit rule', async () => {
    const h = await run(t, ['doctor', '--help']);
    expect(h.stdout).toContain('exit 1');
  });
});
