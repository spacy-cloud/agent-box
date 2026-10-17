// @ts-check
/**
 * Thin, capability-aware wrapper around the worker's `ctx.host.call` (Orca host API v0).
 * Only the methods this plugin needs are exposed; each one checks the granted capability first so a
 * missing permission produces a clear message instead of an opaque host error.
 */
import { fitNotification, isTypableLine } from './format.mjs';

/** Host method -> capability (plugin-host-api.js in Orca 1.4.224). */
export const METHOD_CAPABILITY = Object.freeze({
  'workspace.readContext': 'workspace:read',
  'terminal.sendText': 'terminal:send',
  'notifications.show': 'notifications:show',
  'storage.get': 'storage',
  'storage.set': 'storage',
});

export class HostError extends Error {
  /**
   * @param {string} code `capability_missing`, `invalid_text`, or the host's error code
   * @param {string} message
   * @param {string} [capability]
   */
  constructor(code, message, capability) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.capability = capability;
  }
}

/**
 * @typedef {object} WorkerContext
 * @property {{call: (method: string, params?: unknown) => Promise<unknown>}} host
 * @property {readonly string[]} grantedCapabilities
 */

/**
 * @param {WorkerContext} ctx
 */
export function createHost(ctx) {
  const granted = new Set(ctx.grantedCapabilities);
  /** @param {string} capability */
  const has = (capability) => granted.has(capability);

  /**
   * @param {keyof typeof METHOD_CAPABILITY} method
   * @param {unknown} [params]
   */
  async function call(method, params) {
    const capability = METHOD_CAPABILITY[method];
    if (!has(capability)) {
      throw new HostError('capability_missing', `missing capability ${capability}`, capability);
    }
    try {
      return await ctx.host.call(method, params);
    } catch (e) {
      const err = /** @type {{code?: unknown, message?: unknown}} */ (e);
      throw new HostError(
        typeof err?.code === 'string' ? err.code : 'host_error',
        typeof err?.message === 'string' ? err.message : String(e),
        capability,
      );
    }
  }

  return {
    has,

    /**
     * Branch, display name and terminal ids of the focused worktree, or null when none is focused.
     * The host never reveals the worktree path or terminal titles.
     * @returns {Promise<{branch: string, displayName: string, terminals: string[]} | null>}
     */
    async readContext() {
      const v =
        /** @type {{branch?: unknown, displayName?: unknown, terminals?: unknown} | null} */ (
          await call('workspace.readContext')
        );
      if (!v) return null;
      const terminals = Array.isArray(v.terminals)
        ? v.terminals
            .map((t) => /** @type {{id?: unknown}} */ (t)?.id)
            .filter((id) => typeof id === 'string')
        : [];
      return {
        branch: typeof v.branch === 'string' ? v.branch : '',
        displayName: typeof v.displayName === 'string' ? v.displayName : '',
        terminals: /** @type {string[]} */ (terminals),
      };
    },

    /**
     * Desktop notification labelled with the plugin name. The only output channel a command has.
     * @param {string} title
     * @param {string[] | string} [body]
     */
    async notify(title, body = '') {
      const n = fitNotification(title || 'Agent Sandboxes', body);
      await call(
        'notifications.show',
        n.body ? { title: n.title, body: n.body } : { title: n.title },
      );
    },

    /**
     * Types one printable line into a terminal WITHOUT pressing Enter. `enter` is hard-wired to
     * false: the human decides whether the command runs (and the terminal might be an agent prompt).
     * @param {string} terminalId
     * @param {string} text
     * @returns {Promise<boolean>} accepted
     */
    async sendText(terminalId, text) {
      if (!isTypableLine(text))
        throw new HostError('invalid_text', 'text is not a single printable line');
      const r = /** @type {{accepted?: unknown}} */ (
        await call('terminal.sendText', { terminalId, text, enter: false })
      );
      return r?.accepted === true;
    },

    /** Plugin-private key-value storage; null when the capability was not granted. */
    storage: has('storage')
      ? {
          /** @param {string} key */
          async get(key) {
            const r = /** @type {{value?: unknown}} */ (await call('storage.get', { key }));
            return r?.value ?? null;
          },
          /**
           * @param {string} key
           * @param {unknown} value
           */
          async set(key, value) {
            await call('storage.set', { key, value });
          },
        }
      : null,
  };
}
