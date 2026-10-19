import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc';

const ok = (c: keyof typeof IPC, v: unknown) => IPC[c].safeParse(v).success;

describe('IPC: listing, deleting and cloning snapshots', () => {
  const ref = {
    backend: 'docker',
    sandboxId: 'local/abcd1234',
    snapshotId: 'abox-snap/abcd1234:x',
  };

  it('the global list takes no input', () => {
    expect(ok('snapshots:listAll', undefined)).toBe(true);
    expect(ok('snapshots:listAll', { all: true })).toBe(false);
  });

  it('delete names snapshots by backend, sandbox and snapshot id, 1 to 500 of them', () => {
    expect(ok('snapshots:delete', { refs: [ref] })).toBe(true);
    expect(ok('snapshots:delete', { refs: [] })).toBe(false);
    expect(ok('snapshots:delete', { refs: Array.from({ length: 500 }, () => ref) })).toBe(true);
    expect(ok('snapshots:delete', { refs: Array.from({ length: 501 }, () => ref) })).toBe(false);
    expect(ok('snapshots:delete', { refs: [{ ...ref, backend: 'floppy' }] })).toBe(false);
    expect(ok('snapshots:delete', { refs: [{ ...ref, snapshotId: '' }] })).toBe(false);
    expect(ok('snapshots:delete', { refs: [{ ...ref, snapshotId: 'x'.repeat(201) }] })).toBe(false);
    expect(ok('snapshots:delete', { refs: [{ ...ref, force: true }] })).toBe(false);
    expect(ok('snapshots:delete', { refs: [ref], all: true })).toBe(false);
    expect(ok('snapshots:delete', {})).toBe(false);
  });

  it('clone is a source plus an ordinary create request, with no way to widen it', () => {
    const source = { sandboxId: 'local/abcd1234', snapshotId: 'abox-snap/abcd1234:x' };
    expect(ok('snapshots:clone', { source, request: { template: 'node-dev' } })).toBe(true);
    expect(
      ok('snapshots:clone', {
        source,
        request: {
          template: 'node-dev',
          name: 'copy',
          overrides: { ttl: '2h', network: { mode: 'none' } },
          confirmed: true,
          progressKey: 'clone-1',
        },
      }),
    ).toBe(true);
    expect(ok('snapshots:clone', { request: { template: 'node-dev' } })).toBe(false);
    expect(ok('snapshots:clone', { source, request: {} })).toBe(false);
    expect(ok('snapshots:clone', { source, request: { template: 'a', name: '../evil' } })).toBe(
      false,
    );
    expect(ok('snapshots:clone', { source, request: { template: 'a', mounts: [] } })).toBe(false);
    expect(
      ok('snapshots:clone', { source: { ...source, extra: 1 }, request: { template: 'a' } }),
    ).toBe(false);
    expect(ok('snapshots:clone', { source, request: { template: 'a' }, fromSnapshot: 'x' })).toBe(
      false,
    );
  });
});
