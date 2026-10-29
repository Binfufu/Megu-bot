/**
 * **刀二A · 上下文预算与压缩内核**(2026-10-14,`docs\21` §十二;冷缓存解法并入见 §十三)。
 *
 * ## 这一层管什么、不管什么
 *
 * 管(全是**纯函数**,不碰网不碰库):
 *  · **预算表** `budgetFor(scene)` —— 世界档/梦境档两组数(2026-10-14 用户拍板;内档【暂定】);
 *  · **压缩决策** `planCompaction` —— 触发 + **迟滞**(压完未落回重武装水位前不许再压:
 *    阈值附近反复压 = 反复打碎 DeepSeek 前缀缓存,压得越勤越贵);
 *  · **切分** `splitHistory` —— 按预算把历史切成「逐字保留段 + 待摘要段」,轮界对齐;
 *  · **gap-aware 保留段** `keepForGap` —— 隔天回来的会话(缓存已知冷)保留段临时收窄,
 *    事实靠 memory.db 检索兜底(§十三B);
 *  · **组装顺序** `ASSEMBLY_ORDER` —— 稳定块前置吃「公共前缀检测持久化」,
 *    易变注入只进本轮 user 消息(§十三C/H:摘要区只在压缩时变,而压缩只在冷时做)。
 *
 * 不管(归别处):
 *  · 摘要真调模型 → `llm.js`(D159:必须一致的东西只有一份);存储 → 刀二B;
 *  · keep-alive 心跳 → 刀三B 的 `QQBOT_CACHE_KEEPALIVE` 开关(默认关,探针定生死)。
 *
 * ## 「只在冷时动前缀」总原则(§十三C,迟滞条款的推广)
 *
 * 压缩/收窄/加宽/摘要变更这类**必然打碎缓存**的操作,只在缓存已知冷(超窗回来)时执行 ——
 * 那时打碎不花钱;缓存暖时绝不碰前缀结构。调用方(engine,刀三A)负责判冷(gapMs),
 * 本模块提供 `keepForGap` 与迟滞状态机,把"什么时候允许动"钉死在纯函数里。
 */

import { approxTokens } from './dream-cards.js';

/**
 * 预算表(单位:token,除 coldGapMs 为毫秒)。
 * 2026-10-14 用户拍板:世界 64k/16k、梦境 32k/8k;
 * 内档(摘要区上限/迟滞余量/gap 窗口/冷收窄档)标【暂定】,影子期跑数据再调(docs\21 §十二)。
 * ⚠️ 数值判据钉在 selftest-context(防手滑改错档);改这里必须连判据一起改、留决策条目。
 */
export const CONTEXT_BUDGETS = Object.freeze({
  world: Object.freeze({
    triggerTokens: 65_536,
    keepRecentTokens: 16_384,
    summaryCapTokens: 8_192, // 【暂定】摘要区上限,超了压二层(摘要的摘要)
    hysteresisMarginTokens: 8_192, // 【暂定】迟滞余量:重武装水位 = 触发 − 保留 − 余量
    coldGapMs: 6 * 3_600_000, // 【暂定】超过这个间隔回来 = 缓存已知冷
    coldKeepTokens: 4_096, // 【暂定】冷回来的收窄保留档
  }),
  dream: Object.freeze({
    triggerTokens: 32_768,
    keepRecentTokens: 8_192,
    summaryCapTokens: 4_096, // 【暂定】
    hysteresisMarginTokens: 8_192, // 【暂定】
    coldGapMs: 6 * 3_600_000, // 【暂定】
    coldKeepTokens: 4_096, // 【暂定】
  }),
  // 播报/一次性任务:零历史,不进压缩管线(docs\21 §十二预算表)。
});

/**
 * 取某场景的预算。认不出的场景(含 announce 这类无历史任务)返回 null,
 * 调用方见 null 就不进压缩管线 —— 不硬造预算。
 * @param {string} scene 'world' | 'dream' | 其他
 * @returns {Readonly<object>|null}
 */
export function budgetFor(scene) {
  return CONTEXT_BUDGETS[scene] ?? null;
}

/**
 * 重武装水位:压缩后会话水位须落回这条线以下,迟滞才重新武装。
 * 世界档 = 65536 − 16384 − 8192 = 40960(现算派生,不另存一份 —— D34)。
 */
export function rearmLevel(budget) {
  return budget.triggerTokens - budget.keepRecentTokens - budget.hysteresisMarginTokens;
}

/**
 * 压缩决策(迟滞状态机,纯函数:同输入同结果)。
 *
 * · 已武装 && 水位 > 触发 → **压**,并**卸武装**(压完的水位不许立刻再压);
 * · 已卸武装 && 水位 ≤ 重武装水位 → 重新武装(不压);
 * · 其余 → 维持现状。
 *
 * @param {{tokens: number, armed?: boolean, budget: object}} args
 * @returns {{compact: boolean, armed: boolean, reason: 'over_trigger'|'hysteresis'|'rearm'|'hold'}}
 */
export function planCompaction({ tokens, armed = true, budget }) {
  if (!budget) return { compact: false, armed, reason: 'hold' };
  if (armed && tokens > budget.triggerTokens) {
    return { compact: true, armed: false, reason: 'over_trigger' };
  }
  if (!armed && tokens <= rearmLevel(budget)) {
    return { compact: false, armed: true, reason: 'rearm' };
  }
  return { compact: false, armed, reason: armed ? 'hold' : 'hysteresis' };
}

/**
 * 逐轮 token 估算的默认口径(与 dream-cards 一份,D159)。
 * 轮的形状:{content: string, ...} —— 别的字段不估。
 */
function defaultCostOf(turn) {
  return approxTokens(typeof turn?.content === 'string' ? turn.content : '');
}

/**
 * 把历史切成「待摘要段(older) + 逐字保留段(recent)」。
 *  · 从末尾往前装,装到 keepTokens 为止,**轮界对齐**(不切半轮);
 *  · 单轮超预算时它仍进保留段(至少保一轮 —— 空的保留段等于把最近一句也摘要掉);
 *  · `older.concat(recent)` 与输入逐项相等(不丢轮、不重排)。
 *
 * @param {Array<object>} history 按时间升序的轮
 * @param {number} keepTokens 保留预算(通常是 keepForGap 的产物)
 * @param {(turn: object) => number} [costOf]
 * @returns {{older: Array<object>, recent: Array<object>}}
 */
export function splitHistory(history, keepTokens, costOf = defaultCostOf) {
  const list = Array.isArray(history) ? history : [];
  const budget = Math.max(0, Number(keepTokens) || 0);
  let used = 0;
  let cut = list.length; // recent = list[cut..],从全保留开始往前放
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const cost = costOf(list[i]);
    if (used + cost > budget && cut < list.length) break; // 再装就超且保留段非空 → 停
    used += cost;
    cut = i;
  }
  return { older: list.slice(0, cut), recent: list.slice(cut) };
}

/**
 * gap-aware 保留段(§十三B):距上一轮的间隔超窗 = 缓存已知冷 → 收窄档;
 * 未超窗 → 正常档。间隔未知(null)按未超窗处理(保守:不动前缀)。
 * @returns {number} 本轮该用的保留预算
 */
export function keepForGap(budget, gapMs) {
  if (gapMs == null) return budget.keepRecentTokens;
  return gapMs >= budget.coldGapMs ? budget.coldKeepTokens : budget.keepRecentTokens;
}

/**
 * 摘要区是否超上限(超了 → 把摘要再压一层,摘要的摘要;§十二预算表)。
 * @returns {boolean}
 */
export function summaryOverCap(summaryTokens, budget) {
  return summaryTokens > budget.summaryCapTokens;
}

/**
 * 组装顺序(§十三C/H:稳定块前置吃「公共前缀检测持久化」,易变注入只进本轮)。
 * engine(刀三A)按这个顺序拼 messages;判据钉在 selftest-context,改序必须留决策条目。
 */
export const ASSEMBLY_ORDER = Object.freeze(['stable', 'summary', 'history', 'turn']);

/**
 * 摘要器提示词(一份,D159)。给压缩用的那次 llm.chat:
 * 输入 = 旧摘要(若有)+ 待摘要段;输出 = 新摘要( ≤ summaryCap)。
 * 口径:保留事实/承诺/称呼/梗与语气倾向,不逐字复述,不创作。
 */
export const SUMMARY_PROMPT = [
  '你在为一只长期扮演的聊天机器人压缩对话记忆。',
  '下面给出【旧摘要】(可能为空)与【待压缩的对话段】。',
  '请输出一段新的中文摘要,要求:',
  '1) 保留所有事实:人名/称呼/约定/承诺/重要事件的去向与结果;',
  '2) 保留双方的关系状态、常用梗与语气倾向(一句话概括即可);',
  '3) 不逐字复述、不引用原句;不创作、不推测没发生的事;',
  '4) 只输出摘要正文,不要任何标题、前言或解说。',
].join('\n');
