#!/usr/bin/env node
import { runCli } from './program.js';

// A reader that goes away (`abox ls | head -1`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

const code = await runCli(process.argv.slice(2), { handleSignals: true });
// Let stdout/stderr drain (pipes), then end: open sockets of the container engine client must not keep us alive.
let pending = 2;
const done = (): void => {
  if (--pending === 0) process.exit(code);
};
process.stdout.write('', done);
process.stderr.write('', done);
