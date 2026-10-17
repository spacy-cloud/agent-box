import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import { A, EMPTY_WS, HUMAN_YES, created, fakeOf, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;
beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

describe('smoke', () => {
  it('lists templates and creates + execs in a fake sandbox', async () => {
    const t = await abox.listTemplates(A);
    expect(t.templates.map((x) => x.name)).toContain('fake-box');
    const r = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    expect(r.sandbox.id).toMatch(/^local\/[0-9a-f]{8}$/);
    expect(r.sandbox.state).toBe('running');
    const x = await abox.exec(A, r.sandbox.id, { argv: ['echo', 'hi'] });
    expect(x.status).toBe('completed');
    expect(fakeOf(env).execCalls).toHaveLength(1);
  });

  it('creates and runs on the process backend as a confirmed human', async () => {
    const r = created(
      await abox.createSandbox(HUMAN_YES, {
        template: 'host-shell',
        workspace: { mode: 'copy', path: env.project },
      }),
    );
    const x = await abox.exec(HUMAN_YES, r.sandbox.id, { argv: ['ls'] });
    if (x.status !== 'completed') throw new Error('not completed');
    expect(x.stdout).toContain('README.md');
    await abox.removeSandbox(HUMAN_YES, r.sandbox.id);
  });
});
