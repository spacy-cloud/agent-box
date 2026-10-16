import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestTemplate } from '@abox/contract-tests';
import {
  IMAGE_CATALOG,
  ensureBaseImage,
  normalizeImageName,
  parseChecksums,
  parsePin,
  selectImage,
} from './images.js';
import { buildQcow2Overlay } from './qcow2.js';

let cache: string;
beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), 'abox-img-'));
});
afterEach(async () => {
  await rm(cache, { recursive: true, force: true });
});

/** A tiny but valid qcow2 file standing in for a vendor image. */
const IMAGE = buildQcow2Overlay({ backingFile: '/nonexistent', virtualSize: 1 << 30 });
const sha = (algo: 'sha256' | 'sha512', b: Buffer | string): string =>
  createHash(algo).update(b).digest('hex');

interface FakeOptions {
  image?: Buffer;
  sums?: string;
  imageUrl?: string;
  failSums?: boolean;
  failImage?: boolean;
  redirectTo?: string;
}

function fakeFetch(
  src = IMAGE_CATALOG['debian-12']!,
  o: FakeOptions = {},
): { f: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const image = o.image ?? IMAGE;
  const f = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === src.checksumsUrl) {
      if (o.failSums) throw new Error('offline');
      return new Response(
        o.sums ??
          `${sha(src.algo, image)}  ${src.fileName}\n${'0'.repeat(src.algo === 'sha512' ? 128 : 64)}  other.raw\n`,
        { status: 200 },
      );
    }
    if (url === src.url) {
      if (o.failImage) throw new Error('offline');
      const r = new Response(image, {
        status: 200,
        headers: { 'content-length': String(image.length) },
      });
      if (o.redirectTo) Object.defineProperty(r, 'url', { value: o.redirectTo });
      return r;
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe('image catalog', () => {
  it('normalizes names and aliases', () => {
    expect(normalizeImageName('debian-12')).toBe('debian-12');
    expect(normalizeImageName('Debian:12')).toBe('debian-12');
    expect(normalizeImageName('bookworm')).toBe('debian-12');
    // Debian 13 is not offered: its genericcloud image does not boot with SeaBIOS (needs UEFI)
    expect(normalizeImageName('debian_13')).toBeUndefined();
    expect(normalizeImageName('ubuntu:24.04')).toBe('ubuntu-24.04');
    expect(normalizeImageName('noble')).toBe('ubuntu-24.04');
    expect(normalizeImageName('alpine-3.20')).toBeUndefined();
    expect(normalizeImageName('')).toBeUndefined();
  });

  it('every source is https and checksummed in the same directory', () => {
    for (const s of Object.values(IMAGE_CATALOG)) {
      expect(s.url.startsWith('https://')).toBe(true);
      expect(s.checksumsUrl.startsWith('https://')).toBe(true);
      expect(s.url.slice(0, s.url.lastIndexOf('/'))).toBe(
        s.checksumsUrl.slice(0, s.checksumsUrl.lastIndexOf('/')),
      );
      expect(s.url.endsWith(s.fileName)).toBe(true);
    }
  });

  it('selectImage: vm.image wins over base.os, default is debian-12, unknown is unsupported', () => {
    expect(selectImage(makeTestTemplate({ base: { osFamily: 'debian' } })).id).toBe('debian-12');
    expect(
      selectImage(makeTestTemplate({ base: { os: 'ubuntu:24.04', osFamily: 'debian' } })).id,
    ).toBe('ubuntu-24.04');
    expect(
      selectImage(
        makeTestTemplate({
          base: { os: 'ubuntu:24.04', osFamily: 'debian' },
          vm: { image: 'debian-12' },
        }),
      ).id,
    ).toBe('debian-12');
    expect(() =>
      selectImage(makeTestTemplate({ base: { os: 'fedora:41', osFamily: 'fedora' } })),
    ).toThrowError(/no base image/);
    try {
      selectImage(
        makeTestTemplate({ base: { os: 'https://evil.example/x.qcow2', osFamily: 'debian' } }),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('unsupported');
    }
  });

  it('parses checksum lists (text and binary markers)', () => {
    const h64 = 'a'.repeat(64);
    const m = parseChecksums(
      `${h64} *file-a.img\n${'B'.repeat(64)}  file-b.img\n\nnot a checksum line\n`,
    );
    expect(m.get('file-a.img')).toBe(h64);
    expect(m.get('file-b.img')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });

  it('parses pins', () => {
    const h = 'c'.repeat(128);
    expect(parsePin(`debian-12@sha512:${h}`, 'debian-12')).toEqual({ algo: 'sha512', hash: h });
    expect(parsePin(`debian-12@sha512:${h}`, 'ubuntu-24.04')).toBeUndefined();
    expect(parsePin('garbage', 'debian-12')).toBeUndefined();
    expect(parsePin(undefined, 'debian-12')).toBeUndefined();
  });
});

describe('ensureBaseImage', () => {
  it('downloads, verifies the checksum and caches the image', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const { f, calls } = fakeFetch(src);
    const progress: string[] = [];
    const a = await ensureBaseImage(src, cache, {
      fetchImpl: f,
      onProgress: (l) => progress.push(l),
    });
    expect(a.cached).toBe(false);
    expect(a.path.startsWith(join(cache, 'base'))).toBe(true);
    expect(a.hash).toBe(sha('sha512', IMAGE));
    expect(a.pin).toBe(`debian-12@sha512:${a.hash}`);
    expect(progress.join('\n')).toMatch(/verified/);
    // second call: checksum list only, no second download
    const b = await ensureBaseImage(src, cache, { fetchImpl: f });
    expect(b.cached).toBe(true);
    expect(b.path).toBe(a.path);
    expect(calls.filter((u) => u === src.url)).toHaveLength(1);
    expect((await readdir(join(cache, 'base'))).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('rejects a download whose checksum does not match and leaves nothing behind', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const { f } = fakeFetch(src, { sums: `${'f'.repeat(128)}  ${src.fileName}\n` });
    await expect(ensureBaseImage(src, cache, { fetchImpl: f })).rejects.toThrowError(
      /checksum mismatch/,
    );
    expect(await readdir(join(cache, 'base'))).toEqual([]);
  });

  it('rejects content that is not qcow2 even if the checksum matches', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const evil = Buffer.from('MZ not an image'.repeat(100));
    const { f } = fakeFetch(src, { image: evil });
    await expect(ensureBaseImage(src, cache, { fetchImpl: f })).rejects.toThrowError(/not a qcow2/);
    expect(await readdir(join(cache, 'base'))).toEqual([]);
  });

  it('refuses redirects to plain HTTP', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const { f } = fakeFetch(src, { redirectTo: 'http://mirror.example/img.qcow2' });
    await expect(ensureBaseImage(src, cache, { fetchImpl: f })).rejects.toThrowError(/non-HTTPS/);
  });

  it('fails when the checksum list has no entry for the image', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const { f } = fakeFetch(src, { sums: `${'a'.repeat(128)}  something-else.qcow2\n` });
    await expect(ensureBaseImage(src, cache, { fetchImpl: f })).rejects.toThrowError(
      /no sha512 entry/,
    );
  });

  it('uses a pinned image from the cache without any network access', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const first = await ensureBaseImage(src, cache, { fetchImpl: fakeFetch(src).f });
    const never = (() => {
      throw new Error('network must not be used');
    }) as unknown as typeof fetch;
    const again = await ensureBaseImage(src, cache, { fetchImpl: never, pinnedBase: first.pin });
    expect(again.cached).toBe(true);
    expect(again.path).toBe(first.path);
  });

  it('`update` ignores the pin and re-checks the vendor', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const first = await ensureBaseImage(src, cache, { fetchImpl: fakeFetch(src).f });
    const newer = Buffer.concat([IMAGE, Buffer.from('newer build')]);
    const { f, calls } = fakeFetch(src, { image: newer });
    const upd = await ensureBaseImage(src, cache, {
      fetchImpl: f,
      pinnedBase: first.pin,
      update: true,
    });
    expect(upd.path).not.toBe(first.path);
    expect(upd.hash).toBe(sha('sha512', newer));
    expect(calls).toContain(src.url);
  });

  it('works offline when a verified image is already cached (unless `update`)', async () => {
    const src = IMAGE_CATALOG['debian-12']!;
    const first = await ensureBaseImage(src, cache, { fetchImpl: fakeFetch(src).f });
    const offline = fakeFetch(src, { failSums: true }).f;
    const msgs: string[] = [];
    const again = await ensureBaseImage(src, cache, {
      fetchImpl: offline,
      onProgress: (l) => msgs.push(l),
    });
    expect(again.path).toBe(first.path);
    expect(msgs.join(' ')).toMatch(/using the cached one/);
    await expect(
      ensureBaseImage(src, cache, { fetchImpl: offline, update: true }),
    ).rejects.toThrow();
  });

  it('works for sha256 vendors too (Ubuntu)', async () => {
    const src = IMAGE_CATALOG['ubuntu-24.04']!;
    const { f } = fakeFetch(src);
    const img = await ensureBaseImage(src, cache, { fetchImpl: f });
    expect(img.algo).toBe('sha256');
    expect(img.hash).toBe(sha('sha256', IMAGE));
    await writeFile(join(cache, 'x'), '');
  });
});
