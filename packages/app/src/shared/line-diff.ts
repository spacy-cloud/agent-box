/** Small line diff (LCS) for the policy change preview. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim common prefix/suffix, then LCS on the rest (policy files are small).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const mid: DiffLine[] = [];
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) {
    // pathological size: show as replace
    for (const t of x) mid.push({ kind: 'del', text: t });
    for (const t of y) mid.push({ kind: 'add', text: t });
  } else {
    const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        mid.push({ kind: 'same', text: x[i]! });
        i++;
        j++;
      } else if (L[i + 1]![j]! >= L[i]![j + 1]!) {
        mid.push({ kind: 'del', text: x[i]! });
        i++;
      } else {
        mid.push({ kind: 'add', text: y[j]! });
        j++;
      }
    }
    while (i < n) mid.push({ kind: 'del', text: x[i++]! });
    while (j < m) mid.push({ kind: 'add', text: y[j++]! });
  }
  return [
    ...a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text })),
    ...mid,
    ...a.slice(endA).map((text): DiffLine => ({ kind: 'same', text })),
  ];
}

export function hasChanges(d: DiffLine[]): boolean {
  return d.some((l) => l.kind !== 'same');
}
