import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARD_LIMIT_SCRIPT } from './provider.js';

/** The host-side TTL backstop that wraps QEMU. Needs neither KVM nor QEMU: the "VM" is a `sleep`. */

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abox-hl-'));
  file = join(dir, 'hardlimit');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const nowSec = (): number => Math.floor(Date.now() / 1000);

function run(command: string[]): {
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
  alive: () => boolean;
} {
  const started = Date.now();
  const child = spawn('/bin/sh', ['-c', HARD_LIMIT_SCRIPT, 'abox-vm-main', file, '1', ...command], {
    stdio: 'ignore',
  });
  let alive = true;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>(
    (resolve) => {
      child.on('exit', (code, signal) => {
        alive = false;
        resolve({ code, signal, ms: Date.now() - started });
      });
    },
  );
  return { done, alive: () => alive };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('HARD_LIMIT_SCRIPT', () => {
  it('kills the command once the time in the file has come', async () => {
    await writeFile(file, `${nowSec() + 2}\n`);
    const r = await run(['sleep', '60']).done;
    expect(r.code).toBe(143); // SIGTERM
    expect(r.ms).toBeGreaterThan(1000);
    expect(r.ms).toBeLessThan(8000);
  }, 20_000);

  it('follows a time that is moved while the command runs', async () => {
    await writeFile(file, `${nowSec() + 3}\n`);
    const p = run(['sleep', '60']);
    await wait(500);
    await writeFile(file, `${nowSec() + 9}\n`);
    await wait(5500); // well past the first time
    expect(p.alive()).toBe(true);
    const r = await p.done;
    expect(r.code).toBe(143);
    expect(r.ms).toBeGreaterThan(8000);
  }, 30_000);

  it('passes on the exit code of the command and leaves nothing running', async () => {
    await writeFile(file, `${nowSec() + 600}\n`);
    const r = await run(['sh', '-c', 'exit 7']).done;
    expect(r.code).toBe(7);
    expect(r.ms).toBeLessThan(3000);
  });

  it('a missing file keeps the command running', async () => {
    const p = run(['sleep', '3']);
    const r = await p.done;
    expect(r.code).toBe(0);
  }, 20_000);
});
