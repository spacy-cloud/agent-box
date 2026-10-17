import { AboxError } from '@abox/core';
import type { Cli } from './cli.js';
import { safe } from './format.js';

/**
 * Sandbox reference -> id. Accepts `host/8hex`, a bare `8hex` (host from `--host`, default
 * `local`) and a unique sandbox name.
 */
export async function resolveSandboxId(cli: Cli, input: string): Promise<string> {
  if (input.includes('/')) return input;
  if (/^[0-9a-f]{8}$/.test(input)) return `${cli.host}/${input}`;
  const rt = await cli.rt();
  const { sandboxes } = await rt.abox.listSandboxes(cli.caller(), {
    ...(cli.globals.host ? { host: cli.globals.host } : {}),
  });
  const matches = sandboxes.filter((s) => s.name === input);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new AboxError('invalid_input', `the name "${safe(input)}" is ambiguous`, {
      hint: `Use one of the ids: ${matches.map((m) => m.id).join(', ')}.`,
    });
  }
  throw new AboxError('not_found', `no sandbox "${safe(input)}"`, {
    hint: 'Use the id from "abox ls" (host/8hex), a unique name, or the 8 hex characters.',
  });
}
