import { AboxError } from '../errors.js';
import {
  applySetup,
  clientSpecs,
  detectSetupClients,
  planSetup,
  setupDirs,
  type ClientStatus,
  type SetupEnvironment,
  type SetupPlan,
  type SetupRequest,
  type SetupResult,
} from '../setup/index.js';
import type { Internals } from './internals.js';
import type { Caller } from './types.js';

/**
 * `abox setup`: registers the abox MCP server (and the rules) with the agents on this machine.
 * It writes outside abox's own directories, so it is human-only (`requireHuman`) and not part of
 * the MCP tool list, and applying it needs `humanConfirmed` plus the digest of the preview the
 * human looked at.
 */
function environment(I: Internals): SetupEnvironment {
  return {
    home: I.home,
    env: I.env,
    platform: process.platform,
    now: I.now,
    ...setupDirs(I.paths.dataDir),
  };
}

export async function setupDetect(
  I: Internals,
  caller: Caller,
  o: { command?: string } = {},
): Promise<ClientStatus[]> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'setup.detect');
  return detectSetupClients(environment(I), o.command);
}

export async function setupPlan(
  I: Internals,
  caller: Caller,
  req: SetupRequest,
): Promise<SetupPlan> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'setup.plan');
  const plan = await planSetup(environment(I), req);
  if (!plan.uninstall) {
    const specs = clientSpecs(environment(I));
    for (const id of req.clients) {
      const spec = specs[id];
      if (spec.supported && !Object.hasOwn(I.policy.contexts, spec.context)) {
        plan.warnings.push(
          `${spec.label}: the agent context "${spec.context}" is not defined in policy.yaml, so abox would deny the agent. Add it under "contexts:" (see "abox policy show").`,
        );
      }
    }
  }
  return plan;
}

export async function setupApply(
  I: Internals,
  caller: Caller,
  req: SetupRequest,
  digest: string,
): Promise<SetupResult> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'setup.apply');
  if (caller.humanConfirmed !== true) {
    throw new AboxError(
      'approval_required',
      'setup changes files outside abox and needs your confirmation',
      {
        hint: 'Show the preview (setupPlan), then repeat with humanConfirmed and the digest of that preview (CLI: --yes).',
      },
    );
  }
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new AboxError('invalid_input', 'the digest of the previewed plan is required');
  }
  let result: SetupResult;
  try {
    result = await applySetup(environment(I), req, digest);
  } catch (e) {
    I.audit(ctx.owner, 'setup.apply', {
      decision: 'deny',
      details: {
        clients: req.clients,
        uninstall: req.uninstall === true,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      },
    });
    throw e;
  }
  I.audit(ctx.owner, req.uninstall === true ? 'setup.uninstall' : 'setup.apply', {
    decision: result.ok ? 'allow' : 'deny',
    details: {
      clients: req.clients,
      digest: result.digest,
      steps: result.steps.map((s) => ({
        client: s.client,
        purpose: s.purpose,
        target: s.target.slice(0, 300),
        status: s.status,
      })),
      backups: result.backups.map((b) => b.path),
    },
  });
  return result;
}
