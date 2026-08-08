import { describe, expect, it } from 'vitest';
import { deriveConversationTitle } from '../conversationTitle';

describe('deriveConversationTitle', () => {
  it('summarizes common product intents instead of copying the opening sentence', () => {
    expect(
      deriveConversationTitle('现在左侧 session history 栏里 session 的命名好像不是概括式的'),
    ).toBe('优化会话标题生成');
    expect(deriveConversationTitle('终端按回车不会 run，而且默认路径不对')).toBe('修复内置终端');
    expect(deriveConversationTitle('我想把这里的 md 渲染换成 VSCode 同款')).toBe(
      '优化 Markdown 渲染',
    );
  });

  it('removes greetings, markdown noise, and overly long tails', () => {
    expect(deriveConversationTitle('你好，帮我 fix the flaky login test\nplease')).toBe(
      'fix the flaky login test please',
    );
    expect(deriveConversationTitle('')).toBe('New conversation');
    expect(
      deriveConversationTitle(
        '请帮我把这个特别特别特别特别特别特别特别特别特别特别长的任务说明整理一下',
      ).length,
    ).toBeLessThanOrEqual(35);
  });
});
