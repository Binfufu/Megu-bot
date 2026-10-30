/**
 * **刀三A · 自有引擎**(2026-10-14,`docs\21` §十二;runner 契约 = `makeOfflineRunner` 文档里那份)。
 *
 * ## 这一层管什么、不管什么
 *
 * 管:
 *  · **runner 契约**:`initialize / runTurn(key, text, timeoutMs, imageBlocks) / isBusy /
 *    sessionIdFor / resetConversation / stop / on` —— 与 DshRunner 同形状,换引擎不动调用方;
 *  · **组装**(ASSEMBLY_ORDER,刀二A):稳定块(人设)→ 摘要区 → 逐字历史 → 本轮;
 *    **一切注入块必须经 `wrapInject`**(刀二C 硬规矩,不许裸注入);
 *  · **预算裁剪**:水位超线按 planCompaction(迟滞)+ splitHistory 切,gap-aware 收窄(刀二A);
 *  · **压缩摘要**:超线时用 `SUMMARY_PROMPT` 经**同一个 llm 客户端**压(一份,D159);
 *  · **历史落库**:conversation_turn 表(append-only,刀二B);**usage 落 meta**(g1);
 *  · **人设进桥**:启动(`initialize`)/换代(`resetConversation`)时读工作区 `AGENTS.md`
 *    —— 热更语义与 DSH 一致(g7:进程内一份,换代才重读);
 *  · **贡献者骨架**(§九):`turnContributors` 一行注册,输出自动包 wrapInject。
 *
 * 不管:
 *  · 开关/影子模式(刀三B `QQBOT_ENGINE=own|dsh|shadow`);
 *  · QQ 收发、拆句、记忆归档(全在桥既有层,不因引擎换而动)。
 *
 * ## 空响应口径(g8)
 *
 * 模型回空正文/纯空白 → 返回 `SILENT_TOKEN`(`[跳过]`),与离线替身/模型真跳过**同一条**代码路径
 * —— 不假装成功,也不发空消息。user 轮照落库(用户确实说了),assistant 轮不落(她没说)。
 *
 * ## 「只在冷时动前缀」的落地口径(§十三C)
 *
 * 摘要区改写 = 结构性动前缀,**冷热都允许但受迟滞约束**(迟滞防的是阈值附近反复压);
 * gap-aware 仅决定成功压缩后保留多少原文；未触发/压缩失败绝不提前裁剪。
 * 摘要与覆盖游标持久化，读侧仅取游标之后的原文；表里旧原文保持 append-only。
 */

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { SILENT_TOKEN } from './group-context.js';
import { describeTurnEnd, sanitizeSessionId } from './runner-contract.js';
import { approxTokens } from './dream-cards.js';
import {
  ASSEMBLY_ORDER,
  SUMMARY_PROMPT,
  budgetFor,
  keepForGap,
  planCompaction,
  splitHistory,
} from './context-budget.js';
import { wrapInject } from './inject-mark.js';
import { CHAT_INPUT_PROJECTION_VERSION, projectChatInput } from './chat-input-projection.js';
import { normalizeLlmImages } from './llm.js';
// P3-b 工具循环(P3-a 纯层):引擎只管循环,权限口径在 capabilities 层。
import { budgetExhaustedText, buildAssistantMessage, buildToolResultMessages, nextLoopAction } from './tool-loop.js';
import { executeAuthorized } from './capabilities.js';

/**
 * 把模型的 `finish_reason` 翻成桥的**回合结束原因**(2026-10-15,并行审查 F6)。
 *
 * 为什么要有它:`src\llm.js` 一直在带出 `finishReason`,而 own 引擎**全程不用**、
 * 恒返回 `{kind:'completed'}`。消费端 `composeReply` 靠 `describeTurnEnd(result.reason)`
 * 给用户补「（回复达到输出长度上限，已被截断）」—— 于是**同一个人两副面孔**:
 * DSH 路截断了会说一声,own 路戛然而止、一个字都不说。
 * 现在两边同口径(`describeTurnEnd` 是那份唯一口径,D159),
 * 而 `max-tokens` 这一支的**文案**在 `runner-contract.js` —— 这里只翻 kind,不写字。
 *
 * 📌 **判据钉在"消费端看得见"上**:只断言 kind 不够,必须让 `describeTurnEnd(reason)`
 *    真的吐出那句截断提示(`docs\21` 的"消费端取证"口径)。
 * `finish_reason` 就是 OpenAI 兼容那套字面量;认不出的原样当成 `completed`(不猜)。
 */
export function reasonForFinish(finishReason) {
  return finishReason === 'length' ? { kind: 'max-tokens' } : { kind: 'completed' };
}

/**
 * 上下文状态里 `compactionCalls` 最多留几条(2026-10-15,并行审查 F8)。
 *
 * **为什么要有上限**:它是**唯一一个无上限的持久结构** —— 每次成功压缩往数组里 push 一条,
 * 整个数组随 `saveState` 落进 meta 行,而 meta 行每次 `stateFor` 都要整行解析。
 * 量级不大(每条百来字节),但常驻会话几年下来是**单调膨胀**,与 D135"前缀无界增长"同族。
 *
 * **为什么留 50 而不是"聚合成计数器"**:usage 明细**已经有** `own_llm_call` / `own_llm_attempt`
 * 两张表(1.150.19/D159"不需要第二份明细")—— 这里只是**排障现场**(哪一代、压到哪一轮、
 * 第几层),50 条足够回答"刚才那次压缩长什么样"。真账去查表,不靠这个数组。
 */
export const COMPACTION_CALLS_KEPT = 50;

/** 追加一条压缩记录,只留最近 `COMPACTION_CALLS_KEPT` 条(写入侧唯一入口,D159)。 */
export function rememberCompactionCall(list, entry) {
  return [...(Array.isArray(list) ? list : []), entry].slice(-COMPACTION_CALLS_KEPT);
}

/** 读人设文件(启动/换代两次读之间,进程内一份 —— g7 热更语义)。 */
function readPersona(personaPath) {
  const text = fs.readFileSync(personaPath, 'utf8');
  if (text.trim() === '') throw new Error(`engine: 人设文件是空的(${personaPath})`);
  return text;
}

/**
 * 造自有引擎。
 *
 * @param {{llm: {chat: Function}, store: object, personaPath: string,
 *          scene?: string, budget?: object, timeoutMs?: number,
 *          turnContributors?: Array<{kind: string, render: (ctx: object) => string|null}>,
 *          log?: Console, now?: () => number}} options
 *   · `llm`:`createLlmClient` 的产物或同形状假件(单测注假件,真 key 只在探针);
 *   · `store`:带 `appendConversationTurn`/`conversationTurns` 的状态库(刀二B);
 *   · `budget`:测试/按 bot 覆盖用;默认 `budgetFor(scene)`,认不出返回 null = 不进压缩管线。
 */
import { validateLlmRequestOptions } from './llm.js';

/** T1-C(2026-10-29):own 持久摘要的装配规则版本 —— 升级时旧摘要读时停用、原档重建(见 stateFor)。 */
const OWN_SUMMARY_POLICY_V = CHAT_INPUT_PROJECTION_VERSION;

export function createOwnEngine(options) {
  const {
    llm,
    store,
    personaPath,
    scene = 'world',
    budget = budgetFor(scene),
    timeoutMs = 120_000,
    inputTokenLimit = null,
    estimateInputTokens = null,
    turnContributors = [],
    handoff = null,
    handoffAttempts = 3,
    requestOptions = {},
    log = console,
    now = Date.now,
  } = options || {};
  validateLlmRequestOptions(requestOptions);
  if (Object.keys(requestOptions).some(key => !['reasoningEffort', 'maxTokens'].includes(key))) throw new Error('unsupported engine requestOptions field');
  const sampling = Object.freeze({ ...requestOptions });
  if (!llm || typeof llm.chat !== 'function') throw new Error('createOwnEngine: llm.chat 必填');
  if (!store || typeof store.appendConversationTurn !== 'function') throw new Error('createOwnEngine: store(刀二B)必填');
  if (typeof store.getMeta !== 'function' || typeof store.setMeta !== 'function') {
    throw new Error('createOwnEngine: store must persist context metadata');
  }
  if (!personaPath) throw new Error('createOwnEngine: personaPath 必填(人设进桥,缺口三)');
  if (handoff !== null && handoff !== undefined && typeof handoff !== 'function') throw new Error('handoff must be a function or null');
  if (!Number.isSafeInteger(handoffAttempts) || handoffAttempts <= 0) throw new Error('handoffAttempts must be a positive integer');
  /**
   * 首次 own 历史引导:复用桥的记忆提供者。
   *
   * ⚠️ **失败语义**(2026-10-15 主人拍板,并行审查 F3):**先重试,重试到成功再说话;
   *    超过 `handoffAttempts`(主人定的 3)次还不成功,才降级成 DSH 那套
   *    「大声 warn + 这一轮不带旧记忆照常回话」** —— 既不假装有记忆,也不让她凭空沉默。
   *    · 取消/超时**不重试**(那是这一趟被掐了,不是交接本身坏了),立刻按取消处理;
   *    · 返回值形状不对是**代码错**、重试也修不好,当场抛(不浪费三次调用)。
   */
  async function initialHandoff(key, signal) {
    signal.throwIfAborted();
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      for (let attempt = 1; attempt <= handoffAttempts; attempt += 1) {
        try {
          const block = await Promise.race([Promise.resolve().then(() => {
            signal.throwIfAborted(); return handoff(key);
          }), cancelled]);
          signal.throwIfAborted();
          if (block !== null && block !== undefined && typeof block !== 'string') throw new Error('handoff must return a string or null');
          return block || '';
        } catch (err) {
          if (signal.aborted) throw signal.reason ?? err;
          if (err?.message === 'handoff must return a string or null') throw err;
          if (attempt >= handoffAttempts) {
            log.warn?.(`[engine] 记忆交接失败(已试 ${attempt} 次),这一轮不带旧记忆、照常回话: ${err?.message ?? err}`);
            return '';
          }
          log.warn?.(`[engine] 记忆交接失败(第 ${attempt}/${handoffAttempts} 次,重试): ${err?.message ?? err}`);
        }
      }
      return '';
    } finally { signal.removeEventListener('abort', abort); }
  }
  if (inputTokenLimit !== null && (!Number.isSafeInteger(inputTokenLimit) || inputTokenLimit <= 0)) {
    throw new Error('inputTokenLimit must be a positive integer or null');
  }
  function checkInputCapacity(messages) {
    if (inputTokenLimit === null) return;
    const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url'));
    const tokens = estimateInputTokens ? estimateInputTokens(messages) :
      (hasImages ? null : messages.reduce((sum, message) => sum + approxTokens(message.content), 0));
    if (!Number.isFinite(tokens) || tokens < 0 || tokens > inputTokenLimit) {
      const error = new Error(tokens == null ? 'input capacity unknown for image request' : 'input capacity exceeded');
      error.code = 'OWN_INPUT_CAPACITY'; throw error;
    }
  }

  const emitter = new EventEmitter();
  let persona = ''; // g7:initialize/resetConversation 时读,平时进程内一份
  const state = new Map();
  let stopped = false;
  let stopping;
  const active = new Set();
  // Race even injected clients that ignore AbortSignal. Late responses cannot commit history.
  async function cancellableChat(messages, callOptions, key, kind, client = llm) {
    const { signal } = callOptions;
    signal.throwIfAborted();
    if (kind === 'summary') checkInputCapacity(messages);
    const callId = store.startOwnLlmCall({ key, kind, at: now() });
    let abort;
    const attempts = new Set();
    let callClosed = false;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        signal.throwIfAborted();
        // ⚠️ P3-b:`client` = 整轮快照(scoped.snapshot())——工具循环的多次子调用
        //    钉死同一个 client,中途热换模型只影响**下一轮**(不许半轮跨协议)。
        //    缺省 = 旧调用方行为的同一个 llm 包装。
        return client.chat(messages, { ...sampling, ...callOptions,
          onAttemptStart: () => {
            signal.throwIfAborted();
            if (callClosed) throw new Error('llm call already closed');
            const id = store.startOwnLlmAttempt(callId, now()); attempts.add(id); return id;
          },
          onAttemptEnd: (id, result) => {
            // Ignore a late completion after the engine/store lifecycle ended.
            if (callClosed || signal.aborted) return;
            if (!attempts.delete(id)) throw new Error('unknown llm attempt');
            store.finishOwnLlmAttempt(id, { ...result, at: now() });
          } });
      }), cancelled]);
      // model 随结算落库(1.168.0 / D275):花费报表"按模型分节"要每笔的真实模型,
      // 不许按"当前配置"回填历史(llm.chat 的返回里带本次真实用的模型名)。
      store.finishOwnLlmCall(callId, { status: 'completed', usage: result?.usage ?? null, model: result?.model ?? null, at: now() });
      return result;
    } catch (error) {
      // Own lifecycle closes outstanding attempts before stop() lets the store close.
      // Late transport callbacks remain ignored; cancellation usage stays unknown.
      for (const id of attempts) store.finishOwnLlmAttempt(id, {
        status: signal.aborted ? 'cancelled' : 'failed', usage: null, at: now(),
      });
      attempts.clear();
      store.finishOwnLlmCall(callId, { status: signal.aborted ? 'cancelled' : 'failed',
        error: error?.name ?? 'Error', at: now() });
      throw error;
    } finally { callClosed = true; signal.removeEventListener('abort', abort); }
  }
  const stateKey = key => `own-engine:v1:${key}`;
  function saveState(key, s) {
    store.setMeta(stateKey(key), JSON.stringify({ version: 1, imageHistoryVersion: s.imageHistoryVersion, summary: s.summary, coveredId: s.coveredId,
      resetId: s.resetId, lastAt: s.lastAt, armed: s.armed, compactionCalls: s.compactionCalls,
      // T1-D/T1-C:上下文代(epoch,重置即换代,重复 reset 也换代)与摘要规则版本一起落盘。
      epoch: s.epoch ?? 0, summaryPolicyV: s.summaryPolicyV ?? 0,
      // 失败现场也要落盘:重启后不该因为"忘了上次压失败"而立刻再花一次钱(F1)。
      compactFailAt: s.compactFailAt ?? null }));
  }
  function stateFor(key) {
    let s = state.get(key);
    if (!s) {
      const raw = store.getMeta(stateKey(key));
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && (saved.version !== 1 || typeof saved.summary !== 'string' ||
          !Number.isSafeInteger(saved.coveredId) || !Number.isSafeInteger(saved.resetId) ||
          saved.resetId < 0 || saved.coveredId < saved.resetId || typeof saved.armed !== 'boolean')) {
        throw new Error('engine: invalid persisted context state; refusing silent history loss');
      }
      s = { busy: false, pending: 0, armed: true, summary: '', coveredId: 0, resetId: 0,
        lastAt: null, compactionCalls: [], compactFailAt: null, epoch: 0, summaryPolicyV: 0, ...saved };
      // D274:旧保图策略把 older 挤空后会永久退避。只升级一次,不清历史/摘要/游标。
      if (s.imageHistoryVersion !== 1) {
        if (s.compactFailAt?.removedTokens === 0) {
          s.armed = true;
          s.compactFailAt = null;
          log.warn?.('[engine] 图片历史策略升级:恢复旧保图卡住的摘要重试,原始记录保留');
        }
        s.imageHistoryVersion = 1;
      }
      // 旧库/旧版本留下的数组可能是无上限的(这正是 F8)⇒ 读进来就裁到上限,不许继续背着。
      s.compactionCalls = Array.isArray(s.compactionCalls)
        ? s.compactionCalls.slice(-COMPACTION_CALLS_KEPT) : [];
      // T1-C(2026-10-29)读时版本闸:旧装配口径(临时注入随历史逐字重发、摘要任务跨来源共享)
      // 生成的持久摘要不再直接入口 —— 停用(不删)并把覆盖游标退回 reset 边界,原档以干净投影重建。
      // 原档不删；停用旧摘要后不允许失败兜底把它重新送回主轮/摘要轮。
      if (s.summaryPolicyV !== OWN_SUMMARY_POLICY_V && (s.summary || s.coveredId > s.resetId)) {
        log.warn?.(`[engine] 摘要规则升级(v${s.summaryPolicyV ?? 0}→v${OWN_SUMMARY_POLICY_V}):旧摘要停用,coveredId ${s.coveredId}→${s.resetId}(reset 边界),原档保留待重建`);
        s.summary = '';
        s.coveredId = s.resetId;
        s.summaryPolicyV = OWN_SUMMARY_POLICY_V;
        // 旧投影对应的失败水位不可阻止本次安全重建；后续失败仍遵守原退避。
        s.armed = true;
        s.compactFailAt = null;
        saveState(key, s);
      }
      state.set(key, s);
    }
    return s;
  }

  /** 水位估算(稳定块 + 摘要区 + 历史 + 本轮)。 */
  function waterLevel(stable, summary, history, text) {
    return approxTokens(stable) + approxTokens(summary) + history.reduce((sum, t) => sum + t.tokens, 0) + approxTokens(text);
  }

  /**
   * 压缩:把 older 段连同旧摘要压成新摘要(经同一 llm 客户端,一份提示词)。
   * 失败不拦主轮 —— 摘要失败就继续用旧摘要(水位下轮还超,迟滞放行后再试)。
   */
  /**
   * **历史投影**(T1-A,2026-10-29):一轮进模型前剥掉桥注入块(自报家门标记)。
   * 新标记与可确认的旧桥尾缀共用归档的唯一清洁入口，不信任旧 rawText。
   * tokens 按投影后重算 —— 水位不许拿"曾经注入过的旧文本"虚高。
   */
  function projectTurn(row) {
    const content = projectChatInput(row.content, { source: row.meta?.source, role: row.role,
      inputProjectionVersion: row.meta?.inputProjectionVersion });
    return content === row.content ? row : { ...row, content, tokens: approxTokens(content) };
  }

  function historicalImageText(turn) {
    return turn.meta?.images?.length
      ? `${turn.content}\n（该历史消息附有 ${turn.meta.images.length} 张图片；原图仍存档，本次未附带。不得根据记忆猜测图片细节。）`
      : turn.content;
  }
  async function compactSummary(previousSummary, older, signal, key) {
    const transcript = older.map((t) => `${t.role === 'assistant' ? '她' : '用户'}: ${historicalImageText(t)}`).join('\n');
    const prompt = `${SUMMARY_PROMPT}\n\n【旧摘要】\n${previousSummary || '(无)'}\n\n【待压缩的对话段】\n${transcript}`;
    const result = await cancellableChat([{ role: 'user', content: prompt }], { timeoutMs, signal }, key, 'summary');
    return { text: String(result?.text ?? '').trim(), usage: result?.usage ?? null };
  }

  /**
   * 组装一轮的 messages(ASSEMBLY_ORDER:stable → summary → history → turn)。
   * 注入块全部经 wrapInject(刀二C 硬规矩);易变注入(贡献者)进本轮 user 消息。
   */
  function assemble({ stable, summary, history, text, key, replayImageId }) {
    const messages = [];
    // ① stable:人设 + 出场指令(逐字节稳定,前缀缓存的根)
    messages.push({ role: 'system', content: stable });
    // ② summary:摘要区(只在压缩时变;有才发)
    if (summary && summary.trim() !== '') {
      messages.push({ role: 'system', content: wrapInject('summary', summary) });
    }
    // ③ history:逐字历史(append-only,轮界对齐)
    for (const turn of history) {
      const hasImages = Boolean(turn.meta?.images?.length);
      const images = turn.id === replayImageId ? normalizeLlmImages(turn.meta?.images) : [];
      const content = hasImages && !images.length ? historicalImageText(turn) : turn.content;
      messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: images.length ? [{ type: 'text', text: content },
          ...images.map(url => ({ type: 'image_url', image_url: { url } }))] : content });
    }
    // ④ turn:本轮 = 贡献者注入(自报家门)+ 用户这句
    const blocks = [];
    for (const contributor of turnContributors) {
      const body = contributor.render({ key, text, now: now() });
      if (body && String(body).trim() !== '') blocks.push(wrapInject(contributor.kind, String(body)));
    }
    const userContent = [...blocks, String(text ?? '')].join('\n');
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  const engine = {
    own: true,
    async initialize() {
      persona = readPersona(personaPath); // g7:启动读一次
      return { name: 'own-engine', version: '1' };
    },
    sessionIdFor(conversationKey) {
      return sanitizeSessionId(conversationKey);
    },
    isBusy(conversationKey) {
      if (conversationKey === undefined) {
        for (const s of state.values()) if (s.pending > 0) return true;
        return false;
      }
      return stateFor(String(conversationKey)).pending > 0;
    },
    resetConversation(conversationKey) {
      const key = String(conversationKey ?? '');
      const s = stateFor(key);
      if (s.pending > 0) throw new Error('engine: cannot reset a conversation with pending turns');
      const refreshed = readPersona(personaPath);
      const resetId = store.conversationTurns(key).at(-1)?.id ?? 0;
      // T1-D(2026-10-29):持久、单调递增的上下文代 —— 重复 reset 即使无新 turn 也必须换代
      // (不许拿末行 id 充当 epoch);任务侧用它做迟到结果的提交围栏(T2 起)。
      s.epoch = (s.epoch ?? 0) + 1;
      Object.assign(s, { armed: true, summary: '', coveredId: resetId, resetId, lastAt: null,
        summaryPolicyV: OWN_SUMMARY_POLICY_V });
      saveState(key, s);
      // Even a reset before any row exists is an explicit request not to restore old memory.
      store.setMeta(`own-engine:handoff-suppressed:${key}`, 'true');
      persona = refreshed;
    },
    /** 当前上下文代(持久单调递增;reset 即 +1)。迟到结果的提交围栏用(T2 起)。 */
    epochFor(conversationKey) {
      return stateFor(String(conversationKey ?? '')).epoch ?? 0;
    },
    /**
     * **无状态任务轮**(T1-B,2026-10-29):摘要这类"每次自带全量材料"的辅助调用不再借用
     * 会话历史 —— 不读不写 conversation_turn、无前缀累积,跨来源材料从此不可能同处一个请求;
     * 但仍走同一 llm 客户端、调用/尝试账本、超时与取消语义(cancellableChat 只此一份)。
     * `key` 只是**账本归属**(保持 qqbot-summary* 的既有成本报表口径),不是会话键。
     */
    async runIsolatedTurn(text, { key = '', kind = 'summary', timeoutMs: taskTimeoutMs } = {}) {
      if (stopped) throw new Error('engine stopped');
      const controller = new AbortController();
      active.add(controller);
      const deadline = setTimeout(() => controller.abort(new DOMException('engine turn deadline exceeded', 'TimeoutError')),
        Math.max(1, taskTimeoutMs ?? timeoutMs));
      try {
        const result = await cancellableChat([{ role: 'user', content: String(text ?? '') }],
          { timeoutMs: taskTimeoutMs ?? timeoutMs, signal: controller.signal }, String(key ?? ''), kind);
        return { text: String(result?.text ?? '').trim(), usage: result?.usage ?? null, model: result?.model ?? null };
      } finally {
        clearTimeout(deadline);
        active.delete(controller);
      }
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      const error = new Error('engine stopped');
      for (const controller of active) controller.abort(error);
      stopping = Promise.all([...state.values()].map(s => s.chain)).then(() => undefined);
      return stopping;
    },
    on(...args) {
      emitter.on(...args);
      return engine;
    },
    emit(...args) {
      return emitter.emit(...args);
    },

    /**
     * 跑一轮。同会话串行(排队等),返回与 DshRunner 同形状:`{text, timedOut, reason}`。
     * 空响应 → SILENT_TOKEN(g8);llm 抛错 → 如实带 reason.error 上抛给调用方
     * (桥的既有错误路径接住,**不吞错装成功**)。
     *
     * **P3-b 工具循环**(`toolContext`,可选第 5 参,四参调用行为完全不变):
     *   `{tools, capabilities, grant, turnContext, maxRounds}` 全部由**装配层**构造 ——
     *   引擎只管循环,不认识权限口径(capabilities.js 的等式在那层判)。
     *   · 每个子调用过同一个 `cancellableChat`(共用队列/账/取消/整轮 client 快照);
     *   · **协议状态不落库**(有意简化):assistant(tool_calls)与 tool 中间消息只活在
     *     本次循环内存里,落库的只有最终正文 —— 不破坏 append-only 历史与非 assistant→user 映射;
     *   · 代价:重启后该轮工具上下文不可重放(带 tools 的思考态模型本仓暂不声明支持);
     *   · 纯 tool_calls 不再落到 `[跳过]`;预算耗尽给显式"没能完成"正文。
     */
    async runTurn(conversationKey, text, turnTimeoutMs, imageBlocks, toolContext = null) {
      if (stopped) throw new Error('engine stopped');
      const images = normalizeLlmImages(imageBlocks);
      const key = String(conversationKey ?? '');
      const s = stateFor(key);
      s.pending += 1;
      const run = async () => {
        const controller = new AbortController();
        const signal = controller.signal;
        let deadline;
        s.busy = true;
        try {
          if (stopped) throw new Error('engine stopped');
          active.add(controller);
          deadline = setTimeout(() => controller.abort(new DOMException('engine turn deadline exceeded', 'TimeoutError')),
            Math.max(1, turnTimeoutMs ?? timeoutMs));
          const at = now();
          const gap = s.lastAt === null ? null : Math.max(0, at - s.lastAt);
          const stable = persona;
          const allHistory = store.conversationTurns(key);
          const block = handoff && allHistory.length === 0 && !s.summary && s.resetId === 0
            && store.getMeta(`own-engine:handoff-suppressed:${key}`) !== 'true'
            ? await initialHandoff(key, signal) : '';
          const effectiveText = block.trim() ? block + '\n\n' + String(text ?? '') : text;
          // T1-A:历史投影 —— 档案行原样保留,只动"本轮实际发给模型的输入"。
          const fullHistory = allHistory.filter(row => row.id > s.coveredId).map(projectTurn);
          // 预算裁剪:水位超线 → 迟滞状态机放行才压;保留段 gap-aware(冷收窄)
          const keep = keepForGap(budget ?? {}, gap);
          let history = fullHistory;
          if (budget) {
            const level = waterLevel(stable, s.summary, fullHistory, String(effectiveText ?? ''));
            // ⚠️ **失败后退避**(2026-10-15,F1):以前失败路径 `s.armed = true` ⇒ 水位还超线就
            //    **下一轮立刻再压** —— 失败一次 = 每轮一次付费摘要调用,无退避无熔断;
            //    被保图钉到 older 只剩一两轮时 `size >= replacedSize` 恒真 ⇒ 永远压不动、永远烧钱。
            //    现在:① 失败也**卸武装**(沿用迟滞状态机"压完不许立刻再压"的语义);
            //    ② 再试的前提是**水位比失败那次实质长了一截**,而"一截"是**派生**的 ——
            //    取"那次想压掉的量"与"当时超出触发的量"里更大的那个,不新造数字。
            const fail = s.compactFailAt ?? null;
            const retryNeeds = fail
              ? Math.max(Number(fail.removedTokens) || 0, Math.max(0, (Number(fail.level) || 0) - budget.triggerTokens))
              : 0;
            const retryReady = Boolean(fail) && level >= (Number(fail.level) || 0) + retryNeeds;
            const plan = planCompaction({ tokens: level, armed: s.armed || retryReady, budget });
            s.armed = plan.armed;
            if (plan.compact) {
              // 图仍在 append-only 原档,摘要只处理文字和明确的缺图标记。
              const { older, recent } = splitHistory(fullHistory, keep);
              if (older.length > 0) {
                const attempt = { level, removedTokens: 0 };
                try {
                  const result = await compactSummary(s.summary, older, signal, key);
                  s.compactionCalls = rememberCompactionCall(s.compactionCalls,
                    { at: now(), usage: result.usage, coveredThrough: older.at(-1).id, layer: 1 });
                  let summary = String(result.text ?? '').trim();
                  let size = approxTokens(wrapInject('summary', summary));
                  const replacedSize = approxTokens(s.summary) + older.reduce((n,row) => n + row.tokens, 0);
                  attempt.removedTokens = replacedSize;
                  if (!summary) throw new Error('summary empty');
                  // docs\21 §十二:摘要区**超上限**要"压二层(摘要的摘要)"—— 以前这里直接当失败,
                  // 于是超上限与"压不小"走同一条重试路。现在按文档补上,**同一次尝试内只做一遍**。
                  if (size > budget.summaryCapTokens) {
                    const second = await compactSummary('', [{ role: 'assistant', content: summary }], signal, key);
                    s.compactionCalls = rememberCompactionCall(s.compactionCalls,
                      { at: now(), usage: second.usage, coveredThrough: older.at(-1).id, layer: 2 });
                    summary = String(second.text ?? '').trim();
                    size = approxTokens(wrapInject('summary', summary));
                    if (!summary) throw new Error('summary empty after second layer');
                  }
                  if (size > budget.summaryCapTokens) throw new Error('summary still over cap after second layer');
                  if (size >= replacedSize) throw new Error('summary not smaller than covered history');
                  s.summary = summary;
                  s.summaryPolicyV = OWN_SUMMARY_POLICY_V;
                  s.coveredId = older.at(-1).id;
                  s.compactFailAt = null;
                  history = recent;
                  s.armed = planCompaction({ tokens: waterLevel(stable, s.summary, recent, String(effectiveText ?? '')),
                    armed: false, budget }).armed;
                } catch (err) {
                  // ⚠️ 取消/超时**不是**语义失败:这一趟根本没得到"压不动"的结论(原来的判据也钉着
                  //    这一点:`摘要取消恢复武装，下一轮不能永久卡在迟滞状态`)。所以这里恢复武装,
                  //    并且**不记失败现场** —— 下次水位超线照常再试。
                  if (signal.aborted) {
                    s.armed = true;
                    s.compactFailAt = null;
                    saveState(key, s);
                    signal.throwIfAborted();
                  }
                  // 语义失败(空摘要/超上限/压不小/摘要调用本身失败)⇒ **卸武装 + 记现场**:
                  // 下一轮只有"水位实质长了一截"才允许再试(见上面 retryNeeds)。
                  s.armed = false;
                  s.compactFailAt = { level: attempt.level, removedTokens: attempt.removedTokens, at: now() };
                  log.warn?.(`[engine] 压缩摘要失败，保留全部未覆盖历史(下一轮不重试,除非水位实质增长): ${err?.message ?? err}`);
                }
              } else {
                // 单轮已占满保留段:没有可压的更早历史,不发无效摘要调用,同样退避。
                s.armed = false;
                s.compactFailAt = { level, removedTokens: 0, at: now() };
              }
            }
            saveState(key, s);
          }
          // T4(2026-10-29):取消无条件历史图回放 —— 历史图的像素不再自动进请求。
          // 「刚问的那张」由桥层显式来源供给(3 分钟补图窗 / 引用绑定解析,见 index.js);
          // 引擎层历史只保留文字提示(有几张图、本次未附带、勿凭记忆猜),原档照存。
          const replayImageId = null;
          const historicalImages = fullHistory.reduce((n, row) => n + (row.meta?.images?.length ?? 0), 0);
          if (historicalImages) log.info?.(`[engine] 图片请求:历史存档=${historicalImages},本轮=${images.length},历史回放=0(已取消自动回放)`);
          // ⚠️ P3-b:工具循环会把 assistant/tool 协议消息**续**到这份列表后面 → 必须 let。
          let messages = assemble({ stable, summary: s.summary, history, text: effectiveText, key, replayImageId });
          const capacityMessages = structuredClone(messages);
          if (images.length) capacityMessages.at(-1).content = [
            { type: 'text', text: messages.at(-1).content },
            ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
          checkInputCapacity(capacityMessages);
          // user 轮先落库(append-only;她答不答都落 —— 用户确实说了)
          const userTurnId = store.appendConversationTurn({ key, role: 'user', content: messages.at(-1).content, at,
            // ⚠️ 2026-10-18(P1-A 连带修):`rawText` 的语义是**原始桥提示词** ——
            //    桥自己注入的块(交接/事实/长期记忆,全部 `[[bridge-inject …]]` 自报家门,D177)
            //    必须从它里面剥掉。以前它们裸着,于是 rawText 既被当成 kind 判据的输入、
            //    又让"原始提示词"这句话不成立(探针当场抓到:FTS 注入旧记忆后 rawText 变脏)。
            meta: { source: 'own-engine', inputProjectionVersion: CHAT_INPUT_PROJECTION_VERSION,
              resetId: s.resetId, scene, rawText: projectChatInput(text), ...(block.trim() ? { handoffApplied: true } : {}), ...(images.length ? { images } : {}) } });
          // ⚠️ 2026-10-15(并行审查 F2):`appendConversationTurn` 对**空白内容**拒收并返回 null
          //    (sqlite-store 的既有口径:「空轮没有前缀意义」)。以前这里不判 ⇒ null 被当成
          //    "这一轮的锚点"传下去:影子观测拿到非法 id(镜像断链)、归档配对校验永久抛错(毒丸),
          //    而她**照样答了** —— 正是"她答了、库里没有"的静默漂移。
          //    现在 fail loud:**没落上库就不叫模型**,并且不留半条状态。
          if (!Number.isSafeInteger(userTurnId) || userTurnId <= 0) {
            const error = new Error('own 引擎: user 轮没落上库(组装内容为空或存储拒收),本轮不叫模型');
            error.code = 'OWN_TURN_NOT_PERSISTED';
            throw error;
          }
          s.lastAt = at;
          saveState(key, s);
          // **P3-b**:整轮 client 快照(有没有工具都快照 —— 同一轮的语义一致)。
          const roundClient = llm.snapshot ? llm.snapshot() : llm;
          const tools = (toolContext && Array.isArray(toolContext.tools) && toolContext.tools.length > 0)
            ? toolContext.tools : null;
          let response = await cancellableChat(messages,
            { timeoutMs: turnTimeoutMs ?? timeoutMs, images: imageBlocks, signal,
              observation: { key, userTurnId, resetId: s.resetId }, ...(tools ? { tools } : {}) },
            key, 'main', roundClient);
          let toolsUsed = [];
          if (tools) {
            // **工具循环**(P3-a 状态机驱动):assistant 原样接回 → tool 结果配对 → 再问,
            // 直到模型不再要工具;预算耗尽显式失败,绝不把中间文本当答案。
            const capById = new Map((toolContext.capabilities ?? []).map((cap) => [cap.id, cap]));
            const loopOptions = { timeoutMs: turnTimeoutMs ?? timeoutMs, images: imageBlocks, signal,
              observation: { key, userTurnId, resetId: s.resetId }, tools };
            for (let rounds = 0; ; rounds += 1) {
              signal.throwIfAborted();
              const action = nextLoopAction({ rounds, maxRounds: toolContext.maxRounds, response });
              if (action.action === 'finish') break;
              if (action.action === 'budget-exhausted') {
                log.warn?.(`[engine] 工具循环预算耗尽(${action.calls.length} 个未完成调用),给显式失败正文`);
                response = { ...response, text: budgetExhaustedText(action.calls.map((call) => call.function?.name)), toolCalls: null };
                break;
              }
              const results = new Map();
              for (const call of action.calls) {
                let args = null;
                try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { /* 坏参数走 INVALID_ARGUMENTS */ }
                const outcome = await executeAuthorized({
                  capability: capById.get(String(call.function?.name ?? '')) ?? null,
                  args,
                  turnContext: toolContext.turnContext,
                  grant: toolContext.grant,
                  signal,
                });
                results.set(call.id, { ...outcome, tool: call.function?.name ?? null });
                toolsUsed.push(String(call.function?.name ?? ''));
              }
              messages = [...messages,
                buildAssistantMessage(response),
                ...buildToolResultMessages(action.calls, results)];
              response = await cancellableChat(messages, loopOptions, key, 'main', roundClient);
            }
            toolsUsed = [...new Set(toolsUsed)];
          }
          signal.throwIfAborted();
          const reply = String(response?.text ?? '').trim();
          s.lastAt = now();
          saveState(key, s);
          if (reply === '') {
            // g8:空响应 = 这轮她选择不说(与模型真跳过同一条路径);assistant 轮不落
            return { text: SILENT_TOKEN, reason: reasonForFinish(response?.finishReason), timedOut: false,
              observation: { key, userTurnId, resetId: s.resetId } };
          }
          const usage = response?.usage ?? null;
          const metaBase = { source: 'own-engine', userTurnId, resetId: s.resetId, scene };
          store.appendConversationTurn({
            key, role: 'assistant', content: reply, at: now(),
            // ⚠️ 字段名对齐 normalizeLlmUsage 的形状(promptTokens/…,llm.js 唯一口径)——
            //    第一版读成 prompt/completion,真跑探针当场抓出 usage 全 null。
            //    P3-b:真用过工具才加 `toolsUsed`(默认轮 meta 形状一字不变)。
            meta: {
              ...metaBase,
              ...(usage ? { usage: {
                promptTokens: usage.promptTokens ?? null,
                completionTokens: usage.completionTokens ?? null,
                cacheHitTokens: usage.cacheHitTokens ?? null,
                cacheMissTokens: usage.cacheMissTokens ?? null,
              } } : {}),
              ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
            },
          });
          return { text: reply, reason: reasonForFinish(response?.finishReason), timedOut: false,
            observation: { key, userTurnId, resetId: s.resetId } };
        } catch (error) {
          if (signal.aborted && signal.reason?.name === 'TimeoutError') {
            return { text: null, reason: { kind: 'timeout' }, timedOut: true };
          }
          throw error;
        } finally {
          clearTimeout(deadline);
          active.delete(controller);
          s.busy = false;
          s.pending -= 1;
        }
      };
      // 同会话串行(与 DshRunner 同语义):排队等上一轮落定,错误不让链断。
      const prev = s.chain ?? Promise.resolve();
      const next = prev.then(run, run);
      s.chain = next.catch(() => {});
      return next;
    },
  };

  // 组装顺序对齐声明(判据在 selftest-context 钉死;这里显式引用防两处漂移)
  void ASSEMBLY_ORDER;
  return engine;
}
