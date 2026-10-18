# @abox/e2e

End-to-end acceptance and security tests for abox. They drive the **real Docker backend** through the **real
manager** (`Abox.open`, no mocks except where a test says so) and are meant to find weaknesses: a failing test here
is a result, not noise. Not published.

```sh
ABOX_TEST_DOCKER=1 npx vitest run packages/e2e          # everything (about 2-3 minutes on a warm engine)
ABOX_TEST_DOCKER=1 npx vitest run packages/e2e/src/security.test.ts
npx tsc -b packages/e2e                                  # build the helpers
npx tsc -p packages/e2e/tsconfig.test.json               # type-check the tests too (tsc -b skips *.test.ts)
```

Without `ABOX_TEST_DOCKER=1` every suite is skipped.

The builds of the built-in stack templates (shell-dev, php-dev, tauri-dev) and their smoke checks are not in
this package: they are in `packages/core/src/template/build.docker.test.ts` and run with `ABOX_TEST_DOCKER=1`
(`npx vitest run packages/core/src/template/build.docker.test.ts --no-file-parallelism`). `flutter-dev` takes
about 5 minutes and 3-4 GB of disk, so it additionally needs `ABOX_TEST_HEAVY_TEMPLATES=1` (see CONTRIBUTING.md).

## What runs where

| File                        | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `contract-docker.test.ts`   | `defineProviderContract` against `createDockerProvider` (`gc: false`)                            |
| `acceptance-phase1.test.ts` | roadmap phase 1 criteria 1-5, 7 through the manager (+ the testable part of 6)                   |
| `security.test.ts`          | "Pruefen der Haertung": files, socket, limits, agent isolation, policy, paths, approvals, hosts  |
| `security-network.test.ts`  | network none / allowlist / direct IP / private addresses / docker host / DNS                     |
| `security-secrets.test.ts`  | `inject: proxy`, git clone over HTTPS (phase 3 criterion 3), token never in sandbox/audit/logs   |
| `harness.ts`                | throw-away world (ABOX_HOME + fake HOME), manager wiring, label cleanup, helpers                 |
| `upstream.ts`               | local HTTPS + git smart-HTTP upstream container, test CA, proxy image with the CA as extra trust |
| `crash-child.ts`, `loader/` | child process that is SIGKILLed in the middle of a real docker create                            |

### Isolation and cleanup

- Every test file creates its own temp root: `ABOX_HOME=<tmp>/abox`, fake `HOME=<tmp>/home` (with a
  `.ssh/id_ed25519` marker, `.aws/credentials`, projects, datasets), its own policy and templates, and a
  `MemorySecretStore`. Nothing touches the real home, the real abox state or the real keyring.
- All engine objects carry `abox.test=e2e` and `abox.e2e=<run id>` (plus `abox.e2e-inst=<manager instance>`). Each
  file removes its containers, networks and images by run id in `afterAll`. **Deviation from the brief:** the value is
  `e2e`, not `1`, because the backend-docker and core suites run `sweepTestObjects()` on `abox.test=1` and deleted our
  images and containers in the middle of a run ("Environment image ... is missing"). A blanket
  `docker ... --filter label=abox.test` still finds them.
- Shared infrastructure is left alone: `abox-egress` / `abox-open` networks and the cached image
  `abox-e2e-upstream:1` (git + node, used by the upstream fixture) are not removed.
- The daemon is shared with other runs. The manager treats every backend sandbox without a registry row as an
  orphan, so every provider gets an instance id (`dockerProvider({instance})` -> `DockerProviderOptions.instanceId`,
  run-unique): `list`/`inspect`/`remove`/`gcImages` only see that instance's objects. Without that,
  `reconcile --apply --removeOrphans` would delete other people's sandboxes (finding F3, fixed by the option).
- External dependencies (the tests skip the affected case when the name does not resolve): `example.com` (allowed
  domain works), `*.nip.io` (public wildcard DNS that lets an allowlisted NAME resolve to a private address).
  Everything else is local. First run builds `node:24-bookworm`-based templates (no apt/apk at build time) and the
  upstream image (needs `apk add git git-daemon`, retried: on containerd-snapshotter engines apk hard-link installs
  fail intermittently with "I/O error").
- Private upstream: the upstream container has a private address, so the tests reach it through an **approved
  `privateExceptions: ['<ip>/32']`** (the manager supports that path). The proxy must trust the test CA to verify the
  upstream; `proxyAssetsWithCa` rebuilds the proxy image from the real runtime files plus
  `NODE_EXTRA_CA_CERTS=/opt/e2e-ca.pem`. No proxy code is changed and certificate verification stays on.

## Timings measured (warm engine, this machine)

| Criterion                              | Measured  | Limit |
| -------------------------------------- | --------- | ----- |
| Template build, cold (alpine + 1 step) | 9.5-13 s  | -     |
| Template rebuild, cached               | 13-16 ms  | < 2 s |
| `createSandbox` warm (copy workspace)  | 0.4-0.6 s | < 5 s |

## Concept bullets -> tests

Status: **pass** = automated and green, **FAIL** = automated and red (product finding, see below),
**n/t** = not testable here (reason given).

### Sicherheit und Policy, "Pruefen der Haertung"

| Concept bullet                                                        | Test (file > group > test)                                                                                                                                                                                                                                                      | Status          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Sandbox kann `~/.ssh` nicht lesen (Mount-Anfrage)                     | security > "the sandbox cannot read ~/.ssh" > mount request for ~/.ssh and the other credential directories (agent + human); workspace request in every mode                                                                                                                    | pass            |
| ... auch nicht ueber Symlink im Workspace (copy und mount)            | security > ... > "symlinks inside the workspace do not expose host files (workspace mode copy / mount)" (absolute, relative, file and dir links, `grep -R /` for the marker)                                                                                                    | pass            |
| ... Symlink, den die Sandbox selbst anlegt, folgt Export nie          | security > ... > "a symlink planted BY the sandbox (mount mode, rw) is never followed by export and is flagged"                                                                                                                                                                 | pass            |
| ... Bind-Mount ist genau der Workspace, `.git` read-only              | security > ... > "the host-side bind mount is exactly the workspace ... .git read-only"                                                                                                                                                                                         | pass            |
| Zugriff auf `docker.sock` scheitert (Datei)                           | security > "the engine socket is not reachable" > no docker.sock inside the sandbox, no engine mount, no host namespaces                                                                                                                                                        | pass            |
| ... Mount/Workspace/Symlink/Socket im Baum                            | security > ... > requests that would bring the engine socket in are denied; sockets are not copied                                                                                                                                                                              | pass            |
| ... kein TCP zum Docker-Host                                          | security-network > allowlist > "the docker host is unreachable ..." and "a service on the docker host is not reachable through the proxy either"                                                                                                                                | pass            |
| Netzwerk `none`: kein DNS, keine Verbindung                           | security-network > "network mode none" > no interface/route/proxy env; no DNS (system, 8.8.8.8, 1.1.1.1, 127.0.0.11); no connection by name/IP/v6/TCP                                                                                                                           | pass            |
| `allowlist`: erlaubte Domain funktioniert                             | security-network > allowlist > "an allowed domain works through the proxy" (needs example.com)                                                                                                                                                                                  | pass            |
| ... andere Ziele abgelehnt                                            | security-network > allowlist > "other domains are denied with 403 and recorded by the proxy" (subdomain, suffix, userinfo trick, port, Host header smuggling)                                                                                                                   | pass            |
| ... und **protokolliert** (Proxy-Log / `networkEvents`)               | same test (events with reason) and "the proxy request log names hosts and decisions but never header values"                                                                                                                                                                    | pass            |
| ... und im **Audit-Log des Managers** protokolliert                   | security-network > allowlist > "denied egress is audited by the manager (queryAudit) ..."                                                                                                                                                                                       | pass (F4 fixed) |
| direkter IP-Zugriff scheitert (ohne Proxy / ueber Proxy als Literal)  | security-network > allowlist > "direct IP access fails without the proxy", "IP literals are denied by the proxy as well"                                                                                                                                                        | pass            |
| private/Metadaten-Adressen ueber Proxy abgelehnt                      | security-network > allowlist > "metadata, RFC1918, loopback and the docker host are refused" (22 spellings incl. decimal/hex/octal/mapped IPv6, localhost) and "allowlisted NAMES that resolve to private addresses are refused"                                                | pass            |
| kein DNS-Kanal nach aussen (allowlist)                                | security-network > allowlist > "DNS is not a channel out"                                                                                                                                                                                                                       | pass            |
| Sandboxes sehen sich nicht im Netz                                    | security-network > allowlist > "another sandbox and its proxy are not reachable from this one"                                                                                                                                                                                  | pass            |
| Fork-Bombe wird durch Limits beendet                                  | security > limits > pids storm (cgroup `pids.max=128`, `docker top`, fork() fails) and real recursive bomb (stop/remove still work, engine responsive)                                                                                                                          | pass            |
| Speicherfresser wird durch Limits beendet                             | security > limits > memory hog OOM-killed in its cgroup, `memory.max` exact, swap 0, sandbox survives; `/tmp` tmpfs ENOSPC                                                                                                                                                      | pass            |
| TTL / Zeitlimit                                                       | security > limits > TTL enforced by sweep; acceptance > 4 > container exits by itself after its TTL                                                                                                                                                                             | pass            |
| Agentenkontext A sieht/beeinflusst B nicht                            | security > "agent context A cannot see or influence ..." (15 operations -> `not_found`, lists, logs, audit, idempotency keys, per-agent quotas, unknown contexts)                                                                                                               | pass            |
| `policy.yaml` per Agentenpfad nicht aenderbar, Versuch protokolliert  | security > "policy.yaml cannot be changed through the agent path" > setPolicy denied + `policy_change_denied`; operator functions human only; config/data dirs not mountable; file mode 0600                                                                                    | pass            |
| Policy per MCP nicht aenderbar (Manager-Teil)                         | same; the MCP transport itself is `packages/mcp` (n/t here)                                                                                                                                                                                                                     | pass / n/t      |
| Pfadkanonisierung `..`, Symlinks                                      | security > "path canonicalisation ..." > agent: ~30 spellings x workspace(copy/mount)/mount source; link/.. physical parent; chains                                                                                                                                             | pass            |
| ... Gross-/Kleinschreibung, Unicode-Tricks                            | security > ... > human: `.SSH`, `.Ssh`, U+FF0E, fullwidth letters, zero-width, bidi, NUL, control characters                                                                                                                                                                    | pass            |
| ... Mount-Ziele                                                       | security > ... > mount targets that would shadow system locations or are not normalised                                                                                                                                                                                         | pass            |
| Geheimnisse `inject: proxy`: Upstream sieht Header                    | security-secrets > "an authenticated request succeeds although the sandbox sent no credentials" (independent evidence: upstream request log)                                                                                                                                    | pass            |
| ... Sandbox sieht Token nicht (`env`, `/proc/*/environ`, Dateisystem) | security-secrets > "env, /proc/*/environ and the whole filesystem contain no trace of the token" (plain + base64 forms)                                                                                                                                                         | pass            |
| ... Token nicht in Audit/Registry/State-DB/Logs/Docker-Metadaten      | security-secrets > "the token is in no abox artefact ..."                                                                                                                                                                                                                       | pass            |
| ... Sandbox kann Header nicht ueberschreiben, nur fuer Injection-Host | security-secrets > header override; "not sent to a host that is not an injection host (and not over plain http)"                                                                                                                                                                | pass            |
| ... Ausgabe-Maskierung (Echo des Headers)                             | security-secrets > "a response that echoes the injected header is masked ..."; `inject: env` masked                                                                                                                                                                             | pass            |
| Privatadress-Ausnahme nur mit Freigabe                                | security-secrets > "a private exception always needs a human ... bound to that exact request"; "without an approved exception the private upstream is unreachable"                                                                                                              | pass            |
| Freigaben: approve / deny / expire (ohne CLI)                         | security > "approvals" (7 tests: reuse, one-time, concurrent, deny sticks, expiry both ways, waiting agent, binding to request and policy hash, strict exec)                                                                                                                    | pass            |
| Projekt-Template-Trust per Inhalts-Hash                               | security > "project template trust by content hash" (6 tests incl. shadowing a builtin name, restore -> trusted again, `--yes` records no trust, evil template denied)                                                                                                          | pass            |
| Remote: Agent liest/aendert Hostprofile nicht                         | security > remote > "agents have no way to read or change host profiles" (the facade has no such operation; `HostRegistry` is CLI/GUI only)                                                                                                                                     | pass            |
| Remote: `sandbox_create` auf nicht erlaubtem Host abgelehnt           | security > remote > "an agent cannot use a host that is not in its context" (denied + audited; malformed ids -> input error)                                                                                                                                                    | pass            |
| Remote: Zone `shared` verlangt Freigabe + Mindest-Isolation           | security > remote > "a shared-zone host demands at least `hardened` ..." and "with `hardened` isolation a shared host still needs an approval (host_zone)" (provider stub claims `hardened`)                                                                                    | pass            |
| Remote: `restricted`/`min_isolation` -> nur `vm`                      | security > remote > "a restricted-zone host only takes `vm` isolation ..."                                                                                                                                                                                                      | pass            |
| Remote: Hostlimits                                                    | security > remote > "host quotas hold"                                                                                                                                                                                                                                          | pass            |
| Remote: geaenderter Host-Key blockiert                                | n/t: needs an ssh host. Covered by `packages/core/src/hosts/hosts.docker.test.ts` ("changed host key", sshd in docker)                                                                                                                                                          | n/t             |
| Remote: `ssh-agent` in der Sandbox nicht erreichbar                   | n/t: same file ("the local ssh-agent is not reachable in the remote session"). Locally: no `SSH_AUTH_SOCK`, no sockets in the sandbox (security > engine socket)                                                                                                                | n/t             |
| Remote: Router/Heimnetz/Metadaten auch ueber DNS-Rebinding            | local part covered (private literals, names resolving to private addresses). True rebinding (answer flips between lookups) needs a controllable DNS server in front of the proxy: n/t; the proxy resolves once and connects to the checked IP (unit-tested in `packages/proxy`) | n/t             |

Additional hardening checks beyond the bullets (all pass): hostile repository config (`core.fsmonitor`, hooks, ssh
command, pager, editor, diff drivers, aliases) and sandbox-planted `.git` content never execute on the host during
create/export (clone, worktree, mount, copy); export flags `.envrc`, CI files, `package.json`, `Makefile`; agents cannot
pick export destinations; container hardening in the running sandbox (caps, NoNewPrivs, seccomp, namespaces, devices,
`unshare`/`chroot`/`/proc/sys` writes fail); state files are 0600/0700.

### Roadmap phase 1

| Criterion                                  | Test                                                                                                                                                       | Status          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1 build + cached rebuild < 2 s             | acceptance > 1 > "builds a fresh template, the second build is a cache hit in < 2 s" (+ audit, cache key)                                                  | pass            |
| 2 create < 5 s; exec, cp, logs, stop, rm   | acceptance > 2 (7 tests)                                                                                                                                   | pass            |
| 3 invalid templates: error with line/field | acceptance > 3: `validateTemplate(<file>)` and `listTemplates().problems` give line+field; **create by name does not**                                     | pass (F2 fixed) |
| 4 restrictive defaults, tested inside      | acceptance > 4 (non-root, no caps, NoNewPrivs, seccomp, network off, TTL, profile caps)                                                                    | pass            |
| 5 reconcile after `kill -9`                | acceptance > 5: child process SIGKILLed before prepare/create/start of a real docker create; doctor reports, reconcile cleans docker + disk; ghost; orphan | pass            |
| 6 `--json`, stable exit codes              | acceptance > 6 checks the error/exit-code contract of the facade; the CLI itself is `packages/cli` (n/t here)                                              | pass / n/t      |
| 7 contract suite green on two backends     | `contract-docker.test.ts` (docker); process backend runs the same suite in its own package. Capabilities honoured: acceptance > 7                          | pass (F1 fixed) |
| 8 Podman                                   | n/t: no Podman socket on this machine                                                                                                                      | n/t             |

### Roadmap phase 3

| Criterion                                           | Test                                                                        | Status                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| all "Pruefen der Haertung" points automated         | see table above                                                             | all pass (F1-F5 fixed), rest n/t                                                                                                         |
| 1 approval without GUI, expiry denies               | security > approvals (manager API; `abox approvals` CLI itself is n/t here) | pass                                                                                                                                     |
| 2 project template only after content-hash approval | security > project template trust                                           | pass                                                                                                                                     |
| 3 git clone over HTTPS with `inject: proxy`, `env   | grep -i token` empty                                                        | security-secrets > git clone (local `git http-backend` behind HTTPS, token only via the proxy); negative control: 401 without the secret | pass |
| 4 policy change via MCP impossible                  | manager: security > policy tests; MCP transport n/t                         | pass / n/t                                                                                                                               |

## Findings - diagnosis and status

All five findings below are **fixed** (full run `ABOX_TEST_DOCKER=1 npx vitest run packages/e2e --no-file-parallelism`:
5 files, 196 passed, 10 skipped, 0 failed). The text is kept as the record of what was wrong.

| Finding | Fixed by                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | Docker backend: past `expiresAt` accepted, `copyIn` of a missing source is `not_found`, spec files below `/tmp` (restored on start, also on Debian-based images) |
| F2      | core: `createSandbox`/`buildTemplate`/`showTemplate` rethrow the `template_invalid` error with line/field                                                        |
| F3      | `instanceId` option of the Docker provider (label `abox.instance`); `@abox/runtime` persists one id per data dir                                                 |
| F4      | core: proxy decisions are collected from `networkEvents` into the audit log (`network.egress`)                                                                   |
| F5      | core: `host:port` allow entries in the policy engine                                                                                                             |

| #   | Test(s)                                                                                     | Behaviour / expectation / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | contract-docker: "expiresAt in the past", "copyIn of a missing host path", "files ... mode" | (a) `DockerProvider.create` throws `invalid_input: expiresAt must be in the future`; the contract says create succeeds and the sandbox reports `expired` (`provider.ts` ~l. 682). (b) `copyIn` of a missing host source rejects with `backend_unavailable` ("Cannot reach the container engine ... ENOENT") instead of `not_found`: a local `ENOENT` goes through `mapEngineError`, which treats ENOENT as a socket problem (`errors.ts` CONNECTION_CODES) - `lstat` the source first or only map ENOENT when `syscall === 'connect'`. (c) Spec files below `/tmp` are rejected as `unsupported` although `secretInjection` advertises `file` (`provider.ts` ~l. 817); a secret with `path: /tmp/x` can therefore never be created - write such files after start, or the contract must use another directory. |
| F2  | acceptance > 3 > "createSandbox of an invalid template reports the line and field"          | `createSandbox`/`buildTemplate`/`showTemplate` of a template file that exists but is invalid answer `not_found: template 'x' not found, available: ...` (`manager/templates.ts` `loadTemplate`, l. ~128). The problems are only visible through `validateTemplate(<path>)` and `listTemplates().problems` (humans). Fix: when the name is not found, look the name up in `catalog.listAll().problems` and rethrow that `template_invalid` error (issues with line/column).                                                                                                                                                                                                                                                                                                                                     |
| F3  | acceptance > "two abox instances on one container engine"                                   | Orphan detection, `reconcile --removeOrphans` and `gcImages(keep)` work on the whole engine, not on the instance's own objects: a second ABOX_HOME (another user in the docker group, CI, a test run) sees every sandbox of the first as an orphan and can delete it; `gcImages` removes images of the other instance's templates. Fix: stamp an instance id (`hash(stateDb path or uid)`) as label `abox.instance` on containers, networks, images and filter `list`/`gcImages` by it.                                                                                                                                                                                                                                                                                                                        |
| F4  | security-network > "denied egress is audited by the manager"                                | The proxy records every decision and `provider.networkEvents()` exposes them, but nothing in `@abox/core` ever calls it: the manager's audit log (`queryAudit`, GUI, `abox audit`) has no entry for a denied (or allowed) egress. The docs promise "denied and logged". Fix: collect `networkEvents(id, sinceTs)` after exec/process operations, in `inspect`, and on stop/remove, and append `network.egress` entries (deny always, allow aggregated per host) with actor = sandbox owner.                                                                                                                                                                                                                                                                                                                    |
| F5  | security-network > "allowlist entries with a port (host:port) are accepted by the policy"   | The template schema (`DOMAIN_PATTERN_RE`) and the proxy contract accept `host:port` allow entries, but the policy engine's `normalizeDomainPattern` rejects them ("not a valid domain pattern"), so any template or override with a port can never be created, not even by a human. Fix: let `normalizeDomainPattern`/`domainCovered` carry an optional `:port` and compare it.                                                                                                                                                                                                                                                                                                                                                                                                                                |

Observations that are **not** failing tests but worth knowing:

- **Docker `updateNetwork` is real now.** `accessRequest(kind: 'network')` queues an approval; after `approve` the new
  allowlist is written into the proxy sidecar and takes effect (test "widening the allowlist of a running sandbox
  needs approval, is then applied to the proxy and takes effect"). The manager semantics (deny sticks, private
  exceptions, audit) are additionally verified against a provider stub ("manager flow for network access requests").
- **Two abox installations on one engine** are separated by `abox.instance`; sandboxes without that label (older
  versions) are never touched and only reported by `status()` (acceptance > "two abox installations ...").
- **Filter drivers of the user's own repository config run for `mount` and `worktree` workspaces** (`filter.<x>.clean|smudge|process`
  referenced by a tracked `.gitattributes`). `prepare.ts` documents this for `worktree` only; `mount` computes the HEAD
  diff the same way. All other repository-controlled knobs (hooks, fsmonitor, sshCommand, pager, editor, diff
  textconv/command, aliases) are neutralised. The sandbox cannot define a driver (`.git` is read-only), so this needs
  a hostile `.git/config` on the user's own disk; low severity, but the doc should say it. Suggested hardening: neutralise
  every `filter.*` found in the repo config with `-c filter.<name>.process= -c ...clean= -c ...smudge=` unless git-lfs is wanted.
- **Disk exhaustion is not contained on this engine** (overlayfs on containerd snapshotter: no `StorageOpt size`).
  `capabilities().limits.disk` says `false` and a template with `resources.disk` is rejected as `unsupported`
  (tested), so this is reported, not silent.
- **Template builds and the first proxy-image build depend on package mirrors** (`apk add openssl`, flaky here).
  The harness retries (`warmProxy`) and avoids installs in test templates.
- Running the e2e files in parallel is supported: upstream aliases and manager instances are unique per run;
  the shared `abox-egress` network is never removed by the tests.
