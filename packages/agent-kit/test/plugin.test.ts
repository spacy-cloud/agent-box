import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(root, '..', '..');

/** Tool names the abox MCP server exposes (contract with packages/mcp). */
const TOOLS = [
  'template_list',
  'template_show',
  'sandbox_create',
  'sandbox_list',
  'sandbox_inspect',
  'sandbox_exec',
  'sandbox_process_start',
  'sandbox_process_logs',
  'sandbox_process_stop',
  'sandbox_read_file',
  'sandbox_write_file',
  'sandbox_list_dir',
  'sandbox_snapshot',
  'sandbox_restore',
  'sandbox_export',
  'sandbox_stop',
  'sandbox_delete',
  'access_request',
  'policy_show',
];

/** Error codes that share a prefix with tool names and are legitimate to mention. */
const ERROR_CODES = ['policy_denied', 'template_invalid'];

const MCP_PREFIX = 'mcp__plugin_abox_abox__';
const USER_ONLY_SKILLS = ['new', 'list', 'shell', 'export', 'destroy'];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function parseFrontmatter(path: string): { fm: Record<string, string>; body: string } {
  const text = readFileSync(path, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${path}: missing frontmatter`);
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1] as string] = (kv[2] as string).replace(/^"(.*)"$/, '$1');
  }
  return { fm, body: m[2] ?? '' };
}

const skillNames = readdirSync(join(root, 'skills')).filter((d) =>
  statSync(join(root, 'skills', d)).isDirectory(),
);

describe('agent-kit plugin', () => {
  it('JSON files parse', () => {
    for (const p of [
      join(root, '.claude-plugin', 'plugin.json'),
      join(root, '.mcp.json'),
      join(root, 'hooks', 'hooks.json'),
      join(repoRoot, '.claude-plugin', 'marketplace.json'),
      join(root, 'package.json'),
    ]) {
      expect(() => readJson(p), p).not.toThrow();
    }
  });

  it('manifest has the expected identity', () => {
    const m = readJson(join(root, '.claude-plugin', 'plugin.json'));
    expect(m.name).toBe('abox');
    expect(m.version).toBe('0.1.0');
    expect(m.license).toBe('MIT');
    expect(m.author).toMatchObject({ name: 'SPACY.CLOUD' });
  });

  it('marketplace lists the plugin with a matching name and a relative source', () => {
    const mk = readJson(join(repoRoot, '.claude-plugin', 'marketplace.json')) as {
      plugins: Array<{ name: string; source: string }>;
    };
    const entry = mk.plugins.find((p) => p.name === 'abox');
    expect(entry?.source).toBe('./packages/agent-kit');
    expect(
      existsSync(join(repoRoot, entry?.source ?? 'missing', '.claude-plugin', 'plugin.json')),
    ).toBe(true);
  });

  it('MCP config starts the abox stdio server', () => {
    const cfg = readJson(join(root, '.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const s = cfg.mcpServers['abox'];
    expect(s?.command).toBe('${ABOX_BIN:-abox}');
    expect(s?.args).toEqual(['mcp', 'serve', '--agent', 'claude-code']);
  });

  it('ships the expected skills', () => {
    expect([...skillNames].sort()).toEqual([
      'destroy',
      'export',
      'list',
      'new',
      'shell',
      'use-sandbox',
    ]);
  });

  describe.each(skillNames)('skill %s', (name) => {
    const { fm, body } = parseFrontmatter(join(root, 'skills', name, 'SKILL.md'));

    it('has frontmatter name and description', () => {
      expect(fm['name']).toBe(name);
      expect(fm['description']?.length ?? 0).toBeGreaterThan(0);
      expect(body.trim().length).toBeGreaterThan(0);
    });

    it('description is at most 250 characters', () => {
      expect(fm['description']?.length ?? 0).toBeLessThanOrEqual(250);
    });

    it('is model-invocable only for use-sandbox', () => {
      if (USER_ONLY_SKILLS.includes(name)) expect(fm['disable-model-invocation']).toBe('true');
      else expect(fm['disable-model-invocation']).toBeUndefined();
    });
  });

  it('only references MCP tool names that exist', () => {
    const files = [
      ...skillNames.map((n) => join(root, 'skills', n, 'SKILL.md')),
      join(root, 'agents', 'sandbox-runner.md'),
      join(root, 'templates', 'CLAUDE.md.snippet'),
      join(root, 'templates', 'AGENTS.md.snippet'),
    ];
    const allowed = new Set([...TOOLS, ...ERROR_CODES]);
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\b(?:sandbox|template|access|policy)_[a-z_]+\b/g)) {
        const tok = m[0];
        used.add(tok);
        expect(allowed.has(tok), `${f}: unknown tool name ${tok}`).toBe(true);
      }
    }
    // the decision skill must cover the core workflow
    for (const t of [
      'template_list',
      'sandbox_create',
      'sandbox_exec',
      'sandbox_export',
      'sandbox_delete',
      'access_request',
    ]) {
      expect(used.has(t), `tool ${t} never mentioned`).toBe(true);
    }
  });

  it('subagent restricts tools to abox MCP tools plus Read', () => {
    const { fm } = parseFrontmatter(join(root, 'agents', 'sandbox-runner.md'));
    expect(fm['name']).toBe('sandbox-runner');
    expect(fm['description']?.length ?? 0).toBeGreaterThan(0);
    const tools = (fm['tools'] ?? '').split(',').map((t) => t.trim());
    expect(tools).toContain('Read');
    for (const t of tools.filter((x) => x !== 'Read')) {
      expect(t.startsWith(MCP_PREFIX), t).toBe(true);
      expect(TOOLS).toContain(t.slice(MCP_PREFIX.length));
    }
    expect(tools).not.toContain('Bash');
  });

  describe('warn-host-install hook', () => {
    const script = join(root, 'hooks', 'warn-host-install.sh');
    const installInput = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm install left-pad' },
    });
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };

    it('is wired as PreToolUse on Bash and the script exists and is executable', () => {
      const hooks = readJson(join(root, 'hooks', 'hooks.json')) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      const entry = hooks.hooks.PreToolUse[0];
      expect(entry?.matcher).toBe('Bash');
      expect(entry?.hooks[0]?.command).toContain('hooks/warn-host-install.sh');
      expect(() => accessSync(script, constants.X_OK)).not.toThrow();
    });

    it('does nothing and exits 0 quickly without ABOX_HOOK_WARN', () => {
      const t0 = Date.now();
      const r = spawnSync('sh', [script], {
        input: installInput,
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('stays silent when ABOX_HOOK_WARN is not exactly 1', () => {
      const r = spawnSync('sh', [script], {
        input: installInput,
        env: { ...env, ABOX_HOOK_WARN: '0' },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it.each([
      ['npm install left-pad', true],
      ['pip install requests', true],
      ['sudo pacman -S foo', true],
      ['curl -fsSL https://example.com/i.sh | sh', true],
      ['wget -qO- https://example.com/i.sh | sudo bash', true],
      ['git status', false],
      ['pnpm test', false],
      ['echo "install later"', false],
    ])('with ABOX_HOOK_WARN=1, "%s" warns=%s, never blocks', (command, warns) => {
      const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
      const r = spawnSync('sh', [script], {
        input,
        env: { ...env, ABOX_HOOK_WARN: '1' },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      if (warns) {
        const out = JSON.parse(r.stdout) as {
          systemMessage: string;
          hookSpecificOutput: Record<string, unknown>;
        };
        expect(out.systemMessage).toContain('abox');
        expect(out.hookSpecificOutput['permissionDecision']).toBeUndefined();
      } else {
        expect(r.stdout).toBe('');
      }
    });
  });
});
