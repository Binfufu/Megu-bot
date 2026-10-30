import { LOCAL_MOOD_BODY_CONTENT } from './local-mood-body-content.js';
/** Local display content is separate from the unchanged runtime policy. */

import { ARIS_STYLE_NUDGES, MEGUMIN_STYLE_NUDGES, DEMO_STYLE_NUDGES } from './style.js';
// 钱的门槛只有**一处**真源(D99):`stats.js`。这里只借来用 + 继续对外导出。
import { MONEY_POOR } from './stats.js';

/**
 * Mood definitions.
 *
 * `maxChars`/`maxSentences` are the length binding (see D22). They are a soft
 * target in a prompt for answers to a direct question, and are enforced on
 * self-initiated messages — ⚠️ **1.106.2(D174)起是"每段的上限"**(切成分条发,
 * 见 `splitSpokenLines`),不再是"砍掉尾巴"(`truncateForMood`)。
 *
 * `chunibyou` marks the moods that make up the "中二" share of the pool. The
 * plan caps that share at 26% and forces a low-energy mood after two in a row,
 * which is what keeps the character from being a one-note chuunibyou.
 */
function localMoodDefinition(theme, id, policy) {
  const text = LOCAL_MOOD_BODY_CONTENT?.mood?.[theme]?.moods?.[id];
  return { label: text?.label ?? '平静交流', ...policy,
    directive: text?.directive ?? '用简短自然的句子直接回应，不使用固定口头禅或角色设定。' };
}
function localTopicDefinition(theme, id, weights) {
  const text = LOCAL_MOOD_BODY_CONTENT?.mood?.[theme]?.topics?.[id];
  return { id, label: text?.label ?? '一般话题', keywords: text?.keywords ?? [], weights };
}
export const MOODS = {
  chuni: localMoodDefinition('megumin', 'chuni', {"maxChars":30,"maxSentences":2,"chunibyou":true,"tags":["proud"]}),
  snark: localMoodDefinition('megumin', 'snark', {"maxChars":30,"maxSentences":2,"chunibyou":false,"tags":["awkward","angry"]}),
  lazy: localMoodDefinition('megumin', 'lazy', {"maxChars":15,"maxSentences":2,"chunibyou":false,"tags":["tired"]}),
  genki: localMoodDefinition('megumin', 'genki', {"maxChars":30,"maxSentences":2,"chunibyou":false,"tags":["happy","proud"]}),
  tsundere: localMoodDefinition('megumin', 'tsundere', {"maxChars":30,"maxSentences":2,"chunibyou":false,"tags":["awkward","shy"]}),
  kind: localMoodDefinition('megumin', 'kind', {"maxChars":50,"maxSentences":2,"chunibyou":false,"tags":["happy","shy"]}),
  narcissist: localMoodDefinition('megumin', 'narcissist', {"maxChars":30,"maxSentences":2,"chunibyou":true,"tags":["proud"]}),
  dramatic: localMoodDefinition('megumin', 'dramatic', {"maxChars":80,"maxSentences":3,"chunibyou":false,"tags":["proud","angry"]}),
  angry: localMoodDefinition('megumin', 'angry', {"maxChars":30,"maxSentences":2,"chunibyou":false,"tags":["angry"]}),
  shy: localMoodDefinition('megumin', 'shy', {"maxChars":50,"maxSentences":2,"chunibyou":false,"tags":["shy"]}),
  foodie: localMoodDefinition('megumin', 'foodie', {"maxChars":30,"maxSentences":2,"chunibyou":false,"tags":["happy","proud"]}),
  frenzy: localMoodDefinition('megumin', 'frenzy', {"maxChars":80,"maxSentences":3,"chunibyou":true,"tags":["angry","proud"]}),
  stubborn: localMoodDefinition('megumin', 'stubborn', {"maxChars":30,"maxSentences":2,"chunibyou":false,"tags":["awkward"]}),
  plain: localMoodDefinition('megumin', 'plain', {"maxChars":50,"maxSentences":2,"chunibyou":false,"tags":["tired"]}),
};

/**
 * Everyday weights, in percent. Sums to 100; the chuunibyou share
 * (chuni + narcissist + dramatic-adjacent) is deliberately small — see D22.
 */
export const BASE_POOL = {
  chuni: 12,
  snark: 15,
  lazy: 15,
  genki: 12,
  tsundere: 12,
  kind: 8,
  narcissist: 8,
  dramatic: 6,
  angry: 5,
  shy: 4,
  foodie: 3,
};

/**
 * Moods counted when checking the "中二 must not exceed 26% of the pool" rule.
 *
 * Note this is deliberately *not* the same list as `CHUNIBYOU_MOODS`: 戏剧化表演
 * counts towards the share (it is a chuunibyou-flavoured delivery) but is not
 * itself a mood the streak penalty punishes.
 */
export const CHUNIBYOU_SHARE_MOODS = ['chuni', 'narcissist', 'dramatic'];

/** Moods that count towards "连着两次中二了". */
export const CHUNIBYOU_MOODS = ['chuni', 'narcissist', 'frenzy'];

/** Where the penalty lands: low energy only, never another chuunibyou mood. */
export const LOW_ENERGY_MOODS = ['lazy', 'snark', 'plain'];

/** Consecutive chuunibyou turns that trigger the penalty. */
export const CHUNIBYOU_STREAK_LIMIT = 2;

/** Local display content is separate from the unchanged runtime policy. */
export const STATE_BIAS = {
  lowMood: { lazy: 1.6, snark: 1.4, angry: 1.3, genki: 0.5, kind: 0.5, narcissist: 0.7 },
  highMood: { genki: 1.6, kind: 1.4, narcissist: 1.2, lazy: 0.6, snark: 0.8, angry: 0.6 },
  hungry: { foodie: 1.8, snark: 1.2, angry: 1.1 },
  stuffed: { lazy: 1.2, foodie: 0.4, genki: 0.8 },
  unwell: { lazy: 1.4, dramatic: 0.5, frenzy: 0.4 },
  /**
   * 穷(D42)。**这是"不再一直说穷"的机制所在**:钱少的时候,
   * 讨饭(foodie)与吐槽/炸毛的权重上去 —— 因为"穷"本来就会让人更惦记吃的、
   * 更容易炸毛;而钱够的时候这条偏置不生效,于是她没有理由抱怨。
   *
   * ⚠️ 注意它**不新造一个情绪**,而是借用已有的:`foodie`(讨饭)那格台词本来就是
   * "饿了/没钱"的语气。加新情绪要同时改池子与权重(权重必须合计 100,有测试盯着),
   * 收益不值那个风险。
   */
  poor: { foodie: 2.0, snark: 1.3, angry: 1.1, narcissist: 0.8 },
};

/** 心情低于/高于这两个值时按 `lowMood` / `highMood` 偏置。 */
export const MOOD_LOW = 40;
export const MOOD_HIGH = 80;
/** 饱食度低于/高于这两个值时按 `hungry` / `stuffed` 偏置。 */
export const SATIETY_HUNGRY = 20;
export const SATIETY_STUFFED = 90;
/** 健康低于此值时按 `unwell` 偏置。 */
export const HEALTH_POOR = 40;
// ⚠️ **2026-10-02(D99)删掉了这里的 `export const MONEY_POOR = 15`** ——
//    它和 `stats.js` 那个是**两份**常量,注释还写着"同一个门槛"(经典的那种自欺)。
// Local display content is separate from runtime policy.
//    永远不生效(而 `describeForPrompt` 里那句"可以抱怨"是真的)——
//    一个数值两套门槛,而且**不报错**。现在统一从 `stats.js` 取,同时继续对外导出它
//    (老引用 `from './mood.js'` 不用改)。
export { MONEY_POOR };

/** Local display content is separate from the unchanged runtime policy. */
export function adjustWeightsForState(weights, stats, bias = STATE_BIAS) {
  if (!stats || !bias) return weights;
  const biasses = [];
  if (stats.mood < MOOD_LOW) biasses.push(bias.lowMood);
  else if (stats.mood > MOOD_HIGH) biasses.push(bias.highMood);
  if (stats.satiety < SATIETY_HUNGRY) biasses.push(bias.hungry);
  else if (stats.satiety > SATIETY_STUFFED) biasses.push(bias.stuffed);
  if (stats.health < HEALTH_POOR) biasses.push(bias.unwell);
  // 穷:只有**低于门槛**才偏置。钱够的时候这条不生效 —— 于是"一直说穷"没有了依据。
  if (Number.isFinite(Number(stats.money)) && Number(stats.money) < MONEY_POOR) biasses.push(bias.poor);
  if (biasses.length === 0) return weights;

  const adjusted = {};
  for (const [id, weight] of Object.entries(weights)) {
    let factor = 1;
    for (const item of biasses) factor *= item?.[id] ?? 1;
    // 保底留一点权重:身体不好时"变少"不等于"消失"
    adjusted[id] = Math.max(0.05, weight * factor);
  }
  return adjusted;
}

/** Minimum gap between two uses of an attention-grabbing mood, in ms. */
export const MOOD_COOLDOWNS = {
  frenzy: 5 * 60_000,
  dramatic: 3 * 60_000,
};

/**
 * Topic overrides: when the trigger message is clearly about one of these, the
 * weights are replaced wholesale.
 *
 * Keywords are matched against the triggering message only. Semantic cases that
 * no word list can catch (being praised, being cared about) are covered by
 * phrase lists here — the alternative would be asking the model to classify its
 * own input, which costs a call and drifts.
 */
export const TOPIC_OVERRIDES = [
  localTopicDefinition('megumin', 'explosion', {"frenzy":60,"dramatic":20,"narcissist":15,"chuni":5}),
  localTopicDefinition('megumin', 'praise', {"tsundere":40,"shy":20,"narcissist":20,"kind":10,"chuni":10}),
  localTopicDefinition('megumin', 'weakspot', {"angry":50,"tsundere":30,"stubborn":20}),
  localTopicDefinition('megumin', 'kazuma', {"snark":35,"tsundere":25,"kind":20,"angry":10,"shy":10}),
  localTopicDefinition('megumin', 'yuyu', {"tsundere":30,"chuni":25,"snark":20,"kind":15,"angry":10}),
  localTopicDefinition('megumin', 'food', {"foodie":60,"genki":20,"narcissist":10,"snark":10}),
  localTopicDefinition('megumin', 'poke', {"angry":35,"lazy":25,"tsundere":20,"shy":20}),
  localTopicDefinition('megumin', 'face', {"genki":25,"snark":25,"lazy":20,"angry":15,"tsundere":15}),
];

/**
 * Interjections, per mood. One is drawn each turn and handed to the model, so
 * that the *variety actually shows up* — handing over a list to choose from
 * measurably does not work (the card listed six kaomoji and three ever
 * appeared).
 */
export const INTERJECTIONS = LOCAL_MOOD_BODY_CONTENT?.mood?.megumin?.interjections
  ?? Object.fromEntries(Object.keys(MOODS).map((id) => [id, []]));

/** Optional expression text is local; tags keep selection aligned with the mood. */
export const KAOMOJI = LOCAL_MOOD_BODY_CONTENT?.mood?.megumin?.kaomoji ?? [];

/** How many recent picks to avoid repeating. */
export const RECENT_INTERJECTIONS = 4;
export const RECENT_KAOMOJI = 3;

// Alternate legacy policy palette: numerical behavior stays independent of local wording.
// Topic-gated interjections still require both an eligible topic and a fresh draw.
export const ARIS_MOODS = {
  plain: localMoodDefinition('aris', 'plain', {"maxChars":40,"maxSentences":2,"tags":[]}),
  curious: localMoodDefinition('aris', 'curious', {"maxChars":35,"maxSentences":2,"tags":["happy"]}),
  earnest: localMoodDefinition('aris', 'earnest', {"maxChars":45,"maxSentences":2,"tags":[]}),
  genki: localMoodDefinition('aris', 'genki', {"maxChars":30,"maxSentences":2,"tags":["happy","proud"]}),
  puzzled: localMoodDefinition('aris', 'puzzled', {"maxChars":40,"maxSentences":2,"tags":["awkward"]}),
  system: localMoodDefinition('aris', 'system', {"maxChars":40,"maxSentences":2,"tags":[]}),
  fanfare: localMoodDefinition('aris', 'fanfare', {"maxChars":25,"maxSentences":2,"tags":["happy","proud"]}),
  shy: localMoodDefinition('aris', 'shy', {"maxChars":35,"maxSentences":2,"tags":["shy"]}),
  soft: localMoodDefinition('aris', 'soft', {"maxChars":50,"maxSentences":2,"tags":["happy"]}),
  heroic: localMoodDefinition('aris', 'heroic', {"maxChars":35,"maxSentences":2,"tags":["proud"]}),
  solemn: localMoodDefinition('aris', 'solemn', {"maxChars":25,"maxSentences":2,"tags":[]}),
};

/** 日常权重。合计 100;平稳三类占 60%,振幅压小。 */
export const ARIS_BASE_POOL = {
  plain: 30,
  curious: 16,
  earnest: 14,
  genki: 12,
  puzzled: 10,
  system: 6,
  fanfare: 6,
  shy: 3,
  soft: 2,
  heroic: 1,
};

/** Local display content is separate from the unchanged runtime policy. */
export const ARIS_MOOD_COOLDOWNS = {
  fanfare: 6 * 60_000,
  heroic: 10 * 60_000,
  solemn: 10 * 60_000,
  shy: 5 * 60_000,
};

/** Topic content matches only the triggering message; specific phrases avoid broad false positives. */
export const ARIS_TOPIC_OVERRIDES = [
  localTopicDefinition('aris', 'game', {"genki":32,"curious":24,"heroic":18,"fanfare":16,"system":10}),
  localTopicDefinition('aris', 'light', {"heroic":40,"fanfare":30,"genki":20,"system":10}),
  localTopicDefinition('aris', 'praise', {"shy":45,"earnest":25,"genki":20,"soft":10}),
  localTopicDefinition('aris', 'weakspot', {"solemn":55,"heroic":25,"earnest":20}),
  localTopicDefinition('aris', 'companion', {"soft":40,"earnest":30,"genki":20,"curious":10}),
  localTopicDefinition('aris', 'poke', {"puzzled":35,"genki":30,"shy":20,"plain":15}),
  localTopicDefinition('aris', 'face', {"curious":30,"puzzled":30,"genki":25,"plain":15}),
];

/** Local display content is separate from the unchanged runtime policy. */
export const ARIS_INTERJECTIONS = LOCAL_MOOD_BODY_CONTENT?.mood?.aris?.interjections
  ?? Object.fromEntries(Object.keys(ARIS_MOODS).map((id) => [id, []]));

/** Local display content is separate from the unchanged runtime policy. */
export const ARIS_INTERJECTION_TOPIC_GATE = LOCAL_MOOD_BODY_CONTENT?.mood?.aris?.interjectionTopicGate ?? {};

/** Local expressions are filtered by tags; the existing fallback handles unmatched tags. */
export const ARIS_KAOMOJI = LOCAL_MOOD_BODY_CONTENT?.mood?.aris?.kaomoji ?? [];

/** Local display content is separate from the unchanged runtime policy. */

/** Local display content is separate from the unchanged runtime policy. */
export const MEGUMIN_THEME = {
  id: 'megumin',
  label: LOCAL_MOOD_BODY_CONTENT?.mood?.megumin?.label ?? '中性交流主题',
  moods: MOODS,
  basePool: BASE_POOL,
  topicOverrides: TOPIC_OVERRIDES,
  interjections: INTERJECTIONS,
  kaomoji: KAOMOJI,
  cooldowns: MOOD_COOLDOWNS,
  stateBias: STATE_BIAS,
  chunibyouShareMoods: CHUNIBYOU_SHARE_MOODS,
  chuunibyouMoods: CHUNIBYOU_MOODS,
  lowEnergyMoods: LOW_ENERGY_MOODS,
  chuunibyouStreakLimit: CHUNIBYOU_STREAK_LIMIT,
  styleNudges: MEGUMIN_STYLE_NUDGES,
};

/** Local display content is separate from the unchanged runtime policy. */
export const ARIS_THEME = {
  id: 'aris',
  label: LOCAL_MOOD_BODY_CONTENT?.mood?.aris?.label ?? '中性交流主题',
  moods: ARIS_MOODS,
  basePool: ARIS_BASE_POOL,
  topicOverrides: ARIS_TOPIC_OVERRIDES,
  interjections: ARIS_INTERJECTIONS,
  interjectionTopicGate: ARIS_INTERJECTION_TOPIC_GATE,
  kaomoji: ARIS_KAOMOJI,
  cooldowns: ARIS_MOOD_COOLDOWNS,
  // 没有数值层 —— 那套口径(吃饭/饿/健康)是给人类身体的。
  stateBias: null,
  chunibyouShareMoods: [],
  chuunibyouMoods: [],
  lowEnergyMoods: [],
  // 没有中二,所以"连中两次就强制低能量"这条闸门对她永不触发。
  chuunibyouStreakLimit: Number.POSITIVE_INFINITY,
  styleNudges: ARIS_STYLE_NUDGES,
};

/**
 * 公开示例助手：只有中性陈述，不借用角色的情绪、话题、口癖或颜文字池。
 * 50 字 / 2 句沿用既有 plain 长度框架；单项池沿用总权重 100，
 * 不增加概率、冷却、状态偏置等策略参数，也不改动决策算法。
 */
export const DEMO_THEME = {
  id: 'demo',
  label: '示例助手(中性)',
  moods: {
    plain: {
      label: '平静交流',
      maxChars: 50,
      maxSentences: 2,
      tags: [],
      directive: '平静交流：用简短、自然的句子直接回应，不使用固定口头禅或角色设定。',
    },
  },
  basePool: { plain: 100 },
  topicOverrides: [],
  interjections: { plain: [] },
  kaomoji: [],
  cooldowns: {},
  stateBias: null,
  chunibyouShareMoods: [],
  chuunibyouMoods: [],
  lowEnergyMoods: [],
  chuunibyouStreakLimit: Number.POSITIVE_INFINITY,
  styleNudges: DEMO_STYLE_NUDGES,
};

export const MOOD_THEMES = {
  megumin: MEGUMIN_THEME,
  aris: ARIS_THEME,
  demo: DEMO_THEME,
};

/** Local display content is separate from the unchanged runtime policy. */
export const MOOD_THEME_NAMES = Object.keys(MOOD_THEMES);

/** Local display content is separate from the unchanged runtime policy. */
export function getMoodTheme(name) {
  if (name === undefined || name === null || String(name).trim() === '') return MEGUMIN_THEME;
  const theme = MOOD_THEMES[name];
  if (!theme) {
    throw new Error(`未知情绪主题:${JSON.stringify(name)}(只认 ${MOOD_THEME_NAMES.join(' / ')})`);
  }
  return theme;
}


/** The empty per-conversation state. */
export function createMoodState() {
  return {
    mood: null,
    topicId: null,
    expiresAt: 0,
    chunibyouStreak: 0,
    cooldowns: {},
    recentInterjections: [],
    recentKaomoji: [],
  };
}

/** The override whose keywords appear in `text`, or null. */
export function detectTopic(text, theme = MEGUMIN_THEME) {
  if (typeof text !== 'string' || text === '') return null;
  const haystack = text.toLowerCase();
  for (const override of theme.topicOverrides) {
    if (override.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) return override;
  }
  return null;
}

/**
 * Draw a mood from a weight table.
 *
 * @param {Record<string, number>} weights
 * @param {number} roll a draw in `[0, 1)`.
 */
export function pickWeighted(weights, roll) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = roll * total;
  for (const [id, weight] of entries) {
    cursor -= weight;
    if (cursor < 0) return id;
  }
  return entries[entries.length - 1][0];
}

/**
 * The weights to draw from this turn, after the cooldowns and the
 * "two chuunibyou turns in a row" penalty.
 *
 * @param {object} options
 * @param {Record<string, number>} options.weights the pool to start from.
 * @param {object} options.state
 * @param {number} options.now
 * @returns {{weights: Record<string, number>, penalised: boolean}}
 */
export function applyMoodGuards({ weights, state, now, theme = MEGUMIN_THEME }) {
  const allowed = {};
  for (const [id, weight] of Object.entries(weights)) {
    const cooldown = theme.cooldowns[id];
    const lastUsed = state.cooldowns?.[id];
    if (cooldown && Number.isSafeInteger(lastUsed) && now - lastUsed < cooldown) continue;
    allowed[id] = weight;
  }
  // Never let the guards empty the pool: better to repeat a mood than to skip.
  const pool = Object.keys(allowed).length > 0 ? allowed : { ...weights };

  if ((state.chunibyouStreak ?? 0) >= theme.chuunibyouStreakLimit) {
    const lowEnergy = {};
    for (const id of theme.lowEnergyMoods) {
      if (pool[id] !== undefined) lowEnergy[id] = pool[id];
    }
    // `plain` carries no weight of its own; it exists so the penalty has a
    // "just answer normally" option, and only joins a pool that is already
    // low-energy (never a topic override — see below).
    if (lowEnergy.lazy !== undefined || lowEnergy.snark !== undefined) lowEnergy.plain = 1;
    // A topic override with no low-energy option wins over the penalty: the
    // Local display content is separate from runtime policy.
    if (Object.keys(lowEnergy).length > 0) return { weights: lowEnergy, penalised: true };
  }
  return { weights: pool, penalised: false };
}

/** Pick one item, preferring entries not in `recent`. */
export function pickAvoiding(list, recent, roll) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const fresh = list.filter((item) => !recent.includes(item));
  const pool = fresh.length > 0 ? fresh : list;
  return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))];
}

/** Keep the last `limit` entries. */
export function remember(recent, item, limit) {
  if (!item) return recent;
  return [...recent, item].slice(-limit);
}

/**
 * Decide this turn's mood, interjection and kaomoji.
 *
 * A mood sticks for `ttlMs` so a follow-up three seconds later does not swing
 * from 懒散 to 狂热; a topic override switches immediately, and re-entering the
 * same topic keeps the mood it already chose.
 *
 * @param {object|null} previous the conversation's state, if any.
 * @param {object} ctx
 * @param {number} ctx.now
 * @param {string} [ctx.text] the triggering message (absent for warm-ups).
 * @param {number} ctx.ttlMs
 * @param {number} [ctx.kaomojiChance] probability of a kaomoji at all.
 * @param {{satiety: number, health: number, mood: number}|null} [ctx.stats]
 *   body stats — they bend the everyday pool (see `adjustWeightsForState`).
 * @param {() => number} [ctx.random]
 * @returns {{state: object, mood: string, directive: string, maxChars: number,
 *   maxSentences: number, changed: boolean, reason: string,
 *   interjection: string|null, interjectionScoped: boolean, kaomoji: string|null,
 *   penalised: boolean}}
 */
export function decideMood(previous, ctx) {
  const {
    now,
    text = '',
    ttlMs,
    kaomojiChance = 0.3,
    random = Math.random,
    theme = MEGUMIN_THEME,
  } = ctx;
  const state = { ...createMoodState(), ...(previous ?? {}) };

  const topic = detectTopic(text, theme);
  const ttlAlive = state.mood !== null && now < state.expiresAt;
  let mood = null;
  let reason = '';
  let penalised = false;
  // 这一轮是**重新掷中**的(true)还是**延续**的(false)—— 出场闸的新鲜门用它。
  let moodFresh = false;

  if (topic && !(state.topicId === topic.id && ttlAlive && topic.weights[state.mood] !== undefined)) {
    const guarded = applyMoodGuards({ weights: topic.weights, state, now, theme });
    mood = pickWeighted(guarded.weights, random());
    reason = `话题「${topic.label}」`;
    moodFresh = true;
  } else if (ttlAlive && !topic) {
    mood = state.mood;
    reason = '延续当前情绪';
  } else if (ttlAlive && topic) {
    mood = state.mood;
    reason = `延续当前情绪（话题「${topic.label}」）`;
  } else {
    const guarded = applyMoodGuards({
      weights: adjustWeightsForState(theme.basePool, ctx.stats ?? null, theme.stateBias),
      state,
      now,
      theme,
    });
    mood = pickWeighted(guarded.weights, random());
    penalised = guarded.penalised;
    reason = penalised ? '连着两次中二了，强制低能量' : '日常闲聊';
    moodFresh = true;
  }

  if (!mood) mood = 'plain';
  const definition = theme.moods[mood] ?? theme.moods.plain;
  const changed = mood !== state.mood;

  // Streak only counts *changes into* the chuunibyou group; staying there keeps
  // the streak climbing, which is what eventually forces the penalty.
  const streak = theme.chuunibyouMoods.includes(mood) ? (state.chunibyouStreak ?? 0) + 1 : 0;

  const rawInterjections = theme.interjections[mood] ?? theme.interjections.plain;
  // 出场闸(表见 ARIS_INTERJECTION_TOPIC_GATE):没上闸的语气词照常发;上闸的
  // 要「话题命中 + 这轮新掷中」才放行。过滤后不许空池 —— 真空了退回原池。
  const gate = theme.interjectionTopicGate;
  const gated = gate
    ? rawInterjections.filter((item) => {
        const allowed = gate[item];
        if (!allowed) return true;
        return moodFresh && topic !== null && allowed.includes(topic.id);
      })
    : rawInterjections;
  const interjectionPool = gated.length > 0 ? gated : rawInterjections;
  const interjection = pickAvoiding(interjectionPool, state.recentInterjections, random());
  // **「主题专属」的标记**(2026-10-30 主人拍板:句前模板去机械化)。
  // 只有「上过出场闸、且本轮确实靠闸放行」的语气词才算 —— 例如爱丽丝在 game/light
  // 话题新掷中 fanfare 时的「邦邦咔邦！」(庆典登场的登场音效)。过滤后退回原池的、
  // 或根本没上闸的日常语气词都不算(`buildMoodNote` 据此完全不提语气词)。
  const interjectionScoped = Boolean(
    gate && gated.length > 0 && interjection
      && Object.hasOwn(gate, interjection) && moodFresh && topic !== null,
  );
  const taggedKaomoji = theme.kaomoji
    .filter((entry) => entry.tags.some((tag) => (definition.tags ?? []).includes(tag)))
    .map((entry) => entry.text);
  const kaomojiPool = taggedKaomoji.length > 0 ? taggedKaomoji : theme.kaomoji.map((entry) => entry.text);
  const wantsKaomoji = (definition.tags?.length ?? 0) > 0 && random() < kaomojiChance;
  const kaomoji = wantsKaomoji ? pickAvoiding(kaomojiPool, state.recentKaomoji, random()) : null;

  const cooldowns = { ...(state.cooldowns ?? {}) };
  if (theme.cooldowns[mood]) cooldowns[mood] = now;

  return {
    state: {
      ...state,
      mood,
      topicId: topic?.id ?? null,
      // The TTL runs from when the mood was *chosen*, not from the last message.
      // Refreshing it on every turn would mean a conversation where people keep
      // talking never rolls again — the first mood of the day would stick
      // forever (caught by simulating 2000 turns: 100% one mood).
      expiresAt: changed ? now + ttlMs : state.expiresAt,
      chunibyouStreak: streak,
      cooldowns,
      recentInterjections: remember(state.recentInterjections, interjection, RECENT_INTERJECTIONS),
      recentKaomoji: remember(state.recentKaomoji, kaomoji, RECENT_KAOMOJI),
    },
    mood,
    // 标签挂在 decision 上,`buildMoodNote` 就不必再知道用的是哪套主题。
    label: definition.label,
    directive: definition.directive,
    maxChars: definition.maxChars,
    maxSentences: definition.maxSentences,
    changed,
    reason,
    interjection,
    // 只有「主题专属 + 本轮确实靠出场闸放行」才为 true;`buildMoodNote` 只对它给
    // 「这个场面可以自然用、不强求」的可选提示,其余情况完全不提语气词。
    interjectionScoped,
    kaomoji,
    penalised,
  };
}

/**
 * The private note appended to the prompt for this turn.
 *
 * Kept to two lines: the length binding and the mood, plus the concrete optional
 * items the model *may* use (a kaomoji, or a topic-scoped interjection).
 *
 * ⚠️ 2026-10-30(主人拍板,句前模板去机械化):旧实现把抽中的语气词写成
 *    「语气词用「X」」—— 那是**要求模型用固定开场**,与「让 LLM 自己组织句子」
 *    相反(现场:惠惠频繁「说到钱」「来来来」这类公式化开头)。现在:
 *      · **普通回应完全不提语气词**,允许直接成句,不再要求句前塞词;
 *      · 只有**主题专属**语气词(靠 `theme.interjectionTopicGate` 命中话题才放行的,
 *        如爱丽丝庆典登场的「邦邦咔邦！」),才作为**可选**提示出现:
 *        「这个场面可以自然用「X」，不强求」。
 *    取消强制 ≠ 禁用角色语言:自称、性格、世界观、技能场景用语仍属角色轴,
 *    恰当语境自然使用,不在这里封禁。**不用**扩口头禅池轮换、出站正则删句首
 *    或二次润色模型来换模板 —— 那只是把机械开场藏起来。
 *
 * @param {{label?: string, mood: string, maxSentences: number, maxChars: number,
 *   interjection?: string|null, interjectionScoped?: boolean, kaomoji?: string|null}} decision
 * @returns {string}
 */
export function buildMoodNote(decision) {
  const parts = [
    `本轮情绪：${decision.label ?? MOODS[decision.mood]?.label ?? decision.mood}`,
    `${decision.maxSentences} 句以内、不超过 ${decision.maxChars} 字`,
  ];
  if (decision.interjectionScoped === true && decision.interjection) {
    parts.push(`这个场面可以自然用「${decision.interjection}」，不强求`);
  }
  if (decision.kaomoji) parts.push(`句尾可以带 ${decision.kaomoji}`);
  return parts.join('；');
}

/**
 * Cut a self-initiated message down to the mood's length, at a sentence
 * boundary when there is one.
 *
 * Only ever applied to messages nobody asked for (a warm-up or a self-reply):
 * truncating an answer to a direct question would throw away information the
 * asker wanted.
 *
 * ⚠️ **2026-10-04 修的两个"话没说完"的样子**(用户报「今天说话出现了...省略号,
 * 导致话没说完整」)。根因是**把"…"当成了句末标点**:
 *
 *   1. **句中的停顿被当成了收尾** —— 她写「吾今天可是很努力的,公会**……**」时,
 *      那个 `……` 只是喘口气,而旧实现把它认成"说完了",于是从那儿切开留下 `…`。
 *      → 现在只有**紧挨着句末**的 `…`(后面除了标点/空格没有别的字)才算句末;
 *        句中那种一律当断句点,只在没有真句号时才用它。
 *   2. **切完又补一个 `…`** —— 旧实现先 `slice` 到上限(可能正好切在 `……` 中间),
 *      再拼一个 `…`,于是尾巴变成**悬空的 `……`**:看着就像"话说一半停了"。
 *      → 现在先把尾巴上的省略号与并列标点清干净,再决定补不补。
 *
 * 判据:截断后的结果**不许以省略号结尾,除非原文本就在那儿结束**;
 * 而且**不许以 `，、；,;` 这类并列标点收尾**(那是"话没说完"的另一种样子)。
 *
 * ⚠️ **1.106.2(D174)起它不再管主动发言** —— 主动发言改成"按句分条发"(`splitSpokenLines`),
 *    因为"砍尾巴"正是用户 2026-10-10 报的那个现场(她说了两句,群里只收到第一句)。
 *    保留它是因为它那套"…/并列标点收尾"的判据只此一份(别在别处再写一遍);
 *    现在**唯一**的调用点是 `planSpokenLines()` 里那句"答话不套上限"的对照日志。
 */
export function truncateForMood(text, maxChars) {
  const trimmed = String(text ?? '').trim();
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || trimmed.length <= maxChars) return trimmed;
  const head = trimmed.slice(0, maxChars);
  const floor = Math.floor(maxChars / 2);
  /** 收尾前的清理:并列标点与悬空省略号一律不留(那是"话没说完"的两种样子)。 */
  const tidy = (value) => value.replace(/[，、,;；:：…\s]+$/, '');

  // —— 候选边界:每个标点位置一个,并记下"用什么收" ——
  //    `end` = 句末(`。！？`)→ 原样留着;`cut` = 句中停顿/断句点 → 换成 `…`
  const candidates = [];
  for (let at = 0; at < head.length; at += 1) {
    const ch = head[at];
    if ('。！？'.includes(ch)) { candidates.push({ at, end: true }); continue; }
    if ('，、,;；:：…'.includes(ch)) {
      candidates.push({ at, end: false });
      // `……` 这种连续省略号算**一个**边界(切在整串之前),别把它数成两个
      if (ch === '…' && head[at + 1] === '…') at += 1;
    }
  }
  // ① **最靠后的**那个边界优先 —— 这一条同时满足"切得少"和"切得好看"
  //    ⚠️ 只挡"切得太狠"(不到上限的 1/4):否则「湖面上……」那类早期停顿会把话切掉一大半
  const minKept = Math.max(3, Math.floor(floor / 2));
  const best = candidates.filter((row) => row.at >= minKept).pop();
  if (best) {
    return best.end ? head.slice(0, best.at + 1) : `${tidy(head.slice(0, best.at))}…`;
  }
  // ② 没有任何(够靠后的)标点:硬切,但先清尾巴再补一个省略号
  //    —— 不许切在 `……` 中间留下半个,那正是用户报的"话没说完"
  return `${tidy(head)}…`;
}

/**
 * 把一段普通发言切成**多条短句**交付(1.171.0 / D288 起;S1 风格包接线后由风格策略调用)。
 *
 * @param {string} text 模型原文
 * @param {{maxChars?: number, maxLines?: number}} [options]
 * @param {boolean} [preservePunctuation=false] **S1 风格包 `punctuation.preserve`**:
 *   true 时**跳过** `cleanSpokenLine` 的行尾/停顿标点清理,标点原样保留;
 *   链接/代码保护、空段过滤、段数封顶、防碎段照旧。任务/知识轮的整条保真分支
 *   **不经过这里**(`planSpokenLines` 的 preserveFormatting 先返回)。
 *   ⚠️ 刻意放在第三个位置参数(而不是 options 里):保持既有签名/旧切片兼容。
 */
export function splitSpokenLines(text, { maxChars = 0, maxLines = 5 } = {}, preservePunctuation = false) {
  // 空白规范化:行内连续空格并成一个,首尾 trim;换行**保留**(它是边界,不是空格)
  const plain = String(text ?? '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
  if (plain === '') return [];
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 0;
  const limitLines = Number.isSafeInteger(maxLines) && maxLines > 0 ? maxLines : 1;

  // ⓪ **链接与围栏代码块先摘出去**(1.171.0 / D288 链接;1.171.1 / D289 代码):
  //    两类东西的 `:` `/` `.` `;` `,` 都不是边界,而且代码经不起标点清理
  //    (`foo(a, b)` 会变 `foo(a b)`)—— 占位符换掉再切,发之前原样放回(一份恢复实现)。
  //    URL 尾巴上的中文标点不算 URL 的一部分(「看 https://x.com/a。第二句」)。
  //    围栏代码块整块一条,不切、不清、不剥(没闭上的围栏保到文末)。
  const protected_ = [];
  const protect = (hit) => {
    protected_.push(hit);
    return `${PROTECT_SENTINEL}${protected_.length - 1}${PROTECT_SENTINEL}`;
  };
  // ⚠️ URL 的字符类**排除 CJK 与全角区**(1.171.1 / D289 复核抓到:`\S+` 会把
  // 「看https://x.com/a。第二句」整尾吞成"链接",句号边界消失)。ASCII 标点照旧允许
  // (URL 本身合法字符),尾巴上残留的引号/括号由 protect 里的 trim 收掉。
  const source = plain
    .replace(/```[^\n]*\n[\s\S]*?\n?```|```[^\n]*```|```[\s\S]*$/g, protect)
    .replace(/https?:\/\/[^\s\u3000-\u303F\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+/g,
      (hit) => protect(hit.replace(/[。，、；：！？…）)】」』.,;:!?\]]+$/, '')));

  // ① **句末标点(和换行)切句** —— 保留标点。⚠️ `……` 不算句末(那是喘口气,见 `truncateForMood`),
  //    它只在"这一段太长"时当软边界用(下面 `splitLongPiece`)。
  const pieces = [];
  let buffer = '';
  // ⚠️ 括号深度:括号里的 `。！？；` 不是句末 —— 颜文字 `(￣ω￣;)` 就是现场(2026-10-12)
  let depth = 0;
  const flush = () => {
    const one = buffer.trim();
    if (one !== '') pieces.push(one);
    buffer = '';
  };
  for (const ch of source) {
    if (ch === '\n') {
      // 换行只在**括号外**才是一道边界(括号没闭上就换行,内容还连着 —— 别把它切散)
      if (depth === 0) flush(); else buffer += ch;
      continue;
    }
    if (BRACKET_OPEN.includes(ch)) depth += 1;
    else if (BRACKET_CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    buffer += ch;
    // ⚠️ 括号深度 > 0 时标点**不是句末**(2026-10-12 现场:颜文字 `(￣ω￣;)` 里的 `;`
    //    被当句末,`)` 单独成了一条 —— 见 outbound #53/#54)
    if (depth === 0 && '。！？!?；;'.includes(ch)) flush();
  }
  flush();

  // ② **超长的那一段**退到逗号级(仍然一个字不丢)
  const lines = [];
  for (const piece of pieces) {
    if (limit <= 0 || piece.length <= limit) { lines.push(piece); continue; }
    lines.push(...splitLongPiece(piece, limit));
  }

  // ②½ **防碎段**(1.171.0 / D288):软边界会把「然后我们…」「所以…」这种零头切成
  //    独立一条 —— 单独发反而假(业界同类 = TomoriBot 的孤儿段并入相邻段)。
  //    ⚠️ 只并"以连接词开头的零头";「哈哈」「嗯。」这种**故意的短句**不动。
  const joined = [];
  for (const piece of lines) {
    const prev = joined[joined.length - 1];
    if (prev !== undefined && isSpokenFragment(piece)) joined[joined.length - 1] = prev + piece;
    else joined.push(piece);
  }

  // ③ **段数封顶**:多出来的并进最后一段(不丢字;宁可最后一条长一点,也不发十条)
  const capped = joined.length > limitLines
    ? [...joined.slice(0, limitLines - 1), joined.slice(limitLines - 1).join('')]
    : joined;

  // ④ **口语标点清理**(1.171.0 / D288;行尾剥 + 段内停顿标点变空格),然后**放回被保护的内容**。
  //    整段只有标点时(`。。。` 这种)结果就是空串 → 过滤掉 = 一条都不发(不是发一条空的)。
  //    ⚠️ S1 风格包 `punctuation.preserve=true` 时跳过清理 → 标点原样保留(仍 trim 空白,
  //       仍过滤空段,链接/代码仍在 restoreProtected 里原样放回)。
  return capped
    .map((line) => restoreProtected(
      preservePunctuation ? String(line ?? '').trim() : cleanSpokenLine(line),
      protected_,
    ))
    .filter((line) => line !== '');
}

/**
 * **聊天里不会打在结尾的标点**(1.106.3 / D175)。
 *
 * 用户 2026-10-10:「不用逗号收尾,句号也不用,现在的正常人发言都不会打句号和收尾的标点符号」。
 * ⚠️ 1.171.0 / D288 起,行尾清理**扩大**到 `！？…`(见 `CHAT_TRAILING_TONE`)——
 *    拟人化普及后"不带标点"是明确目标,情绪靠措辞表达;本常量保持原样,
 *    因为 `transcript.js` 的历史比对与测试仍引用它(它的语义 = D175 那一刀的口径)。
 */
const CHAT_TRAILING_PUNCT = '。，、,;；:：';

/** Local display content is separate from the unchanged runtime policy. */
const CHAT_TRAILING_TONE = '！？!?.…';

/** 行尾清理的完整集合(`CHAT_TRAILING_PUNCT` + 语气标点)。 */
const SPOKEN_TRAILING_PUNCT = CHAT_TRAILING_PUNCT + CHAT_TRAILING_TONE;

/**
 * **段内的停顿标点**(1.171.0 / D288):清理时换成**一个空格**(不是删掉 ——
 * 删了中文字会粘连)。⚠️ 只在**括号外**换:动作/颜文字里的标点原样留。
 * ⚠️ 1.171.2 / D290:**`，,` 按主人拍板退出这个集合** —— 句中逗号保留原样,
 * 只有行尾那一刀照旧剥(见 `CHAT_TRAILING_PUNCT`)。其余停顿标点(`。、;；:：`)照旧换空格。
 */
const SPOKEN_PAUSE_PUNCT = '。、;；:：';

/**
 * **保护占位哨兵**(1.171.0 / D288 链接;1.171.1 / D289 起同时保护围栏代码块):
 * 私用区字符,正常聊天文本里不会出现。被保护的内容在切句/清理期间换成
 * `哨兵+序号+哨兵`,发之前再放回来。
 */
const PROTECT_SENTINEL = '\uE000';

/**
 * **软边界切出来的零头**(1.171.0 / D288):以连接词开头且还不长的段,
 * 并进前一段,不单独成条。表与上限都是【暂定】,按真实回复样本调。
 */
const SPOKEN_CONNECTIVES = ['所以', '不过', '但是', '然后', '可是', '而且', '就是', '对了', '话说', '结果'];
const SPOKEN_FRAGMENT_MAX = 8;

function isSpokenFragment(piece) {
  const text = String(piece ?? '');
  if (text.length === 0 || text.length > SPOKEN_FRAGMENT_MAX) return false;
  return SPOKEN_CONNECTIVES.some((word) => text.startsWith(word));
}

/**
 * **口语 emoji 池**(1.178.0 / D299,2026-10-23 主人拍板定稿):**黄脸为主** 30
 * (国人 QQ/微信高频)+ 其他类只留国民热门 10 —— 表情是语气不是抽卡,语境无关的
 * 符号会破坏拟真(教训:旧池 10 个里 5 个是 ✨💥💢⚡👑 这类纯符号,抽到就
 * "像在随机发表情")。想增删先过主人。⚠️ 刻意只用 Unicode emoji:QQ 原生表情是
 * CQ 码,`sanitizeOutgoingText()` 会剥它(那是防注入层,不破例)。
 */
export const SPOKEN_EMOJI_POOL = [
  // 黄脸 30
  '😂', '🤣', '😅', '😆', '😄', '😁', '😊', '😍', '🤩', '🥰',
  '😋', '😜', '🤪', '😏', '😒', '🙄', '😬', '😴', '🥺', '😭',
  '😢', '😤', '😡', '😳', '🥵', '😱', '🤔', '🥳', '😎', '🤗',
  // 其他类只留国民热门 10
  '👍', '❤️', '🌹', '💪', '🔥', '💯', '🎉', '🍉', '🐶', '🙏',
];

/**
 * **这一轮要不要单发一个 emoji**(1.171.2 / D290):概率掷骰 + 避开最近用过的
 * (kaomoji 同款 `pickAvoiding`)。`chance <= 0` = 关。返回 `null` = 这轮不带。
 * 与 kaomoji **各掷各的**(可共存;频率主人拍板后再调)。
 * @param {{chance?: number, random?: () => number, recent?: string[]}} [options]
 */
export function maybeSpokenEmoji({ chance = 0, random = Math.random, recent = [] } = {}) {
  if (!(chance > 0) || random() >= chance) return null;
  return pickAvoiding(SPOKEN_EMOJI_POOL, recent, random());
}

/**
 * **一条的口语标点清理**(1.171.0 / D288;纯函数):
 *   ① 段内停顿标点(括号外)→ 一个空格 —— "去标点不粘连";
 *   ② 行尾标点(`SPOKEN_TRAILING_PUNCT`,连串 `!!!`/`。。。` 一起)剥到不见。
 * 颜文字/括号里的标点原样留(括号深度保护);链接此刻还是占位符,不受影响。
 */
function cleanSpokenLine(line) {
  const chars = Array.from(String(line ?? ''));
  let out = '';
  let depth = 0;
  for (const [at, ch] of chars.entries()) {
    if (BRACKET_OPEN.includes(ch)) depth += 1;
    else if (BRACKET_CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    // ⚠️ 两侧都是英文字母/数字的标点不是停顿(`12:30` / `1,000` —— 与软边界同一条护栏)
    const prev = chars[at - 1] ?? '';
    const next = chars[at + 1] ?? '';
    const numeric = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
    out += depth === 0 && !numeric && SPOKEN_PAUSE_PUNCT.includes(ch) ? ' ' : ch;
  }
  out = out.replace(/[ \t\u3000]{2,}/g, ' ').trim();
  while (out !== '' && SPOKEN_TRAILING_PUNCT.includes(out[out.length - 1])) {
    out = out.slice(0, -1).trimEnd();
  }
  return out;
}

/**
 * 把占位符换回被保护的内容(链接/代码块;找不到对应序号时**原样保留占位**,不吞字)。
 * ⚠️ 1.171.1(D289 复核抓到的高严重度 bug):以前用 `re.exec` 循环 + 对被切短的
 * `rest` 沿用旧 `lastIndex`,同一行第 2 个占位符永远恢复不了(偶数序交替漏)——
 * 改成一次 `replace` 回调,匹配推进由引擎管,不再有状态残留。
 */
function restoreProtected(line, parts) {
  const re = new RegExp(PROTECT_SENTINEL + '(\\d+)' + PROTECT_SENTINEL, 'g');
  return String(line ?? '').replace(re, (whole, index) => {
    const i = Number(index);
    return Number.isInteger(i) && parts[i] !== undefined ? parts[i] : whole;
  });
}

/**
 * **判据归一**(1.171.0 / D288;"除标点与空白外一个字不丢、不重排"):
 * 原文与切完拼回去的各跑一遍,结果必须相等。它**故意**跑的是一条与
 * `cleanSpokenLine` 不同的简单路径(只删不换),这样清理逻辑自己改坏了会被它咬住 ——
 * 判据不能与被判者同一份实现(D159 的精神)。`～` 两边都留,不影响相等性。
 */
export function normalizeSpokenForJudge(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, (hit) => hit.replace(/[。，、；：！？…）)】」』.,;:!?\]]+$/, ''))
    .replace(new RegExp(`[${SPOKEN_TRAILING_PUNCT}${SPOKEN_PAUSE_PUNCT}～]`, 'gu'), '')
    .replace(/\s+/g, '');
}

/**
 * **切句不许切进括号里**(1.115.1):颜文字 `(￣ω￣;)` 里的 `;` 不是句末,
 * 半角/全角括号与引号括起来的内容都是一个整体。`splitSpokenLines` 与
 * `splitLongPiece` 共用这一对常量(只留一处实现)。
 */
const BRACKET_OPEN = '（(「『【〔';
const BRACKET_CLOSE = '）)」』】〕';

/** 导出给测试与 transcript 比对用:D175 的行尾集合(语义保持那一刀的口径)。 */
export { CHAT_TRAILING_PUNCT };

/**
 * 超长的一段 → 按**软边界**(逗号/顿号/冒号/省略号)分桶,每桶尽量不超过 `limit`。
 *
 * ⚠️ 单个"软单元"本身就超长(整段没有一个标点)时,它**自己一条**发出去 ——
 *    这是"不砍尾巴"的代价,也是刻意的:长句照发,总比话说到一半好。
 * ⚠️ 1.171.0 / D288:**两侧都是英文字母/数字时不切**(`1,000` / `12:30` 不是两句话;
 *    maiBot 同一条规则的启发,出处见 `docs\03` D288)。链接已在外层被占位符换走。
 */
function splitLongPiece(piece, limit) {
  const units = [];
  let buffer = '';
  // ⚠️ 同样看括号深度:颜文字 `(￣ω￣;)`、`(TдT;;)` 里的软边界标点不许切(2026-10-12 现场)
  let depth = 0;
  const chars = Array.from(String(piece ?? ''));
  for (const [at, ch] of chars.entries()) {
    if (BRACKET_OPEN.includes(ch)) depth += 1;
    else if (BRACKET_CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    buffer += ch;
    if (depth !== 0 || !'，,、：:…；;'.includes(ch)) continue;
    const prev = chars[at - 1] ?? '';
    const next = chars[at + 1] ?? '';
    if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) continue; // `1,000` / `12:30`
    units.push(buffer);
    buffer = '';
  }
  if (buffer !== '') units.push(buffer);

  const out = [];
  let line = '';
  for (const unit of units) {
    if (line !== '' && line.length + unit.length > limit) { out.push(line); line = ''; }
    line += unit;
    if (line.length >= limit) { out.push(line); line = ''; }
  }
  if (line !== '') out.push(line);
  return out;
}
