/**
 * 分层记忆 v0:**标签化的长期记忆候选**(2026-09-30,见 `docs\03` D74)。
 *
 * 用户的形状(2026-09-29)是:给长期记忆的**每条**打分类标签;被动回忆时**先按标签筛候选**,
 * 再在预算内**挑少数几条**注入 —— **不是全量塞进去**。这就是最小的 RAG(标签版):
 * 索引不占上下文,**只有被选中的那几条才花 token**。
 *
 * 为什么先做 v0 的"离线演练"而不是直接写功能(`TODO.md` 的排法):
 * v0 **不改代码、不动 schema**,只拿 `memory.db` 里真实轮次打标签 + 写几条检索,
 * 看"这样挑会挑出哪几条" —— **产出的是证据,不是功能**。`memory.db` 是派生索引、
 * 可随便重建,所以试错成本极低。
 *
 * ## 四条判据(用户定,做成测试)
 *
 * 1. **命中才注入** —— 没有标签交集就别说"我记得";
 * 2. **能说清为什么选中它** —— 每条候选都要带 `why`(命中了哪些标签、多久以前、重要性),
 *    而且要**打进日志**,否则复核不了;
 * 3. **预算按层分** —— 长期层与最近原文层各有各的预算,不互相挤
 *    (现在的交接预算 1400 字**已经顶满**:实测 1399 字);
 * 4. **标签词表由代码固定** —— 模型只能"提议",落库前必须校验(这里干脆不允许模型加标签)。
 *
 * ⚠️ **一条隐私纪律**:标签是**派生数据**,不是原文。长期层只该带走"她记得这个人答应过的事",
 * 而不是原话摘抄。
 *
 * ## v1(2026-09-30,见 `docs\03` D75):`memory` 从"内容标签"降级为"检索触发"
 *
 * v0 暴露的第一个真问题:**检索把"请求"当成了"内容"**。query
 * 「你还记得我之前说过什么吗」的标签是 `memory`,而库里"可以记住吗""那你要记住我哦"
 * 也命中 `memory` → 挑出来的 5 条**全是元话语**,没有一条是"值得记住的事"。
 * 它不会报错,只会让"她记得"变得很假。
 *
 * 修法是把标签分成**两个作用域**(这是本模块现在唯一的复杂之处):
 *
 * | 作用域 | 有哪些 | 什么时候用 |
 * |---|---|---|
 * | **内容标签** `TAG_VOCAB` | 人/地点/事/情绪/吃/游戏/时间/承诺/身份(9 类) | 给**记忆**打标签,存进 `memory_tag`;**也是唯一的检索键** |
 * | **触发标签** `QUERY_ONLY_TAGS` | 只有 `memory` | 只给**问句**打(「记得」「之前」「说过」…),用来认出"这是在考记忆" |
 *
 * 于是「你还记得我之前说过什么吗」的**内容标签是空的** → 按判据 1 一条都不注入,
 * 而不是把元话语当成回忆端出去。考记忆这类问题由**交接层**回答(D39 已经在做,而且更准)。
 * 这不是"效果变差了":**宁可不回忆,也不要把不相干的当回忆说出来**(v0 决定二那条)。
 */

import { cleanMemoryText } from './memory-archive.js';
import { INFRA_CONTENT } from './local-infra-content.js';
import { accessBonus, accessFreshness } from './memory-store.js';

/**
 * 标签词表 —— **唯一的真相在这里**。**这是"内容标签":只有这些能落库、也只有这些能当检索键。**
 *
 * 分组的理由不是好看,而是**重要性不同**:`promise` / `identity` 这类标签命中的记忆,
 * 不该因为"很久以前"被淘汰(用户 2026-09-29 特别点过这条:
 * 「第一次见面 / 答应过的事属于高重要性,不该因为很久以前被淘汰」)。
 */
export const TAG_VOCAB = {
  /**
   * 人:**第三方**的人名 / 称呼。
   *
   * ⚠️ **这里刻意没有「主实例」和「副实例」** —— 那两只**就是这两只机器人自己**,私聊里
   * 用户几乎每句话都在叫名字:「主实例你真棒」「副实例在吗」。把"被叫到的名字"算成**内容**,
   * 会让 `person` 变成一个几乎什么都命中的噪声标签 —— 实测(2026-10-01):
   * 主实例那边 39 条 `person` 轮次里 **33 条**是「主实例」造成的;副实例那边 13 条里 **10 条**是「副实例」。
   * 而真正"提到**别的**机器人"的只有 **1 / 3 条** —— 代价小到可以忽略,噪声却掉八成半。
   * (这是 v0 那个病的同一族:**把称呼当成内容**。见 `docs\03` D77。)
   */
  person: INFRA_CONTENT.memoryTags.person,
  /** 地点 / 组织 */
  place: INFRA_CONTENT.memoryTags.place,
  /** 事情 / 事件 */
  event: ['委托', '任务', '副本', '活动', '更新', '版本', '播报', '考试', '面试', '加班', '出差', '生日', '节日'],
  /** 情绪 / 状态 */
  emotion: ['开心', '高兴', '难过', '生气', '烦', '累', '害怕', '紧张', '喜欢', '讨厌', '想你', '孤单'],
  /** 吃 / 喝(饮食相关话题) */
  food: ['吃', '饭', '饿', '喝', '奶茶', '咖啡', '外卖', '请客', '投喂', '夜宵', '零食'],
  /** 游戏 / 娱乐 */
  game: ['游戏', '打游戏', 'RPG', '抽卡', 'steam', 'boss', '副本', '电影', '番', '动漫'],
  /**
   * 时间 / 日程 —— ⚠️ **「今天 / 明天 / 昨天」刻意不在里面**。
   *
   * 它们太泛:一句「明天见」只说明"这是日常对话",不说明这轮有什么值得记的事。
   * 实测(2026-10-01):主实例那边 12 条"只带 `time`"的轮次里 **10 条**就是这三个词造成的。
   * 留下的是**真的有日程含义**的那些(上次 / 下次 / 假期…)。
   */
  time: ['周末', '晚上', '早上', '下周', '上次', '下次', '以后', '假期'],
  /**
   * 高重要性:承诺 / 约定 / 身份 / 名字 —— **不因久远被淘汰**。
   *
   * ⚠️ 2026-10-01(D78)拿掉了「一定要」:实测它命中的是**祈使句**("一定要选一个出来呢"),
   * 而不是承诺("我一定会…")—— 这条词表要的是"他答应过的事"。
   */
  promise: ['答应', '约定', '说好', '保证', '承诺', '别忘了'],
  /**
   * 身份 / 名字 / **第一次**。
   *
   * 「第一次」是 2026-10-01 补的:用户当时问的是「你还知道我们这次**第一次**…吗」——
   * 那正是"第一次见面 / 第一次…"这一族高重要性记忆,而旧词表只认「第一次见」。
   * 「我叫 / 叫我 / 我的名字」也是同一天补的:实测「我叫小林」这种**真正的身份事实**
   * 一个标签都没命中(旧词表只有问句形式的「叫什么」)。
   */
  identity: ['名字', '叫什么', '你是谁', '我是谁', '我叫', '叫我', '我的名字', '怎么称呼', '第一次', '初次'],
};

/**
 * **触发标签:只给问句打,永远不落库、永远不当交集。**
 *
 * `memory` 原本住在 `TAG_VOCAB` 里,那正是 v0 的 bug:`query` 与"可以记住吗"因为同一个词
 * 而"看起来相关",于是元话语被当成回忆。现在它在表外 —— 唯一的作用是让
 * 「这是在考记忆」这件事**说得出口**(日志里那句"没注入,因为这句话只有触发标签")。
 */
export const QUERY_ONLY_TAGS = Object.freeze({
  // 「还知道」是 2026-10-01 补的:用户当时那句「…你还知道我们这次第一次…吗」就是
  // **在考她记不记得**,而旧词表只认「记得 / 之前 / 说过」—— 这句话当时**一个触发标签都没命中**,
  // 于是"她在考记忆"这件事在日志里根本看不出来(见 docs\03 D77 的实测)。
  memory: ['记得', '还记得', '忘了', '记住', '说过', '之前', '以前', '上次说', '回忆', '还知道'],
});

/** 高重要性标签:**打分时加权,而且预算不够时优先留**(见 `IMPORTANCE_BONUS`)。 */
export const IMPORTANT_TAGS = Object.freeze(['promise', 'identity']);

/**
 * 每个标签的加权。高重要性那两个刻意给得高。
 *
 * ⚠️ v1 把 `memory: 1` **删掉了**:它已经不是内容标签,再加权就是一条**永远不会被用到**
 * 的配置 —— 而"看起来有、其实不会执行"的配置比没有更坏(它会让人以为元话语还有权重)。
 */
export const IMPORTANCE_BONUS = Object.freeze({
  promise: 3,
  identity: 3,
  person: 1,
});

/**
 * 给一段文本打**内容标签**。**纯函数**:词表是常量、规则是确定的,所以可测、可复核、可重建。
 *
 * ⚠️ 它**不看** `QUERY_ONLY_TAGS` —— 落库与检索键都只该用内容标签(v1 的修法)。
 *
 * ## 认识的人:昵称先"遮住",再当人(2026-10-01 现场,D78)
 *
 * 群友**昵称**会被当成正文内容 —— 实测踩到:「**饭否**」(某群友的昵称)出现在
 * 「用白丝脚踩饭否」里,而词表有「饭」→ 这一轮被打上 `food`。
 * 昵称不是"她吃了什么",是"**她认识的人**"。
 *
 * 所以规则是两步(顺序不能反):
 *   1. 把**已知昵称**等长遮成 `·`(这样昵称里的字再也不能命中别的词表);
 *   2. 只要遮到过,就补一个 `person` —— 提到认识的人**本身就是**一条人物信息。
 *
 * @param {string} text
 * @param {{peopleNames?: string[]}} [options] 已知的人名/昵称(来自 `person` 表)
 * @returns {string[]} 命中的标签(去重,按词表顺序)
 */
export function tagsFor(text, options = {}) {
  // ⚠️ 先洗正文:平台的 `<@openid>` 标记不是内容(它会污染标签、长度与注入文本,见 D78)。
  const clean = cleanMemoryText(text);
  const { masked, hit } = maskPeopleNames(clean, options.peopleNames ?? []);
  const tags = matchVocab(masked, TAG_VOCAB);
  if (hit) tags.push('person');
  return normalizeTags(tags);
}

/** 昵称里至少要有一个"看得见"的字母/数字/汉字 —— `ㅤ`(Hangul filler)这种不算人名。 */
const VISIBLE_NAME = /[A-Za-z0-9\u4e00-\u9fff]/;
/** 一个绝不出现在任何词表里的遮蔽字符(等长替换,不移动其它词的位置)。 */
const MASK_CHAR = '·';

/**
 * 把已知昵称**等长**遮掉。纯函数。
 *
 * ⚠️ 三条边界:
 *   · 只遮**看得见**的昵称(全空白/不可见字符的昵称不参与,否则它会在任何文本里"命中");
 *   · 等长替换 —— 不改动其它字符的位置,所以"遮过之后还命中了什么"是可复核的;
 *   · **长名字先遮**(否则短名字会把长名字切碎,剩下的碎片又可能命中别的词)。
 */
export function maskPeopleNames(text, peopleNames = []) {
  let masked = String(text ?? '');
  let hit = false;
  const names = (peopleNames ?? [])
    .map((name) => String(name ?? '').trim())
    .filter((name) => name.length > 0 && name.length <= 32 && VISIBLE_NAME.test(name))
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!masked.includes(name)) continue;
    masked = masked.split(name).join(MASK_CHAR.repeat(name.length));
    hit = true;
  }
  return { masked, hit };
}

/**
 * 给**问句**打标签:内容标签 + 触发标签。只用于"这句话该不该去检索、怎么解释没命中"。
 *
 * @param {string} text
 * @param {{peopleNames?: string[]}} [options]
 * @returns {string[]}
 */
export function queryTagsFor(text, options = {}) {
  return [...tagsFor(text, options), ...matchVocab(String(text ?? ''), QUERY_ONLY_TAGS)];
}

/** 这句话是不是在"考记忆"(只有触发标签、没有内容标签的那种问法)。 */
export function isRecallRequest(text) {
  return matchVocab(text, QUERY_ONLY_TAGS).length > 0;
}

// ---------------------------------------------------------------------------
// **语义那一维(v2)**:从"对不对词"到"对不对意思"(2026-10-02,D92)
//
// 为什么要它:标签的覆盖上限就是**约四分之一**(D74 量的)——
// 真人聊天大半是"哦/好/嗯",那些**本来就没有标签**。实测几对(本机 CPU、bge-small-zh 量化):
//   「今晚吃什么好」↔「说好了请你吃夜宵」 **0.773**
//   「你能喝冷的吗」↔「我胃不好不能喝冰的」 **0.796**
//   「你最近怎么样」↔「我昨晚做得好累」 **0.663**(字面零重合,标签层永远命不中)
//
// ⚠️ **但绝对相似度很挤**:不相关的一对(「今天天气怎么样」↔「我昨晚好累」)也有 **0.627**。
// 所以这一维有三条纪律:
//   1. 它**只加分、不当唯一闸门** —— 相关度 = 标签命中 + α×相似度,标签那条路照旧;
//   2. `minSim` 是**地板**(低于它连语义这条都不算),用来挡住"明显不相干"那一档;
//   3. 用**相对幅度**(比同批候选高出多少)做第二道闸 —— 因为绝对分数挤在一起时,
//      "这一批里它明显更近"比"它到了某个绝对数值"更可信。
// ---------------------------------------------------------------------------

/** 余弦相似度。**纯函数**;长度不等或空向量返回 0(不猜)。 */
export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  if (n === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 默认权重:相似度这一维最多值几分。⚠️ <1 = 它盖不过"多命中一个标签"。
 *
 * 📌 **0.8 → 0.4(2026-10-02 量出来的)**:标定集(`qqbot-bridge\工作学习\记忆检索标定集.json`,10 条)
 * 上 weight 从 0.4 到 1.2 **通过数完全一样**(7/10)—— 说明"多给语义加权"没有额外收益,
 * 真正起作用的是"**它有没有资格进候选**"。既然一样好,就取小的那个(更保守:语义更压不过标签)。
 *
 * 📌 **0.4 → 0.2(2026-10-18 定稿,9 个数字那一轮)**:用重建后的标定集重扫 24 格
 * (weight 0/0.2/0.4/0.6/0.8/1.2 × minSim 0.55/0.6/0.62/0.65):
 * 主实例 **weight 0.2 严守 13/24、召回 15/24**(当前 0.4 → 严守 12、召回 15),**+1 严守不加召回成本**;
 * 副实例 weight 0.2 与 0.4 **完全打平**(9/15,9/15)。⇒ 取 0.2:语义仍然参与**候选准入**
 * (地板与相对幅度那两道闸不受影响),只是**排序时更压不过标签命中** —— 与"宁可不回忆,
 * 也别把不相干的当回忆"(v0 决定二)同向。
 * ⚠️ 副实例的样本只有 15 条(21 条 note),单只结论不足以推翻;真实风险看日志里的
 *     `长期记忆：为什么选中它` 与 `[长期观察]`(embedding)那条。
 */
export const SEMANTIC_WEIGHT = 0.4;
/**
 * 语义地板(实测依据见文件头:不相关的也能到 0.627,所以它只挡"明显不相干"那一档)。
 *
 * 📌 **0.62 → 0.60(2026-10-02 量出来的)**:标定集上 0.55 与 0.60 **都是 7/10**,
 * 而 **0.62 掉到 6/10** —— 因为"最近怎么样 ↔ 我昨晚好累"那一对实测 **0.663** 紧贴地板,
 * 地板一抬就把它漏掉。当时取 0.60 是"留一点余量"。
 *
 * 📌 **0.60 → 0.55(2026-10-02 当天晚些,标定集重建之后重量的)**:上面那次测量用的尺子**是坏的**
 * —— 10 条里 **3 条引用的句子在库里根本不存在**(旧 eval 会"拿这句话自己造一个候选",
 * 于是自己出题自己答,报告上看不出来)。重建成 **39 条真实轮次**、**按会话**取材、
 * 剔除"近义孪生"的 forbidden 之后,两只各跑一遍:
 * **16 个格点(2 只 × 4 个 weight)里 0.55 没有一个比 0.60 差,其中 10 个严格更好**
 * (主实例 0.4 权重打平、0.6/0.8/1.2 各 +1 召回并 +1 严守;副实例 **四个权重全都 +1**)。
 * 代价说清楚:0.55~0.627 那一段里确实有不相关的对,但**负例(该空手而归的)一条都没被多端出来**。
 * ⚠️ 这不等于"0.55 一定更好"—— 标定集的候选池(21/14/3 条)比真实会话小得多,
 * 所以真实风险要看日志:`[长期观察]`(embedding)那条写着"端出不相干的就抬回去"。
 */
export const SEMANTIC_MIN_SIM = 0.55;

// ---------------------------------------------------------------------------
// **关键词通道(FTS5)与 RRF 名次分**(P1-A,2026-10-18)
//
// 照搬的成熟方案(见全局 skill `reuse-mature-solutions`):
//   · 检索融合 = **RRF**(Reciprocal Rank Fusion):`score = 1/(k+rank)`;
//     k 取 **1**,照 Graphiti `search_config.py` 的 `rank_const=1`。k=60 是 ES 惯例,
//     适合候选池上百;我们两路各只有几十条,k=60 会把第 1 与第 10 压成 1/61 vs 1/70。
//   · 中文分词 = **bigram**(单字+双字)。FTS5 官方文档写死 trigram 要求 ≥3 字符
//     (「小甲」「开心」这类 2 字词一行都匹配不到);unicode61 又不切连续汉字。
//     所以照社区做法:外部分词后写进空格分隔的 `fts_text` 列,查询端用同一套分词。
// 自写部分 = 只有 bigramTokens 这 20 行规则;FTS5 建表/检索/MATCH 全用 node:sqlite 内置。
// ---------------------------------------------------------------------------

/** RRF 的 k(照 Graphiti 源码 rank_const=1;不要照抄 ES 的 60)。 */
export const FTS_RRF_K = 1;
/**
 * FTS 候选的 RRF 权重。
 * ⚠️ **1.0 是刻意的**:关键词候选只在"标签/语义一条都没挑出来"时补位,
 *    靠 RRF 第一名的 1.0 分刚好过 minScore=1;第二名 0.5 过不去 ⇒ **一轮最多补一条**。
 * ⚠️ 不能反过来给"已经在标签通道里的候选"加这个分:实测那样会把 gold 挤出 limit=3
 *    (recall@3 0.824 → 0.706),标签通道自己的分数已经表达了相关度。
 */
export const FTS_RRF_WEIGHT = 1;

/**
 * P1-B 的打分模式默认值。`legacy` = 加和式(命中数+重要性+近期+语义);
 * `normalized` = 三因子各自 min-max 后等权(GenAgents)。
 * ⚠️ **先用评测证明更好再改成 normalized**:改默认值前必须同时跑
 * `eval-memory-recall`(recall/token/P95)与 `memory-eval --sweep`(严守),两个都不劣才算数。
 */
export const DEFAULT_SCORING = 'normalized';

/** 常见虚词:只从**单字** token 里剔掉(双字保留,否则「主人」「开心」也被误伤)。 */
const FTS_STOP_UNIGRAMS = new Set('的了是我你他她它在有吗呢吧啊这那就都也和与不要会能很个上下中来说看想给让把被着过地得之其而及或为一'.split(''));

/**
 * 中文 bigram 分词(**纯函数**):连续汉字切成「单字 + 双字」,英文/数字按词切。
 * 为什么单字也留:2 字词靠双字命中;单字让「猫」这类单字查询不至于空手。
 */
export function bigramTokens(text, { max = 160 } = {}) {
  const source = String(text ?? '').toLowerCase();
  const tokens = [];
  const push = (token) => {
    if (token === '' || tokens.length >= max) return;
    tokens.push(token);
  };
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
  let run = [];
  const flush = () => {
    for (let i = 0; i < run.length; i += 1) {
      if (!FTS_STOP_UNIGRAMS.has(run[i])) push(run[i]);
      if (i + 1 < run.length) push(run[i] + run[i + 1]);
    }
    run = [];
  };
  let ascii = '';
  const flushAscii = () => {
    if (ascii.length >= 2) push(ascii);
    ascii = '';
  };
  for (const ch of source) {
    if (CJK.test(ch)) { flushAscii(); run.push(ch); continue; }
    flush();
    if (/[a-z0-9]/.test(ch)) ascii += ch;
    else flushAscii();
  }
  flush();
  flushAscii();
  return [...new Set(tokens)];
}

/** 把一句话变成 FTS5 的 MATCH 表达式:`"主人" OR "人今" OR …`。**纯函数**。 */
export function ftsMatchExpression(text, { maxTokens = 48 } = {}) {
  const tokens = bigramTokens(text).slice(0, Math.max(1, maxTokens));
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

/** RRF 单项:`1/(k+rank)`(rank 从 0 开始)。**纯函数**。 */
export function rrfScore(rank, { k = FTS_RRF_K } = {}) {
  if (!Number.isFinite(rank) || rank < 0) return 0;
  return 1 / (k + rank);
}

/** 关键词通道给一条候选加的分(带权重)。**纯函数**。 */
export function ftsBonusOf(rank, { weight = FTS_RRF_WEIGHT, k = FTS_RRF_K } = {}) {
  return weight * rrfScore(rank, { k });
}

/**
 * 这一批候选里,**语义上明显更近**的那几条 —— 第二道闸。
 *
 * 为什么需要它(实测):相似度是**挤在一小段**里的(0.62 ~ 0.80),
 * 所以"绝对值到了某个数"并不说明什么;"**比同批其他候选高出多少**"才说明。
 *
 * @param {Array<{id: string, similarity?: number}>} scored
 * @param {{minSim?: number, margin?: number, keep?: number}} [options]
 * @returns {Set<string>} 通过这道闸的 id
 */
export function semanticStandouts(scored, { minSim = SEMANTIC_MIN_SIM, margin = 0.03, keep = 3 } = {}) {
  const list = (scored ?? [])
    .filter((memory) => Number.isFinite(memory?.similarity) && memory.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity);
  if (list.length === 0) return new Set();
  const best = list[0].similarity;
  // 同批里"最像的那几条",而且不能比第一名低太多 —— 低太多说明"这一批里没有真像的"。
  return new Set(list.filter((memory, index) => index < keep && best - memory.similarity <= margin + 0.12)
    .map((memory) => String(memory.id)));
}

function matchVocab(text, vocab) {
  const haystack = String(text ?? '');
  if (haystack === '') return [];
  const hits = [];
  for (const [tag, words] of Object.entries(vocab)) {
    if (words.some((word) => haystack.includes(word))) hits.push(tag);
  }
  return hits;
}

/**
 * **落库前的校验**(判据 4):只留词表里认得的**内容标签**,顺序按词表、去重。
 *
 * 现在标签全是代码算的,所以它此刻"永远通过";但**模型提议标签**那条路(v2)会从这里走 ——
 * 没有这道闸,标签会随对话漂移,而漂移了的索引比没有索引更糟。**先有闸,再有提议者。**
 *
 * ⚠️ 顺序**按词表**而不是按输入顺序:日志里的"为什么选中它"是要拿来复核的,
 * 同一批标签每次打出来的顺序都得一样。
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  const given = new Set((tags ?? []).map(String));
  const out = [];
  for (const tag of Object.keys(TAG_VOCAB)) {
    if (given.has(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 这条记忆有多重要(命中高重要性标签就加分)。 */
export function importanceOf(tags) {
  let score = 0;
  for (const tag of tags ?? []) score += IMPORTANCE_BONUS[tag] ?? 0;
  return score;
}

/**
 * 检索:**按标签交集挑候选**,并把"为什么选中它"一起返回。
 *
 * 打分 = 命中标签数(相关度)+ 重要性加成 + 一点近期加成。
 * ⚠️ 三条纪律写在这里:
 *   · **没有交集就不进候选**(判据 1:命中才注入);
 *   · 每条都带 `why`(判据 2:说得出为什么),调用方**必须把它打进日志**;
 *   · `minScore` 以下的直接丢掉 —— 宁可不说,也别把不相干的当"回忆"说出来(C 档风险)。
 *
 * ⚠️ 交集只用**内容标签**:`query` 自己的 `memory`(触发标签)**不参与交集**
 * (v0 的"把请求当内容"就是这么来的,见文件头)。
 *
 * @param {Array<{id: number|string, at: number, text: string, tags?: string[]}>} memories
 * @param {string} query 当前这句话(或当前的注入场景描述)
 * @param {object} [options]
 * @param {number} [options.now] 现在(毫秒),用于近期加成
 * @param {number} [options.limit] 最多挑几条(预算的一层)
 * @param {number} [options.minScore]
 * @param {number} [options.halfLifeMs] 近期加成的半衰期
 * @param {Set<string>} [options.excludeIds] **这一段会话里已经端过**的那些(access 强化,D89):
 *   它们仍然算相关(判据没变),但**排到最后** —— 于是"换一条次好的端出来"是自动的。
 * @param {{vector?: number[], weight?: number, minSim?: number}} [options.semantic]
 *   **语义那一维**(D92):`vector` 是这句话的向量。给了它,相关度就变成
 *   `标签命中 + 权重×相似度`,而**不改任何别的维**(预算、重要性、access 都照旧)。
 *   没给 = 退回到纯标签行为(**与加这一维之前一字不差**)。
 * @returns {ReturnType<typeof recallDecision>['picked']}
 */
export function recall(memories, query, options = {}) {
  return recallDecision(memories, query, options).picked;
}

/**
 * `recall` 的**带理由版**:除了挑出来的那几条,还要说清"一条都没挑出来是因为什么"。
 *
 * 判据 2 的另一半:说不出口的闸门下次没人敢动它(D72 那条)。
 * 理由里**只有标签/分数/时间**,没有原文 —— 日志是要被贴来贴去的,而库里有真人原话。
 *
 * ## access 强化(2026-10-01 第二批,D89):给打分加两道**新键**,不动老公式
 *
 * `score = 命中数 + 重要性 + 近期加成` 一个字没改 —— 加的是两道独立的键:
 *   · **降权**:这条**刚被端出来过**就排后面(`accessFreshness`),"被想起过的先歇一会儿";
 *   · **加分**:**被端出来过更多次**的**,在相关度与分数都相同时优先**(`accessBonus`)。
 * 两条账都来自 `access` 表(`use_count` / `last_used_at`),所以**跨代也认**。
 *
 * ⚠️ 为什么加分**不进 `score`**:次数一旦进分数,就会盖过"命中几个标签";
 * 而"相关度"必须是第一位的 —— 宁可少回忆,也别把不相干的当成回忆说出来(判据 1 那条)。
 *
 * @returns {{picked: Array<object>, reason: string|null, queryTags: string[],
 *            trigger: boolean, overlap: number}}
 *   `reason` 只在 `picked` 为空时有值;`trigger` = 这句话是在考记忆(`memory` 触发标签)。
 */
export function recallDecision(memories, query, options = {}) {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 1;
  const halfLifeMs = options.halfLifeMs ?? 14 * 24 * 3600 * 1000; // 两周
  const excludeIds = options.excludeIds ?? null;
  // P1-B 实验开关:三因子归一化打分(GenAgents)。默认 legacy = 1.154.0 的加和式,
  // 行为一字不变;只有显式传 'normalized' 才走新路径(先量,证明更好才改成默认)。
  const scoring = options.scoring === 'normalized' || (!options.scoring && DEFAULT_SCORING === 'normalized')
    ? 'normalized'
    : 'legacy';
  // W1 衰减治理:recency 权重(诊断:recency 是挤位主引擎)。legacy 作用在衰减项上,
  // normalized 作用在归一化之后 —— 两处同参数,默认 1 = 行为一字不变。
  const recencyWeight = Number.isFinite(options.recencyWeight) ? options.recencyWeight : 1;
  const contentTags = tagsFor(query, { peopleNames: options.peopleNames });
  const trigger = isRecallRequest(query);
  const queryTags = new Set(contentTags);
  const summary = { queryTags: contentTags, trigger, overlap: 0, semanticOnly: 0, ftsOnly: 0 };

  // P1-A:关键词通道(FTS5)进来的候选带 `ftsRank` —— 有它就不受"必须有内容标签"那道闸限制,
  // 因为"字面命中"本身就是判据 1 说的交集(只是交集来自全文索引而不是标签词表)。
  const hasFts = (memories ?? []).some((memory) => Number.isFinite(memory?.ftsRank));
  // P1-F:实体共现。`query` = 这句话里出现的名单名字;`weight` = 共现加分权重(0 = 关)。
  // 候选身上的 `entityHits` 由调用方(pickLongTerm → entityHitsFor)按 mention 表填好。
  const entities = options.entities ?? null;
  // P1-F:实体共现同理 —— query 点了名、池里有轮次 mention 过这个名字,也是"有交集"。
  // ⚠️ 必须在下面的空标签早退**之前**判,否则实体准入永远轮不到(第一版就栽在这)。
  const hasEntity = entities?.query?.length > 0
    && (memories ?? []).some((memory) => (memory.entityHits ?? []).some((name) => entities.query.includes(name)));

  // ⚠️ 2026-10-02(D92):**没有内容标签不再等于"不注入"** —— 如果这一轮带了向量,
  //    语义那条路照样能挑出东西(这正是"标注覆盖率只有四分之一"要治的病)。
  //    没带向量 = 旧行为一字不差。
  if (queryTags.size === 0 && !options.semantic?.vector?.length && !hasFts && !hasEntity) {
    return {
      ...summary,
      picked: [],
      reason: trigger
        // 这一条就是 v1 要买的:说得出"她问了记不记得,但我们刻意没回忆"。
        ? '这句话只有触发标签 memory(在考记忆)、没有内容标签 —— 按判据1不注入；考记忆由交接层回答'
        : '这句话没有内容标签 —— 按判据1不注入',
    };
  }

  const scored = [];
  const semantic = options.semantic ?? null;
  const semanticWeight = Number.isFinite(semantic?.weight) ? semantic.weight : SEMANTIC_WEIGHT;
  const semanticFloor = Number.isFinite(semantic?.minSim) ? semantic.minSim : SEMANTIC_MIN_SIM;
  // 先把"语义有多近"算出来(它有可能是**唯一**让这条进候选的原因:标签零命中但意思很近)。
  const withSim = (memories ?? []).map((memory) => ({
    memory,
    similarity: semantic?.vector?.length
      ? cosineSimilarity(semantic.vector, memory.vector)
      : 0,
  }));
  // 第二道闸:这一批里**语义上明显更近**的那几条(绝对分数挤,所以看相对幅度)。
  const standouts = semantic?.vector?.length
    ? semanticStandouts(withSim.map((entry) => ({ id: entry.memory.id, similarity: entry.similarity })), { minSim: semanticFloor })
    : new Set();
  for (const { memory, similarity } of withSim) {
    const tags = normalizeTags(memory.tags ?? tagsFor(memory.text));
    const hit = tags.filter((tag) => queryTags.has(tag));
    // 判据 1 的**扩展**:以前是"没有标签交集就不进候选";现在多一条路 ——
    // **意思很近**(similarity 过了地板、而且是这一批里明显更近的)也算命中。
    const semanticHit = similarity >= semanticFloor && standouts.has(String(memory.id));
    const ftsRank = Number.isFinite(memory.ftsRank) ? memory.ftsRank : null;
    // 判据 1 的**第四次扩展**(P1-F):**实体共现**也算命中 —— 这句话里出现过
    // query 里那个"人/概念"的名字(整名匹配,mention 由 rebuildEntities 派生)。
    // 「副实例最近怎么样」的"副实例"不是词表标签,但"哪些轮提到过副实例"是字面事实。
    const entityHits = entities?.query?.length
      ? (memory.entityHits ?? []).filter((name) => entities.query.includes(name))
      : [];
    const entityScore = entities?.weight > 0
      ? entities.weight * Math.min(entityHits.length, 2)
      : 0;
    // 判据 1 的**第三次扩展**(P1-A):字面命中(FTS 关键词通道)也算"有交集"。
    if (hit.length === 0 && !semanticHit && ftsRank === null && entityHits.length === 0) continue;
    if (hit.length === 0 && !semanticHit && ftsRank === null) summary.ftsOnly += 1;
    if (hit.length === 0) summary.semanticOnly += 1;
    summary.overlap += 1;
    const importance = importanceOf(hit);
    // 近期加成:最多 +1,不会盖过"重要性"。
    const ageDays = Math.max(0, (now - memory.at) / (24 * 3600 * 1000));
    const recency = Math.pow(0.5, (ageDays * 24 * 3600 * 1000) / halfLifeMs) * recencyWeight;
    // access 那两道新键(D89):降权 = 刚端过的让位;加分 = 端过更多次的**打平局用**。
    const fresh = accessFreshness(memory, now);
    const bonus = accessBonus(memory);
    // ⚠️ **语义那一维只加在这里**(D92):权重 <1,所以它盖不过"多命中一个标签";
    //    而且它**不进** importance —— "意思很近"不等于"这件事重要"。
    const semanticScore = semanticHit || similarity > 0 ? semanticWeight * Math.max(0, similarity) : 0;
    // P1-A:关键词通道只给"补位候选"(带 ftsRank 且不在标签通道里)加 RRF 名次分;
    // 已经在标签通道里的候选**不加**(加了会把 gold 挤出 limit=3,实测 0.824→0.706)。
    const ftsScore = ftsRank === null ? 0 : ftsBonusOf(ftsRank);
    // P1-F:实体共现分与语义同一条纪律 —— 权重 <1 盖不过标签,不进 importance
    // ("提过这个人"不等于"这件事重要");命中 2 个以上封顶(共现多个名字≠线性更重要)。
    const score = hit.length + importance + recency + semanticScore + ftsScore + entityScore;
    // legacy 模式在这里用 minScore 过滤;normalized 模式的闸门是"有没有任何相关信号"(准入),
    // 三因子只决定**排序**(见循环后的重算)。
    if (scoring === 'legacy' && score < minScore) continue;
    scored.push({
      ...memory,
      tags,
      score,
      similarity,
      semanticScore,
      ftsRank,
      ftsScore,
      // P1-F:实体共现(命中的名字与得分一起进 why,复核要看)。
      entityHits,
      entityScore,
      // P1-B:归一化需要的原始三因子(0 起的量纲;循环后各自 min-max)。
      raw: { rel: hit.length + semanticScore + ftsScore + entityScore, imp: importance, rec: recency },
      accessPenalty: fresh,
      accessBonus: bonus,
      // ⚠️ 这一轮已经端过的**排到最后**,但**不算分低**(理由里会说清是"这一段会话里端过了")。
      excluded: Boolean(excludeIds?.has?.(String(memory.id))),
      why: [
        hit.length > 0 ? `命中标签 ${hit.join('、')}` : (ftsRank !== null ? '标签没命中，是**关键词**命中（全文索引）' : '标签没命中，是**语义**像（向量检索）'),
        ftsRank !== null ? `关键词命中第 ${ftsRank + 1} 位（RRF +${ftsScore.toFixed(2)}，k=${FTS_RRF_K}）` : null,
        similarity > 0 ? `语义相似度 ${similarity.toFixed(3)}（+${semanticScore.toFixed(2)}）` : null,
        entityHits.length > 0 ? `实体共现：${entityHits.join('、')}（+${entityScore.toFixed(2)}）` : null,
        importance > 0 ? `重要性 +${importance}（${hit.filter((t) => IMPORTANT_TAGS.includes(t)).join('、') || '—'}）` : null,
        // 两条账分开写:一条是"什么时候端过",一条是"端过几次" —— 混成一句事后复核不了。
        fresh > 0 ? `刚端过（降权 -${fresh.toFixed(2)}）` : null,
        (memory.useCount ?? 0) > 0 ? `被想起过 ${memory.useCount} 次` : null,
        excludeIds?.has?.(String(memory.id)) ? '这一段会话里已经端过 → 排到最后' : null,
        `约 ${Math.round(ageDays)} 天前（近期加成 +${recency.toFixed(2)}）`,
      ].filter(Boolean),
    });
  }
  // P1-B(实验路径):三因子各自 min-max 归一到 [0,1] 后**等权**相加(GenAgents 原样)。
  // 闸门 = 准入(有没有标签/语义/关键词信号),不再用 legacy 的 minScore —— 那个阈值是
  // 加和式量纲下的数,归一化后没有意义。
  if (scoring === 'normalized' && scored.length > 0) {
    const norm = (get) => {
      const values = scored.map((memory) => Number(get(memory)) || 0);
      const max = Math.max(...values);
      const min = Math.min(...values);
      const span = max - min;
      return (memory) => (span === 0 ? 0.5 : (Number(get(memory)) - min) / span);
    };
    const relN = norm((memory) => memory.raw.rel);
    const impN = norm((memory) => memory.raw.imp);
    const recN = norm((memory) => memory.raw.rec);
    // W1 衰减治理(2026-10-22):recency 权重作用在**归一化之后** —— 作用在之前会被
    // min-max 的尺度不变性整个吃掉(全员 ×0.5 再归一 = 没变)。诊断:recency 是挤位主引擎。
    const recencyWeight = Number.isFinite(options.recencyWeight) ? options.recencyWeight : 1;
    for (const memory of scored) {
      const rel = relN(memory);
      const imp = impN(memory);
      const rec = recN(memory) * recencyWeight;
      memory.normalized = { rel, imp, rec };
      memory.score = rel + imp + rec;
      memory.why.unshift(`归一化三因子 相关 ${rel.toFixed(2)} + 重要 ${imp.toFixed(2)} + 近期 ${(recN(memory)).toFixed(2)}×${recencyWeight} = ${memory.score.toFixed(2)}`);
    }
  }
  if (scored.length === 0) {
    return {
      ...summary,
      picked: [],
      // ⚠️ 带向量时,理由要说得更准:没有交集**不等于**没有相似度,
      //    可能是"这一批里谁都不够像"(语义地板是 minSim)。
      reason: summary.overlap === 0
        ? (semantic?.vector?.length
          ? `没有一条记忆与 ${contentTags.join('、') || '(空)'} 有交集,而且语义上一条都没过地板 ${semanticFloor} —— 不注入`
          : `没有一条记忆与 ${contentTags.join('、')} 有交集 —— 按判据1不注入`)
        : `有 ${summary.overlap} 条交集,但分数都低于 minScore=${minScore} —— 宁可不注入`,
    };
  }
  // 排序:已经端过的排最后 → 相关度(标签命中数)→ 分数(含语义、减去"刚端过"的降权)
  //      → 被想起过更多的 → 越新越前。
  // normalized 模式:**只按归一化总分**(三因子已经各占一份,"相关度"不再单独当第一键)。
  const hitsOf = (memory) => memory.tags.filter((tag) => queryTags.has(tag)).length;
  scored.sort(scoring === 'normalized'
    ? ((a, b) => Number(a.excluded) - Number(b.excluded)
      || (b.score - b.accessPenalty) - (a.score - a.accessPenalty)
      || b.accessBonus - a.accessBonus
      || b.at - a.at)
    : ((a, b) => Number(a.excluded) - Number(b.excluded)
      || hitsOf(b) - hitsOf(a)
      || (b.score - b.accessPenalty) - (a.score - a.accessPenalty)
      || b.accessBonus - a.accessBonus
      || b.at - a.at));
  // ⚠️ 预算与条数都按"能端出去的"算:被排除的那些不该占名额(它们本来就不该再被端)。
  return { ...summary, picked: scored.filter((memory) => !memory.excluded).slice(0, limit), reason: null };
}

/**
 * 把选中的记忆渲染成**注入用的一小段**(判据 3:长期层单独一份预算)。
 *
 * ⚠️ 与"交接"的写法保持一致:明确告诉模型**这是背景不是台词**(不然它会背摘要)。
 *
 * @param {ReturnType<typeof recall>} picked
 * @param {{budgetChars?: number}} [options]
 */
export function renderRecall(picked, options = {}) {
  const budget = options.budgetChars ?? 600;
  if (!picked || picked.length === 0) return '';
  const lines = ['【长期记忆·节选】以下是更早以前的事，只当背景：不要复述、不要说"我记得你说过"。'];
  let used = lines[0].length;
  for (const memory of picked) {
    const line = `· ${cleanMemoryText(memory.text).slice(0, 80)}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
