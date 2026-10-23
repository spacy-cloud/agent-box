import { posix } from 'node:path';
import { AboxError } from '../errors.js';
import { SKILLS_DIR, type SandboxSpec } from '../types.js';
import type { ResolvedSkill } from './catalog.js';

/** At most this many skills in one sandbox (template and request together). */
export const MAX_SANDBOX_SKILLS = 32;
/** At most this many bytes of skills in one sandbox. */
export const MAX_SANDBOX_SKILL_BYTES = 8 * 1024 * 1024;
/** The environment variable that names the skills directory inside the sandbox. */
export const SKILLS_DIR_ENV = 'ABOX_SKILLS_DIR';
/** The file an agent reads first: name, description and path of every skill. */
export const SKILLS_INDEX_FILE = 'INDEX.md';

/** One line of text: descriptions may be YAML block scalars. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * `INDEX.md` of the skills directory: an agent loads only this and reads a full `SKILL.md` when the
 * description fits its task. Paths are relative to the directory, so the index stays right where
 * a backend shows the directory elsewhere (the process backend: inside the sandbox root).
 */
export function renderSkillsIndex(
  skills: readonly Pick<ResolvedSkill, 'name' | 'description'>[],
): string {
  const lines = [
    '# Skills',
    '',
    `abox placed these skills into the sandbox at ${SKILLS_DIR} (the environment variable ${SKILLS_DIR_ENV} holds the directory).`,
    'Each skill is a folder with a SKILL.md. Read this index, then read the SKILL.md of a skill when its description fits your task.',
    'The files are read-only. Paths below are relative to this directory.',
    '',
  ];
  for (const s of skills) {
    lines.push(
      `## ${s.name}`,
      '',
      `- path: ${s.name}/SKILL.md`,
      `- description: ${oneLine(s.description)}`,
      '',
    );
  }
  return lines.join('\n');
}

/**
 * The read-only files that put `skills` into a sandbox: every file of every skill below
 * `SKILLS_DIR/<name>/` and the index. Modes have no write bits; scripts keep their executable bit.
 */
export function skillSpecFiles(skills: readonly ResolvedSkill[]): SandboxSpec['files'] {
  if (skills.length === 0) return [];
  if (skills.length > MAX_SANDBOX_SKILLS)
    throw new AboxError(
      'invalid_input',
      `a sandbox can get at most ${MAX_SANDBOX_SKILLS} skills (asked for ${skills.length})`,
    );
  const total = skills.reduce((n, s) => n + s.totalBytes, 0);
  if (total > MAX_SANDBOX_SKILL_BYTES)
    throw new AboxError(
      'invalid_input',
      `the skills of this sandbox take ${total} bytes together; at most ${MAX_SANDBOX_SKILL_BYTES} are allowed`,
      { hint: 'Give the sandbox fewer skills.' },
    );
  const out: SandboxSpec['files'] = [];
  for (const s of skills) {
    for (const f of s.files) {
      out.push({
        sandboxPath: posix.join(SKILLS_DIR, s.name, f.path),
        content: s.contents.get(f.path)!,
        mode: f.executable ? 0o555 : 0o444,
        readonly: true,
      });
    }
  }
  out.push({
    sandboxPath: posix.join(SKILLS_DIR, SKILLS_INDEX_FILE),
    content: Buffer.from(renderSkillsIndex(skills), 'utf8'),
    mode: 0o444,
    readonly: true,
  });
  return out;
}
