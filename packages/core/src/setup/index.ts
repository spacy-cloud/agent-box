import { join } from 'node:path';
import { applySetup } from './apply.js';
import { detectClients } from './clients.js';
import { prepareSetup } from './plan.js';
import type { ClientStatus, SetupEnvironment, SetupPlan, SetupRequest } from './types.js';

export * from './types.js';
export {
  SERVER_NAME,
  PLUGIN_ID,
  MARKETPLACE_NAME,
  DEFAULT_MARKETPLACE_SOURCE,
  clientSpecs,
} from './clients.js';
export { AGENTS_RULES, CLAUDE_RULES } from './rules.js';

/**
 * `abox setup` as a library: looks at the agents on this machine, builds a preview (exact paths,
 * diffs, commands) and applies it. It always acts for a human: callers gate it (`Abox.setup*`
 * uses `requireHuman`), and no MCP tool exposes it.
 */
export async function detectSetupClients(
  env: SetupEnvironment,
  command?: string,
): Promise<ClientStatus[]> {
  return detectClients(env, command);
}

export async function planSetup(env: SetupEnvironment, req: SetupRequest): Promise<SetupPlan> {
  return (await prepareSetup(env, req)).plan;
}

export { applySetup };

/** Backup and staging directories below a data directory (`AboxPaths.dataDir`). */
export function setupDirs(dataDir: string): { backupDir: string; stagingDir: string } {
  return { backupDir: join(dataDir, 'setup-backups'), stagingDir: join(dataDir, 'setup-staging') };
}
