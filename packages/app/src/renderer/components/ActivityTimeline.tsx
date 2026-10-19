import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ActivityEntry, ActivityKind, ActivityOutcome } from '../../shared/types';
import { ACTIVITY_KINDS } from '../../shared/constants';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { formatBytes, formatDuration, formatTimestamp, safeInline } from '../../shared/format';
import { Badge, Banner, EmptyState, ErrorBox, Loading, Safe } from './ui';

/** Audit entries one page of the timeline looks at; "show older" asks for more, up to {@link MAX_PAGE}. */
const PAGE = 100;
const MAX_PAGE = 500;

const KIND_TONE: Record<ActivityKind, 'neutral' | 'info' | 'ok' | 'warn'> = {
  exec: 'info',
  file: 'neutral',
  network: 'info',
  approval: 'warn',
  lifecycle: 'neutral',
};

const OUTCOME_TONE: Record<Exclude<ActivityOutcome, 'ok'>, 'danger' | 'warn' | 'neutral'> = {
  denied: 'danger',
  error: 'danger',
  pending: 'warn',
  info: 'neutral',
};

/** Small line icons (decorative: the kind badge carries the meaning in text). */
function KindIcon(props: { kind: ActivityKind }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (props.kind) {
    case 'exec':
      return (
        <svg {...common}>
          <polyline points="3,5 7,8 3,11" />
          <line x1="8.5" y1="12" x2="13" y2="12" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M4 2h5l3 3v9H4z" />
          <polyline points="9,2 9,5 12,5" />
        </svg>
      );
    case 'network':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <ellipse cx="8" cy="8" rx="2.6" ry="6" />
          <line x1="2" y1="8" x2="14" y2="8" />
        </svg>
      );
    case 'approval':
      return (
        <svg {...common}>
          <path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z" />
          <polyline points="5.8,8 7.4,9.6 10.2,6.4" />
        </svg>
      );
    case 'lifecycle':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M6.6 5.6l3.6 2.4-3.6 2.4z" />
        </svg>
      );
  }
}

/** The catalog key of the action's label (the proxy's two decisions are two labels). */
function labelKey(e: ActivityEntry): string {
  if (e.action === 'network.egress')
    return `activity.action.network.egress.${e.outcome === 'denied' ? 'deny' : 'allow'}`;
  return `activity.action.${e.action}`;
}

function detailValue(key: string, v: string | number | boolean, t: (k: string) => string): string {
  if (typeof v === 'boolean') return t(v ? 'common.yes' : 'common.no');
  if (key === 'durationMs' && typeof v === 'number') return formatDuration(v);
  if ((key === 'size' || key === 'returnedBytes') && typeof v === 'number')
    return `${formatBytes(v)} (${v})`;
  return String(v);
}

function TimelineItem(props: { e: ActivityEntry }) {
  const { t, navigate } = useApp();
  const { e } = props;
  const label = t(labelKey(e));
  const code = e.detail['exitCode'];
  const rows = Object.entries(e.detail);
  const keyLabel = (k: string): string => {
    const text = t(`activity.detail.${k}`);
    return text === `activity.detail.${k}` ? safeInline(k, 40) : text;
  };
  const facts: Array<[string, ReactNode]> = [
    [
      t('audit.col.action'),
      <code key="a">
        <Safe text={e.action} max={80} />
      </code>,
    ],
    [t('audit.col.actor'), <Safe key="b" text={e.actor} max={80} />],
    ...(e.subject !== undefined
      ? ([[t('activity.detail.subject'), <Safe key="c" text={e.subject} max={500} />]] as Array<
          [string, ReactNode]
        >)
      : []),
    ...(e.count > 1 && e.from !== undefined
      ? ([
          [
            t('activity.detail.span'),
            <span key="d" className="mono">
              {formatTimestamp(e.from)} – {formatTimestamp(e.ts)}
            </span>,
          ],
        ] as Array<[string, ReactNode]>)
      : []),
    ...rows.map(
      ([k, v]) =>
        [keyLabel(k), <Safe key={k} text={detailValue(k, v, t)} max={500} />] as [
          string,
          ReactNode,
        ],
    ),
    [
      '#',
      <span key="e" className="mono">
        {e.seq}
      </span>,
    ],
  ];
  return (
    <li className={`timeline-item timeline-${e.outcome}`}>
      <span className={`timeline-dot timeline-dot-${e.kind}`}>
        <KindIcon kind={e.kind} />
      </span>
      <div className="timeline-body">
        <div className="timeline-head">
          <time className="mono nowrap" dateTime={new Date(e.ts).toISOString()}>
            {formatTimestamp(e.ts)}
          </time>
          <Badge tone={KIND_TONE[e.kind]}>{t(`activity.kind.${e.kind}`)}</Badge>
          {e.outcome !== 'ok' ? (
            <Badge tone={OUTCOME_TONE[e.outcome]}>{t(`activity.outcome.${e.outcome}`)}</Badge>
          ) : null}
          {typeof code === 'number' && code !== 0 ? (
            <Badge tone="warn">{t('activity.exit', { code })}</Badge>
          ) : null}
          {e.count > 1 ? (
            <Badge tone="neutral">{t('activity.repeat', { count: e.count })}</Badge>
          ) : null}
        </div>
        <p className="timeline-summary">
          <strong>{label}</strong>
          {e.subject !== undefined ? (
            <>
              {': '}
              <code>
                <Safe text={e.subject} max={160} />
              </code>
            </>
          ) : null}
          {typeof code === 'number' && code === 0 ? (
            <span className="muted"> ({t('activity.exit', { code })})</span>
          ) : null}
        </p>
        <details className="timeline-details">
          <summary>{t('activity.details')}</summary>
          <dl className="timeline-kv">
            {facts.map(([k, node]) => (
              <div key={k} className="timeline-row">
                <dt>{k}</dt>
                <dd>{node}</dd>
              </div>
            ))}
          </dl>
        </details>
        {e.approvalId ? (
          <p className="timeline-links">
            <button
              type="button"
              className="linklike"
              onClick={() => navigate({ view: 'approvals', approvalId: e.approvalId })}
            >
              {t('activity.openApproval')}
            </button>
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The "Aktivität" tab of a sandbox: what happened there (commands, files, network decisions, approvals,
 * lifecycle), newest first, from the audit log. The manager derives every entry (`activity:list`); this view only
 * filters by kind, pages ("show older" asks for a longer page, at most 500 audit entries) and links approvals to the
 * approvals view. Live: refetched every few seconds and on every change tick, like the network tab.
 * `initialKinds` lets a link open the tab with a filter.
 */
export function ActivityTimeline(props: { id: string; initialKinds?: string[] }) {
  const { t } = useApp();
  const [kinds, setKinds] = useState<ActivityKind[]>(
    (props.initialKinds ?? []).filter((k): k is ActivityKind =>
      (ACTIVITY_KINDS as readonly string[]).includes(k),
    ),
  );
  const [size, setSize] = useState(PAGE);
  const q = useQuery(
    'activity:list',
    { id: props.id, limit: size, ...(kinds.length > 0 ? { kinds } : {}) },
    { pollMs: 4000 },
  );

  const toggle = (k: ActivityKind): void =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const view = q.data;
  const filtered = kinds.length > 0;

  return (
    <>
      <p className="muted">{t('activity.intro')}</p>
      <div className="timeline-filter" role="group" aria-label={t('activity.filter')}>
        <button
          type="button"
          className="chip-toggle"
          aria-pressed={!filtered}
          onClick={() => setKinds([])}
        >
          {t('activity.filter.all')}
        </button>
        {ACTIVITY_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="chip-toggle"
            aria-pressed={kinds.includes(k)}
            onClick={() => toggle(k)}
          >
            <KindIcon kind={k} /> {t(`activity.kind.${k}`)}
          </button>
        ))}
      </div>
      {q.error ? <ErrorBox error={q.error} /> : null}
      {view.entries.length === 0 && !view.nextCursor ? (
        filtered ? (
          <p className="muted">{t('activity.empty.filtered')}</p>
        ) : (
          <EmptyState title={t('activity.empty.title')} text={t('activity.empty.text')} />
        )
      ) : (
        <ol className="timeline" aria-label={t('activity.list')}>
          {view.entries.map((e) => (
            <TimelineItem key={e.seq} e={e} />
          ))}
        </ol>
      )}
      {view.nextCursor ? (
        size < MAX_PAGE ? (
          <p>
            <button type="button" onClick={() => setSize((s) => Math.min(MAX_PAGE, s * 2))}>
              {t('activity.more')}
            </button>
          </p>
        ) : (
          <Banner tone="info">{t('activity.limit', { count: MAX_PAGE })}</Banner>
        )
      ) : null}
    </>
  );
}
