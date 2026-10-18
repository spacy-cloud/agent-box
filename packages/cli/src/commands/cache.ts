import type { Command } from 'commander';
import type { CacheSelector, CacheView } from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { formatBytes, formatRelative, oneLine, renderTable, safe } from '../format.js';

/** `…/long/path/to/project`: the end of a path is the part that tells projects apart. */
function tail(text: string, max: number): string {
  const t = oneLine(text);
  return t.length <= max ? t : `…${t.slice(t.length - max + 1)}`;
}

const sizeText = (c: CacheView): string => (c.sizeBytes === null ? '?' : formatBytes(c.sizeBytes));

export function registerCache(program: Command, cli: Cli): void {
  const cache = program
    .command('cache')
    .description('Package caches kept per project (pnpm store, Cargo registry, uv cache, ...)')
    .addHelpText(
      'after',
      `
A cache is a volume that outlives the sandboxes: a second sandbox of the same project (and the
same template and owner) starts with the downloads of the first one. It is mounted only at the
paths the template declares ("caches:"). Create a sandbox with --no-cache for a clean install;
"abox gc" removes caches unused for caches.max_age (config.yaml, default 30d) and those above the
cap of the profile (cache_max_bytes, default 10g per project). Only a human can list or remove them.`,
    );

  cache
    .command('ls')
    .alias('list')
    .description(
      'List the caches with project, template, size, last use and whether a sandbox uses them',
    )
    .option('--no-size', 'do not measure the sizes (faster on big caches)')
    .action(async (o: { size: boolean }) => {
      const rt = await cli.rt();
      const r = await rt.abox.listCaches(cli.caller(), {
        ...(cli.globals.host ? { host: cli.globals.host } : {}),
        size: o.size,
      });
      const now = Date.now();
      const remote = r.caches.some((c) => c.host !== 'local');
      const owners = r.caches.some((c) => c.owner !== 'human');
      cli.success(
        r,
        () => {
          const lines: string[] = [];
          if (r.caches.length === 0) lines.push('no package caches');
          else {
            lines.push(
              renderTable(
                [
                  { header: 'KEY' },
                  ...(remote ? [{ header: 'HOST' }] : []),
                  { header: 'PROJECT', max: 44 },
                  { header: 'TEMPLATE' },
                  { header: 'NAME' },
                  ...(owners ? [{ header: 'OWNER' }] : []),
                  { header: 'SIZE', right: true },
                  { header: 'LAST USED' },
                  { header: 'IN USE' },
                ],
                r.caches.map((c) => [
                  c.key,
                  ...(remote ? [c.host] : []),
                  tail(c.project, 44),
                  c.stack,
                  c.name,
                  ...(owners ? [c.owner] : []),
                  o.size ? sizeText(c) : '-',
                  formatRelative(c.lastUsedAt, now),
                  c.inUse ? 'yes' : 'no',
                ]),
                cli.width,
              ),
            );
            if (o.size)
              lines.push('', `${r.caches.length} cache(s), ${formatBytes(r.totalBytes)} in total`);
          }
          for (const u of r.unreachable)
            lines.push(`host ${safe(u.host)} could not be asked: ${oneLine(u.error)}`);
          return lines.join('\n');
        },
        () => r.caches.map((c) => c.key).join('\n'),
      );
    });

  cache
    .command('rm')
    .alias('remove')
    .description(
      'Remove caches by key, by project, or all of them (caches a sandbox uses are kept)',
    )
    .argument(
      '[key...]',
      'cache keys from "abox cache ls" (a unique prefix of at least 4 characters is enough)',
    )
    .option('--all', 'remove every cache')
    .addHelpText(
      'after',
      `
By project: the global option --project <dir> selects every cache of that project directory
("abox cache rm --project ~/projects/app"; without it the current directory is NOT assumed).`,
    )
    .action(async (keys: string[], o: { all?: boolean }) => {
      // `--project` is the global option of the program: it is set only when it was given.
      const project = cli.globals.project;
      const modes = [keys.length > 0, project !== undefined, o.all === true].filter(Boolean).length;
      if (modes !== 1) {
        throw new CliError(
          'invalid_input',
          'name what to remove: one or more keys, --project <path>, or --all',
          {
            hint: '"abox cache ls" lists the caches and their keys.',
          },
        );
      }
      const rt = await cli.rt();
      const selector: CacheSelector = {
        ...(keys.length > 0 ? { keys } : {}),
        ...(project !== undefined ? { project: cli.resolvePath(project) } : {}),
        ...(o.all ? { all: true } : {}),
        ...(cli.globals.host ? { host: cli.globals.host } : {}),
      };
      const r = await rt.abox.removeCaches(cli.caller(), selector);
      for (const e of r.errors) cli.warn(safe(e));
      cli.success(
        r,
        () => {
          const lines = [`removed ${r.removed.length} cache(s)`];
          for (const c of r.removed)
            lines.push(`  ${c.key}  ${safe(c.stack)}/${safe(c.name)}  ${safe(c.project)}`);
          for (const s of r.skipped)
            lines.push(`  kept ${s.cache.key} (${safe(s.cache.name)}): ${s.reason}`);
          for (const e of r.errors) lines.push(`  error: ${safe(e)}`);
          return lines.join('\n');
        },
        () => r.removed.map((c) => c.key).join('\n'),
      );
      if (r.errors.length > 0)
        throw new CliError('backend_error', `${r.errors.length} cache(s) could not be removed`);
    });
}
