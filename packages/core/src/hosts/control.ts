import { run } from './exec.js';
import type { HostProfile } from './model.js';
import { buildSshArgs, sshBinary, type HostsEnv } from './ssh-args.js';

/**
 * Stops the ControlMaster connection that batch/interactive calls left behind for this host
 * (`ssh -O exit`). Returns false when no master was running. Call it before security-relevant
 * re-checks (e.g. after a host key change) and on shutdown.
 */
export async function closeSshConnection(profile: HostProfile, env: HostsEnv): Promise<boolean> {
  const args = buildSshArgs(profile, env, { mode: 'batch' });
  const dd = args.indexOf('--');
  const res = await run(sshBinary(env), [...args.slice(0, dd), '-O', 'exit', ...args.slice(dd)], {
    timeoutMs: 10_000,
  });
  if (res.code === 0)
    env.audit?.('host.connection.close', {
      host: profile.id,
      user: profile.user,
      kind: 'control-master',
    });
  return res.code === 0;
}
