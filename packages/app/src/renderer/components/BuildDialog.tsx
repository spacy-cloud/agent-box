import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import { runBuild, useBuildLog } from '../build-logs';
import { Badge, Banner, CopyButton, Dialog, ErrorBox } from './ui';
import { formatClock, formatDuration, safeText } from '../../shared/format';
import type { BuildLog } from '../../shared/build-log';

/** Seconds the build has been running, updated while it runs. */
function useElapsed(log: BuildLog | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const running = log?.status === 'running';
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return log
    ? Math.max(0, (running ? now : log.startedAt + (log.durationMs ?? 0)) - log.startedAt)
    : 0;
}

/**
 * The output of a build: scrollable (focusable by keyboard), follows the end while the human has not
 * scrolled up, bounded (the newest lines are kept, the count of dropped ones is shown).
 */
export function BuildLogView(props: { log: BuildLog }) {
  const { t } = useApp();
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const { log } = props;
  useEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTo({ top: el.scrollHeight });
  }, [log.lines.length]);
  return (
    <>
      {log.dropped > 0 ? (
        <p className="muted small" role="note">
          {t('tpl.build.dropped', { count: log.dropped })}
        </p>
      ) : null}
      <pre
        className="log plain"
        ref={ref}
        tabIndex={0}
        role="log"
        aria-label={t('tpl.build.log')}
        data-testid="build-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {log.lines.length > 0 ? log.lines.join('\n') : t('tpl.build.noOutput')}
      </pre>
    </>
  );
}

/**
 * Builds the image of a saved template and shows the build output live. The log of the last build of every
 * template is kept while the window is open: closing the dialog and opening it again shows it, with the
 * outcome and the duration. Credentials in the output are masked by the manager before they get here.
 */
export function BuildDialog(props: { name: string; onClose(): void }) {
  const { t, notify } = useApp();
  const log = useBuildLog(props.name);
  const [update, setUpdate] = useState(false);
  const [error, setError] = useState<unknown>();
  const running = log?.status === 'running';
  const elapsed = useElapsed(log);

  async function run(): Promise<void> {
    setError(undefined);
    try {
      await runBuild(props.name, update);
      notify('ok', t('tpl.build.done', { name: props.name }));
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Dialog
      title={t('tpl.build.title', { name: props.name })}
      onClose={() => !running && props.onClose()}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose} disabled={running} autoFocus={!!log}>
            {t('common.close')}
          </button>
          {log ? <CopyButton text={log.lines.join('\n')} label={t('tpl.build.copyLog')} /> : null}
          <button
            type="button"
            className="primary"
            disabled={running}
            onClick={() => void run()}
            autoFocus={!log}
          >
            {log && !running ? t('tpl.build.again') : t('tpl.build.start')}
          </button>
        </>
      }
    >
      {!running ? (
        <>
          <Banner tone="warn">{t('tpl.build.networkWarning')}</Banner>
          <label className="inline">
            <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
            {t('tpl.build.update')}
          </label>
        </>
      ) : null}
      {log ? (
        <>
          <h3 className="h-small">
            {t('tpl.build.last')}{' '}
            <Badge
              tone={log.status === 'done' ? 'ok' : log.status === 'failed' ? 'danger' : 'info'}
            >
              {t(`tpl.build.status.${log.status}`)}
            </Badge>
          </h3>
          <p className="muted small">
            {t('tpl.build.started', { time: formatClock(log.startedAt) })}
            {' · '}
            {running
              ? t('tpl.build.elapsed', { duration: formatDuration(elapsed) })
              : t('tpl.build.took', { duration: formatDuration(log.durationMs ?? 0) })}
            {log.update ? ` · ${t('tpl.build.updateUsed')}` : ''}
          </p>
          <p className="muted small">{t('tpl.build.redactedNote')}</p>
          <BuildLogView log={log} />
          {running ? <p role="status">{t('tpl.build.running')}</p> : null}
          {log.status === 'done' ? (
            <Banner tone="ok">
              {log.cached ? t('tpl.build.cached') : t('tpl.build.built')} ·{' '}
              <code className="plain">{safeText(log.image ?? '')}</code> ·{' '}
              {formatDuration(log.durationMs ?? 0)}
            </Banner>
          ) : null}
          {log.status === 'failed' ? (
            error ? (
              <>
                <Banner tone="danger" role="alert">
                  {t('tpl.build.failedAfter', { duration: formatDuration(log.durationMs ?? 0) })}
                </Banner>
                <ErrorBox error={error} />
              </>
            ) : (
              <Banner tone="danger" role="alert">
                {t('tpl.build.failedAfter', { duration: formatDuration(log.durationMs ?? 0) })}
                {': '}
                <span className="plain">{log.error}</span>
              </Banner>
            )
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
