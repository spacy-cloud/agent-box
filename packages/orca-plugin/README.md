# Agent Sandboxes: abox plugin for Orca

Plugin id `spacy-cloud.agent-sandboxes` for [Orca](https://github.com/stablyai/orca). It puts
[abox](../../README.md) sandboxes next to Orca's git worktrees: one sandbox per worktree, state and
lifetime at a glance, a shell, a diff export, and a hint when an agent waits for an approval.

It is a **thin front end**. There is no sandbox logic in it: everything goes through `abox ... --json`
(one adapter module, argv only, no shell, timeouts). Policy, approvals, audit and secret handling stay
in abox.

> **Read this first.** Orca's plugin API (pluginApi 1, experimental) is much smaller than the concept
> note hoped for: a panel is a sandboxed page without network and without a link to the plugin's
> worker, and a command cannot open a dialog. So there is **no live sandbox table inside Orca**. What
> works instead is described below, and everything that is impossible is listed in
> [SCHEMA-NOTES.md](SCHEMA-NOTES.md) section 5 with source references.

## Prerequisites

- Orca **1.4.224 or newer** with **Settings > Plugins > Plugin system** switched on.
- `abox` on the `PATH` that Orca was started with (check: `abox doctor`). A GUI-launched Orca often has
  a shorter `PATH` than your shell; if the plugin says "abox was not found", set `aboxPath` (see
  Configuration).
- A working abox backend (for example Docker or Podman) and at least one template (`abox template ls`).

## Install

The installable plugin folder is **`packages/orca-plugin/plugin/`** (it contains `orca-plugin.json`).
Orca copies the folder and does not run `npm install`, so the plugin has no dependencies and no
build step.

**From a local folder.** Settings > Plugins > Install plugin > Local folder > enter the absolute path
of `.../packages/orca-plugin/plugin` > Install > review the permissions > **Enable plugin**.

**From a Git URL.** Orca clones the repository root, so the plugin folder must be the root of its own
repository, and the URL needs a pinned `#ref`:

```
git subtree split --prefix=packages/orca-plugin/plugin -b orca-plugin
git push git@github.com:<owner>/abox-orca-plugin.git orca-plugin:main
git tag v0.1.0 && git push git@github.com:<owner>/abox-orca-plugin.git v0.1.0
```

then Settings > Plugins > Install plugin > Git URL: `https://github.com/<owner>/abox-orca-plugin.git#v0.1.0`.

Identity rules (checked by tests): the id must not start with `orca-` and the publisher must not be
`stablyai`; Orca refuses to install such plugins from a local folder or a non-official repository.

## Permissions it asks for, and why

| Permission shown by Orca                                          | Used for                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Read the name, branch, and terminal list of your focused worktree | find the sandbox that belongs to the focused worktree; offer its terminals                                                         |
| Type text into a terminal you can see                             | put `abox shell <id>`, `abox rm ...` etc. on a terminal's command line. **Never presses Enter.**                                   |
| Show desktop notifications labeled with the plugin name           | the only way a command can report a result                                                                                         |
| Store data in the plugin's own storage folder                     | remember `worktree path` by `worktree id` (a small map, max 500 entries)                                                           |
| Get notified when worktrees are created or removed                | keep that map current                                                                                                              |
| **Background worker - runs its own process**                      | run `abox`. Orca states that a worker has full access to your files, network and processes; capabilities only limit Orca's own API |

What the worker actually does, so you can judge the "full access" warning: it starts only the
configured `abox` binary (argv array, no shell, 25 s timeout), reads
`~/.config/abox/orca-plugin.json`, and writes the exported diffs to
`$XDG_STATE_HOME/abox-orca-plugin/exports/` (directory `0700`, files `0600`, newest 20 kept). The
source is small enough to read: `plugin/lib/abox-cli.mjs` is the only module that spawns anything, and
a test enforces that (and that nothing opens a socket or uses `eval`).

## Using it

**Command palette** (all titles are bilingual, "English / Deutsch"; they report through desktop
notifications):

| Command                                                                  | What happens                                                                                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create sandbox for this worktree / Sandbox für diesen Worktree erstellen | `abox create <template> --mode worktree --workspace <worktree path> --name wt-<branch> --request-id ...` (idempotent)                              |
| Open sandbox shell / Shell öffnen                                        | types `abox shell <id>` into the worktree's terminal; you press Enter                                                                              |
| Export sandbox diff / Diff exportieren                                   | `abox export <id> --format diff`, saved to a private file, with a warning for paths that can execute code. **Nothing is applied to your project.** |
| Clean up sandboxes / Aufräumen                                           | lists stopped/expired/failed sandboxes and types `abox rm ...`; you decide (removal deletes the workspace)                                         |
| Start / Stop sandbox of this worktree                                    | `abox start <id>` / `abox stop <id>`                                                                                                               |
| Show sandboxes and lifetimes / Sandboxes und Laufzeiten anzeigen         | state and remaining TTL of all sandboxes, the focused worktree's one first, plus the number of pending approvals                                   |
| Show pending sandbox approvals / Offene Sandbox-Freigaben anzeigen       | pending approvals as a hint (kind, requester, abox's own risk text)                                                                                |
| Show MCP setup / MCP-Anbindung anzeigen                                  | URL and header of the HTTP server, stdio line                                                                                                      |
| Check abox setup / abox-Einrichtung prüfen                               | `abox doctor`, problems only                                                                                                                       |

**Right sidebar > "Sandboxes" panel.** A launcher, not a dashboard: it shows the focused worktree,
lets you pick the terminal that receives commands, and has buttons that type `abox ls`,
`abox create ...`, `abox start|stop|shell|export|rm <id>`, `abox approvals ls` (the sandbox id is
pre-filled with the worktree's sandbox name). It also generates the MCP snippets. German or English
(browser language, switch button).

Rules that hold everywhere:

- Commands are **typed, never executed**; Orca's API has no "active terminal", so the plugin only
  types automatically when the worktree has **exactly one** terminal (panel: you choose). Otherwise
  the command is shown in the notification. Pick a plain shell, not an agent prompt.
- The plugin never passes `--yes` and never approves anything. If abox wants a confirmation, the
  notification shows the reasons and the command for you to run yourself.
- Long operations (create, export) run in the background; Orca cancels a command after 30 s, so you
  get a "started" and a "done" notification.

### Worktree <-> sandbox linkage

Orca does not tell plugins the worktree path. The plugin links by two things: the sandbox **name**
`wt-<branch slug>` (always derivable from `workspace.readContext`) and the **path** it remembered from
`worktree.created` events. Worktrees created before the plugin was enabled have no remembered path;
for them "Create" types a self-locating command (`--workspace "$(git rev-parse --show-toplevel)"`).
Sandboxes created elsewhere are matched through `workspace.source` when the path is known.

## Configuration (optional)

Orca has no settings screen for plugins and starts workers with a reduced environment, so settings
live in `~/.config/abox/orca-plugin.json` (`$XDG_CONFIG_HOME` is honoured). It is re-read on every
command. Invalid values are ignored with a notification.

```json
{
  "aboxPath": "/home/me/.local/bin/abox",
  "defaultTemplate": "node-dev",
  "ttl": "4h",
  "timeoutMs": 25000,
  "language": "auto",
  "mcp": { "url": "http://127.0.0.1:8765/mcp", "tokenEnv": "ABOX_MCP_TOKEN" }
}
```

Without `defaultTemplate` the plugin uses the only usable template from `abox template ls`, or asks
you to set one when there are several.

## Approvals

The plugin **shows** pending approvals (list command, count in the overview, panel button that types
`abox approvals ls`). It deliberately **cannot approve or deny**. Approving is the one decision that
must come from a human, and nothing in Orca's plugin API proves that a click in a panel or a command
was made by one: agents run in terminals of the same app, `terminal send` is part of Orca's CLI, and
a sandboxed panel is just a web page. Decide in the abox app or with `abox approvals approve|deny <id>`
in a terminal. Agent-written approval reasons are never displayed (untrusted text); only abox's own
`kind` and `risks` are.

## MCP for Orca agents

Orca agents are CLI agents in terminals (Claude Code, Codex, ...). Orca's plugin API cannot assign an
MCP server to an agent (`contributes.agents` has no consumer in 1.4.224), so you wire it per project:

1. Start the server once: `abox mcp serve --http 127.0.0.1:8765` (loopback only, bearer tokens).
2. Create a token for an agent context from your `policy.yaml` (for example `orca`):
   `abox token create orca`. It is shown once; export it in the environment the agent starts in:
   `export ABOX_MCP_TOKEN=...`. **Never paste the token into the panel, a config file or a chat.**
3. Put this into the project's `.mcp.json` (Claude Code expands `${VAR}`; the panel generates the same
   snippet for your port):

```json
{
  "mcpServers": {
    "abox": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer ${ABOX_MCP_TOKEN}" }
    }
  }
}
```

No token is needed with stdio, one process per agent session (`--agent` names the policy context, which
decides what the agent may do; `abox init` can print the entry):

```json
{
  "mcpServers": { "abox": { "command": "abox", "args": ["mcp", "serve", "--agent", "<context>"] } }
}
```

Claude Code users can instead install the `agent-kit` plugin of this repository. Orca already
displays `.mcp.json` entries read-only in its MCP view.

## Relation to "Orca Multipass Recipes"

`stablyai.orca-multipass-recipes` contributes a **VM recipe**: a lifecycle for a disposable Multipass
VM that is the workspace of an Orca worktree. This plugin does something different: it manages abox
sandboxes (containers or VMs) that agents work in **beside** the worktree, with abox's policy and
audit. They complement each other and do not interfere; this plugin contributes no VM recipe. A shared
VM base (reusing the same Multipass image for both) is a possible later step.

## SSH workspaces

Orca runs plugin workers on the **desktop machine**, also for SSH workspaces. `abox` therefore runs
locally, and sandboxes are local; the terminal commands the plugin types go to the (possibly remote)
worktree terminal, where `abox` may not exist. Running sandboxes on a remote host is a feature of abox
itself (host profiles, `--host`) and a future step for this plugin; today use the abox CLI in the
remote terminal.

## What is not possible (with Orca 1.4.224)

Live panel data, in-Orca approval buttons, dialogs/pickers for commands, opening a terminal,
per-user settings UI, assigning MCP servers to agents, translated manifest titles. Reasons and source
references: [SCHEMA-NOTES.md](SCHEMA-NOTES.md). If you can influence Orca: a worker-to-panel message
channel, a quick-pick API and a `process:exec` capability would remove most of these limits.

## Development

```
pnpm install                                 # links zod and jsdom for this package
pnpm exec vitest run packages/orca-plugin    # 93 tests (2 need an extracted Orca bundle), no Orca needed
pnpm --filter @abox/orca-plugin typecheck    # tsc over the .mjs files (checkJs) and the tests
```

Run Orca's **own** validator and shell code against the plugin (read-only, extracts `app.asar` to a
temp dir):

```
pnpm --filter @abox/orca-plugin validate:orca
# or reuse an extracted bundle and also run the two extra tests:
npx -y @electron/asar extract /opt/stably-orca/resources/app.asar /tmp/orca-app
ORCA_BUNDLE_DIR=/tmp/orca-app ORCA_NODE_MODULES=/opt/stably-orca/resources/node_modules \
  pnpm exec vitest run packages/orca-plugin
```

Layout: `plugin/` (what Orca installs: manifest, `worker.mjs`, `lib/`, `panel/index.html`), `src/`
(Zod mirror of Orca's manifest schema, tests only), `test/`, `scripts/`.

## Not verified

- **Installation into a running Orca** and everything after it (consent dialog, panel layout, the
  notifications on this desktop, command palette entries, how Orca displays a failed command). The
  plugin was validated with Orca's own parser, shell builder and panel bridge types and exercised in
  jsdom and with a mocked host, but Orca was not running during development.
- **A real `abox` binary was never run.** The adapter and the tests follow the CLI _source_ in this
  worktree (`packages/cli/src`, still in progress): `ls`, `create`, `approvals ls`, `template ls`,
  `export`, `doctor` and the exit codes match it; the output of `start`/`stop`/`rm` is passed through
  unread. A change of the `--json` shapes is the most likely thing to break the plugin.
- That your agent expands `${ABOX_MCP_TOKEN}` in `.mcp.json` (documented for Claude Code, not tested).
- Whether Orca's terminal handle ids and "exactly one terminal" behave as assumed with real agent tabs.
- Behaviour after Orca updates: the plugin API is experimental.
