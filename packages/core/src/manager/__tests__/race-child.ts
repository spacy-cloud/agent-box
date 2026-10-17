// Child process of concurrency.test.ts: creates a sandbox with a fixed requestId and prints its id
// (or the error code when the create is refused). Optional 4th argument: the workspace mode (default copy; `mount` uses the in-memory fake container backend, the process backend cannot bind a directory).
import { Abox } from '../abox.js';
import { createProcessProvider } from '@abox/backend-process';
import { FakeProvider } from './fake-provider.js';

const [home, project, requestId, mode = 'copy'] = process.argv.slice(2);
if (!home || !project || !requestId)
  throw new Error('usage: race-child <home> <project> <requestId>');

const abox = await Abox.open({
  env: { ABOX_HOME: `${home}/abox`, HOME: `${home}/home` },
  home: `${home}/home`,
  reconcileOnOpen: false,
  providers: {
    process: (host) => createProcessProvider(host),
    docker: (host) => new FakeProvider(host),
  },
});
try {
  const r = await abox.createSandbox(
    { contextId: 'human', humanConfirmed: true },
    {
      template: mode === 'mount' ? 'fake-box' : 'host-shell',
      workspace: { mode: mode as 'copy' | 'mount', path: project },
      requestId,
    },
  );
  process.stdout.write(
    `RESULT ${JSON.stringify(r.status === 'created' ? { id: r.sandbox.id, idempotent: r.idempotent } : r)}\n`,
  );
} catch (e) {
  process.stdout.write(
    `RESULT ${JSON.stringify({ error: (e as { code?: string }).code ?? 'internal' })}\n`,
  );
}
abox.close();
