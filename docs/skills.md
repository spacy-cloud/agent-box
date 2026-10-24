# Skills

A **skill** is a folder with a `SKILL.md`: instructions for one kind of task, in the same format as
Claude Code and Agent Skills (YAML front matter with `name` and `description`, then Markdown), plus
optional files such as `scripts/` or `references/`. abox keeps a catalog of skills and copies the
ones you choose into a sandbox, read-only, so an agent working there finds them: a short index
first, and the full instructions when it needs them.

Skills are chosen per template (`skills:`) and per sandbox (`abox create --skill`, MCP
`sandbox_create` `skills`, the GUI's New-sandbox dialog), much like you pick the MCP servers of an
agent. They are text for the agent, not code that abox runs.

- [A first skill](#a-first-skill)
- [The SKILL.md format](#the-skillmd-format)
- [Validation](#validation)
- [Where skills live, and which one wins](#where-skills-live-and-which-one-wins)
- [Project skills and trust](#project-skills-and-trust)
- [Giving a sandbox skills](#giving-a-sandbox-skills)
- [Inside the sandbox](#inside-the-sandbox)
- [Built-in skills](#built-in-skills)
- [Security notes](#security-notes)

## A first skill

Create the folder `~/.config/abox/skills/release-notes/` with this `SKILL.md`:

```markdown
---
name: release-notes
description: Write the release notes of the project from the commits since the last tag. Use it when asked for a changelog entry or release notes.
---

# Release notes

1. Find the last tag: `git describe --tags --abbrev=0`.
2. List the commits since then: `git log --oneline <tag>..HEAD`.
3. Group them into Added, Changed, Fixed; leave out chores and merges.
```

Check it, then give it to a sandbox:

```sh
abox skill validate release-notes
abox skill show release-notes
abox create node-dev -w . --skill release-notes
```

Or list it in a template, so every sandbox of that template gets it:

```yaml
apiVersion: 1
name: node-docs
backend: docker
extends: node-dev
skills: [release-notes, minimal-change]
```

## The SKILL.md format

`SKILL.md` must start with front matter between two `---` lines:

| Key                                                                                              | Required | Rules                                                                                                                                      |
| ------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                                                                                           | yes      | `^[a-z0-9]([a-z0-9-]{0,62})$` (the template name rules) and **equal to the folder name**                                                   |
| `description`                                                                                    | yes      | a non-empty string of at most 1024 characters: what the skill does and when to use it. This is what an agent sees in the index; be precise |
| `license`, `compatibility`                                                                       | no       | strings                                                                                                                                    |
| `metadata`                                                                                       | no       | a map of strings                                                                                                                           |
| `allowed-tools`                                                                                  | no       | a string or a list of strings (abox passes it on and does not interpret it)                                                                |
| `version`, `model`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `when_to_use` | no       | accepted as written (Claude Code keys); abox does not interpret them                                                                       |

Any other key is an error that names the known ones. After the front matter come the
instructions; an empty body is an error. Keep `SKILL.md` short and move long material into extra
files that the instructions point to (`references/api.md`, `scripts/check.sh`): an agent reads the
index, then the `SKILL.md`, and only then the files it needs.

## Validation

`abox skill validate <name|folder>` checks a catalog skill by name or any folder by path (`./my-skill`,
or the path of its `SKILL.md`) and prints every problem with the file and, for `SKILL.md`, line and
column; the exit code is 2 and the error code `skill_invalid` (see [errors](errors.md)). The same rules
apply whenever abox loads a skill (`abox skill ls` lists broken folders below the table, and a
create that names one fails):

| Rule          | Limit                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| folder        | a real folder named like the skill; a folder that is a symbolic link is never followed (listed as a problem)                                                      |
| `SKILL.md`    | required, valid UTF-8, at most 256 KiB, front matter as above                                                                                                     |
| files         | at most 100 files and 1 MiB together, folders nested at most 8 levels deep; `.git` is left out                                                                    |
| names         | file and folder names of letters, digits, `.`, `_` and `-` only (no spaces)                                                                                       |
| links         | a symbolic link to a file **inside** the skill is delivered as a copy of that file; links that leave the folder, links to folders and links to nothing are errors |
| special files | sockets, pipes and devices are errors                                                                                                                             |
| per sandbox   | at most 32 skills and 8 MiB together                                                                                                                              |

A template is checked against the catalog too: `abox template validate` reports a name in
`skills:` that no catalog has (with its line), and a create from such a template fails with
`not_found`.

## Where skills live, and which one wins

| Location                                   | Kind      | Purpose                                                                  |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------ |
| `<project>/.sandbox/skills/<name>/`        | `project` | belongs to a repository, versioned with it; **untrusted** until approved |
| `~/.config/abox/skills/<name>/`            | `user`    | your own skills (abox does not create the folder)                        |
| shipped with abox (`packages/core/skills`) | `builtin` | see [built-in skills](#built-in-skills)                                  |

The order on a name clash is the one of templates: **project, then user, then builtin**. `abox skill
ls` shows the winner and `SOURCE` says what it shadows (`project (shadows builtin)`). The project
directory is the one of the create (its workspace, `--project`), exactly as for project templates;
for agents only below their workspace roots. A broken folder that outranks a valid skill of the
same name is reported, never skipped in favour of the other one.

## Project skills and trust

A skill from a repository is external input: it is text an agent reads and may act on. abox
treats it like a [project template](templates.md#project-templates-and-trust):

- It is untrusted until a human approves its **content hash** (the name and every file: path,
  executable bit and content). Any change makes it untrusted again. `abox skill ls` shows
  `TRUSTED = NO`, the MCP tool `skill_list` says `needs_approval`.
- As a human, `abox create` names the skill among the points to confirm and asks; a
  non-interactive call needs `--yes`. That confirmation is for the single call and records no trust.
  Read it first with `abox skill show <name>` (or in the GUI's Skills view).
- When an agent's create needs it, the request goes to the approval queue (kind `template_trust`,
  the same as for an untrusted project template; the reason names the skill). **Approving it records
  exactly that content hash** as trusted (audit entry `skill.trust`); the same approval also covers
  an untrusted project template of the same request.
- Trust is checked in every approval mode, also `open`, and also for the skills a template lists.

## Giving a sandbox skills

A sandbox gets the skills of its template (`skills:`, inherited along `extends` as a union, parent
first) plus the ones the create request adds:

| Surface | How                                                                                  |
| ------- | ------------------------------------------------------------------------------------ |
| CLI     | `abox create <template> --skill a --skill b`                                         |
| MCP     | `sandbox_create` with `skills: ["a", "b"]`; `skill_list` / `skill_show` to find them |
| GUI     | New sandbox, the **Skills** checkboxes (the template's own are checked and fixed)    |

**Policy.** The skills of the template need no right of their own: the template is already
allowed by the profile. A skill that the **request adds** must be in the profile's `skills` list
(`'*'` for any); a profile without `skills` lets a request add none, the safe default of the
policy file. The built-in policy and the human profile allow any skill (`skills: ['*']`). A
project skill additionally needs its approval, see above.

```yaml
profiles:
  default:
    skills: [run-tests, minimal-change] # skills an agent may add to a sandbox
```

The skills are part of the request: an approval binds to their names and content hashes, and the
same `request_id` with other skills is a conflict, not the same sandbox.

## Inside the sandbox

At create, abox copies the chosen skills into the sandbox, one folder each, plus an index:

```
/skills/INDEX.md
/skills/run-tests/SKILL.md
/skills/minimal-change/SKILL.md
```

The environment variable `ABOX_SKILLS_DIR` holds the directory (`/skills`), and `abox inspect` /
`sandbox_inspect` list the skills of a sandbox. `INDEX.md` lists name, path and description of every
skill, so an agent only loads the index and reads a full `SKILL.md` when the description fits:

```markdown
# Skills

abox placed these skills into the sandbox at /skills (the environment variable ABOX_SKILLS_DIR holds the directory).
Each skill is a folder with a SKILL.md. Read this index, then read the SKILL.md of a skill when its description fits your task.
The files are read-only. Paths below are relative to this directory.

## run-tests

- path: run-tests/SKILL.md
- description: Find and run the test suite of the project ...
```

The files are **copied at create**, not mounted, so the same works on every backend and on remote
hosts. A skill that changes later reaches new sandboxes only. How read-only they are depends on
the backend:

| Backend                                      | Where                                                                                              | Read-only                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker`, `podman`, `python` (container)     | `/skills`                                                                                          | files and folders belong to root (files `0444`, scripts `0555`, folders `0755`): the sandbox user can read them, but not change, add, move or remove anything there. With a read-only root file system (`readonly-rootfs`) `/skills` is a volume of its own, owned by root as well |
| `vm`                                         | `/skills` in the guest                                                                             | owned by root in the guest, the same modes                                                                                                                                                                                                                                         |
| `process`, `python` (venv, isolation `none`) | `<sandbox root>/skills`; `ABOX_SKILLS_DIR` points there for commands, the file tools use `/skills` | only the modes: there is no other user, so the files belong to you, and code in the sandbox could change them                                                                                                                                                                      |

`/skills` belongs to abox in such a sandbox: a template whose workspace, a mount, a cache or a
secret file lies in it cannot get skills (`invalid_input`). Snapshots contain the skills like any
other file; a sandbox restored or cloned from a snapshot has the skills of the snapshot plus those
of its own create.

**Claude Code inside the sandbox.** abox does not link the skills into the agent's
`~/.claude/skills` (that would put abox files into the agent's own configuration). To make Claude
Code load them as its own skills, link them in the sandbox, for example
`mkdir -p ~/.claude/skills && ln -s /skills/run-tests ~/.claude/skills/`, or tell the agent to
read `/skills/INDEX.md`. The built-in `work-in-sandbox` skill tells an agent where the skills are.

## Built-in skills

Short, generic skills that are useful in most sandboxes; read them with `abox skill show <name>`.

| Skill             | What it says                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `run-tests`       | how to find the test command of a project, run the suite before and after a change and report the result checkably                       |
| `minimal-change`  | how to make the smallest change that solves the task and is easy to review as a diff                                                     |
| `work-in-sandbox` | what the workspace, the network limits, the secrets rule and the lifetime of an abox sandbox mean for an agent, and how results get back |

No built-in template lists skills; add them per template or per sandbox.

## Security notes

- **Skills are instructions, not a boundary.** An agent may follow them or not; nothing in abox
  enforces what a skill says. What protects your machine is still the sandbox: its isolation,
  network mode, mounts and policy.
- **A foreign skill is prompt injection by design.** A skill can tell an agent to do anything the
  sandbox can reach, for example to send the workspace to an allowed destination. That is why
  project skills need your approval of their exact content, and why the policy decides which skills
  an agent may add.
- **Read-only** means the agent in the sandbox cannot rewrite the skill for itself or for a later
  step (on the isolated backends), not that the content is harmless.
- abox never runs a skill's scripts; an agent in the sandbox may, with the rights of the sandbox
  user.

See also: [templates](templates.md#field-reference) (`skills:`), [CLI](cli.md#abox-skill),
[MCP](mcp.md), [GUI](gui.md#skills), [security](security.md#skills).
