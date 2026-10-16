// Lets a plain `node` child process import the TypeScript sources directly:
// Node strips the types, this hook maps the NodeNext `.js` specifiers back to `.ts`.
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
