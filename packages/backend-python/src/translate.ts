import {
  AboxError,
  bootstrapStep,
  canonicalJson,
  detectOsFamily,
  renderToolPreset,
} from '@abox/core';
import type { BuildStep, OsFamily, ResolvedTemplate } from '@abox/core';
import { sha256Hex, type ProjectFiles } from './project.js';
import { PINNED_UV_VERSION, uvInstallScript } from './uv.js';

/** Bump when the generated steps / Dockerfile change in a way that must invalidate cached images. */
export const TRANSLATION_VERSION = 1;

/** Virtual environment with the project dependencies (owned by the sandbox user). */
export const VENV_PATH = '/opt/venv';
/** Copy of the template project's `pyproject.toml` / `uv.lock` inside the environment image. */
export const PROJECT_PATH = '/opt/abox/project';
/** Exists in the venv once the project dependencies are installed. */
export const SYNCED_MARKER = `${VENV_PATH}/.abox-synced`;
/** Name of the generated Dockerfile inside the build context. */
export const BASE_DOCKERFILE_NAME = 'Dockerfile.abox-python';

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PYTHON_IMAGE_RE = /^(?:docker\.io\/)?(?:library\/)?python:(\d+\.\d+)(?:\.\d+)?/;

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The uv cache location inside a sandbox: the user's own `~/.cache/uv`. */
export function uvCacheDir(userName: string): string {
  return `/home/${userName}/.cache/uv`;
}

/** `python:<major.minor>…` images announce their Python version; undefined for other bases. */
export function pythonImageVersion(baseOs: string | undefined): string | undefined {
  return baseOs ? PYTHON_IMAGE_RE.exec(baseOs)?.[1] : undefined;
}

export interface ContainerTranslation {
  /** The template as the container provider sees it (backend kept as `python`, hash unchanged). */
  template: ResolvedTemplate;
  /** Base image the generated Dockerfile starts from. */
  baseImage: string;
  /** Contents of the generated Dockerfile (`FROM` + project files); written by `prepare()`. */
  dockerfile: string;
  /** Files of the build context next to the Dockerfile. */
  contextFiles: Array<{ name: string; data: Buffer }>;
  /** True when dependencies are installed at prepare time (lock file is build input). */
  depsAtPrepare: boolean;
}

/** Script of the build step that creates the venv and (with a lock file) installs the dependencies. */
export function projectStepScript(
  t: Pick<ResolvedTemplate, 'user' | 'python'>,
  withLock: boolean,
): string {
  const cache = uvCacheDir(t.user.name);
  const owner = `${Math.trunc(t.user.uid)}:${Math.trunc(t.user.uid)}`;
  return [
    'set -eu',
    `export UV_CACHE_DIR=${shq(cache)}`,
    `export UV_PROJECT_ENVIRONMENT=${shq(VENV_PATH)}`,
    'export UV_LINK_MODE=hardlink',
    `uv venv ${shq(VENV_PATH)} --python ${shq(t.python?.version ?? '3')}`,
    ...(withLock
      ? [
          // The lock file is template build input (hashed into the image cache key), so the
          // dependencies are installed here, once, with the network of the image build.
          `uv sync --frozen --no-install-project --project ${shq(PROJECT_PATH)}`,
          `touch ${shq(SYNCED_MARKER)}`,
        ]
      : []),
    `mkdir -p ${shq(cache)}`,
    // Everything the sandbox may later modify belongs to the sandbox user. These paths live in the
    // image; every sandbox gets its own copy-on-write layer, nothing is shared at run time.
    `chown -R ${owner} ${shq(VENV_PATH)} /opt/abox ${shq(`/home/${t.user.name}/.cache`)}`,
    `chmod -R u+rwX,go+rX ${shq(VENV_PATH)}`,
    '',
  ].join('\n');
}

/**
 * Translates a `backend: python` template into what the container provider understands.
 * Pure (no I/O); the project files are passed in. See README for the resulting layout.
 *
 * - base: `base.os`, else `python:<version>-slim-bookworm`
 * - build: [uv (+python on non-python bases)] + the template's own steps + [venv/deps step]
 * - env: `VIRTUAL_ENV`, `PATH`, `UV_*` when the template has a project; template env wins
 */
export function translateTemplate(
  t: ResolvedTemplate,
  project?: ProjectFiles,
): ContainerTranslation {
  if (t.backend !== 'python') {
    throw new AboxError(
      'invalid_input',
      `template "${t.name}" is for backend "${t.backend}", not "python"`,
    );
  }
  if (!t.python) {
    throw new AboxError(
      'template_invalid',
      `template "${t.name}" has no python section (python.version is required)`,
    );
  }
  if (t.base.dockerfile) {
    throw new AboxError(
      'unsupported',
      `backend "python" does not support base.dockerfile (template "${t.name}")`,
      {
        hint: 'Use base.os, or backend "docker" for a template with its own Dockerfile.',
      },
    );
  }
  const version = t.python.version;
  const baseImage = t.base.os ?? `python:${version}-slim-bookworm`;
  const family: OsFamily = detectOsFamily(baseImage);
  const imageVersion = pythonImageVersion(baseImage);
  if (imageVersion !== undefined && !version.startsWith(imageVersion)) {
    throw new AboxError(
      'template_invalid',
      `python.version "${version}" does not match the base image "${baseImage}" (Python ${imageVersion})`,
      { hint: 'Use a matching base.os or drop python.version.' },
    );
  }
  const hasPythonTool = t.tools.some((x) => x.name === 'python');

  const head: BuildStep[] = [];
  const presetEnv: Record<string, string> = {};
  if (!hasPythonTool) {
    if (imageVersion !== undefined) {
      head.push({
        name: `uv ${PINNED_UV_VERSION} (pinned release, sha256 verified)`,
        script: uvInstallScript(),
      });
    } else if (family === 'debian' || family === 'alpine') {
      // A plain OS image: reuse the core `python` tool preset (uv + CPython managed by uv).
      const rendered = renderToolPreset(`python@${version}`, family, 'python.version');
      head.push(bootstrapStep(family), rendered.step);
      Object.assign(presetEnv, rendered.env);
    } else {
      throw new AboxError(
        'unsupported',
        `backend "python" cannot install Python on base "${baseImage}" (OS family ${family})`,
        {
          hint: 'Use a python:<version> image or a Debian/Ubuntu/Alpine base (uv installs Python there).',
        },
      );
    }
  }

  const tail: BuildStep[] = [];
  if (t.python.project !== undefined) {
    tail.push({
      name: project?.lock
        ? 'python project: uv sync --frozen'
        : 'python project: venv (dependencies resolved at first start)',
      script: projectStepScript(t, project?.lock !== undefined),
    });
  }
  const build = [...head, ...t.build, ...tail];

  const env: Record<string, string> = {
    ...presetEnv,
    ...(t.python.project !== undefined
      ? {
          VIRTUAL_ENV: VENV_PATH,
          UV_PROJECT_ENVIRONMENT: VENV_PATH,
          UV_CACHE_DIR: uvCacheDir(t.user.name),
          PATH: `${VENV_PATH}/bin:${DEFAULT_PATH}`,
        }
      : {}),
    ...t.env,
  };

  const contextFiles: ContainerTranslation['contextFiles'] = [];
  const copy: string[] = [];
  if (project) {
    contextFiles.push({ name: 'pyproject.toml', data: project.pyproject });
    copy.push('pyproject.toml');
    if (project.lock) {
      contextFiles.push({ name: 'uv.lock', data: project.lock });
      copy.push('uv.lock');
    }
  }
  const fingerprint = sha256Hex(
    canonicalJson({ v: TRANSLATION_VERSION, build, env, baseImage, family }),
  );
  const dockerfile = [
    '# Generated by abox (python backend). Do not edit.',
    `# translation v${TRANSLATION_VERSION}, uv ${PINNED_UV_VERSION}, fingerprint ${fingerprint}`,
    ...(project
      ? [
          `# pyproject.toml sha256:${project.pyprojectSha256}`,
          `# uv.lock ${project.lockSha256 ? `sha256:${project.lockSha256}` : '(none: dependencies are resolved at first start)'}`,
        ]
      : []),
    `FROM ${baseImage}`,
    ...(copy.length > 0 ? [`COPY ${copy.join(' ')} ${PROJECT_PATH}/`] : []),
    '',
  ].join('\n');

  const template: ResolvedTemplate = {
    ...t,
    base: { os: baseImage, osFamily: family },
    build,
    env,
  };
  return {
    template,
    baseImage,
    dockerfile,
    contextFiles,
    depsAtPrepare: project?.lock !== undefined,
  };
}
