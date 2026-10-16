# Orca plugin API: schema notes

Ground truth for `plugin/orca-plugin.json` and for everything the plugin does. Derived from the
**installed Orca 1.4.224** (`/opt/stably-orca`, Electron 43.7.5, `resources/app.asar`,
`package.json` version `1.4.224`), not from memory. The asar was extracted read-only into a scratch
directory; nothing was installed into Orca and `~/.config/orca` was only listed, never written.

**How to read the references.** Paths are relative to the extracted asar (`out/...`). The files under
`out/shared/plugins/` are readable CommonJS with real line numbers. `out/main/index.js` is one
minified bundle: the installer, plugin IPC and worker host sit on a few giant lines (4891, 7186,
9468, 9470), so those entries give the **line plus the minified symbol** to search for.

The plugin API is labelled **EXPERIMENTAL** in the source ("no compatibility promises until pluginApi
v1 freezes", `plugin-manifest.js:20-21`, `plugin-host-api.js:19-20`). Re-run
`pnpm --filter @abox/orca-plugin validate:orca` after every Orca update.

## 1. Manifest (`orca-plugin.json`, `manifestVersion: 1`)

Zod schema: `shared/plugins/plugin-manifest.js:58-113`. Mirrored in `src/orca-manifest-schema.ts`.

| Field                                         | Rule                                                                                                                                                                     | Reference                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `manifestVersion`                             | literal `1`                                                                                                                                                              | plugin-manifest.js:60                                         |
| `id`, `publisher`                             | `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 64, not `__proto__`/`prototype`/`constructor`                                                                                          | plugin-id-format.js:9-17; plugin-manifest-fields.js:11        |
| identity                                      | `<publisher>.<id>` is the install key and the install directory name                                                                                                     | plugin-manifest.js:120-122                                    |
| `name`                                        | 1-256 chars                                                                                                                                                              | plugin-manifest.js:65                                         |
| `version`                                     | semver                                                                                                                                                                   | plugin-manifest.js:23, 66                                     |
| `description`, `author`, `repository`, `icon` | optional (`icon` is a relative path, max 2 MiB)                                                                                                                          | plugin-manifest.js:67-72; main/index.js:4891 `Kfi`            |
| `engines.orca`                                | only `>=x.y.z` (closed grammar); host refuses to load below it                                                                                                           | plugin-manifest.js:28-31, 74, 134-150                         |
| `pluginApi`                                   | literal `1`                                                                                                                                                              | plugin-manifest.js:76                                         |
| `main`                                        | Node entry run **in the worker process**; required when a command has no `action` or when `events` is non-empty                                                          | plugin-manifest.js:78; contribution-validation.js:69-83       |
| `contributes`                                 | **strict** object (unknown keys rejected): `panels` (max 64), `commands` (256), `events` (3), `languagePacks` (16), `keybindings` (256), `vmRecipes` (64), `agents` (64) | plugin-manifest.js:79-110; content-pack-contributions.js:7-10 |
| `capabilities`                                | array (max 32) of `{kind}` objects, **strict**; closed set, see section 3                                                                                                | plugin-manifest.js:111; plugin-capabilities.js:18-29          |

Contribution types:

- **panel** `{id, title(1-256), icon?(Lucide name, max 64), entry}`; `entry` is an HTML file rendered
  in a sandboxed iframe in the right sidebar (plugin-manifest.js:32-39). Tab key
  `plugin:<publisher>.<id>/<panelId>` (plugin-tab-key.js:18-20).
- **command** `{id, title, context?: 'global'|'worktree', action?}`; `id` matches
  `^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$` (plugin-manifest-fields.js:29-33). Without `action` it is a
  **worker command** (needs `main`); with `action` it is an alias for one of 15 built-in renderer
  actions such as `view.tasks` or `sidebar.search.toggle` (plugin-command-actions.js:8-24). Invoking
  a worker command passes **no arguments**: the renderer calls
  `plugins.invokeCommand({pluginKey, commandId})` only (`renderer/assets/plugin-command-execution-DYsbSSvQ.js`, function `it`).
- **event** `{on}` with `on` in `worktree.created`, `worktree.removed`, `agent.status.changed`
  (plugin-manifest.js:49-53); needs `main` and the `events:subscribe` capability
  (contribution-validation.js:77-91). Payloads: plugin-events.js:11-50 (`worktree.created` carries
  `{worktreeId, path, branch}`).
- **languagePack** `{locale, path}` (translation JSON, max 5 MiB); **keybinding** `{command, key, when?}`
  (must reference a contributed command, `when` must equal the command's context);
  **vmRecipe** `{path}` (JSON, max 256 KiB, schema `schemaVersion 1`, `id`, `name`, `create`, `suspend?`,
  `resume?`, `destroy?`, `checkoutMode?`; main/index.js:4891 `Lfi`); **agents** `{path}` (file, max 1 MiB).
  Duplicate ids/locales/paths/keybindings are rejected (contribution-validation.js:20-39).
  **`contributes.agents` is validated for existence and size only; this build contains no consumer
  for it**, so it cannot be used to give Orca agents an MCP server (searched `main`, `renderer`, `shared`).
- All referenced files must be portable relative paths inside the plugin (no `..`, no absolute path,
  no Windows device names or forbidden characters; plugin-path-safety.js:42-73) and are checked with
  `realpath` containment at install and read time (main/index.js:4891 `Jfi`).

## 2. Identity rules and installation

| Rule                                                                                                                                                                                                                                              | Reference                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Reserved:** publisher `stablyai` or any id starting with `orca-`. Not installable from a local folder; from Git/marketplace only if the URL resolves to the `stablyai` org. The schema itself accepts such ids; the **installer** refuses them. | main/index.js:4891 `Gpi`, `bU`, `Jpi`                                            |
| Install sources: local folder, Git URL (HTTPS or SSH, **must end in `#ref`** tag/commit), marketplace (`orca-marketplace.json`), bundled                                                                                                          | main/index.js:4891 `Qpi`, `emi`; Settings chunk `PluginInstallDialog.*`          |
| The plugin is **copied** (without `.git`) into `<userData>/plugins/<publisher>.<id>/<contentHash>/`, hashed, and made immutable; Git installs `git clone --depth 1` / `fetch`                                                                     | main/index.js:4891 `wU`, `EU`                                                    |
| Tree limits: max **2000 entries**, **50 MiB**, **no symlinks**, no unsafe path segments, only files/directories                                                                                                                                   | main/index.js:4891 `opi`                                                         |
| Artifact limits: manifest 1 MiB, worker entry 50 MiB, panel entry 10 MiB, language pack 5 MiB, VM recipe 256 KiB, agent profile 1 MiB, icon 2 MiB                                                                                                 | main/index.js:4891 `Qfi`, `Bfi`, `Kfi`                                           |
| **There is no dependency installation** (no `npm install`): everything the worker `import`s must be inside the folder                                                                                                                             | `wU` copies the tree as is                                                       |
| Plugin system toggle (`pluginSystemEnabled`) must be on; nothing runs until the user reviews and enables the plugin                                                                                                                               | Settings chunk `PluginsSettingsSection.systemDescription`                        |
| Dev plugins: `devPluginPaths` setting loads folders directly while developing; still needs consent                                                                                                                                                | Settings chunk `PluginDevelopmentSection.*`; main/index.js:9470 `performRefresh` |
| The `orca` CLI has **no plugin commands** (`orca agent-context --json`: 249 commands, none mention plugins), so installation is a Settings > Plugins action                                                                                       | `orca agent-context`                                                             |
| `plugins.invokeCommand` and `plugins.panelAction` require the `host-admin` permission while `plugins.list`/`readPanelEntry` use `workspace`. Which clients hold `host-admin` was **not** verified                                                 | main/index.js:4891 `Smi`                                                         |

Consent: the user sees capabilities and a trust tier; changes to capabilities, the presence of
`main`, or instructional content require re-approval (`plugin-consent-fingerprint.js:19-29`). Dialog
copy for a worker: _"Background worker - runs its own process"_ and _"Its worker still runs as a
normal process on your computer with full access to your files, network, and other processes."_
(Settings chunk `PluginConsentDialog.workerTrust` / `.warning`). **Plugin-owned texts (command and
panel titles) cannot be translated**: they are single strings in the manifest, and language packs may
only translate a short allow-list of plugin-pane chrome (plugin-translatable-chrome.js:32-71).

## 3. Capabilities (permissions)

`plugin-capabilities.js:18-26` - a **closed set of unscoped kinds**; a typo or a kind from a newer
Orca fails validation. The file says _"Scoped kinds (net:fetch hosts, process:exec globs) arrive in
later phases"_ (lines 14-15): **there is no capability for spawning processes, network access or
file access in this version.**

| Kind                 | Consent text                                                                     | Host API methods                                                      |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `workspace:read`     | Read the name, branch, and terminal list of your focused worktree                | `workspace.readContext` (panel + worker)                              |
| `terminal:send`      | Type text into a terminal you can see (always a specific terminal)               | `terminal.sendText` (panel + worker)                                  |
| `notifications:show` | Show desktop notifications labeled with the plugin name                          | `notifications.show` (panel + worker)                                 |
| `storage`            | Store data in the plugin's own storage folder                                    | `storage.get/set/delete/keys` (worker only)                           |
| `secrets`            | Store and read secrets in the plugin's own encrypted vault                       | `secrets.get/set/delete` (worker only)                                |
| `events:subscribe`   | Get notified when worktrees are created or removed and when agent status changes | `events.subscribe` (worker only)                                      |
| `settings:own`       | Read and change the plugin's own settings                                        | `settings.get/set` (worker only; **no per-plugin settings UI found**) |

Source: `plugin-capabilities.js:32-40`, `plugin-host-api.js:91-221`. Enforcement:
`plugin-capability-gate.js:5-34` (unknown method, panel-forbidden method, missing consent, missing
capability) and `main/index.js:9468` `l_s` (param validation, result validation, **mutating calls are
written to an audit log first**; a failed audit write blocks the call).

Limits worth knowing: `terminal.sendText` text 1-4096 chars, explicit `terminalId` (the API has "no
active terminal write target", plugin-host-api.js:31-33, 45-47) and the terminal must belong to the
focused worktree (main/index.js:9468 `o_s`); `enter` defaults to `false`. `notifications.show` title
<= 120, body <= 1000. Storage: 256 KiB per value, 5 MiB total, 1024 keys (plugin-host-api.js:64-66).
`workspace.readContext` returns `{branch, displayName, terminals:[{id}]}` or `null` - **no worktree
path** (strict schema, plugin-host-api.js:26-42), and terminals have no titles or kinds.

## 4. Runtime model

**Worker (`main`).** `child_process.fork(host-entry, [], {env: F_s(), execArgv: [], serialization:
'advanced'})` with `ELECTRON_RUN_AS_NODE=1` (main/index.js:9470 `U_s`). The environment is **scrubbed**
to `PATH, HOME, USERPROFILE, LANG, LC_ALL, LC_CTYPE, TZ, TMPDIR, TEMP, TMP, SYSTEMROOT, SYSTEMDRIVE,
WINDIR, COMSPEC, PATHEXT, PROCESSOR_ARCHITECTURE, NUMBER_OF_PROCESSORS` (main/index.js:9468 `P_s`).
**There is no OS sandbox, no permission model and no module restriction**: the worker is plain Node
with the user's rights; capabilities only gate Orca's own host API. This is how a plugin can spawn
`abox` at all, and the consent dialog says so. The worker `import()`s `main`, calls its default
export `activate({commands.register(id, fn), events.on(name, fn), host.call(method, params),
grantedCapabilities, log})` and an optional `deactivate` (`main/plugin-host-entry.js`). Timeouts:
ready 10 s, **command invocation 30 s**, idle reap 5 min, 5 concurrent workers
(plugin-host-protocol.js:92-97). A command's return value is not shown anywhere; the **only user
output** is `notifications.show` (or typing into a terminal).

**Events.** Static `contributes.events` start the worker on demand to deliver an event; dynamic
subscriptions only reach an already running worker (main/index.js:9470 `Rvs`).

**Panel.** HTML is read from the plugin tree, wrapped by the host shell and rendered in
`<iframe sandbox="allow-scripts">` with an opaque origin (`renderer/assets/PluginPanel-*.js`). CSP:
`default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data:; font-src data:; base-uri 'none'; form-action 'none'` (plugin-panel-shell.js:22-23).
The shell blocks navigation, `window.open`, link clicks and form submits (lines 55-98) and injects 20
design tokens such as `--background`, `--primary`, `--radius` (lines 33-54). The panel talks to the
host only through `postMessage` (`orca-panel-action` -> `orca-panel-action-result`,
plugin-panel-bridge.js:19-44) with **three** allowed actions - `workspace.readContext`,
`terminal.sendText`, `notifications.show` - and budgets of 64 KiB per message and 30 messages / 10 s
(lines 25-26). A watchdog ping every 10 s suspends an unresponsive panel (lines 36-37).
**There is no channel from the worker to the panel, no way for a panel to call a worker command,
and no network.** Consequence: a panel cannot display live data from `abox`.

## 5. What this means for the abox plugin

| Wish (Orca-Plugin.md)                           | Possible?          | How / why not                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn `abox ... --json`                         | Yes                | Worker is unrestricted Node; no capability exists or is needed. Consent shows the "Background worker" tier.                                                                                             |
| Panel "Sandboxes" with live list, state, TTL    | **No**             | Panel has no network and no worker channel. Replaced by notification summaries (command palette) + a launcher panel that types commands.                                                                |
| Row actions in the panel (start/stop/export/rm) | Partly             | Panel can only type a command into a terminal (`terminal.sendText`, no Enter by design).                                                                                                                |
| "Create sandbox for this worktree" with path    | Partly             | Host API hides the worktree path. Path comes from remembered `worktree.created` events; otherwise a self-locating `$(git rev-parse --show-toplevel)` command is typed.                                  |
| Commands with input (template picker, confirm)  | **No**             | Commands get no arguments and the API has no prompt/quick-pick UI. Template comes from a config file.                                                                                                   |
| Open shell in Orca terminal                     | **No**             | A plugin cannot create terminals; it can only type into an existing one (`abox shell <id>`).                                                                                                            |
| Approvals shown and answered in Orca            | Hint only          | Reading pending approvals works (notification). Answering would put a human decision behind a surface that Orca agents can also reach (shared UI, terminals, `terminal send`); not offered. See README. |
| Assign an MCP server to Orca agents             | **No**             | `contributes.agents` has no consumer in 1.4.224 and no host API touches agent config. Instructions/snippets instead (`.mcp.json`, Orca already inspects it read-only: `shared/mcp-config.js`).          |
| Translated UI                                   | Partly             | Manifest titles are bilingual strings; notification texts follow `LANG`/`LC_ALL` or the config file.                                                                                                    |
| Per-user settings screen                        | **No**             | `settings:own` is readable/writable only by the worker and no per-plugin settings UI exists in this build. A config file is used instead.                                                               |
| Keyboard shortcuts                              | Possible, not used | Declarative `keybindings`; skipped to avoid shadowing Orca shortcuts.                                                                                                                                   |
| VM recipes (`contributes.vmRecipes`)            | Possible, not used | The abox VM backend (QEMU) is not a Multipass-style per-workspace recipe; the official `stablyai.orca-multipass-recipes` stays independent.                                                             |
| SSH workspaces                                  | Local only         | Workers always run on the desktop; "SSH workspace actions route through Orca" (Settings chunk `PluginsSettingsSection.systemDescription`).                                                              |
