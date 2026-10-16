import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProviderContract, makeTestTemplate } from '@abox/contract-tests';
import { createProcessProvider } from './index.js';

const dirs: string[] = [];

defineProviderContract({
  name: 'process',
  gc: true,
  async createProvider() {
    const dataDir = await mkdtemp(join(tmpdir(), 'abox-process-ct-'));
    dirs.push(dataDir);
    return createProcessProvider({ host: 'local', kind: 'local' }, { dataDir });
  },
  template: () => makeTestTemplate({ backend: 'process', isolation: 'none' }),
  // The process backend can only offer network mode 'open'.
  spec: (base) => ({ ...base, network: { ...base.network, mode: 'open' } }),
  async dispose() {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  },
});
