import { describe, expect, it } from 'vitest';
import type { ChangeFile } from '@abox/core';
import {
  fileCheck,
  initialSelection,
  selectedFlagged,
  setFile,
  setHunk,
  sideBySide,
  summarize,
  toSelection,
  unselectedFlagged,
} from '../../src/shared/changes';

const hunk = (index: number) => ({
  index,
  header: `@@ -${index},1 +${index},1 @@`,
  oldStart: index,
  oldCount: 1,
  newStart: index,
  newCount: 1,
  additions: 1,
  deletions: 1,
  lines: ['-a', '+b'],
});

function file(over: Partial<ChangeFile> & { path: string }): ChangeFile {
  return {
    status: 'modified',
    kind: 'file',
    insertions: 1,
    deletions: 1,
    binary: false,
    hunks: [hunk(0), hunk(1)],
    hunkSelectable: true,
    contentOmitted: false,
    badges: [],
    flags: [],
    needsConfirmation: false,
    applicable: true,
    ...over,
  };
}

const files: ChangeFile[] = [
  file({ path: 'src/a.ts' }),
  file({ path: 'src/new.ts', status: 'added', hunks: [hunk(0)], hunkSelectable: false }),
  file({
    path: 'package.json',
    badges: ['dependency', 'flagged'],
    flags: ['package.json changed scripts'],
    needsConfirmation: true,
  }),
  file({ path: 'link', kind: 'symlink', applicable: false, hunks: [], hunkSelectable: false }),
];

describe('selection state', () => {
  it('starts with applicable, unflagged files selected and flagged ones off', () => {
    const s = initialSelection(files);
    expect(s['src/a.ts']).toEqual([true, true]);
    expect(s['src/new.ts']).toEqual([true]);
    expect(s['package.json']).toEqual([false, false]);
    expect(s['link']).toEqual([false]);
    expect(summarize(files, s)).toEqual({ files: 2, total: 4, hunks: 3 });
    expect(selectedFlagged(files, s)).toEqual([]);
    expect(unselectedFlagged(files, s).map((f) => f.path)).toEqual(['package.json']);
  });

  it('toggling a hunk makes the file partial and sends the hunk ids; all hunks send the file', () => {
    let s = initialSelection(files);
    s = setHunk(s, files[0]!, 0, false);
    expect(fileCheck(s, files[0]!)).toBe('some');
    expect(toSelection(files, s)).toEqual([
      { path: 'src/a.ts', hunks: [1] },
      { path: 'src/new.ts' },
    ]);
    s = setHunk(s, files[0]!, 1, false);
    expect(fileCheck(s, files[0]!)).toBe(false);
    expect(toSelection(files, s)).toEqual([{ path: 'src/new.ts' }]);
    s = setFile(s, files[0]!, true);
    expect(toSelection(files, s)).toEqual([{ path: 'src/a.ts' }, { path: 'src/new.ts' }]);
  });

  it('hunks of whole-only files and files that cannot be applied cannot be toggled', () => {
    let s = initialSelection(files);
    s = setHunk(s, files[1]!, 0, false);
    expect(s['src/new.ts']).toEqual([true]);
    s = setFile(s, files[3]!, true);
    expect(s['link']).toEqual([false]);
  });

  it('selecting a flagged file lists it for the extra confirmation', () => {
    const s = setFile(initialSelection(files), files[2]!, true);
    expect(selectedFlagged(files, s).map((f) => f.path)).toEqual(['package.json']);
    expect(toSelection(files, s).map((x) => x.path)).toEqual([
      'src/a.ts',
      'src/new.ts',
      'package.json',
    ]);
  });
});

describe('side by side layout', () => {
  it('puts context on both sides and pairs a removed run with the added run after it', () => {
    const rows = sideBySide([' ctx', '-old1', '-old2', '+new1', ' tail']);
    expect(rows).toEqual([
      { left: { kind: 'ctx', text: 'ctx' }, right: { kind: 'ctx', text: 'ctx' } },
      { left: { kind: 'del', text: 'old1' }, right: { kind: 'add', text: 'new1' } },
      { left: { kind: 'del', text: 'old2' } },
      { left: { kind: 'ctx', text: 'tail' }, right: { kind: 'ctx', text: 'tail' } },
    ]);
  });

  it('leaves the left blank for pure additions and the right blank for pure deletions', () => {
    expect(sideBySide(['+x', '+y'])).toEqual([
      { right: { kind: 'add', text: 'x' } },
      { right: { kind: 'add', text: 'y' } },
    ]);
    expect(sideBySide(['-x'])).toEqual([{ left: { kind: 'del', text: 'x' } }]);
  });

  it('keeps an added run that precedes a removed run apart (git never writes that), and the no-newline marker', () => {
    const rows = sideBySide(['+a', '-b', '\\ No newline at end of file']);
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      [undefined, 'a'],
      ['b', undefined],
      ['\\ No newline at end of file', '\\ No newline at end of file'],
    ]);
  });
});
