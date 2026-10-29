/**
 * **刀二后半 · 梦境服务层**(2026-10-13,D227;docs\21 §十"梦境档 born free")。
 *
 * ## 它把三件事拼成一次用户发言
 *
 *   锁人+组装(dream-engine) → 打模型(llm.js) → 落历史+usage(dream-store)。
 *   一次用户发言 = planTurnCalls 给出的 N 次调用(现行口径:说话人 + 旁白),
 *   计费打包算一轮 —— 记账走 credits.recordTurn(免费额度内不扣,超额才扣;
 *   **在定价拍板之前,梦境这一刀先不接闸门**,只有 usage 落在 meta 里照记)。
 *
 * ## 边界
 *
 *  · **卡解析是注入的**(`resolveCard(cardId)`):这一层不碰文件系统、不碰卡库索引 ——
 *    面板装配时把"按 id 取归一卡"的真实现传进来,单测用假解析器。返回形状 =
 *    `{ character, book }`(dream-cards 的归一产物,book 可空)。
 *  · **模型客户端也是注入的**(llm.js 的 `chat`) —— 单测打假客户端,真 key 只在探针。
 */

import {
  NARRATOR_ID,
  assembleContinue,
  assembleSuggest,
  assembleTurn,
  planTurnCalls,
} from './dream-engine.js';

/**
 * **manifest v2 形状**(1.130.0 / D227 追加三,用户拍板"主世界卡 + 次世界卡"):
 *
 *     { mainWorldCardId, ruleCardIds[], charCardIds[], narrator, version }
 *
 *  · 主卡 = **单张**(可空;首次创建时选);
 *  · 次卡(规则类世界书)= **数组**(房内详情里热增删);
 *  · 旧字段 `worldCardId` **读取时兼容**(当作主卡),**写一律新形状**。
 *    兼容只留这一处纯函数 —— 别的地方不许再写 `manifest.worldCardId`(D159)。
 * @returns {{mainWorldCardId: string|null, ruleCardIds: string[], charCardIds: string[], narrator: boolean, version: number}}
 */
export function normalizeManifest(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const main = m.mainWorldCardId ?? m.worldCardId ?? null;
  const listOf = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  return {
    mainWorldCardId: main ? String(main) : null,
    ruleCardIds: listOf(m.ruleCardIds),
    charCardIds: listOf(m.charCardIds),
    narrator: m.narrator !== false,
    version: Number(m.version) || 0,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.dreams createDreamStore 的产物
 * @param {{chat: Function}} deps.llm createLlmClient 的产物(或同形状的假件)
 * @param {(cardId: string) => Promise<{character: object|null, book: object|null}>} deps.resolveCard
 * @param {Console} [deps.log]
 */
export function createDreamService({ dreams, llm, resolveCard, log = console } = {}) {
  if (!dreams || !llm || typeof resolveCard !== 'function') {
    throw new Error('createDreamService: dreams / llm / resolveCard 必填');
  }

  /**
   * 开一间房(manifest 引卡库 id;成员含旁白)。
   * @param {{title:string, mainWorldCardId?:string|null, ruleCardIds?:string[],
   *          charCardIds:string[], createdBy?:string|null,
   *          nameOf?: (cardId:string) => string}} input
   * `mainWorldCardId` = 主世界卡(单张,首次创建时选,可空);
   * `ruleCardIds` = 次世界卡(规则类,可空数组)。兼容旧调用给的 `worldCardId`(当主卡)。
   * `nameOf` 缺省用"卡:前缀剥掉"的 id 尾段当房内名;真名在装配层由卡库解析后传进来。
   */
  async function createRoom({ title, mainWorldCardId = undefined, ruleCardIds = [], charCardIds = [], worldCardId = undefined, createdBy = null, nameOf = defaultNameOf }) {
    if (!Array.isArray(charCardIds) || charCardIds.length === 0) {
      throw new Error('dream 房至少要一名角色');
    }
    const members = [];
    for (const cardId of charCardIds) {
      // 房内显示名用卡的真名;解析不出来才退到 id 尾段(开房当场就知道卡坏没坏)。
      const resolved = await resolveCard(cardId).catch(() => null);
      members.push({
        memberId: `char:${cardId}`,
        name: resolved?.character?.name || nameOf(cardId),
        cardId,
        kind: 'char',
      });
    }
    members.push({ memberId: NARRATOR_ID, name: '旁白', cardId: null, kind: 'narrator' });
    // ⚠️ 写**一律 v2 新形状**(旧字段只在读取时兼容,见 normalizeManifest)。
    const main = mainWorldCardId !== undefined ? mainWorldCardId : (worldCardId ?? null);
    const manifest = {
      mainWorldCardId: main ? String(main) : null,
      ruleCardIds: [...(Array.isArray(ruleCardIds) ? ruleCardIds : [])].map(String).filter(Boolean),
      charCardIds: [...charCardIds],
      narrator: true,
      version: 2,
    };
    const room = dreams.createRoom({ title, manifest, createdBy, members });
    log.info?.(`[dream] 建房 ${room.id}「${title}」:${members.length} 名成员(含旁白)`);
    return room;
  }

  /** 一张世界卡/世界书 → 归一条目数组(resolveCard 的两种落点都收)。 */
  async function entriesOf(cardId) {
    if (!cardId) return [];
    const resolved = await resolveCard(cardId).catch(() => null);
    return resolved?.book?.entries ?? resolved?.character?.book?.entries ?? [];
  }

  /** manifest + 成员 → 本轮要看得见的〔角色卡数组 + 世界书条目〕。 */
  async function loadScene(room) {
    const manifest = normalizeManifest(room.manifest);
    const characters = [];
    for (const cardId of manifest.charCardIds) {
      const resolved = await resolveCard(cardId);
      if (resolved?.character) characters.push(resolved.character);
    }
    // **主卡在前 + 所有次卡**直接 concat(normalizeBook 已归一形状,主卡条目优先撞车时赢)。
    let worldEntries = [];
    if (manifest.mainWorldCardId) worldEntries = worldEntries.concat(await entriesOf(manifest.mainWorldCardId));
    for (const ruleId of manifest.ruleCardIds) {
      if (ruleId === manifest.mainWorldCardId) continue;
      worldEntries = worldEntries.concat(await entriesOf(ruleId));
    }
    return { characters, worldEntries };
  }

  /**
   * **热更改世界卡**(1.130.0 / D227 追加三;房内详情里换主/次卡)。
   *
   * 校验:主卡至多一张(形状天然保证 —— 单值),**卡 id 必须能解析出来**(非法 id 抛错,
   * 服务端翻成 400)。改完 `updateManifest` 落盘,下一轮 playTurn 生效。
   * @param {string} roomId
   * @param {{mainWorldCardId?: string|null, ruleCardIds?: string[]}} patch
   */
  async function setWorldCards(roomId, { mainWorldCardId = undefined, ruleCardIds = undefined } = {}) {
    const room = dreams.getRoom(roomId);
    if (!room) throw new Error(`dream 房不存在:${roomId}`);
    const current = normalizeManifest(room.manifest);
    const main = mainWorldCardId !== undefined ? mainWorldCardId : current.mainWorldCardId;
    const rules = ruleCardIds !== undefined
      ? [...(Array.isArray(ruleCardIds) ? ruleCardIds : [])].map(String).filter(Boolean)
      : current.ruleCardIds;
    if (main) {
      const resolved = await resolveCard(String(main)).catch(() => null);
      if (!resolved || (!resolved.character && !resolved.book)) {
        throw new Error(`dream:主世界卡认不出:${main}`);
      }
    }
    for (const ruleId of rules) {
      const resolved = await resolveCard(ruleId).catch(() => null);
      if (!resolved || (!resolved.character && !resolved.book)) {
        throw new Error(`dream:次世界卡认不出:${ruleId}`);
      }
    }
    return dreams.updateManifest(roomId, {
      mainWorldCardId: main ? String(main) : null,
      ruleCardIds: [...new Set(rules)],
    });
  }

  /**
   * **一轮调用的公共内核**(2026-10-19 / D269 抽出):按 plan 逐个说话人组装 → 打模型 → 落库。
   * `playTurn`(新发言)与 `regenerateTurn`(重新生成)共用这一份 —— 只差"用户那句要不要先落库"。
   * @param {object} input
   * @param {object} input.room
   * @param {string} input.text                 这一轮用户那句(已落库/或从历史里取回)
   * @param {Array<object>} input.historyBefore 这句**之前**的历史
   * @param {Array<{speaker:{id,name},reason:string}>} input.plan planTurnCalls 的产物
   */
  async function runCalls({ room, text, historyBefore, plan, onDelta = null, signal = undefined, llm: llmOverride = null }) {
    const activeLlm = llmOverride ?? llm;
    const { characters, worldEntries } = await loadScene(room);
    const replies = [];
    let speakerSeq = 0;   // 流式事件的序号:按"说话人次序"单调递增(空回复跳过也不复用)
    const usageSum = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0 };
    // 逐个说话人打:前一位的回复立刻进下一位看得见的历史(同轮接得上话)。
    const runningHistory = [...historyBefore];
    for (const call of plan) {
      const assembled = assembleTurn({
        worldEntries,
        characters,
        history: runningHistory,
        userText: text,
        speaker: call.speaker,
        roomTitle: room.title,
      });
      // 流式 vs 非流式(2026-10-17 / D241):给了 onDelta 且客户端支持 chatStream 才走流;
      // 注入的假 LLM(测试/探针)没有 chatStream 时自动回落 chat() —— 行为兜底,不逼着改夹具。
      const canStream = Boolean(onDelta) && typeof activeLlm.chatStream === 'function';
      const speakerIndex = speakerSeq;
      speakerSeq += 1;
      let result;
      if (canStream) {
        // 占位标记(delta 为空串):客户端据此先画出"她要说话了"的空泡(D226 拍板 B)。
        onDelta({ kind: 'reply_start', index: speakerIndex, name: call.speaker.name, delta: '', full: '' });
        result = await activeLlm.chatStream(assembled.messages, { signal }, (delta, full) => {
          onDelta({ kind: 'delta', index: speakerIndex, name: call.speaker.name, delta, full });
        });
      } else {
        result = await activeLlm.chat(assembled.messages, { signal });
      }
      const replyText = (result.text ?? '').trim();
      if (replyText === '') {
        log.warn?.(`[dream] ${call.speaker.name} 这轮空回复,跳过落库`);
        continue;
      }
      dreams.appendMsg({
        roomId: room.id,
        role: 'assistant',
        name: call.speaker.name,
        content: replyText,
        meta: {
          usage: result.usage ?? null,
          model: result.model ?? null,
          activated: assembled.activated,
          reason: call.reason,
        },
      });
      runningHistory.push({ role: 'assistant', name: call.speaker.name, content: replyText });
      replies.push({ name: call.speaker.name, text: replyText, usage: result.usage ?? null });
      if (result.usage) {
        usageSum.calls += 1;
        usageSum.promptTokens += result.usage.promptTokens ?? 0;
        usageSum.completionTokens += result.usage.completionTokens ?? 0;
        usageSum.cacheHitTokens += result.usage.cacheHitTokens ?? 0;
        usageSum.totalTokens += result.usage.totalTokens ?? 0;
      }
    }
    return { speaker: plan[0]?.speaker?.name ?? null, replies, usage: usageSum };
  }

  /**
   * 玩一轮:锁人 → 逐个说话人组装+打模型+落历史 → 回复清单。
   * @param {{roomId:string, userText:string, playerName?:string,
   *          onDelta?: (piece: {index:number, name:string, delta:string, full:string}) => void,
   *          signal?: AbortSignal}} input
   *   ⚠️ `onDelta`(2026-10-17 / D241 流式):给了它就走 `llm.chatStream`,每个增量回调一次
   *      (`delta`=这块新字,`full`=这位说话人到目前为止的全文);**不传则走旧的 `chat()`,
   *      行为一字不变**(旧 /say 那条路的口径)。`signal` 只在流式路生效(客户端断开就掐)。
   * @returns {Promise<{speaker:string|null, replies:Array<{name:string, text:string, usage:object|null}>, usage:object}>}
   */
  async function playTurn({ roomId, userText, playerName = '你', onDelta = null, signal = undefined, llm: llmOverride = null }) {
    const room = dreams.getRoom(roomId);
    if (!room) throw new Error(`dream 房不存在:${roomId}`);
    const text = String(userText ?? '').trim();
    if (text === '') throw new Error('dream:用户这句不能是空的');

    // 锁人的候选 = 角色成员(旁白不参选,planTurnCalls 自己兜)。
    const memberRows = dreams.listMembers(roomId).map((m) => ({ id: m.id, name: m.name }));
    const historyBefore = dreams.history(roomId).map((m) => ({
      role: m.role,
      name: m.name ?? undefined,
      content: m.content,
    }));
    dreams.appendMsg({ roomId, role: 'user', name: playerName, content: text });

    const plan = planTurnCalls(text, memberRows);
    return runCalls({ room, text, historyBefore, plan, onDelta, signal, llm: llmOverride });
  }

  /**
   * **重新生成**(2026-10-19 / D269:输入行「更多功能」第二颗键)。
   *
   * 语义 = 把最后一句用户发言**之后**的旧回复清掉、拿同一句重新走一遍。
   *  · 用户那句**不重写**(它就是历史事实,重写会变成两句);
   *  · 只删尾部(`deleteMsgsAfter`)—— 历史主体 append-only 没变;
   *  · 没有最后一句用户发言(空房 / 只有欢迎语)当场拒。
   * @returns {Promise<{speaker:string|null, replies:Array<object>, usage:object, removed:number}>}
   */
  async function regenerateTurn({ roomId, onDelta = null, signal = undefined, llm: llmOverride = null }) {
    const room = dreams.getRoom(roomId);
    if (!room) throw new Error(`dream 房不存在:${roomId}`);
    const all = dreams.history(roomId, { limit: 0 });
    let lastUserIndex = -1;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].role === 'user') { lastUserIndex = i; break; }
    }
    if (lastUserIndex < 0) throw new Error('dream:还没有可以重新生成的那一句');
    const userRow = all[lastUserIndex];
    const removed = lastUserIndex < all.length - 1 ? dreams.deleteMsgsAfter(roomId, userRow.id) : 0;
    const historyBefore = all.slice(0, lastUserIndex).map((m) => ({
      role: m.role,
      name: m.name ?? undefined,
      content: m.content,
    }));
    const memberRows = dreams.listMembers(roomId).map((m) => ({ id: m.id, name: m.name }));
    const plan = planTurnCalls(userRow.content, memberRows);
    const out = await runCalls({ room, text: userRow.content, historyBefore, plan, onDelta, signal, llm: llmOverride });
    return { ...out, removed };
  }

  /**
   * **续写**(2026-10-19 / D269:输入行「更多功能」第四颗键)。
   *
   * 语义 = 从最后一条 assistant 的断处接着写(**同一句话变长**,不是新开一条)。
   *  · 只续"她/旁白说的最后一句";最后一条是用户发言 → 让人先等她回一句(拒);
   *  · 续写内容接在原文后面(`joinContinuation` 唯一一处拼接口径);
   *  · usage 与原文的 usage **合并**(同一行两次调用都要能被 `roomUsage` 数到)。
   * @returns {Promise<{speaker:string|null, replies:Array<object>, usage:object, base:string, full:string}>}
   */
  async function continueTurn({ roomId, onDelta = null, signal = undefined, llm: llmOverride = null }) {
    const room = dreams.getRoom(roomId);
    if (!room) throw new Error(`dream 房不存在:${roomId}`);
    const last = dreams.lastMsg(roomId);
    if (!last) throw new Error('dream:还没有可以续写的内容');
    if (last.role !== 'assistant') throw new Error('dream:最后一条不是她(或旁白)说的话,先等她回一句再续写');

    const activeLlm = llmOverride ?? llm;
    const { characters, worldEntries } = await loadScene(room);
    const history = dreams.history(roomId, { limit: 0 }).map((m) => ({
      role: m.role,
      name: m.name ?? undefined,
      content: m.content,
    }));
    const speaker = {
      id: last.name === '旁白' ? NARRATOR_ID : String(last.name || NARRATOR_ID),
      name: String(last.name || '旁白'),
    };
    const assembled = assembleContinue({
      worldEntries, characters, history, speaker, roomTitle: room.title,
    });
    const canStream = Boolean(onDelta) && typeof activeLlm.chatStream === 'function';
    let result;
    if (canStream) {
      onDelta({ kind: 'reply_start', index: 0, name: speaker.name, delta: '', full: '' });
      result = await activeLlm.chatStream(assembled.messages, { signal }, (delta, full) => {
        onDelta({ kind: 'delta', index: 0, name: speaker.name, delta, full });
      });
    } else {
      result = await activeLlm.chat(assembled.messages, { signal });
    }
    const replyText = String(result.text ?? '').trim();
    if (replyText === '') throw new Error('dream:这次续写没有内容');
    const full = joinContinuation(last.content, replyText);
    const usage = mergeUsage(last.meta?.usage, result.usage ?? null);
    dreams.updateLastMsg(roomId, {
      content: full,
      meta: {
        ...(last.meta ?? {}),
        usage,
        model: result.model ?? last.meta?.model ?? null,
        continued: true,
      },
    });
    const usageSum = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0 };
    if (result.usage) {
      usageSum.calls = 1;
      usageSum.promptTokens = result.usage.promptTokens ?? 0;
      usageSum.completionTokens = result.usage.completionTokens ?? 0;
      usageSum.cacheHitTokens = result.usage.cacheHitTokens ?? 0;
      usageSum.totalTokens = result.usage.totalTokens ?? 0;
    }
    return { speaker: speaker.name, replies: [{ name: speaker.name, text: replyText }], usage: usageSum, base: last.content, full };
  }

  /**
   * **AI 帮答**(2026-10-19 / D269:输入行「更多功能」第三颗键)。
   *
   * 给玩家下一句起个草稿 —— **只回文本,不落库、不发送**;页面把它塞进输入框让人改。
   * ⚠️ 记账盲区如实记:这次调用没有消息行可挂 usage(不写进 dream_msg.meta),
   *    只在日志留一行;不把它当成"没花钱"。
   * @returns {Promise<{text:string, usage:object|null}>}
   */
  async function suggestTurn({ roomId, llm: llmOverride = null } = {}) {
    const room = dreams.getRoom(roomId);
    if (!room) throw new Error(`dream 房不存在:${roomId}`);
    const activeLlm = llmOverride ?? llm;
    const { characters, worldEntries } = await loadScene(room);
    const history = dreams.history(roomId).map((m) => ({
      role: m.role,
      name: m.name ?? undefined,
      content: m.content,
    }));
    const assembled = assembleSuggest({ worldEntries, characters, history, roomTitle: room.title });
    const result = await activeLlm.chat(assembled.messages);
    const text = String(result.text ?? '').trim().slice(0, 2000);
    if (text === '') throw new Error('dream:这次帮答没有内容');
    if (result.usage) log.info?.(`[dream] 帮答 usage=${JSON.stringify(result.usage)}`);
    return { text, usage: result.usage ?? null };
  }

  /**
   * **删除最后一条消息**(2026-10-19 / D269:输入行「更多功能」第一颗键)。
   * 只动尾部;房内没有消息时抛错(路由层翻成 400)。
   * @returns {object} 被删掉的那一条
   */
  function deleteLastMessage(roomId) {
    const room = dreams.getRoom(roomId);
    if (!room) throw new Error(`dream 房不存在:${roomId}`);
    const deleted = dreams.deleteLastMsg(roomId);
    if (!deleted) throw new Error('dream:没有可删的消息');
    return deleted;
  }

  return {
    createRoom, playTurn, loadScene, setWorldCards, normalizeManifest,
    regenerateTurn, continueTurn, suggestTurn, deleteLastMessage,
  };
}

/** 续写拼接:中文直接接;英文/数字边界补一个空格,避免粘成一个词(D269)。 */
function joinContinuation(base, extra) {
  const tail = String(base ?? '');
  const add = String(extra ?? '').trim();
  if (!add) return tail;
  if (!tail) return add;
  const needSpace = /[A-Za-z0-9]$/.test(tail) && /^[A-Za-z0-9]/.test(add);
  return tail + (needSpace ? ' ' : '') + add;
}

/**
 * 两次调用的 usage 合并(续写把同一行的话续长了 —— 那一行的账要合计两次)。
 * `calls` 用来让 roomUsage 数对次数(playTurn 落的原始 usage 没有这个字段时按 1 算)。
 */
function mergeUsage(a, b) {
  if (!a && !b) return null;
  const out = {
    calls: (a ? (Number(a.calls) || 1) : 0) + (b ? (Number(b.calls) || 1) : 0),
    promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0,
  };
  for (const key of ['promptTokens', 'completionTokens', 'cacheHitTokens', 'totalTokens']) {
    out[key] = (Number(a?.[key]) || 0) + (Number(b?.[key]) || 0);
  }
  return out;
}


function defaultNameOf(cardId) {
  const tail = String(cardId ?? '').split(':').pop() ?? cardId;
  return tail;
}
