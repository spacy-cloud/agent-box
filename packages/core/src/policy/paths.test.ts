import { createServer } from 'node:net';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AboxError } from '../errors.js';
import {
  canonicalizePath,
  checkHostPath,
  checkMountTarget,
  foldPath,
  isWithin,
  isWithinFolded,
} from './paths.js';
import { makeEnv, type TestEnv } from './__tests__/helpers.js';

const cp = (...c: number[]): string => String.fromCodePoint(...c);

let env: TestEnv;
beforeAll(() => {
  env = makeEnv();
});
afterAll(() => env.cleanup());

const canon = (p: string, cwd?: string): string =>
  canonicalizePath(p, { home: env.home, cwd: cwd ?? env.projects });

describe('canonicalizePath', () => {
  it('expands ~ and ~/x', () => {
    expect(canon('~')).toBe(env.home);
    expect(canon('~/projects/app')).toBe(env.app);
  });

  it('rejects ~user', () => {
    expect(() => canon('~root/x')).toThrow(AboxError);
  });

  it('resolves relative paths against cwd', () => {
    expect(canon('app')).toBe(env.app);
    expect(canon('./app/../app/.')).toBe(env.app);
    expect(canon('../datasets', env.app)).toBe(join(env.projects, 'datasets'));
    expect(canon('../../datasets', env.app)).toBe(env.datasets);
  });

  it('collapses .., double slashes and trailing slashes', () => {
    expect(canon(`${env.projects}//app///`)).toBe(env.app);
    expect(canon(`${env.app}/../../.ssh`)).toBe(env.sshDir);
    expect(canon('/../../..')).toBe('/');
    expect(canon('/')).toBe('/');
  });

  it('cannot escape upward beyond root with ..', () => {
    expect(canon(`${env.app}/${'../'.repeat(50)}etc`)).toBe('/etc');
  });

  it('rejects NUL bytes', () => {
    expect(() => canon(`${env.app}/a${cp(0)}b`)).toThrow(/forbidden character/);
  });

  it.each([
    ['newline', 0x0a],
    ['escape', 0x1b],
    ['DEL', 0x7f],
    ['C1 control', 0x85],
    ['RTL override', 0x202e],
    ['LTR override', 0x202d],
    ['bidi isolate', 0x2066],
    ['zero width space', 0x200b],
    ['zero width joiner', 0x200d],
    ['zero width non-joiner', 0x200c],
    ['word joiner', 0x2060],
    ['BOM / zero width no-break space', 0xfeff],
    ['soft hyphen', 0xad],
    ['line separator', 0x2028],
    ['hangul filler', 0x3164],
  ])('rejects %s', (_name, code) => {
    expect(() => canon(`${env.app}/x${cp(code)}y`)).toThrow(AboxError);
  });

  it('rejects empty input and overlong input', () => {
    expect(() => canon('')).toThrow(AboxError);
    expect(() => canon('/' + 'a'.repeat(5000))).toThrow(AboxError);
  });

  it('NFC-normalizes', () => {
    const nfd = 'cafe\u0301';
    const nfc = 'caf\u00e9';
    expect(canon(`${env.app}/${nfd}`)).toBe(`${env.app}/${nfc}`);
  });

  it('resolves symlinks of the existing part and appends the missing remainder', () => {
    const link = join(env.projects, 'to-datasets');
    symlinkSync(env.datasets, link);
    expect(canon(link)).toBe(env.datasets);
    expect(canon(`${link}/new/dir`)).toBe(`${env.datasets}/new/dir`);
  });

  it('resolves a symlink to a forbidden directory to the real target', () => {
    const link = join(env.app, 'innocent');
    symlinkSync(env.sshDir, link);
    expect(canon(link)).toBe(env.sshDir);
    expect(canon(`${link}/id_ed25519`)).toBe(`${env.sshDir}/id_ed25519`);
  });

  it('follows the physical parent for link/.. (not the lexical one)', () => {
    const deep = join(env.datasets, 'deep');
    mkdirSync(deep);
    const link = join(env.app, 'deeplink');
    symlinkSync(deep, link);
    // lexically app/deeplink/.. = app, physically = datasets
    expect(canon(`${link}/..`)).toBe(env.datasets);
    expect(canon(`${link}/../deep`)).toBe(deep);
  });

  it('handles relative symlink targets and chains', () => {
    const a = join(env.app, 'chain-a');
    const b = join(env.app, 'chain-b');
    symlinkSync('chain-b', a);
    symlinkSync(env.datasets, b);
    expect(canon(a)).toBe(env.datasets);
  });

  it('rejects symlink loops', () => {
    const l1 = join(env.app, 'loop1');
    const l2 = join(env.app, 'loop2');
    symlinkSync(l2, l1);
    symlinkSync(l1, l2);
    expect(() => canon(l1)).toThrow(/symbolic links/);
  });

  it('is idempotent', () => {
    const once = canon(`${env.app}/../app//x/./y/`);
    expect(canon(once)).toBe(once);
  });
});

describe('isWithin / fold', () => {
  it('works on component boundaries', () => {
    expect(isWithin('/a/b', '/a')).toBe(true);
    expect(isWithin('/a', '/a')).toBe(true);
    expect(isWithin('/ab', '/a')).toBe(false);
    expect(isWithin('/anything', '/')).toBe(true);
    expect(isWithin('/a', '/a/b')).toBe(false);
  });
  it('folds case and NFKC', () => {
    expect(foldPath('/Home/U/.SSH')).toBe('/home/u/.ssh');
    expect(foldPath('/home/u/\uff0e\uff53\uff53\uff48')).toBe('/home/u/.ssh');
    expect(isWithinFolded('/HOME/u/X', '/home/U')).toBe(true);
  });
});

function check(p: string, extra: Partial<Parameters<typeof checkHostPath>[1]> = {}) {
  return checkHostPath(p, { home: env.home, roots: [env.home], kind: 'mount', ...extra });
}

describe('checkHostPath: forbidden list', () => {
  it('allows normal project paths below a root', () => {
    expect(check(env.app, { roots: [env.projects] })).toEqual({ ok: true });
    expect(check(env.projects, { roots: [env.projects] })).toEqual({ ok: true });
  });

  it.each([
    '/',
    '/etc',
    '/etc/passwd',
    '/etc/ssh/sshd_config',
    '/proc',
    '/proc/1/environ',
    '/sys',
    '/dev',
    '/dev/shm',
    '/boot',
    '/root',
    '/root/.bashrc',
    '/run',
    '/run/user/1000/bus',
    '/var/run',
    '/var/run/docker.sock',
    '/var/lib/docker',
    '/var/lib/docker/volumes',
    '/var/lib/containers/storage',
  ])('forbids %s (even with root /)', (p) => {
    const r = check(p, { roots: ['/'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['forbidden', 'socket']).toContain(r.code);
  });

  it('forbids the home directory itself but not its normal subdirectories', () => {
    const r = check(env.home);
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check(env.app)).toEqual({ ok: true });
  });

  it.each([
    '.ssh',
    '.gnupg',
    '.config',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.local/share/keyrings',
    '.password-store',
    '.mozilla',
    '.netrc',
    '.git-credentials',
    '.npmrc',
    '.pypirc',
    '.var/app',
    '.var/app/org.mozilla.firefox',
  ])('forbids ~/%s and everything below', (rel) => {
    expect(check(join(env.home, rel))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check(join(env.home, rel, 'inner/file'))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('does not over-match on name prefixes', () => {
    expect(check(join(env.home, '.sshx'))).toEqual({ ok: true });
    expect(check(join(env.home, '.config-backup'))).toEqual({ ok: true });
  });

  it('forbids ancestors of forbidden paths (mounting ~ parents)', () => {
    expect(check(env.home)).toMatchObject({ ok: false });
    const parentOfHome = env.root;
    expect(check(parentOfHome, { roots: ['/'] })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check('/var', { roots: ['/'] })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check(join(env.home, '.local/share'), { roots: [env.home] })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(check(join(env.home, '.local'), { roots: [env.home] })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('is case-insensitive', () => {
    expect(check(join(env.home, '.SSH'))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check(join(env.home, '.Ssh/id_rsa'))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check(env.home.toUpperCase(), { roots: ['/'] })).toMatchObject({ ok: false });
    expect(check('/ETC/passwd', { roots: ['/'] })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check('/Var/Run', { roots: ['/'] })).toMatchObject({ ok: false });
  });

  it('folds fullwidth characters (NFKC) to .ssh', () => {
    const fullwidth = '\uff0e\uff53\uff53\uff48'; // fullwidth dot + s s h
    expect(check(join(env.home, fullwidth))).toMatchObject({ ok: false, code: 'forbidden' });
    // one component whose fullwidth solidus folds to a path separator
    const fullwidthSlash = `${env.home}${String.fromCodePoint(0xff0f)}.ssh`;
    expect(check(fullwidthSlash)).toMatchObject({ ok: false });
    expect(check('/\uff45\uff54\uff43', { roots: ['/'] })).toMatchObject({
      ok: false,
      code: 'forbidden',
    }); // /\uff45\uff54\uff43
  });

  it('folds Kelvin sign and other compatibility characters', () => {
    expect(check(join(env.home, '.\u212a' + 'ube'))).toMatchObject({
      ok: false,
      code: 'forbidden',
    }); // .Kube with KELVIN SIGN
  });

  it('treats NFD and NFC spellings of an extra forbidden path as equal', () => {
    const nfc = join(env.root, 'caf\u00e9-data');
    const nfd = join(env.root, 'cafe\u0301-data');
    expect(check(nfd, { roots: [env.root], extraForbidden: [nfc] })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(check(nfc, { roots: [env.root], extraForbidden: [nfd] })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('rejects zero-width / bidi characters even if the caller skipped canonicalization', () => {
    expect(check(join(env.home, '.ss\u200dh'))).toMatchObject({ ok: false, code: 'invalid' });
    expect(check(join(env.home, '\u202e' + 'hss.'))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('rejects non-canonical input', () => {
    expect(check('relative/path')).toMatchObject({ ok: false, code: 'invalid' });
    expect(check(`${env.app}/../.ssh`)).toMatchObject({ ok: false, code: 'invalid' });
    expect(check(`${env.app}/./x`)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('honors extraForbidden (abox dirs, other sandboxes) including descendants and ancestors', () => {
    const aboxData = join(env.home, 'abox-data');
    mkdirSync(join(aboxData, 'sandboxes', 'x'), { recursive: true });
    const opts = { roots: [env.home], extraForbidden: [aboxData] };
    expect(check(aboxData, opts)).toMatchObject({ ok: false });
    expect(check(join(aboxData, 'sandboxes/x'), opts)).toMatchObject({ ok: false });
    expect(check(env.home, opts)).toMatchObject({ ok: false });
    expect(check(env.app, opts)).toEqual({ ok: true });
  });

  it('forbids symlinked forbidden dirs via their real location (dotfile managers)', () => {
    const real = join(env.root, 'dotfiles', 'gnupg');
    mkdirSync(real, { recursive: true });
    // replace ~/.gnupg by a symlink to somewhere else
    symlinkSync(real, join(env.home, '.gnupg'));
    expect(check(real, { roots: [env.root] })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(check(join(real, 'private-keys-v1.d'), { roots: [env.root] })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('forbids real paths below a symlinked home directory', () => {
    const realHome = join(env.root, 'realhome');
    mkdirSync(join(realHome, '.ssh'), { recursive: true });
    mkdirSync(join(realHome, 'proj'), { recursive: true });
    const linkHome = join(env.root, 'linkhome');
    symlinkSync(realHome, linkHome);
    expect(
      checkHostPath(join(realHome, '.ssh'), { home: linkHome, roots: [realHome], kind: 'mount' }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(
      checkHostPath(realHome, { home: linkHome, roots: [env.root], kind: 'mount' }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(
      checkHostPath(join(realHome, 'proj'), { home: linkHome, roots: [realHome], kind: 'mount' }),
    ).toEqual({ ok: true });
  });
});

describe('checkHostPath: symlinks via canonicalizePath', () => {
  it('a symlink in the workspace to ~/.ssh ends up forbidden', () => {
    const link = join(env.app, 'sneaky');
    symlinkSync(env.sshDir, link);
    const c = canon(link);
    expect(check(c, { roots: [env.projects], kind: 'workspace' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(
      check(canon(join(link, 'id_ed25519')), { roots: [env.projects], kind: 'workspace' }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('a symlink in the workspace pointing outside the roots ends up outside_roots', () => {
    const link = join(env.app, 'out');
    symlinkSync(env.datasets, link);
    expect(check(canon(link), { roots: [env.projects] })).toMatchObject({
      ok: false,
      code: 'outside_roots',
    });
  });

  it('case variant of a real directory name is still forbidden', () => {
    expect(check(canon(join(env.home, '.SSH', 'id_ed25519')))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });
});

describe('checkHostPath: roots', () => {
  it('requires the path to be within a root', () => {
    expect(check(env.datasets, { roots: [env.projects] })).toMatchObject({
      ok: false,
      code: 'outside_roots',
    });
    expect(check(env.app, { roots: [env.datasets, env.projects] })).toEqual({ ok: true });
  });
  it('no roots means nothing is allowed', () => {
    expect(check(env.app, { roots: [] })).toMatchObject({ ok: false, code: 'outside_roots' });
  });
  it('a root of ~ does not make forbidden paths usable', () => {
    expect(check(env.sshDir, { roots: [env.home] })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(check(env.app, { roots: [env.home] })).toEqual({ ok: true });
  });
  it('root prefix is matched on components', () => {
    expect(check(`${env.projects}-evil/x`, { roots: [env.projects] })).toMatchObject({
      ok: false,
      code: 'outside_roots',
    });
  });
});

describe('checkHostPath: sockets', () => {
  it('forbids docker.sock / podman.sock by name, any case, any type', () => {
    const f = join(env.datasets, 'docker.sock');
    writeFileSync(f, 'not a socket');
    expect(check(f, { roots: [env.datasets] })).toMatchObject({ ok: false, code: 'socket' });
    expect(check(join(env.datasets, 'Podman.SOCK'), { roots: [env.datasets] })).toMatchObject({
      ok: false,
      code: 'socket',
    });
  });

  it('forbids a directory that contains a real socket file (mount), but not for plain workspace copies', async () => {
    const dir = join(env.datasets, 'with-socket');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const sock = join(dir, 'nested', 'app.sock');
    const server = createServer();
    await new Promise<void>((res) => server.listen(sock, res));
    try {
      const r = check(dir, { roots: [env.datasets] });
      expect(r).toMatchObject({ ok: false, code: 'socket' });
      if (!r.ok) expect(r.reason).toContain('app.sock');
      expect(check(sock, { roots: [env.datasets] })).toMatchObject({ ok: false, code: 'socket' });
      // workspace modes that copy do not need the scan ...
      expect(check(dir, { roots: [env.datasets], kind: 'workspace' })).toEqual({ ok: true });
      // ... workspace mode mount does
      expect(
        check(dir, { roots: [env.datasets], kind: 'workspace', scanSockets: true }),
      ).toMatchObject({ ok: false, code: 'socket' });
    } finally {
      await new Promise((res) => server.close(res));
    }
  });

  it('allows a directory without sockets', () => {
    expect(check(env.app, { roots: [env.projects] })).toEqual({ ok: true });
  });
});

describe('checkMountTarget', () => {
  it('accepts normal targets', () => {
    expect(checkMountTarget('/data')).toEqual({ ok: true });
    expect(checkMountTarget('/home/user/datasets')).toEqual({ ok: true });
  });
  it.each([
    'relative',
    '/',
    '/etc',
    '/etc/ssl',
    '/proc/self',
    '/sys',
    '/dev/shm',
    '/run/secrets',
    '/var/run',
    '/a/../etc',
    '/a//b',
    '/ETC',
    `/x${cp(0x200b)}y`,
  ])('rejects %s', (t) => {
    expect(checkMountTarget(t)).toMatchObject({ ok: false });
  });
});
