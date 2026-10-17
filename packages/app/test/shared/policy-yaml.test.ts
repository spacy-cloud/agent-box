import { describe, expect, it } from 'vitest';
import { setProfileField } from '../../src/shared/policy-form';

const TEXT = `version: 1
profiles:
  agent:
    approval: medium # keep [ this ] comment
    limits: { sandboxes: 5, ttl: 4h }
    workspace: { roots: ['/srv/it''s here', "/tmp/x"], modes: [copy, empty] }
    network: { modes: [none, allowlist], allow: [] }
`;

describe('stringifyPolicy layout', () => {
  it('changes only the line that was edited, also next to quoted list entries and comments', () => {
    const out = setProfileField(TEXT, 'agent', ['limits', 'ttl'], '3h');
    const was = TEXT.split('\n');
    const now = out.split('\n');
    const changed = now.filter((l, i) => l !== was[i]);
    expect(changed).toEqual(['    limits: { sandboxes: 5, ttl: 3h }']);
  });
});
