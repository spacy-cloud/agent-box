import type { SandboxView } from '@abox/core';

export interface SandboxFilters {
  state: string; // '' = all, `active` = not failed/removed/expired
  owner: string; // '' = all, 'human', 'agent' (any agent) or a concrete owner
  template: string;
  text: string;
}

export const EMPTY_FILTERS: SandboxFilters = { state: '', owner: '', template: '', text: '' };

export function matchesFilters(s: SandboxView, f: SandboxFilters): boolean {
  if (f.state === 'active') {
    if (s.state === 'failed' || s.state === 'removed' || s.state === 'expired') return false;
  } else if (f.state && s.state !== f.state) return false;
  if (f.owner === 'agent') {
    if (!s.owner.startsWith('agent:')) return false;
  } else if (f.owner && s.owner !== f.owner) return false;
  if (f.template && s.template !== f.template) return false;
  const q = f.text.trim().toLowerCase();
  if (q) {
    const hay = [s.name, s.id, s.template, s.owner, s.host, s.workspace?.source ?? '']
      .join('\n')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterSandboxes(list: SandboxView[], f: SandboxFilters): SandboxView[] {
  return list.filter((s) => matchesFilters(s, f));
}

export function distinct(list: SandboxView[], pick: (s: SandboxView) => string): string[] {
  return [...new Set(list.map(pick))].sort();
}
