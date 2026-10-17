#!/bin/sh
# abox agent-kit: SessionStart hook.
#
# The plugin's MCP server is started as `${ABOX_BIN:-abox} mcp serve`. When that command does not
# exist, Claude Code only shows a failed server in /mcp without saying why. This hook says why, once
# per session start, and what to do about it.
#
# It is silent (and exits 0) when the command is found; it never blocks anything and never fails the
# session. Nothing here is a security measure.

cat >/dev/null 2>&1

bin="${ABOX_BIN:-abox}"
found=0
case "$bin" in
  */*) [ -f "$bin" ] && [ -x "$bin" ] && found=1 ;;
  *) command -v "$bin" >/dev/null 2>&1 && found=1 ;;
esac
[ "$found" = 1 ] && exit 0

# JSON-safe copy of the configured name (backslash and double quote escaped, control characters dropped).
shown=$(printf '%s' "$bin" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')

if [ -n "${ABOX_BIN:-}" ]; then
  what="ABOX_BIN is set to '$shown', but that file does not exist or is not executable"
else
  what="the 'abox' command was not found on the PATH of the environment Claude Code started in"
fi

user_msg="abox: $what, so the abox MCP server (plugin:abox:abox) cannot start and the sandbox tools are unavailable. Install the abox CLI and put it on the PATH, or start Claude Code with ABOX_BIN=/full/path/to/abox. Check with: abox doctor. See packages/agent-kit/README.md (Prerequisites)."
ctx="The abox plugin is installed, but $what. The abox MCP tools (sandbox_create, sandbox_exec, ...) are therefore NOT available in this session. If the user asks for sandboxed work, tell them to install the abox CLI (or set ABOX_BIN to its full path) and restart Claude Code from an environment where it is found. Do not run untrusted code on the host as a substitute without telling the user."

printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$user_msg" "$ctx"
exit 0
