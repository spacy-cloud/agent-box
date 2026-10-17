/**
 * Export of a `copy` workspace whose project already contains absolute symlinks (Docker backend,
 * through the real manager): the export works in every format, the links stay links in diff/patch,
 * and nothing in an export directory ever points outside it.
 */
import { lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A,
  DOCKER,
  HUMAN,
  makeEnv,
  openAbox,
  sh,
  sweepE2E,
  type Ctx,
  type Env,
} from './harness.js';

/** All entries below `dir` that are symlinks. */
function linksBelow(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.push(p);
    else if (st.isDirectory()) out.push(...linksBelow(p));
  }
  return out;
}

describe.skipIf(!DOCKER)('export of a copy workspace with absolute symlinks (docker)', () => {
  let env: Env;
  let ctx: Ctx;

  beforeAll(async () => {
    env = makeEnv();
    // the project already had absolute links, one to a directory outside the project
    const secret = join(env.root, 'secretdir');
    mkdirSync(secret);
    writeFileSync(join(secret, 'token'), 'never-exported\n');
    symlinkSync(secret, join(env.app, 'link-dir'));
    symlinkSync('/etc/hostname', join(env.app, 'conf-link'));
    ctx = await openAbox(env);
    await ctx.abox.buildTemplate(HUMAN, 'alpine-min');
  }, 300_000);

  afterAll(async () => {
    await ctx?.close();
    await sweepE2E();
    env?.cleanup();
  }, 120_000);

  it('unchanged links are no change; agent-made links are symlink entries, flagged, and never written by files', async () => {
    const c = await ctx.create(A, {
      template: 'alpine-min',
      workspace: { mode: 'copy', path: env.app },
    });
    const id = c.sandbox.id;
    try {
      // 1. nothing changed yet: the pre-existing absolute links must not make the export fail
      const none = await ctx.abox.exportSandbox(A, id, { format: 'diff' });
      expect(none.files).toEqual([]);
      expect(none.content).toBe('');

      // 2. the agent edits a file, retargets one link and plants a new absolute one
      await sh(
        ctx,
        A,
        id,
        'echo changed > /workspace/README.md; rm /workspace/conf-link; ln -s /etc/shadow /workspace/conf-link; ln -s /root/.ssh /workspace/src/planted',
      );
      const diff = await ctx.abox.exportSandbox(A, id, { format: 'diff' });
      const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
      expect(Object.keys(byPath).sort()).toEqual(['README.md', 'conf-link', 'src/planted']);
      expect(byPath['conf-link']).toMatchObject({ kind: 'symlink', symlinkTarget: '/etc/shadow' });
      expect(byPath['src/planted']).toMatchObject({ status: 'added', kind: 'symlink' });
      expect(diff.content).toContain('new file mode 120000');
      for (const p of ['conf-link', 'src/planted'])
        expect(
          diff.flagged.some((f) => f.path === p && /outside the workspace/.test(f.reason)),
        ).toBe(true);
      const patch = await ctx.abox.exportSandbox(A, id, { format: 'patch' });
      expect(patch.content).toContain('120000');

      // 3. files: regular files only, no link of any kind in the export directory
      const files = await ctx.abox.exportSandbox(A, id, { format: 'files' });
      expect(files.outDir).toBeDefined();
      expect(readdirSync(files.outDir!)).toEqual(['README.md']);
      expect(linksBelow(files.outDir!)).toEqual([]);
      expect(
        files.flagged.some((f) => f.path === 'src/planted' && /not written/.test(f.reason)),
      ).toBe(true);
    } finally {
      await ctx.abox.removeSandbox(HUMAN, id).catch(() => undefined);
      const i = ctx.created.indexOf(id);
      if (i >= 0) ctx.created.splice(i, 1);
    }
  }, 180_000);
});
