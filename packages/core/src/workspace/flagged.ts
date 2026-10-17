import { symlinkEscapes } from './snapshot.js';
import type { FileStatus, FlaggedPath } from './types.js';

/**
 * Detection of changes that can lead to code execution on the host once the exported
 * result is used there (build, CI, shell hooks, editors, package managers, …).
 * A flag is a hint for the reviewer, never a block.
 */

export interface ChangeInfo {
  path: string;
  oldPath?: string;
  status: FileStatus;
  oldMode?: string;
  newMode?: string;
  /** Symlink target for entries that are symlinks after the change. */
  symlinkTarget?: string;
}

/** Content access for the few content-dependent rules. Returns undefined when unavailable. */
export interface ContentReader {
  oldContent(change: ChangeInfo): Promise<string | undefined>;
  newContent(change: ChangeInfo): Promise<string | undefined>;
}

const DIR_RULES: Array<[RegExp, string]> = [
  [/^\.github\/workflows\//i, 'CI workflow (runs on the CI service with repository secrets)'],
  [/^\.circleci\//i, 'CI configuration'],
  [/^\.husky\//i, 'git hook manager directory (hooks run on commit/push)'],
  [/^\.githooks\//i, 'git hooks directory'],
  [/^\.vscode\//i, 'editor configuration (tasks, launch and settings can run commands)'],
  [/^\.idea\//i, 'IDE configuration (run configurations can run commands)'],
  [/^\.devcontainer\//i, 'dev container configuration (lifecycle commands run on open)'],
  [/^\.cargo\/config(\.toml)?$/i, 'cargo configuration (runner/linker/build settings)'],
  [/^\.yarn\/(releases|plugins)\//i, 'bundled yarn release/plugin (JavaScript executed by yarn)'],
  [/^\.mise\//i, 'mise configuration (tasks and hooks)'],
];

const NAME_RULES: Array<[RegExp, string]> = [
  [/^\.envrc$/i, 'direnv file (executed when entering the directory)'],
  [/^\.env(\..*)?$/i, 'environment file (may be sourced by tools)'],
  [/^(gnu)?makefile$/i, 'Makefile (executed by make)'],
  [/\.mk$/i, 'make include file'],
  [/^justfile$/i, 'justfile (executed by just)'],
  [/^taskfile\.ya?ml$/i, 'Taskfile (executed by task)'],
  [/^\.gitlab-ci\.yml$/i, 'CI configuration'],
  [/^jenkinsfile$/i, 'CI pipeline'],
  [/^\.pre-commit-config\.ya?ml$/i, 'pre-commit hooks configuration'],
  [/^(\.)?lefthook(-local)?\.ya?ml$/i, 'lefthook git hooks configuration'],
  [/^dockerfile(\..*)?$/i, 'Dockerfile (executed when building the image)'],
  [/\.dockerfile$/i, 'Dockerfile (executed when building the image)'],
  [/^(docker-)?compose(\..*)?\.ya?ml$/i, 'compose file (starts containers)'],
  [/^\.npmrc$/i, 'npm configuration (registry, scripts, auth)'],
  [/^\.yarnrc(\.ya?ml)?$/i, 'yarn configuration (plugins, registry)'],
  [/^\.pnpmfile\.c?js$/i, 'pnpm hook file (JavaScript executed on install)'],
  [/^setup\.py$/i, 'setup.py (executed on pip install)'],
  [/^conftest\.py$/i, 'conftest.py (executed by pytest)'],
  [/^(site|user)customize\.py$/i, 'Python startup hook'],
  [/\.pth$/i, 'Python .pth file (can execute code at interpreter start)'],
  [/^build\.rs$/i, 'cargo build script (executed at build time)'],
  [/^\.?mise\.toml$/i, 'mise configuration (tasks and hooks)'],
  [/^\.tool-versions$/i, 'tool version pinning (tool installation)'],
  [/^\.(bashrc|bash_profile|profile|zshrc|zshenv|zprofile)$/i, 'shell startup file'],
  [/^\.gitattributes$/i, 'git attributes (filters/diff drivers if configured on the host)'],
  [/^\.gitmodules$/i, 'git submodules (fetches further repositories)'],
];

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|ps1|bat|cmd|command)$/i;
const PACKAGE_SCRIPT_KEYS = [
  'scripts',
  'bin',
  'husky',
  'simple-git-hooks',
  'lint-staged',
  'pre-commit',
  'gypfile',
];

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function safeJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Classifies one change; may return several reasons. */
export async function classifyChange(
  change: ChangeInfo,
  content: ContentReader,
): Promise<FlaggedPath[]> {
  const out: FlaggedPath[] = [];
  const add = (reason: string): void => {
    out.push({ path: change.path, reason });
  };
  if (change.status === 'deleted') return out;

  const path = change.path;
  const name = basename(path);

  for (const [re, reason] of DIR_RULES) if (re.test(path)) add(reason);
  for (const [re, reason] of NAME_RULES) if (re.test(name)) add(reason);

  const isLink = change.newMode === '120000';
  if (!isLink && SCRIPT_EXT.test(name)) add('shell script / batch file');

  if (change.newMode === '100755' && change.oldMode !== '100755') {
    add(change.status === 'added' ? 'executable file added' : 'executable bit set');
  }
  if (change.oldMode && change.newMode && change.oldMode !== change.newMode) {
    const wasLink = change.oldMode === '120000';
    if (wasLink !== isLink) add(`file type changed (${change.oldMode} -> ${change.newMode})`);
    else if (change.status !== 'added')
      add(`file mode changed (${change.oldMode} -> ${change.newMode})`);
  }

  if (isLink && change.symlinkTarget !== undefined && symlinkEscapes(path, change.symlinkTarget)) {
    add(
      `symlink points outside the workspace: ${JSON.stringify(change.symlinkTarget.slice(0, 200))}`,
    );
  }

  if (!isLink) {
    if (name === 'package.json') {
      const next = safeJson(await content.newContent(change));
      if (next) {
        const prev = safeJson(await content.oldContent(change));
        const changed = PACKAGE_SCRIPT_KEYS.filter(
          (k) => JSON.stringify(prev?.[k]) !== JSON.stringify(next[k]) && next[k] !== undefined,
        );
        if (changed.length > 0)
          add(`package.json changed ${changed.join(', ')} (run by npm/pnpm/yarn lifecycle)`);
      } else {
        add('package.json changed and is not valid JSON');
      }
    } else if (name === 'pyproject.toml') {
      const text = await content.newContent(change);
      if (text !== undefined && /^\s*\[build-system\]/m.test(text)) {
        const old = await content.oldContent(change);
        if (
          old === undefined ||
          extractSection(old, 'build-system') !== extractSection(text, 'build-system')
        ) {
          add('pyproject.toml build-system changed (build backend code runs on install)');
        }
      }
    } else if (name === 'Cargo.toml') {
      const text = await content.newContent(change);
      if (text !== undefined && /^\s*(build\s*=|\[build-dependencies\])/m.test(text)) {
        const old = await content.oldContent(change);
        if (old !== text) {
          add('Cargo.toml has a build script / build-dependencies (executed at build time)');
        }
      }
    }
  }
  return out;
}

function extractSection(text: string, section: string): string {
  const re = new RegExp(
    `^\\s*\\[${section}\\][^\\n]*\\n([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`,
    'm',
  );
  return re.exec(text)?.[1] ?? '';
}

/** Names with control characters can deceive terminals and log viewers. */
export function flagSuspiciousName(path: string, hasControl: boolean): FlaggedPath | undefined {
  return hasControl ? { path, reason: 'file name contains control characters' } : undefined;
}
