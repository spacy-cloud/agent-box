import { AboxError, isAboxError } from '@abox/core';
import type { Abox } from '@abox/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';
import { assertAgentContextId, createMcpServer } from './server.js';
import { MAX_MESSAGE_BYTES } from './limits.js';
import { startTtlWatch, warnOnPolicyProblems, type McpLimits } from './runtime.js';
import { MessageSizeGuard, oversizedResponse } from './stdio-guard.js';

/**
 * Refuse to start for a context that is not an agent context of the current policy. (`human` is never
 * acceptable: the MCP server must not be able to act with the human's rights.)
 */
export async function assertAgentContext(abox: Abox, contextId: string): Promise<void> {
  try {
    assertAgentContextId(contextId);
  } catch (e) {
    throw new AboxError('invalid_input', e instanceof Error ? e.message : String(e), {
      hint: 'Start the server with --agent <id> where <id> is a context in policy.yaml (contexts:).',
    });
  }
  try {
    const view = await abox.showPolicy({ contextId });
    if (view.kind !== 'agent') throw new Error('not an agent context');
  } catch (e) {
    if (isAboxError(e) && e.code === 'policy_denied') {
      throw new AboxError(
        'policy_denied',
        `agent context "${contextId.slice(0, 64)}" is not defined in policy.yaml`,
        {
          hint: 'Ask the human to add it under contexts: in policy.yaml (abox policy edit), then start the server again.',
        },
      );
    }
    if (isAboxError(e)) throw e;
    throw new AboxError('policy_denied', `"${contextId.slice(0, 64)}" is not an agent context`, {
      hint: 'Use --agent with an agent context from policy.yaml.',
    });
  }
}

export interface ServeStdioOptions {
  abox: Abox;
  /** Agent context (from `--agent`). Must exist in the policy and must not be `human`. */
  contextId: string;
  limits?: McpLimits;
  /** How often expired sandboxes are stopped in the background, ms (default 15 s, 0 = never). */
  ttlWatchMs?: number;
  /** Tests only. Default: process.stdin / process.stdout. */
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Serve MCP over stdio for one agent context. Resolves when the transport closes (client gone / stdin
 * ended). Never writes to stdout except protocol messages; diagnostics go to stderr.
 */
export async function serveStdio(opts: ServeStdioOptions): Promise<void> {
  await assertAgentContext(opts.abox, opts.contextId);
  const stdin = opts.stdin ?? process.stdin;
  const server = createMcpServer({
    abox: opts.abox,
    contextId: opts.contextId,
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  // One message above the limit must not end the connection (the SDK reader would close it): refuse
  // that message with an error answer and carry on.
  const stdout = opts.stdout ?? process.stdout;
  const guard = new MessageSizeGuard(MAX_MESSAGE_BYTES, (info) => {
    process.stderr.write(
      `abox-mcp: refused a message of ${info.bytes} bytes (limit ${MAX_MESSAGE_BYTES})\n`,
    );
    const answer = oversizedResponse(info, MAX_MESSAGE_BYTES);
    if (answer) stdout.write(`${JSON.stringify(answer)}\n`);
  });
  stdin.pipe(guard);
  const transport = new StdioServerTransport(guard, stdout, {
    maxBufferSize: MAX_MESSAGE_BYTES + 1024 * 1024,
  });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  transport.onerror = (e) => {
    process.stderr.write(`abox-mcp: transport error: ${e.message}\n`);
  };
  await server.connect(transport);
  const stopTtlWatch = startTtlWatch(opts.abox, opts.ttlWatchMs);
  const stopPolicyWarn = warnOnPolicyProblems(opts.abox);
  const onEnd = (): void => {
    void server.close().catch(() => undefined);
  };
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);
  try {
    await closed;
  } finally {
    stopTtlWatch();
    stopPolicyWarn();
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
    stdin.unpipe(guard);
    guard.destroy();
  }
}
