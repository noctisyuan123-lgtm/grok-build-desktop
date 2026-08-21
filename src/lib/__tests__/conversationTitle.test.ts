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
    expect(deriveConversationTitle('在桌面写个py文件吧，随便什么都行')).toBe(
      '创建桌面 Python 文件',
    );
    expect(deriveConversationTitle('调用一个只读工具获取当前工作目录，然后简短回复结果')).toBe(
      '读取当前工作目录',
    );
    expect(deriveConversationTitle('只回复 AUTO_POLICY_OK，不要调用工具')).toBe(
      '回复 AUTO_POLICY_OK',
    );
    expect(deriveConversationTitle('把 sidebar 里的滚动条贴到最右边')).toBe('优化侧栏滚动条');
    expect(
      deriveConversationTitle(
        '帮我把显示session usage的按键往下挪挪，再把respond下的复制按钮改成生成完后显示',
      ),
    ).toBe('调整上下文用量与回复操作');
  });

  it('removes greetings, markdown noise, and overly long tails', () => {
    expect(deriveConversationTitle('你好，帮我 fix the flaky login test\nplease')).toBe(
      'fix the flaky login test',
    );
    expect(deriveConversationTitle('')).toBe('New conversation');
    expect(
      deriveConversationTitle(
        '请帮我把这个特别特别特别特别特别特别特别特别特别特别长的任务说明整理一下',
      ),
    ).not.toContain('…');
    expect(
      deriveConversationTitle(
        '请帮我把这个特别特别特别特别特别特别特别特别特别特别长的任务说明整理一下',
      ).length,
    ).toBeLessThanOrEqual(14);
  });
});
