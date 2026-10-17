// @ts-check
/**
 * Runs Orca's OWN validation code (extracted from the installed app bundle) against plugin/.
 *
 *   node scripts/validate-with-orca.mjs [--bundle <dir>] [--node-modules <dir>] [--plugin <dir>]
 *
 * --bundle        root of an extracted app.asar (contains out/shared/plugins/*.js). Default: the
 *                 ORCA_BUNDLE_DIR environment variable, else app.asar of the installed Orca
 *                 (/opt/stably-orca/resources/app.asar) is extracted READ-ONLY into a temp dir.
 * --node-modules  node_modules the bundle needs (zod). Default: ORCA_NODE_MODULES, else
 *                 <resources>/node_modules next to the asar.
 * --shell-out     also write the panel document wrapped by Orca's own shell builder to this file
 *                 (used by the jsdom test that loads the panel exactly as the host would).
 *
 * It never touches ~/.config/orca and never installs anything. Exit code 0 = Orca's validator
 * accepts the plugin.
 */
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string} name */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pluginDir = resolve(arg('plugin') ?? join(here, '..', 'plugin'));
const asar = '/opt/stably-orca/resources/app.asar';
let bundle = arg('bundle') ?? process.env['ORCA_BUNDLE_DIR'];
let nodeModules = arg('node-modules') ?? process.env['ORCA_NODE_MODULES'];

if (!bundle) {
  if (!existsSync(asar)) {
    console.error(
      `No Orca bundle: pass --bundle <extracted app dir> or set ORCA_BUNDLE_DIR (looked for ${asar}).`,
    );
    process.exit(2);
  }
  bundle = mkdtempSync(join(tmpdir(), 'orca-bundle-'));
  const r = spawnSync('npx', ['-y', '@electron/asar', 'extract', asar, bundle], {
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(2);
  nodeModules ??= join(dirname(asar), 'node_modules');
}
nodeModules ??= '/opt/stably-orca/resources/node_modules';

// The bundle's CommonJS files `require('zod')`; make that resolve to Orca's own copy.
process.env['NODE_PATH'] = [nodeModules, process.env['NODE_PATH']].filter(Boolean).join(':');
/** @type {any} */ (Module)._initPaths();

const plugins = join(bundle, 'out', 'shared', 'plugins');
const load = createRequire(join(plugins, 'x.js'));
const manifestMod = load('./plugin-manifest.js');
const capsMod = load('./plugin-capabilities.js');
const hostApi = load('./plugin-host-api.js');
const shell = load('./plugin-panel-shell.js');
const orcaVersion = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')).version;

let failures = 0;
/**
 * @param {boolean} cond
 * @param {string} label
 */
function check(cond, label) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

console.log(`Orca bundle ${orcaVersion} (${bundle})`);
console.log(`Plugin dir  ${pluginDir}\n`);

const raw = JSON.parse(readFileSync(join(pluginDir, 'orca-plugin.json'), 'utf8'));
const parsed = manifestMod.parsePluginManifest(raw);
check(
  parsed.ok,
  `parsePluginManifest accepts orca-plugin.json${parsed.ok ? '' : `: ${parsed.error}`}`,
);
if (!parsed.ok) process.exit(1);
const m = parsed.manifest;

check(
  manifestMod.satisfiesOrcaEngineRange(orcaVersion, m.engines.orca),
  `engines.orca ${m.engines.orca} is satisfied by ${orcaVersion}`,
);
const key = manifestMod.qualifiedPluginKey(m);
check(manifestMod.isQualifiedPluginKey(key), `qualified key ${key}`);
// Orca's installer (main/index.js, Gpi/Jpi) rejects local installs of these identities.
check(
  !(m.publisher === 'stablyai' || m.id.startsWith('orca-')),
  'identity is not reserved (publisher stablyai / id prefix orca-)',
);

for (const [label, rel, max] of /** @type {Array<[string, string | undefined, number]>} */ ([
  ['worker entry', m.main, 50 * 1024 * 1024],
  ...m.contributes.panels.map(
    (/** @type {{id: string, entry: string}} */ p) =>
      /** @type {[string, string, number]} */ ([`panel ${p.id}`, p.entry, 10 * 1024 * 1024]),
  ),
])) {
  const file = rel ? join(pluginDir, rel) : '';
  check(
    !!rel && existsSync(file) && statSync(file).size <= max,
    `${label} ${rel} exists and is within ${max} bytes`,
  );
}

const specs = new Map(hostApi.PLUGIN_HOST_API_V0.map((/** @type {any} */ e) => [e.name, e]));
const granted = new Set(m.capabilities.map((/** @type {{kind: string}} */ c) => c.kind));
const panelHtml = readFileSync(join(pluginDir, m.contributes.panels[0].entry), 'utf8');
const panelCalls = [...panelHtml.matchAll(/\bcall\(\s*'([a-z]+\.[A-Za-z]+)'/g)].map((x) => x[1]);
for (const method of new Set(panelCalls)) {
  const spec = /** @type {any} */ (specs.get(method));
  check(
    !!spec?.panel && granted.has(spec.capability),
    `panel action ${method} is panel-callable and its capability ${spec?.capability} is declared`,
  );
}
const wrapped = shell.buildPluginPanelShellHtml(panelHtml);
check(
  wrapped.startsWith('<!doctype html>') && wrapped.includes(shell.PLUGIN_PANEL_CSP),
  `panel is wrapped by Orca's shell (${wrapped.length} bytes, CSP: ${shell.PLUGIN_PANEL_CSP})`,
);

const shellOut = arg('shell-out');
if (shellOut) writeFileSync(shellOut, wrapped);

console.log('\nWhat the consent dialog will list for this plugin:');
for (const kind of granted) console.log(`  - ${capsMod.PLUGIN_CAPABILITY_DESCRIPTIONS[kind]}`);
console.log(
  "  - Background worker - runs its own process (full user access; capabilities only gate Orca's API)",
);
console.log(
  `\ncontributes: ${m.contributes.panels.length} panel(s), ${m.contributes.commands.length} command(s), ${m.contributes.events.length} event(s)`,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nOrca accepts this plugin.');
