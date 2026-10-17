import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { DirEntry } from '@abox/core';
import { useT } from '../context';
import { formatBytes, formatTimestamp, safeInline } from '../../shared/format';

/** Entries shown per folder; a bigger folder says how many are left out instead of freezing the view. */
export const TREE_MAX_ENTRIES = 1000;

export interface TreeSelection {
  /** Path relative to the workspace root (`''` = the root). */
  path: string;
  /** `null` for the root. */
  entry: DirEntry | null;
}

type Listing =
  { state: 'loading' } | { state: 'ok'; entries: DirEntry[] } | { state: 'error'; message: string };

type Row =
  | {
      kind: 'node';
      path: string;
      level: number;
      entry: DirEntry | null;
      parent: string | null;
      pos: number;
      size: number;
    }
  | {
      kind: 'note';
      key: string;
      level: number;
      text: 'loading' | 'empty' | 'more' | 'error';
      extra?: string;
    };

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * The workspace of a sandbox as a tree (WAI-ARIA tree pattern, one tab stop):
 * folders open on demand, each listing is fetched once through `load` (the manager's `listDir`) when the
 * folder is first opened. Up/Down move, Right opens a folder or enters it, Left closes it or leaves it,
 * Home/End jump, Enter opens or closes a folder. File names come from the sandbox (an agent wrote them) and
 * are shown as neutralised text.
 */
export function FileTree(props: {
  load(path: string): Promise<DirEntry[]>;
  /** Changes when the listing should be fetched again (refresh button, copy in). */
  reloadKey: number;
  rootLabel: string;
  label: string;
  onSelect(sel: TreeSelection): void;
}) {
  const t = useT();
  const { load, onSelect, reloadKey } = props;
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(['']));
  const [active, setActive] = useState('');
  const refs = useRef(new Map<string, HTMLElement>());
  const wantFocus = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const fetchDir = useCallback((path: string, generation: number) => {
    setListings((l) => ({ ...l, [path]: { state: 'loading' } }));
    loadRef.current(path).then(
      (entries) => {
        if (generation !== seq.current) return;
        setListings((l) => ({ ...l, [path]: { state: 'ok', entries } }));
      },
      (e: unknown) => {
        if (generation !== seq.current) return;
        const message = e instanceof Error ? e.message : String(e);
        setListings((l) => ({ ...l, [path]: { state: 'error', message } }));
      },
    );
  }, []);

  // (Re)start: forget everything that was fetched, open the root again.
  useEffect(() => {
    seq.current++;
    setListings({});
    setOpen(new Set(['']));
    setActive('');
    fetchDir('', seq.current);
  }, [reloadKey, fetchDir]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (
      path: string,
      entry: DirEntry | null,
      level: number,
      parent: string | null,
      pos: number,
      size: number,
    ) => {
      out.push({ kind: 'node', path, level, entry, parent, pos, size });
      const isDir = entry === null || entry.type === 'dir';
      if (!isDir || !open.has(path)) return;
      const l = listings[path];
      if (!l || l.state === 'loading') {
        out.push({ kind: 'note', key: `${path}\0loading`, level: level + 1, text: 'loading' });
      } else if (l.state === 'error') {
        out.push({
          kind: 'note',
          key: `${path}\0error`,
          level: level + 1,
          text: 'error',
          extra: l.message,
        });
      } else if (l.entries.length === 0) {
        out.push({ kind: 'note', key: `${path}\0empty`, level: level + 1, text: 'empty' });
      } else {
        const sorted = [...l.entries].sort(
          (a, b) =>
            Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name),
        );
        const shown = sorted.slice(0, TREE_MAX_ENTRIES);
        shown.forEach((e, i) => walk(join(path, e.name), e, level + 1, path, i + 1, shown.length));
        if (sorted.length > shown.length) {
          out.push({
            kind: 'note',
            key: `${path}\0more`,
            level: level + 1,
            text: 'more',
            extra: String(sorted.length - shown.length),
          });
        }
      }
    };
    walk('', null, 1, null, 1, 1);
    return out;
  }, [listings, open]);

  const nodes = rows.filter((r): r is Extract<Row, { kind: 'node' }> => r.kind === 'node');

  const select = useCallback(
    (path: string, entry: DirEntry | null, focus: boolean) => {
      setActive(path);
      wantFocus.current = focus;
      onSelect({ path, entry });
    },
    [onSelect],
  );

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    refs.current.get(active)?.focus();
  }, [active, rows]);

  function expand(path: string) {
    setOpen((o) => new Set(o).add(path));
    if (!listings[path] || listings[path]!.state === 'error') fetchDir(path, seq.current);
  }
  function collapse(path: string) {
    setOpen((o) => {
      const n = new Set(o);
      n.delete(path);
      return n;
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = nodes.findIndex((n) => n.path === active);
    const cur = nodes[i];
    if (!cur) return;
    const go = (n: (typeof nodes)[number] | undefined) => {
      if (n) select(n.path, n.entry, true);
    };
    const isDir = cur.entry === null || cur.entry.type === 'dir';
    switch (e.key) {
      case 'ArrowDown':
        go(nodes[Math.min(i + 1, nodes.length - 1)]);
        break;
      case 'ArrowUp':
        go(nodes[Math.max(i - 1, 0)]);
        break;
      case 'Home':
        go(nodes[0]);
        break;
      case 'End':
        go(nodes[nodes.length - 1]);
        break;
      case 'ArrowRight':
        if (!isDir) return;
        if (!open.has(cur.path)) expand(cur.path);
        else go(nodes[i + 1]?.parent === cur.path ? nodes[i + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (isDir && open.has(cur.path) && cur.path !== '') collapse(cur.path);
        else go(nodes.find((n) => n.path === cur.parent));
        break;
      case 'Enter':
        if (!isDir || cur.path === '') return;
        if (open.has(cur.path)) collapse(cur.path);
        else expand(cur.path);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div role="tree" aria-label={props.label} className="file-tree" onKeyDown={onKeyDown}>
      {rows.map((r) => {
        if (r.kind === 'note') {
          return (
            <div
              key={r.key}
              role="treeitem"
              aria-level={r.level}
              aria-selected={false}
              aria-disabled="true"
              className="tree-note muted small"
              style={{ paddingLeft: `${r.level * 1.1}rem` }}
            >
              {r.text === 'error'
                ? t('tree.error', { message: safeInline(r.extra ?? '', 200) })
                : r.text === 'more'
                  ? t('tree.more', { count: r.extra ?? '0' })
                  : t(`tree.${r.text}`)}
            </div>
          );
        }
        const isDir = r.entry === null || r.entry.type === 'dir';
        const expanded = isDir ? open.has(r.path) : undefined;
        const name = r.entry === null ? props.rootLabel : safeInline(r.entry.name, 200);
        return (
          <div
            key={r.path}
            role="treeitem"
            ref={(el) => {
              if (el) refs.current.set(r.path, el);
              else refs.current.delete(r.path);
            }}
            tabIndex={r.path === active ? 0 : -1}
            aria-level={r.level}
            aria-posinset={r.pos}
            aria-setsize={r.size}
            aria-expanded={expanded}
            aria-selected={r.path === active}
            className={`tree-row${r.path === active ? ' selected' : ''}`}
            style={{ paddingLeft: `${(r.level - 1) * 1.1 + 0.4}rem` }}
            onFocus={() => {
              // focus that arrives by other means than our keys (assistive technology, script) moves the selection
              if (r.path !== active) select(r.path, r.entry, false);
            }}
            onClick={() => {
              select(r.path, r.entry, true);
              if (isDir && r.path !== '') (open.has(r.path) ? collapse : expand)(r.path);
            }}
          >
            <span className="tree-caret" aria-hidden="true">
              {isDir ? (expanded ? '▾' : '▸') : ' '}
            </span>
            <span className="tree-name plain">
              {name}
              {isDir && r.entry !== null ? '/' : ''}
              {r.entry?.type === 'symlink' ? (
                <span className="muted"> ({t('detail.files.symlink')})</span>
              ) : null}
            </span>
            {r.entry?.type === 'file' ? (
              <span className="tree-size muted small">{formatBytes(r.entry.size)}</span>
            ) : (
              <span className="tree-size" />
            )}
            {r.entry ? (
              <span className="tree-time muted small mono">{formatTimestamp(r.entry.mtimeMs)}</span>
            ) : (
              <span className="tree-time" />
            )}
          </div>
        );
      })}
    </div>
  );
}
