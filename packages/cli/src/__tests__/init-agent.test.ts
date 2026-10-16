import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

function projectIn(...parts: string[]): string {
  const dir = join(t.home, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('abox init --agent: workspace roots of the built-in policy', () => {
  it('a project below ~/projects works', async () => {
    const cwd = projectIn('projects', 'app');
    const r = await run(t, ['init', '--agent', 'claude-code', '--json'], { cwd });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.workspace).toMatchObject({ allowed: true });
    expect(r.json.data.workspace.roots).toContain('~/projects');
    expect(r.json.data.workspace.roots).not.toContain('~');
    const text = await run(t, ['init', '--agent', 'claude-code', '--force'], { cwd });
    expect(text.stdout).toContain('may work on projects below: ~/projects, ~/Projekte, ~/src');
    expect(text.stdout).not.toContain('is not usable');
  });

  it('a project elsewhere in the home directory is called out, with the way to fix it', async () => {
    const cwd = projectIn('Documents', 'thesis');
    const r = await run(t, ['init', '--agent', 'claude-code', '--json'], { cwd });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.workspace.allowed).toBe(false);
    expect(r.json.data.workspace.reason).toContain('outside the allowed workspace roots');
    const text = await run(t, ['init', '--agent', 'codex', '--force'], { cwd });
    expect(text.stdout).toContain('is not usable for it');
    expect(text.stdout).toContain('abox policy edit');
    expect(text.stdout).toContain('workspace.roots');
  });

  it('a project inside a hidden home directory is refused whatever the roots', async () => {
    const cwd = projectIn('.cache', 'x');
    const r = await run(t, ['init', '--agent', 'cursor', '--json'], { cwd });
    expect(r.json.data.workspace.allowed).toBe(false);
    expect(r.json.data.workspace.reason).toContain('hidden');
  });

  it('abox policy show lists the roots and the image registries', async () => {
    const r = await run(t, ['policy', 'show', '--context', 'claude-code']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      'below ~/projects, ~/Projekte, ~/src, ~/code, ~/dev, ~/work, ~/git, ~/repos',
    );
    expect(r.stdout).toContain('registries docker.io/library');
  });
});
