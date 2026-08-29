// Assistant markdown (and occasional raw HTML) renders real <a href> tags.
// In a Tauri webview, following those links navigates the app document itself
// and leaves the transparent window empty. Intercept every non-hash href:
// http(s)/mailto/tel open in the system handler; local files open with the
// default app (Finder / Preview / Safari) via openPath.

export type ExternalLinkAction =
  | { type: 'in-app' }
  | { type: 'open-url'; href: string }
  | { type: 'open-path'; path: string }
  | { type: 'ignore' };

export interface ExternalLinkHandlers {
  hasTauri: boolean;
  cwd?: string | null;
  openUrl: (href: string) => Promise<unknown>;
  openPath: (path: string) => Promise<unknown>;
}

export function classifyAnchorHref(href: string, cwd?: string | null): ExternalLinkAction {
  const raw = decodeHref(href.trim());
  if (!raw || raw.startsWith('#')) return { type: 'in-app' };
  if (/^(javascript|data|vbscript):/i.test(raw)) return { type: 'ignore' };
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return { type: 'open-url', href: raw };
  if (raw.startsWith('//')) return { type: 'open-url', href: `https:${raw}` };
  if (/^file:/i.test(raw)) return { type: 'open-path', path: fileUrlToPath(raw) };
  if (isWindowsPath(raw) || isUnixAbsolutePath(raw)) return { type: 'open-path', path: raw };
  if (isRelativeFileHref(raw)) {
    const base = cwd?.trim();
    return { type: 'open-path', path: base ? joinPath(base, raw) : raw };
  }
  return { type: 'ignore' };
}

export function onDocumentLinkClick(event: MouseEvent, handlers: ExternalLinkHandlers): void {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest('a[href], area[href]');
  if (!anchor) return;
  const action = classifyAnchorHref(anchor.getAttribute('href') ?? '', handlers.cwd);
  if (action.type === 'in-app') return;
  event.preventDefault();
  if (action.type === 'ignore') return;
  const task =
    action.type === 'open-url'
      ? handlers.hasTauri
        ? handlers.openUrl(action.href)
        : Promise.resolve(window.open(action.href, '_blank', 'noopener'))
      : openLocalPath(action.path, handlers);
  void task.catch((error) => {
    console.error('[grok-desktop] failed to open link', action, error);
  });
}

export function fileUrlToPath(fileUrl: string): string {
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== 'file:') return fileUrl;
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    return fileUrl.replace(/^file:\/\//i, '');
  }
}

export function joinPath(cwd: string, relative: string): string {
  const posix = relative.replace(/\\/g, '/');
  const base = cwd.replace(/[\\/]+$/, '');
  const absolute = base.startsWith('/') || isWindowsPath(base);
  const stack = base.split(/[\\/]/).filter((part) => part.length > 0);
  for (const part of posix.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const joined = stack.join('/');
  if (isWindowsPath(base)) return joined;
  return absolute ? `/${joined}` : joined;
}

function openLocalPath(path: string, handlers: ExternalLinkHandlers): Promise<unknown> {
  if (!handlers.hasTauri) return Promise.resolve();
  return Promise.resolve(handlers.openPath(path)).catch(() => handlers.openUrl(pathToFileUrl(path)));
}

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`;
  return `file://${encodeURI(normalized.startsWith('/') ? normalized : `/${normalized}`)}`;
}

function decodeHref(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isUnixAbsolutePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  return value.includes('/', 1) || hasFileExtension(value);
}

function isRelativeFileHref(value: string): boolean {
  if (value.includes('://') || value.startsWith('/')) return false;
  if (value.startsWith('./') || value.startsWith('../')) return true;
  return value.includes('/') || hasFileExtension(value);
}

function hasFileExtension(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0] ?? '';
  return /\.[A-Za-z0-9]{1,8}$/.test(path);
}
