import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_REGISTRIES,
  KNOWN_BASE_IMAGES as CORE_KNOWN,
  imageAllowedByRegistries as coreAllowed,
  imageRepository as coreRepository,
  isKnownBaseImage as coreKnown,
} from '@abox/core';
import { kindHintKey, kindLabelKey } from '../../src/shared/approval-diff';
import { safeText } from '../../src/shared/format';
import {
  KNOWN_BASE_IMAGES,
  describeBase,
  imageAllowedByRegistries,
  imageRepository,
  isKnownBaseImage,
} from '../../src/shared/image-ref';
import de from '../../src/renderer/i18n/de.json';
import en from '../../src/renderer/i18n/en.json';

const SAMPLES = [
  'ubuntu:24.04',
  'ubuntu',
  'ubuntu:22.04',
  'python:3.13-slim-bookworm',
  'alpine:3.22',
  'docker.io/library/ubuntu:24.04',
  'index.docker.io/library/alpine:3.22',
  'library/ubuntu',
  'someone/tools:1',
  'ghcr.io/org/tools:1',
  'ghcr.io/org/tools@sha256:' + 'a'.repeat(64),
  'GHCR.IO/org/tools',
  'localhost:5000/dev/img',
  'registry.example.org:5000/a/b/c:tag',
  'quay.io/x',
  'ghcr.io/Org/Tools',
  'a b',
  '../evil',
  'docker.io/library/../evil',
  'ghcr.io/',
  'x@sha256:short',
  '',
  'a'.repeat(256),
];
const REGISTRIES = [
  [],
  ['*'],
  ['docker.io/library'],
  ['docker.io'],
  ['ghcr.io'],
  ['ghcr.io/org'],
  ['GHCR.IO/ORG/'],
  ['docker.io/library', 'quay.io'],
  ['not a registry'],
  ['library'],
];

describe('image helpers agree with the policy engine of @abox/core', () => {
  it('the built-in base images are the same', () => {
    expect([...KNOWN_BASE_IMAGES]).toEqual([...CORE_KNOWN]);
    expect([...DEFAULT_IMAGE_REGISTRIES]).toEqual(['docker.io/library']);
  });
  it('repository, known base and allowlist decisions are identical', () => {
    for (const s of SAMPLES) {
      expect(imageRepository(s), s).toBe(coreRepository(s));
      expect(isKnownBaseImage(s), s).toBe(coreKnown(s));
      for (const r of REGISTRIES)
        expect(imageAllowedByRegistries(s, r), `${s} / ${r}`).toBe(coreAllowed(s, r));
    }
  });
});

describe('describeBase', () => {
  const agent = ['docker.io/library'];
  it('names image, registry and whether the allowlist covers it', () => {
    expect(describeBase({ os: 'ghcr.io/other/tools:1' }, 'docker', agent)).toEqual({
      ref: 'ghcr.io/other/tools:1',
      source: 'image',
      registry: 'ghcr.io',
      repository: 'other/tools',
      registries: agent,
      outside: true,
    });
    // Docker Hub short names expand; official images are inside docker.io/library
    expect(describeBase({ os: 'debian:12' }, 'podman', agent)).toMatchObject({
      registry: 'docker.io',
      repository: 'library/debian',
      outside: false,
    });
    expect(describeBase({ os: 'someone/tools' }, 'docker', agent)).toMatchObject({
      registry: 'docker.io',
      outside: true,
    });
    // built-in bases are accepted whatever the list says
    expect(describeBase({ os: 'alpine:3.22' }, 'docker', [])?.outside).toBe(false);
    expect(describeBase({ os: 'ghcr.io/x/y' }, 'python', ['*'])?.outside).toBe(false);
  });
  it('a malformed name has no registry and counts as outside', () => {
    expect(describeBase({ os: 'Not A Name' }, 'docker', agent)).toMatchObject({
      registry: null,
      outside: true,
    });
  });
  it('a Dockerfile base cannot be checked unless everything is allowed', () => {
    expect(describeBase({ dockerfile: './Dockerfile' }, 'docker', agent)).toMatchObject({
      source: 'dockerfile',
      registry: null,
      outside: true,
    });
    expect(describeBase({ dockerfile: './Dockerfile' }, 'docker', ['*'])?.outside).toBe(false);
  });
  it('shows nothing for vm bases (distro names) or without a base; unknown profile gives no verdict', () => {
    expect(describeBase({ os: 'debian-12' }, 'vm', agent)).toBeUndefined();
    expect(describeBase(undefined, 'docker', agent)).toBeUndefined();
    expect(describeBase({}, 'docker', agent)).toBeUndefined();
    expect(describeBase({ os: 'ghcr.io/x/y' }, 'docker', null)).toMatchObject({
      registry: 'ghcr.io',
      registries: null,
      outside: null,
    });
  });
});

describe('request kinds', () => {
  it('known kinds map to their label, anything else to the generic one', () => {
    for (const k of ['create', 'exec', 'access', 'template_trust', 'image_registry']) {
      expect(kindLabelKey(k), k).toBe(`approvals.kind.${k}`);
      expect((en as Record<string, string>)[`approvals.kind.${k}`], k).toBeTruthy();
      expect((de as Record<string, string>)[`approvals.kind.${k}`], k).toBeTruthy();
    }
    for (const k of ['future_thing', '', 'unknown', 'template_trust.hint', '__proto__']) {
      expect(kindLabelKey(k), k).toBe('approvals.kind.unknown');
      expect(kindHintKey(k), k).toBe('approvals.kind.unknown.hint');
    }
  });
  it('the explanations exist in both languages', () => {
    for (const k of ['template_trust', 'image_registry']) {
      const key = kindHintKey(k)!;
      expect(key).toBe(`approvals.kind.${k}.hint`);
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((de as Record<string, string>)[key]).toBeTruthy();
    }
    expect(kindHintKey('create')).toBeNull();
    expect(kindHintKey('exec')).toBeNull();
    expect((en as Record<string, string>)['approvals.kind.unknown.hint']).toBeTruthy();
    expect((de as Record<string, string>)['approvals.kind.unknown']).toContain('{kind}');
  });
});

describe('safeText', () => {
  it('makes control, bidi and zero-width characters visible, keeps newlines and tabs', () => {
    expect(safeText('a\u001b[31mred\u0007')).toBe('a\\x1b[31mred\\x07');
    expect(safeText('x‮y​z⁦')).toBe('x\\u202ey\\u200bz\\u2066');
    expect(safeText('line1\nline2\tok\r\n')).toBe('line1\nline2\tok\r\n'.replace('\r', '\\x0d'));
    expect(safeText('plain ä ü € text')).toBe('plain ä ü € text');
  });
});
