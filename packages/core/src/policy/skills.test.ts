import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateCreate, type CreateSkill } from './engine.js';
import { defaultPolicy, parsePolicy } from './load.js';
import { resolveContext } from './context.js';
import { humanContext, makeContext, makeEnv, mkReq } from './__tests__/helpers.js';
import type { TestEnv } from './__tests__/helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const skill = (o: Partial<CreateSkill> = {}): CreateSkill => ({
  name: 'run-tests',
  source: { kind: 'builtin', path: '/abox/skills/run-tests' },
  contentHash: 'a'.repeat(64),
  trusted: true,
  requested: true,
  ...o,
});

describe('policy: skills', () => {
  it('a profile without skills lets a request add none (the template skills need no entry)', () => {
    const ctx = makeContext(env);
    expect(ctx.profile.skills).toEqual([]);
    const ev = evaluateCreate(mkReq(env, ctx, { skills: [skill()] }));
    expect(ev.decision).toBe('deny');
    if (ev.decision === 'deny') {
      expect(ev.reasons).toContain('skill "run-tests" is not allowed for profile "p"');
      expect(ev.hint).toMatch(/skills: in policy\.yaml/);
    }
    expect(
      evaluateCreate(mkReq(env, ctx, { skills: [skill({ requested: false })] })).decision,
    ).toBe('allow');
  });

  it('named skills and * allow requested skills', () => {
    const named = makeContext(env, { skills: ['run-tests'] });
    expect(evaluateCreate(mkReq(env, named, { skills: [skill()] })).decision).toBe('allow');
    const other = evaluateCreate(mkReq(env, named, { skills: [skill({ name: 'other' })] }));
    expect(other.decision).toBe('deny');
    const any = makeContext(env, { skills: ['*'] });
    expect(evaluateCreate(mkReq(env, any, { skills: [skill({ name: 'other' })] })).decision).toBe(
      'allow',
    );
  });

  it('an unapproved project skill needs approval in every mode, also from the template', () => {
    for (const approval of ['open', 'medium']) {
      const ctx = makeContext(env, { approval, skills: ['*'] });
      const ev = evaluateCreate(
        mkReq(env, ctx, {
          skills: [
            skill({
              source: { kind: 'project', path: '/p/.sandbox/skills/x' },
              trusted: false,
              requested: false,
            }),
          ],
        }),
      );
      expect(ev.decision).toBe('approval');
      if (ev.decision === 'approval') {
        expect(ev.kinds).toEqual(['template_trust']);
        expect(ev.reasons[0]).toMatch(
          /^skill "run-tests" comes from a project source \(\/p\/\.sandbox\/skills\/x\)/,
        );
      }
    }
    // a human confirms it for one call
    const human = humanContext(env);
    const req = mkReq(env, human, {
      skills: [skill({ source: { kind: 'project' }, trusted: false })],
    });
    expect(evaluateCreate(req).decision).toBe('approval');
    expect(evaluateCreate({ ...req, humanConfirmed: true }).decision).toBe('allow');
  });

  it('binds the approval digest to the skills, and leaves digests without skills alone', () => {
    const ctx = makeContext(env, { skills: ['*'] });
    const plain = evaluateCreate(mkReq(env, ctx));
    expect(plain.requestDigest).not.toHaveProperty('skills');
    expect(plain.effective).not.toHaveProperty('skills');
    const a = evaluateCreate(mkReq(env, ctx, { skills: [skill(), skill({ name: 'b-skill' })] }));
    expect(a.effective.skills).toEqual(['b-skill', 'run-tests']);
    expect(a.requestDigest['skills']).toEqual([
      expect.objectContaining({ name: 'b-skill', contentHash: 'a'.repeat(64), trusted: true }),
      expect.objectContaining({ name: 'run-tests' }),
    ]);
    const changed = evaluateCreate(
      mkReq(env, ctx, { skills: [skill({ contentHash: 'b'.repeat(64) })] }),
    );
    expect(JSON.stringify(changed.requestDigest)).not.toBe(JSON.stringify(a.requestDigest));
  });

  it('the built-in policy and the human profile allow any skill; skills inherit like templates', () => {
    const def = defaultPolicy();
    expect(resolveContext(def, 'claude-code', { home: env.home }).profile.skills).toEqual(['*']);
    expect(humanContext(env).profile.skills).toEqual(['*']);
    const p = parsePolicy(
      'profiles:\n  a: { skills: [run-tests] }\n  b: { extends: a }\n  c: { extends: a, skills: [] }\ncontexts:\n  x: { profile: b }\n  y: { profile: c }\n',
      { kind: 'file', path: '/t/policy.yaml' },
    );
    expect(resolveContext(p, 'x', { home: env.home }).profile.skills).toEqual(['run-tests']);
    expect(resolveContext(p, 'y', { home: env.home }).profile.skills).toEqual([]);
    expect(() =>
      parsePolicy('profiles:\n  a: { skills: [Bad_Name] }\n', { kind: 'file', path: '/t/p.yaml' }),
    ).toThrow(/invalid skill name/);
  });
});
