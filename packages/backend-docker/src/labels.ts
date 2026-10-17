/** Label keys and naming helpers. Labels on the engine are the source of truth for existence. */

export const LABEL = {
  managed: 'abox.managed',
  id: 'abox.id',
  host: 'abox.host',
  name: 'abox.name',
  owner: 'abox.owner',
  template: 'abox.template',
  templateHash: 'abox.template-hash',
  /** Backend kind that created the object (`docker` | `podman` | `python`). */
  backend: 'abox.backend',
  /**
   * Id of the abox installation (data dir) that owns the object. Every object of an instance
   * carries it; objects without it (older versions, other tools) are never touched.
   */
  instance: 'abox.instance',
  isolation: 'abox.isolation',
  created: 'abox.created',
  expires: 'abox.expires',
  /**
   * `1` when the entrypoint takes its deadline from `EXPIRY_FILE` as well (a later one than
   * `abox.expires` wins): the only way to move the deadline, because labels are immutable.
   */
  expiryFile: 'abox.expiry-file',
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
  /** `1` when spec files for the /tmp tmpfs are stashed and copied there on every start. */
  tmpFiles: 'abox.tmp-files',
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
/**
 * Locations inside the container that belong to the backend (CA files, the deadline, stashed spec
 * files). Root-owned, and never written through the sandbox file APIs (`writeFile`, `copyIn`).
 */
export const INTERNAL_DIRS: readonly string[] = [CA_DIR];
export const CA_CERT_PATH = `${CA_DIR}/ca.crt`;
/** Where spec files destined for the /tmp tmpfs wait; `start` copies them into /tmp. */
export const TMP_STASH = `${CA_DIR}/tmpfiles`;
export const CA_BUNDLE_PATH = `${CA_DIR}/ca-bundle.crt`;
/**
 * Current deadline (epoch seconds) of the sandbox, written as root by `extendExpiry` and read by
 * the entrypoint, which only honours it while it is owned by root and not writable by anyone else.
 * Same directory as the CA files: root-owned, and a volume when the rootfs is read-only, so the
 * sandbox user can neither change it nor lose it on a restart. It can only ever move the
 * deadline *later* than the container's creation label, and only the manager's registry decides
 * whether that is allowed: the sweep of `Abox` stops a sandbox at its registry deadline whatever
 * this file says.
 */
export const EXPIRY_FILE = `${CA_DIR}/expires`;

const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HOST_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHORT_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_RE.test(id);
}
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
