// Child process of concurrency.test.ts: creates a sandbox with a fixed requestId and prints its id.
import { Abox } from '../abox.js';
import { createProcessProvider } from '@abox/backend-process';

const [home, project, requestId] = process.argv.slice(2);
if (!home || !project || !requestId)
  throw new Error('usage: race-child <home> <project> <requestId>');

const abox = await Abox.open({
  env: { ABOX_HOME: `${home}/abox`, HOME: `${home}/home` },
  home: `${home}/home`,
  reconcileOnOpen: false,
  providers: { process: (host) => createProcessProvider(host) },
});
const r = await abox.createSandbox(
  { contextId: 'human', humanConfirmed: true },
  { template: 'host-shell', workspace: { mode: 'copy', path: project }, requestId },
);
process.stdout.write(
  `RESULT ${JSON.stringify(r.status === 'created' ? { id: r.sandbox.id, idempotent: r.idempotent } : r)}\n`,
);
abox.close();
