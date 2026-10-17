#!/usr/bin/env node
// `tsc -b` writes dist/bin.js without the execute bit. Make every `bin` entry of every package executable,
// so `pnpm build` at the root leaves a working `packages/cli/dist/bin.js` (the per-package build does the same).
import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
let count = 0;
for (const name of readdirSync(packagesDir)) {
  const manifest = join(packagesDir, name, 'package.json');
  if (!existsSync(manifest)) continue;
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!bin) continue;
  const files = typeof bin === 'string' ? [bin] : Object.values(bin);
  for (const rel of files) {
    const file = join(packagesDir, name, String(rel));
    if (!existsSync(file)) continue;
    chmodSync(file, 0o755);
    count++;
  }
}
process.stdout.write(`postbuild: made ${count} bin file(s) executable` + '\n');
