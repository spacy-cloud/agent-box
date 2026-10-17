import { useEffect, useId, useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { Banner, Dialog, ScrollText } from './ui';
import { safeInline } from '../../shared/format';
import type { AskpassEvent } from '../../shared/constants';

/**
 * Passphrase / PIN prompts of ssh sessions. The main process hands every prompt of a terminal tab's ssh to
 * this dialog (see `main/askpass.ts`), so the question is never answered unseen in the background and never
 * typed into a terminal. Prompts queue up; one dialog is open at a time. The typed value goes to the main
 * process and from there to ssh: it lives in this component's state only while the dialog is open, is cleared
 * on submit and is not written anywhere else.
 */
export function AskpassHost() {
  const [queue, setQueue] = useState<AskpassEvent[]>([]);
  useEffect(() => {
    const offReq = window.abox.on('evt:askpass', (ev) => setQueue((q) => [...q, ev]));
    const offEnd = window.abox.on('evt:askpass-end', ({ id }) =>
      setQueue((q) => q.filter((x) => x.id !== id)),
    );
    return () => {
      offReq();
      offEnd();
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  return (
    <AskpassDialog
      key={current.id}
      req={current}
      onDone={() => setQueue((q) => q.filter((x) => x.id !== current.id))}
    />
  );
}

export function AskpassDialog(props: { req: AskpassEvent; onDone(): void }) {
  const { t, notify } = useApp();
  const { req } = props;
  const formId = useId();
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  async function answer(v: string | null) {
    if (busy) return;
    setBusy(true);
    const typed = v;
    setValue('');
    try {
      if (req.mode !== 'refused') await call('askpass:answer', { id: req.id, value: typed });
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      props.onDone();
    }
  }

  const session = safeInline(req.session, 80);
  return (
    <Dialog
      title={t(`askpass.title.${req.mode}`, { session })}
      onClose={() => void answer(req.mode === 'refused' ? '' : null)}
      footer={
        req.mode === 'secret' ? (
          <>
            <button type="button" onClick={() => void answer(null)} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="submit" form={formId} className="primary" disabled={busy}>
              {t('askpass.submit')}
            </button>
          </>
        ) : req.mode === 'confirm' ? (
          <>
            <button type="button" onClick={() => void answer(null)} disabled={busy}>
              {t('askpass.no')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void answer('')}
              disabled={busy}
            >
              {t('askpass.yes')}
            </button>
          </>
        ) : (
          <button type="button" className="primary" onClick={() => void answer('')} autoFocus>
            {t('common.close')}
          </button>
        )
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void answer(value);
        }}
      >
        <p>{t(`askpass.intro.${req.mode}`, { session })}</p>
        {req.mode === 'refused' ? <Banner tone="warn">{t('askpass.refused')}</Banner> : null}
        <h3 className="h-small">{t('askpass.prompt')}</h3>
        <ScrollText text={req.prompt} label={t('askpass.prompt')} empty="—" />
        {req.mode === 'secret' ? (
          <>
            <div className="field">
              <label htmlFor={`${formId}-value`}>{t('askpass.value')}</label>
              <input
                id={`${formId}-value`}
                type={show ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            <label className="inline">
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />{' '}
              {t('askpass.show')}
            </label>
            <p className="muted small">{t('askpass.hint')}</p>
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
