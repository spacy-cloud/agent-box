import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  ANY_ROOT,
  AboxError,
  DEFAULT_POLICY_YAML,
  resolvePaths,
  validatePolicyText,
} from '@abox/core';
import type { Cli } from '../cli.js';
import { formatIssue } from '../cli.js';
import { CliError } from '../errors.js';
import { renderKeyValues, safe } from '../format.js';
import { invalid } from '../parse.js';

/** `below a, b` for a roots list; `*` (the built-in human profile) = anywhere the forbidden-path list allows. */
function rootsText(roots: readonly string[]): string {
  return roots.includes(ANY_ROOT)
    ? 'anywhere (forbidden paths excluded)'
    : `below ${roots.join(', ')}`;
}

export function registerPolicy(program: Command, cli: Cli): void {
  const p = program.command('policy').description('What agents may do (human only)');

  p.command('show')
    .description('Show the active policy: profiles, agent contexts, where it comes from')
    .option('--context <id>', 'show the resolved rights of this agent context')
    .action(async (o: { context?: string }) => {
      const rt = await cli.rt();
      const v = await rt.abox.showPolicy(cli.caller());
      let profileName: string | undefined;
      if (o.context) {
        const ctx = v.contexts?.[o.context];
        if (!ctx) {
          throw new AboxError('not_found', `no agent context "${safe(o.context)}" in the policy`, {
            hint: `Defined contexts: ${Object.keys(v.contexts ?? {}).join(', ') || 'none'}.`,
          });
        }
        profileName = ctx.profile;
      }
      const profiles = profileName
        ? { [profileName]: v.profiles?.[profileName] }
        : (v.profiles ?? {});
      cli.success(
        o.context
          ? {
              ...v,
              context: o.context,
              contextProfile: profileName ? v.profiles?.[profileName] : undefined,
              contextHosts: v.contexts?.[o.context]?.hosts,
            }
          : v,
        () => {
          const lines = [
            renderKeyValues([
              [
                'source',
                v.policy.source === 'file'
                  ? (v.policy.path ?? 'file')
                  : 'built-in default (no policy.yaml)',
              ],
              ['revision', v.policy.revision === null ? undefined : String(v.policy.revision)],
              ['hash', v.policy.contentHash.slice(0, 16)],
            ]),
          ];
          if (v.policy.reloadError) {
            lines.push(
              '',
              cli.style(
                'yellow',
                `warning: policy.yaml is invalid (${v.policy.reloadError.message}); creating sandboxes, granting access, approvals and every agent are refused until the file is fixed (\`abox policy validate\`, \`abox policy edit\`). ${v.policy.reloadError.fallback === 'last_valid' ? 'Shown here is the last valid policy.' : 'No valid policy was ever recorded; shown here is the restrictive built-in one.'}`,
              ),
            );
          }
          if (!o.context) {
            lines.push('', 'Agent contexts:');
            for (const [id, c] of Object.entries(v.contexts ?? {})) {
              lines.push(
                `  ${id}  profile ${c.profile}${c.hosts ? `  hosts ${c.hosts.join(',')}` : ''}`,
              );
            }
          }
          for (const [name, prof] of Object.entries(profiles)) {
            if (!prof) continue;
            lines.push('', `Profile ${name}:`);
            lines.push(
              renderKeyValues(
                [
                  ['approval', prof.approval],
                  ['templates', prof.templates.join(', ')],
                  ['skills', prof.skills.join(', ') || "none beyond the template's"],
                  [
                    'limits',
                    `${prof.limits.sandboxes} sandboxes, ${prof.limits.cpus} cpu, ${prof.limits.memory}, ttl ${prof.limits.ttl}`,
                  ],
                  [
                    'workspace',
                    `${prof.workspace.modes.join('|')} ${rootsText(prof.workspace.roots)}`,
                  ],
                  [
                    'network',
                    `${prof.network.modes.join('|')}; presets ${prof.network.allow_presets.join(',') || '-'}; extra ${prof.network.allow.join(',') || '-'}`,
                  ],
                  ['images', `registries ${prof.images.registries.join(', ') || 'none'}`],
                  [
                    'mounts',
                    prof.mounts
                      ? `${prof.mounts.access.join('|')} ${rootsText(prof.mounts.roots)}`
                      : 'denied',
                  ],
                  [
                    'secrets',
                    `${prof.secrets.allowed.join(', ') || 'none'} (inject ${prof.secrets.inject.join('|')})`,
                  ],
                ],
                '  ',
              ),
            );
          }
          return lines.join('\n');
        },
      );
    });

  p.command('validate')
    .description('Check a policy file without changing anything (default: the active policy.yaml)')
    .argument('[file]', 'policy file')
    .action(async (file?: string) => {
      // No runtime here: validating must not create abox's directories.
      const path = file ? cli.resolvePath(file) : resolvePaths(cli.env).policyFile;
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if (!file && (e as NodeJS.ErrnoException).code === 'ENOENT') {
          const v = validatePolicyText(DEFAULT_POLICY_YAML);
          cli.success(
            { ...v, file: path, exists: false, source: 'default' },
            () =>
              `no policy.yaml at ${path}: the built-in default policy applies (hash ${v.contentHash.slice(0, 16)}); \`abox policy edit\` creates one`,
          );
          return;
        }
        throw new AboxError('not_found', `cannot read ${path}: ${(e as Error).message}`);
      }
      const v = validatePolicyText(text);
      if (!v.ok) {
        throw new CliError('invalid_input', `${path}: ${v.issues.length} problem(s)`, {
          issues: v.issues,
          hint: 'Fix the listed fields; nothing was changed.',
          details: { file: path },
        });
      }
      cli.success(
        { ...v, file: path, exists: true, source: 'file' },
        () => `${path}: valid (hash ${v.contentHash.slice(0, 16)})`,
      );
    });

  p.command('edit')
    .description(
      'Edit policy.yaml in $VISUAL/$EDITOR; validated, shown as a diff and confirmed before it is saved',
    )
    .option(
      '-y, --yes',
      'save without the final question (the edit itself still happens in your editor)',
    )
    .action(async (o: { yes?: boolean }) => {
      const rt = await cli.rt();
      const env = cli.env;
      const editor = env['VISUAL'] || env['EDITOR'];
      if (!editor) {
        throw invalid('no editor configured', 'Set $VISUAL or $EDITOR.');
      }
      if (cli.json) throw invalid('"policy edit" is interactive and does not support --json');
      let current: string;
      try {
        current = await readFile(rt.paths.policyFile, 'utf8');
      } catch {
        current = DEFAULT_POLICY_YAML;
      }
      const dir = await mkdtemp(join(env['XDG_RUNTIME_DIR'] ?? tmpdir(), 'abox-policy-'));
      const file = join(dir, 'policy.yaml');
      try {
        await writeFile(file, current, { mode: 0o600 });
        for (;;) {
          await runEditor(editor, file, cli);
          const edited = await readFile(file, 'utf8');
          if (edited === current) {
            cli.out('no changes\n');
            return;
          }
          const v = rt.abox.validatePolicy(edited);
          if (!v.ok) {
            cli.err(`${cli.style('red', 'The policy is invalid:')}\n`);
            for (const i of v.issues) cli.err(`  ${formatIssue(i, 'policy.yaml')}\n`);
            if (cli.interactive && (await cli.confirm('Edit again?'))) continue;
            throw new CliError('invalid_input', 'the edited policy is invalid; nothing was saved', {
              issues: v.issues,
            });
          }
          const diff = await unifiedDiff(rt.paths.policyFile, current, edited);
          cli.out(`${diff}\n`);
          let go = o.yes === true;
          if (!go) {
            if (!cli.interactive) {
              throw new CliError('approval_required', 'saving the policy needs your confirmation', {
                hint: 'Run in a terminal or pass --yes.',
              });
            }
            go = await cli.confirm('Save this policy?');
          }
          if (!go) {
            cli.out('not saved\n');
            return;
          }
          const r = await rt.abox.setPolicy(cli.caller(), edited);
          cli.out(`policy saved (revision ${r.revision}, hash ${r.contentHash.slice(0, 16)})\n`);
          return;
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
}

function runEditor(editor: string, file: string, cli: Cli): Promise<void> {
  return new Promise((resolve, reject) => {
    // $EDITOR may carry arguments ("code --wait"); split on whitespace, no shell.
    const parts = editor.split(/\s+/).filter(Boolean);
    const child = spawn(parts[0]!, [...parts.slice(1), file], { stdio: 'inherit', env: cli.env });
    child.on('error', (e) =>
      reject(new AboxError('invalid_input', `cannot start the editor "${editor}": ${e.message}`)),
    );
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new AboxError(
              'invalid_input',
              `the editor exited with code ${code}; nothing was saved`,
            ),
          ),
    );
  });
}

export async function unifiedDiff(label: string, before: string, after: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'abox-diff-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    await writeFile(a, before);
    await writeFile(b, after);
    return await new Promise<string>((resolve) => {
      const child = spawn(
        'diff',
        ['-u', '--label', `${label} (current)`, '--label', `${label} (new)`, a, b],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const out: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.on('error', () => resolve('(diff is not installed; showing the new file)\n' + after));
      child.on('close', () => resolve(Buffer.concat(out).toString('utf8').trimEnd()));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
