# Internal contract: egress proxy sidecar

Shared contract between `packages/proxy` (implementation) and the container
backends (`packages/backend-docker`, later python/vm). Changing it requires
changing both sides.

## Runtime

- The proxy is a **dependency-free Node.js ESM program**: `packages/proxy/runtime/proxy.mjs`.
  It is shipped as plain JavaScript (no build step) so container backends can copy it
  into an image directly. `@abox/proxy` exports `proxyRuntimeDir` (absolute path of
  `packages/proxy/runtime/`) and `proxyImageDockerfile` (string) plus the config types.
- Image: built by the backend from `proxyImageDockerfile` with `proxy.mjs`, `lib.mjs` and
  `Dockerfile` (all three live in `proxyRuntimeDir`; list: `proxyImageFiles`) in the build
  context. Base `node:24-alpine` plus `openssl` (used only for MITM certificates).
  Tag: `proxyImageTag()` = `abox/proxy:<sha256 of proxy.mjs + lib.mjs + Dockerfile, first 12 hex>`.
- Runs as non-root user, `--cap-drop ALL`, `no-new-privileges`, read-only root fs,
  tmpfs at `/run/abox-proxy`, memory 128 MiB, pids 64.

## Configuration

JSON file at `/etc/abox-proxy/config.json`, placed into the proxy container by the
backend **before start** via file copy (never via env vars or labels, because it can
contain secret header values):

```json
{
  "listen": { "host": "0.0.0.0", "port": 3128 },
  "allow": ["registry.npmjs.org", "*.githubusercontent.com"],
  "blockPrivate": true,
  "privateExceptions": [],
  "injections": [{ "host": "github.com", "header": "Authorization", "value": "Basic …" }]
}
```

Allowlist semantics: exact host match, or `*.example.org` matching any subdomain
(not the apex). Matching is case-insensitive on the IDNA/punycode form; trailing dots
are stripped. Raw IP literals as destination are denied unless covered by an explicit
`allow` entry that is the same IP literal.

`blockPrivate`: the proxy resolves the name itself, checks **every resolved address**
and connects to the checked address (no second resolution → no DNS rebinding).
Blocked: 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16 (incl. 169.254.169.254),
172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, ::, ::1, fc00::/7,
fe80::/10, ff00::/8, IPv4-mapped/compatible IPv6 of the above, 64:ff9b::/96 NAT64 of
the above. `privateExceptions` (CIDR list) re-allows specific ranges.

## Supported traffic

- `CONNECT host:port` (HTTPS tunnelling). Port must be 443 or 80 unless the allow
  entry is `host:port`.
- Plain `http://` absolute-form requests (forwarded).
- Nothing else (no SOCKS, no raw TCP/UDP, no DNS for the sandbox).

## Secret injection (`inject: proxy`)

For hosts listed in `injections`, the proxy terminates TLS (MITM) with a per-sandbox
CA generated at startup, adds/overrides the configured header on every request and
forwards upstream with full certificate verification. All other hosts are tunnelled
without inspection. Header values are never logged.

- On startup the proxy writes the CA certificate (PEM) to `/run/abox-proxy/ca.crt`
  (only when `injections` is non-empty) and then prints `{"event":"ready"}`.
- The backend copies `ca.crt` into the sandbox at `/usr/local/share/abox/ca.crt`,
  builds `/usr/local/share/abox/ca-bundle.crt` (system bundle + abox CA) and sets
  `SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`,
  `NODE_EXTRA_CA_CERTS` accordingly.

## Logging

One JSON object per line on stdout:

```json
{"ts":1760000000000,"event":"request","method":"CONNECT","host":"github.com","port":443,"ip":"140.82.121.4","decision":"allow"}
{"ts":1760000000001,"event":"request","method":"CONNECT","host":"evil.example","port":443,"decision":"deny","reason":"not in allowlist"}
```

Backends parse these into `NetworkEvent` (`SandboxProvider.networkEvents`).

## Wiring (Docker backend)

- Per sandbox an internal network `abox-int-<short>` (`Internal: true`).
- Shared egress network `abox-egress` (bridge, not internal).
- Proxy container `abox-proxy-<short>` on both networks, alias `abox-proxy` on the
  internal one. Sandbox only on the internal network.
- Sandbox env: `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` =
  `http://abox-proxy:3128`; `NO_PROXY`/`no_proxy` = `localhost,127.0.0.1`.

## Changelog

Implementation notes and deviations (`packages/proxy`, first implementation):

- **`lib.mjs` added.** Pure policy code (allowlist, CIDR/blocked addresses, config
  validation) lives in `runtime/lib.mjs`, shared by `proxy.mjs` and `@abox/proxy`
  (`src/index.ts`). The image therefore copies `proxy.mjs` **and** `lib.mjs`
  (`COPY proxy.mjs lib.mjs /opt/abox-proxy/`); the tag hash covers both plus the Dockerfile.
- **Config mounts: `docker cp` into a `--read-only` container is refused by Docker**
  ("container rootfs is marked read-only"). Working recipe (verified in
  `src/docker.test.ts`): `--read-only --tmpfs /run/abox-proxy:uid=10001,mode=0700 -v /etc/abox-proxy`
  (anonymous volume; remove with `docker rm -v`), create, `docker cp config.json
  <c>:/etc/abox-proxy/config.json`, start. The tar entry should be owned by uid 10001 with
  mode 0600 (the file contains secrets); a 0644 file owned by another uid still works but is
  world-readable inside the container. The image pre-creates both directories owned by 10001.
- **Reading `ca.crt`:** `docker cp` cannot read tmpfs mounts. Fetch the CA with exec:
  `docker exec <proxy> cat /run/abox-proxy/ca.crt` (or exec API equivalent).
- `ready` event additionally carries the bound port: `{"event":"ready","port":3128}`.
- **Port semantics:** an `allow` entry without port allows 80 and 443 only; an entry
  `host:port` allows exactly that port (not additionally 80/443).
- **Injection hosts must also be allowlisted.** `injections` does not widen `allow`: a
  CONNECT to an injection host that `allow` does not cover is denied (a `warn` event is
  logged at startup). Injection hosts must be plain DNS names (no wildcard/port/IP). Header
  names that frame/route the message (`Host`, `Content-Length`, `Transfer-Encoding`,
  `Connection`, ...) are rejected; values must be printable ASCII.
- Plain `http://` requests to an injection host are denied (`plain http to injection host`).
- For injection hosts the proxy pins the `Host` header to the CONNECT target and logs one
  extra line per decrypted request (`"mitm":true,"injected":true`, no path/headers).
- The per-instance CA is name-constrained (critical) to the injection hosts. All leaf
  certificates are generated at startup and the CA key is deleted from disk afterwards; only
  `ca.crt` stays in `/run/abox-proxy`.
- Extra blocked ranges beyond the contract list: whole `::/96` (IPv4-compatible),
  `fec0::/10`, `64:ff9b:1::/48`, Teredo `2001::/32`; SIIT `::ffff:0:0:0/96` and 6to4
  `2002::/16` are checked via their embedded IPv4. Unparseable addresses are blocked.
- Extra optional config keys: `stateDir` (default `/run/abox-proxy`), `maxConnections`
  (256), `connectTimeoutMs` (10000), `idleTimeoutMs` (120000), and test-only
  `upstreamCaFile` and `dnsOverrides`. Unknown keys are rejected.
- Invalid config: one JSON line `{"event":"error","message":"invalid config","errors":[...]}`
  on stdout (never containing values) and exit code 2.
- `@abox/proxy` extra exports: `proxyImageFiles`, `ProxyConfigInput`, `normalizeHost`,
  `parseAuthority`, `parseCidr`, `blockedReason`, `compileAllowlist`, ...
