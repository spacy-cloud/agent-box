# Internal API: the manager facade (`Abox`)

Contract for the CLI, MCP server, GUI and Orca plugin developers. **Every surface calls only this
class.** Policy, approvals, secret masking, agent isolation and auditing are enforced inside it, once,
for all surfaces. A surface only translates its own input/output (argv, MCP JSON, IPC) and decides how to
ask a human; it must not re-implement any rule.

Source: `packages/core/src/manager/` (exported from `@abox/core`: `Abox`, `HUMAN`, all view types).

## Opening

```ts
const abox = await Abox.open({
  env?,                // default process.env; ABOX_HOME=<dir> puts config/data/cache/run below <dir>
  paths?,              // AboxPaths override
  providers,           // Partial<Record<BackendKind, ProviderFactory>> - only these backends exist
  secretStore?,        // default LibsecretStore (secret-tool); touched only when a template uses secrets
  hostResolver?,       // (hostId) => { connection, zone, minIsolation?, limits?, backends[] }
                       //   default: only `local`, zone `workstation`, every registered backend
  now?,                // clock (tests)
  projectDir?,         // searched for .sandbox/*.yaml; default workspace path of creates
  home?,               // home for `~` and the forbidden-path list (default $HOME)
  ttlCheckIntervalSec? // default 5; 0 = sweep on every call
  reconcileOnOpen?,    // default true: TTL sweep + mark ghosts stale (deletes nothing)
  config?, policyText? // tests
});
abox.close();
```

`providers` is the only place a backend is wired in (core never imports a backend package). Open loads
`config.yaml`, `policy.yaml` (built-in default policy without a file), the SQLite state (WAL, shared with
other processes) and runs the light reconcile. `policy.yaml` is re-read when it changes on disk
(checked at most every 500 ms); a broken edit keeps the last good policy and writes `policy.reload_failed`.

## Configuration (`config.yaml`)

`backends.docker.socket`, `backends.podman.socket`, `limits.*`, `logs.retentionDays`, `secrets.<ref>.*` are used.
`defaults.template` (optional) is the template `abox create` and MCP `sandbox_create` use when none is given (surfaces read
`abox.config.defaults.template`; unset = a template is required). `backends.default` was removed (templates name their
backend); it is rejected with an explanation.

## Callers

```ts
interface Caller {
  contextId: string;
  humanConfirmed?: boolean;
}
```

- `contextId` comes from the surface configuration (CLI: `human`; MCP stdio: `--agent <id>`; MCP HTTP:
  `abox.verifyAgentToken(token)`), **never from a tool argument the agent controls**. Unknown ids ->
  `policy_denied`.
- **Built-in agent contexts.** Without a `policy.yaml` the built-in default policy defines the agent contexts
  `default`, `claude-code`, `codex`, `cursor` and `orca`, all mapped to the built-in profile `default`
  (`BUILTIN_AGENT_CONTEXTS`), so `abox mcp serve --agent claude-code` works out of the box. A `policy.yaml` replaces the
  built-in policy as a whole: it must define the contexts it wants (`abox policy edit` starts from the built-in text as a
  starting point). Every other id stays unknown.
- `human` is built in. Agent owners are `agent:<id>`. Audit `actor` = owner (`human` / `agent:<id>` /
  `system` for TTL, gc, reconcile).
- `humanConfirmed: true` (CLI `--yes`, GUI dialog) satisfies approval items **for the human context only**;
  it is ignored for agents and never overrides a deny. Pattern: call without it, show
  `confirmation_required` reasons/risks, call again with it.
- `import { HUMAN } from '@abox/core'` is `{ contextId: 'human' }`.

**Visibility:** agents only see/affect their own sandboxes, processes, logs, approvals and audit entries.
Anything else is `not_found` (never `policy_denied`), identical to a missing id. A human sees all.

## Results and errors

Operations that may need a human return a status union instead of throwing:

| status                                                                      | meaning                                                                                                           | what the surface does                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `created` / `completed` / `applied` / `started`                             | done                                                                                                              | show the result                                                             |
| `pending_approval` `{approvalId, kind, reasons, risks, expiresAt, message}` | queued; waited up to `waitForApprovalMs` (default `config.limits.approvalWaitMs` = 30 s; `0` for access requests) | tell the agent/user; repeat the identical call later, or poll `getApproval` |
| `confirmation_required` `{reasons, risks, items}`                           | **human callers only**; nothing queued                                                                            | ask the user, repeat with `humanConfirmed: true`                            |

Everything else throws `AboxError` (`code`, `message`, `hint`, `issues`, `details`; `exitCode` 0-5 as in
`errors.ts`): `invalid_input` (zod, with field paths), `not_found`, `policy_denied` (`details.reasons[]` +
`hint`), `approval_denied`, `approval_expired` (undecided = denied, exit 3), `untrusted_template`,
`unsupported` (clear message + hint, e.g. no snapshots, backend cannot change the network of a running
sandbox), `conflict`, `backend_error`, `backend_unavailable`, `host_unreachable`, `timeout`.

### Approval flow (same for create, exec, process start, access requests)

1. The policy engine decides: **deny** -> `policy_denied` (deny always wins, all reasons listed);
   **approval** -> queue entry; **allow** -> run.
2. The queue entry is bound to `sha256(canonical request digest + policy content hash)`. Any change of
   template/contents hash, overrides, paths, network, secrets, resources, command, or of `policy.yaml`
   needs a new approval. Approvals are one-time and valid for `config.limits.approvalTtlMs` after the
   decision. The agent's `reason` text is stored as untrusted (`ApprovalView.reason`; `risks` are abox's own).
3. The same pending request is reused (no duplicate entries). Repeating an identical request that was
   **denied** within 10 min -> `approval_denied` at once; one that **expired** undecided within the last
   2 min -> `approval_expired` once. Afterwards a new request is queued.
4. A human calls `approve` / `deny`. Approving a `template_trust` approval also records the template's
   content hash as trusted (exactly that hash; a changed file asks again). Approving an `access` approval
   applies it immediately (`ApprovalDecision.applied`).
5. For create/exec the agent's repeated call consumes the approval atomically (a concurrent second call
   cannot reuse it).

## Operations

All methods are `async` and take `caller` first unless noted. Types: `manager/types.ts`.

### Templates

- `listTemplates(caller, {projectDir?}) -> {templates: TemplateListEntry[], problems}`: description, `useFor`,
  backend, isolation, network mode, source, `trusted` (project templates: exact content hash approved),
  `allowed` (caller's profile), `backendAvailable`, hashes. Broken files only listed for humans.
  Agents may only use a `projectDir` below their workspace roots.
- `showTemplate(caller, name) -> {template (resolved), trusted, allowed, capabilities, effectiveLimits, warnings}`.
  `showTemplate`, `buildTemplate` and `createSandbox` on a template file that exists but is invalid throw
  `template_invalid` (never `not_found`): `issues[]` carry path, line and column, `details.path` the file. A broken
  higher-precedence file (project > user > builtin) is reported instead of silently using a same-named valid one.
- `validateTemplate(caller, nameOrPath) -> {ok, issues[{kind: schema|invalid|unsupported|policy, path, message, line, column}], warnings, policy}`:
  schema, security rules, backend capabilities, and a policy dry run (what a create with the template's
  defaults would get). Positions come from `annotateIssuePositions`.
- `buildTemplate(caller, name, {update?, onProgress?, projectDir?, signal?}) -> {image, cached, durationMs, pinnedBase}`:
  stores the pinned base per template hash in `template_pins` and passes it as `pinnedBase` next time
  (`update` ignores it). Audited as `image.build_start` / `image.build` with `networkAccess: true` (the build runs
  with network, independent of sandbox policy). Untrusted project templates are refused for agents.
- `gcImages(caller)` (human): `provider.gcImages(keep)` where keep = hashes of all catalog templates and of
  existing sandboxes; unused pins are dropped.

### Sandboxes

- `createSandbox(caller, req, opts?) -> CreateResult`
  ```ts
  req = { template, name?, host?='local', workspace?: {mode?, path?, ref?, access?, exclude?},
          overrides?: {cpus?, memory?, ttl?, network?: {mode?, allow?, presets?, privateExceptions?},
                       mounts?: [{source, target, access?}]},
          requestId?, projectDir? }
  opts = { waitForApprovalMs?, signal?, onProgress? }
  ```
  Flow: idempotency (`requestId` per owner; same key + same request -> same sandbox, `idempotent: true`; same
  key + different request -> `conflict`; concurrent calls in any number of processes -> one sandbox) ->
  host (agents: allowed hosts only) -> template (project templates untrusted until approved) -> backend
  capabilities -> canonicalize paths (forbidden: abox config/data/cache/run dirs, every sandbox dir, `~/.ssh`
  ... ) -> `evaluateCreate` -> approval gate -> **registry row `preparing`** (quota re-checked atomically) ->
  image prepare (own audit step `image.build` when not cached) -> workspace -> secrets -> `provider.create`+`start`
  -> registry `running` -> audit. Any failure removes everything created so far and marks the row `failed`
  (the `requestId` is released for a retry). IDs are `<host>/<8 hex>`.
  Workspace (the MCP `sandbox_create` follows the CLI: no `workspace` -> `{mode: 'empty'}`; a mode other than `empty`, or a
  `ref`, without `path` -> `invalid_input`): without `workspace` the template's mode applies, and a mode that needs a directory without `workspace.path`
  falls back to the instance's `projectDir`. A surface that does not want to share a directory must say
  `workspace: {mode: 'empty'}` itself; the CLI does exactly that unless `--workspace <path>` is given (then
  `--mode` defaults to the template's mode), and rejects `--mode <not empty>`/`--ref` without `--workspace`.
  Notes: `overrides.network.allow` is _added_ to the template's list; allow entries may carry a port
  (`example.org:8443`, see "Network destinations" below); secrets with `inject: proxy` need
  network mode `allowlist` and their hosts are added to `NetworkSpec.allow` (and counted by the policy);
  `blockPrivate` is always true; a template label `readonly-rootfs: "true"` becomes the backend label
  `abox.readonly-rootfs` (template labels starting with `abox.` are reserved). Spec labels also carry
  `abox.managed|id|template|owner|created|expires`.
- `listSandboxes(caller, {state?, template?, host?, owner?(human), includeRemoved?}) -> {sandboxes, orphans, unreachableHosts}`:
  backend `list()` decides existence and live state; the registry adds metadata. A registry sandbox the
  backend does not report is `stale` + `missingInBackend`; an unreachable host marks its sandboxes `stale`
  (last known state). With `host` set, the host must exist (`not_found` otherwise); a host that cannot be
  resolved or has no usable backend is returned in `unreachableHosts` with the reason in the optional
  `hostProblems` (host -> message) instead of an empty list. `orphans` (backend sandboxes unknown to the registry) are shown to humans only.
  `failed`/`removed` rows are hidden unless asked for.
- `inspectSandbox(caller, id) -> SandboxView & {processes, pendingApprovals}` (also collects the proxy's egress decisions, see
  "Network egress in the audit log"): state, template, owner, isolation,
  network, mounts, ttl remaining, `effective` (`policy` = what the engine granted, `provider` = what the backend
  reports), workspace info, secret **refs** (never values), stale/host info.
- `startSandbox`, `stopSandbox`, `removeSandbox(caller, id)`: `start` refuses expired sandboxes (`conflict`);
  `remove` = provider remove + `cleanupWorkspace` + sandbox dir + registry soft-remove (idempotent:
  `{removed:false}` the second time).
- `extendTtl(caller, id, ttl, {waitForApprovalMs?}) -> AccessResult`: `ttl` = _additional_ time on top of the current
  expiry (`'1h'` or ms). The profile limit applies to the total lifetime from creation: beyond it
  `policy_denied`. The provider's `extendExpiry` is called first; the registry changes only when it
  succeeds, and a provider without the capability gives `unsupported`.
- `accessRequest(caller, id, {kind, details, reason?}, opts?) -> AccessResult`
  - `network`: `{mode?, domains?, presets?, privateExceptions?}`; applied via `provider.updateNetwork` (keeps
    the proxy injections); only for allowlist sandboxes (mode changes -> `unsupported`).
  - `ttl`: `{ttl}` as above. `mount` and `resources`: evaluated by the policy (deny wins) and then
    `unsupported` (no backend can change them on a running sandbox; the hint says to recreate).
  - Within the profile: applied at once in `medium`/`open`; beyond it: approval (`kind: 'access'`), applied by
    `approve`. Requests that change nothing (destinations already allowed) return `applied` without a queue entry.
  - Do not repeat a pending access request; poll `getApproval` / `inspectSandbox`.
- `applyApprovedAccess(caller, approvalId)` (human): what `approve` calls for `access` approvals.

### Exec, processes, files

- `exec(caller, id, {argv | command, cwd?, env?, timeoutMs?, stdin?, maxOutputBytes?}, {waitForApprovalMs?, signal?}) -> ExecOutcome`
  `completed`: `{exitCode, stdout, stderr, truncated, timedOut, durationMs, logRef}`. Caps from config:
  agents get at most `limits.execMaxOutputBytes` (64 KiB) per stream and `limits.execTimeoutMs`; humans may raise
  them (16 MiB / 1 h). Known secret values (and their base64/URL/JSON forms) are masked as `***` in output,
  logs and audit. The full masked output goes to `<logsDir>/<short>/exec-*.log` (mode 0600, rotated by
  `logs.retentionDays` in `gc`); read it with `readLog(caller, logRef, {tail?, maxBytes?})`. The audit entry has the
  redacted argv, cwd, env _keys_, exit code, duration, `truncated`, `timedOut`, byte counts, `logRef`, never output.
  `strict` mode (or `exec.approval`) -> approval bound to the exact command line, cwd, env, stdin hash.
  `env` keys starting `ABOX_` are rejected.
- Background processes (backend-neutral: an inline POSIX `sh` wrapper with `nohup`/`setsid`, log
  `${TMPDIR:-/tmp}/.abox/proc/<id>.log`, pid and exit files; needs `sh`, `kill`, `tail`):
  `startProcess(caller, id, {argv|command, cwd?, env?}) -> {status:'started', process}`, `listProcesses(caller, id)`,
  `processLogs(caller, processId, {tail?, sinceBytes?, maxBytes?}) -> {content, nextOffset, size, truncated, process}`,
  `stopProcess(caller, processId)` (kills the process group; TERM then KILL). Same policy/approval as `exec`.
  Process ids are `p<8 hex>`; statuses `running|exited|killed|lost` come from the registry, refreshed on use.
- `readFile(caller, id, path, {maxBytes?}) -> {path, size, truncated, encoding: utf8|base64, content}`,
  `writeFile(caller, id, path, content, {mode?, encoding?}) -> {path, size}` (mode `0..0o777`, max 16 MiB),
  `listDir(caller, id, path?) -> DirEntry[]`. Relative paths resolve against the workspace path. Audit: path
  and sizes, never content.
- `snapshot(caller, id, name) -> {snapshotId}`, `restore(caller, id, snapshotIdOrName)`: `unsupported` (with hint)
  unless `capabilities().snapshots`. `restore` accepts the backend's snapshot id or the name given to `snapshot` (the
  newest snapshot of that name; an exact id wins), resolved through the snapshot index; it returns `{restored: <id>}`. Every snapshot is indexed in the state db (`snapshots` table, forgotten when the
  sandbox is removed); `listSnapshots` reads that index.
- `listSnapshots(caller, id) -> Array<{id, name, createdAt}>` (owner/human, oldest first). `id` is what `restore` takes.
- `exportSandbox(caller, id, {format: diff|patch|branch|files, paths?, outDir?, branchName?, force?}) -> ExportResult & {sandboxId, outDir?}`
  via `exportWorkspace` with the stored `WorkspaceRecord`. **Never applies anything.** The audit entry lists
  the `flagged` paths. Agents: no `outDir` (files go to `<dataDir>/exports/<short>/<ts>`), branch names
  must start with `abox/`, no `force`. Humans: `outDir` must pass the forbidden-path check.
  Git never runs in a work tree a sandbox could write (all modes, `mount` included): abox reads the tree itself and git only sees
  object ids in a fresh host-owned scratch repository with all attributes disabled, so a `.gitattributes` written by the sandbox
  cannot activate a filter, textconv or diff driver defined in the (trusted) repository config. The one host-side git call that
  looks at a mounted work tree, the status check when a `mount` workspace is created, runs with every filter/diff/merge driver
  of the repository config switched off (`driverNeutralizingEnv`).

### Interactive and human-only operations (GUI / CLI `shell`, `cp`, `logs`)

These replace the CLI's former direct use of the provider; the surface calls only the manager.

```ts
attach(caller, id, opts: { cols: number; rows: number; argv?: string[] }): Promise<TtySession>
copyIn(caller, id, hostPath: string, sandboxPath: string): Promise<void>
copyOut(caller, id, sandboxPath: string, hostPath: string): Promise<void>
sandboxLogs(caller, id, opts?: { tail?: number; sinceTs?: number }): Promise<string>
listSnapshots(caller, id): Promise<Array<{ id: string; name: string; createdAt: number }>>
listPolicyRevisions(caller): Promise<Array<{ rev: number; ts: number; actor: string; contentHash: string }>>
getPolicyRevision(caller, rev: number): Promise<{ rev; ts; actor; contentHash; content: string }>
```

- `attach` (human only; an agent gets `policy_denied` and an audit entry `sandbox.attach_denied`). Needs a running
  sandbox (`conflict` otherwise) and a backend with `capabilities().tty` (`unsupported` otherwise). `cols`/`rows`: numbers;
  0/unknown -> 80x24, above 1000 -> 1000; `argv` replaces the login shell. Returns the provider's `TtySession`
  (`stream`, `resize`, `wait()` -> exit code, `close()`), wrapped so that the audit gets `sandbox.attach` when it opens
  (backend, size, the program if `argv` was given) and `sandbox.attach.end` exactly once when it ends (`durationMs`,
  `exitCode`, `null` when closed before the backend reported one). **Never any typed or printed content.**
- `copyIn` / `copyOut` (human only; agents use `writeFile`/`readFile`/`exportSandbox`). Host paths are canonicalized
  (`~`, `..`, symlinks; relative paths resolve against the instance's project dir) and checked against the forbidden-path
  list (`~/.ssh`, `~/.gnupg`, `~/.config`, cloud/kube/docker config, keyrings, engine sockets, `/etc`, `/`, the home dir
  itself, ...). `copyIn`: the source must exist and must not be, contain or lie in a protected path;
  `copyOut`: the destination must not be, contain or lie in a protected path, abox's own config/data/cache/runtime/log
  directories or any sandbox's directory. Violations throw `policy_denied` with a `hint` and are audited with decision
  `deny`. There are no allowed roots: a human may copy from and to any other place. Sandbox-relative paths resolve
  against the workspace path; a trailing `/` is kept (the provider's "into the directory" rule). The sandbox must be
  `created|running|stopped` (`copyOut` also `expired`). Audit `sandbox.copy_in` / `sandbox.copy_out` with
  `hostPath` (canonical), `sandboxPath`, `directory`, `files`, `bytes`, `durationMs`; never content. The CLI computes the
  final target (copy into an existing directory) itself and passes the exact path.
- `sandboxLogs` (owner/human): the main process output of the sandbox (`provider.logs`; `unsupported` without it, e.g.
  the process backend), known secret values masked, newest 8 MiB (agents) / 64 MiB (humans). `tail` 1..1,000,000 lines,
  `sinceTs` epoch ms. Audit `sandbox.logs` once per 10 s burst (a polling surface does not flood the log).
- `listPolicyRevisions` / `getPolicyRevision` (human only): the history of `policy.yaml` (`policy_revisions`; newest first;
  `actor` = `human` for `setPolicy`, `external-edit` for a file edit picked up from disk, `system` for the first
  import). `ts` is the record time (ms). Unknown revision -> `not_found`.

### Network egress in the audit log

The egress proxy of an allowlist sandbox records every allow/deny decision; `provider.networkEvents(id, sinceTs)` exposes
them. The manager copies them into the audit log as `network.egress` entries (`decision` `allow` | `deny`, `actor` = the
sandbox owner, `sandboxId`; details `host`, `port`, `method`, optional `ip` and `reason`, `eventTs`; no headers, paths,
bodies or secrets). Collection happens, per sandbox, after `exec`, `startProcess`, `stopProcess` (always) and after
`processLogs`, `readFile`, `writeFile`, `listDir`, `sandboxLogs`, `copyIn`/`copyOut` (throttled to once per 2 s per
process), in `inspectSandbox`, `stopSandbox`, before every removal (`removeSandbox`, `gc`, `reconcile`), when the TTL sweep
expires a sandbox, at the end of an `attach` session, in `queryAudit` with a `sandboxId` filter and (throttled to 5 s) in
`queryAudit` without one. A per-sandbox cursor in the state db (`sandboxes.net_cursor_ts/net_cursor_seen`) makes each event
land exactly once, also when CLI, MCP server and GUI collect concurrently. A burst larger than 500 denies / 200 allows
is written one-by-one up to those caps and summarized as one `network.egress.summary` entry (counts per host/port). A
backend that cannot be reached never fails the triggering operation; the events stay in the proxy log and are picked up next time.

### Network destinations

`*.example.org` means subdomains only, not the apex `example.org` (as in the proxy; template validation uses the same rule).
Allowlist entries (`overrides.network.allow`, template `network.allow`, profile `network.allow`, access requests) are
`example.org`, `*.example.org` or `example.org:8443` with an optional port 1..65535. Same semantics as the proxy
(`docs/internal/proxy-contract.md`): an entry **without** a port allows ports 80 and 443 only, `host:port` allows exactly that
port. For the policy ("is this request within the profile?") a request without a port means "80 and 443" and is
covered when both are (by `host`, or by `host:80` plus `host:443`); `host:8443` needs a profile entry for `host:8443`
(or `*`). `*` covers every port.

### Approvals (queue shared via SQLite)

`listApprovals(caller, {status?, limit?})` (agents: own only), `getApproval(caller, id)`,
`approve(caller, id, note?)`, `deny(caller, id, note?)`, `expireApprovals(caller)` (human). Agents calling
`approve`/`deny` get `policy_denied` and an audit entry `approval.approve_denied` / `approval.deny_denied`.

### Policy

`showPolicy(caller) -> PolicyView` (agents: own resolved profile + hosts + policy hash only; humans also all
profiles/contexts), `validatePolicy(text)` (pure, no caller), `setPolicy(caller, text)` (human: validates,
writes `policy.yaml` atomically with mode 0600, records a `PolicyRevision`, audits `policy.set`; any agent
attempt -> `policy_denied` **and** audit `policy_change_denied`), `listPolicyRevisions(caller)` /
`getPolicyRevision(caller, rev)` (human only, see above). `auditUnknownTool(caller, tool, argNames?)` is for
surfaces: the MCP server calls it when an agent calls a tool that does not exist (`policy_set`, `approve`,
`ssh_exec`, ...). It writes `mcp.unknown_tool` (`decision` `deny`, `details`: `tool` (sanitized, at most 64
characters), `context`, `argNames` (names only, never values), `suppressed` when entries were dropped), rate
limited per agent owner (the same tool once a minute, at most 10 entries a minute); no-op for `human`.

### Audit

`queryAudit(caller, {sandboxId?, actor?, action?, decision?, since?, until?, afterSeq?, limit?, order?})`
(human: all; agent: its own actions plus entries on its own sandboxes; pulls in new proxy egress events first), `verifyAudit(caller)` and
`exportAudit(caller, filter, writable)` (human; JSON Lines, returns the count). Details never contain secrets
(state layer redacts keys like `token|secret|password` and every known secret value). Probing of foreign
sandbox ids is audited as `sandbox.lookup` (deny) _without_ the sandbox id column.

### Tokens (MCP HTTP)

`createAgentToken(caller, contextId, label)` (human; plaintext returned once; never for `human`),
`verifyAgentToken(token) -> contextId | undefined` (**no caller**: this is the authentication step; undefined for
unknown/revoked tokens or contexts no longer in the policy), `revokeAgentToken(caller, id)`, `listAgentTokens(caller)`.

### Operator functions (all human only)

- `doctor(caller) -> DoctorReport`: backend `status()` + capabilities per host, state db integrity/permissions,
  `policy.yaml` present/permissions (warns when group/other-writable), audit chain, and the reconcile report.
  Never deletes anything. `ok` is false only for `error` checks. An unusable backend is an `error` only when it is needed:
  the backend of one of the user's own (non-builtin) templates or of an existing sandbox; otherwise it is a `warn`
  ("optional"), so a missing Podman does not fail `abox doctor` for a Docker user (nor a missing Docker for a Podman
  user). Exception: when no container engine is usable at all, the Docker check is an `error`. The CLI exits 1 for any
  `error` check (code `check_failed`, backend problems included).
- `reconcile(caller, {apply?, removeOrphans?}) -> ReconcileReport`: `orphans` (backend sandbox, no live registry row),
  `ghosts` (registry row, not in backend -> marked `stale`; with `apply` soft-removed), `interrupted` (row stuck in
  `preparing` whose creating process is dead, e.g. `kill -9`; with `apply`: row -> `failed`, backend sandbox, workspace
  and directory removed), `expired`, `unreachable` backends (nothing concluded for them), pending approvals.
  Orphans are only removed with `apply` **and** `removeOrphans`.
- `gc(caller, {dryRun?}) -> GcReport`: expired sandboxes (stop+remove+cleanup), stale `<dataDir>/sandboxes/*`
  directories without a live row, unreferenced images, logs past retention, overdue approvals.
- `sweepTtl(caller)`: the TTL sweep also runs (rate limited) inside every call: overdue sandboxes become
  `expired` and are stopped; removal is left to `gc`.

### Events

`const off = abox.onEvent(listener)`; types: `sandbox.created|state|expired|removed`, `approval.created|decided|expired`,
`policy.changed`. In-process only (a GUI in another process polls `queryAudit({afterSeq})`).

## State and files

- SQLite (`state.db`): sandboxes, approvals, audit (hash chain), template_trust, policy_revisions, processes,
  host_cache, agent_tokens, **template_pins** (migration 2), **snapshots** and the per-sandbox egress cursor
  (`net_cursor_ts`, `net_cursor_seen` on `sandboxes`; migration 3). A sandbox row is claimed (`preparing`) _before_ anything
  is created; `effective.creator` (pid/host) lets other processes recognise a dead creator.
- Registry rows never contain secret values: only refs (`effective.keyringRefs`), injection kinds, hosts.
- `<dataDir>/sandboxes/<short>/` workspace staging per sandbox; `<dataDir>/exports/`; `<logsDir>/<short>/exec-*.log`.
- Secret values live in the keyring; the manager re-reads them to mask output of existing sandboxes.

## Decisions / things to know

- Every public operation takes a caller, including the operator functions the concept sketched without one
  (`doctor`, `reconcile`, `gc`, `verifyAudit`, `exportAudit`, `applyApprovedAccess`); they are human only so a
  surface cannot expose them to agents by accident. `verifyAgentToken` and `validatePolicy` are the exceptions.
- Names that collide with existing core exports: `CreateSandboxRequest`, `ExecCallOptions`, `ExecOutcome`.
- The `process` backend's `nonRootUser: false` is not an error for templates with isolation `none` unless abox
  itself runs as root. Its sandboxes always need an approval (`isolation_none` is an invariant item).
- Human `humanConfirmed` creation from an untrusted project template does **not** record trust; only approving a
  `template_trust` request does.
