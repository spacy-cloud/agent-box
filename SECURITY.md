# Security Policy

abox is security-relevant software: it exists to limit what AI agents can do on your machine. We
take reports about weaknesses seriously and try to be honest about what abox can and cannot
protect against. For the technical background see [docs/security.md](docs/security.md).

## Supported versions

abox is in early development and has not had a release yet.

| Version                  | Supported             |
| ------------------------ | --------------------- |
| `main` branch            | Yes (fixes land here) |
| Anything else (forks...) | No                    |

Once releases exist, this table will list the supported release lines.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Use GitHub Private Vulnerability Reporting:

1. Go to <https://github.com/spacy-cloud/agent-box/security/advisories/new>
   (or open the repository, then **Security** > **Report a vulnerability**).
2. Describe the problem, the affected component and version/commit, and steps to reproduce.
   A minimal proof of concept helps. Please do not include real secrets or personal data.

If private reporting is unavailable for some reason, open a public issue that says only that you
need a private channel to report a security problem, without any details, and a maintainer will
set one up.

### What to expect

abox is maintained by volunteers. We work on a best-effort basis:

- Acknowledgement of your report within **7 days**.
- A first assessment (accepted, needs more information, or out of scope) within **14 days**.
- Fixes for confirmed issues are prioritised by severity. We cannot promise a fixed timeline, but
  we will keep you informed of progress.
- Coordinated disclosure: please give us a reasonable time (we suggest up to 90 days) to fix the
  issue before publishing details. We credit reporters in the advisory and changelog unless you
  prefer to stay anonymous.

There is no bug bounty.

## Scope

### In scope (we consider these vulnerabilities)

- **Sandbox escape caused by abox**: a sandbox gets access to host resources because abox
  configured it too permissively or incorrectly (for example a missing hardening option, an
  unintended mount, exposure of the container engine socket).
- **Policy bypass**: an agent or sandbox obtains a right, limit or setting that the active policy
  does not grant, or changes the policy or approval mode.
- **Approval bypass**: an action that needs approval runs without it, an approval applies to a
  request other than the one shown, or an agent approves its own request.
- **Secret leakage**: secrets reach a sandbox, the audit log, logs or any output where the
  documented design says they must not (for example a token with `inject: proxy` becoming visible
  inside the sandbox).
- **Path canonicalization bypass**: a mount or file operation reaches a forbidden or out-of-root
  path through symlinks, `..`, case or Unicode tricks, or races.
- **MCP authentication bypass**: access to the HTTP MCP server without a valid token, from outside
  `127.0.0.1`, or across agent contexts.
- **Egress proxy bypass**: reaching destinations that the allowlist or the private-address
  blocking should deny (for example DNS rebinding to a blocked address).
- **Audit log tampering** that goes undetected despite the hash chain.
- **Template trust bypass**: a changed project template is used without a new approval.

### Out of scope

- Vulnerabilities in the Linux kernel, the container runtime (Docker, Podman, runc, crun, gVisor,
  Kata...), hypervisors or other upstream software. Please report these upstream. If abox can
  reasonably mitigate such an issue, tell us and we will consider that as a hardening request.
- Attacks that need the sandbox to run at a lower isolation level than the one the user chose and
  accepted (for example anything inside a `none` sandbox, which has no isolation by design).
- Attacks that require an already compromised host, a malicious local user with the same
  privileges as the abox user, or physical access.
- Weaknesses that exist only because the user explicitly approved a dangerous request or wrote a
  permissive `policy.yaml`.
- Denial of service through resource use within the configured limits.
- Findings without a demonstrated security impact (best-practice suggestions are welcome as normal
  issues).

## Honest limits

- abox has **not** had an independent security audit.
- Containers share the host kernel. A kernel or runtime vulnerability can defeat container
  isolation regardless of how abox is configured.
- Output masking of secrets is best effort and no guarantee.
- The egress proxy filters by domain for HTTP(S) only and does not inspect TLS content (except for
  hosts that use secret injection).
- Known limitations are tracked in [docs/security.md](docs/security.md#known-limitations-and-not-verified)
  and will be listed per release.
