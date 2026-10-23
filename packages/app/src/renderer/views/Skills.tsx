import { useMemo, useState } from 'react';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { Badge, Banner, EmptyState, ErrorBox, Loading } from '../components/ui';
import { ProjectFolderPicker } from '../components/ProjectFolder';
import { formatBytes, safeInline, safeText } from '../../shared/format';
import type { SkillDetails, SkillListEntry } from '../../shared/types';

/**
 * The skill catalog (read-only): builtin, user (`~/.config/abox/skills`) and the skills of a project
 * folder. A skill is a folder with a SKILL.md that abox copies read-only into a sandbox. Its text is
 * foreign input, so it is shown as plain text and never rendered as Markdown or HTML.
 */
export function SkillsView() {
  const { t } = useApp();
  const [projectDir, setProjectDir] = useState('');
  const list = useQuery('skills:list', projectDir ? { projectDir } : undefined, { pollMs: 8000 });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const detail = useQuery(
    'skills:show',
    { name: selected || 'x', ...(projectDir ? { projectDir } : {}) },
    { enabled: selected !== '', live: false },
  );

  const entries = list.data?.skills ?? [];
  const filtered = useMemo(() => {
    const f = search.trim().toLowerCase();
    if (!f) return entries;
    return entries.filter((e) =>
      [e.name, e.description, e.source.kind].join(' ').toLowerCase().includes(f),
    );
  }, [entries, search]);

  /** Another project folder: a project skill of the old one is closed. */
  function changeProject(dir: string) {
    setProjectDir(dir);
    if (detail.data?.source.kind === 'project') setSelected('');
  }

  return (
    <section aria-labelledby="h-skills">
      <header className="page-head">
        <div>
          <h1 id="h-skills">{t('skills.title')}</h1>
          <p className="muted">{t('skills.intro')}</p>
        </div>
      </header>

      <div className="tpl-layout">
        <aside className="tpl-list" aria-label={t('skills.list')}>
          <ProjectFolderPicker
            value={projectDir}
            onChange={changeProject}
            applyLabel={t('skills.showProject')}
            hint={t('skills.projectHint')}
          />
          <form role="search" onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              <span className="sr-only">{t('skills.search')}</span>
              <input
                type="search"
                data-shortcut-search=""
                placeholder={t('skills.search')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoComplete="off"
              />
            </label>
          </form>
          {list.error ? <ErrorBox error={list.error} /> : null}
          {list.loading && !list.data ? <Loading /> : null}
          <ul className="tpl-items">
            {filtered.map((e) => (
              <li key={e.name}>
                <SkillItem
                  entry={e}
                  selected={selected === e.name}
                  onOpen={() => setSelected(e.name)}
                />
              </li>
            ))}
          </ul>
          {list.data && filtered.length === 0 ? (
            <p className="muted">{t('skills.noMatch')}</p>
          ) : null}
          {(list.data?.problems ?? []).length > 0 ? (
            <details className="tpl-problems">
              <summary>{t('skills.problems', { count: list.data!.problems.length })}</summary>
              <ul>
                {list.data!.problems.map((p) => (
                  <li key={p.path} className="plain small">
                    <code>{p.path}</code>: {p.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </aside>

        <div className="tpl-editor">
          {selected === '' ? (
            <EmptyState title={t('skills.empty.title')} text={t('skills.empty.text')} />
          ) : detail.error ? (
            <ErrorBox error={detail.error} />
          ) : !detail.data || detail.data.name !== selected ? (
            <Loading />
          ) : (
            <SkillDetail skill={detail.data} />
          )}
        </div>
      </div>
    </section>
  );
}

function SkillItem(props: { entry: SkillListEntry; selected: boolean; onOpen(): void }) {
  const { t } = useApp();
  const e = props.entry;
  return (
    <button
      type="button"
      className="tpl-item"
      aria-current={props.selected ? 'true' : undefined}
      onClick={props.onOpen}
    >
      <span className="tpl-item-head">
        <strong className="plain">{safeInline(e.name, 80)}</strong>
        <Badge tone={e.source.kind === 'user' ? 'info' : 'neutral'}>
          {t(`tpl.source.${e.source.kind}`)}
        </Badge>
      </span>
      <span className="muted small plain tpl-item-desc">{safeInline(e.description, 240)}</span>
      <span className="badges">
        <Badge tone="neutral">{t('skills.files', { count: e.fileCount })}</Badge>
        {e.shadows ? (
          <Badge tone="warn">
            {t('skills.shadows', { kinds: [...new Set(e.shadows.map((h) => h.kind))].join('/') })}
          </Badge>
        ) : null}
        {e.source.kind === 'project' ? (
          <Badge tone={e.trusted ? 'ok' : 'warn'}>
            {e.trusted ? t('skills.trusted') : t('skills.untrusted')}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}

function SkillDetail(props: { skill: SkillDetails }) {
  const { t } = useApp();
  const s = props.skill;
  const extra = Object.entries(s.frontMatter);
  return (
    <>
      <div className="tpl-toolbar">
        <div>
          <h2 className="plain tpl-name">{safeInline(s.name, 80)}</h2>
          <div className="badges">
            <Badge tone={s.source.kind === 'user' ? 'info' : 'neutral'}>
              {t(`tpl.source.${s.source.kind}`)}
            </Badge>
            <Badge tone="neutral">{t('tpl.readOnly')}</Badge>
          </div>
        </div>
      </div>
      {s.source.kind === 'project' ? (
        <Banner tone={s.trusted ? 'ok' : 'warn'}>
          {s.trusted ? t('skills.project.trusted') : t('skills.project.untrusted')}
        </Banner>
      ) : null}
      <dl className="kv-list">
        <dt>{t('skills.description')}</dt>
        <dd className="plain">{safeText(s.description)}</dd>
        <dt>{t('skills.source')}</dt>
        <dd>
          <code className="plain">{safeInline(s.source.path, 300)}</code>
          {s.shadows ? (
            <div className="muted small">
              {t('skills.shadowsHint', {
                kinds: [...new Set(s.shadows.map((h) => h.kind))].join('/'),
              })}
            </div>
          ) : null}
        </dd>
        <dt>{t('skills.sandboxPath')}</dt>
        <dd>
          <code>{s.sandboxPath}</code>
        </dd>
        <dt>{t('skills.filesLabel')}</dt>
        <dd>
          <ul className="plain-list">
            {s.files.map((f) => (
              <li key={f.path}>
                <code className="plain">{safeInline(f.path, 200)}</code>{' '}
                <span className="muted small">{formatBytes(f.size)}</span>
                {f.executable ? (
                  <>
                    {' '}
                    <Badge tone="neutral">{t('skills.executable')}</Badge>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="muted small">
            {t('skills.total', { size: formatBytes(s.totalBytes) })}
          </div>
        </dd>
        {extra.map(([k, v]) => (
          <div key={k} className="kv-row">
            <dt className="plain">{safeInline(k, 60)}</dt>
            <dd className="plain">{safeText(typeof v === 'string' ? v : JSON.stringify(v))}</dd>
          </div>
        ))}
        <dt>{t('skills.hash')}</dt>
        <dd className="mono">{s.contentHash.slice(0, 16)}</dd>
      </dl>
      <h3 className="h-small">SKILL.md</h3>
      <pre className="code plain skill-body" tabIndex={0} aria-label={t('skills.bodyLabel')}>
        {safeText(s.body)}
      </pre>
    </>
  );
}
