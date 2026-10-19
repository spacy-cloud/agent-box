/**
 * The rule text setup puts into the agents' rules files. It is the same text as
 * `packages/agent-kit/templates/*.snippet` (a test keeps them identical); it is embedded here because
 * a packaged abox (the GUI, an npm install) has no `packages/` directory next to it.
 */

/** For `AGENTS.md` / `GEMINI.md`: agents without the Claude Code plugin. */
export const AGENTS_RULES = `## Running untrusted code (abox sandboxes)

Run unknown or untrusted code only in an abox sandbox, never directly on the host. This covers: installing dependencies, running scripts or tests from code you did not write, \`curl ... | sh\`, and risky experiments.

Setup: the \`abox\` CLI must be on PATH. Register its MCP server in your agent: \`abox mcp serve --agent <your-agent-name>\` (stdio). \`abox init --agent <name>\` prints the matching configuration.

Procedure:

1. \`template_list\` and pick a template by its description.
2. \`sandbox_create\` with workspace mode \`worktree\`, \`clone\` or \`copy\` (not \`mount\`) and a unique \`request_id\`.
3. Optionally \`sandbox_snapshot\` before risky steps.
4. Run work with \`sandbox_exec\` (argv form, explicit timeout). For long output use files or \`sandbox_process_logs\`; results marked \`truncated\` are cut.
5. \`sandbox_export\` with format \`diff\`; give the diff to the human for review and highlight \`flagged\` paths. Do not apply it to the host yourself.
6. \`sandbox_delete\` the sandbox at the end.

Rules:

- On \`policy_denied\` do not work around the limit. Use \`access_request\` with a clear reason or tell the human.
- On \`pending_approval\` tell the human to run \`abox approvals approve <approval_id>\` (or use the GUI), then retry with the same \`request_id\`.
- Never put secrets into a sandbox.
- Humans can inspect with \`abox ls\`, \`abox shell <id>\`, \`abox export <id> --format diff\`, and clean up with \`abox rm <id>\`.
`;

/** For Claude Code's `CLAUDE.md` when the MCP server is registered without the plugin. */
export const CLAUDE_RULES = `## Running untrusted code (abox sandboxes)

Run unknown or untrusted code only in an abox sandbox, never directly on this machine. This covers: installing dependencies, running scripts or tests from code you did not write, \`curl ... | sh\`, and risky experiments.

- Use the abox MCP tools (\`template_list\`, \`sandbox_create\`, \`sandbox_exec\`, \`sandbox_export\`, \`sandbox_delete\`). With the \`abox\` Claude Code plugin, follow the skill \`use-sandbox\`; otherwise follow the steps below.
- Create the sandbox with an isolated workspace (\`worktree\`, \`clone\` or \`copy\`), not a host mount.
- Return changes as a diff (\`sandbox_export\`, format \`diff\`) for human review. Do not apply them to the host yourself. Point out \`flagged\` files.
- Always delete the sandbox when done (\`sandbox_delete\`).
- If a sandbox action is denied by policy, do not work around it. Ask for access with \`access_request\` and a clear reason, or tell the human. If it is pending approval, tell the human to run \`abox approvals approve <approval_id>\` and retry with the same \`request_id\`.
- Never put secrets (tokens, keys, \`.env\` contents) into a sandbox.
`;
