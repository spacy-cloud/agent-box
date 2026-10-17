import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { sandboxNameFor } from '../plugin/lib/worktree.mjs';
import { PLUGIN_DIR } from './helpers.js';

const html = readFileSync(join(PLUGIN_DIR, 'panel', 'index.html'), 'utf8');

interface Ctx {
  branch: string;
  displayName: string;
  terminals: Array<{ id: string }>;
}
interface Request {
  type: string;
  requestId: string;
  action: string;
  params?: Record<string, unknown>;
}

const open: JSDOM[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.window.close();
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * Loads the panel document and plays the host: answers every `orca-panel-action` request on the
 * postMessage bridge the way Orca's PluginPanel host does (same message types, same result shape).
 */
async function loadPanel(
  opts: { language?: string; context?: Ctx | null; reply?: (r: Request) => unknown } = {},
) {
  const requests: Request[] = [];
  let context =
    opts.context === undefined
      ? ({
          branch: 'feat/login',
          displayName: 'feat/login',
          terminals: [{ id: 'terminal-handle-0001' }],
        } as Ctx)
      : opts.context;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window: Window & typeof globalThis) {
      Object.defineProperty(window.navigator, 'language', {
        value: opts.language ?? 'en-US',
        configurable: true,
      });
      window.addEventListener('message', (ev: MessageEvent) => {
        const d = ev.data as Request;
        if (!d || d.type !== 'orca-panel-action') return;
        requests.push(d);
        let value: unknown;
        if (opts.reply) value = opts.reply(d);
        else if (d.action === 'workspace.readContext') value = context;
        else if (d.action === 'terminal.sendText') value = { accepted: true };
        window.postMessage(
          { type: 'orca-panel-action-result', requestId: d.requestId, ok: true, value },
          '*',
        );
      });
    },
  });
  open.push(dom);
  await tick();
  const doc = dom.window.document as Document;
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const click = async (el: Element) => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
  };
  const type = async (id: string, value: string) => {
    const el = $<HTMLInputElement>(id);
    el.value = value;
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick(5);
  };
  const sent = () => requests.filter((r) => r.action === 'terminal.sendText');
  return {
    dom,
    doc,
    $,
    click,
    type,
    sent,
    requests,
    cmd: (name: string) => doc.querySelector(`[data-cmd="${name}"]`)!,
    status: () => $('status').textContent,
    preview: () => $('preview').textContent,
    setContext: (c: Ctx | null) => (context = c),
    refresh: async () => {
      await click($('refresh'));
    },
  };
}

describe('Sandboxes panel', () => {
  it('reads the focused worktree through the bridge and offers its terminals', async () => {
    const p = await loadPanel();
    expect(p.requests[0]).toMatchObject({
      type: 'orca-panel-action',
      action: 'workspace.readContext',
    });
    expect(p.$('wt').textContent).toBe('feat/login');
    const options = [...p.$<HTMLSelectElement>('terminal').options];
    expect(options).toHaveLength(1);
    expect(options[0]?.value).toBe('terminal-handle-0001');
    expect(p.$<HTMLInputElement>('sid').value).toBe('wt-feat-login');
  });

  it('types commands into the chosen terminal and never presses Enter', async () => {
    const p = await loadPanel();
    await p.type('template', 'node');
    await p.click(p.$('create'));
    await p.click(p.cmd('shell'));
    await p.click(p.cmd('stop'));
    await p.click(p.cmd('export'));
    await p.click(p.cmd('rm'));
    await p.click(p.$('ls'));
    await p.click(p.$('approvals'));

    expect(p.sent().map((r) => r.params)).toEqual([
      {
        terminalId: 'terminal-handle-0001',
        enter: false,
        text: 'abox create node --mode worktree --workspace "$(git rev-parse --show-toplevel)" --name wt-feat-login',
      },
      { terminalId: 'terminal-handle-0001', enter: false, text: 'abox shell wt-feat-login' },
      { terminalId: 'terminal-handle-0001', enter: false, text: 'abox stop wt-feat-login' },
      {
        terminalId: 'terminal-handle-0001',
        enter: false,
        text: 'abox export wt-feat-login --format diff',
      },
      { terminalId: 'terminal-handle-0001', enter: false, text: 'abox rm wt-feat-login' },
      { terminalId: 'terminal-handle-0001', enter: false, text: 'abox ls' },
      { terminalId: 'terminal-handle-0001', enter: false, text: 'abox approvals ls' },
    ]);
    expect(p.status()).toContain('Press Enter');
    expect(p.preview()).toBe('abox approvals ls');
  });

  it('only ever calls the three bridge actions sandboxed panels may use', async () => {
    const p = await loadPanel();
    await p.click(p.$('ls'));
    await p.refresh();
    for (const r of p.requests)
      expect(['workspace.readContext', 'terminal.sendText', 'notifications.show']).toContain(
        r.action,
      );
    for (const r of p.requests) expect(r.requestId.length).toBeLessThanOrEqual(128);
  });

  it('refuses ids and templates that could be read as options or shell syntax', async () => {
    const p = await loadPanel();
    for (const bad of ['x; rm -rf /', '--force', '$(id)', 'a b', 'a`id`', '../x']) {
      await p.type('sid', bad);
      await p.click(p.cmd('rm'));
      expect(p.status(), bad).toContain('Invalid value');
    }
    await p.type('template', 'node;ls');
    await p.click(p.$('create'));
    expect(p.status()).toContain('Invalid value');
    expect(p.sent()).toHaveLength(0);
  });

  it('does not guess between several terminals', async () => {
    const p = await loadPanel({
      context: {
        branch: 'main',
        displayName: 'main',
        terminals: [{ id: 't-a-0000001' }, { id: 't-b-0000002' }],
      },
    });
    const sel = p.$<HTMLSelectElement>('terminal');
    expect(sel.value).toBe('');
    expect(sel.options).toHaveLength(3);
    await p.click(p.$('ls'));
    expect(p.sent()).toHaveLength(0);
    expect(p.status()).toContain('Pick a terminal first');
    expect(p.preview()).toBe('abox ls'); // still shown so it can be copied
    sel.value = 't-b-0000002';
    await p.click(p.$('ls'));
    expect(p.sent().map((r) => r.params?.['terminalId'])).toEqual(['t-b-0000002']);
  });

  it('handles "no worktree focused" and bridge errors', async () => {
    const none = await loadPanel({ context: null });
    expect(none.$('wt').textContent).toBe('No worktree focused.');
    await none.type('template', 'node');
    await none.click(none.$('create'));
    expect(none.status()).toBe('No worktree focused.');
    expect(none.sent()).toHaveLength(0);

    const denied = await loadPanel({
      reply: (r) =>
        r.action === 'workspace.readContext'
          ? { branch: 'a', displayName: 'a', terminals: [{ id: 'tt-00000001' }] }
          : { accepted: false },
    });
    await denied.click(denied.$('ls'));
    expect(denied.status()).toContain('did not accept');
  });

  it('derives the same sandbox name as the worker for awkward branch names', async () => {
    for (const branch of [
      'feat/Login Page!',
      'ÄÖÜ-straße',
      '',
      'a'.repeat(60),
      '--force',
      'release/1.2.3',
      'ünï/cödé',
    ]) {
      const p = await loadPanel({
        context: { branch, displayName: branch || 'detached', terminals: [{ id: 'tt-00000001' }] },
      });
      expect(p.$<HTMLInputElement>('sid').value, JSON.stringify(branch)).toBe(
        sandboxNameFor(branch || 'detached'),
      );
    }
  });

  it('renders German or English and can switch', async () => {
    const de = await loadPanel({ language: 'de-DE' });
    expect(de.doc.documentElement.lang).toBe('de');
    expect(de.$('ctx').textContent).toContain('Fokussierter Worktree');
    expect(de.$('lang').textContent).toBe('EN');
    await de.click(de.$('lang'));
    expect(de.$('ctx').textContent).toContain('Focused worktree');

    const en = await loadPanel({ language: 'fr-FR' });
    expect(en.doc.documentElement.lang).toBe('en');
  });

  it('builds MCP snippets for loopback URLs only, with the token as an environment reference', async () => {
    const p = await loadPanel();
    await p.type('mcpurl', 'http://127.0.0.1:8765/mcp');
    const snippet = JSON.parse(p.$('mcphttp').textContent!);
    expect(snippet).toEqual({
      mcpServers: {
        abox: {
          type: 'http',
          url: 'http://127.0.0.1:8765/mcp',
          headers: { Authorization: 'Bearer ${ABOX_MCP_TOKEN}' },
        },
      },
    });
    await p.type('mcpenv', 'MY_ABOX_TOKEN');
    expect(p.$('mcphttp').textContent).toContain('Bearer ${MY_ABOX_TOKEN}');

    for (const bad of [
      'https://evil.example/mcp',
      'http://192.168.1.5:80/mcp',
      'http://127.0.0.1.evil.com:80/mcp',
      'file:///etc/passwd',
    ]) {
      await p.type('mcpurl', bad);
      expect(p.$('mcphttp').textContent, bad).toContain('must be http://127.0.0.1');
      expect(p.$('mcphttp').textContent).not.toContain('Authorization');
    }
    await p.type('mcpenv', 'a b; c');
    await p.type('mcpurl', 'http://localhost:9/mcp');
    expect(p.$('mcphttp').textContent).toContain('Invalid variable name');
    expect(JSON.parse(p.$('mcpstdio').textContent!)).toEqual({
      mcpServers: { abox: { command: 'abox', args: ['mcp', 'serve', '--agent', '<context>'] } },
    });
  });

  it('has no approve button', async () => {
    const p = await loadPanel();
    const labels = [...p.doc.querySelectorAll('button')].map((b) =>
      (b.textContent ?? '').toLowerCase(),
    );
    expect(labels.some((l) => /approve|freigeben|genehmig/.test(l))).toBe(false);
    expect(p.doc.body.textContent).toContain('no approve button');
  });
});
