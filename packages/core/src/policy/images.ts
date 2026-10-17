/**
 * Registry allowlist for free image names (`images.registries` of a profile).
 *
 * A template may name any OCI image as its base. The policy checks the registry and repository of
 * that image against the profile's allowlist; the base images of the built-in templates are known
 * and always accepted. Entries are `<registry>[/<path prefix>]`, for example `docker.io/library`
 * (the official Docker Hub images), `ghcr.io` (everything on GHCR) or `ghcr.io/my-org`; a single
 * `*` allows any image.
 */

/** Docker Hub under every name the engines use for it. */
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const DOCKER_HUB = 'docker.io';

/** Base images of the built-in templates (`packages/core/templates`); accepted whatever the allowlist says. */
export const KNOWN_BASE_IMAGES: readonly string[] = Object.freeze([
  'ubuntu:24.04',
  'python:3.13-slim-bookworm',
  'alpine:3.22',
]);

/** Allowlist of the built-in agent profile: the official Docker Hub images. */
export const DEFAULT_IMAGE_REGISTRIES: readonly string[] = Object.freeze(['docker.io/library']);

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

/**
 * Registry and repository of an image reference as `registry/repository` (tag and digest dropped,
 * Docker Hub short names expanded: `ubuntu:24.04` -> `docker.io/library/ubuntu`). Undefined when
 * the reference is not a well-formed image name.
 */
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
  if (parts.length > 1 && looksLikeHost(parts[0] as string)) {
    registry = (parts.shift() as string).toLowerCase();
    if (!HOST.test(registry)) return undefined;
    registry = canonicalHost(registry);
  }
  // Repository names are lower-case by definition; a mixed-case reference is refused by the engines too.
  if (parts.length === 0 || !parts.every((c) => COMPONENT.test(c))) return undefined;
  if (registry === DOCKER_HUB && parts.length === 1) parts.unshift('library');
  return `${registry}/${parts.join('/')}`;
}

/** Registry host of an image reference (`docker.io` for Docker Hub names); undefined when the reference is malformed. */
export function imageRegistry(ref: string): string | undefined {
  const repo = imageRepository(ref);
  const slash = repo === undefined ? -1 : repo.indexOf('/');
  return repo !== undefined && slash > 0 ? repo.slice(0, slash) : undefined;
}

/**
 * Normalizes an `images.registries` entry (`docker.io/library`, `ghcr.io`, `ghcr.io/my-org`, `*`).
 * Undefined when invalid. The first component must be a registry host so that an entry can never
 * be read as a Docker Hub namespace by accident.
 */
export function normalizeRegistryPattern(entry: string): string | undefined {
  if (typeof entry !== 'string') return undefined;
  const s = entry.trim().toLowerCase().replace(/\/+$/, '');
  if (s === '*') return '*';
  if (s === '' || s.length > 255) return undefined;
  const parts = s.split('/');
  const host = parts.shift() as string;
  if (!looksLikeHost(host) || !HOST.test(host)) return undefined;
  if (!parts.every((c) => COMPONENT.test(c))) return undefined;
  return [canonicalHost(host), ...parts].join('/');
}

/** True when `ref` is the base image of a built-in template (tag included; a different tag is not known). */
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

/** True when the image lies under one of the allowlist entries (`*` allows everything; otherwise a malformed name is refused). */
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
