import { describe, expect, it } from 'vitest';
import { parsePolicy } from '@abox/core';
import { proposeWorkspaceRoots, rootEntryFor } from '../../src/shared/workspace-roots';

const POLICY = `# my policy
version: 1
profiles:
  agent:
    approval: medium
    templates: [node-dev]
    # projects below these folders only
    workspace: { roots: ['~/projects'], modes: [copy, empty] }
  child:
    extends: agent
  bare:
    approval: strict
contexts:
  claude-code: { profile: agent }
`;

describe('proposeWorkspaceRoots', () => {
  it('appends to the roots of the profile and keeps comments and layout', () => {
    const r = proposeWorkspaceRoots(POLICY, 'agent', ['~/projects'], ['~/work', '/data/app']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toEqual(['~/work', '/data/app']);
    expect(r.text).toContain('# projects below these folders only');
    expect(r.text).toContain('# my policy');
    const before = POLICY.split('\n');
    const after = r.text.split('\n');
    // only the workspace line changed
    expect(after.length).toBe(before.length);
    expect(after.filter((l, i) => l !== before[i])).toHaveLength(1);
    // the result is a valid policy with the new roots, in order
    const p = parsePolicy(r.text, { kind: 'default' });
    expect(p.profiles['agent']!.workspace.roots).toEqual(['~/projects', '~/work', '/data/app']);
    expect(p.profiles['agent']!.workspace.modes).toEqual(['copy', 'empty']);
  });

  it('does not add a root that is already there', () => {
    const r = proposeWorkspaceRoots(POLICY, 'agent', ['~/projects'], ['~/projects', '~/work']);
    expect(r).toMatchObject({ ok: true, added: ['~/work'] });
  });

  it('a profile that inherits its roots gets the inherited list plus the new one (a child list replaces the parent)', () => {
    const r = proposeWorkspaceRoots(POLICY, 'child', ['~/projects'], ['~/work']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = parsePolicy(r.text, { kind: 'default' });
    expect(p.profiles['child']!.workspace.roots).toEqual(['~/projects', '~/work']);
    // the parent is untouched
    expect(p.profiles['agent']!.workspace.roots).toEqual(['~/projects']);
  });

  it('a profile without any workspace section gets one', () => {
    const r = proposeWorkspaceRoots(POLICY, 'bare', [], ['~/work']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parsePolicy(r.text, { kind: 'default' }).profiles['bare']!.workspace.roots).toEqual([
      '~/work',
    ]);
  });

  it('quotes a path YAML would misread', () => {
    const r = proposeWorkspaceRoots(POLICY, 'agent', ['~/projects'], ['~/my #1 projects']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parsePolicy(r.text, { kind: 'default' }).profiles['agent']!.workspace.roots).toContain(
      '~/my #1 projects',
    );
  });

  it('reports a profile that is not in the file and a text that does not parse', () => {
    expect(proposeWorkspaceRoots(POLICY, 'human', [], ['~/x'])).toEqual({
      ok: false,
      error: 'no_profile',
    });
    expect(proposeWorkspaceRoots('a: [1', 'agent', [], ['~/x'])).toEqual({
      ok: false,
      error: 'parse',
    });
  });
});

describe('rootEntryFor', () => {
  it('writes ~/… below the home directory and the absolute path elsewhere', () => {
    expect(rootEntryFor('/home/u/projects', '/home/u')).toBe('~/projects');
    expect(rootEntryFor('/home/u/a/b', '/home/u/')).toBe('~/a/b');
    expect(rootEntryFor('/data/app', '/home/u')).toBe('/data/app');
    expect(rootEntryFor('/home/user2/x', '/home/u')).toBe('/home/user2/x');
    expect(rootEntryFor('/home/u', '/home/u')).toBe('/home/u');
  });
});
