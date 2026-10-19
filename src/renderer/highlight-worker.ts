import { highlightCode } from './syntax';
self.onmessage = (event: MessageEvent<{ id: number; text: string; language: string }>) => {
  self.postMessage({ id: event.data.id, html: highlightCode(event.data.text, event.data.language) });
};
