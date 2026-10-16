import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Docker from 'dockerode';
import { ttlEntrypoint } from './hostconfig.js';
import { effectiveExpiresAt, hasMovableExpiry, toEpochSeconds } from './expiry.js';
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

/** Run the real entrypoint script with the local `sh`; resolves with the exit code and the run time. */
function runEntrypoint(
  deadlineSec: number,
  during?: () => Promise<void>,
): Promise<{ code: number | null; ms: number }> {
  const [sh, ...args] = ttlEntrypoint(deadlineSec * 1000, file);
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
