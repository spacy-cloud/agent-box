// Lets a plain `node` child import the TypeScript sources: maps NodeNext `.js` specifiers back to `.ts`
// and the workspace packages to their sources (the same aliases vitest uses).
import { register } from 'node:module';

register('./resolve-manager.mjs', import.meta.url);
