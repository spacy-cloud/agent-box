import { useApp } from '../../context';
import { Badge, CopyButton } from '../ui';

const COMMANDS =
  'abox approvals list\nabox approvals show <id>\nabox approvals approve <id>\nabox approvals deny <id>';

/**
 * Last step: how approvals work. The card below is a picture, in the style of the real one (Approvals page): its
 * buttons do nothing. No request exists yet; this only shows what will appear and where.
 */
export function ApprovalsStep() {
  const { t } = useApp();
  return (
    <>
      <p>{t('setup.approvals.intro')}</p>
      <figure className="approval-demo" aria-label={t('setup.approvals.demoLabel')}>
        <figcaption className="muted small">{t('setup.approvals.demoCaption')}</figcaption>
        <div className="approval-dialog demo">
          <p className="demo-title">{t('setup.approvals.demoTitle')}</p>
          <p className="meta">{t('setup.approvals.demoMeta')}</p>
          <p className="plain">{t('setup.approvals.demoReason')}</p>
          <ul className="chips">
            <li>
              <Badge tone="warn">{t('setup.approvals.demoChip')}</Badge>
            </li>
          </ul>
          <div className="actions" aria-hidden="true">
            <span className="demo-button demo-primary">{t('setup.approvals.demoAllow')}</span>
            <span className="demo-button">{t('setup.approvals.demoDeny')}</span>
          </div>
        </div>
      </figure>
      <h4 className="h-small">{t('setup.approvals.where')}</h4>
      <ul className="reason-list">
        <li>{t('setup.approvals.whereGui')}</li>
        <li>{t('setup.approvals.whereTray')}</li>
        <li>{t('setup.approvals.whereCli')}</li>
      </ul>
      <pre className="code plain" tabIndex={0} aria-label={t('setup.approvals.commands')}>
        {COMMANDS}
      </pre>
      <CopyButton text={COMMANDS} />
      <p className="muted">{t('setup.approvals.humanOnly')}</p>
    </>
  );
}
