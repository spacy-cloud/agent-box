/* global URL */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ALIASES = {
  '@abox/core': new URL('../../index.ts', import.meta.url).href,
  '@abox/backend-process': new URL('../../../../backend-process/src/index.ts', import.meta.url)
    .href,
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

// Full TypeScript transpilation (the sources use parameter properties, which Node's strip-only mode rejects).
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
