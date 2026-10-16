# The desktop app (GUI)

The app is an Electron program in `packages/app`. It is a front end for the same manager that the
CLI and the MCP server use, so it shows the same sandboxes, the same approval queue and the same
audit log, and a click in the app goes through the same policy checks as a CLI call. You never
need the app: everything works without it.

> **Status.** The app is **pre-release and has not been published**. There is no installable
> package to download; you can build an AppImage yourself (`pnpm --filter @abox/app dist`, see
> [packaging](../packaging/README.md#appimage)). This page describes what the source tree
> contains; check it against the version you run. The end-to-end tests
> (`pnpm --filter @abox/app test:e2e`, Playwright on a virtual display) run and pass (21 tests, with
> `ABOX_TEST_DOCKER=1` including the terminal, template build and ssh ones).

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

| View               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandboxes**      | table of all sandboxes (agents' and yours) with state, backend and isolation, owner, resources, workspace and time left; filter by state, template, agent and text; start, stop, extend the lifetime, export a diff, delete (the dialog warns that unexported changes are lost). Orphaned backend objects and stale sandboxes are announced in a banner; nothing is deleted automatically. A wizard (**New sandbox**) walks through template, options (network, resources, workspace) and a summary; risky settings need your explicit confirmation before anything is created. |
| **Sandbox detail** | tabs for the overview (effective options with deviations from the template highlighted), **Files** (browse the workspace, review the changes since start, flagged files that can run code on the host, save the diff or a patch, export to a branch), **Logs** (background processes), **Snapshots**, **Activity** (the audit entries for this sandbox) and an interactive **Terminal**.                                                                                                                                                                                        |
| **Templates**      | list of builtin (read-only), user and project templates with a form editor and a YAML editor, live validation with line numbers, duplicate, export as YAML, and **Build** (with a note that builds have network access).                                                                                                                                                                                                                                                                                                                                                        |
| **Hosts**          | host profiles: add, edit, remove, test, confirm the host key by fingerprint, import from `~/.ssh/config`, saved port forwards, and an SSH terminal. See [hosts and SSH](hosts-ssh.md). There are no fields for passwords or keys.                                                                                                                                                                                                                                                                                                                                               |
| **Approvals**      | the queue of requests from agents, see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Audit**          | the audit log with filters (time, actor, sandbox, action, decision), verification of the hash chain and export as JSON Lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Policy**         | the profiles and agent contexts in force, a text editor for `policy.yaml` with validation, a diff and a confirmation before saving, and the revision history.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Settings**       | language, closing the window to the tray (optional), diagnostics (the `abox doctor` checks), the reconcile report with an explicit "apply repairs" step, the MCP configuration for agents (copyable `claude mcp add` command and JSON for a chosen agent context), MCP HTTP tokens (create, shown once, revoke) and the state of tray and notifications.                                                                                                                                                                                                                        |

## Approvals

Pending requests appear in the **Approvals** view, in a count on the navigation entry, in the tray
icon and as a desktop notification (where the desktop supports a tray and notifications; without
them the count in the window remains). A request shows:

- who asks (the agent context), what kind of request it is (create, run command, extend access,
  trust a template) and when it expires;
- the **exact options compared to the default**, with the differences first;
- abox's own risk notes (isolation `none`, a mount outside the workspace, an open network, extra
  destinations, private addresses, a secret, an untrusted template);
- the agent's reason, labelled as unverified text.

You can **Allow once** or **Deny**. Allowing is bound to exactly this request. "Allow permanently"
does not create a rule: it leads to the policy editor, where you change the profile and review
the diff yourself. Approving a "trust template" request trusts exactly that content hash.

Keyboard: **Esc denies**. **Enter allows once only while the dialog itself has focus**, not while
a button inside it has focus (the button handles its own Enter), so a stray key press cannot
approve. The navigation is a list of buttons, views move focus to the content area on change, and
the app is built for keyboard and screen-reader use (it has an automated accessibility check with
axe in its tests).

## The terminal

The sandbox terminal runs a shell _in_ the sandbox (an `attach` through the manager, audited as
`sandbox.attach`), and the Hosts view can open an SSH session with abox's hardened ssh settings.
What you type there is _your_ access, not an agent's. The session ends when the tab closes. The
terminal is not available for backends that cannot allocate a TTY (the process backend).

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
- Agent-written text (reasons, names, logs) is rendered as plain text, never as markup.
- The app polls the shared state every two seconds to notice changes made by the CLI or the MCP
  server; it does not open a network port.

## Not covered

Sound, notifications on desktops without a notification service, and a tray on desktops without
a status-notifier host (several Wayland setups) degrade gracefully, but have not been tested on
all desktops. The GUI has been developed and tested on Linux only.
