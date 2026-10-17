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
  const bc = r.buildContext;
  if (bc) {
    lines.push(
      cli.style(
        'bold',
        `  Build context ${safe(bc.dir)} (${bc.fileCount} file${bc.fileCount === 1 ? '' : 's'}, ${bc.totalBytes} bytes; everything in it is sent to the engine and can be copied into the image):`,
      ),
    );
    for (const f of bc.files)
      lines.push(
        `    ${safe(f.path)}${f.type === 'symlink' ? ` -> ${safe(f.target ?? '')}` : `  ${f.size} bytes`}${f.path === bc.dockerfile ? '  (Dockerfile)' : ''}`,
      );
    if (bc.filesTruncated)
      lines.push(`    ... ${bc.fileCount - bc.files.length} more files (covered by the hash)`);
    // Against a trusted version only the changes are in the diff: show the whole file as well.
    if (r.against.kind === 'previous') {
      lines.push(cli.style('bold', `  ${safe(bc.dockerfile)} in full:`));
      for (const l of bc.dockerfileText.replace(/\n$/, '').split('\n'))
        lines.push(`    | ${safe(l)}`);
    }
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
