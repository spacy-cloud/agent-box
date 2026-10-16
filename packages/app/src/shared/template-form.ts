/**
 * Template form <-> YAML. The YAML text is the single source of truth: the form is derived from it
 * (`parseForm`), and every form edit is written back into the text (`applyForm`) with the `yaml` document API, so
 * comments, key order and the fields the form does not know (setup, user, workspace, secrets, labels, extends,
 * python, vm) survive. Invalid values are written as typed; the manager's validator reports them at the field.
 */
import { isMap, parseDocument } from 'yaml';
import type { Document, YAMLMap } from 'yaml';
import { osFamilyOf } from './base-images';
import type { ToolInfo } from './types';

export const PACKAGE_MANAGERS = ['apt', 'apk', 'dnf', 'pacman', 'pip', 'npm'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface MountRow {
  source: string;
  target: string;
  access: string;
}
export interface EnvRow {
  key: string;
  value: string;
}

export interface TemplateForm {
  /** False when the YAML has a syntax error or is not a mapping: the form is read-only then. */
  valid: boolean;
  yamlError?: string;
  name: string;
  description: string;
  backend: string;
  isolation: string;
  baseOs: string;
  baseDockerfile: string;
  packages: Record<PackageManager, string[]>;
  tools: string[];
  cpus: string;
  memory: string;
  disk: string;
  pids: string;
  ttl: string;
  networkMode: string;
  networkAllow: string[];
  networkPresets: string[];
  mounts: MountRow[];
  env: EnvRow[];
}

export type FormPatch = Partial<Omit<TemplateForm, 'valid' | 'yamlError'>>;

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
    : [];

export function emptyForm(): TemplateForm {
  return {
    valid: true,
    name: '',
    description: '',
    backend: '',
    isolation: '',
    baseOs: '',
    baseDockerfile: '',
    packages: { apt: [], apk: [], dnf: [], pacman: [], pip: [], npm: [] },
    tools: [],
    cpus: '',
    memory: '',
    disk: '',
    pids: '',
    ttl: '',
    networkMode: '',
    networkAllow: [],
    networkPresets: [],
    mounts: [],
    env: [],
  };
}

export function parseForm(text: string): TemplateForm {
  const doc = parseDocument(text, { uniqueKeys: true });
  const form = emptyForm();
  if (doc.errors.length > 0) {
    return {
      ...form,
      valid: false,
      yamlError: doc.errors[0]!.message.split('\n')[0] ?? 'YAML error',
    };
  }
  if (doc.contents === null) return form;
  if (!isMap(doc.contents)) {
    return { ...form, valid: false, yamlError: 'The template must be a YAML mapping.' };
  }
  let js: Record<string, unknown>;
  try {
    js = (doc.toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return { ...form, valid: false, yamlError: e instanceof Error ? e.message : String(e) };
  }
  const obj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const base = obj(js['base']);
  const packages = obj(js['packages']);
  const resources = obj(js['resources']);
  const network = obj(js['network']);
  form.name = str(js['name']);
  form.description = str(js['description']);
  form.backend = str(js['backend']);
  form.isolation = str(js['isolation']);
  form.baseOs = str(base['os']);
  form.baseDockerfile = str(base['dockerfile']);
  for (const m of PACKAGE_MANAGERS) form.packages[m] = strList(packages[m]);
  form.tools = strList(js['tools']);
  form.cpus = str(resources['cpus']);
  form.memory = str(resources['memory']);
  form.disk = str(resources['disk']);
  form.pids = str(resources['pids']);
  form.ttl = str(resources['ttl']);
  form.networkMode = str(network['mode']);
  form.networkAllow = strList(network['allow']);
  form.networkPresets = strList(network['presets']);
  form.mounts = (Array.isArray(js['mounts']) ? js['mounts'] : []).map((m) => {
    const o = obj(m);
    return { source: str(o['source']), target: str(o['target']), access: str(o['access']) };
  });
  form.env = Object.entries(obj(js['env'])).map(([key, value]) => ({ key, value: str(value) }));
  return form;
}

/** Numbers stay numbers in the YAML; anything else is written as typed so the validator can complain. */
function numeric(v: string): number | string {
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
}

function setOrDelete(doc: Document, path: string[], value: unknown): void {
  const empty =
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0);
  if (empty) {
    if (doc.hasIn(path)) {
      doc.deleteIn(path);
      pruneEmpty(doc, path.slice(0, -1));
    }
    return;
  }
  doc.setIn(path, value);
}

/** Removes parents that became empty (`resources: {}`) so the YAML stays tidy. */
function pruneEmpty(doc: Document, path: string[]): void {
  if (path.length === 0) return;
  const node = doc.getIn(path, true);
  if (isMap(node) && node.items.length === 0) {
    doc.deleteIn(path);
    pruneEmpty(doc, path.slice(0, -1));
  }
}

function ensureMap(doc: Document): YAMLMap {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
  return doc.contents as YAMLMap;
}

export function applyForm(text: string, patch: FormPatch): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) return text;
  ensureMap(doc);

  if (patch.name !== undefined) doc.setIn(['name'], patch.name);
  if (patch.description !== undefined) setOrDelete(doc, ['description'], patch.description);
  if (patch.backend !== undefined) setOrDelete(doc, ['backend'], patch.backend);
  if (patch.isolation !== undefined) setOrDelete(doc, ['isolation'], patch.isolation);
  if (patch.baseOs !== undefined) setOrDelete(doc, ['base', 'os'], patch.baseOs.trim());
  if (patch.baseDockerfile !== undefined)
    setOrDelete(doc, ['base', 'dockerfile'], patch.baseDockerfile.trim());
  if (patch.packages) {
    for (const m of PACKAGE_MANAGERS) {
      const list = patch.packages[m];
      if (list !== undefined) setOrDelete(doc, ['packages', m], list);
    }
  }
  if (patch.tools !== undefined) setOrDelete(doc, ['tools'], patch.tools);
  if (patch.cpus !== undefined) setOrDelete(doc, ['resources', 'cpus'], numeric(patch.cpus));
  if (patch.memory !== undefined) setOrDelete(doc, ['resources', 'memory'], patch.memory.trim());
  if (patch.disk !== undefined) setOrDelete(doc, ['resources', 'disk'], patch.disk.trim());
  if (patch.pids !== undefined) setOrDelete(doc, ['resources', 'pids'], numeric(patch.pids));
  if (patch.ttl !== undefined) setOrDelete(doc, ['resources', 'ttl'], patch.ttl.trim());
  if (patch.networkMode !== undefined) setOrDelete(doc, ['network', 'mode'], patch.networkMode);
  if (patch.networkAllow !== undefined) setOrDelete(doc, ['network', 'allow'], patch.networkAllow);
  if (patch.networkPresets !== undefined)
    setOrDelete(doc, ['network', 'presets'], patch.networkPresets);
  if (patch.mounts !== undefined) {
    setOrDelete(
      doc,
      ['mounts'],
      patch.mounts.map((m) => ({
        source: m.source,
        target: m.target,
        ...(m.access ? { access: m.access } : {}),
      })),
    );
  }
  if (patch.env !== undefined) {
    const map: Record<string, string> = {};
    for (const r of patch.env) if (r.key !== '') map[r.key] = r.value;
    setOrDelete(doc, ['env'], map);
  }
  return doc.toString({ lineWidth: 0 });
}

/** Starting point for "New template": valid as it stands (passes the schema). */
export function blankTemplate(name = 'my-template'): string {
  return [
    'apiVersion: 1',
    `name: ${name}`,
    'description: >-',
    '  Describe what this environment is for (at least 20 characters): agents pick templates by reading it.',
    'backend: docker',
    'isolation: container',
    '',
    'base:',
    '  os: ubuntu:24.04',
    '',
    'tools:',
    '  - git',
    '',
    'resources:',
    '  cpus: 2',
    '  memory: 4g',
    '  ttl: 2h',
    '',
    'network:',
    '  mode: none',
    '',
    'labels:',
    '  use-for: Describe when to use this template',
    '',
  ].join('\n');
}

/** Copy of a template under a new name (comments and unknown fields are kept). */
export function duplicateTemplate(text: string, newName: string): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return text;
  doc.setIn(['name'], newName);
  return doc.toString({ lineWidth: 0 });
}

/** `<name>-copy`, `<name>-copy-2`, … avoiding the given names (template names are `[a-z0-9-]{1,63}`). */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  const stem = (name || 'template').slice(0, 54);
  let candidate = `${stem}-copy`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-copy-${n}`;
  return candidate;
}

// -- field errors -----------------------------------------------------------------------------------------------------

/** Where an issue path is shown: a form field id (see `FIELD_IDS`) or `other` (only YAML / issue list). */
export function fieldKeyForPath(path: string | undefined): string {
  if (!path) return 'other';
  const p = path.replace(/\[\d+\]/g, '');
  if (p === 'name') return 'name';
  if (p === 'description') return 'description';
  if (p === 'backend') return 'backend';
  if (p === 'isolation') return 'isolation';
  if (p === 'base.os') return 'baseOs';
  if (p === 'base.dockerfile') return 'baseDockerfile';
  if (p === 'base') return 'baseOs';
  if (p.startsWith('packages.')) return `packages.${p.slice('packages.'.length)}`;
  if (p === 'tools') return 'tools';
  if (p === 'resources.cpus') return 'cpus';
  if (p === 'resources.memory') return 'memory';
  if (p === 'resources.disk') return 'disk';
  if (p === 'resources.pids') return 'pids';
  if (p === 'resources.ttl') return 'ttl';
  if (p === 'network.mode') return 'networkMode';
  if (p === 'network.allow') return 'networkAllow';
  if (p === 'network.presets') return 'networkPresets';
  if (p === 'mounts' || p.startsWith('mounts.')) return 'mounts';
  if (p === 'env' || p.startsWith('env.')) return 'env';
  return 'other';
}

export interface FieldIssue {
  path?: string;
  message: string;
  line?: number;
  column?: number;
}

/** Groups issues by form field. Issues without a form field land under `other`. */
export function groupIssues(issues: readonly FieldIssue[]): Record<string, FieldIssue[]> {
  const out: Record<string, FieldIssue[]> = {};
  for (const i of issues) (out[fieldKeyForPath(i.path)] ??= []).push(i);
  return out;
}

// -- tools without a preset for the chosen OS -------------------------------------------------------------------------------

export interface ToolWarning {
  tool: string;
  reason: 'no-preset-for-os' | 'unknown-tool';
  family: string;
}

/** Tool refs (`node@24`) that have no preset for the OS family of `baseOs`. Empty while the OS is unknown. */
export function toolWarnings(
  tools: readonly string[],
  baseOs: string,
  catalog: readonly ToolInfo[],
): ToolWarning[] {
  const family = osFamilyOf(baseOs);
  const out: ToolWarning[] = [];
  for (const ref of tools) {
    const name = ref.split('@')[0] ?? ref;
    const info = catalog.find((c) => c.name === name);
    if (!info) {
      out.push({ tool: ref, reason: 'unknown-tool', family });
      continue;
    }
    if (family !== 'unknown' && !info.os.includes(family)) {
      out.push({ tool: ref, reason: 'no-preset-for-os', family });
    }
  }
  return out;
}

/** Splits a free-text package/domain list (comma, space or newline separated). */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
