import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { createManagerHandlers } from '../../src/main/service';
import { projectOption, resolveProjectDir } from '../../src/main/projects';
import { GuiSettings } from '../../src/main/settings';

let root: string;
let project: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abox-app-projects-')));
  project = join(root, 'project');
  mkdirSync(join(project, '.sandbox'), { recursive: true });
  writeFileSync(join(project, '.sandbox', 'p.yaml'), 'name: p\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('resolveProjectDir: the checks of a human --project, plus the app-level ones', () => {
  it('returns the canonical path (symlinks resolved, .. applied)', async () => {
    symlinkSync(project, join(root, 'link'));
    expect(await resolveProjectDir(join(root, 'link'))).toBe(project);
    expect(await resolveProjectDir(join(root, 'x', '..', 'project'))).toBe(project);
    expect(await resolveProjectDir(`${project}/`)).toBe(project);
  });

  it('refuses relative paths, ~, control characters, missing paths and files', async () => {
    for (const bad of ['relative/dir', '~', '~/project', '.', `${project}\u0000`, `${project}\n`]) {
      await expect(resolveProjectDir(bad), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    await expect(resolveProjectDir(join(root, 'missing'))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('does not exist'),
    });
    await expect(resolveProjectDir(join(project, '.sandbox', 'p.yaml'))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('not a directory'),
    });
  });

  it('does not follow a .sandbox that is a symbolic link; a project without .sandbox is fine', async () => {
    const evil = join(root, 'evil');
    mkdirSync(evil);
    symlinkSync(join(root, 'project', '.sandbox'), join(evil, '.sandbox'));
    await expect(resolveProjectDir(evil)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('symbolic link'),
    });
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(await resolveProjectDir(empty)).toBe(empty);
  });

  it('projectOption gives nothing without a folder', async () => {
    expect(await projectOption(undefined)).toEqual({});
    expect(await projectOption(project)).toEqual({ projectDir: project });
  });
});

describe('handlers pass the canonical project folder to the manager, as the human', () => {
  function build() {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const rec =
      (fn: string, ret: unknown = {}) =>
      (...args: unknown[]) => {
        calls.push({ fn, args });
        return Promise.resolve(ret);
      };
    const abox = {
      listTemplates: rec('listTemplates', { templates: [], problems: [] }),
      showTemplate: rec('showTemplate'),
      reviewTemplate: rec('reviewTemplate'),
      createSandbox: rec('createSandbox', { status: 'created' }),
    };
    const handlers = createManagerHandlers({ abox: abox as unknown as Abox, paths: {} as never });
    return { handlers, calls };
  }
  const human = { contextId: 'human' };

  it('templates:list without a folder asks for builtin and user templates only', async () => {
    const { handlers, calls } = build();
    await handlers['templates:list'](undefined, {});
    await handlers['templates:list']({}, {});
    expect(calls.map((c) => c.args)).toEqual([
      [human, {}],
      [human, {}],
    ]);
  });

  it('templates:list, show, review and create name the canonical folder', async () => {
    const { handlers, calls } = build();
    const viaLink = join(root, 'link');
    await handlers['templates:list']({ projectDir: viaLink }, {});
    await handlers['templates:show']({ name: 'p', projectDir: viaLink }, {});
    await handlers['templates:review']({ name: 'p', projectDir: viaLink, workspacePath: '/w' }, {});
    await handlers['sandboxes:create']({ template: 'p', projectDir: viaLink }, {});
    expect(calls.map((c) => c.args)).toEqual([
      [human, { projectDir: project }],
      [human, 'p', { projectDir: project }],
      [human, 'p', { workspacePath: '/w', projectDir: project }],
      [{ contextId: 'human' }, { template: 'p', projectDir: project }, expect.anything()],
    ]);
  });

  it('a folder the checks refuse never reaches the manager', async () => {
    const { handlers, calls } = build();
    await expect(
      handlers['templates:list']({ projectDir: join(root, 'missing') }, {}),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      handlers['sandboxes:create']({ template: 'p', projectDir: join(root, 'evil') }, {}),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toEqual([]);
  });
});

describe('GuiSettings: recent project folders per user', () => {
  it('keeps the most recent first without duplicates, at most eight, across restarts', () => {
    const dir = mkdtempSync(join(root, 'settings-'));
    const s = new GuiSettings(dir);
    expect(s.recentProjects).toEqual([]);
    for (let i = 0; i < 10; i++) s.addRecentProject(`/p/${i}`);
    s.addRecentProject('/p/5');
    expect(s.recentProjects).toEqual([
      '/p/5',
      '/p/9',
      '/p/8',
      '/p/7',
      '/p/6',
      '/p/4',
      '/p/3',
      '/p/2',
    ]);
    expect(new GuiSettings(dir).recentProjects).toEqual(s.recentProjects);
  });

  it('ignores damaged entries in the settings file', () => {
    const dir = mkdtempSync(join(root, 'settings-'));
    writeFileSync(
      join(dir, 'gui-settings.json'),
      JSON.stringify({ recentProjects: ['/ok', 5, 'relative', null, '/also/ok'] }),
    );
    expect(new GuiSettings(dir).recentProjects).toEqual(['/ok', '/also/ok']);
  });
});
