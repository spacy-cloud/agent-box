import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { createManagerHandlers } from '../../src/main/service';
import { createTemplateHandlers } from '../../src/main/templates';

let root: string;
let project: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abox-app-tpl-editor-')));
  project = join(root, 'project');
  mkdirSync(project);
  symlinkSync(project, join(root, 'link'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const human = { contextId: 'human' };
const confirmed = { contextId: 'human', humanConfirmed: true };

function fakeAbox(sandboxes: Array<{ name: string; template: string; state: string }> = []) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const rec =
    (fn: string, ret: unknown = {}) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      return Promise.resolve(ret);
    };
  const abox = {
    draftTemplateFromProject: rec('draftTemplateFromProject', { name: 'x' }),
    planTemplateSave: rec('planTemplateSave', { name: 'mine', exists: true, current: 'a' }),
    listSandboxes: rec('listSandboxes', { sandboxes }),
    saveTemplate: rec('saveTemplate', {
      name: 'mine',
      target: 'project',
      path: `${project}/.sandbox/mine.yaml`,
      projectDir: project,
      created: true,
      bytes: 3,
      shadows: [],
      trusted: false,
    }),
  };
  return { abox: abox as unknown as Abox, calls };
}

describe('template from project and save review', () => {
  it('templates:draft asks the manager as the human about the canonical folder, with the chosen name and base', async () => {
    const { abox, calls } = fakeAbox();
    const handlers = createManagerHandlers({ abox, paths: {} as never });
    await handlers['templates:draft'](
      { path: join(root, 'link'), name: 'mine', base: 'node-dev' },
      {},
    );
    await handlers['templates:draft']({ path: join(root, 'link') }, {});
    expect(calls.map((c) => c.args)).toEqual([
      [human, { path: project, name: 'mine', base: 'node-dev' }],
      [human, { path: project }],
    ]);
    await expect(
      handlers['templates:draft']({ path: join(root, 'missing') }, {}),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(2);
  });

  it('templates:savePlan returns the manager plan and the sandboxes that use the name (not removed ones)', async () => {
    const { abox, calls } = fakeAbox([
      { name: 'one', template: 'mine', state: 'running' },
      { name: 'two', template: 'other', state: 'running' },
      { name: 'three', template: 'mine', state: 'stopped' },
      { name: 'gone', template: 'mine', state: 'removed' },
    ]);
    const handlers = createManagerHandlers({ abox, paths: {} as never });
    const plan = await handlers['templates:savePlan'](
      { yaml: 'name: mine\n', target: 'project', projectDir: join(root, 'link') },
      {},
    );
    expect(plan).toMatchObject({ name: 'mine', usedBy: { count: 2, names: ['one', 'three'] } });
    expect(calls[0]).toEqual({
      fn: 'planTemplateSave',
      args: [human, { yaml: 'name: mine\n', target: 'project', projectDir: project }],
    });
  });

  it('templates:save goes through the manager; only a confirmed save carries humanConfirmed', async () => {
    const { abox, calls } = fakeAbox();
    const h = createTemplateHandlers({
      abox,
      paths: { runtimeDir: root, templatesDir: root } as never,
    });
    const r = await h['templates:save']({
      yaml: 'name: mine\n',
      target: 'project',
      projectDir: join(root, 'link'),
      overwrite: true,
      confirmed: true,
    });
    await h['templates:save']({ yaml: 'name: mine\n' });
    expect(calls.map((c) => c.args)).toEqual([
      [
        confirmed,
        { yaml: 'name: mine\n', target: 'project', projectDir: project, overwrite: true },
      ],
      [human, { yaml: 'name: mine\n', target: 'user' }],
    ]);
    expect(r).toMatchObject({
      name: 'mine',
      target: 'project',
      trusted: false,
      projectDir: project,
    });
  });

  it('a project folder the checks refuse never reaches the manager', async () => {
    const { abox, calls } = fakeAbox();
    const h = createTemplateHandlers({
      abox,
      paths: { runtimeDir: root, templatesDir: root } as never,
    });
    await expect(
      h['templates:save']({ yaml: 'x', target: 'project', projectDir: join(root, 'missing') }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toEqual([]);
  });
});
