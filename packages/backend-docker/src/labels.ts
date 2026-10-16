/** Label keys and naming helpers. Labels on the engine are the source of truth for existence. */

export const LABEL = {
  managed: 'abox.managed',
  id: 'abox.id',
  host: 'abox.host',
  name: 'abox.name',
  owner: 'abox.owner',
  template: 'abox.template',
  templateHash: 'abox.template-hash',
  backend: 'abox.backend',
  isolation: 'abox.isolation',
  created: 'abox.created',
  expires: 'abox.expires',
  /** `sandbox` | `proxy` | `network` | `image`. */
  role: 'abox.role',
  baseDigest: 'abox.base-digest',
  readonlyRootfs: 'abox.readonly-rootfs',
  networkMode: 'abox.network-mode',
  user: 'abox.user',
  workspacePath: 'abox.workspace-path',
  workspaceKind: 'abox.workspace-kind',
  snapshotOf: 'abox.snapshot-of',
  snapshotName: 'abox.snapshot-name',
} as const;

/** Keys that belong to the backend and are not reported as user labels. */
export const RESERVED_LABELS: ReadonlySet<string> = new Set(
  Object.entries(LABEL)
    .filter(([k]) => k !== 'readonlyRootfs')
    .map(([, v]) => v),
);

export const OPEN_NETWORK = 'abox-open';
export const EGRESS_NETWORK = 'abox-egress';
export const PROXY_ALIAS = 'abox-proxy';
export const PROXY_PORT = 3128;
export const CA_DIR = '/usr/local/share/abox';
export const CA_CERT_PATH = `${CA_DIR}/ca.crt`;
export const CA_BUNDLE_PATH = `${CA_DIR}/ca-bundle.crt`;

const HOST_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHORT_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function isValidHost(host: string): boolean {
  return HOST_RE.test(host);
}
export function isValidShort(short: string): boolean {
  return SHORT_RE.test(short);
}

export const containerName = (host: string, short: string): string => `abox-${host}-${short}`;
export const proxyName = (short: string): string => `abox-proxy-${short}`;
export const internalNetName = (short: string): string => `abox-int-${short}`;
export const snapshotRepo = (short: string): string => `abox-snap/${short}`;

/** Make an arbitrary template name usable as an image repository component. */
export function imageRepoName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  return s.length > 0 ? s : 'template';
}
