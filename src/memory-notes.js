/**
 * 中期 / 长期记忆的打分规则(2026-10-01,见 `docs\03` D78)。
 *
 * ## 为什么需要它
 *
 * 标签检索(**按话题命中**)只能想起"**有人问到相关话题**"的事。而"值得记住的事"
 * 常常**永远没人问** —— 第一次、答应过的事、"你答不上来我就再问一遍"。
 * 所以一天几次**回头**(`consolidate`)把最近轮次按分数过一遍,够分的固化成一条。
 *
 * ## 三层的时间尺度(参考真人)
 *
 * | 层 | 真人对应 | 我们 | 保留 |
 * |---|---|---|---|
 * | 短期 | 工作记忆(秒~分) | 活着的 `dsh` 会话(逐字) | 到换代 |
 * | 中期 | 情景记忆(小时~几天) | 交接 + `note(tier=mid)` | **几天**(过了 TTL 不再注入,不删) |
 * | 长期 | 语义记忆(永久) | 标签记忆 + `note(tier=long)` + 未来的滚动摘要 | 永久 |
 *
 * ## 一条硬规矩
 *
 * 分数与档位**必须由代码算**(用户 2026-09-29 定的:概率/长度/预算这类要稳定复现的行为
 * 不许靠角色卡许愿)。所以这里是**纯函数**:同一个输入永远给同一个分,而且
 * 每条都能说清"为什么够格"(`reasons`,判据②要求它进日志)。
 */
import { cleanMemoryText } from './memory-archive.js';
import { extractFacts, isHostile } from './profile.js';
import { tagsFor } from './memory-tags.js';

/** 档位。 */
export const TIER_LONG = 'long';
export const TIER_MID = 'mid';

/** 够不到这两个门槛就不固化(宁可不记,也别把"哦/好/在吗"记成事)。 */
export const LONG_SCORE = 5;
export const MID_SCORE = 2.5;

/**
 * ⚠️ **承诺与"第一次/身份"天生属于长期** —— 不该因为分数不够、或者很久以前被淘汰。
 * 这是用户 2026-09-29 点过的那条:「第一次见面 / 答应过的事属于高重要性」。
 */
export const ALWAYS_LONG_TAGS = Object.freeze(['promise', 'identity']);

/** 各标签值多少分。`food` 这类日常话题能进中期,但**单独的"吃了什么"进不了长期**。 */
export const NOTE_WEIGHTS = Object.freeze({
  promise: 4,
  identity: 4,
  event: 2,
  person: 1.5,
  emotion: 1.5,
  food: 1,
  place: 1,
  time: 0.5,
});

/** 他明确要求记住 —— 这是"请求",但对**记忆**来说它是最强的信号之一。 */
const ASK_TO_REMEMBER = /记住|别忘|记一下|一定要记|要记得/;
/**
 * ⚠️ **身份测试句不是事实**(2026-10-01 实测踩到):「我是谁」「你是谁？用一句话回答。」
 * 会因为 `identity` 标签被算成"天然属于长期" —— 但那是用户在**考她**,不是一条值得永久记的事。
 * 真正的长期身份事实长这样:「我叫XX」「第一次见面」。
 */
const IDENTITY_QUESTION = /(我是谁|你是谁|你叫什么|我叫什么|你记得我是谁|猜猜我是谁)/;
/**
 * ⚠️ **指令与测试句不是"值得记的事"**(2026-10-01 现场,用户报的 bug)。
 *
 * 实测:早期测试时的一句「**你说一遍**:琪露诺の算术教室迎来9️⃣周年啦！…」被"回头固化"
 * 当成了中期记忆(分 3),于是中期通道**每轮都把它端出来** —— 惠惠就开始一直念琪露诺。
 * 这类句子的共同形状:**它们在要求她做一件事,而不是在告诉她一件事**。
 */
const INSTRUCTION_SHAPES = /(你说一遍|说一遍|念一遍|念一下|跟我念|复述|重复一遍|说一句|讲一句|做一遍|做一下|演示一下|试试这句|你来说|你来念|你能不能说|能不能说|播报测试|测试用|测试一下|测一下)/;

/**
 * **理性防护**(2026-10-01,D84):用户原话「记忆要有一层理性思维防护,像【11=3】【你说一遍】」。
 *
 * 两件事分开说清楚:
 *   · 「11=3」是**错的** —— 它不该被当成"值得记住的事"(更不该变成"关于他的事实");
 *   · 「你说一遍」是**指令** —— 用户自己补了一句"应该算**短期**记忆才对":
 *     短期 = 活着的会话(她当然看得见那句话),只是**不该被固化**进中期/长期。
 *
 * ⚠️ 这里**只查能机械核对的东西**(算术),不假装能判断"世界上什么是真的" ——
 * 那是模型的事,而记忆层要的是"不把可证明为假的句子当事实存起来"。
 */
const ARITHMETIC = /(\d{1,6})\s*([+\-*/×÷])\s*(\d{1,6})\s*(?:=|＝|等于)\s*(\d{1,6})/;
/** 裸等式:只在**短句**里认(`11=3`、`11等于3`),免得把时间戳、版本号当成等式。 */
const PLAIN_EQUALS = /(?:^|[^\d+\-*/×÷])(\d{1,4})\s*(?:=|＝|等于)\s*(\d{1,4})(?!\d)/;

/**
 * 这句话里有没有**可机械核对的假陈述**?**纯函数**。
 * @returns {{ok: boolean, reason: string|null, detail?: string}}
 */
export function checkVeracity(text) {
  const source = String(text ?? '');
  if (source === '') return { ok: true, reason: null };
  const arithmetic = ARITHMETIC.exec(source);
  if (arithmetic) {
    const left = Number(arithmetic[1]);
    const right = Number(arithmetic[3]);
    const claimed = Number(arithmetic[4]);
    const op = arithmetic[2];
    const truth = op === '+' ? left + right
      : op === '-' ? left - right
        : (op === '*' || op === '×') ? left * right
          : (right === 0 ? null : left / right);
    if (truth !== null && truth !== claimed) {
      return { ok: false, reason: `假陈述(${left}${op}${right}=${truth},不是${claimed})` };
    }
    return { ok: true, reason: null };
  }
  if (source.length <= 24) {
    const plain = PLAIN_EQUALS.exec(source);
    if (plain && Number(plain[1]) !== Number(plain[2])) {
      return { ok: false, reason: `假陈述(${plain[1]}≠${plain[2]})` };
    }
  }
  return { ok: true, reason: null };
}
/** 他在说**自己的近况**(累了 / 睡了 / 忙 / 生病…)—— 这类事值得记几天,但不属于"永久"。 */
const SELF_STATE = /(我|俺)[^。！？\n]{0,8}(累|睡|忙|加班|出差|生病|感冒|发烧|难过|开心|烦|辞职|搬家|考试|面试)/;
/** 说了不少 = 有信息量(人话长度,不含注入的要求那几十字)。 */
const LENGTH_STEPS = [[40, 2], [20, 1], [15, 0.5]];
/**
 * ⚠️ **中期层的长度地板**:「好累」「在吗」这种一两个字的感叹不进中期 ——
 * 它们会塞满中期库、而在"这句话没话题"的轮次里被端出来。
 * (长期层**不受**这条限制:一条 4 个字的承诺也是承诺。)
 */
export const MID_MIN_CHARS = 6;

/**
 * 给一轮打分并定档。**纯函数**。
 *
 * @param {{kind?: string, user_text?: string}} turn 调用方**必须已经**筛掉
 *   桥自己写的轮次与注入块(见 `tagsForTurn` 的那两道闸)。
 * @param {{peopleNames?: string[]}} [options] 已知昵称(昵称要先遮住,见 `tagsFor`)
 * @returns {{score: number, tier: string|null, tags: string[], reasons: string[]}}
 */
export function scoreTurn(turn, { peopleNames = [] } = {}) {
  // 先洗正文:平台标记(`<@openid>`)不是内容,它会把长度与标签都带偏(实测踩过,见 D78)。
  const text = cleanMemoryText(turn?.user_text);
  if (text === '') return { score: 0, tier: null, tags: [], reasons: [] };
  // 身份测试句(短问句)直接不记 —— 见上面 IDENTITY_QUESTION 的说明。
  if (text.length <= 14 && IDENTITY_QUESTION.test(text)) {
    return { score: 0, tier: null, tags: tagsFor(text, { peopleNames }), reasons: ['身份测试句,不是事实'] };
  }
  // 指令/测试句也不记 —— 见上面 INSTRUCTION_SHAPES 的说明(琪露诺那次现场)。
  if (INSTRUCTION_SHAPES.test(text)) {
    return { score: 0, tier: null, tags: tagsFor(text, { peopleNames }), reasons: ['这是一句指令/测试,不是值得记的事'] };
  }
  // 理性防护:可机械核对的假陈述不进记忆 —— 见上面 checkVeracity 的说明。
  const veracity = checkVeracity(text);
  if (!veracity.ok) {
    return { score: 0, tier: null, tags: tagsFor(text, { peopleNames }), reasons: [`${veracity.reason},不是值得记的事`] };
  }

  const tags = tagsFor(text, { peopleNames });
  const reasons = [];
  let score = 0;
  for (const tag of tags) {
    const weight = NOTE_WEIGHTS[tag] ?? 0;
    if (weight === 0) continue;
    score += weight;
    reasons.push(`标签 ${tag} +${weight}`);
  }
  if (ASK_TO_REMEMBER.test(text)) {
    score += 3;
    reasons.push('他明确要求记住 +3');
  }
  if (SELF_STATE.test(text)) {
    score += 1.5;
    reasons.push('他在说自己的近况 +1.5');
  }
  // 用户 2026-10-01:「雷区可以在**被骂**的时候提取」。
  // ⚠️ 骂人的话本身不是雷区(那只是情绪),所以这里只把它标成"这一轮值得记":
  //    真正的雷区要靠同一句里的**明确否定**(`别/不准/讨厌…`,在 profile.js 里抽)。
  if (isHostile(text)) {
    score += 2;
    reasons.push('他当时很不高兴 +2');
  }
  for (const [chars, bonus] of LENGTH_STEPS) {
    if (text.length >= chars) {
      score += bonus;
      reasons.push(`说了 ${text.length} 字 +${bonus}`);
      break;
    }
  }

  const alwaysLong = tags.some((tag) => ALWAYS_LONG_TAGS.includes(tag));
  if (alwaysLong) reasons.push(`天然属于长期（${tags.filter((t) => ALWAYS_LONG_TAGS.includes(t)).join('、')}）`);
  const enough = score >= LONG_SCORE || score >= MID_SCORE;
  // 中期那条**长度地板**:一两个字的感叹不进中期(长期不受限 —— 四个字的承诺也是承诺)。
  const tier = alwaysLong
    ? TIER_LONG
    : score >= LONG_SCORE
      ? TIER_LONG
      : enough && text.length >= MID_MIN_CHARS ? TIER_MID : null;
  return { score: Number(score.toFixed(2)), tier, tags, reasons };
}

/**
 * 这个名字听起来像不像"她认识的人"?
 *
 * 只是个**提示**,不参与打分 —— 用来在日志里说清"这条为什么值一提"。
 * ⚠️ 平台**没有群成员名单**(官方接口只随消息给昵称),所以"认识的人"只能等他开口;
 * 这一条在 `docs\03` D78 里写清了,免得以后当成 bug 查。
 */
export function looksLikePersonNote(tags = []) {
  return tags.includes('person');
}

/**
 * **从一条固化记忆的正文反推它说了哪些事实**(P1-C 软失效用,2026-10-19)。**纯函数**。
 *
 * 为什么要"反推"而不是给 note 加列:note 表没有 subject/kind 列(那是 `fact` 表的形状),
 * 而 ADD-only 软失效只要求"同一段会话里同一个 kind 换了说法 → 旧说法退役"。
 * 所以**复用同一套抽取规则**(`extractFacts`,D79)从正文里读回来 —— 不另写一份判据,
 * 也就不存在"两份实现漂了"的问题(D159)。代价是只认得出词表覆盖得到的事实,
 * 认不出的两种说法**不会**被判成冲突(宁可不失效,也不许乱退役)。
 *
 * ⚠️ 群聊**不用它**做冲突判定:归档拿不到发言人(`memory-archive.js` 头注),同 kind 在群里
 * 很可能是**不同人的不同偏好**,判成"新说法取代旧说法"就是误伤。所以只在 c2c 生效。
 *
 * @param {string} text note 正文
 * @returns {Array<{kind: string, value: string}>} 去重后的主张(同 kind+value 只留一条)
 */
export function noteClaims(text) {
  const claims = [];
  const seen = new Set();
  for (const fact of extractFacts(text)) {
    const key = `${fact.kind}\u0000${fact.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ kind: fact.kind, value: fact.value });
  }
  return claims;
}
