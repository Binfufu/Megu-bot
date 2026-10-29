/**
 * **元素连接图**的判据(1.90.0 起"**类别**承担连接";1.91.0 起加上**框架四类连接**)。
 *
 * ⚠️ 这里判的是**连接质量与广度**,不是"元素多不多":
 *   ① ❌ 不许有**悬空边**(指向不存在的元素);
 *   ② ❌ 不许有**孤儿**(双向都没有边的元素)—— 装饰要显式标 `decor`;
 *   ③ ❌ **物品必须属于一个有用途的类别**(用户 2026-10-06:连接不能都由个体承担);
 *   ④ ⚠️ **个体差异为 0 只是提示**(和同类完全一样,可以接受);
 *   ⑤ ✅ 处置表里**产出**的东西必须在图里出现(新加 `effect.homeItem` 却忘了登记 → 当场红);
 *   ⑥ ✅ 用户点名的那一件(风干鱼)要有**类别 + 场所 + 用途 + 家具 + 数值位**;
 *   ⑦ ✅(1.91.0)四类连接:**人 / 数值 / 关系 / 跑团三件套**都在图里,而且**一条数值都没定**。
 */
import { ACTION_KINDS } from '../src/play/action.js';
import { affinityTier } from '../src/affinity.js';
import { COMPANION_ACTIVITIES, FISH_HANDLING } from '../src/company.js';
import { PANEL_ACTION_KINDS } from '../src/panel-actions.js';
import { FURNITURE } from '../src/home.js';
import { PLACES } from '../src/world.js';
import { LIFE_ACTIVITIES } from '../src/selfcare.js';
import { INTERACTIONS, STAT_KEYS } from '../src/stats.js';
import { STAT_BINDING } from '../src/stat-binding.js';
import { MEGUMIN_BODY } from '../src/body-theme.js';
import { PEOPLE_FIXTURE, buildPeopleFixture } from './selftest-people.js';
import {
  ACTION_BINDING_KIND, ACTION_EFFECT_FIELDS, DECLARED_ITEMS, DECLARED_PEOPLE, ITEM_CLASSES,
  QUEST_ROLLS, QUEST_TIERS, SCENES, USE_LABEL,
  auditElements, buildElementGraph, nodeNumbers,
} from '../src/elements.js';
import { describePerson, nameIsInvisible, peopleFromAccounts, peopleFromAffinities } from '../src/people.js';

const WIRING = {
  places: PLACES,
  furniture: FURNITURE,
  handling: FISH_HANDLING,
  activities: LIFE_ACTIVITIES,
  companions: COMPANION_ACTIVITIES,
  // ⚠️ 互动那几行的键不在 `STAT_BINDING` 里 —— 把整行带 `kind` 一起传(建图只读它的效果字段)。
  interactions: Object.entries(INTERACTIONS).map(([kind, row]) => ({ kind, ...row })),
  bindings: STAT_BINDING,
  actionBindings: ACTION_BINDING_KIND,
  actionEffectFields: ACTION_EFFECT_FIELDS,
  actions: [...Object.keys(ACTION_KINDS), ...PANEL_ACTION_KINDS],
  actionPlaces: { 'quest.accept': 'guild', 'home.put': 'home', 'home.take': 'home' },
  actionUses: { 'fishing.settle': 'eat', 'quest.accept': 'quest' },
  statSpecs: MEGUMIN_BODY.values,
  stats: STAT_KEYS,
  money: '厄里斯',
  persons: DECLARED_PEOPLE,
  questTiers: QUEST_TIERS,
  scenes: SCENES,
  rolls: QUEST_ROLLS,
};

/** 带**运行时的人**的那份图(账号 + 熟人)—— 四类连接里"人"那一类的真实形状。 */
const LIVE_WIRING = { ...WIRING, people: buildPeopleFixture() };
const LIVE_GRAPH = buildElementGraph(LIVE_WIRING);

const edgesOf = (graph, id) => (graph.nodes.find((node) => node.id === id)?.edges ?? []);
const edgeLabels = (graph, id) => edgesOf(graph, id).map((edge) => edge.label);
const edgeTargets = (graph, id) => edgesOf(graph, id).map((edge) => edge.to);
const hasEdge = (graph, from, to) => edgeTargets(graph, from).includes(to);
const findByKind = (graph, kind) => graph.nodes.filter((node) => node.kind === kind);

export function registerElementTests({ test, assert }) {
  const graph = buildElementGraph(WIRING);
  const report = auditElements(graph);
  const ids = new Set(graph.nodes.map((node) => node.id));

  test('元素连接图(D146):没有悬空边、没有孤儿、**每件东西都落在有用途的类别里**', () => {
    assert.deepEqual(report.dangling, [], `悬空边:${report.dangling.map((row) => `${row.from}→${row.to}`).join('，')}`);
    assert.deepEqual(report.orphans, [], `孤儿:${report.orphans.join('，')}`);
    assert.deepEqual(report.noClass, [], `这些物品没有类别(或类别没声明):${report.noClass.join('，')}`);
    assert.deepEqual(report.classNoUse, [], `这些类别说不出用途:${report.classNoUse.join('，')}`);
    // 场所 / 家具 / 动作 都在图里(免得"图是空的"也算通过)
    for (const place of PLACES) assert.ok(ids.has(`place:${place.id}`), `场所 ${place.id} 要在图里`);
    for (const slot of FURNITURE) assert.ok(ids.has(`furniture:${slot.id}`), `家具 ${slot.id} 要在图里`);
    assert.ok(graph.nodes.some((node) => node.kind === 'action'), '动词也要在图里');
    // 类别表本身要有规矩:每个类别要么有用途,要么显式标 decor
    for (const [id, cls] of Object.entries(ITEM_CLASSES)) {
      assert.ok(cls.label, `类别 ${id} 要有中文名`);
      assert.ok((cls.uses ?? []).length > 0 || cls.decor === true, `类别 ${id} 要么有用途,要么是装饰`);
    }
  });

  test('元素连接图(D146):**加一件新东西只要挑类别 + 写差异** —— 类别默认边自动展开', () => {
    // 这是 1.90.0 存在的理由(用户:"连接又不能太多,不然广度推不动"):
    // 一件新物品**只声明类别**,不写任何用途,也应该自动拿到"能吃/能存/能卖/能送"这些边。
    const extra = buildElementGraph({
      ...WIRING,
      items: [...DECLARED_ITEMS, { id: 'item:烤肉', label: '烤肉', kind: 'item', class: 'food' }],
    });
    const bbq = extra.nodes.find((node) => node.id === 'item:烤肉');
    assert.ok(bbq, '新物品要在图里');
    const classUses = (bbq.edges ?? []).filter((edge) => edge.label === '用(类别)').map((edge) => edge.to.slice(4));
    assert.ok(classUses.length >= 4, `类别默认边要自动展开(现在 ${classUses.length} 条)`);
    assert.ok(classUses.includes('eat') && classUses.includes('sell'), '吃/卖这类同类的默认用途要自动有');
    assert.deepEqual(bbq.uses, [], '它自己一条差异都没写 —— 这完全合法(个体差异为 0 只是提示)');
    assert.ok(auditElements(extra).thinIndividual.includes('item:烤肉'), '和同类完全一样的,进"提示"清单,但不报错');

    // 反例:类别没声明 → 硬错(所以"新加物品忘了选类别"会被抓住)
    const orphanClass = buildElementGraph({
      ...WIRING,
      items: [{ id: 'item:来路不明', label: '来路不明', kind: 'item', class: '不存在的类别' }],
    });
    assert.ok(auditElements(orphanClass).noClass.includes('item:来路不明'), '类别认不出来就该报错');
  });

  test('元素连接图(D146):处置表产出什么,图里就得有什么;风干鱼要有类别/场所/用途/家具/数值位', () => {
    for (const row of FISH_HANDLING) {
      const made = row?.effect?.homeItem;
      if (!made) continue;
      assert.ok(ids.has(`item:${made}`), `处置表会产出「${made}」,但它不在元素图里 —— 去 src\\elements.js 登记`);
    }
    const dried = graph.nodes.find((node) => node.id === 'item:风干鱼');
    assert.ok(dried, '风干鱼要在图里');
    assert.equal(dried.class, 'food', '它是吃的东西');
    const outs = (dried.edges ?? []).map((edge) => edge.to);
    assert.ok(outs.filter((id) => id.startsWith('place:')).length >= 1, '要说清它出现在哪些场景');
    const uses = (dried.edges ?? []).filter((edge) => edge.to.startsWith('use:')).map((edge) => edge.to.slice(4));
    assert.ok(uses.length >= 5, `用途要够(类别 + 个体,现在 ${uses.length} 条)`);
    for (const use of uses) assert.ok(USE_LABEL[use], `用途 ${use} 要有中文说法(报告与页面共用)`);
    assert.ok((dried.uses ?? []).length >= 1, '它至少要有**一条个体差异**(不然它和同类没有任何区别)');
    assert.ok(outs.some((id) => id.startsWith('furniture:')), '它得能摆到某个家具上(1.88 那条)');
    assert.ok(dried.numbers && Object.keys(dried.numbers).length >= 4, '时长/营养/贮藏/吃腻这些数值位要留出来');
    assert.ok(report.unsetNumbers.includes('item:风干鱼'), '还没设计的数值要进 unsetNumbers 清单(这份清单就是待办)');
    for (const item of DECLARED_ITEMS) assert.ok(item.label && item.class, `${item.id} 要写 label 与 class`);
  });

  // =========================================================================
  // ⑦ 1.91.0 / D147:**框架四类连接**
  // =========================================================================

  test('四类连接(D147)①人:**她 + 库里的真人**都在图里,而且人人都有边(不许有人在图里却看不见)', () => {
    const live = auditElements(LIVE_GRAPH);
    assert.deepEqual(live.lonelyPersons, [], `这些人在图里但一条边都没有:${live.lonelyPersons.join('，')}`);
    // 平的那份(没有人进图)也必须成立:她与她的同伴本身就在图里
    assert.deepEqual(report.lonelyPersons, [], `平的那份也有孤立的人:${report.lonelyPersons.join('，')}`);
    assert.ok(ids.has('agent:her'), '她是图的主视角,必须在');
    for (const person of DECLARED_PEOPLE) assert.ok(ids.has(person.id), `声明的人 ${person.id} 要在图里`);

    // **运行时的真人**(面板账号 + QQ 熟人)必须接得进来 —— 这是"人不只是声明"的判据
    const liveIds = new Set(LIVE_GRAPH.nodes.map((node) => node.id));
    for (const row of buildPeopleFixture()) {
      assert.ok(liveIds.has(row.id), `${row.id}(${row.label})没进图 —— 人那一类连接就不能算接上了`);
    }
    // 每一位熟人/玩家都有一条"和她的关系"边(好感那条),而**分数不进图**
    for (const row of buildPeopleFixture().map((person) => person.id)) {
      assert.ok(hasEdge(LIVE_GRAPH, 'agent:her', row), `${row} 要有"和她的关系"那条边`);
      assert.ok(hasEdge(LIVE_GRAPH, row, 'agent:her'), '关系是双向的(他也认得她)');
    }
    // 档位**派生**出来了,分数只作为内部字段
    const friend = LIVE_GRAPH.nodes.find((node) => node.id === 'person:OPENID_B');
    assert.equal(friend.affinityTier, '朋友', '好感档位要用 affinityTier 现算出来');
    assert.equal(friend.affinityScore, PEOPLE_FIXTURE.affinities[1].score, '分数只进图当内部字段');
  });

  test('四类连接(D147)②数值:**stat 变成节点**,而且每个数值都说得出来源(入边)', () => {
    for (const key of [...STAT_KEYS, 'money']) {
      assert.ok(ids.has(`stat:${key}`), `数值 ${key} 要是一个节点`);
    }
    assert.equal(findByKind(graph, 'stat').length, STAT_KEYS.length + 1, '六个感觉刻度 + 钱');
    // 她身上长着这些数 —— 这一步让"谁涨谁跌"有了主语
    for (const key of [...STAT_KEYS, 'money']) {
      assert.ok(hasEdge(graph, 'agent:her', `stat:${key}`), `${key} 要连在"她"身上`);
    }
    // 📋 "数值没有来源"= 还没有玩法动它 —— 这一版必须**空**
    //    (它的这条判据会随玩法长大:以后新加的数值如果没人动,就会出现在这里)
    assert.deepEqual(report.statNoIn, [], `这些数值还没有任何来源:${report.statNoIn.join('，')}`);
    // ⚠️ 这条判据**必须真的会报**(1.91.0 复核抓到的假保证:每个 stat 天生都有
    //    `agent:her --属于-->` 那条入边,只数入边的话它**恒为空**、永远绿)。
    //    造一个"没有来源的数值"来钉它:只留 `stats:['mood']`,别的来源模块全关。
    const noSource = buildElementGraph({
      stats: ['mood'], places: [], furniture: [], activities: [], companions: [],
      actions: [], interactions: [], handling: [], items: [], scenes: [], rolls: [], questTiers: [],
    });
    assert.deepEqual(auditElements(noSource).statNoIn.slice().sort(), ['stat:money', 'stat:mood'].sort(),
      '没有任何玩法动的数值必须进"缺来源"清单(否则这条判据是摆设)');
    assert.deepEqual(nodeNumbers(noSource.nodes), [], '最小图里也没有数值槽');
    // 来源边是**从表派生的**:钓鱼换钱(STAT_BINDING.fish)、接委托给钱与体力
    assert.ok(hasEdge(graph, 'action:fishing.settle', 'stat:money'), '钓鱼换的是钱(绑定表 fish 那条)');
    assert.ok(hasEdge(graph, 'action:quest.accept', 'stat:money'), '接委托给钱');
    assert.ok(hasEdge(graph, 'action:quest.accept', 'stat:stamina'), '接委托花体力');
    assert.ok(hasEdge(graph, 'activity:board', 'stat:mood'), '她去看板那件事动的是心情(selfcare 那一行的声明)');
    assert.ok(hasEdge(graph, 'company:sleep_together', 'stat:health'), '一起睡觉回血(绑定表 sleep 那条)');
    // ⚠️ 反例:绑定表里混着 `homeItem` 这种"效果字段",它**不是数值** —— 不许连出 stat:homeItem
    assert.ok(!ids.has('stat:homeItem'), 'homeItem 是产出物,不是数值');
    assert.deepEqual(report.dangling.filter((row) => row.to.startsWith('stat:')), [], '不许有指向不存在数值的边');
    // 对话式互动也在图里,而且连得上数值 ——
    // ⚠️ 它们的键(`praise` / `fed` / …)**不在** `STAT_BINDING` 里(那张表管 `applyStory` 那条路),
    //    所以这条判据钉的是"别只查绑定表,否则互动会变成一条数值边都没有的空壳"。
    assert.ok(ids.has('interaction:praise'), '"被夸"要是一个元素');
    assert.ok(hasEdge(graph, 'interaction:praise', 'stat:mood'), '被夸涨心情(效果表自己声明的)');
    assert.ok(hasEdge(graph, 'interaction:chat', 'stat:mana'), '被搭话回魔力');
    assert.ok(hasEdge(graph, 'interaction:chat', 'stat:stamina'), '说话耗体力');
    assert.ok(hasEdge(graph, 'interaction:explosion', 'stat:mana'), '放爆裂魔法掉魔力');
    assert.ok(!hasEdge(graph, 'interaction:chat', 'stat:money'), '没声明的数值不许连(冷却与 label 也不是数值)');
  });

  test('四类连接(D147)③关系:**送礼有接收方**了 —— gift 不再是一个"没有对面的动词"', () => {
    const dried = graph.nodes.find((node) => node.id === 'item:风干鱼');
    assert.ok(hasEdge(graph, 'item:风干鱼', 'player:self'), '能送人 = 要说得清送给谁(接收方)');
    assert.ok(hasEdge(graph, 'player:self', 'item:风干鱼'), '接收方那边也要看得见(双向)');
    assert.ok((dried.gifts ?? []).length >= 1, '个体声明里要写出接收方,不然这条边是猜的');
    // 接收方**必须真的在图里** —— 写错 id 会被悬空边抓住
    for (const target of dried.gifts) {
      assert.ok(ids.has(target), `风干鱼的送礼对象 ${target} 不在图里`);
    }
  });

  test('三套身份(D162):**"她世界里的玩家"要让位给真的那个玩家** —— 图上不许同一个人两行', () => {
    const base = { places: PLACES, items: DECLARED_ITEMS, classes: ITEM_CLASSES };
    const byId = (g, id) => g.nodes.find((row) => row.id === id) ?? null;

    // ① 没人绑过 QQ → **占位**还在(图里"有一个玩家"这件事仍然是真的)
    const placeholder = buildElementGraph(base);
    assert.ok(byId(placeholder, 'player:self'), '没有真玩家节点时,占位的那个照旧在');
    assert.ok(hasEdge(placeholder, 'item:风干鱼', 'player:self'), '风干鱼的接收方指向占位');

    // ② 有人绑过 QQ(`playerNodeId` 给了真的 id)→ **占位必须让位**:
    //    否则图上会同时有"真的你"和"占位的你",正是这条线一直在修的"同一个人两行"。
    const real = buildElementGraph({
      ...base,
      playerNodeId: 'player:7',
      people: [{ id: 'player:7', label: '惠惠的队友', kind: 'acquaintance', source: 'account', linked: true }],
    });
    assert.equal(byId(real, 'player:self'), null, '真节点进来了,占位那个就该不在图上');
    const me = byId(real, 'player:7');
    assert.ok(me, '真的玩家节点要在图上');
    assert.equal(me.note ?? null, null, '（没有额外 note —— 它是个真节点,不是声明）');
    // ⚠️ **送礼的接收方要跟着换**:不然会出现"送给占位的那个人"
    assert.ok(hasEdge(real, 'item:风干鱼', 'player:7'), '风干鱼的接收方 = 真的玩家');
    // ③ 双向仍在(收礼那一侧看得见)
    assert.ok(hasEdge(real, 'player:7', 'item:风干鱼') || (byId(real, 'player:7')?.edges ?? []).some((e) => e.to === 'item:风干鱼'),
      '接收方那边也要看得见');
    // ④ 她与玩家的那条边也落在真节点上
    assert.ok(hasEdge(real, 'agent:her', 'player:7'), '她和"你"的关系边要落在真的那个节点上');
  });

  test('四类连接(D147)③关系(续):运行时真人也能收礼,认不出的收礼人**审计要报**', () => {
    // 面板账号也能收礼(真人进图以后,送礼那条边照样连得上)
    const live = buildElementGraph({ ...LIVE_WIRING, items: [{ id: 'item:糖', label: '糖', kind: 'item', class: 'food', gifts: ['player:1'] }] });
    assert.ok(hasEdge(live, 'item:糖', 'player:1'), '运行时的真人也是接收方');
    assert.ok(hasEdge(live, 'player:1', 'item:糖'), '双向');
    // ⚠️ 写一个**不存在**的接收方 → 边不连,而且**审计必须报出来**
    //    (以前只"不连"就完了:悬空边也看不见,因为边根本没建 —— 审计一声不响)
    const broken = buildElementGraph({ ...WIRING, items: [{ id: 'item:糖', label: '糖', kind: 'item', class: 'food', gifts: ['player:查无此人'] }] });
    assert.ok(!hasEdge(broken, 'item:糖', 'player:查无此人'), '认不出来的人不许连');
    assert.deepEqual(auditElements(broken).badGiftTargets,
      [{ from: 'item:糖', targets: ['player:查无此人'] }], '认不出的收礼人必须报出来');
    // 正常那份图里没有认不出的收礼人
    assert.deepEqual(report.badGiftTargets, [], '正常那份图里收礼人都认得出');
  });

  test('四类连接(D147)④跑团三件套:委托 / 场景卡 / 判定结果都在图里,而且**判定是两颗骰子**', () => {
    assert.ok(ids.has('board:guild'), '公会看板要在图里(委托的落点)');
    for (const tier of QUEST_TIERS) {
      assert.ok(ids.has(`quest:${tier.id}`), `委托档位 ${tier.id} 要在图里`);
      assert.ok(hasEdge(graph, 'board:guild', `quest:${tier.id}`), '看板上挂着这一档的活');
    }
    for (const scene of SCENES) {
      assert.ok(ids.has(scene.id), `场景卡 ${scene.id} 要在图里`);
      assert.ok(hasEdge(graph, scene.id, `place:${scene.place}`), '场景卡要贴着一个场所(不然它是悬在空中的)');
    }
    assert.equal(findByKind(graph, 'roll').length, QUEST_ROLLS.length, '判定结果四档都在');
    assert.deepEqual(report.badRolls, [], `判定档位不是"两颗骰子":${report.badRolls.join('，')}`);
    for (const roll of QUEST_ROLLS) {
      assert.ok(hasEdge(graph, 'board:guild', roll.id), '看板要说得清"怎么判"');
      assert.equal(edgesOf(graph, roll.id).length, QUEST_TIERS.length, '每一档委托都要说得出它可能判成什么');
    }
    // 只有**能接活的**场景卡才连委托(别的场景跟着连一遍 = 承诺了做不到的事)
    assert.ok(hasEdge(graph, 'scene:guild', 'quest:trivial'), '公会有活可接');
    assert.ok(!hasEdge(graph, 'scene:home', 'quest:trivial'), '家园不接活');
    // ⚠️ 还玩不了的场景要**显式**标出来(别在页面上承诺)
    assert.deepEqual(report.unplayableScenes, ['scene:market'], '市集那张卡现在只能逛,不能玩');
  });

  test('四类连接(D147)纪律:**只做连接、不定数值** —— 新节点一个数值槽都没有', () => {
    // 用户 2026-10-06 的纪律:数值等四类齐了再一起定。这条在代码里是机械保证的:
    // 数值槽(`numbers`)只长在**物品**上(而且默认 null),别的人 / 数值 / 跑团节点一个都不许有。
    const withNumbers = nodeNumbers(graph.nodes).map((row) => row.id);
    assert.deepEqual(withNumbers, ['item:风干鱼'], `带数值槽的节点:${withNumbers.join('，')}`);
    const dried = graph.nodes.find((node) => node.id === 'item:风干鱼');
    assert.ok(Object.values(dried.numbers).every((value) => value === null), '数值**一个都没定** —— 全是问号');
    assert.deepEqual(report.unsetNumbers, ['item:风干鱼'], '没定的数值要进待办清单');
    // 判定档位也只有"掷两颗骰子"这个**框架**,没有难度值 / 切点
    for (const roll of findByKind(graph, 'roll')) {
      assert.equal(roll.dice, 2, '框架是两颗骰子(docs\\08 3.1)');
      assert.ok(!('dc' in roll) && !('cut' in roll), '切点 / 难度值**还没定**,不许先写一个上去');
    }
  });

  test('四类连接(D147)接缝:`src\\people.js` 把两个来源的人归一化,而且**不猜**', () => {
    const accounts = peopleFromAccounts(PEOPLE_FIXTURE.accounts);
    assert.equal(accounts.length, 2, '两个账号进来(没有 id 的那行被跳过)');
    assert.equal(accounts[0].id, 'player:1');
    assert.equal(accounts[0].label, '防火门', '有昵称就用昵称');
    assert.equal(accounts[0].source, 'account');
    assert.equal(accounts[1].acceptsGifts, false, '停用的账号还在图里,但不收礼');
    assert.ok(accounts.every((row) => row.id !== 'player:undefined'), '不许拿"没有 id"猜一个 id');

    const affinities = peopleFromAffinities(
      PEOPLE_FIXTURE.affinities.map((row) => ({ key: `affinity:${row.openid}`, value: JSON.stringify(row) })),
      { affinityTier },
    );
    assert.equal(affinities.length, 2, '两个熟人');
    assert.equal(affinities[0].id, 'person:OPENID_A', 'id 用 openid(名字是显示用的,会重复)');
    assert.equal(affinities[0].affinity.tierLabel, '眼熟', '档位是现算的');
    // ⚠️ 落盘的值里没有 id 时,从 **meta 键的尾巴**取 —— 不许拿名字当 id
    const keyed = peopleFromAffinities([{ key: 'affinity:OPENID_C', value: JSON.stringify({ name: '某人', score: 3 }) }], { affinityTier });
    assert.equal(keyed[0].id, 'person:OPENID_C');
    assert.equal(keyed[0].label, '某人');
    assert.equal(keyed[0].affinity.tierLabel, '眼熟', '档位是现算的');
    // 名字是"不可见字符"时如实留空,不编一个
    const invisible = peopleFromAffinities([{ key: 'affinity:OPENID_D', value: JSON.stringify({ name: '\u200b\u200b', score: 0 }) }]);
    assert.equal(invisible[0].label, '（QQ 上的熟人）');
    // ⚠️ 库里真有这种昵称:整条是**空白/不可见字符**(`ㅤ` 那种)—— 报表上不许留一行空白。
    //    口径与 `panel.js` 的 `displayNameOr` **同一套**(空白 + 零宽 + 韩文填充符)。
    assert.ok(nameIsInvisible('\u3164'), 'ㅤ 算不可见');
    assert.ok(nameIsInvisible(' \u3000\t'), '空白算不可见');
    assert.ok(!nameIsInvisible('小明'), '正常的名字一个字都不动');
    assert.ok(!nameIsInvisible(' 小明 '), '两边有空白但中间有字 → 可见');
    const blank = peopleFromAffinities([{ key: 'affinity:OPENID_E', value: JSON.stringify({ name: '\u3164', score: 0 }) }]);
    assert.equal(blank[0].label, '（QQ 上的熟人）', '整条不可见的昵称要退回"（QQ 上的熟人）"');
    const blankAccount = peopleFromAccounts([{ id: 3, account: 'carol', nickname: '\u3164\u3164' }]);
    assert.equal(blankAccount[0].label, 'carol', '整条不可见的昵称要退回账号(不编名字)');
    // 坏 JSON / 没键的行**跳过**,不抛也不猜
    assert.deepEqual(peopleFromAffinities([{ key: 'affinity:X', value: '{坏' }], { affinityTier }).length, 1, '坏值退化成"只认 id"');
    assert.deepEqual(peopleFromAffinities([{ key: '其他键', value: '{}' }]), []);
    assert.equal(describePerson({ id: 'person:X', label: '小明', kind: 'acquaintance', source: 'affinity', affinity: { tierLabel: '朋友' } }), '小明 · 熟人 · QQ 熟人 · 朋友');
  });

  test('四类连接(D147)审计:人一个边都没有 / 判定档位不对 —— 都会红', () => {
    // 反例一:一个**没有任何边**的人必须进 lonelyPersons(硬错)。
    // ⚠️ 这一条只能用手搭的图来判:真建图器**保证**每个声明的人都有那条好感边
    //    (所以"孤立的人"在正常路径上不可能出现 —— 判据要抓的是"哪天这个保证被改坏了")。
    const lonely = auditElements({
      nodes: [
        { id: 'agent:her', kind: 'person', self: true, edges: [{ to: 'stat:mood', label: '属于' }] },
        { id: 'person:没人理', kind: 'person', edges: [] },
      ],
      classes: ITEM_CLASSES,
    });
    assert.deepEqual(lonely.lonelyPersons, ['person:没人理'], '没有人边的人要被抓住');
    // 有关系的分支**不许**误报(她是主视角,数值长在她身上)
    assert.deepEqual(report.lonelyPersons, [], '正常那份图里不该有人是孤立的');
    // ⚠️ 而**真建图器**那条保证也要单测钉住:声明的人一个都不会孤立
    const lonelyGraph = buildElementGraph({
      persons: [{ id: 'person:没人理', label: '没人理', kind: 'acquaintance' }],
      items: [], scenes: [], rolls: [], questTiers: [], furniture: [], stats: [], places: [],
      activities: [], companions: [], actions: [], handling: [],
    });
    assert.deepEqual(auditElements(lonelyGraph).lonelyPersons, [],
      '真建图器里每个人都该有边(她那样也会连上)');
    // 反例二:判定档位不是两颗骰子 → 硬错
    const badRoll = auditElements({
      nodes: [
        { id: 'roll:x', kind: 'roll', dice: 1, edges: [] },
        { id: 'agent:her', kind: 'person', self: true, edges: [{ to: 'stat:mood', label: '属于' }] },
      ],
      classes: ITEM_CLASSES,
    });
    assert.deepEqual(badRoll.badRolls, ['roll:x'], '判定框架不对要被抓住');
    // 反例三:悬空边仍然会被抓(1.89 的口径没松)
    const dangling = auditElements({
      nodes: [{ id: 'a', kind: 'item', class: 'food', edges: [{ to: 'item:不存在', label: '产出' }] }],
      classes: ITEM_CLASSES,
    });
    assert.equal(dangling.dangling.length, 1);
    // 反例四(1.91.0 复核补):**最小图不许留下悬空边**。
    // ⚠️ 以前 `board:guild → action:quest.accept` 与"物品 → 场所"两条边**没判目标在不在**,
    //    于是把 actions / places 清空就会连出悬空边 —— 而 selftest 自己的最小图正带着它,
    //    只有 `lonelyPersons` 那条断言,所以一直绿。这条判据把"最小图也要干净"钉住。
    const minimal = buildElementGraph({
      persons: [{ id: 'person:没人理', label: '没人理', kind: 'acquaintance' }],
      items: [], scenes: [], rolls: [], questTiers: [], furniture: [], stats: [], places: [],
      activities: [], companions: [], actions: [], handling: [],
    });
    assert.deepEqual(auditElements(minimal).dangling, [], '最小图里也不许有悬空边(目标不存在就别连)');
    assert.deepEqual(auditElements(minimal).lonelyPersons, [], '最小图里的人也要有边');
    for (const id of ['agent:her', 'board:guild', 'person:没人理']) {
      assert.ok(minimal.nodes.some((node) => node.id === id), `最小图也要立得住:${id} 在`);
    }
    // ⚠️ 顺带钉住"看板可以是个空壳"这件事:在**最小图**里(连场所 / 动作 / 判定档都没有),
    //    看板确实一条边都没有 —— 它会被 orphans 报出来,那是**对的**
    //    (别给它加一条假边来糊弄判据)。⚠️ 只清 `questTiers` 不算孤立的:那时它还有
    //    "贴在 / 接取 / 怎么判"几条出边(见 `minimalWithBoard` 那条)。
    assert.deepEqual(auditElements(minimal).orphans, ['board:guild'],
      '最小图里看板确实是个空壳(如实报出来,不糊弄)');
    const noTiers = buildElementGraph({ ...WIRING, questTiers: [] });
    assert.ok(!auditElements(noTiers).orphans.includes('board:guild'),
      '只清空委托档位时看板**不是**孤立 —— 它还有"贴在 / 接取 / 怎么判"那几条边');
    // 反例五(1.91.0 复核补):判定档位的 `dice` 从**输入**取 —— 硬写 2 会让 badRolls 永远碰不到
    const oneDie = buildElementGraph({ ...WIRING, rolls: [{ id: 'roll:一颗骰子', label: '一颗骰子', dice: 1 }] });
    assert.ok(auditElements(oneDie).badRolls.includes('roll:一颗骰子'), '输入说一颗骰子,审计就要报');
  });
}
