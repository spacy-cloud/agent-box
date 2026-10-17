/**
 * Form view of `policy.yaml` profiles: reads the profiles' OWN values out of the policy text and writes single
 * fields back into it, keeping comments and layout. The text stays the one source of truth (the form and the
 * YAML editor edit the same string); the form has no rules of its own, the manager validates the result.
 *
 * Covered: the approval mode, the limits, the isolation minimums, the network modes and destinations, the
 * workspace modes, the image registries, `exec.approval`, the template and host lists. Mounts, secrets and
 * the workspace roots stay in the YAML.
 */
import { isMap, isSeq, parseDocument } from 'yaml';
import { stringifyPolicy } from './policy-yaml';
import type { Document } from 'yaml';
import { APPROVAL_MODES, ISOLATION_LEVELS, NETWORK_MODES, WORKSPACE_MODES } from './constants';

export { APPROVAL_MODES };

export type FieldPath =
  | ['approval']
  | ['limits', 'sandboxes' | 'cpus' | 'memory' | 'ttl']
  | ['isolation', 'min' | 'network_open' | 'mounts' | 'secrets_env']
  | ['network', 'modes' | 'allow_presets' | 'allow']
  | ['workspace', 'modes']
  | ['images', 'registries']
  | ['exec', 'approval']
  | ['templates']
  | ['hosts'];

/** What the profile itself sets (`undefined` = not set here: inherited from `extends` or the default). */
export interface ProfileFields {
  approval?: string;
  limits: { sandboxes?: string; cpus?: string; memory?: string; ttl?: string };
  isolation: { min?: string; network_open?: string; mounts?: string; secrets_env?: string };
  networkModes?: string[];
  allowPresets?: string[];
  allow?: string[];
  workspaceModes?: string[];
  registries?: string[];
  execApproval?: boolean;
  templates?: string[];
  hosts?: string[];
}

export interface PolicyProfileForm {
  name: string;
  extends?: string;
  fields: ProfileFields;
}

export type ReadResult = { ok: true; profiles: PolicyProfileForm[] } | { ok: false };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const list = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => String(x)) : undefined;

export function readPolicyForm(text: string): ReadResult {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { ok: false };
  const js: unknown = doc.toJS();
  if (js === null || js === undefined) return { ok: true, profiles: [] };
  if (!isRecord(js)) return { ok: false };
  const profiles = js['profiles'];
  if (profiles === undefined || profiles === null) return { ok: true, profiles: [] };
  if (!isRecord(profiles)) return { ok: false };
  const out: PolicyProfileForm[] = [];
  for (const [name, raw] of Object.entries(profiles)) {
    if (raw !== null && !isRecord(raw)) return { ok: false };
    const p = raw ?? {};
    const limits = isRecord(p['limits']) ? p['limits'] : {};
    // `min_isolation` is an accepted alias of `isolation` in policy.yaml; `isolation` wins.
    const iso = {
      ...(isRecord(p['min_isolation']) ? p['min_isolation'] : {}),
      ...(isRecord(p['isolation']) ? p['isolation'] : {}),
    };
    const net = isRecord(p['network']) ? p['network'] : {};
    const ws = isRecord(p['workspace']) ? p['workspace'] : {};
    const images = isRecord(p['images']) ? p['images'] : {};
    const exec = isRecord(p['exec']) ? p['exec'] : {};
    const fields: ProfileFields = {
      limits: {
        ...(str(limits['sandboxes']) !== undefined ? { sandboxes: str(limits['sandboxes'])! } : {}),
        ...(str(limits['cpus']) !== undefined ? { cpus: str(limits['cpus'])! } : {}),
        ...(str(limits['memory']) !== undefined ? { memory: str(limits['memory'])! } : {}),
        ...(str(limits['ttl']) !== undefined ? { ttl: str(limits['ttl'])! } : {}),
      },
      isolation: {
        ...(str(iso['min']) !== undefined ? { min: str(iso['min'])! } : {}),
        ...(str(iso['network_open']) !== undefined
          ? { network_open: str(iso['network_open'])! }
          : {}),
        ...(str(iso['mounts']) !== undefined ? { mounts: str(iso['mounts'])! } : {}),
        ...(str(iso['secrets_env']) !== undefined ? { secrets_env: str(iso['secrets_env'])! } : {}),
      },
    };
    const set = <K extends keyof ProfileFields>(k: K, v: ProfileFields[K]): void => {
      if (v !== undefined) fields[k] = v;
    };
    set('approval', str(p['approval']));
    set('networkModes', list(net['modes']));
    set('allowPresets', list(net['allow_presets']));
    set('allow', list(net['allow']));
    set('workspaceModes', list(ws['modes']));
    set('registries', list(images['registries']));
    set('execApproval', typeof exec['approval'] === 'boolean' ? exec['approval'] : undefined);
    set('templates', list(p['templates']));
    set('hosts', list(p['hosts']));
    out.push({
      name,
      ...(str(p['extends']) !== undefined ? { extends: str(p['extends'])! } : {}),
      fields,
    });
  }
  return { ok: true, profiles: out };
}

/** A number as a YAML number, anything else as the typed text (the validator then reports it). */
function scalarFor(path: FieldPath, value: string): string | number {
  const numeric = path[0] === 'limits' && (path[1] === 'sandboxes' || path[1] === 'cpus');
  return numeric && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
}

function prune(doc: Document, base: string[], path: string[]): void {
  // Remove maps that became empty (`limits: {}`) so a cleared form field leaves no trace.
  for (let n = path.length - 1; n >= 1; n--) {
    const parentPath = [...base, ...path.slice(0, n)];
    const node = doc.getIn(parentPath, true);
    if (isMap(node) && node.items.length === 0) doc.deleteIn(parentPath);
    else break;
  }
}

/**
 * Sets one field of a profile (`undefined`, an empty string or an empty list clears it), or returns the text
 * unchanged when it cannot be edited (invalid YAML, no such profile).
 */
export function setProfileField(
  text: string,
  profile: string,
  path: FieldPath,
  value: string | boolean | string[] | undefined,
): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return text;
  const base = ['profiles', profile];
  if (!isMap(doc.getIn(base, true))) return text;
  const full = [...base, ...path];
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) {
    doc.deleteIn(full);
    prune(doc, base, path);
  } else if (Array.isArray(value)) {
    const old = doc.getIn(full, true);
    const node = doc.createNode(value);
    if (isSeq(node) && isSeq(old) && old.flow) node.flow = true;
    doc.setIn(full, node);
  } else if (typeof value === 'string') {
    doc.setIn(full, scalarFor(path, value));
  } else {
    doc.setIn(full, value);
  }
  return stringifyPolicy(doc);
}

/** The isolation settings of the policy that are `none` (runs on the host): `profile.key` strings. */
export function isolationNoneKeys(text: string): string[] {
  const r = readPolicyForm(text);
  if (!r.ok) return [];
  return r.profiles.flatMap((p) =>
    Object.entries(p.fields.isolation)
      .filter(([, v]) => v === 'none')
      .map(([k]) => `${p.name}.${k}`),
  );
}

/** Isolation settings that are `none` after the edit but were not before: shown as a red warning in the review. */
export function newIsolationNone(before: string, after: string): string[] {
  const had = new Set(isolationNoneKeys(before));
  return isolationNoneKeys(after).filter((k) => !had.has(k));
}

export const FORM_CHOICES = {
  approval: APPROVAL_MODES,
  isolation: ISOLATION_LEVELS,
  networkModes: NETWORK_MODES,
  workspaceModes: WORKSPACE_MODES,
} as const;
