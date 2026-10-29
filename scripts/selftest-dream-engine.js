/**
 * **刀二 `src\dream-engine.js` 的判据**(2026-10-13,docs\21 §十 + docs\20 B 路)。
 *
 * ⚠️ 文件名带 `-engine`:已有的 `selftest-dream.js` 是**卡库**(D223)的判据,别混。
 * 全是纯函数判据:世界书激活的确定性、锁人不歧义、组装形状对上 B 路那张图、
 * 前缀 dump 可读、前缀缓存前提(system 逐字节稳定 / 历史只追加)。
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateStore, SCHEMA_VERSION } from '../src/sqlite-store.js';
import { createDreamStore } from '../src/dream-store.js';
import {
  NARRATOR_ID,
  activateKeyedEntries,
  assembleContinue,
  assembleSuggest,
  assembleTurn,
  constantEntries,
  dumpMessages,
  lockSpeaker,
  planTurnCalls,
  speakerNudge,
} from '../src/dream-engine.js';

const ENTRY = (over = {}) => ({
  uid: 1, keys: ['示例键'], content: '示例小组的示例技能需要登记。', constant: false,
  order: 100, disabled: false, selective: false, probability: null,
  ...over,
});

const DEMO_A = {
  name: '示例甲', description: '示例小组的合成助手。', personality: '合成性格甲。',
  scenario: '在示例站点执行任务。',
};
const DEMO_B = { name: '示例乙', description: '示例小组的另一位合成助手。', personality: '', scenario: '' };

export function registerDreamEngineTests({ test, assert: rawAssert }) {
  const a = rawAssert || assert;

  // ① 常驻条
  test('dream 引擎:常驻条 —— 只收 constant 且未禁用的,按 order 排', () => {
    const out = constantEntries([
      ENTRY({ uid: 2, constant: true, order: 20, content: 'B' }),
      ENTRY({ uid: 3, constant: false, content: '键控,不该进' }),
      ENTRY({ uid: 4, constant: true, order: 10, content: 'A' }),
      ENTRY({ uid: 5, constant: true, disabled: true, content: '禁用,不该进' }),
      ENTRY({ uid: 6, constant: true, content: '' }),
    ]);
    a.deepEqual(out.map((e) => e.content), ['A', 'B']);
  });

  // ② 键控激活:命中 / 大小写 / 次键 / 概率 / 禁用
  test('dream 引擎:键控激活 —— 命中、大小写不敏、次键 AND、概率不掷骰', () => {
    const history = [{ role: 'user', content: '随便聊聊' }];
    a.equal(activateKeyedEntries([ENTRY()], history, '来一发示例键吧').hit.length, 1, '主键命中');
    a.equal(activateKeyedEntries([ENTRY()], history, '今天天气不错').hit.length, 0, '不命中');
    a.equal(
      activateKeyedEntries([ENTRY({ keys: ['DEMO_KEY'] })], history, 'demo_key!').hit.length, 1,
      '默认忽略大小写',
    );
    a.equal(
      activateKeyedEntries([ENTRY({ caseSensitive: true, keys: ['DEMO_KEY'] })], history, 'demo_key').hit.length, 0,
      'caseSensitive 时区分',
    );
    // selective:主键中 + 次键也至少一条中才发
    const selective = ENTRY({ selective: true, keys: ['示例键'], secondaryKeys: ['示例次键'] });
    a.equal(activateKeyedEntries([selective], history, '示例键真厉害').hit.length, 0, '选择性键:只有主键不发');
    a.equal(activateKeyedEntries([selective], history, '示例次键的示例键真厉害').hit.length, 1, '主键+次键都中才发');
    // 概率:不掷骰 —— <100 一律不发(确定性口径,等用户拍板再接骰子)
    a.equal(activateKeyedEntries([ENTRY({ probability: 50 })], history, '示例键').hit.length, 0, '概率<100 不掷骰不发');
    // 禁用 / 无键
    a.equal(activateKeyedEntries([ENTRY({ disabled: true })], history, '示例键').hit.length, 0);
    a.equal(activateKeyedEntries([ENTRY({ keys: [] })], history, '示例键').hit.length, 0, '无键不发');
  });

  test('dream 引擎:扫描深度 —— 只扫最近 N 条 + 用户这句,太远的历史不触发', () => {
    const longHistory = Array.from({ length: 10 }, (_, i) => ({
      role: 'user', content: i === 0 ? '提一下示例键' : `第${i}句`,
    }));
    a.equal(activateKeyedEntries([ENTRY()], longHistory, '继续').hit.length, 0, '默认深度 4:第 1 条扫不到');
    a.equal(
      activateKeyedEntries([ENTRY({ scanDepth: 10 })], longHistory, '继续').hit.length, 1,
      '卡的 scanDepth 更大就能扫到',
    );
  });

  // ③ 锁人
  test('dream 引擎:锁人 —— 点名独占、长名优先、没点名走 fallback、旁白不是候选人', () => {
    const members = [{ id: 'c1', name: '示例甲' }, { id: 'c2', name: '示例乙' }];
    a.equal(lockSpeaker('示例甲,今天吃什么', members).speaker.id, 'c1', '点名示例甲');
    a.equal(lockSpeaker('示例甲,今天吃什么', members).reason, 'named');
    a.equal(lockSpeaker('示例乙你怎么看', members).speaker.id, 'c2');
    a.equal(lockSpeaker('大家都吃了吗', members, { fallback: members[0] }).reason, 'fallback', '没人被点名');
    // 长名优先:「示例甲喵」比「示例甲」长,句里两个都能匹配时应取更具体的那个
    const withAlias = [{ id: 'c1', name: '示例甲' }, { id: 'c3', name: '示例甲喵' }];
    a.equal(lockSpeaker('示例甲喵说得对', withAlias).speaker.id, 'c3');
    // 旁白 id 不参与点名
    a.equal(lockSpeaker('旁白来一段', [...members, { id: NARRATOR_ID, name: '旁白' }]).reason, 'fallback',
      '「旁白」这个名字不该被当成角色点名');
  });

  // ④ 组装器:B 路那张图的形状
  test('dream 引擎:组装 —— 常驻在卡前、卡按人一块、名单、历史带 name、键控在用户前、nudge 收尾', () => {
    const world = [
      ENTRY({ uid: 7, constant: true, content: '【世界】示例镇,大厅「示例大厅」' }),
      ENTRY({ uid: 8, keys: ['鸭肉'], content: '【店里的招牌是鸭肉串】' }),
    ];
    const history = [
      { role: 'assistant', name: '示例乙', content: '又点这么贵的东西……' },
    ];
    const out = assembleTurn({
      worldEntries: world,
      characters: [DEMO_A, DEMO_B],
      history,
      userText: '我要吃鸭肉!',
      speaker: { id: 'c1', name: '示例甲' },
      roomTitle: '示例大厅·大厅',
    });
    const roles = out.messages.map((m) => m.role);
    a.equal(roles[0], 'system', '第一段 = 世界书常驻');
    a.ok(out.messages[0].content.includes('示例镇'), '常驻条在里面');
    const cardBlocks = out.messages.filter((m) => m.content.startsWith('【角色:'));
    a.equal(cardBlocks.length, 2, '两张卡各一块');
    a.ok(cardBlocks[0].content.includes('示例小组'), '示例甲的人设');
    const roster = out.messages.find((m) => m.content.startsWith('【在场】'));
    a.ok(roster.content.includes('示例甲') && roster.content.includes('示例乙'));
    a.ok(roster.content.includes('【这轮谁说话】示例甲'));
    const hist = out.messages.find((m) => m.role === 'assistant');
    a.equal(hist.name, '示例乙', '历史 assistant 带 name(B 路关键)');
    // 键控条:在历史之后、用户这句之前
    const keyedIdx = out.messages.findIndex((m) => m.content.includes('鸭肉串'));
    const histIdx = out.messages.indexOf(hist);
    const userIdx = out.messages.findIndex((m) => m.role === 'user');
    a.ok(keyedIdx > histIdx && keyedIdx < userIdx, '键控条插在历史后用户前');
    a.deepEqual(out.activated.slice().sort((x, y) => x - y), [7, 8], '激活清单 = 常驻 + 键控');
    const last = out.messages[out.messages.length - 1];
    a.equal(last.role, 'system');
    a.ok(last.content.includes('只以示例甲的身份回复'), '末尾 nudge 锁人');
  });

  test('dream 引擎:前缀缓存前提 —— 同房连两轮,system 段逐字节稳定、历史只追加', () => {
    const world = [ENTRY({ uid: 7, constant: true, content: '【世界】示例镇' })];
    const first = assembleTurn({
      worldEntries: world, characters: [DEMO_A], history: [],
      userText: '你好', speaker: { id: 'c1', name: '示例甲' },
    });
    const second = assembleTurn({
      worldEntries: world, characters: [DEMO_A],
      history: [{ role: 'assistant', name: '示例甲', content: '这是示例甲的第一条回复' }],
      userText: '切,吹牛', speaker: { id: 'c1', name: '示例甲' },
    });
    // 第一轮的全部 system 消息要在第二轮里逐字重现(缓存命中的前提)。
    for (const m of first.messages.filter((x) => x.role === 'system')) {
      a.ok(
        second.messages.some((x) => x.role === 'system' && x.content === m.content),
        `逐字节重现:${m.content.slice(0, 20)}…`,
      );
    }
    // 历史:第二轮包含第一轮的回复,且只追加(没重排)。
    a.ok(second.messages.some((m) => m.role === 'assistant' && m.name === '示例甲' && m.content === '这是示例甲的第一条回复'));
  });

  test('dream 引擎:dump —— 真发出去的东西可读、能对账', () => {
    const text = dumpMessages([
      { role: 'system', content: 'A' },
      { role: 'assistant', content: 'B', name: '示例甲' },
      { role: 'user', content: 'C' },
    ]);
    a.ok(text.includes('--- system ---'));
    a.ok(text.includes('--- assistant(示例甲) ---'));
    a.ok(text.includes('\nB'), '正文在名字行后面');
    a.equal(dumpMessages(null), '');
  });

  // ⑤ 一轮计划:一次用户发言 = 说话人 + 旁白(计费打包口径)
  test('dream 引擎:planTurnCalls —— 点名说话人 + 旁白各一次;空名单也兜出旁白', () => {
    const members = [{ id: 'c1', name: '示例甲' }, { id: 'c2', name: '示例乙' }, { id: NARRATOR_ID, name: '旁白' }];
    const calls = planTurnCalls('示例甲来一段', members);
    a.deepEqual(calls.map((c) => c.speaker.id), ['c1', NARRATOR_ID], '点名示例甲 + 旁白收尾');
    a.equal(calls[0].reason, 'named');
    a.equal(calls[1].reason, 'narrator');
    const nobody = planTurnCalls('谁都不在', []);
    a.deepEqual(nobody.map((c) => c.speaker.id), [NARRATOR_ID], '没角色时只有旁白,不炸');
  });

  test('dream 引擎:nudge —— 旁白轮与角色轮措辞分得开', () => {
    a.ok(speakerNudge('示例甲').includes('示例甲'));
    a.ok(speakerNudge(NARRATOR_ID).includes('旁白'));
    a.ok(speakerNudge(NARRATOR_ID).includes('不以任何角色的第一人称'));
  });

  // ⑥ 存储(dream_room / dream_member / dream_msg;真 SQLite 临时库)
  test('dream 存储:建房/成员/历史 append-only/删房;usage 汇总可反推定价', () => {
    a.equal(SCHEMA_VERSION >= 10, true, 'dream 三张表进 SCHEMA(版本要 >= 10)');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dream-store-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const dreams = createDreamStore({ store, now: () => 1_000_000 });

    const room = dreams.createRoom({
      title: '示例房间',
      manifest: { world: 'worldcard:1', cast: ['char:1', 'char:2'] },
      createdBy: 'player:1',
      members: [
        { memberId: 'char:1', name: '示例甲', cardId: 'char:1' },
        { memberId: NARRATOR_ID, name: '旁白', kind: 'narrator' },
      ],
    });
    a.ok(room.id.startsWith('dream:'), '房 id 形状');
    a.deepEqual(room.manifest, { world: 'worldcard:1', cast: ['char:1', 'char:2'] });
    a.equal(dreams.listRooms().length, 1);

    // 历史 append-only:先 user 后 assistant,读回来顺序不乱;meta 落 usage。
    dreams.appendMsg({ roomId: room.id, role: 'user', name: '旅人', content: '示例甲,放一个看看' });
    const id2 = dreams.appendMsg({
      roomId: room.id, role: 'assistant', name: '示例甲', content: '看好了——DEMO_REPLY!',
      meta: { usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cacheHitTokens: 60 } },
    });
    const hist = dreams.history(room.id);
    a.equal(hist.length, 2);
    a.equal(hist[0].role, 'user');
    a.equal(hist[1].name, '示例甲');
    a.equal(hist[1].meta.usage.totalTokens, 120, 'usage 原样在 meta 里');
    a.throws(() => dreams.appendMsg({ roomId: room.id, role: 'system', content: 'x' }), /role 非法/, '只收两种 role');
    a.throws(() => dreams.appendMsg({ roomId: room.id, role: 'user', content: '' }), /空串/);

    // usage 汇总(免费记账 → 反推定价的数据源;user 行不算调用)
    const usage = dreams.roomUsage(room.id);
    a.deepEqual(usage, { calls: 1, promptTokens: 100, completionTokens: 20, cacheHitTokens: 60, totalTokens: 120 });

    // 成员增删
    dreams.addMember(room.id, { memberId: 'char:2', name: '示例乙', cardId: 'char:2' });
    const membersNow = dreams.addMember(room.id, { memberId: 'char:3', name: '示例丙', cardId: 'char:3' });
    a.equal(membersNow.length, 4, '示例甲+旁白+示例乙+示例丙');
    dreams.removeMember(room.id, 'char:3');
    a.equal(dreams.addMember(room.id, { memberId: 'char:9', name: '9' }).length, 4);
    a.throws(() => dreams.addMember(room.id, { memberId: '', name: 'x' }), /要有 id 与名字/);

    // 删房 = 历史与成员一起没了(操作者能删,docs\03 边界 2)
    dreams.deleteRoom(room.id);
    a.equal(dreams.getRoom(room.id), undefined);
    a.equal(dreams.history(room.id).length, 0);
    a.equal(id2 > 0, true);
  });

  test('dream 存储:记忆不串台 —— dream_msg 里的事不进世界档的 conversation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dream-iso-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const dreams = createDreamStore({ store });
    const room = dreams.createRoom({ title: '梦房', members: [{ memberId: 'char:1', name: '示例甲', cardId: 'char:1' }] });
    dreams.appendMsg({ roomId: room.id, role: 'assistant', name: '示例甲', content: '梦里我们完成了示例关卡' });
    // 世界档的会话表仍是空的:梦的事只住 dream_msg。
    const rows = store.handle.prepare('SELECT COUNT(*) AS n FROM conversation').get();
    a.equal(rows.n, 0, '梦境历史绝不进世界档会话');
    const msgRows = store.handle.prepare('SELECT COUNT(*) AS n FROM dream_msg').get();
    a.equal(msgRows.n, 1, '它住在 dream_msg');
    // 同一把库上世界档写自己的会话,两边互不可见。
    store.handle.prepare('INSERT INTO conversation (key, generation, updated_at) VALUES (?, ?, ?)')
      .run('web:1', 1, 1);
    a.equal(dreams.history(room.id).length, 1, '世界档的写入不进梦境');
  });

  // ⑦ 服务层(dream-service:引擎 + 假 llm + 真 store + 假卡解析,全链不碰网)
  test('dream 服务:一次发言 = 说话人 + 旁白两次调用,历史落对、usage 汇总对', async () => {
    const { createDreamService } = await import('../src/dream-service.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dream-svc-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const dreams = createDreamStore({ store });
    const seen = [];
    const fakeLlm = {
      chat: async (messages) => {
        seen.push(messages);
        const nudge = messages[messages.length - 1].content;
        // 用「只以」判角色轮(不能查「旁白」二字 —— 角色 nudge 里也有它)。
        return {
          text: nudge.includes('只以') ? '哼,看好了——DEMO_REPLY!' : '示例大厅的门被推开了。',
          usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60, cacheHitTokens: 30 },
          model: 'fake-model',
        };
      },
    };
    const resolveCard = async (cardId) => cardId.startsWith('world:')
      ? { character: null, book: { entries: [
          { uid: 1, constant: true, content: '【世界】示例镇', order: 100, disabled: false },
        ] } }
      : { character: { name: '示例甲', description: '示例小组助手。', personality: '', scenario: '' }, book: null };
    const svc = createDreamService({ dreams, llm: fakeLlm, resolveCard, log: { warn: () => {}, info: () => {} } });

    const room = await svc.createRoom({
      title: '示例房间', worldCardId: 'world:1', charCardIds: ['char:1'], createdBy: 'player:1',
    });
    a.ok(room.id.startsWith('dream:'));
    const members = dreams.listMembers(room.id);
    a.equal(members.length, 2, '角色 + 旁白');
    a.ok(members.some((m) => m.kind === 'narrator'));

    const out = await svc.playTurn({ roomId: room.id, userText: '示例甲,来一发', playerName: '旅人' });
    a.equal(seen.length, 2, '两次调用:说话人 + 旁白');
    a.equal(out.replies[0].name, '示例甲');
    a.equal(out.replies[1].name, '旁白');
    a.equal(out.usage.calls, 2);
    a.equal(out.usage.promptTokens, 100);
    // 旁白看得见示例甲刚说的话(同轮接得上话)
    const narratorMsgs = seen[1];
    a.ok(narratorMsgs.some((m) => m.role === 'assistant' && m.name === '示例甲' && m.content.includes('DEMO_REPLY')));
    // 组装把卡与世界书带进去了
    a.ok(seen[0].some((m) => m.content.includes('示例小组助手')));
    a.ok(seen[0].some((m) => m.content.includes('示例镇')));
    // 历史:user + 两条 assistant,meta 有 usage 与激活条目
    const hist = dreams.history(room.id);
    a.equal(hist.length, 3);
    a.equal(hist[0].role, 'user');
    a.equal(hist[0].name, '旅人');
    a.ok(hist[1].meta.usage.totalTokens === 60 && hist[1].meta.activated.includes(1));
    // roomUsage 与 playTurn 的汇总一致(免费记账的数据源)
    const roomUsage = dreams.roomUsage(room.id);
    a.equal(roomUsage.calls, 2);
    a.equal(roomUsage.totalTokens, 120);
  });

  test('dream 服务:空回复不落库;空发言/不存在的房当场拒;少角色开不了房', async () => {
    const { createDreamService } = await import('../src/dream-service.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dream-svc2-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const dreams = createDreamStore({ store });
    const svc = createDreamService({
      dreams,
      llm: { chat: async () => ({ text: '  ', usage: null, model: 'm' }) },
      resolveCard: async () => ({ character: { name: '示例甲', description: 'x' }, book: null }),
      log: { warn: () => {}, info: () => {} },
    });
    const room = await svc.createRoom({ title: '房', charCardIds: ['char:1'] });
    await a.rejects(() => svc.playTurn({ roomId: room.id, userText: '   ' }), /不能是空/);
    await a.rejects(() => svc.playTurn({ roomId: 'dream:nope', userText: '嗨' }), /不存在/);
    const out = await svc.playTurn({ roomId: room.id, userText: '嗨' });
    a.equal(out.replies.length, 0, '两个说话人都空回复 = 不落库');
    a.equal(dreams.history(room.id).length, 1, '但用户那句还在(发言是事实)');
    await a.rejects(() => svc.createRoom({ title: '空房', charCardIds: [] }), /至少要一名角色/);
  });

  // ⑧ 输入行「更多功能」四颗键(2026-10-19 / D269):存储尾部口子 + 续写/帮答组装 + 服务四个动作
  test('dream 存储:尾部删/改(D269)—— 只动最后一条;删完改完历史与 usage 跟着变', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dream-tail-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const dreams = createDreamStore({ store });
    const room = dreams.createRoom({ title: '尾房', members: [{ memberId: 'char:1', name: '示例甲', cardId: 'char:1' }] });
    const one = dreams.appendMsg({ roomId: room.id, role: 'user', name: '旅人', content: '第一句' });
    const two = dreams.appendMsg({ roomId: room.id, role: 'assistant', name: '示例甲', content: '第一回' });
    dreams.appendMsg({ roomId: room.id, role: 'user', name: '旅人', content: '第二句' });
    const last = dreams.appendMsg({
      roomId: room.id, role: 'assistant', name: '示例甲', content: '第二回',
      meta: { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    });
    a.equal(dreams.lastMsg(room.id).content, '第二回', 'lastMsg = 最后一条');
    // 删最后一条:返回被删的那一条,历史少一条
    const deleted = dreams.deleteLastMsg(room.id);
    a.equal(deleted.id, last);
    a.equal(deleted.name, '示例甲');
    a.equal(dreams.history(room.id).length, 3);
    // 改最后一条(只许尾部):正文与 meta 一起换
    const changed = dreams.updateLastMsg(room.id, {
      content: '第二句(改)',
      meta: { usage: { promptTokens: 30, completionTokens: 0, totalTokens: 30 } },
    });
    a.equal(changed.content, '第二句(改)');
    a.equal(dreams.lastMsg(room.id).meta.usage.totalTokens, 30, 'meta 一起换');
    a.throws(() => dreams.updateLastMsg(room.id, { content: '' }), /空串/);
    // 删某个 id 之后:只删它后面那些
    a.equal(dreams.deleteMsgsAfter(room.id, one), 2, '第一句之后的 2 条被删');
    a.deepEqual(dreams.history(room.id).map((m) => m.content), ['第一句']);
    a.equal(dreams.roomUsage(room.id).calls, 0, '被删行的 usage 不再参与汇总(如实口径)');
    a.equal(dreams.lastMsg(room.id).id, one);
    // 空房:lastMsg / deleteLastMsg / updateLastMsg 都如实回空
    const empty = dreams.createRoom({ title: '空房', members: [] });
    a.equal(dreams.lastMsg(empty.id), null);
    a.equal(dreams.deleteLastMsg(empty.id), null);
    a.equal(dreams.updateLastMsg(empty.id, { content: 'x' }), null);
    a.equal(two > 0, true);
  });

  test('dream 引擎:续写与帮答的组装(D269)—— 续写带着最后半句 + 锁人 nudge;帮答是玩家侧、不冒充角色', () => {
    const world = [ENTRY({ uid: 9, constant: true, content: '【世界】示例镇' })];
    const history = [
      { role: 'user', name: '旅人', content: '继续讲' },
      { role: 'assistant', name: '示例甲', content: '那天夜里,' },
    ];
    const cont = assembleContinue({
      worldEntries: world, characters: [DEMO_A, DEMO_B], history,
      speaker: { id: 'c1', name: '示例甲' }, roomTitle: '示例大厅·大厅',
    });
    a.ok(cont.messages.some((m) => m.role === 'assistant' && m.name === '示例甲' && m.content === '那天夜里,'),
      '续写要把"最后半句"放进历史');
    const contLast = cont.messages[cont.messages.length - 1];
    a.equal(contLast.role, 'system');
    a.ok(contLast.content.includes('只以示例甲的身份回复'), '续写仍走同一份锁人 nudge');
    const contUser = [...cont.messages].reverse().find((m) => m.role === 'user');
    a.ok(contUser.content.includes('接着上面最后那句话继续写'), '末尾有"接着写"的指令');
    a.ok(cont.messages.some((m) => m.content.includes('【世界】示例镇')), '场景头照旧(常驻世界书)');

    const sug = assembleSuggest({
      worldEntries: world, characters: [DEMO_A, DEMO_B], history, roomTitle: '示例大厅·大厅',
    });
    const instruction = sug.messages.find((m) => m.content.includes('【任务】只写玩家'));
    a.ok(instruction, '帮答要有玩家侧任务指令');
    a.equal(sug.messages[sug.messages.length - 1].role, 'user', '末尾是"写一句"的 user 指令');
    a.ok(!sug.messages.some((m) => m.content.includes('只以') && m.content.includes('身份回复')),
      '帮答绝不冒充角色(不许出现锁人 nudge)');
    a.ok(sug.messages.some((m) => m.content.includes('示例小组')), '场景头照旧(在场角色卡)');
    a.ok(sug.messages.some((m) => m.role === 'assistant' && m.name === '示例甲'), '历史照旧只追加');
    // 共用的场景头:常驻条与卡块两份组装器逐字一致(同一份实现)
    const headOf = (out) => out.messages.filter((m) => m.role === 'system' && (m.content.includes('示例镇') || m.content.startsWith('【角色:')));
    a.deepEqual(headOf(sug).map((m) => m.content), headOf(cont).map((m) => m.content),
      '续写/帮答与说话共用同一份场景头(D159)');
  });

  test('dream 服务:重新生成/续写/帮答/删除(D269)—— 尾部替换、同一句变长、草稿不落库、空房有话说', async () => {
    const { createDreamService } = await import('../src/dream-service.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dream-tools-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const dreams = createDreamStore({ store });
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const fakeLlm = {
      calls: 0,
      chat: async (messages) => {
        fakeLlm.calls += 1;
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        let text = '看好了——DEMO_REPLY!';
        if (system.includes('只写玩家')) text = '我跟着她走进示例大厅。';
        else if (system.includes('由旁白叙述')) text = '灯火摇曳,示例大厅里安静下来。';
        else if (system.includes('接着上面最后那句话')) text = '火光映红了她的脸。';
        return { text, usage, model: 'fake-model' };
      },
    };
    const resolveCard = async (cardId) => cardId.startsWith('world:')
      ? { character: null, book: { entries: [{ uid: 1, constant: true, content: '【世界】示例镇', order: 100, disabled: false }] } }
      : { character: { name: '示例甲', description: '示例小组助手。', personality: '', scenario: '' }, book: null };
    const svc = createDreamService({ dreams, llm: fakeLlm, resolveCard, log: { warn: () => {}, info: () => {} } });
    const room = await svc.createRoom({ title: '示例大厅', worldCardId: 'world:1', charCardIds: ['char:1'] });

    // 一轮正常发言 → 3 行(user + 两个 assistant)
    await svc.playTurn({ roomId: room.id, userText: '示例甲,来一发', playerName: '旅人' });
    a.equal(dreams.history(room.id).length, 3);
    // **重新生成**:旧回复被替换(不是叠加),用户那句不重写
    const regen = await svc.regenerateTurn({ roomId: room.id });
    const afterRegen = dreams.history(room.id);
    a.equal(afterRegen.length, 3, '重新生成 = 尾部替换,历史长度不变');
    a.equal(afterRegen[0].content, '示例甲,来一发', '用户那句原样保留(不重写)');
    a.equal(afterRegen.filter((m) => m.role === 'user').length, 1, '不许把用户那句说两遍');
    a.equal(regen.replies.length, 2, '重新生成还是说话人 + 旁白两次');
    a.equal(regen.removed, 2, '删掉的旧回复数如实回报');
    // **续写**:同一句话变长,行数不变,usage 合并
    const base = dreams.lastMsg(room.id).content;
    const cont = await svc.continueTurn({ roomId: room.id });
    const afterContinue = dreams.lastMsg(room.id);
    a.equal(dreams.history(room.id).length, 3, '续写不新增消息行');
    a.equal(cont.base, base, '回包带原文(页面拼接受用)');
    a.equal(afterContinue.content, base + cont.replies[0].text, '续写接在原文后面');
    a.ok(afterContinue.content.startsWith(base) && afterContinue.content.length > base.length);
    a.equal(afterContinue.meta.usage.calls, 2, '同一行两次调用 → usage.calls 合并');
    a.equal(dreams.roomUsage(room.id).calls, 3, '重新生成删行后的可见口径:说话人 1 + 旁白 2(被删行的账不再汇总)');
    // **AI 帮答**:只回文本、不落库、不发送;提示词是玩家侧
    const beforeSuggest = dreams.history(room.id).length;
    const sug = await svc.suggestTurn({ roomId: room.id });
    a.equal(sug.text, '我跟着她走进示例大厅。');
    a.equal(dreams.history(room.id).length, beforeSuggest, '帮答不落库');
    // **删除**:一次删最后一条;删到空房后三颗键都如实拒
    const deleted = svc.deleteLastMessage(room.id);
    a.equal(deleted.role, 'assistant');
    a.equal(dreams.history(room.id).length, 2);
    svc.deleteLastMessage(room.id);
    svc.deleteLastMessage(room.id);
    a.equal(dreams.history(room.id).length, 0);
    a.throws(() => svc.deleteLastMessage(room.id), /没有可删/);
    await a.rejects(() => svc.regenerateTurn({ roomId: room.id }), /可以重新生成/);
    await a.rejects(() => svc.continueTurn({ roomId: room.id }), /还没有可以续写/);
    // 最后一条是用户时说"先等她回一句"
    dreams.appendMsg({ roomId: room.id, role: 'user', name: '旅人', content: '没人接话' });
    await a.rejects(() => svc.continueTurn({ roomId: room.id }), /先等她回一句/);
    // 帮答在空历史也照常工作(没有可接的话时,就是给一句开场)
    const emptyRoom = await svc.createRoom({ title: '空房', charCardIds: ['char:1'] });
    const emptySug = await svc.suggestTurn({ roomId: emptyRoom.id });
    a.ok(emptySug.text.length > 0);
    a.equal(fakeLlm.calls > 0, true);
  });
}
