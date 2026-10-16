import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestTemplate } from '@abox/contract-tests';
import type { ResolvedTemplate } from '@abox/core';
import { createVmProvider, type VmProvider, type VmProviderOptions } from '../provider.js';

/**
 * Shared setup of the guarded VM integration tests (ABOX_TEST_VM=1).
 * Base and prepared images are cached in ABOX_TEST_VM_CACHE (default ~/.cache/abox-vm-test/cache)
 * so only the first run downloads and builds; sandbox data lives in a fresh temp directory.
 */
export const VM_TESTS = process.env['ABOX_TEST_VM'] === '1';
export const testCacheDir =
  process.env['ABOX_TEST_VM_CACHE'] ?? join(homedir(), '.cache', 'abox-vm-test', 'cache');

const dirs: string[] = [];

/**
 * Cache for suites that call `gcImages` (it deletes everything that is not kept): same downloaded base
 * images (symlinked), separate prepared images.
 */
export async function gcTestCacheDir(): Promise<string> {
  const dir = `${testCacheDir}-gc`;
  await mkdir(dir, { recursive: true });
  await mkdir(testCacheDir, { recursive: true });
  await mkdir(join(testCacheDir, 'base'), { recursive: true });
  await symlink(join(testCacheDir, 'base'), join(dir, 'base')).catch(() => undefined);
  return dir;
}

export async function createTestProvider(extra: VmProviderOptions = {}): Promise<VmProvider> {
  const dataDir = await mkdtemp(join(tmpdir(), 'abox-vm-'));
  dirs.push(dataDir);
  return createVmProvider(
    { host: 'local', kind: 'local' },
    { dataDir, cacheDir: testCacheDir, ...extra },
  );
}

export async function disposeTestDirs(): Promise<void> {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
}

export function vmTemplate(overrides: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  return makeTestTemplate({
    backend: 'vm',
    isolation: 'vm',
    base: { os: 'debian-12', osFamily: 'debian' },
    ...overrides,
  });
}
