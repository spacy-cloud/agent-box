/**
 * The "Limits" fields of the host dialog: three text boxes (empty = no limit) turned into the `limits` of a host
 * profile, with the same bounds as `abox host add --max-sandboxes/--cpus/--memory` and the schema of hosts.yaml.
 * Pure, so the dialog and its tests share it.
 */
import { parseSizeBytes } from './host-usage';

export interface LimitFields {
  sandboxes: string;
  cpus: string;
  memory: string;
}

export interface HostLimitsValue {
  sandboxes?: number;
  cpus?: number;
  memory?: string;
}

/** i18n keys of the problems, per field. */
export type LimitErrors = Partial<Record<keyof LimitFields, string>>;

export const MAX_SANDBOXES = 10_000;
export const MAX_CPUS = 1024;

export function limitFieldsOf(limits: HostLimitsValue | undefined): LimitFields {
  return {
    sandboxes: limits?.sandboxes !== undefined ? String(limits.sandboxes) : '',
    cpus: limits?.cpus !== undefined ? String(limits.cpus) : '',
    memory: limits?.memory ?? '',
  };
}

/** A decimal comma is accepted (German keyboards): `2,5` is `2.5`. */
const normal = (v: string): string => v.trim().replace(',', '.');

export function parseLimitFields(f: LimitFields): {
  /** `null` = no limit at all (clears the limits of the profile). */
  limits: HostLimitsValue | null;
  errors: LimitErrors;
} {
  const errors: LimitErrors = {};
  const limits: HostLimitsValue = {};
  const sandboxes = f.sandboxes.trim();
  if (sandboxes !== '') {
    const n = Number(sandboxes);
    if (!/^\d+$/.test(sandboxes) || !Number.isSafeInteger(n) || n > MAX_SANDBOXES) {
      errors.sandboxes = 'hosts.limits.err.sandboxes';
    } else limits.sandboxes = n;
  }
  const cpus = normal(f.cpus);
  if (cpus !== '') {
    const n = Number(cpus);
    if (!/^\d+(\.\d+)?$/.test(cpus) || !(n > 0) || n > MAX_CPUS) {
      errors.cpus = 'hosts.limits.err.cpus';
    } else limits.cpus = n;
  }
  const memory = normal(f.memory);
  if (memory !== '') {
    const bytes = parseSizeBytes(memory);
    if (bytes === undefined || bytes <= 0) errors.memory = 'hosts.limits.err.memory';
    else limits.memory = memory;
  }
  return { limits: Object.keys(limits).length > 0 ? limits : null, errors };
}

export function hasLimitErrors(e: LimitErrors): boolean {
  return Object.keys(e).length > 0;
}
