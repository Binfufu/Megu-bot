/**
 * **数值 × 模块的绑定表**(D102,2026-10-02)。**纯函数**。
 *
 * 用户原话(起因是一次真 bug):
 * > 「现在数值加得太随便了,你看群聊里刚叫去钓鱼就加了饱食度和体力、扣钱,完全不合理,
 * >   看看为什么会这样。**把每个数值和各自强关联的模块绑定**,绑定的模块 **100% 改变相应数值、
 * >   100% 不改变无关数值**,要做成**有依据的、合理的、逻辑严谨**的数值系统。」
 *
 * 那次 bug 的直接原因是"食物名词 = 她吃了"(已修,见 `stats.js` 的 `hasFeedGift`),
 * 但**更深一层**的问题是:**没有任何地方规定过"哪个模块能动哪个数"** ——
 * 于是每次加新玩法,都能顺手往任何数值上写一笔。这张表就是那条规矩。
 *
 * 三层用法:
 *   ① **声明**:每个"事件种类"(以及 company 那类**分活动**的)写清它**只准**动哪几个数;
 *   ② **执行**:`applyStory()` 在落账前拿它**过滤**掉越界的字段(带一条 warn)——
 *      所以"100% 不改变无关数值"是**代码保证**的,不是靠写代码的人记得;
 *   ③ **回归**:`selftest` 会遍历所有事件表(邀约/事件钩子/委托/钓鱼),
 *      断言它们的 `effect` 键**都在**绑定表允许的集合里 —— 表和绑定**不许各说各话**。
 *
 * ⚠️ 只列"**能改**"的(`allowed`);没列到的 = 这个模块**不许碰**。
 */

export const ALL_STATS = ['satiety', 'health', 'mood', 'stamina', 'mana', 'money'];

/**
 * 事件种类 → 允许改的数值。
 *
 * 每一条都要说得出"**为什么是这个模块**"(用户要的"有依据"):
 */
export const STAT_BINDING = {
  // —— 吃 / 投喂 ——
  /** 吃这一顿本身:饱食是它的主业;健康/心情是食物属性;体力按饱食折算;钱是饭钱。 */
  meal: { allowed: ['satiety', 'health', 'mood', 'stamina', 'money'] },
  /** 「被投喂」那笔:**只有心情和体力** —— 钱在 D99 已经拿掉(投喂不给钱),饱食归 `meal`。 */
  fed: { allowed: ['mood', 'stamina'] },
  /** 她自己跑去吃饭:走的是 `meal` 那条(饱食/钱/体力),这里只留一个别名。 */
  selfcare: { allowed: ['mood', 'stamina'] },
  // —— 互动 ——
  praise: { allowed: ['mood'] },
  poked: { allowed: ['mood', 'stamina'] },
  ignored: { allowed: ['mood', 'stamina'] },
  chat: { allowed: ['mana', 'stamina'] },
  intimate: { allowed: ['mood', 'stamina', 'mana'] },
  explosion: { allowed: ['stamina', 'mana'] },
  rest: { allowed: ['mood', 'stamina'] },
  /**
   * ⚠️ 1.91.0(D147)补的**一条口径**:`rest` 只管心情与体力,可"睡一觉回血"这件事
   * 早就写在两处了 —— `stats.js` 的 `healthPerHourAsleep`(时间积分)与
   * `company:sleep_together` 的 `effect.health`。而元素连接图要回答"**谁动了健康**":
   * 不把 `sleep` 这一条声明出来,健康就是一个**没有任何来源**的数值
   * (图会如实报"没有玩法动它" —— 那是对的,但事实是有的,只是没登记)。
   * 所以这里补的是**声明**,不是新的数值机制:允许改的仍然只有列出来的这几个。
   */
  sleep: { allowed: ['health', 'stamina', 'mood'] },
  potion: { allowed: ['mana', 'stamina', 'money'] },
  // —— 玩法 ——
  /** 接委托:**钱与体力**。不碰吃喝 —— 接活不吃饭(D102 用户点名的那条)。 */
  quest: { allowed: ['money', 'stamina'] },
  /**
   * 她自己的生活事件(钩子的走向):**按档位来** —— 钱/心情/体力/饱食/健康都可能,
   * 因为那些 `effect` 是**事件本身**的内容(吃了剩饭=饱食、赔了钱=钱)。
   * ⚠️ 这一条刻意宽,但它宽得**有据**:每一档的 `effect` 都是人手写的、并且有测试盯着
   * "每一档至少改一个数"。
   */
  story: { allowed: ['satiety', 'health', 'mood', 'stamina', 'money'] },
  /**
   * **钓鱼本身只换钱** —— 用户 2026-10-02:「钓鱼本身**不应该加饱食度**啊」。
   * 钓上来的东西是**物品/卖钱**;要吃是**钓完之后另选**的事(烤/煮/煎)。
   */
  fish: { allowed: ['money', 'mood'] },
  /** 卖东西 / 典当:**只动钱**。 */
  sell: { allowed: ['money'] },
  /**
   * **家里的东西**(风干鱼、留着不卖的稀有物、杂物):
   * 它换的不是钱也不是饱食 —— 所以**只准动心情**(D101 那条"带回家风干"的落点)。
   * ⚠️ 没有这一条的话,"带回家"那笔会因为**没声明**而被整个丢掉(fail closed)。
   */
  home: { allowed: ['mood'] },
  // —— 邀约(分活动,键是 `company:<活动id>`)——
  'company:shopping': { allowed: ['money', 'mood', 'stamina'] },
  'company:sleep_together': { allowed: ['stamina', 'mood', 'health'] },
  'company:outing': { allowed: ['money', 'mood', 'stamina'] },
  'company:adventure': { allowed: ['money', 'stamina', 'mood'] },
  /** 让她做饭:**这一档是"她做了并吃了"**,所以饱食在这条里是**有据**的(钱买料、体力花掉)。 */
  'company:cook': { allowed: ['money', 'satiety', 'mood'] },
  'company:practice': { allowed: ['mana', 'stamina', 'mood'] },
  // —— 前端审计(D110)——
  /**
   * **面板上做了什么事**:只落一行"哪来的动作"(数值增量全 0,鱼篓快照进 `detail`)。
   * ⚠️ 它是**唯一一条 `allowed` 为空**的条目,而且是故意的:
   *    这一行**不打算**改任何数值,它只回答"她自己怎么变富了"。
   *    声明出来(而不是"不声明了,反正没人查")有两层意思:
   *    ① 测试可以断言"**面板的审计行不是一次数值改动**";
   *    ② 以后谁想让它动数值,会在这里看到"不许"。
   */
  panel: { allowed: [] },
  /**
   * **移动**(1.92.0 / D148):走去某个场所 —— **不动任何数值**。
   * ⚠️ 与 `panel` 同一条理由:它是"位置"那一层,不是数值。
   * 将来要收"路上的体力/时间"时,**改的是这张表**(而不是在移动代码里偷偷加减)。
   */
  move: { allowed: [] },
};

/** 取一条绑定(找不到返回 null = **没声明** ⇒ 调用方按"不许改任何数"处理)。 */
export function bindingFor(kind, detail = {}) {
  if (!kind) return null;
  const scoped = detail.activityId ? STAT_BINDING[`${kind}:${detail.activityId}`] : null;
  return scoped ?? STAT_BINDING[kind] ?? null;
}

/**
 * 这一笔效果里**越界**的数值名(空数组 = 全部合规)。**纯函数**。
 *
 * @param {string} kind 事件种类
 * @param {object} effect 想改的数值
 * @param {object} [detail] 附加信息(company 用 `activityId` 区分活动)
 * @returns {string[]}
 */
export function bindingViolations(kind, effect, detail = {}) {
  const binding = bindingFor(kind, detail);
  const allowed = new Set(binding?.allowed ?? []);
  return Object.keys(effect ?? {}).filter((key) => {
    if (!ALL_STATS.includes(key)) return false; // 非数值字段(e.g. `homeItem`)不在这张表的管辖内
    const value = Number(effect[key]);
    if (!Number.isFinite(value) || value === 0) return false; // 写 0 = 没打算改它
    return !allowed.has(key);
  });
}

/**
 * 按绑定表**过滤**一笔效果,并报出被丢掉的部分。**纯函数**。
 *
 * @returns {{effect: object, dropped: string[]}}
 */
export function filterEffectByBinding(kind, effect, detail = {}) {
  const dropped = bindingViolations(kind, effect, detail);
  if (dropped.length === 0) return { effect: { ...(effect ?? {}) }, dropped };
  const kept = { ...(effect ?? {}) };
  for (const key of dropped) delete kept[key];
  return { effect: kept, dropped };
}
