import type { BackendKind } from '../types.js';
import type { Internals } from './internals.js';

/** Every (host, backend) pair worth asking: the ones with registry rows and the local host's backends. */
export async function backendGroups(
  I: Internals,
  recs: Array<{ host: string; backend: BackendKind }>,
): Promise<Array<{ host: string; backend: BackendKind }>> {
  const groups = new Map<string, { host: string; backend: BackendKind }>();
  for (const r of recs) groups.set(`${r.host}|${r.backend}`, { host: r.host, backend: r.backend });
  try {
    const local = await I.resolveHost('local');
    for (const b of local.backends)
      if (I.providerFactories[b]) groups.set(`local|${b}`, { host: 'local', backend: b });
  } catch {
    /* no local host */
  }
  return [...groups.values()];
}
