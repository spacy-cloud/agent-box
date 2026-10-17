import type { BackendKind, BackendStatus } from '../types.js';
import type { DoctorCheck, DoctorNote, DoctorSeverity } from './types.js';

/** The coarse `level` older readers of the doctor report understand. */
export function legacyLevel(severity: DoctorSeverity): DoctorCheck['level'] {
  return severity === 'error' ? 'error' : severity === 'warning' ? 'warn' : 'ok';
}

export function summarizeChecks(checks: readonly DoctorCheck[]): Record<DoctorSeverity, number> {
  const summary: Record<DoctorSeverity, number> = { ok: 0, info: 0, warning: 0, error: 0 };
  for (const c of checks) summary[c.severity]++;
  return summary;
}

/**
 * Splits the warnings of a backend that works into advisory notes (`info`: nothing is broken) and
 * real warnings (something is degraded). A backend without any real warning is `ok`.
 */
export function classifyWorkingBackend(status: BackendStatus): {
  severity: 'ok' | 'warning';
  notes: DoctorNote[];
} {
  const advisories = new Set(status.advisories ?? []);
  const notes: DoctorNote[] = status.warnings.map((message) => ({
    severity: advisories.has(message) ? 'info' : 'warning',
    message,
  }));
  // what needs action first, the advisories after it
  notes.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1));
  return { severity: notes.some((n) => n.severity === 'warning') ? 'warning' : 'ok', notes };
}

/** What to do to be able to use an optional backend that is not installed or not running. */
export function startHint(kind: BackendKind): string {
  switch (kind) {
    case 'podman':
      return 'Start it with `systemctl --user start podman.socket` to use it.';
    case 'docker':
      return 'Start it with `systemctl start docker` (or install Docker) to use it.';
    case 'vm':
      return 'Install QEMU and make /dev/kvm accessible for your user (group "kvm") to use it.';
    case 'python':
      return 'It needs a running Docker or Podman engine (container mode) or uv on the host (venv mode).';
    default:
      return 'Check its details with `abox doctor --verbose`.';
  }
}
