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
  it('awkward names planted by the sandbox do not block the export: a backslash name is left out and flagged, link chains and hardlinks are just entries', async () => {
    const c = await ctx.create(A, {
      template: 'alpine-min',
      workspace: { mode: 'copy', path: env.app },
    });
    const id = c.sandbox.id;
    try {
      await sh(
        ctx,
        A,
        id,
        [
          "printf bad > '/workspace/we\\ird.txt'",
          "mkdir -p '/workspace/d\\ir' && printf bad > '/workspace/d\\ir/inner'",
          'echo ok > /workspace/ok.txt',
          // d/sub -> .., s -> d/sub, t -> s/..: leads out of the workspace only through the chain
          'mkdir -p /workspace/d && ln -s .. /workspace/d/sub && ln -s d/sub /workspace/s && ln -s s/.. /workspace/t',
          // one file, many names
          'head -c 1000000 /dev/zero > /workspace/big && for i in 1 2 3 4 5; do ln /workspace/big /workspace/big$i; done',
        ].join(' && '),
      );
      const diff = await ctx.abox.exportSandbox(A, id, { format: 'diff' });
      const paths = diff.files.map((f) => f.path).sort();
      expect(paths).toEqual(
        ['big', 'big1', 'big2', 'big3', 'big4', 'big5', 'd/sub', 'ok.txt', 's', 't'].sort(),
      );
      for (const p of ['we\\ird.txt', 'd\\ir', 'd\\ir/inner']) {
        expect(
          diff.flagged.some((f) => f.path === p && /backslash/.test(f.reason)),
          p,
        ).toBe(true);
        expect(diff.stats.skipped.some((x) => x.path === p)).toBe(true);
      }
      // the other formats work, too, and nothing with such a name or a link is written to the host
      const files = await ctx.abox.exportSandbox(A, id, { format: 'files' });
      expect(readdirSync(files.outDir!).sort()).toEqual(
        ['big', 'big1', 'big2', 'big3', 'big4', 'big5', 'ok.txt'].sort(),
      );
      expect(linksBelow(files.outDir!)).toEqual([]);
      // `abox cp` of the tree is a copy for the user and stays strict: it refuses the backslash names
      const copy = join(env.root, 'cp-out');
      await expect(ctx.abox.copyOut(HUMAN, id, '/workspace', copy)).rejects.toMatchObject({
        code: 'policy_denied',
      });
      // ... and the link chain on its own, too
      await sh(ctx, A, id, "rm -rf '/workspace/we\\ird.txt' '/workspace/d\\ir'");
      const copy2 = join(env.root, 'cp-out2');
      await expect(ctx.abox.copyOut(HUMAN, id, '/workspace', copy2)).rejects.toMatchObject({
        code: 'policy_denied',
      });
      for (const l of linksBelow(copy2)) {
        // (whatever was extracted before the chain was found never points outside the copy)
        expect(l.startsWith(copy2)).toBe(true);
      }
    } finally {
      await ctx.abox.removeSandbox(HUMAN, id).catch(() => undefined);
      const i = ctx.created.indexOf(id);
      if (i >= 0) ctx.created.splice(i, 1);
    }
  }, 180_000);
});
