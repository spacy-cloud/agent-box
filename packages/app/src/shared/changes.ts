/**
 * Selection state of the "Changes" tab, and the layout of a hunk for the side-by-side view.
 * Pure functions: the renderer keeps no rules of its own. What may be applied is decided by the manager;
 * this only remembers which boxes are ticked and turns them into the ids the manager accepts.
 */
import type { ChangeBadge, ChangeFile, ChangeSelection } from '@abox/core';

/** Per path: one flag per hunk (files whose hunks cannot be chosen one by one have a single flag for the whole file). */
export type SelectionState = Record<string, boolean[]>;

function slots(f: ChangeFile): number {
  return f.hunkSelectable ? f.hunks.length : 1;
}

/** Everything that is applicable and not flagged starts selected; flagged files never do. */
export function initialSelection(files: ChangeFile[]): SelectionState {
  const out: SelectionState = {};
  for (const f of files)
    out[f.path] = Array<boolean>(slots(f)).fill(f.applicable && !f.needsConfirmation);
  return out;
}

export function isSelected(state: SelectionState, f: ChangeFile): boolean {
  return (state[f.path] ?? []).some(Boolean);
}

/** `true` all, `false` none, `'some'` for a partly selected file (an indeterminate checkbox). */
export function fileCheck(state: SelectionState, f: ChangeFile): boolean | 'some' {
  const s = state[f.path] ?? [];
  if (s.length === 0 || !s.some(Boolean)) return false;
  return s.every(Boolean) ? true : 'some';
}

export function setFile(state: SelectionState, f: ChangeFile, on: boolean): SelectionState {
  if (!f.applicable) return state;
  return { ...state, [f.path]: Array<boolean>(slots(f)).fill(on) };
}

export function setHunk(
  state: SelectionState,
  f: ChangeFile,
  index: number,
  on: boolean,
): SelectionState {
  if (!f.applicable || !f.hunkSelectable) return state;
  const cur = [...(state[f.path] ?? Array<boolean>(slots(f)).fill(false))];
  cur[index] = on;
  return { ...state, [f.path]: cur };
}

export function selectedHunkCount(state: SelectionState, f: ChangeFile): number {
  const s = state[f.path] ?? [];
  if (!f.hunkSelectable) return s.some(Boolean) ? f.hunks.length : 0;
  return s.filter(Boolean).length;
}

export interface SelectionSummary {
  files: number;
  total: number;
  hunks: number;
}

export function summarize(files: ChangeFile[], state: SelectionState): SelectionSummary {
  let selected = 0;
  let hunks = 0;
  for (const f of files) {
    if (!isSelected(state, f)) continue;
    selected++;
    hunks += selectedHunkCount(state, f);
  }
  return { files: selected, total: files.length, hunks };
}

/** The ids the manager takes: a file, or a file with the hunks that are ticked when not all of them are. */
export function toSelection(files: ChangeFile[], state: SelectionState): ChangeSelection[] {
  const out: ChangeSelection[] = [];
  for (const f of files) {
    const s = state[f.path] ?? [];
    if (!s.some(Boolean)) continue;
    if (f.hunkSelectable && !s.every(Boolean)) {
      out.push({ path: f.path, hunks: s.flatMap((on, i) => (on ? [i] : [])) });
    } else {
      out.push({ path: f.path });
    }
  }
  return out;
}

export function selectedFlagged(files: ChangeFile[], state: SelectionState): ChangeFile[] {
  return files.filter((f) => f.needsConfirmation && isSelected(state, f));
}

/** Flagged files that are not selected (the bottom bar says they were left out). */
export function unselectedFlagged(files: ChangeFile[], state: SelectionState): ChangeFile[] {
  return files.filter((f) => f.needsConfirmation && f.applicable && !isSelected(state, f));
}

export const BADGE_TONE: Record<ChangeBadge, 'warn' | 'danger' | 'info' | 'neutral'> = {
  dependency: 'warn',
  executable: 'danger',
  flagged: 'danger',
  symlink: 'danger',
  binary: 'info',
  large: 'info',
};

// -- layout of a hunk ----------------------------------------------------------------------------

export interface Cell {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}
export interface Row {
  left?: Cell;
  right?: Cell;
}

/**
 * Pairs the lines of a hunk for two columns: context lines on both sides, a run of removed lines next
 * to the run of added lines that follows it (blank where one side is longer). `\ No newline` markers are
 * attached to the line they belong to.
 */
export function sideBySide(lines: string[]): Row[] {
  const rows: Row[] = [];
  let dels: Cell[] = [];
  let adds: Cell[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const row: Row = {};
      if (dels[i]) row.left = dels[i] as Cell;
      if (adds[i]) row.right = adds[i] as Cell;
      rows.push(row);
    }
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    const c = l.charAt(0);
    const text = l.slice(1);
    if (c === '-') {
      if (adds.length > 0) flush();
      dels.push({ kind: 'del', text });
    } else if (c === '+') {
      adds.push({ kind: 'add', text });
    } else if (c === ' ') {
      flush();
      rows.push({ left: { kind: 'ctx', text }, right: { kind: 'ctx', text } });
    } else {
      // "\ No newline at end of file": shown as a note row of its own
      flush();
      const note: Cell = { kind: 'ctx', text: l };
      rows.push({ left: note, right: note });
    }
  }
  flush();
  return rows;
}
