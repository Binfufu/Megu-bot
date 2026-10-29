/**
 * 当前角色的身体状态:饱食度 / 健康值 / 心情值。
 *
 * 为什么要这三个数:在此之前"饿"是模型**当场编**的 —— 说十次饿也没有后果,
 * 喂她也没有反馈,互动没有闭环。有了数值之后:
 *
 *   吃 → 饱食度↑ → 她不再频繁讨饭
 *   饿久了 → 饱食度↓ → 健康↓ → 语气变虚脱
 *   被喂 / 被夸 → 心情↑ → 情绪池偏元气、温柔
 *   被戳 / 被凶 → 心情↓ → 情绪池偏懒散、易怒
 *
 * 本文件**全是纯函数**:时间推进、进食、互动、描述。持久化交给调用方
 * (现在是 SQLite 的 `stats` 行 + `stats_event` 流水),所以这里可以直接单测。
 *
 * 数值口径见 D28;面向用户的说明在 `.env` 的 `QQBOT_STATS_*`。
 */

import { MEGUMIN_BODY, describeValue, labelFor, longLabelFor } from './body-theme.js';
// **两套数值框架**(2026-10-28 主人拍板):生物体/机械体各一套;这里只取默认(生物体)。
import { BIOLOGICAL_RULES } from './body-rules.js';
// 数值 × 模块的**绑定表**(D102):`applyStory()` 在落账前用它过滤越界字段。
import { filterEffectByBinding } from './stat-binding.js';
// **隐藏状态档位**(D103):健康/心情不再报数字,提示词里换成"病着/养病中/狂喜…"这类状态。
import { describeCondition, tier10 } from './condition.js';
import { log } from './log.js';
import { GAMEPLAY_CONTENT, gameplayText } from './local-gameplay-content.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 三个数值的名字,顺序即展示顺序。 */
export const STAT_KEYS = ['satiety', 'health', 'mood', 'stamina', 'mana'];

/**
 * **货币**(D99,2026-10-02):跟世界观统一 —— 原作的**通用货币**。
 *
 * 用户给的口径锚点(照抄):「科技水平类似 12 世纪神圣罗马帝国时期的意大利。
 * **货币通用货币与现代日元等值**。30 万通用货币相当于 2 万人民币……
 * **个人做一次任务相当于美国建筑工人 10 天的薪酬**……按这样的话,**物价就可以参考现代日本了**。」
 *
 * 于是本文件里所有钱的刻度都按 **1 通用货币 ≈ 1 日元** 重标(旧刻度 ×100)。
 * ⚠️ 单位名只在这里写一次:`describe*` / 横幅 / `/钱包` / 报表都从这里取。
 */
export const CURRENCY = GAMEPLAY_CONTENT.currency;

/** 全新一份状态的起点。`stamina`/`mana` 是 2026-10-01 加的(D83);`money` 按通用货币重标(D99)。 */
export const STAT_DEFAULTS = BIOLOGICAL_RULES.defaults;

/** 初始值:不饿不撑、身体尚可、心情平常、兜里有 **2,000 通用货币**(≈ 两顿定食)。 */
export const STAT_MIN = 0;
export const STAT_MAX = 100;

/**
 * 钱 —— **第四个数值**,但不在 0–100 的"感觉"刻度上(D42)。
 *
 * 为什么单独一套上下限:钱要**能攒**。攒不起来的数值撑不起"接委托赚钱"这条玩法,
 * 而且"吾有 3,200 通用货币"比"吾有 37%"像人话。
 * ⚠️ D99 起上限从 **999 → 9,999,999**:通用货币口径下,一次 hard 委托就是 8~20 万,
 * 999 连一次委托都装不下。
 */
export const MONEY_MIN = 0;
export const MONEY_MAX = 9_999_999;
/** 低于这个数才算"真穷" —— **只有这时才允许她提穷**(D42 的核心机制)。1,500 通用货币 ≈ 一顿定食。 */
export const MONEY_POOR = 1_500;

/**
 * 开销速率:**钱会自己变少** —— 这是"穷"能成立的前提。
 *
 * 照饱食度那套(读的时候按经过时间补算),理由相同:定时器会在重启/休眠/时钟跳变时
 * 丢账,而**读的时候补算**不会。
 *
 * 口径(D99 按通用货币/现代日本重标):**清醒 150/小时(住宿·杂用·魔杖保养油),睡觉 80/小时**
 * —— 一天约 **2,970 通用货币**,和"两顿定食 + 一点杂用"同一个量级。
 */
export const MONEY_DECAY = BIOLOGICAL_RULES.moneyDecay;

/**
 * 吃一顿**要花钱**(D99 起按通用货币重标):`ceil(kcal × 1.5)`。
 *
 * 为什么是这个系数:锚点说物价照**现代日本**,而日本一顿**定食(600 kcal 上下)≈ 900 日元** ——
 * 于是"热量 × 1.5" 同时满足了两件事:① 一条公式(和"热量 ÷ 25 = 饱食度"那种做法同族,D42);
 * ② 定食/快餐/零食的相对贵贱**天然有序**(热量是价钱的第一近似)。
 * ⚠️ 偏差照实说:**泡面**(450 kcal)会被算成 675 通用货币,而实际便利店只要 250 上下 ——
 * 想要准就得给 `FOOD_TABLE` 加第二套价,先不做(见 D99 第八节"否掉的方案")。
 */
export const ERIS_PER_KCAL = BIOLOGICAL_RULES.meal.erisPerKcal;

/** 没人理她时心情慢慢回到这个基线 —— 既不会无限掉,也不会自己涨满。 */
export const MOOD_BASELINE = 60;

/**
 * 衰减速率("温和"档:一天两顿正餐刚好维持)。
 *
 * 心跳不是定时器,而是**读的时候按经过时间补算** —— 所以重启、休眠、时钟跳变
 * 都不会让数值停住,也不会丢;代价是每次读要跑一遍时间积分。
 */
export const DECAY = BIOLOGICAL_RULES.decay;

/** 热量换饱食度:一顿 600 kcal ≈ +24,单次最多 +40。 */
export const KCAL_PER_SATIETY = 25;
/** 吃东西**回体力**的折算:每点饱食度换这么多体力(一顿 +24 饱食 ≈ +12 体力)。 */
export const STAMINA_PER_SATIETY = 0.5;
export const MAX_SATIETY_PER_MEAL = 40;
/** 单次能接受的热量上限 —— 防止模型写出离谱的数字。 */
export const MAX_KCAL = 2000;
/** 单次进食对健康和心情的影响上限。 */
export const MAX_HEALTH_PER_MEAL = 3;
export const MAX_MOOD_PER_MEAL = 10;
/** 时间积分的上限:停机太久就只补算这么多,免得空转几万次。 */
export const MAX_CATCHUP_MS = 14 * DAY_MS;

const clamp = (value) => Math.max(STAT_MIN, Math.min(STAT_MAX, value));
/** 钱是另一套刻度(0–`MONEY_MAX`,能攒),不能和那三个一起 clamp。 */
const clampMoney = (value) => Math.max(MONEY_MIN, Math.min(MONEY_MAX, value));

/**
 * 一次互动的效果与冷却:被夸能涨心情,但刷不动。
 *
 * ⚠️ 2026-10-01(D83)起,**体力与魔力也在这张表里** —— 用户原话:
 * 「体力和魔力的数值也要加上(这两个数值也要能被互动和亲密互动影响)」。
 * 于是"被搭话""亲密互动""放了技能"都是这张表里的普通一行,数值规则**不写进提示词**。
 */
export const INTERACTIONS = {
  // ⚠️ **2026-10-02(D96)改过一版**:原来这一行是 `{ mood: 5, money: 3, mana: 2 }` ——
  //    用户的现场感受是「被夸等等场景加**奇奇怪怪的数值**」。被夸给钱、给魔力在两处都不自洽:
  //    钱是"有人对她好"的回报(`fed` 那一笔已经承担了),魔力是**放技能的资源**
  //    (要回魔得靠亲密互动/药剂/时间),夸两句就涨魔力等于把资源闸门拆了。
  //    现在**只涨心情** —— 只留下"被夸会开心"这一件说得通的事。
  praise: { mood: 5, cooldownMs: 5 * 60_000, label: GAMEPLAY_CONTENT.interactionLabels.praise },
  poked: { mood: -2, stamina: -1, cooldownMs: 60_000, label: GAMEPLAY_CONTENT.interactionLabels.poked },
  ignored: { mood: -3, stamina: -2, cooldownMs: 6 * 60 * 60_000, label: GAMEPLAY_CONTENT.interactionLabels.ignored },
  // 被投喂**不给钱**(D99,用户原话:「正常投喂不应该加钱」)——
  // 钱只从她的世界来(公会委托),也只回她的世界去(商店/餐厅)。见下面 `fed` 的注释。
  fed: { mood: 6, stamina: 8, cooldownMs: 5 * 60_000, label: GAMEPLAY_CONTENT.interactionLabels.fed },
  chat: { mana: 2, stamina: -1, cooldownMs: 60_000, label: GAMEPLAY_CONTENT.interactionLabels.chat },
  intimate: { mood: 8, stamina: 10, mana: 12, cooldownMs: 5 * 60_000, label: GAMEPLAY_CONTENT.interactionLabels.intimate },
  explosion: { stamina: -20, mana: -55, cooldownMs: 0, label: GAMEPLAY_CONTENT.interactionLabels.explosion },
  rest: { mood: 3, stamina: 6, cooldownMs: 0, label: GAMEPLAY_CONTENT.interactionLabels.rest },
};

/**
 * **亲密互动**的关键词(2026-10-01,D83)。
 *
 * ⚠️ 这是**私聊里的事**,不进任何日志正文;这里只负责"归类",数值才是它的用途。
 * 词表刻意短而明确:宁可漏(少回一次魔力),不要误伤日常话(把"抱一下"之外的都算上就滥了)。
 */
export const INTIMATE_KEYWORDS = [
  '亲亲', '亲一下', '吻', '抱抱', '抱紧', '抱着', '搂', '蹭蹭', '蹭', '摸摸', '摸头', '贴贴',
  '舔', '揉', '捏', '捏捏', '伸手进', '脱', '色色', '涩涩', '做爱', '上床', '睡我', '睡了你',
  '舌', '胸', '腿', '腰', '屁股', '里面', '进来', '吻我', '要你',
  // 「汲取人类精血」那一族(用户 2026-10-01 定的口径):亲密互动**补体力也补魔力**。
  '精血', '吸血', '汲取', '榨', '补魔',
];

/** 这句话算不算亲密互动?(纯函数;归类用,不存原文) */
export function isIntimate(text) {
  const source = String(text ?? '');
  if (source === '') return false;
  return INTIMATE_KEYWORDS.some((word) => source.includes(word));
}

/**
 * **药剂**(2026-10-01 用户要的:「喝魔力药剂这种也能补体力/补魔」)。
 *
 * ⚠️ 效果与价格**全在代码里**(和吃饭同一条规矩:模型只负责"这是什么",换算与封顶由代码定),
 * 所以"喝一瓶回多少"不会每次不一样。钱不够照喝(账会记负),和吃饭一致。
 */
export const POTIONS = {
  // 价钱按通用货币重标(D99):现代日本口径下,消耗品的药剂大致是几千日元这一档。
  mana: { label: GAMEPLAY_CONTENT.potionDisplay.mana.label, mana: 45, stamina: 5, cost: 1_800, tag: GAMEPLAY_CONTENT.potionDisplay.mana.tag },
  stamina: { label: GAMEPLAY_CONTENT.potionDisplay.stamina.label, stamina: 40, mana: 0, cost: 1_200, tag: GAMEPLAY_CONTENT.potionDisplay.stamina.tag },
};

/** 从一句话里认出喝的是什么药(纯函数)。认不出来返回 null。 */
export function detectPotion(text) {
  const source = String(text ?? '');
  if (source === '') return null;
  // 先认魔力侧(「魔力药剂」也含"药剂",所以要排在体力侧前面判)。
  if (/魔力药|魔法药|蓝药|玛娜药|mp药|ＭＰ药/i.test(source)) return 'mana';
  if (/体力药|能量饮料|红牛|力药|耐力药|恢复药/i.test(source)) return 'stamina';
  return null;
}

/**
 * 喝一瓶药剂:按 `POTIONS` 的固定数值结算,并记一条流水。
 * @param {object} stats
 * @param {'mana'|'stamina'} kind
 * @param {number} now
 */
export function applyPotion(stats, kind, now) {
  const rule = POTIONS[kind];
  if (!rule) return { stats, event: null };
  const before = {
    stamina: Number(stats?.stamina) || 0,
    mana: Number(stats?.mana) || 0,
    money: Number(stats?.money) || 0,
  };
  const next = {
    ...stats,
    stamina: clamp(before.stamina + (rule.stamina ?? 0)),
    mana: clamp(before.mana + (rule.mana ?? 0)),
    money: clampMoney(before.money - (rule.cost ?? 0)),
    updatedAt: now,
  };
  return {
    stats: next,
    event: {
      kind: 'potion',
      ts: now,
      satietyDelta: 0,
      healthDelta: 0,
      moodDelta: 0,
      staminaDelta: next.stamina - before.stamina,
      manaDelta: next.mana - before.mana,
      moneyDelta: next.money - before.money,
      detail: { potion: kind, label: rule.label, cost: rule.cost },
    },
  };
}

/** 全新的一份状态。 */
export function createStats(now, rules = null) {
  const profile = rules ?? BIOLOGICAL_RULES;
  return {
    ...profile.defaults,
    updatedAt: now,
    // ⚠️ 每种互动的冷却时间戳都**必须在这里落地**:老代码读不到字段时 `now - undefined`
    //    会变成 NaN,而 `NaN < cooldown` 是 false —— 冷却被静默绕过(见 applyInteraction)。
    lastPraiseAt: 0,
    lastPokeAt: 0,
    lastIgnoredAt: 0,
    lastChatAt: 0,
    lastIntimateAt: 0,
    lastExplosionAt: 0,
  };
}

/**
 * 把状态按经过的时间往前推。
 *
 * 逐小时积分(跨小时边界切段),因为睡眠时段与"饿着掉健康"都跟**钟点**有关:
 * 不能拿两个时间点一减了事。
 *
 * @param {object} stats
 * @param {number} fromTs 上次结算时刻(`stats.updatedAt`)
 * @param {number} toTs 现在
 * @param {{sleep?: {start: number, end: number}|null}} [options]
 * @returns {object} 新的状态(不修改入参)
 */
export function advanceStats(stats, fromTs, toTs, { sleep = null, rules = null } = {}) {
  // ⚠️ `null` 与 `undefined` 一样回落到生物体:旧调用方/测试构造 store 时不传框架。
  const profile = rules ?? BIOLOGICAL_RULES;
  const decay = profile.decay;
  const moneyDecay = profile.moneyDecay;
  const start = Math.max(Number(fromTs) || 0, (Number(toTs) || 0) - MAX_CATCHUP_MS);
  if (!(toTs > start)) return { ...stats, updatedAt: toTs };

  const current = { ...stats };
  let cursor = start;

  while (cursor < toTs) {
    const step = new Date(cursor);
    const hourStart = step.getHours();
    step.setMinutes(60, 0, 0); // 下一个整点(跨小时自动进位)
    const stepEnd = Math.min(toTs, step.getTime());
    const hours = (stepEnd - cursor) / HOUR_MS;
    const asleep = isAsleep(hourStart, sleep);

    current.satiety = clamp(
      current.satiety - ((asleep ? decay.satietyPerHourAsleep : decay.satietyPerHourAwake)) * hours,
    );

    if (current.satiety < decay.starvingBelow) {
      current.health = clamp(current.health - decay.healthPerHourStarving * hours);
    } else if (asleep) {
      current.health = clamp(current.health + decay.healthPerHourAsleep * hours);
    }

    // 体力:醒着慢慢耗,睡着回(所以"熬夜聊天"是真的会累)。
    current.stamina = clamp(
      (Number(current.stamina) || 0)
      + ((asleep ? decay.staminaPerHourAsleep : -decay.staminaPerHourAwake)) * hours,
    );
    // 魔力:自然回复 —— 这是"技能不能连发"的根源(放一发 −55,回 5/小时)。
    current.mana = clamp((Number(current.mana) || 0) + decay.manaPerHour * hours);

    const drift = decay.moodPerHourToBaseline * hours;
    current.mood = current.mood > MOOD_BASELINE
      ? clamp(Math.max(MOOD_BASELINE, current.mood - drift))
      : clamp(Math.min(MOOD_BASELINE, current.mood + drift));

    // 钱也按时间走 —— 这是"穷"能成立的前提。注意它**只减不补**:
    // 补钱要靠事件(投喂/接委托/小事件),否则钱就变成又一个自己回满的数值。
    // ⚠️ 2026-10-28(两套框架):机械体 `moneyDecay.enabled=false` —— 不产生货币开销。
    if (moneyDecay.enabled !== false) {
      current.money = clampMoney(
        (Number(current.money) || 0) - (asleep ? moneyDecay.perHourAsleep : moneyDecay.perHourAwake) * hours,
      );
    }

    cursor = stepEnd;
  }

  current.updatedAt = toTs;
  return current;
}

/** 睡眠判定(自带一份,避免 stats.js 依赖 warmup.js 的解析细节)。 */
function isAsleep(hour, sleep) {
  if (!sleep || sleep.start === sleep.end) return false;
  return sleep.start < sleep.end
    ? hour >= sleep.start && hour < sleep.end
    : hour >= sleep.start || hour < sleep.end;
}

/**
 * 吃一顿。
 *
 * 分工是刻意的:**模型只负责它才能做的事**(这是什么食物、大概多少热量),
 * **换算与封顶在代码里**(`kcal / 25`、单次上限、上下限裁剪)——
 * 数值规则不该写进提示词,否则每次都可能不一样。
 *
 * **谁付钱**(D97,2026-10-02):`intake.paidBy === 'other'` = **别人请的** ——
 * 那一顿**不扣她的钱**,并且套用「被投喂」那笔进项(+8 枚,带冷却);
 * 其它情况(她自己花钱吃的)= 扣 `ceil(kcal / 25)`,而且**不套用「被投喂」**
 * (以前无条件套,于是"她自己吃饭"也冒 8 枚钱 —— 那是语义错,不是数值调参)。
 * 钱不够也照吃(总不能饿死),但账会记成负的 —— 于是"穷"是真的会来的。
 *
 * @param {object} stats
 * @param {{food?: string, kcal?: number, health?: number, mood?: number, source?: string,
 *   paidBy?: 'other'|'self'}} intake
 * @param {number} now
 */
export function applyMeal(stats, intake, now, rules = null) {
  const profile = rules ?? BIOLOGICAL_RULES;
  const kcal = Number.isFinite(Number(intake?.kcal))
    ? Math.max(0, Math.min(MAX_KCAL, Number(intake.kcal)))
    : 0;
  const satietyGain = Math.min(kcal / (rules?.meal?.kcalPerSatiety ?? KCAL_PER_SATIETY), (rules?.meal?.maxSatietyPerMeal ?? MAX_SATIETY_PER_MEAL));
  const healthHint = Number.isFinite(Number(intake?.health))
    ? Math.max(-MAX_HEALTH_PER_MEAL, Math.min(MAX_HEALTH_PER_MEAL, Number(intake.health)))
    : 0;
  const moodHint = Number.isFinite(Number(intake?.mood))
    ? Math.max(-MAX_MOOD_PER_MEAL, Math.min(MAX_MOOD_PER_MEAL, Number(intake.mood)))
    : 0;
  /** 别人请的 → 免单,而且只有这一种情况套「被投喂」。 */
  const gift = intake?.paidBy === 'other';
  // 机械体没有货币概念:一份"餐"照换算电量,但**不产生任何金额变动**。
  const moneyEnabled = rules?.meal?.moneyEnabled !== false;
  const cost = gift || !moneyEnabled ? 0 : mealCost(kcal, rules);

  const fed = gift ? applyInteraction(stats, 'fed', now) : { stats, event: null };
  const beforeMoney = Number(fed.stats.money) || 0;
  // ⚠️ **账分两层,别混**(测试的注释早就这么写了,但当时"被投喂那笔"其实没落账):
  //    别人请的那一顿里的"被投喂"是**另一笔 `kind='fed'` 的流水**,由 `fedEvent` 带出去;
  //    `event`(kind='meal')只记**这一顿饭本身**的钱/心情/体力变化。
  const beforeStamina = Number(fed.stats.stamina) || 0;
  const money = moneyEnabled ? clampMoney(beforeMoney - cost) : beforeMoney;
  // 吃东西也**回体力**(2026-10-01 用户要的):按"吃饱了多少"折算,吃饱越多越有劲。
  const next = {
    ...fed.stats,
    satiety: clamp(fed.stats.satiety + satietyGain),
    health: clamp(fed.stats.health + healthHint),
    mood: clamp(fed.stats.mood + moodHint),
    stamina: clamp(beforeStamina + satietyGain * STAMINA_PER_SATIETY),
    money,
    updatedAt: now,
  };
  return {
    stats: next,
    event: {
      kind: 'meal',
      ts: now,
      satietyDelta: satietyGain,
      healthDelta: healthHint,
      moodDelta: moodHint,
      staminaDelta: next.stamina - beforeStamina,
      moneyDelta: money - beforeMoney,
      detail: {
        food: intake?.food ?? null,
        kcal,
        cost,
        paidBy: gift ? 'other' : 'self',
        source: intake?.source ?? 'unknown',
      },
    },
    /** 「被投喂」那一笔(单独落账,别让它只改状态不记流水)。只有别人请的才有。 */
    fedEvent: fed.event,
  };
}

/**
 * **一次事件的数值结果**(D99 阶段 3)。用户原话:「事件**一定要有结果**(可改变数值)」。
 *
 * 与 `applyMeal` / `applyInteraction` 同一族:**数值在代码里**,模型只挑"哪一档走向"
 * (`<story outcome="…"/>`),换算与封顶由这里做。所以"这次到底亏了多少"不会每次不一样。
 *
 * @param {object} stats
 * @param {{money?: number, mood?: number, stamina?: number, satiety?: number, health?: number}} effect
 * @param {number} now
 * @param {{id?: string, line?: string, branch?: string}} [detail]
 * @returns {{stats: object, event: object|null}} 全是 0 时 `event` 是 null(但调用方仍会记一条"无变化")
 */
export function applyStory(stats, effect = {}, now, detail = {}) {
  // ⚠️ **数值 × 模块的绑定表在落账前执行**(D102):越界的字段**被丢掉**并记一条 warn。
  //    于是"绑定的模块 100% 不改变无关数值"是代码保证的 —— 不是靠写代码的人记得。
  const { effect: bounded, dropped } = filterEffectByBinding(detail.kind ?? 'story', effect, detail);
  if (dropped.length > 0) {
    log?.warn?.(
      `数值绑定：${detail.kind ?? 'story'} 不许改 ${dropped.join('/')}，已丢弃（见 docs\\03 D102）`,
    );
  }
  const before = {
    money: Number(stats?.money) || 0,
    mood: Number(stats?.mood) || 0,
    stamina: Number(stats?.stamina) || 0,
    satiety: Number(stats?.satiety) || 0,
    health: Number(stats?.health) || 0,
    mana: Number(stats?.mana) || 0,
  };
  const clampEffect = (value, limit) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(-limit, Math.min(limit, number));
  };
  // 单次事件的幅度上限:钱 ±50,000(比 hard 委托低一档,免得"日常小事"比大活还赚),
  // 其余五项按 STAT_MAX 之内、单次最多 ±30(魔力也是 0–100 的刻度)。
  const money = clampMoney(before.money + clampEffect(bounded.money, 50_000));
  const mood = clamp(before.mood + clampEffect(bounded.mood, 30));
  const stamina = clamp(before.stamina + clampEffect(bounded.stamina, 30));
  const satiety = clamp(before.satiety + clampEffect(bounded.satiety, 30));
  const health = clamp(before.health + clampEffect(bounded.health, 30));
  const mana = clamp(before.mana + clampEffect(bounded.mana, 30));
  const next = { ...stats, money, mood, stamina, satiety, health, mana, updatedAt: now };
  const event = {
    kind: detail.kind ?? 'story',
    ts: now,
    satietyDelta: satiety - before.satiety,
    healthDelta: health - before.health,
    moodDelta: mood - before.mood,
    staminaDelta: stamina - before.stamina,
    manaDelta: mana - before.mana,
    moneyDelta: money - before.money,
    detail: { ...detail, effect: bounded, ...(dropped.length > 0 ? { droppedStats: dropped } : {}) },
  };
  return { stats: next, event };
}

/** 一顿饭要花多少**通用货币**。0 热量 = 0(不算吃饭的那一轮不该扣钱)。 */
export function mealCost(kcal, rules = BIOLOGICAL_RULES) {
  const value = Number(kcal);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.round(value * (rules?.meal?.erisPerKcal ?? ERIS_PER_KCAL)));
}

/**
 * 一次互动(被夸 / 被戳 / 被冷落 / 被投喂)。
 *
 * 带冷却:夸她两句能让她高兴,但**刷不动** —— 否则同一句夸奖喊十遍就满了。
 * 钱同样受冷却约束(被夸 +3 有 5 分钟冷却),所以它也不是刷钱的入口。
 */
export function applyInteraction(stats, kind, now) {
  const rule = INTERACTIONS[kind];
  const touched = rule
    ? ['mood', 'money', 'stamina', 'mana'].some((field) => (rule[field] ?? 0) !== 0)
    : false;
  if (!rule || !touched) return { stats, event: null };

  // ⚠️ 冷却字段**按 kind 生成**(以前是三个 kind 的硬编码三元):加了新的互动种类
  //    (chat / intimate / explosion)之后,那种写法会静默复用别人的冷却。
  const field = `last${kind[0].toUpperCase()}${kind.slice(1)}At`;
  // ⚠️ 冷却比较必须**显式**处理 NaN:旧库读出来的状态(或任何漏了字段的调用方)会让
  // `now - undefined` 变成 NaN,而 `NaN < cooldown` 是 **false** —— 冷却就被静默绕过了。
  // 这条约束是"夸她两句能让她高兴,但刷不动",绕过它等于把数值的闸门拆了。
  const since = Number(stats?.[field]);
  if (rule.cooldownMs > 0 && Number.isFinite(since) && now - since < rule.cooldownMs) {
    return { stats, event: null };
  }

  const moneyDelta = rule.money ?? 0;
  const before = {
    money: Number(stats?.money) || 0,
    stamina: Number(stats?.stamina) || 0,
    mana: Number(stats?.mana) || 0,
  };
  const money = clampMoney(before.money + moneyDelta);
  const stamina = clamp(before.stamina + (rule.stamina ?? 0));
  const mana = clamp(before.mana + (rule.mana ?? 0));
  const next = {
    ...stats,
    mood: clamp((stats?.mood ?? MOOD_BASELINE) + (rule.mood ?? 0)),
    stamina,
    mana,
    money,
    [field]: now,
    updatedAt: now,
  };
  return {
    stats: next,
    event: {
      kind,
      ts: now,
      satietyDelta: 0,
      healthDelta: 0,
      moodDelta: rule.mood ?? 0,
      staminaDelta: stamina - before.stamina,
      manaDelta: mana - before.mana,
      moneyDelta: money - before.money,
      detail: { label: rule.label },
    },
  };
}

/**
 * 钱的一次增减(接委托、小事件、被请客)。**记流水**,和进食/互动同一个事务里提交。
 *
 * 这是"公会接任务赚钱"与"随机小事件"落地的唯一入口 —— 于是所有钱的来路都可查。
 */
export function applyMoney(stats, delta, now, detail = {}) {
  const before = Number(stats?.money) || 0;
  const money = clampMoney(before + (Number(delta) || 0));
  const actual = money - before;
  return {
    stats: { ...stats, money, updatedAt: now },
    event: actual === 0 ? null : {
      kind: detail.kind ?? 'money',
      ts: now,
      satietyDelta: 0,
      healthDelta: 0,
      moodDelta: 0,
      moneyDelta: actual,
      detail,
    },
  };
}

// ---------------------------------------------------------------------------
// 描述:给模型看的、给人看的
// ---------------------------------------------------------------------------

// 措辞从 `body-theme.js` 取:同一套数值机制,当前角色说"饱食度",协作角色说"电量"。
// 三个 `describe*` 保留原签名(不传主题 = 当前角色那套),所以老调用与老测试一行不用改。

/** 饱食度/电量的一句话解读 —— 她会照着这个说话。 */
export function describeSatiety(value, theme = MEGUMIN_BODY) {
  return describeValue('satiety', value, theme);
}

export function describeHealth(value, theme = MEGUMIN_BODY) {
  return describeValue('health', value, theme);
}

export function describeMood(value, theme = MEGUMIN_BODY) {
  return describeValue('mood', value, theme);
}

/**
 * 钱的一句话解读。**只有真穷才允许她说穷**(D42)—— 这是那段话术的唯一依据。
 * ⚠️ 刻度按通用货币重标(D99):门槛是"还能不能吃上一顿"(1,500 ≈ 一顿定食)。
 */
export function describeMoney(value) {
  const number = Number(value) || 0;
  if (number <= 0) return GAMEPLAY_CONTENT.moneyLabels[0];
  if (number < MONEY_POOR) return GAMEPLAY_CONTENT.moneyLabels[1];
  if (number < 4_000) return GAMEPLAY_CONTENT.moneyLabels[2];
  if (number < 12_000) return GAMEPLAY_CONTENT.moneyLabels[3];
  if (number < 40_000) return GAMEPLAY_CONTENT.moneyLabels[4];
  return GAMEPLAY_CONTENT.moneyLabels[5];
}

/** 钱够不够吃这一顿 —— 给提示词与 `/钱包` 用。 */
export function canAfford(stats, kcal) {
  return (Number(stats?.money) || 0) >= mealCost(kcal);
}

/** 放一发技能要多少魔力(与 `INTERACTIONS.explosion.mana` 的绝对值一致)。 */
export const EXPLOSION_MANA_COST = 55;

/**
 * 注入提示词的一行身体状态。
 *
 * 明确标注"不要念出来" —— 它是**给她的感觉**,不是台词。数值本身对群里人是隐形的
 * (要报数由后面的"日志机器人"负责,和角色分开)。
 *
 * 钱那一项后面挂了一句**行为约束**:穷是数值,但"什么时候提穷"得说清楚 ——
 * 否则模型会把"手头紧"当成每轮都可以抱怨的素材,那就退回改之前的样子了。
 */
export function describeForPrompt(stats, theme = MEGUMIN_BODY, {
  condition = null, now = Date.now(), explosionEnabled = true, moneyEnabled = true,
} = {}) {
  const round = (n) => Math.round(n);
  // ⚠️ **健康与心情不再报数字,改成"隐藏状态档位"**(D103,用户 2026-10-02:
  //    「数值直接换成隐藏状态档位」)。数值仍在库里(时间衰减要用),但**不进她的眼睛** ——
  //    她看到的是"健康/病着/养病中"与"平和/失落/狂喜"这类**状态**。
  const conditionLine = describeCondition({
    health: stats.health,
    mood: stats.mood,
    condition,
    now,
    theme,
  });
  const parts = [
    `${longLabelFor('satiety', theme)} ${round(stats.satiety)}/100（${describeSatiety(stats.satiety, theme)}）`,
    conditionLine,
    // 体力 / 魔力(用户 2026-10-01 要的)。魔力那一项挂一句**行为约束**:
    // 不够就放不出技能 —— 否则她会对着"魔力 8/100"照样喊 Explosion。
    `${longLabelFor('stamina', theme)} ${round(stats.stamina ?? STAT_DEFAULTS.stamina)}/100` +
    `（${describeValue('stamina', stats.stamina ?? STAT_DEFAULTS.stamina, theme)}）`,
    // ⚠️ 2026-10-28(P4):爆裂那条**只给开这个玩法的实例**——机械体没有技能,
    //    以前无条件写"魔力不够放技能了",协作角色会照着说(串味)。
    //    关掉时只报资源值本身(仍然知道"能源多少"),不加任何爆裂约束。
    `${longLabelFor('mana', theme)} ${round(stats.mana ?? STAT_DEFAULTS.mana)}/100` +
    `（${describeValue('mana', stats.mana ?? STAT_DEFAULTS.mana, theme)}）` +
    (explosionEnabled
      ? `—— ${Number(stats.mana ?? STAT_DEFAULTS.mana) < EXPLOSION_MANA_COST
        ? gameplayText(GAMEPLAY_CONTENT.statsText.manaLow, { cost: EXPLOSION_MANA_COST })
        : GAMEPLAY_CONTENT.statsText.manaEnough}`
      : ''),
  ];
  // 钱这一行包含"什么时候可以提穷"的行为约束 —— 没有货币概念的实例(机械体)整行不给。
  if (moneyEnabled && Number.isFinite(Number(stats.money))) {
    const poor = Number(stats.money) < MONEY_POOR;
    parts.push(
      `钱 ${Math.round(Number(stats.money))} ${CURRENCY.name}（${describeMoney(stats.money)}）` +
      `—— ${poor
        ? '确实很穷,可以抱怨、可以想赚钱'
        : '**手头不紧,这一轮不要提穷、不要讨钱、也别装穷**'}`,
    );
  }
  return parts.join('、');
}

/**
 * `/状态` 命令与日志机器人用的一段(含最近一次进食 / 充电)。
 *
 * ⚠️ 2026-10-01(D85):用户要「每个词条都要**各占一行**方便阅读」——
 * 所以从 `【状态】饱食 60/100 · 健康 80/100 · …` 改成一行一项。
 */
export function describeForUser(stats, { lastMealAt = null, lastFood = null, theme = MEGUMIN_BODY } = {}) {
  // ⚠️ **前端不再显示数值**(D103,用户 2026-10-02:「数值前端显示可以全部砍了,全部隐藏,
  //    保留后端计算数字的同时,五个数值的显示**全部用十个档位的形容词代替**」)。
  //    所以这里只说词 —— 数字照旧在库里算,`/状态` 不再是报表。
  // ⚠️ **口径跟着主题走**:协作角色是**日志机器人**,报数字是她的本职工作 ——
  //    所以"前端只用形容词"这条**只管有血肉的那只**(megumin);机械口径照旧报数。
  const show = (key, value) => (theme?.id && theme.id !== 'megumin'
    ? `${Math.round(Number(value) || 0)}/100`
    : tier10(key, value));
  const items = [
    `${labelFor('satiety', theme)} ${show('satiety', stats.satiety)}`,
    `${labelFor('health', theme)} ${show('health', stats.health)}`,
    `${labelFor('mood', theme)} ${show('mood', stats.mood)}`,
    `${labelFor('stamina', theme)} ${show('stamina', stats.stamina ?? STAT_DEFAULTS.stamina)}`,
    `${labelFor('mana', theme)} ${show('mana', stats.mana ?? STAT_DEFAULTS.mana)}`,
  ];
  if (Number.isFinite(Number(stats.money))) items.push(`${CURRENCY.name} ${Math.round(Number(stats.money))}（钱照旧报数：它是账目，不是感觉）`);
  const lines = ['【状态】', ...items];
  if (Number.isFinite(lastMealAt)) {
    const at = new Date(lastMealAt).toTimeString().slice(0, 5);
    lines.push(`上次${theme.action.short}：${at}${lastFood ? ` ${lastFood}` : ''}`);
  }
  return lines.join('\n');
}

/** `/钱包` 用的一份收支说明。 */
/**
 * 状态增量的**显示顺序**(固定,免得同一批数字每次排得不一样)。
 * 钱在最后:`金币` 不是身体数值,是另一套刻度。
 */
export const STAT_DELTA_ORDER = ['satiety', 'health', 'mood', 'stamina', 'mana', 'money'];

/**
 * 把这一轮的状态变化渲染成**回复末尾那一行**(2026-10-01,D87)。**纯函数**。
 *
 * 用户原话:
 * > 「每次都 @ /状态 好像有点繁琐了,我感觉可以针对性地对**状态提升之后的回复**,
 * > 换行加一个`【某状态】+N`」,例子:
 * > ```
 * > 这个魔力药水我全喝完了,也才加了一点点魔力,不愧是我
 * > [魔力+N]
 * > ```
 *
 * 几条口径:
 *   · **只打有变化的**(全是 0 就返回空串 —— 不许每轮挂一个空 `[]` 刷屏);
 *   · 同一轮里多笔变化**合并求和**(被搭话 +2 与喝药 +45 会写成 `魔力+47`);
 *   · 涨跌都打(`+`/`-`):技能那种 −55 也要看得见,不然只有好事才报数;
 *   · **这行由代码拼** —— 数值不许交给模型自己编。
 *
 * @param {Array<object>} deltas 每笔变化(`{satiety, health, mood, stamina, mana, money}`)
 * @param {{theme?: object}} [options]
 * @returns {string} 例如 `[魔力+45 体力+5]`;没有变化时是空串
 */
export function renderStatDeltas(deltas, { theme = MEGUMIN_BODY } = {}) {
  if (!Array.isArray(deltas) || deltas.length === 0) return '';
  const totals = {};
  for (const delta of deltas) {
    if (!delta) continue;
    for (const key of STAT_DELTA_ORDER) {
      // 两种写法都认:事件里叫 `manaDelta`(与 stats_event 的列一致),也可以直接给 `mana`。
      const value = Number(delta[`${key}Delta`] ?? delta[key]);
      if (Number.isFinite(value) && value !== 0) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  const parts = [];
  for (const key of STAT_DELTA_ORDER) {
    const value = Math.round(totals[key] ?? 0);
    if (value === 0) continue;
    const label = key === 'money' ? CURRENCY.name : labelFor(key, theme);
    parts.push(`${label}${value > 0 ? '+' : ''}${value}`);
  }
  return parts.length === 0 ? '' : `[${parts.join(' ')}]`;
}

export function describeWallet(stats) {
  const money = Math.round(Number(stats?.money) || 0);
  const state = describeMoney(money);
  const rate = money < MONEY_POOR
    ? GAMEPLAY_CONTENT.statsText.poorRate
    : GAMEPLAY_CONTENT.statsText.comfortableRate;
  return `【钱包】${money} ${CURRENCY.name}（${state}）\n` +
    `开销：清醒 ${MONEY_DECAY.perHourAwake}/小时、睡觉 ${MONEY_DECAY.perHourAsleep}/小时；` +
    `吃东西另外按热量花钱\n${rate}`;
}

// ---------------------------------------------------------------------------
// 进食识别:模型回报的机器可读块 + 纯文字兜底
// ---------------------------------------------------------------------------

/** `<intake food="炸鸡" kcal="620" health="-2" mood="6"/>` */
const INTAKE_BLOCK = /<intake\b([^>]*)\/?>/i;

/**
 * **"这不是吃的"的否决标记**(2026-10-09)。
 *
 * ⚠️ 为什么需要它 —— 用户当天报的现场:「叫她记名字、评论一张**蟑螂图**的时候莫名其妙加饱食度」。
 *    日志对得上:`10/8 17:18:31 收到群聊消息(非@) … 文字=0 图片=1`(图是窗内补进来的)→
 *    `17:20:17 进食:投喂 300kcal(image,别人请的:免单)→ 饱食 100(+12.0)`。
 *    根因是 `detectFeeding()` 把"**这一轮带图**"当成投喂的最强判据,而且 `feedingNote()`
 *    还**反过来命令**她"图里的吃食就是你现在吃到的东西、不许说图不能吃" —— 于是蟑螂被当成一口饭。
 *
 * 这一条**不是**把"带图 = 投喂"删掉(那是 D96 为"被投喂 100% 有数值"定的保证,单测钉着),
 * 而是给模型一个**否决口**:它真看过图,由它说"这图不是吃的"。
 * 它**只能否决带图那条兜底**;明确的投喂说法(`[投喂 X]` / "请你吃…")照样结算 —— 否则又回到
 * 2026-10-02 那个"十次里九次没反应"的 bug。
 */
const INTAKE_REJECT = /<intake\b[^>]*\breject\b[^>]*\/?>/i;

/** 这一轮模型有没有明确说"这不是吃的"(纯函数)。 */
export function rejectsIntake(text) {
  return INTAKE_REJECT.test(String(text ?? ''));
}

/** 从回复里取出进食信息,并把这一段**从要发出去的文字里去掉**。 */
export function extractIntake(text) {
  const source = String(text ?? '');
  const match = INTAKE_BLOCK.exec(source);
  if (!match) return { intake: null, text: source };

  // ⚠️ **否决标记不是一份进食数据**(2026-10-09):`<intake reject/>` 会让 `INTAKE_BLOCK` 命中,
  //    但它没有 `kcal`、也不该被当成"模型报了数值" —— 所以这里直接当成"没有进食信息",
  //    只把标记从正文里剥掉(`rejectsIntake()` 单独判它)。
  if (/\breject\b/i.test(match[1])) {
    const rest = source.replace(INTAKE_BLOCK, '').replace(/[ \t]+$/gm, '').trim();
    return { intake: null, text: rest };
  }

  const attrs = {};
  for (const item of match[1].matchAll(/([a-zA-Z_]+)\s*=\s*"([^"]*)"/g)) {
    attrs[item[1].toLowerCase()] = item[2];
  }
  const intake = {
    food: typeof attrs.food === 'string' ? attrs.food.slice(0, 40) : null,
    kcal: Number(attrs.kcal),
    health: attrs.health === undefined ? 0 : Number(attrs.health),
    mood: attrs.mood === undefined ? 0 : Number(attrs.mood),
  };
  const rest = source.replace(INTAKE_BLOCK, '').replace(/[ \t]+$/gm, '').trim();
  return { intake, text: rest };
}

/**
 * 这一轮**是否可能涉及吃东西** —— 决定那个 `<intake>` 块算不算数。
 *
 * 不加这道闸,模型随手写个 `kcal="9999"` 就能把数值刷满;加了之后,
 * 至少得是"带了图片"或"文字里提到吃喝"的回合才会被采纳。
 *
 * ⚠️ **2026-10-23 收窄**:删掉单字"食/饭" —— 太宽(「食堂」「粮食」「米饭」这类泛词
 * 也开门)。自带条目的复合词(零食/夜宵/外卖)不受影响;"请客/投喂/吃/喝/饿"是真场景,保留。
 */
export function looksLikeEating(text, { hasImage = false } = {}) {
  if (hasImage) return true;
  return /吃|喝|饿|餐|厨|外卖|零食|夜宵|请客|投喂|尝|味道|好吃/.test(String(text ?? ''));
}

/** 常见食物的粗略热量表 —— 纯文字说"我吃了泡面"时的兜底(认图走模型)。 */
export const FOOD_TABLE = [
  { match: /泡面|方便面/, food: '泡面', kcal: 450, health: -1, mood: 4 },
  { match: /炸鸡|鸡排|薯条/, food: '炸物', kcal: 600, health: -2, mood: 7 },
  { match: /汉堡|快餐/, food: '汉堡', kcal: 550, health: -2, mood: 6 },
  { match: /披萨|比萨/, food: '披萨', kcal: 700, health: -2, mood: 8 },
  { match: /蛋糕|甜点|冰淇淋|布丁/, food: '甜点', kcal: 350, health: -1, mood: 9 },
  { match: /奶茶|可乐|汽水/, food: '甜饮料', kcal: 250, health: -1, mood: 6 },
  { match: /米饭|盖饭|便当|盒饭/, food: '米饭', kcal: 500, health: 1, mood: 4 },
  { match: /面|拉面|乌冬/, food: '面', kcal: 480, health: 1, mood: 4 },
  { match: /沙拉|蔬菜|青菜|水果|苹果|香蕉/, food: '蔬果', kcal: 150, health: 2, mood: 2 },
  { match: /鱼|肉|牛排|烤肉/, food: '肉', kcal: 550, health: 1, mood: 6 },
  { match: /汤|粥/, food: '汤粥', kcal: 200, health: 1, mood: 3 },
  { match: /面包|吐司|三明治/, food: '面包', kcal: 300, health: 0, mood: 3 },
  { match: /酒|啤酒|红酒/, food: '酒', kcal: 180, health: -2, mood: 5 },
  { match: /蘑菇|野菜/, food: '野味', kcal: 120, health: 2, mood: 3 },
];

/** 从纯文字里猜一顿。猜不到返回 null。 */
export function estimateFromText(text) {
  const haystack = String(text ?? '');
  for (const row of FOOD_TABLE) {
    if (row.match.test(haystack)) {
      return { food: row.food, kcal: row.kcal, health: row.health, mood: row.mood, source: 'keyword' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 投喂:由**代码**保证"被投喂就一定结算数值"(2026-10-02,D96)
// ---------------------------------------------------------------------------

/**
 * **为什么需要这一块** —— 用户 2026-10-02 的现场感受:
 * > 「当前角色现在在会话里遇到被用户投喂/请吃饭的情景时**经常不加饱食度**等数值,
 * >   反而在被夸等等场景加**奇奇怪怪的数值**。当前角色应该在被图片/文本投喂互动之后
 * >   回应并 **100% 加/减数值**,否则互动感大打折扣。」
 *
 * 量出来的证据(当前角色 2026-10-02 的 `data\megumin\bridge.log`):
 * **79 个带图回合里只有 8 个(10.1%)真的结算了数值** —— 也就是说"给她发吃的"这件事,
 * 十次里有九次**什么反馈都没有**。
 *
 * **根因不是模型态度不好,而是判据押在了模型身上**:改造之前,只有两条路会结算 ——
 *   ① 模型自己在回复末尾写 `<intake …/>`(实测只有约一成回合写);
 *   ② `estimateFromText()` 在**用户那句话**里命中 `FOOD_TABLE` 的食物名词。
 * 于是「我请你吃饭」「给你点了外卖」这类**明明白白的投喂**一个词都对不上(表里只有
 * 泡面/炸鸡/披萨……),而带图不说话的那种连文字都没有 —— **两条路同时落空**。
 *
 * 这条正好撞在本项目自己的规矩上(`docs\00`):「概率/随机这类要**稳定复现**的行为
 * 不许靠提示词许愿」。所以修法不是把提示词写得更凶,而是**把判据搬回代码**:
 * "这一轮是投喂"由 `detectFeeding()` 判,判中了就**一定**有一笔数值,模型写不写 `<intake>` 只是
 * 精度更高的一层(它真看过图,所以它的估计优先)。
 *
 * ⚠️ 与 `looksLikeEating()` 的分工**别混**:
 *   · `looksLikeEating()` 是**宽**的(含"饿""外卖"这类词;2026-10-23 起删了单字"食/饭"),
 *     它只用来决定"要不要教模型写 `<intake>`",
 *     以及"模型写了 `<intake>` 到底算不算数"(防伪造);
 *   · `detectFeeding()` 是**窄**的(食物名词 / 明确的投喂话 / 有图),它才决定"要不要真的结算"。
 *   —— 混用会让「吾好饿」这种抱怨也喂她一顿(+12 饱食),那不是互动感,那是刷数值。
 */
/**
 * 「有人在投喂她」的**说法**表(纯文字那一半)。
 *
 * ⚠️ **这批词是照真实聊天记录捞出来的**(当前角色 `data\megumin\memory.db` 里 `user_text`),
 * 不是拍脑袋想的一串近义词 —— 群里真正出现过的形状有:
 *
 * | 现场原话 | 靠哪条命中 |
 * |---|---|
 * | `[投喂一斤俄罗斯大列巴]` `[投喂大便]`(群里的主力写法,方括号是动作标记) | `/投喂/` |
 * | `我请你们吃` | `请(你\|妳\|您\|你们\|大家\|客\|她\|他)…吃` |
 * | `请你吃典明粥` `请你吃这个` | 同上 |
 * | `那我喂你[烤串递到嘴边]啊张嘴` | `/喂(你\|妳\|我)/` + `/递到…嘴边/` |
 * | `剩下的给你全吃完` | `给(你\|妳…)…吃`(**中间允许夹 1~3 个字**) |
 * | `她不喝给你喝` `全部给你喝了` | 同上 |
 * | `帮我吃完` | `/帮(我\|你\|妳)…(吃\|喝)/` |
 *
 * ⚠️ **刻意不命中的**同样是真实记录:「到底吃不吃」「吃」「吃老干妈」「我吃你踩过的」
 * 「又喝拿铁了」「吃早餐去了」—— 那些是**群里别人自己的饭**,不是给她的。
 * 「喂，你在干嘛」里的"喂"是**语气词**(所以要求后面紧跟你/我),「请问吃什么」是
 * **提问**(所以 `请` 后面必须是人称词)。
 */
export const FEED_INTENT = [
  /投喂|投食|喂食/,
  /喂(你|妳|我)/,
  /请(你|妳|您|你们|大家|客|她|他)[^。！？\n]{0,4}(吃|喝|尝)/,
  /请客|请吃|请喝/,
  /给(你|妳|她|他)[^。！？\n]{0,3}(吃|喝|尝)/,
  /(带|拿|留|送)(给)?(你|妳|她|他)[^。！？\n]{0,2}(吃|喝)/,
  /(递|送|塞)到(你|妳|她|他)?(嘴|口)边/,
  /帮(我|你|妳)[^。！？\n]{0,3}(吃|喝)/,
  /拿去(吃|喝)/,
  /尝(尝|一口)/,
  /(吃|喝)(这个|那个|一口|点)/,
  /外卖|夜宵|宵夜|加餐|开饭|下馆子|打牙祭/,
];

/** 一句话里有没有"有人在投喂"的明确说法(纯函数)。 */
export function looksLikeFeeding(text) {
  const source = String(text ?? '');
  if (source === '') return false;
  return FEED_INTENT.some((pattern) => pattern.test(source));
}

/**
 * 认不出具体食物时的**兜底一顿**:300 kcal ≈ +12 饱食,不撑也不亏。
 *
 * 刻意取小:`detectFeeding()` 会在"带图但不说话"这种最常见的投喂上用它,
 * 而**每一次投喂都会走这个兜底** —— 取大了饱食度会长期顶在 100,数值就不再是信息了。
 * 认得出具体食物时(`FOOD_TABLE` / 模型的 `<intake>`)用它自己那个热量,不走这里。
 */
export const FEED_DEFAULT = { food: '投喂', kcal: 300, health: 0, mood: 5 };

/**
 * **投喂保底热量**:投喂回合里,模型给的热量低于这个数(或给了 0)时,按这个数算。
 *
 * 理由:用户要的是"100% 加/减数值" —— 模型写 `<intake kcal="0"/>`(一杯水)或者
 * 热量填了个离谱的小数时,结算出来是 +0 饱食,回复末尾那行 `[…]` 还是不出来,
 * 等于"系统看着像没反应"。150 kcal = **+6 饱食**,是"这一口真的算数"的下限。
 */
export const FEEDING_FLOOR_KCAL = 150;

/** 兜底那一顿按口径改名(当前角色是"投喂",协作角色是"充电")。 */
function feedDefault(theme = MEGUMIN_BODY) {
  const food = theme?.id === 'aris' ? '充电' : FEED_DEFAULT.food;
  return { ...FEED_DEFAULT, food };
}

/**
 * 从"投喂"那句话里**把投喂物的名字捞出来**(D98,纯函数)。捞不到返回 null。
 *
 * 为什么非要有它:本轮注入的那句"有人投喂你 X"里 X 是空的,她就只能自由发挥 ——
 * 现场(2026-10-02 本地 20:45)有人 @她发 `[投喂 宿舍的零食]`,
 * 而**窗内补进来的旧图是一盘肉**,于是她答「这**盘肉**看着还算有点诚意」——
 * 票投的是零食,吃的是三天前那张图。(用户原话:「又把图片的肉吃了」。)
 *
 * 只认三种**结构明确**的形状(宁可不出名字,也不要从一句话里瞎猜一个名词出来):
 *   · `[投喂 宿舍的零食]` → `宿舍的零食`(群里最常用的动作标记写法)
 *   · `请你吃典明粥` → `典明粥`
 *   · `给你点了外卖` → `外卖`
 */
export function extractFeedItem(text) {
  const source = String(text ?? '');
  if (source === '') return null;
  const patterns = [
    /\[投喂\s*([^\]\n]{1,20})\]/,
    /请你(?:吃|喝|尝)\s*([^，。！？、\s\]\n]{1,12})/,
    /给你(?:带|拿|点|留|送)了?\s*([^，。！？、\s\]\n]{1,12})/,
  ];
  for (const pattern of patterns) {
    const matched = pattern.exec(source);
    const item = matched?.[1]?.trim();
    if (item) return item.slice(0, 20);
  }
  return null;
}

/**
 * **投喂的"给与"标记**(纯函数)。食物名词**必须**跟它同时出现才算投喂 ——
 * D102(2026-10-02)加的这条,是一个**真 bug** 换来的:
 *
 * 现场:群里有人说「带当前角色去**钓**鱼」→ `FOOD_TABLE` 的 `/鱼|肉|牛排|烤肉/` 命中「鱼」→
 * 于是记成"**她自己付钱吃了一份肉**":饱食 +22、体力 +11、**钱 −825**。
 * 用户的原话:「**现在数值加得太随便了**,你看群聊里刚叫去钓鱼就加了饱食度和体力、扣钱,完全不合理」。
 *
 * 判据从"有没有食物名词"改成"**有没有人在给她东西**":
 *   · 「给**你**带了炸鸡」✓(给你)   · 「我请**你们**吃」✓   · 「**投喂**零食」✓
 *   · 「带当前角色去钓鱼」✗(那边是"带 **当前角色**",不是在给)   · 「去钓鱼」✗   · 「我吃了泡面」✗(那是他自己吃)
 *
 * ⚠️ 代词必须跟着"给/请/送/投喂"出现 —— 单说"带"是不行的:
 * 第一版就写成 `/给|请|带|送|喂/`,而「带当前角色去钓鱼」里**有"带"**,又踩一遍同一个坑。
 */
export function hasFeedGift(text) {
  const source = String(text ?? '');
  if (source === '') return false;
  if (looksLikeFeeding(source)) return true;
  return /给(你|妳|她|他)|请(你|妳|您|你们|大家|客|她|他)|投喂|投食|喂(你|妳|我)|送(给)?(你|妳|她|他)/.test(source);
}

/**
 * 这一轮**是不是投喂**(纯函数)。判中了就一定会结算数值 —— 这是 D96 的核心保证。
 *
 * 判据从强到弱:
 *   ① **带了图片**(图已经进模型了,而"发图 = 投喂"是这个项目一开始的口径:
 *      `.env` 里写着「拍食物:她把食物/营养素/热量估出来」)→ 兜底一顿;
 *   ② 出现 `FEED_INTENT` 的投喂说法("我请你吃饭""给你点了外卖")→ 兜底一顿
 *      (**投喂物的名字用 `extractFeedItem()` 捞,捞到就写进 `food`**);
 *   ③ **食物名词 + "给与"标记**才算(见 `hasFeedGift`)—— 食物名词**单独出现什么都不算**。
 *
 * @param {string} text 用户这一轮说的话
 * @param {{hasImage?: boolean, theme?: object}} [options]
 * @returns {{food: string, kcal: number, health: number, mood: number, source: string}|null}
 */
export function detectFeeding(text, { hasImage = false, theme = MEGUMIN_BODY } = {}) {
  const item = extractFeedItem(text);
  const fromTable = estimateFromText(text);
  // ① 图 = 投喂(她吃的是图里那个东西;话里说了名字就用名字)
  if (hasImage) {
    if (item) return { ...feedDefault(theme), food: item, source: 'image' };
    return { ...feedDefault(theme), source: 'image' };
  }
  // ② 明确的投喂说法
  if (looksLikeFeeding(text)) {
    if (fromTable) return item ? { ...fromTable, food: item } : fromTable;
    return { ...feedDefault(theme), ...(item ? { food: item } : {}), source: 'feed-intent' };
  }
  // ③ 食物名词**只有**同时有"给与"标记才算(否则"去钓鱼""我吃了泡面"都会喂她一顿)
  if (fromTable && hasFeedGift(text)) return fromTable;
  return null;
}

/**
 * **被投喂时该跟她说什么**(D98,纯函数)—— 修的是"尴尬"那一半。
 *
 * 现场(用户 2026-10-02 原话):「有个群聊里发图+@ 当前角色吃,**回应图不能吃**,这个必须改,太尴尬了」。
 * 这不是偶发:`memory.db` 里她说过「**图又不能当饭吃**,来点真东西」「饿归饿,**这种图可填不饱肚子**」
 * 「那张图**能吃吗**」「这图,凡人看看就好」—— 系统性的。
 *
 * 根因:**从来没有人告诉过她"被投喂"是"你在吃这件事"**。每轮只注入了一个**格式**要求
 * (`<intake …/>`),而她的角色卡把人设写得很实(饿、穷、嘴硬),于是最自然的演法就是
 * "图是图,吃不到" —— 从纸面上完全说得通,从互动上完全失败。
 *
 * 所以这一条是**行为方向**(和 `style.js` 的风格提示同一类),不是数值规则:
 *   · **本轮投喂物有名有姓**:`[投喂 宿舍的零食]` → 「有人正在投喂你【宿舍的零食】」;
 *   · **带图那一路要点破"图里的吃食就是你现在吃到的东西"** —— 否则她按字面当"图";
 *   · **明令不许**说"这是图/图不能吃/填不饱肚子/吃不到",也不许怀疑食物是不是真的;
 *   · **窗内补图要标成背景**:那些图是**刚才**别人发过的,不是这一口 ——
 *     这正是"喂零食却吃了旧图的肉"那条(见 `extractFeedItem` 的注释)。
 *
 * @param {{text?: string, hasImage?: boolean, backgroundImages?: boolean, theme?: object}} [ctx]
 *   `backgroundImages` = 这一轮的图**不是**触发那条消息自带的(是窗内补进来的)。
 * @returns {string} 没有投喂信号时是空串(不占 token)
 */
export function feedingNote({ text = '', hasImage = false, backgroundImages = false, theme = MEGUMIN_BODY } = {}) {
  const detected = detectFeeding(text, { hasImage, theme });
  if (!detected) return '';
  const fromText = looksLikeFeeding(text);
  const named = detected.source === 'keyword' || detected.food !== feedDefault(theme).food
    ? `【${detected.food}】`
    : '';
  const parts = [
    fromText
      ? `有人正在**投喂**你${named || '一份吃的'} —— 这一轮你就是在吃／喝它。`
      : '对方发来的图就是**投喂**：图里的吃食就是你现在吃到的东西。'
        + '**除非**你看出图里根本不是吃的 —— 那走下面那条否决。',
    '直接从"吃到了什么、好不好吃、还想不想要"往下演；' +
    '**不许**说"这是图／图不能吃／填不饱肚子／吃不到"，也不许怀疑这份食物是不是真的 —— 收下就吃。',
  ];
  // ⚠️ **2026-10-09:给模型一个否决口**(见 `resolveIntake` 里 `modelSaysNotFood`)。
  //    只有"带图兜底"这一路才需要它:以前这里只教"图 = 投喂",于是**蟑螂图也被当成一口饭**
  //    (用户报的现场)。现在把"先看是不是吃的、不是就明确说一声"讲清楚,
  //    而且**必须给一个可机读的写法** —— 光说"不是就别吃"代码看不见。
  if (!fromText && detected.source === 'image') {
    parts.push(
      '如果图里**不是吃的**（虫子／梗图／截图／风景／别的东西）：这一轮**不要**当成吃饭，' +
      '照常吐槽或者回话就行；**并且在回复末尾单独写一个 `<intake reject/>`**（它不会发出去）。' +
      '只有真的是吃的、你也真的吃下去了，才照上面那条演。',
    );
  }
  if (backgroundImages) {
    parts.push(
      '（那几张图是**刚才**群里发过的，只算背景；你这一轮吃的是**当前这条消息**里的东西，' +
      '别把旧图里的东西当成现在这一口。）',
    );
  }
  return parts.join('');
}

/**
 * **她这句里有没有"在吃"的迹象**(纯函数,2026-10-09)。
 *
 * 用来决定"要不要替她补一句动作行" —— 用户的原话:「**要吃东西就说一声(在嚼小鱼干....)**」。
 * 现场:`22:43:38 meal 饱食+12` / `22:43:58 meal 饱食+12`(自发接话那两轮,窗内补进的图被当成投喂),
 * 而她**一个字都没说吃** → 用户在群里问「饱食度？你哪儿来的饭——说清楚」。
 *
 * ⚠️ **只认"吃的动作"**(吃/嚼/咬/咽/吞/尝/喝/舔/喂),**不认食物名词** ——
 *    「这鱼干咸得要命」是在评价食物,不是在吃(单测钉住)。
 */
export function mentionsEating(text) {
  return /吃|嚼|咬|咽|吞|尝|喝|舔|喂/.test(String(text ?? ''));
}

/**
 * **她没说吃就替她补一句动作行**(纯函数,2026-10-09;2026-10-23 收窄)。
 *
 * 理由见 `mentionsEating`:**数值动了,话里就得看得见** —— 不然用户只看到饱食度自己涨。
 * 她说了就不补(别抢她的语气)。
 *
 * ⚠️ **2026-10-23 主人拍板:万能句退役**。只有 `food` 认得出**有名有姓**时才补
 * 「（嚼着XX,含混地应了一声）」;认不出(含 `food='投喂'` 这种泛称)就**一个字不补** ——
 * 万能句没有信息量,反而让她嘴上反复"嚼东西"。数值可见性闲置期由 `/状态` 与网页面板兜底。
 *
 * @param {string} text 她这一轮的正文(已剥掉协议标记)
 * @param {{food?: string|null, satietyDelta?: number}} [meal] 这一轮那次进食
 * @returns {string} 要发出的正文(可能多一行)
 */
export function narrateMeal(text, meal = {}) {
  const body = String(text ?? '');
  if (!(Number(meal?.satietyDelta) > 0)) return body;
  if (mentionsEating(body)) return body;
  const food = String(meal?.food ?? '').trim();
  // 万能句退役(2026-10-23):没有有名有姓的食物就不补,别让她空口嚼东西。
  if (!food || food === '投喂') return body;
  const action = `（嚼着${food}，含混地应了一声）`;
  return body === '' ? action : `${body}\n\n${action}`;
}

/**
 * 这一轮到底该按哪一份进食数据处理。**纯函数** —— 于是"100% 有数值"这件事可以直接单测,
 * 不需要真的起一个 bridge(命令路由与装配都在 `main()` 里,单测覆盖不到,见 TODO)。
 *
 * 优先级:
 *   ① 模型给了**有效热量**的 `<intake>` → 用模型的(它真看过图,精度最高);
 *      ⚠️ 保留老闸门:模型在**不像吃喝**的回合里写的进食块一律**不采纳**(防伪造刷数值);
 *   ② 模型没给、或给的热量是 0/负数 → 用 `detectFeeding()` 的结果(**这就是那 100%**);
 *   ③ 两样都没有 → null(这一轮不结算,连标记都已经剥掉了)。
 *
 * **谁付钱**(D97):`paidBy` 只有两个值 ——
 *   · `'other'` = **别人请的**(带图,或话里明确在投喂)→ 那一顿免单,并套「被投喂」进项;
 *   · `'self'`  = 她自己吃的(模型报的 `<intake>`,而且这一轮没有投喂信号)→ 扣她的饭钱。
 * 判据用 `hasImage || looksLikeFeeding(text)`,**不是**"谁产出了那份数据" ——
 * 因为模型在带图回合估出的热量,那顿饭**还是别人给的**。
 * 而"用户那句话里只出现食物名词"(比如「我吃了泡面」)不算投喂 → 她自己付钱(有单测钉住)。
 *
 * @param {{modelIntake?: object|null, text?: string, hasImage?: boolean, theme?: object}} [ctx]
 * @returns {{intake: object, source: string}|null}
 */
export function resolveIntake({ modelIntake = null, text = '', hasImage = false, theme = MEGUMIN_BODY, modelSaysNotFood = false } = {}) {
  const detected = detectFeeding(text, { hasImage, theme });
  // ⚠️ `paidBy` 用**同一个**判据(有没有"给与"标记),不然会出现
  // "认成投喂却让她自己付钱"这种自相矛盾(D102 统一到 `hasFeedGift`)。
  const paidBy = hasImage || hasFeedGift(text) ? 'other' : 'self';
  const kcal = Number(modelIntake?.kcal);
  const modelUsable = Boolean(modelIntake) && Number.isFinite(kcal) && kcal > 0;

  if (modelUsable) {
    if (!looksLikeEating(text, { hasImage })) return null;
    // 保底:投喂回合里模型给的太少,按 FEEDING_FLOOR_KCAL 抬起来 —— 否则 +0 饱食等于没反应。
    if (detected && kcal < FEEDING_FLOOR_KCAL) {
      return { intake: { ...modelIntake, kcal: FEEDING_FLOOR_KCAL, paidBy }, source: 'model-floor' };
    }
    return { intake: { ...modelIntake, paidBy }, source: 'model' };
  }

  // ⚠️ **模型明确说"这不是吃的" → 只否决"带图兜底"那一份**(2026-10-09):
  //    · 那张图是蟑螂/梗图/截图时不该喂她一顿(用户报的现场);
  //    · 但"明确的投喂说法"照旧结算 —— 否则又回到 D96 那个"十次里九次没反应"。
  //    ⚠️ 顺序很要紧:`feed-intent` / `keyword` 这两种 source **不受否决影响**。
  if (detected && modelSaysNotFood && detected.source === 'image') {
    return null;
  }

  if (detected) return { intake: { ...detected, paidBy }, source: detected.source };
  return null;
}
