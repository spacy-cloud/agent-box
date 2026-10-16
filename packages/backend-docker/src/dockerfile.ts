import type { OsFamily, ResolvedTemplate } from '@abox/core';
import { CA_DIR } from './labels.js';

export interface RenderDockerfileOptions {
  /**
   * Overrides `FROM`: the pinned base (`repo@sha256:…`) or, for templates with their own
   * Dockerfile, the intermediate image built from it. Defaults to `template.base.os`.
   */
  baseRef?: string;
  /** Digest of the base image, recorded as label `abox.base-digest`. */
  baseDigest?: string;
  /** Additional image labels. */
  labels?: Record<string, string>;
}

/** POSIX single-quote escaping. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for a Dockerfile LABEL instruction. */
function labelValue(v: string): string {
  return `"${v.replace(/[\\"$]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n')}"`;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `ENV` instructions for the template environment (visible to the build steps and at runtime). */
function envLines(env: Record<string, string>): string[] {
  const entries = Object.entries(env);
  if (entries.length === 0) return [];
  for (const [k] of entries) {
    if (!ENV_KEY.test(k))
      throw new Error(`renderDockerfile: invalid environment variable name "${k}"`);
  }
  return ['# env', ...entries.map(([k, v]) => `ENV ${k}=${labelValue(v)}`)];
}

/** A step script as a single, injection-safe `RUN` line: base64 decoded into a temp file, run by sh. */
function runScript(script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `RUN f=/tmp/.abox-step-$$ && printf %s '${b64}' | base64 -d > "$f" && { sh -e "$f"; rc=$?; rm -f "$f"; exit $rc; }`;
}

function shadowUserScript(): string {
  return `
if getent passwd "$NAME" >/dev/null 2>&1 && [ "$(id -u "$NAME")" = "$UID_" ]; then
  mkdir -p "/home/$NAME"
else
  for n in "$(getent passwd "$UID_" | cut -d: -f1)" "$NAME"; do
    if [ -n "$n" ] && getent passwd "$n" >/dev/null 2>&1; then userdel -r "$n" >/dev/null 2>&1 || userdel "$n"; fi
  done
  for g in "$(getent group "$UID_" | cut -d: -f1)" "$NAME"; do
    if [ -n "$g" ] && getent group "$g" >/dev/null 2>&1; then groupdel "$g" >/dev/null 2>&1 || true; fi
  done
  groupadd -g "$UID_" "$NAME"
  useradd -m -u "$UID_" -g "$UID_" -s "$SH" "$NAME"
fi`;
}

function busyboxUserScript(): string {
  return `
if getent passwd "$NAME" >/dev/null 2>&1 && [ "$(id -u "$NAME")" = "$UID_" ]; then
  mkdir -p "/home/$NAME"
else
  for n in "$(getent passwd "$UID_" | cut -d: -f1)" "$NAME"; do
    if [ -n "$n" ] && getent passwd "$n" >/dev/null 2>&1; then deluser "$n" >/dev/null 2>&1 || true; fi
  done
  for g in "$(getent group "$UID_" | cut -d: -f1)" "$NAME"; do
    if [ -n "$g" ] && getent group "$g" >/dev/null 2>&1; then delgroup "$g" >/dev/null 2>&1 || true; fi
  done
  addgroup -g "$UID_" "$NAME"
  adduser -D -u "$UID_" -G "$NAME" -s "$SH" "$NAME"
fi`;
}

/** Script that creates the non-root sandbox user (and nothing else). */
export function userSetupScript(user: ResolvedTemplate['user'], family: OsFamily): string {
  const head = `set -e
NAME=${shq(user.name)}
UID_=${String(Math.trunc(user.uid))}
SH=/bin/sh
if [ -x /bin/bash ] || [ -x /usr/bin/bash ]; then SH=$(command -v bash); fi`;
  let body: string;
  if (family === 'alpine') {
    body = busyboxUserScript();
  } else if (family === 'debian' || family === 'fedora' || family === 'arch') {
    body = shadowUserScript();
  } else {
    body = `
if command -v useradd >/dev/null 2>&1; then${shadowUserScript().replace(/\n/g, '\n  ')}
elif command -v adduser >/dev/null 2>&1; then${busyboxUserScript().replace(/\n/g, '\n  ')}
else
  echo "abox: no useradd/adduser in base image" >&2; exit 1
fi`;
  }
  // `sudo: true` only drops a sudoers entry. It is inert under no-new-privileges / CapDrop ALL,
  // which abox never relaxes; it exists so templates that expect the file keep working.
  const sudo = user.sudo
    ? `
mkdir -p /etc/sudoers.d
printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$NAME" > /etc/sudoers.d/abox
chmod 440 /etc/sudoers.d/abox`
    : '';
  return `${head}${body}${sudo}\n`;
}

/**
 * Render the Dockerfile for a resolved template. Pure and deterministic.
 *
 * Layout: FROM, labels, user creation, one `RUN` per build step (script base64-encoded, so no
 * quoting issue can alter it), workspace directory owned by the user, `USER`, `WORKDIR`.
 */
export function renderDockerfile(
  template: ResolvedTemplate,
  opts: RenderDockerfileOptions = {},
): string {
  const base = opts.baseRef ?? (template.base.dockerfile ? undefined : template.base.os);
  if (!base) {
    throw new Error(
      template.base.dockerfile
        ? 'renderDockerfile: templates with base.dockerfile need opts.baseRef (the image built from it)'
        : 'renderDockerfile: template has neither base.os nor base.dockerfile',
    );
  }
  const { user, workspace } = template;
  const labels: Record<string, string> = {
    'abox.managed': '1',
    'abox.template': template.name,
    'abox.template-hash': template.hash,
    ...(opts.baseDigest ? { 'abox.base-digest': opts.baseDigest } : {}),
    ...opts.labels,
  };
  const lines: string[] = [
    '# Generated by abox. Do not edit.',
    `FROM ${base}`,
    `LABEL ${Object.entries(labels)
      .map(([k, v]) => `${k}=${labelValue(v)}`)
      .join(' ')}`,
    ...envLines(template.env),
    '# user',
    runScript(userSetupScript(user, template.base.osFamily)),
  ];
  for (const step of template.build) {
    lines.push(`# step: ${oneLine(step.name)}`);
    lines.push(runScript(step.script));
  }
  lines.push('# workspace');
  lines.push(
    `RUN mkdir -p ${shq(workspace.path)} ${shq(CA_DIR)} && chown ${user.uid}:${user.uid} ${shq(workspace.path)} && chmod 755 ${shq(CA_DIR)}`,
  );
  lines.push(`USER ${user.uid}:${user.uid}`);
  lines.push(`WORKDIR ${workspace.path}`);
  return `${lines.join('\n')}\n`;
}
