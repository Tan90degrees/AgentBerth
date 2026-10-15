import React from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAppearance } from './appearance';
import { App } from './App';
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import './appearance.css';

initializeAppearance();

createRoot(document.getElementById('root')!).render(<App />);
