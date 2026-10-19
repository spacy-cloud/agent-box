import { ERROR_CODES, errorEnvelopeSchema } from '@abox/core';
import { describe, expect, it } from 'vitest';
import { CLI_EXIT_CODES, CLI_ONLY_ERROR_INFO, CliError, describeError } from '../errors.js';

describe('CLI error envelope', () => {
  const schema = errorEnvelopeSchema(Object.keys(CLI_EXIT_CODES));

  it('documents exactly the codes the CLI adds to the core ones', () => {
    const extra = Object.keys(CLI_EXIT_CODES).filter((c) => !(c in ERROR_CODES));
    expect(Object.keys(CLI_ONLY_ERROR_INFO).sort()).toEqual(extra.sort());
  });

  it('every body describeError builds validates against the schema', () => {
    const errors: unknown[] = [
      new CliError('check_failed', 'problems found', { details: { report: {} } }),
      new CliError('invalid_input', 'bad', {
        hint: 'fix',
        issues: [{ path: 'a', message: 'm' }],
      }),
      new Error('boom'),
      Object.assign(new Error('connect ECONNREFUSED docker'), { code: 'ECONNREFUSED' }),
    ];
    for (const e of errors) {
      const { body, exitCode } = describeError(e);
      expect(schema.safeParse(body).success, JSON.stringify(body)).toBe(true);
      expect(CLI_EXIT_CODES[body.code]).toBe(exitCode);
    }
  });
});
