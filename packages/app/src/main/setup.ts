/**
 * Back end of the first-run setup wizard. Everything that decides something is the manager's: which agents exist and
 * what registering abox with them changes (`Abox.setupDetect/setupPlan/setupApply`, human only, apply needs the
 * confirmation and the digest of the preview), the policy (`policy:set`, revisioned and audited), the template suggestion.
 * This file only checks the folders the wizard offers as workspace roots, builds the proposed text of policy.yaml
 * and counts what the projects below the folders point to. Nothing here writes a file.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ANY_ROOT, AboxError, canonicalizePath, checkHostPath, isWithin } from '@abox/core';
import type { Abox, Caller, SetupRequest } from '@abox/core';
import type { IPC } from '../shared/ipc';
import type {
  Outputs,
  SetupRootsFolder,
  SetupRootsProfile,
  SetupRootsProposal,
  SetupTemplateScan,
} from '../shared/types';
import { proposeWorkspaceRoots, rootEntryFor } from '../shared/workspace-roots';
import { readPolicyText } from './policy-text';
import { resolveProjectDir } from './projects';
import type { z } from 'zod';

const HUMAN: Caller = { contextId: 'human' };

type Input<C extends keyof typeof IPC> = z.output<(typeof IPC)[C]>;

/** Most folders the template scan asks the manager about (the chosen ones and the folders directly below them). */
export const SCAN_MAX_FOLDERS = 60;
/** Files whose presence means "this folder is a project of its own" (agents can only use folders *below* a root). */
const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'pubspec.yaml',
];

export function createSetupHandlers(abox: Abox): {
  'setup:detect': () => Promise<Outputs['setup:detect']>;
  'setup:plan': (i: Input<'setup:plan'>) => Promise<Outputs['setup:plan']>;
  'setup:apply': (i: Input<'setup:apply'>) => Promise<Outputs['setup:apply']>;
  'setup:roots': (i: Input<'setup:roots'>) => Promise<SetupRootsProposal>;
  'setup:scan': (i: Input<'setup:scan'>) => Promise<SetupTemplateScan>;
} {
  const request = (i: {
    clients: SetupRequest['clients'];
    claudeCodeMethod?: SetupRequest['claudeCodeMethod'] | undefined;
    rules?: boolean | undefined;
  }): SetupRequest => ({
    clients: i.clients,
    ...(i.claudeCodeMethod ? { claudeCodeMethod: i.claudeCodeMethod } : {}),
    ...(i.rules !== undefined ? { rules: i.rules } : {}),
  });

  return {
    'setup:detect': () => abox.setupDetect(HUMAN),
    'setup:plan': (i) => abox.setupPlan(HUMAN, request(i)),
    // `confirmed` is the click on "Apply" after the preview (the schema accepts nothing else); the manager still
    // requires the digest of that preview and audits the result.
    'setup:apply': (i) =>
      abox.setupApply({ contextId: 'human', humanConfirmed: true }, request(i), i.digest),

    async 'setup:roots'(i) {
      const [view, doc] = await Promise.all([abox.showPolicy(HUMAN), readPolicyText(abox, HUMAN)]);
      // The agent profiles: those some agent context uses (the human profile is built in and not edited here).
      const byProfile = new Map<string, string[]>();
      for (const [id, c] of Object.entries(view.contexts ?? {})) {
        if (id === 'human') continue;
        byProfile.set(c.profile, [...(byProfile.get(c.profile) ?? []), id]);
      }
      const profiles: SetupRootsProfile[] = [...byProfile.entries()].map(([name, usedBy]) => ({
        name,
        usedBy: usedBy.sort(),
      }));
      const preferred = view.contexts?.['claude-code']?.profile;
      const profile =
        i.profile !== undefined
          ? profiles.find((p) => p.name === i.profile)?.name
          : (profiles.find((p) => p.name === preferred) ?? profiles[0])?.name;
      if (i.profile !== undefined && profile === undefined) {
        throw new AboxError('not_found', `no agent context uses the profile "${i.profile}"`);
      }
      const roots = profile ? [...(view.profiles?.[profile]?.workspace.roots ?? [])] : [];
      const home = homedir();
      const canonHome = canonicalizePath(home, { home, cwd: '/' });
      const existing = roots.flatMap((r) => {
        try {
          return [{ entry: r, canonical: canonicalizePath(r, { home, cwd: home }) }];
        } catch {
          return [];
        }
      });

      const folders: SetupRootsFolder[] = [];
      const taken: Array<{ entry: string; canonical: string }> = [];
      for (const input of i.folders) {
        const f = await inspectFolder(input, home, canonHome, [...existing, ...taken]);
        if (f.status === 'new' && f.path && f.entry)
          taken.push({ entry: f.entry, canonical: f.path });
        folders.push(f);
      }

      const entries = folders.filter((f) => f.status === 'new' && f.entry).map((f) => f.entry!);
      let proposed: string | null = null;
      let error: SetupRootsProposal['error'];
      if (profile && entries.length > 0) {
        const edit = proposeWorkspaceRoots(doc.text, profile, roots, entries);
        if (edit.ok) proposed = edit.text === doc.text ? null : edit.text;
        else error = edit.error;
      }
      return {
        profile: profile ?? null,
        usedBy: profiles.find((p) => p.name === profile)?.usedBy ?? [],
        profiles,
        roots,
        folders,
        current: doc.text,
        proposed,
        baseHash: view.policy.contentHash,
        ...(error ? { error } : {}),
      };
    },

    async 'setup:scan'(i) {
      const found = new Map<
        string,
        { projects: number; basis: 'project_template' | 'markers'; examples: string[] }
      >();
      const seen = new Set<string>();
      let truncated = false;
      for (const input of i.folders) {
        let dir: string;
        try {
          dir = await resolveProjectDir(expandHome(input, homedir()));
        } catch {
          continue;
        }
        const candidates = [dir, ...(await childFolders(dir))];
        for (const path of candidates) {
          if (seen.has(path)) continue;
          if (seen.size >= SCAN_MAX_FOLDERS) {
            truncated = true;
            break;
          }
          seen.add(path);
          let primary;
          try {
            primary = (await abox.suggestTemplate(HUMAN, { path })).primary;
          } catch {
            continue; // a folder the manager refuses is simply not suggested for
          }
          // A project's own template needs a review before it can be built: not something to prebuild here.
          if (!primary || primary.basis !== 'markers') continue;
          const e = found.get(primary.template) ?? {
            projects: 0,
            basis: primary.basis,
            examples: [],
          };
          e.projects += 1;
          if (e.examples.length < 3) e.examples.push(basename(path) || path);
          found.set(primary.template, e);
        }
      }
      return {
        scanned: seen.size,
        truncated,
        templates: [...found.entries()]
          .map(([name, e]) => ({ name, ...e }))
          .sort((a, b) => b.projects - a.projects || a.name.localeCompare(b.name)),
      };
    },
  };
}

/** `~/x` -> `<home>/x`; the schema only lets absolute paths and `~/…` through. */
function expandHome(input: string, home: string): string {
  return input.startsWith('~/') ? join(home, input.slice(2)) : input;
}

/** The folders directly below `dir`: real directories only (no links), no hidden ones, no dependency folders. */
async function childFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

async function inspectFolder(
  input: string,
  home: string,
  canonHome: string,
  roots: ReadonlyArray<{ entry: string; canonical: string }>,
): Promise<SetupRootsFolder> {
  const refused = (reason: string, path: string | null = null): SetupRootsFolder => ({
    input,
    path,
    entry: null,
    status: 'refused',
    reason,
    looksLikeProject: false,
  });
  let path: string;
  try {
    path = await resolveProjectDir(expandHome(input, home));
  } catch (e) {
    return refused(e instanceof Error ? e.message : String(e));
  }
  // The same check a workspace of an agent has to pass: protected paths, hidden directories of the home directory.
  const check = checkHostPath(path, {
    home,
    roots: [ANY_ROOT],
    kind: 'workspace',
    denyHiddenHomeDirs: true,
    scanSockets: false,
  });
  if (!check.ok) return refused(check.reason, path);
  const looksLikeProject = PROJECT_MARKERS.some((m) => existsSync(join(path, m)));
  const entry = rootEntryFor(path, canonHome);
  const covering = roots.find((r) => isWithin(path, r.canonical));
  if (covering) {
    return {
      input,
      path,
      entry,
      status: 'covered',
      coveredBy: covering.entry,
      looksLikeProject,
    };
  }
  return { input, path, entry, status: 'new', looksLikeProject };
}
