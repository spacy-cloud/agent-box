import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { builtinTemplatesDir } from '../template/catalog.js';
import {
  DEFAULT_IMAGE_REGISTRIES,
  KNOWN_BASE_IMAGES,
  imageAllowedByRegistries,
  imageRegistry,
  imageRepository,
  isKnownBaseImage,
  normalizeRegistryPattern,
} from './images.js';

describe('imageRegistry', () => {
  it.each([
    ['ubuntu:24.04', 'docker.io'],
    ['myorg/app', 'docker.io'],
    ['index.docker.io/library/ubuntu', 'docker.io'],
    ['GHCR.io/my-org/app:v1', 'ghcr.io'],
    ['localhost:5000/app', 'localhost:5000'],
  ])('%s -> %s', (ref, expected) => {
    expect(imageRegistry(ref)).toBe(expected);
  });
  it('is undefined for malformed names', () => {
    expect(imageRegistry('docker.io/library/../evil')).toBeUndefined();
    expect(imageRegistry('')).toBeUndefined();
  });
});

describe('imageRepository', () => {
  it.each([
    ['ubuntu', 'docker.io/library/ubuntu'],
    ['ubuntu:24.04', 'docker.io/library/ubuntu'],
    ['library/ubuntu:24.04', 'docker.io/library/ubuntu'],
    ['docker.io/library/ubuntu:24.04', 'docker.io/library/ubuntu'],
    ['index.docker.io/library/ubuntu', 'docker.io/library/ubuntu'],
    ['registry-1.docker.io/myorg/app:1', 'docker.io/myorg/app'],
    ['myorg/app', 'docker.io/myorg/app'],
    ['GHCR.io/my-org/app:v1', 'ghcr.io/my-org/app'],
    ['ghcr.io/my-org/app@sha256:' + 'a'.repeat(64), 'ghcr.io/my-org/app'],
    ['ubuntu:24.04@sha256:' + 'b'.repeat(64), 'docker.io/library/ubuntu'],
    ['localhost/app:dev', 'localhost/app'],
    ['localhost:5000/app', 'localhost:5000/app'],
    ['registry.example.org:5000/team/app:1.2', 'registry.example.org:5000/team/app'],
  ])('%s -> %s', (ref, expected) => {
    expect(imageRepository(ref)).toBe(expected);
  });

  it.each([
    '',
    'Ubuntu:24.04',
    'ubuntu:',
    'ubuntu@sha256:xyz',
    'docker.io/library/../evil',
    'docker.io//library/ubuntu',
    'docker.io/library/ubuntu/',
    '-oops',
    'a b',
    'user@evil.example/x',
    'x'.repeat(300),
  ])('refuses %j', (ref) => {
    expect(imageRepository(ref)).toBeUndefined();
  });
});

describe('normalizeRegistryPattern', () => {
  it.each([
    ['docker.io/library', 'docker.io/library'],
    ['Docker.IO/Library/', 'docker.io/library'],
    ['index.docker.io', 'docker.io'],
    ['ghcr.io', 'ghcr.io'],
    ['ghcr.io/my-org', 'ghcr.io/my-org'],
    ['localhost:5000', 'localhost:5000'],
    ['*', '*'],
  ])('%s -> %s', (entry, expected) => {
    expect(normalizeRegistryPattern(entry)).toBe(expected);
  });

  it.each([
    '',
    'library',
    'myorg/app',
    'https://ghcr.io',
    'ghcr.io/../x',
    'ghcr.io//x',
    '*.io',
    '/',
  ])('refuses %j', (entry) => {
    expect(normalizeRegistryPattern(entry)).toBeUndefined();
  });
});

describe('imageAllowedByRegistries', () => {
  const lib = [...DEFAULT_IMAGE_REGISTRIES];
  it('the default allows the official Docker Hub images only', () => {
    expect(imageAllowedByRegistries('debian:12', lib)).toBe(true);
    expect(imageAllowedByRegistries('docker.io/library/fedora:42', lib)).toBe(true);
    expect(imageAllowedByRegistries('myorg/app', lib)).toBe(false);
    expect(imageAllowedByRegistries('ghcr.io/library/ubuntu', lib)).toBe(false);
    expect(imageAllowedByRegistries('evil.example/library/ubuntu', lib)).toBe(false);
  });
  it('matches on path components, not on string prefixes', () => {
    const r = ['ghcr.io/my-org'];
    expect(imageAllowedByRegistries('ghcr.io/my-org/app:1', r)).toBe(true);
    expect(imageAllowedByRegistries('ghcr.io/my-org', r)).toBe(true);
    expect(imageAllowedByRegistries('ghcr.io/my-org-evil/app', r)).toBe(false);
    expect(imageAllowedByRegistries('docker.io/library/ubuntu', ['docker.io/lib'])).toBe(false);
  });
  it('a whole registry covers every repository on it', () => {
    expect(imageAllowedByRegistries('ghcr.io/anyone/anything:latest', ['ghcr.io'])).toBe(true);
    expect(imageAllowedByRegistries('quay.io/x/y', ['ghcr.io'])).toBe(false);
  });
  it('Docker Hub is one registry under all its names', () => {
    expect(imageAllowedByRegistries('myorg/app', ['index.docker.io/myorg'])).toBe(true);
  });
  it('* allows everything; an empty list nothing; malformed names are never allowed by a prefix', () => {
    expect(imageAllowedByRegistries('anything.example/x', ['*'])).toBe(true);
    expect(imageAllowedByRegistries('ubuntu', [])).toBe(false);
    expect(imageAllowedByRegistries('docker.io/library/../evil', lib)).toBe(false);
  });
});

describe('known base images', () => {
  it('matches the tag exactly', () => {
    expect(isKnownBaseImage('ubuntu:24.04')).toBe(true);
    expect(isKnownBaseImage('docker.io/library/ubuntu:24.04')).toBe(true);
    expect(isKnownBaseImage('ubuntu:22.04')).toBe(false);
    expect(isKnownBaseImage('ubuntu')).toBe(false);
    expect(isKnownBaseImage('evil.example/ubuntu:24.04')).toBe(false);
  });
  it('covers every base image of the built-in templates', () => {
    const files = readdirSync(builtinTemplatesDir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const spec = parse(readFileSync(join(builtinTemplatesDir, f), 'utf8')) as {
        backend?: string;
        base?: { os?: string };
      };
      if (spec.backend === 'docker' || spec.backend === 'podman')
        expect(spec.base?.os, f).toBeDefined();
      if (spec.base?.os && spec.backend !== 'vm')
        expect(isKnownBaseImage(spec.base.os), `${f}: ${spec.base.os}`).toBe(true);
    }
    expect(KNOWN_BASE_IMAGES.length).toBeGreaterThan(0);
  });
});
