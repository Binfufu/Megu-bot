/**
 * 「她自己的生活在转」(D99 阶段 2)。**全是纯函数** —— 时间、随机源都由调用方注入,
 * 所以"她什么时候会自己开口、开口说什么方向"可以直接单测(装配段在 `main()` 里,测不到)。
 *
 * 用户 2026-10-02 的原话:
 * > 「在没有互动时惠惠**饱食度过低会自己去吃饭并且报备出来**(感觉可以代替暖群)。」
 * > 「主动开口提出**随机事件钩子**,用户可作出互动选择,如果没有互动则在一段时间后**自己决定走向**,
 * >   随机事件可**暂时交给 llm 自由发挥**……最后说惠惠去休息/洗澡/睡觉等等休闲行为(互动事件结束)。」
 *
 * 阶段 2 只做前半截:**静默够久 + 饿了 → 去吃饭(真的花钱、真的涨饱食)并报备**;
 * 饱食还行时 → 偶尔报一句"她在做什么"(公会看板/逛街/保养魔杖/泡澡)。
 * 事件钩子(**未解决** → 等回应 → 超时自决 → 必有数值结果)是阶段 3,落在这里加即可。
 *
 * ⚠️ 三条与暖群共用的纪律(别绕开):
 *   ① **主动消息有配额**(单群 20/qpm、每天 1000)—— 所以有 `gapMs` 与"每次只对一个目标开口";
 *   ② **睡眠时段不开口**(`warmup.sleep` 那套);
 *   ③ **别人刚说过话就不插嘴**(`quietMs`)—— "她在生活"不等于"她刷屏"。
 */
import { placeById } from './world.js';
import { CURRENCY } from './stats.js';
import { GAMEPLAY_CONTENT, gameplayText } from './local-gameplay-content.js';

/** 默认参数。放在代码里(D20 的教训:写进提示词的概率不会变成概率)。 */
export const SELFCARE_DEFAULTS = {
  /** 静默这么久之后,才轮到"她自己过日子"。 */
  quietMs: 40 * 60_000,
  /** 饱食低于此值就去吃饭(和 `DECAY.starvingBelow` 那个"饿着"分开:这条是**行动**门槛)。 */
  hungryBelow: 25,
  /** 两条主动消息之间至少隔这么久 —— 配额闸门。 */
  gapMs: 45 * 60_000,
  /** `life`(不饿但想冒个泡)那一档的最短间隔:比吃饭稀得多。 */
  lifeEveryMs: 3 * 60 * 60_000,
  /** 满足上面所有条件时,`life` 真的开口的概率。 */
  lifeChance: 0.5,
};

/**
 * 去吃的地方。**按"她缺多少"挑** —— 这就是"钱只和她的世界的商店/餐厅绑定"的落地:
 * 饿了才去,缺得越多进越便宜的店(原作里她本来就常常只能在便宜地方解决)。
 *
 * `kcal` 走 `stats.js` 的 `mealCost()`(`热量 × 1.5` 厄里斯),**不另立一套价**。
 */
export const EATERIES = [
  {
    id: 'street',
    // 快饿死了才走最便宜那条路 —— 前提起点(她说出地点时才有画面)。
    when: (satiety) => satiety < 12,
    place: GAMEPLAY_CONTENT.eateries[0].place,
    food: GAMEPLAY_CONTENT.eateries[0].food,
    kcal: 450,
    line: GAMEPLAY_CONTENT.eateries[0].line,
  },
  {
    id: 'guild',
    when: (satiety) => satiety < 25,
    place: GAMEPLAY_CONTENT.eateries[1].place,
    food: GAMEPLAY_CONTENT.eateries[1].food,
    kcal: 600,
    line: GAMEPLAY_CONTENT.eateries[1].line,
  },
  {
    id: 'bakery',
    when: () => true,
    place: GAMEPLAY_CONTENT.eateries[2].place,
    food: GAMEPLAY_CONTENT.eateries[2].food,
    kcal: 400,
    line: GAMEPLAY_CONTENT.eateries[2].line,
  },
];

/** 不饿时她可能在忙什么(`life` 那一档)。阶段 3 会把它们升级成"未解决的小事件"。
 *
 * ⚠️ 1.85.0 起每条都带 `place`(场所 id,见 `src\world.js` 的 `PLACES`)——
 *    她自己活动时**写一条位置事实**,页面与 QQ 报幕都读那一份。
 *    加了新活动**必须同时给它一个场所**,否则 `whereaboutsFromDecision()` 会返回 null
 *    (页面就只能说"不知道她在哪" —— 那是刻意的:不许写一条错的地点)。
 *
 * ⚠️ 1.91.0 起每条**还要带 `stat`**(这件事**动哪个数**)—— 它是元素连接图里
 *    "数值"这类连接的**唯一来源边**:图**不猜**、也不另抄一份效果表,
 *    只读这一行(见 `src\elements.js` 的 `activity:* → stat:*`)。
 *    `story: true` = "这条活动长成一张场景卡"(她自己会去处理的小事)
 *    —— ⚠️ **1.106.0 / D172 起它还是"抛不抛事件钩子"的闸门**:标了的抛钩子等回应,
 *    没标的就只是"她在干嘛"(报备一句)。见 `isStoryActivity()`。
 *
 * ⚠️ 1.92.0(D148):从 5 条扩到 13 条 —— 用户 2026-10-07「先把世界系统做好」。
 *    原来那 5 条轮换几下就被看穿了;加了新活动**必须同时给它一个场所与一个数值**,
 *    否则 `whereaboutsFromDecision()` 返回 null(页面只能说"不知道她在哪")。
 */
export const LIFE_ACTIVITIES = [
  { id: 'wand', place: 'home', placeName: GAMEPLAY_CONTENT.lifeActivities[0].placeName, stat: 'mana', line: GAMEPLAY_CONTENT.lifeActivities[0].line },
  { id: 'bath', place: 'home', placeName: GAMEPLAY_CONTENT.lifeActivities[1].placeName, stat: 'stamina', line: GAMEPLAY_CONTENT.lifeActivities[1].line },
  { id: 'nap', place: 'home', placeName: GAMEPLAY_CONTENT.lifeActivities[2].placeName, stat: 'stamina', line: GAMEPLAY_CONTENT.lifeActivities[2].line },
  { id: 'laundry', place: 'home', placeName: GAMEPLAY_CONTENT.lifeActivities[3].placeName, stat: 'mood', line: GAMEPLAY_CONTENT.lifeActivities[3].line },
  { id: 'pack', place: 'home', placeName: GAMEPLAY_CONTENT.lifeActivities[4].placeName, stat: 'mood', line: GAMEPLAY_CONTENT.lifeActivities[4].line },
  { id: 'count_coin', place: 'home', placeName: GAMEPLAY_CONTENT.lifeActivities[5].placeName, stat: 'mood', line: GAMEPLAY_CONTENT.lifeActivities[5].line },
  { id: 'board', place: 'guild', placeName: GAMEPLAY_CONTENT.lifeActivities[6].placeName, stat: 'mood', story: true, line: GAMEPLAY_CONTENT.lifeActivities[6].line },
  { id: 'library', place: 'guild', placeName: GAMEPLAY_CONTENT.lifeActivities[7].placeName, stat: 'mana', line: GAMEPLAY_CONTENT.lifeActivities[7].line },
  { id: 'brag', place: 'guild', placeName: GAMEPLAY_CONTENT.lifeActivities[8].placeName, stat: 'mood', line: GAMEPLAY_CONTENT.lifeActivities[8].line },
  { id: 'canteen_water', place: 'canteen', placeName: GAMEPLAY_CONTENT.lifeActivities[9].placeName, stat: 'satiety', line: GAMEPLAY_CONTENT.lifeActivities[9].line },
  { id: 'market', place: 'market', placeName: GAMEPLAY_CONTENT.lifeActivities[10].placeName, stat: 'mood', story: true, line: GAMEPLAY_CONTENT.lifeActivities[10].line },
  { id: 'window_shop', place: 'market', placeName: GAMEPLAY_CONTENT.lifeActivities[11].placeName, stat: 'mood', line: GAMEPLAY_CONTENT.lifeActivities[11].line },
  { id: 'riverbank', place: 'fishing', placeName: GAMEPLAY_CONTENT.lifeActivities[12].placeName, stat: 'mood', line: GAMEPLAY_CONTENT.lifeActivities[12].line },
];

/** 按"她缺多少"挑一家店(纯函数,`random` 可注入)。 */
export function pickEatery(satiety) {
  const value = Number(satiety) || 0;
  const candidates = EATERIES.filter((row) => row.when(value));
  return candidates[0] ?? EATERIES[EATERIES.length - 1];
}

/** 按随机源挑一件"她在忙的事"(纯函数)。 */
export function pickActivity(random = Math.random) {
  const index = Math.min(
    LIFE_ACTIVITIES.length - 1,
    Math.max(0, Math.floor(random() * LIFE_ACTIVITIES.length)),
  );
  return LIFE_ACTIVITIES[index];
}

/**
 * **这条活动要不要长成"未解决的小事件"**(纯函数;1.106.0 / D172)。
 *
 * 用户 2026-10-02 要的"随机事件钩子"是 `life` 那一档的**一种**走法,不是**唯一**走法 ——
 * 原来的代码把两者当成同一件事(`life` → 一律抛钩子),于是那 13 条多场景活动
 * **从来没有进过她的嘴**(只写进了"她在哪"的事实,只在页面上看得见)。
 *
 * 判据就是活动表里那一列 `story`(它在 `src\elements.js` 的元素连接图里本来就有用途):
 *   ① `story: true`(去公会看板 / 去市集逛)—— 抛钩子,等回应,超时自决;
 *   ② 其余 —— 就是"她在干嘛",**不抛钩子、不开状态机**,台词走 `buildSelfCarePrompt`。
 *
 * ⚠️ 认不出来**不当钩子**(fail closed:宁可少抛一次,也别把一条普通活动挂成一个悬着的事件)。
 */
export function isStoryActivity(activity) {
  return activity?.story === true;
}

/**
 * **这一句该发去哪**(纯函数;1.106.0 / D172)。
 *
 * 用户 2026-10-10 的原话:「**试一下能不能接上私聊报备/群聊自发发言**」。所以按**这一句是什么**分:
 *   · `eat` / `arrive` = **报备**(她自己的事有个结果要交代)→ **私聊操作者**优先;
 *   · `life`(活动报备与事件钩子)= **自发发言**(她自己过日子被撞见)→ **已知安静群**优先,
 *     一个安静的群都没有时**回落私聊**(而不是不说话 —— 沉默不是"接上了")。
 *
 * ⚠️ 这里**只决定"发去哪"**,配额/睡眠/别插嘴那些闸门都在调用方(`selfCareTick` 那一套)。
 * ⚠️ `spontaneousTo: 'c2c'` 是**回退开关**:所有主动消息都走私聊(1.106.0 之前的老行为)。
 */
export function pickReportScene({ action, hasC2c = false, quietGroups = [], spontaneousTo = 'group' } = {}) {
  const spontaneous = action === 'life';
  const groupFirst = spontaneous && spontaneousTo !== 'c2c';
  if (groupFirst) {
    if (quietGroups.length > 0) return 'group';
    return hasC2c ? 'c2c' : null;
  }
  if (hasC2c) return 'c2c';
  return quietGroups.length > 0 ? 'group' : null;
}

/**
 * **安静群该怎么排队**(纯函数;1.106.1 / D173)。
 *
 * 用户 2026-10-10:「有个只有机器人的三人测试群,在那个群测试就行」+「有的群聊这几天完全没有暖群过」。
 * 查现场时抓到这条排序**本来就会挑错群**:老规则是"**最久没说过话**的群优先",而那正是
 * **你已经不用的死群** —— 她会对着一只没人看的群自言自语,你在活跃的群里什么也看不到。
 *
 * 新口径两条:
 *   ① **最近还活跃过、且已经安静够久**的群优先(仍要过 `quietMs`:别插正在说话的群);
 *   ② `preferred` 指定一个群(env `QQBOT_SELFCARE_GROUP`)—— 它是**测试 / 指定用途**的硬钉子:
 *      排在第一位,而且**不要求它此刻在已知群清单里**(`knownGroups()` 只认"本次进程收到过消息"
 *      的群,重启就重置 —— 而一个全是机器人的测试群可能永远不满足这一条)。
 *      ⚠️ 但**它正热闹时不硬插**:那条 `quietMs` 一样管它(其余群照旧排队)。
 *
 * ⚠️ `lastHumanAt` = 该群**最后一次真人说话**的时刻(0 / null = 本次进程还没见过人说话)。
 * ⚠️ 算不出来一律当"安静"(`0`)—— 宁可多说一句,也别把目标算没了。
 *
 * @param {{groups?: Array<{id: string, lastHumanAt?: number|null}>, quietMs?: number,
 *   now?: number, preferred?: string}} [input]
 * @returns {string[]} 排好序的群 id(第一个就是目标;空数组 = 一个都不能发)
 */
export function orderSelfCareGroups({ groups = [], quietMs = 0, now = Date.now(), preferred = '' } = {}) {
  const pin = String(preferred ?? '').trim();
  const rows = (Array.isArray(groups) ? groups : [])
    .map((row) => ({ id: String(row?.id ?? ''), lastHumanAt: Number(row?.lastHumanAt) || 0 }))
    .filter((row) => row.id !== '');
  const isQuiet = (row) => now - row.lastHumanAt >= Math.max(0, Number(quietMs) || 0);
  // ① 已知的安静群:最近还活跃过的排前面(死群垫底)
  const rest = rows
    .filter((row) => row.id !== pin && isQuiet(row))
    .sort((a, b) => b.lastHumanAt - a.lastHumanAt)
    .map((row) => row.id);
  if (pin === '') return rest;
  // ② 指定群:认得出它的 lastHumanAt 就用真的,认不出(不在本次进程的已知清单里)当安静
  const pinned = rows.find((row) => row.id === pin) ?? { id: pin, lastHumanAt: 0 };
  if (!isQuiet(pinned)) return rest;   // 那个群正热闹 → 不硬插,照旧排队
  return [pin, ...rest];
}

/**
 * **她自己写下的那条"她在哪"要有效多久**(纯函数;1.106.0 / D172)。
 *
 * ⚠️ 为什么必须派生:位置事实的 `until` 是 30 分钟,而她两次 `life` 之间**至少** `lifeEveryMs`
 *    (惠惠配的是 3 小时)—— 于是下一次 `decideSelfCare()` 读 `currentPlace` 时那条事实
 *    **早就过期了**,"她挑中的活动不在她现在这个地方 → 先走一趟"这条路**永远进不去**。
 *    现场(2026-10-10 查日志):`她自己出门` **0 次**、`她走到了` **0 次** ——
 *    1.95.1 交付的"她自己走一趟 + 到了报一句"**从来没在线上跑过**。
 *
 * 口径:生活那一档的事实要**撑到下一次轮到她**(`lifeEveryMs`)再多一点余量(`whereTtlMs`);
 * 吃饭那一档**不延长**(她饿了就吃,吃完那 30 分钟的事实过期就过期 —— 那一档本来也不走"路上")。
 * ⚠️ 这不是新数字:两边都是**已有的配置值**派生出来的。
 */
export function whereaboutsTtlMs({ action, whereTtlMs = 30 * 60_000, lifeEveryMs = 3 * 60 * 60_000 } = {}) {
  const base = Math.max(60_000, Number(whereTtlMs) || 0);
  if (action !== 'life') return base;
  return base + Math.max(0, Number(lifeEveryMs) || 0);
}

/**
 * **"到达报备"的新鲜窗口**(纯函数;1.106.0 / D172)。
 *
 * ⚠️ 这是同一条死链的第二截:出发那句会占掉"两条主动消息至少隔 `gapMs`"的配额,
 *    所以到达报备**最早**只能在落地后 `gapMs - travelMs` 才轮到 ——
 *    而 `decideArrivalReport()` 原来的新鲜窗口**写死 30 分钟**。
 *    惠惠的 `gapMs` 是 45 分钟 → 配额还没放开,这一趟就"不新鲜"了 → **永远报不出来**。
 *
 * 口径:**新鲜窗口不能比配额闸门还短**(取两者较大的那个),否则"到了再补一句"这句设计是自相矛盾。
 */
export function arrivalFreshnessMs({ gapMs = 0, baseMs = 30 * 60_000 } = {}) {
  return Math.max(Math.max(0, Number(baseMs) || 0), Math.max(0, Number(gapMs) || 0));
}

/**
 * **走到了**要不要自己冒一句(1.92.1 / D149;纯函数)。
 *
 * 用户 2026-10-07 选的"补 A 的尾巴":她会走去别的地方,但**走完那一趟从来不吭声** ——
 * 玩家只会在页面上看到她换了地方。这一条让"她出门/她回来了"也进她的**报备**那一族。
 *
 * ⚠️ 它**只管"该不该报"**,不管"怎么发"(发去哪、配额、睡眠时段都在调用方那套闸门里)。
 * ⚠️ 判据(缺一个就不报):
 *   ① 那条事实得是**她自己走到的**(`why === 'self'`)—— 玩家点「去XX」是**人拉着她**,
 *      那一趟不该由她当成"我自己出门了"来报(那是编排,不是她自己过日子);
 *   ② 刚落地 **`withinMs` 之内**(再晚就不新鲜了,报出来像延迟通知);
 *   ③ 这一次到达**还没报过**(`reportedAt`)—— 同一个地方不重复报,免得每次 tick 都来一句;
 *   ④ 她**不在路上**(在途那份没有 `arrivedAt`,自然报不了)。
 *
 * @param {object|null} fact `world:her` 那条事实
 * @param {{now?: number, withinMs?: number}} [options]
 * @returns {null | {placeId: string, placeName: string, since: number, line: string}}
 */
export function decideArrivalReport(fact, { now = Date.now(), withinMs = 30 * 60_000 } = {}) {
  if (!fact || typeof fact !== 'object') return null;
  if (fact.to) return null;                       // 还在路上
  if (fact.why !== 'self') return null;           // 不是她自己走到的(玩家让她去的)
  const arrivedAt = Number(fact.arrivedAt);
  if (!Number.isFinite(arrivedAt)) return null;
  if (Number(fact.reportedAt) >= arrivedAt) return null;  // 这一次到达已经报过
  if (now - arrivedAt > withinMs) return null;    // 太久了:不新鲜
  const place = placeById(fact.place);
  if (!place) return null;                        // 认不出场所 —— 不猜
  return {
    placeId: place.id,
    placeName: place.name,
    since: arrivedAt,
    line: `刚走到了${place.name}`,
  };
}

/**
 * 走到地方那一句该怎么跟她说(**纯函数**)。
 *
 * ⚠️ 与 `buildSelfCarePrompt` 同一族:事实由代码给(到了哪儿、什么时候到的),
 * 台词是她的。⚠️ **不是**"报告"——是一句自己嘟囔,所以不许写成通知体(有测试钉着)。
 */
export function buildArrivalReportPrompt({ scene, arrival, silentToken = '[跳过]' }) {
  const heard = scene === 'c2c' ? '[私聊]' : '[群聊]';
  return gameplayText(GAMEPLAY_CONTENT.selfcareText.arrival, { heard, placeName: arrival.placeName, silentToken });
}

/**
 * **她自己出门**那一句该怎么跟她说(纯函数;1.95.1 / D151)。
 *
 * ⚠️ 与"到达报备"是一对:这一句是**出发时**说的(或者干脆不说 —— 她也可以安静地走),
 *    到点落地之后由 `buildArrivalReportPrompt` 再说一句"到了"。
 * ⚠️ 提示词里**不许报时间数字**(那是代码的事):只说"你要去哪儿、干什么"。
 */
export function buildTravelReportPrompt({ scene, activity, placeName = null, silentToken = '[跳过]' }) {
  const heard = scene === 'c2c' ? '[私聊]' : '[群聊]';
  return gameplayText(GAMEPLAY_CONTENT.selfcareText.travel, { heard, placeName: placeName ?? '另一个地方',
    activitySuffix: activity?.line ? `，${activity.line}` : '', silentToken });
}

/** 睡眠时段(自带一份,口径与 `stats.js` 的 `isAsleep` 一致:支持跨午夜)。 */
export function isAsleepAt(hour, sleep) {
  if (!sleep || sleep.start === sleep.end) return false;
  return sleep.start < sleep.end
    ? hour >= sleep.start && hour < sleep.end
    : hour >= sleep.start || hour < sleep.end;
}

/**
 * 现在该不该"她自己过日子"?**纯函数** —— 这是本模块的核心判据。
 *
 * @param {{now?: number, stats?: object, lastHumanAt?: number|null, lastProactiveAt?: number|null,
 *   sleep?: object|null, random?: () => number, options?: object, currentPlace?: string|null}} ctx
 *   `lastHumanAt` = 最后一次**真人说话**的时刻(群里那条"读空气"用的是同一个概念);
 *   `lastProactiveAt` = 上一次**她自己主动开口**的时刻(配额闸门);
 *   `currentPlace` = **她此刻在哪个场所**(1.95.1 起:她挑中的活动不在那儿时,先走一趟)。
 * @returns {{action: 'eat', eatery: object}|{action: 'life', activity: object}
 *   |{action: 'travel', activity: object}|{action: 'arrive', arrival: object}|null}
 */
export function decideSelfCare({
  now = Date.now(),
  stats = {},
  lastHumanAt = null,
  lastProactiveAt = null,
  sleep = null,
  random = Math.random,
  options = {},
  currentPlace = null,
} = {}) {
  const cfg = { ...SELFCARE_DEFAULTS, ...options };

  // ① 睡眠时段:谁也不说话。
  if (isAsleepAt(new Date(now).getHours(), sleep)) return null;

  // ② 别人刚说过话 → 这不是"没人互动",别插嘴(真人还在你一句我一句的时候尤其)。
  //    ⚠️ `lastHumanAt === null`(**进程刚起来,还没见过任何人说话**)按"就是现在"算 ——
  //    否则每次重启都会在 30 秒内冒出一条报备(1.48.0 第一次真启动的现场就是这样:
  //    她刚上线就去公会食堂吃了顿定食,趁群里一个人都还没说话)。
  const sinceHuman = lastHumanAt === null ? 0 : now - lastHumanAt;
  if (sinceHuman < cfg.quietMs) return null;

  // ③ 主动消息配额闸门:刚开口过就先等着。
  if (lastProactiveAt !== null && now - lastProactiveAt < cfg.gapMs) return null;

  // ④ **饿了 → 去吃饭**(用户点名的那条,优先级最高)。
  const satiety = Number(stats.satiety) || 0;
  if (satiety < cfg.hungryBelow) return { action: 'eat', eatery: pickEatery(satiety) };

  // ⑤ 不饿:偶尔冒个泡说说自己在干嘛,但比吃饭稀得多。
  //    ⚠️ **这一档的两道闸门(`lifeEveryMs` / `lifeChance`)现在也管"出门"** ——
  //    1.95.1 复核抓到:第一版把"她自己出门"放在这两道闸门**之前**,于是 24 小时里
  //    主动消息从 ~8 条涨到 ~58 条,而 `life` 那一档(事件钩子的来源)被挤到几乎没有。
  //    "出门"本来就是 `life` 那一档的一种走法,闸门必须一致。
  if (lastProactiveAt !== null && now - lastProactiveAt < cfg.lifeEveryMs) return null;
  if (random() >= cfg.lifeChance) return null;

  // ⑤-b ⚠️ **她自己走一趟**(1.95.1 / D151):"她自己去公会看板"以前是**瞬移** ——
  //    位置事实直接写成"她在公会",一步到位。世界里明明有路上那几分钟(1.92.0)却没人用。
  //    现在:她挑中的活动**不在她此刻待的地方**时,先**出发**(带 `arriveAt`),到点由 tick 落地,
  //    落地后她会自己说一句(到达报备,D149)。这就是那条"她自己动"的闭环。
  //    ⚠️ **吃饭不走这条路**(她饿了就得马上吃,不是"路上五分钟")。
  //    ⚠️ 认不出她此刻在哪(没有事实)→ **不猜**,照老样子直接写活动事实。
  //    ⚠️ 她**已经在路上**时也不出门(上面那些闸门管走完之后的下一趟;在途由 tick 收尾)。
  const here = String(currentPlace ?? '');
  const picked = pickActivity(random);
  if (here && picked?.place && picked.place !== here) {
    return { action: 'travel', activity: picked };
  }

  return { action: 'life', activity: picked };
}

/**
 * 「她自己的这一轮」该怎么跟她说 —— 事实由**代码**给(吃了什么、花了多少、在忙什么),
 * 台词仍然是她的(角色卡说了算)。**纯函数**。
 *
 * ⚠️ 两条口径:
 *   · **报备要具体**:地点 + 吃了什么/在做什么 —— 否则"我去吃饭了"读起来像系统通知;
 *   · **钱不许报数字**(D42/D44):说"钱包又轻了"可以,说"花了 900 厄里斯"不行。
 *
 * @param {{scene: 'c2c'|'group', action: 'eat'|'life', eatery?: object, activity?: object,
 *   cost?: number, currency?: string, silentToken?: string}} ctx
 */
export function buildSelfCarePrompt({ scene, action, eatery, activity, cost = 0, currency = CURRENCY.name, silentToken = '[跳过]' }) {
  const heard = scene === 'c2c' ? '[私聊]' : '[群聊]';
  const text = GAMEPLAY_CONTENT.selfcareText;
  const facts = action === 'eat'
    ? gameplayText(text.eatFacts, { place: eatery.place, food: eatery.food, currency })
    : gameplayText(text.lifeFacts, { line: activity.line });
  const framing = gameplayText(scene === 'c2c' ? text.c2c : text.group, { heard });
  return [framing, '', facts, '', gameplayText(text.silent, { silentToken })].join('\n');
}
