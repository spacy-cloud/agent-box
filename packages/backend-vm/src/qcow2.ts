import { open } from 'node:fs/promises';
import { AboxError } from '@abox/core';

/**
 * Minimal qcow2 (version 3) writer for empty copy-on-write overlays.
 *
 * Why: `qemu-img` is not guaranteed to be installed next to `qemu-system-*` (it is in a separate
 * package on several distros), and an overlay without any data clusters is a tiny, fully
 * documented structure. We write exactly that and let QEMU do everything else.
 *
 * Layout (cluster size 64 KiB, refcount_order 4 = 16-bit refcounts):
 *
 *   cluster 0     header (104 bytes) + header extensions (backing format, end marker) + backing file name
 *   cluster 1     refcount table (one entry -> cluster 2)
 *   cluster 2     refcount block (refcount 1 for every cluster of this file)
 *   cluster 3..   L1 table (all zero: every guest cluster is read from the backing file)
 *
 * Spec: https://www.qemu.org/docs/master/interop/qcow2.html
 */

export const QCOW2_MAGIC = 0x514649fb; // 'Q' 'F' 'I' 0xfb
export const QCOW2_CLUSTER_BITS = 16;
export const QCOW2_CLUSTER_SIZE = 1 << QCOW2_CLUSTER_BITS;
const HEADER_LENGTH = 104;
const EXT_BACKING_FORMAT = 0xe2792aca;
const BACKING_NAME_MAX = 1023;

export interface Qcow2OverlayOptions {
  /** Absolute path of the backing file (stored verbatim; QEMU resolves it at open time). */
  backingFile: string;
  /** Format of the backing file (stored as header extension so QEMU does not have to probe). */
  backingFormat?: 'qcow2' | 'raw';
  /** Virtual disk size in bytes. Must be >= the backing file's virtual size to avoid truncating it. */
  virtualSize: number;
}

export interface Qcow2Header {
  version: number;
  clusterBits: number;
  virtualSize: number;
  backingFile?: string;
  backingFormat?: string;
  l1Size: number;
  refcountOrder: number;
}

function roundUp(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}

/** Builds the bytes of an empty qcow2 overlay file. */
export function buildQcow2Overlay(opts: Qcow2OverlayOptions): Buffer {
  const { backingFile, virtualSize } = opts;
  if (!Number.isSafeInteger(virtualSize) || virtualSize <= 0) {
    throw new AboxError('invalid_input', `invalid virtual disk size ${String(virtualSize)}`);
  }
  const backing = Buffer.from(backingFile, 'utf8');
  if (backing.length === 0 || backing.length > BACKING_NAME_MAX) {
    throw new AboxError(
      'invalid_input',
      `backing file path must be 1..${BACKING_NAME_MAX} bytes (got ${backing.length})`,
    );
  }
  if (backing.includes(0))
    throw new AboxError('invalid_input', 'backing file path contains a NUL byte');

  const fmt = Buffer.from(opts.backingFormat ?? 'qcow2', 'ascii');
  const extData = Buffer.alloc(roundUp(fmt.length, 8));
  fmt.copy(extData);
  const ext = Buffer.alloc(8 + extData.length + 8); // backing-format ext + end marker
  ext.writeUInt32BE(EXT_BACKING_FORMAT, 0);
  ext.writeUInt32BE(fmt.length, 4);
  extData.copy(ext, 8);
  // trailing 8 bytes stay zero: end-of-extensions marker

  const backingOffset = HEADER_LENGTH + ext.length;
  if (backingOffset + backing.length > QCOW2_CLUSTER_SIZE) {
    throw new AboxError('invalid_input', 'backing file path too long for the qcow2 header cluster');
  }

  const l2Entries = QCOW2_CLUSTER_SIZE / 8;
  const l1Size = Math.max(1, Math.ceil(virtualSize / (l2Entries * QCOW2_CLUSTER_SIZE)));
  const l1Clusters = Math.ceil((l1Size * 8) / QCOW2_CLUSTER_SIZE);
  const refcountTableOffset = QCOW2_CLUSTER_SIZE; // cluster 1
  const refcountBlockOffset = 2 * QCOW2_CLUSTER_SIZE; // cluster 2
  const l1Offset = 3 * QCOW2_CLUSTER_SIZE;
  const totalClusters = 3 + l1Clusters;
  if (totalClusters > QCOW2_CLUSTER_SIZE / 2) {
    throw new AboxError(
      'invalid_input',
      'virtual disk size too large for the minimal qcow2 writer',
    );
  }

  const buf = Buffer.alloc(totalClusters * QCOW2_CLUSTER_SIZE);
  buf.writeUInt32BE(QCOW2_MAGIC, 0);
  buf.writeUInt32BE(3, 4); // version
  buf.writeBigUInt64BE(BigInt(backingOffset), 8);
  buf.writeUInt32BE(backing.length, 16);
  buf.writeUInt32BE(QCOW2_CLUSTER_BITS, 20);
  buf.writeBigUInt64BE(BigInt(virtualSize), 24);
  buf.writeUInt32BE(0, 32); // crypt_method: none
  buf.writeUInt32BE(l1Size, 36);
  buf.writeBigUInt64BE(BigInt(l1Offset), 40);
  buf.writeBigUInt64BE(BigInt(refcountTableOffset), 48);
  buf.writeUInt32BE(1, 56); // refcount_table_clusters
  buf.writeUInt32BE(0, 60); // nb_snapshots
  buf.writeBigUInt64BE(0n, 64); // snapshots_offset
  buf.writeBigUInt64BE(0n, 72); // incompatible features
  buf.writeBigUInt64BE(0n, 80); // compatible features
  buf.writeBigUInt64BE(0n, 88); // autoclear features
  buf.writeUInt32BE(4, 96); // refcount_order: 16 bit
  buf.writeUInt32BE(HEADER_LENGTH, 100);
  ext.copy(buf, HEADER_LENGTH);
  backing.copy(buf, backingOffset);

  // refcount table: first entry points to the (only) refcount block
  buf.writeBigUInt64BE(BigInt(refcountBlockOffset), refcountTableOffset);
  // refcount block: every cluster of the file has refcount 1
  for (let i = 0; i < totalClusters; i++) buf.writeUInt16BE(1, refcountBlockOffset + i * 2);
  return buf;
}

/** Parses the fixed header of a qcow2 image from its first bytes (at least one cluster is plenty). */
export function parseQcow2Header(buf: Buffer): Qcow2Header {
  if (buf.length < HEADER_LENGTH - 8 || buf.readUInt32BE(0) !== QCOW2_MAGIC) {
    throw new AboxError('invalid_input', 'not a qcow2 image (bad magic)');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3)
    throw new AboxError('invalid_input', `unsupported qcow2 version ${version}`);
  const backingOffset = Number(buf.readBigUInt64BE(8));
  const backingSize = buf.readUInt32BE(16);
  const header: Qcow2Header = {
    version,
    clusterBits: buf.readUInt32BE(20),
    virtualSize: Number(buf.readBigUInt64BE(24)),
    l1Size: buf.readUInt32BE(36),
    refcountOrder: version === 3 ? buf.readUInt32BE(96) : 4,
  };
  if (backingOffset !== 0 && backingSize > 0 && backingOffset + backingSize <= buf.length) {
    header.backingFile = buf.subarray(backingOffset, backingOffset + backingSize).toString('utf8');
  }
  if (version === 3 && buf.length >= HEADER_LENGTH) {
    let off = buf.readUInt32BE(100);
    while (off + 8 <= buf.length) {
      const type = buf.readUInt32BE(off);
      const len = buf.readUInt32BE(off + 4);
      if (type === 0) break;
      if (type === EXT_BACKING_FORMAT && off + 8 + len <= buf.length) {
        header.backingFormat = buf.subarray(off + 8, off + 8 + len).toString('ascii');
      }
      off += 8 + roundUp(len, 8);
    }
  }
  return header;
}

/** Reads the header of a qcow2 file on disk. Rejects anything that is not qcow2. */
export async function readQcow2Header(path: string): Promise<Qcow2Header> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(QCOW2_CLUSTER_SIZE);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseQcow2Header(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
