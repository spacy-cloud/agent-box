/**
 * Rows of the "effective options" table in the sandbox detail view. A row `deviates` when the sandbox
 * does not match what its template asks for, or is security relevant by itself (no isolation, open
 * network, extra mounts), so the view can highlight it.
 */
import type { ResolvedTemplate, SandboxView } from '@abox/core';
import { formatBytes, formatDuration } from './format';

export interface OverviewRow {
  /** i18n key suffix: `detail.opt.<id>` */
  id: string;
  /** Plain values (paths, numbers); enumerations carry `enumKey` instead. */
  values: string[];
  /** i18n key for an enumeration value (e.g. `network.open`). */
  enumKey?: string;
  deviates: boolean;
  /** Security-relevant deviation (rendered red). */
  danger: boolean;
  /** i18n key explaining the deviation. */
  noteKey?: string;
}

export function overviewRows(s: SandboxView, tpl?: ResolvedTemplate): OverviewRow[] {
  const rows: OverviewRow[] = [];
  const add = (r: Partial<OverviewRow> & Pick<OverviewRow, 'id' | 'values'>) =>
    rows.push({ deviates: false, danger: false, ...r });

  add({
    id: 'isolation',
    values: [],
    enumKey: `isolation.${s.isolation}`,
    deviates: s.isolation === 'none',
    danger: s.isolation === 'none',
    noteKey: s.isolation === 'none' ? 'detail.note.isolationNone' : undefined,
  });
  add({ id: 'backend', values: [s.backend] });

  const netDev = tpl ? tpl.network.mode !== s.network.mode : false;
  add({
    id: 'network',
    values: [],
    enumKey: `network.${s.network.mode}`,
    deviates: netDev || s.network.mode === 'open',
    danger: s.network.mode === 'open',
    noteKey:
      s.network.mode === 'open'
        ? 'detail.note.networkOpen'
        : netDev
          ? 'detail.note.differsTemplate'
          : undefined,
  });
  if (s.network.mode === 'allowlist') {
    const extra = tpl ? s.network.allow.filter((d) => !tpl.network.allow.includes(d)) : [];
    add({
      id: 'allow',
      values: s.network.allow,
      deviates: extra.length > 0,
      noteKey: extra.length > 0 ? 'detail.note.extraDestinations' : undefined,
    });
  }

  add({
    id: 'mounts',
    values: s.mounts.map((m) => `${m.hostPath} -> ${m.target} (${m.access})`),
    deviates: s.mounts.length > 0,
    danger: s.mounts.some((m) => m.access === 'rw'),
    noteKey: s.mounts.length > 0 ? 'detail.note.mounts' : undefined,
  });

  const differs = (a: number, b: number | undefined) => b !== undefined && a !== b;
  add({
    id: 'cpus',
    values: [String(s.resources.cpus)],
    deviates: differs(s.resources.cpus, tpl?.resources.cpus),
    noteKey: differs(s.resources.cpus, tpl?.resources.cpus)
      ? 'detail.note.differsTemplate'
      : undefined,
  });
  add({
    id: 'memory',
    values: [formatBytes(s.resources.memoryBytes)],
    deviates: differs(s.resources.memoryBytes, tpl?.resources.memoryBytes),
    noteKey: differs(s.resources.memoryBytes, tpl?.resources.memoryBytes)
      ? 'detail.note.differsTemplate'
      : undefined,
  });
  if (s.resources.pids !== undefined) add({ id: 'pids', values: [String(s.resources.pids)] });
  add({
    id: 'ttl',
    values: [formatDuration(s.resources.ttlMs)],
    deviates: differs(s.resources.ttlMs, tpl?.resources.ttlMs),
    noteKey: differs(s.resources.ttlMs, tpl?.resources.ttlMs)
      ? 'detail.note.differsTemplate'
      : undefined,
  });

  if (s.workspace) {
    const wsDev = tpl
      ? tpl.workspace.mode !== s.workspace.mode || tpl.workspace.access !== s.workspace.access
      : false;
    add({
      id: 'workspace',
      values: [
        `${s.workspace.mode} (${s.workspace.access})`,
        ...(s.workspace.source ? [s.workspace.source] : []),
        ...(s.workspace.branch ? [`branch ${s.workspace.branch}`] : []),
      ],
      deviates: wsDev,
      danger: s.workspace.mode === 'mount' && s.workspace.access === 'rw',
      noteKey:
        s.workspace.mode === 'mount' && s.workspace.access === 'rw'
          ? 'detail.note.mountRw'
          : wsDev
            ? 'detail.note.differsTemplate'
            : undefined,
    });
  }
  add({
    id: 'secrets',
    values: s.secretRefs.map(
      (r) => `${r.ref} (${r.inject}${r.hosts.length ? ': ' + r.hosts.join(', ') : ''})`,
    ),
    deviates: s.secretRefs.some((r) => r.inject !== 'proxy'),
    danger: s.secretRefs.some((r) => r.inject !== 'proxy'),
    noteKey: s.secretRefs.some((r) => r.inject !== 'proxy')
      ? 'detail.note.secretReadable'
      : undefined,
  });
  return rows;
}
