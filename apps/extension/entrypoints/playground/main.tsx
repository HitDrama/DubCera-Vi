import React from 'react';
import { createRoot } from 'react-dom/client';
import { SandboxPlayer } from './SandboxPlayer';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SandboxPlayer />
  </React.StrictMode>,
);
