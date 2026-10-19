import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../context';
import { useQuery } from '../../hooks';
import { Badge, Banner, ErrorBox, Loading } from '../ui';
import { safeInline } from '../../../shared/format';
import type { SetupBuild } from './builds';

const BUILDABLE = new Set(['docker', 'podman']);

/**
 * Step 4: prebuild the images of the templates the projects need, so the first sandbox starts at once. The
 * templates the project folders point to are preselected (`Abox.suggestTemplate`, from file names only). The build is the
 * normal build action; it runs in the background and the wizard does not wait for it.
 */
export function TemplatesStep(props: {
  /** Folders to look at: the ones chosen in this wizard plus the current workspace roots. */
  scanFolders: string[];
  builds: SetupBuild[];
  onBuild(names: string[]): void;
}) {
  const { t } = useApp();
  const list = useQuery('templates:list', undefined, { live: false });
  const scan = useQuery(
    'setup:scan',
    { folders: props.scanFolders },
    { live: false, enabled: props.scanFolders.length > 0 },
  );
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);

  const candidates = useMemo(
    () =>
      (list.data?.templates ?? []).filter(
        (x) => x.ready && x.allowed && x.source.kind !== 'project' && BUILDABLE.has(x.backend),
      ),
    [list.data],
  );
  const suggested = useMemo(
    () => new Map((scan.data?.templates ?? []).map((s) => [s.name, s])),
    [scan.data],
  );
  const scanDone =
    props.scanFolders.length === 0 || scan.data !== undefined || scan.error !== undefined;
  const rows = useMemo(
    () =>
      [...candidates].sort(
        (a, b) =>
          Number(suggested.has(b.name)) - Number(suggested.has(a.name)) ||
          a.name.localeCompare(b.name),
      ),
    [candidates, suggested],
  );

  // Preselect what the projects point to, once both answers are in.
  useEffect(() => {
    if (chosen === null && list.data && scanDone) {
      setChosen(new Set(candidates.filter((x) => suggested.has(x.name)).map((x) => x.name)));
    }
  }, [chosen, list.data, scanDone, candidates, suggested]);

  const picked = rows.map((r) => r.name).filter((n) => chosen?.has(n));
  const building = props.builds.some((b) => b.status === 'queued' || b.status === 'running');
  return (
    <>
      <p>{t('setup.templates.intro')}</p>
      <Banner tone="warn">{t('tpl.build.networkWarning')}</Banner>
      {list.error ? <ErrorBox error={list.error} /> : null}
      {scan.error ? <ErrorBox error={scan.error} /> : null}
      {(list.loading && !list.data) || (!scanDone && props.scanFolders.length > 0) ? (
        <Loading />
      ) : null}
      {list.data && rows.length === 0 ? (
        <Banner tone="info">{t('setup.templates.noEngine')}</Banner>
      ) : null}
      {scan.data ? (
        <p className="muted small" data-testid="scan-summary">
          {suggested.size > 0
            ? t('setup.templates.scanned', { count: scan.data.scanned })
            : t('setup.templates.noSuggestion')}
          {scan.data.truncated ? ` ${t('setup.templates.truncated')}` : ''}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <fieldset className="template-pick">
          <legend>{t('setup.templates.choose')}</legend>
          <ul className="plain-list">
            {rows.map((r) => {
              const s = suggested.get(r.name);
              return (
                <li key={r.name} className="template-pick-row">
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={chosen?.has(r.name) === true}
                      onChange={(e) => {
                        const next = new Set(chosen ?? []);
                        if (e.target.checked) next.add(r.name);
                        else next.delete(r.name);
                        setChosen(next);
                      }}
                    />
                    <strong>{r.name}</strong>
                  </label>{' '}
                  {s ? (
                    <Badge tone="info">
                      {t('setup.templates.suggested', {
                        count: s.projects,
                        examples: safeInline(s.examples.join(', '), 120),
                      })}
                    </Badge>
                  ) : null}
                  <div className="muted small plain">{safeInline(r.description, 200)}</div>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}
      {rows.length > 0 ? (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={picked.length === 0 || building}
            onClick={() => props.onBuild(picked)}
          >
            {t('setup.templates.build', { count: picked.length })}
          </button>
          <span className="muted small">{t('setup.templates.background')}</span>
        </div>
      ) : null}
      <BuildList builds={props.builds} />
    </>
  );
}

export function BuildList(props: { builds: SetupBuild[] }) {
  const { t } = useApp();
  if (props.builds.length === 0) return null;
  return (
    <ul
      className="plain-list build-list"
      aria-label={t('setup.templates.progress')}
      aria-live="polite"
    >
      {props.builds.map((b) => (
        <li key={b.name} className="plain">
          <strong>{b.name}</strong>{' '}
          <Badge
            tone={
              b.status === 'failed'
                ? 'danger'
                : b.status === 'built' || b.status === 'cached'
                  ? 'ok'
                  : 'neutral'
            }
          >
            {t(`setup.templates.status.${b.status}`)}
          </Badge>
          {b.status === 'running' && b.line ? (
            <div className="muted small mono plain">{b.line}</div>
          ) : null}
          {b.status === 'failed' && b.error ? (
            <div className="danger-text small plain">{b.error}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
