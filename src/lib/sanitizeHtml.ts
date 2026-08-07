// Central sanitizer for HTML that reaches `dangerouslySetInnerHTML`.
//
// The markdown worker parses assistant text with `markdown-it`, which does NOT
// sanitize its output — raw HTML embedded in a model/tool response (or in a
// restored legacy message) passes straight through. Strip anything executable
// (script tags, inline event handlers, javascript: URLs) before it touches
// the DOM. DOMPurify's defaults handle all of that while preserving normal
// markdown output: headings, links, tables, and highlight.js code markup.
import DOMPurify from 'dompurify';

export function sanitizeHtml(html: string): string {
  // KaTeX's MathML output wraps the visual tree in <semantics> and stores the
  // original TeX in a non-rendered <annotation>. DOMPurify supports MathML but
  // omits these two semantic tags by default; allowing them prevents the TeX
  // annotation text from being flattened into (and displayed by) <math>.
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['encoding'],
  });
}
