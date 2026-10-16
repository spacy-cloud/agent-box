import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { AboxError, type ResolvedTemplate } from '@abox/core';
import { readQcow2Header } from './qcow2.js';

/**
 * Base images: official cloud images, downloaded over HTTPS and verified against the
 * checksum list published next to them (same origin, HTTPS). The GPG signature of the
 * checksum file is NOT verified: the guarantee is "what the vendor's HTTPS site serves",
 * not an offline-verifiable signature chain. See README.
 */

export interface ImageSource {
  /** Catalog id, e.g. `debian-12`. */
  id: string;
  label: string;
  family: 'debian';
  /** Image file URL (https). */
  url: string;
  /** Checksum list URL (https), same directory as the image. */
  checksumsUrl: string;
  /** File name inside the checksum list. */
  fileName: string;
  algo: 'sha512' | 'sha256';
}

export const IMAGE_CATALOG: Readonly<Record<string, ImageSource>> = {
  'debian-12': {
    id: 'debian-12',
    label: 'Debian 12 (bookworm) genericcloud',
    family: 'debian',
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2',
    checksumsUrl: 'https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS',
    fileName: 'debian-12-genericcloud-amd64.qcow2',
    algo: 'sha512',
  },
  'ubuntu-24.04': {
    id: 'ubuntu-24.04',
    label: 'Ubuntu 24.04 LTS (noble) cloud image',
    family: 'debian',
    url: 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img',
    checksumsUrl: 'https://cloud-images.ubuntu.com/releases/24.04/release/SHA256SUMS',
    fileName: 'ubuntu-24.04-server-cloudimg-amd64.img',
    algo: 'sha256',
  },
};

export const DEFAULT_IMAGE_ID = 'debian-12';

const ALIASES: Record<string, string> = {
  debian: 'debian-12',
  bookworm: 'debian-12',
  'debian-bookworm': 'debian-12',
  debian12: 'debian-12',
  ubuntu: 'ubuntu-24.04',
  noble: 'ubuntu-24.04',
  'ubuntu-noble': 'ubuntu-24.04',
  'ubuntu-24': 'ubuntu-24.04',
  ubuntu2404: 'ubuntu-24.04',
};

/** Normalizes `Debian:12`, `ubuntu_24.04`, ... to a catalog id, or undefined. */
export function normalizeImageName(name: string): string | undefined {
  const n = name.trim().toLowerCase().replace(/[:_/]/g, '-');
  if (IMAGE_CATALOG[n]) return n;
  return ALIASES[n];
}

/** Picks the image for a template (`vm.image`, else `base.os`, else the default) or rejects with `unsupported`. */
export function selectImage(template: ResolvedTemplate): ImageSource {
  const wanted = template.vm?.image || template.base.os || DEFAULT_IMAGE_ID;
  const id = normalizeImageName(wanted);
  const src = id ? IMAGE_CATALOG[id] : undefined;
  if (!src) {
    throw new AboxError('unsupported', `the VM backend has no base image '${wanted}'`, {
      hint: `Supported images: ${Object.keys(IMAGE_CATALOG).join(', ')} (set base.os or vm.image). Custom image files and URLs are not supported because they can not be verified.`,
    });
  }
  return src;
}

/** Parses `sha256sum`/`sha512sum` style lists: `<hex>  <file>` or `<hex> *<file>`. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64,128})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) out.set(m[2] as string, (m[1] as string).toLowerCase());
  }
  return out;
}

export interface BaseImage {
  id: string;
  path: string;
  algo: ImageSource['algo'];
  hash: string;
  /** Pin string accepted again through `PrepareOptions.pinnedBase`. */
  pin: string;
  /** True when nothing was downloaded. */
  cached: boolean;
}

export interface EnsureBaseOptions {
  /** Re-resolve the vendor's current image instead of using a pinned one. */
  update?: boolean;
  pinnedBase?: string;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /** Test hook. */
  fetchImpl?: typeof fetch;
}

export function parsePin(
  pin: string | undefined,
  id: string,
): { algo: string; hash: string } | undefined {
  if (!pin) return undefined;
  const m = /^([a-z0-9.-]+)@(sha256|sha512):([0-9a-f]{64,128})$/.exec(pin);
  if (!m || m[1] !== id) return undefined;
  return { algo: m[2] as string, hash: m[3] as string };
}

function baseFileName(id: string, hash: string): string {
  return `${id}-${hash.slice(0, 16)}.qcow2`;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function fetchChecked(f: typeof fetch, url: string, signal?: AbortSignal): Promise<Response> {
  if (!url.startsWith('https://')) throw new AboxError('internal', `refusing non-HTTPS URL ${url}`);
  let res: Response;
  try {
    res = await f(url, { redirect: 'follow', ...(signal ? { signal } : {}) });
  } catch (e) {
    throw new AboxError(
      'backend_unavailable',
      `downloading ${url}: ${e instanceof Error ? e.message : String(e)}`,
      {
        hint: 'The VM backend needs internet access once to download the base image (it is cached afterwards).',
        cause: e,
      },
    );
  }
  if (!res.ok) {
    throw new AboxError('backend_unavailable', `downloading ${url}: HTTP ${res.status}`);
  }
  // Redirects to plain HTTP would defeat the point of HTTPS-verified checksums.
  if (res.url && !res.url.startsWith('https://')) {
    throw new AboxError(
      'backend_error',
      `${url} redirected to a non-HTTPS URL (${res.url}); refusing`,
    );
  }
  return res;
}

/**
 * Returns the verified base image for `source`, downloading it when needed.
 * Images live in `<cacheDir>/base/<id>-<hash16>.qcow2` and are immutable once written.
 */
export async function ensureBaseImage(
  source: ImageSource,
  cacheDir: string,
  opts: EnsureBaseOptions = {},
): Promise<BaseImage> {
  const dir = join(cacheDir, 'base');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = opts.onProgress ?? (() => undefined);
  const f = opts.fetchImpl ?? fetch;

  // 1. A pinned image that is still in the cache needs no network at all.
  const pin = opts.update ? undefined : parsePin(opts.pinnedBase, source.id);
  if (pin) {
    const p = join(dir, baseFileName(source.id, pin.hash));
    if (await exists(p)) {
      return {
        id: source.id,
        path: p,
        algo: source.algo,
        hash: pin.hash,
        pin: `${source.id}@${pin.algo}:${pin.hash}`,
        cached: true,
      };
    }
    log(
      `pinned base image ${source.id}@${pin.hash.slice(0, 12)} is not in the cache; resolving the current one`,
    );
  }

  // 2. Current checksum from the vendor.
  let expected: string;
  try {
    const res = await fetchChecked(f, source.checksumsUrl, opts.signal);
    const sums = parseChecksums(await res.text());
    const h = sums.get(source.fileName);
    if (!h || h.length !== (source.algo === 'sha512' ? 128 : 64)) {
      throw new AboxError(
        'backend_error',
        `${source.checksumsUrl} has no ${source.algo} entry for ${source.fileName}`,
      );
    }
    expected = h;
  } catch (e) {
    // Offline: fall back to the newest verified image we already have.
    const have = await newestCached(dir, source.id);
    if (have && !opts.update) {
      log(
        `could not check for a newer ${source.id} image (${e instanceof Error ? e.message : String(e)}); using the cached one`,
      );
      return have;
    }
    throw e;
  }

  const target = join(dir, baseFileName(source.id, expected));
  if (await exists(target)) {
    return {
      id: source.id,
      path: target,
      algo: source.algo,
      hash: expected,
      pin: `${source.id}@${source.algo}:${expected}`,
      cached: true,
    };
  }

  // 3. Download + verify.
  log(`downloading ${source.label} (${source.url})`);
  const res = await fetchChecked(f, source.url, opts.signal);
  if (!res.body) throw new AboxError('backend_error', `${source.url}: empty response`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const part = join(dir, `.dl-${randomBytes(6).toString('hex')}.part`);
  const hash = createHash(source.algo);
  let received = 0;
  let nextReport = 10;
  try {
    const sink = createWriteStream(part, { mode: 0o600 });
    const writable = new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct >= nextReport) {
            log(`download ${pct}% (${Math.round(received / 1048576)} MiB)`);
            nextReport = pct + 10;
          }
        }
        if (sink.write(chunk)) cb();
        else sink.once('drain', () => cb());
      },
      final(cb) {
        sink.end(() => cb());
      },
    });
    const reader = res.body.getReader();
    await new Promise<void>((resolve, reject) => {
      writable.on('error', reject);
      sink.on('error', reject);
      writable.on('finish', resolve);
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!writable.write(Buffer.from(value)))
            await new Promise<void>((r) => writable.once('drain', () => r()));
        }
        writable.end();
      };
      pump().catch(reject);
    });
    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new AboxError(
        'backend_error',
        `checksum mismatch for ${source.url}: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`,
        {
          hint: 'The download was corrupted or tampered with and has been discarded. Retry later.',
        },
      );
    }
    await readQcow2Header(part).catch((e: unknown) => {
      throw new AboxError(
        'backend_error',
        `${source.url} is not a qcow2 image: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    await rename(part, target);
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    throw e;
  }
  await writeFile(
    `${target}.json`,
    JSON.stringify(
      {
        id: source.id,
        url: source.url,
        algo: source.algo,
        hash: expected,
        size: received,
        fetchedAt: Date.now(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  log(`base image verified (${source.algo} ${expected.slice(0, 16)}…) and stored`);
  return {
    id: source.id,
    path: target,
    algo: source.algo,
    hash: expected,
    pin: `${source.id}@${source.algo}:${expected}`,
    cached: false,
  };
}

async function newestCached(dir: string, id: string): Promise<BaseImage | undefined> {
  let best: { path: string; hash: string; mtime: number; algo: ImageSource['algo'] } | undefined;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(`${id}-`) || !name.endsWith('.qcow2')) continue;
    try {
      const meta = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as {
        hash?: string;
        algo?: string;
      };
      if (typeof meta.hash !== 'string' || (meta.algo !== 'sha256' && meta.algo !== 'sha512'))
        continue;
      const st = await stat(join(dir, name));
      if (!best || st.mtimeMs > best.mtime)
        best = { path: join(dir, name), hash: meta.hash, mtime: st.mtimeMs, algo: meta.algo };
    } catch {
      /* skip unverified files */
    }
  }
  return best
    ? {
        id,
        path: best.path,
        algo: best.algo,
        hash: best.hash,
        pin: `${id}@${best.algo}:${best.hash}`,
        cached: true,
      }
    : undefined;
}
