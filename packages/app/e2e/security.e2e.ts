import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { APP_DIR, launchGui, makeHome } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

test('renderer has no Node access, a minimal bridge, strict CSP and blocked navigation', async () => {
  const { app, page } = await launchGui(h);
  try {
    // window / process level
    const globals = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>)['require'],
      process: typeof (globalThis as Record<string, unknown>)['process'],
      module: typeof (globalThis as Record<string, unknown>)['module'],
      buffer: typeof (globalThis as Record<string, unknown>)['Buffer'],
      electron: typeof (globalThis as Record<string, unknown>)['electron'],
      bridge: Object.keys((window as unknown as { abox: object }).abox).sort(),
    }));
    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      buffer: 'undefined',
      electron: 'undefined',
      bridge: ['invoke', 'on'],
    });

    // web preferences of the window
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences(): {
          contextIsolation: boolean;
          nodeIntegration: boolean;
          sandbox: boolean;
          webSecurity: boolean;
        };
      };
      const p = wc.getLastWebPreferences();
      return {
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
        sandbox: p.sandbox,
        webSecurity: p.webSecurity,
      };
    });
    expect(prefs).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });

    // IPC: unknown channels and invalid input are refused (validated with Zod in the main process)
    const ipc = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          abox: {
            invoke(c: string, i?: unknown): Promise<{ ok: boolean; error?: { code: string } }>;
          };
        }
      ).abox;
      return {
        unknown: await api.invoke('shell:exec', { cmd: 'id' }),
        badType: await api.invoke('sandboxes:inspect', { id: 123 }),
        extraKey: await api.invoke('sandboxes:inspect', { id: 'local/x', extra: 1 }),
        badDuration: await api.invoke('sandboxes:extend', { id: 'local/x', ttl: 'forever' }),
        badBranch: await api.invoke('export:run', {
          id: 'local/x',
          format: 'branch',
          branchName: 'main',
        }),
        missing: await api.invoke('sandboxes:remove'),
      };
    });
    for (const [k, v] of Object.entries(ipc)) {
      expect(v.ok, k).toBe(false);
      expect(v.error?.code, k).toBe('invalid_input');
    }

    // CSP: no eval, no inline script, no network, no remote images
    const csp = await page.evaluate(async () => {
      const violations: string[] = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        violations.push(e.violatedDirective),
      );
      // Playwright evaluates through the debugger, which is exempt from `eval` blocking itself; a string timer is
      // compiled by the page and therefore subject to the page's CSP.
      (setTimeout as unknown as (code: string, ms: number) => void)('window.__evald = true', 0);
      const s = document.createElement('script');
      s.textContent = 'window.__injected = true';
      document.body.append(s);
      let fetchErr = '';
      try {
        await fetch('https://example.com/');
      } catch (e) {
        fetchErr = (e as Error).name;
      }
      const imgLoaded = await new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = 'https://example.com/x.png';
      });
      await new Promise((r) => setTimeout(r, 200));
      return {
        evald: (window as unknown as Record<string, unknown>)['__evald'] === true,
        injected: (window as unknown as Record<string, unknown>)['__injected'] === true,
        fetchErr,
        imgLoaded,
        violations,
      };
    });
    expect(csp.evald).toBe(false);
    expect(csp.injected).toBe(false);
    expect(csp.fetchErr).toBe('TypeError');
    expect(csp.imgLoaded).toBe(false);
    expect(csp.violations).toEqual(
      expect.arrayContaining(['script-src', 'script-src-elem', 'connect-src', 'img-src']),
    );

    // the header the protocol handler sends, and path traversal through the protocol
    const served = await app.evaluate(async ({ session }) => {
      const ok = await session.defaultSession.fetch('abox-app://app/index.html');
      const trav = await session.defaultSession.fetch(
        'abox-app://app/%2e%2e%2f%2e%2e%2fpackage.json',
      );
      return {
        csp: ok.headers.get('content-security-policy'),
        nosniff: ok.headers.get('x-content-type-options'),
        travStatus: trav.status,
      };
    });
    expect(served.csp).toContain("default-src 'none'");
    expect(served.csp).toContain("script-src 'self'");
    expect(served.csp).not.toContain('unsafe');
    expect(served.nosniff).toBe('nosniff');
    expect(served.travStatus).toBe(403);

    // navigation and new windows are blocked
    const before = page.url();
    const popup = await page.evaluate(() => window.open('https://example.com/') === null);
    expect(popup).toBe(true);
    await page.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    await page.waitForTimeout(500);
    expect(page.url()).toBe(before);
    expect(app.windows()).toHaveLength(1);

    // permissions are denied
    const perm = await page.evaluate(async () => {
      try {
        await navigator.clipboard.readText();
        return 'granted';
      } catch (e) {
        return (e as Error).name;
      }
    });
    expect(perm).not.toBe('granted');
  } finally {
    await app.close();
  }
});

test('a second instance exits at once and focuses the running window (single-instance lock)', async () => {
  const { app, page } = await launchGui(h);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(electronPath as unknown as string, ['--ozone-platform=x11', APP_DIR], {
        env: h.env,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('the second instance kept running'));
      }, 20_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
    // still exactly one window, still working
    expect(app.windows()).toHaveLength(1);
    await expect(page.getByRole('heading', { name: 'Sandboxes', level: 1 })).toBeVisible();
  } finally {
    await app.close();
  }
});
