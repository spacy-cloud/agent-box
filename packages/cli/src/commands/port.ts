import type { Command } from 'commander';
import {
  PORT_FORWARD_MAX_PORT,
  PORT_FORWARD_MIN_HOST_PORT,
  type SandboxPortForward,
} from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { renderTable, safe } from '../format.js';
import { resolveSandboxId } from '../ids.js';
import { invalid } from '../parse.js';

function parsePort(value: string, what: string, min = 1): number {
  const n = Number(value);
  if (!/^\d{1,5}$/.test(value.trim()) || n < min || n > PORT_FORWARD_MAX_PORT) {
    throw invalid(
      `${what}: expected a TCP port ${min}..${PORT_FORWARD_MAX_PORT}, got "${safe(value)}"`,
      min > 1
        ? `Host ports below ${PORT_FORWARD_MIN_HOST_PORT} are privileged and never bound; leave --host-port out to get a free port.`
        : undefined,
    );
  }
  return n;
}

function stateText(p: SandboxPortForward): string {
  return p.target === 'up' ? 'answering' : p.target === 'down' ? 'no server' : 'open';
}

function connectionsText(p: SandboxPortForward): string {
  if (p.connections === undefined) return '-';
  const extra = [
    p.rejected ? `${p.rejected} refused` : '',
    p.failed ? `${p.failed} failed` : '',
  ].filter(Boolean);
  return extra.length ? `${p.connections} (${extra.join(', ')})` : String(p.connections);
}

export function registerPort(program: Command, cli: Cli): void {
  const port = program
    .command('port')
    .description(
      'Preview a server of a sandbox in your browser: forward a sandbox port to 127.0.0.1 (TCP, loopback only)',
    );

  port
    .command('add')
    .description(
      'Forward a TCP port of a running sandbox to 127.0.0.1 on this machine and print the URL. ' +
        'Needs network mode allowlist or open (not none); the sandbox gets no new way out. ' +
        'The server in the sandbox must listen on 0.0.0.0. The forward ends when the sandbox stops',
    )
    .argument('<id>', 'sandbox id or name')
    .argument('<port>', 'TCP port the server listens on inside the sandbox')
    .option(
      '--host-port <n>',
      `port on 127.0.0.1 (${PORT_FORWARD_MIN_HOST_PORT}..${PORT_FORWARD_MAX_PORT}); default: a free one is picked`,
    )
    .action(async (ref: string, portArg: string, o: { hostPort?: string }) => {
      const sandboxPort = parsePort(portArg, '<port>');
      const hostPort =
        o.hostPort !== undefined
          ? parsePort(o.hostPort, '--host-port', PORT_FORWARD_MIN_HOST_PORT)
          : undefined;
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const r = await cli.confirmed(
        (caller) =>
          rt.abox.accessRequest(caller, id, {
            kind: 'port',
            details: { port: sandboxPort, ...(hostPort !== undefined ? { hostPort } : {}) },
          }),
        {},
      );
      if (r.status === 'pending_approval') {
        throw new CliError('approval_required', r.message, {
          details: { approvalId: r.approvalId, reasons: r.reasons },
        });
      }
      const fwd = r.port;
      if (!fwd) throw invalid('the backend did not report the forward');
      cli.success(
        { id, port: fwd, message: r.message },
        () =>
          [
            `forwarded ${id} port ${fwd.sandboxPort} -> ${fwd.url}`,
            ...(fwd.target === 'down'
              ? [
                  '  nothing answers on that port in the sandbox yet: start the server there and let it listen on 0.0.0.0 (not only 127.0.0.1)',
                ]
              : []),
            '  reachable on this machine only (127.0.0.1); closes when the sandbox stops, or with "abox port rm"',
          ].join('\n'),
        () => fwd.url,
      );
    });

  port
    .command('ls')
    .alias('list')
    .description('List the open port forwards of a sandbox')
    .argument('<id>', 'sandbox id or name')
    .action(async (ref: string) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const ports = await rt.abox.listPortForwards(cli.caller(), id);
      cli.success(
        { id, ports },
        () =>
          ports.length
            ? renderTable(
                [
                  { header: 'SANDBOX PORT' },
                  { header: 'URL' },
                  { header: 'STATE' },
                  { header: 'CONNECTIONS' },
                ],
                ports.map((p) => [String(p.sandboxPort), p.url, stateText(p), connectionsText(p)]),
              )
            : `no port forwards for ${id}`,
        () => ports.map((p) => `${p.sandboxPort} ${p.url}`).join('\n'),
      );
    });

  port
    .command('rm')
    .alias('remove')
    .description('Close the forward of a sandbox port')
    .argument('<id>', 'sandbox id or name')
    .argument('<port>', 'TCP port inside the sandbox')
    .action(async (ref: string, portArg: string) => {
      const sandboxPort = parsePort(portArg, '<port>');
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const r = await rt.abox.removePortForward(cli.caller(), id, sandboxPort);
      cli.success(
        { id, sandboxPort, removed: r.removed, ...(r.port ? { port: r.port } : {}) },
        () =>
          r.removed
            ? `closed the forward of ${id} port ${sandboxPort}${r.port?.connections !== undefined ? ` (${r.port.connections} connection(s) served)` : ''}`
            : `${id} port ${sandboxPort} was not forwarded`,
      );
    });
}
