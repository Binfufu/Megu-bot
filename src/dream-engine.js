/**
 * **刀二 · 梦境引擎地基**(2026-10-13,`docs\21` §十梦境档 + `docs\20` B 路)。
 *
 * ## 这一层管什么、不管什么
 *
 * 管(全是**纯函数**,不碰网不碰库):
 *  · **锁人路由** —— 一轮里谁说话由代码定死,不由模型自觉(docs\20:结构性的,不是求它);
 *  · **世界书激活器** —— 键控条按上下文捡出来,常驻条照发(仿酒馆 before_char / at_depth);
 *  · **组装器** —— 把〔世界书 + 角色卡 + 历史 + 用户这句 + nudge〕拼成 messages 数组,
 *    形状照 `docs\20` B 路那张图;
 *  · **前缀 dump** —— 真发出去的东西能变成一段可读文本(`docs\20` 末尾的警告:
 *    "看起来对"不算验过,要能看见模型到底看见了什么)。
 *
 * 不管(归别处):
 *  · 真发请求 → `src\llm.js`(刀一);存储 → 刀二后半(state.db 新表);
 *  · 拆句/颜文字保护**不做** —— 梦境输出 = 卡文风原样直出(docs\21 §十分立项)。
 *
 * ## 身份隔离(docs\21 §十四点之 2/4,切分的理由本身)
 *
 * 梦里的"当前角色"是**卡**,不是世界档那只 bot —— 本模块只认 `characters` 参数里给进来的卡,
 * 从头到尾**不 import** 世界档的任何人设/记忆。记忆串台的防线在存储分表(刀二后半),
 * 而这一层的防线是:世界档的东西根本进不了这里的输入。
 */

import { approxTokens } from './dream-cards.js';

/** 末尾 nudge 的措辞(B 路的"只以 X 身份回复",X 由锁人定死 —— docs\20 B 路示例)。 */
export function speakerNudge(speakerName) {
  return speakerName === NARRATOR_ID
    ? '[这一轮由旁白叙述:推进场景,描写环境与在场角色的动作神态,不以任何角色的第一人称发言]'
    : `[只以${speakerName}的身份回复:不要替其他角色或旁白说话]`;
}

/** 旁白在成员表里的固定 id(产品层叫"旁白",库里就是一条普通成员,docs\03 边界同族)。 */
export const NARRATOR_ID = '__narrator__';

// ---------------------------------------------------------------------------
// ① 世界书激活(纯函数,确定性:同一输入同一结果)
// ---------------------------------------------------------------------------

/**
 * 常驻条 = 每轮都发的那些(constant / disabled=false)。
 * 按 order 升序排(酒馆同族:order 小的先发)。
 */
export function constantEntries(entries) {
  return (entries || [])
    .filter((e) => e && e.constant === true && e.disabled !== true && e.content)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * 键控条激活:扫描文本里出现任一主键(或选择性键的次键全中)就算命中。
 *  · 大小写:entry.caseSensitive 为真才区分(默认忽略);
 *  · 概率:probability 为 null / >=100 才发 —— **不掷骰子**(docs\00:
 *    要稳定复现的行为不许靠随机;卡写了 <100 的概率,这一版宁可多发也不掷骰,
 *    骰子口径等用户拍板后再接)。
 *  · 扫描深度:默认扫「最近 4 条历史 + 用户这句」(scanDepth 有值则听卡的,酒馆同族)。
 * @returns {{hit: Array<object>, missed: number}}
 */
export function activateKeyedEntries(entries, history, userText) {
  const scanDefaults = 4;
  const list = (entries || []).filter((e) => e && e.constant !== true && e.disabled !== true && e.content);
  if (list.length === 0) return { hit: [], missed: 0 };
  // 每条可以有自己的扫描深度(酒馆 scan_depth);取「该条深度对应的最近 N 条」。
  const hit = [];
  let missed = 0;
  for (const entry of list) {
    const depth = Number.isFinite(entry.scanDepth) ? entry.scanDepth : scanDefaults;
    const recent = (history || []).slice(-Math.max(1, depth));
    const scanText = [
      ...recent.map((m) => (typeof m === 'string' ? m : m.content || '')),
      userText || '',
    ].join('\n');
    const haystack = entry.caseSensitive === true ? scanText : scanText.toLowerCase();
    const keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean) : [];
    if (keys.length === 0) { missed += 1; continue; }
    const primaryHit = keys.some((key) => containsKey(haystack, key, entry));
    // 选择性键(selective):主键中 + 次键至少一条也中,才发(酒馆 AND ANY 语义)。
    const secondary = Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys.filter(Boolean) : [];
    const secondaryOk = !entry.selective || secondary.length === 0
      || secondary.some((key) => containsKey(haystack, key, entry));
    const probabilityOk = entry.probability == null || entry.probability >= 100;
    if (primaryHit && secondaryOk && probabilityOk) hit.push(entry);
    else missed += 1;
  }
  hit.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return { hit, missed };
}

function containsKey(haystack, key, entry) {
  const needle = entry.caseSensitive === true ? String(key) : String(key).toLowerCase();
  if (needle === '') return false;
  if (entry.matchWholeWords === true) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:[^\\p{L}\\p{N}_]|$)`, 'u').test(haystack);
  }
  return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// ② 锁人路由(确定性;点名 = 独占)
// ---------------------------------------------------------------------------

/**
 * 这一轮谁说话:
 *  · 用户这句里**点名的角色独占**(名字出现在句里;同时点多个 = 句中先出现的那个);
 *  · 没点名 → 交给 `fallback`(默认旁白)。
 * `members` 形状:[{id, name}];名字匹配按「更长的名字优先」(「当前角色」vs「角色名的变体写法」不歧义)。
 * @returns {{speaker: {id, name}|null, reason: 'named'|'fallback'}}
 */
export function lockSpeaker(userText, members, { fallback = null } = {}) {
  const text = String(userText || '');
  if (text === '') return { speaker: fallback || null, reason: 'fallback' };
  const candidates = (members || [])
    .filter((m) => m && m.name && m.id !== NARRATOR_ID)
    .map((m) => ({ member: m, at: text.indexOf(m.name) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => (b.member.name.length - a.member.name.length) || (a.at - b.at));
  if (candidates.length === 0) return { speaker: fallback || null, reason: 'fallback' };
  return { speaker: candidates[0].member, reason: 'named' };
}

// ---------------------------------------------------------------------------
// ③ 组装器(仿酒馆;输出 = llm.js 直接能发的 messages)
// ---------------------------------------------------------------------------

/**
 * 把一轮拼成 messages。
 * @param {object} input
 * @param {Array<object>} input.worldEntries   世界书条目(dream-cards 归一形状;可空)
 * @param {Array<object>} input.characters     在场角色卡(normalizeCharacter 形状)
 * @param {Array<{role:'user'|'assistant', name?:string, content:string}>} input.history
 * @param {string} input.userText              用户这句
 * @param {{id:string,name:string}} input.speaker   锁人定下的这轮说话人
 * @param {string} [input.roomTitle]           房名(进常驻段,让模型知道在哪个场景)
 * @returns {{messages: Array<object>, activated: Array<number>, dump: string, tokens: number}}
 */
export function assembleTurn({ worldEntries = [], characters = [], history = [], userText = '', speaker, roomTitle = '' }) {
  if (!speaker || !speaker.name) throw new Error('assembleTurn: 必须先锁人(speaker)');
  const messages = [];
  const activatedEntries = pushSceneHead(messages, { worldEntries, characters, roomTitle });
  // 键控条要在**历史之后**激活(扫描深度看的是历史 + 用户这句)。
  const keyed = activateKeyedEntries(worldEntries, history, userText);

  // ③ 在场名单(锁人的"物理隔离"靠它说清楚:这轮只有 speaker 该开口)。
  const roster = [speaker.name, ...characters.map((c) => c.name).filter((n) => n !== speaker.name)];
  messages.push({
    role: 'system',
    content: `【在场】${[...new Set(roster)].join('、')}\n【这轮谁说话】${speaker.name}`,
  });

  // ④ 历史(只追加不重排 —— DeepSeek 前缀缓存的前提;assistant 带 name)。
  messages.push(...historyMessages(history));

  // ⑤ 键控条(at_depth 近似:插在历史之后、用户这句之前 —— 离注意力最近的位置)。
  for (const entry of keyed.hit) {
    messages.push({ role: 'system', content: entry.content });
  }

  // ⑥ 用户这句 + ⑦ 末尾 nudge(说话人由锁人定死)。
  messages.push({ role: 'user', content: userText });
  messages.push({ role: 'system', content: speakerNudge(speaker.name) });

  const tokens = approxTokens(messages.map((m) => m.content).join('\n'));
  return {
    messages,
    activated: [...activatedEntries.map((e) => e.uid), ...keyed.hit.map((e) => e.uid)],
    dump: dumpMessages(messages),
    tokens,
  };
}

/**
 * **场景头**(常驻世界书 + 在场角色卡)—— 组装器与续写/帮答共用的唯一一份(D159)。
 * 常驻条在前、卡按人一块(仿酒馆 before_char 语义)。
 */
function pushSceneHead(messages, { worldEntries, characters, roomTitle }) {
  const activatedEntries = constantEntries(worldEntries);
  const constantBlock = [
    roomTitle ? `【这个房间】${roomTitle}` : '',
    ...activatedEntries.map((e) => e.content),
  ].filter(Boolean).join('\n\n');
  if (constantBlock) messages.push({ role: 'system', content: constantBlock });

  // ② 在场角色卡(description/personality/scenario → 一人一块)。
  for (const card of characters) {
    const block = [
      `【角色:${card.name}】`,
      card.description || '',
      card.personality ? `性格:${card.personality}` : '',
      card.scenario ? `处境:${card.scenario}` : '',
    ].filter(Boolean).join('\n');
    if (block.trim() !== `【角色:${card.name}】`) messages.push({ role: 'system', content: block });
  }
  return activatedEntries;
}

/** 历史 → messages(只追加不重排;assistant 带 name —— 前缀缓存与 B 路那条形状)。 */
function historyMessages(history) {
  const out = [];
  for (const turn of history) {
    if (!turn || typeof turn.content !== 'string' || turn.content === '') continue;
    if (turn.role === 'assistant') {
      out.push({ role: 'assistant', content: turn.content, name: turn.name || undefined });
    } else {
      out.push({ role: 'user', content: turn.name ? `${turn.name}:${turn.content}` : turn.content });
    }
  }
  return out;
}

/**
 * **续写**(2026-10-19 / D269:输入行「更多功能」第四颗键)。
 *
 * 语义 = "从最后一句的断处接着写",不是重新回一句。所以:
 *  · 历史**包含**最后那条 assistant(要续的那半句);
 *  · 末尾仍走同一份锁人 nudge(只以这位说话人的身份续,不许抢别人的话);
 *  · 最后追加一句"接着写"的 user 指令(模型只有看到指令才知道这不是新提问)。
 * ⚠️ 不复述、不重写 —— 客户端把返回的续写直接接在原文后面(拼接口径在 service 层一处)。
 */
export const CONTINUE_PROMPT = '（接着上面最后那句话继续写下去，从断开处续，不要复述、不要重写已经写过的内容。）';
export function assembleContinue({ worldEntries = [], characters = [], history = [], speaker, roomTitle = '' }) {
  if (!speaker || !speaker.name) throw new Error('assembleContinue: 必须先定下续写人(speaker)');
  return assembleTurn({ worldEntries, characters, history, userText: CONTINUE_PROMPT, speaker, roomTitle });
}

/** 帮答的末尾指令(只出一句玩家自己的话;不是角色扮演、不是旁白)。 */
export const SUGGEST_INSTRUCTION = [
  '【任务】只写玩家此刻接下来会说的话或会做的动作,用第一人称,像玩家自己打的字。',
  '不要替在场角色说话、不要旁白、不要解释,不要加引号、"玩家:"这类前缀;只输出这一句本身。',
].join('\n');

/**
 * **AI 帮答**(2026-10-19 / D269:输入行「更多功能」第三颗键)。
 *
 * 给"玩家下一句"起个草稿(塞进输入框给人改,不发送),所以:
 *  · 场景头(常驻世界书 + 在场角色卡)与 assembleTurn **共用同一份**(D159);
 *  · 历史照旧只追加不重排;
 *  · 末尾是**玩家侧**的指令,而不是锁人 nudge —— 这一层绝不冒充角色说话。
 * @returns {{messages: Array<object>, activated: Array<number>, dump: string, tokens: number}}
 */
export function assembleSuggest({ worldEntries = [], characters = [], history = [], roomTitle = '' }) {
  const messages = [];
  const activatedEntries = pushSceneHead(messages, { worldEntries, characters, roomTitle });
  const names = characters.map((c) => c.name).filter(Boolean);
  if (names.length) messages.push({ role: 'system', content: `【在场】${[...new Set(names)].join('、')}` });
  messages.push(...historyMessages(history));
  // 键控条按历史激活(帮答没有"用户这句",扫描文本就是历史本身)。
  const keyed = activateKeyedEntries(worldEntries, history, '');
  for (const entry of keyed.hit) messages.push({ role: 'system', content: entry.content });
  messages.push({ role: 'system', content: SUGGEST_INSTRUCTION });
  messages.push({ role: 'user', content: '写一句玩家接下来会说的话。' });
  const tokens = approxTokens(messages.map((m) => m.content).join('\n'));
  return {
    messages,
    activated: [...activatedEntries.map((e) => e.uid), ...keyed.hit.map((e) => e.uid)],
    dump: dumpMessages(messages),
    tokens,
  };
}

/**
 * 前缀 dump:把真发出去的 messages 变成可读文本(docs\20:"A 路要特意做"的那件事,
 * B 路天然有 —— 这里把它落成判据能对账的字符串)。
 */
export function dumpMessages(messages) {
  return (messages || [])
    .map((m) => {
      const who = m.role === 'assistant' ? `assistant(${m.name || '?'})` : m.role;
      return `--- ${who} ---\n${m.content}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// ④ 一轮的调度计划(锁人 + 旁白:一次用户发言 = N+1 次调用,计费打包的依据)
// ---------------------------------------------------------------------------

/**
 * 计划一轮:用户说话后,要打哪几次模型。
 * 现行口径(docs\21 §十三项拍板之 1):一次用户发言 = 说话人 1 次 + 旁白 1 次(打包计一轮)。
 * @returns {Array<{speaker:{id,name}, reason:string}>} 依次调用的说话人清单
 */
export function planTurnCalls(userText, members) {
  const roster = (members || []).filter((m) => m && m.id !== NARRATOR_ID);
  const narrator = (members || []).find((m) => m && m.id === NARRATOR_ID) || { id: NARRATOR_ID, name: '旁白' };
  const { speaker, reason } = lockSpeaker(userText, roster, { fallback: roster[0] || null });
  const calls = [];
  if (speaker) calls.push({ speaker, reason });
  calls.push({ speaker: narrator, reason: 'narrator' });
  return calls;
}
