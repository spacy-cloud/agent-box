import { isSeq, parseDocument } from 'yaml';

/**
 * Text edits of `policy.yaml` that the manager proposes itself (network log: "allow permanently"). They only
 * PROPOSE a new text: the caller shows the diff, the human confirms, and the write goes through `setPolicy`
 * (validated, revisioned, audited). Comments and layout of the file are kept.
 */

const QUOTED = /'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"/g;

/** One line with the padding of flow lists removed (`[ a, 'b' ]` -> `[a, 'b']`); quoted text and comments stay. */
function tightenLists(line: string): string {
  const quoted: string[] = [];
  const masked = line.replace(QUOTED, (q) => {
    quoted.push(q);
    return `${quoted.length - 1}`;
  });
  const hash = /(^|\s)#/.exec(masked);
  const cut = hash ? hash.index + hash[1]!.length : masked.length;
  const code = masked.slice(0, cut).replace(/\[ ([^[\]{}]*?) \]/g, '[$1]');
  return (code + masked.slice(cut)).replace(/(\d+)/g, (_m, i: string) => quoted[Number(i)]!);
}

export type NetworkAllowEdit =
  { ok: true; text: string; added: string[] } | { ok: false; error: 'parse' | 'no_profile' };

/**
 * Adds `destinations` to `network.allow` of profile `profileName`. `inherited` is the profile's resolved
 * allow list: when the profile does not set the list itself (it inherits it through `extends`), the new list
 * is the inherited one plus the entries, because a list in a child replaces the parent's.
 */
export function proposeNetworkAllow(
  text: string,
  profileName: string,
  inherited: readonly string[],
  destinations: readonly string[],
): NetworkAllowEdit {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { ok: false, error: 'parse' };
  const base = ['profiles', profileName];
  if (!doc.hasIn(base)) return { ok: false, error: 'no_profile' };
  const path = [...base, 'network', 'allow'];
  const node = doc.getIn(path, true);
  let added: string[];
  if (isSeq(node)) {
    const have = new Set(node.items.map((i) => String((i as { value?: unknown }).value ?? i)));
    added = [...new Set(destinations)].filter((d) => !have.has(d));
    for (const d of added) node.add(doc.createNode(d));
  } else {
    added = [...new Set(destinations)].filter((d) => !inherited.includes(d));
    doc.setIn(path, [...new Set([...inherited, ...added])]);
  }
  return {
    ok: true,
    added,
    text: doc.toString({ lineWidth: 0 }).split('\n').map(tightenLists).join('\n'),
  };
}
