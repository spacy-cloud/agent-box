import { useEffect, useState } from 'react';
import { call } from '../../api';
import { useApp } from '../../context';
import { useQuery } from '../../hooks';
import { Badge, Banner, ErrorBox, Loading } from '../ui';
import { CLAUDE_CODE_METHODS, SETUP_CLIENTS } from '../../../shared/constants';
import type { ClaudeCodeMethod, SetupClientId } from '../../../shared/constants';
import { safeInline, safeText } from '../../../shared/format';
import type { ClientStatus, SetupPlan, SetupResult, SetupStep } from '../../../shared/types';

/**
 * Step 3: register abox with the agents found on this machine, with `abox setup` as the engine. The human ticks the
 * agents, looks at the preview (every file with its diff, every command) and applies it with a click; the manager
 * only applies the plan whose digest it is given, so a file that changed since the preview is never overwritten.
 */
export function AgentsStep(props: { onApplied(): void }) {
  const { t, notify } = useApp();
  const detect = useQuery('setup:detect', undefined, { live: false });
  const [chosen, setChosen] = useState<ReadonlySet<SetupClientId> | null>(null);
  const [method, setMethod] = useState<ClaudeCodeMethod | undefined>();
  const [plan, setPlan] = useState<{ key: string; plan: SetupPlan } | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const clients = detect.data;
  // Start with Claude Code ticked when it is installed and abox is not registered with it yet; nothing else.
  useEffect(() => {
    if (clients && chosen === null) {
      const cc = clients.find((c) => c.id === 'claude-code');
      setChosen(
        new Set(cc && cc.detected && cc.supported && !cc.registered ? ['claude-code'] : []),
      );
    }
  }, [clients, chosen]);

  const selected = SETUP_CLIENTS.filter((id) => chosen?.has(id));
  const request = {
    clients: selected,
    ...(selected.includes('claude-code') && method ? { claudeCodeMethod: method } : {}),
  };
  const key = JSON.stringify(request);
  const shownPlan = plan && plan.key === key ? plan.plan : null;

  function toggle(id: SetupClientId, on: boolean) {
    const next = new Set(chosen ?? []);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
    setResult(null);
  }

  async function preview() {
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      setPlan({ key, plan: await call('setup:plan', request) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!shownPlan) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('setup:apply', {
        ...request,
        digest: shownPlan.digest,
        confirmed: true,
      });
      setResult(r);
      setPlan(null);
      if (r.ok) {
        notify('ok', t('setup.agents.applied'));
        props.onApplied();
      }
      await detect.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>{t('setup.agents.intro')}</p>
      {detect.error ? <ErrorBox error={detect.error} /> : null}
      {detect.loading && !clients ? <Loading /> : null}
      {clients ? (
        <fieldset className="client-list">
          <legend>{t('setup.agents.choose')}</legend>
          <ul className="plain-list">
            {SETUP_CLIENTS.map((id) => clients.find((c) => c.id === id)).map((c) =>
              c ? (
                <ClientRow
                  key={c.id}
                  client={c}
                  checked={chosen?.has(c.id) === true}
                  onChange={(on) => toggle(c.id, on)}
                  method={method}
                  onMethod={(m) => {
                    setMethod(m);
                    setResult(null);
                  }}
                />
              ) : null,
            )}
          </ul>
        </fieldset>
      ) : null}
      <div className="actions">
        <button
          type="button"
          onClick={() => void preview()}
          disabled={busy || selected.length === 0}
        >
          {t('setup.agents.preview')}
        </button>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {shownPlan ? <PlanView plan={shownPlan} busy={busy} onApply={() => void apply()} /> : null}
      {result ? <ResultView result={result} /> : null}
    </>
  );
}

function ClientRow(props: {
  client: ClientStatus;
  checked: boolean;
  onChange(on: boolean): void;
  method: ClaudeCodeMethod | undefined;
  onMethod(m: ClaudeCodeMethod): void;
}) {
  const { t } = useApp();
  const c = props.client;
  const disabled = !c.supported || c.problem !== undefined;
  const effective = props.method ?? c.claudeCodeMethod;
  return (
    <li className="client-row">
      <label className="inline">
        <input
          type="checkbox"
          checked={props.checked}
          disabled={disabled}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <strong>{safeInline(c.label, 60)}</strong>
      </label>{' '}
      {c.detected ? (
        <Badge tone="ok">{t('setup.agents.found')}</Badge>
      ) : (
        <Badge tone="neutral">{t('setup.agents.notFound')}</Badge>
      )}{' '}
      {c.registered ? (
        <Badge tone="info">
          {t('setup.agents.registered', {
            via: c.registeredVia ? t(`setup.agents.via.${c.registeredVia}`) : '',
          })}
        </Badge>
      ) : null}
      {!c.supported ? (
        <div className="muted small plain">{safeInline(c.unsupportedReason ?? '', 300)}</div>
      ) : null}
      {c.problem ? (
        <div className="danger-text small plain">{safeInline(c.problem, 300)}</div>
      ) : null}
      {c.otherEntries.length > 0 ? (
        <div className="warn-text small">
          {t('setup.agents.otherEntries', { count: c.otherEntries.length })}
        </div>
      ) : null}
      {c.id === 'claude-code' && props.checked && c.supported ? (
        <fieldset className="method">
          <legend>{t('setup.agents.method')}</legend>
          {CLAUDE_CODE_METHODS.map((m) => (
            <label key={m} className="inline method-option">
              <input
                type="radio"
                name="claude-code-method"
                checked={effective === m}
                disabled={m === 'plugin' && c.cliPath === undefined}
                onChange={() => props.onMethod(m)}
              />
              <span>
                {t(`setup.agents.method.${m}`)}
                {m === 'plugin' ? (
                  <small className="muted"> — {t('setup.agents.method.pluginHint')}</small>
                ) : (
                  <small className="muted"> — {t('setup.agents.method.mcpHint')}</small>
                )}
              </span>
            </label>
          ))}
          <p className="muted small">{t('setup.agents.method.never')}</p>
        </fieldset>
      ) : null}
    </li>
  );
}

function PlanView(props: { plan: SetupPlan; busy: boolean; onApply(): void }) {
  const { t } = useApp();
  const plan = props.plan;
  return (
    <section aria-labelledby="h-setup-plan" className="setup-plan">
      <h4 className="h-small" id="h-setup-plan">
        {t('setup.agents.planTitle')}
      </h4>
      {plan.warnings.map((w, i) => (
        <Banner key={i} tone="warn">
          <span className="plain">{safeText(w)}</span>
        </Banner>
      ))}
      {plan.empty ? (
        <Banner tone="ok">{t('setup.agents.nothing')}</Banner>
      ) : (
        <>
          <p>{t('setup.agents.planIntro')}</p>
          <ol className="plain-list plan-steps">
            {plan.steps.map((s, i) => (
              <StepView key={i} step={s} />
            ))}
          </ol>
        </>
      )}
      {plan.notes.length > 0 ? (
        <ul className="reason-list muted">
          {plan.notes.map((n, i) => (
            <li key={i} className="plain">
              {safeText(n)}
            </li>
          ))}
        </ul>
      ) : null}
      {!plan.empty ? (
        <div className="actions">
          <button type="button" className="primary" disabled={props.busy} onClick={props.onApply}>
            {t('setup.agents.apply')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function StepView(props: { step: SetupStep }) {
  const { t } = useApp();
  const s = props.step;
  if (s.type === 'command') {
    return (
      <li className="plan-step">
        <Badge tone="info">{t('setup.agents.step.command')}</Badge>{' '}
        <span>{safeInline(s.summary, 300)}</span>
        <pre className="code plain" tabIndex={0} aria-label={t('setup.agents.step.commandLabel')}>
          {safeInline(s.argv.join(' '), 600)}
        </pre>
        {s.touches.length > 0 ? (
          <div className="muted small plain">
            {t('setup.agents.step.touches', { files: safeInline(s.touches.join(', '), 400) })}
          </div>
        ) : null}
      </li>
    );
  }
  return (
    <li className="plan-step">
      <Badge tone={s.action === 'delete' ? 'warn' : s.action === 'unchanged' ? 'neutral' : 'info'}>
        {t(`setup.agents.action.${s.action}`)}
      </Badge>{' '}
      <code className="plain">{safeInline(s.path, 300)}</code>
      <div className="muted small plain">
        {safeInline(s.summary, 300)}
        {s.backup ? ` · ${t('setup.agents.step.backup')}` : ''}
      </div>
      {s.diff ? (
        <UnifiedDiff
          text={s.diff}
          label={t('setup.agents.step.diff', { path: safeInline(s.path, 120) })}
        />
      ) : null}
    </li>
  );
}

/** A unified diff as setup prints it: `+` / `-` stay visible as characters, the colour is only a hint. */
export function UnifiedDiff(props: { text: string; label: string }) {
  const lines = props.text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return (
    <pre className="diff plain" tabIndex={0} aria-label={props.label}>
      {lines.map((l, i) => {
        const cls =
          l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')
            ? 'diff-hunk'
            : l.startsWith('+')
              ? 'diff-add'
              : l.startsWith('-')
                ? 'diff-del'
                : '';
        return (
          <span key={i} className={cls}>
            {safeText(l)}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function ResultView(props: { result: SetupResult }) {
  const { t } = useApp();
  const r = props.result;
  return (
    <section aria-labelledby="h-setup-result" className="setup-plan">
      <h4 className="h-small" id="h-setup-result">
        {t('setup.agents.resultTitle')}
      </h4>
      <Banner tone={r.ok ? 'ok' : 'danger'}>
        {r.ok ? t('setup.agents.resultOk') : t('setup.agents.resultFailed')}
      </Banner>
      <ul className="plain-list">
        {r.steps.map((s, i) => (
          <li key={i} className="plain">
            <Badge
              tone={s.status === 'failed' ? 'danger' : s.status === 'applied' ? 'ok' : 'neutral'}
            >
              {t(`setup.agents.status.${s.status}`)}
            </Badge>{' '}
            <code>{safeInline(s.target, 300)}</code>
            {s.message ? <div className="muted small">{safeInline(s.message, 300)}</div> : null}
          </li>
        ))}
      </ul>
      {r.warnings.map((w, i) => (
        <p key={i} className="warn-text small plain">
          {safeText(w)}
        </p>
      ))}
      {r.backups.length > 0 ? (
        <p className="muted small">{t('setup.agents.backups', { count: r.backups.length })}</p>
      ) : null}
    </section>
  );
}
