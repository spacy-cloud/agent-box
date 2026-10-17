import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPodmanProvider, defaultSocketPath } from './index.js';
import { TEST_ENGINE, TEST_SOCKET } from './__tests__/harness.js';

// ABOX_TEST_ENGINE=podman [ABOX_TEST_ENGINE_SOCKET=...] points the whole integration suite at Podman.
const podmanSocket = TEST_ENGINE === 'podman' ? TEST_SOCKET : defaultSocketPath('podman');
const hasPodman = existsSync(podmanSocket);

describe('podman provider', () => {
  it('defaults to the user podman socket', () => {
    const saved = process.env['XDG_RUNTIME_DIR'];
    process.env['XDG_RUNTIME_DIR'] = '/run/user/4242';
    try {
      expect(defaultSocketPath('podman')).toBe('/run/user/4242/podman/podman.sock');
    } finally {
      if (saved === undefined) delete process.env['XDG_RUNTIME_DIR'];
      else process.env['XDG_RUNTIME_DIR'] = saved;
    }
  });

  it('reports kind podman and fails cleanly (no throw from status) without a socket', async () => {
    const p = createPodmanProvider({
      host: 'local',
      kind: 'local',
      engineSocket: '/nonexistent/podman.sock',
    });
    expect(p.kind).toBe('podman');
    const st = await p.status();
    expect(st.ok).toBe(false);
    await expect(p.list()).rejects.toMatchObject({ code: 'backend_unavailable' });
  });

  describe.skipIf(!hasPodman || process.env['ABOX_TEST_DOCKER'] !== '1')(
    'against a real podman socket',
    () => {
      it('status is ok', async () => {
        const p = createPodmanProvider({
          host: 'local',
          kind: 'local',
          engineSocket: podmanSocket,
        });
        expect((await p.status()).ok).toBe(true);
      });
    },
  );

  it.skipIf(hasPodman)('real podman tests skipped: no podman socket at ' + podmanSocket, () => {
    expect(hasPodman).toBe(false);
  });
});
