import { describe, expect, it } from 'vitest';
import { isUncommittedMarkdown, shouldLiveRenderMarkdown } from '../liveMarkdown';

describe('isUncommittedMarkdown', () => {
  it('renders a closed pair and holds an unclosed one', () => {
    expect(isUncommittedMarkdown('hello **world**')).toBe(false);
    expect(isUncommittedMarkdown('hello **world')).toBe(true);
    expect(isUncommittedMarkdown('hello **world** more')).toBe(false);
    expect(isUncommittedMarkdown('*em*')).toBe(false);
    expect(isUncommittedMarkdown('*em')).toBe(true);
    expect(isUncommittedMarkdown('~~删除线~~')).toBe(false);
    expect(isUncommittedMarkdown('**粗体结束** *斜体结束* `inlinecode` ~~删除线~~')).toBe(false);
  });

  it('holds a lone * or #, but renders a completed heading', () => {
    expect(isUncommittedMarkdown('*')).toBe(true);
    expect(isUncommittedMarkdown('#')).toBe(true);
    expect(isUncommittedMarkdown('##')).toBe(true);
    expect(isUncommittedMarkdown('# Title')).toBe(false);
    expect(isUncommittedMarkdown('# Title\nnext')).toBe(false);
    expect(isUncommittedMarkdown('plain text')).toBe(false);
  });
});

describe('shouldLiveRenderMarkdown', () => {
  it('does not live-render empty or uncommitted drafts', () => {
    expect(shouldLiveRenderMarkdown('')).toBe(false);
    expect(shouldLiveRenderMarkdown('**bold')).toBe(false);
    expect(shouldLiveRenderMarkdown('**bold**')).toBe(true);
    expect(shouldLiveRenderMarkdown('# Title')).toBe(true);
  });
});
