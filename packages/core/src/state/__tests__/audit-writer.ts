// Child process used by the concurrency test: appends N audit entries as fast as possible.
import { StateStore } from '../store.js';

const [dbPath, label, countArg] = process.argv.slice(2);
if (!dbPath || !label || !countArg) throw new Error('usage: audit-writer <db> <label> <count>');

const store = StateStore.open(dbPath);
const count = Number(countArg);
for (let i = 0; i < count; i++) {
  store.audit.append({ actor: label, action: 'test.append', details: { i, label } });
  if (i % 7 === 0) {
    store.sandboxes.upsert({
      id: `local/${label}-${i}`,
      host: 'local',
      name: `${label}-${i}`,
      owner: 'human',
      template: 't',
      templateHash: 'h',
      backend: 'docker',
      isolation: 'container',
      state: 'created',
      createdAt: 1,
      expiresAt: 2,
    });
  }
}
store.close();
