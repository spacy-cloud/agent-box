// @ts-check
/**
 * Worker entry (`main` in orca-plugin.json). Orca forks this module in a separate Node process,
 * imports it and calls the default export once. It registers the command handlers declared in the
 * manifest and the two worktree events used to remember worktree paths.
 *
 * This process is NOT sandboxed by Orca: capabilities only gate Orca's own host API. The plugin
 * therefore keeps itself small, spawns nothing but the configured `abox` binary with argv arrays,
 * and never writes outside its own state directory.
 */
import { createAboxCli } from './lib/abox-cli.mjs';
import { COMMAND_IDS, createCommands } from './lib/commands.mjs';
import { loadConfig } from './lib/config.mjs';
import { createHost } from './lib/host.mjs';
import { createTranslator, detectLanguage } from './lib/i18n.mjs';
import { createWorktreeCache } from './lib/worktree.mjs';

/**
 * @typedef {object} ActivateContext
 * @property {{register: (id: string, handler: (args?: unknown) => Promise<unknown>) => void}} commands
 * @property {{on: (event: string, handler: (payload: unknown) => Promise<void> | void) => void}} events
 * @property {{call: (method: string, params?: unknown) => Promise<unknown>}} host
 * @property {readonly string[]} grantedCapabilities
 * @property {(message: string) => void} log
 */

/** @param {ActivateContext} ctx */
export default async function activate(ctx) {
  const host = createHost(ctx);
  const cache = createWorktreeCache(host.storage);

  // The config file is re-read on every command, so edits apply without restarting the plugin.
  const getRuntime = async () => {
    const { config, warnings, path } = await loadConfig();
    const abox = createAboxCli({ bin: config.aboxPath ?? 'abox', timeoutMs: config.timeoutMs });
    return {
      config,
      warnings,
      configPath: path,
      abox,
      t: createTranslator(detectLanguage(config.language)),
    };
  };

  const commands = createCommands({ host, cache, getRuntime, log: (m) => ctx.log(m) });

  for (const id of COMMAND_IDS) {
    const handler = commands.handlers[/** @type {keyof typeof commands.handlers} */ (id)];
    ctx.commands.register(id, async () => handler());
  }
  ctx.events.on('worktree.created', (payload) =>
    commands
      .onWorktreeCreated(payload)
      .catch((e) => ctx.log(`worktree.created: ${e instanceof Error ? e.message : String(e)}`)),
  );
  ctx.events.on('worktree.removed', (payload) =>
    commands
      .onWorktreeRemoved(payload)
      .catch((e) => ctx.log(`worktree.removed: ${e instanceof Error ? e.message : String(e)}`)),
  );
}

export function deactivate() {
  // Nothing to release: abox runs are short-lived child processes.
}
