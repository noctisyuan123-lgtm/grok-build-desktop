// Sidebar titles are a navigation list, not a replay of the opening prompt.
// Industry pattern (Cursor / Claude Code / Copilot / ChatGPT): 3–6 words,
// verb + object, keep files/errors, drop filler. CSS ellipsis means the
// generator failed, so we fit by display width and never emit "…".

const MAX_TITLE_UNITS = 26;

const FILE_RE =
  /\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|md|css|scss|json|toml|lock|vue|svelte)\b/gi;
const ERROR_RE = /\b(?:E[A-Z]{2,}\d*|[A-Z]{3,}_[A-Z0-9_]{2,}|[A-Z]{2,}-\d{2,})\b/g;

const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff]/;

type Kind = 'fix' | 'add' | 'create' | 'adjust' | 'read' | 'remove';

function isCjk(char: string): boolean {
  return CJK_RE.test(char);
}

function displayUnits(text: string): number {
  let units = 0;
  for (const char of text) units += isCjk(char) ? 2 : 1;
  return units;
}

function fitSidebar(text: string): string {
  let units = 0;
  let fitted = '';
  for (const char of text) {
    const next = isCjk(char) ? 2 : 1;
    if (units + next > MAX_TITLE_UNITS) break;
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
    cutMidWord && lastSpace >= Math.floor(trimmed.length * 0.55)
      ? trimmed.slice(0, lastSpace)
      : trimmed;
  return readable;
}

function compact(text: string): string {
  return text
    .replace(/```[\w-]*\r?\n[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+\]\((?:file:|https?:)[^)]*\)/g, ' ')
    .replace(/(?:file:\/\/|https?:\/\/)\S+/g, ' ')
    .replace(/(?:\/[\w.@+~-]+){2,}/g, ' ')
    .replace(/^[#>*\-\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFiller(text: string): string {
  return text
    .replace(/^(?:你好|嗨|哈喽|hello|hi|hey)[呀啊，,!\s]*/i, '')
    .replace(/^(?:嗯|哦|诶|那个|这个|对了|还有个事)[呀啊，,。.!\s]*/i, '')
    .replace(/^(?:我想|我希望|我需要|请|麻烦|能不能|能否|可以不可以)\s*(?:你)?\s*(?:帮我)?\s*/i, '')
    .replace(/^帮我\s*/i, '')
    .replace(/^(?:please|can you|could you|would you)\s+/i, '')
    .replace(/^(?:i (?:want|need) to|i'?d like to|help me(?: to)?)\s+/i, '')
    .replace(/\b(?:please|help me(?: to)?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstClause(text: string): string {
  return text
    .split(/[，,。！？!?；;\n]|(?:然后|顺便|另外|还有|and then)/, 1)[0]
    .replace(/(?:一下|一些|一点|就行|吧|吗|呢|呀|啊|呗)+$/g, '')
    .trim();
}

function looksChinese(text: string): boolean {
  let cjk = 0;
  let latin = 0;
  for (const char of text) {
    if (isCjk(char)) cjk += 1;
    else if (/[A-Za-z]/.test(char)) latin += 1;
  }
  return cjk >= 2 && cjk * 2 >= latin;
}

function kindOf(text: string): Kind | null {
  if (
    /(问题|不对|异常|失败|不能|没法|不会|无效|bug|broken|fail|doesn.?t|can.?t|error|crash)/i.test(
      text,
    )
  ) {
    return 'fix';
  }
  if (/(删除|移除|去掉|remove|delete|drop)\b/i.test(text)) return 'remove';
  if (/(新增|添加|加个|加入|支持|实现|\badd\b|\bimplement\b|\bsupport\b)/i.test(text)) {
    return 'add';
  }
  if (/(创建|写个|写一?个|新建|\bcreate\b|\bwrite\b)/i.test(text)) return 'create';
  if (/(获取|读取|查看|看看|看一下|\bread\b|\bget\b|\bshow\b)/i.test(text)) return 'read';
  if (
    /(好像不是|不太好|冗长|省略|改成|换成|调整|挪|贴到|优化|update|change|move|rename|改|换)/i.test(
      text,
    )
  ) {
    return 'adjust';
  }
  return null;
}

const VERB_ZH: Record<Kind, string> = {
  fix: '修复',
  add: '添加',
  create: '创建',
  adjust: '优化',
  read: '读取',
  remove: '删除',
};

function glueZh(verb: string, object: string): string {
  if (!verb) return object;
  if (object.startsWith(verb)) return object;
  const space = /[A-Za-z0-9]/.test(object[0] ?? '') ? ' ' : '';
  return `${verb}${space}${object}`;
}

function squeezeCjkSpaces(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTopic(text: string, chinese: boolean): string {
  let s = text;
  if (chinese) {
    s = s
      .replace(/session history/gi, '会话')
      .replace(/\bsessions?\b(?!\s*usage)/gi, '会话')
      .replace(/侧边栏|左侧栏/g, '侧栏')
      .replace(/\bsidebar\b/gi, '侧栏')
      .replace(/\bmarkdown\b|\bmd\b/gi, 'Markdown')
      .replace(/\bterminal\b/gi, '终端')
      .replace(/\bpython\b/gi, 'Python')
      .replace(/\bpy\b/gi, 'Python')
      .replace(/\bscrollbar\b/gi, '滚动条')
      .replace(/(?:当前)?工作目录|working directory|\bcwd\b/gi, '工作目录');
  }
  return squeezeCjkSpaces(s);
}

function cleanZhObject(raw: string): string {
  let s = normalizeTopic(
    raw
      .replace(/^(?:现在|这里|这个|左侧|右边|里面|当前)+/, '')
      .replace(/(?:栏里|里面|当中)/g, '')
      .replace(/按回车|按下?enter/gi, '')
      .replace(/里的|中的|上的/g, '的')
      .replace(/^(?:显示|把|将|给|调用一个|只读工具)/, '')
      .replace(/(?:一下|一些|一点)$/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    true,
  ).replace(/(会话)\s*\1/g, '$1');

  const parts = s
    .split('的')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1] ?? '';
    const prev = parts[parts.length - 2] ?? '';
    const lastCjk = [...last].filter(isCjk).length;
    if (lastCjk > 0 && lastCjk <= 4) {
      const prevIsFiller = /^(?:特别|很|非常|超|这个|那个)+/.test(prev);
      if (prevIsFiller) {
        s = last;
      } else if (/[A-Za-z]/.test(prev) && !CJK_RE.test(prev)) {
        const prevTail = prev.split(/\s+/).filter(Boolean).slice(-2).join(' ');
        s = `${prevTail} ${last}`.trim();
      } else {
        const prevTail = prev.split(/\s+/).pop() ?? prev;
        s = /[A-Za-z]/.test(last) ? `${prevTail} ${last}` : prevTail + last;
      }
    }
  }

  return normalizeTopic(s, true);
}

function zhVerb(kind: Kind | null, source: string): string {
  if (/整理/.test(source)) return '整理';
  if (
    kind === 'adjust' &&
    /(改成|换成|挪|贴到|移到|改|换)/.test(source) &&
    !/(优化|好像不是|不太好|冗长)/.test(source)
  ) {
    return '调整';
  }
  return kind ? VERB_ZH[kind] : '';
}

function summarizeZh(source: string, clause: string): string | null {
  const kind = kindOf(source);
  const verb = zhVerb(kind, source);

  const reply = source.match(/只回复\s*([A-Za-z][\w-]{2,})/);
  if (reply?.[1]) return `回复 ${reply[1]}`;

  const createFile = source.match(/(?:写|创建|新建).{0,10}?(py|python|js|ts|tsx)文件/i);
  if (createFile) {
    const lang = /py/i.test(createFile[1] ?? '') ? 'Python' : (createFile[1] ?? '文件');
    const where = source.includes('桌面') ? '桌面' : '';
    return squeezeCjkSpaces(['创建', where, lang, '文件'].filter(Boolean).join(' '));
  }

  const ba = clause.match(
    /把(?:这里的|这个|左侧的|里面的)?(.+?)(?:整理|改成|换成|贴到|移到|变成|做成|写成|往[下上左右]挪|挪|改|换)/,
  );
  if (ba?.[1]) {
    const object = cleanZhObject(ba[1]);
    if (object) return glueZh(verb || VERB_ZH.adjust, object);
  }

  const complaint = clause.match(/(.+?)(?:好像不是|不太好|不对|有问题|不行|失败|不会|不能|没法)/);
  if (complaint?.[1]) {
    const object = cleanZhObject(complaint[1]);
    if (object) return glueZh(verb || VERB_ZH.fix, object);
  }

  const read = clause.match(/(?:获取|读取|查看|看看|看一下)(.{1,16}?)(?:$|，|。)/);
  if (read?.[1]) {
    const object = cleanZhObject(read[1]);
    if (object) return glueZh(VERB_ZH.read, object);
  }

  const object = cleanZhObject(clause);
  if (!object) return null;
  return verb ? glueZh(verb, object) : object;
}

const EN_STOP = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'my',
  'your',
  'me',
  'please',
  'just',
  'really',
  'in',
  'on',
  'of',
  'for',
  'to',
  'with',
  'from',
  'into',
]);

function summarizeEn(clause: string): string {
  let s = clause
    .replace(/^(?:please|hey|hi|hello)\s+/i, '')
    .replace(/\b(?:please|thanks)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const support = s.match(/^(?:implement|add|create)\s+support\s+for\s+(.+)/i);
  if (support?.[1]) s = `Add ${support[1]}`;

  s = s.split(/\b(?:so that|because|which |and then)\b/i)[0]?.trim() ?? s;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= 6 && displayUnits(s) <= MAX_TITLE_UNITS) return words.join(' ');

  const content = words.filter((word) => !EN_STOP.has(word.toLowerCase()));
  return content.slice(0, 5).join(' ');
}

function firstAnchor(text: string, pattern: RegExp): string | null {
  pattern.lastIndex = 0;
  return text.match(pattern)?.[0] ?? null;
}

function attachAnchors(title: string, source: string): string {
  const file = firstAnchor(source, FILE_RE);
  const error = firstAnchor(source, ERROR_RE);
  const extra =
    error && !title.toLowerCase().includes(error.toLowerCase())
      ? error
      : file && !title.toLowerCase().includes(file.toLowerCase())
        ? file
        : null;
  if (!extra) return title;
  const words = title.split(/\s+/).filter(Boolean);
  while (words.length > 0) {
    const candidate = `${words.join(' ')} ${extra}`;
    if (displayUnits(candidate) <= MAX_TITLE_UNITS) return candidate;
    words.pop();
  }
  return displayUnits(extra) <= MAX_TITLE_UNITS ? extra : title;
}

/** Produce a stable, quota-free task title from the first user prompt. */
export function deriveConversationTitle(prompt: string): string {
  const source = compact(prompt);
  if (!source) return 'New conversation';

  const cleaned = stripFiller(source);
  if (!cleaned) return 'New conversation';

  const clause = firstClause(cleaned) || cleaned;
  const chinese = looksChinese(cleaned);
  let title = chinese ? summarizeZh(cleaned, clause) : summarizeEn(clause);
  if (!title) title = clause;
  title = attachAnchors(title, source);
  title = title.replace(/[。！？!?.,;:]+$/g, '').trim();
  if (!title) title = source;
  return fitSidebar(title);
}
