import { AboxError } from '../errors.js';
import {
  claudePluginState,
  clientSpecs,
  DEFAULT_MARKETPLACE_SOURCE,
  detectClients,
  findOnPath,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  readClientServers,
  SERVER_NAME,
  type ClientSpec,
} from './clients.js';
import { unifiedDiff as templateDiff } from '../template/review.js';
import {
  deepEqual,
  entryMatches,
  isRecord,
  jsonIsEmptySkeleton,
  jsonRemoveServer,
  jsonSetServer,
  parseJsonc,
  runsAboxMcp,
  type McpEntry,
} from './edit-json.js';
import { hasRulesBlock, removeRulesBlock, upsertRulesBlock } from './edit-markdown.js';
import {
  parseTomlDoc,
  tomlIsEmptySkeleton,
  tomlRemoveTable,
  tomlUpsertTable,
} from './edit-toml.js';
import { createdBySetup, needsBackup, readSnapshot, sha256, type Snapshot } from './fsafe.js';
import { AGENTS_RULES, CLAUDE_RULES } from './rules.js';
import {
  CLAUDE_CODE_METHODS,
  SETUP_CLIENTS,
  type ClaudeCodeMethod,
  type CommandStep,
  type FileStep,
  type SetupEnvironment,
  type SetupPlan,
  type SetupPurpose,
  type SetupRequest,
  type SetupStep,
} from './types.js';

/** A file change ready to be written, with the checks that go with it. */
export interface FileAction {
  step: FileStep;
  /** New content; null deletes the file. */
  after: string | null;
  snapshot: Snapshot;
  verify: (text: string) => void;
}

/** A program to run (argv), with the check that it did what was meant. */
export interface CommandAction {
  step: CommandStep;
  /** True when the effect can be seen afterwards. */
  verify?: () => Promise<boolean>;
}

export type Action = FileAction | CommandAction;

export interface Prepared {
  plan: SetupPlan;
  actions: Action[];
}

/** Unified diff of a file change (`null` = the file does not exist / is deleted). */
function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const d = templateDiff(before ?? '', after ?? '', {
    fromLabel: before === null ? '/dev/null' : path,
    toLabel: after === null ? '/dev/null' : path,
  });
  return d === '' ? '' : `${d}\n`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateRequest(req: SetupRequest): void {
  if (!Array.isArray(req.clients) || req.clients.length === 0)
    throw new AboxError('invalid_input', 'no client given', {
      hint: `Choose from: ${SETUP_CLIENTS.join(', ')}.`,
    });
  const seen = new Set<string>();
  for (const c of req.clients) {
    if (!(SETUP_CLIENTS as readonly string[]).includes(c))
      throw new AboxError('invalid_input', `unknown client '${String(c).slice(0, 40)}'`, {
        hint: `Choose from: ${SETUP_CLIENTS.join(', ')}.`,
      });
    if (seen.has(c)) throw new AboxError('invalid_input', `client '${c}' given twice`);
    seen.add(c);
  }
  if (
    req.claudeCodeMethod !== undefined &&
    !(CLAUDE_CODE_METHODS as readonly string[]).includes(req.claudeCodeMethod)
  )
    throw new AboxError(
      'invalid_input',
      `unknown Claude Code method '${String(req.claudeCodeMethod)}'`,
      {
        hint: `Choose plugin or mcp.`,
      },
    );
  for (const [name, v, max] of [
    ['command', req.command, 1024],
    ['marketplace', req.marketplace, 300],
  ] as const) {
    if (v === undefined) continue;
    if (typeof v !== 'string' || v === '' || v.length > max || CONTROL.test(v) || v.startsWith('-'))
      throw new AboxError('invalid_input', `invalid ${name}`, {
        hint: `A non-empty single-line value of at most ${max} characters that does not start with "-".`,
      });
  }
}

export function mcpEntryFor(spec: ClientSpec, command: string): McpEntry {
  return { command, args: ['mcp', 'serve', '--agent', spec.context] };
}

function fileStepBase(
  spec: ClientSpec,
  purpose: SetupPurpose,
  path: string,
  format: FileStep['format'],
): Pick<FileStep, 'type' | 'client' | 'purpose' | 'path' | 'format'> {
  return { type: 'file', client: spec.id, purpose, path, format };
}

function verifyFailed(path: string): AboxError {
  return new AboxError('internal', `the new content of ${path} did not pass verification`, {
    hint: 'Nothing was written. Please report this with the file (without secrets).',
  });
}

/** MCP entry in a config file (JSON, JSONC or TOML): add or update it, or remove it. */
async function mcpFileAction(
  env: SetupEnvironment,
  spec: ClientSpec,
  mode: { kind: 'set'; entry: McpEntry } | { kind: 'remove' },
  warnings: string[],
): Promise<FileAction | undefined> {
  const m = spec.mcp!;
  const snap = await readSnapshot(m.path);
  const beforeText = snap.text ?? '';
  const toml = m.format === 'toml';
  const parseDoc = (t: string): Record<string, unknown> =>
    toml ? parseTomlDoc(t, m.path) : parseJsonc(t, m.path);
  const beforeDoc = parseDoc(beforeText);
  const servers = beforeDoc[m.key];
  if (servers !== undefined && !isRecord(servers))
    throw new AboxError('unsupported', `"${m.key}" in ${m.path} is not a table/object`, {
      hint: 'Fix it by hand; setup does not guess.',
    });
  const existing = isRecord(servers) ? servers[SERVER_NAME] : undefined;
  let afterText: string;
  const expected = structuredClone(beforeDoc);
  if (mode.kind === 'set') {
    if (existing !== undefined && !isRecord(existing))
      throw new AboxError(
        'unsupported',
        `"${m.key}.${SERVER_NAME}" in ${m.path} is not a table/object`,
      );
    if (isRecord(existing) && (existing['url'] !== undefined || existing['httpUrl'] !== undefined))
      throw new AboxError(
        'conflict',
        `the "${SERVER_NAME}" entry in ${m.path} is a remote (URL) server`,
        {
          hint: 'Setup writes a stdio entry and will not replace one that connects over HTTP. Rename or remove it, or leave it as it is.',
        },
      );
    afterText = toml
      ? tomlUpsertTable(
          beforeText,
          [m.key, SERVER_NAME],
          { command: mode.entry.command, args: mode.entry.args },
          m.path,
        )
      : jsonSetServer(beforeText, m.key, SERVER_NAME, mode.entry, m.path);
    const exp = (isRecord(expected[m.key]) ? expected[m.key] : (expected[m.key] = {})) as Record<
      string,
      unknown
    >;
    exp[SERVER_NAME] = {
      ...(isRecord(exp[SERVER_NAME]) ? (exp[SERVER_NAME] as Record<string, unknown>) : {}),
      command: mode.entry.command,
      args: mode.entry.args,
    };
  } else {
    if (existing === undefined) return undefined;
    if (!runsAboxMcp(existing, 'abox')) {
      warnings.push(
        `${m.path}: the entry "${SERVER_NAME}" does not look like an abox MCP server; left alone.`,
      );
      return undefined;
    }
    afterText = toml
      ? tomlRemoveTable(beforeText, [m.key, SERVER_NAME], m.path)
      : jsonRemoveServer(beforeText, m.key, SERVER_NAME, m.path);
    delete (expected[m.key] as Record<string, unknown>)[SERVER_NAME];
  }
  if (afterText === beforeText) return undefined;

  // an emptied container may be gone (TOML) or stay as {} (JSON): both are fine
  const normalize = (d: Record<string, unknown>): Record<string, unknown> => {
    const c = structuredClone(d);
    const s = c[m.key];
    if (isRecord(s) && Object.keys(s).length === 0) delete c[m.key];
    return c;
  };
  const verify = (t: string): void => {
    if (!deepEqual(normalize(parseDoc(t)), normalize(expected))) throw verifyFailed(m.path);
  };
  verify(afterText); // the planned content is checked now, and again when staged

  let action: FileStep['action'] = snap.fp.exists ? 'update' : 'create';
  let after: string | null = afterText;
  if (mode.kind === 'remove') {
    const empty = toml
      ? tomlIsEmptySkeleton(afterText, m.key, m.path)
      : jsonIsEmptySkeleton(afterText, m.key, m.path);
    if (empty && (await createdBySetup(env.backupDir, m.path))) {
      action = 'delete';
      after = null;
    }
  }
  return {
    step: {
      ...fileStepBase(spec, 'mcp', m.path, m.format),
      action,
      summary:
        mode.kind === 'set'
          ? `${snap.fp.exists ? 'update' : 'create'} the "${SERVER_NAME}" MCP entry`
          : action === 'delete'
            ? `remove the "${SERVER_NAME}" MCP entry (and the file, which setup had created)`
            : `remove the "${SERVER_NAME}" MCP entry`,
      diff: unifiedDiff(m.path, snap.fp.exists ? beforeText : null, after),
      before: snap.fp,
      afterHash:
        after === null ? '' : sha256(Buffer.from((snap.bom ? '\uFEFF' : '') + after, 'utf8')),
      backup: await needsBackup(env.backupDir, m.path, snap.fp.exists),
    },
    after,
    snapshot: snap,
    verify,
  };
}

/** The abox rules block in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. */
async function rulesFileAction(
  env: SetupEnvironment,
  spec: ClientSpec,
  install: boolean,
): Promise<FileAction | undefined> {
  const path = spec.rulesPath;
  if (!path) return undefined;
  const rules = spec.rulesKind === 'claude' ? CLAUDE_RULES : AGENTS_RULES;
  const snap = await readSnapshot(path);
  const beforeText = snap.text ?? '';
  if (!install && !snap.fp.exists) return undefined;
  if (!install && !hasRulesBlock(beforeText, path)) return undefined;
  const afterText = install
    ? upsertRulesBlock(beforeText, rules, path)
    : removeRulesBlock(beforeText, path);
  if (afterText === beforeText) return undefined;
  const verify = (t: string): void => {
    const has = hasRulesBlock(t, path);
    const rest = removeRulesBlock(t, path).trimEnd();
    if (has !== install || rest !== removeRulesBlock(beforeText, path).trimEnd())
      throw verifyFailed(path);
    if (install && t !== upsertRulesBlock(beforeText, rules, path)) throw verifyFailed(path);
  };
  verify(afterText);
  let action: FileStep['action'] = snap.fp.exists ? 'update' : 'create';
  let after: string | null = afterText;
  if (!install && afterText.trim() === '' && (await createdBySetup(env.backupDir, path))) {
    action = 'delete';
    after = null;
  }
  return {
    step: {
      ...fileStepBase(spec, 'rules', path, 'markdown'),
      action,
      summary: install
        ? 'add the abox rules (when to use a sandbox)'
        : action === 'delete'
          ? 'remove the abox rules (and the file, which setup had created)'
          : 'remove the abox rules',
      diff: unifiedDiff(path, snap.fp.exists ? beforeText : null, after),
      before: snap.fp,
      afterHash:
        after === null ? '' : sha256(Buffer.from((snap.bom ? '\uFEFF' : '') + after, 'utf8')),
      backup: await needsBackup(env.backupDir, path, snap.fp.exists),
    },
    after,
    snapshot: snap,
    verify,
  };
}

function commandAction(
  spec: ClientSpec,
  purpose: SetupPurpose,
  argv: string[],
  summary: string,
  touches: string[],
  extra: { optional?: boolean; verify?: () => Promise<boolean> } = {},
): CommandAction {
  return {
    step: {
      type: 'command',
      client: spec.id,
      purpose,
      argv,
      summary,
      touches,
      ...(extra.optional ? { optional: true } : {}),
    },
    ...(extra.verify ? { verify: extra.verify } : {}),
  };
}

/** Claude Code: the plugin (skills + MCP) or a user-scope MCP entry, and never both. */
async function planClaudeCode(
  env: SetupEnvironment,
  spec: ClientSpec,
  req: SetupRequest,
  command: string,
  out: { actions: Action[]; warnings: string[]; notes: string[] },
): Promise<void> {
  const global = spec.mcp!.path;
  const settings = `${spec.dir}/settings.json`;
  const cli = await findOnPath('claude', env.env, env.platform);
  const plugin = await claudePluginState(env);
  const servers = (await readClientServers(spec)).entries;
  const manual = servers[SERVER_NAME];
  const want = mcpEntryFor(spec, command);
  const uninstall = req.uninstall === true;
  const manualVerify = (present: boolean) => async (): Promise<boolean> => {
    const now = (await readClientServers(spec)).entries[SERVER_NAME];
    return present ? entryMatches(now, want) : now === undefined;
  };
  const pluginVerify = (present: boolean) => async (): Promise<boolean> =>
    (await claudePluginState(env)).installed === present;
  const cliMissing = (what: string): AboxError =>
    new AboxError(
      'unsupported',
      `the claude command was not found on the PATH (needed to ${what})`,
      {
        hint: 'Install Claude Code or add it to the PATH. For a plain MCP entry use --claude-code-method mcp (setup then edits ~/.claude.json itself).',
      },
    );

  const removeManual = async (): Promise<void> => {
    if (manual === undefined) return;
    if (!runsAboxMcp(manual, 'abox')) {
      out.warnings.push(
        `${global}: the entry "${SERVER_NAME}" does not look like an abox MCP server; left alone.`,
      );
      return;
    }
    if (cli) {
      out.actions.push(
        commandAction(
          spec,
          'mcp',
          [cli, 'mcp', 'remove', '--scope', 'user', SERVER_NAME],
          'remove the manual MCP entry (user scope)',
          [global],
          { verify: manualVerify(false) },
        ),
      );
    } else {
      const a = await mcpFileAction(env, spec, { kind: 'remove' }, out.warnings);
      if (a) out.actions.push(a);
    }
  };
  const removePlugin = (): void => {
    if (!plugin.installed) return;
    if (!cli) throw cliMissing('remove the plugin');
    out.actions.push(
      commandAction(
        spec,
        'plugin',
        [cli, 'plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'],
        'uninstall the abox plugin',
        [settings],
        { verify: pluginVerify(false) },
      ),
    );
    if (plugin.marketplaceKnown)
      out.actions.push(
        commandAction(
          spec,
          'plugin',
          [cli, 'plugin', 'marketplace', 'remove', MARKETPLACE_NAME],
          'remove the agent-box marketplace',
          [settings],
          { optional: true },
        ),
      );
  };

  if (uninstall) {
    removePlugin();
    await removeManual();
    const r = await rulesFileAction(env, spec, false);
    if (r) out.actions.push(r);
    return;
  }

  const method: ClaudeCodeMethod =
    req.claudeCodeMethod ??
    (plugin.installed ? 'plugin' : manual !== undefined ? 'mcp' : cli ? 'plugin' : 'mcp');

  if (method === 'plugin') {
    if (!cli) throw cliMissing('install the plugin');
    if (command !== 'abox')
      out.warnings.push(
        'Claude Code: the plugin starts abox from $ABOX_BIN or the PATH; --command does not apply to it.',
      );
    if (!plugin.installed) {
      const source = req.marketplace ?? DEFAULT_MARKETPLACE_SOURCE;
      if (!plugin.marketplaceKnown)
        out.actions.push(
          commandAction(
            spec,
            'plugin',
            [cli, 'plugin', 'marketplace', 'add', source],
            `add the plugin marketplace ${source}`,
            [settings],
          ),
        );
      out.actions.push(
        commandAction(
          spec,
          'plugin',
          [cli, 'plugin', 'install', PLUGIN_ID, '--scope', 'user'],
          'install the abox plugin (MCP server, skills, slash commands)',
          [settings],
          { verify: pluginVerify(true) },
        ),
      );
    } else {
      out.notes.push('Claude Code: the abox plugin is installed already.');
    }
    // the plugin brings its own MCP server: a manual entry would start a second one
    if (manual !== undefined) {
      out.warnings.push(
        'Claude Code: the manual "abox" MCP entry is removed because the plugin registers the server itself.',
      );
      await removeManual();
    }
    return;
  }

  // method mcp
  if (plugin.installed) {
    out.warnings.push(
      'Claude Code: the abox plugin is uninstalled because a manual MCP entry and the plugin would start the server twice.',
    );
    removePlugin();
  }
  if (cli) {
    if (manual !== undefined && !entryMatches(manual, want)) {
      if (
        isRecord(manual) &&
        (manual['url'] !== undefined || manual['type'] === 'http' || manual['type'] === 'sse')
      )
        throw new AboxError(
          'conflict',
          `the "${SERVER_NAME}" MCP entry of Claude Code is a remote (URL) server`,
          {
            hint: 'Setup will not replace it. Remove it yourself ("claude mcp remove abox") or leave it.',
          },
        );
      out.actions.push(
        commandAction(
          spec,
          'mcp',
          [cli, 'mcp', 'remove', '--scope', 'user', SERVER_NAME],
          'replace the existing "abox" MCP entry',
          [global],
        ),
      );
    }
    if (manual === undefined || !entryMatches(manual, want)) {
      out.actions.push(
        commandAction(
          spec,
          'mcp',
          [cli, 'mcp', 'add', '--scope', 'user', SERVER_NAME, '--', want.command, ...want.args],
          'register the MCP server for your user (all projects)',
          [global],
          { verify: manualVerify(true) },
        ),
      );
    } else {
      out.notes.push('Claude Code: the MCP server is registered already.');
    }
  } else {
    const a = await mcpFileAction(env, spec, { kind: 'set', entry: want }, out.warnings);
    if (a) out.actions.push(a);
    else out.notes.push('Claude Code: the MCP server is registered already.');
    out.warnings.push(
      'Claude Code: the claude command is not on the PATH, so setup edits ~/.claude.json itself. Claude Code rewrites that file often: close Claude Code first.',
    );
  }
  if (req.rules !== false) {
    const r = await rulesFileAction(env, spec, true);
    if (r) out.actions.push(r);
  }
}

export async function prepareSetup(env: SetupEnvironment, req: SetupRequest): Promise<Prepared> {
  validateRequest(req);
  const command = req.command ?? 'abox';
  const uninstall = req.uninstall === true;
  const specs = clientSpecs(env);
  const statuses = await detectClients(env, command);
  const out = { actions: [] as Action[], warnings: [] as string[], notes: [] as string[] };

  if (!uninstall && command === 'abox' && !(await findOnPath('abox', env.env, env.platform))) {
    out.warnings.push(
      'abox is not on the PATH of this shell. Agents start it by name: put it on the PATH, or run setup with --command <absolute path of abox>.',
    );
  }

  for (const id of SETUP_CLIENTS) {
    if (!req.clients.includes(id)) continue;
    const spec = specs[id];
    if (!spec.supported) {
      if (uninstall) {
        out.notes.push(`${spec.label}: nothing to remove (setup never writes for it).`);
        continue;
      }
      throw new AboxError(
        'unsupported',
        `${spec.label}: ${spec.unsupportedReason ?? 'not supported'}`,
        {
          hint: 'Run "abox init --agent orca" for the manual steps.',
        },
      );
    }
    const status = statuses.find((s) => s.id === id)!;
    for (const other of status.otherEntries)
      out.warnings.push(
        `${spec.label}: the entry "${other}" also starts "abox mcp serve" (a second server). Setup leaves it alone; remove it by hand if you do not need it.`,
      );
    if (!uninstall) out.notes.push(...spec.notes.map((n) => `${spec.label}: ${n}`));

    if (id === 'claude-code') {
      await planClaudeCode(env, spec, req, command, out);
      continue;
    }
    const a = await mcpFileAction(
      env,
      spec,
      uninstall ? { kind: 'remove' } : { kind: 'set', entry: mcpEntryFor(spec, command) },
      out.warnings,
    );
    if (a) out.actions.push(a);
    else if (!uninstall) out.notes.push(`${spec.label}: the MCP server is registered already.`);
    if (uninstall || req.rules !== false) {
      const r = await rulesFileAction(env, spec, !uninstall);
      if (r) out.actions.push(r);
      else if (!uninstall && spec.rulesPath)
        out.notes.push(`${spec.label}: the rules are in place already.`);
    }
  }

  const steps: SetupStep[] = out.actions.map((a) => a.step);
  const digest = sha256(
    JSON.stringify([
      uninstall,
      steps.map((s) =>
        s.type === 'file'
          ? ['f', s.client, s.path, s.action, s.before.exists, s.before.hash, s.afterHash]
          : ['c', s.client, s.argv, s.touches],
      ),
    ]),
  );
  return {
    plan: {
      uninstall,
      steps,
      warnings: out.warnings,
      notes: out.notes,
      digest,
      empty: steps.length === 0,
    },
    actions: out.actions,
  };
}
