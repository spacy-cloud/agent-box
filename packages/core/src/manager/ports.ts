import { AboxError } from '../errors.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import type { NetworkMode, SandboxPortForward } from '../types.js';
import type { Internals, StoredEffective } from './internals.js';
import { requireNotTakenOver } from './takeover.js';
import type { Caller } from './types.js';
import { errMessage } from './util.js';

/**
 * Port forwards of a sandbox: `127.0.0.1:<hostPort>` on the machine running abox to a TCP port in
 * the sandbox, for previewing dev servers. The forward itself belongs to the backend (a sidecar
 * container, a QEMU rule): it must outlive the short-lived CLI, so the manager keeps no state of
 * its own and asks the backend (`listPortForwards`) whenever it needs to know. Opening goes through
 * `accessRequest` (kind `port`: policy, approval, audit); this module has the parts around it.
 */

export type PortApply = { kind: 'port'; sandboxPort: number; hostPort?: number };

/** The network mode a sandbox was created with (the backend decides what it can forward for). */
function networkModeOf(rec: SandboxRecord): NetworkMode {
  const eff = (rec.effective ?? {}) as Partial<StoredEffective>;
  return (eff.network?.mode ?? 'none') as NetworkMode;
}

/**
 * Fails with a clear message before anything is queued or opened when the sandbox cannot get a
 * forward: not running, a backend without forwards, a network mode without a path from the host.
 */
export async function assertPortApplicable(I: Internals, rec: SandboxRecord): Promise<void> {
  if (rec.state !== 'running') {
    throw new AboxError('conflict', `sandbox ${rec.id} is ${rec.state}, not running`, {
      hint:
        rec.state === 'stopped' || rec.state === 'created'
          ? 'Start it first (startSandbox / `abox start`); port forwards end when a sandbox stops.'
          : 'Port forwards need a running sandbox.',
    });
  }
  if (rec.isolation === 'none') {
    throw new AboxError(
      'unsupported',
      `sandbox ${rec.id} runs directly on the host (isolation none): there is nothing to forward`,
      {
        hint: 'A server in it already listens on the host network; open it at its own address (http://127.0.0.1:<port>/).',
      },
    );
  }
  const provider = await I.providerForRecord(rec);
  const caps = provider.capabilities();
  if (!provider.addPortForward || !caps.portForward || caps.portForward.length === 0) {
    throw new AboxError(
      'unsupported',
      `backend '${rec.backend}' cannot forward ports${caps.remote ? ' on a remote host' : ''}`,
      {
        hint: caps.remote
          ? 'Port forwards are not available on remote (ssh) hosts. Use a local sandbox for previews.'
          : 'Use a docker, podman or vm sandbox.',
      },
    );
  }
  const mode = networkModeOf(rec);
  if (!caps.portForward.includes(mode)) {
    throw new AboxError(
      'unsupported',
      `a sandbox with network mode "${mode}" cannot forward ports: it has no network path from this machine`,
      {
        hint:
          mode === 'none'
            ? 'Create the sandbox with network mode allowlist (with the destinations it really needs) or open: a sandbox with network none has no interface a forward could reach.'
            : `Port forwards work for network mode ${caps.portForward.join(', ')}.`,
      },
    );
  }
}

/** The open forwards of a sandbox; empty when there are none, the sandbox is not running or the backend cannot tell. */
export async function portsOf(I: Internals, rec: SandboxRecord): Promise<SandboxPortForward[]> {
  if (rec.state !== 'running' && rec.state !== 'expired' && rec.state !== 'stopped') return [];
  try {
    const provider = await I.providerForRecord(rec);
    if (!provider.listPortForwards) return [];
    return await provider.listPortForwards(rec.id);
  } catch {
    return [];
  }
}

export async function listPortForwards(
  I: Internals,
  caller: Caller,
  id: string,
): Promise<SandboxPortForward[]> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  return portsOf(I, rec);
}

export async function removePortForward(
  I: Internals,
  caller: Caller,
  id: string,
  sandboxPort: number,
): Promise<{ removed: boolean; port?: SandboxPortForward }> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  requireNotTakenOver(I, ctx, rec, 'sandbox.port.remove');
  if (!Number.isInteger(sandboxPort) || sandboxPort < 1 || sandboxPort > 65535) {
    throw new AboxError('invalid_input', `${String(sandboxPort)} is not a TCP port (1..65535)`);
  }
  const provider = await I.providerForRecord(rec);
  if (!provider.removePortForward) return { removed: false };
  const gone = await provider.removePortForward(rec.id, sandboxPort);
  if (!gone) return { removed: false };
  I.audit(ctx.owner, 'sandbox.port.remove', {
    sandboxId: rec.id,
    decision: 'allow',
    details: { reason: 'requested', ...summary(gone) },
  });
  I.emit('sandbox.ports', {
    sandboxId: rec.id,
    owner: rec.owner,
    data: { action: 'remove', sandboxPort },
  });
  return { removed: true, port: gone };
}

/** What the audit log keeps of a forward: ports and counts, never per-connection data. */
function summary(p: SandboxPortForward): Record<string, unknown> {
  return {
    sandboxPort: p.sandboxPort,
    hostPort: p.hostPort,
    ...(p.connections !== undefined ? { connections: p.connections } : {}),
    ...(p.rejected !== undefined ? { rejected: p.rejected } : {}),
    ...(p.failed !== undefined ? { failed: p.failed } : {}),
  };
}

/**
 * Called right before a sandbox is stopped, removed or found expired: the backend closes its
 * forwards with the sandbox, and this writes what they did (ports, connection counts) to the audit
 * log first, while they can still be asked. Best effort; never breaks the operation.
 */
export async function auditPortsClosing(
  I: Internals,
  rec: SandboxRecord,
  actor: string,
  reason: 'stop' | 'remove' | 'expired',
): Promise<void> {
  if (I.closed) return;
  try {
    const open = await portsOf(I, rec);
    if (open.length === 0) return;
    for (const p of open) {
      I.audit(actor, 'sandbox.port.close', {
        sandboxId: rec.id,
        decision: 'info',
        details: { reason, ...summary(p) },
      });
    }
    I.emit('sandbox.ports', {
      sandboxId: rec.id,
      owner: rec.owner,
      data: { action: 'close', reason },
    });
  } catch (e) {
    I.audit('system', 'sandbox.port.close', {
      sandboxId: rec.id,
      decision: 'error',
      details: { reason, message: errMessage(e) },
    });
  }
}
