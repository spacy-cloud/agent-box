import type { Server } from 'node:net';

export const MAX_HEAD_BYTES: number;
export const HEAD_TIMEOUT_MS: number;
export const FIRST_BYTES_TIMEOUT_MS: number;
export const MAX_CONNECTIONS: number;
export function looksLikeHttp(buf: Buffer): boolean;
export function isLoopbackName(hostname: string): boolean;
export function hostnameOf(authority: string): string;
export function checkRequestHead(head: string): { ok: true } | { ok: false; reason: string };
export interface ForwarderStats {
  connections: number;
  rejected: number;
  failed: number;
  active: number;
  target: 'up' | 'down' | 'unknown';
}
export function startForwarder(
  env?: Record<string, string | undefined>,
  opts?: { log?: (o: Record<string, unknown>) => void; onExpired?: () => void },
): {
  server: Server;
  stats: ForwarderStats;
  close: () => void;
  ready: Promise<void>;
};
