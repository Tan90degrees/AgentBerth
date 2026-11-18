import React from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAppearance } from './appearance';
import { App } from './App';
import { DesktopPet } from './DesktopPet';
import './tokens.css';
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import './appearance.css';
import './files.css';
import './conversation.css';
import './settings.css';

initializeAppearance();

const query = new URLSearchParams(window.location.search);
const view = query.get('view');
const titleBar = view !== 'pet' && query.get('titleBar') === '32';
const root = document.getElementById('root')!;
if (titleBar) root.classList.add('has-window-titlebar');
createRoot(root).render(view === 'pet' ? <DesktopPet /> : <>
  {titleBar && <div className="window-titlebar">{view === 'ssh' ? 'AgentBerth · SSH' : 'AgentBerth · 泊栈'}</div>}
  <App sshWindow={view === 'ssh'} />
</>);
