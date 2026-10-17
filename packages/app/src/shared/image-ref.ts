/**
 * Registry of a template's base image, for the approval and confirmation views. Same rules as
 * `policy/images.ts` of @abox/core (the renderer must not import core at runtime; a unit test keeps
 * both in sync): which registry an image name points to and whether the profile's allowlist
 * (`images.registries`) covers it. The decision itself is the policy engine's, this only explains it.
 */
import type { ImageUse } from './types';

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const DOCKER_HUB = 'docker.io';

/** Base images of the built-in templates: accepted whatever the allowlist says. */
export const KNOWN_BASE_IMAGES: readonly string[] = [
  'ubuntu:24.04',
  'python:3.13-slim-bookworm',
  'alpine:3.22',
];

/** Backends whose `base.os` is an OCI image reference (vm bases are distro names). */
const IMAGE_BACKENDS: readonly string[] = ['docker', 'podman', 'python'];

const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-f0-9]{32,}$/i;

function looksLikeHost(first: string): boolean {
  return first.includes('.') || first.includes(':') || first === 'localhost';
}

function canonicalHost(host: string): string {
  return DOCKER_HUB_ALIASES.has(host) ? DOCKER_HUB : host;
}

/** `registry/repository` of an image reference (tag and digest dropped, Docker Hub names expanded); undefined if malformed. */
export function imageRepository(ref: string): string | undefined {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255) return undefined;
  let s = ref;
  const at = s.indexOf('@');
  if (at >= 0) {
    if (!DIGEST.test(s.slice(at + 1))) return undefined;
    s = s.slice(0, at);
  }
  const lastSlash = s.lastIndexOf('/');
  const colon = s.indexOf(':', lastSlash + 1);
  if (colon >= 0) {
    if (!TAG.test(s.slice(colon + 1))) return undefined;
    s = s.slice(0, colon);
  }
  if (s.length === 0) return undefined;
  const parts = s.split('/');
  let registry = DOCKER_HUB;
  if (parts.length > 1 && looksLikeHost(parts[0]!)) {
    registry = parts.shift()!.toLowerCase();
    if (!HOST.test(registry)) return undefined;
    registry = canonicalHost(registry);
  }
  if (parts.length === 0 || !parts.every((c) => COMPONENT.test(c))) return undefined;
  if (registry === DOCKER_HUB && parts.length === 1) parts.unshift('library');
  return `${registry}/${parts.join('/')}`;
}

function normalizeRegistryPattern(entry: string): string | undefined {
  if (typeof entry !== 'string') return undefined;
  const s = entry.trim().toLowerCase().replace(/\/+$/, '');
  if (s === '*') return '*';
  if (s === '' || s.length > 255) return undefined;
  const parts = s.split('/');
  const host = parts.shift()!;
  if (!looksLikeHost(host) || !HOST.test(host)) return undefined;
  if (!parts.every((c) => COMPONENT.test(c))) return undefined;
  return [canonicalHost(host), ...parts].join('/');
}

export function isKnownBaseImage(ref: string): boolean {
  if (ref.includes('@')) return false;
  const withTag = (r: string): string | undefined => {
    const repo = imageRepository(r);
    if (!repo) return undefined;
    const lastSlash = r.lastIndexOf('/');
    const colon = r.indexOf(':', lastSlash + 1);
    return `${repo}:${colon >= 0 ? r.slice(colon + 1) : 'latest'}`;
  };
  const wanted = withTag(ref);
  return wanted !== undefined && KNOWN_BASE_IMAGES.some((k) => withTag(k) === wanted);
}

export function imageAllowedByRegistries(ref: string, registries: readonly string[]): boolean {
  if (registries.includes('*')) return true;
  const repo = imageRepository(ref);
  if (!repo) return false;
  for (const entry of registries) {
    const n = normalizeRegistryPattern(entry);
    if (n && n !== '*' && (repo === n || repo.startsWith(`${n}/`))) return true;
  }
  return false;
}

/**
 * What the views show about the base of a template: the image, its registry and whether the allowlist
 * covers it. Undefined when there is nothing to show (vm and other non-image backends, no base).
 * `registries` is null when the profile is not known (then `outside` is null as well).
 */
export function describeBase(
  base: { os?: string | undefined; dockerfile?: string | undefined } | undefined,
  backend: string | undefined,
  registries: readonly string[] | null,
): ImageUse | undefined {
  if (!base) return undefined;
  if (backend !== undefined && !IMAGE_BACKENDS.includes(backend)) return undefined;
  const list = registries ? [...registries] : null;
  if (base.os !== undefined) {
    const repo = imageRepository(base.os);
    const slash = repo?.indexOf('/') ?? -1;
    return {
      ref: base.os,
      source: 'image',
      registry: repo && slash > 0 ? repo.slice(0, slash) : null,
      repository: repo && slash > 0 ? repo.slice(slash + 1) : null,
      registries: list,
      outside:
        list === null
          ? null
          : !(isKnownBaseImage(base.os) || imageAllowedByRegistries(base.os, list)),
    };
  }
  if (base.dockerfile !== undefined) {
    return {
      ref: base.dockerfile,
      source: 'dockerfile',
      registry: null,
      repository: null,
      registries: list,
      // The images a Dockerfile builds on cannot be inspected: unchecked unless everything is allowed.
      outside: list === null ? null : !list.includes('*'),
    };
  }
  return undefined;
}
