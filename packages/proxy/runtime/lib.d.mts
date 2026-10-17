// Type declarations for lib.mjs (plain JavaScript, shipped into the proxy image).

export const DEFAULT_PORTS: readonly number[];

export interface ParsedIp {
  family: 4 | 6;
  value: bigint;
}

export interface ParsedCidr {
  family: 4 | 6;
  base: bigint;
  prefix: number;
}

export type HostKind = 'name' | 'ipv4' | 'ipv6';

export type HostResult = { ok: true; host: string; kind: HostKind } | { ok: false; reason: string };

export type AuthorityResult =
  { ok: true; host: string; port: number; kind: HostKind } | { ok: false; reason: string };

export type ProxyRequestUrlResult =
  | { ok: true; host: string; port: number; kind: HostKind; path: string }
  | { ok: false; status: 400; reason: string };

export interface AllowRule {
  host: string;
  kind: HostKind;
  /** `null`: ports 80 and 443; otherwise exactly this port. */
  port: number | null;
  wildcard: boolean;
  entry: string;
}

export type AllowMatch = { allowed: true; host: string } | { allowed: false; reason: string };

export interface ProxyInjection {
  /** Plain DNS name; secrets are injected on every request to this host (TLS only). */
  host: string;
  header: string;
  value: string;
}

/** Config as written by the backend; everything but `allow` falls back to defaults. */
export interface ProxyConfigInput {
  listen?: { host?: string; port?: number };
  allow: string[];
  blockPrivate?: boolean;
  privateExceptions?: string[];
  injections?: ProxyInjection[];
  /** Directory for ca.crt (default `/run/abox-proxy`). */
  stateDir?: string;
  /** Test only: PEM bundle used instead of the system roots to verify upstream TLS. */
  upstreamCaFile?: string;
  /** Test only: static name -> address map consulted instead of DNS. */
  dnsOverrides?: Record<string, string[]>;
  maxConnections?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/** Validated config with defaults applied. */
export interface ProxyConfig extends ProxyConfigInput {
  listen: { host: string; port: number };
  blockPrivate: boolean;
  privateExceptions: string[];
  injections: ProxyInjection[];
}

export type ProxyConfigValidation =
  { ok: true; config: ProxyConfig } | { ok: false; errors: string[] };

export function parseIp(text: string): ParsedIp | undefined;
export function formatIp(ip: ParsedIp): string;
export function parseCidr(text: string): ParsedCidr | undefined;
export function blockedReason(address: string, exceptions?: readonly string[]): string | undefined;
export function isBlockedAddress(address: string, exceptions?: readonly string[]): boolean;
export function normalizeHost(raw: unknown): HostResult;
export function parseAuthority(authority: string, defaultPort?: number): AuthorityResult;
export function parseProxyRequestUrl(target: string): ProxyRequestUrlResult;
export function compileAllowEntry(
  entry: string,
): { ok: true; rule: AllowRule } | { ok: false; reason: string };
export function compileAllowlist(entries: readonly string[]): AllowRule[];
export function matchAllowlist(
  allow: readonly string[] | readonly AllowRule[],
  host: string,
  port: number,
): AllowMatch;
export function validateProxyConfig(input: unknown): ProxyConfigValidation;
