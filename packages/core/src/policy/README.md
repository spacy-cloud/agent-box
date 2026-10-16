# Policy engine (`@abox/core` / `policy`)

One policy check for CLI, MCP and GUI. Pure decision functions over request
data; the only I/O is the path check (symlinks, socket scan) and `loadPolicy`.

Public API (`index.ts`): `loadPolicy`, `parsePolicy`, `defaultPolicy`, `policyContentHash`,
`resolveContext`, `canonicalizePath`, `isWithin`, `checkHostPath`, `evaluateCreate`,
`evaluateExec`, `evaluateAccessRequest`, `hashRequestDigest`.

## policy.yaml

Strict schema (unknown keys are errors, with field path and line). Profiles
support single-parent `extends` (chains, cycle detection); child fields override,
arrays are replaced, objects are merged one level deep. `min_isolation` is an
accepted alias of `isolation`. A bare `~` must be quoted (`'~'`; unquoted it is YAML null).

Missing fields fall back to the **safe** side: no templates, workspace mode `empty`
only, network `none`, mounts denied, no secrets (inject `proxy`), isolation `container`,
host `local`, approval `medium`, built-in limits (never unlimited).

Built-in profiles: `human` (always present; approval `open`, broad rights; a `human`
profile in the file is merged on top of it unless it uses `extends`) and, without a
policy file, `default` (workspace roots `['~']` - the forbidden list still applies) plus
the agent context `default`. Every other context id is unknown -> `policy_denied`.
Context `human` is built in and cannot be redefined. Agent owners are `agent:<id>`.

## Forbidden host paths (workspace and mounts, for everyone incl. humans)

`/`, `/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/root`, `/run`, `/var/run`,
`/var/lib/docker`, `/var/lib/containers`, the home directory itself, `~/.ssh`, `~/.gnupg`,
`~/.config`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.local/share/keyrings`,
`~/.password-store`, `~/.mozilla`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`,
`~/.pypirc`, `~/.var/app` (+ `~/.pgpass`, `~/.gem/credentials`, `~/.cargo/credentials.toml`,
`~/.local/share/kwalletd`, `~/.thunderbird`, shell histories), engine sockets by name,
any real socket file inside a mounted tree, plus `extraForbidden` (abox dirs, other sandboxes).

A path is rejected when it **is, lies below, or contains** a forbidden path (mounting `~`,
`/home`, `/var` fails). The home directory and `/` are forbidden as a whole, their
descendants are not. Comparison is case-insensitive and NFKC-folded; real paths of
symlinked forbidden entries (dotfile managers, symlinked home) are included. Forbidden
wins over roots. Canonicalization rejects NUL/control/zero-width/bidi characters, resolves
symlinks component-wise (`link/..` follows the physical parent), and cannot be escaped by `..`.
TOCTOU (path replaced after the check) is out of scope; providers must not follow
symlinks in the final mount component.

## Create rules (`evaluateCreate`)

Deny rules are evaluated first and all reasons are collected; **deny always wins over approval**.

| Rule                                                                                                                                                                                              | Result                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| template not in `templates` (`*` = any)                                                                                                                                                           | deny, hint lists allowed templates                                        |
| host not in context hosts (`*` = any)                                                                                                                                                             | deny                                                                      |
| cpus / memory / ttl above profile `limits` or host limits                                                                                                                                         | deny with exact numbers; `effective` holds the clamped (strictest) values |
| owner sandbox count >= `limits.sandboxes`; host count >= host `sandboxes`                                                                                                                         | deny                                                                      |
| workspace mode not in `workspace.modes`; `mount` on remote host                                                                                                                                   | deny                                                                      |
| workspace path forbidden / outside `workspace.roots` / missing host path                                                                                                                          | deny                                                                      |
| mounts with `mounts: deny`                                                                                                                                                                        | deny                                                                      |
| mount forbidden, outside `mounts.roots`, `rw` while only `ro`, bad/duplicate/system target                                                                                                        | deny                                                                      |
| network mode not in `network.modes`                                                                                                                                                               | deny                                                                      |
| allowlist destination invalid (`*`, `*.com`, URLs)                                                                                                                                                | deny                                                                      |
| allowlist destination beyond `allow_presets` + `allow`                                                                                                                                            | approval (all modes); deny if the profile has no allowlist at all         |
| private-address exception                                                                                                                                                                         | approval (all modes); deny with mode `none` or malformed                  |
| secret ref not in `secrets.allowed` (`*` = any); inject kind not in `secrets.inject`                                                                                                              | deny                                                                      |
| isolation of provider below template / `isolation.min` / host zone (`shared` hardened, `restricted` vm) / host `min_isolation` / `network_open` (mode open) / `mounts` / `secrets_env` (env/file) | deny, one reason per unmet source                                         |
| secret injected as `env` / `file`                                                                                                                                                                 | approval (all modes)                                                      |
| provider isolation `none`                                                                                                                                                                         | approval (all modes)                                                      |
| untrusted template (`templateTrusted: false`)                                                                                                                                                     | approval `template_trust` (all modes)                                     |
| host zone `shared` / `restricted`                                                                                                                                                                 | approval `host_zone` (all modes)                                          |
| additional mount within rights                                                                                                                                                                    | approval in `strict`, `medium`; allowed in `open`                         |
| network mode `open` within rights                                                                                                                                                                 | approval in `strict`, `medium`; allowed in `open`                         |
| approval mode `strict`                                                                                                                                                                            | approval for every creation                                               |

"All modes" = security invariants: needed in `strict`, `medium` and `open`.
`humanConfirmed: true` satisfies the approval items for context kind `human` only
(agents: ignored); it never overrides a deny. Callers should evaluate without it,
show `items`/`risks`, then re-evaluate with it. `requestDigest` is the canonical object
to hash (`hashRequestDigest`) for approval binding; it contains no secret values and
excludes counts and the confirmation flag. Bind the policy `contentHash` separately if
approvals should expire on policy change.

## Exec and access requests

- `evaluateExec`: not the owner (agents) -> deny; approval mode `strict` or `exec.approval: true` -> approval; else allow. Commands are not inspected.
- `evaluateAccessRequest` (kinds `network`, `mount`, `resources`, `ttl`): foreign sandbox -> deny. Limits and rights of the profile are hard (deny). Within the profile: allow in `medium`/`open`, approval in `strict`. Beyond the profile: never auto-allowed (destinations -> approval, even in `open`). Exceptions: additional mounts follow the create rule (approval unless `open`); switching to network `open` needs `isolation.network_open` and approval unless `open`; private-address exceptions always need approval.
