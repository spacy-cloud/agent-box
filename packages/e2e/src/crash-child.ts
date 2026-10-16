// Child process of acceptance-phase1.test.ts: starts a real Docker create and hangs at a chosen step until the
// parent kills it with SIGKILL (roadmap phase 1 criterion 5). Started through loader/register.mjs.
import { writeFileSync } from 'node:fs';
import { createDockerProvider } from '@abox/backend-docker';
import { Abox, type ProviderFactory } from '@abox/core';

const [root, project, marker, hangAt, run, inst] = process.argv.slice(2);
if (!root || !project || !marker || !hangAt || !run || !inst) {
  throw new Error('usage: crash-child <root> <project> <marker> <hangAt> <run> <instance>');
}

const hang = (): Promise<never> => {
  writeFileSync(marker, String(process.pid));
  return new Promise<never>(() => undefined);
};

const factory: ProviderFactory = (host) => {
  const real = createDockerProvider(host, {
    extraLabels: { 'abox.test': 'e2e', 'abox.e2e': run, 'abox.e2e-inst': inst },
    stopTimeoutSec: 1,
  });
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
};

const abox = await Abox.open({
  env: { ABOX_HOME: `${root}/abox`, HOME: `${root}/home` },
  home: `${root}/home`,
  reconcileOnOpen: false,
  providers: { docker: factory },
});
await abox.createSandbox(
  { contextId: 'human', humanConfirmed: true },
  { template: 'alpine-min', workspace: { mode: 'copy', path: project }, requestId: 'crash-1' },
);
