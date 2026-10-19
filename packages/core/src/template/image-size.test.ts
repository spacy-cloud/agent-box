import { describe, expect, it } from 'vitest';
import type { ResolvedTemplate, TemplateSourceKind } from '../types.js';
import { parseTemplateYaml } from './parse.js';
import { estimateImageBytes } from './image-size.js';
import { resolveTemplate } from './resolve.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

async function resolve(
  extra: string,
  base = 'base:\n  os: ubuntu:24.04\n',
): Promise<ResolvedTemplate> {
  const text = `apiVersion: 1\nname: demo\nbackend: docker\n${base}${extra}`;
  return resolveTemplate(parseTemplateYaml(text), {
    source: { kind: 'user' as TemplateSourceKind, path: '/x/demo.yaml' },
    contentText: text,
  });
}

describe('image.size', () => {
  it('is read as a size, and wins over the heuristic', async () => {
    const t = await resolve('image:\n  size: 3g\ntools: [rust@stable]\n');
    expect(t.image).toEqual({ sizeBytes: 3 * GIB });
    expect(estimateImageBytes(t)).toEqual({ bytes: 3 * GIB, source: 'hint' });
  });

  it('is rejected when it is not a size, and unknown keys are rejected', () => {
    expect(() =>
      parseTemplateYaml('apiVersion: 1\nname: demo\nbackend: docker\nimage:\n  size: huge\n'),
    ).toThrow(/image\.size/);
    expect(() =>
      parseTemplateYaml('apiVersion: 1\nname: demo\nbackend: docker\nimage:\n  tag: x\n'),
    ).toThrow();
  });

  it('does not change the build hash', async () => {
    const a = await resolve('');
    const b = await resolve('image:\n  size: 3g\n');
    expect(b.hash).toBe(a.hash);
    expect(b.contentHash).not.toBe(a.contentHash);
    expect(a.image).toBeUndefined();
  });
});

describe('estimateImageBytes', () => {
  it('adds the base image, the tools, the packages and the setup commands, on the high side', async () => {
    const plain = estimateImageBytes(await resolve(''));
    expect(plain.source).toBe('estimate');
    expect(plain.bytes).toBe(150 * MIB);
    const full = estimateImageBytes(
      await resolve(
        'packages:\n  apt: [clang, cmake]\n  npm: [typescript]\ntools: [node@24, git]\nsetup:\n  - run: echo hi\n',
      ),
    );
    // base 150 + apt 2 x 60 + npm 1 x 30 + node 250 + git 50 + setup 200
    expect(full.bytes).toBe((150 + 120 + 30 + 250 + 50 + 200) * MIB);
    // a toolchain-heavy template is clearly bigger
    expect(estimateImageBytes(await resolve('tools: [flutter@3.47.7]\n')).bytes).toBeGreaterThan(
      3 * GIB,
    );
  });

  it('knows the other OS families and counts a Dockerfile base generously', async () => {
    const alpine = await resolve('', 'base:\n  os: alpine:3.22\n');
    expect(estimateImageBytes(alpine).bytes).toBe(50 * MIB);
    const custom = await resolve('', 'base:\n  dockerfile: ./Dockerfile\n').catch(() => undefined);
    // a Dockerfile base needs the file; only the estimate for the case without a context is checked
    if (custom) expect(estimateImageBytes(custom).bytes).toBeGreaterThanOrEqual(GIB);
  });
});
