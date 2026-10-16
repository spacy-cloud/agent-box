import type { RepoContext } from './db.js';
import { num, strOrNull } from './json.js';
import type { Row } from './json.js';

/** Pinned base reference (e.g. `ubuntu@sha256:...`) recorded by the first build of a template hash. */
export interface TemplatePin {
  templateHash: string;
  template: string;
  backend: string;
  pinnedBase: string | null;
  imageRef: string | null;
  updatedAt: number;
}

function toPin(r: Row): TemplatePin {
  return {
    templateHash: r['template_hash'] as string,
    template: r['template'] as string,
    backend: r['backend'] as string,
    pinnedBase: strOrNull(r['pinned_base']),
    imageRef: strOrNull(r['image_ref']),
    updatedAt: num(r['updated_at']),
  };
}

/** Reproducible builds: the base digest chosen by the first build is reused until `--update`. */
export class TemplatePins {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  get(templateHash: string): TemplatePin | undefined {
    const row = this.ctx.db
      .prepare('SELECT * FROM template_pins WHERE template_hash = ?')
      .get(templateHash);
    return row ? toPin(row) : undefined;
  }

  put(input: {
    templateHash: string;
    template: string;
    backend: string;
    pinnedBase?: string | null;
    imageRef?: string | null;
  }): TemplatePin {
    this.ctx.db
      .prepare(
        `INSERT INTO template_pins (template_hash, template, backend, pinned_base, image_ref, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(template_hash) DO UPDATE SET template = excluded.template, backend = excluded.backend,
           pinned_base = excluded.pinned_base, image_ref = excluded.image_ref, updated_at = excluded.updated_at`,
      )
      .run(
        input.templateHash,
        input.template,
        input.backend,
        input.pinnedBase ?? null,
        input.imageRef ?? null,
        this.ctx.now(),
      );
    return this.get(input.templateHash)!;
  }

  list(): TemplatePin[] {
    return this.ctx.db
      .prepare('SELECT * FROM template_pins ORDER BY updated_at, template_hash')
      .all()
      .map(toPin);
  }

  delete(templateHash: string): boolean {
    return (
      num(
        this.ctx.db.prepare('DELETE FROM template_pins WHERE template_hash = ?').run(templateHash)
          .changes,
      ) > 0
    );
  }
}
