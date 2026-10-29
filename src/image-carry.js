/**
 * 「窗内补图」:把**同一个群里最近几分钟出现过的图**带给被文字触发的那一轮。
 *
 * ## 为什么需要它(2026-10-02,用户现场感受)
 *
 * > 「两个机器人识图**时有时无**,特别是协作角色」
 *
 * 病根是结构性的,不是模型能力:群聊里**非 @ 的消息**走"防抖 + 条数门槛"那条路,
 * 它**不当场进模型**;而回复时只取**触发那一条消息**的图。于是
 * 「几个人连着发、图夹在中间那几条」时,她回的是最后那条文字 —— **那些图根本没上桌**。
 * 私聊与 @ 的**带图那一轮**本来就把图直接喂进去 —— 但**追问轮**当时没兜
 * (「发图 → 隔几秒问颜色」现场,见下方 `createConversationImageCarry` 的说明,2026-10-16 补)。
 *
 * ## 三条边界(都有测试)
 *
 * 1. **只在没点名时兜底**(`autoTargets`):被 @ 的那一轮仍然只喂"那一条"的图 ——
 *    点名是明确的指向,把别人的图混进来只会让她答错人;
 * 2. **时间窗 + 条数封顶**:避免隔了很久的图被当成"刚发的";
 * 3. **去重**:同一条消息被记两次也只算一次。
 *
 * ⚠️ 这是**纯逻辑**(不碰网络、不碰模型),所以能单测 —— 按这个项目的纪律,
 * "抽出来才能测"比"写在 main() 里然后说测不到"强。
 */

/** 图能"跟着走"多久(毫秒)。3 分钟 ≈ 一次真实对话的长度。 */
export const IMAGE_CARRY_MS = 3 * 60 * 1000;
/** 最多跟几条消息(按消息数,不是图数 —— 图数由 `maxImages` 那道闸管)。 */
export const IMAGE_CARRY_MAX_SOURCES = 12;

/**
 * 记一条"带图的消息"。
 *
 * @param {Array<{at: number, message: object}>} list 现有清单(会被**就地修改**并返回)
 * @param {object} message 带 `images` 的原始消息
 * @param {number} now
 */
export function rememberCarriedImage(list, message, now = Date.now()) {
  const entries = Array.isArray(list) ? list : [];
  if (!message?.images?.length) return entries;
  entries.push({ at: now, message });
  pruneCarriedImages(entries, now);
  return entries;
}

/** 丢掉过期的(时间窗外)与超量的(只留最新的 N 条)。 */
export function pruneCarriedImages(list, now = Date.now()) {
  const entries = Array.isArray(list) ? list : [];
  let cut = 0;
  while (cut < entries.length && now - entries[cut].at > IMAGE_CARRY_MS) cut += 1;
  if (cut > 0) entries.splice(0, cut);
  if (entries.length > IMAGE_CARRY_MAX_SOURCES) {
    entries.splice(0, entries.length - IMAGE_CARRY_MAX_SOURCES);
  }
  return entries;
}

/**
 * 时间窗内带图的那几条消息(**新的在前**,去重)。
 *
 * @param {Array<{at: number, message: object}>} list
 * @param {{now?: number}} [options]
 * @returns {object[]} 原始消息(不是包装)
 */
export function carriedImages(list, { now = Date.now() } = {}) {
  const entries = pruneCarriedImages(list, now);
  const seen = new Set();
  const out = [];
  for (const entry of [...entries].reverse()) {
    if (seen.has(entry.message)) continue;
    seen.add(entry.message);
    out.push(entry.message);
  }
  return out;
}

/**
 * **没点名时**该补哪些图:窗内除触发那条以外的带图消息。
 *
 * @param {Array<{at: number, message: object}>} list
 * @param {object} [triggerMessage] 这一轮的触发消息(它自己已经会被单独喂进去)
 */
export function carriedExtraImages(list, triggerMessage, { now = Date.now() } = {}) {
  return carriedImages(list, { now }).filter((entry) => entry !== triggerMessage);
}

/**
 * **每个会话一份**的「窗内补图」账本(2026-10-16):群与私聊**同一套**机制、同一个时间窗。
 *
 * ## 为什么私聊也要(2026-10-16 现场,阶段3 的真实门槛)
 *
 * 上面第 11 行那句"私聊与 @ 不存在这个问题"是条**化石假设**:它只对**带图那一轮**成立。
 * 私聊现场:「发一张图(红) → 隔 6 秒问"这是什么颜色"」—— 图那一轮看得见,
 * **追问那条是纯文字,图不在桌上**,模型只能拿历史里的旧图记忆 pattern-match
 * (答了"白的,跟上次那张一个样",实际是红的)。隔离两发对照:同一张红图,
 * 带图发答"红色",不带图发老实说"我看不到图" ⇒ 模型没问题,缺的是**追问轮把图带上**。
 *
 * 群与私聊共用一个实例没问题:`targetId`(群 id / 私聊对方 openid)天然不撞,
 * 时间窗与封顶两条边界对两边一视同仁。
 *
 * @returns {{remember: Function, sources: Function}}
 *   `remember(key, message, now?)` 记一条带图消息;`sources(key, triggerMessage, {now}?)`
 *   取该会话窗内(除触发那条)的带图消息。
 */
export function createConversationImageCarry() {
  const byKey = new Map();
  return {
    remember(key, message, now = Date.now()) {
      if (!key) return;
      const list = byKey.get(key) ?? [];
      rememberCarriedImage(list, message, now);
      byKey.set(key, list);
    },
    sources(key, triggerMessage, { now = Date.now() } = {}) {
      return carriedExtraImages(byKey.get(key) ?? [], triggerMessage, { now });
    },
    /** 丢弃一个会话的补图账(/重置 的"清空重来"语义;T1-D,2026-10-29)。 */
    clear(key) {
      if (key) byKey.delete(key);
    },
  };
}
