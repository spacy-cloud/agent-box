import type { Readable } from 'node:stream';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';

interface BuildEvent {
  stream?: string;
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
  aux?: { ID?: string };
}

type DockerWithProgress = Docker & {
  followProgress(
    stream: NodeJS.ReadableStream,
    onFinished: (err: Error | null, output: unknown[]) => void,
    onProgress?: (event: BuildEvent) => void,
  ): void;
};

/** Pull an image reference, forwarding progress lines. */
export async function pullImage(
  docker: Docker,
  ref: string,
  onProgress?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const stream = (await docker.pull(
    ref,
    signal ? { abortSignal: signal } : {},
  )) as unknown as NodeJS.ReadableStream;
  let last = '';
  let failure: string | undefined;
  await new Promise<void>((resolve, reject) => {
    (docker as DockerWithProgress).followProgress(
      stream,
      (err) =>
        err || failure !== undefined
          ? reject(err ?? Object.assign(new Error(failure), { statusCode: 404 }))
          : resolve(),
      (ev) => {
        if (ev.error) failure = ev.errorDetail?.message ?? ev.error;
        if (!onProgress || !ev.status) return;
        const line = `pull ${ref}: ${ev.status}`;
        if (line !== last) onProgress(line);
        last = line;
      },
    );
  });
}

/**
 * Build an image from a tar build context with the classic `/build` endpoint (works on Docker and
 * Podman). Rejects with `backend_error` carrying the tail of the build log on failure.
 */
export async function buildImage(
  docker: Docker,
  context: Readable | NodeJS.ReadableStream,
  opts: {
    tag: string;
    labels?: Record<string, string>;
    dockerfile?: string;
    nocache?: boolean;
    onProgress?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const stream = (await docker.buildImage(
    context as Readable,
    {
      t: opts.tag,
      rm: true,
      forcerm: true,
      ...(opts.dockerfile ? { dockerfile: opts.dockerfile } : {}),
      ...(opts.labels ? { labels: opts.labels } : {}),
      ...(opts.nocache ? { nocache: true } : {}),
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    } as Docker.ImageBuildOptions,
  )) as unknown as NodeJS.ReadableStream;

  const tail: string[] = [];
  let failure: string | undefined;
  const push = (text: string): void => {
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      if (line === '') continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
      opts.onProgress?.(line);
    }
  };
  await new Promise<void>((resolve, reject) => {
    (docker as DockerWithProgress).followProgress(
      stream,
      (err) => {
        if (err || failure !== undefined) {
          const msg = failure ?? err?.message ?? 'unknown error';
          reject(
            new AboxError('backend_error', `Image build failed: ${msg}`, {
              details: { tag: opts.tag, log: tail.join('\n') },
              hint: 'See details.log for the end of the build output.',
              ...(err ? { cause: err } : {}),
            }),
          );
        } else resolve();
      },
      (ev) => {
        if (ev.stream) push(ev.stream);
        else if (ev.error) {
          failure = ev.errorDetail?.message ?? ev.error;
          push(`ERROR: ${ev.error}`);
        } else if (ev.status) push(ev.status);
      },
    );
  });
}
