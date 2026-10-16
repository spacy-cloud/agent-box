/**
 * Runs Orca's own validator code (taken from the installed Orca bundle) against plugin/.
 * Skipped unless ORCA_BUNDLE_DIR points to an extracted app.asar (see scripts/validate-with-orca.mjs):
 *
 *   npx -y @electron/asar extract /opt/stably-orca/resources/app.asar /tmp/orca-app
 *   ORCA_BUNDLE_DIR=/tmp/orca-app ORCA_NODE_MODULES=/opt/stably-orca/resources/node_modules pnpm test
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { PACKAGE_DIR } from './helpers.js';

const bundle = process.env['ORCA_BUNDLE_DIR'];
const script = join(PACKAGE_DIR, 'scripts', 'validate-with-orca.mjs');

describe.skipIf(!bundle)('Orca bundle validator', () => {
  const shellFile = join(mkdtempSync(join(tmpdir(), 'orca-shell-')), 'panel-shell.html');
  const result = bundle
    ? spawnSync('node', [script, '--shell-out', shellFile], { encoding: 'utf8', env: process.env })
    : null;

  it("accepts the plugin (Orca's parsePluginManifest, engine gate, capability and panel-action checks)", () => {
    expect(result?.stderr ?? '').toBe('');
    expect(result?.status, result?.stdout).toBe(0);
    expect(result?.stdout).toContain('Orca accepts this plugin.');
    expect(result?.stdout).not.toContain('FAIL');
  });

  it("runs inside Orca's real panel shell (CSP meta, shell scripts, panel boots)", async () => {
    const wrapped = readFileSync(shellFile, 'utf8')
      .replace('__ORCA_COLOR_SCHEME__', 'dark')
      .replace('/*__ORCA_PANEL_TOKENS__*/', '--background:#111;--foreground:#eee');
    const messages: Array<{ type?: string; action?: string; pingId?: number }> = [];
    const dom = new JSDOM(wrapped, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window: Window & typeof globalThis) {
        window.addEventListener('message', (ev: MessageEvent) => {
          const d = ev.data as {
            type?: string;
            requestId?: string;
            action?: string;
            pingId?: number;
          };
          messages.push(d);
          if (d?.type === 'orca-panel-action' && d.action === 'workspace.readContext') {
            window.postMessage(
              { type: 'orca-panel-action-result', requestId: d.requestId, ok: true, value: null },
              '*',
            );
          }
        });
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const doc = dom.window.document as Document;
    expect(
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    ).toContain("connect-src 'none'");
    expect(doc.getElementById('wt')?.textContent).toBe('No worktree focused.');
    expect(doc.documentElement.className).toBe('dark');
    // the shell's own scripts (ping responder, link and form blockers) are present ahead of the panel
    expect(doc.head.innerHTML).toContain('orca-panel-pong');
    expect(doc.getElementById('create')).not.toBeNull();
    dom.window.close();
  });
});
