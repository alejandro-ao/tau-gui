import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { StoreProvider } from './state/store.js';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Renderer root element is missing');

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
