/**
 * `abox setup`: registers the abox MCP server (and the agent rules) with the agents on this machine.
 * The types below are what the CLI prints and what a GUI wizard can render. Everything in this
 * directory is human-only: the `Abox` facade gates it with `requireHuman`, and the MCP server has no
 * tool for it.
 */

export const SETUP_CLIENTS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'gemini-cli',
  'orca',
] as const;
export type SetupClientId = (typeof SETUP_CLIENTS)[number];

/** Claude Code: the agent-kit plugin (skills + MCP) or a plain user-scope MCP entry. Never both. */
export const CLAUDE_CODE_METHODS = ['plugin', 'mcp'] as const;
export type ClaudeCodeMethod = (typeof CLAUDE_CODE_METHODS)[number];

export type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'markdown';

/** Result of running a program (argv, no shell). */
export interface SetupCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SetupCommandRunner = (
  argv: string[],
  o: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<SetupCommandResult>;

/** Where setup works. Tests pass a temp directory as `home` and a private `env`; nothing reads the real one. */
export interface SetupEnvironment {
  /** Home directory. All client locations derive from it, `env` and `platform`. */
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** First-snapshot backups of every file setup touches (mode 0700, files 0600). */
  backupDir: string;
  /** Private staging directory (mode 0700): the new content is written and verified here first. */
  stagingDir: string;
  /** Runs `claude`, `codex`, ...: argv only. Default: `execFile`. */
  run?: SetupCommandRunner;
  now?: () => number;
}

export interface SetupRequest {
  /** Clients to set up (or to remove with `uninstall`). */
  clients: SetupClientId[];
  /** Claude Code only. Default: what is registered now, else `plugin` when the `claude` CLI exists, else `mcp`. */
  claudeCodeMethod?: ClaudeCodeMethod;
  /** Executable written into the MCP entries (default `abox`). */
  command?: string;
  /** Marketplace source for the Claude Code plugin (default `spacy-cloud/agent-box`). */
  marketplace?: string;
  /** Also install the agent rules where the agent has a rules file (default true). */
  rules?: boolean;
  /** Remove what setup installed instead of installing. */
  uninstall?: boolean;
}

export interface ClientStatus {
  id: SetupClientId;
  label: string;
  /** The agent's own agent-context id for `abox mcp serve --agent`. */
  context: string;
  /** Something of this client was found (binary on the PATH, config directory, config file). */
  detected: boolean;
  evidence: string[];
  /** Setup can write for this client. */
  supported: boolean;
  unsupportedReason?: string;
  /** An abox registration exists (MCP entry or plugin). */
  registered: boolean;
  /** How: `plugin`, `mcp` (CLI-managed entry in Claude Code) or `file` (entry in the client's config file). */
  registeredVia?: 'plugin' | 'mcp' | 'file';
  /** Other entries that also start `abox mcp serve` (duplicate servers). */
  otherEntries: string[];
  /** Config files setup would touch for the MCP entry. */
  configPaths: string[];
  rulesPath?: string;
  rulesInstalled: boolean;
  /** Claude Code: the method setup would use by default. */
  claudeCodeMethod?: ClaudeCodeMethod;
  /** Claude Code: the `claude` CLI was found. */
  cliPath?: string;
  /** What the multi-select should start with: true when abox is registered already. */
  preselected: boolean;
  notes: string[];
  /** The config could not be read (broken syntax, symbolic link, ...): setup would refuse to write it. */
  problem?: string;
}

export interface FileFingerprint {
  exists: boolean;
  size: number;
  mtimeMs: number;
  mode: number;
  /** sha256 of the bytes, hex; empty when the file does not exist. */
  hash: string;
}

export type SetupPurpose = 'mcp' | 'rules' | 'plugin';

export interface FileStep {
  type: 'file';
  client: SetupClientId;
  purpose: SetupPurpose;
  path: string;
  format: ConfigFormat;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  summary: string;
  /** Unified diff of the change (empty for `unchanged`). */
  diff: string;
  before: FileFingerprint;
  /** sha256 of the new content (empty for `delete` / `unchanged`). */
  afterHash: string;
  /** A first-snapshot backup will be made (the file exists and none was kept yet). */
  backup: boolean;
}

export interface CommandStep {
  type: 'command';
  client: SetupClientId;
  purpose: SetupPurpose;
  /** What is run, as argv. Never through a shell. */
  argv: string[];
  summary: string;
  /** Files the program changes (backed up before, shown to the human). */
  touches: string[];
  /** Run only to make a registration undone: a failure is a warning. */
  optional?: boolean;
}

export type SetupStep = FileStep | CommandStep;

export interface SetupPlan {
  uninstall: boolean;
  steps: SetupStep[];
  warnings: string[];
  notes: string[];
  /** Bound to the exact steps (paths, contents, commands). Apply refuses when the state moved on. */
  digest: string;
  /** Nothing to do. */
  empty: boolean;
}

export interface StepResult {
  client: SetupClientId;
  purpose: SetupPurpose;
  /** Path of the file, or the command line. */
  target: string;
  status: 'applied' | 'unchanged' | 'failed' | 'skipped';
  message?: string;
  /** Verified after writing. */
  verified?: boolean;
  backup?: string;
}

export interface SetupResult {
  ok: boolean;
  uninstall: boolean;
  steps: StepResult[];
  warnings: string[];
  /** Backups kept by setup (first snapshots), by original path. */
  backups: Array<{ path: string; backup: string }>;
  digest: string;
}
