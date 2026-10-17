import type { Command } from 'commander';
import { AboxError, type Abox } from '@abox/core';
import type { Cli } from '../cli.js';
import { invalid, isLoopbackHost, parseListen } from '../parse.js';

/** What `@abox/mcp` exports for the CLI. */
interface McpModule {
  serveStdio?: (o: { abox: Abox; contextId: string }) => Promise<void>;
  serveHttp?: (o: {
    abox: Abox;
    host: string;
    port: number;
    onListening?: (address: { host: string; port: number; url?: string }) => void;
  }) => Promise<{ close(): Promise<void> | void }>;
}

export async function loadMcp(): Promise<McpModule> {
  try {
    return (await import('@abox/mcp')) as unknown as McpModule;
  } catch (e) {
    throw new AboxError('unsupported', `the MCP server is not available: ${(e as Error).message}`, {
      hint: 'Reinstall abox; @abox/mcp must be installed next to the CLI.',
    });
  }
}

export function registerMcp(program: Command, cli: Cli): void {
  const mcp = program.command('mcp').description('Model Context Protocol server for agents');

  mcp
    .command('serve')
    .description('Run the MCP server: stdio (the agent starts it) or --http on loopback')
    .option(
      '--http <host:port>',
      'serve Streamable HTTP on a loopback address, e.g. 127.0.0.1:8765 (token required)',
    )
    .option('--agent <context>', 'agent context from policy.yaml for stdio', 'default')
    .action(async (o: { http?: string; agent: string }) => {
      const mod = await loadMcp();
      if (o.http !== undefined) {
        const { host, port } = parseListen(o.http);
        if (!isLoopbackHost(host)) {
          throw invalid(
            `refusing to bind ${host}: the MCP HTTP server only listens on loopback`,
            'Use 127.0.0.1:PORT and put a tunnel or proxy in front of it if you need remote access.',
          );
        }
        if (!mod.serveHttp)
          throw new AboxError('unsupported', 'this build of @abox/mcp has no HTTP server');
        // HTTP: the context comes from the token of each request; the runtime context is irrelevant.
        const rt = await cli.rt();
        const signal = cli.abortSignal();
        const server = await mod.serveHttp({
          abox: rt.abox,
          host,
          port,
          onListening: (info) => {
            const url = info?.url ?? `http://${host}:${port}/mcp`;
            cli.err(
              `abox MCP server listening on ${url} (create tokens with "abox token create <context>"; Ctrl-C stops it)\n`,
            );
          },
        });
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await server.close();
        cli.interrupted = false;
        return;
      }
      if (!mod.serveStdio)
        throw new AboxError('unsupported', 'this build of @abox/mcp has no stdio server');
      const rt = await cli.rt({ contextId: o.agent });
      await mod.serveStdio({ abox: rt.abox, contextId: o.agent });
    });
}
