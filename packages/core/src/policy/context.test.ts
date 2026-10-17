import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AboxError } from '../errors.js';
import { resolveContext } from './context.js';
import { defaultPolicy, parsePolicy } from './load.js';
import { makeEnv, type TestEnv } from './__tests__/helpers.js';

let env: TestEnv;
beforeAll(() => {
  env = makeEnv();
});
afterAll(() => env.cleanup());

const parse = (t: string) => parsePolicy(t, { kind: 'file', path: '/test/policy.yaml' });

describe('resolveContext', () => {
  it('resolves the built-in human context', () => {
    const ctx = resolveContext(defaultPolicy(), 'human', { home: env.home });
    expect(ctx).toMatchObject({ id: 'human', kind: 'human', profileName: 'human', owner: 'human' });
    expect(ctx.allowedHosts).toEqual(['*']);
    // Humans are not limited by roots (only the forbidden-path list applies).
    expect(ctx.workspaceRoots).toEqual(['*']);
    expect(ctx.mountRoots).toEqual(['*']);
  });

  it('a human profile with explicit roots in policy.yaml gets canonical roots', () => {
    const p = parse('profiles:\n  human:\n    workspace: { roots: [~/projects] }\n');
    const ctx = resolveContext(p, 'human', { home: env.home });
    expect(ctx.workspaceRoots).toEqual([env.projects]);
    expect(ctx.mountRoots).toEqual(['*']);
  });

  it('resolves an agent context with owner agent:<id> and the merged profile', () => {
    const p = parse(
      'profiles:\n  base: { templates: [a], hosts: [local] }\n  child: { extends: base, approval: open }\ncontexts:\n  claude-code/work: { profile: child }\n',
    );
    const ctx = resolveContext(p, 'claude-code/work', { home: env.home });
    expect(ctx).toMatchObject({
      id: 'claude-code/work',
      kind: 'agent',
      profileName: 'child',
      owner: 'agent:claude-code/work',
    });
    expect(ctx.profile.templates).toEqual(['a']);
    expect(ctx.profile.approval).toBe('open');
    expect(ctx.allowedHosts).toEqual(['local']);
  });

  it('denies unknown context ids (policy_denied), including prototype names', () => {
    const p = defaultPolicy();
    for (const id of [
      'nope',
      '',
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
      'HUMAN',
      'human ',
    ]) {
      let err: unknown;
      try {
        resolveContext(p, id, { home: env.home });
      } catch (e) {
        err = e;
      }
      expect(err, id).toBeInstanceOf(AboxError);
      expect((err as AboxError).code).toBe('policy_denied');
    }
    expect(() => resolveContext(p, undefined as unknown as string)).toThrow(AboxError);
  });

  it('an agent context cannot become kind human by naming', () => {
    const p = parse('profiles:\n  a: {}\ncontexts:\n  human2: { profile: human }\n');
    expect(resolveContext(p, 'human2', { home: env.home })).toMatchObject({
      kind: 'agent',
      owner: 'agent:human2',
    });
  });

  it('context hosts override the profile hosts', () => {
    const p = parse(
      'profiles:\n  a: { hosts: [local] }\ncontexts:\n  x: { profile: a, hosts: [local, lab] }\n  y: { profile: a }\n',
    );
    expect(resolveContext(p, 'x', { home: env.home }).allowedHosts).toEqual(['local', 'lab']);
    expect(resolveContext(p, 'y', { home: env.home }).allowedHosts).toEqual(['local']);
  });

  it('defaults to local only for the default policy agent context', () => {
    expect(resolveContext(defaultPolicy(), 'default', { home: env.home }).allowedHosts).toEqual([
      'local',
    ]);
  });

  it('canonicalizes roots (~ expansion, symlinks, double slashes)', () => {
    const real = join(env.root, 'real-projects');
    mkdirSync(real);
    symlinkSync(real, join(env.home, 'linked'));
    const p = parse(
      'profiles:\n  a:\n    workspace: { roots: [~/linked, ~/projects//./app] }\n    mounts: { roots: [~/datasets/], access: [ro] }\ncontexts:\n  x: { profile: a }\n',
    );
    const ctx = resolveContext(p, 'x', { home: env.home });
    expect(ctx.workspaceRoots).toEqual([real, env.app]);
    expect(ctx.mountRoots).toEqual([env.datasets]);
  });

  it('has no mount roots when mounts are denied', () => {
    const p = parse('profiles:\n  a: { mounts: deny }\ncontexts:\n  x: { profile: a }\n');
    expect(resolveContext(p, 'x', { home: env.home }).mountRoots).toEqual([]);
  });
});
