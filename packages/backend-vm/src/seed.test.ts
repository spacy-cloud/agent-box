import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILD_OK_MARKER,
  createSeedImage,
  missingSeedTools,
  renderPrepareScript,
  renderSeed,
} from './seed.js';

const input = {
  user: { name: 'agent', uid: 1000, sudo: false },
  workspacePath: '/workspace',
  steps: [
    { name: 'apt: git curl', script: 'set -eu\napt-get install -y git curl\n' },
    { name: `setup #2 with 'quotes' and "double"`, script: 'set -eu\necho hi\n' },
  ],
};

describe('renderPrepareScript', () => {
  it('installs the guest agent, creates the user, runs the steps in order and powers off', () => {
    const s = renderPrepareScript(input);
    expect(s.startsWith('#!/bin/bash\n')).toBe(true);
    expect(s).toContain('qemu-guest-agent');
    expect(s).toContain("useradd -m -u 1000 -g 'agent' -s /bin/bash 'agent'");
    expect(s.indexOf('/usr/local/lib/abox/steps/01.sh')).toBeGreaterThan(s.indexOf('useradd'));
    expect(s.indexOf('/usr/local/lib/abox/steps/02.sh')).toBeGreaterThan(
      s.indexOf('/usr/local/lib/abox/steps/01.sh'),
    );
    expect(s).toContain('touch /etc/cloud/cloud-init.disabled');
    expect(s).toContain(BUILD_OK_MARKER);
    expect(s.trimEnd().endsWith('sleep 120')).toBe(true);
    expect(s).toContain('systemctl poweroff');
    expect(s).toContain('/dev/virtio-ports/abox.build');
  });

  it('does not grant sudo unless the template asks for it', () => {
    expect(renderPrepareScript(input)).not.toContain('NOPASSWD');
    expect(renderPrepareScript(input)).toContain('rm -f /etc/sudoers.d/90-abox');
    const sudo = renderPrepareScript({ ...input, user: { ...input.user, sudo: true } });
    expect(sudo).toContain('agent ALL=(ALL) NOPASSWD:ALL');
    expect(sudo).toContain('ca-certificates sudo');
  });

  it('quotes step names so they can not break out of the script', () => {
    const s = renderPrepareScript(input);
    // the name with quotes appears only inside single-quoted (escaped) strings
    expect(s).toContain(`say 'step 2/2: setup #2 with '\\''quotes'\\'' and "double"'`);
    expect(s).not.toMatch(/\n[^\n]*\$\(.*quotes/);
  });
});

describe('renderSeed', () => {
  it('produces a cloud-config that writes the scripts (base64) and runs the build script', () => {
    const { userData, metaData } = renderSeed(input, 'abox-build-123');
    expect(userData.startsWith('#cloud-config\n')).toBe(true);
    const doc = JSON.parse(userData.slice('#cloud-config\n'.length)) as {
      users: Array<{ name: string }>;
      write_files: Array<{ path: string; encoding: string; content: string; permissions: string }>;
      runcmd: string[][];
    };
    expect(doc.users).toEqual([{ name: 'root' }]); // suppresses the default user
    expect(doc.runcmd).toEqual([['/bin/bash', '/usr/local/lib/abox/prepare.sh']]);
    const paths = doc.write_files.map((f) => f.path);
    expect(paths).toEqual([
      '/usr/local/lib/abox/prepare.sh',
      '/usr/local/lib/abox/steps/01.sh',
      '/usr/local/lib/abox/steps/02.sh',
    ]);
    const step1 = doc.write_files[1];
    expect(step1?.encoding).toBe('b64');
    expect(Buffer.from(step1?.content ?? '', 'base64').toString()).toBe(input.steps[0]?.script);
    expect(step1?.permissions).toBe('0700');
    expect(metaData).toBe('instance-id: abox-build-123\nlocal-hostname: abox\n');
  });
});

describe('createSeedImage', () => {
  it.skipIf(missingSeedTools().length > 0)(
    'creates a FAT volume labelled CIDATA with user-data and meta-data',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'abox-seed-test-'));
      try {
        const img = join(dir, 'seed.img');
        const seed = renderSeed(input, 'iid-1');
        await createSeedImage(img, seed);
        const label = execFileSync('blkid', ['-o', 'value', '-s', 'LABEL', img], {
          encoding: 'utf8',
        }).trim();
        expect(label).toBe('CIDATA');
        expect(execFileSync('mtype', ['-i', img, '::user-data'], { encoding: 'utf8' })).toBe(
          seed.userData,
        );
        expect(execFileSync('mtype', ['-i', img, '::meta-data'], { encoding: 'utf8' })).toBe(
          seed.metaData,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
