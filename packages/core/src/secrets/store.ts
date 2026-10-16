import { AboxError } from '../errors.js';

/** Where secret values live. Values never go into templates, state or the audit log. */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set?(ref: string, value: string): Promise<void>;
  delete?(ref: string): Promise<void>;
  list?(): Promise<string[]>;
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/** Secret references are short identifiers like `github-token`. */
export function assertValidSecretRef(ref: string): void {
  if (!REF_RE.test(ref) || ref.includes('..')) {
    throw new AboxError(
      'invalid_input',
      `invalid secret reference ${JSON.stringify(ref.slice(0, 80))}`,
      {
        hint: 'use letters, digits and . _ : @ / - (max 128 characters)',
      },
    );
  }
}

/** In-memory store for tests and development. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
  }

  get(ref: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(ref));
  }

  set(ref: string, value: string): Promise<void> {
    assertValidSecretRef(ref);
    this.values.set(ref, value);
    return Promise.resolve();
  }

  delete(ref: string): Promise<void> {
    this.values.delete(ref);
    return Promise.resolve();
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.values.keys()].sort());
  }
}
