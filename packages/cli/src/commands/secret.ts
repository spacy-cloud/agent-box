import type { Command } from 'commander';
import { assertValidSecretRef } from '@abox/core';
import type { Cli } from '../cli.js';
import { invalid } from '../parse.js';

export function registerSecret(program: Command, cli: Cli): void {
  const s = program
    .command('secret')
    .description('Secrets in your keyring (referenced by name from templates)');

  s.command('set')
    .description('Store a secret; the value is read from stdin or a prompt, never from arguments')
    .argument('<ref>', 'secret reference, e.g. github-token')
    .action(async (ref: string) => {
      assertValidSecretRef(ref);
      const rt = await cli.rt();
      if (!rt.secretStore.set) throw invalid('this secret store is read-only');
      const value = await cli.readSecret(`value for ${ref} (input hidden): `);
      if (value === '') throw invalid('empty secret; nothing stored');
      await rt.secretStore.set(ref, value);
      cli.success({ ref, stored: true }, () => `stored ${ref} in the keyring`);
    });

  s.command('ls')
    .alias('list')
    .description('List secret references (never values)')
    .action(async () => {
      const rt = await cli.rt();
      if (!rt.secretStore.list) throw invalid('this secret store cannot list');
      const refs = await rt.secretStore.list();
      cli.success(
        { refs },
        () => (refs.length ? refs.join('\n') : 'no secrets stored'),
        () => refs.join('\n'),
      );
    });

  s.command('rm')
    .alias('remove')
    .description('Delete a secret from the keyring')
    .argument('<ref>', 'secret reference')
    .action(async (ref: string) => {
      assertValidSecretRef(ref);
      const rt = await cli.rt();
      if (!rt.secretStore.delete) throw invalid('this secret store cannot delete');
      await rt.secretStore.delete(ref);
      cli.success({ ref, removed: true }, () => `removed ${ref}`);
    });
}
