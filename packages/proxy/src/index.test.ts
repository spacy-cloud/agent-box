import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseProxyLogLine,
  proxyImageDockerfile,
  proxyImageFiles,
  proxyImageTag,
  proxyRuntimeDir,
} from './index.js';

describe('image + runtime exports', () => {
  it('proxyRuntimeDir is absolute and holds the image build context', () => {
    expect(isAbsolute(proxyRuntimeDir)).toBe(true);
    for (const f of proxyImageFiles) expect(existsSync(join(proxyRuntimeDir, f)), f).toBe(true);
  });

  it('runtime/Dockerfile is identical to proxyImageDockerfile', () => {
    expect(readFileSync(join(proxyRuntimeDir, 'Dockerfile'), 'utf8')).toBe(proxyImageDockerfile);
  });

  it('Dockerfile follows the contract', () => {
    expect(proxyImageDockerfile).toContain('FROM node:24-alpine');
    expect(proxyImageDockerfile).toContain('apk add --no-cache openssl');
    expect(proxyImageDockerfile).toContain('-u 10001');
    expect(proxyImageDockerfile).toContain('COPY proxy.mjs lib.mjs /opt/abox-proxy/');
    expect(proxyImageDockerfile).toContain('USER 10001');
    expect(proxyImageDockerfile).toContain('ENTRYPOINT ["node","/opt/abox-proxy/proxy.mjs"]');
  });

  it('proxyImageTag hashes proxy.mjs + lib.mjs + Dockerfile', () => {
    const h = createHash('sha256');
    h.update(readFileSync(join(proxyRuntimeDir, 'proxy.mjs')));
    h.update(readFileSync(join(proxyRuntimeDir, 'lib.mjs')));
    h.update(readFileSync(join(proxyRuntimeDir, 'Dockerfile')));
    expect(proxyImageTag()).toBe(`abox/proxy:${h.digest('hex').slice(0, 12)}`);
    expect(proxyImageTag()).toMatch(/^abox\/proxy:[0-9a-f]{12}$/);
  });
});

describe('parseProxyLogLine', () => {
  it('parses allow and deny request lines', () => {
    expect(
      parseProxyLogLine(
        '{"ts":1760000000000,"event":"request","method":"CONNECT","host":"github.com","port":443,"ip":"140.82.121.4","decision":"allow"}',
      ),
    ).toEqual({
      ts: 1760000000000,
      method: 'CONNECT',
      host: 'github.com',
      port: 443,
      ip: '140.82.121.4',
      decision: 'allow',
    });
    expect(
      parseProxyLogLine(
        '{"ts":1760000000001,"event":"request","method":"CONNECT","host":"evil.example","port":443,"decision":"deny","reason":"not in allowlist"}',
      ),
    ).toEqual({
      ts: 1760000000001,
      method: 'CONNECT',
      host: 'evil.example',
      port: 443,
      decision: 'deny',
      reason: 'not in allowlist',
    });
  });

  it('drops extra fields (mitm/injected flags)', () => {
    const e = parseProxyLogLine(
      '{"ts":1,"event":"request","method":"GET","host":"a.com","port":443,"ip":"1.2.3.4","decision":"allow","mitm":true,"injected":true}',
    );
    expect(e).toEqual({
      ts: 1,
      method: 'GET',
      host: 'a.com',
      port: 443,
      ip: '1.2.3.4',
      decision: 'allow',
    });
  });

  it('parses ready', () => {
    expect(parseProxyLogLine('{"ts":1,"event":"ready"}')).toEqual({ event: 'ready' });
    expect(parseProxyLogLine('{"ts":1,"event":"ready","port":3128}')).toEqual({
      event: 'ready',
      port: 3128,
    });
  });

  it('ignores everything else', () => {
    for (const line of [
      '',
      'hello',
      '{',
      '[]',
      'null',
      '{"event":"warn"}',
      '{"event":"shutdown"}',
      '{"event":"request"}',
      '{"event":"request","ts":1,"method":"GET","host":"a","port":"443","decision":"allow"}',
      '{"event":"request","ts":1,"method":"GET","host":"a","port":443,"decision":"maybe"}',
    ]) {
      expect(parseProxyLogLine(line), line).toBeUndefined();
    }
  });
});
