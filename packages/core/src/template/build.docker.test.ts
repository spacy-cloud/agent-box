import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { ResolvedTemplate } from '../types.js';
import { TemplateCatalog } from './catalog.js';
import { parseTemplateYaml } from './parse.js';
import { resolveTemplate } from './resolve.js';

/**
 * Builds real images from rendered build steps. The Dockerfile renderer below is a
 * tiny test helper, NOT the docker backend. Run with ABOX_TEST_DOCKER=1; the heavier
 * preset matrix additionally needs ABOX_TEST_DOCKER_FULL=1, and the built-in templates that
 * are too slow or large for CI (flutter-dev: about 5 minutes and 3-4 GB) ABOX_TEST_HEAVY_TEMPLATES=1.
 */
const run = promisify(execFile);
const DOCKER = process.env.ABOX_TEST_DOCKER === '1';
const FULL = DOCKER && process.env.ABOX_TEST_DOCKER_FULL === '1';
const HEAVY = DOCKER && process.env.ABOX_TEST_HEAVY_TEMPLATES === '1';
const LABEL = 'abox-test=template-build';
/** Marks everything this run creates so the cleanup never touches a concurrent run's objects. */
const RUN_LABEL = `abox-test-run=${randomUUID()}`;
const built: string[] = [];

async function docker(
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return run('docker', args, { timeout: opts.timeout ?? 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
}

function renderDockerfile(t: ResolvedTemplate): string {
  const lines = [`FROM ${t.base.os}`, `LABEL ${LABEL} ${RUN_LABEL}`];
  // Like the docker backend: the template environment is also set while the build steps run
  // (a `setup:` step such as `rustup component add` needs the preset's RUSTUP_HOME).
  for (const [k, v] of Object.entries(t.env)) lines.push(`ENV ${k}=${JSON.stringify(v)}`);
  lines.push('COPY steps/ /abox-steps/');
  t.build.forEach((s, i) => {
    lines.push(
      `# ${s.name.replace(/\n/g, ' ')}`,
      `RUN sh /abox-steps/${String(i).padStart(2, '0')}.sh`,
    );
  });
  lines.push('RUN rm -rf /abox-steps');
  const user = t.user;
  lines.push(
    t.base.osFamily === 'alpine'
      ? `RUN adduser -D -u ${user.uid} ${user.name}`
      : `RUN (userdel -r $(getent passwd ${user.uid} | cut -d: -f1) 2>/dev/null || true) && useradd -m -u ${user.uid} -s /bin/sh ${user.name}`,
  );
  lines.push(`USER ${user.uid}`, 'WORKDIR /tmp');
  return `${lines.join('\n')}\n`;
}

async function build(t: ResolvedTemplate): Promise<string> {
  const ctx = await mkdtemp(join(tmpdir(), 'abox-build-'));
  try {
    await mkdir(join(ctx, 'steps'));
    for (const [i, s] of t.build.entries())
      await writeFile(join(ctx, 'steps', `${String(i).padStart(2, '0')}.sh`), s.script);
    await writeFile(join(ctx, 'Dockerfile'), renderDockerfile(t));
    const tag = `abox-test/tpl-${t.name}:${t.hash.slice(0, 12)}`;
    built.push(tag);
    // --force-rm: a failing RUN step otherwise leaves its exited intermediate container behind.
    await docker([
      'build',
      '--pull=false',
      '--force-rm',
      '--label',
      LABEL,
      '--label',
      RUN_LABEL,
      '-t',
      tag,
      ctx,
    ]);
    return tag;
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}

async function inSandbox(
  tag: string,
  cmd: string,
  user = '1000',
  timeout = 120_000,
): Promise<string> {
  const { stdout, stderr } = await docker(
    ['run', '--rm', '--user', user, '--network', 'none', tag, 'sh', '-c', cmd],
    { timeout },
  );
  return `${stdout}${stderr}`;
}

/** Runs a command that is expected to fail and returns its output plus exit code ("exit=<n>"). */
async function inSandboxFailing(tag: string, cmd: string): Promise<string> {
  return inSandbox(tag, `{ ${cmd}; } 2>&1; echo exit=$?`);
}

/** Every tool's check command prints something as uid 1000 (no network). */
async function expectToolChecks(tag: string, t: ResolvedTemplate): Promise<void> {
  for (const tool of t.tools)
    expect(
      (await inSandbox(tag, tool.check)).trim().length,
      `${t.name}/${tool.name}`,
    ).toBeGreaterThan(0);
}

async function resolveText(text: string): Promise<ResolvedTemplate> {
  return resolveTemplate(parseTemplateYaml(text), { source: { kind: 'user' }, contentText: text });
}

/** Ids (`-q`) of the objects of this run: `docker ps -a` for containers, `docker images` for images. */
async function ownIds(list: 'ps' | 'images'): Promise<string[]> {
  const args = list === 'ps' ? ['ps', '-aq'] : ['images', '-q'];
  const { stdout } = await docker([...args, '--filter', `label=${RUN_LABEL}`]).catch(() => ({
    stdout: '',
  }));
  return stdout.split('\n').filter(Boolean);
}

afterAll(async () => {
  if (!DOCKER) return;
  // Containers first (a failed or interrupted build leaves its intermediate containers), then images.
  const containers = await ownIds('ps');
  if (containers.length > 0) await docker(['rm', '-f', '-v', ...containers]).catch(() => undefined);
  for (const tag of built) await docker(['rmi', '-f', tag]).catch(() => undefined);
  // Safety net: any image of this run that is still there (untagged layers of a failed build).
  const ids = await ownIds('images');
  if (ids.length > 0) await docker(['rmi', '-f', ...ids]).catch(() => undefined);
});

describe.skipIf(!DOCKER)('template build (docker)', () => {
  it(
    'builds alpine-min and runs as uid 1000',
    async () => {
      const t = await new TemplateCatalog().get('alpine-min');
      const tag = await build(t);
      expect((await inSandbox(tag, 'id -u && whoami')).trim().split('\n')).toEqual([
        '1000',
        'agent',
      ]);
      expect((await inSandbox(tag, 'cat /etc/alpine-release')).trim()).toMatch(/^3\.22/);
    },
    5 * 60_000,
  );

  it(
    'a failing build step leaves no container behind',
    async () => {
      const t = await resolveText(`apiVersion: 1
name: failing-step
backend: docker
base: { os: "alpine:3.22" }
setup:
  - run: exit 3
`);
      await expect(build(t)).rejects.toThrow();
      expect(await ownIds('ps')).toEqual([]);
    },
    5 * 60_000,
  );

  it(
    'debian image with node@24, git and python@3.13: preset checks pass as uid 1000',
    async () => {
      const t = await resolveText(`apiVersion: 1
name: debian-tools
description: Test image with node, git and python
backend: docker
base: { os: "ubuntu:24.04" }
packages:
  apt: [make]
  pip: [six]
  npm: [left-pad]
tools: [node@24, git, python@3.13, pnpm@10]
setup:
  - run: echo built > /etc/abox-marker
`);
      const tag = await build(t);
      const out: Record<string, string> = {};
      for (const tool of t.tools) out[tool.name] = (await inSandbox(tag, tool.check)).trim();
      expect(out.node).toMatch(/^v24\./);
      expect(out.git).toMatch(/^git version /);
      expect(out.python).toMatch(/Python 3\.13\./);
      expect(out.python).toMatch(/uv \d/);
      expect(out.pnpm).toMatch(/^10\./);
      expect(
        await inSandbox(tag, 'id -u && cat /etc/abox-marker && which python python3 node'),
      ).toContain('1000\nbuilt\n');
      expect(
        await inSandbox(tag, 'python -c "import six, sys; print(sys.version_info[:2])"'),
      ).toContain('(3, 13)');
      expect(await inSandbox(tag, 'npm ls -g --depth=0')).toContain('left-pad');
      // Tools must not need root: no files owned by or writable only for root are required at run time.
      expect(await inSandbox(tag, 'node -e "console.log(1+1)"')).toContain('2');
    },
    15 * 60_000,
  );

  it(
    'shell-dev: lints and formats shell, fish and Lua offline as uid 1000',
    async () => {
      const t = await new TemplateCatalog().get('shell-dev');
      const tag = await build(t);
      await expectToolChecks(tag, t);
      expect(await inSandbox(tag, 'lua -v')).toMatch(/^Lua 5\.4\./);
      for (const cmd of [
        'bash --version',
        'fish --version',
        'shellcheck --version',
        'shfmt --version',
      ])
        expect((await inSandbox(tag, cmd)).length, cmd).toBeGreaterThan(5);
      expect(await inSandbox(tag, 'luacheck --version')).toContain('Luacheck:');
      expect(await inSandbox(tag, 'stylua --version')).toMatch(/^stylua 2\./);
      expect(await inSandbox(tag, 'jq -n "[1,2]|add"')).toContain('3');
      expect(
        await inSandboxFailing(
          tag,
          `cd /tmp && printf '#!/bin/sh\necho $1\n' > a.sh && shellcheck a.sh`,
        ),
      ).toMatch(/SC2086[\s\S]*exit=1/);
      expect(
        await inSandboxFailing(
          tag,
          `cd /tmp && printf '#!/bin/sh\necho "$1"\n' > ok.sh && shellcheck ok.sh`,
        ),
      ).toContain('exit=0');
      expect(
        await inSandboxFailing(
          tag,
          `cd /tmp && printf 'if true\nthen echo  x;fi\n' > f.sh && shfmt -d f.sh`,
        ),
      ).toMatch(/exit=1/);
      expect(
        await inSandboxFailing(tag, `cd /tmp && printf 'x = nope\n' > a.lua && luacheck a.lua`),
      ).toMatch(/non-standard global variable[\s\S]*exit=1/);
      expect(
        await inSandboxFailing(
          tag,
          `cd /tmp && printf 'local x   =  1\n' > f.lua && stylua --check f.lua`,
        ),
      ).toMatch(/exit=1/);
      expect(
        await inSandboxFailing(
          tag,
          `cd /tmp && printf 'function f\n if true\nend\n' > b.fish && fish -n b.fish`,
        ),
      ).toMatch(/Missing end/);
      expect(await inSandbox(tag, 'id -u')).toContain('1000');
    },
    15 * 60_000,
  );

  it(
    'php-dev: extensions, composer and the built-in server work as uid 1000',
    async () => {
      const t = await new TemplateCatalog().get('php-dev');
      const tag = await build(t);
      await expectToolChecks(tag, t);
      const modules = await inSandbox(tag, 'php -m');
      for (const m of ['mbstring', 'xml', 'curl', 'zip', 'sqlite3', 'pdo_sqlite', 'intl', 'dom'])
        expect(modules, m).toContain(m);
      expect(await inSandbox(tag, 'composer --version')).toMatch(/^Composer version 2\.10\./);
      expect(
        await inSandbox(
          tag,
          `php -r 'echo mb_strtoupper("abc"), (new PDO("sqlite::memory:"))->query("select 41+1")->fetchColumn(), class_exists("Collator") ? "+intl" : "";'`,
        ),
      ).toContain('ABC42+intl');
      // No dependencies: composer needs no network to write the lock file and the autoloader.
      expect(
        await inSandbox(
          tag,
          'cd /tmp && mkdir p && cd p && composer init --no-interaction --name smoke/p --require "php:>=8.1" >/dev/null 2>&1 && composer install --no-interaction 2>&1 && test -f vendor/autoload.php && echo autoload-ok',
        ),
      ).toContain('autoload-ok');
      expect(
        await inSandbox(
          tag,
          `mkdir -p /tmp/site && printf '<?php echo "served by php ", PHP_MAJOR_VERSION;' > /tmp/site/index.php && (php -S 127.0.0.1:8123 -t /tmp/site >/dev/null 2>&1 & ) && sleep 1 && curl -fsS http://127.0.0.1:8123/ && php -l /tmp/site/index.php`,
        ),
      ).toMatch(/served by php 8[\s\S]*No syntax errors/);
    },
    15 * 60_000,
  );

  it(
    'tauri-dev: Rust, Node, pnpm and the Tauri system libraries are in place; a crate compiles offline',
    async () => {
      const t = await new TemplateCatalog().get('tauri-dev');
      const tag = await build(t);
      await expectToolChecks(tag, t);
      const pkgs = await inSandbox(
        tag,
        'pkg-config --modversion webkit2gtk-4.1 libsoup-3.0 librsvg-2.0 ayatana-appindicator3-0.1 openssl gtk+-3.0',
      );
      expect(pkgs.trim().split('\n')).toHaveLength(6);
      expect(await inSandbox(tag, 'cargo clippy --version && cargo fmt --version')).toMatch(
        /clippy[\s\S]*rustfmt/,
      );
      expect(await inSandbox(tag, 'node --version && pnpm --version')).toMatch(
        /^v24\.[\s\S]*\n10\./,
      );
      expect(
        await inSandbox(
          tag,
          'cd /tmp && cargo new --offline hello >/dev/null 2>&1 && cd hello && cargo build --offline 2>&1 && ./target/debug/hello',
          '1000',
          5 * 60_000,
        ),
      ).toContain('Hello, world!');
    },
    20 * 60_000,
  );
});

describe.skipIf(!HEAVY)('heavy built-in templates (docker, ABOX_TEST_HEAVY_TEMPLATES=1)', () => {
  it(
    'flutter-dev: create, pub get, analyze, test and build web and linux work offline as uid 1000',
    async () => {
      const t = await new TemplateCatalog().get('flutter-dev');
      const tag = await build(t);
      await expectToolChecks(tag, t);
      expect(await inSandbox(tag, 'flutter --version')).toMatch(/Flutter 3\.47\.7 .*Dart 3\.13\./s);
      expect(await inSandbox(tag, 'dart --version')).toMatch(/Dart SDK version: 3\.13\./);
      // The default app template's packages are in the image's pub cache, so nothing needs the network.
      const out = await inSandbox(
        tag,
        [
          'cd /tmp',
          'flutter create --offline --project-name smoke app >/dev/null 2>&1',
          'cd app',
          'flutter analyze 2>&1 | tail -n 3',
          'flutter test 2>&1 | tail -n 2',
          'dart format --set-exit-if-changed lib test && echo format-ok',
          'flutter build web 2>&1 | tail -n 1',
          'flutter build linux 2>&1 | tail -n 1',
        ].join(' && '),
        '1000',
        10 * 60_000,
      );
      expect(out).toContain('No issues found');
      expect(out).toContain('All tests passed');
      expect(out).toContain('format-ok');
      expect(out).toContain('Built build/web');
      expect(out).toContain('Built build/linux/x64/release/bundle/smoke');
    },
    30 * 60_000,
  );
});

describe.skipIf(!FULL)('template build: full preset matrix (docker)', () => {
  const sets: Array<{
    name: string;
    base: string;
    tools: string[];
    checks?: Record<string, RegExp>;
  }> = [
    { name: 'deb-go', base: 'ubuntu:24.04', tools: ['go@1.24'], checks: { go: /go1\.24\./ } },
    { name: 'deb-rust', base: 'ubuntu:24.04', tools: ['rust'], checks: { rust: /^rustc 1\./ } },
    { name: 'deb-java', base: 'ubuntu:24.04', tools: ['java@21', 'gh'], checks: { java: /21\./ } },
    {
      name: 'deb-docker',
      base: 'ubuntu:24.04',
      tools: ['docker-cli'],
      checks: { 'docker-cli': /^Docker version/ },
    },
    {
      name: 'deb-pw',
      base: 'debian:12',
      tools: ['node@24', 'playwright'],
      checks: { playwright: /^Version / },
    },
    {
      name: 'alp-node',
      base: 'alpine:3.22',
      tools: ['node@24', 'pnpm@10', 'git'],
      checks: { node: /^v24\./ },
    },
    {
      name: 'alp-py',
      base: 'alpine:3.22',
      tools: ['python@3.13'],
      checks: { python: /Python 3\.13/ },
    },
    { name: 'alp-go', base: 'alpine:3.22', tools: ['go@1.24'], checks: { go: /go1\.24/ } },
    { name: 'alp-rust', base: 'alpine:3.22', tools: ['rust'], checks: { rust: /^rustc/ } },
    {
      name: 'alp-java',
      base: 'alpine:3.22',
      tools: ['java@21', 'gh', 'docker-cli'],
      checks: { java: /21\./ },
    },
  ];
  for (const s of sets) {
    it(
      s.name,
      async () => {
        const t = await resolveText(
          `apiVersion: 1\nname: ${s.name}\nbackend: docker\nbase: { os: "${s.base}" }\ntools: [${s.tools.join(', ')}]\n`,
        );
        const tag = await build(t);
        for (const tool of t.tools) {
          const out = (await inSandbox(tag, tool.check)).trim();
          const re = s.checks?.[tool.name];
          if (re) expect(out, tool.name).toMatch(re);
          else expect(out.length, tool.name).toBeGreaterThan(0);
        }
      },
      30 * 60_000,
    );
  }

  it(
    'rust can compile and go can build as uid 1000',
    async () => {
      const t = await resolveText(
        `apiVersion: 1\nname: compile\nbackend: docker\nbase: { os: "ubuntu:24.04" }\ntools: [rust, go@1.24]\n`,
      );
      const tag = await build(t);
      expect(
        await inSandbox(
          tag,
          'cd /tmp && cargo new --offline hello >/dev/null 2>&1 && cd hello && cargo build --offline 2>&1 && ./target/debug/hello',
        ),
      ).toContain('Hello, world!');
      expect(
        await inSandbox(
          tag,
          'cd /tmp && mkdir g && cd g && printf "package main\\nfunc main(){println(\\"hi\\")}\\n" > m.go && go run m.go 2>&1',
        ),
      ).toContain('hi');
    },
    30 * 60_000,
  );

  it(
    'builds the remaining builtin templates',
    async () => {
      const catalog = new TemplateCatalog();
      for (const name of ['py-offline', 'node-dev', 'py-dev', 'rust-dev']) {
        const t = await catalog.get(name);
        const tag = await build(t);
        for (const tool of t.tools)
          expect(
            (await inSandbox(tag, tool.check)).trim().length,
            `${name}/${tool.name}`,
          ).toBeGreaterThan(0);
        if (name === 'py-offline')
          expect(
            await inSandbox(tag, 'python -c "import numpy, pandas; print(pandas.__version__)"'),
          ).toMatch(/\d/);
      }
    },
    30 * 60_000,
  );
});
