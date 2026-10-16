// Child process of crash.test.ts: starts a create and hangs at a chosen step until the parent kills it with SIGKILL.
import { writeFileSync } from 'node:fs';
import { createProcessProvider } from '@abox/backend-process';
import { Abox } from '../abox.js';

const [home, project, marker, hangAt] = process.argv.slice(2);
if (!home || !project || !marker || !hangAt)
  throw new Error('usage: crash-child <home> <project> <marker> <hangAt>');

const hang = async (): Promise<never> => {
  writeFileSync(marker, String(process.pid));
  return new Promise<never>(() => undefined);
};

const abox = await Abox.open({
  env: { ABOX_HOME: `${home}/abox`, HOME: `${home}/home` },
  home: `${home}/home`,
  reconcileOnOpen: false,
  providers: {
    process: (host) => {
      const real = createProcessProvider(host);
      return new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (prop === 'prepare' && hangAt === 'prepare') return hang;
          if (prop === 'create' && hangAt === 'create') return hang;
          if (prop === 'start' && hangAt === 'start') return hang;
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
  },
});
await abox.createSandbox(
  { contextId: 'human', humanConfirmed: true },
  { template: 'host-shell', workspace: { mode: 'copy', path: project }, requestId: 'crash-1' },
);
