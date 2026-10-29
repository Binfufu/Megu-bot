/**
 * **钓鱼适配器(D108)的用例** —— 这一批要补的是 D106 第三节点名的那笔账:
 *
 * > 1.65.0 的两处真回归(**先落盘再问模型**、自动收杆丢了一条消息)**都在适配器里**,
 * > 而当时它是 `main()` 里的闭包 —— 单测碰不到,是靠复核者逐行读 diff 抓到的。
 *
 * 所以这里用**假端口**(假 store / 假 send / 假 flavor)把那一层的行为钉住:
 *   ① **调用顺序**:收杆与结算都必须"先落盘、再问模型";
 *   ② **发几条、什么顺序**:自动收杆要发"台词 + 事实"一整段(不是只有账目);
 *   ③ 空鱼篓收杆那一条**代码写死**、**不许**去问模型(白等一次);
 *   ④ 落账走**绑定表**能认的 kind(meal/fish/home)且 `detail` 带得全;
 *   ⑤ `handleMessage` 的三条口径:该拦的拦、**不该拦的原样放过去**、已经在钓就别重复开局;
 *   ⑥ "带回家"那笔账**看得见**(`home_item`),不再悄悄消失。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_ITEM_KEY, createFishingAdapter, fishingEventKind } from '../src/fishing-adapter.js';
import { SqliteStateStore } from '../src/sqlite-store.js';

/** 假 store:把每一次读写按**时间顺序**记下来 —— 这就是"顺序"那几条判据的唯一尺子。 */
function makeFakeWorld({ meta = {}, statsOk = true } = {}) {
  const trace = [];
  const written = [];
  const store = {
    getMeta(key) { trace.push(`get:${key}`); return meta[key] ?? null; },
    setMeta(key, value) { trace.push(`set:${key}`); meta[key] = value; written.push({ key, value }); },
    listMetaKeys(prefix) {
      trace.push(`list:${prefix}`);
      return Object.keys(meta)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, value: meta[key] }));
    },
    applyStoryResult(effect, now, detail) {
      trace.push(`apply:${detail?.kind ?? '?'}`);
      if (!statsOk) throw new Error('库坏了');
      return { stats: {}, event: { moneyDelta: Number(detail?.moneyDelta) || 0, satietyDelta: 0 } };
    },
  };
  const sent = [];
  const flavors = [];
  return {
    trace, sent, flavors, written, store,
    send: async (message, text) => { trace.push('send'); sent.push(text); },
    flavor: async (kind, ctx) => { trace.push(`flavor:${kind}`); flavors.push({ kind, ctx }); return `《${kind}》`; },
    get lastMeta() { return meta; },
  };
}

const MESSAGE = { scene: 'group', targetId: 'G1', senderId: 'U1', senderName: '和真', content: '', messageId: 'm1' };

/** 一个"鱼篓里有货、正等她选处置"的钓位。 */
const CHOOSING_STATE = {
  phase: 'choosing',
  water: '城东的湖',
  spot: '芦苇丛边',
  baits: [{ id: 'a', label: '蚯蚓' }],
  basket: [
    { tier: 'fish', kind: 'fish', name: '鳟鱼', money: 900 },
    { tier: 'treasure', kind: 'treasure', name: '湖底的秘宝', money: 50_000 },
  ],
  userId: 'U1',
  userName: '和真',
  startedAt: 1000,
  lastTouchAt: 2000,
};

const WAITING_STATE = {
  ...CHOOSING_STATE,
  phase: 'waiting',
  choosingUntil: undefined,
  dueAt: 5000,
  basket: [{ tier: 'fish', kind: 'fish', name: '鳟鱼', money: 900 }],
};

function makeAdapter(world, extra = {}) {
  return createFishingAdapter({
    store: world.store,
    send: world.send,
    flavor: world.flavor,
    config: { appId: 'APP', currency: '厄里斯', sleep: null, ...extra },
    log: { info: () => {}, warn: () => {} },
  });
}

/** 把 key 写进假 store(`fishing:group:G1:U1`)。 */
function withFishing(meta, state) {
  return { ...meta, 'fishing:group:G1:U1': state === null ? '' : JSON.stringify(state) };
}

export function registerFishingAdapterTests({ test, assert }) {
  test('适配器(D108):**先落盘、再问模型** —— 收杆那两条的顺序是判据(1.65.0 的真回归)', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter = makeAdapter(world);
    await adapter.reelIn(MESSAGE, CHOOSING_STATE, {});
    const order = world.trace;
    const writeAt = order.findIndex((row) => row.startsWith('set:fishing:'));
    const flavorAt = order.findIndex((row) => row.startsWith('flavor:'));
    assert.ok(writeAt !== -1, `应当写了钓位：${order.join(' → ')}`);
    assert.ok(flavorAt !== -1, '应当问过模型');
    assert.ok(writeAt < flavorAt, `**必须先落盘再问模型**（现在是 ${order.join(' → ')}）——
      模型那拍最长 40 秒，期间状态必须已经是 choosing，否则人会收到自相矛盾的回复、tick 还会再结算一次`);
    // 落盘之后状态就是 choosing(带处置窗口)—— 不是"等模型回来才变"
    const saved = JSON.parse(world.lastMeta['fishing:group:G1:U1']);
    assert.equal(saved.phase, 'choosing');
    assert.ok(Number.isFinite(saved.choosingUntil), '处置窗口也要落盘');
  });

  test('适配器(D108):**先落盘再问模型** —— 结算同理,而且落的是**清空**', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter = makeAdapter(world);
    await adapter.settle(MESSAGE, CHOOSING_STATE, [{ handling: 'sell', kinds: ['all'] }]);
    const writeAt = world.trace.findIndex((row) => row.startsWith('set:fishing:'));
    const flavorAt = world.trace.findIndex((row) => row.startsWith('flavor:'));
    const applyAt = world.trace.findIndex((row) => row.startsWith('apply:'));
    assert.ok(writeAt !== -1 && flavorAt !== -1 && applyAt !== -1, world.trace.join(' → '));
    assert.ok(writeAt < flavorAt, '落盘要在问模型之前');
    assert.equal(world.lastMeta['fishing:group:G1:U1'], '', '结算完钓位要清掉（空串 = 没有）');
    assert.equal(world.sent.length, 1, '最后发一段台词');
    assert.equal(world.sent[0], '《settle》');
  });

  test('适配器(D108):**自动收杆要发两句** —— 模型那句领起语不许再丢(1.65.0 的真回归)', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, WAITING_STATE) });
    const adapter = makeAdapter(world);
    await adapter.reelIn(MESSAGE, WAITING_STATE, { auto: true });
    assert.deepEqual(world.flavors.map((row) => row.kind), ['reel'], '两种收杆都用 reel 那档提示词(与 1.64.0 一致)');
    assert.equal(world.sent.length, 1, '发一整段');
    const text = world.sent[0];
    assert.ok(text.startsWith('《reel》'), '第一行是模型写的过程/感受');
    assert.ok(text.includes('鱼篓里：鳟鱼（普通的鱼）'), '第二行是代码给的事实');
    assert.ok(text.includes('怎么处理？'));
    assert.ok(text.includes('50900') === false, '这条是单条 900,不该出现别的数');
    assert.ok(text.includes('900'), '数值来自鱼篓');
  });

  test('适配器(D108):空鱼篓收杆**不问模型**,直接说没钓着', async () => {
    const empty = { ...WAITING_STATE, basket: [] };
    const world = makeFakeWorld({ meta: withFishing({}, empty) });
    const adapter = makeAdapter(world);
    await adapter.reelIn(MESSAGE, empty, {});
    assert.deepEqual(world.flavors, [], '空鱼篓不值得为它等一次模型');
    assert.equal(world.sent.length, 1);
    assert.equal(world.sent[0], '杆收上来了——今天什么也没钓着。');
    assert.equal(world.lastMeta['fishing:group:G1:U1'], '', '状态清掉');
    // 自动收杆那一句是另一句(代码写死)
    const world2 = makeFakeWorld({ meta: withFishing({}, empty) });
    await makeAdapter(world2).reelIn(MESSAGE, empty, { auto: true });
    assert.equal(world2.sent[0], '（半天没动静，吾收杆回去了。）');
  });

  test('适配器(D108):落账前的 kind 必须过绑定表 —— 吃=meal / 卖=fish / 留=home', () => {
    // 记错 kind,`applyStory` 会把数值**整个丢掉**(D102 fail closed):吃错成 fish,饱食就没了
    assert.equal(fishingEventKind([{ handling: 'grill', count: 1 }]), 'meal');
    assert.equal(fishingEventKind([{ handling: 'boil', count: 2 }]), 'meal');
    assert.equal(fishingEventKind([{ handling: 'sell', count: 1 }]), 'fish');
    assert.equal(fishingEventKind([{ handling: 'sell_precious', count: 1 }]), 'fish');
    assert.equal(fishingEventKind([{ handling: 'dry', count: 1 }]), 'home');
    assert.equal(fishingEventKind([{ handling: 'keep_precious', count: 1 }]), 'home');
    assert.equal(fishingEventKind([{ handling: 'toss', count: 1 }]), 'home');
    // 混着来的(一句话好几类)以"吃到东西"为优先 —— 数值要落到 meal 那一科
    assert.equal(fishingEventKind([{ handling: 'toss', count: 1 }, { handling: 'grill', count: 1 }]), 'meal');
  });

  test('适配器(D108):结算真的落账,而且 detail 带得全(台账要能查)', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter = makeAdapter(world);
    await adapter.settle(MESSAGE, CHOOSING_STATE, [{ handling: 'sell', kinds: ['all'] }]);
    const applied = world.trace.filter((row) => row.startsWith('apply:'));
    assert.deepEqual(applied, ['apply:fish'], '只落一笔,而且是绑定表认得的 kind');
  });

  test('适配器(D108):**带回家的东西要看得见** —— `home_item` 记账,不再悄悄消失', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter = makeAdapter(world);
    await adapter.settle(MESSAGE, CHOOSING_STATE, [{ handling: 'dry', kinds: ['fish'] }]);
    const raw = world.lastMeta[HOME_ITEM_KEY];
    assert.ok(raw, `应当写下 ${HOME_ITEM_KEY}(否则"带回家风干"账上什么都不多)`);
    const ledger = JSON.parse(raw);
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].key, '风干鱼');
    assert.equal(ledger.items[0].count, 1);
    assert.equal(ledger.items[0].available, false, '现在还没地方放 —— 要如实说');
    // 再来一次就累加,不是重开一份
    await adapter.settle(MESSAGE, CHOOSING_STATE, [{ handling: 'dry', kinds: ['fish'] }]);
    const again = JSON.parse(world.lastMeta[HOME_ITEM_KEY]);
    assert.equal(again.items.length, 1, '同一件东西累加,别长成两行');
    assert.equal(again.items[0].count, 2);
  });

  test('适配器(D108):**卖**不写 home_item(别把卖掉的也算成带回家)', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    await makeAdapter(world).settle(MESSAGE, CHOOSING_STATE, [{ handling: 'sell', kinds: ['all'] }]);
    assert.equal(world.lastMeta[HOME_ITEM_KEY], undefined);
  });

  test('适配器(D108):tick 里"自己收杆"走**同一个** reelIn(会问模型、会发两句)', async () => {
    // 太久没人理 → 自己收杆(鱼篓有货):内核给 fishing_reeled,适配器必须转成完整的收杆流程
    const idle = { ...WAITING_STATE, lastTouchAt: 0, dueAt: Number.MAX_SAFE_INTEGER };
    const world = makeFakeWorld({ meta: withFishing({}, idle) });
    const adapter = makeAdapter(world);
    await adapter.tick();
    assert.deepEqual(world.flavors.map((row) => row.kind), ['reel'], '自动收杆也要问模型(以前这里丢了一整句)');
    assert.equal(world.sent.length, 1);
    assert.ok(world.sent[0].includes('鱼篓里：'), '事实那一段也在');
    const saved = JSON.parse(world.lastMeta['fishing:group:G1:U1']);
    assert.equal(saved.phase, 'choosing', '自动收杆后进"等处置"');
  });

  test('适配器(D108):tick 上钩 → 两条消息(上钩 + 接着钓),而且鱼篓继续等', async () => {
    // ⚠️ `lastTouchAt` 必须是"刚刚"(否则内核会先判成"太久没人理 → 自己收杆")
    const due = { ...WAITING_STATE, dueAt: 1, lastTouchAt: Date.now() };
    const world = makeFakeWorld({ meta: withFishing({}, due) });
    const adapter = makeAdapter(world);
    await adapter.tick();
    assert.equal(world.sent.length, 2, `上钩一条 + 接着钓一条(用户点名要的)：${world.sent.join(' | ')}`);
    assert.ok(world.sent[0].startsWith('和真，'), '要叫名字(群消息里 @ 做不到,只能正文点名)');
    assert.ok(world.sent[0].includes('《catch》'), '第一条是模型写的上钩过程');
    assert.ok(world.sent[1].startsWith('《continue》'), '第二条是"接着钓"');
    assert.ok(world.sent[1].includes('说"收杆"'), '后面挂一句操作提示');
    const saved = JSON.parse(world.lastMeta['fishing:group:G1:U1']);
    assert.equal(saved.phase, 'waiting', '钓上一条之后**自动接着钓**');
    assert.equal(saved.basket.length, 2);
  });

  test('适配器(D108):tick 分鱼超时 → 默认全卖(钱不会凭空消失)', async () => {
    const expired = { ...CHOOSING_STATE, choosingUntil: 1 };
    const world = makeFakeWorld({ meta: withFishing({}, expired) });
    await makeAdapter(world).tick();
    assert.deepEqual(world.trace.filter((row) => row.startsWith('apply:')), ['apply:fish']);
    assert.equal(world.lastMeta['fishing:group:G1:U1'], '');
  });

  test('适配器(D108):tick 遇到坏数据(空壳/坏 JSON)不炸,也不瞎收', async () => {
    const world = makeFakeWorld({ meta: { 'fishing:group:G1:U1': '{坏 JSON', 'fishing:group:G2:U2': '{"water":"湖"}' } });
    await makeAdapter(world).tick();
    assert.deepEqual(world.sent, [], '什么都不该发');
    assert.deepEqual(world.flavors, []);
  });

  // -------------------------------------------------------------------------
  // handleMessage:这一步该不该由钓鱼接管
  // -------------------------------------------------------------------------
  test('适配器(D108):**听不懂的话要原样放过去**,不许被无声吃掉(用户实测第 1 条)', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter = makeAdapter(world);
    // 闲聊:不是收杆、不是在说怎么处理、也不是选饵
    const handled = await adapter.handleMessage({ ...MESSAGE, content: '今天天气不错啊' });
    assert.equal(handled, false, '不接管');
    assert.deepEqual(world.sent, [], '不许回任何东西');
    // 但"最后互动时刻"要刷新(自动收杆看的就是它)
    const saved = JSON.parse(world.lastMeta['fishing:group:G1:U1']);
    assert.ok(saved.lastTouchAt > CHOOSING_STATE.lastTouchAt, '每一句人话都算有人陪着她');
  });

  test('适配器(D108):选饵只认"像回答的话";库外饵按好感度答不答应', async () => {
    const baiting = { ...CHOOSING_STATE, phase: 'bait', basket: [] };
    const world = makeFakeWorld({ meta: withFishing({}, baiting) });
    const adapter = makeAdapter(world);
    assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '你们俩在干嘛' }), false, '"不像回答"的话放过去');
    assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '随便' }), true, '"随便"算选饵');
    const cast = JSON.parse(world.lastMeta['fishing:group:G1:U1']);
    assert.equal(cast.phase, 'waiting');
    assert.ok(Number.isFinite(cast.dueAt));

    // 库外的饵:好感度"眼熟"时 10% 概率 —— 注一个必拒的随机数
    const world2 = makeFakeWorld({ meta: withFishing({}, baiting) });
    const adapter2 = makeAdapter(world2, { affinityTier: () => ({ id: 'known', label: '认得' }), readAffinityScore: () => 12 });
    const handled = await adapter2.handleMessage({ ...MESSAGE, content: '用肥皂当饵行不行' }, { extra: { random: () => 0.99 } });
    assert.equal(handled, true);
    assert.deepEqual(world2.flavors.map((row) => row.kind), ['bait_refuse'], '不肯就用"不肯"那档提示词');
    assert.ok(world2.sent[0].includes('《bait_refuse》'));
    const kept = JSON.parse(world2.lastMeta['fishing:group:G1:U1']);
    assert.equal(kept.phase, 'bait', '不肯之后还在选饵');
    assert.ok(kept.lastTouchAt > baiting.lastTouchAt, '库外饵那条路也要刷新互动时刻(1.65.1 复核抓到的那条)');
  });

  test('适配器(D108):已经在钓了就别重复开局;在分鱼时说"收杆"只提醒一次', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, WAITING_STATE) });
    const adapter = makeAdapter(world);
    assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '去钓鱼' }), true);
    assert.equal(world.sent.length, 1);
    assert.ok(world.sent[0].startsWith('（已经在钓了——'), world.sent[0]);
    assert.equal(JSON.parse(world.lastMeta['fishing:group:G1:U1']).phase, 'waiting', '不许把状态顶掉');

    const world2 = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter2 = makeAdapter(world2);
    assert.equal(await adapter2.handleMessage({ ...MESSAGE, content: '收杆' }), true);
    assert.equal(world2.sent.length, 1);
    assert.ok(world2.sent[0].includes('已经收杆了'), '已经在分鱼了就不再收一次');
    assert.deepEqual(world2.flavors, [], '也别再问一次模型');
    assert.equal(JSON.parse(world2.lastMeta['fishing:group:G1:U1']).phase, 'choosing', '状态不动');
  });

  test('适配器(D108):没在钓时"去钓鱼"要开局;没触发词一律不接管', async () => {
    const world = makeFakeWorld({ meta: {} });
    const adapter = makeAdapter(world);
    assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '今天吃什么' }), false);
    assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '带惠惠去钓鱼吧' }), true);
    assert.equal(world.sent.length, 1);
    assert.ok(world.sent[0].includes('鱼饵用哪种？'), world.sent[0]);
    const started = JSON.parse(world.lastMeta['fishing:group:G1:U1']);
    assert.equal(started.phase, 'bait');
    assert.equal(started.userId, 'U1', '谁开的局记在谁头上');
    assert.equal(started.userName, '和真');
  });

  test('适配器(D108):"分档处置"一句话好几类要听得懂;听不懂就反问', async () => {
    const world = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter = makeAdapter(world);
    assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '鱼烤了、值钱的留着' }), true);
    assert.deepEqual(world.trace.filter((row) => row.startsWith('apply:')), ['apply:meal'], '有"吃"就走 meal');
    assert.equal(world.lastMeta['fishing:group:G1:U1'], '');

    const world2 = makeFakeWorld({ meta: withFishing({}, CHOOSING_STATE) });
    const adapter2 = makeAdapter(world2);
    assert.equal(await adapter2.handleMessage({ ...MESSAGE, content: '这鱼怎么处理' }), true);
    assert.equal(world2.sent.length, 1);
    assert.ok(world2.sent[0].includes('没听清哪一样怎么处理'), '像在说处理但认不出 → 反问');
    assert.equal(JSON.parse(world2.lastMeta['fishing:group:G1:U1']).phase, 'choosing', '状态不动,等她再说一次');
  });

  test('适配器(D108):写盘失败不许把这一轮带崩(钓位读不出来就当没在钓)', async () => {
    const broken = {
      getMeta() { throw new Error('库坏了'); },
      setMeta() { throw new Error('库坏了'); },
      listMetaKeys() { throw new Error('库坏了'); },
      applyStoryResult() { throw new Error('库坏了'); },
    };
    const adapter = createFishingAdapter({
      store: broken,
      send: async () => {},
      flavor: async () => 'x',
      config: {},
      log: { info: () => {}, warn: () => {} },
    });
    assert.equal(adapter.read(MESSAGE), null);
    assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '今天天气不错' }), false);
    await adapter.tick();  // 不该抛
  });

  test('适配器(D108):接**真的** SqliteStateStore 跑一遍 —— 端口名对不上就会在这儿红', async () => {
    // 上面那些用例用的是**手写的假 store**;假 store 的形状是我自己写的,所以"端口名与真库一致"
    // 这件事它证明不了。这条用真库(临时文件)走一遍完整回路:开局 → 选饵 → 上钩 → 收杆 → 卖出。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-fishing-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    try {
      const sent = [];
      const adapter = createFishingAdapter({
        store,
        send: async (message, text) => { sent.push(text); },
        flavor: async (kind) => `《${kind}》`,
        config: { appId: 'APP', currency: '厄里斯', sleep: null },
        log: { info: () => {}, warn: () => {} },
      });

      // ① 开局(写进**真库**)
      assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '去钓鱼' }), true);
      const raw = store.getMeta('fishing:group:G1:U1');
      assert.ok(raw, '钓位要真的落进 meta');
      let state = JSON.parse(raw);
      assert.equal(state.phase, 'bait');

      // ② 选饵 → 开始计时
      assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '1' }), true);
      state = JSON.parse(store.getMeta('fishing:group:G1:U1'));
      assert.equal(state.phase, 'waiting');
      assert.ok(Number.isFinite(state.dueAt));

      // ③ 到点 → 上钩(两条消息)
      const due = { ...state, dueAt: 1, lastTouchAt: Date.now() };
      store.setMeta('fishing:group:G1:U1', JSON.stringify(due));
      sent.length = 0;
      await adapter.tick();
      assert.equal(sent.length, 2, '上钩 + 接着钓');
      state = JSON.parse(store.getMeta('fishing:group:G1:U1'));
      assert.equal(state.basket.length, 1);
      assert.equal(state.phase, 'waiting', '接着钓');

      // ④ 喊收杆 → 进"等她选处置"
      assert.equal(await adapter.handleMessage({ ...MESSAGE, content: '收杆' }), true);
      state = JSON.parse(store.getMeta('fishing:group:G1:U1'));
      assert.equal(state.phase, 'choosing');

      // ⑤ 按**这一竿到底抽到了什么**说处置 —— 处置选项是**按档位**给的(D101 实测第 4 条),
      //    所以"全卖了吧"对一件杂物是听不懂的(这正是那个功能的判据,不是 bug)。
      const caught = state.basket[0];
      const isJunk = caught.kind === 'junk';
      const reply = isJunk ? '杂物扔了吧' : '都卖了吧';
      const before = store.getStats(Date.now(), {});
      sent.length = 0;
      assert.equal(await adapter.handleMessage({ ...MESSAGE, content: reply }), true, `${caught.kind} 这一档应当听得懂「${reply}」`);
      assert.equal(store.getMeta('fishing:group:G1:U1'), '', '钓位清掉');
      assert.ok(sent.some((text) => text.includes('《settle》')), '结算那一段要说出来');
      const after = store.getStats(Date.now(), {});
      if (isJunk) {
        // 扔杂物**不换钱**(只动心情)—— 这条也在绑定表里(D102)
        assert.ok(after.money <= before.money + 1, '扔杂物不该换钱');
      } else {
        assert.ok(after.money >= before.money, '卖鱼只进不出(时间衰减可能同时在扣,所以不比死数)');
      }
      // 台账里要能查到这一笔,而且 kind 是绑定表认得的
      const events = store.listStatsEvents ? store.listStatsEvents(5) : null;
      if (events) assert.ok(events.some((row) => ['fish', 'meal', 'home'].includes(row.kind)), '流水要有这一笔');
    } finally {
      store.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
