# Setting up agents: `abox setup`

`abox setup` registers the abox MCP server (and the rules snippet that tells an agent when to use a
sandbox) with the agents installed on your machine. Until now `abox init --agent <name>` only printed
a snippet and you edited each agent's configuration by hand. Setup does that for you, but only after
it has shown you exactly what it will change.

```text
$ abox setup                                    # choose on the terminal, see the preview, confirm
$ abox setup --list                             # what is installed, where abox is registered
$ abox setup --client codex --client cursor --dry-run
$ abox setup --client codex,cursor,gemini-cli --yes --json     # non-interactive
$ abox setup --uninstall --client codex          # revert
```

It is a **human-only** operation: the `Abox` facade (`setupDetect`, `setupPlan`, `setupApply`) refuses
agent contexts, there is no MCP tool for it, and applying needs `humanConfirmed` plus the digest of the
preview you saw. Every application is audited (`setup.apply`, `setup.uninstall`: clients, file paths and
step results, never file contents).

## Which agents

| Client         | Id               | MCP entry                                           | Rules file (`abox:begin` block)                                      |
| -------------- | ---------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| Claude Code    | `claude-code`    | the agent-kit **plugin**, or a user-scope MCP entry | `~/.claude/CLAUDE.md` (MCP method only; the plugin brings its skill) |
| Claude Desktop | `claude-desktop` | `mcpServers` in `claude_desktop_config.json`        | none (no rules file)                                                 |
| Codex          | `codex`          | `[mcp_servers.abox]` in `~/.codex/config.toml`      | `~/.codex/AGENTS.md`                                                 |
| Cursor         | `cursor`         | `mcpServers` in `~/.cursor/mcp.json`                | none (user rules live in its settings)                               |
| Gemini CLI     | `gemini-cli`     | `mcpServers` in `~/.gemini/settings.json`           | `~/.gemini/GEMINI.md`                                                |
| Orca           | `orca`           | not supported, see below                            | none                                                                 |

Every entry is `abox mcp serve --agent <id>` (stdio), with the id as the agent context of
[policy.yaml](mcp.md#identity-and-contexts). The built-in default policy defines all of these contexts
(`claude-desktop` and `gemini-cli` are new in it); if you have your own `policy.yaml`, setup warns when a
context is missing, because abox would deny that agent.

`--command <path>` writes another executable than `abox` (for example an absolute path). GUI-started
agents (Claude Desktop, Cursor) often have a shorter `PATH` than your shell: if one cannot find `abox`,
use `--command`. Setup warns when `abox` is not on the `PATH` of the shell you run it in.

### Claude Code: plugin or MCP entry, never both

The preferred way is the agent-kit plugin (skills, slash commands, subagent and the MCP server in one):

```text
claude plugin marketplace add spacy-cloud/agent-box        # skipped when the marketplace is known
claude plugin install abox@agent-box --scope user
```

Setup runs exactly these commands (argv, no shell) when the `claude` CLI is on the `PATH`. The plugin
registers its own MCP server (`plugin:abox:abox`), so setup **never also writes a manual entry**: if a
manual `abox` entry exists it is removed in the same plan (and the other way round when you choose
`--claude-code-method mcp`: the plugin is uninstalled). The preview lists these steps. The MCP method
uses the officially supported command and not an edit of `~/.claude.json`:

```text
claude mcp add --scope user abox -- abox mcp serve --agent claude-code
```

Without the `claude` CLI the plugin is impossible (setup says so); the MCP method then edits
`~/.claude.json` itself, with all the safeguards below, and asks you to close Claude Code first because
it rewrites that file often. Which method is the default: what is registered now; otherwise the plugin
when `claude` is installed, else the MCP entry. `--marketplace <source>` uses another marketplace source.

### Orca

Orca is detected but not written: it needs the HTTP server and a bearer token, and a token is a secret
that setup does not put into a file. `abox init --agent orca` prints the steps. The agents Orca starts
(Claude Code, Codex, ...) are covered by their own entries above.

## What setup guarantees

- **Preview first.** Per file: the exact path, the action (create / update / delete), the unified diff and
  whether a backup is kept. Per program: the argv and the files it changes. Nothing is written without a
  yes (`--yes` where there is no terminal). `--dry-run` only previews.
- **Preselection.** The terminal multi-select marks the agents where abox is registered already; newly
  detected agents are not marked. `Enter` keeps the marks, numbers choose, `a` selects all, `q` quits.
- **Unrelated content stays.** JSON and JSONC files (comments, trailing commas, indentation, line
  endings, a byte order mark) and TOML files are edited in place: only the `abox` entry is inserted,
  updated or removed, and extra fields of an existing `abox` entry (`env`, timeouts) are kept. The rules
  go between two marker comments (`<!-- abox:begin ... -->` / `<!-- abox:end -->`), so setup can update or
  remove exactly its own text. A file setup cannot parse, or an entry it cannot place with certainty (a
  Codex entry written as an inline table), is refused and left alone; so is an `abox` entry that points to
  a URL.
- **First-snapshot backup.** Before the first change to a file, a copy is kept in
  `<abox data dir>/setup-backups/` (directory `0700`, files `0600`; a manifest remembers the original path
  and whether the file existed). Later runs never overwrite it, so it always shows the state before abox.
  The backups can contain secrets (`~/.claude.json` does): treat the directory like the originals.
- **Staged, verified, atomic.** The new content is written and parsed in a private staging directory
  (`<data dir>/setup-staging/`), compared with the old document (everything but the `abox` entry must be
  equal), then written to a temporary file in the target's directory (`0600`, fsynced, mode of the old file
  restored) and renamed over the target. A file that did not exist is created with `link`, which cannot
  replace one that appeared meanwhile. The result is read back and compared once more.
- **Nothing changed meanwhile.** The preview carries a digest of every file's content. Apply builds the plan
  again and refuses when the digest differs; the guarded write compares size, mtime and hash right before
  the rename. Nothing is written then.
- **No symbolic links.** The files are examined with `lstat` and opened with `O_NOFOLLOW`; a link (typical
  for dotfile managers) is refused with the path of its target, and a link swapped in after the preview is
  not followed. Directories, files over 32 MiB and non-UTF-8 files are refused.
- **Uninstall.** `abox setup --uninstall` removes the `abox` entries, the rules blocks, the plugin and the
  marketplace it added (through the same code paths, so it works on the file as it is now and keeps later
  edits). A file that setup had created and that is empty afterwards is deleted. The backups stay for a
  manual restore.

## Where the files are

The paths below are what setup uses. **Several are not verified on a real install of the client**; this
column says how far each one was checked.

| Client         | Config file (Linux)                                                                                                                                                                                                                                                                                                                      | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | CLI `claude`; `~/.claude.json` (`mcpServers`, user scope), `~/.claude/settings.json` (`enabledPlugins`), `~/.claude/plugins/installed_plugins.json` and `known_marketplaces.json`, `~/.claude/CLAUDE.md`. With `CLAUDE_CONFIG_DIR` set: `$CLAUDE_CONFIG_DIR/.claude.json` and `settings.json`, `plugins/`, `CLAUDE.md` in that directory | The CLI syntax (`mcp add/remove`, `plugin install/uninstall`, `plugin marketplace add/remove`, `--scope`) and the structure of the files (key names only) were checked against Claude Code 2.1.302 on Linux, and `abox setup` was run end to end against that `claude` with a throw-away `HOME` (MCP method, and the plugin from a local marketplace path). The effect of `CLAUDE_CONFIG_DIR` on the location of `.claude.json` is **assumed** (setup detects with these paths; a mismatch shows up as "could not confirm" after a command). |
| Claude Desktop | Linux `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json` (default `~/.config/Claude/`); macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`                                                                                                                 | The Linux file was seen on a real install (Linux build; no abox entry in it). The macOS and Windows paths follow Anthropic's MCP documentation and are **unverified**.                                                                                                                                                                                                                                                                                                                                                                       |
| Codex          | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), `~/.codex/AGENTS.md`                                                                                                                                                                                                                                                              | Checked against Codex 0.156.1 on Linux: the file, `[mcp_servers.<name>]` with `command`/`args` and an `[mcp_servers.<name>.env]` sub-table, and the global `AGENTS.md`. `CODEX_HOME` is **assumed** from Codex's documentation.                                                                                                                                                                                                                                                                                                              |
| Cursor         | `~/.cursor/mcp.json` (JSON, read leniently as JSONC)                                                                                                                                                                                                                                                                                     | **Unverified**: Cursor was not installed. Path and `mcpServers` format from Cursor's documentation.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Gemini CLI     | `~/.gemini/settings.json` (JSONC), `~/.gemini/GEMINI.md`                                                                                                                                                                                                                                                                                 | **Unverified**: Gemini CLI was not installed. Paths and format from its documentation (the settings file allows comments).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Orca           | none                                                                                                                                                                                                                                                                                                                                     | Not written, see above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Windows is untested as a whole (path handling is in place, nothing was run there). Corrections welcome:
the table in `packages/core/src/setup/clients.ts` is the single place to change.

Not done on purpose: Cursor and Claude Desktop have no file for standing instructions, Codex and Gemini
CLI skills are not installed (their skill directories are not verified, and the skill text names the tools
of the plugin, `mcp__plugin_abox_abox__*`, which differ from a manual registration); the rules snippet
works everywhere. Claude Code's skill comes with the plugin.

## For the GUI wizard (later)

The logic lives in `@abox/core` (`packages/core/src/setup/`): `detectSetupClients`, `planSetup`,
`applySetup` take a `SetupEnvironment` (home, env, platform, backup and staging directories) and know
nothing about the CLI. The `Abox` facade wraps them as `setupDetect` / `setupPlan` / `setupApply` with
`requireHuman`, the confirmation and the audit entries; a main-process handler can call these three
methods. The first-run wizard (#22) can offer the same multi-select.

## Exit codes and errors

`approval_required` (3): no `--yes` and no terminal; `conflict` (2): a file changed since the preview, is a
symbolic link, or the Claude Code methods would collide; `unsupported` (2): Orca, a file shape setup will
not edit, a missing `claude` CLI; `invalid_input` (2): a file that is not valid JSON/TOML, unknown client,
bad option; `backend_error` (4): a step failed while applying (the steps that ran are in `details.result`).
