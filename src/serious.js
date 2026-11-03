/**
 * **严肃话题**的识别与收敛(2026-10-01,见 `docs\03` D80)。
 *
 * ## 为什么必须有这一层
 *
 * 用户 2026-10-01 的原话:
 * > 「健康要不要加上重病,我感觉这个比较严肃。同时涉及严肃话题的时候也要**按角色设定判断**
 * > (如 911,大地震等等)」
 *
 * 这条抓的是一个**真实的事故形状**:这个项目里有一堆"让她更像人"的花活 ——
 * 每轮随机风格提示(「这次顺带抱怨一下饿或者穷」「这次先愣住,再嘴硬」)、情绪掷骰、
 * 颜文字、讨饭梗、中二腔。**在 911 / 大地震 / 家里人得了癌症的时候,这些全是灾难。**
 *
 * 所以规矩和 D22 一样:**行为由代码负责**。桥在这一轮**关掉花活**,并把
 * "这是严肃话题、按你的角色设定认真回应"写进提示词 —— 她仍然是当前角色/协作角色,
 * 只是**收敛**,而不是被桥替代成另一个说话的人。
 *
 * ## 一条不能越过的线
 *
 * 这一层只做两件事:**关掉娱乐化的花活** + **给一句态度提示**。
 * 它**不写台词**,也**不替她判断"该说什么"** —— 那是角色卡的活(用户要的正是"按角色设定判断")。
 */

/** 话题档位:`critical`(重病/死亡/灾难)与 `serious`(较轻但同样不适合玩梗)。 */
export const SERIOUS_CATEGORIES = Object.freeze({
  /** 重病 —— 用户点名要加的那一类。 */
  illness: ['癌症', '肿瘤', '化疗', '放疗', '确诊', '住院', '手术', 'ICU', '重症', '病危', '晚期',
    '白血病', '中风', '心梗', '脑梗', '抢救', '绝症', '瘫痪', '失明', '截肢', '尿毒症', '肝移植', '透析'],
/** 死亡 / 丧亲 / 自伤。⚠️ 2026-11-03 收紧：删掉"走了"（"我先走了"是最常见的日常句，误伤率太高）。 */
  death: ['去世', '过世', '葬礼', '出殡', '自杀', '想死', '不想活', '活不下去', '轻生', '遗书'],
  /** 灾难与社会事件。⚠️ 2026-11-03 收紧：删掉"爆炸/塌了/台风/龙卷风/撞车/开战/疫情/封城"
   *  —— 它们在玩梗、游戏、天气闲聊里的误伤率远高于真事件（主人："这个几乎用不上，可以更严"）。 */
  disaster: ['地震', '海啸', '洪水', '泥石流', '山火', '火灾', '坠机', '空难', '车祸',
    '战争', '空袭', '枪击', '恐怖袭击', '911', '逃难'],
});

/** 同一类里只要命中一个就够 —— 命中多个也只算一次(档位取最重的那个)。 */
const CATEGORY_WEIGHT = { illness: 'critical', death: 'critical', disaster: 'serious' };

/**
 * **玩笑 / 否认 / 非真实**语境（2026-11-03 新增）。
 *
 * 现场：「这是动漫里的爆炸，不是真事」被当成严肃话题，把轻松接话拉成了沉重说教。
 * 命中这一组就**整轮不判严肃**：当事人自己已经声明"不是真的 / 在开玩笑"。
 */
const JOKE_OR_NEGATION_RE = /不是真事|不是真的|不是事实|开玩笑|玩梗|梗图|表情包|打个比方|比喻一下|梦到|做梦|梦里|假的|编的|夸张|演一下/;

/**
 * **虚构作品**语境（动漫/游戏/影视/小说/同人）。
 *
 * 只用来**压掉 disaster 那一档**（"动漫里的火灾""游戏剧情里的地震"不该让语气变沉重）；
 * 重病/丧亲两类不压 —— 「我妈住院了，我在游戏里…」这种句子不能因为出现"游戏"就不安慰。
 */
const FICTION_RE = /动漫|动画|漫画|二次元|番剧|电影|电视剧|小说|游戏|剧情|角色|同人|cosplay|cos|虚拟|模拟|设定里|图里|画面/;

/**
 * 这句话是不是严肃话题?**纯函数**。
 *
 * 2026-11-03 口径（主人）：**宁可不判，也不要误伤**。真严肃场景很少，误判一次会把
 * 一段日常调侃写成沉重说教。所以先过两道排除：玩笑/否认语境 → 整轮不判；
 * 虚构语境 → 只压 disaster。后续可考虑把"要不要认真"整个交给模型判断（见 TODO）。
 *
 * @param {string} text 这一轮的人话
 * @returns {{level: 'critical'|'serious'|null, categories: string[], matched: string[]}}
 */
export function detectSerious(text) {
  const source = String(text ?? '');
  const empty = { level: null, categories: [], matched: [] };
  if (source === '') return empty;
  if (JOKE_OR_NEGATION_RE.test(source)) return empty;
  const categories = [];
  const matched = [];
  for (const [category, words] of Object.entries(SERIOUS_CATEGORIES)) {
    const hit = words.filter((word) => source.includes(word));
    if (hit.length === 0) continue;
    categories.push(category);
    matched.push(...hit);
  }
  if (categories.length === 0) return empty;
  const level = categories.some((category) => CATEGORY_WEIGHT[category] === 'critical') ? 'critical' : 'serious';
  // 只有 disaster 这一档被虚构语境压掉；重病/丧亲不压。
  if (level === 'serious' && categories.every((category) => category === 'disaster') && FICTION_RE.test(source)) {
    return empty;
  }
  return { level, categories, matched };
}

/**
 * 这一轮该怎么收敛?**纯函数** —— 让"关掉哪些花活"这件事可测、可复核。
 *
 * | 关掉什么 | 为什么 |
 * |---|---|
 * | 每轮风格提示(`nextNudges`) | 里面写着「顺带抱怨一下饿或者穷」「先愣住再嘴硬」—— 严肃场合是灾难 |
 * | 情绪掷骰那一块(`moodNotes`) | 它的语气词/颜文字/接话是把这一轮当闲聊在调味 |
 * | 主动玩梗的口吻 | 由下面那句提示交代,不写死台词 |
 *
 * @param {string} text
 * @param {{enabled?: boolean}} [options]
 */
export function turnPolicyFor(text, { enabled = true } = {}) {
  const serious = detectSerious(text);
  if (!enabled || serious.level === null) {
    return { serious, suppressNudges: false, suppressMood: false, note: null };
  }
  return {
    serious,
    suppressNudges: true,
    suppressMood: true,
    note: seriousNote(serious),
  };
}

/**
 * 给她的态度提示。⚠️ **只交代态度与边界,不写台词** —— 具体怎么说由角色卡决定。
 */
export function seriousNote(serious) {
  const what = {
    illness: '他提到了重病 / 住院 / 这类事',
    death: '他提到了去世、丧亲,或者很消极的念头',
    disaster: '他提到了灾难或严重的社会事件',
  };
  const lines = Object.entries(what)
    .filter(([category]) => serious.categories.includes(category))
    .map(([, text]) => text);
  return [
    `⚠️ 这一轮是**严肃话题**（${lines.join('；') || '严肃的事'}）：`,
    '· 用你自己的语气**认真**回应，但收着点：不玩梗、不用讨饭梗/中二腔/颜文字来活跃气氛；',
    '· 不要说教，也不要追问细节（他不想说就不问）；',
    '· 如果不知道说什么，短而真诚就够 —— 别用"加油""会好起来的"这种套话敷衍；',
    '· 你仍然是你（照角色卡），只是**把平时那些花活收起来**。',
  ].join('\n');
}
