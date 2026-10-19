import { highlightCode } from './syntax';

self.onmessage = (event: MessageEvent<{ text: string; language: string }>) => {
  self.postMessage(highlightCode(event.data.text, event.data.language));
};
