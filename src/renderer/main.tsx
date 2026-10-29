import React from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAppearance } from './appearance';
import { App } from './App';
import { DesktopPet } from './DesktopPet';
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import './appearance.css';
import './files.css';
import './settings.css';

initializeAppearance();

const view = new URLSearchParams(window.location.search).get('view');
createRoot(document.getElementById('root')!).render(view === 'pet' ? <DesktopPet /> : <App sshWindow={view === 'ssh'} />);
