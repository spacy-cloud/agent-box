import { homedir } from 'node:os';
import { AboxError } from '../errors.js';
import type { AgentContext, Policy } from './model.js';
import { ANY_ROOT, canonicalizePath } from './paths.js';

export interface ResolveContextOptions {
  /** Home directory used to expand `~` in roots. Defaults to the current user's home. */
  home?: string;
}

/**
 * Resolves the rights of a context (who is asking). The context id comes from
 * the surface configuration (CLI = `human`; MCP = `--agent <id>` or an HTTP
 * token mapping), never from a field the agent controls.
 *
 * An unknown context id is denied (`policy_denied`) - there is no fallback
 * profile. Roots are canonicalized here (symlinks resolved) so the engine only
 * compares canonical paths.
 */
export function resolveContext(
  policy: Policy,
  contextId: string,
  opts: ResolveContextOptions = {},
): AgentContext {
  if (typeof contextId !== 'string' || !Object.hasOwn(policy.contexts, contextId)) {
    throw new AboxError('policy_denied', `unknown agent context "${String(contextId)}"`, {
      hint: 'Only a human can define agent contexts in policy.yaml (contexts: section).',
    });
  }
  const def = policy.contexts[contextId] as NonNullable<Policy['contexts'][string]>;
  const profile = Object.hasOwn(policy.profiles, def.profile)
    ? policy.profiles[def.profile]
    : undefined;
  if (!profile) {
    throw new AboxError(
      'policy_denied',
      `context "${contextId}" refers to unknown profile "${def.profile}"`,
    );
  }
  const home = opts.home ?? homedir();
  const canon = (roots: readonly string[]): string[] => [
    ...new Set(roots.map((r) => (r === ANY_ROOT ? r : canonicalizePath(r, { home, cwd: home })))),
  ];
  const kind = contextId === 'human' ? 'human' : 'agent';
  return {
    id: contextId,
    kind,
    profileName: profile.name,
    profile,
    owner: kind === 'human' ? 'human' : `agent:${contextId}`,
    allowedHosts: [...(def.hosts ?? profile.hosts)],
    workspaceRoots: canon(profile.workspace.roots),
    mountRoots: profile.mounts ? canon(profile.mounts.roots) : [],
  };
}
