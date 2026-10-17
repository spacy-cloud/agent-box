#!/bin/sh
# abox agent-kit: PreToolUse hook (matcher: Bash).
#
# Reminds Claude (and shows the user a one-line notice) when a Bash command on the
# HOST looks like a package install or a `curl ... | sh`, and suggests a sandbox.
#
# This is COMFORT ONLY, NOT A SECURITY BOUNDARY:
#   - it never blocks (always exits 0, never emits a permission decision),
#   - it works on a crude text match and is trivially bypassed,
#   - it is DISABLED BY DEFAULT: it does nothing unless ABOX_HOOK_WARN=1 is set in
#     the environment Claude Code runs in.
# Real isolation comes from running the command inside an abox sandbox.

if [ "${ABOX_HOOK_WARN:-}" != "1" ]; then
  cat >/dev/null 2>&1
  exit 0
fi

input=$(cat 2>/dev/null) || input=""

# Package installs on the host.
install_re='(^|[^[:alnum:]_-])((npm|pnpm|yarn|bun)[[:space:]]+(install|i|add|ci)|pip3?[[:space:]]+install|python3?[[:space:]]+-m[[:space:]]+pip[[:space:]]+install|uv[[:space:]]+(pip[[:space:]]+install|add|sync)|poetry[[:space:]]+(install|add)|cargo[[:space:]]+(install|add)|go[[:space:]]+(install|get)|gem[[:space:]]+install|composer[[:space:]]+(install|require)|(apt|apt-get|dnf|yum|pacman|apk|brew|paru|yay)[[:space:]]+(-[[:alnum:]-]+[[:space:]]+)*(install|add|-S[[:alnum:]]*))([^[:alnum:]_-]|$)'
# Download piped into a shell.
pipe_re='(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da)?sh([^[:alnum:]_-]|$)'

kind=""
if printf '%s' "$input" | grep -Eq "$pipe_re"; then
  kind="a download piped into a shell"
elif printf '%s' "$input" | grep -Eq "$install_re"; then
  kind="a package install"
fi

if [ -z "$kind" ]; then
  exit 0
fi

user_msg="abox: this command looks like $kind on the host. Consider running it in an abox sandbox (skill abox:use-sandbox)."
ctx="This Bash command looks like $kind on the host. If the code or packages are not fully trusted, run it inside an abox sandbox instead (skill use-sandbox: template_list, sandbox_create, sandbox_exec, sandbox_export). This is a reminder only; the command is not blocked."

printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$user_msg" "$ctx"
exit 0
