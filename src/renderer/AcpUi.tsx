import type { ReactNode } from 'react';

const shapes = {
  chat: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.6-3.5a7.5 7.5 0 1 1 13.4-4Z M9 10h7 M9 13h4',
  terminal: 'M4 5h16v14H4z M7 9l3 3-3 3 M12 15h4',
  file: 'M7 3h7l4 4v14H7z M14 3v5h4 M10 12h5 M10 16h5',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9h.01',
  send: 'M12 19V5 M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  chevron: 'm7 10 5 5 5-5',
  review: 'M8 7h12 M8 12h12 M8 17h12 M4 7h.01 M4 12h.01 M4 17h.01',
  history: 'M4 11a8 8 0 1 1 2 6 M4 6v5h5 M12 8v5l3 2',
  search: 'M15 15l5 5 M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  more: 'M6 12h.01 M12 12h.01 M18 12h.01',
  close: 'm6 6 12 12 M18 6 6 18',
  folder: 'M3 7V5h6l2 2h10v12H3z',
} as const;

export function AcpIcon({ name }: { name: keyof typeof shapes }) {
  return <svg className="acp-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={shapes[name]} /></svg>;
}

export function AcpEmpty({ icon, children, busy = false }: {icon:keyof typeof shapes;children:ReactNode;busy?:boolean}) {
  return <div className="acp-panel-empty" role="status">{busy?<div className="loader" />:<AcpIcon name={icon} />}<span>{children}</span></div>;
}
