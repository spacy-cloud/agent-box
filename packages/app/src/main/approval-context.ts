/**
 * What the approval and confirmation views need to explain a request about a template: which template
 * (and which project directory) the request names. Read from the stored request in the main process,
 * so the renderer never names a path.
 */
import { basename, dirname } from 'node:path';

export interface TemplateTarget {
  name: string;
  /** Content hash the request is bound to (approval covers exactly this content). */
  contentHash?: string;
  /** `<project>` for a template at `<project>/.sandbox/<file>.yaml`. */
  projectDir?: string;
  /** Name of the policy profile the request was evaluated against. */
  profile?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The template a stored create / template-trust request names, or undefined for any other request. */
export function templateTarget(request: unknown): TemplateTarget | undefined {
  if (!isRecord(request)) return undefined;
  const tpl = request['template'];
  if (!isRecord(tpl) || typeof tpl['name'] !== 'string' || tpl['name'] === '') return undefined;
  const source = isRecord(tpl['source']) ? tpl['source'] : undefined;
  const path = typeof source?.['path'] === 'string' ? source['path'] : undefined;
  return {
    name: tpl['name'],
    ...(typeof tpl['contentHash'] === 'string' ? { contentHash: tpl['contentHash'] } : {}),
    ...(path && basename(dirname(path)) === '.sandbox'
      ? { projectDir: dirname(dirname(path)) }
      : {}),
    ...(typeof request['profile'] === 'string' ? { profile: request['profile'] } : {}),
  };
}
