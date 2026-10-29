/**
 * 「读空气」的社会判断:她该不该现在开口(2026-09-30,见 `docs\03` D72)。
 *
 * 这个模块解决的是用户最早提的那件事:
 * 「两个机器人没有社会属性感、架空感重、**自顾自地说话并且打断正常聊天**」。
 * 实测已经坐实(惠惠群里:自发 464 次 vs 被叫 306 次,沉默率 <1%),
 * 而**真人基准线**是:被 @ 只占 **13.6%**、相邻消息间隔**中位 9 秒**、
 * 对话串**平均 7.5 条 / P75 间隔 26 秒**、单条**中位 9~13 字**。
 *
 * 两类东西分开写,理由不同:
 *
 * 1. **观测**(`classifyUtterance` / `summarizeSocial`):把"她这次开口是插在串中间,
 *    还是落在串的间隙"变成一个**可数的数**。这是 TODO 里写死的前提 ——
 *    "这个观测现在还没有,要先加(否则改完无法判断有没有变好)"。
 *    它是**事后**统计,只读日志,不改任何行为。
 * 2. **判断**(`decideSpeakUp`):开口之前的那道闸。纯函数,有测试,理由进日志。
 *    ⚠️ 这条**默认不启用**,先让观测把改造前的基线量出来(见 `docs\04` §5.12)。
 *
 * ## 判据的口径(为什么用这些数,而不是感觉)
 *
 * | 真人事实 | 这里怎么用 |
 * |---|---|
 * | 相邻消息间隔**中位 9 秒**、P75 **26 秒** | 间隔 < `strandGapMs`(默认 **26000**) 就算"**串还在进行**" |
 * | 对话串平均 **7.5 条**、P90 间隔 256 秒 | 串的**间隙** ≈ 静默超过这个量级;她只该在间隙开口 |
 * | **被 @ 只占 13.6%** | 所以"没被 @ 就沉默"在多数时候是**对的**默认 |
 *
 * ⚠️ `strandGapMs` 取 26000 不是随手取的:它是真人 P75 的**相邻消息间隔** ——
 * 也就是说"四人聊天里,超过四分之一的相邻间隔比它更长",所以以它为界能把
 * "还在你一句我一句"和"这串已经断了"分开。**要改先重跑 `rhythm-report.js`。**
 */

/** 「串还在进行」的判定阈值:距最后一条人类消息小于它 = 串没断。 */
export const DEFAULT_STRAND_GAP_MS = 26_000;

/**
 * 把**她的一次发言**按"落在串中间还是间隙"归类。
 *
 * @param {object} utterance
 * @param {number} utterance.at 她发言的时刻(毫秒)
 * @param {number|null} [utterance.lastHumanAt] 在她之前、同会话最后一条**人类**消息的时刻
 * @param {number} [utterance.runLength] 那一串人类消息的条数(她能看见的"你一句我一句"有多少句)
 * @param {object} [options]
 * @param {number} [options.strandGapMs]
 * @returns {'interjecting'|'in-gap'|'no-context'}
 *   `interjecting` = 插在别人还在说话的串中间(打断);
 *   `in-gap` = 串已经静下来她才开口(像人);
 *   `no-context` = 之前没有任何人类消息(开新话题/暖群)。
 */
export function classifyUtterance(utterance, options = {}) {
  const strandGapMs = options.strandGapMs ?? DEFAULT_STRAND_GAP_MS;
  const lastHumanAt = utterance?.lastHumanAt;
  if (!Number.isFinite(lastHumanAt)) return 'no-context';
  const gap = utterance.at - lastHumanAt;
  if (!Number.isFinite(gap) || gap < 0) return 'no-context';
  return gap < strandGapMs ? 'interjecting' : 'in-gap';
}

/**
 * 从一条**按时间排好**的同会话时间线里,数出"打断/间隙"的分布。
 *
 * ⚠️ **必须分成两栏,否则量出来的是假数字**:
 *   · **主动开口**(`selfInitiated: true`)= 她**自己**找话(自发接话/暖群/戳一戳反应);
 *     这一栏才是"读空气"要治的东西 —— 用户抱怨的是"**自顾自**地说话并打断聊天"。
 *   · **被叫后的回复**(`selfInitiated: false`)= @ / 关键词唤醒后的回应;
 *     真人被叫到也是立刻回,把它算进打断率只会把数字糊成一片
 *     (第一版就犯了这错:爱丽丝某群"打断率 99%",其实那一栏全是 @ 之后的回复)。
 *   所以 `interjectingRatio` 只统计**主动开口**那一栏;被叫那栏单独报。
 *
 * @param {Array<{at: number, kind: 'human'|'bot', selfInitiated?: boolean}>} timeline
 * @param {{strandGapMs?: number}} [options]
 */
export function summarizeSocial(timeline, options = {}) {
  const strandGapMs = options.strandGapMs ?? DEFAULT_STRAND_GAP_MS;
  let lastHumanAt = null;
  let runLength = 0;
  let runStart = null;
  const result = {
    botUtterances: 0,
    selfInitiated: 0,
    prompted: 0,
    interjecting: 0,
    inGap: 0,
    noContext: 0,
    promptedInterjecting: 0,
    humanMessages: 0,
    maxRun: 0,
  };

  for (const entry of timeline ?? []) {
    if (!Number.isFinite(entry?.at)) continue;
    if (entry.kind === 'human') {
      result.humanMessages += 1;
      // 串的边界:与上一条人类消息的间隔超过阈值 → 这是**新的一串**。
      if (lastHumanAt !== null && entry.at - lastHumanAt >= strandGapMs) {
        runLength = 0;
        runStart = entry.at;
      } else if (runStart === null) {
        runStart = entry.at;
      }
      runLength += 1;
      lastHumanAt = entry.at;
      continue;
    }
    if (entry.kind !== 'bot') continue;
    result.botUtterances += 1;
    result.maxRun = Math.max(result.maxRun, runLength);
    const verdict = classifyUtterance(
      { at: entry.at, lastHumanAt, runLength },
      { strandGapMs },
    );
    if (entry.selfInitiated === true) {
      result.selfInitiated += 1;
      if (verdict === 'interjecting') result.interjecting += 1;
      else if (verdict === 'in-gap') result.inGap += 1;
      else result.noContext += 1;
    } else {
      result.prompted += 1;
      if (verdict === 'interjecting') result.promptedInterjecting += 1;
    }
  }

  result.interjectingRatio = result.selfInitiated === 0
    ? Number.NaN
    : result.interjecting / result.selfInitiated;
  return result;
}

/**
 * 开口之前的判断:**该说 / 该等 / 别插话**。
 *
 * 只管"什么时候说",不管"说什么"(那是模型的活,见项目分工)。
 *
 * ⚠️ 与既有闸门的关系(别重复造闸门):
 *   · `QQBOT_GROUP_COOLDOWN_MS` 管的是"我上次发言之后多久"(机器人视角的量);
 *   · 这里的 `gapMs` 管的是"**别人**最近有没有在连着说话"(对话视角的量);
 *   · 两个都要过 —— 前者防刷屏,后者防打断。
 *
 * @param {object} state
 * @param {number} state.now
 * @param {number|null} state.lastHumanAt 同会话最后一条人类消息的时刻
 * @param {number|null} [state.lastUtteranceAt] 她上次在这个会话开口的时刻
 * @param {number|null} [state.ownMessageAt] 最近一次**她发出**的消息时刻(含暖群/播报)
 * @param {number} [state.pending] 缓冲里攒着多少条群消息
 * @param {number} [state.runLength] 当前这一串人类消息的条数
 * @param {boolean} [state.addressed] 这条是不是点名/被搭话(@、关键词、第二人称)
 * @param {boolean} [state.hasPersonCandidate] 有没有别人在说话之后没被回应的"人"
 * @param {object} [options]
 * @param {number} [options.gapMs] 要等多久静默才算"串的间隙"
 * @param {number} [options.minRunForWait] 串短到几条就不必等(默认 2:单人自言自语不算串)
 * @param {number} [options.maxWaitMs] 等超过这么久就别等了(免得永远开不了口)
 * @returns {{verdict: 'speak'|'wait'|'stay-silent', reason: string}}
 */
export function decideSpeakUp(state = {}, options = {}) {
  const gapMs = options.gapMs ?? DEFAULT_STRAND_GAP_MS;
  const maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
  const now = state.now ?? 0;

  // 点名/被搭话:永远先说。真人在被叫到时不会"读空气"读到不回答。
  if (state.addressed) return { verdict: 'speak', reason: '被点名/被搭话' };

  if (!Number.isFinite(state.lastHumanAt)) {
    return { verdict: 'stay-silent', reason: '这个会话还没有人说过话(不该由她起头)' };
  }

  const gap = now - state.lastHumanAt;
  if (gap >= gapMs) {
    return { verdict: 'speak', reason: `串已经静了 ${(gap / 1000).toFixed(0)} 秒(阈值 ${(gapMs / 1000).toFixed(0)} 秒)` };
  }

  // ⚠️ 这里的 maxWait 是**保险丝**:某个人一直在刷屏时,否则她永远开不了口 ——
  //    而"永远开不了口"是另一种不像人(真人也会接一句"你们在聊什么")。
  if ((now - state.lastHumanAt) >= maxWaitMs) {
    return { verdict: 'speak', reason: `串一直在继续,但已经等了 ${(maxWaitMs / 60000).toFixed(0)} 分钟(保险丝)` };
  }

  return {
    verdict: 'wait',
    reason: `别人还在连着说(距最后一条 ${(gap / 1000).toFixed(0)} 秒 < ${(gapMs / 1000).toFixed(0)} 秒)`,
  };
}

/** 连续跳过几次之后就不再加长间隔了(退避封顶倍率)。 */
export const RECHECK_BACKOFF_MAX = 4;

/**
 * **"自发重查"的间隔**(2026-10-01,D90)。
 *
 * ## 什么是自发重查
 *
 * `decideSpeakUp` 说"先等等"时,桥会**排一次重试**:等串静下来,再喂她一遍同样的上下文,
 * 让她重新判断要不要接话(日志里那句「串似乎断了,再看一眼」)。这一步就是**自发重查**。
 * ⚠️ 它只发生在"没人点名"时 —— 被 @、关键词、戳一戳在更前面就返回了,不受这里管。
 *
 * ## 为什么要上限
 *
 * 实测(2026-10-01,一个群里 15 分钟)**自发重查了 8 次** —— 因为那时候有人在连发消息,
 * "串"反复看起来是断的。每次重查都是一次**可能发言**的机会,于是群里看到的是"她也跟着刷"。
 * ⚠️ 这和"想发多少看模型心情"是**同一类病:没有上限**。
 *
 * 退避:她连着回 `[跳过]`(看了但不想说)就说明这时候不该多嘴 → 间隔按 2× / 3× / 4× 拉长,
 * 一开口立刻归零。
 *
 * @param {number} minMs 基础间隔(`QQBOT_RECHECK_MINUTES`,0 = 关掉上限)
 * @param {number} [skips] 最近连续跳过几次
 */
export function recheckIntervalMs(minMs, skips = 0) {
  const base = Math.max(0, Number(minMs) || 0);
  const step = Math.min(1 + Math.max(0, Math.floor(Number(skips) || 0)), RECHECK_BACKOFF_MAX);
  return base * step;
}

/**
 * 这一次允许排队"自发重查"吗?**纯函数**。
 *
 * @param {{lastRecheckAt?: number|null, now?: number, minMs?: number, skips?: number}} state
 * @returns {{allowed: boolean, intervalMs: number, reason: string}}
 */
export function decideRecheck({ lastRecheckAt = null, now = 0, minMs = 0, skips = 0 } = {}) {
  if (!(Number(minMs) > 0)) {
    return { allowed: true, intervalMs: 0, reason: '没设上限（QQBOT_RECHECK_MINUTES=0）' };
  }
  const intervalMs = recheckIntervalMs(minMs, skips);
  const since = Number.isFinite(lastRecheckAt) ? now - lastRecheckAt : Number.POSITIVE_INFINITY;
  const backoff = skips > 0 ? `，连续跳过 ${skips} 次已退避` : '';
  const seconds = (ms) => `${Math.round(ms / 1000)} 秒`;
  return Number.isFinite(since) && since < intervalMs
    ? {
      allowed: false,
      intervalMs,
      reason: `距上次自发重查只有 ${seconds(Math.max(0, since))}（下限 ${seconds(intervalMs)}${backoff}）`,
    }
    : {
      allowed: true,
      intervalMs,
      reason: Number.isFinite(since)
        ? `距上次自发重查 ${seconds(since)} ≥ ${seconds(intervalMs)}${backoff}`
        : `本群还没自发重查过（下限 ${seconds(intervalMs)}${backoff}）`,
    };
}
