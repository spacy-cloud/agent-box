import { useMemo } from 'react';
import { useApp } from '../context';
import { Badge, Banner } from './ui';
import { safeText } from '../../shared/format';
import type { ImageUse, TemplateReview } from '../../shared/types';

/**
 * Unified diff as plain text, line by line: monospaced and scrollable (keyboard focusable). `+` / `-` stay
 * visible as characters, the background colour is only a hint. Control and bidi characters are made visible.
 */
export function UnifiedDiff(props: { text: string; label: string }) {
  const lines = useMemo(() => safeText(props.text).split('\n'), [props.text]);
  return (
    <pre className="diff plain" tabIndex={0} aria-label={props.label}>
      {lines.map((l, i) => (
        <span
          key={i}
          className={
            l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')
              ? 'diff-head'
              : l.startsWith('+')
                ? 'diff-add'
                : l.startsWith('-')
                  ? 'diff-del'
                  : l.startsWith('@@')
                    ? 'diff-hunk'
                    : ''
          }
        >
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * What a project template does before it is trusted: where it comes from, what it is compared with, the
 * risky points (computed by the manager) and the resolved template as a diff. Text comes from a file in a
 * project, so it is shown as plain text only.
 */
export function TemplateReviewPanel(props: { review: TemplateReview }) {
  const { t } = useApp();
  const r = props.review;
  return (
    <div className="template-review" data-testid="template-review">
      {r.changedSinceRequest ? (
        <Banner tone="danger">{t('review.changedSinceRequest')}</Banner>
      ) : null}
      <p className="plain">
        <strong>{safeText(r.template)}</strong> &middot; {t(`tpl.source.${r.source.kind}`)}
        {r.source.path ? <code className="plain"> {safeText(r.source.path)}</code> : null}{' '}
        {r.trusted ? (
          <Badge tone="ok">{t('review.trusted')}</Badge>
        ) : (
          <Badge tone="warn">{t('review.untrusted')}</Badge>
        )}
      </p>
      <p className="muted small plain">
        {t('review.comparedWith')}: {safeText(r.against.label)}
        {r.against.kind === 'none' ? ` – ${t('review.shownInFull')}` : ''}
      </p>
      {r.risks.length > 0 ? (
        <>
          <h4 className="h-small">{t('review.risks')}</h4>
          <ul className="risk-list">
            {r.risks.map((risk, i) => (
              <li key={i} className="plain">
                {safeText(risk)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4 className="h-small">{t('review.diff')}</h4>
      {r.diff === '' ? (
        <p className="muted">{t('review.noDifference')}</p>
      ) : (
        <UnifiedDiff text={r.diff} label={t('review.diffLabel')} />
      )}
    </div>
  );
}

/** Base image of a template, the registry it comes from and whether the profile's allowlist covers it. */
export function ImageUseBlock(props: { use: ImageUse }) {
  const { t } = useApp();
  const u = props.use;
  return (
    <div className="image-use" data-testid="image-use">
      <dl className="summary">
        <dt>{u.source === 'dockerfile' ? t('image.dockerfile') : t('image.image')}</dt>
        <dd>
          <code className="plain">{safeText(u.ref)}</code>
        </dd>
        {u.source === 'image' ? (
          <>
            <dt>{t('image.registry')}</dt>
            <dd>
              <code className="plain">
                {u.registry ? safeText(u.registry) : t('image.unknown')}
              </code>
            </dd>
          </>
        ) : null}
        {u.registries ? (
          <>
            <dt>{t('image.allowed')}</dt>
            <dd className="plain">
              {u.registries.length > 0 ? safeText(u.registries.join(', ')) : t('common.none')}
            </dd>
          </>
        ) : null}
      </dl>
      {u.outside ? (
        <Banner tone="warn">
          {u.source === 'dockerfile' ? t('image.dockerfileUnchecked') : t('image.outside')}
        </Banner>
      ) : null}
    </div>
  );
}
