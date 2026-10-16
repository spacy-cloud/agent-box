// Lets a plain `node` child import the TypeScript sources of the monorepo (used for the kill -9 test).
import { register } from 'node:module';

register('./resolve.mjs', import.meta.url);
