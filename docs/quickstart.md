# Quickstart

This page takes you from a fresh checkout to a working sandbox, then shows how the approval flow
works and how to connect an agent. It assumes Linux and a container engine (Docker or Podman).

abox is **pre-release software**. Nothing is published yet, so the only way to install it is from
source. Read the [security model](security.md), including
[Known limitations and not verified](security.md#known-limitations-and-not-verified), before you
give an agent anything you cannot afford to lose.

## Requirements

| What                    | Needed for                                            |
| ----------------------- | ----------------------------------------------------- |
| Linux                   | everything (macOS and Windows are not supported)      |
| Node.js >= 24           | running abox                                          |
| pnpm 10                 | building from source (`corepack enable` provides it)  |
| git                     | building, and the workspace modes `clone`/`worktree`  |
| Docker or Podman        | the container backends (the default for most templates) |
| `secret-tool` (libsecret) | optional: secrets in your desktop keyring           |
| `/dev/kvm`, QEMU        | optional: the VM backend, see [backends](backends.md) |

`abox doctor` checks what is available on your machine (see
[troubleshooting](troubleshooting.md#abox-doctor)).

## Install from source

```sh
git clone https://github.com/spacy-cloud/agent-box.git
cd agent-box
pnpm install
pnpm build
chmod +x packages/cli/dist/bin.js        # the root build does not set the executable bit
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/cli/dist/bin.js" ~/.local/bin/abox
abox --version
```

Make sure `~/.local/bin` is on your `PATH`. Without the link you can run
`node packages/cli/dist/bin.js` everywhere this documentation says `abox`.

Optional shell completion (bash, zsh and fish are supported):

```sh
abox completion bash > ~/.local/share/bash-completion/completions/abox
abox completion zsh  > "${fpath[1]}/_abox"
abox completion fish > ~/.config/fish/completions/abox.fish
```

abox keeps its files in the XDG directories: configuration in `~/.config/abox`, state and logs in
`~/.local/share/abox`, caches in `~/.cache/abox`. Set `ABOX_HOME=<dir>` to put everything below
one directory instead, which is handy for trying things out without touching your real setup.

## Your first sandbox

List the templates that come with abox:

```console
$ abox template ls
NAME        BACKEND  ISOLATION  NET        SOURCE   TRUSTED  READY  DESCRIPTION
alpine-min  docker   container  none       builtin  yes      yes    Minimal Alpine 3.22 shell environment (busybox only) without network …
host-shell  process  none       open       builtin  yes      yes    Runs commands directly on the host as the abox user with NO isolation…
node-dev    docker   container  allowlist  builtin  yes      yes    Node.js 24 with pnpm 10, git and C build tools on Ubuntu 24.04. Netwo…
py-dev      docker   container  allowlist  builtin  yes      yes    Python 3.13 with uv and git on Ubuntu 24.04. Network is limited to Py…
py-offline  docker   container  none       builtin  yes      yes    Python 3.13 with numpy and pandas and NO network access. Use it to ru…
py-uv       python   container  allowlist  builtin  yes      yes    Python 3.13 with uv in a container (python backend), without git and …
rust-dev    docker   container  allowlist  builtin  yes      yes    Rust (stable, minimal rustup profile) with git on Ubuntu 24.04. Netwo…
```

`READY` tells you whether the backend of a template is available on this machine. The
[template handbook](templates.md) explains every field.

Create a throw-away sandbox from `alpine-min` with an empty workspace. The first create builds
the environment image (a few seconds for `alpine-min`, much longer for templates that install
toolchains); later creates reuse it.

```console
$ abox create alpine-min --mode empty --name scratch
created local/7faf91da (scratch) from alpine-min in 500ms
  state running, network none, expires in 30m00s
  next: abox exec local/7faf91da -- <command>   |   abox shell local/7faf91da
```

A sandbox can be addressed by its id (`local/7faf91da`), by the 8 hex characters, or by its name
when the name is unique. Run something in it, then open an interactive shell:

```console
$ abox exec scratch -- sh -c 'id -un; pwd; echo hello > note.txt; ls'
agent
/workspace
note.txt
$ abox shell scratch          # needs an interactive terminal; leave with `exit`
```

`abox exec` ends with the exit code of the command it ran. Put `--` in front of the command so
your shell does not parse its options. Every sandbox has a lifetime (`ttl`); `abox ls` shows the
time left and `abox extend scratch 1h` adds more (a policy may cap the total).

Get the result out and clean up:

```console
$ abox export scratch --format files -o ~/projects/scratch-out
$ abox rm -f scratch
removed local/7faf91da
```

`abox export` never changes your original project; see below. `abox rm` refuses to remove a
running sandbox unless you pass `-f`.

## Workspace modes

A sandbox sees a **workspace**: a directory at `/workspace` (the default) inside the sandbox. The
mode decides how your project directory gets there. You choose it with `--mode` together with
`--workspace <dir>` (use `.` for the current directory); templates can set a default.

| Mode       | What happens                                                          | Git inside the sandbox | Typical use                              |
| ---------- | --------------------------------------------------------------------- | ---------------------- | ---------------------------------------- |
| `copy`     | the directory is copied in (symlinks are not followed)               | whatever you copied    | unknown code, maximum separation (default) |
| `clone`    | an independent clone on a new branch `abox/<id>`, uncommitted changes are not included | works      | work on a repo without touching the checkout |
| `worktree` | a git worktree on a new branch `abox/<id>`, bound read-write          | does not work          | parallel agents on one repo              |
| `mount`    | your directory is bind-mounted; `.git` is read-only                   | read-only              | fast iteration; **edits your real files** |
| `empty`    | an empty directory                                                    | -                      | experiments with no input                |
| `sync`     | one-way initial copy, meant for remote hosts                          | whatever you copied    | remote hosts                             |

Things to know:

- `copy` and `sync` copy **everything**, including `.git` with its history, remote URLs and
  hooks. abox prints a warning when it does; ask an agent to use `clone` or `worktree` for
  repositories.
- `clone` and `worktree` need the top level of a git repository.
- The workspace must lie inside the **workspace roots** of the profile that is asking. For you
  (the human) that is your home directory, but never the home directory itself or credential
  folders such as `~/.ssh`. For agents see [MCP identity](mcp.md#identity-and-contexts).
- `worktree` and `mount` are not available on remote hosts, see [hosts and SSH](hosts-ssh.md).

An end-to-end example with a git repository:

```console
$ cd ~/projects/demo
$ abox create alpine-min --mode clone --workspace . --name try1
$ abox exec try1 -- sh -c 'echo "// change" >> README.md && echo new > new.txt'
$ abox export try1                       # prints a diff; nothing is applied
$ abox export try1 --format patch -o /tmp/try1.patch
$ abox export try1 --format branch       # creates the branch abox/<id>-export in ~/projects/demo
$ abox rm -f try1
```

Export formats:

| Format   | Result                                                                   |
| -------- | ------------------------------------------------------------------------ |
| `diff`   | unified diff on standard output (or `-o <file>`)                         |
| `patch`  | like `diff`, as a mail-style patch for `git am`/`git apply` (use `-o <file>`) |
| `branch` | a branch `abox/<id>-export` (or `--branch <name>`) in your repository containing the changes; your checkout is untouched |
| `files`  | the changed files copied to a directory (`-o <dir>`)                     |

abox flags changed files that can run code on your machine later (CI workflows, git hooks,
`Makefile`, `package.json` scripts, `.envrc`, editor tasks and so on). Review these especially
carefully. There is no command that applies a result to your project; that step stays yours.

## Approvals

abox has two kinds of callers. **You** (the `human` context) are trusted: abox asks you to confirm
risky settings, and `--yes` answers for you. An **agent** works under a *profile* in `policy.yaml`.
Whatever the profile allows runs without asking (in the default approval mode), whatever goes
beyond it needs a decision from you, and whatever the profile forbids is denied outright.

When an agent asks for something that needs a decision, abox puts a request in a queue and the
agent is told to wait. You decide:

```console
$ abox approvals ls
ID                                    KIND    AGENT           SANDBOX  STATUS   EXPIRES    REQUEST
70918ad4-c657-457d-8065-4d6daa948f87  create  agent:reviewer  -        pending  in 14m56s
$ abox approvals show 70918ad4-c657-457d-8065-4d6daa948f87      # the exact request, the agent's reason, abox's own risk text
$ abox approvals approve 70918ad4-c657-457d-8065-4d6daa948f87
$ abox approvals deny 70918ad4-c657-457d-8065-4d6daa948f87 --note "not now"
```

Properties worth knowing:

- An approval is **one-time** and **bound to the exact request** (template content, options,
  paths, network, resources) and to the current `policy.yaml`. Any change is a new decision.
- The agent's explanation is shown to you as untrusted text. The risk list is computed by abox.
- A request nobody decides expires (after 15 minutes by default) and counts as denied.
- Permanent rules are never a side effect of an approval. To allow something for good, edit the
  policy: `abox policy edit` (validates, shows a diff, asks for confirmation).
- The GUI shows the same queue, with desktop notifications and a tray indicator, see
  [GUI](gui.md).

A first look at the policy that is in force:

```console
$ abox policy show
$ abox policy show --context claude-code     # the resolved rights of one agent context
```

Without a `policy.yaml`, a conservative built-in policy applies, with the agent contexts
`default`, `claude-code`, `codex`, `cursor` and `orca`, all using the profile `default`: up to 3
sandboxes, 4 CPUs, 8 GB, 4 hours, the templates `node-dev`, `py-dev`, `py-offline` and
`alpine-min`, workspace modes `worktree`, `clone`, `copy`, `empty`, network `none` or `allowlist`
with the `npm`, `pypi` and `github` presets, no extra mounts, no secrets.

## Connect Claude Code

The simplest way is to register abox as an MCP server. The server runs as a child process of
Claude Code and acts as the agent context `claude-code`:

```sh
claude mcp add abox -- abox mcp serve --agent claude-code
```

Or put this into the project's `.mcp.json` (`abox init --agent claude-code` prints it):

```json
{
  "mcpServers": {
    "abox": { "command": "abox", "args": ["mcp", "serve", "--agent", "claude-code"] }
  }
}
```

Better still, install the `agent-kit` plugin, which adds the MCP wiring plus a skill that teaches
Claude when to use a sandbox, slash commands and an optional subagent:

```text
/plugin marketplace add spacy-cloud/agent-box
/plugin install abox@agent-box
```

Details, other agents (Codex, Cursor, Orca) and the rule snippets for `CLAUDE.md` / `AGENTS.md`
are in [Claude Code and other agents](claude-code.md). The tools the agent gets and how errors
and approvals look to it are in the [MCP reference](mcp.md).

`abox init` also writes an example project template to `.sandbox/<dir>-dev.yaml` in the current
directory. Project templates are untrusted until you approve their exact content, see
[templates](templates.md#project-templates-and-trust).

## Start the GUI

The Electron app is part of the repository and is still under development (see [GUI](gui.md) for
what exists today). From a source checkout:

```sh
pnpm --filter @abox/app dev          # development mode with hot reload
pnpm --filter @abox/app build        # production build of main, preload and renderer
```

The app uses the same state as the CLI and the MCP server, so approvals created by an agent show
up in it. It is not required: everything works without it.

## Where to go next

- [Template handbook](templates.md): write your own templates.
- [CLI reference](cli.md): every command, JSON output and exit codes.
- [Backends](backends.md): docker, podman, process, python, vm.
- [Troubleshooting](troubleshooting.md): `abox doctor`, common errors, resetting `ABOX_HOME`.
