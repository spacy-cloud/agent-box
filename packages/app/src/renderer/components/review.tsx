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
      {r.buildContext ? (
        <BuildContextBlock ctx={r.buildContext} full={r.against.kind === 'previous'} />
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

/**
 * The Dockerfile of a template and what else is sent to the engine with it: the files of the build
 * context with their sizes. The Dockerfile is part of the diff below; against a trusted version the
 * diff shows only the changes, so it is listed in full as well.
 */
function BuildContextBlock(props: {
  ctx: NonNullable<TemplateReview['buildContext']>;
  full: boolean;
}) {
  const { t } = useApp();
  const c = props.ctx;
  return (
    <div className="build-context" data-testid="build-context">
      <h4 className="h-small">{t('review.buildContext')}</h4>
      <p className="muted small plain">
        <code className="plain">{safeText(c.dir)}</code> &middot;{' '}
        {t('review.buildContextSummary', { files: c.fileCount, bytes: c.totalBytes })}
      </p>
      <ul className="plain-list" aria-label={t('review.buildContextFiles')}>
        {c.files.map((f) => (
          <li key={f.path} className="plain">
            <code className="plain">{safeText(f.path)}</code>
            {f.type === 'symlink' ? (
              <> &rarr; {safeText(f.target ?? '')}</>
            ) : (
              <> &middot; {t('review.bytes', { bytes: f.size })}</>
            )}
            {f.path === c.dockerfile ? <> &middot; Dockerfile</> : null}
          </li>
        ))}
        {c.filesTruncated ? (
          <li className="muted">{t('review.moreFiles', { n: c.fileCount - c.files.length })}</li>
        ) : null}
      </ul>
      {props.full ? (
        <>
          <h4 className="h-small">
            {t('review.dockerfileFull', { name: safeText(c.dockerfile) })}
          </h4>
          <pre className="plain" tabIndex={0} aria-label={t('review.dockerfileLabel')}>
            {safeText(c.dockerfileText)}
          </pre>
        </>
      ) : null}
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
