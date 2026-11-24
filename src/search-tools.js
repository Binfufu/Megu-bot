/**
 * **搜本 / 发图 两个多功能组件的工具适配层**(2026-11-24,「模型能操作会发群消息的组件」)。
 *
 * ## 这一层只做两件事
 *
 * ```text
 * 模型参数 → normalizeXxxArgs → 现有服务 handler(parsed, ctx) → 结果原样回给模型
 * ```
 *
 * 群白名单 / 冷却 / 被动槽位 / 队列 / 失败话术**全部仍在服务层**(`jm-service.js` /
 * `meitu-service.js`),这里一个都不复制 —— 工具层只是"把模型的话翻译成服务认识的 parsed",
 * 服务层自己会拒绝没开的群、冷却中的群、越权操作。这样命令入口与模型入口走的是**同一份判定**,
 * 不会出现"指令不让发、模型能发"的两套权限。
 *
 * ## 为什么必须显式归一,而不是拼字符串再 `parseJmCommand`
 *
 * 拼字符串会让用户可控的值变成**命令语法**注入点(值里带换行/空白/「作者:」就多出一个条件,
 * 甚至拼进下载动词)。这里直接从结构化参数**构造 parsed**,值只当字符串,永远不参与语法解析。
 * 归一规则与命令解析器的口径对齐(60 字上限 / 1..5 张 / 标签白名单),但**不复用其解析路径**。
 *
 * ## 能力定义
 *
 * 两个能力的 effect 都是 `'mutating'`(会真发群消息、发文件),执行前要过
 * `capabilities.authorizeExecution` 的 `allowMutatingIds` 显式放行;costCny 0(本机组件,
 * 不计搜索 API 成本)。`buildSearchTools` 由装配层注入 `defineCapability` 与 handlers,
 * 本文件不直接依赖能力运行时(保持纯函数、可单测)。
 */

import { DEFAULT_JM_MAX, MAX_JM_KEYWORD_CHARS } from './jm-command.js';
import { DEFAULT_MEITU_COUNT, DEFAULT_MEITU_MAX, TAG_WORDS } from './meitu-command.js';

/** 工具 id:发出去给模型的名字(改这里 = 改协议,测试钉着字面值)。 */
export const SEARCH_TOOL_IDS = Object.freeze({
  jmSearch: 'jm_search',
  meituSend: 'meitu_send',
});

/** 结构化检索条件的规范字段名(与 `parseJmCommand` 的 structured conditions 同形)。 */
const JM_CONDITION_FIELDS = Object.freeze(['creator', 'original', 'character', 'tag', 'title']);

/** 结构化检索单字段最多几个值(与解析器 `parseStructuredSearchRest` 的口径一致)。 */
const MAX_JM_CONDITION_VALUES = 5;

/** 页码上限(与解析器 `MAX_STRUCTURED_PAGE` 同口径)。 */
const MAX_JM_PAGE = 9999;

/** 每张图最多带几个修饰 tag(与 `meitu-command.js` 的 `MAX_TAGS` 同口径)。 */
const MAX_MEITU_TAGS = 2;

/**
 * 工具单次最多发几张图（2026-11-24 审查 P1-4）。
 *
 * 一条入站消息的被动回复槽位是 5；工具先发、最终回复还要接一句。留 1 个槽给最终回复，
 * 所以工具侧最多 3 张图 + 1 条回执 —— 超过就可能在最终回复时转主动，而没主动权限的群
 * 会静默丢回答。`meitu_send` 的 schema 描述与校验都用这一个数。
 */
const MAX_TOOL_MEITU_COUNT = 3;

/** 角色名长度上限（与 JM 关键词 60 字口径分开：角色名/别名不会这么长）。 */
const MAX_MEITU_CHARACTER_CHARS = 40;

/** 换行 / 行分隔符 / 控制字符:值里出现即拒(防把参数当多行指令注入)。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** 图源合法 tag 集合(只收 `TAG_WORDS` 里真实存在的 tag 值,不收中文叫法/任意字符串)。 */
const MEITU_TAG_SET = new Set(TAG_WORDS.map((entry) => entry.tag));

/** 统一的参数错误形状(execute 原样回给模型,code 固定 INVALID_ARGUMENTS)。 */
function invalid(message) {
  return { ok: false, error: { code: 'INVALID_ARGUMENTS', message } };
}

/**
 * 归一一个检索值:NFKC → trim,再卡非空 / 换行控制符 / 长度上限(`MAX_JM_KEYWORD_CHARS`)。
 * 值**只当纯文本**,不参与任何命令语法解析(见文件头)。
 */
function normalizeJmText(value, field) {
  if (typeof value !== 'string') return invalid(`${field} 必须是字符串`);
  const text = value.normalize('NFKC').trim();
  if (!text) return invalid(`${field} 不能为空`);
  if (CONTROL_CHARS_RE.test(text)) return invalid(`${field} 不能含换行/控制字符`);
  if (Array.from(text).length > MAX_JM_KEYWORD_CHARS) {
    return invalid(`${field} 超过 ${MAX_JM_KEYWORD_CHARS} 字上限`);
  }
  return { ok: true, text };
}

/**
 * 归一一个结构化条件的值:字符串或字符串数组;逐项走 `normalizeJmText`,去重后按 AND 传递。
 * 多值上限与解析器一致(5 个)。
 */
function normalizeJmValues(value, field) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return invalid(`${field} 不能是空数组`);
  if (list.length > MAX_JM_CONDITION_VALUES) {
    return invalid(`${field} 最多 ${MAX_JM_CONDITION_VALUES} 个值`);
  }
  const values = [];
  for (const raw of list) {
    const one = normalizeJmText(raw, field);
    if (!one.ok) return one;
    if (!values.includes(one.text)) values.push(one.text);
  }
  return { ok: true, values };
}

/**
 * **归一 `jm_search` 的参数**(纯函数,不联网/不读文件)。
 *
 * 成功 = 直接产出 `parseJmCommand` 同形的 parsed,交给 `handleJmCommand` 吃;
 * 失败 = `{ok:false, error:{code:'INVALID_ARGUMENTS', message}}`。
 *
 * 口径:
 *   · `query`(关键词)与结构化条件 `creator/original/character/tag/title` **二选一**,
 *     不许混用(混用会被静默丢掉一半条件,宁可明确拒);
 *   · 至少一个条件;结构化条件多值按 AND(单值也是数组,与服务 parsed 同形);
 *   · `original` + `character` 同时出现 → 拒(现有服务不能同时用两种上游模式复核);
 *   · `original`/`character` 多值 → 拒(多值无法逐条复核,与解析器同一约束);
 *   · `count` 只用于关键词检索(1..`DEFAULT_JM_MAX`);结构化清单按配置上限,给 count 明确拒;
 *   · `page` 只用于结构化检索(1..9999);关键词检索没有页码。
 *
 * ⚠️ 纯数字的 `query` 按关键词原样交给服务 —— 服务自己会把它当编号解析(既有 `搜本 <编号>`
 * 语义)。工具层不复制这条判定,以免命令入口与模型入口分叉。
 */
export function normalizeJmSearchArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return invalid('参数必须是对象');
  }

  const conditions = {};
  for (const field of JM_CONDITION_FIELDS) {
    if (args[field] === undefined || args[field] === null) continue;
    const normalized = normalizeJmValues(args[field], field);
    if (!normalized.ok) return normalized;
    conditions[field] = normalized.values;
  }
  const hasStructured = Object.keys(conditions).length > 0;

  let keyword = '';
  if (args.query !== undefined && args.query !== null) {
    const normalized = normalizeJmText(args.query, 'query');
    if (!normalized.ok) return normalized;
    keyword = normalized.text;
  }

  if (hasStructured && keyword) {
    return invalid('query 与结构化条件(creator/original/character/tag/title)只能二选一');
  }
  if (!hasStructured && !keyword) {
    return invalid('至少给一个检索条件(query 或 creator/original/character/tag/title)');
  }

  if ((conditions.original?.length ?? 0) > 0 && (conditions.character?.length ?? 0) > 0) {
    return invalid('原作(original)与角色(character)不能同时作为条件');
  }
  if ((conditions.original?.length ?? 0) > 1 || (conditions.character?.length ?? 0) > 1) {
    return invalid('原作/角色只接受单值(多值无法逐条复核)');
  }

  if (hasStructured) {
    if (args.count !== undefined && args.count !== null) {
      return invalid('结构化检索不接受 count(清单数量跟服务配置上限)');
    }
    let page = 1;
    if (args.page !== undefined && args.page !== null) {
      if (!Number.isSafeInteger(args.page) || args.page < 1 || args.page > MAX_JM_PAGE) {
        return invalid(`page 只许 1..${MAX_JM_PAGE} 的整数`);
      }
      page = args.page;
    }
    return {
      ok: true,
      action: 'search',
      mode: 'structured',
      conditions,
      page,
      keyword: null,
      countGiven: false,
      // 2026-11-24 审查 P1-2：工具承诺"只给清单"，绝不复用命令入口"唯一命中自动下载"。
      listOnly: true,
    };
  }

  if (args.page !== undefined && args.page !== null) {
    return invalid('关键词检索没有页码(page 只用于结构化检索)');
  }
  // 2026-11-24 审查 P1-2：纯数字在服务层会被当编号精确解析并直接下载；
  // 工具不承诺"按编号下本"，明确让模型改用用户的下本指令，避免意外发文件。
  if (/^\d+$/u.test(keyword)) {
    return invalid('纯数字按编号下本，不走搜索工具；请让用户发「下本 <编号>」');
  }
  let count = DEFAULT_JM_MAX;
  let countGiven = false;
  if (args.count !== undefined && args.count !== null) {
    if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > DEFAULT_JM_MAX) {
      return invalid(`count 只许 1..${DEFAULT_JM_MAX} 的整数`);
    }
    count = args.count;
    countGiven = true;
  }
  return { ok: true, action: 'search', keyword, count, countGiven, listOnly: true };
}

/**
 * **归一 `meitu_send` 的参数**(纯函数,不联网/不读文件)。
 *
 * 产出的对象就是 `handleMeituCommand` 吃的 parsed 形状:
 * `{ok, count, character, tags, ratingWanted, tier, random, ignored}`。
 *
 * 口径:
 *   · `count` 缺省 1,只许 1..`DEFAULT_MEITU_MAX`;
 *   · `character` 字符串或空;空 = 随机角色(`random:true`,服务从别名表随机挑);
 *   · `tags` 只收 `TAG_WORDS` 里**真实存在**的 tag 值(最多 2 个,去重),未知 tag 明确拒
 *     —— 不静默丢掉,否则用户要的修饰被吞了还以为发了;
 *   · `tier` 只许 `meitu`(全年龄唯美)/`seitu`(擦边),缺省美图档;
 *   · 归一失败返回 `{ok:false, error:{code:'INVALID_ARGUMENTS', message}}`。
 */
export function normalizeMeituArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return invalid('参数必须是对象');
  }

  let count = DEFAULT_MEITU_COUNT;
  if (args.count !== undefined && args.count !== null) {
    if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > MAX_TOOL_MEITU_COUNT) {
      return invalid(`count 只许 1..${MAX_TOOL_MEITU_COUNT}(工具要给最终回复留一个被动槽)`);
    }
    count = args.count;
  }

  let character = '';
  if (args.character !== undefined && args.character !== null) {
    if (typeof args.character !== 'string') return invalid('character 必须是字符串');
    character = args.character.normalize('NFKC').trim();
    if (CONTROL_CHARS_RE.test(character)) return invalid('character 不能含换行/控制字符');
    if (Array.from(character).length > MAX_MEITU_CHARACTER_CHARS) {
      return invalid(`character 超过 ${MAX_MEITU_CHARACTER_CHARS} 字上限`);
    }
  }

  const tags = [];
  if (args.tags !== undefined && args.tags !== null) {
    if (!Array.isArray(args.tags)) return invalid('tags 必须是字符串数组');
    for (const raw of args.tags) {
      if (typeof raw !== 'string') return invalid('tags 必须是字符串数组');
      const tag = raw.normalize('NFKC').trim();
      if (!MEITU_TAG_SET.has(tag)) {
        return invalid(`未知 tag：${tag || '(空)'}(只用图源已有标签)`);
      }
      if (!tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > MAX_MEITU_TAGS) return invalid(`tags 最多 ${MAX_MEITU_TAGS} 个`);
  }

  let tier = 'meitu';
  if (args.tier !== undefined && args.tier !== null) {
    if (args.tier !== 'meitu' && args.tier !== 'seitu') {
      return invalid('tier 只许 meitu / seitu');
    }
    tier = args.tier;
  }

  return {
    ok: true,
    count,
    character,
    tags,
    ratingWanted: true,
    tier,
    random: character === '',
    ignored: [],
  };
}

/**
 * 构造搜索/发图工具的能力定义数组(冻结;**不注册**任何全局状态,由装配层自己拼)。
 *
 * @param {object} input
 * @param {Function} input.defineCapability `capabilities.js` 的 defineCapability(注入,避免双重实现)
 * @param {{jmSearch: Function, meituSend: Function}} input.handlers
 *   `jmSearch(parsed, ctx)` / `meituSend(parsed, ctx)` —— 装配层把服务层调用包成这两个;
 *   `ctx` 由 `executeAuthorized` 原样透传(`{turnContext, signal}`);
 *   结果必须原样返回(`{ok, ...}` 结构化),本层不再包装/改写。
 * @returns {ReadonlyArray<object>} 冻结的能力定义数组
 */
export function buildSearchTools({ defineCapability, handlers } = {}) {
  if (typeof defineCapability !== 'function') {
    throw new TypeError('buildSearchTools: 需要注入 defineCapability');
  }
  const jmSearch = handlers?.jmSearch;
  const meituSend = handlers?.meituSend;
  if (typeof jmSearch !== 'function' || typeof meituSend !== 'function') {
    throw new TypeError('buildSearchTools: handlers 需要 jmSearch(parsed, ctx) 与 meituSend(parsed, ctx)');
  }

  return Object.freeze([
    defineCapability({
      id: SEARCH_TOOL_IDS.jmSearch,
      description: '搜 JM 本子清单。只在用户明确要搜本/找本时用；会真的执行搜索并在群里发结果清单'
        + '(只给清单，不自动下载文件；要下本让用户发「下本」)。一次只搜一件事：关键词 query 与'
        + '结构化条件二选一；纯数字编号不走这里。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词(与结构化条件二选一)' },
          creator: { description: '作者/画师;字符串或字符串数组(多值按 AND)' },
          original: { description: '原作/IP;字符串(不能与 character 同时用)' },
          character: { description: '角色;字符串(不能与 original 同时用)' },
          tag: { description: '站点标签;字符串或字符串数组(多值按 AND)' },
          title: { description: '标题文字;字符串或字符串数组(多值按 AND)' },
          page: { type: 'integer', description: '页码 1..9999,仅结构化检索' },
          count: { type: 'integer', description: '一次搜几本 1..5,仅关键词检索' },
        },
      },
      effect: 'mutating',
      costCny: 0,
      execute: async (args, ctx) => {
        const parsed = normalizeJmSearchArgs(args);
        if (!parsed.ok) return parsed;
        return jmSearch(parsed, ctx);
      },
    }),
    defineCapability({
      id: SEARCH_TOOL_IDS.meituSend,
      description: '发美图/涩图。只在用户明确要图、美图、涩图时用；会真的找图并把图片发到群里。'
        + '一次只发一件事：角色、档位、修饰一次给全再调用。',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: `发几张 1..${MAX_TOOL_MEITU_COUNT},缺省 1(给最终回复留被动槽)` },
          character: { type: 'string', description: '角色名;留空 = 随机角色' },
          tags: { type: 'array', items: { type: 'string' }, description: '修饰 tag,用图源标签英文标识(如 thighhighs/twintails),最多 2 个' },
          tier: { type: 'string', description: 'meitu(美图,全年龄)/seitu(涩图,擦边),缺省 meitu' },
        },
      },
      effect: 'mutating',
      costCny: 0,
      execute: async (args, ctx) => {
        const parsed = normalizeMeituArgs(args);
        if (!parsed.ok) return parsed;
        return meituSend(parsed, ctx);
      },
    }),
  ]);
}
