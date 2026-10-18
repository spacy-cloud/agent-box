import type { Command } from 'commander';
import type {
  AccessResult,
  NetworkDenials,
  NetworkLogEntry,
  NetworkLogView,
  NetworkPolicyProposal,
  SetPolicyResult,
} from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError } from '../errors.js';
import { formatTime, oneLine, renderKeyValues, renderTable, safe } from '../format.js';
import { resolveSandboxId } from '../ids.js';
import { parseSince, positiveInt } from '../parse.js';
import { unifiedDiff } from './policy.js';

const label = (host: string, port: number): string =>
  host === ''
    ? '(unreadable request)'
    : port === 443 || port === 80 || port < 1
      ? host
      : `${host}:${port}`;

/** The note `abox exec` prints when the proxy denied requests while the command ran. */
export function denialNote(id: string, n: NetworkDenials): string {
  const shown = n.hosts.slice(0, 3).map((h) => label(h.host, h.port));
  const more = n.hosts.length - shown.length + n.moreHosts;
  return `network: ${n.denied} request${n.denied === 1 ? '' : 's'} to ${oneLine(shown.join(', '))}${more > 0 ? ` and ${more} more` : ''} denied; see "abox network log ${id} --denied", allow with "abox network allow ${id} <domain>"`;
}

function decisionText(e: NetworkLogEntry): string {
  if (e.denied > 0 && e.allowedNow) return 'allowed now';
  return e.decision === 'deny' ? 'denied' : 'allowed';
}

function logText(cli: Cli, id: string, v: NetworkLogView): string {
  if (v.mode === 'none')
    return `sandbox ${id}: the network is off (mode none), so nothing is logged and nothing can be allowed.\nCreate a new sandbox with network mode allowlist if it needs the internet.`;
  if (v.mode === 'open')
    return `sandbox ${id}: the network is open (no proxy decides), so nothing is logged.`;
  if (v.entries.length === 0) return `sandbox ${id}: no network requests in the log`;
  const lines = [
    `sandbox ${id}: ${v.totals.denied} denied, ${v.totals.allowed} allowed request(s) to ${v.totals.destinations} destination(s)${v.truncated ? ' (older entries or more destinations were left out)' : ''}`,
    '',
    renderTable(
      [
        { header: 'DESTINATION', max: 60 },
        { header: 'DECISION' },
        { header: 'DENIED', right: true },
        { header: 'ALLOWED', right: true },
        { header: 'LAST SEEN' },
        { header: 'REASON', max: 80 },
      ],
      v.entries.map((e) => [
        label(e.host, e.port),
        decisionText(e),
        String(e.denied),
        String(e.allowed),
        formatTime(e.lastSeen),
        e.denied > 0 ? (e.reason ?? '') : '',
      ]),
      cli.width,
    ),
  ];
  const open = v.entries.filter((e) => e.allow?.possible === true);
  if (open.length > 0) {
    lines.push('', 'Allow a denied destination for this sandbox:');
    for (const e of open.slice(0, 5))
      lines.push(
        `  abox network allow ${id} ${e.allow!.pattern}${e.allow!.wildcard ? `   (all subdomains: '${e.allow!.wildcard}', use with care)` : ''}`,
      );
    if (open.length > 5) lines.push(`  ... and ${open.length - 5} more`);
    lines.push('  add --permanent to change the policy for every sandbox of the profile');
  }
  const blocked = v.entries.filter((e) => e.allow?.possible === false);
  for (const e of blocked.slice(0, 5))
    lines.push(`cannot be allowed here: ${safe(label(e.host, e.port))}: ${e.allow!.why}`);
  return lines.join('\n');
}

function accessText(r: AccessResult): string {
  if (r.status === 'applied') return r.message;
  return 'not applied';
}

export function registerNetwork(program: Command, cli: Cli): void {
  const net = program
    .command('network')
    .description('Egress log of an allowlist sandbox and allowing a denied destination');

  net
    .command('log')
    .description('Show what the egress proxy allowed and denied, grouped by destination')
    .argument('<sandbox>', 'sandbox id or name')
    .option('--denied', 'only denied requests')
    .option('--since <when>', 'only newer requests: a duration (10m, 2h) or an ISO date')
    .option('--limit <n>', 'at most N destinations (most recently seen first)', '200')
    .action(async (ref: string, o: { denied?: boolean; since?: string; limit: string }) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const view = await rt.abox.networkLog(cli.caller(), id, {
        ...(o.denied ? { denied: true } : {}),
        ...(o.since ? { since: parseSince(o.since, Date.now()) } : {}),
        limit: positiveInt(o.limit, '--limit'),
      });
      cli.success(view, () => logText(cli, id, view));
    });

  net
    .command('allow')
    .description(
      'Allow destinations for one sandbox (default) or, with --permanent, in the policy of its owner',
    )
    .argument('<sandbox>', 'sandbox id or name')
    .argument('<destination...>', 'host name, host:port or *.example.org (all subdomains)')
    .option(
      '--permanent',
      "also add the destinations to network.allow of the owner's profile in policy.yaml (shown as a diff and confirmed first)",
    )
    .option('-y, --yes', 'confirm without asking')
    .addHelpText(
      'after',
      `
Without --permanent only this sandbox changes: its proxy is updated live and policy.yaml stays as it is.
IP addresses, names of the local machine or internal networks and cloud metadata services are never allowed;
the proxy refuses private addresses whatever the allowlist says. A sandbox with network mode none or open has
nothing to allow. A wildcard (*.example.org) covers every subdomain and always asks for confirmation.
`,
    )
    .action(
      async (ref: string, destinations: string[], o: { permanent?: boolean; yes?: boolean }) => {
        const id = await resolveSandboxId(cli, ref);
        const rt = await cli.rt();
        const input = { destinations };
        let policy: SetPolicyResult | undefined;
        let proposal: NetworkPolicyProposal | undefined;
        if (o.permanent) {
          proposal = await rt.abox.proposeNetworkPolicy(cli.caller(), id, input);
          if (proposal.proposed === null) {
            if (!cli.json && !cli.quiet)
              cli.err(
                `profile "${safe(proposal.profile)}" already allows ${proposal.alreadyAllowed.map(safe).join(', ')}; policy.yaml stays as it is\n`,
              );
          } else {
            if (!cli.json) {
              cli.out(
                `${renderKeyValues([
                  [
                    'profile',
                    `${proposal.profile} (used by: ${proposal.usedBy.join(', ') || 'no context'})`,
                  ],
                  ['network.allow +', proposal.added.join(', ')],
                ])}\n\n${await unifiedDiff(rt.paths.policyFile, proposal.current, proposal.proposed)}\n`,
              );
            }
            let go = o.yes === true;
            if (!go) {
              if (!cli.interactive) {
                throw new CliError(
                  'approval_required',
                  'changing the policy needs your confirmation',
                  {
                    hint: 'Run in a terminal or pass --yes.',
                    details: { profile: proposal.profile, added: proposal.added },
                  },
                );
              }
              go = await cli.confirm(
                `Save this policy (affects every sandbox and agent that uses profile "${proposal.profile}")?`,
              );
            }
            if (!go) {
              cli.out('not saved\n');
              return;
            }
            policy = await rt.abox.setPolicy(cli.caller(), proposal.proposed, {
              baseHash: proposal.baseHash,
            });
          }
        }
        const r = await cli.confirmed((caller) => rt.abox.allowNetwork(caller, id, input), {
          yes: o.yes,
        });
        if (r.status === 'pending_approval') {
          throw new CliError('approval_required', r.message, {
            details: { approvalId: r.approvalId, reasons: r.reasons },
          });
        }
        cli.success({ access: r, ...(policy ? { policy } : {}), destinations }, () =>
          [
            policy
              ? `policy saved (revision ${policy.revision}, hash ${policy.contentHash.slice(0, 16)}): ${proposal!.added.join(', ')} added to profile ${proposal!.profile}`
              : undefined,
            `${safe(accessText(r))}${o.permanent ? '' : ' (this sandbox only; policy.yaml unchanged)'}`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      },
    );
}
