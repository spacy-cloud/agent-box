import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveContext } from './context.js';
import { evaluateCreate, type CreateEvaluation } from './engine.js';
import { parsePolicy } from './load.js';
import { canonicalizePath, checkHostPath, lexicalPath } from './paths.js';
import { GIB, HOUR, makeContext, mkReq, type TestEnv } from './__tests__/helpers.js';

/**
 * A machine where `~/Projekte` is a symlink to another disk (`/data/Projekte`): the canonical path
 * of a project lies outside the home directory.
 */
let root: string;
let env: TestEnv;
let outside: string;
let linked: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-hroots-')));
  const home = join(root, 'home');
  outside = join(root, 'data', 'Projekte');
  linked = join(home, 'Projekte');
  mkdirSync(join(outside, 'x'), { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(home, 'projects'), { recursive: true });
  symlinkSync(outside, linked);
  symlinkSync(join(home, '.ssh'), join(home, 'sneaky'));
  // a project directory below the (real) root whose content lives elsewhere
  mkdirSync(join(root, 'elsewhere', 'proj'), { recursive: true });
  symlinkSync(join(root, 'elsewhere', 'proj'), join(home, 'projects', 'linked-proj'));
  env = {
    root,
    home,
    projects: join(home, 'projects'),
    app: join(outside, 'x'),
    datasets: join(home, 'datasets'),
    sshDir: join(home, '.ssh'),
    cleanup: () => undefined,
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function humanWith(policyText: string) {
  const policy = parsePolicy(policyText, { kind: 'file', path: '/test/policy.yaml' });
  return resolveContext(policy, 'human', { home: env.home });
}

/** Mirrors the manager: canonical path for the check, the typed path as `lexicalPath`. */
function createAt(
  ctx: ReturnType<typeof humanWith>,
  typed: string,
  mode: 'copy' | 'mount' = 'copy',
): CreateEvaluation {
  const opts = { home: env.home, cwd: env.home };
  const lexical = lexicalPath(typed, opts);
  return evaluateCreate(
    mkReq(env, ctx, {
      workspace: {
        mode,
        hostPath: canonicalizePath(typed, opts),
        ...(lexical ? { lexicalPath: lexical } : {}),
      },
      resources: { cpus: 2, memoryBytes: 4 * GIB },
      ttlMs: HOUR,
    }),
  );
}

describe('human context: no roots', () => {
  const human = () => humanWith('profiles: {}\n');

  it('uses a project reached through a symlink that leaves $HOME', () => {
    const canonical = canonicalizePath('~/Projekte/x', { home: env.home, cwd: env.home });
    expect(canonical).toBe(join(outside, 'x'));
    expect(createAt(human(), '~/Projekte/x').decision).not.toBe('deny');
    expect(createAt(human(), join(linked, 'x'), 'mount').decision).not.toBe('deny');
  });

  it('uses any other directory outside the home directory, too', () => {
    expect(createAt(human(), join(root, 'elsewhere', 'proj')).decision).not.toBe('deny');
  });

  it('the forbidden-path list still applies, on the canonical path', () => {
    const r = createAt(human(), '~/sneaky');
    expect(r.decision).toBe('deny');
    if (r.decision === 'deny') expect(r.reasons.join(' ')).toContain('protected path');
    expect(createAt(human(), env.home).decision).toBe('deny');
    expect(createAt(human(), '/etc').decision).toBe('deny');
  });

  it('allows a mount outside $HOME for a human (mount roots are open, too)', () => {
    const ctx = human();
    const r = evaluateCreate(
      mkReq(env, ctx, {
        workspace: { mode: 'empty' },
        mounts: [{ hostPath: join(outside, 'x'), target: '/data', access: 'ro' }],
      }),
    );
    expect(r.decision).not.toBe('deny');
  });
});

describe('human context: explicit roots in policy.yaml are honoured', () => {
  const text = 'profiles:\n  human:\n    workspace: { roots: [~/projects] }\n';

  it('rejects a path outside the roots', () => {
    const r = createAt(humanWith(text), '~/Projekte/x');
    expect(r.decision).toBe('deny');
    if (r.decision === 'deny') expect(r.reasons.join(' ')).toContain('outside the allowed');
  });

  it('accepts a project whose typed path is inside a root although its canonical path is not', () => {
    // ~/projects/linked-proj -> /.../elsewhere/proj
    expect(createAt(humanWith(text), '~/projects/linked-proj').decision).not.toBe('deny');
  });

  it('a root that is itself a symlink is compared canonically', () => {
    const t = 'profiles:\n  human:\n    workspace: { roots: [~/Projekte] }\n';
    expect(createAt(humanWith(t), '~/Projekte/x').decision).not.toBe('deny');
    expect(createAt(humanWith(t), join(outside, 'x')).decision).not.toBe('deny');
    expect(createAt(humanWith(t), '~/projects/linked-proj').decision).toBe('deny');
  });

  it('never accepts a typed path that contains ..', () => {
    expect(lexicalPath('~/projects/linked-proj/../x', { home: env.home, cwd: env.home })).toBe(
      undefined,
    );
    expect(createAt(humanWith(text), '~/projects/linked-proj/../proj').decision).toBe('deny');
  });

  it('the forbidden list wins over a lexical match', () => {
    const t = 'profiles:\n  human:\n    workspace: { roots: [~/] }\n';
    expect(createAt(humanWith(t), '~/sneaky').decision).toBe('deny');
  });
});

describe('agent context: symlinks are not trusted', () => {
  it('an agent cannot use a symlink inside its root that points outside', () => {
    const ctx = makeContext(env, {});
    const r = evaluateCreate(
      mkReq(env, ctx, {
        workspace: {
          mode: 'copy',
          hostPath: canonicalizePath('~/projects/linked-proj', { home: env.home, cwd: env.home }),
          // even if a caller handed in the typed path, an agent's check ignores it
          lexicalPath: join(env.projects, 'linked-proj'),
        },
      }),
    );
    expect(r.decision).toBe('deny');
    if (r.decision === 'deny') expect(r.reasons.join(' ')).toContain('outside the allowed');
  });

  it('roots: ["*"] cannot be written in policy.yaml', () => {
    expect(() =>
      parsePolicy("profiles:\n  p:\n    workspace: { roots: ['*'] }\n", {
        kind: 'file',
        path: 'p',
      }),
    ).toThrow(/absolute path/);
  });
});

describe('checkHostPath: lexicalPath', () => {
  it('is only a second chance for the roots check', () => {
    const canonical = join(root, 'elsewhere', 'proj');
    const base = { home: env.home, kind: 'workspace' as const, roots: [env.projects] };
    expect(checkHostPath(canonical, base).ok).toBe(false);
    expect(checkHostPath(canonical, { ...base, lexicalPath: join(env.projects, 'x') }).ok).toBe(
      true,
    );
    expect(checkHostPath(canonical, { ...base, lexicalPath: join(root, 'other') }).ok).toBe(false);
  });
});

describe('lexicalPath', () => {
  const o = () => ({ home: env.home, cwd: join(env.home, 'cwd') });
  it('expands ~, resolves relative paths and normalizes without following symlinks', () => {
    expect(lexicalPath('~/Projekte//x/./y', o())).toBe(join(env.home, 'Projekte', 'x', 'y'));
    expect(lexicalPath('rel/dir', o())).toBe(join(env.home, 'cwd', 'rel', 'dir'));
    expect(lexicalPath('~', o())).toBe(env.home);
  });
  it('returns undefined for .., ~user, empty and control characters', () => {
    for (const bad of ['a/../b', '~bob/x', '', 'a\u0000b', '/x/\u202Ey'])
      expect(lexicalPath(bad, o()), bad).toBeUndefined();
  });
});
