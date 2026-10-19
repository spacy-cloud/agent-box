import { describe, expect, it } from 'vitest';
import type { DoctorCheck } from '@abox/core';
import { renderDoctorChecks, severityOf, summaryText, wrapText } from '../doctor-format.js';

const plain = (_k: string, t: string): string => t;
const render = (checks: DoctorCheck[], o: { verbose?: boolean; width?: number } = {}): string =>
  renderDoctorChecks(checks, { verbose: o.verbose === true, width: o.width ?? 80, style: plain });

const LONG =
  'The docker daemon is rootful: access to its socket (e.g. membership of the docker group) is root-equivalent on the host. Prefer a rootless engine.';

const checks: DoctorCheck[] = [
  {
    id: 'backend.local.docker',
    level: 'ok',
    severity: 'ok',
    title: 'backend docker on local: ok',
    detail: 'docker 29; storage driver: overlay2',
    details: ['docker 29', 'storage driver: overlay2'],
    notes: [{ severity: 'info', message: LONG }],
  },
  {
    id: 'backend.local.podman',
    level: 'ok',
    severity: 'info',
    title: 'backend podman on local: not installed or not running (optional)',
    hint: 'Start it with `systemctl --user start podman.socket` to use it.',
    details: ['podman engine unreachable at /run/podman.sock: ENOENT'],
  },
  { id: 'state.perms', level: 'warn', severity: 'warning', title: 'state database is open' },
  { id: 'audit', level: 'error', severity: 'error', title: 'audit chain broken', detail: 'x' },
];

describe('abox doctor text output', () => {
  it('marks every check by severity', () => {
    const lines = render(checks).split('\n');
    expect(lines.find((l) => l.includes('docker on local: ok'))).toMatch(/^✓ /);
    expect(lines.find((l) => l.includes('podman on local'))).toMatch(/^i /);
    expect(lines.find((l) => l.includes('state database'))).toMatch(/^! /);
    expect(lines.find((l) => l.includes('audit chain'))).toMatch(/^✗ /);
  });

  it('wraps notes and keeps them indented under their check', () => {
    const out = render(checks, { width: 60 }).split('\n');
    const i = out.findIndex((l) => l.startsWith('    i The docker daemon is rootful'));
    expect(i).toBeGreaterThan(0);
    expect(out[i + 1]).toMatch(/^ {6}\S/);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(60);
  });

  it('hides the raw details of ok and info checks unless --verbose', () => {
    const short = render(checks);
    expect(short).not.toContain('storage driver');
    expect(short).not.toContain('ENOENT');
    expect(short).toContain('abox doctor --verbose');
    expect(short).toContain('hint: Start it with `systemctl --user start podman.socket`');
    // a failed check always shows its detail
    expect(short).toContain('· x');
    const full = render(checks, { verbose: true });
    expect(full).toContain('· storage driver: overlay2');
    expect(full).toContain('· podman engine unreachable at /run/podman.sock: ENOENT');
    expect(full).not.toContain('abox doctor --verbose');
  });

  it('escapes control characters in titles and details', () => {
    const out = render([
      {
        id: 'x',
        level: 'error',
        severity: 'error',
        title: 'bad\u001b[31m title',
        detail: 'a\u0007b',
      },
    ]);
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
  });

  it('derives the severity of a check from an older core that only has `level`', () => {
    expect(severityOf({ level: 'warn' })).toBe('warning');
    expect(severityOf({ level: 'ok' })).toBe('ok');
    expect(severityOf({ level: 'ok', severity: 'info' })).toBe('info');
  });

  it('summarises the counts', () => {
    expect(summaryText({ ok: 7, info: 2, warning: 1, error: 0 })).toBe('7 ok, 2 info, 1 warning');
    expect(summaryText({ ok: 1, info: 0, warning: 2, error: 1 })).toBe(
      '1 ok, 2 warnings, 1 failed',
    );
  });

  it('wrapText breaks at word boundaries and never loses a word', () => {
    const lines = wrapText(LONG, 50, '    ');
    expect(lines.join(' ')).toBe(LONG);
    for (const l of lines) expect(l.length + 4).toBeLessThanOrEqual(50);
  });
});

describe('renderDoctorChecks: the command named in the closing hint', () => {
  it('names abox doctor --verbose by default and the scoped command when one is given', () => {
    const hidden: DoctorCheck[] = [
      { id: 'a', level: 'ok', severity: 'info', title: 't', details: ['more'] },
    ];
    expect(render(hidden)).toContain('Run "abox doctor --verbose" for the full details.');
    const scoped = renderDoctorChecks(hidden, {
      verbose: false,
      width: 80,
      style: plain,
      rerun: 'abox doctor --for flutter-dev --verbose',
    });
    expect(scoped).toContain('Run "abox doctor --for flutter-dev --verbose" for the full details.');
    expect(scoped).not.toContain('Run "abox doctor --verbose"');
  });
});
