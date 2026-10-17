#!/usr/bin/env node
/* global process, console, setTimeout */
/**
 * Smoke test of the packaged AppImage. Run it under a display, e.g.
 *   xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm --filter @abox/app smoke [path/to/abox.AppImage]
 * It starts the AppImage with a throwaway ABOX_HOME/HOME, waits for the main window, checks that the native pty
 * module of the package loads, then quits the app and checks that the process ended.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';

const releaseDir = join(import.meta.dirname, '..', 'release');
const arg = process.argv[2];
const file =
  arg ??
  readdirSync(releaseDir)
    .filter((f) => f.endsWith('.AppImage'))
    .map((f) => join(releaseDir, f))[0];
if (!file || !existsSync(file)) {
  console.error('smoke: no AppImage found (run "pnpm --filter @abox/app dist" first)');
  process.exit(2);
}
console.log(`smoke: ${file} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MiB)`);

const base = mkdtempSync(join(tmpdir(), 'abox-appimage-smoke-'));
const started = Date.now();
let ok = false;
try {
  const app = await electron.launch({
    executablePath: file,
    args: [],
    timeout: 60_000,
    env: {
      ...process.env,
      ABOX_HOME: join(base, 'home'),
      HOME: base,
      SSH_AUTH_SOCK: '',
      ABOX_GUI_LOCALE: 'en',
      // no FUSE needed for the smoke test
      APPIMAGE_EXTRACT_AND_RUN: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('nav[aria-label="Main navigation"]', { timeout: 60_000 });
  const title = await page.title();
  const heading = await page.locator('h1').first().innerText();
  const info = await app.evaluate(async ({ app: a }) => {
    const { join: j } = process.getBuiltinModule('node:path');
    const fs = process.getBuiltinModule('node:fs');
    const pty = j(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'pty.node',
    );
    let ptyLoads = false;
    try {
      process.dlopen({ exports: {} }, pty);
      ptyLoads = true;
    } catch {
      /* reported below */
    }
    return {
      version: a.getVersion(),
      packaged: a.isPackaged,
      ptyExists: fs.existsSync(pty),
      ptyLoads,
    };
  });
  console.log(`smoke: window "${title}" shows "${heading}" after ${Date.now() - started} ms`);
  console.log(`smoke: ${JSON.stringify(info)}`);
  if (!info.packaged || !info.ptyExists || !info.ptyLoads)
    throw new Error('packaged app is missing the native pty module');
  const proc = app.process();
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  await app.close();
  const code = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r('timeout'), 15_000)),
  ]);
  if (code === 'timeout') throw new Error('the app did not exit after close');
  console.log(`smoke: app exited with code ${code}`);
  ok = true;
} catch (e) {
  console.error(`smoke: FAILED: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
