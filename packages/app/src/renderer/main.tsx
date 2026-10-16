import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { call } from './api';
import './styles.css';

async function start(): Promise<void> {
  const root = createRoot(document.getElementById('root')!);
  try {
    const info = await call('app:info');
    document.documentElement.lang = info.locale;
    root.render(
      <StrictMode>
        <App info={info} />
      </StrictMode>,
    );
  } catch (e) {
    // The bridge is missing or the main process refused: show a plain message (no i18n available yet).
    const p = document.createElement('p');
    p.textContent = `abox: ${e instanceof Error ? e.message : String(e)}`;
    document.getElementById('root')!.append(p);
  }
}

void start();
