import { defineProviderContract } from '@abox/contract-tests';
import {
  VM_TESTS,
  createTestProvider,
  disposeTestDirs,
  gcTestCacheDir,
  vmTemplate,
} from './env.js';

const GC = process.env['ABOX_TEST_VM_GC'] === '1';

// Heavy: boots real VMs. Run with ABOX_TEST_VM=1 (needs /dev/kvm and QEMU).
defineProviderContract({
  name: 'vm',
  skip: VM_TESTS ? false : 'set ABOX_TEST_VM=1 to boot real VMs',
  // A cold start is ~4 s, prepare of a new image ~30 s - 3 min depending on the build steps.
  timeoutMs: 240_000,
  gc: GC,
  createProvider: async () =>
    GC ? createTestProvider({ cacheDir: await gcTestCacheDir() }) : createTestProvider(),
  template: () => vmTemplate(),
  async dispose() {
    await disposeTestDirs();
  },
});
