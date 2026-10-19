import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApprovalView, HostCapacity, SandboxView } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useHostCapacity, useNow, useQuery } from '../hooks';
import type { CapacityState } from '../hooks';
import { Badge, ErrorBox, Safe } from '../components/ui';
import { kindLabel } from './Approvals';
import { NewSandboxDialog } from './NewSandbox';
import { barTone, liveBars } from '../../shared/capacity';
import type { BarTone } from '../../shared/capacity';
import { requestTemplateName } from '../../shared/approval-diff';
import { formatBytes, formatClock, formatTimestamp, safeInline } from '../../shared/format';
import { hostUtilisation } from '../../shared/host-usage';
import {
  OVERVIEW_ACTIVITY_LIMIT,
  activityBadge,
  activityText,
  approvalHeadline,
  expiringSoon,
  overviewHosts,
  problemCount,
  problemSandboxes,
  runningSandboxes,
  sandboxLabel,
} from '../../shared/overview-page';
import type { HostRow } from '../../shared/types';

/** Open approvals listed on the page; the rest is one click away in the approvals view. */
const MAX_APPROVALS = 5;
const ZONE_TONE = {
  workstation: 'neutral',
  lab: 'info',
  shared: 'warn',
  restricted: 'danger',
} as const;

/**
 * The start page: what runs, what waits for a decision, how busy the hosts are, what agents did lately and what the
 * diagnosis found. Every number comes from a call the other views make too (nothing new is measured here), and
 * "Allow" / "Deny" go through the same `approvals:approve` / `approvals:deny` as the approvals view.
 */
export function OverviewView() {
  const { t, navigate, notify } = useApp();
  const list = useQuery('sandboxes:list', {}, { pollMs: 4000 });
  const pending = useQuery('approvals:list', { status: 'pending' }, { pollMs: 3000 });
  const activity = useQuery(
    'activity:recent',
    { limit: OVERVIEW_ACTIVITY_LIMIT },
    { pollMs: 5000 },
  );
  // The doctor probes every backend (ssh hosts included): once a minute, and it never holds up the rest of the page.
  const doctor = useQuery('doctor:run', undefined, { live: false, pollMs: 60_000 });
  const hosts = useQuery('hosts:list', undefined, { pollMs: 10_000 });
  const [creating, setCreating] = useState(false);
  const now = useNow(10_000);

  const sandboxes = useMemo(() => list.data?.sandboxes ?? [], [list.data]);
  const byId = useMemo(() => new Map(sandboxes.map((s) => [s.id, s])), [sandboxes]);
  const asOf = [list.updatedAt, pending.updatedAt, activity.updatedAt]
    .filter((x): x is number => x !== undefined)
    .reduce<number | undefined>((m, x) => (m === undefined || x > m ? x : m), undefined);

  return (
    <section aria-labelledby="h-overview">
      <header className="page-head">
        <div>
          <h1 id="h-overview">{t('overview.title')}</h1>
          {asOf !== undefined ? (
            <p className="muted small" data-testid="as-of">
              {t('overview.asOf', { time: formatClock(asOf) })}
            </p>
          ) : null}
        </div>
        <div className="actions">
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            {t('sandboxes.new')}
          </button>
        </div>
      </header>

      {list.error ? <ErrorBox error={list.error} /> : null}

      <StatCards
        sandboxes={list.data ? sandboxes : undefined}
        pending={pending.data}
        doctor={doctor}
        now={now}
      />

      <div className="ov-columns">
        <HostsCard
          rows={hosts.data}
          error={hosts.error}
          sandboxes={sandboxes}
          unreachable={list.data?.unreachableHosts ?? []}
        />
        <ApprovalsCard
          approvals={pending.data}
          byId={byId}
          onChanged={() => {
            void pending.reload();
            void list.reload();
          }}
          notify={notify}
        />
      </div>

      <section className="card ov-wide" aria-labelledby="h-ov-activity">
        <h2 id="h-ov-activity">{t('overview.activity.title')}</h2>
        {activity.error ? <ErrorBox error={activity.error} /> : null}
        {activity.data && activity.data.length === 0 ? (
          <p className="muted">{t('overview.activity.empty')}</p>
        ) : null}
        {!activity.data && !activity.error ? (
          <p className="muted" role="status">
            {t('common.loading')}
          </p>
        ) : null}
        {activity.data && activity.data.length > 0 ? (
          <ul className="ov-activity">
            {activity.data.map((e) => {
              const text = activityText(e);
              const params = Object.fromEntries(
                Object.entries(text.params).map(([k, v]) => [
                  k,
                  typeof v === 'string' ? safeInline(v, 120) : v,
                ]),
              );
              const reason =
                e.outcome !== 'ok' ? safeInline(String(e.facts['reason'] ?? ''), 120) : '';
              const sb = e.sandboxId ? byId.get(e.sandboxId) : undefined;
              const badge = activityBadge(e);
              return (
                <li key={e.seq} data-testid="activity-row">
                  <time
                    className="mono muted"
                    dateTime={new Date(e.ts).toISOString()}
                    title={formatTimestamp(e.ts)}
                  >
                    {formatClock(e.ts).slice(0, 5)}
                  </time>
                  {e.sandboxId ? (
                    sb ? (
                      <button
                        type="button"
                        className="linklike plain ov-sb"
                        onClick={() => navigate({ view: 'detail', sandboxId: e.sandboxId! })}
                      >
                        {safeInline(sb.name, 40)}
                      </button>
                    ) : (
                      <span className="plain ov-sb">
                        {safeInline(sandboxLabel(e.sandboxId, byId), 40)}
                      </span>
                    )
                  ) : (
                    <span className="ov-sb muted">&mdash;</span>
                  )}
                  <span className="ov-sum" title={safeInline(e.actor, 80)}>
                    <Safe text={t(text.key, params) + (reason ? ` · ${reason}` : '')} max={200} />
                  </span>
                  <Badge
                    tone={
                      badge === 'blocked'
                        ? 'warn'
                        : badge === 'error'
                          ? 'danger'
                          : badge === 'export'
                            ? 'info'
                            : badge === 'pending'
                              ? 'warn'
                              : 'ok'
                    }
                  >
                    {t(`overview.badge.${badge}`)}
                  </Badge>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {creating ? (
        <NewSandboxDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void list.reload();
            navigate({ view: 'detail', sandboxId: id });
          }}
        />
      ) : null}
    </section>
  );
}

// -- the four numbers ---------------------------------------------------------------------------------------

function StatCards(props: {
  sandboxes: SandboxView[] | undefined;
  pending: ApprovalView[] | undefined;
  doctor: ReturnType<typeof useQuery<'doctor:run'>>;
  now: number;
}) {
  const { t, navigate } = useApp();
  const all = props.sandboxes;
  const running = all ? runningSandboxes(all) : [];
  const problems = all ? problemSandboxes(all) : [];
  const soon = all ? expiringSoon(all, props.now) : [];
  const nPending = props.pending?.length;
  const report = props.doctor.data;
  const diag = report ? problemCount(report) : undefined;

  const soonNames = soon.slice(0, 2).map((s) => safeInline(s.name, 24));
  const soonBadge = soonNames.join(', ') + (soon.length > 2 ? ` +${soon.length - 2}` : '');

  return (
    <ul className="stat-grid" aria-label={t('overview.stats')}>
      <Stat
        testId="stat-running"
        value={all ? running.length : undefined}
        label={t('overview.stat.running')}
        onClick={() => navigate({ view: 'sandboxes' })}
        badge={
          all ? (
            problems.length > 0 ? (
              <Badge tone="warn">{t('overview.badge.problems', { count: problems.length })}</Badge>
            ) : (
              <Badge tone="ok">{t('overview.badge.allGood')}</Badge>
            )
          ) : null
        }
      />
      <Stat
        testId="stat-approvals"
        value={nPending}
        label={t('overview.stat.approvals')}
        onClick={() => navigate({ view: 'approvals' })}
        badge={
          nPending === undefined ? null : nPending > 0 ? (
            <Badge tone="warn">{t('overview.badge.waiting')}</Badge>
          ) : (
            <Badge tone="neutral">{t('overview.badge.nothingOpen')}</Badge>
          )
        }
      />
      <Stat
        testId="stat-expiring"
        value={all ? soon.length : undefined}
        label={t('overview.stat.expiring')}
        onClick={() => navigate({ view: 'sandboxes' })}
        badge={
          all ? (
            soon.length > 0 ? (
              <Badge tone="neutral">
                <span className="plain">{soonBadge}</span>
              </Badge>
            ) : (
              <Badge tone="neutral">{t('overview.badge.none')}</Badge>
            )
          ) : null
        }
      />
      <Stat
        testId="stat-problems"
        value={diag?.problems}
        label={t('overview.stat.problems')}
        onClick={() => navigate({ view: 'settings' })}
        badge={
          diag ? (
            diag.errors > 0 ? (
              <Badge tone="danger">{t('overview.badge.errors', { count: diag.errors })}</Badge>
            ) : diag.warnings > 0 ? (
              <Badge tone="warn">{t('overview.badge.warnings', { count: diag.warnings })}</Badge>
            ) : diag.info > 0 ? (
              <Badge tone="ok">{t('overview.badge.notes', { count: diag.info })}</Badge>
            ) : (
              <Badge tone="ok">{t('overview.badge.allGood')}</Badge>
            )
          ) : props.doctor.error ? (
            <Badge tone="neutral" title={safeInline(props.doctor.error.message, 200)}>
              {t('overview.badge.unavailable')}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('overview.badge.checking')}</Badge>
          )
        }
      />
    </ul>
  );
}

function Stat(props: {
  testId: string;
  value: number | undefined;
  label: string;
  badge: ReactNode;
  onClick(): void;
}) {
  return (
    <li>
      <button
        type="button"
        className="stat-card"
        data-testid={props.testId}
        onClick={props.onClick}
      >
        <span className="stat-value">{props.value ?? '–'}</span>
        <span className="stat-label">{props.label}</span>
        <span className="stat-badge">{props.badge}</span>
      </button>
    </li>
  );
}

// -- hosts ---------------------------------------------------------------------------------------------------

function HostsCard(props: {
  rows: HostRow[] | undefined;
  error: ReturnType<typeof useQuery<'hosts:list'>>['error'];
  sandboxes: SandboxView[];
  unreachable: string[];
}) {
  const { t, navigate } = useApp();
  const picked = useMemo(
    () => overviewHosts(props.rows ?? [], props.sandboxes),
    [props.rows, props.sandboxes],
  );
  // Same call as the Hosts view (`capacity:host`, cached by the manager, one independent call per host).
  const caps = useHostCapacity(picked.shown.map((r) => r.profile.id));
  return (
    <section className="card" aria-labelledby="h-ov-hosts" data-testid="ov-hosts">
      <div className="ov-card-head">
        <h2 id="h-ov-hosts">{t('overview.hosts.title')}</h2>
        <button type="button" className="linklike" onClick={() => navigate({ view: 'hosts' })}>
          {t('overview.hosts.all')}
        </button>
      </div>
      {props.error ? <ErrorBox error={props.error} /> : null}
      {!props.rows && !props.error ? (
        <p className="muted" role="status">
          {t('common.loading')}
        </p>
      ) : null}
      {props.rows && picked.shown.length === 0 ? (
        <p className="muted">{t('overview.hosts.empty')}</p>
      ) : null}
      {picked.shown.map((row) => (
        <HostBlock
          key={row.profile.id}
          row={row}
          sandboxes={props.sandboxes}
          capacity={caps[row.profile.id]}
          listUnreachable={props.unreachable.includes(row.profile.id)}
        />
      ))}
      {picked.hidden > 0 ? (
        <p className="muted small">{t('overview.hosts.more', { count: picked.hidden })}</p>
      ) : null}
    </section>
  );
}

function HostBlock(props: {
  row: HostRow;
  sandboxes: SandboxView[];
  capacity: CapacityState | undefined;
  listUnreachable: boolean;
}) {
  const { t, locale } = useApp();
  const p = props.row.profile;
  const dec = (text: string): string =>
    locale === 'de' ? text.replace(/(\d)\.(\d)/g, '$1,$2') : text;
  const util = hostUtilisation(p.id, props.sandboxes, p.limits);
  const s = props.capacity;
  const c: HostCapacity | undefined = s?.data;
  const bars = liveBars(c);
  const failed = s !== undefined && !s.loading && !s.data;
  const unreachable = failed || props.listUnreachable || props.row.status.state === 'unreachable';
  const ncpu = c?.capacity.cpus ?? null;
  return (
    <div className="ov-host" data-testid={`ov-host-${p.id}`}>
      <div className="ov-host-head">
        <strong className="plain">{safeInline(p.id, 40)}</strong>
        <Badge tone={ZONE_TONE[p.zone]}>{t(`hosts.zone.${p.zone}`)}</Badge>
        {unreachable ? (
          <Badge tone="danger" title={s?.error ? safeInline(s.error, 200) : undefined}>
            {t('hosts.status.unreachable')}
          </Badge>
        ) : null}
      </div>
      {!unreachable ? (
        <>
          {!s || (s.loading && !c) ? (
            <p className="muted small">{t('hosts.live.loading')}</p>
          ) : bars.cpu || bars.ram ? (
            <>
              {bars.cpu ? (
                <Meter
                  testId={`ov-cpu-${p.id}`}
                  label={t('overview.hosts.cpu')}
                  text={
                    bars.cpu.used !== null && ncpu !== null
                      ? t('overview.hosts.cpuText', {
                          used: dec(Number(bars.cpu.used.toFixed(1)).toString()),
                          total: ncpu,
                        })
                      : t('hosts.live.cpuPercent', { percent: bars.cpu.percent ?? 0 })
                  }
                  percent={bars.cpu.percent ?? 0}
                />
              ) : null}
              {bars.ram && bars.ram.used !== null && bars.ram.total !== null ? (
                <Meter
                  testId={`ov-ram-${p.id}`}
                  label={t('overview.hosts.memory')}
                  text={`${dec(formatBytes(bars.ram.used))} / ${dec(formatBytes(bars.ram.total))}`}
                  percent={bars.ram.percent ?? 0}
                />
              ) : null}
            </>
          ) : (
            <p className="warn-text small" title={c?.live.reason}>
              {t('hosts.live.unknown')}
            </p>
          )}
        </>
      ) : null}
      <Meter
        testId={`ov-sandboxes-${p.id}`}
        label={t('overview.hosts.sandboxes')}
        text={
          util.sandboxLimit !== undefined
            ? `${util.sandboxes} / ${util.sandboxLimit}`
            : String(util.sandboxes)
        }
        percent={util.sandboxFraction !== undefined ? Math.round(util.sandboxFraction * 100) : null}
      />
    </div>
  );
}

/** Label, "used / total" and a thin bar (amber above 80 %, red above 95 %: the same tones as the Hosts view). */
function Meter(props: { testId: string; label: string; text: string; percent: number | null }) {
  const { t } = useApp();
  const tone: BarTone = barTone(props.percent);
  return (
    <div className="live-row" data-testid={props.testId} data-tone={tone}>
      <span className="live-label">{props.label}</span>
      <span className="live-text mono">
        {props.text}
        {tone !== 'ok' ? (
          <span className={`live-tone live-tone-${tone}`}> {t(`hosts.live.tone.${tone}`)}</span>
        ) : null}
      </span>
      {props.percent !== null ? (
        <span className="live-bar" aria-hidden="true">
          <span className={`live-fill live-fill-${tone}`} style={{ width: `${props.percent}%` }} />
        </span>
      ) : null}
    </div>
  );
}

// -- approvals -----------------------------------------------------------------------------------------------

function ApprovalsCard(props: {
  approvals: ApprovalView[] | undefined;
  byId: ReadonlyMap<string, SandboxView>;
  onChanged(): void;
  notify: ReturnType<typeof useApp>['notify'];
}) {
  const { t, navigate } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const all = props.approvals ?? [];
  const shown = all.slice(0, MAX_APPROVALS);

  async function decide(a: ApprovalView, kind: 'approve' | 'deny') {
    if (busy) return;
    setBusy(a.id);
    setErrors((e) => ({ ...e, [a.id]: undefined }));
    try {
      await call(kind === 'approve' ? 'approvals:approve' : 'approvals:deny', { id: a.id });
      props.notify(
        'ok',
        t(kind === 'approve' ? 'approvals.approvedToast' : 'approvals.deniedToast', {
          agent: safeInline(a.requester.replace(/^agent:/, ''), 60),
        }),
      );
      props.onChanged();
    } catch (e) {
      setErrors((m) => ({ ...m, [a.id]: e }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="h-ov-approvals" data-testid="ov-approvals">
      <div className="ov-card-head">
        <h2 id="h-ov-approvals">{t('overview.approvals.title')}</h2>
        <button type="button" className="linklike" onClick={() => navigate({ view: 'approvals' })}>
          {t('overview.approvals.all')}
        </button>
      </div>
      {!props.approvals ? (
        <p className="muted" role="status">
          {t('common.loading')}
        </p>
      ) : null}
      {props.approvals && all.length === 0 ? (
        <p className="muted">{t('overview.approvals.empty')}</p>
      ) : null}
      <ul className="ov-approvals">
        {shown.map((a) => {
          const name = a.sandboxId ? sandboxLabel(a.sandboxId, props.byId) : '';
          const head = approvalHeadline(a, safeInline(name, 40));
          const title = head
            ? t(
                head.key,
                Object.fromEntries(
                  Object.entries(head.params).map(([k, v]) => [
                    k,
                    typeof v === 'string' ? safeInline(v, 60) : v,
                  ]),
                ),
              )
            : `${kindLabel(t, a.kind, a.request)}${
                (requestTemplateName(a.request) ?? name) !== ''
                  ? ` · ${safeInline(requestTemplateName(a.request) ?? name, 60)}`
                  : ''
              }`;
          const reason = safeInline(a.reason, 140);
          const agent = safeInline(a.requester.replace(/^agent:/, ''), 40);
          const err = errors[a.id];
          return (
            <li key={a.id} className="ov-approval" data-approval-id={a.id}>
              <strong className="plain">{title}</strong>
              <span className="muted small plain">
                {reason ? t('overview.approvals.by', { agent, reason }) : agent}
              </span>
              {err ? <ErrorBox error={err} /> : null}
              <span className="ov-approval-actions">
                {head?.quick ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy !== null}
                    onClick={() => void decide(a, 'approve')}
                  >
                    {t('overview.approvals.allow')}
                    <span className="sr-only"> {title}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide(a, 'deny')}
                >
                  {t('approvals.deny')}
                  <span className="sr-only"> {title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate({ view: 'approvals', approvalId: a.id })}
                >
                  {t('overview.approvals.details')}
                  <span className="sr-only"> {title}</span>
                </button>
              </span>
              {!head?.quick ? (
                <span className="muted small">{t('overview.approvals.needsDetails')}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {all.length > shown.length ? (
        <p className="muted small">
          {t('overview.approvals.more', { count: all.length - shown.length })}
        </p>
      ) : null}
    </section>
  );
}
