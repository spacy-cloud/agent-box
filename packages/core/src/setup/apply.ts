import { readFile } from 'node:fs/promises';
import { AboxError } from '../errors.js';
import { defaultRunner } from './clients.js';
import {
  deleteGuarded,
  ensureBackup,
  forgetCreated,
  MAX_CONFIG_BYTES,
  readSnapshot,
  sameFingerprint,
  sha256,
  writeGuarded,
  type Snapshot,
} from './fsafe.js';
import { prepareSetup, type CommandAction, type FileAction } from './plan.js';
import type { SetupEnvironment, SetupRequest, SetupResult, StepResult } from './types.js';

const COMMAND_TIMEOUT_MS = 60_000;

/** The file as a copy for the backup: following links is fine, nothing is written through them. */
async function backupSnapshot(path: string): Promise<Snapshot> {
  try {
    return await readSnapshot(path);
  } catch (e) {
    if (!(e instanceof AboxError) || e.code !== 'conflict') throw e;
  }
  // a symbolic link: the program that writes it follows the link; keep a copy of what it points to
  const buf = await readFile(path);
  if (buf.length > MAX_CONFIG_BYTES)
    throw new AboxError('unsupported', `${path} is too large to back up`);
  const text = buf.toString('utf8');
  const bom = text.startsWith('\uFEFF');
  return {
    fp: { exists: true, size: buf.length, mtimeMs: 0, mode: 0o600, hash: sha256(buf) },
    text: bom ? text.slice(1) : text,
    bom,
  };
}

function clip(s: string, n = 400): string {
  // eslint-disable-next-line no-control-regex
  const t = s.trim().replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?');
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

/**
 * Applies a plan. The plan is built again from the files as they are now; it must have the digest
 * the human saw, otherwise nothing is written. All first-snapshot backups are made before the first
 * change; then the steps run in order and stop at the first failure (what ran is reported).
 */
export async function applySetup(
  env: SetupEnvironment,
  req: SetupRequest,
  digest: string,
): Promise<SetupResult> {
  const prepared = await prepareSetup(env, req);
  const { plan } = prepared;
  if (plan.digest !== digest) {
    throw new AboxError('conflict', 'the configuration changed since the preview', {
      hint: 'Nothing was written. Run setup again to see the current state.',
    });
  }
  const now = (env.now ?? Date.now)();
  const run = env.run ?? defaultRunner;
  const result: SetupResult = {
    ok: true,
    uninstall: plan.uninstall,
    steps: [],
    warnings: [...plan.warnings],
    backups: [],
    digest: plan.digest,
  };

  // 1. every file still looks as planned; 2. first-snapshot backups of all of them
  const toBackup = new Map<string, Snapshot>();
  for (const a of prepared.actions) {
    if (a.step.type === 'file') {
      const fa = a as FileAction;
      const cur = await readSnapshot(fa.step.path);
      if (!sameFingerprint(cur.fp, fa.step.before))
        throw new AboxError('conflict', `${fa.step.path} changed since the preview`, {
          hint: 'Nothing was written. Run setup again.',
        });
      toBackup.set(fa.step.path, cur);
    } else {
      for (const t of (a as CommandAction).step.touches) {
        if (toBackup.has(t)) continue;
        try {
          toBackup.set(t, await backupSnapshot(t));
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
            toBackup.set(t, {
              fp: { exists: false, size: 0, mtimeMs: 0, mode: 0, hash: '' },
              text: null,
              bom: false,
            });
          } else throw e;
        }
      }
    }
  }
  const backupOf = new Map<string, string>();
  for (const [path, snap] of toBackup) {
    const b = await ensureBackup(env.backupDir, path, snap, now);
    if (b) {
      backupOf.set(path, b);
      result.backups.push({ path, backup: b });
    }
  }

  // 3. run
  for (const a of prepared.actions) {
    if (a.step.type === 'file') {
      const fa = a as FileAction;
      const s = fa.step;
      const r: StepResult = {
        client: s.client,
        purpose: s.purpose,
        target: s.path,
        status: 'applied',
        ...(backupOf.has(s.path) ? { backup: backupOf.get(s.path)! } : {}),
      };
      try {
        if (fa.after === null) {
          await deleteGuarded(s.path, s.before);
          await forgetCreated(env.backupDir, s.path);
          r.verified = (await readSnapshot(s.path)).fp.exists === false;
        } else {
          await writeGuarded({
            path: s.path,
            text: fa.after,
            bom: fa.snapshot.bom,
            expected: s.before,
            stagingDir: env.stagingDir,
            verify: fa.verify,
          });
          r.verified = true;
        }
      } catch (e) {
        r.status = 'failed';
        r.message = e instanceof Error ? e.message : String(e);
        result.steps.push(r);
        result.ok = false;
        return result;
      }
      result.steps.push(r);
      continue;
    }
    const ca = a as CommandAction;
    const s = ca.step;
    const r: StepResult = {
      client: s.client,
      purpose: s.purpose,
      target: s.argv.join(' '),
      status: 'applied',
    };
    let res;
    try {
      res = await run(s.argv, { env: env.env, cwd: env.home, timeoutMs: COMMAND_TIMEOUT_MS });
    } catch (e) {
      res = { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
    if (res.code !== 0) {
      const msg = `${s.summary}: exit code ${res.code}${res.stderr ? ` (${clip(res.stderr)})` : ''}`;
      if (s.optional) {
        r.status = 'skipped';
        r.message = msg;
        result.warnings.push(msg);
        result.steps.push(r);
        continue;
      }
      r.status = 'failed';
      r.message = msg;
      result.steps.push(r);
      result.ok = false;
      return result;
    }
    if (ca.verify) {
      const ok = await ca.verify().catch(() => false);
      r.verified = ok;
      if (!ok)
        result.warnings.push(
          `${s.summary}: the command succeeded, but the result could not be confirmed in the configuration files (their location is unverified, see docs/setup.md).`,
        );
    }
    result.steps.push(r);
  }
  return result;
}
