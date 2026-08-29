import { describe, expect, it, vi } from 'vitest';
import { classifyAnchorHref, fileUrlToPath, onDocumentLinkClick } from '../externalLinks';

describe('classifyAnchorHref', () => {
  it('keeps in-page hashes in the webview', () => {
    expect(classifyAnchorHref('#')).toEqual({ type: 'in-app' });
    expect(classifyAnchorHref('#usage')).toEqual({ type: 'in-app' });
    expect(classifyAnchorHref('')).toEqual({ type: 'in-app' });
  });

  it('opens http(s), mailto, tel, and protocol-relative URLs externally', () => {
    expect(classifyAnchorHref('https://example.com/docs')).toEqual({
      type: 'open-url',
      href: 'https://example.com/docs',
    });
    expect(classifyAnchorHref('http://localhost:3000')).toEqual({
      type: 'open-url',
      href: 'http://localhost:3000',
    });
    expect(classifyAnchorHref('mailto:hi@example.com')).toEqual({
      type: 'open-url',
      href: 'mailto:hi@example.com',
    });
    expect(classifyAnchorHref('//cdn.example.com/x')).toEqual({
      type: 'open-url',
      href: 'https://cdn.example.com/x',
    });
  });

  it('opens file URLs and absolute filesystem paths instead of navigating', () => {
    expect(classifyAnchorHref('file:///Users/noctis/site/index.html')).toEqual({
      type: 'open-path',
      path: '/Users/noctis/site/index.html',
    });
    expect(classifyAnchorHref('/Users/noctis/report.pdf')).toEqual({
      type: 'open-path',
      path: '/Users/noctis/report.pdf',
    });
    expect(classifyAnchorHref('C:\\Users\\noctis\\a.html')).toEqual({
      type: 'open-path',
      path: 'C:\\Users\\noctis\\a.html',
    });
  });

  it('resolves relative files against the project cwd', () => {
    expect(classifyAnchorHref('./index.html', '/Users/noctis/site')).toEqual({
      type: 'open-path',
      path: '/Users/noctis/site/index.html',
    });
    expect(classifyAnchorHref('README.md', '/Users/noctis/site')).toEqual({
      type: 'open-path',
      path: '/Users/noctis/site/README.md',
    });
    expect(classifyAnchorHref('../out/report.pdf', '/Users/noctis/site/src')).toEqual({
      type: 'open-path',
      path: '/Users/noctis/site/out/report.pdf',
    });
  });

  it('swallows javascript/data URLs and hash-less SPA stubs', () => {
    expect(classifyAnchorHref('javascript:alert(1)')).toEqual({ type: 'ignore' });
    expect(classifyAnchorHref('data:text/html,hi')).toEqual({ type: 'ignore' });
    expect(classifyAnchorHref('/settings')).toEqual({ type: 'ignore' });
  });
});

describe('fileUrlToPath', () => {
  it('decodes file URLs on POSIX and Windows', () => {
    expect(fileUrlToPath('file:///Users/noctis/My%20Site/index.html')).toBe(
      '/Users/noctis/My Site/index.html',
    );
    expect(fileUrlToPath('file:///C:/Users/noctis/a.html')).toBe('C:/Users/noctis/a.html');
  });
});

describe('onDocumentLinkClick', () => {
  it('prevents default and opens https links through the opener', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const openPath = vi.fn().mockResolvedValue(undefined);
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/docs';
    anchor.textContent = 'docs';
    document.body.append(anchor);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor });

    onDocumentLinkClick(event, { hasTauri: true, openUrl, openPath });

    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('https://example.com/docs'));
    expect(openPath).not.toHaveBeenCalled();
    anchor.remove();
  });

  it('does not intercept in-page hash links', () => {
    const openUrl = vi.fn();
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#section');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor });

    onDocumentLinkClick(event, {
      hasTauri: true,
      openUrl,
      openPath: vi.fn(),
    });

    expect(event.defaultPrevented).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('opens a local file through openPath', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const openPath = vi.fn().mockResolvedValue(undefined);
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/Users/noctis/site/index.html');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor });

    onDocumentLinkClick(event, { hasTauri: true, openUrl, openPath });

    expect(event.defaultPrevented).toBe(true);
    expect(openPath).toHaveBeenCalledWith('/Users/noctis/site/index.html');
    expect(openUrl).not.toHaveBeenCalled();
  });
});
