import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

let t: TestEnv;

beforeEach(() => {
  t = makeEnv();
  // only the process backend on `local`: no Docker involved
  t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
});
afterEach(() => t.cleanup());

function projectTemplate(): void {
  const dir = join(t.project, '.sandbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'proj-host.yaml'),
    `apiVersion: 1\nname: proj-host\ndescription: Project template for the auto-detection tests, runs on the host.\nbackend: process\nisolation: none\nworkspace: { mode: copy, path: /workspace, access: rw }\nresources: { cpus: 1, memory: 256m, pids: 64, ttl: 1h }\nnetwork: { mode: open }\n`,
  );
}

describe('create --auto', () => {
  it('says which template it chose and why, and creates the sandbox from it', async () => {
    projectTemplate();
    writeFileSync(join(t.project, 'package.json'), '{}');
    const r = await run(t, ['create', '--auto', '-w', '.', '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('auto: using template proj-host for');
    expect(r.stderr).toContain('.sandbox/proj-host.yaml');
    expect(r.stderr).toContain('project templates win over detected markers');
    expect(r.stderr).toContain('also possible: node-dev');
    expect(r.stdout).toContain('from proj-host');
  });

  it('names the markers it went by', async () => {
    writeFileSync(join(t.project, 'Cargo.toml'), '');
    mkdirSync(join(t.project, 'src-tauri'));
    writeFileSync(join(t.project, 'src-tauri', 'tauri.conf.json'), '{}');
    const r = await run(t, ['create', '--auto', '-w', '.', '--json']);
    // the process-only host cannot run the docker based template, which is the create's business
    expect(r.json).toMatchObject({ ok: false });
    const info = await run(t, ['create', '--auto', '-w', '.']);
    expect(info.stderr).toContain('auto: using template tauri-dev for');
    expect(info.stderr).toContain('found src-tauri/tauri.conf.json and Cargo.toml (a Tauri app)');
    expect(info.stderr).toContain('also possible: rust-dev');
  });

  it('looks at the project directory when no workspace is given, and the workspace stays empty', async () => {
    projectTemplate();
    const r = await run(t, ['create', '--auto', '--yes', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.auto).toMatchObject({
      primary: { template: 'proj-host', basis: 'project_template' },
    });
    expect(r.json.data.sandbox.template).toBe('proj-host');
  });

  it('fails clearly when nothing matches', async () => {
    const r = await run(t, ['create', '--auto', '-w', '.']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--auto found no template for');
    expect(r.stderr).toContain('no known marker file');
    expect(r.stderr).toContain('abox template ls');
    const j = await run(t, ['create', '--auto', '-w', '.', '--json']);
    expect(j.json).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('cannot be combined with a template name', async () => {
    writeFileSync(join(t.project, 'package.json'), '{}');
    const r = await run(t, ['create', 'host-shell', '--auto', '-w', '.']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--auto and a template name exclude each other');
  });
});

describe('template suggest', () => {
  it('prints the suggestion with the reason and the alternatives', async () => {
    writeFileSync(join(t.project, 'package.json'), '{}');
    writeFileSync(join(t.project, 'uv.lock'), '');
    const r = await run(t, ['template', 'suggest']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('suggested: py-uv  (found uv.lock (a Python project))');
    expect(r.stdout).toContain('also possible: node-dev');
  });

  it('--json carries the structure, --quiet only the name', async () => {
    writeFileSync(join(t.project, 'pubspec.yaml'), 'name: x\n');
    const j = await run(t, ['template', 'suggest', '.', '--json']);
    expect(j.json.data).toMatchObject({
      primary: { template: 'flutter-dev', basis: 'markers', files: ['pubspec.yaml'] },
      alternatives: [],
    });
    const q = await run(t, ['template', 'suggest', '--quiet']);
    expect(q.stdout.trim()).toBe('flutter-dev');
  });

  it('says so when nothing matches', async () => {
    const r = await run(t, ['template', 'suggest']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no template suggested');
  });
});
