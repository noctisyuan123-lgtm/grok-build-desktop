import { renderMarkdown } from './markdown';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface ParseRequest {
  runId: string;
  text: string;
}

interface ParseResponse {
  runId: string;
  html: string;
}

// Workers don't have access to Window globals, but `self` is the worker scope.
// We cast to `any` to avoid pulling the WebWorker lib into the global tsconfig.
const workerSelf = self as unknown as { postMessage: (data: ParseResponse) => void };

self.addEventListener('message', (e: MessageEvent<ParseRequest>) => {
  const { runId, text } = e.data;
  try {
    const html = renderMarkdown(text);
    workerSelf.postMessage({ runId, html });
  } catch {
    const safe = escapeHtml(text);
    workerSelf.postMessage({ runId, html: `<pre>${safe}</pre>` });
  }
});

export {};
