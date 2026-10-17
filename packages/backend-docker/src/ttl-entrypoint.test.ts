import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Docker from 'dockerode';
import { ttlEntrypoint } from './hostconfig.js';
import {
  effectiveExpiresAt,
  hasMovableExpiry,
  isTrustedExpiryFile,
  toEpochSeconds,
} from './expiry.js';
import { LABEL } from './labels.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abox-ttl-'));
  file = join(dir, 'expires');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The file is owned by the test user here, so that user stands in for root. */
const me = process.getuid?.() ?? 0;

/** Run the real entrypoint script with the local `sh`; resolves with the exit code and the run time. */
function runEntrypoint(
  deadlineSec: number,
  during?: () => Promise<void>,
  trustedUid = me,
): Promise<{ code: number | null; ms: number }> {
  const [sh, ...args] = ttlEntrypoint(deadlineSec * 1000, file, trustedUid);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(sh as string, args, { stdio: 'ignore' });
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the entrypoint did not exit in time'));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(guard);
      resolve({ code, ms: Date.now() - started });
    });
    void during?.();
  });
}

describe('ttlEntrypoint', () => {
  it('exits 0 at the label deadline without a file, at once when it is over', async () => {
    const late = await runEntrypoint(nowSec() + 2);
    expect(late.code).toBe(0);
    expect(late.ms).toBeGreaterThan(500);
    expect(late.ms).toBeLessThan(4000);
    const over = await runEntrypoint(nowSec() - 5);
    expect(over.code).toBe(0);
    expect(over.ms).toBeLessThan(1000);
  });

  it('re-reads the file when the sleep ends: a deadline moved meanwhile is honoured', async () => {
    const original = nowSec() + 2;
    const r = await runEntrypoint(original, async () => {
      await new Promise((res) => setTimeout(res, 300));
      await writeFile(file, `${original + 3}\n`);
    });
    expect(r.code).toBe(0);
    expect(r.ms).toBeGreaterThan(4000);
    expect(r.ms).toBeLessThan(7500);
  });

  it('uses a file that is already there, but never an earlier or invalid one', async () => {
    await writeFile(file, `${nowSec() + 3}\n`);
    const later = await runEntrypoint(nowSec() + 1);
    expect(later.ms).toBeGreaterThan(1900);
    await writeFile(file, '1\n');
    const earlier = await runEntrypoint(nowSec() + 2);
    expect(earlier.ms).toBeGreaterThan(500);
    await writeFile(file, 'garbage');
    const invalid = await runEntrypoint(nowSec() + 1);
    expect(invalid.code).toBe(0);
    expect(invalid.ms).toBeLessThan(4500);
  });
});

describe('ttlEntrypoint: only a file the backend could have written moves the deadline', () => {
  it('ignores a file owned by somebody else', async () => {
    await writeFile(file, `${nowSec() + 60}\n`);
    const r = await runEntrypoint(nowSec() + 1, undefined, me + 1);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(4000);
  });

  it('ignores a file that group or others can write', async () => {
    for (const mode of [0o664, 0o646, 0o666]) {
      await writeFile(file, `${nowSec() + 60}\n`);
      await chmod(file, mode);
      const r = await runEntrypoint(nowSec() + 1);
      expect(r.ms).toBeLessThan(4000);
    }
  });

  it('accepts a file that is read-only for everyone but the owner', async () => {
    await writeFile(file, `${nowSec() + 3}\n`);
    await chmod(file, 0o600);
    const r = await runEntrypoint(nowSec() + 1);
    expect(r.ms).toBeGreaterThan(1900);
  });

  it('ignores a symlink, even to a file it would accept', async () => {
    const target = join(dir, 'target');
    await writeFile(target, `${nowSec() + 60}\n`);
    await symlink(target, file);
    const r = await runEntrypoint(nowSec() + 1);
    expect(r.ms).toBeLessThan(4000);
  });

  it('ignores a value that is not an epoch time in seconds', async () => {
    await writeFile(file, '99999999999999\n');
    const r = await runEntrypoint(nowSec() + 1);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(4000);
  });

  it('a file replaced by a forged one while it sleeps changes nothing', async () => {
    await writeFile(file, `${nowSec() + 1}\n`);
    const r = await runEntrypoint(nowSec() + 1, async () => {
      await new Promise((res) => setTimeout(res, 300));
      await writeFile(file, `${nowSec() + 60}\n`);
      await chmod(file, 0o666);
    });
    expect(r.ms).toBeLessThan(4500);
  });
});

describe('isTrustedExpiryFile', () => {
  it('is root-owned and not writable by group or others', () => {
    expect(isTrustedExpiryFile(0, 0o644)).toBe(true);
    expect(isTrustedExpiryFile(0, 0o600)).toBe(true);
    expect(isTrustedExpiryFile(1000, 0o644)).toBe(false);
    expect(isTrustedExpiryFile(0, 0o664)).toBe(false);
    expect(isTrustedExpiryFile(0, 0o646)).toBe(false);
  });
});

describe('effectiveExpiresAt', () => {
  const never = {
    getArchive: () => Promise.reject(new Error('must not be asked')),
  } as unknown as Docker.Container;

  it('a container without the marker label is not asked: the label is the deadline', async () => {
    const labels = { [LABEL.expires]: '1234567' };
    expect(hasMovableExpiry(labels)).toBe(false);
    expect(await effectiveExpiresAt(never, labels)).toBe(1234567);
  });

  it('rounds up the way the file is written', () => {
    expect(toEpochSeconds(1000)).toBe(1);
    expect(toEpochSeconds(1001)).toBe(2);
  });
});
