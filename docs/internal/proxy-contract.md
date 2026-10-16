# Internal contract: egress proxy sidecar

Shared contract between `packages/proxy` (implementation) and the container
backends (`packages/backend-docker`, later python/vm). Changing it requires
changing both sides.

## Runtime

- The proxy is a **dependency-free Node.js ESM program**: `packages/proxy/runtime/proxy.mjs`.
  It is shipped as plain JavaScript (no build step) so container backends can copy it
  into an image directly. `@abox/proxy` exports `proxyRuntimeDir` (absolute path of
  `packages/proxy/runtime/`) and `proxyImageDockerfile` (string) plus the config types.
- Image: built by the backend from `proxyImageDockerfile` with `proxy.mjs` in the build
  context. Base `node:24-alpine` plus `openssl` (used only for MITM certificates).
  Tag: `abox/proxy:<sha256 of proxy.mjs + Dockerfile, first 12 hex>`.
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
