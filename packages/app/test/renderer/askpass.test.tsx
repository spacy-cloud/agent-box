// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AskpassHost } from '../../src/renderer/components/AskpassDialog';
import type { AskpassEvent, AskpassEndEvent } from '../../src/shared/constants';
import { HIDDEN_CHARS, RLO } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

type Listener = (p: never) => void;

/** `window.abox` whose pushed events the test can fire. */
function bridge() {
  const listeners = new Map<string, Set<Listener>>();
  const calls = installBridge(() => undefined);
  const base = (window as unknown as { abox: { invoke: unknown } }).abox;
  (window as unknown as { abox: unknown }).abox = {
    invoke: base.invoke,
    on: (channel: string, fn: Listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(channel, set);
      return () => set.delete(fn);
    },
  };
  const emit = (channel: string, payload: AskpassEvent | AskpassEndEvent) =>
    act(() => {
      for (const fn of listeners.get(channel) ?? []) fn(payload as never);
    });
  return { calls, emit };
}

const REQ = '11111111-1111-4111-8111-111111111111';
const secret = (over: Partial<AskpassEvent> = {}): AskpassEvent => ({
  id: REQ,
  session: 'abox@lab1.example.org',
  prompt: "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
  mode: 'secret',
  ...over,
});
const answers = (calls: Array<{ channel: string; input: unknown }>) =>
  calls.filter((c) => c.channel === 'askpass:answer').map((c) => c.input);

describe('ssh passphrase dialog', () => {
  it('opens as an own dialog for the prompt, with the session named and the prompt labelled as ssh text', async () => {
    const { emit } = bridge();
    renderApp(<AskpassHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await emit('evt:askpass', secret());
    const dlg = await screen.findByRole('dialog', { name: 'SSH-Anmeldung: abox@lab1.example.org' });
    expect(within(dlg).getByText('Meldung von ssh (kann vom Server stammen)')).toBeTruthy();
    expect(dlg.textContent).toContain("Enter passphrase for key '/home/u/.ssh/id_ed25519': ");
    const input = within(dlg).getByLabelText('Eingabe') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    fireEvent.click(within(dlg).getByRole('checkbox', { name: 'Eingabe anzeigen' }));
    expect(input.type).toBe('text');
  });

  it('sends the typed value once, to the main process only, and closes', async () => {
    const { calls, emit } = bridge();
    renderApp(<AskpassHost />);
    await emit('evt:askpass', secret());
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText('Eingabe'), { target: { value: 'hunter2' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(answers(calls)).toEqual([{ id: REQ, value: 'hunter2' }]);
    // the value is nowhere in the page any more
    expect(document.body.innerHTML).not.toContain('hunter2');
  });

  it('Cancel and Esc answer with null (ssh then fails to authenticate)', async () => {
    const { calls, emit } = bridge();
    renderApp(<AskpassHost />);
    await emit('evt:askpass', secret());
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abbrechen' }),
    );
    await waitFor(() => expect(answers(calls)).toEqual([{ id: REQ, value: null }]));
    cleanup();
    const b2 = bridge();
    renderApp(<AskpassHost />);
    await b2.emit('evt:askpass', secret());
    fireEvent(await screen.findByRole('dialog'), new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(answers(b2.calls)).toEqual([{ id: REQ, value: null }]));
  });

  it('closes by itself when ssh stops waiting (the prompt is gone)', async () => {
    const { calls, emit } = bridge();
    renderApp(<AskpassHost />);
    await emit('evt:askpass', secret());
    await screen.findByRole('dialog');
    await emit('evt:askpass-end', { id: REQ });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(answers(calls)).toEqual([]);
  });

  it('queues prompts: one dialog at a time, in order', async () => {
    const { calls, emit } = bridge();
    renderApp(<AskpassHost />);
    await emit('evt:askpass', secret({ prompt: 'first' }));
    await emit(
      'evt:askpass',
      secret({ id: '22222222-2222-4222-8222-222222222222', prompt: 'second' }),
    );
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toContain('first');
    fireEvent.change(within(dlg).getByLabelText('Eingabe'), { target: { value: 'a' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('second'));
    expect(answers(calls)).toEqual([{ id: REQ, value: 'a' }]);
  });

  it('shows text from the server neutralised and capped', async () => {
    const { emit } = bridge();
    renderApp(<AskpassHost />);
    await emit(
      'evt:askpass',
      secret({ prompt: `Code${RLO}: ${'x'.repeat(3000)}`, session: `u@h${RLO}ost` }),
    );
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).not.toMatch(HIDDEN_CHARS);
    expect(dlg.textContent).toContain('\\u202e');
    expect(dlg.querySelector('.scroll-text')).toBeTruthy();
  });

  it('a host key question is never answerable: it is reported, not relayed', async () => {
    const { calls, emit } = bridge();
    renderApp(<AskpassHost />);
    await emit(
      'evt:askpass',
      secret({
        mode: 'refused',
        prompt: 'Are you sure you want to continue connecting (yes/no)? ',
      }),
    );
    const dlg = await screen.findByRole('dialog', {
      name: /Host-Schlüssel-Frage nicht beantwortet/,
    });
    expect(within(dlg).queryByLabelText('Eingabe')).toBeNull();
    expect(within(dlg).getByText(/Hosts“ am Fingerabdruck geprüft/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Schließen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(answers(calls)).toEqual([]); // main already finished it
  });

  it('confirm and info prompts have their own buttons', async () => {
    const { calls, emit } = bridge();
    renderApp(<AskpassHost />);
    await emit('evt:askpass', secret({ mode: 'confirm', prompt: 'Allow use of key?' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Ja' }));
    await waitFor(() => expect(answers(calls)).toEqual([{ id: REQ, value: '' }]));
    await emit(
      'evt:askpass',
      secret({
        id: '33333333-3333-4333-8333-333333333333',
        mode: 'info',
        prompt: 'Confirm user presence for key',
      }),
    );
    const dlg = await screen.findByRole('dialog', { name: /Hinweis von ssh/ });
    expect(within(dlg).queryByLabelText('Eingabe')).toBeNull();
  });
});
