# @abox/app - desktop GUI

Electron app for abox: sandboxes, approvals, templates, hosts and SSH, policy, audit, diagnostics.
The GUI is the human: it calls the manager (`@abox/core`) as context `human` and contains no rules of its own.

## Layout

| Path           | What                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main`     | Electron main process: IPC handlers (Zod-validated), terminals (`tty.ts`, `ssh-pty.ts`), hosts (`hosts.ts`), templates (`templates.ts`), tray, CSP |
| `src/preload`  | `window.abox` bridge: `invoke` and `on` for an allow-list of channels                                                                              |
| `src/renderer` | React UI, xterm.js terminals, CodeMirror YAML editor, i18n (de/en)                                                                                 |
| `src/shared`   | IPC schemas and pure logic (form <-> YAML sync, host-key dialog state)                                                                             |
| `e2e`, `test`  | Playwright (Electron) and Vitest                                                                                                                   |

Security model: sandboxed renderer, no Node access, strict CSP (scripts `'self'` only; styles `'self'` plus a per-load
nonce because xterm.js creates `<style>` elements), every IPC call validated, terminal output is data only. Hosts, SSH and
terminal channels exist only in the GUI; they are never reachable from MCP. No passwords, passphrases or keys are
stored: SSH login uses the system `ssh` (agent, key file, FIDO), prompts appear inside the terminal tab.

## Develop

```sh
pnpm install                       # also builds node-pty once (see below)
pnpm -w build                      # workspace packages (tsc -b); the app uses their dist
pnpm --filter @abox/app dev        # electron-vite dev server + Electron
pnpm --filter @abox/app typecheck
pnpm --filter @abox/app test       # Vitest (unit + renderer)
```

Use `ABOX_HOME=/tmp/abox-dev` to keep a development instance away from your real configuration.

## End-to-end tests

```sh
pnpm --filter @abox/app test:e2e                       # no docker needed
ABOX_TEST_DOCKER=1 pnpm --filter @abox/app test:e2e    # + terminal, template build/test, ssh against a throwaway sshd
```

Tests run Electron under `xvfb-run` with a temporary `ABOX_HOME` and a temporary `HOME`; the ssh tests start an sshd
container on a random loopback port with a freshly generated key and never read or write the real `~/.ssh`.

## node-pty (SSH terminals)

SSH tabs run the system `ssh` in a pty through [`node-pty`](https://github.com/microsoft/node-pty).

- node-pty 1.x is an **N-API** addon: a binary compiled against the system Node loads unchanged in Electron, so
  `@electron/rebuild` is not needed.
- It ships prebuilt binaries for macOS and Windows only. On Linux it is compiled once with `node-gyp` (needs `python3`,
  `make` and a C++ compiler; Node headers are downloaded on first use).
- pnpm does not run dependency build scripts, so this package's `postinstall` (`scripts/ensure-native.mjs --soft`) builds it. If
  that fails, install still succeeds and only SSH terminals are unavailable; run
  `pnpm --filter @abox/app run native` after fixing the toolchain.
- The packaged app contains the compiled `pty.node` (unpacked from the asar archive).

## AppImage

```sh
pnpm --filter @abox/app dist       # -> packages/app/release/abox-<version>-x86_64.AppImage and release/linux-unpacked/
pnpm --filter @abox/app smoke      # starts the AppImage under xvfb, checks the window, quits
```

Config: `electron-builder.yml` (app id `cloud.spacy.abox`, product name `abox`, Linux x64, targets AppImage and `dir`).
There is no auto-update and no telemetry. Notes:

- The AppImage needs FUSE 2 to mount itself; without FUSE run it with `--appimage-extract-and-run`.
- Chromium's sandbox needs unprivileged user namespaces. On systems that restrict them (e.g. Ubuntu 24.04 AppArmor) the
  app does not start unless you allow them for abox or pass `--no-sandbox` (not recommended).
- The first build downloads Electron and the AppImage tooling (needs network).
