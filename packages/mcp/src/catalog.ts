import { z } from 'zod';
import { TOOL_NAMES } from './names.js';
import { registerTools } from './tools.js';
import type { Register, ToolDef, ToolDoc } from './tools.js';

/** One tool as the generated catalog (`docs/mcp-catalog.md`) shows it. */
export interface ToolDescription {
  name: string;
  title: string;
  description: string;
  /** MCP tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. */
  annotations: Record<string, unknown>;
  /** JSON Schema (draft 2020-12) of the arguments, exactly what `tools/list` advertises. */
  inputSchema: Record<string, unknown>;
  doc: ToolDoc;
}

/**
 * Every registered tool in registration order, read from the same definitions the server registers
 * (no server, no manager needed). Fails when the registry and `TOOL_NAMES` disagree, so the generated
 * catalog can never describe a different surface than the one the server exposes.
 */
export function describeTools(): ToolDescription[] {
  const defs: ToolDef<z.ZodRawShape>[] = [];
  const collect: Register = (def) => {
    defs.push(def as unknown as ToolDef<z.ZodRawShape>);
  };
  registerTools(collect);
  const names = defs.map((d) => d.name);
  const missing = TOOL_NAMES.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !(TOOL_NAMES as readonly string[]).includes(n));
  if (missing.length || extra.length || new Set(names).size !== names.length) {
    throw new Error(
      `TOOL_NAMES and the registered tools differ (missing: ${missing.join(', ') || '-'}; ` +
        `unlisted: ${extra.join(', ') || '-'}); update packages/mcp/src/names.ts`,
    );
  }
  return defs.map((d) => ({
    name: d.name,
    title: d.title,
    description: d.description,
    annotations: { ...d.annotations },
    inputSchema: z.toJSONSchema(z.strictObject(d.input), { io: 'input' }) as Record<
      string,
      unknown
    >,
    doc: d.doc,
  }));
}
