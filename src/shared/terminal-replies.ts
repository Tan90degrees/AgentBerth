/** Responses to terminal queries, never user keystrokes. Keep TUI negotiation
 * working while a human is watching an Agent-controlled terminal. */
export function isTerminalReply(data: string): boolean {
  return data.length <= 512 && /^(?:\x1b\[(?:[?>]?[\d;]*c|\??\d{1,4};\d{1,4}R|\??\d{1,4}n|\?\d{1,5};\d\$y|[\d;]+t)|\x1bP[01]\$r[\d;: ?"a-zA-Z]*\x1b\\|\x1b\](?:4;\d{1,3}|10|11|12);rgb:[a-fA-F\d/]+(?:\x07|\x1b\\))$/.test(data);
}
