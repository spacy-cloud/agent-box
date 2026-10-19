import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import { resolvePaths } from '../../config/paths.js';
import type { PreparedImage, PrepareOptions } from '../../provider.js';
import type { ResolvedTemplate } from '../../types.js';
import type { Abox } from '../abox.js';
import { FakeProvider } from './fake-provider.js';
import { HUMAN, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;

class NoisyBuild extends FakeProvider {
  fail = false;
  override prepare(t: ResolvedTemplate, opts: PrepareOptions = {}): Promise<PreparedImage> {
    opts.onProgress?.('Step 3/9 : ENV API_TOKEN=tok-1234567890');
    opts.onProgress?.('Step 4/9 : ARG NPM_PASSWORD=hunter2-value');
    opts.onProgress?.('Step 5/9 : RUN git clone https://bob:s3cret@example.org/r.git');
    opts.onProgress?.('Step 6/9 : RUN apt-get install -y curl');
    if (this.fail) {
      return Promise.reject(
        new AboxError(
          'backend_error',
          'Image build failed: command failed (Authorization: Bearer abcdefgh1234)',
          {
            details: { log: 'last lines\nENV API_TOKEN=tok-1234567890\nboom' },
          },
        ),
      );
    }
    return super.prepare(t, opts);
  }
}

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, {
    providers: { docker: (host) => new NoisyBuild(host, { now: env.clock.now }) },
  });
  writeFileSync(
    join(resolvePaths(env.env).templatesDir, 'noisy.yaml'),
    `apiVersion: 1\nname: noisy\ndescription: Template whose build prints credentials (redaction test).\nbackend: docker\nbase: { os: ubuntu:24.04 }\n`,
  );
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

describe('build output', () => {
  it('is redacted before a caller sees a line (credential names, URL user info)', async () => {
    const lines: string[] = [];
    await abox.buildTemplate(HUMAN, 'noisy', { onProgress: (l) => lines.push(l) });
    const text = lines.join('\n');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('tok-1234567890');
    expect(text).not.toContain('hunter2-value');
    expect(text).not.toContain('s3cret');
    expect(text).toContain('apt-get install -y curl');
  });

  it('is redacted in the error and in the log it carries', async () => {
    abox.close();
    abox = await openAbox(env, {
      bare: true,
      providers: {
        docker: (host) => {
          const p = new NoisyBuild(host, { now: env.clock.now });
          p.fail = true;
          return p;
        },
      },
    });
    const err = await abox
      .buildTemplate(HUMAN, 'noisy', { onProgress: () => undefined })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AboxError);
    const e = err as AboxError;
    expect(e.code).toBe('backend_error');
    expect(e.message).not.toContain('abcdefgh1234');
    expect(JSON.stringify(e.details)).not.toContain('tok-1234567890');
    expect(JSON.stringify(e.details)).toContain('boom');
    const rows = await abox.queryAudit(HUMAN, { action: 'image.build' });
    expect(JSON.stringify(rows)).not.toContain('abcdefgh1234');
  });
});
