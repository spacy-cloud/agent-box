# Quickstart

This page takes you from a fresh checkout to a working sandbox, then shows how the approval flow
works and how to connect an agent. It assumes Linux and a container engine (Docker or Podman).

abox is **pre-release software**. Nothing is published yet, so the only way to install it is from
source. Read the [security model](security.md), including
[Known limitations and not verified](security.md#known-limitations-and-not-verified), before you
give an agent anything you cannot afford to lose.

## Requirements

| What                      | Needed for                                              |
| ------------------------- | ------------------------------------------------------- |
| Linux                     | everything (macOS and Windows are not supported)        |
| Node.js >= 24             | running abox                                            |
| pnpm 10                   | building from source (`corepack enable` provides it)    |
| git                       | building, and the workspace modes `clone`/`worktree`    |
| Docker or Podman          | the container backends (the default for most templates) |
| `secret-tool` (libsecret) | optional: secrets in your desktop keyring               |
| `/dev/kvm`, QEMU          | optional: the VM backend, see [backends](backends.md)   |

`abox doctor` checks what is available on your machine (see
[troubleshooting](troubleshooting.md#abox-doctor)).

## Install from source

```sh
git clone https://github.com/spacy-cloud/agent-box.git
cd agent-box
pnpm install
pnpm build
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
NAME         BACKEND  ISOLATION  NET        SOURCE   TRUSTED  READY  DESCRIPTION
alpine-min   docker   container  none       builtin  yes      yes    Minimal Alpine 3.22 shell environment (busybox only) without network …
flutter-dev  docker   container  allowlist  builtin  yes      yes    Flutter 3.47 (stable channel, Dart 3.13) with git and the Linux deskt…
host-shell   process  none       open       builtin  yes      yes    Runs commands directly on the host as the abox user with NO isolation…
node-dev     docker   container  allowlist  builtin  yes      yes    Node.js 24 with pnpm 10, git and C build tools on Ubuntu 24.04. Netwo…
php-dev      docker   container  allowlist  builtin  yes      yes    PHP 8.3 (CLI) with mbstring, xml, curl, zip, sqlite3 and intl, Compos…
py-dev       docker   container  allowlist  builtin  yes      yes    Python 3.13 with uv and git on Ubuntu 24.04. Network is limited to Py…
py-offline   docker   container  none       builtin  yes      yes    Python 3.13 with numpy and pandas and NO network access. Use it to ru…
py-uv        python   container  allowlist  builtin  yes      yes    Python 3.13 with uv in a container (python backend), without git and …
rust-dev     docker   container  allowlist  builtin  yes      yes    Rust (stable, minimal rustup profile) with git on Ubuntu 24.04. Netwo…
shell-dev    docker   container  none       builtin  yes      yes    Linting and formatting for shell and Lua configuration on Ubuntu 24.0…
tauri-dev    docker   container  allowlist  builtin  yes      yes    Rust (stable, with clippy and rustfmt), Node.js 24 with pnpm 10 and g…
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
`--workspace <dir>` (use `.` for the current directory).

- **Without `--workspace`** the workspace is `empty`: nothing of the current directory is shared.
- **With `--workspace` and no `--mode`** the mode of the template is used (`copy` for all built-in
  templates).
- `--mode` or `--ref` without `--workspace` is an `invalid_input` error (except `--mode empty`).

| Mode       | What happens                                                                           | Git inside the sandbox | Typical use                                         |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------- |
| `copy`     | the directory is copied in (symlinks are not followed)                                 | whatever you copied    | unknown code, maximum separation (template default) |
| `clone`    | an independent clone on a new branch `abox/<id>`, uncommitted changes are not included | works                  | work on a repo without touching the checkout        |
| `worktree` | a git worktree on a new branch `abox/<id>`, bound read-write                           | does not work          | parallel agents on one repo                         |
| `mount`    | your directory is bind-mounted; `.git` is read-only                                    | read-only              | fast iteration; **edits your real files**           |
| `empty`    | an empty directory                                                                     | -                      | experiments with no input                           |
| `sync`     | one-way initial copy, meant for remote hosts                                           | whatever you copied    | remote hosts                                        |

Things to know:

- `copy` and `sync` copy **everything**, including `.git` with its history, remote URLs and
  hooks. abox prints a warning when it does; ask an agent to use `clone` or `worktree` for
  repositories.
- `clone` and `worktree` need the top level of a git repository.
- The workspace must lie inside the **workspace roots** of the profile that is asking. For you
  (the human) that is your home directory, but never the home directory itself or credential
  folders such as `~/.ssh`. For agents see [MCP identity](mcp.md#identity-and-contexts).
- `worktree` and `mount` are not available on remote hosts, see [hosts and SSH](hosts-ssh.md).
- A directory that a `mount` sandbox works on directly cannot be given to another sandbox (in any
  mode) until the first one is removed: `abox create` answers `conflict` and names that sandbox. The
  directory is held from the moment the sandbox is registered, and that is decided in one database
  transaction, so several `abox create --mode mount` for one directory started at the same time give
  it to exactly one of them (a parent or child directory counts as the same).

### What `copy` and `sync` copy, and how big it may be

`copy` and `sync` put the directory (minus what `.gitignore` and `--exclude` leave out) into the sandbox:

- **What `.gitignore` ignores is left out.** The project's `.gitignore` files (nested ones, `!`
  negation and `**` included) and its `.git/info/exclude` are applied, so `node_modules`, build
  output, virtual environments and `.env` files do not travel into the sandbox; files git tracks are
  always kept. It is on by default. To copy everything, use `abox create ... --no-gitignore`, the
  MCP field `workspace.gitignore` set to `false`, the **Respect .gitignore** checkbox of the GUI or
  `workspace: { gitignore: false }` in a template. The rules, what is not applied (your global git
  ignore file, `.gitignore` files above the folder) and the caps are in
  [templates](templates.md#gitignore).
- **`.git` is copied** (history, remote URLs, hooks) and never treated as ignorable content; keep
  it out with `--exclude .git`.
- **More can be left out with `--exclude`** (`abox create ... --exclude generated,*.bak`; MCP
  `workspace.exclude`; the **Also exclude** field of the GUI's New sandbox). Patterns are
  gitignore-like (`name` anywhere, `/name` at the top, `dir/`, `*`, `?`, `**`; no `!`), see
  [templates](templates.md#exclude-patterns).
- **Symlinks are not followed**; they are copied as links. Sockets, FIFOs and devices are skipped.
- **Size is checked before anything is copied.** A fast read-only scan (it only lists directories
  and looks at file sizes, no content is read) runs first and prints `workspace: N files, X` on
  stderr (and in the GUI log); `abox create` then shows `copying workspace ... X of Y` and
  `recording baseline ... X of Y` while it works. Ctrl-C (CLI) or **Cancel** (GUI) stops the scan or
  copy and removes what was made.
- **Soft limit: 1 GiB or 50 000 entries** (policy `workspace.max_copy_bytes` /
  `workspace.max_copy_entries`). A bigger folder is not copied silently: you get a confirmation
  that names the size (`--yes` answers it; without a terminal the command exits with 3), an agent
  gets `policy_denied` with the alternatives of its profile. Raise the limits for a profile in
  `policy.yaml` (`abox policy edit`).
- **Hard limit: 64 GiB or 2 000 000 entries** (4 GiB per file; larger files are skipped and
  listed). Beyond it `abox create` fails within seconds with `invalid_input` ("workspace folder ...
  is larger than the copy limit"). Choose the project folder itself, use `mount` or `clone` for big
  repositories, or exclude the big directories. The limits count what remains after `.gitignore`.
- The copy needs free disk space several times the size (staging copy, baseline, the sandbox).

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

| Format   | Result                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `diff`   | unified diff on standard output (or `-o <file>`)                                                                         |
| `patch`  | like `diff`, as a mail-style patch for `git am`/`git apply` (use `-o <file>`)                                            |
| `branch` | a branch `abox/<id>-export` (or `--branch <name>`) in your repository containing the changes; your checkout is untouched |
| `files`  | the changed files copied to a directory (`-o <dir>`)                                                                     |

abox flags changed files that can run code on your machine later (CI workflows, git hooks,
`Makefile`, `package.json` scripts, `.envrc`, editor tasks and so on). Review these especially
carefully. There is no command that applies a result to your project; that step stays yours.

## Approvals

abox has two kinds of callers. **You** (the `human` context) are trusted: abox asks you to confirm
risky settings, and `--yes` answers for you. An **agent** works under a _profile_ in `policy.yaml`.
Whatever the profile allows runs without asking (in the default approval mode), whatever goes
beyond it needs a decision from you, and whatever the profile forbids is denied outright.

When an agent asks for something that needs a decision, abox puts a request in a queue and the
agent is told to wait. You decide:

```console
$ abox approvals ls
ID                                    KIND    AGENT           SANDBOX  STATUS   EXPIRES    REQUEST
70918ad4-c657-457d-8065-4d6daa948f87  create  agent:reviewer  -        pending  in 14m56s
$ abox approvals show 70918ad4-c657-457d-8065-4d6daa948f87      # the exact request, the agent's reason, why approval is needed, abox's own risk text
$ abox approvals approve 70918ad4-c657-457d-8065-4d6daa948f87
$ abox approvals deny 70918ad4-c657-457d-8065-4d6daa948f87 --note "not now"
```

Properties worth knowing:

- An approval is **one-time** and **bound to the exact request** (template content and its base
  image, options, paths, network, resources) and to the current `policy.yaml`. Any change is a new
  decision.
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

Without a `policy.yaml`, a built-in policy applies, with the agent contexts
`default`, `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini-cli` and `orca`, all using the profile `default`: up to 3
sandboxes, 4 CPUs, 8 GB, 4 hours, every built-in template except `host-shell`, workspace modes `worktree`, `clone`, `copy`, `empty`, network `none` or `allowlist`
with the `npm`, `pypi`, `crates`, `pub`, `packagist` and `github` presets, no extra mounts, no secrets.

**Where agents may work.** An agent can only use projects below these folders (they do not have
to exist): `~/projects`, `~/Projekte`, `~/src`, `~/code`, `~/dev`, `~/work`, `~/git` and
`~/repos`. Your home directory as a whole is not a root, and an agent never gets a path inside a
hidden folder of your home directory (`~/.claude`, `~/.codex`, `~/.cache`, ...), whatever the
roots say. A project anywhere else is refused with `policy_denied` and a hint. To allow another
folder, add it to `workspace.roots` of the profile with `abox policy edit`.
`abox init --agent claude-code` tells you whether the current project is usable. You, the human,
are not limited by these roots.

Free image names in templates (`base.os`) are limited for agents to the official Docker Hub images
(`images.registries: [docker.io/library]`); the base images of the built-in templates are always
fine. Anything else needs your approval, see [templates](templates.md#choosing-the-operating-system).

**A `policy.yaml` replaces the built-in policy entirely.** Once you write one, the built-in agent
contexts are gone: define every context you need (`contexts:`) and the profiles they use. See
[MCP: identity and contexts](mcp.md#identity-and-contexts).

## Connect Claude Code

The simplest way is to register abox as an MCP server. The server runs as a child process of
Claude Code and acts as the agent context `claude-code`:

```sh
claude mcp add abox -- abox mcp serve --agent claude-code      # or: abox setup --client claude-code
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

`abox setup` does the registration for you, for several agents at once, with a preview of every
change (see [Setting up agents](setup.md)). Details, other agents (Codex, Cursor, Gemini CLI, Orca)
and the rule snippets for `CLAUDE.md` / `AGENTS.md` are in
[Claude Code and other agents](claude-code.md). The tools the agent gets and how errors
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
