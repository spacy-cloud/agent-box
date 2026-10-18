/**
 * "Open preview": opens a port forward of a sandbox in the default browser.
 *
 * The one place where the app hands a URL to the system (`shell.openExternal`). The renderer never names a
 * URL: it names a sandbox and the port inside it, this module asks the manager for the forwards that sandbox
 * really has open and builds the URL itself. A URL is only opened when it is exactly
 * `http://127.0.0.1:<host port>/` of one of those forwards: no other scheme, host, port, path, user info or
 * query, whatever the manager or the renderer claims. Kept free of Electron imports so it is unit-tested.
 */
import { AboxError } from '@abox/core';
import type { Abox, SandboxPortForward } from '@abox/core';
import {
  PORT_FORWARD_HOST_ADDRESS,
  PORT_FORWARD_MAX_PORT,
  PORT_FORWARD_MIN_HOST_PORT,
} from '../shared/constants';

const HUMAN = { contextId: 'human' };

type ForwardFacts = Pick<SandboxPortForward, 'hostAddress' | 'hostPort'>;

function validHostPort(p: unknown): p is number {
  return (
    typeof p === 'number' &&
    Number.isInteger(p) &&
    p >= PORT_FORWARD_MIN_HOST_PORT &&
    p <= PORT_FORWARD_MAX_PORT
  );
}

/** The only URL the preview of a forward can have; null when the forward is not a loopback forward on an allowed port. */
export function previewUrl(forward: ForwardFacts): string | null {
  if (forward.hostAddress !== PORT_FORWARD_HOST_ADDRESS || !validHostPort(forward.hostPort)) {
    return null;
  }
  return `http://${PORT_FORWARD_HOST_ADDRESS}:${forward.hostPort}/`;
}

/**
 * True only for the canonical preview URL of one of `forwards`. A string comparison on purpose: parsing would
 * normalise tricks such as `http://0x7f.1:5000`, `http://127.0.0.1.evil.example/` or `http://user@host/`
 * into something that looks harmless.
 */
export function isPreviewUrl(url: unknown, forwards: readonly ForwardFacts[]): boolean {
  if (typeof url !== 'string') return false;
  return forwards.some((f) => previewUrl(f) === url);
}

export interface PreviewDeps {
  abox: Pick<Abox, 'listPortForwards'>;
  /** `shell.openExternal` of Electron. */
  openExternal(url: string): Promise<void> | void;
}

/** Opens the forward of sandbox port `port` of sandbox `id`; refuses everything that is not an open forward of that sandbox. */
export async function openPreview(
  d: PreviewDeps,
  id: string,
  port: number,
): Promise<{ url: string }> {
  const forwards = await d.abox.listPortForwards(HUMAN, id);
  const forward = forwards.find((f) => f.sandboxPort === port);
  if (!forward) {
    throw new AboxError('not_found', `port ${port} of this sandbox is not forwarded`, {
      hint: 'Forward the port first. Forwards end when the sandbox stops.',
    });
  }
  const url = previewUrl(forward);
  if (url === null || !isPreviewUrl(url, forwards)) {
    throw new AboxError(
      'policy_denied',
      'the preview is only opened for 127.0.0.1 on this machine',
      {
        hint: 'Only forwards on the loopback address with a port from 1024 to 65535 can be opened.',
      },
    );
  }
  await d.openExternal(url);
  return { url };
}
