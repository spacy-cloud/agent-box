/**
 * The edit of `policy.yaml` the first-run wizard proposes: more folders in `workspace.roots` of one agent profile.
 *
 * Like the other policy proposals of the app (`policy-edit.ts`, "allow permanently") this only PROPOSES a new text.
 * The caller shows the diff, the human confirms, and the write is the normal policy edit (validated, revisioned,
 * audited). Comments and layout of the file are kept.
 */
import { isSeq, parseDocument } from 'yaml';
import { stringifyPolicy } from './policy-yaml';

export type RootsEdit =
  { ok: true; text: string; added: string[] } | { ok: false; error: 'parse' | 'no_profile' };

/**
 * Adds `roots` to `workspace.roots` of profile `profileName`. `inherited` is the profile's resolved list: when the
 * profile does not set the list itself (it inherits it through `extends`), the new list is the inherited one plus
 * the entries, because a list in a child replaces the parent's.
 */
export function proposeWorkspaceRoots(
  text: string,
  profileName: string,
  inherited: readonly string[],
  roots: readonly string[],
): RootsEdit {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { ok: false, error: 'parse' };
  const base = ['profiles', profileName];
  if (!doc.hasIn(base)) return { ok: false, error: 'no_profile' };
  const path = [...base, 'workspace', 'roots'];
  const node = doc.getIn(path, true);
  let added: string[];
  if (isSeq(node)) {
    const have = new Set(node.items.map((i) => String((i as { value?: unknown }).value ?? i)));
    added = [...new Set(roots)].filter((r) => !have.has(r));
    for (const r of added) node.add(doc.createNode(r));
  } else {
    added = [...new Set(roots)].filter((r) => !inherited.includes(r));
    doc.setIn(path, [...new Set([...inherited, ...added])]);
  }
  return { ok: true, added, text: stringifyPolicy(doc) };
}

/** The text for `workspace.roots`: `~/…` below the home directory (portable), else the absolute path. */
export function rootEntryFor(canonical: string, home: string): string {
  const prefix = home.endsWith('/') ? home : `${home}/`;
  return canonical.startsWith(prefix) && canonical.length > prefix.length
    ? `~/${canonical.slice(prefix.length)}`
    : canonical;
}
