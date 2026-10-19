import type { ResolvedTemplate } from '../types.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** What the engine needs on top of the finished image while it builds one: layers, the build cache. */
export const BUILD_SPACE_FACTOR = 2;

/** Rough on-disk size of the base image by OS family (an official, slim-ish image). Deliberately on the high side. */
const BASE_BYTES: Record<ResolvedTemplate['base']['osFamily'], number> = {
  alpine: 50 * MIB,
  debian: 150 * MIB,
  fedora: 300 * MIB,
  arch: 400 * MIB,
  unknown: 500 * MIB,
};

/** A template with its own Dockerfile: its base is unknown, so assume a development image. */
const DOCKERFILE_BASE_BYTES = GIB;

/** Rough size of what a tool preset installs (toolchains dominate an image). Unknown presets count as `TOOL_DEFAULT_BYTES`. */
const TOOL_BYTES: Record<string, number> = {
  git: 50 * MIB,
  gh: 60 * MIB,
  node: 250 * MIB,
  pnpm: 150 * MIB,
  python: 200 * MIB,
  uv: 60 * MIB,
  go: 500 * MIB,
  java: 400 * MIB,
  rust: 1500 * MIB,
  flutter: 3 * GIB,
  composer: 100 * MIB,
  stylua: 20 * MIB,
  playwright: GIB,
  'docker-cli': 150 * MIB,
};
const TOOL_DEFAULT_BYTES = 300 * MIB;

/** Per distro package (`apt`, `apk`, `dnf`, `pacman`: with its dependencies) and per language package (`pip`, `npm`). */
const OS_PACKAGE_BYTES = 60 * MIB;
const LANG_PACKAGE_BYTES = 30 * MIB;
/** A free-form `setup` command can download anything. */
const SETUP_STEP_BYTES = 200 * MIB;

export interface ImageSizeEstimate {
  bytes: number;
  /** `hint` = the template's `image.size`; `estimate` = the conservative heuristic below. */
  source: 'hint' | 'estimate';
}

/**
 * How big the built environment image of a template is expected to be. `image.size` of the template wins.
 * Without it a conservative heuristic adds up the base image (by OS family), every tool preset, every
 * package and every setup command from the rendered build steps. It is meant to catch "this needs
 * several GiB and the disk has 1" before the first build, not to predict the size: it errs on the high
 * side. A template with an exact figure should set `image.size`.
 */
export function estimateImageBytes(
  t: Pick<ResolvedTemplate, 'base' | 'build' | 'image' | 'buildContext'>,
): ImageSizeEstimate {
  if (t.image) return { bytes: t.image.sizeBytes, source: 'hint' };
  let bytes = t.base.dockerfile
    ? DOCKERFILE_BASE_BYTES + (t.buildContext?.totalBytes ?? 0)
    : BASE_BYTES[t.base.osFamily];
  for (const step of t.build) {
    const tool = /^tool: ([a-z][a-z0-9-]*)/.exec(step.name);
    if (tool) {
      bytes += TOOL_BYTES[tool[1]!] ?? TOOL_DEFAULT_BYTES;
      continue;
    }
    const pkgs = /^(apt|apk|dnf|pacman|pip|npm): (.*)$/.exec(step.name);
    if (pkgs) {
      const count = pkgs[2]!.split(' ').filter(Boolean).length;
      bytes +=
        count * (pkgs[1] === 'pip' || pkgs[1] === 'npm' ? LANG_PACKAGE_BYTES : OS_PACKAGE_BYTES);
      continue;
    }
    if (step.name.startsWith('setup #')) bytes += SETUP_STEP_BYTES;
  }
  return { bytes, source: 'estimate' };
}
