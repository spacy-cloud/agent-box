// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeFile, ChangesView } from '@abox/core';
import { ChangesTab } from '../../src/renderer/components/Changes';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const hunk = (index: number, lines: string[]) => ({
  index,
  header: `@@ -${index * 30 + 1},3 +${index * 30 + 1},3 @@ fn${index}`,
  oldStart: index * 30 + 1,
  oldCount: 3,
  newStart: index * 30 + 1,
  newCount: 3,
  additions: lines.filter((l) => l.startsWith('+')).length,
  deletions: lines.filter((l) => l.startsWith('-')).length,
  lines,
});

function file(over: Partial<ChangeFile> & { path: string }): ChangeFile {
  return {
    status: 'modified',
    kind: 'file',
    insertions: 1,
    deletions: 1,
    binary: false,
    hunks: [],
    hunkSelectable: false,
    contentOmitted: false,
    badges: [],
    flags: [],
    needsConfirmation: false,
    applicable: true,
    ...over,
  };
}

const DIGEST = 'a'.repeat(64);

function view(over: Partial<ChangesView> = {}): ChangesView {
  return {
    sandboxId: 'local/aaaa1111',
    digest: DIGEST,
    files: [
      file({
        path: 'src/api/client.ts',
        insertions: 12,
        deletions: 3,
        hunks: [
          hunk(0, [' keep', '-const a = 1;', '+const a = 2;', ' tail']),
          hunk(1, ['-export const BASE = "/api";', '+export const BASE = "/api/v2";']),
        ],
        hunkSelectable: true,
      }),
      file({
        path: 'src/api/client.test.ts',
        status: 'added',
        insertions: 48,
        deletions: 0,
        hunks: [hunk(0, ['+test("x", () => {});'])],
      }),
      file({
        path: 'package.json',
        badges: ['dependency', 'flagged'],
        flags: ['package.json changed scripts (run by npm/pnpm/yarn lifecycle)'],
        needsConfirmation: true,
        hunks: [hunk(0, ['+"postinstall": "x"'])],
      }),
      file({
        path: 'scripts/postinstall.sh',
        status: 'added',
        mode: '100755',
        badges: ['executable', 'flagged'],
        flags: ['executable file added'],
        needsConfirmation: true,
        hunks: [hunk(0, ['+echo hi'])],
      }),
    ],
    notices: [],
    stats: { filesChanged: 4, insertions: 62, deletions: 3 },
    ignored: { count: 1, paths: ['node_modules/'] },
    warnings: [],
    target: { kind: 'git', path: '/home/u/web-app', dirtyPaths: [] },
    ...over,
  };
}

const plan = {
  target: '/home/u/web-app',
  targetKind: 'git' as const,
  files: [
    {
      path: 'src/api/client.ts',
      status: 'modified' as const,
      hunks: 1,
      totalHunks: 2,
      insertions: 1,
      deletions: 1,
      badges: [],
      flagged: false,
    },
  ],
  insertions: 1,
  deletions: 1,
  hunks: 1,
  flaggedPaths: [],
};

function bridge(v: ChangesView, applyFail?: { code: string; message: string }) {
  return installBridge((channel, input) => {
    if (channel === 'changes:review') return v;
    if (channel === 'changes:apply') {
      if (applyFail) throw new Error(applyFail.message);
      const i = input as { dryRun?: boolean; confirmed?: boolean };
      return {
        status: i.dryRun ? 'dry_run' : 'applied',
        sandboxId: v.sandboxId,
        digest: v.digest,
        plan,
        message: 'ok',
      };
    }
    if (channel === 'changes:savePatch') return { saved: '/tmp/x.patch', count: 1 };
    throw new Error(`unexpected ${channel}`);
  });
}

describe('ChangesTab', () => {
  it('lists the files like the design: letters, counts, flag badges, ignored note, preselection', async () => {
    bridge(view());
    renderApp(<ChangesTab id="local/aaaa1111" />);
    const list = await screen.findByRole('list', { name: 'Geänderte Dateien' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain('src/api/client.ts');
    expect(rows[0]!.textContent).toContain('+12 −3');
    expect(rows[0]!.textContent).toContain('2 Abschnitte');
    expect(rows[2]!.textContent).toContain('Abhängigkeit');
    expect(rows[3]!.textContent).toContain('ausführbar');
    expect(screen.getByText(/Ignoriert durch \.gitignore: node_modules\//)).toBeTruthy();
    const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box('src/api/client.ts auswählen').checked).toBe(true);
    expect(box('src/api/client.test.ts auswählen').checked).toBe(true);
    expect(box('package.json auswählen').checked).toBe(false);
    expect(box('scripts/postinstall.sh auswählen').checked).toBe(false);
    expect(screen.getByTestId('changes-summary').textContent).toBe(
      '2 von 4 Dateien, 3 Abschnitte ausgewählt',
    );
    expect(screen.getByTestId('changes-target').textContent).toContain(
      'Ziel: /home/u/web-app (sauberer Git-Stand) · markierte Dateien',
    );
  });

  it('shows hunks side by side with a per-hunk checkbox; unticking one changes the summary and the selection sent', async () => {
    const calls = bridge(view());
    renderApp(<ChangesTab id="local/aaaa1111" />);
    await screen.findByRole('list', { name: 'Geänderte Dateien' });
    expect(screen.getByRole('button', { name: 'Nebeneinander' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const hunks = screen.getAllByTestId('hunk');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.textContent).toContain('@@ -1,3 +1,3 @@ fn0');
    expect(hunks[0]!.textContent).toContain('const a = 2;');
    const second = within(hunks[1]!).getByRole('checkbox') as HTMLInputElement;
    expect(second.checked).toBe(true);
    fireEvent.click(second);
    expect(screen.getByTestId('changes-summary').textContent).toBe(
      '2 von 4 Dateien, 2 Abschnitte ausgewählt',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Untereinander' }));
    expect(screen.getByRole('button', { name: 'Untereinander' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Als Patch speichern' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'changes:savePatch')).toBe(true));
    const save = calls.find((c) => c.channel === 'changes:savePatch')!.input as Record<
      string,
      unknown
    >;
    expect(save).toEqual({
      id: 'local/aaaa1111',
      digest: DIGEST,
      selection: [{ path: 'src/api/client.ts', hunks: [0] }, { path: 'src/api/client.test.ts' }],
    });
  });

  it('applying runs the checks first, shows the summary, needs the extra confirmation for flagged files', async () => {
    const calls = bridge(view());
    renderApp(<ChangesTab id="local/aaaa1111" />);
    await screen.findByRole('list', { name: 'Geänderte Dateien' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'package.json auswählen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auswahl übernehmen' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByTestId('apply-summary')).toBeTruthy());
    const dry = calls.find((c) => c.channel === 'changes:apply')!.input as Record<string, unknown>;
    expect(dry['dryRun']).toBe(true);
    expect(dry['acknowledgeFlagged']).toEqual(['package.json']);
    expect(within(dialog).getByText('Markierte Dateien')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', {
      name: 'Ins Projekt übernehmen',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /markierten Dateien geprüft/ }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.filter((c) => c.channel === 'changes:apply')).toHaveLength(2));
    const real = calls.filter((c) => c.channel === 'changes:apply')[1]!.input as Record<
      string,
      unknown
    >;
    expect(real['confirmed']).toBe(true);
    expect(real['dryRun']).toBeUndefined();
    expect(real['digest']).toBe(DIGEST);
    // ids only: no patch text, no target path
    expect(Object.keys(real).sort()).toEqual(
      ['acknowledgeFlagged', 'confirmed', 'digest', 'id', 'selection'].sort(),
    );
  });

  it('a project without git needs its own acknowledgement; an unavailable target disables applying', async () => {
    bridge(view({ target: { kind: 'plain', path: '/home/u/web-app', dirtyPaths: [] } }));
    renderApp(<ChangesTab id="local/aaaa1111" />);
    await screen.findByRole('list', { name: 'Geänderte Dateien' });
    fireEvent.click(screen.getByRole('button', { name: 'Auswahl übernehmen' }));
    const dialog = await screen.findByRole('dialog');
    await screen.findByTestId('apply-summary');
    const confirm = within(dialog).getByRole('button', {
      name: 'Ins Projekt übernehmen',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /keine ungesicherte Arbeit/ }));
    expect(confirm.disabled).toBe(false);
    cleanup();

    bridge(view({ target: { kind: 'unavailable', reason: 'mount', dirtyPaths: [] } }));
    renderApp(<ChangesTab id="local/aaaa1111" />);
    await screen.findByRole('list', { name: 'Geänderte Dateien' });
    expect(
      (screen.getByRole('button', { name: 'Auswahl übernehmen' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByText(/arbeitet direkt im Projekt/).length).toBeGreaterThan(0);
  });

  it('files with uncommitted changes in the project cannot be selected; binary and large files show no content', async () => {
    const v = view({
      target: { kind: 'git', path: '/home/u/web-app', dirtyPaths: ['src/api/client.test.ts'] },
    });
    v.files.push(
      file({
        path: 'logo.png',
        binary: true,
        contentOmitted: true,
        badges: ['binary'],
        needsConfirmation: true,
      }),
    );
    bridge(v);
    renderApp(<ChangesTab id="local/aaaa1111" />);
    await screen.findByRole('list', { name: 'Geänderte Dateien' });
    const box = screen.getByRole('checkbox', {
      name: 'src/api/client.test.ts auswählen',
    }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(
      screen.getByText(/uncommittete Änderungen und lassen sich nicht übernehmen/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Änderungen von logo\.png|logo\.png/ }));
    expect(screen.getByText(/Binärdatei: es wird kein Inhalt angezeigt/)).toBeTruthy();
    expect(screen.queryAllByTestId('hunk')).toHaveLength(0);
  });

  it('caps long diffs and offers "Mehr anzeigen"', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `+line ${i}`);
    const v = view();
    v.files = [file({ path: 'big.txt', hunks: [hunk(0, lines)], hunkSelectable: true })];
    bridge(v);
    renderApp(<ChangesTab id="local/aaaa1111" />);
    await screen.findByRole('list', { name: 'Geänderte Dateien' });
    expect(document.querySelectorAll('.sbs-row').length).toBe(400);
    fireEvent.click(screen.getByRole('button', { name: /Mehr anzeigen \(600 weitere Zeilen\)/ }));
    expect(document.querySelectorAll('.sbs-row').length).toBe(1000);
  });

  it('English locale', async () => {
    bridge(view());
    renderApp(<ChangesTab id="local/aaaa1111" />, { locale: 'en' });
    await screen.findByRole('list', { name: 'Changed files' });
    expect(screen.getByTestId('changes-summary').textContent).toBe(
      '2 of 4 files, 3 hunks selected',
    );
    expect(screen.getByRole('button', { name: 'Apply selection' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as patch' })).toBeTruthy();
  });
});
