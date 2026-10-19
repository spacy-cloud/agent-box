import type { Command } from 'commander';
import { Option } from 'commander';
import {
  CLAUDE_CODE_METHODS,
  SETUP_CLIENTS,
  type ClaudeCodeMethod,
  type ClientStatus,
  type SetupClientId,
  type SetupPlan,
  type SetupRequest,
  type SetupResult,
} from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { renderTable, safe } from '../format.js';
import { collect, commaList, invalid } from '../parse.js';

interface SetupOptions {
  client?: string[];
  claudeCodeMethod?: ClaudeCodeMethod;
  command?: string;
  marketplace?: string;
  rules: boolean;
  uninstall?: boolean;
  list?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

function tilde(cli: Cli, path: string): string {
  const home = cli.env['HOME'];
  return home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

function describeFound(cli: Cli, c: ClientStatus): string {
  if (!c.supported) return 'not supported by setup';
  if (c.registered)
    return c.registeredVia === 'plugin' ? 'abox registered (plugin)' : 'abox registered';
  if (c.detected) return `found (${tilde(cli, c.evidence[0] ?? '')})`;
  return 'not found';
}

function listText(cli: Cli, clients: ClientStatus[]): string {
  return renderTable(
    [{ header: 'CLIENT' }, { header: 'STATE' }, { header: 'RULES' }, { header: 'CONFIG' }],
    clients.map((c) => [
      c.id,
      describeFound(cli, c) + (c.problem ? ' (config unreadable)' : ''),
      c.rulesPath ? (c.rulesInstalled ? 'installed' : 'no') : '-',
      c.configPaths.map((p) => tilde(cli, p)).join(', ') || '-',
    ]),
    cli.width,
  );
}

/** Numbered multi-select on the terminal; abox registrations are preselected. */
async function chooseClients(
  cli: Cli,
  clients: ClientStatus[],
  uninstall: boolean,
): Promise<SetupClientId[]> {
  const rows = clients.map((c, i) => ({ c, n: i + 1 }));
  for (;;) {
    const lines = [
      uninstall
        ? 'Agents with an abox registration are marked [x]:'
        : 'Agents on this machine. [x] = abox is registered already (kept marked):',
    ];
    for (const { c, n } of rows) {
      const mark = !c.supported ? '[-]' : c.preselected ? '[x]' : '[ ]';
      lines.push(
        `  ${n}  ${mark} ${c.label.padEnd(15)} ${safe(describeFound(cli, c))}${c.problem ? ` - ${safe(c.problem)}` : ''}`,
      );
    }
    cli.err(`${lines.join('\n')}\n`);
    const answer = await cli.readLine(
      `${uninstall ? 'Remove from' : 'Set up'} which? Numbers separated by spaces, "a" = all supported, Enter = the marked ones, "q" = quit: `,
    );
    if (answer === undefined || /^\s*q(uit)?\s*$/i.test(answer)) return [];
    const text = answer.trim().toLowerCase();
    const supported = rows.filter((r) => r.c.supported);
    if (text === '') return supported.filter((r) => r.c.preselected).map((r) => r.c.id);
    if (text === 'a' || text === 'all') return supported.map((r) => r.c.id);
    if (text === 'n' || text === 'none') return [];
    const picked: SetupClientId[] = [];
    let bad = false;
    for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
      const row = rows.find((r) => String(r.n) === tok || r.c.id === tok);
      if (!row || !row.c.supported) {
        cli.err(`"${safe(tok.slice(0, 40))}" is not a choice here.\n`);
        bad = true;
        break;
      }
      if (!picked.includes(row.c.id)) picked.push(row.c.id);
    }
    if (!bad) return picked;
  }
}

function previewLines(cli: Cli, plan: SetupPlan): string[] {
  const lines: string[] = [];
  const label = (id: string): string => id;
  if (plan.steps.length === 0) lines.push('Nothing to change.');
  for (const s of plan.steps) {
    if (s.type === 'file') {
      lines.push(
        `[${label(s.client)}] ${s.action} ${tilde(cli, s.path)}: ${safe(s.summary)}${s.backup ? ' (a backup of the original is kept)' : ''}`,
      );
      for (const l of s.diff.trimEnd().split('\n')) if (l) lines.push(`    ${safe(l)}`);
    } else {
      lines.push(`[${label(s.client)}] run: ${safe(s.argv.join(' '))}`, `    ${safe(s.summary)}`);
      if (s.touches.length > 0)
        lines.push(
          `    changes: ${s.touches.map((t) => tilde(cli, t)).join(', ')} (backed up first)`,
        );
    }
  }
  for (const w of plan.warnings) lines.push('', `warning: ${safe(w)}`);
  for (const n of plan.notes) lines.push(`note: ${safe(n)}`);
  return lines;
}

function resultLines(cli: Cli, r: SetupResult): string[] {
  const lines: string[] = [];
  for (const s of r.steps) {
    const mark =
      s.status === 'applied' ? (s.verified === false ? 'done (not confirmed)' : 'done') : s.status;
    lines.push(
      `${mark.padEnd(8)} [${s.client}] ${safe(tilde(cli, s.target))}${s.message ? ` - ${safe(s.message)}` : ''}`,
    );
  }
  for (const w of r.warnings) lines.push(`warning: ${safe(w)}`);
  for (const b of r.backups)
    lines.push(`backup   ${tilde(cli, b.path)} -> ${tilde(cli, b.backup)}`);
  if (r.ok) lines.push('', 'Restart the agents so that they pick up the change.');
  return lines;
}

export function registerSetup(program: Command, cli: Cli): void {
  program
    .command('setup')
    .description(
      'Register the abox MCP server (and the agent rules) with Claude Code, Claude Desktop, Codex, Cursor and Gemini CLI',
    )
    .addOption(
      new Option(
        '--client <name>',
        `agent to set up (repeatable or comma separated): ${SETUP_CLIENTS.join(', ')}; without it a terminal asks`,
      ).argParser(collect),
    )
    .addOption(
      new Option(
        '--claude-code-method <method>',
        'Claude Code: the plugin (skills + MCP, default when "claude" is installed) or a plain user-scope MCP entry; never both',
      ).choices([...CLAUDE_CODE_METHODS]),
    )
    .option('--command <path>', 'abox executable written into the MCP entries (default: abox)')
    .option(
      '--marketplace <source>',
      'Claude Code plugin marketplace (default: spacy-cloud/agent-box)',
    )
    .option('--no-rules', 'do not install the rules snippet into AGENTS.md / CLAUDE.md / GEMINI.md')
    .option('--uninstall', 'remove what setup installed instead')
    .option('--list', 'only show which agents were found and where abox is registered')
    .option('--dry-run', 'show the preview (paths, diffs, commands) and change nothing')
    .option('--yes', 'apply without asking (required without a terminal and with --json)')
    .addHelpText(
      'after',
      `
Setup shows exactly what it would change (file paths, diffs, commands) and writes only after you
confirm. Existing entries and comments stay; the first version of every file it changes is kept in
the abox data directory; files are replaced atomically and checked afterwards; a file that changed
meanwhile or is a symbolic link is refused. See docs/setup.md for the config file locations.

Examples:
  abox setup                                   choose on the terminal
  abox setup --client codex --client cursor --yes
  abox setup --client claude-code --claude-code-method mcp --dry-run
  abox setup --uninstall --client codex --yes --json`,
    )
    .action(async (o: SetupOptions) => {
      const rt = await cli.rt();
      const abox = rt.abox;
      const detectOpts = o.command ? { command: o.command } : {};
      const detected = await abox.setupDetect(cli.caller(), detectOpts);

      if (o.list) {
        cli.success({ clients: detected }, () => listText(cli, detected));
        return;
      }

      let clients = commaList(o.client) as SetupClientId[];
      if (clients.length === 0) {
        if (!cli.interactive)
          throw invalid(
            'no agent given',
            `Run "abox setup" in a terminal to choose, or pass --client <name> (${SETUP_CLIENTS.join(', ')}).`,
          );
        clients = await chooseClients(cli, detected, o.uninstall === true);
        if (clients.length === 0) {
          cli.info('nothing selected');
          return;
        }
      }

      const req: SetupRequest = {
        clients,
        ...(o.claudeCodeMethod ? { claudeCodeMethod: o.claudeCodeMethod } : {}),
        ...(o.command ? { command: o.command } : {}),
        ...(o.marketplace ? { marketplace: o.marketplace } : {}),
        rules: o.rules,
        ...(o.uninstall ? { uninstall: true } : {}),
      };
      const plan = await abox.setupPlan(cli.caller(), req);
      if (!cli.json && !cli.quiet) {
        cli.out(
          `${cli.style('bold', 'Preview - nothing has been changed yet')}\n${previewLines(cli, plan).join('\n')}\n`,
        );
      }
      if (plan.empty || o.dryRun) {
        cli.success({ applied: false, plan });
        return;
      }

      let go = o.yes === true;
      if (!go && cli.interactive) go = await cli.confirm('\nApply these changes?');
      if (!go) {
        throw new CliError('approval_required', 'confirmation required and not given', {
          hint: cli.interactive
            ? 'Declined; nothing was changed.'
            : 'Re-run with --yes to apply (or --dry-run to only preview).',
          details: { digest: plan.digest, plan },
        });
      }
      const result = await abox.setupApply(cli.caller(true), req, plan.digest);
      if (!result.ok) {
        if (!cli.json) cli.err(`${resultLines(cli, result).join('\n')}\n`);
        throw new CliError(
          'backend_error',
          'setup stopped at a failing step; later steps were not run',
          {
            hint: 'Fix the problem and run "abox setup" again; steps that are done are skipped. "abox setup --uninstall" reverts.',
            details: { result },
          },
        );
      }
      cli.success({ applied: true, plan, result }, () => resultLines(cli, result).join('\n'));
    });
}
