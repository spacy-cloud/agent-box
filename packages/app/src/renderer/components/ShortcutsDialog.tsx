import { useApp } from '../context';
import { Dialog } from './ui';

interface Row {
  keys: string[][];
  text: string;
}

/** Every keyboard shortcut of the app, grouped. Keep in step with docs/gui.md. */
function groups(): Array<{ id: string; rows: Row[] }> {
  return [
    {
      id: 'global',
      rows: [
        { keys: [['n']], text: 'shortcuts.new' },
        { keys: [['/']], text: 'shortcuts.search' },
        { keys: [['?']], text: 'shortcuts.help' },
        { keys: [['Esc']], text: 'shortcuts.close' },
      ],
    },
    {
      id: 'lists',
      rows: [
        { keys: [['Enter'], ['↓'], ['↑']], text: 'shortcuts.menu' },
        { keys: [['←'], ['→'], ['Home'], ['End']], text: 'shortcuts.tabs' },
        { keys: [['↑'], ['↓'], ['←'], ['→']], text: 'shortcuts.tree' },
      ],
    },
    {
      id: 'approvals',
      rows: [
        { keys: [['↑'], ['↓']], text: 'shortcuts.queue' },
        { keys: [['Enter']], text: 'shortcuts.allow' },
        { keys: [['Esc']], text: 'shortcuts.deny' },
      ],
    },
    {
      id: 'terminal',
      rows: [
        { keys: [['Shift', 'Esc']], text: 'shortcuts.termLeave' },
        { keys: [['Ctrl', 'Shift', 'C']], text: 'shortcuts.termCopy' },
      ],
    },
  ];
}

/** The `?` help: opens as a dialog (Esc closes it). */
export function ShortcutsDialog(props: { onClose(): void }) {
  const { t } = useApp();
  return (
    <Dialog
      title={t('shortcuts.title')}
      onClose={props.onClose}
      wide
      footer={
        <button type="button" className="primary" onClick={props.onClose} autoFocus>
          {t('common.close')}
        </button>
      }
    >
      <p className="muted">{t('shortcuts.intro')}</p>
      {groups().map((g) => (
        <section key={g.id} aria-labelledby={`sc-${g.id}`}>
          <h3 id={`sc-${g.id}`} className="h-small">
            {t(`shortcuts.group.${g.id}`)}
          </h3>
          <dl className="shortcuts">
            {g.rows.map((r) => (
              <div key={r.text} className="shortcut-row">
                <dt>
                  {r.keys.map((combo, i) => (
                    <span key={combo.join('+')}>
                      {i > 0 ? <span className="muted"> / </span> : null}
                      {combo.map((k, n) => (
                        <span key={k}>
                          {n > 0 ? '+' : null}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </span>
                  ))}
                </dt>
                <dd>{t(r.text)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}
