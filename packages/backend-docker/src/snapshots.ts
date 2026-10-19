import { isValidShort } from './labels.js';

/** Name of a snapshot as `snapshot` accepts it (an image tag). */
export const SNAPSHOT_TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** `abox-snap/<short>:<name>` -> its parts; `undefined` for anything else. */
export function parseSnapshotRef(ref: string): { short: string; name: string } | undefined {
  const m = /^abox-snap\/([^:/]+):([^:/]+)$/.exec(ref);
  if (!m) return undefined;
  const short = m[1]!;
  const name = m[2]!;
  if (!isValidShort(short) || !SNAPSHOT_TAG_RE.test(name)) return undefined;
  return { short, name };
}

/**
 * The tag of a snapshot image or of the base reference of a sandbox created from one
 * (`snapshotBaseRepo`): the only images `listForeign` / `removeForeign` deal with.
 */
export function isSnapshotImageTag(tag: string): boolean {
  return /^abox-snap(-base)?\/[a-z0-9][a-z0-9_-]{0,47}:[a-z0-9][a-z0-9_.-]{0,63}$/.test(tag);
}

/** `NAME=value` -> `NAME` (an entry without `=` is all name). */
export function envName(entry: string): string {
  const i = entry.indexOf('=');
  return i < 0 ? entry : entry.slice(0, i);
}

/** One layer of `GET /images/{id}/history`. */
export interface HistoryEntry {
  Size?: number;
  Comment?: string;
}

/**
 * The bytes a snapshot added to the image of its sandbox: the size of the layer the commit made,
 * recognised by the comment `snapshot` writes. `undefined` when the engine's history has no such
 * entry (then the number would be a guess).
 */
export function snapshotLayerSize(history: HistoryEntry[]): number | undefined {
  const e = history.find(
    (h) => typeof h.Comment === 'string' && h.Comment.startsWith('abox snapshot '),
  );
  return e && typeof e.Size === 'number' && e.Size >= 0 ? e.Size : undefined;
}
