import { AboxError, type SnapshotEntry } from '@abox/core';
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

/**
 * Snapshot reference -> its entry in `listAllSnapshots`. Accepts the id printed by
 * `abox snapshot ls` (`abox-snap/…:name`), or `<sandbox>:<snapshot name>` where the sandbox is
 * anything `resolveSandboxId` takes; of several snapshots with that name the newest.
 */
export async function resolveSnapshot(cli: Cli, input: string): Promise<SnapshotEntry> {
  const rt = await cli.rt();
  const all = (await rt.abox.listAllSnapshots(cli.caller())).snapshots;
  const byId = all.filter((s) => s.id === input);
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) {
    throw new AboxError('invalid_input', `the snapshot id "${safe(input)}" is ambiguous`, {
      hint: `Name it as <sandbox>:<name>; it exists for ${byId.map((s) => s.sandboxId).join(', ')}.`,
    });
  }
  const cut = input.lastIndexOf(':');
  if (cut > 0 && cut < input.length - 1) {
    const sandboxId = await resolveSandboxId(cli, input.slice(0, cut));
    const name = input.slice(cut + 1);
    const hits = all.filter((s) => s.sandboxId === sandboxId && s.name === name);
    if (hits.length > 0) return hits.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
  }
  throw new AboxError('not_found', `no snapshot "${safe(input)}"`, {
    hint: 'Use an id from "abox snapshot ls --all", or <sandbox>:<snapshot name>.',
  });
}
