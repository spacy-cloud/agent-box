import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { defineProviderContract } from '@abox/contract-tests';
import { createPythonProvider } from './index.js';
import { testLabels, dockerEnabled, pyTemplate, sweepTestObjects } from './__tests__/helpers.js';

// Container mode against a real engine: ABOX_TEST_DOCKER=1.
const dirs: string[] = [];

defineProviderContract({
  name: 'python (container mode)',
  skip: dockerEnabled ? false : 'set ABOX_TEST_DOCKER=1',
  timeoutMs: 120_000,
  async createProvider() {
    const dataDir = await mkdtemp(join(tmpdir(), 'abox-python-ct-'));
    dirs.push(dataDir);
    const p = createPythonProvider(
      { host: 'local', kind: 'local' },
      { dataDir, docker: { extraLabels: testLabels('contract'), stopTimeoutSec: 1 } },
    );
    await p.init();
    return p;
  },
  template: () => pyTemplate(),
  async dispose() {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
    await sweepTestObjects('contract');
  },
});

afterAll(async () => {
  if (dockerEnabled) await sweepTestObjects('contract');
});
