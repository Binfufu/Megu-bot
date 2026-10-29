/**
 * 经济:公会委托与随机小事件(D42)。
 *
 * **为什么钱要有一套"来路",而不只是衰减。**
 * 用户的原话是「惠惠的经济系统,不要一直说穷,这一块参考上次解决一直说饿的做法」。
 * "一直说饿"是被 D28 用**真数值 + 有后果**治好的 —— 钱照同一条路:
 * 会花掉(所以"穷"是真的)、也能赚回来(所以"穷"不是死路,而是**动机**)。
 *
 * 三个进钱的口子,分工刻意不同:
 *
 * | 来源 | 谁触发 | 量级 | 为什么这么设计 |
 * |---|---|---|---|
 * | 被投喂 / 被夸 | 群友的日常互动 | 小(+3 / +8) | 让"对她好"有回报,而且是**唯一不需要她自己开口**的进项 |
 * | 公会委托 | 她自己提(关键词/暖群) | 中(+8~+40) | 呼应她"去公会看看有没有委托"的口头禅 —— 让台词变成机制 |
 * | 随机小事件 | 桥掷骰 | 小,可正可负 | 给"钱"一点不确定性,免得变成每月固定工资 |
 *
 * 本文件**全是纯函数**(除了用一个注入的 `random`),不碰数据库、不碰时钟 ——
 * 所以规则可以直接单测,和 `warmup.js` / `mood.js` / `growth.js` 同一套做法。
 *
 * ⚠️ 概率**写在代码里**(`TASK_CHANCE` 等),不写在角色卡里 —— 这是 D22 的教训:
 * "写在提示词里的概率不会变成概率"。
 *
 * ### 冷却为什么是"硬闸门"而不是"提高门槛"
 *
 * `TASK_COOLDOWN_MS` / `EVENT_COOLDOWN_MS` **连 `force` 也挡**(see `rollTask`):
 * 它们是"这件事在物理上不可能连着发生",不是"概率低一点"。要重置只能等时间。
 * 一开始把 `force` 也放进冷却判断里,是刻意的 —— 否则"显式要求"就变成了绕过冷却的后门。
 */
import { CURRENCY, MONEY_POOR } from './stats.js';
import { GAMEPLAY_CONTENT, gameplayText } from './local-gameplay-content.js';

/**
 * 委托的报酬区间(**厄里斯**,D99 按原作口径重标)。
 *
 * 用户给的锚点:「**个人做一次任务相当于美国建筑工人 10 天的薪酬**」——
 * 建筑工人年薪 ≈ 50 万人民币,折下来约 **20 万厄里斯**。所以"大活"就该是这个量级,
 * 但那必须**稀有**(见 `TASK_TIERS` 的权重与 `TASK_COOLDOWN_MS`)。
 */
export const TASK_REWARD = { min: 3_000, max: 200_000 };
/** 她这一轮真去接委托的概率(`/接委托` 那种显式触发不受它限制)。 */
export const TASK_CHANCE = 0.06;
/**
 * 一小段对话里最多几次委托 —— **从 45 分钟拉到 120 小时(5 天)**(D99)。
 *
 * ⚠️ 这一条是本条设计里最容易做错的地方:**锚点约束的是金额,节奏得自己定。**
 * "个人一次 ≈ 10 天工钱"如果配上"一天接四次",日入就是 8 万,和原作里"她们总是很穷"直接矛盾。
 *
 * 这个数字是**模拟出来的**(`scripts\economy-sim.js`,200 天 × 40 次;脚本会自己判判据):
 *
 * | 冷却 | 中位终局余额 | "穷"的时间 | 日入 / 日支 |
 * |---|---|---|---|
 * | 72h | 135,490(太富) | 10.8% | 8,608 / 8,448 |
 * | 96h | 22,305 | 23.9% | 6,879 / 7,799 |
 * | **120h** | **10,520** ✅ | **32.5%** ✅ | 5,207 / 7,819 |
 * | 168h | 469(几乎一直是 0) | 38.4% | 4,807 / 7,912 |
 *
 * 取 **120h(5 天一次)**。⚠️ **这里有个诚实的缺口**:终局余额的**中位数**被
 * "hard 那一档一次 8~20 万"的重尾主导 —— 一个人中一次就够活一个月。
 * 也就是说,**只靠"生活开销 + 饭钱"这两个出口,她终究会攒下钱**;
 * 让"钱留不住"的那一半出口(乱花钱 / 爆裂魔法损坏赔偿 / 请客)是**阶段 3**的事
 * (见 D99 第五节的事件钩子),所以阶段 1 的判据放宽成:
 *   ① 中位终局落在 **1,000 ~ 50,000 厄里斯**(不是永远 0,也攒不下几十天的生活费);
 *   ② "低于穷线"的时间落在 **5% ~ 45%**(既不是从不穷 —— 那条机制是死的,
 *      也不是一直穷 —— 用户原话是「不要一直说穷」)。
 * 阶段 3 把出口补上之后,目标再压回 1,000~5,000。
 */
export const TASK_COOLDOWN_MS = 120 * 60 * 60_000;

/**
 * 随机小事件的概率与冷却。
 *
 * 比委托更稀有:它是"意外",不是日常。而且它**可正可负** ——
 * 一直只赚不赔的经济系统等于缓慢通胀,钱就不值钱了。
 */
export const EVENT_CHANCE = 0.04;
export const EVENT_COOLDOWN_MS = 60 * 60_000;

/**
 * 委托档位。`tier` 越高越少见 —— 用权重而不是阈值,和情绪池同一个做法。
 *
 * ⚠️ **权重在 D99 重排过**:原来 trivial/normal/hard = 40/40/17,
 * 那个形状配上"20 万那档"会让日入直接爆掉。现在 **大活稀有、日常是跑腿** ——
 * 这既是数值平衡,也是原作事实(她们接的多半是找猫送信,大活才有大钱)。
 *
 * `line` 是**给她用的台词方向**,不是要原样发出的话:提示词会把它当"这一轮发生了什么",
 * 让她用自己的语气讲出来。所以这里写的是**事实**,不是文案。
 */
export const TASK_TIERS = [
  { id: 'trivial', weight: 75, reward: [3_000, 8_000], line: GAMEPLAY_CONTENT.taskLines[0] },
  { id: 'normal', weight: 20, reward: [20_000, 50_000], line: GAMEPLAY_CONTENT.taskLines[1] },
  { id: 'hard', weight: 4, reward: [80_000, 200_000], line: GAMEPLAY_CONTENT.taskLines[2] },
  { id: 'fiasco', weight: 1, reward: [0, 0], extra: -20_000, line: GAMEPLAY_CONTENT.taskLines[3] },
];

/**
 * 随机小事件:可正可负。同样只写**事实**,台词交给她。
 * ⚠️ 金额按厄里斯重标(D99):"捡到一点钱"是几百日元那一档,"钱袋丢了"才上千。
 */
export const RANDOM_EVENTS = [
  { id: 'found_coin', weight: 22, delta: [200, 1_200], line: GAMEPLAY_CONTENT.eventLines[0] },
  { id: 'someone_treats', weight: 18, delta: [800, 2_500], line: GAMEPLAY_CONTENT.eventLines[1] },
  { id: 'sold_loot', weight: 16, delta: [1_500, 6_000], line: GAMEPLAY_CONTENT.eventLines[2] },
  { id: 'bought_staff', weight: 14, delta: [-3_000, -1_000], line: GAMEPLAY_CONTENT.eventLines[3] },
  { id: 'tax', weight: 10, delta: [-2_500, -800], line: GAMEPLAY_CONTENT.eventLines[4] },
  { id: 'lost_pouch', weight: 10, delta: [-8_000, -2_000], line: GAMEPLAY_CONTENT.eventLines[5] },
  { id: 'donated', weight: 10, delta: [-3_000, -800], line: GAMEPLAY_CONTENT.eventLines[6] },
];

/** 在区间里取一个整数(含两端)。 */
function pickInRange([min, max], random) {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * **委托面板**(D101 形态二:用户主动去接活)。用户原话:
 * 「让惠惠去接委托(**显示委托面板**)」。
 *
 * 为什么要"面板"而不是又掷一次骰:掷骰是**她**自己接活(被动);面板是**人**看着挑,
 * 挑之前就知道报酬与风险 —— 这是"用户在玩",不是"数值在动"。
 *
 * ⚠️ 面板由**代码掷**(照 `TASK_TIERS` 的权重),不是让模型编 ——
 * 模型编出来的报酬没法核对,那正是 D44「数字只能来自库」要防的。
 */
export const QUEST_LABELS = GAMEPLAY_CONTENT.questLabels;

/** 每条委托要花多少体力(接活是体力活)。 */
export const QUEST_STAMINA = { trivial: 4, normal: 12, hard: 20, fiasco: 10 };

/** 面板一次给几条 —— 三条:够挑,又不至于让人读不完。 */
export const QUEST_BOARD_SIZE = 3;

/**
 * 面板能挂多久(过了就作废 —— 看板上的纸会被撕掉)。
 * ⚠️ 这一条**不是**为了好玩:面板存在 `meta` 里,不设 TTL 就会一直挂着一块过期的看板。
 */
export const QUEST_BOARD_TTL_MS = 6 * 60 * 60_000;

/**
 * **面板这条路的两个闸门**(D101)。
 *
 * ⚠️ 为什么必须有:掷骰那条路有 `TASK_COOLDOWN_MS`(5 天)兜着,而**面板是用户点出来的** ——
 * 不设闸门的话,`/委托` + `/接 1` 连点就能刷钱,那正好把 D99 好不容易做出来的"紧巴巴"打穿。
 * 所以接活**单独**一套:①两条之间至少隔 `QUEST_TAKE_COOLDOWN_MS`;
 * ②**每天最多 `QUEST_TAKE_PER_DAY` 条**。
 * 第一版取"1 条/天"是**故意保守**的:先量几天真实使用频率,再决定要不要放宽(D101 第五节的判据)。
 */
export const QUEST_TAKE_COOLDOWN_MS = 2 * 60 * 60_000;
export const QUEST_TAKE_PER_DAY = 1;

/** 掷一块委托面板(纯函数,`random` 可注入)。 */
export function rollQuestBoard({ count = QUEST_BOARD_SIZE, random = Math.random } = {}) {
  // ⚠️ **抽不放回** —— 第一版是"每条独立掷",结果 75% 权重下有 42% 的面板是**三条跑腿**,
  //    挑起来毫无意义(而且看着像 bug)。现在保证三条**档位各不相同**,choice 才是真的。
  // ⚠️ 上界要**先算出来**:写 `index < Math.min(count, pool.length)` 会在 pool 变短之后
  //    把循环提前掐断(实测只出两条 —— 自己的测试当场抓到)。
  const pool = [...TASK_TIERS];
  const size = Math.min(count, pool.length);
  const board = [];
  for (let index = 0; index < size; index += 1) {
    const tier = pickWeighted(pool, random) ?? pool[0];
    pool.splice(pool.indexOf(tier), 1);
    board.push({
      index: index + 1,
      tier: tier.id,
      label: QUEST_LABELS[tier.id] ?? tier.id,
      reward: pickInRange(tier.reward, random),
      // `extra` 是"搞砸了要赔的违约金"(D99 给 fiasco 那一档加的);正数档这里是 0
      penalty: Math.min(0, tier.extra ?? 0),
      stamina: QUEST_STAMINA[tier.id] ?? 8,
      line: tier.line,
    });
  }
  return board;
}

/**
 * 面板要念给人听的那一段(**确定性文本,不过模型** —— 挑活是操作,不是闲聊)。
 *
 * @param {Array<object>} board
 * @param {{unit?: string}} [options]
 */
export function formatQuestBoard(board, { unit = CURRENCY.name } = {}) {
  const text = GAMEPLAY_CONTENT.economyText;
  if (!Array.isArray(board) || board.length === 0) return text.boardEmpty;
  const lines = [text.boardHeader];
  for (const row of board) {
    const pay = gameplayText(row.penalty < 0 ? text.boardPenalty : text.boardPay,
      { reward: row.reward, unit, '-penalty': -row.penalty });
    lines.push(gameplayText(text.boardRow, { ...row, pay }));
  }
  lines.push(text.boardFooter);
  return lines.join('\n');
}

/** 按权重抽一项。权重表与 `mood.js` 的池子同一个做法:不归一化,按总和取比例。 */
function pickWeighted(rows, random) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return null;
  let roll = random() * total;
  for (const row of rows) {
    roll -= row.weight;
    if (roll < 0) return row;
  }
  return rows[rows.length - 1];
}

/**
 * 她此刻的"钱的处境"。**暖群话题按它挑**(D42)—— 这是让钱影响行为的那一步。
 *
 *   `poor`       低于穷的线 → 话题偏向"怎么赚钱、省着花"
 *   `rich`       很宽裕     → 话题偏向"请客、想买什么"
 *   `comfortable` 其余       → 中性话题
 *
 * @param {{money?: number, lastTaskAt?: number, now?: number}} ctx
 */
export function moneyMood({ money, lastTaskAt = 0, now = 0 } = {}) {
  const amount = Number(money) || 0;
  if (amount < MONEY_POOR) return 'poor';
  // 最近刚接过委托 → 这会儿手头松,聊点花钱的(比单纯看数字更像"刚发了工钱")
  const justPaid = lastTaskAt > 0 && now - lastTaskAt < 2 * 60 * 60_000;
  if (amount >= 12_000 && justPaid) return 'rich';
  return 'comfortable';
}

/**
 * 掷一次"这一轮有没有接到委托"。
 *
 * @param {{now: number, money: number, lastTaskAt?: number, force?: boolean}} ctx
 *   `force` = 显式要求(群里有人明确让她去接个委托):跳过**概率**,但**不跳过冷却** ——
 *   否则"显式要求"就成了绕过冷却的后门。
 * @param {() => number} [random]
 * @returns {{delta: number, line: string, tier: string}|null}
 */
export function rollTask(ctx, random = Math.random) {
  const { now, money, lastTaskAt = 0, force = false } = ctx;
  // 冷却**先于** force 判断:显式要求只跳过"概率",不跳过"刚接过一次"。
  if (now - lastTaskAt < TASK_COOLDOWN_MS) return null;
  const chance = Number(money) < MONEY_POOR ? TASK_CHANCE * 2 : TASK_CHANCE;
  if (!force && random() >= chance) return null;

  const tier = pickWeighted(TASK_TIERS, random);
  if (!tier) return null;
  // ⚠️ `extra` 是"这一档自己带着的额外收支":搞砸了那一档 `reward` 是 0,
  //    但**违约金是真的要赔的** —— 不然台词说"赔了违约金"而账上一分没动,那是账本说谎。
  const delta = pickInRange(tier.reward, random) + (tier.extra ?? 0);
  return { delta, line: tier.line, tier: tier.id };
}

/**
 * 掷一次随机小事件。
 *
 * @param {{now: number, lastEventAt?: number}} ctx
 * @param {() => number} [random]
 * @returns {{delta: number, line: string, id: string}|null}
 */
export function rollEvent(ctx, random = Math.random) {
  const { now, lastEventAt = 0 } = ctx;
  if (now - lastEventAt < EVENT_COOLDOWN_MS) return null;
  if (random() >= EVENT_CHANCE) return null;

  const event = pickWeighted(RANDOM_EVENTS, random);
  if (!event) return null;
  return { delta: pickInRange(event.delta, random), line: event.line, id: event.id };
}

/**
 * 钱的收支该怎么进提示词。
 *
 * 关键在最后那句:**不许她念数字**。钱和那三个数一样是"给她的感觉",
 * 报数由 `/钱包` 与爱丽丝的扫描负责(和 D28 的分工一致)。
 */
export function describeLedgerForPrompt(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const lines = entries.map(
    (entry) => gameplayText(GAMEPLAY_CONTENT.economyText.ledgerEntry,
      { ...entry, sign: entry.delta >= 0 ? '+' : '', currency: CURRENCY.name }),
  );
  return lines.join('\n') + gameplayText(GAMEPLAY_CONTENT.economyText.ledgerTail, { currency: CURRENCY.name });
}

// ---------------------------------------------------------------------------
// 钱包:她自己那句话(D44)
// ---------------------------------------------------------------------------

/**
 * 「钱包」那一句的提示词。
 *
 * 用户 2026-09-27 的要求:
 *   「改一下惠惠'/钱包'的回应文本形式,不要像机器人一样,只要说自己有多少钱就行,
 *     报详细数值的工作交给爱丽丝」
 *
 * 所以提示词**刻意不给她任何"规格"**:不提"枚"、不给三围、不给开销速率、不许列账单 ——
 * 那些是爱丽丝的活(D28/D42 的分工:报数与角色分开)。
 * 她只需要用**自己的口吻**说一个数。
 *
 * ⚠️ 数字必须由桥给(她从库里读不到),而且**说完要校验**(见 `mentionsAmount`)——
 * 模型有可能把 49 说成 50,那就是"诊断工具说谎"。
 */
export function walletPrompt(amount) {
  return gameplayText(GAMEPLAY_CONTENT.economyText.walletPrompt, { amount: Math.round(amount), currency: CURRENCY.name });
}

/**
 * 她的回复里有没有说出那个数。
 *
 * 这是**唯一**决定"用她那句还是用确定性兜底"的判据 —— 纯函数,所以可以直接单测。
 * 宽松匹配:阿拉伯数字、全角数字、以及"三千二百"这类中文写法都算数,
 * 因为卡着她的重点是"别说错",不是"必须用阿拉伯数字"。
 *
 * ⚠️ **2026-10-02(D99)扩到万位**:钱改成厄里斯之后,余额常态就是**几千到几十万**,
 * 原来那句"只处理到 999"等于把最该核对的那一段全放过去了。
 *
 * @param {string} text 她真的说出来的话
 * @param {number} amount 桥给她的那个数
 */
export function mentionsAmount(text, amount) {
  const target = Math.round(Number(amount) || 0);
  const source = String(text ?? '');
  if (source === '') return false;
  if (source.includes(String(target))) return true;
  // 全角数字(有人/模型偶尔会打全角)
  const fullWidth = String(target).replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
  if (fullWidth !== String(target) && source.includes(fullWidth)) return true;
  // 中文数字(含口语短式:"一千五"= 1500、"三万二"= 32000)
  // ⚠️ 0 也要能对上「身无分文」/「零」那类说法 —— 破产那一次恰恰最该核对。
  for (const zh of chineseNumberCandidates(target)) {
    if (zh && source.includes(zh)) return true;
  }
  return false;
}

/**
 * 一个数的**中文写法候选**(纯函数)。返回数组,`mentionsAmount` 命中任意一个就算说过。
 *
 * 为什么要"候选"而不是一个:中文口语里 **1500 会说成"一千五"**(不说"一千五百"),
 * **32000 会说成"三万二"**。只给规范式会把最自然的那种说法判成"她没说对",
 * 于是每次都退回确定性兜底 —— 那比不核对更糟(她永远说不了自己的钱)。
 * 上限取到 `MONEY_MAX`(9,999,999),超出返回空数组 = 不猜。
 */
export function chineseNumberCandidates(value) {
  const number = Math.round(Number(value) || 0);
  if (!Number.isInteger(number) || number < 0 || number > 9_999_999) return [];
  const canonical = chineseNumber(number);
  const out = new Set();
  if (canonical) out.add(canonical);
  // 口语短式:省掉结尾那一档的单位字(一千五百 → 一千五;一百五十 → 一百五;三万二千 → 三万二)。
  // ⚠️ 两条边界:① 只在 **≥100** 时做(不然 20「二十」会被切成「二」);
  //    ② **不省"万"**(「三十万」切出来是「三十」= 30,那是**假命中** —— 负数钱比不核对更糟)。
  if (canonical && number >= 100 && /[十百千]$/.test(canonical)) {
    const short = canonical.slice(0, -1);
    if (short.length >= 2) out.add(short);
  }
  // "两"变体:20,000 口语是"两万"(规范式给的是"二万")
  for (const candidate of [...out]) {
    if (/^二(万|千)/.test(candidate)) out.add(candidate.replace(/^二/, '两'));
  }
  return [...out];
}

/** @param {number} value 0 ~ 9,999,999 */
function chineseNumber(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (!Number.isInteger(value) || value < 0 || value > 9_999_999) return null;
  if (value === 0) return '零';
  // 万位单独递归:`digits[999]` 是不存在的,拿它当"几位数字"会写出 `undefined万`。
  if (value >= 10_000) {
    const head = `${chineseNumber(Math.floor(value / 10_000))}万`;
    const low = value % 10_000;
    if (low === 0) return head;
    // 万以下不足四位要补一个"零"(10005 → 一万零五)
    return low < 1_000 ? `${head}零${chineseNumber(low)}` : `${head}${chineseNumber(low)}`;
  }
  const units = [[1_000, '千'], [100, '百'], [10, '十']];
  let rest = value;
  const out = [];
  let pendingZero = false;
  for (const [unit, name] of units) {
    const count = Math.floor(rest / unit);
    if (count > 0) {
      if (pendingZero && out.length > 0) out.push('零');
      pendingZero = false;
      // 10~19 说"十五"而不是"一十五"
      out.push(unit === 10 && count === 1 && out.length === 0 ? name : `${digits[count]}${name}`);
      rest -= count * unit;
    } else if (out.length > 0 && rest > 0) {
      pendingZero = true;
    }
  }
  if (rest > 0) {
    if (pendingZero && out.length > 0) out.push('零');
    out.push(digits[rest]);
  }
  return out.join('');
}
