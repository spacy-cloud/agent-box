import { makeTestSpec } from '@abox/contract-tests';
import { afterAll, describe, expect, it } from 'vitest';
import { VM_TESTS, createTestProvider, disposeTestDirs, vmTemplate } from './env.js';

/** Other distributions: ABOX_TEST_VM=1 ABOX_TEST_VM_IMAGES=ubuntu-24.04,debian-13 (downloads 300-700 MB each, once). */
const wanted = (process.env['ABOX_TEST_VM_IMAGES'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

describe.skipIf(!VM_TESTS || wanted.length === 0)('other base images', () => {
  afterAll(disposeTestDirs);
  for (const os of wanted) {
    it(
      `${os}: builds, boots, runs commands as the template user and honours the sandbox features`,
      async () => {
        const p = await createTestProvider();
        const template = vmTemplate({
          base: { os, osFamily: 'debian' },
          user: { name: 'dev', uid: 1000, sudo: true },
          build: [
            {
              name: 'setup #1',
              script:
                'set -eu\necho built-on-$(. /etc/os-release; echo $ID-$VERSION_ID) > /etc/abox-test-marker\n',
            },
          ],
        });
        const t0 = Date.now();
        const image = await p.prepare(template, {
          onProgress: (l) => process.stderr.write(`    ${os}: ${l.slice(0, 120)}\n`),
        });
        process.stderr.write(`    ${os}: prepare took ${Date.now() - t0} ms\n`);
        const spec = await makeTestSpec(p, template, {
          image,
          resources: { ...template.resources, pids: 64 },
        });
        await p.create(spec);
        const t1 = Date.now();
        await p.start(spec.id);
        process.stderr.write(`    ${os}: start took ${Date.now() - t1} ms\n`);
        try {
          const r = await p.exec(spec.id, {
            command:
              'id -un; id -u; cat /etc/abox-test-marker; sudo -n true && echo sudo-ok; . /etc/os-release; echo $PRETTY_NAME; uname -r',
          });
          expect(r.exitCode).toBe(0);
          const lines = r.stdout.split('\n');
          expect(lines[0]).toBe('dev');
          expect(lines[2]).toMatch(/^built-on-/);
          expect(lines[3]).toBe('sudo-ok');
          // file APIs, tar based copy and the process limit group also work on this image
          await p.writeFile(spec.id, '/workspace/x/y.txt', Buffer.from('hi'));
          expect((await p.readFile(spec.id, '/workspace/x/y.txt', 10)).data.toString()).toBe('hi');
          const snap = await p.snapshot!(spec.id, 's1');
          await p.writeFile(spec.id, '/workspace/x/y.txt', Buffer.from('changed'));
          await p.restore!(spec.id, snap);
          expect((await p.readFile(spec.id, '/workspace/x/y.txt', 10)).data.toString()).toBe('hi');
          const cg = await p.exec(spec.id, { argv: ['cat', '/proc/self/cgroup'] });
          expect(cg.stdout).toContain('abox-sandbox');
        } finally {
          await p.remove(spec.id);
        }
      },
      20 * 60_000,
    );
  }
});
