// @ts-check
/**
 * Optional user configuration: `$XDG_CONFIG_HOME/abox/orca-plugin.json` (default
 * `~/.config/abox/orca-plugin.json`).
 *
 * Why a file: Orca has no settings UI for plugins (the `settings:own` host API can only be used by
 * the plugin itself) and starts workers with a scrubbed environment (PATH, HOME, LANG, ... only), so
 * neither a settings screen nor environment variables can carry a custom abox path.
 *
 * The file is read-only for the plugin and every value is validated; invalid values are ignored and
 * reported as warnings.
 */
import { readFile as nodeReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

export const CONFIG_FILENAME = 'orca-plugin.json';
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * @typedef {object} PluginConfig
 * @property {string | undefined} aboxPath bare command name or absolute path of the abox binary
 * @property {string | undefined} defaultTemplate template for "create sandbox for this worktree"
 * @property {string | undefined} ttl lifetime for sandboxes created by the plugin, e.g. `2h`
 * @property {number} timeoutMs timeout for quick abox calls
 * @property {'auto' | 'de' | 'en'} language language of notifications
 * @property {{url: string | undefined, tokenEnv: string}} mcp
 */

/** @returns {PluginConfig} */
export function defaultConfig() {
  return {
    aboxPath: undefined,
    defaultTemplate: undefined,
    ttl: undefined,
    timeoutMs: 25_000,
    language: 'auto',
    mcp: { url: undefined, tokenEnv: 'ABOX_MCP_TOKEN' },
  };
}

/** @param {NodeJS.ProcessEnv} [env] */
export function configPath(env = process.env) {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && isAbsolute(xdg) ? xdg : join(env['HOME'] || homedir(), '.config');
  return join(base, 'abox', CONFIG_FILENAME);
}

const BARE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const DURATION_RE = /^[0-9]+(?:\.[0-9]+)?(?:ms|s|m|h|d)?$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LOOPBACK_URL_RE =
  /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}\/[A-Za-z0-9._~/-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Applies a parsed config document on top of the defaults.
 * @param {unknown} doc
 * @returns {{config: PluginConfig, warnings: string[]}}
 */
export function applyConfig(doc) {
  const config = defaultConfig();
  /** @type {string[]} */
  const warnings = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    if (doc !== undefined) warnings.push('config must be a JSON object');
    return { config, warnings };
  }
  const d = /** @type {Record<string, unknown>} */ (doc);

  if (d['aboxPath'] !== undefined) {
    const v = d['aboxPath'];
    if (
      typeof v === 'string' &&
      !CONTROL_RE.test(v) &&
      v.length <= 4096 &&
      (BARE_RE.test(v) || v.startsWith('/'))
    ) {
      config.aboxPath = v;
    } else warnings.push('aboxPath must be a bare command name or an absolute path');
  }
  if (d['defaultTemplate'] !== undefined) {
    const v = d['defaultTemplate'];
    if (typeof v === 'string' && REF_RE.test(v)) config.defaultTemplate = v;
    else warnings.push('defaultTemplate is not a valid template name');
  }
  if (d['ttl'] !== undefined) {
    const v = d['ttl'];
    if (typeof v === 'string' && DURATION_RE.test(v)) config.ttl = v;
    else warnings.push('ttl must look like "90m" or "2h"');
  }
  if (d['timeoutMs'] !== undefined) {
    const v = d['timeoutMs'];
    // Orca cancels worker commands after 30 s (PLUGIN_WORKER_INVOKE_TIMEOUT_MS), so more is pointless.
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1_000 && v <= 28_000)
      config.timeoutMs = v;
    else warnings.push('timeoutMs must be an integer between 1000 and 28000');
  }
  if (d['language'] !== undefined) {
    const v = d['language'];
    if (v === 'auto' || v === 'de' || v === 'en') config.language = v;
    else warnings.push('language must be "auto", "de" or "en"');
  }
  if (d['mcp'] !== undefined) {
    const m = d['mcp'];
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const mm = /** @type {Record<string, unknown>} */ (m);
      if (mm['url'] !== undefined) {
        if (typeof mm['url'] === 'string' && LOOPBACK_URL_RE.test(mm['url']))
          config.mcp.url = mm['url'];
        else warnings.push('mcp.url must be a loopback http URL such as http://127.0.0.1:8765/mcp');
      }
      if (mm['tokenEnv'] !== undefined) {
        if (typeof mm['tokenEnv'] === 'string' && ENV_NAME_RE.test(mm['tokenEnv']))
          config.mcp.tokenEnv = mm['tokenEnv'];
        else warnings.push('mcp.tokenEnv must be an environment variable name');
      }
    } else warnings.push('mcp must be an object');
  }
  return { config, warnings };
}

/**
 * Loads the config file; a missing file is not an error.
 * @param {{env?: NodeJS.ProcessEnv, readFile?: (path: string, enc: 'utf8') => Promise<string>}} [opts]
 * @returns {Promise<{config: PluginConfig, warnings: string[], path: string}>}
 */
export async function loadConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const path = configPath(env);
  const readFile = opts.readFile ?? nodeReadFile;
  /** @type {string} */
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (/** @type {{code?: string}} */ (e)?.code === 'ENOENT')
      return { ...applyConfig(undefined), path };
    return { config: defaultConfig(), warnings: [`cannot read ${path}`], path };
  }
  if (text.length > MAX_CONFIG_BYTES)
    return { config: defaultConfig(), warnings: ['config file is too large'], path };
  try {
    return { ...applyConfig(JSON.parse(text)), path };
  } catch {
    return { config: defaultConfig(), warnings: [`${path} is not valid JSON`], path };
  }
}
