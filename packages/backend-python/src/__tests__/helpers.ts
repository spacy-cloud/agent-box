import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { makeTestTemplate } from '@abox/contract-tests';
import type { ResolvedTemplate } from '@abox/core';

const run = promisify(execFile);

export const dockerEnabled = process.env['ABOX_TEST_DOCKER'] === '1';
export const TEST_LABEL = 'abox.test';
/** Second label so cleanup only touches objects of one test file (files run in parallel and share the engine). */
export const SUITE_LABEL = 'abox.test.suite';

/** Labels for every engine object a test file creates; `suite` is unique per file. */
export function testLabels(suite: string): Record<string, string> {
  return { [TEST_LABEL]: '1', [SUITE_LABEL]: `backend-python-${suite}` };
}

export async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Remove everything the file's suite created (abox.test=1 and its abox.test.suite label). Best effort. */
export async function sweepTestObjects(suite: string): Promise<void> {
  const label = `label=${SUITE_LABEL}=backend-python-${suite}`;
  const ids = async (args: string[]): Promise<string[]> =>
    (await docker(args).catch(() => '')).split('\n').filter(Boolean);
  for (const c of await ids(['ps', '-aq', '--filter', label]))
    await docker(['rm', '-f', '-v', c]).catch(() => undefined);
  for (const n of await ids(['network', 'ls', '-q', '--filter', label]))
    await docker(['network', 'rm', n]).catch(() => undefined);
  for (const i of await ids(['images', '-q', '--filter', label]))
    await docker(['rmi', '-f', i]).catch(() => undefined);
}

/** A container-mode python template for tests (no catalog needed). */
export function pyTemplate(overrides: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  return makeTestTemplate({
    name: 'abox-test-py',
    backend: 'python',
    isolation: 'container',
    base: { os: 'python:3.13-slim-bookworm', osFamily: 'debian' },
    python: { version: '3.13' },
    ...overrides,
  });
}

export async function hostUv(): Promise<string | undefined> {
  try {
    const { stdout } = await run('uv', ['--version']);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** `major.minor` of the Python that host `uv` finds without downloading, if any. */
export async function hostPythonVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run('uv', ['python', 'find', '--no-python-downloads']);
    const { stdout: v } = await run(stdout.trim(), [
      '-c',
      'import sys; print("%d.%d" % sys.version_info[:2])',
    ]);
    return v.trim();
  } catch {
    return undefined;
  }
}

export interface Fixture {
  dir: string;
  locked: boolean;
  dep: string;
}

/**
 * A tiny project depending on `six`. With host uv available it is locked (`uv.lock`); without,
 * the fixture is lock-free and `locked` is false (tests that need the lock are skipped).
 */
export async function makeProject(opts: { lock: boolean }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'abox-py-project-'));
  await writeFile(
    join(dir, 'pyproject.toml'),
    [
      '[project]',
      'name = "abox-fixture"',
      'version = "0.1.0"',
      'requires-python = ">=3.13"',
      'dependencies = ["six==1.17.0"]',
      '',
    ].join('\n'),
  );
  let locked = false;
  if (opts.lock && (await hostUv())) {
    await run('uv', ['lock', '--project', dir]);
    locked = true;
  }
  await mkdir(join(dir, 'src'), { recursive: true });
  return { dir, locked, dep: 'six' };
}
