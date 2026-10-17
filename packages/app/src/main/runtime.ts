import { openAbox } from '@abox/runtime';
import type { AboxRuntime } from '@abox/runtime';

/** One manager per GUI process, as context `human`. Reconciles on open (nothing is deleted). */
export async function openRuntime(env: NodeJS.ProcessEnv = process.env): Promise<AboxRuntime> {
  return openAbox({ contextId: 'human', env });
}

export type { AboxRuntime };
