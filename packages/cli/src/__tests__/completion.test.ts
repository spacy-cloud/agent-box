import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

let t: TestEnv;
const scripts: Record<string, string> = {};

beforeAll(async () => {
  t = makeEnv();
  for (const shell of ['bash', 'zsh', 'fish']) {
    const r = await run(t, ['completion', shell]);
    expect(r.code, r.stderr).toBe(0);
    scripts[shell] = r.stdout;
    writeFileSync(join(t.root, `abox.${shell}`), r.stdout);
  }
});
afterAll(() => t.cleanup());

const have = (bin: string): boolean => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

describe('completion scripts', () => {
  it('mention the commands, subcommands and flags', () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const s = scripts[shell]!;
      for (const word of [
        'template',
        'create',
        'exec',
        'approvals',
        'import-ssh-config',
        '--workspace',
        '--format',
        'completion',
      ]) {
        expect(s, `${shell}: ${word}`).toContain(word);
      }
      expect(s).not.toContain('__ids\n    ');
    }
    expect(scripts['bash']).toContain('complete -F _abox abox');
    expect(scripts['zsh']).toMatch(/^#compdef abox/);
    expect(scripts['fish']).toContain('complete -c abox');
  });

  it('are syntactically valid', () => {
    if (have('bash')) {
      const r = spawnSync('bash', ['-n', join(t.root, 'abox.bash')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
    if (have('zsh')) {
      const r = spawnSync('zsh', ['-n', join(t.root, 'abox.zsh')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
    if (have('fish')) {
      const r = spawnSync('fish', ['--no-execute', join(t.root, 'abox.fish')], {
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
    }
  });

  it.runIf(have('bash'))('complete commands, subcommands, flags and option values in bash', () => {
    const complete = (words: string[]): string[] => {
      const cur = words.length - 1;
      const script = `source '${join(t.root, 'abox.bash')}'
COMP_WORDS=(${words.map((w) => `'${w}'`).join(' ')})
COMP_CWORD=${cur}
_abox
printf '%s\\n' "\${COMPREPLY[@]}"`;
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      return r.stdout.split('\n').filter(Boolean);
    };
    expect(complete(['abox', 'tem'])).toEqual(['template']);
    expect(complete(['abox', 'template', ''])).toEqual(
      expect.arrayContaining(['ls', 'show', 'validate', 'build', 'gc']),
    );
    expect(complete(['abox', 'template', 'b'])).toEqual(['build']);
    expect(complete(['abox', 'create', 'alpine-min', '--wo'])).toEqual(['--workspace']);
    expect(complete(['abox', 'create', 'alpine-min', '--net', ''])).toEqual([
      'none',
      'allowlist',
      'open',
    ]);
    expect(complete(['abox', 'export', 'local/abcd1234', '--format', ''])).toEqual([
      'diff',
      'patch',
      'branch',
      'files',
    ]);
    expect(complete(['abox', 'ls', '--state', 'ru'])).toEqual(['running']);
    expect(complete(['abox', 'host', 'i'])).toEqual(['import-ssh-config']);
    expect(complete(['abox', 'completion', ''])).toEqual(['bash', 'zsh', 'fish']);
    expect(complete(['abox', '--js'])).toEqual(['--json']);
  });

  it.runIf(have('fish'))('complete commands and option values in fish', () => {
    const q = (cmd: string): string[] => {
      const r = spawnSync('fish', ['-c', `source '${join(t.root, 'abox.fish')}'; ${cmd}`], {
        encoding: 'utf8',
      });
      return r.stdout.split('\n').filter(Boolean);
    };
    expect(q('__abox_subs_for template | string split -f1 \\t')).toEqual([
      'ls',
      'suggest',
      'show',
      'review',
      'validate',
      'build',
      'gc',
    ]);
    expect(q("__abox_choices_for create --net | string split ' '")).toEqual([
      'none',
      'allowlist',
      'open',
    ]);
    const sub = spawnSync(
      'fish',
      ['-c', `source '${join(t.root, 'abox.fish')}'; complete -C 'abox tem'`],
      { encoding: 'utf8' },
    );
    expect(sub.stdout).toContain('template');
    const flags = spawnSync(
      'fish',
      ['-c', `source '${join(t.root, 'abox.fish')}'; complete -C 'abox create alpine-min --net '`],
      { encoding: 'utf8' },
    );
    expect(flags.stdout).toMatch(/allowlist/);
  });

  it.runIf(have('zsh'))('loads in zsh and offers commands', () => {
    const script = `autoload -Uz compinit && compinit -u -d '${join(t.root, 'zcompdump')}'
source '${join(t.root, 'abox.zsh')}'
whence -w _abox_subs >/dev/null || exit 3
print -r -- "$(_abox_subs 'template')"
print -r -- "$(_abox_choices 'create' '--net')"`;
    const r = spawnSync('zsh', ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('ls suggest show review validate build gc');
    expect(r.stdout).toContain('none allowlist open');
  });

  it('prints JSON with --json and rejects unknown shells', async () => {
    const j = await run(t, ['completion', 'bash', '--json']);
    expect(j.json.data.shell).toBe('bash');
    expect(j.json.data.script).toContain('_abox');
    const bad = await run(t, ['completion', 'powershell', '--json']);
    expect(bad.code).toBe(2);
  });

  it('the hidden __ids helper lists sandbox ids silently', async () => {
    const empty = await run(t, ['__ids']);
    expect(empty.code).toBe(0);
    expect(empty.stderr).toBe('');
    chmodSync(join(t.root, 'abox.bash'), 0o644);
  });
});
