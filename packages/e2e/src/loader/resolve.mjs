/* global URL */
// Node ESM loader hooks: maps NodeNext `.js` specifiers back to `.ts` and the workspace packages to their
// sources (the same aliases vitest uses), and transpiles TypeScript with the repo's `typescript`.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const pkg = (name) => new URL(`../../../${name}/src/index.ts`, import.meta.url).href;
const ALIASES = {
  '@abox/core': pkg('core'),
  '@abox/backend-docker': pkg('backend-docker'),
  '@abox/backend-process': pkg('backend-process'),
  '@abox/proxy': pkg('proxy'),
};

export async function resolve(specifier, context, nextResolve) {
  if (ALIASES[specifier]) return nextResolve(ALIASES[specifier], context);
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\/.*\.js$/.test(specifier)) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    throw e;
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const out = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        sourceMap: false,
      },
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
