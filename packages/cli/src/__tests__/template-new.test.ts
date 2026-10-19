import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

let t: TestEnv;
let app: string;

beforeEach(() => {
  t = makeEnv();
  t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
  app = join(t.home, 'My App');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{}');
});
afterEach(() => t.cleanup());

describe('template new --from-project', () => {
  it('prints a template that extends the detected one, says why, and writes nothing', async () => {
    const r = await run(t, ['template', 'new', '--from-project', app]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('name: my-app');
    expect(r.stdout).toContain('extends: node-dev');
    expect(r.stderr).toContain('extends node-dev (found package.json');
    expect(existsSync(join(app, '.sandbox'))).toBe(false);
    expect(existsSync(join(t.aboxHome, 'config', 'templates', 'my-app.yaml'))).toBe(false);
  });

  it('--save user writes the user template directory and the result validates', async () => {
    const r = await run(t, ['template', 'new', '--from-project', app, '--save', 'user']);
    expect(r.code, r.stderr).toBe(0);
    const file = join(t.aboxHome, 'config', 'templates', 'my-app.yaml');
    expect(readFileSync(file, 'utf8')).toContain('extends: node-dev');
    expect(r.stdout).toContain(`saved ${file}`);
    const v = await run(t, ['template', 'validate', 'my-app']);
    expect(v.code, v.stderr + v.stdout).toBe(0);
    // the same name again is a conflict until --overwrite
    const again = await run(t, [
      'template',
      'new',
      '--from-project',
      app,
      '--name',
      'my-app',
      '--save',
      'user',
    ]);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('already exists');
    const over = await run(t, [
      'template',
      'new',
      '--from-project',
      app,
      '--name',
      'my-app',
      '--save',
      'user',
      '--overwrite',
    ]);
    expect(over.code, over.stderr).toBe(0);
    expect(over.stdout).toContain('replaced');
  });

  it('--save project needs --yes (or an answer on a terminal), and the result is not trusted', async () => {
    const no = await run(t, ['template', 'new', '--from-project', app, '--save', 'project']);
    expect(no.code).toBe(3);
    expect(no.stderr).toContain('needs your confirmation');
    expect(existsSync(join(app, '.sandbox'))).toBe(false);

    const declined = await run(t, ['template', 'new', '--from-project', app, '--save', 'project'], {
      tty: true,
      stdin: 'n\n',
    });
    expect(declined.code).toBe(3);
    expect(existsSync(join(app, '.sandbox'))).toBe(false);

    const asked = await run(t, ['template', 'new', '--from-project', app, '--save', 'project'], {
      tty: true,
      stdin: 'y\n',
    });
    expect(asked.code, asked.stderr).toBe(0);
    expect(existsSync(join(app, '.sandbox', 'my-app.yaml'))).toBe(true);

    const r = await run(t, [
      'template',
      'new',
      '--from-project',
      app,
      '--name',
      'second',
      '--save',
      'project',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.saved).toMatchObject({ name: 'second', target: 'project', trusted: false });
    expect(readFileSync(join(app, '.sandbox', 'second.yaml'), 'utf8')).toContain('name: second');
    expect(r.json.data.draft.base).toMatchObject({ template: 'node-dev' });
    const ls = await run(t, ['template', 'ls', '--project', app, '--json']);
    const entry = ls.json.data.templates.find((x: { name: string }) => x.name === 'second');
    expect(entry).toMatchObject({ trusted: false, source: { kind: 'project' } });
  });

  it('takes --base and --name, and refuses a bad value', async () => {
    const r = await run(t, [
      'template',
      'new',
      '--from-project',
      app,
      '--base',
      'alpine-min',
      '--name',
      'tiny',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('extends: alpine-min');
    expect(r.stdout).toContain('name: tiny');
    const bad = await run(t, ['template', 'new', '--from-project', app, '--save', 'elsewhere']);
    expect(bad.code).toBe(2);
    const noSave = await run(t, ['template', 'new', '--from-project', app, '--yes']);
    expect(noSave.code).toBe(2);
    const badName = await run(t, ['template', 'new', '--from-project', app, '--name', '../x']);
    expect(badName.code).toBe(2);
  });

  it('is a standalone template when nothing is detected', async () => {
    const plain = join(t.home, 'plain');
    mkdirSync(plain);
    const r = await run(t, ['template', 'new', '--from-project', plain]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('extends:');
    expect(r.stderr).toContain('no known marker file');
  });
});
