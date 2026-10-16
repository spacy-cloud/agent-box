/**
 * Manager-backed IPC handlers. Each handler is a thin call to one `Abox` operation as the context
 * `human`; there are no rules here (policy, approval, audit and masking all live in @abox/core).
 * Electron-specific handlers (dialogs, clipboard, app info) are in ipc.ts.
 */
import { readFile } from 'node:fs/promises';
import { AboxError, DEFAULT_POLICY_YAML } from '@abox/core';
import type { Abox, AboxPaths, AuditFilter, Caller, CreateSandboxRequest } from '@abox/core';
import type { z } from 'zod';
import type { IPC, IpcChannel } from '../shared/ipc';
import type { McpConfig, Outputs } from '../shared/types';
import { mcpClaudeCommand, mcpJsonConfig } from '../shared/mcp-config';

export interface ServiceRuntime {
  abox: Abox;
  paths: AboxPaths;
}

type Input<C extends IpcChannel> = z.output<(typeof IPC)[C]>;

export interface ServiceContext {
  onProgress?: (key: string, line: string) => void;
}

export type ManagerHandlers = {
  [C in ManagerChannel]: (input: Input<C>, ctx: ServiceContext) => Promise<Outputs[C]>;
};

/** Channels served by the manager alone (the rest needs Electron APIs). */
export type ManagerChannel =
  | 'sandboxes:list'
  | 'sandboxes:inspect'
  | 'sandboxes:start'
  | 'sandboxes:stop'
  | 'sandboxes:remove'
  | 'sandboxes:extend'
  | 'sandboxes:create'
  | 'templates:list'
  | 'templates:show'
  | 'files:list'
  | 'export:run'
  | 'processes:list'
  | 'processes:logs'
  | 'sandboxes:logs'
  | 'snapshots:list'
  | 'snapshots:create'
  | 'snapshots:restore'
  | 'approvals:list'
  | 'approvals:approve'
  | 'approvals:deny'
  | 'audit:query'
  | 'audit:verify'
  | 'policy:get'
  | 'policy:validate'
  | 'policy:set'
  | 'policy:revisions'
  | 'policy:revision'
  | 'doctor:run'
  | 'reconcile:run'
  | 'tokens:list'
  | 'tokens:create'
  | 'tokens:revoke'
  | 'mcp:config';

const HUMAN: Caller = { contextId: 'human' };
const confirmedHuman = (confirmed: boolean | undefined): Caller =>
  confirmed ? { contextId: 'human', humanConfirmed: true } : HUMAN;

/** Drops `undefined` members (the manager schemas are strict about unknown/undefined keys). */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function createManagerHandlers(rt: ServiceRuntime): ManagerHandlers {
  const { abox } = rt;

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
    'sandboxes:start': (i) => abox.startSandbox(HUMAN, i.id),
    'sandboxes:stop': (i) => abox.stopSandbox(HUMAN, i.id),
    'sandboxes:remove': (i) => abox.removeSandbox(HUMAN, i.id),
    'sandboxes:extend': (i) => abox.extendTtl(confirmedHuman(i.confirmed), i.id, i.ttl),
    'sandboxes:create': (i, ctx) => {
      const { confirmed, progressKey, ...req } = i;
      const request: CreateSandboxRequest = clean({
        ...req,
        workspace: req.workspace ? clean(req.workspace) : undefined,
        overrides: req.overrides
          ? clean({
              ...req.overrides,
              network: req.overrides.network ? clean(req.overrides.network) : undefined,
            })
          : undefined,
      });
      return abox.createSandbox(confirmedHuman(confirmed), request, {
        onProgress: (line) => {
          if (progressKey) ctx.onProgress?.(progressKey, line);
        },
      });
    },
    'templates:list': () => abox.listTemplates(HUMAN),
    'templates:show': (i) => abox.showTemplate(HUMAN, i.name),
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
      content: await abox.sandboxLogs(HUMAN, i.id, clean({ tail: i.tail ?? 300, sinceTs: i.sinceTs })),
    }),
    'snapshots:list': (i) => abox.listSnapshots(HUMAN, i.id),
    'snapshots:create': (i) => abox.snapshot(HUMAN, i.id, i.name),
    'snapshots:restore': (i) => abox.restore(HUMAN, i.id, i.snapshotId),
    'approvals:list': (i) => abox.listApprovals(HUMAN, clean({ ...(i ?? {}) })),
    'approvals:approve': (i) => abox.approve(HUMAN, i.id, i.note),
    'approvals:deny': (i) => abox.deny(HUMAN, i.id, i.note),
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
  };
}
