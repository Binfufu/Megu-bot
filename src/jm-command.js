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
 *     搜本 作者:甲                ← 结构化检索：作者（上游 author 模式）；也认「作者 甲 / author 甲」
 *     搜本 原作:乙 / 搜本 IP:乙    ← 结构化检索：原作/IP（上游 work 模式）
 *     搜本 角色:丙                ← 结构化检索：角色（上游 actor 模式）
 *     搜本 标签:丁                ← 结构化检索：站点标签（上游 tag 模式）；也认「标签 丁 / tag 丁」
 *     搜本 标题:戊                ← 标题文字检索（站点候选后按标题复核）
 *     搜本 作者:甲 标签:丁 2       ← 多条件 AND + 页码；只回本次检查范围内的清单
 *     搜原神的本子               ← 模糊搜本：请求动词 + 句尾“本子/本”，关键词=原神
 *     搜齁的本 / 来个齁的本       ← 单字关键词也认（裸「本」不再强制≥2 字，2026-11-20）
 *     来个莉音的本               ← 同上；只给清单，不自动下载
 *     （结构化/模糊检索永远只给清单；普通「搜本 关键词」旧行为不变）
 *     下本 1490076              ← 直接给作品编号（至少两位数字；边车按 id 下载）
 *     下本 3                    ← 给**序号**：取本群最近一次搜索结果里的第 3 本
 *     下本 1489725 1488143      ← 一次选多个（空格/逗号/顿号分隔，最多 5 个，逐个下载）
 *     下本 1 2                  ← 多个序号也认；写「下本1 2」「下本 1、2」都行
 *     下本 JM1490076            ← 编号可带清单里显示的 JM 前缀（去掉后再按编号解析）
 *     下载本子 1490076          ← 「下载本子」是「下本」的别名
 *     整本打包                 ← 显式选择最近本群单元清单全部
 *     打包1 3 5 7              ← 只选择这些单元序号（可超过 9，按清单顺序合并）
 *
 * 解析顺序（每一步只做一件小事，selftest 按表钉着）：
 *   ⓪ 归一化：trim → 去前导标点/空白 → 去句末标点 → 剥前导 `@残留` → 剥末尾 `@残留`；
 *   ① 搜索指令：`^(搜本|找本|搜索本子|找本子)\s*(.*)$`（正文可跨行）；
 *      纯多编号/序号清单回 `useDownload`，不搜索/下载；保留同一行的短数量旧写法（如 `搜本 123456 2`）。
 *      剩余段**末尾以空白分隔**的数量词（阿拉伯数字或中文 1..5）当数量，其余全是关键词。
 *      ⚠️ 数量必须与关键词之间有空白：「搜本 全彩3」里的 `3` 算关键词（宁窄勿宽，
 *      关键词里出现数字很常见，不能瞎猜）；
 *   ② 下载指令：`^(下本|下载本子|下载本)\s*(.*)$` —— 按空白/逗号/顿号/斜杠/和与及切成多个目标；
 *      每个目标再去掉 `#`/`第`/`JM` 前缀与尾部「本/号/个」：
 *      · **一位数字 1..9** = 序号（对应最近一次搜索/单元清单的 rank，由服务层换算成 id）；
 *      · **两位及以上数字** = 作品/单元编号，原样交给边车按编号精确解析；
 *      · 同一个目标写两遍按一次算；超过 5 个回 `tooMany`（不静默截断）；
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
// 有分隔的「搜本子/找本子」是别名；无分隔的「搜本子宫」仍按「搜本 子宫」解析
// （2026-11-24：补上「搜本子」—— 以前「搜本子 全彩」被「搜本」咬走，关键词变成「子 全彩」）。
// 长词必须排在前：「搜本子」先于「搜本」，「搜索本子」先于「搜本」。
const SEARCH_VERBS = '搜索本子|搜本子(?=\\s|$)|搜本|找本子(?=\\s|$)|找本';
const DOWNLOAD_VERBS = '下本|下载本子|下载本';
const SEARCH_COMMAND_RE = new RegExp(`^(?:${SEARCH_VERBS})\\s*(.*)$`, 'su');
const DOWNLOAD_COMMAND_RE = new RegExp(`^(?:${DOWNLOAD_VERBS})\\s*(.*)$`, 'su');

/** 中文数量 → 数值（只收 1..5 与常见写法；「十几」之类落不到数字 = 当关键词）。 */
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };

/**
 * 结构化检索的条件键：中文主名 + 常见中英别名（2026-11-20 放宽）。
 * 未知键仍然回 unsupported（不静默当关键词），但近失键会由 `suggestJmSyntax` 给出纠正提示。
 */
const STRUCTURED_FIELDS = new Map([
  ['作者', 'creator'],
  ['作者名', 'creator'],
  ['画师', 'creator'],
  ['author', 'creator'],
  ['artist', 'creator'],
  ['原作', 'original'],
  ['作品', 'original'],
  ['IP', 'original'],
  ['ip', 'original'],
  ['work', 'original'],
  ['角色', 'character'],
  ['人物', 'character'],
  ['character', 'character'],
  ['actor', 'character'],
  ['标签', 'tag'],
  ['标签名', 'tag'],
  ['tag', 'tag'],
  ['tags', 'tag'],
  ['标题', 'title'],
  ['title', 'title'],
]);

/** 页码键（`页码:2` 与「页码 2」都认）。 */
const PAGE_KEYS = new Set(['页码', '页', 'page']);

/** 字段规范名 → 中文标签（近失提示用）。 */
const FIELD_LABELS = Object.freeze({
  creator: '作者', original: '原作', character: '角色', tag: '标签', title: '标题', page: '页码',
});

/** 取条件键的规范字段名；不是条件键返回 null（英文键大小写不敏感）。 */
function structuredField(key) {
  const raw = String(key ?? '').normalize('NFKC').trim();
  if (!raw) return null;
  return STRUCTURED_FIELDS.get(raw) ?? STRUCTURED_FIELDS.get(raw.toLowerCase()) ?? null;
}

/** 是不是页码键（英文 page 大小写不敏感）。 */
function isPageKey(key) {
  const raw = String(key ?? '').normalize('NFKC').trim();
  return PAGE_KEYS.has(raw) || PAGE_KEYS.has(raw.toLowerCase());
}

/** 结构化检索的值/页码上限；页码与列表页码同一口径。 */
const MAX_STRUCTURED_VALUE_CHARS = 60;
const MAX_STRUCTURED_PAGE = 9999;

/** 把 `键:值` 拆开（全角/半角冒号都认）；没有冒号返回 null。 */
function splitKeyValue(token) {
  const match = /^([^:：]+)[:：](.*)$/u.exec(String(token ?? ''));
  if (!match) return null;
  return { key: match[1].normalize('NFKC').trim(), value: match[2].trim() };
}

/**
 * **粘连键**：`标签全彩` / `作者甲` / `页码2`（2026-11-24，命令路由收口现场写法）。
 * 只认「条件键（最长优先）+ 直接跟值」，值不能为空，不做子串扫描。
 * ⚠️ 换来的代价：`标题党` 会当成 title=党、`作品集` 当成 original=集 —— 这是“用户把键和值
 *    粘在一起”的既有语义；按条件走比把整段当关键词（搜出 0 条）更容易解释。
 * @returns {{field: string, key: string, value: string}|null}
 */
function splitGluedCondition(token) {
  const raw = String(token ?? '').normalize('NFKC').trim();
  if (!raw) return null;
  // 长键先试：「作者名」先于「作者」、「tags」先于「tag」。
  const candidates = [...STRUCTURED_FIELDS.keys(), ...PAGE_KEYS].sort((a, b) => b.length - a.length);
  for (const key of candidates) {
    if (!raw.startsWith(key) || raw.length === key.length) continue;
    const value = raw.slice(key.length).trim();
    if (!value) continue;
    const field = structuredField(key);
    return field ? { field, key, value } : { field: 'page', key, value };
  }
  return null;
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

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const pair = splitKeyValue(token);
    if (pair) {
      if (isPageKey(pair.key)) {
        if (!/^\d+$/u.test(pair.value) || !setPage(pair.value)) return { ok: false, reason: 'page' };
        continue;
      }
      const field = structuredField(pair.key);
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

    // 2026-11-20：条件键与值之间只写空格也认（「搜本 标签 齁」「搜本 tag 齁」）。
    // 只在下一个 token 不是另一个条件键时消费；写了键却没有值 → 明确回格式错误（不静默当关键词）。
    const bareField = structuredField(token);
    if (bareField) {
      const next = tokens[i + 1];
      const nextIsKey = next !== undefined && (
        splitKeyValue(next) !== null || structuredField(next) !== null || isPageKey(next));
      if (next === undefined || nextIsKey) return { ok: false, reason: 'format', field: token };
      const value = String(next).normalize('NFKC').trim();
      if (!value || Array.from(value).length > MAX_STRUCTURED_VALUE_CHARS) {
        return { ok: false, reason: 'format', field: token };
      }
      const list = conditions[bareField] ?? [];
      if (list.length >= 5) return { ok: false, reason: 'format', field: token };
      list.push(value);
      conditions[bareField] = list;
      hasCondition = true;
      i += 1;
      continue;
    }

    // 页码的空格写法：「搜本 作者:甲 页码 2」。
    if (isPageKey(token)) {
      const next = tokens[i + 1];
      if (next === undefined || !/^\d+$/u.test(next) || !setPage(next)) {
        return { ok: false, reason: 'page' };
      }
      i += 1;
      continue;
    }

    // 粘连键（2026-11-24）：「搜本 标签全彩」「搜本作者甲」—— 键和值之间没写冒号/空格。
    // 必须排在“裸条件键”和页码之后：单独一个「标签」仍是明确的格式错误。
    const glued = splitGluedCondition(token);
    if (glued) {
      if (glued.field === 'page') {
        if (!/^\d+$/u.test(glued.value) || !setPage(glued.value)) return { ok: false, reason: 'page' };
        continue;
      }
      const value = glued.value.normalize('NFKC').trim();
      if (!value || Array.from(value).length > MAX_STRUCTURED_VALUE_CHARS) {
        return { ok: false, reason: 'format', field: glued.key };
      }
      const list = conditions[glued.field] ?? [];
      if (list.length >= 5) return { ok: false, reason: 'format', field: glued.key };
      list.push(value);
      conditions[glued.field] = list;
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
    // 但只写了页码没写条件键（`搜本 页码 2`）不是一次有意义的检索，明确回格式错误。
    return pageGiven ? { ok: false, reason: 'format' } : null;
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

/**
 * **书/媒体目标名词**（2026-11-24，命令路由的目标名词闸）：
 * 「目标名词闸」判定“这句话在找书还是找图”时，书侧只有这一份词表；
 * 图像侧对应 `src\meitu-command.js` 的 `hasImageTarget`（各自一份，供 router 复用，不互相抄）。
 * 裸「本」不写在这里 —— 它必须过上面的 `FUZZY_BEN_COMPOUNDS` 复合词护栏（日本/成本/剧本…）。
 *
 * ⚠️ 2026-11-24 审查 P2-2：裸 `书` / `漫画` 太宽（`来张秘书图`、`来张书签图`、`来点漫画风图`
 * 会被判成「书+图」两边都有 → 误澄清）。这里只保留**本身就像书/媒体目标**的名词：
 * `本子/单行本/同人本/漫画书/画集/资源`；裸「书」「漫画」不再算目标（宁可当闲聊/不认）。
 */
const BOOK_TARGET_NOUNS = ['本子', '单行本', '同人本', '漫画书', '画集', '资源'];

/**
 * `index` 处的「本」是不是**复合词**的一部分（复用 `FUZZY_BEN_COMPOUNDS`，不另写词表）。
 * 做法 = 枚举包含这个「本」的 2..4 字子串，命中词表就算复合词（「日本」「成本」「笔记本」
 * 「笔记本子」「剧本」都在表里）。词表最大就是 4 字，所以不需要更长。
 */
function isBenCompoundAt(text, index) {
  const value = String(text ?? '');
  if (value[index] !== '本') return false;
  for (let length = 2; length <= 4; length += 1) {
    for (let start = Math.max(0, index - length + 1); start <= index; start += 1) {
      const chunk = value.slice(start, start + length);
      if (chunk.length === length && FUZZY_BEN_COMPOUNDS.has(chunk)) return true;
    }
  }
  return false;
}

/**
 * 文本里有没有**书/媒体目标**（命令路由的目标名词闸；纯函数、零 IO）。
 *
 * 只判“提到了书/媒体名词”，不判“是不是命令” —— 「这个本子不错」也算提到了本子，
 * 由上面的命令形状闸（strict/fuzzy/自然句式/`looksLikeJmAttempt`）决定它是不是指令。
 * 复合词护栏复用 `FUZZY_BEN_COMPOUNDS`：日本 / 本来 / 成本 / 基本 / 老板本来 / 剧本 都不算。
 *
 * @param {string} text 消息正文
 * @returns {boolean}
 */
export function hasBookTarget(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) return false;
  for (const noun of BOOK_TARGET_NOUNS) {
    let from = 0;
    for (;;) {
      const at = normalized.indexOf(noun, from);
      if (at === -1) break;
      // 「本子」的「本」在词首；「单行本/同人本」的「本」在词尾 —— 复合词检查要指到「本」上。
      const benIndex = noun === '本子' ? at : at + noun.length - 1;
      if ((noun === '本子' || noun.endsWith('本')) && isBenCompoundAt(normalized, benIndex)) {
        from = at + 1;
        continue;
      }
      return true;
    }
  }
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] !== '本') continue;
    if (isBenCompoundAt(normalized, i)) continue;
    return true;
  }
  return false;
}

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
  if (Array.from(text).length > MAX_JM_KEYWORD_CHARS) return null;
  // 句尾裸“本”可能是复合词的词尾：来个日本 / 来个成本 / 来个笔记本。
  // 2026-11-20：不再额外要求「裸本至少两字」—— 那条规则会误杀「搜齁的本」这类单字关键词；
  // 复合词由下面这张黑名单负责挡（成本/日本/基本/剧本…），单字但不在名单里的照常放行。
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
  const normalized = normalizeCommandText(text);
  if (!normalized || Array.from(normalized).length > FUZZY_MAX_INPUT_CHARS) return null;
  // 显式搜本的编号清单已经被严格入口拒绝；末尾「本」是目标后缀，不是模糊请求。
  const search = SEARCH_COMMAND_RE.exec(normalized);
  if (search && isDownloadTargetList(search[1])) return null;
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

/**
 * 一条消息里最多同时下几本（编号/序号都算）。再多就回明确提示，不静默截断：
 * 每个都要真下载 + 打包 + 发文件，还会把本群串行队列占住几分钟。
 */
export const MAX_DOWNLOAD_TARGETS = 5;
const DOWNLOAD_TARGET_SEPARATOR_RE = /[\s,，、;；/和与及]+/u;

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

/**
 * 归一化：去装饰性标点与残留 @。返回空串 = 没有可用正文。
 * 2026-11-24 起对外导出（`normalizeCommandText`）：命令路由与需求方要按同一个口径
 * 判“这条正文算不算一条指令”，不能各自 trim 一遍。
 */
export function normalizeCommandText(text) {
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
 *   | {ok: false, reason: 'format'|'count'|'keyword'|'useDownload'}}
 */
function parseSearchRest(rest, max) {
  if (isDownloadTargetList(rest)) return { ok: false, reason: 'useDownload' };
  // 搜索文本跨行时把换行当词间空格；单行中原有的空格不改动。
  const body = rest.split(/[\r\n\u2028\u2029]+/u).map((line) => line.trim()).filter(Boolean).join(' ');
  if (!body) return { ok: false, reason: 'format' };

  // 结构化条件（作者/原作/IP/角色/标签/标题/页码）优先；没有条件键时回到普通关键词。
  const structured = parseStructuredSearchRest(body);
  if (structured) return structured;

  // 末尾单独一个数量词（必须**以空白分隔**，见文件头 ① 的宁窄勿宽口径）。
  let keyword = body;
  let count = null;
  const spaced = /\s([0-9一二两三四五六七八九十]+)$/u.exec(body);
  if (spaced) {
    const parsed = parseCountToken(spaced[1]);
    // 「搜本 xxx 十几」这种落不到数字的，不当数量 —— 整段仍算关键词（不瞎猜）。
    if (Number.isSafeInteger(parsed)) {
      keyword = body.slice(0, spaced.index).trimEnd();
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
 * 共用的编号/序号清单解析：支持空白（含换行）、逗号、顿号、分号、斜杠或「和/与/及」混排；
 * 目标可带 `#`/`第`/`JM` 前缀和「本/号/个」后缀；全角经 NFKC；同一个目标只算一次。
 * 保留去重前的项数，让搜本也能识别重复粘贴的清单；这里只解析，不套下载数量上限。
 */
function parseDownloadTargets(rest) {
  const body = rest.normalize('NFKC').replace(/^[\s:：,，、;；/]+/u, '').trim();
  const chunks = body.split(DOWNLOAD_TARGET_SEPARATOR_RE).filter(Boolean);
  if (chunks.length === 0) return null;

  const targets = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const token = String(chunk)
      .replace(/^[#＃]+/u, '')
      .replace(/^jm/iu, '')
      .replace(/^[#＃]+/u, '')
      .replace(/^第/u, '')
      .replace(/[本号个.。]+$/u, '')
      .trim();
    if (!/^\d+$/u.test(token)) return null;

    // 序号只有一位 1..9；两位及以上一律当作品编号（JM 的 id 是六位数级别）。
    if (token.length === 1) {
      const rank = Number.parseInt(token, 10);
      if (rank < 1 || rank > MAX_RANK) return null;
      if (seen.has(`rank:${rank}`)) continue;
      seen.add(`rank:${rank}`);
      targets.push({ kind: 'ordinal', ordinal: rank });
      continue;
    }
    if (!Number.isSafeInteger(Number(token))) return null;
    if (seen.has(`id:${token}`)) continue;
    seen.add(`id:${token}`);
    targets.push({ kind: 'id', target: token });
  }
  return { targets, raw: body, itemCount: chunks.length };
}

/** 搜本遇到纯目标清单只提示；同一行「单目标 + 单位数」仍按旧数量语法解析。 */
function isDownloadTargetList(rest) {
  const shortCount = /^(\S+)[^\S\r\n\u2028\u2029]+[0-9]$/u.exec(rest);
  if (shortCount && !DOWNLOAD_TARGET_SEPARATOR_RE.test(shortCount[1].normalize('NFKC'))) return false;
  return (parseDownloadTargets(rest)?.itemCount ?? 0) > 1;
}

/** 下本限定去重后的目标个数，不静默截断。 */
function parseDownloadRest(rest) {
  const parsed = parseDownloadTargets(rest);
  if (!parsed) return { ok: false, reason: 'format' };
  const { targets, raw } = parsed;
  if (targets.length > MAX_DOWNLOAD_TARGETS) {
    return { ok: false, reason: 'tooMany', count: targets.length, max: MAX_DOWNLOAD_TARGETS };
  }
  return { ok: true, action: 'download', targets, raw };
}

/**
 * 解析一条群消息。成功 = 可以照做；失败 = 不是这条指令（由调用方决定要不要回格式提示）。
 *
 * @param {string} text 消息正文（群里已经剥掉段落 @ 也行，多剥一层无副作用）
 * @param {{max?: number}} [options] `max` = 一次最多搜几本（来自 `config.jm.max`）
 * @returns {{ok: true, action: 'search', keyword: string, count: number, countGiven: boolean}
 *   | {ok: true, action: 'search', mode: 'structured', conditions: object, page: number,
 *      keyword: null, countGiven: false}
 *   | {ok: true, action: 'download',
 *      targets: Array<{kind:'id', target:string}|{kind:'ordinal', ordinal:number}>, raw: string}
 *   | {ok: true, action: 'pack', all: boolean, ordinals: number[]}
 *   | {ok: false, reason: 'format'|'count'|'keyword'|'page'|'unsupported'|'tooMany'|'useDownload', field?: string}}
 */
export function parseJmCommand(text, { max = DEFAULT_JM_MAX } = {}) {
  const normalized = normalizeCommandText(text);
  if (!normalized) return { ok: false, reason: 'format' };

  // 「搜本子」「找本子」没有关键词：不能把动词后面的「子」当关键词搜出去。
  if (/^(?:搜本|找本)子\s*$/u.test(normalized)) return { ok: false, reason: 'format' };

  const pack = parsePackCommand(normalized);
  if (pack) return pack;

  // 2026-11-24 真实群语料（c106）：「下这个JM1485799」「下那张 12345」——用户不会照
  // 帮助写「下本」；带指示词的下载简写按同一份目标解析走。
  const downloadShorthand = /^(?:下|下载)\s*(?:这个|那张|这条|这个本子|这本|这一本|那个)\s*(.+)$/u.exec(normalized);
  if (downloadShorthand) return parseDownloadRest(downloadShorthand[1]);

  // 2026-11-24 真实群语料（c106）：「搜作者kusui」「查标签全彩」——省掉「本」的写法。
  // 只认明确的**结构化条件键**开头，仍交给 parseSearchRest 解析（字段/AND/页码一份实现）。
  if (/^(?:搜|找|查)\s*(?:作者名|作者|画师|原作|作品|角色|人物|标签名|标签|标题)(?=\S)/u.test(normalized)) {
    return parseSearchRest(normalized.replace(/^(?:搜|找|查)\s*/u, ''));
  }

  const search = SEARCH_COMMAND_RE.exec(normalized);
  if (search) return parseSearchRest(search[1], max);

  const download = DOWNLOAD_COMMAND_RE.exec(normalized);
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
  return ATTEMPT_RE.test(normalizeCommandText(text));
}

/** 字段规范名 → 中文标签；近失提示与帮助文案共用这一处，避免再抄第二份名单。 */
export const JM_FIELD_LABELS = FIELD_LABELS;

/**
 * 一次编辑内的近似判定（含相邻换位），用于「你是不是想写 X」的字段键提示。
 * 做法与 Git 的 `help.autoCorrect`（Damerau-Levenshtein 距离 ≤1 才建议）同族；
 * 这里只判"是否 ≤1"，不需要完整距离矩阵，所以是一段几十行的确定性比较。
 */
function withinOneEdit(a, b) {
  const left = Array.from(String(a ?? '').normalize('NFKC').toLowerCase());
  const right = Array.from(String(b ?? '').normalize('NFKC').toLowerCase());
  if (left.length === right.length) {
    const diffs = [];
    for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) diffs.push(i);
    if (diffs.length <= 1) return true;
    // 相邻两字写反（tga → tag）也只算一次。
    return diffs.length === 2
      && diffs[1] === diffs[0] + 1
      && left[diffs[0]] === right[diffs[1]]
      && left[diffs[1]] === right[diffs[0]];
  }
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  if (long.length - short.length !== 1) return false;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i += 1; j += 1; continue; }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}

/** 找与 `key` 只差一次编辑的条件键；找不到返回 null。单字键（如「页」）不参与近失猜测，避免误报。 */
function nearestFieldKey(key) {
  const raw = String(key ?? '').normalize('NFKC').trim();
  if (Array.from(raw).length < 2) return null;
  for (const candidate of [...STRUCTURED_FIELDS.keys(), ...PAGE_KEYS]) {
    if (Array.from(candidate).length < 2) continue;
    if (withinOneEdit(raw, candidate)) {
      return { alias: candidate, field: structuredField(candidate) ?? 'page' };
    }
  }
  return null;
}

/**
 * **近失提示**（2026-11-20，对标 Git 的 did-you-mean）：消息像搜本指令但解析失败时，
 * 从里面找"差一点的条件键"（`作都:甲`、`tga:齁`、`标签 齁` 的漏冒号不算失败），
 * 返回给人话提示用的结构化建议；找不到返回 null（调用方回一条短格式提示即可）。
 *
 * 只做提示，不自动执行用户没写出来的条件 —— 猜错方向比让人再打一遍更糟。
 *
 * @param {string} text 消息正文
 * @returns {{kind:'field', field:string, alias:string, value:string}|null}
 */
export function suggestJmSyntax(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) return null;
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const pair = splitKeyValue(tokens[i]);
    if (pair) {
      if (structuredField(pair.key) || isPageKey(pair.key)) continue;
      const near = nearestFieldKey(pair.key);
      if (near) return { kind: 'field', field: near.field, alias: near.alias, value: pair.value };
      continue;
    }
    // 本身已经是合法条件键的 token 不参与"近失"猜测（否则「标题」会被猜成「标签」）。
    if (structuredField(tokens[i]) || isPageKey(tokens[i])) continue;
    const near = nearestFieldKey(tokens[i]);
    if (near && tokens[i + 1] !== undefined
      && splitKeyValue(tokens[i + 1]) === null
      && structuredField(tokens[i + 1]) === null
      && !isPageKey(tokens[i + 1])) {
      return { kind: 'field', field: near.field, alias: near.alias, value: tokens[i + 1] };
    }
  }
  return null;
}
