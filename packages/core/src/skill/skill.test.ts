import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAboxError } from '../errors.js';
import { SKILLS_DIR } from '../types.js';
import {
  MAX_SANDBOX_SKILLS,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_FILES,
  SkillCatalog,
  builtinSkillsDir,
  loadSkillDir,
  parseSkillMd,
  renderSkillsIndex,
  skillSpecFiles,
  type ResolvedSkill,
} from './index.js';

const md = (
  name: string,
  description = `Does ${name} things for the tests of the catalog.`,
  extra = '',
) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nDo the thing.\n`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abox-skill-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(
  dir: string,
  name: string,
  text = md(name),
  files: Record<string, string> = {},
): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), text);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), content);
  }
  return d;
}

async function invalid(
  p: Promise<unknown>,
): Promise<Array<{ path?: string; line?: number; message: string }>> {
  try {
    await p;
  } catch (e) {
    if (isAboxError(e) && e.code === 'skill_invalid') return e.issues;
    throw e;
  }
  throw new Error('expected skill_invalid');
}

describe('SKILL.md front matter', () => {
  it('accepts name, description, the known optional keys and a body', () => {
    const r = parseSkillMd(
      md(
        'a-skill',
        'Short but clear description.',
        'license: MIT\nallowed-tools: [Bash, Read]\nmetadata: { team: x }\n',
      ),
      'a-skill',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.frontMatter.name).toBe('a-skill');
    expect(r.skill.frontMatter.extra).toEqual({
      license: 'MIT',
      'allowed-tools': ['Bash', 'Read'],
      metadata: { team: 'x' },
    });
    expect(r.skill.body).toContain('Do the thing.');
  });

  it('needs front matter at the very start', () => {
    const r = parseSkillMd('# no front matter\n', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ path: 'SKILL.md', line: 1 });
  });

  it('reports missing keys, a wrong name, unknown keys and an empty body with their lines', () => {
    const r = parseSkillMd('---\nname: other\ncolour: red\n---\n', 'mine');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msgs = r.issues.map((i) => `${i.line}: ${i.message}`);
    expect(msgs).toContainEqual(expect.stringMatching(/^3: unknown front matter key "colour"/));
    expect(msgs).toContainEqual(
      expect.stringMatching(/^2: name "other" differs from the folder name "mine"/),
    );
    expect(msgs).toContainEqual(expect.stringMatching(/missing required key "description"/));
    expect(msgs).toContainEqual(expect.stringMatching(/no instructions after the front matter/));
  });

  it('limits the description and checks the types of the optional keys', () => {
    const long = 'x'.repeat(MAX_SKILL_DESCRIPTION + 1);
    const r = parseSkillMd(md('s', long, 'license: 3\nmetadata: [a]\n'), 's');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/at most 1024 are allowed/),
        'license must be a string',
        'metadata must be a map of strings',
      ]),
    );
  });

  it('rejects names that are not skill names, and YAML errors with a line', () => {
    const bad = parseSkillMd(md('Bad_Name'), 'Bad_Name');
    expect(!bad.ok && bad.issues[0]!.message).toMatch(/must match/);
    const broken = parseSkillMd('---\nname: [a\n---\nbody\n', 'a');
    expect(!broken.ok && broken.issues[0]!.line).toBeGreaterThanOrEqual(2);
  });
});

describe('skill folders', () => {
  it('loads every file, keeps the executable bit and hashes the content', async () => {
    const d = skill(root, 'tool', md('tool'), {
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
      'references/a.md': 'ref\n',
    });
    chmodSync(join(d, 'scripts/run.sh'), 0o755);
    const s = await loadSkillDir(d, 'user');
    expect(s.files.map((f) => [f.path, f.executable])).toEqual([
      ['SKILL.md', false],
      ['references/a.md', false],
      ['scripts/run.sh', true],
    ]);
    expect(s.source).toEqual({ kind: 'user', path: d });
    const before = s.contentHash;
    chmodSync(join(d, 'scripts/run.sh'), 0o644);
    expect((await loadSkillDir(d, 'user')).contentHash).not.toBe(before);
    writeFileSync(join(d, 'references/a.md'), 'changed\n');
    expect((await loadSkillDir(d, 'user')).contentHash).not.toBe(before);
  });

  it('delivers a link to a file inside the skill as a copy and ignores .git', async () => {
    const d = skill(root, 'linked', md('linked'), { 'a.txt': 'A\n', '.git/HEAD': 'ref\n' });
    symlinkSync('a.txt', join(d, 'b.txt'));
    const s = await loadSkillDir(d, 'user');
    expect(s.files.map((f) => f.path)).toEqual(['SKILL.md', 'a.txt', 'b.txt']);
    expect(s.contents.get('b.txt')!.toString()).toBe('A\n');
  });

  it('refuses links that leave the folder, links to folders and odd names', async () => {
    writeFileSync(join(root, 'secret.txt'), 'nope');
    const d = skill(root, 'escape', md('escape'), { 'sub/x.txt': 'x' });
    symlinkSync(join(root, 'secret.txt'), join(d, 'out.txt'));
    symlinkSync('sub', join(d, 'dirlink'));
    writeFileSync(join(d, 'with space.txt'), 'x');
    const issues = await invalid(loadSkillDir(d, 'project'));
    expect(issues.map((i) => `${i.path}: ${i.message}`)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^out\.txt: symbolic link points outside the skill folder/),
        expect.stringMatching(/^dirlink: symbolic link to a folder/),
        expect.stringMatching(/^with space\.txt: file and folder names/),
      ]),
    );
  });

  it('limits the number of files and the size', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_SKILL_FILES; i++) many[`f${i}.txt`] = 'x';
    const d = skill(root, 'many', md('many'), many);
    expect((await invalid(loadSkillDir(d, 'user')))[0]!.message).toMatch(/at most 100 files/);
    const big = skill(root, 'big', md('big'), { 'blob.bin': 'x'.repeat(1024 * 1024) });
    expect((await invalid(loadSkillDir(big, 'user')))[0]!.message).toMatch(/larger than 1024 KiB/);
  });

  it('needs a SKILL.md and a valid folder name', async () => {
    mkdirSync(join(root, 'empty'));
    expect((await invalid(loadSkillDir(join(root, 'empty'), 'user')))[0]).toMatchObject({
      path: 'SKILL.md',
      message: 'the skill folder has no SKILL.md',
    });
    const d = skill(root, 'Up', md('Up'));
    expect((await invalid(loadSkillDir(d, 'user'))).map((i) => i.message)).toContainEqual(
      expect.stringMatching(/folder name "Up" is not a valid skill name/),
    );
  });
});

describe('SkillCatalog', () => {
  it('ships valid builtin skills', async () => {
    const cat = new SkillCatalog();
    const { skills, problems } = await cat.listAll();
    expect(problems).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(['minimal-change', 'run-tests', 'work-in-sandbox']);
    for (const s of skills) {
      expect(s.source).toEqual({ kind: 'builtin', path: join(builtinSkillsDir, s.name) });
      expect(s.description.length).toBeGreaterThan(40);
    }
  });

  it('resolves project > user > builtin and reports what a winner shadows', async () => {
    const project = join(root, 'proj');
    const user = join(root, 'user');
    const builtin = join(root, 'builtin');
    skill(builtin, 'shared', md('shared', 'The builtin version of the shared skill.'));
    skill(builtin, 'only-builtin');
    skill(user, 'shared', md('shared', 'The user version of the shared skill.'));
    skill(
      join(project, '.sandbox', 'skills'),
      'shared',
      md('shared', 'The project version of the shared skill.'),
    );
    const cat = new SkillCatalog({ projectDir: project, userDir: user, builtinDir: builtin });
    const list = await cat.list();
    expect(list.map((s) => [s.name, s.source.kind, s.shadows.map((x) => x.kind)])).toEqual([
      ['only-builtin', 'builtin', []],
      ['shared', 'project', ['user', 'builtin']],
    ]);
    expect((await cat.get('shared')).description).toMatch(/project version/);
    expect(await cat.getShadowed('shared')).toHaveLength(2);
    await expect(cat.get('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a broken folder that outranks a valid skill is reported, never skipped', async () => {
    const user = join(root, 'user');
    const builtin = join(root, 'builtin');
    skill(builtin, 'tool');
    skill(user, 'tool', '---\nname: tool\n---\nbody\n');
    const cat = new SkillCatalog({ userDir: user, builtinDir: builtin });
    const { skills, problems } = await cat.listAll();
    expect(problems.map((p) => [p.kind, p.name, p.error.code])).toEqual([
      ['user', 'tool', 'skill_invalid'],
    ]);
    expect(skills.map((s) => s.source.kind)).toEqual(['builtin']);
    await expect(cat.get('tool')).rejects.toMatchObject({ code: 'skill_invalid' });
  });

  it('never follows a symlinked skill folder (it is listed as a problem)', async () => {
    const outside = skill(root, 'elsewhere');
    const project = join(root, 'proj');
    mkdirSync(join(project, '.sandbox', 'skills'), { recursive: true });
    symlinkSync(outside, join(project, '.sandbox', 'skills', 'elsewhere'));
    const cat = new SkillCatalog({ projectDir: project, builtinDir: join(root, 'none') });
    const { skills, problems } = await cat.listAll();
    expect(skills).toEqual([]);
    expect(problems[0]!.error.issues[0]!.message).toMatch(/symbolic link; copy the folder instead/);
  });
});

describe('delivery into the sandbox', () => {
  const fake = (name: string, files: Array<[string, string, boolean]>): ResolvedSkill => ({
    name,
    description: `The ${name} skill.\nSecond line.`,
    frontMatter: {},
    body: 'x',
    source: { kind: 'builtin', path: `/b/${name}` },
    files: files.map(([path, content, executable]) => ({ path, size: content.length, executable })),
    totalBytes: files.reduce((n, f) => n + f[1].length, 0),
    contentHash: 'h',
    contents: new Map(files.map(([p, c]) => [p, Buffer.from(c)])),
  });

  it('places read-only files below /skills with an index', () => {
    const files = skillSpecFiles([
      fake('one', [
        ['SKILL.md', 'a', false],
        ['scripts/x.sh', 'b', true],
      ]),
      fake('two', [['SKILL.md', 'c', false]]),
    ]);
    expect(files.map((f) => [f.sandboxPath, f.mode.toString(8), f.readonly])).toEqual([
      [`${SKILLS_DIR}/one/SKILL.md`, '444', true],
      [`${SKILLS_DIR}/one/scripts/x.sh`, '555', true],
      [`${SKILLS_DIR}/two/SKILL.md`, '444', true],
      [`${SKILLS_DIR}/INDEX.md`, '444', true],
    ]);
    const index = files.at(-1)!.content.toString();
    expect(index).toContain(
      '## one\n\n- path: one/SKILL.md\n- description: The one skill. Second line.',
    );
    expect(index).toContain('ABOX_SKILLS_DIR');
    expect(skillSpecFiles([])).toEqual([]);
  });

  it('limits the number of skills per sandbox', () => {
    const many = Array.from({ length: MAX_SANDBOX_SKILLS + 1 }, (_, i) =>
      fake(`s${i}`, [['SKILL.md', 'a', false]]),
    );
    expect(() => skillSpecFiles(many)).toThrow(/at most 32 skills/);
  });

  it('renders an index with one section per skill', () => {
    expect(renderSkillsIndex([{ name: 'a', description: 'Alpha.' }])).toMatch(/^# Skills\n/);
  });
});
