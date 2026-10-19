import { describe, expect, it } from 'vitest';
import {
  AboxError,
  ERROR_CODES,
  ERROR_CODE_INFO,
  EXIT_CODE_MEANING,
  errorEnvelopeJsonSchema,
  errorEnvelopeSchema,
} from './errors.js';

describe('error catalog sources', () => {
  it('documents every code, and only the codes that exist', () => {
    expect(Object.keys(ERROR_CODE_INFO).sort()).toEqual(Object.keys(ERROR_CODES).sort());
    for (const [code, info] of Object.entries(ERROR_CODE_INFO)) {
      expect(info.meaning.length, code).toBeGreaterThan(10);
      expect(info.hint.length, code).toBeGreaterThan(10);
    }
  });

  it('explains every exit code a code maps to', () => {
    for (const [code, exit] of Object.entries(ERROR_CODES)) {
      expect(EXIT_CODE_MEANING[exit], code).toBeTruthy();
    }
    expect(EXIT_CODE_MEANING[0]).toBeTruthy();
  });
});

describe('error envelope schema', () => {
  it('accepts what AboxError.toJSON() produces', () => {
    const schema = errorEnvelopeSchema();
    for (const code of Object.keys(ERROR_CODES) as Array<keyof typeof ERROR_CODES>) {
      expect(schema.safeParse(new AboxError(code, 'x').toJSON()).success, code).toBe(true);
    }
    const full = new AboxError('template_invalid', 'bad', {
      hint: 'fix it',
      issues: [{ path: 'a.b', line: 3, column: 4, message: 'wrong' }],
      details: { path: '/x.yaml', reasons: ['r'] },
    });
    expect(schema.safeParse(full.toJSON()).success).toBe(true);
  });

  it('rejects a success, an unknown code and a missing message', () => {
    const schema = errorEnvelopeSchema();
    expect(schema.safeParse({ ok: true, code: 'internal', message: 'x' }).success).toBe(false);
    expect(schema.safeParse({ ok: false, code: 'nope', message: 'x' }).success).toBe(false);
    expect(schema.safeParse({ ok: false, code: 'internal' }).success).toBe(false);
  });

  it('renders as a JSON Schema listing the codes, and takes extra codes', () => {
    const js = errorEnvelopeJsonSchema([...Object.keys(ERROR_CODES), 'extra']) as {
      properties: { code: { enum: string[] } };
      required: string[];
    };
    expect(js.properties.code.enum).toContain('extra');
    expect(js.properties.code.enum).toContain('policy_denied');
    expect(js.required).toEqual(['ok', 'code', 'message']);
  });
});
