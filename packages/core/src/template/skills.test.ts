import { describe, expect, it } from 'vitest';
import { AboxError } from '../errors.js';
import type { ResolvedTemplate } from '../types.js';
import { parseTemplateYaml } from './parse.js';
import { renderTemplateSnapshot, templateRisks } from './review.js';
import { resolveTemplate, type TemplateLookup } from './resolve.js';

const head = (name = 'demo'): string =>
  `apiVersion: 1\nname: ${name}\nbackend: docker\nbase:\n  os: ubuntu:24.04\n`;

async function resolve(text: string, lookup?: TemplateLookup): Promise<ResolvedTemplate> {
  return resolveTemplate(parseTemplateYaml(text), {
    source: { kind: 'user', path: '/x/user.yaml' },
    contentText: text,
    lookup,
  });
}

function schemaProblems(text: string): string[] {
  try {
    parseTemplateYaml(text);
  } catch (e) {
    expect(e).toBeInstanceOf(AboxError);
    return (e as AboxError).issues.map((i) => `${i.path}: ${i.message}`);
  }
  throw new Error('expected the schema to reject the template');
}

describe('template skills', () => {
  it('lists skills by name; absent means none', async () => {
    expect((await resolve(`${head()}skills: [run-tests, minimal-change]\n`)).skills).toEqual([
      'run-tests',
      'minimal-change',
    ]);
    expect((await resolve(head())).skills).toBeUndefined();
  });

  it('rejects bad names, duplicates and too many entries', () => {
    expect(schemaProblems(`${head()}skills: [Run_Tests]\n`)[0]).toMatch(
      /^skills\[0\]: skills entries/,
    );
    expect(schemaProblems(`${head()}skills: [a, b, a]\n`)[0]).toMatch(
      /^skills\[2\]: skill "a" is listed twice/,
    );
    const many = Array.from({ length: 33 }, (_, i) => `s${i}`).join(', ');
    expect(schemaProblems(`${head()}skills: [${many}]\n`)[0]).toMatch(/at most 32 skills/);
  });

  it('extends merges skills as a union, parent first', async () => {
    const parent = `${head('base-tpl')}skills: [run-tests, minimal-change]\n`;
    const lookup: TemplateLookup = async (name) =>
      name === 'base-tpl'
        ? {
            spec: parseTemplateYaml(parent),
            source: { kind: 'user', path: '/x/base.yaml' },
            contentText: parent,
          }
        : undefined;
    const child = await resolve(
      `${head()}extends: base-tpl\nskills: [minimal-change, own]\n`,
      lookup,
    );
    expect(child.skills).toEqual(['run-tests', 'minimal-change', 'own']);
    const inherited = await resolve(`${head()}extends: base-tpl\n`, lookup);
    expect(inherited.skills).toEqual(['run-tests', 'minimal-change']);
  });

  it('skills do not change the image hash, but show in the review', async () => {
    const without = await resolve(head());
    const withSkills = await resolve(`${head()}skills: [run-tests]\n`);
    expect(withSkills.hash).toBe(without.hash);
    expect(withSkills.contentHash).not.toBe(without.contentHash);
    expect(renderTemplateSnapshot(withSkills)).toContain('skills:\n  - run-tests');
    expect(templateRisks(withSkills)).toContainEqual(
      expect.stringMatching(/gives the agent the skill run-tests/),
    );
  });
});
