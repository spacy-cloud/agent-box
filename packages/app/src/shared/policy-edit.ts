/**
 * "Allow permanently": what the policy would have to say for an approval request to pass without asking.
 *
 * The app never creates a hidden rule. This module only PROPOSES edits of the text of `policy.yaml` for the
 * findings the policy engine reported (`ApprovalView.kinds`); the human sees them as a diff, chooses which
 * ones to keep and confirms. The write goes through the normal policy edit (revisioned, audited, validated
 * by the manager). Nothing here decides anything: the engine remains the only judge.
 *
 * Only changes that are narrow and mean what they say are proposed: one more image registry, one more
 * network destination, the approval mode `strict` -> `medium`, `exec.approval` off. Findings that no
 * policy setting can waive (isolation `none`, an untrusted template, a shared or restricted host) or that
 * only the broad approval mode `open` would waive (mounts, open network, secrets, private addresses) are
 * listed with the reason and never proposed.
 */
import { isSeq, parseDocument } from 'yaml';
import { stringifyPolicy } from './policy-yaml';
import { imageRepository } from './image-ref';

/** The part of a resolved profile (`policy:get` view) the proposals need. */
export interface ProfileFacts {
  approval: string;
  exec: { approval: boolean };
  network: { allow: string[] };
  images: { registries: string[] };
}

export type PolicyEdit =
  | { op: 'add'; path: ['images', 'registries'] | ['network', 'allow']; value: string }
  | { op: 'set'; path: string[]; value: string | boolean };

export interface PolicyChangeItem {
  /** Stable id (used by the checkboxes). */
  id: string;
  /** The finding of the policy engine this change answers. */
  kind: string;
  edit: PolicyEdit;
  /** i18n key (`perm.change.*`) and its parameters. */
  labelKey: string;
  params: Record<string, string>;
}

export type UnsupportedReason = 'invariant' | 'elevated' | 'dockerfile' | 'unknown';

export interface PolicyProposal {
  items: PolicyChangeItem[];
  unsupported: Array<{ kind: string; reason: UnsupportedReason }>;
}

const INVARIANT_KINDS = ['isolation_none', 'template_trust', 'host_zone'];
const ELEVATED_KINDS = ['mount', 'network_open', 'secret_env', 'secret_file', 'private_address'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The allowlist entry that covers an image: `<registry>/<first path component>` (`ghcr.io/my-org`, `docker.io/library`). */
export function registryEntryFor(imageRef: string): string | undefined {
  const repo = imageRepository(imageRef);
  if (!repo) return undefined;
  const parts = repo.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
}

/** Destinations the request names (`network.allow`), as the approval recorded them. */
function requestedDomains(request: unknown): string[] {
  if (!isRecord(request) || !isRecord(request['network'])) return [];
  const allow = request['network']['allow'];
  return Array.isArray(allow) ? allow.filter((x): x is string => typeof x === 'string') : [];
}

export function proposePolicyChange(input: {
  profile: ProfileFacts;
  profileName: string;
  kinds: readonly string[];
  request: unknown;
  /** Base of the template as bound into the request (`ApprovalView.base`). */
  base: { os?: string | undefined; dockerfile?: string | undefined } | null;
}): PolicyProposal {
  const items = new Map<string, PolicyChangeItem>();
  const unsupported: PolicyProposal['unsupported'] = [];
  const p = input.profile;
  const put = (i: PolicyChangeItem): void => {
    if (!items.has(i.id)) items.set(i.id, i);
  };
  const approvalToMedium = (kind: string): void =>
    put({
      id: 'approval',
      kind,
      edit: { op: 'set', path: ['approval'], value: 'medium' },
      labelKey: 'perm.change.approval',
      params: { from: p.approval, to: 'medium' },
    });

  for (const kind of new Set(input.kinds)) {
    if (kind === 'image_registry') {
      const os = input.base?.os;
      const entry = os !== undefined ? registryEntryFor(os) : undefined;
      if (entry === undefined) {
        unsupported.push({
          kind,
          reason: input.base?.dockerfile !== undefined ? 'dockerfile' : 'unknown',
        });
      } else if (!p.images.registries.includes(entry) && !p.images.registries.includes('*')) {
        put({
          id: `registry:${entry}`,
          kind,
          edit: { op: 'add', path: ['images', 'registries'], value: entry },
          labelKey: 'perm.change.registry',
          params: { entry },
        });
      }
    } else if (kind === 'network_domains') {
      for (const d of requestedDomains(input.request)) {
        if (p.network.allow.includes(d)) continue;
        put({
          id: `domain:${d}`,
          kind,
          edit: { op: 'add', path: ['network', 'allow'], value: d },
          labelKey: 'perm.change.domain',
          params: { domain: d },
        });
      }
    } else if (kind === 'strict_mode') {
      if (p.approval === 'strict') approvalToMedium(kind);
    } else if (kind === 'exec') {
      if (p.exec.approval) {
        put({
          id: 'exec',
          kind,
          edit: { op: 'set', path: ['exec', 'approval'], value: false },
          labelKey: 'perm.change.exec',
          params: {},
        });
      } else if (p.approval === 'strict') {
        approvalToMedium(kind);
      }
    } else if (INVARIANT_KINDS.includes(kind)) {
      unsupported.push({ kind, reason: 'invariant' });
    } else if (ELEVATED_KINDS.includes(kind)) {
      unsupported.push({ kind, reason: 'elevated' });
    } else {
      unsupported.push({ kind, reason: 'unknown' });
    }
  }
  return { items: [...items.values()], unsupported };
}

export type ApplyResult = { ok: true; text: string } | { ok: false; error: 'parse' | 'no_profile' };

/**
 * Applies the chosen edits to the text of policy.yaml (comments and layout are kept; a list that is written as
 * `[a, b]` stays a flow list). An `add` appends to the profile's own list; when the profile does not set it
 * (it inherits it), the new list is the inherited one plus the entry, because a list in a child replaces the
 * parent's.
 */
export function applyPolicyEdits(
  text: string,
  profileName: string,
  profile: ProfileFacts,
  edits: readonly PolicyEdit[],
): ApplyResult {
  const doc = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length > 0) return { ok: false, error: 'parse' };
  const base = ['profiles', profileName];
  if (!doc.hasIn(base)) return { ok: false, error: 'no_profile' };

  const adds = new Map<string, { path: string[]; values: string[] }>();
  for (const e of edits) {
    if (e.op === 'set') {
      doc.setIn([...base, ...e.path], e.value);
    } else {
      const key = e.path.join('.');
      const entry = adds.get(key) ?? { path: e.path, values: [] };
      entry.values.push(e.value);
      adds.set(key, entry);
    }
  }
  for (const { path, values } of adds.values()) {
    const full = [...base, ...path];
    const node = doc.getIn(full, true);
    if (isSeq(node)) {
      const have = new Set(node.items.map((i) => String((i as { value?: unknown }).value ?? i)));
      for (const v of values) if (!have.has(v)) node.add(doc.createNode(v));
    } else {
      const inherited = path[0] === 'images' ? profile.images.registries : profile.network.allow;
      doc.setIn(full, [...new Set([...inherited, ...values])]);
    }
  }
  return { ok: true, text: stringifyPolicy(doc) };
}
