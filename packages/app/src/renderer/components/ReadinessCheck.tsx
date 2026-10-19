import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import type { ScopedDoctorReport } from '../../shared/types';
import { safeInline } from '../../shared/format';
import { CheckItem, DoctorBanner } from './DoctorChecks';
import { Dialog, ErrorBox, Loading } from './ui';

/** What the readiness check looks at: a template (on a host, default this computer) or a host. */
export type ReadinessTarget =
  | { kind: 'template'; template: string; host?: string; projectDir?: string }
  | { kind: 'host'; host: string };

/**
 * "Can I run this?": the scoped readiness check of a template or a host (`abox doctor --for`) in a dialog.
 * It shows the checks the way the Diagnostics view does. Read-only: the manager only looks (engine, disk space,
 * policy), it builds, pulls and starts nothing, so it runs on opening and again on request.
 */
export function ReadinessDialog(props: { target: ReadinessTarget; onClose(): void }) {
  const { t } = useApp();
  const [report, setReport] = useState<ScopedDoctorReport | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(true);
  const alive = useRef(true);
  const { target } = props;

  const run = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('doctor:for', target);
      if (alive.current) setReport(r);
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [target]);

  useEffect(() => {
    alive.current = true;
    void run();
    return () => {
      alive.current = false;
    };
    // once when the dialog opens; "Check again" runs it on request
  }, []);

  const title =
    target.kind === 'template'
      ? t('ready.title.template', { name: safeInline(target.template, 80) })
      : t('ready.title.host', { host: safeInline(target.host, 80) });
  return (
    <Dialog
      title={title}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose} autoFocus>
            {t('common.close')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run()}>
            {t('ready.again')}
          </button>
        </>
      }
    >
      <p className="muted">
        {t(target.kind === 'template' ? 'ready.hint.template' : 'ready.hint.host')}
      </p>
      {busy && !report ? <Loading /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {report ? (
        <div aria-live="polite" aria-busy={busy}>
          <DoctorBanner report={report} ready />
          <ul className="checks" data-testid="ready-checks">
            {report.checks.map((c) => (
              <CheckItem key={c.id} check={c} />
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  );
}
