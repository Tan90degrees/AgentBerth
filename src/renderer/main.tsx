import React from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAppearance } from './appearance';
import { App } from './App';
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import './appearance.css';
import './files.css';
import './settings.css';

initializeAppearance();

createRoot(document.getElementById('root')!).render(<App sshWindow={new URLSearchParams(window.location.search).get('view')==='ssh'} />);
