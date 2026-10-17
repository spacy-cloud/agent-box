import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AboxError, type SandboxProvider } from '@abox/core';
import { makeTestSpec, makeTestTemplate } from '@abox/contract-tests';
import { confine, createProcessProvider, normalizeSandboxPath } from './index.js';

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AboxError) return e.code;
    throw e;
  }
  return 'ok';
}

describe('normalizeSandboxPath', () => {
  it('normalizes absolute and relative paths', () => {
    expect(normalizeSandboxPath('/a/b/../c')).toBe('/a/c');
    expect(normalizeSandboxPath('/a//b/./c/')).toBe('/a/b/c');
    expect(normalizeSandboxPath('x/y', '/workspace')).toBe('/workspace/x/y');
    expect(normalizeSandboxPath('../tmp', '/workspace')).toBe('/tmp');
    expect(normalizeSandboxPath('/')).toBe('/');
  });

  it('rejects ".." that climbs above the root', () => {
    expect(() => normalizeSandboxPath('/..')).toThrow(/escapes/);
    expect(() => normalizeSandboxPath('/workspace/../../etc/passwd')).toThrow(/escapes/);
    expect(() => normalizeSandboxPath('../../x', '/workspace')).toThrow(/escapes/);
    expect(() => normalizeSandboxPath('a/../../..')).toThrow(AboxError);
  });

  it('rejects empty paths and NUL bytes', () => {
    expect(() => normalizeSandboxPath('')).toThrow(AboxError);
    expect(() => normalizeSandboxPath('/a\0b')).toThrow(/NUL/);
  });
});

describe('confine / file API confinement', () => {
  let tmpRoot: string;
  let outside: string;
  let root: string;
  let provider: SandboxProvider;
  let id: string;
  let sandboxRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'abox-process-paths-'));
    outside = join(tmpRoot, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'host-secret');
    root = join(tmpRoot, 'data');
    provider = createProcessProvider({ host: 'local', kind: 'local' }, { dataDir: root });
    const template = makeTestTemplate();
    const spec = await makeTestSpec(provider, template, {
      network: {
        mode: 'open',
        allow: [],
        blockPrivate: true,
        privateExceptions: [],
        injections: [],
      },
    });
    id = spec.id;
    const info = await provider.create(spec);
    await provider.start(id);
    sandboxRoot = join(info.backendRef, 'root');
    // plant escape routes the way a hostile process inside the sandbox could
    await symlink(join(outside, 'secret.txt'), join(sandboxRoot, 'workspace', 'abs-file'));
    await symlink(outside, join(sandboxRoot, 'workspace', 'abs-dir'));
    await symlink(
      relative(join(sandboxRoot, 'workspace'), join(outside, 'secret.txt')),
      join(sandboxRoot, 'workspace', 'rel-file'),
    );
    await symlink(join(tmpRoot, 'does-not-exist-yet'), join(sandboxRoot, 'workspace', 'dangling'));
    await symlink('inside.txt', join(sandboxRoot, 'workspace', 'inner-link'));
    await writeFile(join(sandboxRoot, 'workspace', 'inside.txt'), 'inside');
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('readFile rejects ".." escapes and absolute-looking host paths stay inside the root', async () => {
    expect(await codeOf(provider.readFile(id, '/workspace/../../etc/passwd', 100))).toBe(
      'invalid_input',
    );
    expect(await codeOf(provider.readFile(id, '../../../../etc/passwd', 100))).toBe(
      'invalid_input',
    );
    // A host path is just a path in the sandbox: it does not exist there.
    expect(await codeOf(provider.readFile(id, join(outside, 'secret.txt'), 100))).toBe('not_found');
  });

  it('readFile rejects symlinks pointing outside the root (absolute, relative, directory)', async () => {
    expect(await codeOf(provider.readFile(id, '/workspace/abs-file', 100))).toBe('invalid_input');
    expect(await codeOf(provider.readFile(id, '/workspace/rel-file', 100))).toBe('invalid_input');
    expect(await codeOf(provider.readFile(id, '/workspace/abs-dir/secret.txt', 100))).toBe(
      'invalid_input',
    );
    expect(await codeOf(provider.listDir(id, '/workspace/abs-dir'))).toBe('invalid_input');
  });

  it('writeFile never writes through an outside symlink, dangling or not', async () => {
    expect(await codeOf(provider.writeFile(id, '/workspace/abs-file', Buffer.from('pwned')))).toBe(
      'invalid_input',
    );
    expect(
      await codeOf(provider.writeFile(id, '/workspace/abs-dir/new.txt', Buffer.from('pwned'))),
    ).toBe('invalid_input');
    expect(await codeOf(provider.writeFile(id, '/workspace/dangling', Buffer.from('pwned')))).toBe(
      'invalid_input',
    );
    expect(
      await codeOf(provider.writeFile(id, '/workspace/dangling/sub/f', Buffer.from('pwned'))),
    ).toBe('invalid_input');
    expect((await readFile(join(outside, 'secret.txt'))).toString()).toBe('host-secret');
    await expect(readFile(join(tmpRoot, 'does-not-exist-yet'))).rejects.toThrow();
  });

  it('copyIn/copyOut cannot be steered outside via symlinks', async () => {
    const dest = join(tmpRoot, 'copied-out');
    expect(await codeOf(provider.copyOut(id, '/workspace/abs-dir', dest))).toBe('invalid_input');
    expect(
      await codeOf(
        provider.copyIn(id, join(outside, 'secret.txt'), '/workspace/abs-dir/dropped.txt'),
      ),
    ).toBe('invalid_input');
    await expect(readFile(join(outside, 'dropped.txt'))).rejects.toThrow();
  });

  it('symlinks that stay inside the root work', async () => {
    expect((await provider.readFile(id, '/workspace/inner-link', 100)).data.toString()).toBe(
      'inside',
    );
    await provider.writeFile(id, '/workspace/inner-link', Buffer.from('rewritten'));
    expect((await provider.readFile(id, '/workspace/inside.txt', 100)).data.toString()).toBe(
      'rewritten',
    );
  });

  it('a symlink is reported as a symlink by listDir, not followed', async () => {
    const entries = await provider.listDir(id, '/workspace');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.type]));
    expect(byName['abs-file']).toBe('symlink');
    expect(byName['abs-dir']).toBe('symlink');
    expect(byName['inside.txt']).toBe('file');
  });

  it('confine: ".." that stays inside is fine and resolves to the real path', async () => {
    const c = await confine(
      sandboxRoot,
      '/workspace/../workspace/inside.txt',
      '/workspace',
      'existing',
    );
    expect(c.sandboxPath).toBe('/workspace/inside.txt');
    expect(c.hostPath.endsWith('/root/workspace/inside.txt')).toBe(true);
  });

  it('confine create: missing parents resolve below the deepest existing ancestor', async () => {
    const c = await confine(sandboxRoot, '/workspace/new/deep/file.txt', '/workspace', 'create');
    expect(c.hostPath.endsWith('/root/workspace/new/deep/file.txt')).toBe(true);
  });

  it('confine: a file used as a directory is invalid_input', async () => {
    expect(
      await codeOf(confine(sandboxRoot, '/workspace/inside.txt/x', '/workspace', 'create')),
    ).toBe('invalid_input');
    expect(
      await codeOf(confine(sandboxRoot, '/workspace/inside.txt/x', '/workspace', 'existing')),
    ).toBe('invalid_input');
  });

  it('writeFile outside the workspace but inside the root works and writes below root/', async () => {
    await provider.writeFile(id, '/var/lib/ct/data.txt', Buffer.from('deep'));
    expect((await readFile(join(sandboxRoot, 'var', 'lib', 'ct', 'data.txt'))).toString()).toBe(
      'deep',
    );
  });
});
