import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN, makeEnv, runBin, type TestEnv } from './harness.js';

/**
 * Skills through the real CLI against a real Docker engine (ABOX_TEST_DOCKER=1): a sandbox created
 * with `--skill` has `/skills/INDEX.md` and the skill files, owned by root and read-only for the
 * sandbox user, and `ABOX_SKILLS_DIR` in its environment; the same with a read-only root file
 * system (the skills directory is a volume of its own there). Everything lives below a private
 * ABOX_HOME and is removed again.
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const RO_TEMPLATE = `apiVersion: 1
name: ro-skills
description: alpine-min with a read-only root file system and a skill (Docker skill tests).
backend: docker
extends: alpine-min
labels: { readonly-rootfs: "true" }
skills: [run-tests]
`;

describe.runIf(DOCKER)('skills in a Docker sandbox', () => {
  let t: TestEnv;
  const created: string[] = [];

  const create = async (name: string, ...args: string[]): Promise<void> => {
    const r = await runBin(t, ['create', ...args, '--name', name, '--yes', '--json'], {
      timeoutMs: 300_000,
    });
    expect(r.code, r.stderr).toBe(0);
    created.push(name);
  };
  const sh = async (name: string, script: string): Promise<{ code: number; out: string }> => {
    const r = await runBin(t, ['exec', name, '--', 'sh', '-c', script]);
    return { code: r.code, out: r.stdout };
  };
  /** Owner uid and octal mode of each path, one `uid mode path` line per path. */
  const owners = async (name: string, paths: string[]): Promise<string[]> => {
    const r = await sh(name, `stat -c '%u %a %n' ${paths.join(' ')}`);
    expect(r.code).toBe(0);
    return r.out.trim().split('\n');
  };
  const expectReadOnly = async (name: string): Promise<void> => {
    for (const attempt of [
      'echo changed > /skills/run-tests/SKILL.md',
      'touch /skills/run-tests/new.txt',
      'touch /skills/new.txt',
      'rm -f /skills/INDEX.md',
      'chmod u+w /skills/INDEX.md',
      'mv /skills/run-tests /skills/moved',
    ]) {
      expect((await sh(name, `${attempt} 2>/dev/null`)).code, attempt).not.toBe(0);
    }
  };

  beforeAll(async () => {
    execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(BIN)).toBe(true);
    t = makeEnv();
    const dir = join(t.aboxHome, 'config', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ro-skills.yaml'), RO_TEMPLATE);
    const built = await runBin(t, ['template', 'build', 'alpine-min', '--json'], {
      timeoutMs: 600_000,
    });
    expect(built.code, built.stderr).toBe(0);
  }, 660_000);

  afterAll(async () => {
    for (const id of created) await runBin(t, ['rm', '--force', id]).catch(() => undefined);
    t.cleanup();
  }, 120_000);

  it('a sandbox created with --skill has the index and read-only skill files', async () => {
    await create('skills-a', 'alpine-min', '--skill', 'run-tests', '--skill', 'minimal-change');
    expect((await sh('skills-a', 'echo "$ABOX_SKILLS_DIR"')).out.trim()).toBe('/skills');
    const index = await sh('skills-a', 'cat /skills/INDEX.md');
    expect(index.code).toBe(0);
    expect(index.out).toContain('## run-tests');
    expect(index.out).toContain('- path: minimal-change/SKILL.md');
    expect(
      await owners('skills-a', [
        '/skills',
        '/skills/run-tests',
        '/skills/INDEX.md',
        '/skills/run-tests/SKILL.md',
      ]),
    ).toEqual([
      '0 755 /skills',
      '0 755 /skills/run-tests',
      '0 444 /skills/INDEX.md',
      '0 444 /skills/run-tests/SKILL.md',
    ]);
    // the sandbox user is not root and cannot change, add or remove anything
    expect((await sh('skills-a', 'id -u')).out.trim()).not.toBe('0');
    await expectReadOnly('skills-a');
    // the file API of an agent cannot write there either
    const w = await runBin(t, [
      'cp',
      join(t.project, 'hello.txt'),
      'skills-a:/skills/run-tests/x.txt',
    ]);
    expect(w.code).not.toBe(0);
    const insp = await runBin(t, ['inspect', 'skills-a', '--json']);
    expect(insp.json.data.skills.map((s: { name: string }) => s.name)).toEqual([
      'run-tests',
      'minimal-change',
    ]);
  });

  it('works on a read-only root file system (the template skills come on their own)', async () => {
    await create('skills-ro', 'ro-skills');
    expect((await sh('skills-ro', 'touch /etc/x 2>/dev/null')).code).not.toBe(0);
    expect(await owners('skills-ro', ['/skills', '/skills/run-tests/SKILL.md'])).toEqual([
      '0 755 /skills',
      '0 444 /skills/run-tests/SKILL.md',
    ]);
    expect((await sh('skills-ro', 'cat /skills/INDEX.md')).out).toContain('## run-tests');
    await expectReadOnly('skills-ro');
  });
});
