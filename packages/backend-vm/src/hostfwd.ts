import { createServer } from 'node:net';

/**
 * Port forwards of a VM through QEMU's user-mode networking (`hostfwd`). QEMU itself listens on
 * `127.0.0.1:<hostPort>` and connects to the guest's address (10.0.2.15) on `<guestPort>`, so the
 * forward needs no helper process, ends with the QEMU process and costs the guest nothing: it does
 * not change what the guest can reach (`restrict=on` of the allowlist mode only limits connections
 * the guest opens). The rules are added and removed at run time through the human monitor
 * (`hostfwd_add` / `hostfwd_remove` over QMP's `human-monitor-command`), because QMP has no command
 * of its own for them.
 */

/** The id of the user-mode netdev in `buildQemuArgs` (`-netdev user,id=n0`). */
export const NETDEV_ID = 'n0';

export interface HostForwardRule {
  hostPort: number;
  guestPort: number;
}

export const hostfwdAddLine = (hostPort: number, guestPort: number): string =>
  `hostfwd_add ${NETDEV_ID} tcp:127.0.0.1:${hostPort}-:${guestPort}`;
export const hostfwdRemoveLine = (hostPort: number): string =>
  `hostfwd_remove ${NETDEV_ID} tcp:127.0.0.1:${hostPort}`;

/**
 * The host forwards listed by `info usernet`, which prints one row per connection and per rule:
 * `TCP[HOST_FORWARD]  15  127.0.0.1 34567  10.0.2.15  5173  0  0`. Only rules on 127.0.0.1 count.
 */
export function parseUsernet(output: string): HostForwardRule[] {
  const rules: HostForwardRule[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+(\S+)\s+(\d+)\s+\S+\s+(\d+)\b/.exec(line);
    if (m?.[1] === '127.0.0.1') rules.push({ hostPort: Number(m[2]), guestPort: Number(m[3]) });
  }
  return rules.sort((a, b) => a.guestPort - b.guestPort);
}

/**
 * Did the monitor refuse a `hostfwd_add`? It answers with an empty string on success and a sentence
 * on failure (it is not a QMP error): `Could not set up host forwarding rule ...`. (`hostfwd_remove`
 * prints a sentence either way.)
 */
export function hostfwdFailed(output: string): boolean {
  return output.trim() !== '';
}

/** A port on 127.0.0.1 that is free right now (QEMU cannot pick one itself). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
