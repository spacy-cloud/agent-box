import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, describeTools } from '../src/index.js';

/**
 * The deliberate pin: the exact tool surface an agent gets. Adding, renaming or removing a tool means
 * editing this list on purpose (plus `TOOL_NAMES` in src/names.ts and `pnpm catalogs`); every other test
 * and doc derives the set from `TOOL_NAMES` or the generated catalog instead of restating it.
 */
const PINNED_TOOLS = [
  'access_request',
  'policy_show',
  'sandbox_create',
  'sandbox_delete',
  'sandbox_exec',
  'sandbox_export',
  'sandbox_inspect',
  'sandbox_list',
  'sandbox_list_dir',
  'sandbox_network_log',
  'sandbox_port_forward',
  'sandbox_process_logs',
  'sandbox_process_start',
  'sandbox_process_stop',
  'sandbox_read_file',
  'sandbox_restore',
  'sandbox_snapshot',
  'sandbox_start',
  'sandbox_stop',
  'sandbox_write_file',
  'template_list',
  'template_show',
];

describe('tool catalog source', () => {
  it('pins the exact tool set', () => {
    expect([...TOOL_NAMES].sort()).toEqual(PINNED_TOOLS);
  });

  it('describes every tool of TOOL_NAMES exactly once', () => {
    const names = describeTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('carries what the generated catalog needs for each tool', () => {
    for (const t of describeTools()) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.description, t.name).toBeTruthy();
      expect(typeof t.annotations['readOnlyHint'], t.name).toBe('boolean');
      expect(t.inputSchema['type'], t.name).toBe('object');
      expect(t.inputSchema['additionalProperties'], t.name).toBe(false);
      expect(['context', 'sandbox', 'process'], t.name).toContain(t.doc.scope);
      expect(t.doc.approval.length, t.name).toBeGreaterThan(3);
      expect(t.doc.result.length, t.name).toBeGreaterThan(3);
    }
  });

  it('a read-only tool never asks for approval and is never paused', () => {
    for (const t of describeTools().filter((x) => x.annotations['readOnlyHint'] === true)) {
      expect(t.doc.approval, t.name).toBe('None.');
      expect(t.doc.pausedWhenHumanAttached, t.name).toBeUndefined();
    }
  });
});
