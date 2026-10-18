// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedProfile } from '@abox/core';
import { PolicyForm } from '../../src/renderer/components/PolicyForm';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const TEXT = `# policy
version: 1
profiles:
  agent:
    approval: strict
    limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }
    network: { modes: [none], allow_presets: [npm], allow: [] }
    isolation: { min: container }
  child:
    extends: agent
contexts:
  sim: { profile: agent }
`;

const RESOLVED = {
  agent: {
    approval: 'strict',
    exec: { approval: false },
    limits: { sandboxes: 3, cpus: 4, memory: '8g', ttl: '4h' },
    isolation: {
      min: 'container',
      network_open: 'vm',
      mounts: 'container',
      secrets_env: 'container',
    },
    network: { modes: ['none'], allow_presets: ['npm'], allow: [] },
    images: { registries: ['docker.io/library'] },
    caches: true,
    cache_max_bytes: '10g',
    workspace: { modes: ['empty'], roots: [] },
    templates: [],
    hosts: ['local'],
  },
} as unknown as Record<string, ResolvedProfile>;

function Host(props: { initial?: string }) {
  const [text, setText] = useState(props.initial ?? TEXT);
  return (
    <>
      <PolicyForm text={text} onText={setText} resolved={RESOLVED} />
      <pre data-testid="text">{text}</pre>
    </>
  );
}
const text = () => screen.getByTestId('text').textContent ?? '';

describe('PolicyForm', () => {
  it('edits the policy text field by field and keeps the rest (comments, layout) as it was', () => {
    installBridge(() => undefined);
    renderApp(<Host />);
    const form = screen.getByRole('form', { name: 'Profile und Limits' });
    fireEvent.change(within(form).getByLabelText('Freigabemodus'), { target: { value: 'open' } });
    expect(text()).toContain('approval: open');
    fireEvent.change(within(form).getByLabelText('Speicher je Sandbox'), {
      target: { value: '4g' },
    });
    expect(text()).toContain('limits: { sandboxes: 3, cpus: 4, memory: 4g, ttl: 4h }');
    fireEvent.change(within(form).getByLabelText('Sandboxes gleichzeitig'), {
      target: { value: '10' },
    });
    expect(text()).toContain('sandboxes: 10');
    expect(text()).toContain('# policy');
    expect(text()).toContain('contexts:\n  sim: { profile: agent }');
  });

  it('edits lists as words and shows the inherited value as a placeholder', () => {
    installBridge(() => undefined);
    renderApp(<Host />);
    const modes = screen.getByLabelText('Netzwerk-Modi') as HTMLInputElement;
    fireEvent.change(modes, { target: { value: 'none allowlist' } });
    expect(text()).toContain('modes: [none, allowlist]');
    // the profile "child" inherits everything: the fields are empty, the placeholder shows what applies
    fireEvent.change(screen.getByLabelText('Profil'), { target: { value: 'child' } });
    expect((screen.getByLabelText('Speicher je Sandbox') as HTMLInputElement).value).toBe('');
    // (the hints come from the policy in force; "child" is not part of it, so its placeholder is empty)
    expect((screen.getByLabelText('Freigabemodus') as HTMLSelectElement).value).toBe('');
  });

  it('edits the package caches switch and size cap; the inherited values are the placeholders', () => {
    installBridge(() => undefined);
    renderApp(<Host />);
    const use = screen.getByLabelText('Paket-Caches erlauben') as HTMLSelectElement;
    expect(use.value).toBe('');
    expect(within(use).getByRole('option', { name: '(geerbt oder Standard: ja)' })).toBeTruthy();
    fireEvent.change(use, { target: { value: 'false' } });
    expect(text()).toContain('caches: false');
    const cap = screen.getByLabelText('Größenlimit je Projekt') as HTMLInputElement;
    expect(cap.placeholder).toBe('10g');
    fireEvent.change(cap, { target: { value: '2g' } });
    expect(text()).toContain('cache_max_bytes: 2g');
    fireEvent.change(use, { target: { value: '' } });
    fireEvent.change(cap, { target: { value: '' } });
    expect(text()).not.toContain('cache');
    expect(text()).toContain('contexts:\n  sim: { profile: agent }');
  });

  it('clearing a field removes it again (and an emptied map with it)', () => {
    installBridge(() => undefined);
    renderApp(<Host />);
    const iso = screen.getByLabelText('Minimum') as HTMLSelectElement;
    expect(iso.value).toBe('container');
    fireEvent.change(iso, { target: { value: '' } });
    expect(text()).not.toContain('isolation');
  });

  it('marks isolation "none" in red, in the select and next to it', () => {
    installBridge(() => undefined);
    renderApp(<Host />);
    const iso = screen.getByLabelText('Minimum');
    expect(document.querySelector('.badge-strong-danger')).toBeNull();
    fireEvent.change(iso, { target: { value: 'none' } });
    expect(text()).toContain('min: none');
    const badge = document.querySelector('.badge-strong-danger')!;
    expect(badge.textContent).toContain('Keine Isolation');
    expect(
      within(iso as HTMLElement).getByRole('option', { name: /⚠ Keine Isolation/ }),
    ).toBeTruthy();
  });

  it('is off while the YAML is broken and says why', () => {
    installBridge(() => undefined);
    renderApp(<Host initial="profiles: [oops" />);
    expect(screen.getByText(/Das YAML hat Fehler/)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('explains a policy without profiles', () => {
    installBridge(() => undefined);
    renderApp(<Host initial="version: 1\n" />);
    expect(screen.getByText('Die Policy enthält noch keine Profile.')).toBeTruthy();
  });
});
