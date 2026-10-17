/** Builds the strings the settings view shows and copies. No secrets: tokens are never part of them. */
export function mcpClaudeCommand(agent: string): string {
  return `claude mcp add abox -- abox mcp serve --agent ${agent}`;
}

export function mcpJsonConfig(agent: string): string {
  return JSON.stringify(
    { mcpServers: { abox: { command: 'abox', args: ['mcp', 'serve', '--agent', agent] } } },
    null,
    2,
  );
}

export function mcpHttpHint(): string {
  return 'abox mcp serve --http 127.0.0.1:<port>   # Authorization: Bearer <token>';
}
