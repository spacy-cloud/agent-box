import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  projectTemplatePath,
  safeParseTemplateYaml,
  userTemplatePath,
} from '../../template/index.js';
import type { Abox } from '../abox.js';
import { A, HUMAN, HUMAN_YES, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;

const tpl = (name: string, extra = ''): string =>
  `apiVersion: 1\nname: ${name}\ndescription: A template saved by the tests, long enough to be valid.\nbackend: docker\nbase: { os: ubuntu:24.04 }\n${extra}`;

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

describe('template file paths', () => {
  it('a project template goes to exactly <project>/.sandbox/<name>.yaml', () => {
    expect(projectTemplatePath('/work/app', 'my-tpl')).toEqual({
      dir: '/work/app/.sandbox',
      path: '/work/app/.sandbox/my-tpl.yaml',
    });
    expect(userTemplatePath('/cfg/templates', 'a1')).toEqual({
      dir: '/cfg/templates',
      path: '/cfg/templates/a1.yaml',
    });
  });

  it.each([
    '..',
    '../x',
    'a/b',
    '.hidden',
    'a..b/c',
    'UPPER',
    '',
    'a b',
    'a\0b',
    '-lead',
    'x'.repeat(64),
  ])('refuses the name %j', (name) => {
    expect(() => projectTemplatePath('/work/app', name)).toThrow(/invalid template name/);
    expect(() => userTemplatePath('/cfg', name)).toThrow(/invalid template name/);
  });

  it.each(['relative/dir', '/work/../etc', '/work/app\0', ''])(
    'refuses the project folder %j',
    (dir) => {
      expect(() => projectTemplatePath(dir, 'ok')).toThrow();
    },
  );
});

describe('saveTemplate: user directory', () => {
  it('writes the file (0600), reports it and audits it', async () => {
    const r = await abox.saveTemplate(HUMAN, { yaml: tpl('mine'), target: 'user' });
    expect(r).toMatchObject({ name: 'mine', target: 'user', created: true, trusted: true });
    const file = join(env.aboxHome, 'config', 'templates', 'mine.yaml');
    expect(r.path).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(tpl('mine'));
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    const rows = await abox.queryAudit(HUMAN, { action: 'template.save' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'allow' });
    expect(JSON.stringify(rows[0]!.details)).toContain('"target":"user"');
    // nothing else was left behind
    expect(
      readdirSync(join(env.aboxHome, 'config', 'templates')).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('refuses to replace a file without overwrite, replaces it with overwrite', async () => {
    await abox.saveTemplate(HUMAN, { yaml: tpl('mine'), target: 'user' });
    await expect(
      abox.saveTemplate(HUMAN, { yaml: tpl('mine', 'tools: [git]\n'), target: 'user' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    const file = join(env.aboxHome, 'config', 'templates', 'mine.yaml');
    expect(readFileSync(file, 'utf8')).toBe(tpl('mine'));
    const r = await abox.saveTemplate(HUMAN, {
      yaml: tpl('mine', 'tools: [git]\n'),
      target: 'user',
      overwrite: true,
    });
    expect(r.created).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('tools: [git]');
    const denied = (await abox.queryAudit(HUMAN, { action: 'template.save' })).filter(
      (e) => e.decision === 'deny',
    );
    expect(denied).toHaveLength(1);
  });

  it('refuses a template with errors and writes nothing', async () => {
    await expect(
      abox.saveTemplate(HUMAN, {
        yaml: tpl('bad', 'resources: { memory: lots }\n'),
        target: 'user',
      }),
    ).rejects.toMatchObject({ code: 'template_invalid' });
    expect(existsSync(join(env.aboxHome, 'config', 'templates', 'bad.yaml'))).toBe(false);
  });

  it('says that a built-in template of that name is hidden', async () => {
    const r = await abox.saveTemplate(HUMAN, { yaml: tpl('node-dev'), target: 'user' });
    expect(r.shadows).toEqual(['builtin']);
  });

  it('refuses when the other spelling (.yml) already defines the name', async () => {
    const dir = join(env.aboxHome, 'config', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mine.yml'), tpl('mine'));
    await expect(
      abox.saveTemplate(HUMAN, { yaml: tpl('mine'), target: 'user' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(existsSync(join(dir, 'mine.yaml'))).toBe(false);
  });

  it('is a human-only operation', async () => {
    await expect(abox.saveTemplate(A, { yaml: tpl('mine'), target: 'user' })).rejects.toMatchObject(
      {
        code: 'policy_denied',
      },
    );
    await expect(
      abox.planTemplateSave(A, { yaml: tpl('mine'), target: 'user' }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(existsSync(join(env.aboxHome, 'config', 'templates', 'mine.yaml'))).toBe(false);
  });
});

describe('saveTemplate: project', () => {
  it('needs the human to confirm', async () => {
    await expect(
      abox.saveTemplate(HUMAN, { yaml: tpl('p1'), target: 'project', projectDir: env.project }),
    ).rejects.toMatchObject({ code: 'approval_required' });
    expect(existsSync(join(env.project, '.sandbox'))).toBe(false);
  });

  it('needs a project folder', async () => {
    await expect(
      abox.saveTemplate(HUMAN_YES, { yaml: tpl('p1'), target: 'project' }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('writes exactly <project>/.sandbox/<name>.yaml, creates .sandbox, and does not trust the result', async () => {
    const r = await abox.saveTemplate(HUMAN_YES, {
      yaml: tpl('p1'),
      target: 'project',
      projectDir: env.project,
    });
    const file = join(env.project, '.sandbox', 'p1.yaml');
    expect(r).toMatchObject({
      name: 'p1',
      target: 'project',
      path: file,
      projectDir: env.project,
      created: true,
      trusted: false,
    });
    expect(readFileSync(file, 'utf8')).toBe(tpl('p1'));
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(env.project, '.sandbox'))).toEqual(['p1.yaml']);
    const listed = await abox.listTemplates(HUMAN, { projectDir: env.project });
    expect(listed.templates.find((t) => t.name === 'p1')).toMatchObject({
      source: { kind: 'project' },
      trusted: false,
    });
    const audit = await abox.queryAudit(HUMAN, { action: 'template.save' });
    expect(JSON.stringify(audit[0]!.details)).toContain('"trusted":false');
  });

  it('refuses to overwrite without the flag and replaces the file with it', async () => {
    const input = { yaml: tpl('p1'), target: 'project' as const, projectDir: env.project };
    await abox.saveTemplate(HUMAN_YES, input);
    await expect(
      abox.saveTemplate(HUMAN_YES, { ...input, yaml: tpl('p1', 'tools: [git]\n') }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(readFileSync(join(env.project, '.sandbox', 'p1.yaml'), 'utf8')).toBe(tpl('p1'));
    const r = await abox.saveTemplate(HUMAN_YES, {
      ...input,
      yaml: tpl('p1', 'tools: [git]\n'),
      overwrite: true,
    });
    expect(r.created).toBe(false);
    expect(readFileSync(join(env.project, '.sandbox', 'p1.yaml'), 'utf8')).toContain(
      'tools: [git]',
    );
  });

  it('does not write through a .sandbox that is a symbolic link', async () => {
    const elsewhere = join(env.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(env.project, '.sandbox'));
    await expect(
      abox.saveTemplate(HUMAN_YES, { yaml: tpl('p1'), target: 'project', projectDir: env.project }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('the plan refuses a .sandbox that is a symbolic link too', async () => {
    const elsewhere = join(env.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(env.project, '.sandbox'));
    await expect(
      abox.planTemplateSave(HUMAN, { yaml: tpl('p1'), target: 'project', projectDir: env.project }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not follow a symbolic link in place of the template file', async () => {
    mkdirSync(join(env.project, '.sandbox'));
    const victim = join(env.root, 'victim.txt');
    writeFileSync(victim, 'keep me');
    symlinkSync(victim, join(env.project, '.sandbox', 'p1.yaml'));
    for (const overwrite of [false, true]) {
      await expect(
        abox.saveTemplate(HUMAN_YES, {
          yaml: tpl('p1'),
          target: 'project',
          projectDir: env.project,
          overwrite,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    }
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    await expect(
      abox.planTemplateSave(HUMAN, { yaml: tpl('p1'), target: 'project', projectDir: env.project }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('writes into the real folder when the project is reached through a link', async () => {
    const link = join(env.root, 'link-to-app');
    symlinkSync(env.project, link);
    const r = await abox.saveTemplate(HUMAN_YES, {
      yaml: tpl('p1'),
      target: 'project',
      projectDir: link,
    });
    expect(r.path).toBe(join(env.project, '.sandbox', 'p1.yaml'));
  });

  it('refuses folders that are not usable', async () => {
    await expect(
      abox.saveTemplate(HUMAN_YES, {
        yaml: tpl('p1'),
        target: 'project',
        projectDir: join(env.root, 'missing'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      abox.saveTemplate(HUMAN_YES, {
        yaml: tpl('p1'),
        target: 'project',
        projectDir: join(env.home, '.ssh'),
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.saveTemplate(HUMAN_YES, {
        yaml: tpl('p1'),
        target: 'project',
        projectDir: join(env.project, 'README.md'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('an agent cannot save anything into a project', async () => {
    await expect(
      abox.saveTemplate(
        { ...A, humanConfirmed: true },
        { yaml: tpl('p1'), target: 'project', projectDir: env.project },
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(existsSync(join(env.project, '.sandbox'))).toBe(false);
  });
});

describe('planTemplateSave', () => {
  it('shows the file and the text that is there now, writes nothing', async () => {
    const before = await abox.planTemplateSave(HUMAN, { yaml: tpl('mine'), target: 'user' });
    expect(before).toMatchObject({ name: 'mine', exists: false, current: null, shadows: [] });
    await abox.saveTemplate(HUMAN, { yaml: tpl('mine'), target: 'user' });
    const after = await abox.planTemplateSave(HUMAN, {
      yaml: tpl('mine', 'tools: [git]\n'),
      target: 'user',
    });
    expect(after).toMatchObject({ exists: true, current: tpl('mine') });
    const p = await abox.planTemplateSave(HUMAN, {
      yaml: tpl('p9'),
      target: 'project',
      projectDir: env.project,
    });
    expect(p).toMatchObject({
      path: join(env.project, '.sandbox', 'p9.yaml'),
      projectDir: env.project,
      exists: false,
    });
    expect(existsSync(join(env.project, '.sandbox'))).toBe(false);
  });
});

describe('draftTemplateFromProject', () => {
  function project(name: string, files: Record<string, string>): string {
    const d = join(env.projects, name);
    mkdirSync(d, { recursive: true });
    for (const [f, content] of Object.entries(files)) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), content);
    }
    return d;
  }

  it('builds on the detected built-in template, named after the folder, with the reason', async () => {
    const p = project('My Web App', { 'package.json': '{}' });
    const d = await abox.draftTemplateFromProject(HUMAN, { path: p });
    expect(d).toMatchObject({
      path: p,
      name: 'my-web-app',
      base: { template: 'node-dev', basis: 'markers', files: ['package.json'] },
      projectTemplates: [],
    });
    expect(d.base.reason).toContain('package.json');
    const parsed = safeParseTemplateYaml(d.yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec).toMatchObject({
        name: 'my-web-app',
        extends: 'node-dev',
        backend: 'docker',
      });
      expect(parsed.spec.description).toContain('My Web App');
    }
    // the draft resolves: it can be validated like any user template
    await abox.saveTemplate(HUMAN, { yaml: d.yaml, target: 'user' });
    const shown = await abox.showTemplate(HUMAN, 'my-web-app');
    expect(shown.template.tools.map((t) => t.name)).toContain('node');
  });

  it('lists the other detected templates and lets the caller pick one', async () => {
    const p = project('both', { 'package.json': '{}', 'Cargo.toml': '' });
    const d = await abox.draftTemplateFromProject(HUMAN, { path: p });
    const other = d.alternatives[0]!.template;
    expect(['rust-dev', 'node-dev']).toContain(other);
    const picked = await abox.draftTemplateFromProject(HUMAN, {
      path: p,
      base: other,
      name: 'custom',
    });
    expect(picked).toMatchObject({ name: 'custom', base: { template: other, basis: 'chosen' } });
    expect(picked.yaml).toContain(`extends: ${other}`);
    const free = await abox.draftTemplateFromProject(HUMAN, { path: p, base: 'alpine-min' });
    expect(free.base).toMatchObject({ template: 'alpine-min', basis: 'chosen', files: [] });
  });

  it('is a standalone template when nothing matches', async () => {
    const p = project('plain', { 'notes.txt': 'x' });
    const d = await abox.draftTemplateFromProject(HUMAN, { path: p });
    expect(d.base).toMatchObject({ template: null, basis: 'fallback' });
    const parsed = safeParseTemplateYaml(d.yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.extends).toBeUndefined();
  });

  it("does not use the project's own templates as a base, and avoids names that are taken", async () => {
    const p = project('node-dev', { 'package.json': '{}' });
    mkdirSync(join(p, '.sandbox'));
    writeFileSync(join(p, '.sandbox', 'own.yaml'), tpl('own'));
    const d = await abox.draftTemplateFromProject(HUMAN, { path: p });
    expect(d.projectTemplates).toEqual(['own']);
    expect(d.base.template).toBe('node-dev');
    expect(d.name).toBe('node-dev-sandbox'); // the folder name is a built-in template's name
    await expect(
      abox.draftTemplateFromProject(HUMAN, { path: p, base: 'own' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      abox.draftTemplateFromProject(HUMAN, { path: p, name: '../x' }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('is a human-only operation and writes nothing', async () => {
    const p = project('h', { 'package.json': '{}' });
    await expect(abox.draftTemplateFromProject(A, { path: p })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await abox.draftTemplateFromProject(HUMAN, { path: p });
    expect(existsSync(join(p, '.sandbox'))).toBe(false);
  });
});
