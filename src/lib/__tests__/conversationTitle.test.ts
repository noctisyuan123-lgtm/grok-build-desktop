import { describe, expect, it } from 'vitest';
import { deriveConversationTitle } from '../conversationTitle';

describe('deriveConversationTitle', () => {
  it('names the task instead of replaying the opening sentence', () => {
    expect(
      deriveConversationTitle('现在左侧 session history 栏里 session 的命名好像不是概括式的'),
    ).toBe('优化会话命名');
    expect(deriveConversationTitle('终端按回车不会 run，而且默认路径不对')).toBe('修复终端');
    expect(deriveConversationTitle('我想把这里的 md 渲染换成 VSCode 同款')).toBe(
      '调整 Markdown 渲染',
    );
    expect(deriveConversationTitle('在桌面写个py文件吧，随便什么都行')).toBe(
      '创建桌面 Python 文件',
    );
    expect(deriveConversationTitle('调用一个只读工具获取当前工作目录，然后简短回复结果')).toBe(
      '读取工作目录',
    );
    expect(deriveConversationTitle('只回复 AUTO_POLICY_OK，不要调用工具')).toBe(
      '回复 AUTO_POLICY_OK',
    );
    expect(deriveConversationTitle('把 sidebar 里的滚动条贴到最右边')).toBe('调整侧栏滚动条');
    expect(
      deriveConversationTitle(
        '帮我把显示session usage的按键往下挪挪，再把respond下的复制按钮改成生成完后显示',
      ),
    ).toBe('调整 session usage 按键');
  });

  it('keeps short English prompts and strips greetings / filler', () => {
    expect(deriveConversationTitle('你好，帮我 fix the flaky login test\nplease')).toBe(
      'fix the flaky login test',
    );
    expect(deriveConversationTitle('fix the login flake')).toBe('fix the login flake');
    expect(deriveConversationTitle('write release notes')).toBe('write release notes');
    expect(deriveConversationTitle('')).toBe('New conversation');
  });

  it('fits the sidebar and keeps files / errors instead of code dumps', () => {
    const long = deriveConversationTitle(
      '请帮我把这个特别特别特别特别特别特别特别特别特别特别长的任务说明整理一下',
    );
    expect(long).toBe('整理任务说明');
    expect(long).not.toContain('…');
    expect([...long].length).toBeLessThanOrEqual(12);

    expect(
      deriveConversationTitle(
        'Hey can you please help me debug the race condition in the WebSocket reconnect logic in reconnect.ts? It throws ECONNRESET after 30s idle.',
      ),
    ).toBe('debug race ECONNRESET');

    expect(
      deriveConversationTitle(
        'Please implement support for renaming conversations from the sidebar context menu and persist the custom label',
      ),
    ).toBe('Add renaming conversations');
  });
});
