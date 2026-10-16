import type { TemplateReview } from '@abox/core';
import type { Cli } from './cli.js';
import { safe } from './format.js';

/**
 * Text for `TemplateReview`: where the template comes from, the risky points and the resolved
 * template as a unified diff (green additions, red removals). Shown before a project template is trusted.
 */
export function reviewLines(cli: Cli, r: TemplateReview): string[] {
  const where = `${r.source.kind} template${r.source.path ? ` ${r.source.path}` : ''}`;
  const lines: string[] = [
    '',
    cli.style('bold', `Review of "${safe(r.template)}" (${safe(where)})`),
  ];
  if (r.changedSinceRequest) {
    lines.push(
      cli.style(
        'red',
        '  ! The file changed after the request was made: an approval covers the OLD content (hash differs). Deny it and review the new file.',
      ),
    );
  }
  lines.push(
    `  Compared with: ${safe(r.against.label)}${r.against.kind === 'none' ? ' - shown in full' : ''}`,
  );
  if (r.risks.length > 0) {
    lines.push(cli.style('yellow', '  Look at first:'));
    for (const risk of r.risks) lines.push(`    ! ${safe(risk)}`);
  }
  lines.push(cli.style('bold', '  Resolved template:'));
  if (r.diff === '') {
    lines.push('    (no difference in the resolved template; only comments or formatting changed)');
  } else {
    for (const l of r.diff.split('\n')) {
      const text = `    ${safe(l)}`;
      if (l.startsWith('+++') || l.startsWith('---')) lines.push(cli.style('bold', text));
      else if (l.startsWith('+')) lines.push(cli.style('green', text));
      else if (l.startsWith('-')) lines.push(cli.style('red', text));
      else if (l.startsWith('@@')) lines.push(cli.style('dim', text));
      else lines.push(text);
    }
  }
  return lines;
}
