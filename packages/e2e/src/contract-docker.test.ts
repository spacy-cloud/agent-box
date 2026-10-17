import { describe } from 'vitest';
import { createDockerProvider } from '@abox/backend-docker';
import { defineProviderContract, makeTestTemplate } from '@abox/contract-tests';
import { DOCKER, E2E_LABELS, MiB, engineSocketOpts, instanceIdOf, sweepE2E } from './harness.js';

/**
 * Roadmap Phase 1 criterion 7 (docker half): the shared provider contract suite against the real Docker
 * backend. The gc tests run too: the provider has an instance id of its own and `gcImages` only deletes
 * the images that instance built, so a shared image store (other developers' runs) is not at risk.
 */
if (!DOCKER) {
  describe.skip('provider contract: docker [skipped: ABOX_TEST_DOCKER != 1]', () => undefined);
} else {
  defineProviderContract({
    name: 'docker (e2e)',
    gc: true,
    timeoutMs: 120_000,
    createProvider() {
      return createDockerProvider(
        { host: 'local', kind: 'local' },
        {
          ...engineSocketOpts(),
          extraLabels: E2E_LABELS,
          instanceId: instanceIdOf('contract'),
          stopTimeoutSec: 1,
        },
      );
    },
    template: () =>
      makeTestTemplate({
        name: 'e2e-contract-alpine',
        backend: 'docker',
        isolation: 'container',
        base: { os: 'alpine:3.22', osFamily: 'alpine' },
        user: { name: 'dev', uid: 1000, sudo: false },
        workspace: { mode: 'empty', path: '/workspace', access: 'rw' },
        resources: { cpus: 1, memoryBytes: 256 * MiB, pids: 128, ttlMs: 60 * 60 * 1000 },
      }),
    async dispose() {
      await sweepE2E();
    },
  });
}
