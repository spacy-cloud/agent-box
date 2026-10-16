// @ts-check
/**
 * German and English texts for everything the worker says (notifications and terminal hints).
 *
 * What Orca lets a plugin translate: nothing via the manifest. `title` fields of panels and commands
 * are single static strings and Orca's own language packs only cover Orca's chrome, so the manifest
 * titles are bilingual ("English / Deutsch") and the runtime texts below follow `LANG`/`LC_ALL`
 * (the only locale variables Orca passes to workers) or the `language` option of the config file.
 */
import process from 'node:process';

/** @type {Record<string, string>} */
const en = {
  'common.pluginName': 'Agent Sandboxes',
  'common.noWorktree': 'No worktree is focused. Select a worktree in Orca first.',
  'common.error': 'Agent Sandboxes: error',
  'common.hint': 'Hint: {hint}',
  'common.capabilityMissing':
    'The plugin lacks the "{capability}" permission. Re-enable it in Settings > Plugins.',
  'common.configWarning': 'Config {path}: {warning}',

  'error.abox_not_found':
    'abox was not found. Install it, add it to PATH, or set "aboxPath" in {configPath}.',
  'error.timeout': 'abox took too long and was stopped.',
  'error.policy_denied': 'abox policy denied this: {message}',
  'error.generic': 'abox: {message}',

  'list.title': 'Sandboxes: {count} ({running} running)',
  'list.empty': 'No sandboxes.',
  'list.line': '{mark}{id} {name} - {state}{flags} - {ttl}',
  'list.more': '... and {count} more',
  'list.approvals':
    '{count} pending approval(s): decide in the abox app or with "abox approvals ls".',
  'list.unreachable': 'Unreachable hosts: {hosts}',

  'approvals.title': 'Pending approvals: {count}',
  'approvals.none': 'No pending approvals.',
  'approvals.line': '{id} - {kind} - requested by {requester}{sandbox}',
  'approvals.risk': '  risk: {risk}',
  'approvals.more': '... and {count} more',
  'approvals.decide':
    'Decide in the abox app or in a terminal ("abox approvals approve|deny <id>"). Orca cannot offer a trustworthy approve button.',

  'create.noTemplates': 'abox lists no usable template. Check "abox template ls".',
  'create.chooseTemplate':
    'Several templates are available ({names}). Set "defaultTemplate" in {configPath}.',
  'create.started': 'Creating sandbox from template {template} ...',
  'create.title': 'Sandbox created: {id}',
  'create.titleExisting': 'Sandbox already exists: {id}',
  'create.body': 'Worktree {worktree} -> {name}\nState {state}, expires in {ttl}\nShell: {shell}',
  'create.pendingApproval':
    'Approval required ({approvalId}). Decide in the abox app or with "abox approvals"; then run this command again (the call is idempotent).',
  'create.needsConfirmation':
    'abox asks for confirmation: {reasons}\nConfirm yourself in a terminal: {command}',
  'create.noPath':
    'The path of this worktree is unknown (it was created before the plugin saw it). Run in the worktree terminal:\n{command}',

  'link.none':
    'No sandbox is linked to this worktree. Run "Create sandbox for this worktree" first.',
  'link.ambiguous': 'Several sandboxes match this worktree: {ids}. Use the id directly: {command}',

  'terminal.typed': 'Typed into the terminal (not executed, press Enter): {command}',
  'terminal.copy': 'Run in a terminal: {command}',
  'shell.notRunning': 'Sandbox {id} is {state}. Start it first: {command}',

  'export.started': 'Exporting the diff of {id} ...',
  'export.title': 'Diff exported: {id}',
  'export.body':
    '{files} file(s), +{additions}/-{deletions}\nSaved to {path}\nNothing was applied to your project.',
  'export.empty': 'The sandbox has no changes: {id}',
  'export.flagged': 'CAUTION: {count} changed path(s) can run code once used on the host: {paths}',
  'export.lossy': 'The diff contains replacement characters (binary or non-UTF-8 content).',
  'export.noContent':
    'abox returned no diff text. Use "abox export {id} --format patch" in a terminal.',

  'cleanup.none': 'Nothing to clean up.',
  'cleanup.title': 'Clean-up candidates: {count}',
  'cleanup.line': '{id} {name} - {state}',
  'cleanup.typed':
    'Typed into the terminal (not executed): {command}\nExport the diff first, removal deletes the sandbox workspace.',
  'cleanup.copy': 'Run in a terminal after exporting the diff: {command}',

  'start.title': 'Sandbox started: {id}',
  'stop.title': 'Sandbox stopped: {id}',

  'mcp.title': 'MCP for Orca agents',
  'mcp.body':
    'HTTP: {url}\nHeader: Authorization: Bearer ${tokenEnv}\nStdio: abox mcp serve --agent <context>\nFull snippets: "Sandboxes" panel > MCP, or the README.',
  'mcp.urlPlaceholder':
    '<start "abox mcp serve --http 127.0.0.1:PORT" and set mcp.url in {configPath}>',

  'doctor.ok': 'abox doctor: everything is fine',
  'doctor.title': 'abox doctor: {count} problem(s)',
  'doctor.raw': 'abox doctor returned: {text}',
};

/** @type {Record<string, string>} */
const de = {
  'common.pluginName': 'Agent Sandboxes',
  'common.noWorktree': 'Kein Worktree im Fokus. Wähle zuerst einen Worktree in Orca.',
  'common.error': 'Agent Sandboxes: Fehler',
  'common.hint': 'Hinweis: {hint}',
  'common.capabilityMissing':
    'Dem Plugin fehlt die Berechtigung "{capability}". Aktiviere es in Einstellungen > Plugins neu.',
  'common.configWarning': 'Konfiguration {path}: {warning}',

  'error.abox_not_found':
    'abox wurde nicht gefunden. Installiere es, nimm es in den PATH auf oder setze "aboxPath" in {configPath}.',
  'error.timeout': 'abox hat zu lange gebraucht und wurde gestoppt.',
  'error.policy_denied': 'Die abox-Richtlinie verbietet das: {message}',
  'error.generic': 'abox: {message}',

  'list.title': 'Sandboxes: {count} ({running} laufen)',
  'list.empty': 'Keine Sandboxes.',
  'list.line': '{mark}{id} {name} - {state}{flags} - {ttl}',
  'list.more': '... und {count} weitere',
  'list.approvals':
    '{count} offene Freigabe(n): in der abox-App oder mit "abox approvals ls" entscheiden.',
  'list.unreachable': 'Nicht erreichbare Hosts: {hosts}',

  'approvals.title': 'Offene Freigaben: {count}',
  'approvals.none': 'Keine offenen Freigaben.',
  'approvals.line': '{id} - {kind} - angefragt von {requester}{sandbox}',
  'approvals.risk': '  Risiko: {risk}',
  'approvals.more': '... und {count} weitere',
  'approvals.decide':
    'Entscheide in der abox-App oder im Terminal ("abox approvals approve|deny <id>"). Orca kann keinen vertrauenswürdigen Freigabe-Knopf anbieten.',

  'create.noTemplates': 'abox listet kein nutzbares Template. Prüfe "abox template ls".',
  'create.chooseTemplate':
    'Mehrere Templates sind verfügbar ({names}). Setze "defaultTemplate" in {configPath}.',
  'create.started': 'Sandbox wird aus Template {template} erstellt ...',
  'create.title': 'Sandbox erstellt: {id}',
  'create.titleExisting': 'Sandbox existiert bereits: {id}',
  'create.body': 'Worktree {worktree} -> {name}\nStatus {state}, läuft ab in {ttl}\nShell: {shell}',
  'create.pendingApproval':
    'Freigabe nötig ({approvalId}). Entscheide in der abox-App oder mit "abox approvals" und führe den Befehl danach erneut aus (der Aufruf ist idempotent).',
  'create.needsConfirmation':
    'abox verlangt eine Bestätigung: {reasons}\nBestätige selbst im Terminal: {command}',
  'create.noPath':
    'Der Pfad dieses Worktrees ist unbekannt (er wurde angelegt, bevor das Plugin ihn gesehen hat). Führe im Worktree-Terminal aus:\n{command}',

  'link.none':
    'Mit diesem Worktree ist keine Sandbox verknüpft. Führe zuerst "Sandbox für diesen Worktree erstellen" aus.',
  'link.ambiguous':
    'Mehrere Sandboxes passen zu diesem Worktree: {ids}. Nutze direkt die ID: {command}',

  'terminal.typed': 'Ins Terminal geschrieben (nicht ausgeführt, drücke Enter): {command}',
  'terminal.copy': 'In einem Terminal ausführen: {command}',
  'shell.notRunning': 'Sandbox {id} ist {state}. Starte sie zuerst: {command}',

  'export.started': 'Diff von {id} wird exportiert ...',
  'export.title': 'Diff exportiert: {id}',
  'export.body':
    '{files} Datei(en), +{additions}/-{deletions}\nGespeichert in {path}\nIm Projekt wurde nichts angewendet.',
  'export.empty': 'Die Sandbox hat keine Änderungen: {id}',
  'export.flagged':
    'ACHTUNG: {count} geänderte(r) Pfad(e) können beim Verwenden auf dem Host Code ausführen: {paths}',
  'export.lossy': 'Der Diff enthält Ersatzzeichen (Binär- oder Nicht-UTF-8-Inhalt).',
  'export.noContent':
    'abox hat keinen Diff-Text geliefert. Nutze im Terminal "abox export {id} --format patch".',

  'cleanup.none': 'Nichts aufzuräumen.',
  'cleanup.title': 'Aufräum-Kandidaten: {count}',
  'cleanup.line': '{id} {name} - {state}',
  'cleanup.typed':
    'Ins Terminal geschrieben (nicht ausgeführt): {command}\nExportiere vorher den Diff, das Entfernen löscht den Sandbox-Workspace.',
  'cleanup.copy': 'Nach dem Diff-Export im Terminal ausführen: {command}',

  'start.title': 'Sandbox gestartet: {id}',
  'stop.title': 'Sandbox gestoppt: {id}',

  'mcp.title': 'MCP für Orca-Agenten',
  'mcp.body':
    'HTTP: {url}\nHeader: Authorization: Bearer ${tokenEnv}\nStdio: abox mcp serve --agent <context>\nVollständige Snippets: Panel "Sandboxes" > MCP oder die README.',
  'mcp.urlPlaceholder':
    '<"abox mcp serve --http 127.0.0.1:PORT" starten und mcp.url in {configPath} setzen>',

  'doctor.ok': 'abox doctor: alles in Ordnung',
  'doctor.title': 'abox doctor: {count} Problem(e)',
  'doctor.raw': 'abox doctor lieferte: {text}',
};

export const MESSAGES = Object.freeze({ en: Object.freeze(en), de: Object.freeze(de) });

/**
 * @param {'auto' | 'de' | 'en'} configured
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'de' | 'en'}
 */
export function detectLanguage(configured, env = process.env) {
  if (configured === 'de' || configured === 'en') return configured;
  const raw = env['LC_ALL'] || env['LC_MESSAGES'] || env['LANGUAGE'] || env['LANG'] || '';
  return /^de(?:[_.@-]|$)/i.test(raw) ? 'de' : 'en';
}

/**
 * @param {'de' | 'en'} lang
 * @returns {(key: string, params?: Record<string, string | number>) => string}
 */
export function createTranslator(lang) {
  const table = MESSAGES[lang];
  return (key, params = {}) => {
    const template = table[key] ?? en[key] ?? key;
    // `${tokenEnv}` in the text is a literal dollar sign followed by the {tokenEnv} placeholder.
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : whole,
    );
  };
}
