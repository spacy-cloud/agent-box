import { Command, CommanderError } from 'commander';
import { Cli, jsonRequested, processIo, type RunOptions } from './cli.js';
import { CliError } from './errors.js';
import { registerApprovals } from './commands/approvals.js';
import { registerCompletion } from './commands/completion.js';
import { registerData } from './commands/data.js';
import { registerHost } from './commands/host.js';
import { registerInit } from './commands/init.js';
import { registerMcp } from './commands/mcp.js';
import { registerOps } from './commands/ops.js';
import { registerPolicy } from './commands/policy.js';
import { registerPort } from './commands/port.js';
import { registerRun } from './commands/run.js';
import { registerSandbox } from './commands/sandbox.js';
import { registerSecret } from './commands/secret.js';
import { registerTemplate } from './commands/template.js';
import { cliVersion } from './version.js';

const EXIT_CODES_HELP = `
Exit codes:
  0  success
  1  internal error, or a check (doctor, audit verify) found problems
  2  invalid input (also: unknown id, unsupported on this backend, conflict)
  3  denied by policy, approval denied/expired, or confirmation missing (use --yes)
  4  backend or host unavailable / failed
  5  timeout
  "abox exec" exits with the exit code of the command it ran.

Output:
  --json prints {"ok":true,"data":...} or {"ok":false,"code":...,"message":...,"hint":...,"issues":[...]}
  on stdout; human text and progress go to stderr/stdout without colours when not a terminal.
`;

export function buildProgram(cli: Cli): Command {
  const program = new Command('abox');
  program
    .description(
      'abox - sandboxes for AI agents: create, run, inspect and clean up isolated environments',
    )
    .version(cliVersion(), '-V, --version', 'print the version')
    .option('--json', 'machine-readable output ({"ok":true,"data":…} or {"ok":false,"code":…})')
    .option('-q, --quiet', 'print only the essentials (ids); errors are still shown')
    .option('--host <id>', 'host to use (default: local)')
    .option('--project <dir>', 'project directory (default: the current directory)')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => cli.out(s),
      writeErr: (s) => cli.err(s),
      outputError: () => undefined,
    })
    .showSuggestionAfterError()
    .addHelpText('after', EXIT_CODES_HELP);

  program.hook('preAction', () => {
    const o = program.opts<{ json?: boolean; quiet?: boolean; host?: string; project?: string }>();
    cli.globals = {
      json: o.json === true,
      quiet: o.quiet === true,
      ...(o.host ? { host: o.host } : {}),
      ...(o.project ? { project: o.project } : {}),
    };
  });

  registerTemplate(program, cli);
  registerSandbox(program, cli);
  registerRun(program, cli);
  registerData(program, cli);
  registerApprovals(program, cli);
  registerPolicy(program, cli);
  registerPort(program, cli);
  registerOps(program, cli);
  registerMcp(program, cli);
  registerInit(program, cli);
  registerHost(program, cli);
  registerSecret(program, cli);
  registerCompletion(program, cli);
  return program;
}

/**
 * Runs the CLI with `argv` (without node and script) and returns the exit code. Never calls
 * `process.exit` and writes only to `opts.io`, so tests can run it in-process.
 */
export async function runCli(argv: string[], opts: RunOptions = {}): Promise<number> {
  const cli = new Cli(opts.io ?? processIo(), opts);
  cli.globals.json = jsonRequested(argv);
  const program = buildProgram(cli);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (
      e instanceof CommanderError &&
      e.code === 'commander.unknownOption' &&
      (argv.includes('exec') || argv.includes('process'))
    ) {
      return cli.reportError(
        new CliError('invalid_input', e.message.replace(/^error:\s*/i, ''), {
          hint: 'Put "--" before the command: abox exec <id> -- ls -l',
        }),
      );
    }
    return cli.reportError(e);
  } finally {
    await cli.close();
  }
}
