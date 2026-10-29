/**
 * 「养成」:经验值、等级、以及"她学会了什么/认识了谁"的**规则层**。
 *
 * 为什么要有这个文件:爱丽丝的角色卡 §十三 早就写着
 * `【状态】HP：满 / 一般 / 偏低 · 系统：正常 / 冷却中 / 待机 · 等级：Lv.?`,
 * 而代码里**从来没有算过它** —— 那是"许愿",不是机制。
 * 同一个教训写在 D22 里:**写在提示词里的概率不会变成概率。**
 * 所以这里把"什么算成长、一次加多少、多少级要多少经验"全部写成纯函数,
 * 由 `selftest.js` 盯着;提示词只负责把算出来的数字说给她听。
 *
 * 本文件**不碰数据库、不碰时钟、不碰模型** —— 持久化在 `sqlite-store.js`,
 * 装配在 `index.js`。这样规则可以直接单测(和 `stats.js` / `warmup.js` 同一套做法)。
 *
 * ⚠️ 改这张表等于改"养成的手感"。改完要:
 *   1. 跑 `node scripts\selftest.js`;
 *   2. 把新的阈值写进 D40(docs\03);
 *   3. 提醒:`meta.growth_version` 变了要整库重导(`scripts\growth-report.js --rebuild`)——
 *      经验值本身不能重算(它是**发生过的事**),能重算的只有由它派生的等级与里程碑。
 */

/** 等级上限。到顶之后经验继续累计,只是不再升级。 */
export const MAX_LEVEL = 100;

/**
 * 单级所需经验的**收尾上限**。
 *
 * 曲线是 `10 + 6·(n−1) + ⌊(n−1)²/5⌋`,到 Lv.36 前后自然涨到 300 就不再涨了。
 * 没有这个上限的话 Lv.99→100 要 1,970 点(约 5 天的满负荷聊天换一级),
 * 后期每级都变成"看不到头"——那不是养成,那是罚站。
 */
export const XP_PER_LEVEL_CAP = 300;

/** 一次成长的"事件种类"。表里没有的一律 **0**(不认识就不给,不猜)。 */
export const XP_RULES = {
  /** 有人 @ 她 —— 最直接的一次互动。 */
  mention: 1,
  /** 她自己在群里接话(发言闸门放行的那次)。 */
  self: 1,
  /** 被戳 / 被发表情:是一个动作,但信息量比一句话少。 */
  poke: 1,
  face: 1,
  /** 控制指令:`/状态` `/更新` 之类 —— 也是一次真实的交互。 */
  command: 1,
  /** 暖群是她自己找话,不是别人来找她 —— 折半。 */
  warmup: 0.5,
  /** 「她自己过日子」那一拍(去吃饭/去公会看板,报备一句,见 D99 阶段 2)—— 同暖群,折半。 */
  selfcare: 0.5,
  /** 更新播报**不是对话**(D39 已经把它排除在记忆交接之外),所以不给经验。 */
  announce: 0,
  /** 归档读不出来的轮次。 */
  unknown: 0,
};

/**
 * 第一次遇到一个新概念时的额外经验 —— 那是"学到了东西"。
 * 一次只算一次(靠 `concept` 表的主键保证),所以刷不动。
 */
export const CONCEPT_BONUS = 5;

/**
 * 里程碑:**这些等级会"开口说话"**。
 *
 * ⚠️ 这里刻意**不是**简单的"每 N 级一次"。用户 2026-09-27 把目标说清楚了:
 *
 * > 「其实不追求满级,两个 bot 都可以放慢,你想想满级了有什么用呢,
 * >   现在追求的是养成的互动感和沉浸感」
 *
 * 所以曲线**不为"早点满级"服务**(Lv.100 是个用不上的天花板,不该拿来当指标),
 * 而应该让**变化被感觉到**。两件事跟着这条改:
 *
 * 1. **前段密、后段疏**:Lv.5 就报一次 —— 按实测(惠惠约 171 点/活跃日),
 *    Lv.5 大约第 5 天到,而"第一个里程碑"如果排在 Lv.10(约第 2 天凑够前 10 级
 *    里的 343 点其实更快),那 Lv.6–9 这几级就是**只有数字在动、没人看见**。
 *    5/10/20/30… 让"最容易被放弃的头一周"里有两次回响。
 * 2. **里程碑是"群里的那句";普通升级走私聊账单**(见 `index.js` 的 `recordTurn`)——
 *    群里不该被升级通知刷屏,但运维者应该看得见进度。
 */
export const MILESTONE_LEVELS = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
/** 里程碑之间大致隔多少级(只用于文案:"每 N 级一次")。 */
export const MILESTONE_STEP = 10;

const TABLE = buildTable();

/** `TABLE[i]` = 达到 **Lv.(i+1)** 所需的累计经验;`TABLE[0]` 恒为 0。 */
function buildTable() {
  const thresholds = [0];
  for (let level = 1; level < MAX_LEVEL; level += 1) {
    thresholds.push(thresholds[level - 1] + xpToAdvance(level));
  }
  return thresholds;
}

/** 从 Lv.`level` 升到下一级需要多少经验。 */
export function xpToAdvance(level) {
  const claimed = Math.max(1, Math.floor(Number(level) || 1));
  const raw = 10 + 6 * (claimed - 1) + Math.floor((claimed - 1) ** 2 / 5);
  return Math.min(raw, XP_PER_LEVEL_CAP);
}

/** 累计经验阈值表(只读,**不要就地改**)。给报表与测试用。 */
export function xpTable() {
  return TABLE.slice();
}

/** 累计经验 → 等级。超过上限就停在 `MAX_LEVEL`。 */
export function levelForXp(xp) {
  const total = Math.max(0, Number(xp) || 0);
  let low = 0;
  let high = TABLE.length - 1; // 下标 = 等级 − 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (TABLE[mid] <= total) low = mid;
    else high = mid - 1;
  }
  return Math.min(MAX_LEVEL, low + 1);
}

/** 累计经验 → 进度(等级 + 距离下一级还差多少)。`maxed` = 已经到顶。 */
export function progressForXp(xp) {
  const total = Math.max(0, Number(xp) || 0);
  const level = levelForXp(total);
  if (level >= MAX_LEVEL) {
    return { level, xp: total, intoLevel: 0, needed: 0, remain: 0, ratio: 1, maxed: true };
  }
  const base = TABLE[level - 1];
  const needed = TABLE[level] - base;
  const intoLevel = total - base;
  return {
    level,
    xp: total,
    intoLevel,
    needed,
    remain: needed - intoLevel,
    ratio: needed > 0 ? intoLevel / needed : 1,
    maxed: false,
  };
}

/** 空的一份养成状态。`Lv.1`、0 经验。 */
export function createGrowth(now = Date.now()) {
  return { xp: 0, level: 1, milestones: 0, updatedAt: now };
}

/** 是不是里程碑等级(每 10 级)。`milestones` = 已经播报过的次数,防止重复。 */
export function isMilestone(level) {
  return MILESTONE_LEVELS.includes(Math.floor(Number(level) || 0));
}

/** 从成长状态里取出等级 —— 等级永远是经验值的**派生值**,不单独存真相。 */
export function levelOf(growth) {
  return levelForXp(growth?.xp ?? 0);
}

/**
 * 结算一轮:加经验、重算等级、判断这次有没有跨过里程碑。
 *
 * @param {object} growth 当前状态(`{xp, milestones, updatedAt}`)
 * @param {number} delta 这一轮的经验(见 `XP_RULES` / `xpForTurn`)
 * @param {number} now
 * @returns {{growth: object, gained: number, before: object, after: object,
 *            levelledUp: boolean, milestone: number|null}}
 *   `growth` 是**新的**对象(不修改入参);`gained <= 0` 时原样返回。
 */
export function advanceGrowth(growth, delta, now = Date.now()) {
  const current = { ...createGrowth(now), ...(growth ?? {}) };
  const gained = Math.max(0, Number(delta) || 0);
  const before = progressForXp(current.xp ?? 0);
  if (gained === 0) {
    return { growth: current, gained: 0, before, after: before, levelledUp: false, milestone: null };
  }

  const xp = (Number(current.xp) || 0) + gained;
  const after = progressForXp(xp);
  const levelledUp = after.level > before.level;

  // 里程碑按"跨过了几个 10 级台阶"算,而不是"等级恰好是 10 的倍数"——
  // 否则一次加很多经验(以后可能有别的事件给大额经验)会漏掉中间的台阶。
  let milestone = null;
  let milestones = Number(current.milestones) || 0;
  const crossed = MILESTONE_LEVELS.filter((mark) => mark > before.level && mark <= after.level);
  if (crossed.length > 0) {
    milestone = crossed[crossed.length - 1];
    milestones += crossed.length;
  }

  return {
    growth: { xp, level: after.level, milestones, updatedAt: now },
    gained,
    before,
    after,
    levelledUp,
    milestone,
  };
}

/** 一次发言(`kind` 见 `XP_RULES`)值多少经验。`concepts` = 这一轮新学会的概念数。 */
export function xpForTurn(kind, { concepts = 0 } = {}) {
  const base = XP_RULES[kind] ?? 0;
  const bonus = Math.max(0, Math.floor(Number(concepts) || 0)) * CONCEPT_BONUS;
  return base + bonus;
}

/**
 * 一轮发言在**人话里**叫什么 —— 日志、报表、`/成长` 都用它。
 * 表里没有的一律 `unknown`,不编。
 */
export function describeTurnKind(kind) {
  const labels = {
    mention: '被叫到',
    self: '自己接话',
    warmup: '暖群',
    poke: '被戳',
    face: '表情',
    command: '控制指令',
    announce: '更新播报',
    unknown: '未知',
  };
  return labels[kind] ?? labels.unknown;
}

// ---------------------------------------------------------------------------
// 概念词表:她"学会"的东西
// ---------------------------------------------------------------------------

/**
 * 概念词表 —— **必须由代码判定,不能让模型自己报"我学会了"**。
 *
 * 判据是确定的:一轮的正文里出现了某个词,而库里没有它 → 学会。
 * 所以它是可复现、可测试、可以解释"我为什么会说这句话"的。
 *
 * ⚠️ **这张表在 2026-09-27 重写过一次,原因是量出来的。**
 * 第一版是照"技术文档"写的(`server` / `database` / `network` / `test` / `repair`),
 * 拿 699 轮真实归档跑了一遍:**16 类只命中 8 类**,而没命中的恰好是那几个技术词 ——
 * 它们从没在对话里出现过。同一批数据里真正高频的是 `memory` / `food` /
 * `weather` / `game` / `command` / `version` 这些**日常词**。
 *
 * 结论:**词表要照"人真的会说的话"写,不是照项目文档写**。
 * 往这里加词之前先量一遍(`TODO.md` 里那条"养成的手感要按真实数据标定"写了怎么量)——
 * 命不中的词等于没有,只会让"学会的东西"显得少。
 *
 * ⚠️ 刻意保持**短**:每个词都代表一次"学会"的播报机会,词表越长她越像在背词典。
 * 分类也**故意做得宽**(比如"网络"那一类把断网/延迟/掉线都收进来),
 * 因为窄词表会漏 —— 而漏掉的词永远学不会。
 */
export const CONCEPT_WORDS = [
  // --- 实测高频(2026-09-27 用 699 轮真实归档量过) ---
  { id: 'memory', label: '记忆', words: ['记忆', '记住', '忘记', '存档', '归档', '记得'] },
  { id: 'food', label: '吃喝', words: ['好吃', '吃了', '晚饭', '午饭', '早饭', '零食', '饿', '请客', '投喂', '喝水'] },
  { id: 'weather', label: '天气', words: ['天气', '下雨', '下雪', '降温', '热死', '冷', '太阳', '台风'] },
  { id: 'game', label: '游戏', words: ['游戏', '打游戏', '开黑', '副本', '抽卡', '排位'] },
  { id: 'command', label: '指令', words: ['指令', '命令', '命令词', '状态栏', '查询'] },
  { id: 'version', label: '版本', words: ['版本', '更新日志', '更新内容', '播报', '更新'] },
  { id: 'code', label: '代码', words: ['代码', '编程', '脚本', 'bug', '报错', '修好', '函数'] },
  { id: 'ai', label: 'AI', words: ['ai', '人工智能', '大模型', '模型', '机器人'] },

  // --- 日常(第一版就有,实测也命中) ---
  { id: 'exam', label: '考试', words: ['考试', '期末', '成绩', '作业', '上课', '论文'] },
  { id: 'work', label: '上班', words: ['上班', '加班', '开会', '出差', '下班', '工作'] },
  { id: 'money', label: '钱', words: ['钱', '工资', '便宜', '贵', '穷', '省钱', '红包'] },
  { id: 'sleep', label: '作息', words: ['睡觉', '熬夜', '失眠', '困', '起不来', '午睡'] },
  { id: 'health', label: '身体', words: ['生病', '感冒', '发烧', '吃药', '头疼', '肚子'] },
  { id: 'travel', label: '出门', words: ['出门', '路上', '车站', '旅游', '回家', '堵车'] },
  { id: 'music', label: '音乐', words: ['歌', '音乐', '耳机', '好听', '唱歌'] },
  { id: 'study', label: '学习', words: ['学习', '复习', '背单词', '考试周', '自习'] },
  { id: 'tech', label: '电脑', words: ['电脑', '手机', '键盘', '屏幕', '卡死', '重启', '网络', '断网', '掉线', '延迟'] },
  { id: 'machine', label: '能源', words: ['电量', '充电', '电池', '能源', '过热', '散热'] },
];

/**
 * 扫一轮正文,列出**这一轮出现的**概念 id。
 *
 * 只认词表里的词;**不做模糊匹配、不做同义词推断** ——
 * 宁可漏,不可编。判定"新"与"旧"是调用方的事(它才知道库里有什么)。
 */
export function matchConcepts(text, words = CONCEPT_WORDS) {
  const haystack = String(text ?? '').toLowerCase();
  if (haystack === '') return [];
  return words.filter((entry) => entry.words.some((word) => haystack.includes(word.toLowerCase()))).map((entry) => entry.id);
}

/** 概念 id → 显示名(报表、`/成长` 用)。找不到就原样返回 id。 */
export function conceptLabel(id, words = CONCEPT_WORDS) {
  return words.find((entry) => entry.id === id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// 描述:给模型看的、给人看的
// ---------------------------------------------------------------------------

/**
 * 注入提示词的那一行。
 *
 * 只给**等级与进度**,不给"你升级了要说什么"——那是角色卡的事。
 * 里程碑那一次由调用方另加一句要求(见 `milestoneNote`)。
 */
export function describeForPrompt(growth, { maxedHint = '已经满级' } = {}) {
  const progress = progressForXp(growth?.xp ?? 0);
  if (progress.maxed) return `Lv.${progress.level}（${maxedHint}，累计 ${Math.round(progress.xp)} 点）`;
  return (
    `Lv.${progress.level}（${Math.floor(progress.intoLevel)}/${progress.needed}，` +
    `再 ${Math.ceil(progress.remain)} 点升级）`
  );
}

/** 里程碑那一次额外加的要求 —— 她得知道"这次要说一句",但说什么由她定。 */
export function milestoneNote(level) {
  return (
    `这一轮你刚升到 Lv.${level}。这是**里程碑**(前面几级只有数字在动,这一次要让人听见):` +
    '回复的最后单独加一句升级台词(用你自己的说法,一两句、别报数字、别提"经验值""等级"这种词),' +
    '前面照常回答对方。只在这一轮加。'
  );
}

/**
 * 普通升级(不是里程碑)的**私聊账单**。
 *
 * 为什么不发群:一只每小时都在群里冒泡的机器人,每升一级都开口就是刷屏。
 * 那"普通升级"是不是就没人知道了?——**发给你**。养成是运维者关心的事,
 * 群里只需要偶尔听见一句(里程碑)。
 *
 * @param {number} level 刚升到的等级
 * @param {object} progress `progressForXp` 的结果
 * @param {number|null} nextMilestone 下一个里程碑等级,没有就是 null
 */
export function levelUpReport(level, progress, nextMilestone = null) {
  const tail = nextMilestone
    ? `下一次里程碑 Lv.${nextMilestone}(还差 ${nextMilestone - level} 级)`
    : '已经是最后一个里程碑';
  return `【养成】升到 Lv.${level}（累计 ${Math.floor(progress?.xp ?? 0)} 点；${tail}）`;
}

/** 下一个里程碑等级(超过就返回 null)。给 `/成长` 与私聊账单用。 */
export function nextMilestoneAfter(level) {
  const current = Math.floor(Number(level) || 0);
  return MILESTONE_LEVELS.find((mark) => mark > current) ?? null;
}

/** 给人看的一行(`/成长`、报表)。 */
export function describeForUser(growth) {
  const progress = progressForXp(growth?.xp ?? 0);
  const head = progress.maxed
    ? `Lv.${progress.level}（已满级）`
    : `Lv.${progress.level}　经验 ${Math.floor(progress.xp)}（距下一级还差 ${Math.ceil(progress.remain)}）`;
  return `${head}　已达成里程碑 ${Number(growth?.milestones) || 0} 次`;
}
