/**
 * Manager-backed IPC handlers. Each handler is a thin call to one `Abox` operation as the context
 * `human`; there are no rules here (policy, approval, audit and masking all live in @abox/core).
 * Electron-specific handlers (dialogs, clipboard, app info) are in ipc.ts.
 */
import { readFile } from 'node:fs/promises';
import { AboxError, DEFAULT_POLICY_YAML } from '@abox/core';
import type {
  Abox,
  AboxPaths,
  AuditFilter,
  Caller,
  CreateSandboxRequest,
  ProgressInfo,
} from '@abox/core';
import type { z } from 'zod';
import type { IPC, IpcChannel } from '../shared/ipc';
import type { McpConfig, McpContextStatus, McpStatus, Outputs } from '../shared/types';
import { mcpClaudeCommand, mcpJsonConfig } from '../shared/mcp-config';
import { describeBase } from '../shared/image-ref';
import { templateTarget } from './approval-context';
import { projectOption, resolveProjectDir } from './projects';

export interface ServiceRuntime {
  abox: Abox;
  paths: AboxPaths;
}

type Input<C extends IpcChannel> = z.output<(typeof IPC)[C]>;

export interface ServiceContext {
  onProgress?: (key: string, line: string, info?: ProgressInfo) => void;
}

export type ManagerHandlers = {
  [C in ManagerChannel]: (input: Input<C>, ctx: ServiceContext) => Promise<Outputs[C]>;
};

/** Channels served by the manager alone (the rest needs Electron APIs). */
export type ManagerChannel =
  | 'sandboxes:list'
  | 'sandboxes:inspect'
  | 'sandboxes:stats'
  | 'sandboxes:start'
  | 'sandboxes:stop'
  | 'sandboxes:remove'
  | 'sandboxes:extend'
  | 'sandboxes:create'
  | 'workspace:estimate'
  | 'jobs:cancel'
  | 'capacity:host'
  | 'capacity:estimate'
  | 'templates:list'
  | 'templates:suggest'
  | 'templates:show'
  | 'templates:review'
  | 'files:list'
  | 'export:run'
  | 'processes:list'
  | 'processes:logs'
  | 'sandboxes:logs'
  | 'network:log'
  | 'network:allow'
  | 'network:propose'
  | 'snapshots:list'
  | 'snapshots:create'
  | 'snapshots:restore'
  | 'ports:list'
  | 'ports:add'
  | 'ports:remove'
  | 'approvals:list'
  | 'approvals:approve'
  | 'approvals:deny'
  | 'approvals:templateReview'
  | 'approvals:image'
  | 'audit:query'
  | 'audit:verify'
  | 'policy:get'
  | 'policy:validate'
  | 'policy:set'
  | 'policy:revisions'
  | 'policy:revision'
  | 'doctor:run'
  | 'caches:list'
  | 'caches:remove'
  | 'reconcile:run'
  | 'tokens:list'
  | 'tokens:create'
  | 'tokens:revoke'
  | 'mcp:config'
  | 'mcp:status';

const HUMAN: Caller = { contextId: 'human' };
const confirmedHuman = (confirmed: boolean | undefined): Caller =>
  confirmed ? { contextId: 'human', humanConfirmed: true } : HUMAN;

/** Drops `undefined` members (the manager schemas are strict about unknown/undefined keys). */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function createManagerHandlers(rt: ServiceRuntime): ManagerHandlers {
  const { abox } = rt;

  /** Running cancellable calls (`sandboxes:create`, `workspace:estimate`) by the key the renderer chose. */
  const jobs = new Map<string, AbortController>();
  async function cancellable<T>(
    key: string | undefined,
    run: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    if (!key) return run(undefined);
    // a repeated key replaces (and cancels) the older call: the renderer only wants the latest answer
    jobs.get(key)?.abort();
    const ctl = new AbortController();
    jobs.set(key, ctl);
    try {
      return await run(ctl.signal);
    } finally {
      if (jobs.get(key) === ctl) jobs.delete(key);
    }
  }

  async function policyText(): Promise<{
    text: string;
    source: 'default' | 'file';
    path: string | null;
  }> {
    const view = await abox.showPolicy(HUMAN);
    if (view.policy.source === 'file' && view.policy.path) {
      try {
        return {
          text: await readFile(view.policy.path, 'utf8'),
          source: 'file',
          path: view.policy.path,
        };
      } catch {
        /* file vanished between calls: fall through to the built-in text */
      }
    }
    return { text: DEFAULT_POLICY_YAML, source: 'default', path: null };
  }

  return {
    'sandboxes:list': (i) => abox.listSandboxes(HUMAN, clean({ ...(i ?? {}) })),
    'sandboxes:inspect': (i) => abox.inspectSandbox(HUMAN, i.id),
    'sandboxes:stats': (i) => abox.sandboxStats(HUMAN, i.ids),
    'sandboxes:start': (i) => abox.startSandbox(HUMAN, i.id),
    'sandboxes:stop': (i) => abox.stopSandbox(HUMAN, i.id),
    'sandboxes:remove': (i) => abox.removeSandbox(HUMAN, i.id),
    'sandboxes:extend': (i) => abox.extendTtl(confirmedHuman(i.confirmed), i.id, i.ttl),
    'sandboxes:create': async (i, ctx) => {
      const { confirmed, progressKey, projectDir, cache, ...req } = i;
      const request: CreateSandboxRequest = clean({
        ...req,
        // only the opt-out is sent: absent means "use the template's caches where policy allows"
        cache: cache === false ? false : undefined,
        ...(await projectOption(projectDir)),
        workspace: req.workspace ? clean(req.workspace) : undefined,
        overrides: req.overrides
          ? clean({
              ...req.overrides,
              network: req.overrides.network ? clean(req.overrides.network) : undefined,
            })
          : undefined,
      });
      return cancellable(progressKey, (signal) =>
        abox.createSandbox(confirmedHuman(confirmed), request, {
          ...(signal ? { signal } : {}),
          onProgress: (line, info) => {
            if (progressKey) ctx.onProgress?.(progressKey, line, info);
          },
        }),
      );
    },
    'workspace:estimate': (i, ctx) => {
      const { progressKey, ...req } = i;
      return cancellable(progressKey, (signal) =>
        abox.estimateWorkspace(HUMAN, clean(req), {
          ...(signal ? { signal } : {}),
          onProgress: (line, info) => {
            if (progressKey) ctx.onProgress?.(progressKey, line, info);
          },
        }),
      );
    },
    'capacity:host': (i) => abox.hostCapacity(HUMAN, i.id),
    'capacity:estimate': (i) =>
      abox.estimateFit(
        HUMAN,
        clean({
          hostId: i.host,
          template: i.template,
          overrides: i.overrides ? clean(i.overrides) : undefined,
          projectDir: i.projectDir,
          workspacePath: i.workspacePath,
        }),
      ),
    'jobs:cancel': async (i) => {
      const ctl = jobs.get(i.key);
      ctl?.abort();
      return { cancelled: ctl !== undefined };
    },
    'templates:list': async (i) => abox.listTemplates(HUMAN, await projectOption(i?.projectDir)),
    // read-only: file names of the project folder only; the folder is checked like any project folder first
    'templates:suggest': async (i) =>
      abox.suggestTemplate(HUMAN, { path: await resolveProjectDir(i.path) }),
    'templates:show': async (i) =>
      abox.showTemplate(HUMAN, i.name, await projectOption(i.projectDir)),
    'templates:review': async (i) =>
      abox.reviewTemplate(
        HUMAN,
        i.name,
        clean({ workspacePath: i.workspacePath, ...(await projectOption(i.projectDir)) }),
      ),
    'files:list': (i) => abox.listDir(HUMAN, i.id, i.path),
    'export:run': (i) =>
      abox.exportSandbox(
        HUMAN,
        i.id,
        clean({ format: i.format, paths: i.paths, branchName: i.branchName }),
      ),
    'processes:list': (i) => abox.listProcesses(HUMAN, i.id),
    'processes:logs': (i) => abox.processLogs(HUMAN, i.processId, clean({ tail: i.tail ?? 200 })),
    'sandboxes:logs': async (i) => ({
      content: await abox.sandboxLogs(
        HUMAN,
        i.id,
        clean({ tail: i.tail ?? 300, sinceTs: i.sinceTs }),
      ),
    }),
    'network:log': (i) =>
      abox.networkLog(HUMAN, i.id, clean({ since: i.since, denied: i.denied, limit: i.limit })),
    'network:allow': (i) =>
      abox.allowNetwork(confirmedHuman(i.confirmed), i.id, { destinations: i.destinations }),
    'network:propose': (i) =>
      abox.proposeNetworkPolicy(HUMAN, i.id, { destinations: i.destinations }),
    'snapshots:list': (i) => abox.listSnapshots(HUMAN, i.id),
    'snapshots:create': (i) => abox.snapshot(HUMAN, i.id, i.name),
    'snapshots:restore': (i) => abox.restore(HUMAN, i.id, i.snapshotId),
    'ports:list': (i) => abox.listPortForwards(HUMAN, i.id),
    'ports:add': (i) =>
      abox.accessRequest(confirmedHuman(i.confirmed), i.id, {
        kind: 'port',
        details: { port: i.port, ...(i.hostPort !== undefined ? { hostPort: i.hostPort } : {}) },
      }),
    'ports:remove': (i) => abox.removePortForward(HUMAN, i.id, i.port),
    'approvals:list': (i) => abox.listApprovals(HUMAN, clean({ ...(i ?? {}) })),
    'approvals:approve': (i) => abox.approve(HUMAN, i.id, i.note),
    'approvals:deny': (i) => abox.deny(HUMAN, i.id, i.note),
    'approvals:templateReview': async (i) => {
      const a = await abox.getApproval(HUMAN, i.id);
      const target = a.kind === 'template_trust' ? templateTarget(a.request) : undefined;
      if (!target) {
        throw new AboxError('invalid_input', 'this approval is not about trusting a template');
      }
      // The same call as `abox approvals show`: the hash from the request flags a file changed since.
      return abox.reviewTemplate(
        HUMAN,
        target.name,
        clean({ projectDir: target.projectDir, expectedContentHash: target.contentHash }),
      );
    },
    'approvals:image': async (i) => {
      const a = await abox.getApproval(HUMAN, i.id);
      const target = templateTarget(a.request);
      if (!target) return null;
      const view = await abox.showPolicy(HUMAN);
      const profile = target.profile ? view.profiles?.[target.profile] : undefined;
      const registries = profile ? profile.images.registries : null;
      if (a.base) {
        // The base is part of the request the approval is bound to: nothing to resolve again.
        const use = describeBase(a.base, target.backend, registries);
        return use && use.source === 'image' && a.base.registry
          ? { ...use, registry: a.base.registry }
          : (use ?? null);
      }
      // An approval stored before the base was recorded: look the template up again, but only trust it
      // while the file still has the content the approval was requested for.
      let details;
      try {
        details = await abox.showTemplate(
          HUMAN,
          target.name,
          clean({ projectDir: target.projectDir }),
        );
      } catch {
        return null; // the template is gone or not reachable from here: nothing to show
      }
      const tpl = details.template;
      if (target.contentHash !== undefined && tpl.contentHash !== target.contentHash) return null;
      return describeBase(tpl.base, tpl.backend, registries) ?? null;
    },
    'audit:query': (i) => abox.queryAudit(HUMAN, clean({ ...(i ?? {}) }) as AuditFilter),
    'audit:verify': () => abox.verifyAudit(HUMAN),
    'policy:get': async () => {
      const [view, doc] = await Promise.all([abox.showPolicy(HUMAN), policyText()]);
      return { view, text: doc.text, source: doc.source, path: doc.path };
    },
    'policy:validate': async (i) => abox.validatePolicy(i.text),
    'policy:set': async (i) => {
      if (i.baseHash !== undefined && abox.policyHash !== i.baseHash) {
        throw new AboxError('conflict', 'policy.yaml changed while it was being edited', {
          hint: 'Reload the policy view, redo your change on the current version, and save again.',
        });
      }
      return abox.setPolicy(HUMAN, i.text);
    },
    'policy:revisions': async () => {
      const list = await abox.listPolicyRevisions(HUMAN);
      return [...list].sort((a, b) => b.rev - a.rev);
    },
    'policy:revision': (i) => abox.getPolicyRevision(HUMAN, i.rev),
    'doctor:run': () => abox.doctor(HUMAN),
    'caches:list': () => abox.listCaches(HUMAN, { size: true }),
    'caches:remove': (i) =>
      abox.removeCaches(
        HUMAN,
        'keys' in i
          ? clean({ keys: i.keys, host: i.host })
          : clean({ all: true as const, host: i.host }),
      ),
    'reconcile:run': (i) => abox.reconcile(HUMAN, clean({ ...(i ?? {}) })),
    'tokens:list': () => abox.listAgentTokens(HUMAN),
    'tokens:create': async (i) => {
      const { token, ...view } = await abox.createAgentToken(HUMAN, i.contextId, i.label);
      return { token, view };
    },
    'tokens:revoke': (i) => abox.revokeAgentToken(HUMAN, i.id),
    'mcp:config': async (i) => {
      const view = await abox.showPolicy(HUMAN);
      const contexts = Object.keys(view.contexts ?? {})
        .filter((c) => c !== 'human')
        .sort();
      const agent = i?.agent ?? contexts[0] ?? 'default';
      const cfg: McpConfig = {
        agent,
        claudeCommand: mcpClaudeCommand(agent),
        json: mcpJsonConfig(agent),
        contexts,
      };
      return cfg;
    },
    'mcp:status': async (): Promise<McpStatus> => {
      // The MCP server is a process of its own (stdio per agent, or HTTP with tokens): the manager keeps no
      // "running" flag. What is observable is who is configured, which tokens exist and when each agent last acted.
      const [view, tokens] = await Promise.all([
        abox.showPolicy(HUMAN),
        abox.listAgentTokens(HUMAN),
      ]);
      const ids = Object.keys(view.contexts ?? {})
        .filter((c) => c !== 'human')
        .sort();
      const contexts: McpContextStatus[] = [];
      for (const id of ids) {
        const last = (
          await abox.queryAudit(HUMAN, { actor: `agent:${id}`, limit: 1, order: 'desc' })
        )[0];
        const mine = tokens.filter((k) => k.contextId === id);
        const active = mine.filter((k) => k.revokedAt === null);
        const used = mine.map((k) => k.lastUsedAt ?? 0).reduce((a, b) => Math.max(a, b), 0);
        contexts.push({
          id,
          profile: view.contexts?.[id]?.profile ?? '',
          lastActivityAt: last?.ts ?? null,
          lastAction: last?.action ?? null,
          lastDecision: last?.decision ?? null,
          activeTokens: active.length,
          lastTokenUseAt: used > 0 ? used : null,
        });
      }
      const lastUsed = tokens.map((k) => k.lastUsedAt ?? 0).reduce((a, b) => Math.max(a, b), 0);
      return {
        contexts,
        tokens: {
          active: tokens.filter((k) => k.revokedAt === null).length,
          revoked: tokens.filter((k) => k.revokedAt !== null).length,
          lastUsedAt: lastUsed > 0 ? lastUsed : null,
        },
        lastActivityAt: contexts.reduce<number | null>(
          (a, c) =>
            c.lastActivityAt !== null && (a === null || c.lastActivityAt > a)
              ? c.lastActivityAt
              : a,
          null,
        ),
      };
    },
  };
}
