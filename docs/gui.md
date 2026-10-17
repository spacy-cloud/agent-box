# The desktop app (GUI)

The app is an Electron program in `packages/app`. It is a front end for the same manager that the
CLI and the MCP server use, so it shows the same sandboxes, the same approval queue and the same
audit log, and a click in the app goes through the same policy checks as a CLI call. You never
need the app: everything works without it.

> **Status.** The app is **pre-release and has not been published**. There is no installable
> package to download; you can build an AppImage yourself (`pnpm --filter @abox/app dist`, see
> [packaging](../packaging/README.md#appimage)). This page describes what the source tree
> contains; check it against the version you run. The end-to-end tests
> (`pnpm --filter @abox/app test:e2e`, Playwright on a virtual display) run and pass (37 tests; the 5 that
> need docker run with `ABOX_TEST_DOCKER=1`: the terminal, template build, ssh and the takeover with live usage ones; the
> test of the ssh passphrase dialog starts a throwaway `sshd` of the current user and is skipped when
> `/usr/bin/sshd` does not exist).

## Starting it

From a source checkout (after `pnpm install` and `pnpm build`):

```sh
pnpm --filter @abox/app dev       # development mode with hot reload
pnpm --filter @abox/app build     # production build (main, preload, renderer)
```

The app runs as the `human` context and uses `ABOX_HOME` / the XDG directories like the CLI. A
second start focuses the running window (single instance). German and English are available; the
language follows the system locale and can be switched in the settings (`ABOX_GUI_LOCALE` overrides
it).

## Views

| View               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandboxes**      | table of all sandboxes (agents' and yours) with state, backend and isolation, owner, resources (live CPU and memory next to the limit, see below), workspace and time left; filter by state, template, agent and text; start, stop, **Shell** (opens the Terminal tab of that sandbox; only for a running sandbox on a reachable host), extend the lifetime, export a diff, delete (the dialog warns that unexported changes are lost). The header says **"as of hh:mm:ss"** for the data on screen; after 20 seconds without a successful refresh, or after a failed one, it is marked **outdated**, and a row the backend no longer reports says so. Orphaned backend objects and stale sandboxes are announced in a banner; nothing is deleted automatically. A wizard (**New sandbox**) walks through template (with an optional **project folder** whose project templates are listed too, see below), options (network, resources, workspace) and a summary; risky settings need your explicit confirmation before anything is created. |
| **Sandbox detail** | tabs for the overview (effective options with deviations from the template highlighted), **Files** (the workspace as a tree, see below; review the changes since start, flagged files that can run code on the host, save the diff or a patch, export to a branch), **Logs** (background processes), **Snapshots**, **Activity** (the audit entries for this sandbox) and an interactive **Terminal**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Templates**      | list of builtin (read-only) and user templates, and the project templates of a **project folder** you pick (marked "project", with their trust state), with a form editor and a YAML editor, live validation with line numbers, duplicate, export as YAML, **Build** (with a note that builds have network access) and, for a project template, **Review …** (what it adds and its risks, see below). A project template is read-only here and is neither built nor tested from this view: it is built when a sandbox is created from it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Hosts**          | host profiles: add, edit, remove, test, confirm the host key by fingerprint, create a sandbox on a host (opens the New sandbox wizard with that host preselected), import from `~/.ssh/config`, saved port forwards, and an SSH terminal. Per host: the **utilisation** against its limits, the **engine** (rootless or rootful) and the hardened **runtimes** that were found, and groups (see [Hosts: utilisation, groups, engine](#hosts-utilisation-groups-engine)). See [hosts and SSH](hosts-ssh.md). There are no fields for passwords or keys; an ssh passphrase is asked in a dialog (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Approvals**      | the queue of requests from agents, see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Audit**          | the audit log with filters (time, actor, sandbox, action, decision), verification of the hash chain and export as JSON Lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Policy**         | the profiles and agent contexts in force as cards (isolation `none` in red), an editor with a **form** for profiles and limits next to the **YAML** text, live validation by the manager, a diff and a confirmation before saving, and the revision history. See [The Policy view](#the-policy-view).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Settings**       | language, closing the window to the tray (optional), diagnostics (the `abox doctor` checks with severities, see [Diagnostics](#diagnostics)), the reconcile report with an explicit "apply repairs" step, the MCP configuration for agents (copyable `claude mcp add` command and JSON for a chosen agent context), the **MCP status** (see below), MCP HTTP tokens (create, shown once, revoke) and the state of tray and notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Approvals

Pending requests appear in the **Approvals** view, in a count on the navigation entry, in the tray
icon and as a desktop notification (where the desktop supports a tray and notifications; without
them the count in the window remains). A request shows:

- who asks (the agent context), what kind of request it is (create, run command, extend access,
  trust a template, a base image from a registry the profile does not list) and when it expires. A
  kind this version of the app does not know is shown with a generic label and a warning, never as
  a raw key, together with the exact request;
- the **exact options compared to the default**, with the differences first;
- **why approval is needed**: one line per finding of the policy (a base image outside the
  allowed registries, an untrusted template, a mount, ...), stored with the approval by the
  manager (`abox approvals show` prints the same). Approvals stored by an older version have none,
  and the list is then left out;
- abox's own risk notes (isolation `none`, a mount outside the workspace, an open network, extra
  destinations, private addresses, a secret, an untrusted template);
- the agent's reason, labelled as unverified text;
- for a **template** request, the **base image** of the template, the registry it comes from, the
  registries the profile allows (`images.registries`) and a warning when the image lies outside
  them or a Dockerfile base cannot be checked. An image outside the allowlist is a decision for
  you, like a network destination beyond the allowlist; the publisher of the image controls
  everything that runs in the sandbox. The base is part of the request the approval is bound to
  (an approval for one base image cannot be used for another) and is read from the approval, so it
  is shown even if the template file has changed or is gone. Only for an approval stored by an
  older version, which does not carry the base, the app looks the template up again, and shows
  nothing when the file no longer has the content that was requested;
- for a **trust template** request, the **template review** (see below).

You can **Allow once**, **Allow permanently** or **Deny**. Allowing once is bound to exactly this
request. "Allow permanently" never creates a hidden rule: it opens a dialog with the change to
`policy.yaml` that would let requests like this one pass (see [Allow permanently](#allow-permanently)),
and nothing is written before you confirm. Approving a "trust template" request trusts exactly that
content hash.

Keyboard: **Esc denies** (inside the policy dialog opened from the request, Esc only closes that dialog). **Enter allows once only while the dialog itself has focus**, not while
a button inside it has focus (the button handles its own Enter), so a stray key press cannot
approve. The navigation is a list of buttons, views move focus to the content area on change, and
the app is built for keyboard and screen-reader use (it has an automated accessibility check with
axe in its tests).

### Template review

A project template is foreign input: it can run setup commands as root and ask for mounts,
network and secrets. Before you trust one, the approval shows the review the CLI prints with
`abox approvals show` (the manager's `reviewTemplate`):

- where the template comes from and what it is compared with: the version you trusted last, else
  the template it `extends`, else nothing (then the whole template is shown);
- the **risky points** in plain words (setup commands, open network, mounts, secrets, no
  isolation), computed by abox;
- the resolved template as a **diff** in a monospaced, scrollable box: added lines with `+`, removed
  lines with `-` (the colour is only a hint, the characters carry the meaning). Control and
  direction-changing characters in the file are shown as visible escapes, so a file cannot hide or
  reorder lines.

If the file **changed after the request was made**, a warning says so: an approval covers the old
content (its hash), so deny the request and review the new file. If the review cannot be loaded (the
file is gone), a notice says so and the decision stays available.

The same review appears in two more places: in the **New sandbox** confirmation when the template
is an untrusted project template (it is shown before anything is created, together with the base
image when that lies outside the allowed registries), and as **Review …** in the Templates view for
a project template. Looking at a review never trusts anything.

## New sandbox: big folders

For a `copy`/`sync` workspace the **Options** step measures the folder as soon as you have chosen
or typed it (a fast read-only scan, no file content is read; it is cancelled and restarted when you
change the folder). Under the field it shows "≈ 3.2 GiB, 41 000 files", a warning for a folder
above the policy's soft limit (default 1 GiB or 50 000 entries; creating it asks for your
confirmation) and an error that blocks **Next** for a folder above the hard copy limit (64 GiB or
2 000 000 entries). Both come with buttons to switch to `mount` or `clone` and with the advice to
choose the project folder itself or fill **Exclude** (patterns like `node_modules *.log`; `.gitignore`
is not read). While the sandbox is created the dialog shows the lines of the scan, the copy
(`copying workspace … X of Y`, with a progress bar) and the image build, and **Cancel** stops the
create at the next file and removes what was made.

## Allow permanently

"Allow permanently" in an approval opens the dialog **Allow permanently: change policy**. It shows
the profile that is affected (and the agent contexts that use it), the proposed changes as
checkboxes, and the resulting change to `policy.yaml` as a diff. Only when you confirm with
**Change policy** does the app write, through the same revisioned, validated and audited
`policy:set` as the Policy view (the manager's own validation has the last word, and a changed file
since you opened the dialog is refused). The request itself stays open: changing the policy never
decides it, and deciding never changes the policy.

abox only proposes changes that are narrow and mean what they say, for the findings the policy
engine reported with the request:

| Finding                                   | Proposal                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| base image outside the allowed registries | add `<registry>/<first path component>` (for example `ghcr.io/my-org`) to `images.registries` |
| network destinations beyond the allowlist | add each requested destination to `network.allow`                                             |
| approval mode `strict`                    | `approval: medium`                                                                            |
| commands need approval (`exec.approval`)  | `exec.approval: false`                                                                        |

Everything else is listed with the reason and **not** proposed: isolation `none`, an untrusted
template and a shared or restricted host zone, which no policy setting can waive (they need your
decision every time); mounts, an open network, secrets and private addresses, which only the broad
mode `open` would waive for the whole profile; the base of a Dockerfile, which cannot be checked.
If a profile does not set a list itself (it inherits it from `extends`), the new list is the
inherited one plus the entry, because a list in a child replaces the parent's.

## The Policy view

The view has three modes.

- **Reading.** One card per profile and per agent context, all labels from the language catalog.
  Isolation settings of `none` are shown as a red "No isolation" badge (text and colour), in the
  cards, in the form and in the review.
- **Editing.** Two columns that edit the same text: a **form** (profile selector, approval mode,
  `exec.approval`, limits, the four isolation minimums, network modes, presets, allowed
  destinations and image registries, workspace modes, templates and hosts) and the **YAML** editor.
  A change in the form is written into the text, keeping comments and layout, so the diff contains
  only the lines that changed; a change in the YAML shows in the form. An empty form field means
  "not set in this profile": it inherits from `extends` or uses the default, which the field shows as
  its hint. Mounts, secrets and the workspace roots stay in the YAML. The manager validates the text
  on every change (the same check as `abox policy validate`); if the YAML cannot be read, the form
  says so and is off. Nothing can be reviewed while the text is invalid.
- **Review.** The diff against the policy in force. If the change newly allows isolation `none` for
  a profile, a red warning names it. **Write policy** saves with the hash of the version you
  started from (a concurrent change is refused instead of overwritten). Every save is a numbered,
  audited revision.

The revision history lists the revisions newest first (who and when), shows an old
revision with the difference to the current policy, and **Edit as draft** opens it in the editor.
It never restores anything directly.

## Files tab

The Files tab shows the workspace of a sandbox as a tree (WAI-ARIA tree pattern). Folders are
listed only when you open them, each listing is fetched once (the manager's `listDir`), and a folder
with more than 1000 entries shows the first 1000 and says how many are left out. The tree is one
tab stop: Up and Down move, Right opens a folder or enters it, Left closes it or goes to the parent,
Home and End jump to the first and last entry, Enter opens or closes a folder. A bar above the tree
refreshes the listing and copies the selected entry to the host (or a file or folder from the host
into the sandbox). The names come from the sandbox, so they are shown as neutralised text (see
below).

## Hosts: utilisation, groups, engine

- **Utilisation.** For every host the table shows the number of sandboxes against the limit of
  the host profile, and the CPU and memory reserved by them against the limit, as meters with text
  (the numbers carry the meaning, not the colour). The limits of a host profile are quotas for all
  sandboxes on the host together; a host with a limit that is used up is marked "full". The figures
  count the sandboxes abox knows about on that host (reserved resources, not live usage). An
  unreachable host says that its figures are incomplete.
- **Groups and tags.** A host profile has tags only. A tag of the form `group.<name>` (or
  `gruppe.<name>`; the tag syntax allows letters, digits and `._-`, no colon) puts the host into a
  group: the table has one section per group (hosts without a group first, this computer among
  them), a host with several group tags appears in each, and a filter shows one group. The group
  tags are not repeated as ordinary tags.
- **Engine and runtimes.** A host test shows whether the engine is rootless or **rootful**, and
  which hardened runtimes (for example gVisor's `runsc`) it found. A backend is shown with its
  runtime, for example `docker (runsc)`. The add and edit form has a runtime per container backend
  (docker, podman) and a checkbox **Allow rootful engine**. A rootful engine gives root-equivalent
  rights on the host to everything that breaks out of a container, so the form explains this in a
  warning banner and the host shows a "rootful allowed" badge; leave it off unless you need it.

## Diagnostics

Settings shows the same report as `abox doctor` (see [troubleshooting](troubleshooting.md#abox-doctor)),
run when the page opens and again on "Run diagnostics". Each check has one of four badges, always
with a word and not by colour alone: **OK** (green), **Info** (neutral; "Hinweis" in German),
**Warning** (amber) and **Error** (red). The banner above the report says whether anything failed,
how many warnings there are, or how many notes there are on an otherwise healthy system.

- **Backends** has one row per backend and host with a short one-line summary (version, rootless,
  isolation level). A backend that works is **available**; with real warnings it is
  **available (warning)** in amber. A backend that is not installed or not running and that nothing
  uses (Podman on a Docker machine) is a neutral **not installed (optional)** with a hint how to
  start it, not a red "unavailable"; **unavailable** in red is for a backend that something needs
  (or the only container engine). The advisory notes (rootful daemon, no disk quota, no isolation,
  the VM `open` network mode) are behind a **Notes (n)** disclosure in the row, and for a backend
  that does not work the detail lines are behind **Details (n)**.
- **Checks** lists everything else (state database, policy file, audit chain, leftovers) with its
  badge. Details of a warning or an error are shown directly; for other checks they are behind a
  disclosure. Backends are not repeated here because the table shows them.

The disclosures are native `<details>` elements: focus the summary with Tab and open or close it
with Enter or Space.

## MCP status

Settings shows what is observable about the MCP side: the agent contexts defined in the policy
(profile, number of sandboxes), the HTTP tokens (active and revoked, last use per token) and the time
of the last action of each agent, with a link to its audit entries. The MCP server is a separate
process (stdio per agent, or HTTP with tokens) that does not report to the manager, so the app cannot
tell whether it is running right now; it shows the activity and tokens instead.

## The SSH passphrase dialog

When an SSH session started by the app (the Hosts terminal) needs input, ssh asks the app instead of
the terminal: a dialog shows the question ("SSH login: user@host") and a masked input with a
"Show input" switch. The app starts ssh with `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE=force`; the helper
is a small script that runs the app's own Electron binary as plain Node (`ELECTRON_RUN_AS_NODE`) and
talks to the main process over a private unix socket (directory 0700, socket 0600, a random token per
session, compared in constant time). The question is shown as neutralised text, labelled as coming
from ssh (it can contain text from the server).

- A passphrase, PIN or password goes straight to ssh. It is **not** stored, **not** logged and **not**
  written to the audit log or to any file; the field is cleared when you submit. A prompt that nobody
  answers ends after 120 seconds, and closing the window, reloading or leaving the app cancels it.
- Yes/no questions and touch hints (a security key) have their own forms.
- **Host-key questions are never answered here.** abox's ssh is strict about host keys; a new or
  changed key is confirmed in the Hosts view by its fingerprint. If ssh asks anyway, the dialog says so
  and the session ends.
- Limits: it needs OpenSSH 8.4 or newer (`SSH_ASKPASS_REQUIRE`) and a runtime directory that allows
  running the helper (not mounted `noexec`). If the helper cannot be set up, ssh falls back to asking
  in the terminal; the app logs why.

## Text from agents

Reasons, sandbox and template names, process commands, log lines, audit details and file names are
written by agents or by what runs in a sandbox. They are shown as plain text with control,
direction-changing (right-to-left override and isolates), zero-width and other invisible characters
replaced by visible escapes (`\u202e`, `\x07`), so a text cannot hide or reorder what you read. Long
text is capped: a long reason, a command or an audit detail is shown in a box of limited height that
scrolls and can be focused with the keyboard, and one-line values are shortened with an ellipsis. The
buttons of a dialog stay in reach however long the text is. Error messages and the toast
notifications get the same treatment.

## Project templates and the project folder

A project template is a file `.sandbox/*.yaml` inside a project. The app does not guess which
project you mean (it has no working directory like the CLI): you pick a **project folder**, in
two places:

- in the **Templates** view, above the list: type a path and press Enter (or **Show templates**),
  use **Browse …**, or choose one of the recent folders. The list then shows that folder's project
  templates next to the builtin and user ones, marked "project" and "Trusted" or "Not trusted yet"
  (a project template is trusted only for the exact content you approved). **Clear** removes the
  folder again. Opening a project template shows it read-only, with **Review …**;
- in the first step (**Template**) of **New sandbox**: the same field. Picking a folder lists its
  project templates in the wizard, marked "Project template", with a warning badge while they are
  not trusted. A sandbox created from one uses that folder to find the template (the workspace
  you choose in the next step is independent of it). Creating from an untrusted project template
  goes through the normal confirmation: nothing is created before you confirm, and the
  confirmation shows the template review described above.

The folder is checked by the app's main process before anything is read, the way the CLI checks a
human's `--project`: it must be an absolute path (no `~`, no relative path, no control
characters), is canonicalised (symbolic links resolved) and must be an existing directory. Only
`.sandbox/*.yaml` and `.sandbox/*.yml` of that directory are read, regular files only (a symbolic
link inside `.sandbox` is skipped), and a `.sandbox` that is itself a symbolic link is refused.
Nothing is read until you pick a folder. The recent folders (the last eight) are kept per user in
the app's own settings file (`gui-settings.json` in the app's data directory, `gui/` below
`ABOX_HOME` if that is set), never in a project; a folder that no longer exists is not offered.

## The terminal

The sandbox terminal runs a shell _in_ the sandbox (an `attach` through the manager, audited as
`sandbox.attach`), and the Hosts view can open an SSH session with abox's hardened ssh settings.
What you type there is _your_ access, not an agent's. The session ends when the tab closes. The
terminal is not available for backends that cannot allocate a TTY (the process backend).

### Taking over an agent's sandbox

The GUI concept asks that when a human takes over a terminal of a session an agent is using, the
agent's input is paused and the pause is visible. abox does this for sandboxes an **agent owns**:

- While a terminal of the GUI (or `abox shell`) is open in such a sandbox, a marker is kept in the
  shared state database (the GUI and the agent's MCP server are separate processes, the database
  is what both see). The holder refreshes it every 5 seconds; a marker that has not been refreshed
  for 20 seconds (the GUI crashed or was killed) counts as gone, so a crash cannot block the agent
  for good. Closing the terminal, leaving the tab or closing the window removes it at once.
- Every tool of the agent that runs code in that sandbox or changes it, `sandbox_exec`,
  `sandbox_process_start`, `sandbox_process_stop`, `sandbox_write_file`, `sandbox_snapshot`,
  `sandbox_restore`, `sandbox_start`, `sandbox_stop`, `sandbox_delete` and `access_request`
  (a stop or delete would kill your terminal), answer `conflict`: "paused: a human is working in sandbox ...". They are refused, not queued: a
  queued command would run at an arbitrary moment in the middle of your terminal session.
  Reading (files, listing, logs, inspect) keeps working so the agent can see what you did. Your own
  commands are never blocked.
- You see it: a banner **"A person is working in this sandbox"** on the sandbox detail (with the
  name of the paused agent), a **"Human attached"** badge in the Sandboxes table, and a note on the
  Terminal tab before you open it. With several terminals open the sandbox stays paused until the
  last one ends.
- The audit log has `sandbox.takeover` when the marker is set and `sandbox.takeover.end` (duration,
  exit code) when it is removed, in addition to `sandbox.attach` / `sandbox.attach.end`; a refused
  agent call is audited once per ten seconds as a `deny` with the reason `human_attached`.

Not covered: a command the agent started _before_ you opened the terminal keeps running (stop it
with `abox process stop` or from the shell). Sandboxes you own have no marker: there is nobody to pause.

### Live CPU and memory

For running sandboxes of a backend that reports usage (docker and podman; the engine's `stats`),
the Sandboxes table and the sandbox overview show CPU (100% is one core), memory against the limit
and the number of processes, next to the configured limit. The view asks the manager every 5
seconds, only for sandboxes that are on screen and running, and **not while the window is hidden**
(it refreshes once when you come back). A sample takes about a second on the engine. Backends
without usage figures, stopped sandboxes and unreachable hosts keep showing the configured values.
The numbers are not audited (it is a poll) and not available to agents.

## Security of the app itself

- The window runs with Electron's **sandbox** and **context isolation**, no Node integration,
  `webSecurity` on, dialogs and spell checking off, developer tools only in development builds.
- The renderer is served from an own protocol (`abox-app://`), not from `file://`, under a strict
  Content-Security-Policy: scripts and styles only from the bundled files, no inline code, no
  `eval`, `connect-src 'none'`, no frames, no forms.
- Navigation, new windows and webviews are blocked; every permission request (camera,
  notifications from the page, clipboard) is denied; requests to anything but the app's own
  scheme are cancelled.
- The renderer talks to the main process through a small, typed IPC surface; it has no direct
  access to files, the database or the network. All secrets stay in the keyring; the app shows
  references, never values.
- Agent-written text (reasons, names, logs, file names) is rendered as plain text, never as markup, with
  invisible and direction-changing characters made visible and long text capped (see [Text from
  agents](#text-from-agents)).
- The app polls the shared state every two seconds to notice changes made by the CLI or the MCP
  server; it does not open a network port.

## Not covered

Sound, notifications on desktops without a notification service, and a tray on desktops without
a status-notifier host (several Wayland setups) degrade gracefully, but have not been tested on
all desktops. The GUI has been developed and tested on Linux only.
