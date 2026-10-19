import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchMarkers, MAX_DETECT_ENTRIES, scanProjectMarkers } from './detect.js';

describe('matchMarkers', () => {
  const names = (found: string[]): string[] => matchMarkers(found).map((c) => c.template);

  it('maps each marker to its template', () => {
    expect(names(['pubspec.yaml'])).toEqual(['flutter-dev']);
    expect(names(['Cargo.toml'])).toEqual(['rust-dev']);
    expect(names(['package.json'])).toEqual(['node-dev']);
    expect(names(['pyproject.toml'])).toEqual(['py-uv']);
    expect(names(['uv.lock'])).toEqual(['py-uv']);
    expect(names(['composer.json'])).toEqual(['php-dev']);
    expect(names(['index.php'])).toEqual(['php-dev']);
    expect(names(['README.md', 'Makefile'])).toEqual([]);
  });

  it('Cargo.toml with tauri.conf.json is a Tauri app, also with the files below src-tauri', () => {
    expect(names(['Cargo.toml', 'tauri.conf.json'])).toEqual(['tauri-dev', 'rust-dev']);
    expect(names(['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json'])).toEqual([
      'tauri-dev',
      'node-dev',
    ]);
    // the config alone (or Cargo.toml alone) is not enough
    expect(names(['tauri.conf.json'])).toEqual([]);
  });

  it('a Cargo.toml below src-tauri is only a Tauri marker, rust-dev needs the one at the top level', () => {
    const c = matchMarkers(['src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']);
    expect(c.map((x) => x.template)).toEqual(['tauri-dev']);
  });

  it('ranks by priority and keeps every matching template as an alternative', () => {
    expect(names(['package.json', 'composer.json', 'pyproject.toml'])).toEqual([
      'php-dev',
      'py-uv',
      'node-dev',
    ]);
    expect(names(['package.json', 'pubspec.yaml'])).toEqual(['flutter-dev', 'node-dev']);
  });

  it('a composer.json beats loose .php files, which are the weakest hint', () => {
    const c = matchMarkers(['composer.json', 'index.php', 'package.json']);
    expect(c.map((x) => x.template)).toEqual(['php-dev', 'node-dev']);
    expect(c[0]!.markers).toEqual(['composer.json']);
    expect(names(['index.php', 'package.json'])).toEqual(['node-dev', 'php-dev']);
  });

  it('says which markers matched', () => {
    const [tauri] = matchMarkers(['Cargo.toml', 'tauri.conf.json']);
    expect(tauri!.markers).toEqual(['tauri.conf.json', 'Cargo.toml']);
    expect(tauri!.reason).toBe('found tauri.conf.json and Cargo.toml (a Tauri app)');
    expect(matchMarkers(['package.json'])[0]!.reason).toBe(
      'found package.json (a Node.js project)',
    );
  });
});

describe('scanProjectMarkers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abox-detect-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds top-level markers and the well-known files below src-tauri', async () => {
    writeFileSync(join(dir, 'package.json'), '{ "scripts": { "postinstall": "exit 1" } }');
    writeFileSync(join(dir, 'uv.lock'), '');
    writeFileSync(join(dir, 'z.php'), '');
    writeFileSync(join(dir, 'a.PHP'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    mkdirSync(join(dir, 'src-tauri'));
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), '{}');
    writeFileSync(join(dir, 'src-tauri', 'Cargo.toml'), '');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'Cargo.toml'), '');
    const r = await scanProjectMarkers(dir);
    expect(r.truncated).toBe(false);
    // one .php file stands for all of them; nothing below node_modules is looked at
    expect(r.files).toEqual([
      'a.PHP',
      'package.json',
      'src-tauri/Cargo.toml',
      'src-tauri/tauri.conf.json',
      'uv.lock',
    ]);
  });

  it('does not look into other subdirectories', async () => {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'package.json'), '{}');
    mkdirSync(join(dir, 'tauri-app', 'src-tauri'), { recursive: true });
    writeFileSync(join(dir, 'tauri-app', 'src-tauri', 'Cargo.toml'), '');
    expect((await scanProjectMarkers(dir)).files).toEqual([]);
  });

  it('never follows symbolic links: a linked marker or a linked src-tauri does not count', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'abox-detect-out-'));
    try {
      writeFileSync(join(outside, 'Cargo.toml'), '');
      writeFileSync(join(outside, 'tauri.conf.json'), '{}');
      mkdirSync(join(outside, 'tauri'));
      writeFileSync(join(outside, 'tauri', 'tauri.conf.json'), '{}');
      symlinkSync(join(outside, 'Cargo.toml'), join(dir, 'Cargo.toml'));
      symlinkSync(join(outside, 'tauri'), join(dir, 'src-tauri'));
      symlinkSync(join(outside, 'missing.json'), join(dir, 'package.json'));
      writeFileSync(join(dir, 'pubspec.yaml'), 'name: x\n');
      expect((await scanProjectMarkers(dir)).files).toEqual(['pubspec.yaml']);
      // a link inside a real src-tauri is not followed either
      rmSync(join(dir, 'src-tauri'));
      mkdirSync(join(dir, 'src-tauri'));
      symlinkSync(join(outside, 'tauri.conf.json'), join(dir, 'src-tauri', 'tauri.conf.json'));
      expect((await scanProjectMarkers(dir)).files).toEqual(['pubspec.yaml']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a marker that is a directory is no marker', async () => {
    mkdirSync(join(dir, 'package.json'));
    expect((await scanProjectMarkers(dir)).files).toEqual([]);
  });

  it('cuts off a huge folder and says so', async () => {
    for (let i = 0; i < MAX_DETECT_ENTRIES + 5; i++) writeFileSync(join(dir, `f${i}.txt`), '');
    const r = await scanProjectMarkers(dir);
    expect(r.truncated).toBe(true);
    expect(r.files).toEqual([]);
  });

  it('fails for a folder that does not exist', async () => {
    await expect(scanProjectMarkers(join(dir, 'nope'))).rejects.toThrow();
  });
});
