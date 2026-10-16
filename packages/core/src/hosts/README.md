# hosts: host profiles, ssh, engine-socket tunnels (Phase 4b, model M1)

A host is a place where sandboxes run: `local` or an SSH host. Everything here uses the system
`ssh` / `ssh-keyscan` / `ssh-keygen` binaries with argv arrays (never a shell string), so
`~/.ssh/config`, ProxyJump, ssh-agent and FIDO keys keep working. No `ssh2` library.

**Agents never manage hosts.** `HostRegistry` and everything else in this module is for the CLI
and the GUI. The manager must not expose it through MCP; it only consumes `createHostResolver`.
abox stores no secrets: `identity_file` is a path, auth is ssh-agent / keys / FIDO.

## Files

| File | Purpose |
| --- | --- |
| `model.ts`, `schema.ts` | `HostProfile`, zone defaults, strict Zod schema of `hosts.yaml` (snake_case), value grammars |
| `registry.ts` | `HostRegistry`: list/get/add/update/remove/resolve, atomic 0600 writes, lock, comments kept |
| `ssh-config.ts` | read-only `~/.ssh/config` parser (`Include`, globs, wildcards skipped) and `importSshConfig` |
| `effective.ts` | `ssh -G` wrapper (`getEffectiveSshConfig`) |
| `ssh-args.ts` | `buildSshArgs`, `sshSessionArgs`, `portForwardArgs`, generated hardened config |
| `known-hosts.ts` | `scanHostKey`, `checkHostKey`, `trustHostKey`, `forgetHostKey` |
| `test-host.ts` | `testHost` (one ssh call running a fixed probe) |
| `tunnel.ts` | `openEngineTunnel`, `TunnelManager` |
| `resolver.ts` | `createHostResolver` for the manager |
| `control.ts` | `closeSshConnection` (ControlMaster) |

## Decisions

- **known_hosts**: abox keeps its own file (`<configDir>/known_hosts`, 0600) and uses ONLY that file
  (`GlobalKnownHostsFile=/dev/null`). A key is trusted only after a human confirmed its SHA256
  fingerprint in abox. The user's `~/.ssh/known_hosts` is not read unless the caller sets
  `env.userKnownHostsFile` (opt-in, read-only, never written). Unknown key: `checkHostKey` =
  `unknown`, `testHost` does not log in. Changed key: `changed`, everything is blocked, and
  `trustHostKey` refuses even the correct new fingerprint; the human must run `forgetHostKey` first.
  Entries are written as `host` (port 22) or `[host]:port`. Observed with OpenSSH 10.6: ssh also
  accepts a plain `host` entry for other ports, so the lookup consults both (can only make a host
  `changed`, never wrongly `trusted`).
- **Hardening applies to jump hosts too.** ssh does not pass `-o` options to `-J` hops, but it does
  pass `-F`; so every call uses a generated config (`<runtimeDir>/ssh/abox-<mode>-<hash>.conf`) with
  the hardening in `Host *`, followed by `Match all` + `Include <user ssh config>`. Hardening comes
  first, so it wins ("first value wins"). `identity_file` (`-i`) applies to the destination only.
- **Scanning**: direct hosts via `ssh-keyscan` (falls back to `-4`/`-6`); hosts behind a ProxyJump via
  a throwaway ssh handshake that stops before authentication (`PreferredAuthentications none`, scratch
  known_hosts for the target only; the hops must already be trusted).
- **Import** (`importSshConfig`): read-only. Proposed profiles get zone **`shared`** (needs approval,
  min isolation `hardened`), `backends: []` (SSH-only until the user declares an engine and
  `engine_socket`), tag `imported`, and only the identity file path. The login user of an alias is
  often an administrator: set a dedicated unprivileged `user` before using it for sandboxes.
- **Zones**: `workstation` / `lab` impose no minimum, `shared` -> `hardened` + approval,
  `restricted` -> `vm` + approval. An explicit `min_isolation` can only raise this.
- **Multiplexing**: batch/interactive calls use `ControlMaster=auto`, `ControlPersist=60`, socket
  keyed by host/port/user and by identity/jump chain/user config. A live master skips the host-key
  check of new connections (normal ControlMaster semantics); call `closeSshConnection` for
  security-sensitive re-checks. Tunnels use their own process without multiplexing.
- **Errors**: unreachable / untrusted / changed key -> `AboxError('host_unreachable')` with
  `details.reason` in `host_key_unknown | host_key_changed | fingerprint_mismatch | auth | forward_refused | unreachable | tunnel`.

## Server requirements (M1)

A dedicated unprivileged user with a **rootless** engine (`podman.socket` or rootless docker), key
login, and sshd allowing stream-local forwarding for that user (`AllowTcpForwarding yes|local`,
`AllowStreamLocalForwarding yes|local`; with `AllowTcpForwarding no` the socket forward is refused).
OpenSSH >= 9.8 `PerSourcePenalties` may throttle clients that open many unauthenticated connections;
abox scans only on test/trust and when ssh refused a key, not on every call.
