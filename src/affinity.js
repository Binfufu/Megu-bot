/**
 * **好感度**(D104 第①批,2026-10-02)。**纯函数**。
 *
 * 用户原话:「**好感度**、公会等级……可以都做,**只有档位没有数值**,
 *   改变靠**向量关联度随机影响**(可以联动 rag 库)」。
 *
 * 为什么先做它:`memory.db` 里她"认识人"已经有一阵子了(谁说过话、叫什么),
 * 但**对每个人的温度是一样的** —— 这是"她在自己的世界里生活"最缺的一块。
 *
 * 三条口径:
 *   ① **只有档位对外**:分数只存在库里(和 `health`/`mood` 同一个规矩,D103),
 *      前端与提示词里只说"眼熟/认得/说得上话/朋友/交心";
 *   ② **有上限**:每人每天最多涨 `DAILY_CAP` —— 不然刷屏就能变"交心"(用户最反感的那种);
 *   ③ **要说得出来由**:每次变化把 `why` 记进记录里(哪一轮、因为什么涨的)。
 */

/** 档位表(只有档位名,没有"1234 分"这种对外的东西)。 */
export const AFFINITY_TIERS = [
  { id: 'stranger', min: 0, label: '眼熟' },
  { id: 'known', min: 12, label: '认得' },
  { id: 'talked', min: 35, label: '说得上话' },
  { id: 'friend', min: 80, label: '朋友' },
  { id: 'close', min: 160, label: '交心' },
];

/** 每人每天的上限(防刷)。 */
export const AFFINITY_DAILY_CAP = 20;

/** 各种互动涨多少。`chat` 是最小的一档:说话本身就算数,但很慢。 */
export const AFFINITY_GAIN = {
  chat: 1,
  praise: 1,
  fed: 3,
  company: 2,
  quest: 1,
  gift: 2,
};

/** 分数 → 档位(纯函数)。 */
export function affinityTier(score) {
  const number = Number(score) || 0;
  let tier = AFFINITY_TIERS[0];
  for (const row of AFFINITY_TIERS) if (number >= row.min) tier = row;
  return tier;
}

/** 本地日期键(每天的上限按本地日算,和"今天接过几条委托"同一套口径)。 */
export function dayKeyOf(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * 给一条好感记录**加一笔**(纯函数,不改入参)。
 *
 * @param {{score?: number, daily?: {day: string, gain: number}, why?: string[]}|null} record
 * @param {{kind?: string, now?: number, detail?: string}} ctx
 * @returns {{record: object, delta: number, tier: object, promoted: boolean, capped: boolean}}
 */
export function applyAffinity(record, { kind = 'chat', now = Date.now(), detail = '' } = {}) {
  const day = dayKeyOf(now);
  const base = {
    score: Number(record?.score) || 0,
    daily: record?.daily?.day === day ? record.daily : { day, gain: 0 },
    why: Array.isArray(record?.why) ? record.why.slice(0, 4) : [],
  };
  const before = affinityTier(base.score);
  const want = AFFINITY_GAIN[kind] ?? 1;
  const room = Math.max(0, AFFINITY_DAILY_CAP - base.daily.gain);
  const delta = Math.min(want, room);
  const score = base.score + delta;
  const after = affinityTier(score);
  // 由头:只留最近几条(它要进日志,不能无限长)。**哪怕没给 detail 也要记下"是什么互动"** ——
  // "为什么涨"是用户要的"有依据"(D104),空着就等于没依据。
  const why = delta > 0
    ? [`${kind}${detail ? `:${detail}` : ''}`.slice(0, 40), ...base.why].slice(0, 4)
    : base.why;
  return {
    record: { ...base, score, daily: { day, gain: base.daily.gain + delta }, why, updatedAt: now },
    delta,
    tier: after,
    promoted: after.id !== before.id,
    capped: delta < want,
  };
}

/** 好感记录 → 一句"我对你什么感觉"(进提示词用;**只说档位,不报数**)。 */
export function describeAffinity(record, name = '对方') {
  const tier = affinityTier(record?.score ?? 0);
  const tone = {
    stranger: '还不太熟,客气一点、别自来熟',
    known: '见过几次,可以随便搭话但别装熟',
    talked: '聊过不少次了,说话可以随意些',
    friend: '是朋友了,可以开玩笑、可以损他两句',
    close: '交情很深了,可以托付事情、也可以直接骂他',
  }[tier.id];
  return `你对 ${name} 的熟悉程度：**${tier.label}**（${tone}）`;
}

/** 记录列表 → `/熟人` 那种一览(纯函数)。 */
export function describeAffinityList(entries = []) {
  const rows = entries
    .filter((row) => row?.name)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((row) => {
      const tier = affinityTier(row.score ?? 0);
      return `${row.name} —— ${tier.label}`;
    });
  if (rows.length === 0) return '（还没认识几个人。）';
  return ['【熟人】', ...rows].join('\n');
}
