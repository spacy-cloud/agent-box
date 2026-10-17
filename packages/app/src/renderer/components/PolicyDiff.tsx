import { useMemo } from 'react';
import { diffLines, hasChanges } from '../../shared/line-diff';
import type { DiffLine } from '../../shared/line-diff';
import { safeText } from '../../shared/format';

/** Lines that are changed or within `ctx` lines of a change; the rest of the file is left out. */
export function nearChange(diff: Array<{ kind: string }>, i: number, ctx: number): boolean {
  for (let d = -ctx; d <= ctx; d++) {
    const x = diff[i + d];
    if (x && x.kind !== 'same') return true;
  }
  return false;
}

/** Line diff of two texts for a policy change: `+` / `-` stay visible as characters, the colour is only a hint. */
export function PolicyDiff(props: { lines: DiffLine[]; label: string }) {
  const shown = useMemo(
    () =>
      props.lines
        .map((l, i) => ({ l, i }))
        .filter(({ l, i }) => l.kind !== 'same' || nearChange(props.lines, i, 2)),
    [props.lines],
  );
  return (
    <pre className="diff plain" tabIndex={0} aria-label={props.label}>
      {shown.map(({ l, i }) => (
        <span
          key={i}
          className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}
        >
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
          {safeText(l.text)}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export { diffLines, hasChanges };
