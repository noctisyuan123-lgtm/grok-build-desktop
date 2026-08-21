// Keep auto-titles short enough to scan in the sidebar. The sidebar itself
// is a navigation list, so a clipped short topic is preferable to replaying
// the user's whole opening sentence with a visible ellipsis.
const MAX_TITLE_UNITS = 28;

function fitSidebar(text: string): string {
  let units = 0;
  let fitted = '';
  for (const char of text) {
    // CJK glyphs are roughly twice as wide as Latin text in the sidebar.
    const next = /[\u3000-\u9fff\uf900-\ufaff]/.test(char) ? 2 : 1;
    if (units + next > MAX_TITLE_UNITS - 1) {
      break;
    }
    fitted += char;
    units += next;
  }
  const trimmed = fitted.trimEnd();
  const lastSpace = trimmed.lastIndexOf(' ');
  const cutMidWord =
    fitted.length < text.length &&
    !/\s/.test(text[fitted.length] ?? '') &&
    !/\s/.test(fitted.at(-1) ?? '');
  const readable =
    cutMidWord && lastSpace >= Math.floor(trimmed.length * 0.6)
      ? trimmed.slice(0, lastSpace)
      : trimmed;
  return readable;
}

function compact(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+\]\((?:file:|https?:)[^)]*\)/g, ' ')
    .replace(/(?:file:\/\/|https?:\/\/)\S+/g, ' ')
    .replace(/(?:\/[\w.@+~-]+){2,}/g, ' ')
    .replace(/^[#>*\-\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function intentTitle(text: string): string | null {
  const broken = /(问题|不对|异常|失败|不能|没法|不会|无效|bug|broken|fail|doesn.?t|can.?t)/i.test(
    text,
  );
  const adding = /(新增|添加|加个|加入|支持|实现|add|implement|support)/i.test(text);
  const verb = broken ? '修复' : adding ? '添加' : '优化';

  if (/(session|会话).*(命名|标题|name|title)|(?:命名|标题).*(session|会话)/i.test(text)) {
    return '优化会话标题生成';
  }
  if (
    /(usage|context|用量|占用|上下文)/i.test(text) &&
    /(copy|复制|respond|response|回复)/i.test(text)
  ) {
    return '调整上下文用量与回复操作';
  }
  if (/(usage|context|用量|占用|上下文)/i.test(text)) return '调整上下文用量显示';
  if (/(copy|复制).*(respond|response|回复)|(?:respond|response|回复).*复制/i.test(text)) {
    return '调整回复复制操作';
  }
  if (/(滚轮|滚动条|scrollbar)/i.test(text)) return '优化侧栏滚动条';
  if (/(terminal|终端)/i.test(text)) return `${verb}内置终端`;
  if (/(markdown|\bmd\b)/i.test(text) && /(渲染|render|样式|style)/i.test(text)) {
    return `${verb} Markdown 渲染`;
  }
  if (/(图片|图像|文件|附件|image|file|attachment).*(上传|upload)/i.test(text)) {
    return `${verb === '优化' ? '完善' : verb}附件上传`;
  }
  if (/(sidebar|侧边栏|左侧栏)/i.test(text)) return `${verb}侧边栏`;
  if (/(桌面).*(?:py|python).*(?:文件)|(?:py|python).*(?:文件).*(?:桌面)/i.test(text)) {
    return '创建桌面 Python 文件';
  }
  if (/(当前工作目录|working directory|\bcwd\b)/i.test(text)) return '读取当前工作目录';
  const replyToken = text.match(/只回复\s*([A-Z][A-Z0-9_-]{2,})/i)?.[1];
  if (replyToken) return `回复 ${replyToken}`;
  if (/(github).*(?:推|push|上传)|(?:推|push|上传).*github/i.test(text)) return '推送到 GitHub';
  if (/(窗口).*(?:大小|尺寸|长宽|宽度|高度)|(?:大小|尺寸|长宽).*(?:窗口)/i.test(text)) {
    return '调整窗口尺寸';
  }
  if (/(图标|icon)/i.test(text)) return `${broken ? '修复' : '设计'}应用图标`;
  if (/(ui|界面).*(布局|排版)|(?:布局|排版).*(ui|界面)/i.test(text)) return '优化界面布局';
  if (/(表格|table)/i.test(text)) return `${verb}表格样式`;
  if (/(背景|主题|theme|background)/i.test(text)) return `${verb}界面主题`;
  return null;
}

/** Produce a stable, quota-free task title from the first user prompt. */
export function deriveConversationTitle(prompt: string): string {
  const source = compact(prompt);
  if (!source) return 'New conversation';

  const intent = intentTitle(source);
  if (intent) return intent;

  let title = source
    .replace(/^(?:你好|嗨|哈喽|hello|hi)[呀啊，,!\s]*/i, '')
    .replace(/^(?:嗯|哦|诶|那个|这个|对了|还有个事)[呀啊，,。.!\s]*/i, '')
    .replace(
      /^(?:我想|我希望|我需要|请|麻烦|能不能|能否|可以不可以)\s*(?:你)?\s*(?:帮我)?\s*(?:把)?\s*/i,
      '',
    )
    .replace(/^帮我\s*(?:把)?\s*/i, '')
    .split(/[，,。！？!?；;\n]|(?:然后|顺便|另外|还有)/, 1)[0]
    .replace(/(?:一下|一些|一点|就行|吧|吗|呢|呀|啊|呗|please)+$/i, '')
    .trim();

  if (!title) title = source;
  return fitSidebar(title);
}
