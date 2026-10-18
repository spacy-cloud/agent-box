/**
 * Pure helpers of the port forward panel ("Vorschau" / "Preview" in the sandbox detail view): when a forward can
 * be offered at all, and how the two port fields are read. The manager decides again for every call; this only
 * explains the situation before a click instead of after an error.
 */
import { PORT_FORWARD_MAX_PORT, PORT_FORWARD_MIN_HOST_PORT } from './constants';

/** Why no forward can be added to a sandbox (the first reason that applies); null = it can. */
export type PortsBlock = 'remote' | 'no_isolation' | 'no_network' | 'not_running';

export interface PortsFacts {
  state: string;
  host: string;
  backend: string;
  isolation: string;
  network: { mode: string };
}

/**
 * Permanent reasons come first: a stopped sandbox with network mode "none" will not get a forward after it is
 * started, so "start it" would be the wrong advice. Mirrors the checks of the manager (`assertPortApplicable`):
 * remote hosts and the process backend (isolation none) have no forwards, network mode none has no path from
 * this machine to the sandbox, and a forward lives only while the sandbox runs.
 */
export function portsBlocked(s: PortsFacts): PortsBlock | null {
  if (s.host !== 'local') return 'remote';
  if (s.isolation === 'none' || s.backend === 'process') return 'no_isolation';
  if (s.network.mode === 'none') return 'no_network';
  if (s.state !== 'running') return 'not_running';
  return null;
}

/** Reads a port field: a whole number from `min` to `max`, written with digits only. */
function readPort(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** Port inside the sandbox (1..65535); null = not a valid port. */
export function readSandboxPort(text: string): number | null {
  return readPort(text, 1, PORT_FORWARD_MAX_PORT);
}

/** Port on this machine: empty = let abox choose (`undefined`), otherwise 1024..65535; null = invalid. */
export function readHostPort(text: string): number | undefined | null {
  if (text.trim() === '') return undefined;
  return readPort(text, PORT_FORWARD_MIN_HOST_PORT, PORT_FORWARD_MAX_PORT);
}
