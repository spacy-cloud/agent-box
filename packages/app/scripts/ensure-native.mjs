#!/usr/bin/env node
/* global process, console */
/**
 * Makes sure the native module node-pty (SSH terminals) is available.
 *
 * node-pty 1.x is an N-API addon: a binary built against the system Node runs unchanged in Electron, so no
 * "electron-rebuild" is needed. It ships prebuilt binaries for macOS and Windows only; on Linux it has to be compiled
 * once (`node-gyp rebuild`, needs python3, make and a C++ compiler; headers are downloaded on first use).
 *
 * pnpm skips dependency build scripts by default, so this runs from this package's own `postinstall`.
 * `--soft` (postinstall): a failure only prints a warning and the rest of the app stays usable (no SSH terminals).
 * Without `--soft` (`pnpm --filter @abox/app run native`, `dist`): a failure is an error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const soft = process.argv.includes('--soft');
const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`[abox] ${message}`);
  process.exit(soft ? 0 : 1);
}

let ptyDir;
try {
  ptyDir = dirname(require.resolve('node-pty/package.json'));
} catch {
  fail('node-pty is not installed; run "pnpm install" first.');
}

const prebuilt = join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node');
const built = join(ptyDir, 'build', 'Release', 'pty.node');
if (existsSync(prebuilt) || existsSync(built)) {
  console.log('[abox] node-pty native module present.');
  process.exit(0);
}

console.log(`[abox] building node-pty for ${process.platform}-${process.arch} (one time) ...`);
const gyp = join(import.meta.dirname, '..', 'node_modules', '.bin', 'node-gyp');
const cmd = existsSync(gyp) ? gyp : 'node-gyp';
const res = spawnSync(cmd, ['rebuild'], { cwd: ptyDir, stdio: 'inherit' });
if (res.status !== 0 || !existsSync(built)) {
  fail(
    'could not build node-pty. SSH terminals will not work until it is built. ' +
      'Install python3, make and a C++ compiler, then run "pnpm --filter @abox/app run native".',
  );
}
console.log('[abox] node-pty built.');
