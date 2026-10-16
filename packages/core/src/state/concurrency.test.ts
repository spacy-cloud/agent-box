import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from './store.js';

const register = fileURLToPath(new URL('./__tests__/register.mjs', import.meta.url));
const writer = fileURLToPath(new URL('./__tests__/audit-writer.ts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abox-conc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runWriter(dbPath: string, label: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', register, writer, dbPath, label, String(count)],
      {
        stdio: ['ignore', 'inherit', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`writer ${label} exited with ${String(code)}: ${stderr}`)),
    );
  });
}

describe('concurrent processes', () => {
  it('two child processes append to the audit log simultaneously without losing or breaking entries', async () => {
    const dbPath = join(dir, 'state.db');
    const store = StateStore.open(dbPath); // creates + migrates before the writers start
    const N = 150;
    await Promise.all([runWriter(dbPath, 'alpha', N), runWriter(dbPath, 'beta', N)]);

    // the parent writes too, after the children finished
    store.audit.append({ actor: 'parent', action: 'done' });

    expect(store.audit.count()).toBe(2 * N + 1);
    expect(store.audit.verifyChain()).toEqual({ ok: true, checked: 2 * N + 1 });
    for (const label of ['alpha', 'beta']) {
      const mine = store.audit.query({ actor: label, order: 'asc', limit: 1000 });
      expect(mine.map((e) => (e.details as { i: number }).i)).toEqual(
        Array.from({ length: N }, (_, i) => i),
      );
    }
    // the sandbox upserts from both processes landed too
    expect(store.sandboxes.list().length).toBe(2 * Math.ceil(N / 7));
    store.close();
  }, 60_000);
});
