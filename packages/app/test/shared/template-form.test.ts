import { describe, expect, it } from 'vitest';
import { detectOsFamily, listToolPresets, safeParseTemplateYaml } from '@abox/core';
import { BASE_IMAGES, osFamilyOf } from '../../src/shared/base-images';
import {
  applyForm,
  blankTemplate,
  copyName,
  duplicateTemplate,
  fieldKeyForPath,
  groupIssues,
  parseForm,
  splitList,
  toolWarnings,
} from '../../src/shared/template-form';

const SAMPLE = `# my comment
apiVersion: 1
name: demo
description: A demo environment for the tests, long enough.
backend: docker
isolation: container
base:
  os: ubuntu:24.04
packages:
  apt: [build-essential]
tools:
  - node@24
  - git
resources:
  cpus: 2
  memory: 4g # keep small
  ttl: 2h
network:
  mode: allowlist
  presets: [npm]
  allow:
    - example.org
mounts:
  - source: ~/data
    target: /data
    access: ro
env:
  FOO: bar
labels:
  use-for: tests
setup:
  - run: echo hi
`;

describe('parseForm', () => {
  it('reads every form field from the YAML', () => {
    const f = parseForm(SAMPLE);
    expect(f.valid).toBe(true);
    expect(f.name).toBe('demo');
    expect(f.baseOs).toBe('ubuntu:24.04');
    expect(f.packages.apt).toEqual(['build-essential']);
    expect(f.tools).toEqual(['node@24', 'git']);
    expect(f.cpus).toBe('2');
    expect(f.memory).toBe('4g');
    expect(f.networkMode).toBe('allowlist');
    expect(f.networkPresets).toEqual(['npm']);
    expect(f.networkAllow).toEqual(['example.org']);
    expect(f.mounts).toEqual([{ source: '~/data', target: '/data', access: 'ro' }]);
    expect(f.env).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('reports a YAML syntax error and leaves the form unusable instead of throwing', () => {
    const f = parseForm('name: [oops');
    expect(f.valid).toBe(false);
    expect(f.yamlError).toBeTruthy();
    expect(parseForm('- a\n- b').valid).toBe(false);
    expect(parseForm('').valid).toBe(true);
  });

  it('tolerates wrongly typed values (the validator reports them)', () => {
    const f = parseForm('tools: node\nresources:\n  memory: [1]\nenv: 5\n');
    expect(f.valid).toBe(true);
    expect(f.tools).toEqual([]);
    expect(f.memory).toBe('');
    expect(f.env).toEqual([]);
  });
});

describe('applyForm (form -> YAML)', () => {
  it('changes only the touched field and keeps comments, order and unknown sections', () => {
    const out = applyForm(SAMPLE, { memory: '8g' });
    expect(out).toContain('# my comment');
    expect(out).toContain('memory: 8g # keep small');
    expect(out).toContain('setup:');
    expect(out).toContain('use-for: tests');
    expect(parseForm(out).memory).toBe('8g');
    expect(parseForm(out).tools).toEqual(['node@24', 'git']);
  });

  it('writes numbers as numbers and leaves invalid text as typed for the validator', () => {
    expect(applyForm(SAMPLE, { cpus: '4' })).toMatch(/cpus: 4\n/);
    expect(applyForm(SAMPLE, { cpus: 'many' })).toMatch(/cpus: many\n/);
    expect(applyForm(SAMPLE, { pids: '512' })).toMatch(/pids: 512\n/);
  });

  it('removes a field when it is emptied, and the section when it becomes empty', () => {
    const out = applyForm('name: x\nresources:\n  ttl: 2h\n', { ttl: '' });
    expect(out).not.toContain('resources');
    const out2 = applyForm(SAMPLE, { networkAllow: [], networkPresets: [] });
    expect(out2).not.toContain('allow:');
    expect(out2).not.toContain('presets:');
    expect(out2).toContain('mode: allowlist');
  });

  it('creates missing sections and sets lists, mounts and env', () => {
    const out = applyForm('apiVersion: 1\nname: x\n', {
      baseOs: 'alpine:3.22',
      tools: ['git'],
      packages: { apt: [], apk: ['curl'], dnf: [], pacman: [], pip: [], npm: [] },
      mounts: [{ source: '~/a', target: '/a', access: '' }],
      env: [
        { key: 'A', value: '1' },
        { key: '', value: 'skipped' },
      ],
    });
    const f = parseForm(out);
    expect(f.baseOs).toBe('alpine:3.22');
    expect(f.packages.apk).toEqual(['curl']);
    expect(f.mounts).toEqual([{ source: '~/a', target: '/a', access: '' }]);
    expect(f.env).toEqual([{ key: 'A', value: '1' }]);
    expect(out).toContain('"1"'); // env values stay strings
  });

  it('does not touch text it cannot parse', () => {
    const broken = 'name: [oops';
    expect(applyForm(broken, { memory: '1g' })).toBe(broken);
  });

  it('round trip: form -> YAML -> form is stable, and the result still passes the real schema', () => {
    const f1 = parseForm(SAMPLE);
    const text = applyForm(SAMPLE, { ...f1, memory: '6g', tools: [...f1.tools, 'pnpm@10'] });
    const f2 = parseForm(text);
    expect({ ...f2, memory: f1.memory, tools: f1.tools }).toEqual(f1);
    expect(f2.memory).toBe('6g');
    expect(f2.tools).toContain('pnpm@10');
    expect(safeParseTemplateYaml(text).ok).toBe(true);
  });
});

describe('YAML -> form', () => {
  it('a YAML edit shows up in the form on the next parse', () => {
    const edited = SAMPLE.replace('cpus: 2', 'cpus: 8').replace('mode: allowlist', 'mode: none');
    const f = parseForm(edited);
    expect(f.cpus).toBe('8');
    expect(f.networkMode).toBe('none');
  });
});

describe('blank, duplicate, copy names', () => {
  it('the blank template is valid for the real schema', () => {
    const r = safeParseTemplateYaml(blankTemplate('fresh'));
    expect(r.ok).toBe(true);
  });
  it('duplicate keeps everything except the name', () => {
    const out = duplicateTemplate(SAMPLE, 'demo-copy');
    expect(parseForm(out).name).toBe('demo-copy');
    expect(out).toContain('# my comment');
    expect(out).toContain('setup:');
  });
  it('copyName avoids taken names', () => {
    expect(copyName('demo', new Set())).toBe('demo-copy');
    expect(copyName('demo', new Set(['demo-copy']))).toBe('demo-copy-2');
    expect(copyName('demo', new Set(['demo-copy', 'demo-copy-2']))).toBe('demo-copy-3');
  });
});

describe('issue to field mapping', () => {
  it('maps manager issue paths to form fields', () => {
    const cases: Record<string, string> = {
      name: 'name',
      'base.os': 'baseOs',
      'resources.memory': 'memory',
      'resources.cpus': 'cpus',
      'tools[1]': 'tools',
      'packages.apt[0]': 'packages.apt',
      'network.allow[2]': 'networkAllow',
      'network.presets[0]': 'networkPresets',
      'mounts[0].source': 'mounts',
      'env.FOO': 'env',
      user: 'other',
    };
    for (const [path, field] of Object.entries(cases))
      expect(fieldKeyForPath(path), path).toBe(field);
    expect(fieldKeyForPath(undefined)).toBe('other');
  });
  it('groups issues', () => {
    const g = groupIssues([
      { path: 'resources.memory', message: 'bad' },
      { path: 'resources.memory', message: 'worse' },
      { message: 'general' },
    ]);
    expect(g['memory']).toHaveLength(2);
    expect(g['other']).toHaveLength(1);
  });
});

describe('os family and tool warnings', () => {
  it('osFamilyOf agrees with detectOsFamily of @abox/core', () => {
    const samples = [
      'ubuntu:24.04',
      'debian:12',
      'alpine:3.22',
      'python:3.13-slim-bookworm',
      'python:3.13-alpine',
      'node:24-alpine',
      'fedora:41',
      'archlinux:latest',
      'docker.io/library/ubuntu@sha256:abc',
      'ghcr.io/x/y:1',
      'ubuntu-24.04',
      'debian-12',
      'busybox',
      '',
    ];
    for (const s of samples) expect(osFamilyOf(s), s).toBe(detectOsFamily(s));
    for (const b of BASE_IMAGES) expect(osFamilyOf(b.ref), b.ref).toBe(b.family);
  });

  it('warns about tools without a preset for the OS, and about unknown tools', () => {
    const catalog = listToolPresets().map((p) => ({
      name: p.name,
      summary: p.summary,
      version: p.version,
      os: Object.keys(p.install) as Array<'debian' | 'alpine'>,
    }));
    const onlyDebian = catalog.find((c) => c.os.length === 1 && c.os[0] === 'debian');
    expect(onlyDebian).toBeDefined();
    const w = toolWarnings([onlyDebian!.name, 'no-such-tool', 'git'], 'alpine:3.22', catalog);
    expect(w.find((x) => x.tool === onlyDebian!.name)?.reason).toBe('no-preset-for-os');
    expect(w.find((x) => x.tool === 'no-such-tool')?.reason).toBe('unknown-tool');
    expect(toolWarnings([onlyDebian!.name], 'ubuntu:24.04', catalog)).toEqual([]);
    // unknown OS: no OS-specific warning
    expect(toolWarnings([onlyDebian!.name], 'custom/image', catalog)).toEqual([]);
  });

  it('splitList', () => {
    expect(splitList('a, b\n c  d')).toEqual(['a', 'b', 'c', 'd']);
  });
});
