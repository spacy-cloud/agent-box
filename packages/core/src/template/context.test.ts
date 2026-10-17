import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TemplateCatalog } from './catalog.js';
import {
  MAX_DOCKERFILE_BYTES,
  buildContextOf,
  collectBuildContext,
  dockerfilePathOf,
} from './context.js';

let root: string;
let project: string;
let ctx: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'abox-context-'));
  project = join(root, 'project');
  ctx = join(project, '.sandbox');
  await mkdir(ctx, { recursive: true });
  await writeFile(join(ctx, 'Dockerfile'), 'FROM alpine:3.22\nCOPY seed.sh /seed.sh\n');
  await writeFile(join(ctx, 'seed.sh'), 'echo seed\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const digest = async (): Promise<string> =>
  (await collectBuildContext(join(ctx, 'Dockerfile'))).digest;

describe('collectBuildContext', () => {
  it('describes the Dockerfile and lists the files of the context with sizes', async () => {
    const c = await collectBuildContext(join(ctx, 'Dockerfile'));
    expect(c.dir).toBe(ctx);
    expect(c.dockerfile).toBe('Dockerfile');
    expect(c.dockerfileText).toBe('FROM alpine:3.22\nCOPY seed.sh /seed.sh\n');
    expect(c.files.map((f) => [f.path, f.size])).toEqual([
      ['Dockerfile', 39],
      ['seed.sh', 10],
    ]);
    expect(c.fileCount).toBe(2);
    expect(c.totalBytes).toBe(49);
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest()).toBe(c.digest); // stable
  });

  it('changes with the Dockerfile, a file it can COPY, a new file, a mode, a rename and a symlink', async () => {
    const seen = new Set([await digest()]);
    const step = async (change: () => Promise<void>): Promise<void> => {
      await change();
      const d = await digest();
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    };
    await step(() => writeFile(join(ctx, 'Dockerfile'), 'FROM alpine:3.22\nRUN echo EVIL\n'));
    await step(() => writeFile(join(ctx, 'seed.sh'), 'echo changed\n'));
    await step(() => writeFile(join(ctx, 'extra.txt'), 'new\n'));
    await step(() => chmod(join(ctx, 'seed.sh'), 0o755));
    await mkdir(join(ctx, 'sub'));
    await step(() => writeFile(join(ctx, 'sub', 'deep.txt'), 'deep\n'));
    await step(() => symlink('/etc/passwd', join(ctx, 'link')));
    await step(async () => {
      await rm(join(ctx, 'link'));
      await symlink('/etc/shadow', join(ctx, 'link'));
    });
  });

  it('does not follow symlinks and ignores sockets', async () => {
    await writeFile(join(root, 'secret.txt'), 'outside\n');
    await symlink(join(root, 'secret.txt'), join(ctx, 'leak'));
    const before = await collectBuildContext(join(ctx, 'Dockerfile'));
    expect(before.files.find((f) => f.path === 'leak')).toMatchObject({
      type: 'symlink',
      target: join(root, 'secret.txt'),
    });
    await writeFile(join(root, 'secret.txt'), 'outside, changed\n');
    expect((await digest()) === before.digest).toBe(true); // content behind the link is not part of it

    const sock = join(ctx, 's.sock');
    const server = createServer();
    await new Promise<void>((res) => server.listen(sock, res));
    try {
      expect(await digest()).toBe(before.digest);
    } finally {
      await new Promise((res) => server.close(res));
    }
  });

  it('refuses a missing, symlinked or oversized Dockerfile and a symlinked context', async () => {
    await expect(collectBuildContext(join(ctx, 'Missing'))).rejects.toMatchObject({
      code: 'template_invalid',
    });
    await symlink(join(ctx, 'seed.sh'), join(ctx, 'Linked'));
    await expect(collectBuildContext(join(ctx, 'Linked'))).rejects.toMatchObject({
      code: 'template_invalid',
    });
    await writeFile(join(ctx, 'Big'), 'x'.repeat(MAX_DOCKERFILE_BYTES + 1));
    await expect(collectBuildContext(join(ctx, 'Big'))).rejects.toMatchObject({
      code: 'template_invalid',
    });
    await symlink(ctx, join(project, 'ctxlink'));
    await expect(collectBuildContext(join(project, 'ctxlink', 'Dockerfile'))).rejects.toMatchObject(
      { code: 'template_invalid' },
    );
  });
});

describe('buildContextOf', () => {
  const source = (kind: 'project' | 'user' | 'builtin', path = join(ctx, 'x.yaml')) => ({
    kind,
    path,
  });

  it('resolves the Dockerfile relative to the template file', async () => {
    expect(dockerfilePathOf('./Dockerfile', '/a/b/x.yaml')).toBe('/a/b/Dockerfile');
    expect(dockerfilePathOf('Dockerfile', undefined)).toBeUndefined();
    const c = await buildContextOf('./Dockerfile', source('project'));
    expect(c.dir).toBe(ctx);
  });

  it('keeps a project template inside its project, user templates may use any directory', async () => {
    const other = join(root, 'other');
    await mkdir(other);
    await writeFile(join(other, 'Dockerfile'), 'FROM alpine:3.22\n');
    await expect(buildContextOf('../../other/Dockerfile', source('project'))).rejects.toMatchObject(
      { code: 'template_invalid' },
    );
    expect((await buildContextOf('../../other/Dockerfile', source('user'))).dir).toBe(other);
    // the project root is fine
    await writeFile(join(project, 'Dockerfile'), 'FROM alpine:3.22\n');
    expect((await buildContextOf('../Dockerfile', source('project'))).dir).toBe(project);
  });
});

describe('catalog: hashes cover the Dockerfile and its context', () => {
  const yaml = (name: string, extra = ''): string =>
    `apiVersion: 1\nname: ${name}\ndescription: Template ${name} with its own Dockerfile\nbackend: docker\nbase:\n  dockerfile: ./Dockerfile\n${extra}`;

  it('contentHash and hash change when the Dockerfile or a copied file changes', async () => {
    await writeFile(join(ctx, 'df.yaml'), yaml('df'));
    const catalog = new TemplateCatalog({ projectDir: project });
    const a = await catalog.get('df');
    expect(a.buildContext?.dockerfileText).toContain('COPY seed.sh');
    expect(a.source.kind).toBe('project');

    await writeFile(join(ctx, 'Dockerfile'), 'FROM alpine:3.22\nRUN echo EVIL2 > /etc/marker\n');
    const b = await catalog.get('df');
    expect(b.contentHash).not.toBe(a.contentHash);
    expect(b.hash).not.toBe(a.hash);

    await writeFile(join(ctx, 'seed.sh'), 'echo evil\n');
    const c = await catalog.get('df');
    expect(c.contentHash).not.toBe(b.contentHash);
    expect(c.hash).not.toBe(b.hash);
    expect((await catalog.get('df')).contentHash).toBe(c.contentHash); // deterministic
  });

  it('a template without a Dockerfile keeps the plain hash of its file', async () => {
    const text = `apiVersion: 1\nname: plain\ndescription: Plain template\nbackend: docker\nbase: { os: alpine:3.22 }\n`;
    await writeFile(join(ctx, 'plain.yaml'), text);
    const t = await new TemplateCatalog({ projectDir: project }).get('plain');
    const { createHash } = await import('node:crypto');
    expect(t.contentHash).toBe(createHash('sha256').update(text).digest('hex'));
    expect(t.buildContext).toBeUndefined();
  });

  it('a missing Dockerfile is a template_invalid error', async () => {
    await writeFile(join(ctx, 'df.yaml'), yaml('df').replace('./Dockerfile', './Nope'));
    await expect(new TemplateCatalog({ projectDir: project }).get('df')).rejects.toMatchObject({
      code: 'template_invalid',
    });
  });

  it('the contentHash of a project template covers the project template it extends', async () => {
    const parent = `apiVersion: 1\nname: parent\ndescription: Parent template for the extends test\nbackend: docker\nbase: { os: alpine:3.22 }\n`;
    await writeFile(join(ctx, 'parent.yaml'), parent);
    await writeFile(
      join(ctx, 'child.yaml'),
      `apiVersion: 1\nname: child\ndescription: Child template for the extends test\nbackend: docker\nextends: parent\n`,
    );
    const catalog = new TemplateCatalog({ projectDir: project });
    const before = await catalog.get('child');
    await writeFile(join(ctx, 'parent.yaml'), `${parent}network: { mode: open }\n`);
    const after = await catalog.get('child');
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.network.mode).toBe('open');
  });
});
