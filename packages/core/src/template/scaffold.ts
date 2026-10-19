import { stringify } from 'yaml';
import { TEMPLATE_NAME_RE } from './schema.js';

/** A template name taken from a folder name: lowercase letters, digits and "-", at most 63 characters. */
export function templateNameFromFolder(folder: string): string {
  const slug = folder
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return TEMPLATE_NAME_RE.test(slug) ? slug : 'project';
}

/** `base`, `base-sandbox`, `base-sandbox-2`, … that is not in `taken` (still a valid template name). */
export function freeTemplateName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const stem = base.slice(0, 50).replace(/-+$/g, '');
  let candidate = `${stem}-sandbox`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-sandbox-${n}`;
  return candidate;
}

export interface ProjectDraftInput {
  name: string;
  /** Folder name, for the description. */
  project: string;
  /** The template to build on, and the backend it uses; absent: a standalone starting point. */
  base?: { template: string; backend: string; reason: string };
}

const HINTS = [
  '# Add what this project needs on top of the base, for example:',
  '# tools: [gh]',
  '# packages:',
  '#   apt: [jq]',
  '# network:',
  '#   mode: allowlist',
  '#   presets: [npm]',
];

/**
 * The starting text of "template from project". With a base it only names it (`extends`): the base's fields
 * stay where they are and the new file shows just what the project adds, so a later change of the built-in is
 * inherited. Without a base it is a small standalone template. Both validate as they stand.
 */
export function projectTemplateDraft(i: ProjectDraftInput): string {
  const description = i.base
    ? `Sandbox for the project "${i.project}", based on ${i.base.template}: ${i.base.reason}. Describe what it adds: agents pick templates by reading it.`
    : `Sandbox for the project "${i.project}". Describe what this environment is for: agents pick templates by reading it.`;
  const head = stringify(
    {
      apiVersion: 1,
      name: i.name,
      description,
      backend: i.base ? i.base.backend : 'docker',
      ...(i.base ? { extends: i.base.template } : {}),
    },
    { lineWidth: 0 },
  );
  if (i.base) return `${head}\n${HINTS.join('\n')}\n`;
  return `${head}isolation: container\n\nbase:\n  os: ubuntu:24.04\n\ntools:\n  - git\n\nresources:\n  cpus: 2\n  memory: 4g\n  ttl: 2h\n\nnetwork:\n  mode: none\n`;
}
