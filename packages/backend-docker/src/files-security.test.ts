import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedImage, ResolvedTemplate, SandboxSpec } from '@abox/core';
import { type DockerProvider } from './index.js';
import { makeSpec, makeTemplate } from './__tests__/helpers.js';
import { dockerEnabled, newProvider, sweepTestObjects, Tracker } from './__tests__/harness.js';

/**
 * The sandbox file APIs act with the identity of the sandbox user: they can never modify
 * root-owned files (the proxy CA, the deadline, /etc), follow a symlink planted by the sandbox out
 * of what the user may write, or write into kernel interfaces.
 */
describe.skipIf(!dockerEnabled)('sandbox file APIs act as the sandbox user (real docker)', () => {
  const provider: DockerProvider = newProvider();
  const track = new Tracker(provider);
  const template: ResolvedTemplate = makeTemplate({ name: 'abox-test-files' });
  let prepared: PreparedImage;
  let tmp: string;

  /** A started sandbox whose deadline was moved, so the root-owned deadline file exists. */
  const sb = async (start = true): Promise<SandboxSpec> => {
    const now = Date.now();
    const s = await track.create(
      makeSpec(template, prepared.ref, { createdAt: now, expiresAt: now + 10 * 60_000 }),
      start,
    );
    if (start) await provider.extendExpiry!(s.id, now + 20 * 60_000);
    return s;
  };
  const run = (s: SandboxSpec, command: string) => provider.exec(s.id, { command });

  const EXPIRES = '/usr/local/share/abox/expires';
  const CA = '/usr/local/share/abox/ca.crt';
  const denied = { code: 'policy_denied' };

  beforeAll(async () => {
    await sweepTestObjects();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'abox-ftest-'));
    await provider.init();
    prepared = await provider.prepare(template);
  }, 300_000);

  afterAll(async () => {
    await track.cleanup();
    await sweepTestObjects();
    await fs.rm(tmp, { recursive: true, force: true });
  }, 120_000);

  it('normal writes still work and belong to the sandbox user (workspace and /tmp)', async () => {
    const s = await sb();
    await provider.writeFile(s.id, '/workspace/a/b/c.txt', Buffer.from('hi'), 0o640);
    await provider.writeFile(s.id, '/tmp/t/x.txt', Buffer.from('tmp'), 0o600);
    expect((await run(s, 'stat -c "%U %a" /workspace/a/b/c.txt /tmp/t/x.txt')).stdout).toBe(
      'dev 640\ndev 600\n',
    );
    expect((await run(s, 'stat -c "%U %a" /workspace/a /workspace/a/b /tmp/t')).stdout).toBe(
      'dev 755\ndev 755\ndev 755\n',
    );
    // overwrite and mode change
    await provider.writeFile(s.id, '/workspace/a/b/c.txt', Buffer.from('new!'), 0o644);
    expect(
      (await run(s, 'cat /workspace/a/b/c.txt; stat -c " %a" /workspace/a/b/c.txt')).stdout,
    ).toBe('new! 644\n');
    // binary content survives
    const bin = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
    await provider.writeFile(s.id, '/workspace/bin', bin);
    expect((await provider.readFile(s.id, '/workspace/bin', 100)).data.equals(bin)).toBe(true);
    // copyIn
    const src = path.join(tmp, 'src');
    await fs.mkdir(path.join(src, 'd'), { recursive: true });
    await fs.writeFile(path.join(src, 'd', 'f.txt'), 'copied');
    await provider.copyIn(s.id, src, '/workspace/in');
    await provider.copyIn(s.id, path.join(src, 'd', 'f.txt'), '/tmp/single.txt');
    expect(
      (
        await run(
          s,
          'cat /workspace/in/d/f.txt /tmp/single.txt; stat -c " %U" /workspace/in/d/f.txt /tmp/single.txt',
        )
      ).stdout,
    ).toBe('copiedcopied dev\n dev\n');
  });

  it('refuses /proc, /sys and /dev paths, also spelled as /proc/self/root/...', async () => {
    const s = await sb();
    const forged = Buffer.from('9999999999\n');
    for (const p of [
      `/proc/self/root${EXPIRES}`,
      `/proc/1/root${CA}`,
      '/proc/self/environ',
      '/proc/sys/kernel/hostname',
      '/sys/kernel/x',
      '/dev/shm/x',
      '/dev/null',
    ]) {
      await expect(provider.writeFile(s.id, p, forged), p).rejects.toMatchObject(denied);
    }
    const src = path.join(tmp, 'p-src');
    await fs.writeFile(src, 'x');
    await expect(provider.copyIn(s.id, src, '/proc/self/root/tmp/x')).rejects.toMatchObject(denied);
    // the deadline and the CA are untouched
    expect((await run(s, `ls -l ${EXPIRES} ${CA} 2>&1 | wc -l`)).stdout.trim()).not.toBe('0');
    expect(
      (
        await run(s, `find /usr/local/share/abox -newer /etc/abox-marker -user dev | wc -l`)
      ).stdout.trim(),
    ).toBe('0');
  });

  it('a symlink planted in the workspace does not lead the write into abox-internal paths', async () => {
    const s = await sb();
    await run(s, 'ln -s /usr/local/share/abox /workspace/sl; ln -s /etc /workspace/etc-link');
    const before = (await run(s, `stat -c '%U %a %Y' ${EXPIRES} ${CA} 2>&1`)).stdout;
    const forged = Buffer.from('9999999999\n');
    await expect(provider.writeFile(s.id, '/workspace/sl/expires', forged)).rejects.toMatchObject(
      denied,
    );
    await expect(provider.writeFile(s.id, '/workspace/sl/ca.crt', forged)).rejects.toMatchObject(
      denied,
    );
    await expect(provider.writeFile(s.id, '/workspace/sl/new/dir/f', forged)).rejects.toMatchObject(
      denied,
    );
    await expect(
      provider.writeFile(s.id, '/workspace/etc-link/hosts', forged),
    ).rejects.toMatchObject(denied);
    const src = path.join(tmp, 'sl-src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'expires'), forged);
    await expect(provider.copyIn(s.id, src, '/workspace/sl/x')).rejects.toMatchObject(denied);
    await expect(
      provider.copyIn(s.id, path.join(src, 'expires'), '/workspace/sl/expires'),
    ).rejects.toMatchObject(denied);
    expect((await run(s, `stat -c '%U %a %Y' ${EXPIRES} ${CA} 2>&1`)).stdout).toBe(before);
    expect((await run(s, 'cat /etc/hosts')).stdout).not.toContain('9999999999');
    // the link itself is a normal directory entry: writing the link's path replaces the link, not its target
    await provider.writeFile(s.id, '/workspace/sl', Buffer.from('now a file'));
    expect((await run(s, 'cat /workspace/sl; stat -c " %U" /workspace/sl')).stdout).toBe(
      'now a file dev\n',
    );
    expect((await run(s, `stat -c '%U %a %Y' ${EXPIRES} ${CA} 2>&1`)).stdout).toBe(before);
  });

  it('cannot replace root-owned files (the CA, /etc/hosts, root files in the workspace)', async () => {
    const s = await sb();
    const before = (await run(s, `sha256sum ${CA} /etc/hosts 2>&1; stat -c '%U' ${CA} /etc/hosts`))
      .stdout;
    const forged = Buffer.from('forged\n');
    for (const p of [
      CA,
      '/etc/hosts',
      '/etc/passwd',
      '/etc/new-file',
      '/usr/local/share/abox/ca-bundle.crt',
    ]) {
      await expect(provider.writeFile(s.id, p, forged), p).rejects.toMatchObject(denied);
    }
    const src = path.join(tmp, 'ca-src');
    await fs.writeFile(src, 'forged');
    for (const dest of ['/etc/hosts', '/etc/abox-copy', '/usr/bin/forged']) {
      await expect(provider.copyIn(s.id, src, dest), dest).rejects.toMatchObject(denied);
    }
    expect(
      (await run(s, `sha256sum ${CA} /etc/hosts 2>&1; stat -c '%U' ${CA} /etc/hosts`)).stdout,
    ).toBe(before);
  });

  it('a stopped sandbox gets the same protection (static check, no symlinks followed)', async () => {
    const s = await sb();
    await run(s, 'ln -s /usr/local/share/abox /workspace/sl; mkdir /workspace/real');
    await provider.stop(s.id);
    const forged = Buffer.from('9999999999\n');
    await expect(provider.writeFile(s.id, '/workspace/sl/expires', forged)).rejects.toMatchObject(
      denied,
    );
    await expect(provider.writeFile(s.id, '/etc/hosts', forged)).rejects.toMatchObject(denied);
    await expect(
      provider.writeFile(s.id, `/proc/self/root${EXPIRES}`, forged),
    ).rejects.toMatchObject(denied);
    await expect(
      provider.writeFile(s.id, '/usr/local/share/abox/new', forged),
    ).rejects.toMatchObject(denied);
    const src = path.join(tmp, 'st-src');
    await fs.writeFile(src, 'x');
    await expect(provider.copyIn(s.id, src, '/workspace/sl/x')).rejects.toMatchObject(denied);
    await expect(provider.copyIn(s.id, src, '/etc/x')).rejects.toMatchObject(denied);
    // ordinary writes into the workspace keep working while stopped
    await provider.writeFile(s.id, '/workspace/real/new/ok.txt', Buffer.from('ok'));
    await provider.copyIn(s.id, src, '/workspace/real/copied');
    await provider.start(s.id);
    expect(
      (
        await run(
          s,
          'cat /workspace/real/new/ok.txt /workspace/real/copied; stat -c " %U" /workspace/real/new/ok.txt /workspace/real/copied',
        )
      ).stdout,
    ).toBe('okx dev\n dev\n');
    expect((await run(s, `stat -c '%U' ${EXPIRES}`)).stdout.trim()).toBe('root');
  });

  it('readFile: special files, directories and missing paths get accurate errors', async () => {
    const s = await sb();
    await run(
      s,
      'mkdir /workspace/dir; mkfifo /workspace/fifo; ln -s /dev/zero /workspace/zero-link; ln -s /workspace/dir /workspace/dir-link',
    );
    for (const p of [
      '/dev/zero',
      '/dev/null',
      '/dev/random',
      '/workspace/dir',
      '/workspace/dir-link',
      '/workspace/fifo',
      '/workspace/zero-link',
      '/proc/self',
      '/tmp',
    ]) {
      const e = await provider.readFile(s.id, p, 100).catch((x: unknown) => x);
      expect(e, p).toMatchObject({ code: 'invalid_input' });
      expect(String((e as Error).message), p).toMatch(/not a regular file/i);
    }
    await expect(provider.readFile(s.id, '/workspace/missing', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(provider.readFile(s.id, '/nope/not/here', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
    // a symlink to a regular file is followed, and its size is the file's
    await provider.writeFile(s.id, '/workspace/real.txt', Buffer.from('hello'));
    await run(s, 'ln -s real.txt /workspace/rl');
    expect(await provider.readFile(s.id, '/workspace/rl', 100)).toMatchObject({
      size: 5,
      truncated: false,
    });
    // a root-only file is not readable through the API either
    await expect(provider.readFile(s.id, '/etc/shadow', 100)).rejects.toMatchObject(denied);
    await expect(provider.listDir(s.id, '/workspace/real.txt')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(provider.listDir(s.id, '/workspace/nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    // stopped: special files and missing paths are accurate too (no "no such container")
    await provider.stop(s.id);
    await expect(provider.readFile(s.id, '/workspace/missing', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
    const e = await provider.readFile(s.id, '/workspace/missing', 100).catch((x: unknown) => x);
    expect(String((e as Error).message)).not.toMatch(/no such container/i);
    await expect(provider.readFile(s.id, '/workspace/dir', 100)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(provider.readFile(s.id, '/dev/zero', 100)).rejects.toSatisfy(
      (x: Error & { code?: string }) => x.code === 'not_found' || x.code === 'invalid_input',
    );
  });
  it('a stopped sandbox is read with the permissions of the sandbox user, like a running one', async () => {
    const s = await sb();
    await run(
      s,
      'mkdir -p /workspace/d /workspace/sub && echo ok > /workspace/d/f.txt && ' +
        'ln -s /etc/shadow /workspace/shadow-link && ln -s /etc /workspace/etc-link && ' +
        'ln -s d/f.txt /workspace/rel-link && ln -s /workspace/d /workspace/dir-link && ' +
        'ln -s ../../etc/shadow /workspace/sub/up-link && ln -s /workspace/sub/up-link /workspace/chain && ' +
        'ln -s /root /workspace/root-link && echo mine > /tmp/tmp-file',
    );
    // a root-only directory holding a world-readable file, and a root-only file in a world-readable one
    await provider.exec(s.id, {
      command:
        'mkdir -m 700 /opt/locked && echo secret > /opt/locked/f && chmod 644 /opt/locked/f && ' +
        'echo hidden > /opt/hidden && chmod 600 /opt/hidden',
      user: 'root',
    });
    const refused = [
      '/etc/shadow',
      '/workspace/shadow-link',
      '/workspace/etc-link/shadow',
      '/workspace/chain', // a chain of links ending at /etc/shadow
      '/workspace/sub/../etc-link/shadow',
      '/opt/locked/f', // no search permission on the directory
      '/opt/hidden',
      '/workspace/root-link/.profile',
      '/etc/../etc/shadow',
    ];
    const readable: Array<[string, string]> = [
      ['/workspace/d/f.txt', 'ok\n'],
      ['/workspace/rel-link', 'ok\n'],
      ['/workspace/dir-link/f.txt', 'ok\n'],
      ['/workspace/sub/../d/f.txt', 'ok\n'],
      ['/workspace/d/../d/./f.txt', 'ok\n'],
      ['/etc/hostname', ''], // world-readable (content differs per container)
    ];
    const probe = async (): Promise<void> => {
      for (const p of refused) {
        await expect(provider.readFile(s.id, p, 100), p).rejects.toMatchObject(denied);
      }
      for (const [p, content] of readable) {
        const r = await provider.readFile(s.id, p, 100);
        if (content) expect(r.data.toString(), p).toBe(content);
      }
      await expect(provider.listDir(s.id, '/opt/locked'), '/opt/locked').rejects.toMatchObject(
        denied,
      );
      await expect(provider.listDir(s.id, '/root'), '/root').rejects.toMatchObject(denied);
      await expect(provider.listDir(s.id, '/workspace/root-link')).rejects.toMatchObject(denied);
      expect((await provider.listDir(s.id, '/workspace/dir-link')).map((e) => e.name)).toEqual([
        'f.txt',
      ]);
      expect((await provider.listDir(s.id, '/workspace/sub/../d')).map((e) => e.name)).toEqual([
        'f.txt',
      ]);
      await expect(provider.readFile(s.id, '/workspace/d', 100)).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(provider.listDir(s.id, '/workspace/d/f.txt')).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(provider.readFile(s.id, '/workspace/none', 100)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(provider.listDir(s.id, '/workspace/none')).rejects.toMatchObject({
        code: 'not_found',
      });
    };
    await probe(); // running: the kernel decides
    await provider.stop(s.id);
    await probe(); // stopped: the same answers
    // a link loop is an error, not a hang
    await provider.start(s.id);
    await run(s, 'ln -s loop-b /workspace/loop-a; ln -s loop-a /workspace/loop-b');
    await provider.stop(s.id);
    await expect(provider.readFile(s.id, '/workspace/loop-a', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
    await provider.start(s.id);
    await expect(provider.readFile(s.id, '/workspace/loop-a', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a stopped sandbox: the workspace stays readable, a symlink to /etc/shadow does not', async () => {
    const s = await sb();
    await provider.writeFile(s.id, '/workspace/notes.txt', Buffer.from('keep me'));
    await run(s, 'ln -s /etc/shadow /workspace/s');
    await provider.stop(s.id);
    expect((await provider.readFile(s.id, '/workspace/notes.txt', 100)).data.toString()).toBe(
      'keep me',
    );
    await expect(provider.readFile(s.id, '/etc/shadow', 100)).rejects.toMatchObject(denied);
    await expect(provider.readFile(s.id, '/workspace/s', 100)).rejects.toMatchObject(denied);
  });

  it('procfs files report the length that was returned, and listing /proc/self/fd survives vanishing entries', async () => {
    const s = await sb();
    const all = await provider.readFile(s.id, '/proc/self/environ', 1_000_000);
    expect(all.data.length).toBeGreaterThan(0);
    expect(all).toMatchObject({ size: all.data.length, truncated: false });
    const part = await provider.readFile(s.id, '/proc/self/environ', 6);
    expect(part.data.length).toBe(6);
    expect(part.truncated).toBe(true);
    expect(part.size).toBeGreaterThan(6);
    // an ordinary file keeps its stated size
    await provider.writeFile(s.id, '/workspace/five', Buffer.from('12345'));
    expect(await provider.readFile(s.id, '/workspace/five', 3)).toMatchObject({
      size: 5,
      truncated: true,
    });
    expect(await provider.readFile(s.id, '/workspace/five', 10)).toMatchObject({
      size: 5,
      truncated: false,
    });
    await provider.writeFile(s.id, '/workspace/empty', Buffer.alloc(0));
    expect(await provider.readFile(s.id, '/workspace/empty', 10)).toMatchObject({
      size: 0,
      truncated: false,
    });
    // the fd directory of the listing process changes while it is listed
    for (let i = 0; i < 15; i++) {
      const entries = await provider.listDir(s.id, '/proc/self/fd');
      expect(entries.length).toBeGreaterThan(0);
    }
    for (let i = 0; i < 5; i++) await provider.listDir(s.id, '/proc/self/task');
    // a real error of the listing is still one
    await expect(provider.listDir(s.id, '/root')).rejects.toMatchObject(denied);
  });
});
