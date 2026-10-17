import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { Option } from 'commander';
import { ANY_ROOT, canonicalizePath, checkHostPath, type PolicyView } from '@abox/core';
import type { Cli } from '../cli.js';
import { safe } from '../format.js';

export const AGENTS = ['claude-code', 'codex', 'cursor', 'orca'] as const;
export type AgentName = (typeof AGENTS)[number];

export function projectTemplateName(dir: string): string {
  const base = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'project'}-dev`;
}

export function exampleTemplate(name: string): string {
  return `# Project template for abox sandboxes. Commit it with the project.
# abox does not trust it until a human approves this exact content ("abox create ${name}"
# asks; agents need an approval). Every change to the file asks again.
apiVersion: 1
name: ${name}
description: >-
  Sandbox for this project: Ubuntu 24.04 with git and build tools, no network.
  Edit packages, tools and network to fit the project.
backend: docker
isolation: container

base:
  os: ubuntu:24.04

packages:
  apt: [git, build-essential]

# tools:               # tool presets, e.g. node@24, pnpm@10, python@3.13
#   - node@24

workspace:
  mode: copy           # the project is copied in; get results out with "abox export"
  path: /workspace
  access: rw

resources:
  cpus: 2
  memory: 2g
  pids: 256
  ttl: 2h

network:
  mode: none           # allowlist + presets (npm, pypi, github) when the build needs the network

labels:
  use-for: Work on this project in isolation
`;
}

/** MCP configuration for each supported agent. */
export function mcpSnippet(agent: AgentName): {
  description: string;
  command?: string;
  /** Config file snippet for agents whose configuration is TOML (printed instead of the JSON). */
  toml?: string;
  json: unknown;
} {
  const server = { command: 'abox', args: ['mcp', 'serve', '--agent', agent] };
  switch (agent) {
    case 'claude-code':
      return {
        description:
          'Claude Code: run the command below, or put the JSON into .mcp.json in the project.',
        command: `claude mcp add abox -- abox mcp serve --agent ${agent}`,
        json: { mcpServers: { abox: server } },
      };
    case 'codex':
      return {
        description: 'Codex: run the command below, or put the TOML into ~/.codex/config.toml.',
        command: `codex mcp add abox -- abox mcp serve --agent ${agent}`,
        toml: `[mcp_servers.abox]\ncommand = "abox"\nargs = ["mcp", "serve", "--agent", "${agent}"]`,
        json: { mcpServers: { abox: server } },
      };
    case 'cursor':
      return {
        description: 'Cursor: put this into .cursor/mcp.json (project) or ~/.cursor/mcp.json.',
        json: { mcpServers: { abox: server } },
      };
    case 'orca':
      return {
        description:
          'Orca: use the HTTP server instead of stdio. Start "abox mcp serve --http 127.0.0.1:8765", create a token with "abox token create orca --label orca", then configure:',
        json: {
          mcpServers: {
            abox: {
              url: 'http://127.0.0.1:8765/mcp',
              headers: { Authorization: 'Bearer <token from abox token create orca>' },
            },
          },
        },
      };
  }
}

async function readRuleSnippet(): Promise<string | undefined> {
  const candidates = [
    // monorepo: packages/cli/{src,dist}/commands -> packages/agent-kit/templates
    new URL('../../../agent-kit/templates/AGENTS.md.snippet', import.meta.url),
    new URL('../../../../agent-kit/templates/AGENTS.md.snippet', import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const p = fileURLToPath(url);
      if (existsSync(p)) return await readFile(p, 'utf8');
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

export interface ProjectRootsCheck {
  /** Workspace roots of the agent's profile, as written in policy.yaml. */
  roots: string[];
  /** May the agent use this project directory as a workspace? */
  allowed: boolean;
  reason?: string;
}

/** Whether the profile of `agent` lets the agent use `projectDir` (same rules as a create request). */
export function checkAgentProject(
  pol: Pick<PolicyView, 'contexts' | 'profiles'>,
  agent: string,
  projectDir: string,
  home: string,
): ProjectRootsCheck | undefined {
  const profile = pol.profiles?.[pol.contexts?.[agent]?.profile ?? ''];
  if (!profile) return undefined;
  const roots = profile.workspace.roots;
  try {
    const canon = (p: string): string => canonicalizePath(p, { home, cwd: home });
    const res = checkHostPath(canon(projectDir), {
      home,
      roots: roots.map((r) => (r === ANY_ROOT ? r : canon(r))),
      kind: 'workspace',
      scanSockets: false,
      denyHiddenHomeDirs: true,
    });
    return { roots, allowed: res.ok, ...(res.ok ? {} : { reason: res.reason }) };
  } catch {
    return undefined;
  }
}

export function registerInit(program: Command, cli: Cli): void {
  program
    .command('init')
    .description(
      'Set up .sandbox/ with an example project template and show how to connect an agent',
    )
    .addOption(
      new Option('--agent <name>', 'print the MCP configuration for this agent').choices([
        ...AGENTS,
      ]),
    )
    .option('--force', 'overwrite an existing example template')
    .action(async (o: { agent?: AgentName; force?: boolean }) => {
      const dir = cli.projectDir();
      const name = projectTemplateName(dir);
      const sandboxDir = join(dir, '.sandbox');
      const file = join(sandboxDir, `${name}.yaml`);
      let created = false;
      if (existsSync(file) && !o.force) {
        cli.info(`${file} exists; not overwritten (use --force)`);
      } else {
        await mkdir(sandboxDir, { recursive: true });
        await writeFile(file, exampleTemplate(name), { mode: 0o644 });
        created = true;
      }
      const lines: string[] = [];
      lines.push(
        created ? `created ${file}` : `kept ${file}`,
        `  template "${name}" is not trusted until you approve it: "abox create ${name} --workspace ." asks you.`,
        `  check it: abox template validate ${name}`,
      );
      let agentInfo: ReturnType<typeof mcpSnippet> | undefined;
      let rules: string | undefined;
      let contextDefined: boolean | undefined;
      let projectCheck: ProjectRootsCheck | undefined;
      if (o.agent) {
        agentInfo = mcpSnippet(o.agent);
        rules = await readRuleSnippet();
        try {
          const rt = await cli.rt();
          const pol = await rt.abox.showPolicy(cli.caller());
          contextDefined = pol.contexts ? o.agent in pol.contexts : undefined;
          projectCheck = checkAgentProject(pol, o.agent, dir, cli.env['HOME'] || homedir());
        } catch {
          /* the hint is optional */
        }
        lines.push('', safe(agentInfo.description));
        if (agentInfo.command) lines.push('', `  ${agentInfo.command}`);
        lines.push(
          '',
          ...(agentInfo.toml ?? JSON.stringify(agentInfo.json, null, 2))
            .split('\n')
            .map((l) => `  ${l}`),
        );
        if (contextDefined === false) {
          lines.push(
            '',
            `note: the agent context "${o.agent}" is not defined in policy.yaml, so abox denies it.`,
            `      Add it under "contexts:" (see "abox policy show") or use "--agent default".`,
          );
        }
        if (projectCheck) {
          lines.push(
            '',
            `Agent "${o.agent}" may work on projects below: ${projectCheck.roots.join(', ')}`,
          );
          if (!projectCheck.allowed) {
            lines.push(
              `note: this project (${dir}) is not usable for it: ${safe(projectCheck.reason ?? '')}`,
              `      Move the project below one of those folders, or add its folder to workspace.roots`,
              `      of the agent's profile with "abox policy edit" (the home directory itself is no good root).`,
            );
          }
        }
        if (rules)
          lines.push(
            '',
            "Add this to the agent's rules file (AGENTS.md / CLAUDE.md):",
            '',
            rules.trimEnd(),
          );
      } else {
        lines.push('', `connect an agent: abox init --agent ${AGENTS.join('|')}`);
      }
      cli.success(
        {
          file,
          template: name,
          created,
          ...(agentInfo
            ? {
                agent: o.agent,
                mcp: agentInfo.json,
                mcpCommand: agentInfo.command,
                ...(agentInfo.toml ? { mcpToml: agentInfo.toml } : {}),
                contextDefined,
                ...(projectCheck ? { workspace: projectCheck } : {}),
              }
            : {}),
          ...(rules ? { rules } : {}),
        },
        () => lines.join('\n'),
        () => file,
      );
    });
}
