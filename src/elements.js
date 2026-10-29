/**
 * **元素连接图**(用户 2026-10-06 提出):每个"有名字的东西"都要能说清
 * **从哪来 / 出现在哪些场景 / 能干什么 / 动哪些数值 / 连着谁**。
 *
 * ## 它解决什么
 *
 * 用户原话:「给每个将要和已经出现的元素(如风干鱼)做出神经网络连接……防止出现什么用都没有的垃圾
 * (美术装饰物品除外)」;以及「方便每个元素的玩法深入和数值设计」。
 *
 * ## ⚠️ 第一层修正(1.90.0 / D146):连接由**类别**承担,不由个体承担
 *
 * 用户第二条原话:「一个简单物件的元素连接又不能太多,不然**物件数量的广度**又很难推进 ——
 * 现实里一件类似"风干鱼"的简单物件能有多少常用的元素连接?」
 *
 * **现实适用**:一把干鱼没有"连接"这个概念,它有**类别**(食物):能吃 / 能存 / 能买卖送 / 能搁在哪;
 * 个别差异属于**个体**。所以:
 *
 * | 层 | 谁负责 | 例子 |
 * |---|---|---|
 * | **类别**(`ITEM_CLASSES`) | 这类东西**默认能干什么** | `food`:吃 / 存 / 卖 / 送 |
 * | **个体**(物品声明) | **只写差异** | 风干鱼:能投喂她、能带进跑团、连着吃会腻 |
 *
 * ## ⚠️ 第二层:框架最缺的**四类连接**(1.91.0 / D147;用户:「先往这个方向发展,做出大框架再深化」)
 *
 * | # | 类 | 以前缺什么 | 现在是什么 |
 * |---|---|---|---|
 * | ① | **人**(`person`) | 家园 / 委托 / 面板 / 网页聊天全挂在人身上,图里却没有"人" | `person:*` / `agent:*` 节点 |
 * | ② | **数值**(`stat`) | `→satiety` 只是边上一串字 | `stat:*` 节点(可见"谁涨谁跌") |
 * | ③ | **关系** | ⚠️ `gift`(送人)**没有接收方** | `送礼→person:*` + 好感边(只画边,分数不在这里) |
 * | ④ | **跑团三件套** | 委托 / 场景卡 / 判定结果一个都不在图里 | `quest:*` / `scene:*` / `roll:*` 节点 |
 *
 * ### 📌 纪律:每一类**只做连接、不定数值**(数值等四类齐了再一起定)
 *
 * 这条在代码里是**机械保证**的,不靠"记得":
 *   · 新节点(人 / 数值 / 跑团)**一个都不带 `numbers` 字段** —— 数值槽仍然只在**物品**上;
 *   · 数值的**去向**也不在这里定:`stat` 的入边一律**从动作表派生**
 *     (`bindings` 的 `allowed` + 各表自己的效果字段),不另抄一份效果;
 *   · `nodeNumbers()` 把第一条变成判据(见 `scripts\selftest-elements.js`)。
 *
 * ## 三条纪律
 *
 * ① ⚠️ **能算的一律派生**:场所 / 家具 / 动词 / "东西从哪来" / "她会去哪些地方" /
 *    "谁动了哪个数值"全从现有表读;**手写的只有**类别、个体差异、人物、判定档位。
 * ② ⚠️ **认不出就报**:边指向不存在的元素 → `dangling`;物品没类别 / 类别没用途 /
 *    人一个边都没有 / 判定档位不是"两颗骰子" → 硬错。
 * ③ **数值可以空着**:`null` = "还没设计",进 `unsetNumbers` 清单 —— 那就是下一步的待办。
 *
 * 机制表仍由调用方传入；只有声明人物展示由固定本地内容读取器提供，不反向依赖机制。
 */

import { INFRA_CONTENT } from './local-infra-content.js';

// ---------------------------------------------------------------------------
// 人话表(报告与页面共用)
// ---------------------------------------------------------------------------

/** 用途标签的人话(加新用途时**顺手加一句**)。 */
export const USE_LABEL = Object.freeze({
  eat: '她自己吃',
  store: '收着(贮藏)',
  sell: '换钱',
  gift: '送人(收礼的人在图里)',
  place: '摆出来看',
  feed: '投喂她',
  quest: '带进跑团',
  craft: '当材料',
  use: '拿来用',
  report: '自己报备一句',
});

/** 边类型的人话(报告上"这条边是什么关系"要说得出人话)。 */
export const EDGE_LABEL = Object.freeze({
  '发生在': '发生在哪个场所',
  '产出': '产出',
  '出现在': '出现在',
  '能摆到': '能摆到',
  '上面摆着': '上面摆着',
  '收': '收哪几类',
  '用(类别)': '用途(类别)',
  '用(个体)': '用途(个体)',
  '动': '影响(类别)',
  '动(个体)': '影响(个体)',
  '影响(派生)': '影响(从动作表派生)',
  '可能影响': '可能影响',
  '属于': '属于她',
  '送礼': '能送给',
  '收到': '能收到',
  '和她的关系': '和她的关系',
  '他称她': '他称她',
  '同龄人': '同族/同类',
  '在场': '在这里发生',
  '贴在': '贴在',
  '挂出来': '板上挂着',
  '接取': '从这儿接活',
  '委托': '这一档的活',
  '怎么判': '怎么判',
  '判出': '可能判出',
  '能接的活': '这里有活可接',
});

/** 数值位的人话。 */
export const NUMBER_LABEL = Object.freeze({
  kcal: '热量(吃下去涨多少饱食)',
  price: '卖价',
  ttlMs: '能放多久(贮藏)',
  boredomAfter: '连着吃几顿会腻',
  mood: '看着它心情涨多少',
});

/** 人在世界里的身份(手写的"谁在她身边"用得上;运行时的真人一律 `acquaintance`)。 */
export const PERSON_KINDS = Object.freeze(['bot', 'creator', 'companion', 'goddess', 'acquaintance', 'npc']);

// ---------------------------------------------------------------------------
// 物品类别(第一层的成果:加新东西 = 挑类别 + 写差异)
// ---------------------------------------------------------------------------

/**
 * **物品类别**:这一类东西**默认能干什么、动哪些数值、要设计哪些数**。
 *
 * ⚠️ 判据认这个:**物品没有类别 = 硬错**;**类别没有用途 = 硬错**(说不出用途的类别才是真垃圾);
 * 而**个体差异为 0 只是提示**(它现在和同类完全一样 —— 广度推进期完全可以接受)。
 * ⚠️ 1.91.0 起 `stats` 里的名字**必须是图上存在的 `stat` 节点**(数值已经是节点了)。
 */
export const ITEM_CLASSES = Object.freeze({
  food: {
    label: '吃的东西',
    uses: ['eat', 'store', 'sell', 'gift'],
    stats: ['satiety', 'money'],
    numbers: ['kcal', 'price', 'ttlMs'],
    note: '能吃的东西:自己吃 / 收着 / 换钱 / 送人',
  },
  material: {
    label: '材料',
    uses: ['craft', 'store', 'sell'],
    stats: ['money'],
    numbers: ['price'],
    note: '当材料用、也能收着或换钱',
  },
  tool: {
    label: '工具',
    uses: ['use', 'store'],
    stats: [],
    numbers: [],
    note: '拿来用(这一版还没有耐久)',
  },
  decor: {
    label: '装饰',
    uses: ['place'],
    stats: ['mood'],
    numbers: ['mood'],
    decor: true,
    note: '⚠️ 只是好看 —— 用户明说"美术装饰物品除外",这一类**免"必须有用途"**的硬判据',
  },
});

/** 按 id 取类别(取不到给 null —— **不猜**)。 */
export function itemClassOf(id) {
  const key = String(id ?? '').trim();
  return Object.prototype.hasOwnProperty.call(ITEM_CLASSES, key) ? ITEM_CLASSES[key] : null;
}

/**
 * 手写的元素:只写**类别 + 个体差异**。
 * 键名 `item:<名字>`(名字就是账本里的中文名)。
 *
 * ⚠️ 个体差异里 `gifts` = "这件东西能送给**谁**"(1.91.0)。
 *    它写的是**人的 id**,不是人名 —— 名字会改,id 不会。
 */
export const DECLARED_ITEMS = Object.freeze([
  {
    id: 'item:风干鱼',
    label: '风干鱼',
    kind: 'item',
    class: 'food',
    // —— 以下都是**个体差异**(同类里只有它有)——
    uses: ['feed', 'quest'],          // 能投喂她 / 能带进跑团吃
    places: ['home', 'canteen'],
    gifts: ['player:self'],           // ⚠️ 送礼的**接收方** —— 以前 `gift` 是个没有对面的动词
    numbers: { boredomAfter: null },  // 个体特有的数值位:连着吃几顿会腻
    note: '用户点名的那一件:时长 / 营养 / 贮藏库 / 投喂 / 吃腻 / 售卖与赠送 / 带进跑团',
  },
]);

// ---------------------------------------------------------------------------
// 四类连接的**声明**(手写的只有"她认识谁"与"判定档位";其余全派生)
// ---------------------------------------------------------------------------

/**
 * **她认识的人**(手写;**运行时的真人**由 `options.people` 接进来)。
 *
 * ⚠️ `creator` / `companion` / `goddess` 这几位**不在任何库里**:
 *    库里有的人(`player` 表的账号、`affinity:` 那一族的熟人)一律**派生**,
 *    库里没有的**必须写明它是声明的**(`declared: true`)—— 报告里照实分开写。
 * ⚠️ `relations.tag` 是"和她的另一种关系"(家人 / 同类 / 来源),写的也是**人的 id**。
 *    它不替代**好感那条边**:好感(`affinity`)是运行时算出来的,分数**不在这里定**。
 */
export const DECLARED_PEOPLE = Object.freeze(INFRA_CONTENT.declaredPeople);

/**
 * **跑团三件套**的三张手写表(设计声明;1.91.0 只做连接,数值一个都不定)。
 *
 * ① **委托档位** `QUEST_TIERS` —— 看板上贴着的活分几档(权重与报酬在 `economy.js` 的 `TASK_TIERS`);
 * ② **场景卡** `SCENES` —— 她是"在某个场所里发生一段事",卡是场所的**可玩实例**;
 * ③ **判定结果** `QUEST_ROLLS` —— **框架** = 掷**两颗骰子**、按四档读结果(docs\08 3.1 / §七)。
 *    ⚠️ **切点数字一个都没定** —— 那要等"四类齐了再一起定"(用户纪律)。
 */
export const QUEST_TIERS = Object.freeze([
  { id: 'trivial', label: '跑腿小活', note: '送信 / 找猫' },
  { id: 'normal', label: '正经委托', note: '清怪 / 护卫' },
  { id: 'hard', label: '危险委托', note: '差点回不来' },
  { id: 'fiasco', label: '看着就不对劲的活', note: '搞砸了要赔违约金' },
]);

export const SCENES = Object.freeze([
  { id: 'scene:fishing', label: '钓鱼场景卡', place: 'fishing', activity: 'fishing', note: '整条回路(甩竿/选饵/收杆/分档处置)已经在跑' },
  // ⚠️ `questable: true` = **这儿真的有活可接** —— 只有公会能挂委托(D101 的看板在公会)。
  //    别的场景卡不许跟着连一遍,那是"承诺了一个做不到的事"。
  { id: 'scene:guild', label: '公会场景卡', place: 'guild', activity: 'board', questable: true, note: '委托三段闭环的落点(接取 → 过程 → 结算)' },
  { id: 'scene:home', label: '家园场景卡', place: 'home', activity: 'wand', note: '摆放是装饰轴;战斗/探索的小场地以后和它共用同一张网格' },
  { id: 'scene:canteen', label: '食堂场景卡', place: 'canteen', note: '她自己饿了会来吃(那个动作是 `selfcare` 的,没有场景内互动)' },
  // ⚠️ 市集**故意标成"还玩不了"**:它现在只有一句说明,给它一张能玩的卡就是假承诺(TODO 里挂着)。
  { id: 'scene:market', label: '市集场景卡', place: 'market', activity: 'market', playable: false, note: '⚠️ 还没做互动 —— 标 playable:false,别在页面上承诺' },
]);

/** 判定结果四档(**框架**;切点数字等四类齐了再定)。 */
export const QUEST_ROLLS = Object.freeze([
  { id: 'roll:crit_fail', label: '大失败', note: '要落一档后果' },
  { id: 'roll:fail', label: '失败', note: '推进局势、不一定受伤' },
  { id: 'roll:success', label: '成功', note: '默认档' },
  { id: 'roll:crit_success', label: '大成功', note: '额外好处' },
]);

/**
 * **动作 → 效果表里的 kind**(1.91.0)。
 *
 * ⚠️ 为什么需要它:动作名与 `STAT_BINDING` 的键**不是一套**(`quest.accept` 走 `quest`、
 *    `home.put` 走 `panel`、`fishing.settle` 走 `fish`)。这张表是**派生用的别名**,
 *    不是第二份效果表 —— 允许改哪些数**只在 `stat-binding.js` 里**。
 */
export const ACTION_BINDING_KIND = Object.freeze({
  'fishing.settle': 'fish',
  'quest.accept': 'quest',
  'home.put': 'panel',
  'home.take': 'panel',
  // "一起睡觉"走 `sleep` 那条(健康/体力/心情)—— 别的邀约按自己的 id 走 `company:<id>`。
  'company:sleep_together': 'sleep',
});

/** 动作 → **别的表里的效果字段**(拿得出产出物那种;值的含义归那张表)。 */
export const ACTION_EFFECT_FIELDS = Object.freeze({
  'fishing.settle': ['homeItem'],
});

// ---------------------------------------------------------------------------
// 小工具(纯函数)
// ---------------------------------------------------------------------------

function withPrefix(value, prefix) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.includes(':') ? text : `${prefix}:${text}`;
}

/** 边的人话标签:表里有就用表里的,没有就把 key 原样兜出来(**不静默成空**)。 */
function edgeLabelOf(key) {
  return EDGE_LABEL[key] ?? String(key ?? '');
}

function pickName(row) {
  return String(row?.label ?? row?.name ?? row?.nickname ?? row?.account ?? row?.id ?? '（无名）');
}

/** 与 `home.js` 的 `itemKindOf` 同一套口径(这里再写一份是为了**不 import**;口径若有变,两处一起改)。 */
function itemKindOfLocal(key) {
  const name = String(key ?? '').trim();
  if (!name) return 'misc';
  if (name.includes('风干')) return 'dried';
  if (/[鱼虾贝螺蟹]/.test(name)) return 'fish';
  return 'misc';
}

/**
 * 一行**动了哪些数值**(纯函数)。
 *
 * ⚠️ 它只回答"**动哪些**" —— 动多少、正负、上限全归各自的表,这里一个字都不定。
 * 来源有两处:① `bindings[kind].allowed`(模块 × 数值的绑定表);② `extraFields`
 * (拿得出产出物那种,如 `fishing.settle` 的 `homeItem`)。
 * ⚠️ `money` **不在**这里给:钱是另一套刻度(能攒、按小时自己变少),它另有来源。
 */
export function statTargetsFor(kind, { bindings = {}, extraFields = [], validStats = null } = {}) {
  const binding = bindings[String(kind ?? '')] ?? null;
  const allowed = Array.isArray(binding?.allowed) ? binding.allowed : [];
  const known = validStats ? new Set(validStats) : null;
  return [...new Set([...allowed, ...(extraFields ?? [])])]
    // ⚠️ 只认**真的是数值**的名字:绑定表里还混着 `homeItem` 这种"效果字段"
    //    (它是产出物,不是数值)—— 不过滤就会连出一个不存在的 `stat:homeItem`(悬空边)。
    .filter((key) => (known ? known.has(key) : true))
    .filter((key) => key !== 'affinity');
}

/**
 * **对话式互动**那几张表(`stats.js` 的 `INTERACTIONS` / `POTIONS`)的效果字段。
 *
 * ⚠️ 为什么单开一个:`INTERACTIONS` 的键(`praise` / `fed` / `chat` / `intimate` / `explosion` / `rest`)
 *    **不在** `STAT_BINDING` 里(那张表管的是 `applyStory` 那条路),可它们的 `effect` 就是
 *    "这次互动动哪个数"的**声明本身**。只认绑定表的话,这些互动在图里会变成
 *    **一条数值边都没有**的空壳 —— 而"被夸涨心情"正是最基础的一条链。
 * ⚠️ 它**扔掉的正是绑定表规定不许动的那些字段**(`cooldownMs` / `label` 不是数值;
 *    其余按 `validStats` 过滤)—— 所以口径仍然只有一份:`STAT_BINDING`。
 */
export function effectStatsOf(entry, { validStats = null } = {}) {
  const known = validStats ? new Set(validStats) : null;
  // ⚠️ 这几个键**不是效果**:`cooldownMs` 是冷却、`label` 是人话、
  //    `kind` / `id` / `name` 只是这一行的名字(它们由调用方当节点 id 用)。
  const NOT_EFFECTS = new Set(['cooldownMs', 'label', 'kind', 'id', 'name']);
  const fields = entry && typeof entry === 'object' ? Object.entries(entry) : [];
  return fields
    .filter(([key]) => !NOT_EFFECTS.has(key))
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) !== 0)
    .map(([key]) => key)
    .filter((key) => (known ? known.has(key) : true));
}

/** 从动作名取它对应的活动 id(`company:cook` → `cook`;`fishing.settle` → `fishing.settle`)。 */
export function activityIdFromKind(kind) {
  const text = String(kind ?? '');
  return text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
}

/**
 * **这一版(1.91.0)一条数值都没定** —— 这个函数把它变成可判的东西(纯函数)。
 *
 * @returns {Array<{id: string, numbers: object}>} 身上带 `numbers` 的节点(**应该是空的**)
 */
export function nodeNumbers(nodes = []) {
  return (nodes ?? [])
    .filter((node) => node && Object.prototype.hasOwnProperty.call(node, 'numbers'))
    .map((node) => ({ id: node.id, numbers: node.numbers }));
}

// ---------------------------------------------------------------------------
// 建图
// ---------------------------------------------------------------------------

/**
 * 建图(**纯函数**)。
 *
 * @param {object} input
 * @param {Array<{id:string,name:string,kind?:string}>} [input.places] 场所(`world.js` 的 `PLACES`)
 * @param {Array<{id:string,name:string,kinds:string[]}>} [input.furniture] 家具(`home.js` 的 `FURNITURE`)
 * @param {Array<string>} [input.actions] 动作名(`ACTION_KINDS` + `PANEL_ACTION_KINDS`)
 * @param {Array<{id:string,effect?:object}>} [input.handling] 鱼的处置表(`company.js` 的 `FISH_HANDLING`)
 * @param {Array<{id:string,line?:string,place?:string,stat?:string,story?:boolean}>} [input.activities] 她自己的活动(`selfcare.js`)
 * @param {Array<{id:string,label?:string}>} [input.companions] 邀约(`company.js` 的 `COMPANION_ACTIVITIES`)
 * @param {Array<string>} [input.interactions] 互动种类(`stats.js` 的 `INTERACTIONS` 的键)
 * @param {Record<string,{allowed:string[]}>} [input.bindings] 数值×模块绑定表(`stat-binding.js`)
 * @param {Record<string,string[]>} [input.actionEffectFields] 动作 → 别的表里的效果字段(`ACTION_EFFECT_FIELDS`)
 * @param {Record<string,string>} [input.actionBindings] 动作 → 绑定表的键(`ACTION_BINDING_KIND`)
 * @param {Record<string,string>} [input.actionPlaces] 名字里配不出场所的动词 → 显式指定
 * @param {Record<string,string>} [input.actionUses] 动词的**用途**(设计声明,可省)
 * @param {Record<string,{short:string,long:string}>} [input.statSpecs] 数值的名字(主题表 `values`)
 * @param {Array<string>} [input.stats] 数值 key(`STAT_KEYS`)
 * @param {string} [input.money] 钱的名字(默认"钱")
 * @param {Array<object>} [input.people] **运行时的真人**(账号 / 熟人;`src\people.js` 归一化过)
 * @param {Array<object>} [input.persons] 手写的人(默认 `DECLARED_PEOPLE`)
 * @param {Array<object>} [input.questTiers] 委托档位(默认 `QUEST_TIERS`)
 * @param {Array<object>} [input.scenes] 场景卡(默认 `SCENES`)
 * @param {Array<object>} [input.rolls] 判定结果档(默认 `QUEST_ROLLS`)
 * @param {Array<object>} [input.items] 手写声明(默认 `DECLARED_ITEMS`)
 * @param {Record<string,object>} [input.classes] 类别表(默认 `ITEM_CLASSES`)
 */
export function buildElementGraph({
  places = [],
  furniture = [],
  actions = [],
  handling = [],
  activities = [],
  companions = [],
  interactions = [],
  bindings = {},
  actionEffectFields = ACTION_EFFECT_FIELDS,
  actionBindings = ACTION_BINDING_KIND,
  actionPlaces = {},
  actionUses = {},
  statSpecs = {},
  stats = [],
  money = '钱',
  people = [],
  persons = DECLARED_PEOPLE,
  /**
   * **"她世界里的玩家"到底是哪个节点**(1.100.0 / D162)。
   *
   * ⚠️ 这里原来是写死的 `player:self`(一个**声明的占位人**,它的注释写着
   *    "面板账号 / QQ openid / 她世界里的玩家三套身份还没统一,统一那天在这里合并")。
   *    三套身份现在已经由 `src\people.js` 的 `joinPeople` 合并 —— 所以:
   *    · **有真的玩家节点时**(有人绑过 QQ)必须传 `player:<id>`:
   *      否则图上会**同时**出现"真的你"和"占位的你",正是这整条线一直在修的
   *      "同一个人两行"那个毛病;
   *    · **没有时**保持 `player:self`:图里"有一个玩家"这件事仍然是真的
   *      (我们只是还不知道他是哪个 id)。
   */
  playerNodeId = 'player:self',
  questTiers = QUEST_TIERS,
  scenes = SCENES,
  rolls = QUEST_ROLLS,
  items = DECLARED_ITEMS,
  classes = ITEM_CLASSES,
} = {}) {
  const nodes = new Map();
  const inEdges = new Map();
  const add = (node) => {
    const existing = nodes.get(node.id);
    if (existing) {
      // 同一个 id 被加第二遍(比如"她"既是声明的人、又是数值的宿主):
      // **补缺**(只填原来没有的),不覆盖、也不丢已经连上的边。
      for (const [key, value] of Object.entries(node)) {
        if (key === 'edges') continue;
        if (existing[key] === undefined) existing[key] = value;
      }
      return existing;
    }
    nodes.set(node.id, { edges: [], ...node });
    return nodes.get(node.id);
  };
  const link = (from, to, label, extra = {}) => {
    if (!from || !to) return;
    const node = nodes.get(from);
    if (!node) return;
    // ⚠️ **同一条边只画一次**(同一个(来源, 目标, 类型)):两条派生路径算出同一件事时,
    //    重复的边只会让报表变吵,还会让人以为"这里有两个来源"。
    if (node.edges.some((edge) => edge.to === to && edge.label === label)) return;
    node.edges.push({ to, label, ...extra });
    if (!inEdges.has(to)) inEdges.set(to, []);
    inEdges.get(to).push({ from, label, ...extra });
  };

  // =========================================================================
  // 既有层:场所 / 家具 / 动词 / 她自己的活动
  // =========================================================================
  for (const place of places) add({ id: `place:${place.id}`, label: place.name, kind: 'place', placeKind: place.kind ?? null });
  for (const slot of furniture) add({ id: `furniture:${slot.id}`, label: slot.name, kind: 'furniture', accepts: slot.kinds ?? [] });
  for (const kind of actions) add({ id: `action:${kind}`, label: kind, kind: 'action' });

  // ⚠️ **她先落地**(`agent:her`):下面所有"长在她身上"的边(数值 / 关系 / 动作)
  //    都从她出发 —— `link()` 找不到来源节点会**静默丢掉**那条边(这是本文件最阴的坑),
  //    所以主视角必须在最前面 `add()` 一次。
  add({
    id: 'agent:her',
    label: '她',
    kind: 'person',
    personKind: 'bot',
    self: true,
    derived: true,
    note: '世界的主视角:所有人的边最后都落到她身上(面板 / 委托 / 聊天全挂在"人"这件事上)',
  });
  // ⚠️ **看板也要提前落地**:委托那一族动词(`quest.accept` / `quest.step` / `quest.abandon`)
  //    是从它出发的(`link` 找不到来源就静默丢边)—— 与 `agent:her` 同一个坑。
  add({
    id: 'board:guild',
    label: '公会委托看板',
    kind: 'board',
    note: '看板会过期(6 小时)—— 板上贴着的活由 economy.js 按档位权重掷,不看模型脸色',
  });

  // —— ④ 跑团三件套之①:**场景卡**(她是"在某个场所里发生一段事")——
  for (const scene of scenes ?? []) {
    add({
      id: scene.id,
      label: scene.label,
      kind: 'scene',
      playable: scene.playable !== false,
      declared: true,
      note: scene.note ?? null,
    });
    const place = withPrefix(scene.place, 'place');
    if (place && nodes.has(place)) link(scene.id, place, '发生在');
  }

  // —— 动词属于哪个场所:显式表优先;没给的按**动作名前缀**或用**活动表的场所**配 ——
  const activityById = new Map((activities ?? []).map((row) => [String(row.id), row]));
  const actionPlaceFor = (kind) => {
    const explicit = actionPlaces[kind];
    if (explicit) return explicit;
    const byPrefix = places.find((place) => kind.startsWith(`${place.id}.`));
    if (byPrefix) return byPrefix.id;
    const byActivity = activityById.get(activityIdFromKind(kind));
    if (byActivity?.place) return byActivity.place;
    const scene = (scenes ?? []).find((row) => row.activity && (row.activity === kind || row.activity === activityIdFromKind(kind)));
    return scene?.place ?? null;
  };
  for (const kind of actions) {
    const target = actionPlaceFor(kind);
    if (target && places.some((place) => place.id === target)) link(`action:${kind}`, `place:${target}`, '发生在');
    // ⚠️ **移动**不属于某一个场所:它是"从**任意**场所出发"的那一个动词(1.92.0)。
    //    把每个场所都连到它 —— 否则它在图里是孤儿(而它明明连着整个世界的路)。
    if (kind === 'move.to') {
      for (const place of places) link(`place:${place.id}`, `action:${kind}`, '从这儿出发');
    }
    // ⚠️ **委托的过程与结算**(B / 1.93.0):它们发生在"接下这条活的地方"——
    //    也就是**看板**上(`quest.accept` 从看板接,`quest.step` / `quest.abandon` 是那一局的延续)。
    //    连到看板,免得它们在图里是孤儿(而它们明明接着委托那条链)。
    if (String(kind).startsWith('quest.')) link('board:guild', `action:${kind}`, '这一局的延续');
    // 动词的**用途**是设计声明(可省):给了就连,不给就不连(不猜)。
    const use = actionUses[kind];
    if (use) link(`action:${kind}`, `use:${use}`, '用(个体)');
  }

  // —— 她自己会去的地方(1.85 的活动表)——
  for (const act of activities ?? []) {
    const id = `activity:${act.id}`;
    add({ id, label: act.line ?? String(act.id), kind: 'activity' });
    link(id, 'use:report', '用(个体)');
    if (act.place && places.some((place) => place.id === act.place)) link(id, `place:${act.place}`, '发生在');
    // ⚠️ 数值的**唯一来源边**:活动行自己声明"这件事动哪个数"(`selfcare.js`)——
    //    不在这里猜,也不再抄一份效果表。没声明就不连(宁可缺,不许编)。
    if (act.stat) link(id, `stat:${act.stat}`, '动');
  }

  // =========================================================================
  // ② 四条连接之"数值":**stat 变成节点**
  //    ⚠️ 它必须**排在"人"前面**:数值是"长在她身上"的(`agent:her --属于--> stat:*`)——
  //       而 `link()` 在**来源节点不存在**时会静默丢掉那条边,所以 `agent:her` 得先落地
  //       (见下面那句显式 `add`,`link()` 的注释里也写了这个坑)。
  // =========================================================================
  for (const key of stats ?? []) {
    add({
      id: `stat:${key}`,
      label: statSpecs?.[key]?.short ?? String(key),
      kind: 'stat',
      themeLabel: statSpecs?.[key]?.long ?? null,
      statKey: String(key),
      derived: true,
    });
    link('agent:her', `stat:${key}`, '属于');
  }
  add({
    id: 'stat:money',
    label: money,
    kind: 'stat',
    statKey: 'money',
    derived: true,
    note: '钱是另一套刻度(能攒、按小时自己变少,不是 0–100 的感觉)—— 见 stats.js 的 MONEY_*',
  });
  link('agent:her', 'stat:money', '属于');

  // —— 数值的去向:从**绑定表 + 各表的效果字段**派生(不手抄一份效果)——
  const validStats = [...(stats ?? []), 'money'];
  const targetsForAction = (kind) => {
    const bindingKind = actionBindings[kind] ?? String(kind).split(':')[0];
    return statTargetsFor(bindingKind, {
      bindings,
      extraFields: actionEffectFields[kind] ?? [],
      validStats,
    });
  };
  for (const kind of actions) {
    for (const key of targetsForAction(kind)) link(`action:${kind}`, `stat:${key}`, '影响(派生)');
  }
  // 对话式互动(被夸 / 被投喂 / 被戳……):效果表**自己**就是"动哪个数"的声明 ——
  // ⚠️ 这些键不在 `STAT_BINDING` 里,所以不能只查绑定表(那样它们会变成一条数值边都没有的空壳)。
  for (const row of interactions ?? []) {
    const name = typeof row === 'string' ? row : String(row?.kind ?? row?.id ?? row?.name ?? '').trim();
    if (!name) continue;
    const entry = typeof row === 'string' ? null : row;
    add({ id: `interaction:${name}`, label: entry?.label ?? name, kind: 'interaction', declared: false });
    for (const key of effectStatsOf(entry, { validStats })) {
      link(`interaction:${name}`, `stat:${key}`, '影响(派生)');
    }
  }
  // 用户主动的邀约(company):按活动 id 走 `company:<id>` 那条绑定
  for (const row of companions ?? []) {
    const id = `company:${row.id}`;
    add({ id, label: row.label ?? String(row.id), kind: 'company', declared: false });
    const bindingKind = actionBindings[id] ?? `company:${row.id}`;
    for (const key of statTargetsFor(bindingKind, { bindings, validStats })) link(id, `stat:${key}`, '影响(派生)');
  }

  // =========================================================================
  // ① 四条连接之"人":她 + **运行时的真人** + 手写的人
  // =========================================================================
  const personRows = [];
  const seenPerson = new Set();
  const pushPerson = (row) => {
    const id = String(row?.id ?? '').trim();
    if (!id || seenPerson.has(id)) return;
    seenPerson.add(id);
    personRows.push({ ...row, id });
  };
  // ⚠️ **占位的人要让位**(1.100.0 / D162):一旦调用方给了真的玩家节点(`player:<id>`),
  //    那个"她世界里的玩家(占位)"就该**不在图上** —— 否则同一个人在图上两行,
  //    正是这条线一直在修的毛病。没有真节点时它照旧在(图里"有一个玩家"仍然是真的)。
  for (const row of persons ?? []) {
    if (playerNodeId !== 'player:self' && String(row?.id ?? '') === 'player:self') continue;
    pushPerson(row);
  }
  for (const row of people ?? []) pushPerson({ ...row, id: withPrefix(row.id, 'person') });

  for (const row of personRows) {
    if (nodes.has(row.id)) continue;
    add({
      id: row.id,
      label: pickName(row),
      kind: 'person',
      personKind: row.kind ?? (row.self ? 'bot' : 'acquaintance'),
      self: row.self === true,
      virtual: row.virtual === true,
      declared: row.declared === true,
      derived: row.derived === true,
      source: row.source ?? null,
      affinityScore: Number.isFinite(Number(row.affinity?.score ?? row.score))
        ? Number(row.affinity?.score ?? row.score) : null,
      affinityTier: row.affinity?.tierLabel ?? row.tierLabel ?? row.tier ?? null,
      acceptsGifts: row.acceptsGifts !== false,
      note: row.note ?? null,
    });
  }

  // ⚠️ **关系**那一类:好感这条边**只连她与那个人** —— 分数/档位是运行时的派生值,
  //    图里只画边(一条都不定数值)。
  for (const row of personRows) {
    const node = nodes.get(row.id);
    if (!node || node.id === 'agent:her') continue;
    const tier = node.affinityTier ? `（现在：${node.affinityTier}）` : '';
    link('agent:her', node.id, '和她的关系', { labelText: `好感度${tier}` });
    link(node.id, 'agent:her', '他称她', { labelText: '他也认得她' });
    const tagRaw = row.relations?.tag ?? null;
    if (!tagRaw) continue;
    const tagTarget = nodes.has(tagRaw)
      ? tagRaw
      : (String(tagRaw).includes(':') ? String(tagRaw) : `person:${tagRaw}`);
    if (!nodes.has(tagTarget)) continue;
    link(node.id, tagTarget, '同龄人', { labelText: 'Tag' });
    link(tagTarget, node.id, '同龄人', { labelText: 'Tag' });
  }

  // =========================================================================
  // "东西从哪来" —— **从处置表派生**(扫 `effect.homeItem`),别手抄
  // =========================================================================
  for (const row of handling ?? []) {
    const made = row?.effect?.homeItem;
    if (!made) continue;
    add({ id: `item:${made}`, label: String(made), kind: 'item', derived: true });
    link('action:fishing.settle', `item:${made}`, '产出');
  }

  // —— 手写声明:**类别给默认边,个体只补差异** ——
  for (const item of items) {
    const node = add({ id: item.id, label: item.label, kind: item.kind ?? 'item' });
    const cls = item.class ? (Object.prototype.hasOwnProperty.call(classes, item.class) ? classes[item.class] : null) : null;
    node.class = item.class ?? null;
    node.classLabel = cls?.label ?? null;
    node.classUses = cls?.uses ?? [];
    node.classStats = cls?.stats ?? [];
    node.uses = item.uses ?? [];
    node.stats = item.stats ?? [];
    // ⚠️ 送礼的接收方:"她世界里的玩家"**是哪个节点由调用方定**(见 `playerNodeId`)——
    //    写死 `player:self` 的话,绑过 QQ 的人会看到"送给占位的那个人"。
    node.gifts = (item.gifts ?? []).map((id) => (id === 'player:self' ? playerNodeId : id));
    node.decor = cls?.decor === true || item.decor === true;
    node.note = item.note ?? null;
    // 数值位 = 类别要求的 + 个体特有的(值默认 `null` = 还没设计)
    const numbers = {};
    for (const key of cls?.numbers ?? []) numbers[key] = null;
    for (const [key, value] of Object.entries(item.numbers ?? {})) numbers[key] = value;
    node.numbers = numbers;
    node.classNumbers = cls?.numbers ?? [];
    node.ownNumbers = Object.keys(item.numbers ?? {});

    for (const use of node.classUses) link(item.id, `use:${use}`, '用(类别)');
    for (const stat of node.classStats) link(item.id, `stat:${stat}`, '动');
    for (const use of node.uses) link(item.id, `use:${use}`, '用(个体)');
    for (const stat of node.stats) link(item.id, `stat:${stat}`, '动(个体)');
    // ⚠️ 场所要判在不在:最小图(测试里那些 `places: []`)会让这条边悬空。
    for (const place of item.places ?? []) {
      if (nodes.has(`place:${place}`)) link(item.id, `place:${place}`, '出现在');
    }
  }

  // —— 家具收哪几类 → 连到"能摆上去的东西"(双向,免得家具看着像空的)——
  for (const slot of furniture) {
    for (const kind of slot.kinds ?? []) link(`furniture:${slot.id}`, `kind:${kind}`, '收');
  }
  for (const node of nodes.values()) {
    if (node.kind !== 'item') continue;
    for (const slot of furniture) {
      if (!(slot.kinds ?? []).includes(itemKindOfLocal(node.label))) continue;
      link(node.id, `furniture:${slot.id}`, '能摆到');
      link(`furniture:${slot.id}`, node.id, '上面摆着');
    }
  }

  // =========================================================================
  // ③ 四条连接之"关系"的落点:**送礼的接收方**(⚠️ 修"gift 没有接收方")
  // =========================================================================
  for (const node of nodes.values()) {
    if (node.kind !== 'item') continue;
    for (const target of node.gifts ?? []) {
      const targetId = withPrefix(target, 'person');
      if (!targetId || !nodes.has(targetId)) {
        // ⚠️ 认不出的接收方**必须留痕**:只"不连"的话(dangling 也看不见,因为边根本没建)
        //    审计就是一声不响 —— 而"写错一个人的 id"正是这一版要防的那种错。
        node.badGiftTargets = [...(node.badGiftTargets ?? []), String(target)];
        continue;
      }
      link(node.id, targetId, '送礼');
      link(targetId, node.id, '收到');
    }
  }

  // =========================================================================
  // ④ 四条连接之"跑团三件套":委托 / 场景卡 / 判定结果
  // =========================================================================
  const guildPlace = 'place:guild';
  // ⚠️ 看板节点**在文件上面已经先落地**(委托那一族动词要从它出发);这里只补它的边。
  if (nodes.has(guildPlace)) link('board:guild', guildPlace, '贴在');
  // ⚠️ 目标也要判在不在:`actions` 里没有 `quest.accept` 时(测试里的最小图、或哪天它从
  //    白名单里拿掉)这一步会连出一条**悬空边** —— 同一个文件里别处的 link 都判了,这里也判。
  if (nodes.has('action:quest.accept')) link('board:guild', 'action:quest.accept', '接取');

  for (const tier of questTiers ?? []) {
    add({
      id: `quest:${tier.id}`,
      label: tier.label,
      kind: 'quest',
      questTier: tier.id,
      declared: true,
      note: tier.note ?? null,
    });
    link('board:guild', `quest:${tier.id}`, '挂出来');
    if (nodes.has(guildPlace)) link(`quest:${tier.id}`, guildPlace, '属于');
  }

  for (const roll of rolls ?? []) {
    add({
      id: roll.id,
      label: roll.label,
      kind: 'roll',
      // ⚠️ 从输入取(默认 2):以前**硬写 2**,于是输入的 `dice` 被丢掉 →
      //    审计那条"判定档位不是两颗骰子"在真图上永远碰不到(它就成了摆设)。
      dice: Number.isFinite(Number(roll.dice)) ? Number(roll.dice) : 2,
      declared: true,
      note: roll.note ?? null,
    });
    link('board:guild', roll.id, '怎么判');
    for (const tier of questTiers ?? []) link(roll.id, `quest:${tier.id}`, '判出');
  }

  // 场景卡 ← 场所里的活动;有"她自己会去处理的事"的场所 = 那儿有活可接
  const questablePlaces = new Set();
  for (const act of activities ?? []) {
    if (act.story !== true) continue;
    questablePlaces.add(act.place);
    const scene = (scenes ?? []).find((row) => row.activity === act.id);
    if (scene) link(scene.id, `activity:${act.id}`, '在场');
  }
  for (const scene of scenes ?? []) {
    // ⚠️ 只有**显式声明 `questable`** 的场景卡才连委托 —— 别的场景不许跟着连一遍。
    if (scene.questable !== true) continue;
    if (!questablePlaces.has(scene.place)) continue;
    for (const tier of questTiers ?? []) link(scene.id, `quest:${tier.id}`, '能接的活');
    // 这块看板**属于哪张场景卡**:不连的话"板子挂在哪儿"在图上答不出来。
    if (nodes.has('board:guild')) link(scene.id, 'board:guild', '这里的看板');
  }

  const nodesArray = [...nodes.values()];
  const inbound = {};
  for (const [id, rows] of inEdges) inbound[id] = rows;
  return { nodes: nodesArray, classes, inbound };
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/**
 * **审计**(纯函数)。判据分三档:
 *
 * | 档 | 判据 |
 * |---|---|
 * | ❌ 硬错 | 悬空边 / **物品没有类别**(或类别未声明)/ **类别没有任何用途**(装饰类除外)/ 孤儿 / **人一个边都没有** / **判定档位不是"两颗骰子"** / **送礼的接收方认不出来** |
 * | ⚠️ 提示 | **个体差异为 0** / 太薄(总边数 ≤2) / **场景卡还玩不了** |
 * | 📋 待办 | 数值位还是 `null` 的 / **数值没有来源**(没有任何玩法动它) |
 *
 * ⚠️ **"数值没有来源"要排除"属于她"那条边**(1.91.0 复核时抓到的假保证):
 *    每个 `stat` 天生都有一条 `agent:her --属于-->` 的入边,只数入边的话这条判据**恒为空** ——
 *    看着永远绿,而它本该报"这个数值还没有任何玩法动它"。所以只数**真正的流向边**。
 */
export function auditElements(graph = { nodes: [], classes: ITEM_CLASSES }) {
  const nodes = graph.nodes ?? [];
  const classes = graph.classes ?? ITEM_CLASSES;
  const ids = new Set(nodes.map((node) => node.id));
  const byKind = (kind) => nodes.filter((node) => node.kind === kind);
  const dangling = [];
  // 孤儿 = **双向都没有边**(场所/家具/动作常常是"被指向的容器",只看出边会冤枉它们)
  const inDegree = new Map(nodes.map((node) => [node.id, 0]));
  // "真正的流向边"(排除 `属于` 那种"她身上长着这个数"的归属边)
  const flowIn = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) {
    for (const edge of node.edges ?? []) {
      if (inDegree.has(edge.to)) inDegree.set(edge.to, inDegree.get(edge.to) + 1);
      if (flowIn.has(edge.to) && edge.label !== '属于') flowIn.set(edge.to, flowIn.get(edge.to) + 1);
      // 语义槽(`use:` / `kind:`)不是元素,不受这张图的管辖(和 1.89/1.90 同一条口径)
      if (/^(use|kind):/.test(edge.to)) continue;
      if (!ids.has(edge.to)) dangling.push({ from: node.id, to: edge.to, label: edge.label });
    }
  }
  const isolated = (node) => (node.edges ?? []).length === 0 && (inDegree.get(node.id) ?? 0) === 0;
  const items = byKind('item');
  const persons = byKind('person');
  const stats = byKind('stat');
  const classNoUse = Object.entries(classes)
    .filter(([, cls]) => cls?.decor !== true && (cls?.uses ?? []).length === 0)
    .map(([id]) => id);

  return {
    total: nodes.length,
    dangling,
    orphans: nodes.filter(isolated).filter((node) => node.decor !== true).map((node) => node.id),
    decor: nodes.filter((node) => node.decor === true).map((node) => node.id),
    // ❌ 硬错:物品没有类别 / 类别没声明
    noClass: items.filter((node) => !node.class || !Object.prototype.hasOwnProperty.call(classes, node.class)).map((node) => node.id),
    // ❌ 硬错:类别说不出用途(装饰类豁免)
    classNoUse,
    // ❌ 硬错(1.91.0):**人一个边都没有** —— "有人在这个世界里,图里却看不见他"
    lonelyPersons: persons.filter(isolated).map((node) => node.id),
    // ❌ 硬错(1.91.0):判定档位不是"两颗骰子"的框架
    badRolls: byKind('roll').filter((node) => node.dice !== 2).map((node) => node.id),
    // ❌ 硬错(1.91.0 复核补):**送礼的接收方认不出来** —— 边没连上,以前一声不响
    badGiftTargets: items
      .filter((node) => (node.badGiftTargets ?? []).length > 0)
      .map((node) => ({ from: node.id, targets: [...node.badGiftTargets] })),
    // ⚠️ 提示(1.91.0):场景卡还玩不了(不是错 —— 是"别在页面上承诺")
    unplayableScenes: byKind('scene').filter((node) => node.playable === false).map((node) => node.id),
    // 📋 待办(1.91.0):数值**没有任何玩法动它**(⚠️ 排除"属于她"那条归属边,否则恒为空)。
    // ⚠️ 知道这个口径的边界:排除是按**标签字面量**做的 —— 现在只有 `agent:her → stat:*`
    //    用 `属于` 这个标签;哪天别处也复用同一个词,这里要跟着改(别让归属边被当成来源)。
    statNoIn: stats.filter((node) => (flowIn.get(node.id) ?? 0) === 0).map((node) => node.id),
    // ⚠️ 提示:个体差异为 0(它和同类完全一样 —— 可以接受)
    thinIndividual: items.filter((node) => (node.uses ?? []).length === 0 && (node.stats ?? []).length === 0).map((node) => node.id),
    // ⚠️ 提示:边的总数太少(连类别默认边都没展开?)
    thin: items.filter((node) => (node.edges ?? []).length <= 2).map((node) => node.id),
    // 📋 待办:数值还没设计
    unsetNumbers: items
      .filter((node) => Object.values(node.numbers ?? {}).some((value) => value === null))
      .map((node) => node.id),
    items: items.map((node) => node.id),
    persons: persons.map((node) => node.id),
    stats: stats.map((node) => node.id),
    quests: byKind('quest').map((node) => node.id),
    scenes: byKind('scene').map((node) => node.id),
    rolls: byKind('roll').map((node) => node.id),
  };
}
