import { useApp } from '../context';
import { Badge, Banner, Disclosure } from './ui';
import { safeText } from '../../shared/format';
import type { DoctorCheck, DoctorReport, DoctorSeverity } from '../../shared/types';

/** The severity of a check; a report from before severities existed only has `level`. */
export function severityOf(
  c: Pick<DoctorCheck, 'level'> & { severity?: DoctorSeverity },
): DoctorSeverity {
  return c.severity ?? (c.level === 'warn' ? 'warning' : c.level);
}

const SEVERITY_TONE: Record<DoctorSeverity, 'ok' | 'neutral' | 'warn' | 'danger'> = {
  ok: 'ok',
  info: 'neutral',
  warning: 'warn',
  error: 'danger',
};

export function SeverityBadge(props: { severity: DoctorSeverity }) {
  const { t } = useApp();
  return (
    <Badge tone={SEVERITY_TONE[props.severity]}>{t(`settings.severity.${props.severity}`)}</Badge>
  );
}

/**
 * The one-line verdict of a report. `ready`: the wording of the scoped readiness check ("Ready: ..."), for the
 * Diagnostics view the wording of the full diagnostics.
 */
export function DoctorBanner(props: {
  report: Pick<DoctorReport, 'ok' | 'summary' | 'checks'>;
  ready?: boolean;
}) {
  const { t } = useApp();
  const counts =
    props.report.summary ??
    props.report.checks.reduce((n, c) => ({ ...n, [severityOf(c)]: n[severityOf(c)] + 1 }), {
      ok: 0,
      info: 0,
      warning: 0,
      error: 0,
    } as Record<DoctorSeverity, number>);
  const k = props.ready ? 'ready' : 'settings.doctor';
  if (!props.report.ok || counts.error > 0)
    return (
      <Banner tone="warn">
        {props.ready ? t('ready.issues', { count: counts.error }) : t('settings.doctor.issues')}
      </Banner>
    );
  if (counts.warning > 0)
    return <Banner tone="warn">{t(`${k}.warnings`, { count: counts.warning })}</Banner>;
  return (
    <Banner tone="ok">
      {counts.info > 0 ? t(`${k}.okInfo`, { count: counts.info }) : t(`${k}.ok`)}
    </Banner>
  );
}

export function NoteList(props: { notes: NonNullable<DoctorCheck['notes']> }) {
  const { t } = useApp();
  return (
    <ul className="plain-list notes">
      {props.notes.map((n, i) => (
        <li key={i} className="plain small">
          <span aria-hidden="true" className={n.severity === 'warning' ? 'warn-text' : 'muted'}>
            {n.severity === 'warning' ? '!' : 'i'}
          </span>
          <span className="sr-only">{t(`settings.severity.${n.severity}`)}: </span>
          <span>{safeText(n.message)}</span>
        </li>
      ))}
    </ul>
  );
}

export function DetailLines(props: { lines: string[] }) {
  return (
    <ul className="plain-list detail-lines">
      {props.lines.map((l, i) => (
        <li key={i} className="plain muted small">
          {safeText(l)}
        </li>
      ))}
    </ul>
  );
}

export function detailLinesOf(c: DoctorCheck | undefined): string[] {
  return c?.details ?? (c?.detail ? c.detail.split(/\r?\n/) : []);
}

export function CheckItem(props: { check: DoctorCheck }) {
  const { t } = useApp();
  const c = props.check;
  const severity = severityOf(c);
  const lines = detailLinesOf(c);
  const notes = c.notes ?? [];
  // what needs a look is shown, the rest is one click away
  const open = severity === 'warning' || severity === 'error';
  return (
    <li>
      <SeverityBadge severity={severity} /> <strong className="plain">{c.title}</strong>
      {c.hint && severity !== 'ok' ? <div className="plain small">{c.hint}</div> : null}
      {lines.length > 0 ? (
        open ? (
          <DetailLines lines={lines} />
        ) : (
          <Disclosure label={t('settings.detailLines', { count: lines.length })}>
            <DetailLines lines={lines} />
          </Disclosure>
        )
      ) : null}
      {notes.length > 0 ? (
        <Disclosure label={t('settings.notes', { count: notes.length })}>
          <NoteList notes={notes} />
        </Disclosure>
      ) : null}
    </li>
  );
}
