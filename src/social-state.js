/**
 * 群参与状态机:**观望 / 试探 / 活跃 / 退场**(2026-10-21,1.170.0 / D277)。
 *
 * ### 这一层解决什么
 *
 * D275 盘点过:「什么时候说话」的判定原本是**五把散闸**——防抖(gapMs)、冷却
 * (`shouldSelfReply`)、对话窗口(`isWindowOpen`)、互动概率(`maybeInteractionReply`)、
 * 读空气(`decideSpeakUp`,D72)。每把闸各答一个局部问题,但**没有一个在回答:
 * 「这个群此刻,她该以多大的参与度在场」**。开源 qq-bridge 的状态机给的是这个形状:
 * 每群一个状态,状态决定开口意愿档位 —— **判据形状照搬,数值一个不抄**
 * (主人 2026-10-21 拍板的边界):数值要么从自家真人基线派生,要么标【暂定】集中在
 * `SOCIAL_STATE_DEFAULTS` 一张表里等主人调。
 *
 * ### 四个状态(语义是自家的,不是开源的直译)
 *
 *   · **observing(观望)**:初始态/退场冷却结束。不是失联 —— 自发与互动概率打折
 *     (×0.5【暂定】),被叫照答;
 *   · **trying(试探)**:有人找过她(@)。自发 ×0.75【暂定】,互动照常;
 *   · **active(活跃)**:她的开口得到过回应(answered)。**×1 = 与现状完全一致**;
 *   · **retreating(退场)**:她**自发**开口连续 3 次【暂定】无人接。自发与互动全静
 *     一个冷却期(30 分钟【暂定】),把话语权还给群。
 *
 * ### 三条铁律(判据钉死,不许破)
 *
 *   1. **被叫/私聊/关键词永远不走状态机**:状态机只调制**自发开口**与**戳一戳/表情
 *      反应**的概率 —— @、关键词、私聊在她退场时也照答(D72:真人被点名不会
 *      "读空气"读到不回答;状态机更没资格拦)。退场期间被叫照常回,只是状态不抬。
 *   2. **ignored 连击只数自发开口**:被叫后没人接话是常态(问完就散),不惩罚;
 *      只有"她自己找话没人理"才往退场推。
 *   3. **重启 = 全部回观望**(内存态,不落盘):保守方向 —— 重启后她少说话,
 *      不会突然话痨。
 *
 * ### 观测(前后对照的地基)
 *
 * 每次转移经 `onTransition(groupId, transition)` 统一交调用方记日志与 metric(`social.state.<to>`);下一轮用
 * rhythm-report / 转移轨迹做前后对照 —— **"对照"的判据是转移轨迹与抑制行为,
 * 不是"群里更安静了"这种手感**。
 */

/** 全部数值【暂定】,集中一张表等主人调;改这里 = 改行为,别在逻辑里散写。 */
export const SOCIAL_STATE_DEFAULTS = {
  /** 自发开口连续这么多次无人接 → 退场【暂定】。 */
  ignoredToRetreat: 3,
  /** 试探档连续这么多次无人接 → 回观望(试探期宽容一档)【暂定】。 */
  tryingIgnoredToBack: 2,
  /** 她开口后这个窗口内同群有人说话 =「有回应」【暂定】。 */
  answeredWindowMs: 5 * 60_000,
  /** 退场冷却:静默这么久后回观望【暂定】。 */
  retreatCooldownMs: 30 * 60_000,
  /**
   * 各状态的开口意愿乘数【暂定】。`self` = 自发开口(重查命中后的掷骰),
   * `interact` = 戳一戳/表情反应概率。`active` 恒为 1 —— **活跃态 = 现状,零变化**。
   */
  modulation: {
    observing: { self: 0.5, interact: 0.5 },
    trying: { self: 0.75, interact: 1 },
    active: { self: 1, interact: 1 },
    retreating: { self: 0, interact: 0 },
  },
};

/** 状态全集(顺序即降档顺序:退场是最安静的一档)。 */
export const SOCIAL_STATES = ['observing', 'trying', 'active', 'retreating'];

/**
 * 造一份状态机(桥进程内**一份**,按群各记各的)。
 *
 * @param {{now?: () => number, config?: object, onTransition?: (groupId: string, transition: object) => void}} [options]
 *   `config` 只合并顶层标量;`modulation` 整表替换(别半张表混着改)。
 */
export function createSocialStateMachine({ now = Date.now, config = {}, onTransition = null } = {}) {
  const cfg = { ...SOCIAL_STATE_DEFAULTS };
  for (const [key, value] of Object.entries(config ?? {})) {
    if (key === 'modulation' && value && typeof value === 'object') {
      cfg.modulation = { ...SOCIAL_STATE_DEFAULTS.modulation, ...value };
    } else {
      cfg[key] = value;
    }
  }

  /** 每群的账:状态、连击、自发开口时刻。全内存,重启即清(铁律 3)。 */
  const groups = new Map();

  function entry(groupId) {
    let one = groups.get(groupId);
    if (!one) {
      one = { state: 'observing', ignoredSpree: 0, lastSelfSpokeAt: null, since: now() };
      groups.set(groupId, one);
    }
    return one;
  }

  /**
   * 现算态:退场冷却到点在这里回落观望(不靠定时器 —— 查询时推进,与
   * group-context 的窗口同一风格:状态是派生的,不是跑出来的)。
   */
  function stateOf(groupId, at = now()) {
    const one = entry(groupId);
    if (one.state === 'retreating' && at - one.since >= cfg.retreatCooldownMs) {
      one.state = 'observing';
      one.ignoredSpree = 0;
      one.since = at;
      return { state: 'observing', transition: emit(groupId, { from: 'retreating', to: 'observing', reason: `退场冷却 ${Math.round(cfg.retreatCooldownMs / 60_000)} 分钟已过` }) };
    }
    return { state: one.state, transition: null };
  }

  // 显式信号与查询时冷却共用消费出口;返回值保留兼容,调用方不再重复记账。
  function emit(groupId, transition) {
    if (typeof onTransition === 'function') onTransition(groupId, transition);
    return transition;
  }

  function setSpree(one, value) {
    one.ignoredSpree = value;
  }

  return {
    /** 配置(诊断/判据用;别在运行时改它)。 */
    config: cfg,

    /**
     * 有人 @ 她:观望/试探抬到试探(参与的开始)。**活跃不动**(已经在场上);
     * **退场不抬**(铁律 1:被叫照答,但状态等 answered 信号再说)。
     */
    noteAddressed(groupId, at = now()) {
      const one = entry(groupId);
      const current = stateOf(groupId, at).state;
      one.state = current;
      if (current === 'observing') {
        one.state = 'trying';
        one.since = at;
        return emit(groupId, { from: 'observing', to: 'trying', reason: '被 @——参与的开始' });
      }
      if (current === 'trying') {
        one.since = at;
      }
      return null;
    },

    /**
     * 她开了口。`selfInitiated` = 自发(自发开口启动 ignored 计时;
     * 被叫开口重置连击 —— 她被理睬过,上一轮"没人接"不算数)。
     */
    noteSpoke(groupId, { selfInitiated = false } = {}, at = now()) {
      const one = entry(groupId);
      one.state = stateOf(groupId, at).state;
      if (selfInitiated) {
        one.lastSelfSpokeAt = at;
      } else {
        setSpree(one, 0);
      }
      return null;
    },

    /**
     * 群里有人说话。若落在她**自发**开口的回应窗口内 =「有回应」:
     * 连击清零、任何非活跃态抬到活跃(参与成立)。
     * ⚠️ 口径有意从宽(双审 Y1):窗口内**同群任何人说话**都算有回应 —— 不要求@她、
     *    也不要求那句话真是冲她来的。群里"有人接话"本来就难判定谁在接谁;少数误判的
     *    方向是**少退场**(保守:她多待一会儿),不是把真回应漏掉。审计里的"非@=无关闲聊"
     *    推断过强(样本 11/26、9/11 不足以证明因果),故不改判据,只把理由说清。
     */
    noteGroupMessage(groupId, at = now()) {
      const one = entry(groupId);
      const current = stateOf(groupId, at).state;
      one.state = current;
      const answered = one.lastSelfSpokeAt !== null
        && at - one.lastSelfSpokeAt <= cfg.answeredWindowMs;
      if (answered) {
        setSpree(one, 0);
        one.lastSelfSpokeAt = null;
      }
      if (answered && current !== 'active') {
        one.state = 'active';
        one.since = at;
        return emit(groupId, { from: current, to: 'active', reason: '她开口后有人接话——参与成立' });
      }
      return null;
    },

    /**
     * 她的一次自发开口**无人接**(调用方在回应窗口过后喂)。连击到阈值就降档:
     * 试探回观望、活跃/观望直接退场。返回转移(或 null)。
     * ⚠️ 守卫:`lastSelfSpokeAt === null` 说明这次开口已经被人接过(answered 清掉了)
     * —— 那就不许再数"没人接"。定时器晚到时靠这条不冤枉她。
     */
    noteIgnored(groupId, at = now(), { spokeAt = null } = {}) {
      const one = entry(groupId);
      const current = stateOf(groupId, at).state;
      one.state = current;
      if (one.lastSelfSpokeAt === null) return null;
      if (spokeAt !== null && one.lastSelfSpokeAt !== spokeAt) return null;
      if (at - one.lastSelfSpokeAt <= cfg.answeredWindowMs) return null;
      if (current === 'retreating') return null;
      setSpree(one, one.ignoredSpree + 1);
      one.lastSelfSpokeAt = null;
      if (current === 'trying' && one.ignoredSpree >= cfg.tryingIgnoredToBack) {
        const from = current;
        one.state = 'observing';
        one.ignoredSpree = 0;
        one.since = at;
        return emit(groupId, { from, to: 'observing', reason: `试探期连续 ${cfg.tryingIgnoredToBack} 次开口无人接,回落观望` });
      }
      if (current !== 'trying' && one.ignoredSpree >= cfg.ignoredToRetreat) {
        const from = current;
        one.state = 'retreating';
        one.ignoredSpree = 0;
        one.since = at;
        return emit(groupId, { from, to: 'retreating', reason: `自发开口连续 ${cfg.ignoredToRetreat} 次无人接——退场,把话语权还给群` });
      }
      return null;
    },

    /** 现算状态(退场冷却在这里推进)。 */
    stateOf(groupId, at = now()) {
      return stateOf(groupId, at).state;
    },

    /**
     * 这个群此刻的开口意愿乘数(调用方拿去乘概率;retreating 的 0 = 全静)。
     */
    modulationFor(groupId, at = now()) {
      const state = stateOf(groupId, at).state;
      const table = cfg.modulation[state] ?? cfg.modulation.active;
      return { state, self: table.self, interact: table.interact };
    },

    /** 诊断快照(日志/巡检;全内存的形状,重启后清空是特性)。 */
    snapshotOf(groupId, at = now()) {
      const one = entry(groupId);
      const state = stateOf(groupId, at).state;
      return { state, ignoredSpree: one.ignoredSpree, lastSelfSpokeAt: one.lastSelfSpokeAt, since: one.since };
    },

    /** 所有没有回到观望的群(诊断用)。 */
    busyGroups(at = now()) {
      const out = [];
      for (const [groupId] of groups) {
        if (stateOf(groupId, at).state !== 'observing') out.push(groupId);
      }
      return out;
    },
  };
}
