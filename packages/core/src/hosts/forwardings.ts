import { AboxError } from '../errors.js';
import { run } from './exec.js';

/** One forwarding as `ssh -G` prints it. */
export interface EffectiveForward {
  kind: 'localforward' | 'remoteforward' | 'dynamicforward';
  /** The rest of the line, e.g. `/run/abox/x.sock /run/user/1000/podman/podman.sock`. */
  value: string;
}

/** Pure: the forwardings in the output of `ssh -G`. */
export function parseForwardings(stdout: string): EffectiveForward[] {
  const out: EffectiveForward[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(localforward|remoteforward|dynamicforward)\s+(.*)$/.exec(line.trim());
    if (m) out.push({ kind: m[1] as EffectiveForward['kind'], value: m[2]!.trim() });
  }
  return out;
}

/**
 * Pure: forwardings in `effective` that are not one of the explicit `-L local:remote` socket
 * forwards abox asked for. Everything else comes from the user's ssh config (`LocalForward`,
 * `RemoteForward`, `DynamicForward`).
 *
 * OpenSSH prints a stream-local `-L a.sock:b.sock` as `localforward a.sock b.sock` and, in the
 * versions observed (10.x), also as `dynamicforward a.sock`; the second form is accepted when it
 * belongs to one of our own listen paths.
 */
export function unexpectedForwardings(
  effective: readonly EffectiveForward[],
  expected: ReadonlyArray<{ flag: '-L' | '-R' | '-D'; spec: string }>,
): EffectiveForward[] {
  const local = new Set<string>();
  const listen = new Set<string>();
  for (const f of expected) {
    if (f.flag !== '-L') continue;
    const i = f.spec.indexOf(':');
    if (i > 0) {
      listen.add(f.spec.slice(0, i));
      local.add(`${f.spec.slice(0, i)} ${f.spec.slice(i + 1)}`);
    }
  }
  return effective.filter((e) => {
    if (e.kind === 'localforward') return !local.has(e.value);
    if (e.kind === 'dynamicforward') return !listen.has(e.value);
    return true;
  });
}

/**
 * Refuses to start an ssh whose configuration forwards something abox did not ask for.
 *
 * The engine tunnel needs its own `-L`, so `ClearAllForwardings=yes` cannot be used (ssh would
 * clear the command-line forwards too). Instead `ssh -G` reports what this exact command line
 * would forward, and a `RemoteForward` (a way back into this machine for whoever controls the
 * server) or any other forward from `~/.ssh/config` fails the start. Does not connect.
 */
export async function verifyForwardings(
  sshBinary: string,
  args: readonly string[],
  expected: ReadonlyArray<{ flag: '-L' | '-R' | '-D'; spec: string }>,
  hostId: string,
): Promise<void> {
  let res;
  try {
    res = await run(sshBinary, ['-G', ...args], { timeoutMs: 10_000 });
  } catch (e) {
    throw new AboxError('backend_unavailable', `cannot run ssh: ${(e as Error).message}`, {
      hint: 'Install the OpenSSH client.',
      cause: e,
    });
  }
  if (res.code !== 0) {
    throw new AboxError(
      'invalid_input',
      `ssh -G failed for host "${hostId}": ${res.stderr.trim().split('\n')[0] ?? ''}`,
    );
  }
  const extra = unexpectedForwardings(parseForwardings(res.stdout), expected);
  if (extra.length > 0) {
    throw new AboxError(
      'invalid_input',
      `the ssh configuration of host "${hostId}" defines port forwards (${extra
        .map((e) => `${e.kind} ${e.value}`)
        .join('; ')}); abox only forwards the engine socket`,
      {
        hint: 'Remove LocalForward/RemoteForward/DynamicForward from the Host entry (or from a Host * block) in your ssh config, or give the sandbox host its own Host entry without forwards.',
        details: { reason: 'config_forwards', host: hostId },
      },
    );
  }
}
