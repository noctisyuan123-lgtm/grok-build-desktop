const MAX_TITLE_LENGTH = 34;

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
  if (/(terminal|终端)/i.test(text)) return `${verb}内置终端`;
  if (/(markdown|\bmd\b)/i.test(text) && /(渲染|render|样式|style)/i.test(text)) {
    return `${verb} Markdown 渲染`;
  }
  if (/(图片|图像|文件|附件|image|file|attachment).*(上传|upload)/i.test(text)) {
    return `${verb === '优化' ? '完善' : verb}附件上传`;
  }
  if (/(sidebar|侧边栏|左侧栏)/i.test(text)) return `${verb}侧边栏`;
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
    .split(/[。！？!?；;\n]/, 1)[0]
    .trim();

  if (!title) title = source;
  if (title.length > MAX_TITLE_LENGTH) title = `${title.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`;
  return title;
}
