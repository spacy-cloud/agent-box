/**
 * Zod mirror of Orca's plugin manifest schema (`orca-plugin.json`, manifestVersion 1).
 *
 * Derived from the installed Orca 1.4.224 bundle, NOT from memory. Every rule carries the bundle
 * location it was copied from; see ../SCHEMA-NOTES.md for the full table. This file is a
 * development/test aid only and is not shipped inside the plugin folder.
 *
 * Not mirrored on purpose: keybinding key normalisation (`normalizeKeybinding` lives in Orca's
 * `shared/keybindings.js`); this plugin contributes no keybindings, so `key` is only length-checked.
 */
import { z } from 'zod';

// -- plugin-id-format.js:9-17 ----------------------------------------------------------------
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DANGEROUS_PLUGIN_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
export const PLUGIN_ID_MAX_LENGTH = 64;

export function isSafePluginId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length <= PLUGIN_ID_MAX_LENGTH &&
    PLUGIN_ID_RE.test(id) &&
    !DANGEROUS_PLUGIN_NAMES.has(id)
  );
}

// -- main/index.js `Gpi` + `Jpi` (install time, NOT part of the zod schema) ----------------------
/** Publisher `stablyai` or any id starting with `orca-` is reserved for official plugins. */
export function isReservedPluginIdentity(publisher: string, id: string): boolean {
  return publisher === 'stablyai' || id.startsWith('orca-');
}

// -- plugin-path-safety.js:39-73 -------------------------------------------------------------
const WINDOWS_DEVICE_NAME_RE =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_CHAR_RE = /[<>:"|?*]/;

export function pluginPathSegmentError(segment: string): string | null {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    return 'empty and dot path segments are not allowed';
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return 'path segments may not end with a dot or space';
  }
  if (
    WINDOWS_FORBIDDEN_CHAR_RE.test(segment) ||
    [...segment].some((character) => character.charCodeAt(0) <= 31)
  ) {
    return 'path segment contains a Windows-forbidden character or alternate-data-stream colon';
  }
  if (WINDOWS_DEVICE_NAME_RE.test(segment)) {
    return 'path segment is a Windows reserved device name';
  }
  return null;
}

export function pluginRelativePathError(value: string): string | null {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\')) {
    return 'must be a non-empty relative path';
  }
  for (const segment of value.split(/[\\/]/)) {
    const error = pluginPathSegmentError(segment);
    if (error) return error;
  }
  return null;
}

// -- plugin-manifest-fields.js:11-33 ---------------------------------------------------------
const pluginIdSchema = z
  .string()
  .refine(isSafePluginId, 'must be kebab-case (a-z, 0-9, dashes) and not a reserved name');
const pluginRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) => pluginRelativePathError(v) === null,
    'must be a portable relative path inside the plugin directory',
  );
const pluginCommandIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/, 'must be a portable command id');

// -- plugin-command-actions.js:8-24 ----------------------------------------------------------
export const PLUGIN_COMMAND_ALIAS_ACTION_IDS = [
  'worktree.history.back',
  'worktree.history.forward',
  'sidebar.left.toggle',
  'sidebar.sleepingWorkspaces.toggle',
  'floatingWorkspace.maximize',
  'tab.rename',
  'workspace.rename',
  'workspace.openBoard',
  'view.tasks',
  'sidebar.right.toggle',
  'sidebar.explorer.toggle',
  'sidebar.search.toggle',
  'sidebar.sourceControl.toggle',
  'sidebar.checks.toggle',
  'sidebar.ports.toggle',
] as const;

// -- plugin-capabilities.js:18-29 ------------------------------------------------------------
export const PLUGIN_CAPABILITY_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own',
] as const;
export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number];
const pluginCapabilitySchema = z.object({ kind: z.enum(PLUGIN_CAPABILITY_KINDS) }).strict();

// -- plugin-manifest.js:23-57 ----------------------------------------------------------------
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const PLUGIN_PANEL_LIMIT = 64;
export const PLUGIN_COMMAND_LIMIT = 256;
export const PLUGIN_EVENT_NAMES = [
  'worktree.created',
  'worktree.removed',
  'agent.status.changed',
] as const;

const orcaEngineRangeSchema = z
  .string()
  .max(64)
  .regex(/^>=\d+\.\d+\.\d+$/, 'must be a ">=x.y.z" version range');

const panelContributionSchema = z.object({
  id: pluginIdSchema,
  title: z.string().min(1).max(256),
  icon: z.string().min(1).max(64).optional(),
  entry: pluginRelativePathSchema,
});

const commandContributionSchema = z.object({
  id: pluginCommandIdSchema,
  title: z.string().min(1).max(256),
  context: z.enum(['global', 'worktree']).optional(),
  action: pluginCommandIdSchema.optional(),
});

const eventContributionSchema = z.object({ on: z.enum(PLUGIN_EVENT_NAMES) });

// -- plugin-content-pack-contributions.js:7-47 -----------------------------------------------
const languagePackSchema = z
  .object({
    locale: z
      .string()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a portable locale identifier'),
    path: pluginRelativePathSchema,
  })
  .strict();
const keybindingSchema = z
  .object({
    command: pluginCommandIdSchema,
    key: z.string().min(1).max(128),
    when: z.enum(['global', 'worktree']).optional(),
  })
  .strict();
const pathContributionSchema = z.object({ path: pluginRelativePathSchema }).strict();

const contributesSchema = z
  .object({
    panels: z.array(panelContributionSchema).max(PLUGIN_PANEL_LIMIT).default([]),
    commands: z.array(commandContributionSchema).max(PLUGIN_COMMAND_LIMIT).default([]),
    events: z.array(eventContributionSchema).max(PLUGIN_EVENT_NAMES.length).default([]),
    languagePacks: z.array(languagePackSchema).max(16).default([]),
    keybindings: z.array(keybindingSchema).max(256).default([]),
    vmRecipes: z.array(pathContributionSchema).max(64).default([]),
    agents: z.array(pathContributionSchema).max(64).default([]),
  })
  .strict();

export const pluginManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: pluginIdSchema,
    publisher: pluginIdSchema,
    name: z.string().min(1).max(256),
    version: z.string().regex(SEMVER_RE, 'must be semver'),
    description: z.string().max(4096).optional(),
    author: z
      .object({ name: z.string().min(1).max(256), url: z.string().max(2048).optional() })
      .optional(),
    repository: z.string().max(2048).optional(),
    icon: pluginRelativePathSchema.optional(),
    engines: z.object({ orca: orcaEngineRangeSchema }),
    pluginApi: z.literal(1),
    main: pluginRelativePathSchema.optional(),
    contributes: contributesSchema.default(() => ({
      panels: [],
      commands: [],
      events: [],
      languagePacks: [],
      keybindings: [],
      vmRecipes: [],
      agents: [],
    })),
    capabilities: z.array(pluginCapabilitySchema).max(32).default([]),
  })
  // -- plugin-manifest-contribution-validation.js:20-91 -------------------------------------
  .superRefine((manifest, ctx) => {
    const dup = <T>(entries: T[], key: (e: T) => string, path: string, label: string): void => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const value = key(entry);
        if (seen.has(value)) {
          ctx.addIssue({
            code: 'custom',
            path: ['contributes', path, index],
            message: `duplicate ${label}: ${value}`,
          });
        }
        seen.add(value);
      });
    };
    dup(manifest.contributes.panels, (e) => e.id, 'panels', 'panels id');
    dup(manifest.contributes.commands, (e) => e.id, 'commands', 'commands id');
    dup(
      manifest.contributes.languagePacks,
      (e) => e.locale.toLowerCase(),
      'languagePacks',
      'language pack locale',
    );
    dup(manifest.contributes.vmRecipes, (e) => e.path, 'vmRecipes', 'vmRecipes path');
    dup(manifest.contributes.agents, (e) => e.path, 'agents', 'agents path');

    const commands = new Map(manifest.contributes.commands.map((c) => [c.id, c]));
    manifest.contributes.commands.forEach((command, index) => {
      if (
        command.action !== undefined &&
        !(PLUGIN_COMMAND_ALIAS_ACTION_IDS as readonly string[]).includes(command.action)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'commands', index, 'action'],
          message: `unknown built-in action: ${command.action}`,
        });
      }
    });
    manifest.contributes.keybindings.forEach((keybinding, index) => {
      const command = commands.get(keybinding.command);
      if (!command) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'keybindings', index, 'command'],
          message: `unknown contributed command: ${keybinding.command}`,
        });
        return;
      }
      if (keybinding.when !== undefined && keybinding.when !== (command.context ?? 'global')) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'keybindings', index, 'when'],
          message: 'keybinding context must match its command context',
        });
      }
    });
    if (!manifest.main && manifest.contributes.commands.some((c) => c.action === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['main'],
        message: 'required when contributes.commands contains a worker command',
      });
    }
    if (!manifest.main && manifest.contributes.events.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['main'],
        message: 'required when contributes.events is non-empty',
      });
    }
    if (
      manifest.contributes.events.length > 0 &&
      !manifest.capabilities.some((c) => c.kind === 'events:subscribe')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'events:subscribe capability required when contributes.events is non-empty',
      });
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** Qualified install identity `<publisher>.<id>` (plugin-manifest.js:120-122). */
export function qualifiedPluginKey(manifest: Pick<PluginManifest, 'publisher' | 'id'>): string {
  return `${manifest.publisher}.${manifest.id}`;
}

/** `>=x.y.z` gate (plugin-manifest.js:134-150). */
export function satisfiesOrcaEngineRange(hostVersion: string, range: string): boolean {
  const parse = (value: string): number[] =>
    (value.split(/[-+]/)[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const host = parse(hostVersion);
  const min = parse(range.slice(2));
  for (let i = 0; i < 3; i++) {
    const a = host[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// -- install-time artifact limits: main/index.js `Kfi`/`Bfi`/`opi` ------------------------------
export const PLUGIN_MANIFEST_MAX_BYTES = 1024 * 1024;
export const PLUGIN_TREE_MAX_ENTRIES = 2000;
export const PLUGIN_TREE_MAX_BYTES = 50 * 1024 * 1024;
export const PLUGIN_PANEL_ENTRY_MAX_BYTES = 10 * 1024 * 1024;
export const PLUGIN_WORKER_ENTRY_MAX_BYTES = 50 * 1024 * 1024;

/** Host API v0 method -> required capability (plugin-host-api.js:91-221). */
export const HOST_METHOD_CAPABILITY: Readonly<Record<string, PluginCapabilityKind>> = {
  'workspace.readContext': 'workspace:read',
  'terminal.sendText': 'terminal:send',
  'notifications.show': 'notifications:show',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'storage.keys': 'storage',
  'secrets.get': 'secrets',
  'secrets.set': 'secrets',
  'secrets.delete': 'secrets',
  'settings.get': 'settings:own',
  'settings.set': 'settings:own',
  'events.subscribe': 'events:subscribe',
};
/** Methods a sandboxed panel may request (host API entries with `panel: true`). */
export const PANEL_ACTIONS = [
  'workspace.readContext',
  'terminal.sendText',
  'notifications.show',
] as const;
