import type { Document } from 'yaml';

const QUOTED = /'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"/g;

/** One line with the padding of flow lists removed (`[ a, 'b' ]` -> `[a, 'b']`); quoted text and comments stay as they are. */
function tightenLists(line: string): string {
  const quoted: string[] = [];
  const masked = line.replace(QUOTED, (q) => {
    quoted.push(q);
    return `\uE000${quoted.length - 1}\uE000`;
  });
  const hash = /(^|\s)#/.exec(masked);
  const cut = hash ? hash.index + hash[1]!.length : masked.length;
  const code = masked.slice(0, cut).replace(/\[ ([^[\]{}]*?) \]/g, '[$1]');
  return (code + masked.slice(cut)).replace(
    /\uE000(\d+)\uE000/g,
    (_m, i: string) => quoted[Number(i)]!,
  );
}

/**
 * Writes a policy document back as text in the layout the policy files use (and `DEFAULT_POLICY_YAML` has):
 * flow maps padded (`{ a: 1 }`), flow lists tight (`[a, b]`), no line folding. The YAML library has one switch
 * for both kinds of padding, so the lists are tightened afterwards; quoted text and the comment part of a
 * line are left alone. This keeps the diff of a policy change to the lines that really changed.
 */
export function stringifyPolicy(doc: Document): string {
  return doc.toString({ lineWidth: 0 }).split('\n').map(tightenLists).join('\n');
}
