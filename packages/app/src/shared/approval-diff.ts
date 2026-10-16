/**
 * Turns the exact request an approval is bound to (`ApprovalView.request`, no secret values) into
 * rows "option / standard / requested" plus risk hints derived from it. Pure, so it is unit-tested.
 *
 * "Standard" is the safe default of a sandbox (no network, no extra mounts, no secrets, container
 * isolation, trusted template). A row is `changed` when the request deviates from it.
 */
import { formatBytes, formatDuration } from './format';

export interface ApprovalRow {
  path: string;
  requested: string;
  /** `null` = no fixed standard for this option. */
  standard: string | null;
  changed: boolean;
}

export type RiskHint =
  | 'mount_outside'
  | 'open_network'
  | 'secret'
  | 'isolation_none'
  | 'untrusted_template'
  | 'private_address'
  | 'network_destinations';

/**
 * Request kinds the app has a label for: the kinds of the approval queue (`create`, `exec`, `access`,
 * `template_trust`) and `image_registry`, the policy item for a base image outside the profile's
 * registries. Anything else (a kind of a newer core) is shown generically, never as a raw key.
 */
export const KNOWN_APPROVAL_KINDS = [
  'create',
  'exec',
  'access',
  'template_trust',
  'image_registry',
] as const;

/** Kinds with an explanation under the options table. */
const KINDS_WITH_HINT: readonly string[] = ['template_trust', 'image_registry'];

/** i18n key for the label of a request kind (`approvals.kind.unknown` for a kind this version does not know). */
export function kindLabelKey(kind: string): string {
  return (KNOWN_APPROVAL_KINDS as readonly string[]).includes(kind)
    ? `approvals.kind.${kind}`
    : 'approvals.kind.unknown';
}

/** i18n key for the explanation of a request kind, or null when the kind has none. */
export function kindHintKey(kind: string): string | null {
  if (KINDS_WITH_HINT.includes(kind)) return `approvals.kind.${kind}.hint`;
  return (KNOWN_APPROVAL_KINDS as readonly string[]).includes(kind)
    ? null
    : 'approvals.kind.unknown.hint';
}

const HIDDEN = new Set([
  'v',
  'kind',
  'owner',
  'context',
  'policy',
  'template.hash',
  'template.contentHash',
]);

const DEFAULTS: Record<string, unknown> = {
  isolation: 'container',
  'network.mode': 'none',
  'network.allow': [],
  'network.privateExceptions': [],
  mounts: [],
  secrets: [],
  'template.trusted': true,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scalar(path: string, v: unknown): string {
  if (typeof v === 'number') {
    if (path.endsWith('Bytes')) return formatBytes(v);
    if (path.endsWith('Ms')) return formatDuration(v);
    return String(v);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}

function item(v: unknown): string {
  if (!isRecord(v)) return scalar('', v);
  if (typeof v['hostPath'] === 'string' && typeof v['target'] === 'string') {
    return `${v['hostPath']} -> ${v['target']} (${String(v['access'] ?? 'ro')})`;
  }
  if (typeof v['ref'] === 'string') return `${v['ref']} (${String(v['inject'] ?? '?')})`;
  return Object.entries(v)
    .filter(([, x]) => x !== undefined && x !== null)
    .map(([k, x]) => `${k}=${scalar(k, x)}`)
    .join(', ');
}

function render(path: string, v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '' : v.map(item).join('\n');
  return scalar(path, v);
}

function sameAsDefault(def: unknown, v: unknown): boolean {
  if (Array.isArray(def)) return Array.isArray(v) && v.length === def.length;
  return def === v;
}

export function approvalRows(request: unknown): ApprovalRow[] {
  const rows: ApprovalRow[] = [];
  const walk = (value: unknown, path: string): void => {
    if (HIDDEN.has(path)) return;
    if (value === undefined || value === null) return;
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const hasDefault = path in DEFAULTS;
    const def = DEFAULTS[path];
    const requested = render(path, value);
    rows.push({
      path,
      requested,
      standard: hasDefault ? render(path, def) : null,
      changed: hasDefault ? !sameAsDefault(def, value) : false,
    });
  };
  // Defaults that are absent in the request are not shown (nothing was asked for).
  walk(request, '');
  return rows;
}

export function riskHints(kind: string, request: unknown): RiskHint[] {
  const out = new Set<RiskHint>();
  if (!isRecord(request)) return [];
  const net = isRecord(request['network']) ? request['network'] : undefined;
  const mounts = request['mounts'];
  const secrets = request['secrets'];
  const tpl = isRecord(request['template']) ? request['template'] : undefined;

  if (Array.isArray(mounts) && mounts.length > 0) out.add('mount_outside');
  if (net) {
    if (net['mode'] === 'open') out.add('open_network');
    const allow = net['allow'];
    if (Array.isArray(allow) && allow.length > 0) out.add('network_destinations');
    const pe = net['privateExceptions'];
    if (Array.isArray(pe) && pe.length > 0) out.add('private_address');
  }
  if (Array.isArray(secrets) && secrets.length > 0) out.add('secret');
  if (request['isolation'] === 'none') out.add('isolation_none');
  if (kind === 'template_trust' || (tpl && tpl['trusted'] === false)) out.add('untrusted_template');

  // access requests: { kind: 'access', details?: … } shapes are handled generically
  const details = isRecord(request['details']) ? request['details'] : undefined;
  if (details) {
    if (typeof details['hostPath'] === 'string' || typeof details['source'] === 'string')
      out.add('mount_outside');
    if (details['mode'] === 'open') out.add('open_network');
    const pe = details['privateExceptions'];
    if (Array.isArray(pe) && pe.length > 0) out.add('private_address');
    const dom = details['domains'];
    if (Array.isArray(dom) && dom.length > 0) out.add('network_destinations');
  }
  return [...out];
}

/** Template name and agent-independent summary fields used in the queue list. */
export function requestTemplateName(request: unknown): string | null {
  if (!isRecord(request)) return null;
  const t = request['template'];
  return isRecord(t) && typeof t['name'] === 'string' ? t['name'] : null;
}
