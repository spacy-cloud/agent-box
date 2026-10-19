import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import {
  A,
  HUMAN,
  makeEnv,
  openAbox,
  projectTemplate,
  testPolicy,
  writePolicy,
  writeUserTemplates,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;
let dir: string;

/** The agent profile may use node-dev and php-dev on top of the test templates. */
async function openWith(allowed: string): Promise<void> {
  abox.close();
  writePolicy(
    env,
    testPolicy(env).replace('templates: [host-shell,', `templates: [${allowed}, host-shell,`),
  );
  writeUserTemplates(env);
  abox = await openAbox(env, { bare: true });
}

function project(name: string, files: Record<string, string>): string {
  const d = join(env.projects, name);
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), content);
  }
  mkdirSync(d, { recursive: true });
  return d;
}

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
  dir = env.project;
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

describe('suggestTemplate', () => {
  it('suggests the template of the markers with the files as reason, the others as alternatives', async () => {
    const p = project('tauri', {
      'package.json': '{}',
      'src-tauri/Cargo.toml': '',
      'src-tauri/tauri.conf.json': '{}',
      'Cargo.toml': '',
    });
    const s = await abox.suggestTemplate(HUMAN, { path: p });
    expect(s.path).toBe(p);
    expect(s.primary).toMatchObject({
      template: 'tauri-dev',
      basis: 'markers',
      files: ['src-tauri/tauri.conf.json', 'Cargo.toml', 'src-tauri/Cargo.toml'],
    });
    expect(s.primary!.reason).toContain('Tauri');
    expect(s.alternatives.map((a) => a.template)).toEqual(['rust-dev', 'node-dev']);
    expect(s.skipped).toEqual([]);
    expect(s.truncated).toBe(false);
  });

  it('suggests nothing for a folder without markers', async () => {
    const s = await abox.suggestTemplate(HUMAN, { path: dir });
    expect(s).toMatchObject({ primary: null, alternatives: [], skipped: [] });
  });

  it('a project template always wins over the markers, which stay as alternatives', async () => {
    const p = project('own', {
      'package.json': '{}',
      '.sandbox/web.yaml': projectTemplate('web'),
      '.sandbox/api.yaml': projectTemplate('api'),
    });
    const s = await abox.suggestTemplate(HUMAN, { path: p });
    expect(s.primary).toMatchObject({
      template: 'api',
      basis: 'project_template',
      files: ['.sandbox/api.yaml'],
    });
    expect(s.alternatives.map((a) => [a.template, a.basis])).toEqual([
      ['web', 'project_template'],
      ['node-dev', 'markers'],
    ]);
  });

  it('a project template that overrides a detected one is listed once, as the project template', async () => {
    const p = project('over', {
      'package.json': '{}',
      '.sandbox/node-dev.yaml': projectTemplate('node-dev'),
      '.sandbox/zzz.yaml': projectTemplate('zzz'),
    });
    const s = await abox.suggestTemplate(HUMAN, { path: p });
    expect(s.primary).toMatchObject({ template: 'node-dev', basis: 'project_template' });
    expect(s.alternatives.map((a) => a.template)).toEqual(['zzz']);
  });

  it('a project template named default comes first among several', async () => {
    const p = project('dflt', {
      '.sandbox/a.yaml': projectTemplate('a'),
      '.sandbox/default.yaml': projectTemplate('default'),
    });
    expect((await abox.suggestTemplate(HUMAN, { path: p })).primary!.template).toBe('default');
  });

  it('a broken project template is ignored, not suggested', async () => {
    const p = project('broken', { 'package.json': '{}', '.sandbox/bad.yaml': 'not: [a template' });
    const s = await abox.suggestTemplate(HUMAN, { path: p });
    expect(s.primary).toMatchObject({ template: 'node-dev', basis: 'markers' });
  });

  it('never suggests a template the agent policy does not allow, and says so', async () => {
    const p = project('web', { 'package.json': '{}', 'index.php': '<?php' });
    // the agent profile of the tests allows neither node-dev nor php-dev
    const s = await abox.suggestTemplate(A, { path: p });
    expect(s.primary).toBeNull();
    expect(s.alternatives).toEqual([]);
    expect(s.skipped).toEqual([
      { template: 'node-dev', files: ['package.json'], why: 'not_allowed' },
      { template: 'php-dev', files: ['index.php'], why: 'not_allowed' },
    ]);
    // the human is allowed everything
    expect((await abox.suggestTemplate(HUMAN, { path: p })).primary!.template).toBe('node-dev');
  });

  it('falls back to the next allowed template when the best one is not allowed', async () => {
    await openWith('php-dev');
    const p = project('mixed', { 'package.json': '{}', 'composer.json': '{}' });
    const forAgent = await abox.suggestTemplate(A, { path: p });
    expect(forAgent.primary).toMatchObject({ template: 'php-dev' });
    await openWith('node-dev');
    const s = await abox.suggestTemplate(A, { path: p });
    expect(s.primary).toMatchObject({ template: 'node-dev' });
    expect(s.skipped.map((x) => x.template)).toEqual(['php-dev']);
  });

  it('a project template the agent policy does not allow is not suggested either', async () => {
    const p = project('own2', {
      'package.json': '{}',
      '.sandbox/not-in-policy.yaml': projectTemplate('not-in-policy'),
    });
    await openWith('node-dev');
    const s = await abox.suggestTemplate(A, { path: p });
    expect(s.primary).toMatchObject({ template: 'node-dev', basis: 'markers' });
    expect([s.primary, ...s.alternatives].map((e) => e!.template)).not.toContain('not-in-policy');
  });

  it('refuses folders an agent could not use as a workspace, but not for the human', async () => {
    await expect(abox.suggestTemplate(A, { path: env.datasets })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(abox.suggestTemplate(A, { path: join(env.home, '.ssh') })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(abox.suggestTemplate(HUMAN, { path: env.datasets })).resolves.toMatchObject({
      primary: null,
    });
  });

  it('rejects a missing folder, a file and bad input', async () => {
    await expect(abox.suggestTemplate(HUMAN, { path: join(dir, 'nope') })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      abox.suggestTemplate(HUMAN, { path: join(dir, 'README.md') }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(abox.suggestTemplate(HUMAN, { path: '' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      abox.suggestTemplate(HUMAN, { path: dir, extra: 1 } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('does not follow a linked marker out of the project', async () => {
    const p = project('linked', {});
    writeFileSync(join(env.datasets, 'package.json'), '{}');
    symlinkSync(join(env.datasets, 'package.json'), join(p, 'package.json'));
    expect((await abox.suggestTemplate(A, { path: p })).primary).toBeNull();
  });

  it('is read-only: nothing is created, nothing is audited', async () => {
    const p = project('ro', { 'package.json': '{}' });
    const before = abox.verifyAudit(HUMAN);
    await abox.suggestTemplate(HUMAN, { path: p });
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
    expect(abox.verifyAudit(HUMAN)).toEqual(before);
  });
});
