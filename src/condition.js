/**
 * **状态档位**(D103,2026-10-02):健康与心情从"0–100 的数值"变成**隐藏的档位/状态**。
 *
 * 用户原话:
 * > 「**健康值和心情值也要动手,数值直接换成隐藏状态档位**,角色随时带着
 * >   健康/**生病**[带**随机**疾病,染病有随机或人为原因(做委托感冒了/给当前角色喂了不能吃的东西)]
 * >   和**养病中**的状态,得病和养病可以**求治疗角色帮忙治疗**。
 * >   心情如法炮制,带**开心/伤心/失落/抑郁/狂喜/平和/生气**等等状态
 * >   (**把人类常有的状态都加上**)。心情改动**影响现在的情绪指标或直接代替**。」
 *
 * 本文件是这一套的**纯函数内核**(状态表、病因、病程、治疗、心情→情绪池的偏置),
 * 存储与接线由调用方;于是"病怎么来、拖多久、怎么好、心情怎么影响语气"都能直接单测。
 *
 * ⚠️ 三条刻意的边界:
 *   ① **数值还在,只是不再给她看也不再进提示词**(用户要的是"隐藏")——
 *      档位由数值 + 病程推出来,于是这一版**不需要迁移数据库**;
 *   ② **疾病是"事件",不是"档位"**:档位说"现在什么样",疾病说"为什么、还要多久"。
 *      两者分开,才能"养病中"这种既不是健康也不是生病的中间态;
 *   ③ **心情只"偏置"现有的情绪池**(`mood.js` 的 11 种日常情绪),**不并行第二套** ——
 *      用户给的选项是"影响或直接代替",先偏置:一套池子两套入口,
 *      比两套池子互相打架安全(真跑几天看手感再决定要不要替)。
 */
import { MEGUMIN_BODY, describeValue, longLabelFor } from './body-theme.js';
import { GAMEPLAY_CONTENT, gameplayText } from './local-gameplay-content.js';

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// 一、健康档位
// ---------------------------------------------------------------------------

/**
 * 健康档位。`below` 是**上界**(照 `body-theme` 的 `states` 那个写法——表的最后一项是"以上")。
 *
 * ⚠️ 与 `body-theme` 里那张 `health.states` 的关系:那张是**措辞**(给人看的一句话),
 * 这张是**状态机**(带 id、带能不能求医、带"要不要紧")。两处都要,别合并:
 * 措辞那张协作角色也要用(机械口径),状态机这张只属于这具身体。
 */
export const HEALTH_TIERS = [
  { id: 'critical', below: 20, label: GAMEPLAY_CONTENT.healthLabels[0], urgency: 'high', canSeekHelp: true },
  { id: 'sick', below: 45, label: GAMEPLAY_CONTENT.healthLabels[1], urgency: 'normal', canSeekHelp: true },
  { id: 'recovering', below: 65, label: GAMEPLAY_CONTENT.healthLabels[2], urgency: 'low', canSeekHelp: false },
  { id: 'tired', below: 85, label: GAMEPLAY_CONTENT.healthLabels[3], urgency: 'low', canSeekHelp: false },
  { id: 'healthy', below: 101, label: GAMEPLAY_CONTENT.healthLabels[4], urgency: 'none', canSeekHelp: false },
];

/** 数值 → 健康档位(纯函数)。 */
export function healthTier(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return HEALTH_TIERS[HEALTH_TIERS.length - 1];
  return HEALTH_TIERS.find((tier) => number < tier.below) ?? HEALTH_TIERS[HEALTH_TIERS.length - 1];
}

// ---------------------------------------------------------------------------
// 二、疾病表(带病因、病程、治疗途径)
// ---------------------------------------------------------------------------

/**
 * 疾病表。每条都要说得出**为什么会得**(用户:"染病有随机或人为原因")。
 *
 * `causes` 是**病因标签**,由调用方按事件传进来;`weight` 只在同病因里比。
 * `cure` 说明这一病**能不能求治疗角色**(原作里治疗角色是水之女神,治愈是她的本职 ——
 * 但她常常在别的地方帮倒忙,所以"求她"有一条**失败/帮倒忙**的概率,见 `seekAqua`)。
 */
export const DISEASES = [
  { id: 'cold', name: GAMEPLAY_CONTENT.diseaseTexts[0].name, weight: 6,
    causes: ['commission', 'weather', 'fishing'], drainPerHour: 1.5, durationMs: 36 * HOUR_MS,
    cure: { aqua: 0.85, potion: true }, line: GAMEPLAY_CONTENT.diseaseTexts[0].line },
  { id: 'fever', name: GAMEPLAY_CONTENT.diseaseTexts[1].name, weight: 2,
    causes: ['commission', 'weather', 'food'], drainPerHour: 2.5, durationMs: 24 * HOUR_MS,
    cure: { aqua: 0.9, potion: true }, line: GAMEPLAY_CONTENT.diseaseTexts[1].line },
  { id: 'stomach', name: GAMEPLAY_CONTENT.diseaseTexts[2].name, weight: 5,
    causes: ['food'], drainPerHour: 2, durationMs: 12 * HOUR_MS,
    cure: { aqua: 0.8, potion: true }, line: GAMEPLAY_CONTENT.diseaseTexts[2].line },
  { id: 'mana_burn', name: GAMEPLAY_CONTENT.diseaseTexts[3].name, weight: 2,
    causes: ['explosion'], drainPerHour: 2, durationMs: 18 * HOUR_MS,
    cure: { aqua: 0.75, potion: true }, line: GAMEPLAY_CONTENT.diseaseTexts[3].line },
  { id: 'exhaustion', name: GAMEPLAY_CONTENT.diseaseTexts[4].name, weight: 4,
    causes: ['commission', 'adventure'], drainPerHour: 1, durationMs: 10 * HOUR_MS,
    cure: { aqua: 0.6, potion: true }, line: GAMEPLAY_CONTENT.diseaseTexts[4].line },
  { id: 'curse_light', name: GAMEPLAY_CONTENT.diseaseTexts[5].name, weight: 1,
    causes: ['adventure', 'explosion'], drainPerHour: 1.5, durationMs: 48 * HOUR_MS,
    cure: { aqua: 0.95, potion: false }, line: GAMEPLAY_CONTENT.diseaseTexts[5].line },
];

/** 病因的中文说明(日志与提示词用)。 */
export const DISEASE_CAUSES = GAMEPLAY_CONTENT.diseaseCauses;

/**
 * 按"病因"抽一个病(纯函数)。抽不到就返回 null —— 调用方**不许**自己编一个病出来。
 *
 * @param {string} cause 病因标签(见 `DISEASE_CAUSES`)
 * @param {() => number} [random]
 */
export function pickDisease(cause, random = Math.random) {
  const candidates = DISEASES.filter((row) => row.causes.includes(cause));
  // ⚠️ **抽不到也要给一个病,不许返回 null**(用户 2026-10-02:
  //    「**编一个病就编呗,为什么要 null**」)。理由本来就成立:她的身体是活的,
  //    "说不出为什么就是不舒服"本身就是一种日常 —— 而返回 null 会让调用方
  //    **要么不生病、要么自己现编一个**,那才是真正的"随便"。
  //    所以:先看 `random` 那类(病因不明),没有就整表按权重抽一个,病因照实记传入的那个。
  const pool = candidates.length > 0
    ? candidates
    : (DISEASES.filter((row) => row.causes.includes('random')).length > 0
      ? DISEASES.filter((row) => row.causes.includes('random'))
      : DISEASES);
  const total = pool.reduce((sum, row) => sum + row.weight, 0);
  let roll = random() * total;
  for (const row of pool) {
    roll -= row.weight;
    if (roll < 0) return row;
  }
  return pool[pool.length - 1];
}

/**
 * **染病**(纯函数):按病因抽病、算出这一次的病程。
 *
 * @param {{cause: string, now?: number, random?: () => number}} ctx
 * @returns {{id: string, name: string, cause: string, startedAt: number, endsAt: number,
 *   drainPerHour: number, treated: boolean, line: string}|null}
 */
export function catchDisease({ cause, now = Date.now(), random = Math.random } = {}) {
  const disease = pickDisease(cause, random);
  // 病程给 ±25% 的抖动:同一个病两次不会一模一样长
  const jitter = 0.75 + random() * 0.5;
  return {
    id: disease.id,
    name: disease.name,
    cause,
    startedAt: now,
    endsAt: now + Math.round(disease.durationMs * jitter),
    drainPerHour: disease.drainPerHour,
    treated: false,
    line: disease.line,
  };
}

/** 病还在不在(纯函数)。 */
export function isIll(condition, now = Date.now()) {
  return Boolean(condition) && !condition.treated && now < condition.endsAt;
}

/**
 * **求治疗角色**(纯函数)。用户原话:「得病和养病可以**求治疗角色帮忙治疗**」。
 *
 * ⚠️ 刻意**不是 100%**:治疗角色是治愈女神没错,但在这个项目里她同时是"帮倒忙"的代名词 ——
 * 一次 85%~95% 的治愈率(按病),失败那次不是"没治好"而是"**她来了反而更糟**"
 * (心情掉一点),这既是梗也是"求人不如求己"的机制张力。
 *
 * @returns {{ok: boolean, condition: object|null, moodDelta: number, line: string}}
 */
export function seekAqua(condition, random = Math.random) {
  if (!condition) return { ok: false, condition: null, moodDelta: 0, line: '（现在没在病着。）' };
  const disease = DISEASES.find((row) => row.id === condition.id) ?? { cure: { aqua: 0.8 } };
  const chance = disease.cure?.aqua ?? 0.8;
  if (random() < chance) {
    return {
      ok: true,
      condition: { ...condition, treated: true },
      moodDelta: 3,
      line: gameplayText(GAMEPLAY_CONTENT.conditionText.seekSuccess, { name: condition.name }),
    };
  }
  return {
    ok: false,
    condition,
    moodDelta: -2,
    line: gameplayText(GAMEPLAY_CONTENT.conditionText.seekFailure, { name: condition.name }),
  };
}

// ---------------------------------------------------------------------------
// 三、心情档位(把人类常有的状态都列上)
// ---------------------------------------------------------------------------

/**
 * 心情档位。`below` 照 `HEALTH_TIERS` 的写法(上界)。
 *
 * ⚠️ **与情绪池(`mood.js` 的 11 种)分工**:
 *   · **档位**回答"她现在是什么心理状态"(抑郁/狂喜/失落…)—— 这是**状态**,会持续一段;
 *   · **情绪池**回答"这一轮用哪种语气说话"(中二/傲娇/懒散…)—— 这是**表现**,每轮掷骰。
 * 用户给的选项是"影响现在的情绪指标**或直接代替**";先做**偏置**(`moodBiasFor`):
 * 一套池子两个入口,比两套池子互相打架安全。真跑几天再决定要不要替。
 */
export const MOOD_TIERS = [
  { id: 'despair', below: 12, label: GAMEPLAY_CONTENT.moodLabels[0], bias: { lazy: 2.0, snark: 1.6, kind: 0.4, genki: 0.3 } },
  { id: 'grief', below: 25, label: GAMEPLAY_CONTENT.moodLabels[1], bias: { lazy: 1.6, kind: 0.6, genki: 0.5, dramatic: 1.3 } },
  { id: 'down', below: 40, label: GAMEPLAY_CONTENT.moodLabels[2], bias: { lazy: 1.5, snark: 1.3, genki: 0.6, chuni: 0.7 } },
  { id: 'angry', below: 46, label: GAMEPLAY_CONTENT.moodLabels[3], bias: { angry: 2.2, snark: 1.5, tsundere: 1.2, kind: 0.5 } },
  { id: 'calm', below: 62, label: GAMEPLAY_CONTENT.moodLabels[4], bias: { kind: 1.2, tsundere: 1.1 } },
  { id: 'happy', below: 82, label: GAMEPLAY_CONTENT.moodLabels[5], bias: { genki: 1.6, kind: 1.3, narcissist: 1.1 } },
  { id: 'elated', below: 93, label: GAMEPLAY_CONTENT.moodLabels[6], bias: { genki: 2.0, narcissist: 1.6, chuni: 1.3, lazy: 0.5 } },
  { id: 'manic', below: 101, label: GAMEPLAY_CONTENT.moodLabels[7], bias: { narcissist: 2.2, chuni: 1.6, genki: 1.5 } },
];

/** 「还有哪些人类常见的状态」——用户说"把人类常有的状态都加上"。 */
export const EXTRA_MOOD_STATES = ['anxious', 'shy', 'excited', 'bored', 'lonely', 'smug', 'grateful', 'jealous']
  .map((id, index) => ({ id, ...GAMEPLAY_CONTENT.extraMoodTexts[index] }));

/** 数值 → 心情档位(纯函数)。 */
export function moodTier(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return MOOD_TIERS.find((tier) => tier.id === 'calm');
  return MOOD_TIERS.find((tier) => number < tier.below) ?? MOOD_TIERS[MOOD_TIERS.length - 1];
}

/**
 * 心情档位 → **情绪池的权重倍数**(纯函数)。这是"影响现在的情绪指标"那半。
 *
 * @param {object} state 情绪池的权重表(键是 `mood.js` 的情绪 id)
 * @param {number} moodValue 心情数值
 * @returns {object} 新的权重表(不修改入参)
 */
export function moodBiasFor(state, moodValue) {
  const tier = moodTier(moodValue);
  if (!tier?.bias) return { ...state };
  const next = { ...state };
  for (const [key, factor] of Object.entries(tier.bias)) {
    if (Number.isFinite(Number(next[key]))) next[key] = Number(next[key]) * factor;
  }
  return next;
}

// ---------------------------------------------------------------------------
// 三点五、**十个档位的形容词**(前端不再显示数字)
// ---------------------------------------------------------------------------

/**
 * 五个数值各自的**十档形容词**。用户 2026-10-02:
 * 「我感觉**数值前端显示可以全部砍了,全部隐藏**,保留后端计算数字的同时,
 *   **五个数值的显示全部用十个档位的形容词代替**」。
 *
 * 于是:库里照旧算,`/状态`、状态行这些**给人看的地方只说词** ——
 * 「养病中」比「健康 55/100」更能让她和人**演**起来。
 * ⚠️ 每档都是**形容词**不是刻度词(不写"中等/偏高"),因为这些东西她**会念出来**。
 */
export const TIER10 = GAMEPLAY_CONTENT.tier10;

/** 数值 → 十档里的第几档(0–9)。 */
export function tier10Index(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(9, Math.floor(number / 10)));
}

/** 数值 → 十档形容词(纯函数)。认不出的键返回空串,不抛。 */
export function tier10(key, value) {
  const labels = TIER10[key];
  if (!labels) return '';
  return labels[tier10Index(value)];
}

// ---------------------------------------------------------------------------
// 三点六、**身体检查**(把 `/状态` 融进对话)
// ---------------------------------------------------------------------------

/** 模糊询问身体状态的说法。 */
const VAGUE_PATTERNS = [
  /(身体|状态|身体状态)(怎么样|如何|还好|好些|ok|OK)/,
  /(最近|今天|这几天)(感觉)?(怎么样|还好吗|没事吧|还好吧)/,
  /(哪里|哪儿)(不舒服|难受)/,
  /(感觉|觉得)(怎么样|如何)/,
  /有没有(哪里)?(不舒服|难受)/,
];

/** 命中**特定**状态的说法(问什么答什么,别打岔)。 */
const SPECIFIC_PATTERNS = [
  { topic: 'illness', re: /(病|感冒|发烧|肚子|伤)(好了|好没|好了吗|好些了|怎么样|还病着)/ },
  { topic: 'illness', re: /(还|在)(病|养病|难受)/ },
  { topic: 'hunger', re: /(饿|饿不饿|吃饭了|吃过)/ },
  { topic: 'mana', re: /(魔力|魔法)(够|不够|还有|怎么样|恢复)/ },
  { topic: 'tired', re: /(累|体力|困|休息)(不累|够|怎么样|还好)/ },
  { topic: 'mood', re: /(心情|开心|难过|高兴)(怎么样|好吗|不好|还行)/ },
];

/**
 * 这句话是不是在**检查她的身体**(纯函数)。
 *
 * @returns {{topic: string, vague: boolean}|null}
 */
export function detectBodyCheck(text) {
  const source = String(text ?? '').trim();
  if (source === '' || source.length > 60) return null;
  for (const row of SPECIFIC_PATTERNS) {
    if (row.re.test(source)) return { topic: row.topic, vague: false };
  }
  for (const re of VAGUE_PATTERNS) {
    if (re.test(source)) return { topic: 'overall', vague: true };
  }
  return null;
}

/**
 * **她的回答**(纯函数)。用户给的两个样板就是这个形状:
 *
 * > 用户:当前角色感觉最近身体怎么样(模糊询问)
 * > 当前角色:我现在健康的很!就是你经常不带我吃好吃的,好饿好伤心.......感觉魔力也漏了
 * > 用户:当前角色病好了吗(命中特定状态询问)
 * > 当前角色:吾今天找了治疗角色,她收了我10000通用货币给我治好了......真是狮子大开口
 *
 * 三条口径:
 *   ① **模糊问 → 随机报几个相关状态**(不是把五项全念一遍 —— 那是报表,不是人);
 *   ② **具体问 → 答那一件事**(问病只说病);
 *   ③ 文案里有**抱怨**的余地(饿/没带她吃好的),这样她像在说话,而不是在报数。
 */
export function bodyCheckReply({ stats = {}, condition = null, now = Date.now(), question = {}, random = Math.random } = {}) {
  const topic = question.topic ?? 'overall';
  const ill = isIll(condition, now);
  const sickLine = () => {
    if (ill) return gameplayText(GAMEPLAY_CONTENT.conditionText.bodySick, { name: condition.name, line: condition.line });
    if (condition?.treated) return GAMEPLAY_CONTENT.conditionText.bodyTreated;
    return null;
  };

  if (!question.vague && topic === 'illness') {
    const line = sickLine();
    if (line) return line;
    return GAMEPLAY_CONTENT.conditionText.bodyHealthy;
  }

  const pick = (key, label) => `${label}${tier10(key, stats[key] ?? 0)}`;
  if (!question.vague) {
    const map = {
      hunger: () => `${pick('satiety', GAMEPLAY_CONTENT.conditionText.hungerPrefix)}${Number(stats.satiety) < 45 ? GAMEPLAY_CONTENT.conditionText.hungerLow : ''}。`,
      mana: () => `${pick('mana', '魔力')}${Number(stats.mana) < 40 ? GAMEPLAY_CONTENT.conditionText.manaLow : GAMEPLAY_CONTENT.conditionText.manaEnough}。`,
      tired: () => `${pick('stamina', '体力')}${Number(stats.stamina) < 40 ? GAMEPLAY_CONTENT.conditionText.tiredLow : ''}。`,
      mood: () => `${pick('mood', '心情')}${Number(stats.mood) < 40 ? '……你说呢' : ''}。`,
    };
    const build = map[topic];
    if (build) return build();
  }

  // 模糊问:挑 3 项相关的说(按好坏排序会让回答像体检表,所以**随机开头往后隔一个取一个**)。
  // ⚠️ 这里**不许用拒绝采样**(`while` 里反复掷到不重复为止)—— 第一版就是那么写的,
  //    而 `random` 可注入,单测里给个常数就**死循环**了(selftest 当场挂住,只能杀进程)。
  //    "掷骰子"和"有限步数"必须同时成立:现在无论 random 给什么,步数都是固定的。
  const keys = ['health', 'mood', 'satiety', 'stamina', 'mana'];
  const start = Math.floor(random() * keys.length) % keys.length;
  const chosen = [keys[start], keys[(start + 2) % keys.length], keys[(start + 4) % keys.length]];
  const names = { health: '身体', mood: '心情', satiety: '肚子', stamina: '体力', mana: '魔力' };
  const parts = chosen.map((key) => `${names[key]}${tier10(key, stats[key] ?? 0)}`);
  const head = ill ? sickLine() : (Number(stats.mood) >= 80 ? GAMEPLAY_CONTENT.conditionText.healthyHead : '唔……');
  const grumble = Number(stats.satiety) < 50 ? GAMEPLAY_CONTENT.conditionText.grumble : '';
  return `${head}${parts.join('、')}。${grumble}`;
}

/**
 * 给提示词的那一行**状态描述**(纯函数)。用户要的是"**隐藏**"档位:
 * 所以这里**只说状态,不报数字** —— 数值仍然在库里(时间衰减要用它),但不再进模型的眼睛。
 *
 * @param {{health?: number, mood?: number, condition?: object|null, now?: number, theme?: object}} ctx
 */
export function describeCondition({ health = 100, mood = 60, condition = null, now = Date.now(), theme = MEGUMIN_BODY } = {}) {
  //    (实测:她的提示词里出现过「电量 60/100、健康：有点乏」)。所以非 megumin 的身体
  //    退回 `body-theme` 那套措辞 —— 档位状态机(生病/养病中)只属于**有血肉的那只**。
  if (theme?.id && theme.id !== 'megumin') {
    const parts = [
      `${longLabelFor('health', theme)}：${describeValue('health', health, theme)}`,
      `${longLabelFor('mood', theme)}：${describeValue('mood', mood, theme)}`,
    ];
    return parts.join('、');
  }
  const healthTierText = healthTier(health).label;
  const moodTierText = moodTier(mood).label;
  const parts = [`健康：${healthTierText}`, `心情：${moodTierText}`];
  if (isIll(condition, now)) {
    const leftHours = Math.max(0, Math.round((condition.endsAt - now) / HOUR_MS));
    parts.push(
      `**正在生病：${condition.name}**（${DISEASE_CAUSES[condition.cause] ?? '原因不明'}；` +
      gameplayText(GAMEPLAY_CONTENT.conditionText.help, { hours: leftHours, line: condition.line }),
    );
  } else if (condition?.treated) {
    parts.push(`病刚治好（${condition.name}），还虚着`);
  }
  return parts.join('、');
}
