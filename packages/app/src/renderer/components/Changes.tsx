import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ApplyChangesResult, ChangeFile, ChangeHunk, ChangesView } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import type { TFn } from '../i18n';
import { Badge, Banner, Dialog, ErrorBox, Loading } from './ui';
import { safeInline, safeText } from '../../shared/format';
import {
  BADGE_TONE,
  fileCheck,
  initialSelection,
  selectedFlagged,
  setFile,
  setHunk,
  sideBySide,
  summarize,
  toSelection,
  unselectedFlagged,
} from '../../shared/changes';
import type { Cell, SelectionState } from '../../shared/changes';

/** Rows (side by side) or lines (unified) shown per file before "Show more". */
const ROW_CAP = 400;
const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

type Layout = 'side' | 'unified';

/**
 * "Changes" tab: the sandbox's changes as files and hunks, side by side or unified, with per-file and
 * per-hunk selection. The component only holds ticks; the digest of the reviewed diff and the ids of the
 * selection go to the manager, which recomputes the diff, builds the patch and decides (the renderer never
 * sends patch text or a target path).
 */
export function ChangesTab(props: { id: string; onCount?: (n: number | null) => void }) {
  const { t, notify } = useApp();
  const headId = useId();
  const [view, setView] = useState<ChangesView | null>(null);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<SelectionState>({});
  const [active, setActive] = useState<string>();
  const [layout, setLayout] = useState<Layout>('side');
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState(false);
  const onCount = useRef(props.onCount);
  onCount.current = props.onCount;

  const load = useCallback(
    async (keep: Set<string> = new Set()) => {
      setLoading(true);
      setError(undefined);
      try {
        const v = await call('changes:review', { id: props.id });
        const dirty = new Set(v.target.dirtyPaths);
        const init = initialSelection(v.files);
        for (const f of v.files) {
          if (dirty.has(f.path) || dirty.has(f.oldPath ?? ''))
            init[f.path] = init[f.path]!.map(() => false);
        }
        // files that were just applied stay deselected: the project has them now
        for (const p of keep) if (init[p]) init[p] = init[p].map(() => false);
        setView(v);
        setSel(init);
        setApplied(keep);
        setActive((cur) => (cur && v.files.some((f) => f.path === cur) ? cur : v.files[0]?.path));
        onCount.current?.(v.files.length);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [props.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const files = view?.files ?? [];
  const dirty = useMemo(() => new Set(view?.target.dirtyPaths ?? []), [view]);
  const blocked = (f: ChangeFile): boolean =>
    !f.applicable || applied.has(f.path) || dirty.has(f.path) || dirty.has(f.oldPath ?? '');
  const summary = summarize(files, sel);
  const flaggedOut = view ? unselectedFlagged(files, sel).length > 0 : false;
  const current = files.find((f) => f.path === active);
  const canApply =
    view !== null && view.target.kind !== 'unavailable' && summary.files > 0 && !loading;
  const dirtyShown = files.filter((f) => dirty.has(f.path) || dirty.has(f.oldPath ?? ''));

  async function savePatch() {
    if (!view) return;
    try {
      const r = await call('changes:savePatch', {
        id: props.id,
        digest: view.digest,
        selection: toSelection(files, sel),
      });
      if (r.saved) notify('ok', t('changes.patchSaved', { path: r.saved }));
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  if (error && !view) {
    return (
      <>
        <ErrorBox error={error} />
        <p>
          <button type="button" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </p>
      </>
    );
  }
  if (!view) return <Loading />;

  return (
    <div className="changes" data-testid="changes">
      <p className="muted">{t('changes.intro')}</p>
      <div className="actions">
        <button type="button" onClick={() => void load()} disabled={loading}>
          {t('changes.reload')}
        </button>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {view.target.kind === 'unavailable' ? (
        <Banner tone="info">
          {t('changes.target.unavailable', {
            message: t(`changes.unavailable.${view.target.reason ?? 'no_source'}`),
          })}
        </Banner>
      ) : null}
      {dirtyShown.length > 0 ? (
        <Banner tone="warn">
          {t('changes.dirtyBanner', {
            paths: dirtyShown.map((f) => safeInline(f.path, 80)).join(', '),
          })}
        </Banner>
      ) : null}
      {view.warnings.map((w, i) => (
        <Banner key={i} tone="warn">
          <span className="plain">{safeInline(w, 400)}</span>
        </Banner>
      ))}
      {view.notices.length > 0 ? (
        <Banner tone="danger">
          <strong>{t('changes.notices')}</strong>
          <ul>
            {view.notices.map((n, i) => (
              <li key={i} className="plain">
                <code>{safeInline(n.path, 160)}</code> – {safeInline(n.reason, 300)}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {files.length === 0 ? (
        <p className="muted">{t('changes.empty')}</p>
      ) : (
        <div className="changes-grid">
          <section className="card changes-files" aria-labelledby={headId}>
            <h2 id={headId} className="h-small">
              {t('changes.files')}
            </h2>
            <ul className="plain-list" aria-label={t('changes.fileList')}>
              {files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  check={fileCheck(sel, f)}
                  blocked={blocked(f)}
                  isApplied={applied.has(f.path)}
                  isDirty={dirty.has(f.path) || dirty.has(f.oldPath ?? '')}
                  active={f.path === active}
                  hunksSelected={(sel[f.path] ?? []).filter(Boolean).length}
                  onToggle={(on) => setSel((s) => setFile(s, f, on))}
                  onShow={() => setActive(f.path)}
                />
              ))}
            </ul>
            {view.ignored ? (
              <p className="muted small plain">
                {t('changes.ignored', {
                  paths: view.ignored.paths.map((p) => safeInline(p, 60)).join(', '),
                  count: view.ignored.count,
                })}
              </p>
            ) : null}
          </section>
          <section
            className="card changes-diff"
            aria-label={t('changes.fileHeading', { path: safeInline(active ?? '', 120) })}
          >
            {current ? (
              <FileDiff
                key={current.path}
                file={current}
                state={sel[current.path] ?? []}
                blocked={blocked(current)}
                layout={layout}
                onLayout={setLayout}
                onHunk={(i, on) => setSel((s) => setHunk(s, current, i, on))}
              />
            ) : (
              <p className="muted">{t('changes.pick')}</p>
            )}
          </section>
        </div>
      )}

      <div className="card changes-bar" role="region" aria-label={t('changes.title')}>
        <div>
          <p className="changes-summary" aria-live="polite" data-testid="changes-summary">
            <strong>
              {t('changes.summary', { files: summary.files, total: summary.total })},{' '}
              {t('changes.hunksSelected', { count: summary.hunks })}
            </strong>
          </p>
          <p className="muted small plain" data-testid="changes-target">
            {targetText(view, dirtyShown.length, t)}
            {flaggedOut ? ` · ${t('changes.flaggedLeftOut')}` : ''}
          </p>
        </div>
        <div className="actions">
          <button type="button" disabled={summary.files === 0} onClick={() => void savePatch()}>
            {t('changes.savePatch')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canApply}
            onClick={() => setDialog(true)}
          >
            {t('changes.apply')}
          </button>
        </div>
      </div>

      {dialog ? (
        <ApplyDialog
          id={props.id}
          view={view}
          selection={sel}
          onClose={() => setDialog(false)}
          onApplied={(r) => {
            setDialog(false);
            const done = new Set(r.plan.files.map((f) => f.path));
            notify(
              'ok',
              t('changes.applied', {
                files: r.plan.files.length,
                target: safeInline(r.plan.target, 120),
              }),
            );
            // the project changed: the dirty state of the target is stale
            void load(new Set([...applied, ...done]));
          }}
        />
      ) : null}
    </div>
  );
}

function targetText(view: ChangesView, dirtyCount: number, t: TFn): string {
  const tg = view.target;
  if (tg.kind === 'unavailable')
    return t('changes.target.unavailable', {
      message: t(`changes.unavailable.${tg.reason ?? 'no_source'}`),
    });
  const path = safeInline(tg.path ?? '', 160);
  const state =
    tg.kind === 'plain'
      ? t('changes.target.plain')
      : dirtyCount > 0
        ? t('changes.target.dirty', { count: dirtyCount })
        : t('changes.target.clean');
  return `${t('changes.target', { path })} ${state}`;
}

// -- file list ------------------------------------------------------------------------------------------

function FileRow(props: {
  file: ChangeFile;
  check: boolean | 'some';
  blocked: boolean;
  isApplied: boolean;
  isDirty: boolean;
  active: boolean;
  hunksSelected: number;
  onToggle(on: boolean): void;
  onShow(): void;
}) {
  const { t } = useApp();
  const f = props.file;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = props.check === 'some';
  }, [props.check]);
  const letter = STATUS_LETTER[f.status];
  return (
    <li className={`change-file${props.active ? ' active' : ''}`} data-testid="change-file">
      <input
        ref={box}
        type="checkbox"
        checked={props.check === true}
        disabled={props.blocked}
        aria-label={t('changes.selectFile', { path: safeInline(f.path, 160) })}
        onChange={(e) => props.onToggle(e.target.checked)}
      />
      <span className={`change-st st-${f.status}`} aria-hidden="true">
        {letter}
      </span>
      <div className="change-file-main">
        <button
          type="button"
          className="linklike change-file-name plain"
          aria-current={props.active ? 'true' : undefined}
          onClick={props.onShow}
        >
          {safeInline(f.path, 160)}
          <span className="sr-only"> ({t(`changes.status.${f.status}`)})</span>
        </button>
        <span className="muted small plain">
          {f.binary ? null : t('changes.lines', { add: f.insertions, del: f.deletions })}
          {f.hunks.length > 0 ? ` · ${t('changes.hunks', { count: f.hunks.length })}` : ''}
        </span>
        <span className="badges">
          {f.badges.map((b) => (
            <Badge
              key={b}
              tone={BADGE_TONE[b]}
              title={b === 'flagged' ? safeInline(f.flags.join('; '), 400) : undefined}
            >
              {t(`changes.badge.${b}`)}
            </Badge>
          ))}
          {props.isApplied ? <Badge tone="ok">{t('changes.badge.applied')}</Badge> : null}
          {props.isDirty && !props.isApplied ? (
            <Badge tone="warn">{t('changes.badge.local')}</Badge>
          ) : null}
        </span>
        {f.notApplicable ? (
          <span className="muted small plain">{t(`changes.na.${f.notApplicable}`)}</span>
        ) : null}
      </div>
    </li>
  );
}

// -- diff of one file -------------------------------------------------------------------------------

function FileDiff(props: {
  file: ChangeFile;
  state: boolean[];
  blocked: boolean;
  layout: Layout;
  onLayout(l: Layout): void;
  onHunk(i: number, on: boolean): void;
}) {
  const { t } = useApp();
  const f = props.file;
  const [shown, setShown] = useState(ROW_CAP);
  let budget = shown;
  const total = f.hunks.reduce((n, h) => n + (h.lines?.length ?? 0), 0);
  return (
    <>
      <div className="changes-diff-head">
        <h2 className="h-small plain">{safeInline(f.path, 200)}</h2>
        <div className="seg" role="group" aria-label={t('changes.view.label')}>
          <button
            type="button"
            aria-pressed={props.layout === 'side'}
            onClick={() => props.onLayout('side')}
          >
            {t('changes.view.side')}
          </button>
          <button
            type="button"
            aria-pressed={props.layout === 'unified'}
            onClick={() => props.onLayout('unified')}
          >
            {t('changes.view.unified')}
          </button>
        </div>
      </div>
      {f.oldPath ? (
        <p className="muted small plain">
          {safeInline(f.oldPath, 200)} → {safeInline(f.path, 200)}
        </p>
      ) : null}
      {f.oldMode && f.mode && f.oldMode !== f.mode ? (
        <p className="muted small plain">
          {t('changes.modeChange', { old: f.oldMode, new: f.mode })}
        </p>
      ) : null}
      {f.flags.length > 0 ? (
        <Banner tone="warn">
          <strong>{t('changes.flagReasons')}</strong>
          <ul>
            {f.flags.map((r, i) => (
              <li key={i} className="plain">
                {safeInline(r, 300)}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {f.kind === 'symlink' && f.symlinkTarget !== undefined ? (
        <p className="plain">
          {t('changes.symlinkTo', { target: safeInline(f.symlinkTarget, 300) })}
        </p>
      ) : null}
      {f.contentOmitted ? (
        <p className="muted">
          {f.binary ? t('changes.omitted.binary') : t('changes.omitted.large')}
        </p>
      ) : f.hunks.length === 0 && f.kind !== 'symlink' ? (
        <p className="muted">{t('changes.noLines')}</p>
      ) : null}
      {f.hunks.map((h) => {
        const lines = h.lines ?? [];
        const take = Math.max(0, Math.min(lines.length, budget));
        budget -= take;
        return (
          <Hunk
            key={h.index}
            hunk={h}
            lines={lines.slice(0, take)}
            layout={props.layout}
            selectable={f.hunkSelectable && !props.blocked}
            showBox={f.hunkSelectable}
            checked={props.state[h.index] === true}
            onChange={(on) => props.onHunk(h.index, on)}
          />
        );
      })}
      {total > shown ? (
        <p>
          <button type="button" onClick={() => setShown((n) => n + ROW_CAP * 2)}>
            {t('changes.more', { count: total - shown })}
          </button>
        </p>
      ) : null}
    </>
  );
}

function Hunk(props: {
  hunk: ChangeHunk;
  lines: string[];
  layout: Layout;
  selectable: boolean;
  showBox: boolean;
  checked: boolean;
  onChange(on: boolean): void;
}) {
  const { t } = useApp();
  const header = safeInline(props.hunk.header, 300);
  const rows = useMemo(
    () => (props.layout === 'side' ? sideBySide(props.lines) : []),
    [props.lines, props.layout],
  );
  return (
    <div className="hunk" data-testid="hunk">
      <div className="hunk-head">
        <code className="plain">{header}</code>
        {props.showBox ? (
          <label className="inline-check">
            <input
              type="checkbox"
              checked={props.checked}
              disabled={!props.selectable}
              aria-label={t('changes.hunk.aria', { header })}
              onChange={(e) => props.onChange(e.target.checked)}
            />{' '}
            {t('changes.hunk.take')}
          </label>
        ) : null}
      </div>
      {props.layout === 'side' ? (
        <div
          className="sbs"
          role="group"
          tabIndex={0}
          aria-label={t('changes.hunk.label', { header })}
        >
          {rows.map((r, i) => (
            <div className="sbs-row" key={i}>
              <CellView cell={r.left} />
              <CellView cell={r.right} />
            </div>
          ))}
        </div>
      ) : (
        <pre
          className="diff plain unified"
          tabIndex={0}
          aria-label={t('changes.hunk.label', { header })}
        >
          {props.lines.map((l, i) => (
            <span
              key={i}
              className={l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : ''}
            >
              {safeText(l)}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function CellView(props: { cell: Cell | undefined }) {
  const c = props.cell;
  if (!c) return <span className="sbs-cell sbs-empty" />;
  return (
    <span className={`sbs-cell sbs-${c.kind}`}>
      <span className="sbs-mark" aria-hidden="true">
        {c.kind === 'add' ? '+' : c.kind === 'del' ? '-' : ' '}
      </span>
      {safeText(c.text)}
    </span>
  );
}

// -- summary dialog ---------------------------------------------------------------------------------

function ApplyDialog(props: {
  id: string;
  view: ChangesView;
  selection: SelectionState;
  onClose(): void;
  onApplied(r: ApplyChangesResult): void;
}) {
  const { t } = useApp();
  const files = props.view.files;
  const flagged = selectedFlagged(files, props.selection);
  const plain = props.view.target.kind === 'plain';
  const selection = useMemo(() => toSelection(files, props.selection), [files, props.selection]);
  const [phase, setPhase] = useState<'checking' | 'ready' | 'error' | 'applying'>('checking');
  const [plan, setPlan] = useState<ApplyChangesResult['plan']>();
  const [error, setError] = useState<unknown>();
  const [ackFlagged, setAckFlagged] = useState(false);
  const [ackPlain, setAckPlain] = useState(false);
  const flaggedPaths = flagged.map((f) => f.path);

  // All checks run first (dry run: nothing is written), so the dialog shows what the manager will do
  // and refusals (dirty files, a changed sandbox, a patch that does not apply) come before the question.
  useEffect(() => {
    let live = true;
    call('changes:apply', {
      id: props.id,
      digest: props.view.digest,
      selection,
      ...(flaggedPaths.length > 0 ? { acknowledgeFlagged: flaggedPaths } : {}),
      ...(plain ? { allowNonGit: true } : {}),
      dryRun: true,
    }).then(
      (r) => {
        if (!live) return;
        setPlan(r.plan);
        setPhase('ready');
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setPhase('error');
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const ready = phase === 'ready' && (flagged.length === 0 || ackFlagged) && (!plain || ackPlain);

  async function confirm() {
    setPhase('applying');
    try {
      const r = await call('changes:apply', {
        id: props.id,
        digest: props.view.digest,
        selection,
        ...(flaggedPaths.length > 0 ? { acknowledgeFlagged: flaggedPaths } : {}),
        ...(plain ? { allowNonGit: true } : {}),
        confirmed: true,
      });
      if (r.status === 'applied') props.onApplied(r);
      else {
        setError(new Error(r.message));
        setPhase('error');
      }
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  }

  return (
    <Dialog
      title={t('changes.dialog.title')}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose} autoFocus>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => void confirm()}
          >
            {t('changes.dialog.confirm')}
          </button>
        </>
      }
    >
      {phase === 'checking' ? <p className="muted">{t('changes.dialog.checking')}</p> : null}
      {phase === 'error' ? (
        <>
          <ErrorBox error={error} />
          {(error as { details?: { stale?: boolean } } | undefined)?.details?.stale ? (
            <p>{t('changes.dialog.stale')}</p>
          ) : null}
        </>
      ) : null}
      {plan && phase !== 'error' ? (
        <>
          <p className="plain" data-testid="apply-summary">
            {t('changes.dialog.summary', {
              files: plan.files.length,
              hunks: plan.hunks,
              add: plan.insertions,
              del: plan.deletions,
              target: safeInline(plan.target, 200),
            })}
          </p>
          <ul className="plain-list apply-files" aria-label={t('changes.dialog.files')}>
            {plan.files.map((f) => (
              <li key={f.path} className="plain">
                <span className={`change-st st-${f.status}`} aria-hidden="true">
                  {STATUS_LETTER[f.status]}
                </span>{' '}
                <code>{safeInline(f.path, 200)}</code>{' '}
                <span className="muted small">
                  {t('changes.lines', { add: f.insertions, del: f.deletions })}
                  {f.totalHunks > 1 ? ` · ${f.hunks}/${f.totalHunks}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">{t('changes.dialog.allOrNothing')}</p>
          {flagged.length > 0 ? (
            <Banner tone="danger">
              <strong>{t('changes.dialog.flaggedTitle')}</strong>
              <p>{t('changes.dialog.flaggedText')}</p>
              <ul>
                {flagged.map((f) => (
                  <li key={f.path} className="plain">
                    <code>{safeInline(f.path, 200)}</code> –{' '}
                    {safeInline(
                      f.flags.join('; ') || f.badges.map((b) => t(`changes.badge.${b}`)).join(', '),
                      300,
                    )}
                  </li>
                ))}
              </ul>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={ackFlagged}
                  onChange={(e) => setAckFlagged(e.target.checked)}
                />{' '}
                {t('changes.dialog.flaggedAck')}
              </label>
            </Banner>
          ) : null}
          {plain ? (
            <Banner tone="warn">
              <p>{t('changes.dialog.nonGit', { target: safeInline(plan.target, 200) })}</p>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={ackPlain}
                  onChange={(e) => setAckPlain(e.target.checked)}
                />{' '}
                {t('changes.dialog.nonGitAck')}
              </label>
            </Banner>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
