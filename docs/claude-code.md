# Claude Code and other agents

abox is useful to an agent only if the agent knows _when_ to use a sandbox. This page covers the
three ways to connect Claude Code (plain MCP, the `agent-kit` plugin, rule snippets) and how to
wire up other agents.

Whatever you use, the limits come from abox, not from instructions: the agent acts as a policy
context and cannot change the policy or approve its own requests (see [MCP](mcp.md)).

## Option 1: MCP server only

```sh
claude mcp add abox -- abox mcp serve --agent claude-code
```

Or in the project's `.mcp.json` (`abox init --agent claude-code` prints this):

```json
{
  "mcpServers": {
    "abox": { "command": "abox", "args": ["mcp", "serve", "--agent", "claude-code"] }
  }
}
```

`claude-code` is a built-in agent context only while you have **no** `policy.yaml`. As soon as you
write one, define the context yourself ([MCP: identity and contexts](mcp.md#identity-and-contexts)).
Claude Code lists the tools as `mcp__abox__<tool>`.

Under the built-in policy Claude can only use projects below `~/projects`, `~/Projekte`, `~/src`,
`~/code`, `~/dev`, `~/work`, `~/git` and `~/repos`, never your home directory as a whole and never
hidden folders such as `~/.claude`. `abox init --agent claude-code` run in your project says
whether the project qualifies; otherwise add its folder to `workspace.roots` with
`abox policy edit`.

## Option 2: the `agent-kit` plugin

The plugin lives in `packages/agent-kit` and bundles the MCP wiring, a decision skill, slash
commands, an optional subagent and an optional reminder hook. The repository doubles as a Claude
Code marketplace (`.claude-plugin/marketplace.json`).

Install from the marketplace (once the repository is public):

```text
/plugin marketplace add spacy-cloud/agent-box
/plugin install abox@agent-box
```

Install from a checkout, for development or before publication:

```sh
claude --plugin-dir packages/agent-kit            # loaded for this session, no install
```

or `/plugin marketplace add ./path/to/agent-box` followed by `/plugin install abox@agent-box`.
After loading, `/mcp` shows the server as `plugin:abox:abox` and its tools are named
`mcp__plugin_abox_abox__<tool>` (relevant for permission rules).

> **`abox` must be installed separately and found on the `PATH`.** The plugin does not contain the
> program: its MCP server is `abox mcp serve --agent claude-code`. If `abox` is not on the `PATH`
> of the environment Claude Code starts in (a desktop launcher or an IDE often has a shorter one
> than your shell), set `ABOX_BIN=/full/path/to/abox` there; `.mcp.json` of the plugin uses
> `${ABOX_BIN:-abox}`. Without it `/mcp` shows `plugin:abox:abox` as failed. The `check-abox`
> SessionStart hook of the plugin then tells you why (see below).

Other requirements: a working backend (`abox doctor`) and a Claude Code version with plugin support
(checked with 2.1.x). `claude plugin validate packages/agent-kit` and `claude plugin validate .`
(marketplace) pass.

### What the plugin contains

| Component                     | How you use it | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill `use-sandbox`           | automatic      | Tells Claude when a sandbox is required (unknown code, dependency installs, `curl \| sh`, risky experiments), how to pick a template and a workspace mode (`worktree`/`clone`/`copy`, `mount` only on request), to snapshot before risky steps, to return results as a **diff** for you to review (pointing out `flagged` files), to always delete the sandbox, to **never work around** `policy_denied`, to tell you how to approve a `pending_approval`, to keep secrets out and to handle truncated output |
| `/abox:new <template> [mode]` | slash command  | creates a sandbox and reports id and limits; without a template it lists them                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/abox:list`                  | slash command  | table of your sandboxes with state and remaining lifetime                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/abox:shell <id>`            | slash command  | Claude cannot take over a TTY; it checks the sandbox and tells you to run `abox shell <id>`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/abox:export <id> [format]`  | slash command  | exports a diff (or patch, branch, files) and shows it with flagged files; applies nothing                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/abox:destroy <id>`          | slash command  | shows what would be lost and asks before deleting                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Subagent `sandbox-runner`     | on request     | runs one bounded task entirely inside a sandbox; it may only use the abox tools and `Read`, and returns a summary plus the diff                                                                                                                                                                                                                                                                                                                                                                               |
| Hook `warn-host-install`      | opt-in         | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Hook `check-abox`             | automatic      | at session start: silent when `abox` is found, otherwise says that the sandbox tools are unavailable and how to fix it                                                                                                                                                                                                                                                                                                                                                                                        |

Only `use-sandbox` is model-invoked; the slash commands are user-only, which keeps the per-session
context cost small.

### The reminder hook (off by default)

`hooks/warn-host-install.sh` is registered for `PreToolUse` on `Bash` but **does nothing** unless
you start Claude Code with `ABOX_HOOK_WARN=1`:

```sh
ABOX_HOOK_WARN=1 claude
```

When enabled and a Bash command looks like a package install (`npm`/`pnpm`/`yarn`/`bun`,
`pip`, `uv`, `cargo`, `go`, `apt`/`dnf`/`pacman`/`brew`, ...) or a download piped into a shell, it
shows a one-line notice and adds a hint for Claude. It never blocks and never makes a permission
decision. **It is a convenience, not a security boundary**: it matches text and is trivially
bypassed. The hook process is started for every Bash call even when disabled (it exits at once);
disable the hook in `/plugin` if that matters to you.

### When `abox` is not found (`check-abox`)

`hooks/check-abox.sh` is a `SessionStart` hook. It looks up `${ABOX_BIN:-abox}` (a command on the
`PATH`, or a path to an executable file) and stays silent if it exists. Otherwise it shows a
one-line notice ("the 'abox' command was not found on the PATH of the environment Claude Code
started in ...", or, when `ABOX_BIN` is set to something that is not an executable file, which
value is wrong) and tells Claude that the sandbox tools are not available in this session, so it
neither pretends to use them nor quietly runs untrusted code on the host. It never blocks and
always exits 0. Fix: install abox or set `ABOX_BIN`, then restart Claude Code.

### While a human works in a sandbox

When you open a terminal in a sandbox that Claude owns (GUI terminal tab or `abox shell`), abox
**pauses Claude's input** there, as the GUI concept asks: `sandbox_exec`, `sandbox_process_start`,
`sandbox_process_stop`, `sandbox_write_file`, `sandbox_snapshot`, `sandbox_restore`, `sandbox_start`,
`sandbox_stop`, `sandbox_delete` and `access_request` answer `conflict` with "paused: a human is
working in sandbox ...", and `sandbox_inspect` / `sandbox_list` carry `human_attached`.
Reading (files, listing, logs, inspect) keeps working. See [GUI: taking over a
sandbox](gui.md#taking-over-an-agents-sandbox).

### Security of the plugin itself

A plugin runs with your user rights: its MCP server is a process on your machine, its hooks run
shell commands and its skills steer Claude. Read `.mcp.json`, `hooks/` and the skill texts before
installing, as with any code. The plugin gives Claude no power over abox policy.

### Status

The plugin's structure is covered by automated tests (`pnpm vitest run packages/agent-kit`:
manifests parse, skills are well formed, every tool name used exists, the subagent is limited to
abox tools and `Read`, the hook is silent and never blocks). **Whether Claude actually loads the
`use-sandbox` skill for the right tasks was verified headless only (`claude -p`, 2026-10-17, single
samples)**: with the first description one scenario failed, with the current one all passed. The
slash commands and an interactive session are untested; the scenarios and results are in
`packages/agent-kit/README.md`.

## Option 3: rules in `CLAUDE.md` / `AGENTS.md`

For agents without plugin support, or in addition to the plugin, put the snippet from
`packages/agent-kit/templates/CLAUDE.md.snippet` (or `AGENTS.md.snippet`) into the project's rules
file. `abox init --agent <name>` prints a ready-made version together with the MCP configuration:

```markdown
## Running untrusted code (abox sandboxes)

Run unknown or untrusted code only in an abox sandbox, never directly on the host. ...

1. `template_list` and pick a template by its description.
2. `sandbox_create` with workspace mode `worktree`, `clone` or `copy` (not `mount`) and a unique `request_id`.
3. Optionally `sandbox_snapshot` before risky steps.
4. Run work with `sandbox_exec` (argv form, explicit timeout).
5. `sandbox_export` with format `diff`; give the diff to the human for review.
6. `sandbox_delete` the sandbox at the end.
```

## Other agents

`abox init --agent <name>` prints the MCP entry and the rules snippet for `claude-code`, `codex`,
`cursor` and `orca`. All of them use the same stdio command with their own context name:

| Agent         | Where the entry goes                                                                                                                               | Command                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Codex         | `codex mcp add abox -- abox mcp serve --agent codex`, or the `[mcp_servers.abox]` TOML in `~/.codex/config.toml` (both shown by `abox init`)       | `abox mcp serve --agent codex`                                         |
| Cursor        | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`                                                                                               | `abox mcp serve --agent cursor`                                        |
| Orca          | HTTP: start `abox mcp serve --http 127.0.0.1:8765`, create a token with `abox token create orca`, put the URL and a bearer header into `.mcp.json` | see [MCP: HTTP](mcp.md#http)                                           |
| anything else | its MCP configuration                                                                                                                              | `abox mcp serve --agent <name>` with `<name>` defined in `policy.yaml` |

These contexts exist without a policy file; with one, define them.

### Orca

`packages/orca-plugin` is a thin Orca plugin (`spacy-cloud.agent-sandboxes`): commands that create
a sandbox for a worktree, show sandboxes, lifetimes and pending approvals, and type `abox shell
...`/`abox rm ...` into a terminal (never pressing Enter). It calls `abox ... --json` and contains
no sandbox logic. It **cannot approve** anything by design. Orca's plugin API cannot assign an MCP
server to an agent, so you wire MCP per project as above. See `packages/orca-plugin/README.md` for
installation and the permissions Orca asks for. **It has not been tested in a running Orca**; it
was validated against Orca's own manifest parser and exercised with mocks.

## A typical session

1. You ask: "Install the dependencies of this repo and run the tests."
2. Claude loads `use-sandbox`, calls `template_list`, then `sandbox_create` (`worktree` of the
   project, a fresh `request_id`).
3. If the profile requires it, abox queues an approval. Claude tells you the id; you run
   `abox approvals approve <id>` (or use the GUI); Claude repeats the same call.
4. Claude runs the install and the tests with `sandbox_exec`, with network only to the registries
   the template allows.
5. Claude exports a diff, shows it to you and points out flagged files, then calls
   `sandbox_delete`. You decide whether to apply anything.
