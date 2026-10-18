import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { InspectResult, SandboxPortForward } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { Badge, Banner, ErrorBox, Safe } from './ui';
import { portsBlocked, readHostPort, readSandboxPort } from '../../shared/ports';
import { safeText } from '../../shared/format';

/**
 * "Vorschau" / "Preview" in the sandbox detail view: the TCP ports of the sandbox that are forwarded to
 * 127.0.0.1 of this machine (a dev server shown in the browser), with add, remove and "open preview".
 *
 * The panel only asks. Whether a forward is possible is decided by the manager and the backend; what it knows
 * beforehand (not running, network mode none, remote host, no isolation) it turns into an explanation instead of
 * an error. "Open preview" sends the sandbox and the port, never a URL: the main process builds the URL from the
 * forward that really exists and opens only that (see `main/preview.ts`).
 */
export function PortsPanel(props: { sandbox: InspectResult }) {
  const { t, notify } = useApp();
  const s = props.sandbox;
  const heading = useId();
  const blocked = portsBlocked(s);
  const list = useQuery('ports:list', { id: s.id }, { pollMs: 3000, enabled: blocked === null });
  const forwards: SandboxPortForward[] = blocked === null ? (list.data ?? []) : [];

  const [port, setPort] = useState('');
  const [hostPort, setHostPort] = useState('');
  const [invalid, setInvalid] = useState<'port' | 'hostPort' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [confirmation, setConfirmation] = useState<{ reasons: string[]; risks: string[] } | null>(
    null,
  );
  const portId = useId();
  const hostPortId = useId();
  const portErr = useId();
  const hostPortErr = useId();

  async function guarded(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const sandboxPort = readSandboxPort(port);
    const host = readHostPort(hostPort);
    if (sandboxPort === null) return setInvalid('port');
    if (host === null) return setInvalid('hostPort');
    setInvalid(null);
    void guarded(async () => {
      const r = await call('ports:add', {
        id: s.id,
        port: sandboxPort,
        ...(host !== undefined ? { hostPort: host } : {}),
        ...(confirmation ? { confirmed: true } : {}),
      });
      if (r.status === 'confirmation_required') {
        setConfirmation({ reasons: r.reasons, risks: r.risks });
        return;
      }
      setConfirmation(null);
      if (r.status === 'applied' && r.port) {
        notify('ok', t('ports.added', { port: r.port.sandboxPort, url: r.port.url }));
        setPort('');
        setHostPort('');
      } else {
        notify('info', r.message);
      }
      await list.reload();
    });
  }

  const intro = <p className="muted">{t('ports.intro')}</p>;

  return (
    <section aria-labelledby={heading} data-testid="ports-panel">
      <h2 className="h-small" id={heading}>
        {t('ports.title')}
      </h2>
      {intro}
      {blocked ? <Banner tone="info">{t(`ports.blocked.${blocked}`)}</Banner> : null}
      {list.error && blocked === null ? <ErrorBox error={list.error} /> : null}

      {blocked === null && forwards.length === 0 && list.data ? (
        <p className="muted">{t('ports.empty')}</p>
      ) : null}
      {forwards.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t('ports.table')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ports.col.sandbox')}</th>
                <th scope="col">{t('ports.col.address')}</th>
                <th scope="col">{t('ports.col.state')}</th>
                <th scope="col">{t('sandboxes.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {forwards.map((f) => (
                <tr key={f.sandboxPort}>
                  <th scope="row" className="mono">
                    {f.sandboxPort}
                  </th>
                  <td>
                    <Safe text={f.url} className="mono" max={80} />
                  </td>
                  <td>
                    <TargetState forward={f} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={t('ports.openNamed', { port: f.sandboxPort })}
                        onClick={() =>
                          void guarded(async () => {
                            const r = await call('ports:openPreview', {
                              id: s.id,
                              port: f.sandboxPort,
                            });
                            notify('ok', t('ports.opened', { url: r.url }));
                          })
                        }
                      >
                        {t('ports.open')}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        aria-label={t('ports.removeNamed', { port: f.sandboxPort })}
                        onClick={() =>
                          void guarded(async () => {
                            await call('ports:remove', { id: s.id, port: f.sandboxPort });
                            notify('ok', t('ports.removed', { port: f.sandboxPort }));
                            await list.reload();
                          })
                        }
                      >
                        {t('ports.remove')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h3 className="h-small">{t('ports.add.title')}</h3>
      <form
        className="form-grid"
        onSubmit={submit}
        onChange={() => {
          setConfirmation(null);
          setInvalid(null);
        }}
        noValidate
      >
        <div className="field">
          <label htmlFor={portId}>{t('ports.add.port')}</label>
          <input
            id={portId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={port}
            disabled={blocked !== null}
            aria-invalid={invalid === 'port' ? true : undefined}
            aria-describedby={invalid === 'port' ? portErr : undefined}
            onChange={(e) => setPort(e.target.value)}
          />
          {invalid === 'port' ? (
            <small id={portErr} className="danger-text">
              {t('ports.add.portInvalid')}
            </small>
          ) : (
            <small className="muted">{t('ports.add.portHint')}</small>
          )}
        </div>
        <div className="field">
          <label htmlFor={hostPortId}>{t('ports.add.hostPort')}</label>
          <input
            id={hostPortId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={hostPort}
            disabled={blocked !== null}
            aria-invalid={invalid === 'hostPort' ? true : undefined}
            aria-describedby={invalid === 'hostPort' ? hostPortErr : undefined}
            onChange={(e) => setHostPort(e.target.value)}
          />
          {invalid === 'hostPort' ? (
            <small id={hostPortErr} className="danger-text">
              {t('ports.add.hostPortInvalid')}
            </small>
          ) : (
            <small className="muted">{t('ports.add.hostPortHint')}</small>
          )}
        </div>
        {confirmation ? (
          <div className="wide-col">
            <Banner tone="warn">
              <ul>
                {[...confirmation.reasons, ...confirmation.risks].map((x, i) => (
                  <li key={i} className="plain">
                    {safeText(x)}
                  </li>
                ))}
              </ul>
            </Banner>
          </div>
        ) : null}
        <div className="actions wide-col">
          <button type="submit" className="primary" disabled={blocked !== null || busy}>
            {confirmation ? t('common.confirm') : t('ports.add.button')}
          </button>
        </div>
      </form>
      {error ? <ErrorBox error={error} /> : null}
    </section>
  );
}

/** Whether anything in the sandbox answers on the forwarded port, and what to do when nothing does. */
function TargetState(props: { forward: SandboxPortForward }) {
  const { t } = useApp();
  const f = props.forward;
  const problems = (f.rejected ?? 0) + (f.failed ?? 0);
  return (
    <>
      {f.target === 'up' ? <Badge tone="ok">{t('ports.state.up')}</Badge> : null}
      {f.target === 'down' ? <Badge tone="warn">{t('ports.state.down')}</Badge> : null}
      {f.target === 'unknown' ? <Badge tone="neutral">{t('ports.state.unknown')}</Badge> : null}
      {f.target === 'down' ? <div className="small">{t('ports.state.downHint')}</div> : null}
      {f.connections !== undefined ? (
        <div className="muted small">{t('ports.connections', { count: f.connections })}</div>
      ) : null}
      {problems > 0 ? (
        <div className="muted small">
          {t('ports.problems', { rejected: f.rejected ?? 0, failed: f.failed ?? 0 })}
        </div>
      ) : null}
    </>
  );
}
