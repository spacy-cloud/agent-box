// Tiny stand-in for `abox mcp serve --agent <id>` used by the stdio subprocess test and the MCP Inspector run.
// Needs the built packages (`npx tsc -b packages/mcp packages/backend-process`).
import process from 'node:process';
import { Abox } from '@abox/core';
import { createProcessProvider } from '@abox/backend-process';
import { serveHttp, serveStdio } from '../../dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const abox = await Abox.open({
  env: process.env,
  providers: { process: (host) => createProcessProvider(host) },
  ...(process.env.ABOX_TEST_PROJECT ? { projectDir: process.env.ABOX_TEST_PROJECT } : {}),
});
try {
  const http = flag('--http');
  if (http) {
    const [host, port] = http.split(':');
    const h = await serveHttp({
      abox,
      host,
      port: Number(port),
      onListening: (a) => process.stderr.write(`listening ${a.url}\n`),
    });
    process.once('SIGTERM', () => void h.close().then(() => process.exit(0)));
    await new Promise(() => undefined);
  } else {
    await serveStdio({ abox, contextId: flag('--agent') ?? '' });
  }
} catch (e) {
  process.stderr.write(`abox: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 3;
} finally {
  abox.close();
}
