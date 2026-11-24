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
 * ## 保守闸(2026-11-24,owner 拍板)
 *
 * 时间窗只回答"多久之前的图还算最近",**不回答"这张图是不是这一轮在说的那张"**。
 * 现场「发一张图 → 中间隔几条闲聊 → 随便回一句」时,窗内旧图会被当成这一轮的图喂进去,
 * 于是按错图答。owner 的口径是**宁可这轮没看到图,也不要按错图答**,所以窗口内部再收一道闸:
 *
 *   - **指代**:触发文字命中指代词(这张/刚才/图里/什么颜色…)→ 窗内图都可以带;
 *   - **紧邻**:没有指代时,只带触发消息往回 `ADJACENT_MAX_MESSAGES`(2)条以内的图;
 *   - 两者都不满足的旧图**不返回**。
 *
 * 3 分钟窗口与条数封顶照旧,闸只负责在窗口内部进一步收窄,不会把窗口放宽。
 * **回话后不整体清账**(owner 确认的是"这条规则",不是"回一次就清空"):账继续在窗内滚动,
 * 只由时间窗、条数封顶和显式 `clear()` 回收。
 *
 * 消息序号:每条入站消息调 `note()` 编号(每会话单调 +1),`remember()` 把图挂到它的序号上。
 * 没先 `note` 的旧调用方由 `remember()` 自己补一个号 —— 于是旧行为(窗内全带)仍由
 * `sources(key, null)` 与"触发消息没有序号信息"这两条老路保留,兼容旧测试与旧接线。
 *
 * ⚠️ 这是**纯逻辑**(不碰网络、不碰模型),所以能单测 —— 按这个项目的纪律,
 * "抽出来才能测"比"写在 main() 里然后说测不到"强。
 */

/** 图能"跟着走"多久(毫秒)。3 分钟 ≈ 一次真实对话的长度。 */
export const IMAGE_CARRY_MS = 3 * 60 * 1000;
/** 最多跟几条消息(按消息数,不是图数 —— 图数由 `maxImages` 那道闸管)。 */
export const IMAGE_CARRY_MAX_SOURCES = 12;

/**
 * 「紧邻」的上限:触发消息往回数几条消息以内的图,没有指代也自动带。
 *
 * 2 = 上一条/上两条;再远就要求指代,否则宁可不带(保守闸)。
 * 暂定值,由 `scripts/selftest-image-carry.js` 钉住。
 */
export const ADJACENT_MAX_MESSAGES = 2;

/**
 * 指代图的正则(**集中定义**,别在别处散落第二份)。
 *
 * 命中即认为"这句话在说图",窗内旧图才允许带上;不命中就只认紧邻。
 * ⚠️ 只收**明确指向图片**的说法(这张/图片/照片/截图/图里/什么颜色…),不收裸「这/那/此」——
 * 水群里「这是什么」「楼上说得对」绝大多数是在说文字/话题,收进来等于保守闸失效。
 */
const DEICTIC_IMAGE_REF_RE = /这张|那张|这几张|那几张|这图|那图|这个图|那个图|图片|照片|截图|图里|图中|上图|看图|什么颜色|什么图|啥图|刚才(?:那张|发的|那图|的图)|刚刚(?:那张|发的|那图|的图)|刚(?:发|拍|截)(?:的)?(?:图|照片|截图|那张)/u;

/** 一段文字里有没有"在说图"的指代。非字符串/空串一律 false(不猜)。 */
export function hasDeicticImageRef(text) {
  if (typeof text !== 'string' || !text) return false;
  return DEICTIC_IMAGE_REF_RE.test(text);
}

/**
 * 记一条"带图的消息"。
 *
 * @param {Array<{at: number, message: object}>} list 现有清单(会被**就地修改**并返回)
 * @param {object} message 带 `images` 的原始消息
 * @param {number} now
 * @param {{seq?: number, epoch?: number}} [meta] 可选:入站序号与账本代际(保守闸用;
 *   旧调用不传则 entry 只有 `at/message`,行为与以前完全一致)
 */
export function rememberCarriedImage(list, message, now = Date.now(), meta = null) {
  const entries = Array.isArray(list) ? list : [];
  if (!message?.images?.length) return entries;
  const entry = { at: now, message };
  if (meta && typeof meta === 'object') {
    entry.seq = meta.seq;
    entry.epoch = meta.epoch;
  }
  entries.push(entry);
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
 * @returns {{note: Function, currentSeq: Function, seqOf: Function, remember: Function,
 *   sources: Function, clear: Function}}
 *   `note(key, message, now?)` 给入站消息编号(同一条消息重复调返回原号);
 *   `currentSeq(key)` 该会话最新序号(没记过=0);`seqOf(message)` 某条消息的序号(没编号=undefined);
 *   `remember(key, message, now?)` 记一条带图消息(顺手把它的序号补上);
 *   `sources(key, triggerMessage, {now}?)` 取该会话窗内(除触发那条)的带图消息,
 *   走保守闸(指代 OR 紧邻);`triggerMessage` 为 null/没有序号信息时回到旧行为(窗内全带);
 *   `clear(key)` 显式清空该会话的账(序号归零、代际 +1,旧序号全部作废)。
 */
export function createConversationImageCarry() {
  /** key → {seq, epoch}:每会话最新序号与账本代际(clear 时代际 +1,旧 entry 因此失效)。 */
  const seqState = new Map();
  /** message → {key, seq, epoch}:WeakMap 不能枚举,clear 只能靠代际号作废旧关联。 */
  const messageSeq = new WeakMap();
  const byKey = new Map();

  function stateOf(key) {
    let state = seqState.get(key);
    if (!state) {
      state = { seq: 0, epoch: 1 };
      seqState.set(key, state);
    }
    return state;
  }

  /** 只返回**当前账本代际**的关联;别的会话/clear 之前的旧关联一律当作"没有序号信息"。 */
  function liveInfo(message) {
    if (!message || typeof message !== 'object') return undefined;
    const info = messageSeq.get(message);
    if (!info) return undefined;
    const state = seqState.get(info.key);
    if (!state || state.epoch !== info.epoch) return undefined;
    return info;
  }

  /** 给一条入站消息编号(每会话单调 +1);同一条消息重复调是幂等的,返回原序号。 */
  function note(key, message) {
    if (!key || !message || typeof message !== 'object') return 0;
    const state = stateOf(key);
    const known = messageSeq.get(message);
    if (known && known.key === key && known.epoch === state.epoch) return known.seq;
    state.seq += 1;
    messageSeq.set(message, { key, seq: state.seq, epoch: state.epoch });
    return state.seq;
  }

  /** 该会话当前最新序号(没记过/刚 clear=0)。 */
  function currentSeq(key) {
    return seqState.get(key)?.seq ?? 0;
  }

  /** 某条消息的序号;没编号或已被 clear 作废 → undefined(调用方据此回旧行为)。 */
  function seqOf(message) {
    return liveInfo(message)?.seq;
  }

  function remember(key, message, now = Date.now()) {
    if (!key || !message?.images?.length) return;
    // 兼容旧调用:没先 note 的带图消息,这里自己补一个序号(先入账后编号也无所谓)。
    note(key, message);
    const info = liveInfo(message);
    const list = byKey.get(key) ?? [];
    rememberCarriedImage(list, message, now, info ? { seq: info.seq, epoch: info.epoch } : null);
    byKey.set(key, list);
  }

  /**
   * 取该会话窗内(除触发那条)的带图消息(新→旧)。
   *
   * - `triggerMessage` 为 null 或没有序号信息 → **旧行为**:窗内全部(新→旧);
   * - 触发文字命中指代 → 窗内全部(新→旧);
   * - 否则只留紧邻图:`0 < triggerSeq - imageSeq <= ADJACENT_MAX_MESSAGES`。
   *   两边都不满足的旧图不返回 —— 宁可这轮没看到图,也不按错图答。
   */
  function sources(key, triggerMessage, { now = Date.now() } = {}) {
    const list = byKey.get(key) ?? [];
    const windowed = carriedExtraImages(list, triggerMessage, { now });
    const triggerInfo = liveInfo(triggerMessage);
    if (!triggerInfo) return windowed;
    if (hasDeicticImageRef(triggerMessage?.content)) return windowed;
    return windowed.filter((message) => {
      const info = liveInfo(message);
      if (!info || info.key !== key) return false;
      if (info.seq >= triggerInfo.seq) return false;
      return triggerInfo.seq - info.seq <= ADJACENT_MAX_MESSAGES;
    });
  }

  /**
   * 丢弃一个会话的补图账(/重置 的"清空重来"语义;T1-D,2026-10-29)。
   *
   * 序号归零、代际 +1:WeakMap 不能枚举,旧消息的关联靠"代际对不上"作废,
   * 这样 clear 之后旧图/旧触发序号不会被误认成"紧邻"而复活。
   */
  function clear(key) {
    if (!key) return;
    byKey.delete(key);
    const state = seqState.get(key);
    if (state) {
      state.seq = 0;
      state.epoch += 1;
    }
  }

  return { note, currentSeq, seqOf, remember, sources, clear };
}
