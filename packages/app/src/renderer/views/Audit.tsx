import { useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { Banner, ErrorBox, Loading } from '../components/ui';
import { safeInline } from '../../shared/format';
import { AuditTable } from './Detail';
import { AUDIT_DECISIONS } from '../../shared/constants';
import type { IpcInput } from '../../shared/ipc';
import type { ChainVerification } from '../../shared/types';

interface Filters {
  actor: string;
  action: string;
  decision: string;
  sandboxId: string;
  since: string;
  limit: string;
}
const EMPTY: Filters = {
  actor: '',
  action: '',
  decision: '',
  sandboxId: '',
  since: '',
  limit: '200',
};

export function toAuditFilter(f: Filters): NonNullable<IpcInput<'audit:query'>> {
  const out: NonNullable<IpcInput<'audit:query'>> = { order: 'desc' };
  if (f.actor.trim()) out.actor = f.actor.trim();
  if (f.action.trim()) out.action = f.action.trim();
  if (f.decision) out.decision = f.decision as (typeof AUDIT_DECISIONS)[number];
  if (f.sandboxId.trim()) out.sandboxId = f.sandboxId.trim();
  if (f.since) {
    const ms = new Date(f.since).getTime();
    if (Number.isFinite(ms)) out.since = ms;
  }
  const lim = Number(f.limit);
  out.limit = Number.isInteger(lim) && lim > 0 ? Math.min(lim, 5000) : 200;
  return out;
}

export function AuditView() {
  const { t, navigate, notify, route } = useApp();
  const initial: Filters = route.actor ? { ...EMPTY, actor: route.actor } : EMPTY;
  const [form, setForm] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  const q = useQuery('audit:query', toAuditFilter(applied), { pollMs: 5000 });
  const [chain, setChain] = useState<ChainVerification | null>(null);

  async function exportJsonl() {
    try {
      const { order: _o, ...filter } = toAuditFilter(applied);
      const r = await call('audit:exportSave', filter);
      if (r.saved) notify('ok', t('audit.exported', { count: r.count ?? 0, path: r.saved }));
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  async function verify() {
    try {
      setChain(await call('audit:verify'));
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  return (
    <section aria-labelledby="h-audit">
      <header className="page-head">
        <h1 id="h-audit">{t('audit.title')}</h1>
        <div className="actions">
          <button type="button" onClick={() => void verify()}>
            {t('audit.verify')}
          </button>
          <button type="button" onClick={() => void exportJsonl()}>
            {t('audit.export')}
          </button>
        </div>
      </header>
      {chain ? (
        <Banner tone={chain.ok ? 'ok' : 'danger'}>
          {chain.ok
            ? t('audit.chainOk', { count: chain.checked })
            : t('audit.chainBroken', { seq: chain.brokenAt ?? 0 })}
          {chain.reason ? <span className="plain"> ({safeInline(chain.reason, 200)})</span> : null}
        </Banner>
      ) : null}
      <form
        className="filters"
        role="search"
        aria-label={t('audit.filters')}
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(form);
        }}
      >
        <label>
          {t('audit.col.actor')}
          <input
            type="text"
            value={form.actor}
            onChange={(e) => setForm({ ...form, actor: e.target.value })}
            placeholder="agent:default"
          />
        </label>
        <label>
          {t('audit.col.action')}
          <input
            type="text"
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
            placeholder="sandbox.create"
          />
        </label>
        <label>
          {t('audit.col.decision')}
          <select
            value={form.decision}
            onChange={(e) => setForm({ ...form, decision: e.target.value })}
          >
            <option value="">{t('common.all')}</option>
            {AUDIT_DECISIONS.map((d) => (
              <option key={d} value={d}>
                {t(`decision.${d}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('audit.col.sandbox')}
          <input
            type="text"
            value={form.sandboxId}
            onChange={(e) => setForm({ ...form, sandboxId: e.target.value })}
            placeholder="local/1a2b3c4d"
          />
        </label>
        <label>
          {t('audit.since')}
          <input
            type="datetime-local"
            value={form.since}
            onChange={(e) => setForm({ ...form, since: e.target.value })}
          />
        </label>
        <label>
          {t('audit.limit')}
          <input
            type="number"
            min="1"
            max="5000"
            value={form.limit}
            onChange={(e) => setForm({ ...form, limit: e.target.value })}
          />
        </label>
        <button type="submit" className="primary">
          {t('audit.apply')}
        </button>
        <button
          type="button"
          onClick={() => {
            setForm(EMPTY);
            setApplied(EMPTY);
          }}
        >
          {t('common.reset')}
        </button>
      </form>
      {q.error ? <ErrorBox error={q.error} /> : null}
      {!q.data && q.loading ? <Loading /> : null}
      {q.data && q.data.length === 0 ? <p className="muted">{t('audit.empty')}</p> : null}
      {q.data && q.data.length > 0 ? (
        <AuditTable
          entries={q.data}
          onSandbox={(id) => navigate({ view: 'detail', sandboxId: id })}
        />
      ) : null}
    </section>
  );
}
