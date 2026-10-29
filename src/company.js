/**
 * **用户主动**的互动事件(陪着做某件事)—— D101 形态一(自然语言邀约)。**纯函数**。
 *
 * 用户 2026-10-02 的原话:
 * > 「现在做的只是**被动随机事件**,我还需要**用户主动互动的事件**,例如:
 * >   带当前角色一起逛街/吃饭叫当前角色一起陪/和当前角色一起睡觉/让当前角色去接委托(显示委托面板)/
 * >   跟当前角色去野外随机地点(山洞、海边等等)探险/和当前角色钓鱼……」
 *
 * 与 D99 阶段 3 的区别一句话:**那边是她抛钩子等人接,这边是人拉她去做事、她陪着。**
 *
 * 三条口径(缺一条就不许加进来):
 *   ① **数值在代码里** —— 模型只说"这是什么",效果与封顶由这张表给(和 `applyMeal` 同一族);
 *   ② **每条都有冷却** —— 不然"陪我去逛街"喊十遍就是刷数值的入口;
 *   ③ **要能演** —— 光加数值不够,还得告诉它"这一轮你俩在做什么"(见 `companyNote`)。
 *
 * ⚠️ **一起吃饭不在这张表里**:那条已经有更强的实现(`detectFeeding` + 免单/饱食/体力),
 *    这里再写一遍就会**双重结算**(用户说的"一起吃饭"会被当成"被投喂"处理,正是想要的效果)。
 */

import { GAMEPLAY_CONTENT, gameplayText } from './local-gameplay-content.js';

/** 每条邀约的冷却与效果。`effect` 会被 `applyStory()` 结算(有封顶、有流水)。 */
export const COMPANION_ACTIVITIES = [
  { id: 'shopping', label: GAMEPLAY_CONTENT.companyActivities[0].label,
    cooldownMs: 30 * 60_000, effect: { money: -2_500, mood: 8, stamina: -6 },
    keywords: ['逛街', '上街', '陪吾去买', '一起去买', '逛市集', '去市集'], line: GAMEPLAY_CONTENT.companyActivities[0].line },
  { id: 'sleep_together', label: GAMEPLAY_CONTENT.companyActivities[1].label,
    cooldownMs: 6 * 60 * 60_000, effect: { stamina: 25, mood: 6, health: 1 },
    keywords: ['一起睡', '陪着睡', '陪吾睡', '抱着睡', '一起躺', '陪睡'], line: GAMEPLAY_CONTENT.companyActivities[1].line },
  { id: 'outing', label: GAMEPLAY_CONTENT.companyActivities[2].label,
    cooldownMs: 60 * 60_000, effect: { mood: 6, stamina: -10, money: -1_200 },
    keywords: ['带你出去', '带吾出去', '一起出门', '出去走走', '散步', '兜风', '去郊游', '去野餐'], line: GAMEPLAY_CONTENT.companyActivities[2].line },
  { id: 'adventure', label: GAMEPLAY_CONTENT.companyActivities[3].label,
    cooldownMs: 2 * 60 * 60_000, effect: { stamina: -14, mood: 4, money: 3_000 },
    keywords: ['探险', '去山洞', '去海边', '去森林', '去遗迹', '去沼泽', '野外'], line: GAMEPLAY_CONTENT.companyActivities[3].line },
  { id: 'cook', label: GAMEPLAY_CONTENT.companyActivities[4].label,
    cooldownMs: 60 * 60_000, effect: { money: -800, satiety: 20, mood: 5 },
    keywords: ['做顿饭', '做饭给吾', '做饭给你', '下厨', '给吾做饭', '做给吾吃'], line: GAMEPLAY_CONTENT.companyActivities[4].line },
  { id: 'practice', label: GAMEPLAY_CONTENT.companyActivities[5].label,
    cooldownMs: 2 * 60 * 60_000, effect: { mana: -20, stamina: -8, mood: 7 },
    keywords: ['练魔法', '练爆裂', '教你魔法', '教吾魔法', '一起练', '练习魔法'], line: GAMEPLAY_CONTENT.companyActivities[5].line },
];

/** 按 id 取一条(纯函数);认不出来返回 null。 */
export function companyById(id) {
  return COMPANION_ACTIVITIES.find((row) => row.id === id) ?? null;
}

/**
 * 这条消息是不是在"拉着她做某件事"?**纯函数**。
 *
 * 判据是**关键词**而不是模型:和 `detectFeeding` 同一条规矩 ——
 * 要稳定复现的行为不许靠提示词许愿(`docs\00`)。
 *
 * @param {string} text 用户这一轮说的话
 * @returns {object|null} 命中的那一条
 */
export function detectCompany(text) {
  const source = String(text ?? '');
  if (source === '') return null;
  return COMPANION_ACTIVITIES.find((row) => row.keywords.some((word) => source.includes(word))) ?? null;
}

/**
 * 这一轮"你俩在做什么"该怎么跟她说(D101)。
 *
 * 和 `feedingNote()` 同一族:**点破这一轮在干什么 + 给一个演的方向**,
 * 但**数值不许她管**(所以这里也明说"别报数字")。
 *
 * @param {{activity?: object, fatigue?: boolean}} [ctx]
 */
export function companyNote({ activity } = {}) {
  if (!activity) return '';
  return gameplayText(GAMEPLAY_CONTENT.companyPrompt, { label: activity.label, line: activity.line });
}

/**
 * 长时间活动(钓鱼 / 探险)的**等待窗口**:开一个挂起活动,由 tick 在随机时刻推进。
 *
 * ⚠️ 这一版只定义口径,**还没实现**(见 D101 第六节):`FISH_MIN_WAIT_MS` / `FISH_MAX_WAIT_MS`
 * 是"她甩竿到有动静"的间隔;一局最多 `FISH_MAX_CASTS` 竿,之后必须收尾。
 */
export const FISH_MIN_WAIT_MS = 3 * 60_000;
export const FISH_MAX_WAIT_MS = 8 * 60_000;
export const FISH_MAX_CASTS = 3;

/**
 * 钓鱼的战利品表(D101 第四节;**2026-10-02 用户当场改过一版**)。
 *
 * 用户口径(第一版):「大概率是随机品种的**鱼**、小概率是**随机物品**、极小概率**超高价值物品**……
 * 可以比正常的高一点点」。
 * 用户口径(第二版,就是现在这张表):「**超高价值的上限给稀有**,超高价值**就是要高就是要爽**,
 * 就是要运气好,要不就**再加一档极高价值**,**不超过 1M**」。
 *
 * ⚠️ **这条推翻了我自己写的那句锚点**("钓鱼不该比拼命接委托还赚、上限压在大活 200,000 之下")。
 *    用户的优先级很明确:**手感 > 平衡** —— 钓到秘宝那一下要真的炸裂。
 *    我照办,但把**期望值**算出来钉在测试里,免得它悄悄漂移:
 *    每次抛竿的期望 ≈ **8,500 通用货币**(鱼 70% / 杂物 22% / 稀有 6% / 超高 1.7% / 极高 0.3%),
 *    而一顿定食是 900 —— 也就是说**钓鱼成了主要收入来源之一**。
 *    ⚠️ 如果哪天觉得"她太有钱了",**动的是概率或每天的竿数,不是把上限砍回去**
 *    (用户要的是"爽",不是"便宜");`FISH_MAX_CASTS_PER_DAY` 就是为这个留的闸门。
 */
export const FISH_TABLE = [
  {
    id: 'fish',
    weight: 70,
    kind: 'fish',
    names: GAMEPLAY_CONTENT.fishNames[0],
    money: [300, 1_200],
    // ⚠️ **没有 satiety** —— 用户 2026-10-02:「钓鱼本身**不应该加饱食度**啊,
    //    钓完鱼**分出选项**:吃几条(烤鱼煮鱼煎鱼),剩下的全卖/带回家风干」。
    //    所以钓上来的东西是**物品/钱**;饱食是**钓完之后另选**的事(见 `FISH_KEEP_OPTIONS`)。
    //    绑定表 `stat-binding.js` 的 `fish: { allowed: ['money','mood'] }` 也是这个口径。
  },
  {
    id: 'junk',
    weight: 22,
    kind: 'junk',
    names: GAMEPLAY_CONTENT.fishNames[1],
    money: [0, 300],
    mood: [-1, 2],
  },
  {
    id: 'rare',
    weight: 6,
    kind: 'rare',
    names: GAMEPLAY_CONTENT.fishNames[2],
    // ⚠️ 用户:"超高价值的上限给稀有" —— 原来超高那档的 80,000 现在是**稀有**的上限。
    money: [8_000, 80_000],
  },
  {
    id: 'treasure',
    weight: 1.7,
    kind: 'treasure',
    names: GAMEPLAY_CONTENT.fishNames[3],
    money: [100_000, 300_000],
  },
  {
    id: 'legend',
    weight: 0.3,
    kind: 'legend',
    // 「极高价值」是用户点名加的一档:**上限 1M,极小概率**(千分之三)
    names: GAMEPLAY_CONTENT.fishNames[4],
    money: [300_000, 1_000_000],
  },
];

/** 权重总和(报表/测试用)。 */
export function fishTableWeight() {
  return FISH_TABLE.reduce((sum, row) => sum + row.weight, 0);
}

/** 一竿的**期望收益**(通用货币)—— 把"爽"量化,免得它悄悄漂移(见 `FISH_TABLE` 的注释)。 */
export function fishExpectedValue() {
  const total = fishTableWeight();
  return FISH_TABLE.reduce((sum, row) => {
    const mid = (row.money[0] + row.money[1]) / 2;
    return sum + (row.weight / total) * mid;
  }, 0);
}

/**
 * 「钓上来了要 **@那个把它钓起来的人**」—— 用户原话:
 * 「掉上来的时候要 **@用户**,因为等鱼的过程用户有可能去干别的事」。
 *
 * ⚠️ 这一条撞上了本项目的一条**有意为之**的纪律:`sanitizeOutgoingText()` 会
 * **主动剥掉** `<@!id>` 与行首 `@昵称`(理由:回复刚说话的人没理由 ping 他)。
 * 所以它必须走一个**窄口子的例外**(`keepMention: true`),不能把剥离整个关掉。
 * 这段文字只解释口径;真正的例外在 `src\qq.js` 的 `sanitizeOutgoingText` 与
 * `src\index.js` 的 `sendChunked({ keepMention })`,**只有钓鱼收网这一处用它**。
 */
/**
 * **钓完之后**的处置选项(用户 2026-10-02 的原话):
 * 「钓完鱼**分出选项**:吃几条(**烤鱼煮鱼煎鱼**),剩下的**全卖 / 带回家风干**
 *   —— 这一块正好可以延伸出来和即将做的**家园 / 典当铺**等等场景联动」。
 *
 * 三条口径:
 *   ① **吃**才算饱食(而且只算她真吃的那几条);
 *   ② **卖**只换钱;
 *   ③ **带回家风干**不换钱、也不涨饱食 —— 它落成一件**家里的东西**(`homeItem`),
 *      这正是"家园"场景的接口:东西攒得下来、看得见(D100 的第三件机制)。
 *
 * ⚠️ `effect.homeItem` **不是数值** —— 绑定表不管它(它按 `ALL_STATS` 过滤),
 *    落库由"家园"那一批来做;在那之前它只进 `stats_event.detail`(可查、可回看)。
 */
export const FISH_KEEP_OPTIONS = [
  { id: 'grill', label: '烤鱼', effect: { satiety: 20, mood: 4 }, line: '架火烤了几条' },
  { id: 'boil', label: '煮鱼汤', effect: { satiety: 16, mood: 3, health: 1 }, line: '煮了一锅鱼汤' },
  { id: 'fry', label: '煎鱼', effect: { satiety: 18, mood: 5 }, line: '下锅煎了几条' },
  { id: 'sell', label: '全卖掉', effect: { money: 0 }, line: '拎到市场全卖了' },
  { id: 'dry', label: '带回家风干', effect: { homeItem: '风干鱼' }, line: '带回家挂起来风干' },
];

/**
 * **按档位**的处置选项(用户 2026-10-02 实测第 4 条:
 * 「钓上了**不同档位的东西要配套不同的处理方法**,而且要**收杆之后再结算**询问处理方法」)。
 *
 * 与 `FISH_KEEP_OPTIONS` 的关系:那张是**钓到鱼**时的吃法(旧版,单条鱼现场处理);
 * 这一张是**收杆之后、按鱼篓里有什么**给的一套处置 —— 所以它多了"扔杂物 / 留稀有物"这类。
 * ⚠️ 两条口径不变:**吃才算饱食**、**卖只换钱**、**带回家风干**落成家里的东西(`homeItem`),
 *    而且都必须过 D102 的绑定表(见 `stat-binding.js`:鱼相关的只准动钱/心情/饱食)。
 */
export const FISH_HANDLING = [
  { id: 'grill', label: '烤着吃', kinds: ['fish'], effect: { satiety: 20, mood: 4 }, line: '架火烤了' },
  { id: 'boil', label: '煮汤', kinds: ['fish'], effect: { satiety: 16, mood: 3, health: 1 }, line: '煮了一锅汤' },
  { id: 'fry', label: '煎了', kinds: ['fish'], effect: { satiety: 18, mood: 5 }, line: '下锅煎了' },
  { id: 'sell', label: '全卖掉', kinds: ['fish'], effect: { money: 0 }, line: '拎到市场全卖了' },
  { id: 'dry', label: '带回家风干', kinds: ['fish'], effect: { homeItem: '风干鱼' }, line: '带回家挂起来风干' },
  { id: 'toss', label: '杂物扔了', kinds: ['junk'], effect: { mood: 1 }, line: '把没用的都扔了' },
  { id: 'keep_junk', label: '杂物留着', kinds: ['junk'], effect: { mood: 2 }, line: '收进包里留着' },
  { id: 'sell_precious', label: '值钱的出手', kinds: ['rare', 'treasure', 'legend'], effect: { money: 0 }, line: '拿去换成了钱' },
  { id: 'keep_precious', label: '值钱的留着', kinds: ['rare', 'treasure', 'legend'], effect: { mood: 6 }, line: '收进箱子里留着' },
];

/**
 * **钓鱼的场景推进**:用户要求「严谨、推进快速」——
 * 「开始互动之后**立刻**到随机水域找随机钓点 → **选鱼饵**,不能像(目前的群聊对话)一样磨蹭,
 *  **三句话以内**到 [下鱼饵] 这一步开始等待」。
 */
export const FISH_STEPS = ['spot', 'bait', 'cast'];
export const FISH_PROGRESS_BUDGET = 3;

/** 随机水域 × 随机钓点(推进快 + 每次不一样;名字给模型用作"现场")。 */
export const FISHING_SPOTS = GAMEPLAY_CONTENT.fishingSpots;

/**
 * **鱼饵库**(用户 2026-10-02:「鱼饵太少了,**库里多加50件**,可以是更多东西,
 * **每次随机挑三个**出来」)。
 *
 * 所以这里是一个**池子**(50+ 件),`startFishing()` 每次洗牌取三件 —— 三个人来问会看到三套不同的饵。
 * 内容尽量贴着这个世界:渔具店的常规货 + 冒险者随手能摸到的东西 + 几件只有当前角色会拿出来的怪东西。
 * `good` 只是**风味标签**(给措辞用),不参与掉落概率 —— 概率归 `FISH_TABLE`,别让两个地方各说一套。
 */
export const FISH_BAITS = [
  // —— 渔具店的正经货 ——
  { id: 'worm', label: '蚯蚓', good: true },
  { id: 'bread', label: '面包屑', good: true },
  { id: 'lure', label: GAMEPLAY_CONTENT.baitLabels.lure, good: true },
  { id: 'cheese', label: '一块发霉的奶酪', good: false },
  { id: 'corn', label: '玉米粒', good: true },
  { id: 'riceball', label: '半个饭团', good: true },
  { id: 'dough', label: '揉过头的面团', good: false },
  { id: 'shrimp', label: '小河虾', good: true },
  { id: 'minnow', label: '当饵用的小鱼', good: true },
  { id: 'fly', label: '手绑的毛钩', good: true },
  { id: 'spoon', label: '亮片', good: true },
  { id: 'feather', label: '闪光羽毛', good: true },
  // —— 冒险者随手能摸到的 ——
  { id: 'snail', label: '蜗牛', good: true },
  { id: 'grasshopper', label: '蚂蚱', good: true },
  { id: 'beetle', label: '一只甲虫', good: false },
  { id: 'frog', label: '小青蛙', good: true },
  { id: 'lizard_tail', label: '蜥蜴尾巴', good: false },
  { id: 'jerky', label: '一块肉干', good: true },
  { id: 'fishgut', label: '鱼肠子', good: true },
  { id: 'chicken_liver', label: '鸡肝', good: true },
  { id: 'spider', label: '蜘蛛', good: false },
  { id: 'ant_egg', label: '蚂蚁卵', good: false },
  { id: 'berry', label: '野果', good: true },
  { id: 'apple_core', label: '苹果核', good: false },
  { id: 'melon_rind', label: '西瓜皮', good: false },
  { id: 'leaf', label: '一片树叶', good: false },
  { id: 'petal', label: '花瓣', good: false },
  { id: 'seaweed', label: '海藻', good: true },
  { id: 'clam', label: '砸开的蛤蜊', good: true },
  { id: 'crab_claw', label: '螃蟹钳子', good: true },
  // —— 杂物(但真钓得上东西)——
  { id: 'copper', label: '一枚小铜片', good: true },
  { id: 'glass_bead', label: '玻璃珠', good: true },
  { id: 'coin_bad', label: '不值钱的旧硬币', good: true },
  { id: 'thread', label: '线团', good: false },
  { id: 'knot', label: '打了个结的绳头', good: false },
  { id: 'button', label: '掉了的扣子', good: false },
  { id: 'nail', label: '一根弯钉子', good: false },
  { id: 'soap', label: '一小块肥皂', good: false },
  { id: 'candle_end', label: '蜡烛头', good: false },
  // —— 这个世界的特色货 ——
  { id: 'mana_shard', label: '磨碎的魔素结晶', good: true },
  { id: 'potion_dregs', label: '药剂瓶底的渣', good: true },
  { id: 'explosion_ash', label: GAMEPLAY_CONTENT.baitLabels.explosion_ash, good: false },
  { id: 'aqua_bottle', label: GAMEPLAY_CONTENT.baitLabels.aqua_bottle, good: false },
  { id: 'guild_flyer', label: '公会的传单', good: false },
  { id: 'yuuyuu_charm', label: GAMEPLAY_CONTENT.baitLabels.yuuyuu_charm, good: true },
  { id: 'kazuma_sock', label: GAMEPLAY_CONTENT.baitLabels.kazuma_sock, good: false },
  { id: 'chomusuke_fur', label: GAMEPLAY_CONTENT.baitLabels.chomusuke_fur, good: true },
  { id: 'crimson_thread', label: GAMEPLAY_CONTENT.baitLabels.crimson_thread, good: true },
  { id: 'wand_polish', label: '魔杖保养油', good: false },
  { id: 'old_scroll', label: '泡过水的旧卷轴', good: false },
  { id: 'slime_jelly', label: '史莱姆果冻', good: true },
  { id: 'goblin_tooth', label: '哥布林的牙', good: false },
  { id: 'dragonfly', label: '蜻蜓', good: true },
  { id: 'firefly', label: '萤火虫（晚上才亮）', good: true },
];


/**
 * **收网那条 @ 起钓者**的说明(见 `stats.js`/`qq.js` 的 `keepMention` 窄口子)。
 * 用户原话:「掉上来的时候要 **@用户**,因为等鱼的过程用户有可能去干别的事」。
 */
export const FISH_MENTION_NOTE = '收网那条要 @ 起钓的那个人(群内用 <@!openid>;私聊不用 @)';
