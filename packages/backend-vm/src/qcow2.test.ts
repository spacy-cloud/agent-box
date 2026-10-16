import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildQcow2Overlay, parseQcow2Header, QCOW2_CLUSTER_SIZE } from './qcow2.js';

describe('qcow2 overlay writer', () => {
  it('produces a parseable v3 header with backing file and format', () => {
    const buf = buildQcow2Overlay({
      backingFile: '/var/cache/abox/base.qcow2',
      virtualSize: 8 * 1024 ** 3,
    });
    expect(buf.length % QCOW2_CLUSTER_SIZE).toBe(0);
    const h = parseQcow2Header(buf);
    expect(h.version).toBe(3);
    expect(h.clusterBits).toBe(16);
    expect(h.virtualSize).toBe(8 * 1024 ** 3);
    expect(h.backingFile).toBe('/var/cache/abox/base.qcow2');
    expect(h.backingFormat).toBe('qcow2');
    expect(h.refcountOrder).toBe(4);
    expect(h.l1Size).toBe(16); // 8 GiB / 512 MiB per L1 entry
  });

  it('sizes the L1 table for large disks and keeps refcounts consistent', () => {
    const size = 2 * 1024 ** 4; // 2 TiB
    const buf = buildQcow2Overlay({ backingFile: '/b.qcow2', virtualSize: size });
    const h = parseQcow2Header(buf);
    expect(h.l1Size).toBe(4096);
    // 3 fixed clusters + 1 L1 cluster (4096 * 8 bytes = 32 KiB < 64 KiB)
    expect(buf.length).toBe(4 * QCOW2_CLUSTER_SIZE);
    const refBlock = 2 * QCOW2_CLUSTER_SIZE;
    for (let i = 0; i < 4; i++) expect(buf.readUInt16BE(refBlock + i * 2)).toBe(1);
    expect(buf.readUInt16BE(refBlock + 4 * 2)).toBe(0);
  });

  it('rejects invalid input', () => {
    expect(() => buildQcow2Overlay({ backingFile: '', virtualSize: 1 })).toThrow();
    expect(() => buildQcow2Overlay({ backingFile: '/x'.repeat(600), virtualSize: 1 })).toThrow();
    expect(() => buildQcow2Overlay({ backingFile: '/x', virtualSize: 0 })).toThrow();
    expect(() => buildQcow2Overlay({ backingFile: '/x\0y', virtualSize: 10 })).toThrow();
    expect(() =>
      parseQcow2Header(Buffer.from('not qcow2 at all, definitely not'.repeat(5))),
    ).toThrow(/magic/);
  });

  it('is accepted by qemu-img (when available via ABOX_TEST_QEMU_IMG)', async () => {
    const qemuImg = process.env['ABOX_TEST_QEMU_IMG'];
    if (!qemuImg || !existsSync(qemuImg)) return;
    const dir = await mkdtemp(join(tmpdir(), 'abox-qcow2-'));
    try {
      const base = join(dir, 'base.qcow2');
      execFileSync(qemuImg, ['create', '-f', 'qcow2', base, '64M']);
      const overlay = join(dir, 'overlay.qcow2');
      await writeFile(
        overlay,
        buildQcow2Overlay({ backingFile: base, virtualSize: 128 * 1024 ** 2 }),
      );
      const check = execFileSync(qemuImg, ['check', overlay]).toString();
      expect(check).toContain('No errors were found');
      const info = JSON.parse(
        execFileSync(qemuImg, ['info', '--output=json', overlay]).toString(),
      ) as Record<string, unknown>;
      expect(info['virtual-size']).toBe(128 * 1024 ** 2);
      expect(info['backing-filename']).toBe(base);
      expect(info['backing-filename-format']).toBe('qcow2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
