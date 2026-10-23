import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

/** `abox skill ls|show|validate` and `abox create --skill` (process backend, no engine needed). */
let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

describe('abox skill', () => {
  it('ls lists the builtin skills, also as JSON', async () => {
    const r = await run(t, ['skill', 'ls']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/NAME\s+SOURCE\s+TRUSTED\s+FILES\s+DESCRIPTION/);
    for (const name of ['minimal-change', 'run-tests', 'work-in-sandbox'])
      expect(r.stdout).toContain(name);
    const j = await run(t, ['skill', 'ls', '--json']);
    expect(j.json.data.skills.map((s: { name: string }) => s.name)).toEqual([
      'minimal-change',
      'run-tests',
      'work-in-sandbox',
    ]);
  });

  it('show prints the source, the files and the instructions', async () => {
    const r = await run(t, ['skill', 'show', 'run-tests']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/source:\s+builtin /);
    expect(r.stdout).toMatch(/in a sandbox:\s+\/skills\/run-tests/);
    expect(r.stdout).toContain('# Run the tests and report them');
    const missing = await run(t, ['skill', 'show', 'nope']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('[not_found]');
  });

  it('validate names every problem with file and line, and exit code 2', async () => {
    const dir = join(t.project, 'my-skill');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: other\ncolour: red\n---\n');
    const r = await run(t, ['skill', 'validate', './my-skill']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('[skill_invalid]');
    expect(r.stderr).toContain(`${dir}/SKILL.md:2:7 name "other" differs from the folder name`);
    expect(r.stderr).toContain(`${dir}/SKILL.md:3:1 unknown front matter key "colour"`);
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A skill of the CLI tests that says what to do.\n---\nDo it.\n',
    );
    const ok = await run(t, ['skill', 'validate', dir]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/my-skill: valid \(.*, 1 file, \d+ bytes\)/);
    expect((await run(t, ['skill', 'validate', 'run-tests'])).code).toBe(0);
  });

  it('a project skill shows up untrusted in ls', async () => {
    const dir = join(t.project, '.sandbox', 'skills', 'proj-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: proj-skill\ndescription: A skill that lives in the project of the CLI tests.\n---\nDo it.\n',
    );
    const r = await run(t, ['skill', 'ls', '--json']);
    const s = r.json.data.skills.find((x: { name: string }) => x.name === 'proj-skill');
    expect(s).toMatchObject({ source: { kind: 'project' }, trusted: false });
  });
});

describe('abox create --skill', () => {
  it('places the skills in the sandbox; inspect and the shell see them', async () => {
    const c = await run(t, [
      'create',
      'host-shell',
      '--skill',
      'run-tests',
      '--skill',
      'minimal-change',
      '--yes',
      '--json',
    ]);
    expect(c.code, c.stderr).toBe(0);
    const id = c.json.data.sandbox.id as string;
    expect(c.json.data.sandbox.skills.map((s: { name: string }) => s.name)).toEqual([
      'run-tests',
      'minimal-change',
    ]);
    const insp = await run(t, ['inspect', id]);
    expect(insp.stdout).toMatch(/skills:\s+run-tests, minimal-change in \/skills/);
    // the process backend points ABOX_SKILLS_DIR into the sandbox root
    const e = await run(t, ['exec', id, '--', 'sh', '-c', 'cat "$ABOX_SKILLS_DIR/INDEX.md"']);
    expect(e.code, e.stderr).toBe(0);
    expect(e.stdout).toContain('## minimal-change');
    expect(e.stdout).toContain('- path: run-tests/SKILL.md');
    expect((await run(t, ['rm', '-f', id])).code).toBe(0);
  });

  it('an unknown skill fails the create before anything is built', async () => {
    const r = await run(t, ['create', 'host-shell', '--skill', 'nope', '--yes']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("skill 'nope' not found");
  });
});
