#!/usr/bin/env node
// Generates the reference catalogs that must never be restated by hand:
//
//   docs/mcp-catalog.md              every MCP tool: purpose, input schema, result, who may call it, approval
//   docs/errors.md                   every error code: exit code, meaning, typical hint, the error envelope
//   docs/error-envelope.schema.json  JSON Schema of the error envelope (`abox --json`, MCP structuredContent)
//
// The sources are the zod schemas and tables in the code (`describeTools()` of @abox/mcp, `ERROR_CODES`
// and `ERROR_CODE_INFO` of @abox/core, `CLI_EXIT_CODES` of @abox/cli), read from the built packages, so
// run `pnpm build` first. The output is deterministic (stable order, no timestamps) and already
// formatted with the repository's Prettier configuration.
//
//   pnpm catalogs          rewrite the files
//   pnpm catalogs:check    fail (exit 1) when a file differs from what would be generated (used by CI)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------------------------

/** One line of text that is safe inside a table cell or a paragraph. */
function text(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');
}

const code = (s) => `\`${String(s).replace(/\|/g, '\\|')}\``;

function table(head, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// JSON Schema -> parameter rows
// ---------------------------------------------------------------------------------------------

function range(min, max, unit) {
  if (min !== undefined && max !== undefined) return `${min} to ${max}${unit}`;
  if (min !== undefined) return `at least ${min}${unit}`;
  if (max !== undefined) return `at most ${max}${unit}`;
  return '';
}

/** A short type description of a schema node, e.g. `string (1 to 64 chars)` or `"add" or "list"`. */
function typeOf(node) {
  if (Array.isArray(node.anyOf)) return [...new Set(node.anyOf.map(typeOf))].join(' or ');
  if (Array.isArray(node.enum)) return node.enum.map((v) => code(JSON.stringify(v))).join(' or ');
  if (node.const !== undefined) return code(JSON.stringify(node.const));
  const notes = [];
  switch (node.type) {
    case 'string': {
      const r = range(node.minLength, node.maxLength, ' chars');
      if (r) notes.push(r);
      if (node.pattern) notes.push(`pattern ${code(node.pattern)}`);
      break;
    }
    case 'number':
    case 'integer': {
      const min = node.exclusiveMinimum !== undefined ? `> ${node.exclusiveMinimum}` : undefined;
      if (min) notes.push(min);
      // zod writes the safe-integer bounds for plain `.int()`: not worth showing
      const lo = node.minimum <= -Number.MAX_SAFE_INTEGER ? undefined : node.minimum;
      const hi = node.maximum >= Number.MAX_SAFE_INTEGER ? undefined : node.maximum;
      const r = range(lo, hi, '');
      if (r) notes.push(r);
      break;
    }
    case 'array': {
      const r = range(node.minItems, node.maxItems, ' items');
      if (r) notes.push(r);
      const item = node.items ? typeOf(node.items) : 'any';
      return `array of ${item}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    }
    case 'object':
      return node.additionalProperties && typeof node.additionalProperties === 'object'
        ? `object (values: ${typeOf(node.additionalProperties)})`
        : 'object';
    default:
  }
  const base = node.type ?? 'any';
  return `${base}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/**
 * Flattens the properties of an object schema into rows. Nested objects (also inside arrays) are listed
 * with a dotted path (`overrides.network.mode`, `overrides.mounts[].source`).
 */
function parameterRows(schema, prefix = '', out = []) {
  const required = new Set(schema.required ?? []);
  for (const [name, node] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`;
    const isRequired = required.has(name);
    const req = !isRequired ? 'no' : prefix === '' ? 'yes' : 'yes, within its parent';
    out.push([code(path), typeOf(node), req, text(node.description)]);
    const nested = node.type === 'object' ? node : node.type === 'array' ? node.items : undefined;
    if (nested && nested.type === 'object' && nested.properties) {
      parameterRows(nested, `${path}${node.type === 'array' ? '[]' : ''}.`, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// MCP tool catalog
// ---------------------------------------------------------------------------------------------

const SCOPE_TEXT = {
  context:
    "Any agent context defined in `policy.yaml` (never `human`). The answer depends on the caller's own profile.",
  sandbox:
    "Any agent context, for its own sandboxes only (another context's sandbox answers `not_found`).",
  process: 'Any agent context, for processes of its own sandboxes only.',
};

function behaviour(a) {
  const parts = [];
  parts.push(a.readOnlyHint ? 'read-only' : 'changes state');
  if (!a.readOnlyHint && a.destructiveHint) parts.push('destructive');
  if (a.idempotentHint) parts.push('idempotent');
  if (a.openWorldHint) parts.push('reaches beyond the sandbox (network)');
  return parts.join(', ');
}

function renderToolCatalog(tools) {
  const out = [];
  out.push(
    '<!-- Generated by scripts/gen-catalogs.mjs from the zod schemas in packages/mcp/src/tools.ts. Do not edit; run `pnpm catalogs`. CI fails when this file is stale. -->',
    '',
    '# MCP tool catalog',
    '',
    `The abox MCP server offers **${tools.length} tools**. This page is generated from the tool definitions in the code (the zod input schemas, the annotations and the documentation each tool carries), so it cannot drift from what \`tools/list\` returns. The prose around the tools, the approval flow and the limits are in the [MCP server reference](mcp.md); the error codes are in the [error catalog](errors.md).`,
    '',
    '- Every tool returns `structuredContent` `{ ok, message, ... }` with `snake_case` keys; fields that end in `_at` are ISO timestamps. A failure is `ok: false` with a `code` and `isError: true` (see the [error envelope](errors.md#error-envelope)).',
    '- `pending_approval` is `ok: false` **without** `code` and without `isError`: a human has to decide, see [approval flow](mcp.md#approval-flow-for-agents).',
    '- Unknown parameters are errors (`invalid_input`): every input schema is closed (`additionalProperties: false`), also nested objects.',
    '- **Result** lists the fields of a successful call beside `ok` and `message`; fields that appear only in some cases (such as `hint`) are listed too. ',
    '',
    '## Overview',
    '',
    table(
      ['Tool', 'Purpose', 'Changes state', 'Human approval'],
      tools.map((t) => [
        `[${code(t.name)}](#${t.name})`,
        text(t.title),
        t.annotations.readOnlyHint ? 'no' : 'yes',
        t.doc.approval === 'None.' ? 'never' : 'depends on the policy',
      ]),
    ),
    '',
    '## Tools',
  );
  for (const t of tools) {
    out.push('', `### ${code(t.name)}`, '', `**${text(t.title)}.** ${text(t.description)}`, '');
    out.push(`- **Who may call it:** ${SCOPE_TEXT[t.doc.scope]}`);
    if (t.doc.pausedWhenHumanAttached) {
      out.push(
        '- **While a human is in the sandbox:** answers `conflict` ("paused") as long as a person has a terminal open in it; nothing is queued, retry later.',
      );
    }
    out.push(`- **Approval:** ${text(t.doc.approval)}`);
    out.push(`- **Behaviour:** ${behaviour(t.annotations)}.`);
    out.push(`- **Result:** ${t.doc.result}.`);
    const rows = parameterRows(t.inputSchema);
    out.push('');
    if (rows.length === 0) out.push('**Parameters:** none.');
    else
      out.push('**Parameters**', '', table(['Parameter', 'Type', 'Required', 'Description'], rows));
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Error catalog
// ---------------------------------------------------------------------------------------------

function renderErrorCatalog(core, cli, envelope) {
  const exitText = core.EXIT_CODE_MEANING;
  const rows = [];
  for (const [name, exit] of Object.entries(core.ERROR_CODES)) {
    const info = core.ERROR_CODE_INFO[name];
    rows.push([code(name), String(exit), text(info.meaning), text(info.hint), 'CLI, MCP']);
  }
  for (const [name, info] of Object.entries(cli.CLI_ONLY_ERROR_INFO)) {
    rows.push([
      code(name),
      String(cli.CLI_EXIT_CODES[name]),
      text(info.meaning),
      text(info.hint),
      'CLI only',
    ]);
  }
  const props = parameterRows(envelope);
  const out = [
    '<!-- Generated by scripts/gen-catalogs.mjs from ERROR_CODES and ERROR_CODE_INFO (packages/core/src/errors.ts). Do not edit; run `pnpm catalogs`. CI fails when this file is stale. -->',
    '',
    '# Error catalog',
    '',
    'Error codes are part of the public interface: the CLI maps them to exit codes and prints them in `--json` output, and the MCP tools return them in `structuredContent`. This page is generated from the code (`ERROR_CODES` and `ERROR_CODE_INFO` in `@abox/core`), so it cannot drift. The tools themselves are in the [MCP tool catalog](mcp-catalog.md).',
    '',
    '## Exit codes',
    '',
    table(
      ['Exit code', 'Meaning'],
      Object.entries(exitText).map(([c, m]) => [String(c), text(m)]),
    ),
    '',
    '`abox exec` exits with the exit code of the command it ran.',
    '',
    '## Error codes',
    '',
    table(['Code', 'Exit code', 'Meaning', 'Typical hint', 'Returned by'], rows),
    '',
    'A concrete error usually carries a more specific `hint` than the typical one above. `pending_approval` is not an error: it is `ok: false` without `code`, see the [approval flow](mcp.md#approval-flow-for-agents).',
    '',
    '## Error envelope',
    '',
    'Every failure has the same shape: `abox --json` prints it on stdout, and an MCP tool returns it as `structuredContent` (with `isError: true`). `hint`, `issues` and `details` appear only when there is something to say. The JSON Schema is in [error-envelope.schema.json](error-envelope.schema.json).',
    '',
    table(['Field', 'Type', 'Required', 'Description'], props),
    '',
    '```json',
    '{',
    '  "ok": false,',
    '  "code": "policy_denied",',
    '  "message": "workspace path /tmp/proj is outside the allowed workspace roots",',
    '  "hint": "Use a path inside one of the allowed roots, or ask the human to change the policy.",',
    '  "details": { "reasons": ["..."] }',
    '}',
    '```',
    '',
  ];
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

async function load(pkg) {
  const file = join(root, 'packages', pkg, 'dist', 'index.js');
  if (!existsSync(file)) {
    throw new Error(`${relative(root, file)} is missing: run "pnpm build" first`);
  }
  return import(pathToFileURL(file).href);
}

async function format(file, content, parser) {
  const config = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(content, { ...config, parser });
}

export async function generate() {
  const [mcp, core, cli] = await Promise.all([load('mcp'), load('core'), load('cli')]);
  const envelopeSchema = {
    ...core.errorEnvelopeJsonSchema(Object.keys(cli.CLI_EXIT_CODES)),
  };
  const schemaDoc = {
    $schema: envelopeSchema['$schema'],
    title: 'abox error envelope',
    description:
      'The failure shape printed by `abox --json` and returned as structuredContent by the MCP tools (see docs/errors.md).',
    ...Object.fromEntries(Object.entries(envelopeSchema).filter(([k]) => k !== '$schema')),
  };
  const files = [
    ['docs/mcp-catalog.md', renderToolCatalog(mcp.describeTools()), 'markdown'],
    ['docs/errors.md', renderErrorCatalog(core, cli, envelopeSchema), 'markdown'],
    ['docs/error-envelope.schema.json', `${JSON.stringify(schemaDoc, null, 2)}\n`, 'json'],
  ];
  const result = [];
  for (const [rel, content, parser] of files) {
    result.push([rel, await format(join(root, rel), content, parser)]);
  }
  return result;
}

async function main() {
  const check = process.argv.includes('--check');
  const generated = await generate();
  const stale = [];
  for (const [rel, content] of generated) {
    const file = join(root, rel);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (current === content) continue;
    if (check) stale.push(rel);
    else {
      writeFileSync(file, content);
      process.stdout.write(`catalogs: wrote ${rel}\n`);
    }
  }
  if (check) {
    if (stale.length > 0) {
      process.stderr.write(
        `catalogs: out of date: ${stale.join(', ')}\nRun "pnpm build && pnpm catalogs" and commit the result.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`catalogs: ${generated.length} file(s) up to date\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    process.stderr.write(`catalogs: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
