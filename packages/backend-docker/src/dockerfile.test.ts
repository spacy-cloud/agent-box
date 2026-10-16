import { describe, expect, it } from 'vitest';
import { renderDockerfile, shq, userSetupScript } from './dockerfile.js';
import { makeTemplate } from './__tests__/helpers.js';

const fixed = (over = {}, fam: Parameters<typeof makeTemplate>[1] = 'alpine') =>
  makeTemplate({ hash: 'a'.repeat(64), ...over }, fam);

function decodeSteps(df: string): string[] {
  return [...df.matchAll(/printf %s '([A-Za-z0-9+/=]+)'/g)].map((m) =>
    Buffer.from(m[1] as string, 'base64').toString('utf8'),
  );
}

describe('renderDockerfile', () => {
  it('renders the alpine layout (snapshot)', () => {
    expect(renderDockerfile(fixed())).toMatchSnapshot();
  });

  it('renders the debian layout (snapshot)', () => {
    const t = fixed(
      {
        base: { os: 'ubuntu:24.04', osFamily: 'debian' },
        user: { name: 'dev', uid: 1000, sudo: true },
      },
      'debian',
    );
    expect(
      renderDockerfile(t, {
        baseRef: 'ubuntu@sha256:' + 'b'.repeat(64),
        baseDigest: 'ubuntu@sha256:' + 'b'.repeat(64),
      }),
    ).toMatchSnapshot();
  });

  it('uses the pinned base and records the digest label', () => {
    const df = renderDockerfile(fixed(), {
      baseRef: 'alpine@sha256:abc',
      baseDigest: 'alpine@sha256:abc',
    });
    expect(df).toContain('FROM alpine@sha256:abc\n');
    expect(df).toContain('abox.base-digest="alpine@sha256:abc"');
    expect(df).toContain('abox.managed="1"');
    expect(df).toContain('abox.template="abox-test-alpine"');
    expect(df).toContain(`abox.template-hash="${'a'.repeat(64)}"`);
  });

  it('puts every build step in its own RUN, byte-exact via base64', () => {
    const nasty = `echo 'a' "b" $X \`id\` \\ \n# comment\nprintf '%s' "x"`;
    const t = fixed({
      build: [
        { name: 'one\nline', script: nasty },
        { name: 'two', script: 'true' },
      ],
    });
    const df = renderDockerfile(t);
    const scripts = decodeSteps(df);
    expect(scripts).toContain(nasty);
    expect(scripts).toContain('true');
    expect(df.split('\n').filter((l) => l.startsWith('RUN f=/tmp/.abox-step-')).length).toBe(3); // user + 2 steps
    expect(df).toContain('# step: one line');
    // the raw script never appears unencoded in the Dockerfile
    expect(df).not.toContain('printf \'%s\' "x"');
  });

  it('creates the non-root user, workspace and drops to it', () => {
    const df = renderDockerfile(fixed());
    expect(df).toContain('USER 1000:1000');
    expect(df).toContain('WORKDIR /workspace');
    expect(df).toContain("chown 1000:1000 '/workspace'");
    expect(df.indexOf('USER 1000:1000')).toBeGreaterThan(df.lastIndexOf('# step:'));
  });

  it('user setup per OS family; sudo only when requested', () => {
    const user = { name: 'dev', uid: 1000, sudo: false };
    expect(userSetupScript(user, 'alpine')).toContain('adduser -D');
    expect(userSetupScript(user, 'alpine')).not.toContain('useradd');
    for (const fam of ['debian', 'fedora', 'arch'] as const) {
      const s = userSetupScript(user, fam);
      expect(s).toContain('groupadd -g');
      expect(s).toContain('useradd -m');
      expect(s).not.toContain('sudo');
    }
    const unknown = userSetupScript(user, 'unknown');
    expect(unknown).toContain('useradd');
    expect(unknown).toContain('adduser');
    expect(userSetupScript({ ...user, sudo: true }, 'debian')).toContain('/etc/sudoers.d/abox');
  });

  it('quotes hostile user names', () => {
    expect(
      userSetupScript({ name: "x'; rm -rf /; '", uid: 1000, sudo: false }, 'alpine'),
    ).toContain(`NAME=${shq("x'; rm -rf /; '")}`);
  });

  it('requires a baseRef for templates with their own Dockerfile', () => {
    const t = fixed({ base: { dockerfile: './Dockerfile', osFamily: 'debian' } });
    expect(() => renderDockerfile(t)).toThrow(/baseRef/);
    expect(renderDockerfile(t, { baseRef: 'abox/x-base:1' })).toContain('FROM abox/x-base:1\n');
  });

  it('emits template env as ENV before the steps, escaped', () => {
    const df = renderDockerfile(fixed({ env: { RUSTUP_HOME: '/opt/rustup', X: 'a "b" $c' } }));
    expect(df).toContain('ENV RUSTUP_HOME="/opt/rustup"');
    expect(df).toContain('ENV X="a \\"b\\" \\$c"');
    expect(df.indexOf('ENV RUSTUP_HOME')).toBeLessThan(df.indexOf('# step:'));
    expect(() => renderDockerfile(fixed({ env: { 'BAD NAME': 'x' } }))).toThrow(
      /invalid environment/,
    );
  });

  it('is deterministic', () => {
    expect(renderDockerfile(fixed())).toBe(renderDockerfile(fixed()));
  });
});
