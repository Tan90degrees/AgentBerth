import type { Terminal } from '@xterm/headless';

// SerializeAddon restores mouse tracking, but omits its wire encoding. A TUI
// expecting SGR cannot consume the legacy reports emitted after reconnecting.
// Observe parsed sequences so split writes, OSC payloads and resets are handled
// by xterm itself; returning false leaves its built-in handlers in control.
export function trackMouseEncoding(terminal: Terminal): () => string {
  let encoding = 0;
  for (const final of ['h', 'l']) terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
    for (const mode of params) if (mode === 1006 || mode === 1016) encoding = final === 'h' ? mode : 0;
    return false;
  });
  terminal.parser.registerEscHandler({ final: 'c' }, () => { encoding = 0; return false; });
  return () => encoding ? `\x1b[?${encoding}h` : '';
}
