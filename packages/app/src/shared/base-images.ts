import type { BaseImageInfo, OsFamily } from './types';

/**
 * Base images the template editor offers. These are the images abox's tool presets and package steps are
 * checked against (the builtin templates use them). Any other image name is still allowed in the form
 * ("custom"), the manager then validates it and the policy may restrict registries.
 */
export const BASE_IMAGES: readonly BaseImageInfo[] = [
  { ref: 'ubuntu:24.04', family: 'debian', backends: ['docker', 'podman'], note: 'default' },
  { ref: 'ubuntu:22.04', family: 'debian', backends: ['docker', 'podman'] },
  { ref: 'debian:12', family: 'debian', backends: ['docker', 'podman'] },
  { ref: 'python:3.13-slim-bookworm', family: 'debian', backends: ['docker', 'podman', 'python'] },
  { ref: 'alpine:3.22', family: 'alpine', backends: ['docker', 'podman'], note: 'small' },
  { ref: 'debian-12', family: 'debian', backends: ['vm'], note: 'cloud image' },
  { ref: 'ubuntu-24.04', family: 'debian', backends: ['vm'], note: 'cloud image' },
];

const DEBIAN_DEFAULT_IMAGES = new Set([
  'ubuntu',
  'debian',
  'python',
  'node',
  'golang',
  'rust',
  'ruby',
  'eclipse-temurin',
]);

/**
 * Same rules as `detectOsFamily` in @abox/core (the renderer must not import core at runtime; a unit test keeps
 * both in sync). Used to warn about tools without a preset for the chosen OS while the user is typing.
 */
export function osFamilyOf(os: string | undefined): OsFamily {
  if (!os) return 'unknown';
  const ref = os.toLowerCase().split('@')[0]!;
  const lastSlash = ref.lastIndexOf('/');
  const nameAndTag = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;
  const colon = nameAndTag.indexOf(':');
  const name = colon >= 0 ? nameAndTag.slice(0, colon) : nameAndTag;
  const tag = colon >= 0 ? nameAndTag.slice(colon + 1) : '';
  if (name === 'alpine' || /(^|[-_.])alpine($|[-_.\d])/.test(tag)) return 'alpine';
  if (name === 'fedora' || /^fedora([-_.]|$)/.test(name)) return 'fedora';
  if (name === 'archlinux') return 'arch';
  if (/^(ubuntu|debian)([-_.\d]|$)/.test(name)) return 'debian';
  if (DEBIAN_DEFAULT_IMAGES.has(name)) return 'debian';
  return 'unknown';
}

/** Package manager that belongs to an OS family (the form shows these first). */
export const FAMILY_PACKAGE_MANAGER: Record<OsFamily, 'apt' | 'apk' | 'dnf' | 'pacman' | null> = {
  debian: 'apt',
  alpine: 'apk',
  fedora: 'dnf',
  arch: 'pacman',
  unknown: null,
};
