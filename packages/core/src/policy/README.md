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
policy file, `default` (workspace roots `DEFAULT_WORKSPACE_ROOTS`: `~/projects`, `~/Projekte`, `~/src`, `~/code`,
`~/dev`, `~/work`, `~/git`, `~/repos`; never `~` itself) plus
the agent contexts `default`, `claude-code`, `codex`, `cursor` and `orca` (`BUILTIN_AGENT_CONTEXTS`), all using
profile `default`, so `abox mcp serve --agent claude-code` works without a policy.yaml. A policy.yaml replaces the
built-in policy completely and defines its own contexts. Every other context id is unknown -> `policy_denied`.
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

## Hidden home directories (agents)

For agent contexts every workspace and mount path below a hidden (dot) directory directly under the
home directory (`~/.claude`, `~/.codex`, `~/.cache`, `~/.local`, ...) is denied, whatever the roots say
(`denyHiddenHomeDirs` of `checkHostPath`, set by the engine and the manager for `kind: agent`). Humans are
not subject to it (the forbidden list above still is). A path outside the roots is denied with a hint
naming `workspace.roots` (`mounts.roots` for mounts) and `abox policy edit`.

## Image registries (`images.registries`)

Profile key `images: { registries: [...] }`: registries or registry paths (`docker.io/library`, `ghcr.io`,
`ghcr.io/my-org`, `*`) that free image names (`base.os` of container backends, `docker`/`podman`/`python`)
may come from. Default for profiles that do not set it: `['docker.io/library']`; the built-in `human` profile
has `['*']`. Base images of the built-in templates (`KNOWN_BASE_IMAGES`) are always accepted. Matching
(`imageAllowedByRegistries`) parses the reference (`imageRepository`: tag and digest dropped, Docker Hub short
names expanded, malformed names never match) and compares path components. `base.dockerfile` is an unchecked
image. Result: like a network destination beyond the allowlist, approval `image_registry` (all modes), deny when
the list is empty.

## Create rules (`evaluateCreate`)

Deny rules are evaluated first and all reasons are collected; **deny always wins over approval**.

| Rule                                                                                                                                                                                              | Result                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| template not in `templates` (`*` = any)                                                                                                                                                           | deny, hint lists allowed templates                                                                          |
| host not in context hosts (`*` = any)                                                                                                                                                             | deny                                                                                                        |
| cpus / memory / ttl above profile `limits`; cpus / memory above the host limits **together with what the other sandboxes of the host reserve** (`req.hostUsage`, `hostQuotaViolations`)           | deny with exact numbers; `effective` holds the clamped (strictest) values                                   |
| owner sandbox count >= `limits.sandboxes`; host count >= host `sandboxes`                                                                                                                         | deny                                                                                                        |
| `copy`/`sync` folder above `workspace.max_copy_bytes` (default `1g`) or `max_copy_entries` (default 50000) (`workspace.copy`, from the manager's pre-scan)                                        | agents: deny, hint lists the alternatives the profile offers; humans: approval `workspace_size` (all modes) |
| workspace mode not in `workspace.modes`; `mount` on remote host                                                                                                                                   | deny                                                                                                        |
| workspace path forbidden / hidden home directory (agents) / outside `workspace.roots` / missing host path                                                                                         | deny                                                                                                        |
| base image outside `images.registries` (and not a built-in base); `base.dockerfile` unless `*`                                                                                                    | approval `image_registry` (all modes); deny if `registries` is empty                                        |
| mounts with `mounts: deny`                                                                                                                                                                        | deny                                                                                                        |
| mount forbidden, outside `mounts.roots`, `rw` while only `ro`, bad/duplicate/system target                                                                                                        | deny                                                                                                        |
| network mode not in `network.modes`                                                                                                                                                               | deny                                                                                                        |
| allowlist destination invalid (`*`, `*.com`, URLs, port outside 1..65535)                                                                                                                         | deny                                                                                                        |
| allowlist destination beyond `allow_presets` + `allow`                                                                                                                                            | approval (all modes); deny if the profile has no allowlist at all                                           |
| private-address exception                                                                                                                                                                         | approval (all modes); deny with mode `none` or malformed                                                    |
| secret ref not in `secrets.allowed` (`*` = any); inject kind not in `secrets.inject`                                                                                                              | deny                                                                                                        |
| isolation of provider below template / `isolation.min` / host zone (`shared` hardened, `restricted` vm) / host `min_isolation` / `network_open` (mode open) / `mounts` / `secrets_env` (env/file) | deny, one reason per unmet source                                                                           |
| secret injected as `env` / `file`                                                                                                                                                                 | approval (all modes)                                                                                        |
| provider isolation `none`                                                                                                                                                                         | approval (all modes)                                                                                        |
| untrusted template (`templateTrusted: false`)                                                                                                                                                     | approval `template_trust` (all modes)                                                                       |
| host zone `shared` / `restricted`                                                                                                                                                                 | approval `host_zone` (all modes)                                                                            |
| additional mount within rights                                                                                                                                                                    | approval in `strict`, `medium`; allowed in `open`                                                           |
| network mode `open` within rights                                                                                                                                                                 | approval in `strict`, `medium`; allowed in `open`                                                           |
| network mode `open` for the **human** context on isolation below `hardened`                                                                                                                       | approval (all modes), see "The human context"                                                               |
| approval mode `strict`                                                                                                                                                                            | approval for every creation                                                                                 |

"All modes" = security invariants: needed in `strict`, `medium` and `open`.
`humanConfirmed: true` satisfies the approval items for context kind `human` only
(agents: ignored); it never overrides a deny. Callers should evaluate without it,
show `items`/`risks`, then re-evaluate with it. `requestDigest` is the canonical object
to hash (`hashRequestDigest`) for approval binding; it contains no secret values and
excludes counts and the confirmation flag. For a create it includes the template base
(`template.base`: `os`, `dockerfile`, and the `registry` of an image reference on container backends), so an
approval is bound to the base image. Bind the policy `contentHash` separately if
approvals should expire on policy change.

## Host quotas (`hostQuotaViolations`)

`limits.cpus`, `limits.memory` and `limits.sandboxes` of a host profile are budgets of the host as a whole. The
engine is pure, so the caller passes what is already reserved: `CreateRequest.hostUsage` (cpus, memory bytes of
the other live sandboxes on the host) and `currentHostSandboxCount`; for an `access_request` of kind `resources`
`SandboxRef.hostUsage` (the others, without the sandbox being resized). A request above a limit on its own is
reported as such, one that only exceeds the total says what is left. The manager repeats the check
(`hostQuotaViolations`, the same function) inside the registry transaction that claims the sandbox row, so
parallel creates cannot all pass a check only one of them satisfies; the policy evaluation is advisory. A resize
reserves the larger of old and new limits in a transaction before the backend is asked.

## The human context

The built-in `human` profile has the workspace and mount roots `['*']` (`ANY_ROOT`): **no roots check**, only
the forbidden list above. A project below a symlink that leaves `$HOME` (`~/projects` -> `/mnt/data/projects`)
therefore works for a human. `*` is not valid in `policy.yaml` (roots must be paths); a `human` profile there
that sets `workspace.roots` / `mounts.roots` replaces it, and those roots are then enforced: the manager passes
the path as typed too (`lexicalPath`, normalized, not symlink-resolved, only when it contains no `..`) and the
check accepts a path whose canonical _or_ typed form lies within a canonical root (the forbidden list is always
checked on the canonical path). Agents are compared by the canonical path only; `lexicalPath` is ignored for them.

The built-in `human` profile (the CLI/GUI user) does not enforce the agent isolation minimums of a profile
(`isolation.min`, `network_open`, `mounts`, `secrets_env` are denials for agents). The **host zone minimums**
(`shared` hardened, `restricted` vm) and a host's `min_isolation` are properties of the machine (Hosts und SSH,
Hostzonen) and bind the human as well: a container sandbox on a `shared` host is denied for everybody. It keeps
the invariant approval items, which a human satisfies with `humanConfirmed` (CLI prompt or `--yes`, GUI dialog):
isolation `none`, untrusted template, shared/restricted host zone, secrets as env/file, private-address
exceptions. One more, following the concept "network mode `open` needs at least `hardened`": **network mode
`open` on a provider isolation below `hardened` is an invariant `network_open` item** (reason names the actual
isolation, risk: unrestricted internet access without a hardened sandbox), so it is never silent, also with approval
mode `open`; it applies to `evaluateCreate` and to a network access request that switches a running sandbox to
`open` (`NETWORK_OPEN_MIN_ISOLATION`). With `hardened` or `vm` an `open` network is allowed without a question for
the `open` approval mode. Agent rules are unchanged: `isolation.network_open` of the profile is a hard denial, and
`humanConfirmed` is ignored for agents.

## Workspace in use

A project directory that another live sandbox works on directly (workspace mode `mount`) cannot be a workspace
again (any mode), nor can a directory above or below it. `createSandbox` answers with error `conflict`
("workspace ... is already used by sandbox <id>; remove it or choose another path/mode") before the policy
check, instead of the generic "protected path" denial. Agents get the sandbox id only for their own sandboxes;
for other owners the generic denial stays, so nothing about foreign sandboxes is revealed.

## Network destinations and ports

Patterns are `example.org`, `*.example.org` (subdomains, not the apex) and either with `:port`. Ports follow the
egress proxy (`docs/internal/proxy-contract.md`): a pattern without port allows 80 and 443 only, `host:port`
allows exactly that port. `domainCovered(requested, allowed)`: a request without port means 80 and 443 and is
covered when both ports are (by `host`, or by `host:80` + `host:443`); `host:8443` is covered by `host:8443`, by
`*.parent:8443` or by `*`, not by `host`; `*` covers everything.

## Exec and access requests

- `evaluateExec`: not the owner (agents) -> deny; approval mode `strict` or `exec.approval: true` -> approval; else allow. Commands are not inspected.
- `evaluateAccessRequest` (kinds `network`, `mount`, `resources`, `ttl`): foreign sandbox -> deny. Limits and rights of the profile are hard (deny). Within the profile: allow in `medium`/`open`, approval in `strict`. Beyond the profile: never auto-allowed (destinations -> approval, even in `open`). Exceptions: additional mounts follow the create rule (approval unless `open`); switching to network `open` needs `isolation.network_open` and approval unless `open`; private-address exceptions always need approval.
