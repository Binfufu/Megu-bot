/**
 * 「搜本/找本 <关键词>」「下本 <编号/序号>」的**纯解析器**（2026-11-12）。
 *
 * 做的是与 `src\meitu-command.js` 同构的一件事：把群消息里的一条**确定性指令**认出来，
 * 正常命中不经过模型；网络/落盘/发送全在别处（`scripts\jm-fetch-one.mjs` 与
 * `src\jm-service.js`）。所以本文件**不联网、不读文件、不碰子进程**，输入输出都是普通对象。
 *
 * 认的写法（群里 @ 之后的正文；⚠️ 有的客户端会把 `@名字` 当成**纯文本**留在正文里，
 * 网关只剥段落 @，所以开头/末尾残留的 `@xxx` 要先剥掉）：
 *
 *     搜本 全彩                 ← 关键词搜索，数量用默认上限（`QQBOT_JM_MAX`，默认 5）
 *     找本 全彩                 ← 「找本」与「搜本」同义
 *     搜本 全彩 3               ← 末尾单独一个数量词（1..5，超出夹到上限）
 *     搜本 全彩 三               ← 中文数量也认
 *     搜本 作者:甲                ← 结构化检索：作者（上游 author 模式）
 *     搜本 原作:乙 / 搜本 IP:乙    ← 结构化检索：原作/IP（上游 work 模式）
 *     搜本 角色:丙                ← 结构化检索：角色（上游 actor 模式）
 *     搜本 标签:丁                ← 结构化检索：站点标签（上游 tag 模式）
 *     搜本 标题:戊                ← 标题文字检索（站点候选后按标题复核）
 *     搜本 作者:甲 标签:丁 2       ← 多条件 AND + 页码；只回本次检查范围内的清单
 *     搜原神的本子               ← 模糊搜本：请求动词 + 句尾“本子/本”，关键词=原神
 *     来个莉音的本               ← 同上；只给清单，不自动下载
 *     （结构化/模糊检索永远只给清单；普通「搜本 关键词」旧行为不变）
 *     下本 1490076              ← 直接给作品编号（至少两位数字；边车按 id 下载）
 *     下本 3                    ← 给**序号**：取本群最近一次搜索结果里的第 3 本
 *     下载本子 1490076          ← 「下载本子」是「下本」的别名
 *     整本打包                 ← 显式选择最近本群单元清单全部
 *     打包1 3 5 7              ← 只选择这些单元序号（可超过 9，按清单顺序合并）
 *
 * 解析顺序（每一步只做一件小事，selftest 按表钉着）：
 *   ⓪ 归一化：trim → 去前导标点/空白 → 去句末标点 → 剥前导 `@残留` → 剥末尾 `@残留`；
 *   ① 搜索指令：`^(搜本|找本|搜索本子|找本子)\s*(.*)$` —— 剩余段非空、长度 1..60 字；
 *      剩余段**末尾以空白分隔**的数量词（阿拉伯或中文 1..5）当数量，其余全是关键词。
 *      ⚠️ 数量必须与关键词之间有空白：「搜本 全彩3」里的 `3` 算关键词（宁窄勿宽，
 *      关键词里出现数字很常见，不能瞎猜）；
 *   ② 下载指令：`^(下本|下载本子|下载本)\s*(.*)$` —— 去掉 `#`/`第`/尾部「号」之后：
 *      · **一位数字 1..9** = 序号（对应最近一次搜索/单元清单的 rank，由服务层换算成 id）；
 *      · **两位及以上数字** = 作品/单元编号，原样交给边车按编号精确解析；
 *      · 其它 = 格式错误（回一句格式提示，别当闲聊丢掉）。
 *
 * 失败分支都带 `reason`：
 *   · `format` = 不是这条指令的形状（空关键词、下本没给东西、编号形状不对…）；
 *   · `count`  = 确实在写搜索指令，但数量写坏了（0 / 超过 60 位以外的怪数字）。
 *
 * 为什么数量上限**夹到**配置上限而不是报错：与搬图同口径（写多了夹到上限是既有行为，
 * 让用户少写一次；写 0 才明确拒绝）。
 */

/** 数量上限的兜底值（与配置 `QQBOT_JM_MAX` 的默认值同一口径，服务层会传真实配置）。 */
export const DEFAULT_JM_MAX = 5;

/** 边车 `/search` 契约 v1：`q` 长度 1..60 字符（按码点算，中文一个字算一个）。 */
export const MAX_JM_KEYWORD_CHARS = 60;

/** 搜索动词与下载动词。⚠️ 同义写法只在这里加一处，`looksLikeJmAttempt` 自动跟上。 */
const SEARCH_VERBS = '搜本|找本|搜索本子|找本子';
const DOWNLOAD_VERBS = '下本|下载本子|下载本';

/** 中文数量 → 数值（只收 1..5 与常见写法；「十几」之类落不到数字 = 当关键词）。 */
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };

/** 结构化检索的条件键；只收明确写出来的键，未知键回 unsupported。 */
const STRUCTURED_FIELDS = new Map([
  ['作者', 'creator'],
  ['原作', 'original'],
  ['IP', 'original'],
  ['ip', 'original'],
  ['角色', 'character'],
  ['标签', 'tag'],
  ['标题', 'title'],
]);

/** 结构化检索的值/页码上限；页码与列表页码同一口径。 */
const MAX_STRUCTURED_VALUE_CHARS = 60;
const MAX_STRUCTURED_PAGE = 9999;

/** 把 `键:值` 拆开（全角/半角冒号都认）；没有冒号返回 null。 */
function splitKeyValue(token) {
  const match = /^([^:：]+)[:：](.*)$/u.exec(String(token ?? ''));
  if (!match) return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

/**
 * 解析结构化搜索的条件段：`作者/原作/IP/角色/标签/标题` + 页码。
 *
 * 返回 null = 没有条件键，交回原有的普通关键词搜索（保住 `搜本 全彩 3` 的旧语义）。
 * 只要写了条件键，就进入**只清单、不自动下载**的结构化路径。
 */
function parseStructuredSearchRest(body) {
  const tokens = String(body ?? '').trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  const conditions = {};
  const free = [];
  const numericPages = [];
  let page = 1;
  let pageGiven = false;
  let hasCondition = false;

  const setPage = (raw) => {
    if (pageGiven) return false;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STRUCTURED_PAGE) return false;
    page = value;
    pageGiven = true;
    return true;
  };

  for (const token of tokens) {
    const pair = splitKeyValue(token);
    if (pair) {
      if (pair.key === '页码' || pair.key === '页') {
        if (!/^\d+$/u.test(pair.value) || !setPage(pair.value)) return { ok: false, reason: 'page' };
        continue;
      }
      const field = STRUCTURED_FIELDS.get(pair.key);
      if (!field) return { ok: false, reason: 'unsupported', field: pair.key };
      const value = pair.value.normalize('NFKC').trim();
      if (!value || Array.from(value).length > MAX_STRUCTURED_VALUE_CHARS) {
        return { ok: false, reason: 'format', field: pair.key };
      }
      const list = conditions[field] ?? [];
      if (list.length >= 5) return { ok: false, reason: 'format', field: pair.key };
      list.push(value);
      conditions[field] = list;
      hasCondition = true;
      continue;
    }

    if (/^\d+$/u.test(token)) {
      numericPages.push(token);
      continue;
    }
    if (/^第\d+页$/u.test(token)) {
      if (!setPage(token.replace(/\D+/gu, ''))) return { ok: false, reason: 'page' };
      continue;
    }
    free.push(token);
  }

  if (!hasCondition) {
    // 没有条件键：交回普通关键词路径；页码词/数字由原解析器处理（或当关键词）。
    return null;
  }

  if (numericPages.length > 0) {
    if (numericPages.length > 1 || pageGiven) return { ok: false, reason: 'page' };
    if (!setPage(numericPages[0])) return { ok: false, reason: 'page' };
  }

  if (free.length > 0) {
    const text = free.join(' ').trim();
    if (!text || Array.from(text).length > MAX_STRUCTURED_VALUE_CHARS) return { ok: false, reason: 'format' };
    conditions.title = [...(conditions.title ?? []), text];
  }

  if ((conditions.original?.length ?? 0) > 0 && (conditions.character?.length ?? 0) > 0) {
    // 当前边车详情只给作者/标签，不能同时用两种上游模式再复核；明确拒绝，不静默丢一个。
    return { ok: false, reason: 'unsupported', field: '原作+角色' };
  }
  if ((conditions.original?.length ?? 0) > 1 || (conditions.character?.length ?? 0) > 1) {
    // 原作/角色只能作为一个主要条件信任上游；多值无法逐条复核，拒绝而不是静默只查第一个。
    return { ok: false, reason: 'unsupported', field: '原作/角色多值' };
  }

  return {
    ok: true,
    action: 'search',
    mode: 'structured',
    conditions,
    page,
    keyword: null,
    countGiven: false,
  };
}

/**
 * **模糊搜本**（2026-11-17，对标搬图的噪点/复合词护栏）：
 * 只认“明确请求 + 句尾 本子/本”的形状，不认句中随便出现的“本”字。
 *
 * 认的写法：
 *     搜原神的本子
 *     来个莉音的本
 *     来点原神的本子
 *     我想看原神的本子
 *     有没有原神的本子
 *     搜原神本
 *
 * 不认（防闲聊误命中）：
 *     这个本子不错          ← 没有请求动词
 *     我本来想找…           ← “本来”的“本”不是书
 *     来个日本              ← 日本/成本/基本… 是复合词，不是“日本的书”
 *     老板本来…             ← 同上
 *
 * 与搬图同一思路：动词/前缀是白名单，不是自由扫描；句尾书标记 + 关键词非空
 * 才形成命令。纯代码即可，不调模型。
 */
const FUZZY_PREFIXES = [
  '麻烦你', '麻烦', '请问', '请', '帮我', '给我', '我想', '想', '能不能', '可以', '能',
  '再', '就', '嗯', '那', '你', '我',
].sort((a, b) => b.length - a.length);

const FUZZY_CUES = [
  '有没有', '推荐', '来个', '来点', '来几', '看看', '找找', '搜搜', '搜索',
  '搜', '找', '来', '看', '求', '发', '整', '搬', '搞', '要', '有无',
].sort((a, b) => b.length - a.length);

/** 引词后的可选量词/衬词；用一次性匹配，避免嵌套量词回溯。 */
const FUZZY_FILLER_RE = /^(?:[一两几]?个|[一两几]本|点|些|下|一下|看看|看下|这个|那个|这部|那部|一些|一点|几个)?/u;

/** 句尾裸“本”的常见复合词：这些不是“某本书”，出现就放弃模糊命中。 */
const FUZZY_BEN_COMPOUNDS = new Set([
  '日本', '本人', '本来', '本事', '基本', '成本', '版本', '脚本', '资本', '文本',
  '课本', '账本', '样本', '副本', '译本', '抄本', '刻本', '善本', '绘本', '蓝本',
  '范本', '原本', '根本', '忘本', '固本', '治本', '校本', '底本', '母本', '教本',
  '读本', '选本', '节本', '足本', '全本', '单本', '开本', '印本', '孤本', '珍本',
  '秘本', '戏本', '话本', '唱本', '剧本', '笔记本', '笔记本子', '画本', '画本子',
]);

/** 模糊关键词不能是这些空词；否则回“本子”本身不构成检索目标。 */
const FUZZY_STOP_WORDS = new Set([
  '本', '本子', '这个', '那个', '这部', '那部', '一些', '一点', '几个', '什么', '啥',
  '随便', '好看', '不错', '那个本', '这个本',
]);

/** 关键词开头若是这些，说明更像“看了/说过/想知道”的闲聊，而不是下指令。 */
const FUZZY_CHAT_PREFIXES = /^(?:了|过|着|完|到|说|讲|聊|起|觉|知道|看过|看看|瞧瞧)/u;

/** 关键词里含这些“聊书/问人”的词，更像讨论而不是下命令。 */
const FUZZY_CHAT_CONTAINS = /(?:看过|看了|看完|读过|读了|知道|觉得|认为|说过|讲过|聊过|发过|推荐过|有人|谁|人看|人读|来人|帮忙|帮我看|解释|讨论|看看|好不好|怎么样|买过|喜欢|人买|人喜欢|人推荐)/u;

/** 输入长度硬上限：模糊解析只该服务一句短指令，超长直接当闲聊。 */
const FUZZY_MAX_INPUT_CHARS = 200;

/** 去掉句尾语气词后取“本子/本”标记；没有标记返回 null。 */
function splitFuzzyMarker(text) {
  const body = String(text ?? '').replace(/[吧啊呀呢吗嘛哦啦~～。！!？?\s]+$/u, '');
  if (body.endsWith('本子')) return { marker: '本子', body: body.slice(0, -2) };
  if (body.endsWith('本')) return { marker: '本', body: body.slice(0, -1) };
  return null;
}

/** 循环剥开头白名单前缀；每次都是 startsWith，线性、无回溯。 */
function stripFuzzyPrefixes(text) {
  let out = text;
  for (;;) {
    const hit = FUZZY_PREFIXES.find((prefix) => out.startsWith(prefix));
    if (!hit) return out;
    out = out.slice(hit.length).replace(/^[，,、;；\s]+/u, '');
  }
}

/** 清洗模糊关键词：去掉引导词/尾巴；复合词直接放弃。 */
function cleanFuzzyKeyword(raw, marker) {
  let text = String(raw ?? '').normalize('NFKC').trim();
  text = text.replace(/^(?:[，,、;；\s]+)/u, '')
    .replace(/^(?:个|点|些|下|一下|看看|看下|看|推荐|安利|这个|那个|这部|那部|一些|一点|几个|本|的)+/u, '')
    .replace(/[的吧啊呀呢吗嘛哦啦~～\s]+$/u, '')
    .trim();
  if (!text || FUZZY_STOP_WORDS.has(text)) return null;
  if (FUZZY_CHAT_PREFIXES.test(text) || FUZZY_CHAT_CONTAINS.test(text)) return null;
  // 裸“本”前面只有一个字时太容易是“本来/基本/成本”这类句子；要求至少两字。
  if (marker === '本' && Array.from(text).length < 2) return null;
  if (Array.from(text).length > MAX_JM_KEYWORD_CHARS) return null;
  // 句尾裸“本”可能是复合词的词尾：来个日本 / 来个成本 / 来个笔记本。
  const compound = `${text}${marker}`;
  if (FUZZY_BEN_COMPOUNDS.has(compound) || FUZZY_BEN_COMPOUNDS.has(text)) return null;
  return text;
}

/**
 * 解析模糊搜本。**只在严格解析失败之后调用**；不联网、不读文件。
 *
 * @param {string} text 消息正文
 * @param {{max?: number}} [options] 展示数量上限（来自 config.jm.max）
 * @returns {{ok:true, action:'search', keyword:string, count:number, countGiven:false,
 *            fuzzy:true} | {ok:false, reason:'format'} | null}
 */
export function parseJmFuzzyCommand(text, { max = DEFAULT_JM_MAX } = {}) {
  const normalized = normalize(text);
  if (!normalized || Array.from(normalized).length > FUZZY_MAX_INPUT_CHARS) return null;
  const split = splitFuzzyMarker(normalized);
  if (!split) return null;
  let rest = split.body.replace(/[的\s]+$/u, '');
  rest = stripFuzzyPrefixes(rest);
  const cue = FUZZY_CUES.find((one) => rest.startsWith(one));
  if (!cue) return null;
  rest = rest.slice(cue.length).replace(/^[，,、;；\s]+/u, '');
  rest = rest.replace(FUZZY_FILLER_RE, '').replace(/^[，,、;；\s]+/u, '');
  const keyword = cleanFuzzyKeyword(rest, split.marker);
  if (!keyword) return null;
  const limit = Number.isSafeInteger(max) && max > 0 ? max : DEFAULT_JM_MAX;
  return {
    ok: true,
    action: 'search',
    keyword,
    count: limit,
    countGiven: false,
    fuzzy: true,
  };
}

/**
 * 一位数字里可以当**序号**的取值（搜索结果最多 5 本；单元本清单最多列 15 个，
 * 序号只放行到 9 —— 10 个以上用清单里显示的单元编号选，见 `src\jm-service.js`）。
 */
const MAX_RANK = 9;

/** 导航用的宽松形状：只要开头是搜索/下载动词，就算"在尝试这条指令"。 */
const ATTEMPT_RE = new RegExp(`^(?:${SEARCH_VERBS}|${DOWNLOAD_VERBS}|整本打包|打包)`, 'u');

/** 打包只认显式全选或以空白分隔的正整数序号；不把编号/标题猜成选项。 */
function parsePackCommand(text) {
  if (text.startsWith('整本打包')) {
    const body = text.replace(/\s*(?:（#全部单元）|\(#全部单元\))$/u, '').trim();
    return body === '整本打包'
      ? { ok: true, action: 'pack', all: true, ordinals: [] }
      : { ok: false, reason: 'format' };
  }
  if (!text.startsWith('打包')) return null;
  const body = text.slice(2).replace(/\s*(?:（#选择单元打包）|\(#选择单元打包\))$/u, '').trim();
  if (!body) return { ok: false, reason: 'format' };
  const tokens = body.split(/\s+/u);
  if (tokens.some((token) => !/^[1-9]\d*$/u.test(token) || !Number.isSafeInteger(Number(token)))) {
    return { ok: false, reason: 'format' };
  }
  return { ok: true, action: 'pack', all: false, ordinals: tokens.map(Number) };
}

/**
 * 把一个数量词解析成数字：阿拉伯数字或中文 1..5；认不出返回 NaN。
 * ⚠️ 这里**不收** 0/6..9/十几 —— 写 0 是明确写错（reason=count），写 6..9 的阿拉伯
 *    数字会进 `parseSearchCount` 的夹取分支（写多了夹到上限）。
 */
function parseCountToken(token) {
  const raw = String(token ?? '').trim();
  if (/^\d+$/u.test(raw)) return Number.parseInt(raw, 10);
  return CN_NUM[raw] ?? Number.NaN;
}

/**
 * 剥掉正文开头残留的**纯文本 @**（`@副实例 搜本 全彩`）。
 * 只剥 `@` 到第一个空白/标点为止的那一段；最多剥三段，剥不出东西就原样返回。
 */
function stripLeadingMentions(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 3; i += 1) {
    const match = /^@[^\s，,、;；。.!！?？]+[\s，,、;；。]*/u.exec(out);
    if (!match) break;
    out = out.slice(match[0].length);
  }
  return out;
}

/**
 * 剥掉正文**末尾**残留的纯文本 @（`搜本 全彩 @副实例`）。只剥最后一段 `@+非空白`；
 * 最多连剥三段（多个提及并列的写法）。没有 `@` 就原样返回。
 */
function stripTrailingMentions(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 3; i += 1) {
    const match = /[\s，,、;；。.!！?？]*@[^\s@，,、;；。.!！?？]+$/u.exec(out);
    if (!match) break;
    out = out.slice(0, match.index).trimEnd();
  }
  return out;
}

/** 归一化：去装饰性标点与残留 @。返回空串 = 没有可用正文。 */
function normalize(text) {
  let out = String(text ?? '')
    .trim()
    .replace(/^[，,、;；\s]+/u, '')
    .replace(/[。！!？?]+$/u, '')
    .trim();
  out = stripLeadingMentions(out);
  out = stripTrailingMentions(out);
  return out.trim();
}

/**
 * 解析搜索指令的剩余段：「关键词 [数量]」。
 *
 * @param {string} rest 动词之后的正文
 * @param {number} max 数量上限（来自 `config.jm.max`）
 * @returns {{ok: true, action: 'search', keyword: string, count: number,
 *            countGiven: boolean}
 *   | {ok: false, reason: 'format'|'count'|'keyword'}}
 */
function parseSearchRest(rest, max) {
  const body = String(rest ?? '').trim();
  if (!body) return { ok: false, reason: 'format' };

  // 结构化条件（作者/原作/IP/角色/标签/标题/页码）优先；没有条件键时回到普通关键词。
  const structured = parseStructuredSearchRest(body);
  if (structured) return structured;

  // 末尾单独一个数量词（必须**以空白分隔**，见文件头 ① 的宁窄勿宽口径）。
  let keyword = body;
  let count = null;
  const spaced = /^(.*?)\s+([0-9一二两三四五六七八九十]+)$/u.exec(body);
  if (spaced && spaced[1].trim()) {
    const parsed = parseCountToken(spaced[2]);
    // 「搜本 xxx 十几」这种落不到数字的，不当数量 —— 整段仍算关键词（不瞎猜）。
    if (Number.isSafeInteger(parsed)) {
      keyword = spaced[1].trim();
      count = parsed;
    }
  }
  if (!keyword) return { ok: false, reason: 'format' };
  if (count !== null && count <= 0) return { ok: false, reason: 'count' };
  if (Array.from(keyword).length > MAX_JM_KEYWORD_CHARS) return { ok: false, reason: 'keyword' };

  const limit = Number.isSafeInteger(max) && max > 0 ? max : DEFAULT_JM_MAX;
  return {
    ok: true,
    action: 'search',
    keyword,
    // 写多了夹到上限；没写用上限（一次最多看多少本）。
    count: count === null ? limit : Math.min(count, limit),
    countGiven: count !== null,
  };
}

/**
 * 解析下载指令的剩余段：「编号 / 序号」。
 *
 * @param {string} rest 动词之后的正文
 * @returns {{ok: true, action: 'download', target: string|null, ordinal: number|null,
 *            raw: string} | {ok: false, reason: 'format'}}
 */
function parseDownloadRest(rest) {
  const body = String(rest ?? '')
    .trim()
    .replace(/^[#＃]+\s*/u, '')
    .replace(/^第\s*/u, '')
    .replace(/\s*(?:本|号)$/u, '')
    .trim();
  if (!body) return { ok: false, reason: 'format' };
  if (!/^\d+$/u.test(body)) return { ok: false, reason: 'format' };

  // 序号只有一位 1..5；两位及以上一律当作品编号（JM 的 id 是六位数级别）。
  if (body.length === 1) {
    const rank = Number.parseInt(body, 10);
    if (rank < 1 || rank > MAX_RANK) return { ok: false, reason: 'format' };
    return { ok: true, action: 'download', target: null, ordinal: rank, raw: body };
  }
  return { ok: true, action: 'download', target: body, ordinal: null, raw: body };
}

/**
 * 解析一条群消息。成功 = 可以照做；失败 = 不是这条指令（由调用方决定要不要回格式提示）。
 *
 * @param {string} text 消息正文（群里已经剥掉段落 @ 也行，多剥一层无副作用）
 * @param {{max?: number}} [options] `max` = 一次最多搜几本（来自 `config.jm.max`）
 * @returns {{ok: true, action: 'search', keyword: string, count: number, countGiven: boolean}
 *   | {ok: true, action: 'search', mode: 'structured', conditions: object, page: number,
 *      keyword: null, countGiven: false}
 *   | {ok: true, action: 'download', target: string|null, ordinal: number|null, raw: string}
 *   | {ok: true, action: 'pack', all: boolean, ordinals: number[]}
 *   | {ok: false, reason: 'format'|'count'|'keyword'|'page'|'unsupported', field?: string}}
 */
export function parseJmCommand(text, { max = DEFAULT_JM_MAX } = {}) {
  const normalized = normalize(text);
  if (!normalized) return { ok: false, reason: 'format' };

  // 「搜本子」「找本子」没有关键词：不能把动词后面的「子」当关键词搜出去。
  if (/^(?:搜本|找本)子\s*$/u.test(normalized)) return { ok: false, reason: 'format' };

  const pack = parsePackCommand(normalized);
  if (pack) return pack;

  const search = new RegExp(`^(?:${SEARCH_VERBS})\\s*(.*)$`, 'u').exec(normalized);
  if (search) return parseSearchRest(search[1], max);

  const download = new RegExp(`^(?:${DOWNLOAD_VERBS})\\s*(.*)$`, 'u').exec(normalized);
  if (download) return parseDownloadRest(download[1]);

  return { ok: false, reason: 'format' };
}

/**
 * 「看起来是在尝试搜本/下本」—— 用来区分"格式写歪了"与"普通闲聊"。
 *
 * 只认动词**开头**（剥完 @残留之后）：`搜本`、`找本`、`下本`、`下载本子` 都算；
 * 写成 `搜本`（没关键词）、`下本 随便`（编号不是数字）这类也回一句格式提示。
 * ⚠️ 只给格式提示用：解析成功的那条根本到不了这里。
 *
 * @param {string} text
 */
export function looksLikeJmAttempt(text) {
  return ATTEMPT_RE.test(normalize(text));
}
