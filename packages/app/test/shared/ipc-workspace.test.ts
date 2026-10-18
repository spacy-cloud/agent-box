import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc';

const ok = (c: keyof typeof IPC, v: unknown) => IPC[c].safeParse(v).success;

describe('IPC: workspace estimate, cancel and exclude', () => {
  it('workspace:estimate takes an absolute folder, a mode, exclude patterns and a progress key', () => {
    expect(ok('workspace:estimate', { path: '/home/u/proj' })).toBe(true);
    expect(
      ok('workspace:estimate', {
        path: '/home/u/proj',
        mode: 'copy',
        exclude: ['node_modules', '*.log'],
        progressKey: 'estimate-abc',
      }),
    ).toBe(true);
    expect(ok('workspace:estimate', { path: 'relative/dir' })).toBe(false);
    expect(ok('workspace:estimate', { path: '/p', mode: 'bogus' })).toBe(false);
    expect(ok('workspace:estimate', { path: '/p', extra: 1 })).toBe(false);
    expect(ok('workspace:estimate', { path: '/p', exclude: [''] })).toBe(false);
  });

  it('jobs:cancel names the call by its key and nothing else', () => {
    expect(ok('jobs:cancel', { key: 'create-1' })).toBe(true);
    expect(ok('jobs:cancel', {})).toBe(false);
    expect(ok('jobs:cancel', { key: 'k', all: true })).toBe(false);
  });

  it('sandboxes:create carries the exclude patterns of a copy workspace', () => {
    expect(
      ok('sandboxes:create', {
        template: 'alpine-min',
        workspace: { mode: 'copy', path: '/home/u/p', exclude: ['node_modules'] },
        progressKey: 'create-1',
      }),
    ).toBe(true);
    expect(ok('sandboxes:create', { template: 't', workspace: { exclude: [1] } as unknown })).toBe(
      false,
    );
  });

  it('both carry the .gitignore choice as a boolean', () => {
    expect(ok('workspace:estimate', { path: '/p', gitignore: false })).toBe(true);
    expect(ok('workspace:estimate', { path: '/p', gitignore: 'no' })).toBe(false);
    expect(
      ok('sandboxes:create', {
        template: 't',
        workspace: { mode: 'copy', path: '/p', gitignore: false },
      }),
    ).toBe(true);
    expect(ok('sandboxes:create', { template: 't', workspace: { gitignore: 1 } as unknown })).toBe(
      false,
    );
  });
});
