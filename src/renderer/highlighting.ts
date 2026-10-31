import { useEffect, useState } from 'react';
import HighlightWorker from './highlight-worker?worker&inline';

type Job = { id: number; text: string; language: string; done: (html: string | null) => void };
let worker: Worker | null = null, current: Job | null = null, timer: ReturnType<typeof setTimeout> | undefined, nextId = 0, users = 0;
const queue: Job[] = [];
function finish(html: string | null, reset = false) {
  clearTimeout(timer); const job = current; current = null;
  if (reset) { worker?.terminate(); worker = null; }
  job?.done(html); queueMicrotask(pump);
}
function pump() {
  if (current || !queue.length) return;
  current = queue.shift()!;
  try {
    if (!worker) {
      worker = new HighlightWorker();
      worker.onmessage = event => { if (current?.id === event.data.id) finish(String(event.data.html)); };
      worker.onerror = () => finish(null, true);
    }
    timer = setTimeout(() => finish(null, true), 3000);
    worker.postMessage({ id: current.id, text: current.text, language: current.language });
  } catch { finish(null, true); }
}
function request(text: string, language: string, done: Job['done']): () => void {
  users++;
  const job: Job = { id: ++nextId, text, language, done }; queue.push(job); pump();
  return () => {
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
    if (current === job) { job.done = () => {}; finish(null, true); }
    if(--users===0)queueMicrotask(()=>{if(!users){clearTimeout(timer);worker?.terminate();worker=null;}});
  };
}
export function useHighlightedCode(text: string, language: string, enabled = true): string | null {
  const [result, setResult] = useState<{ text: string; language: string; html: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !text || language === 'plaintext') return;
    return request(text, language, html => setResult({ text, language, html }));
  }, [text, language, enabled]);
  return enabled && result?.text === text && result.language === language ? result.html : null;
}
