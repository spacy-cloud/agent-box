import { readFile } from 'node:fs/promises';
import { DEFAULT_POLICY_YAML } from '@abox/core';
import type { Abox, Caller } from '@abox/core';

/** The text of policy.yaml as it is now (the built-in default text while no file exists). */
export async function readPolicyText(
  abox: Pick<Abox, 'showPolicy'>,
  caller: Caller,
): Promise<{ text: string; source: 'default' | 'file'; path: string | null }> {
  const view = await abox.showPolicy(caller);
  if (view.policy.source === 'file' && view.policy.path) {
    try {
      return {
        text: await readFile(view.policy.path, 'utf8'),
        source: 'file',
        path: view.policy.path,
      };
    } catch {
      /* file vanished between calls: fall through to the built-in text */
    }
  }
  return { text: DEFAULT_POLICY_YAML, source: 'default', path: null };
}
