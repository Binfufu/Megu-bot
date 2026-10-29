import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { SUMMARY_SESSION_META_KEY, parseSummarySessionMeta, pickSummarySession, planSummarySession, summarySessionKey } from '../src/summary-session.js';
export function registerSummarySessionTests({ test, assert }) {
  test('摘要会话:用满的代绝不回头(重启也一样)，未满的代承接盘上真实用量', () => {
    // 键口径:第 0 代仍是老键(与旧日志/旧判据对得上),第 N 代加后缀。
    assert.equal(summarySessionKey(0), 'qqbot-summary');
    assert.equal(summarySessionKey(1), 'qqbot-summary-1');
    assert.equal(summarySessionKey(-3), 'qqbot-summary');
    assert.equal(summarySessionKey(2.5), 'qqbot-summary');
    // 盘上全空 ⇒ 从第 0 代起。
    assert.deepEqual(planSummarySession({ maxCalls: 30, callsOnDisk: () => 0 }), { gen: 0, calls: 0 });
    // 第 0 代用满 ⇒ 跳到第 1 代,并且**承接**第 1 代已有的用量(旧进程可能已经用过它)。
    const disk = { 0: 48, 1: 20, 2: 6 };
    assert.deepEqual(planSummarySession({ maxCalls: 30, callsOnDisk: (g) => disk[g] ?? 0 }), { gen: 1, calls: 20 });
    // 连续几代都用满 ⇒ 一直往后走,绝不回到任何满代。
    assert.deepEqual(planSummarySession({ maxCalls: 5, callsOnDisk: (g) => (g <= 3 ? 7 : 0) }), { gen: 4, calls: 0 });
    // 读不出来(0)与坏值/负数都当没用量 —— 不许因此跳过一整代。
    assert.deepEqual(planSummarySession({ maxCalls: 10, callsOnDisk: () => undefined }), { gen: 0, calls: 0 });
    assert.deepEqual(planSummarySession({ maxCalls: 10, callsOnDisk: (g) => (g === 0 ? -5 : Number.NaN) }), { gen: 0, calls: 0 });
    // 上限本身坏掉时退到 1(不许出现"cap=0 就永远轮换")。
    assert.deepEqual(planSummarySession({ maxCalls: 0, callsOnDisk: () => 0 }), { gen: 0, calls: 0 });
    // 病态盘(每一代都报"用满")不许把这里变成死循环 —— 有界退出即可,不当成正常状态。
    const pathological = planSummarySession({ maxCalls: 1, callsOnDisk: () => 3 });
    assert.ok(Number.isSafeInteger(pathological.gen) && pathological.gen > 0 && pathological.gen <= 10000,
      '病态输入要有界退出,而不是无限往后走');
  });
  test('摘要会话:真状态库上复现"重启回到已用满旧会话"并证明修复后不回头', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-session-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    try {
      // 造出事故现场:第 0 代已经用满(maxCalls=3 却落了 5 条 user 轮),第 1 代用过 1 次。
      for (let i = 0; i < 5; i += 1) store.appendConversationTurn({ key: 'qqbot-summary', role: 'user', content: `摘要材料 ${i}` });
      store.appendConversationTurn({ key: 'qqbot-summary-1', role: 'user', content: '摘要材料 新一代' });
      const callsOnDisk = (gen) => store.conversationTurns(summarySessionKey(gen)).filter((r) => r.role === 'user').length;
      assert.equal(callsOnDisk(0), 5);
      // 旧口径(纯进程内计数归零)会继续往 qqbot-summary 追加 —— 那就是膨胀的来源。
      assert.equal(summarySessionKey(0), 'qqbot-summary');
      // 新口径:承接"还有余额"的那一代。
      const plan = planSummarySession({ maxCalls: 3, callsOnDisk });
      assert.deepEqual(plan, { gen: 1, calls: 1 });
      const key = summarySessionKey(plan.gen);
      assert.equal(key, 'qqbot-summary-1');
      store.appendConversationTurn({ key, role: 'user', content: '这一轮的摘要材料' });
      assert.equal(callsOnDisk(0), 5, '满代不许再增长');
      assert.equal(callsOnDisk(1), 2);
      // 再开一个"进程"也走同一条路 —— 承接关系只依赖盘上的事实。
      const reopened = new SqliteStateStore(path.join(dir, 'state.db'));
      try {
        assert.equal(planSummarySession({ maxCalls: 3, callsOnDisk: (g) => reopened.conversationTurns(summarySessionKey(g)).filter((r) => r.role === 'user').length }).gen, 1);
      } finally { reopened.close(); }
    } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('摘要会话:盘上用量与持久化计数取更靠前者，后端没有我们的库时靠 meta 跨重启', () => {
    const disk = { 0: 48, 1: 20, 2: 6 };
    const callsOnDisk = (g) => disk[g] ?? 0;
    // 只信盘:满代照样跳过。
    assert.deepEqual(pickSummarySession({ maxCalls: 20, callsOnDisk }),
      { gen: 2, calls: 6, from: 'disk' });
    // 后端没有我们的库(DSH 模式)⇒ 全 0,靠 meta 记住"上一代用到哪"。
    assert.deepEqual(pickSummarySession({ maxCalls: 20, callsOnDisk: () => 0, persisted: { gen: 2, calls: 6 } }),
      { gen: 2, calls: 6, from: 'persisted' });
    // 两个来源冲突时取**更靠前**的,绝不允许往回退(退回已用满的代就是事故本身)。
    assert.deepEqual(pickSummarySession({ maxCalls: 20, callsOnDisk, persisted: { gen: 3, calls: 1 } }),
      { gen: 3, calls: 1, from: 'persisted' });
    assert.deepEqual(pickSummarySession({ maxCalls: 20, callsOnDisk: () => 4, persisted: { gen: 0, calls: 9 } }),
      { gen: 0, calls: 9, from: 'persisted' }, '同一代取更大的用量');
    assert.deepEqual(pickSummarySession({ maxCalls: 20, callsOnDisk, persisted: { gen: 1, calls: 2 } }),
      { gen: 2, calls: 6, from: 'disk' }, '盘上更靠前就用盘上的');
    // 坏 meta 当没有(不猜、不跳代)。
    for (const bad of ['', '{', '{"gen":-1,"calls":3}', '{"gen":1.5,"calls":2}', '[]', 'null']) {
      assert.equal(parseSummarySessionMeta(bad), null, `坏 meta 必须当没有:${bad}`);
    }
    assert.deepEqual(parseSummarySessionMeta(JSON.stringify({ gen: 2, calls: 6 })), { gen: 2, calls: 6 });
    assert.equal(SUMMARY_SESSION_META_KEY, 'summary_session');
  });
  test('摘要会话:**问错库就等于没修** —— 影子模式的隔离库与桥的主库不是同一个', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-stores-'));
    const main = new SqliteStateStore(path.join(dir, 'main.db'));
    const shadow = new SqliteStateStore(path.join(dir, 'shadow.db'));
    try {
      // 事故现场:摘要历史在**隔离库**(48 轮),桥的主库只有 4 轮(影子模式下引擎不往主库写)。
      for (let i = 0; i < 48; i += 1) shadow.appendConversationTurn({ key: 'qqbot-summary', role: 'user', content: `影子摘要材料 ${i}` });
      for (let i = 0; i < 4; i += 1) main.appendConversationTurn({ key: 'qqbot-summary', role: 'user', content: `主库摘要材料 ${i}` });
      const counter = (store) => (gen) => store.conversationTurns(summarySessionKey(gen)).filter((r) => r.role === 'user').length;
      // 问对库(隔离库)⇒ 跳过满代,落到第 1 代(那一代盘上是空的)。
      assert.deepEqual(planSummarySession({ maxCalls: 20, callsOnDisk: counter(shadow) }), { gen: 1, calls: 0 });
      // 问错库(主库)⇒ 以为只用了 4 次,又回到已用 48 次的第 0 代 —— 这就是这次要修的 bug。
      assert.deepEqual(planSummarySession({ maxCalls: 20, callsOnDisk: counter(main) }), { gen: 0, calls: 4 });
      // 持久化计数能把"问错库"也兜住:哪怕盘上看不见,也不许回到 0。
      // 两层分工:pick 取更靠前者(这里 = 已用满的 20),紧接着 summarizer 的轮换负责跳到下一代。
      const pickWhenBlind = pickSummarySession({ maxCalls: 20, callsOnDisk: counter(main), persisted: { gen: 0, calls: 20 } });
      assert.deepEqual(pickWhenBlind, { gen: 0, calls: 20, from: 'persisted' });
      assert.ok(pickWhenBlind.calls >= 20, '取回来就是满的 ⇒ 生产入口那一步会轮换,不会再往第 0 代追加');
      // meta 真落盘再读回(跨"重启"的形态)。
      main.setMeta(SUMMARY_SESSION_META_KEY, JSON.stringify({ gen: 1, calls: 3 }));
      assert.deepEqual(parseSummarySessionMeta(main.getMeta(SUMMARY_SESSION_META_KEY)), { gen: 1, calls: 3 });
      const reopened = new SqliteStateStore(path.join(dir, 'main.db'));
      try { assert.deepEqual(parseSummarySessionMeta(reopened.getMeta(SUMMARY_SESSION_META_KEY)), { gen: 1, calls: 3 }); }
      finally { reopened.close(); }
    } finally { main.close(); shadow.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('摘要会话:**拿生产同形状态在行为层跑一遍**:按盘上用量承接第 2 代,meta 兜底跨重启', async () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    // 整段抽出**部署中的真实逻辑**(状态变量 + 三个助手 + summarizer),不做任何改写。
    const begin = source.indexOf('  let summarySessionGen = 0;');
    const bodyEnd = source.indexOf('\n  }', source.indexOf('const text = String(turn?.text ?? \'\').trim();', begin)) + 4;
    assert.ok(begin > 0 && bodyEnd > begin, '抽不出摘要那一段');
    const region = source.slice(begin, bodyEnd);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-behavior-'));
    // 6B(1.150.84):影子退役 ⇒ 摘要历史就在**这一个**状态库(不再有隔离库/主库之分)。
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    try {
      for (let i = 0; i < 48; i += 1) store.appendConversationTurn({ key: 'qqbot-summary', role: 'user', content: `零代 ${i}` });
      for (let i = 0; i < 20; i += 1) store.appendConversationTurn({ key: 'qqbot-summary-1', role: 'user', content: `代一 ${i}` });
      for (let i = 0; i < 6; i += 1) store.appendConversationTurn({ key: 'qqbot-summary-2', role: 'user', content: `代二 ${i}` });
      const run = (historyStore = store) => {
        const used = [];
        // T1-B(2026-10-29)忠实模拟:真引擎的 runIsolatedTurn **不写**会话历史 ——
        // 无状态任务轮没有"前缀累积"这回事;键只作为账本归属被记进 used。
        const scope = { stateStore: historyStore,
          memoryCfg: { summary: { sessionCalls: 20, timeoutMs: 1000 } },
          log: { info() {}, warn() {} },
          runnerRef: { runIsolatedTurn: async (text, opts) => {
            used.push(opts?.key ?? '');
            return { text: '摘要结果' };
          } },
          pickSummarySession, summarySessionKey, parseSummarySessionMeta, SUMMARY_SESSION_META_KEY };
        const summarizer = vm.runInNewContext(region + '\nsummarizer', scope);
        return { summarizer, used };
      };
      // ① 生产同形:第 0 代满(48)、第 1 代满(20)、第 2 代用了 6/20 ⇒ **承接第 2 代**,账本记第 7 次。
      const live = run();
      assert.equal(await live.summarizer('材料'), '摘要结果');
      assert.deepEqual(live.used, ['qqbot-summary-2'], '按盘上用量承接还有余额的第 2 代');
      assert.equal(store.conversationTurns('qqbot-summary-2').filter((r) => r.role === 'user').length, 6,
        '无状态任务轮不写会话历史(盘上用量不再增长,前缀不再累积)');
      assert.deepEqual(parseSummarySessionMeta(store.getMeta(SUMMARY_SESSION_META_KEY)), { gen: 2, calls: 7 }, '代次要落盘(账本口径,跨重启靠它)');
      // ② 跨"重启":meta 记着第 2 代/7 次 ⇒ 新进程接着第 2 代,不回第 0 代。
      const restarted = run();
      await restarted.summarizer('材料');
      assert.deepEqual(restarted.used, ['qqbot-summary-2'], 'meta 说第 2 代已用 7 次 ⇒ 接着第 2 代,不回第 0 代');
      // ③ 反证(**问错库/看不见盘的样子**):只看得见 4 条 ⇒ 以为第 0 代还有余额,回到已用满的第 0 代。
      store.forgetMeta(SUMMARY_SESSION_META_KEY);
      const blind = new SqliteStateStore(path.join(dir, 'blind.db'));
      try {
        for (let i = 0; i < 4; i += 1) blind.appendConversationTurn({ key: 'qqbot-summary', role: 'user', content: `看不见的 ${i}` });
        const wrong = run(blind);
        await wrong.summarizer('材料');
        assert.deepEqual(wrong.used, ['qqbot-summary'], '看不见盘上用量 ⇒ 回到已用满的第 0 代 —— 这就是"问错库"的模样');
        // ④ meta 兜底:即使看不见盘,只要 meta 记着第 2 代,也不许回满代(mata 要写在**作用域里那个库**上)。
        blind.setMeta(SUMMARY_SESSION_META_KEY, JSON.stringify({ gen: 2, calls: 7 }));
        const wrongWithMeta = run(blind);
        await wrongWithMeta.summarizer('材料');
        assert.deepEqual(wrongWithMeta.used, ['qqbot-summary-2'], 'meta 兜底:看不见盘上的用量时也按记着的代次接着走');
      } finally { blind.close(); }
    } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('摘要会话:生产入口真的按新规则取键(消费端扫描，不只测纯函数)', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ parseSummarySessionMeta, pickSummarySession, summarySessionKey, SUMMARY_SESSION_META_KEY \} from '\.\/summary-session\.js';/, '取键规则必须来自那一个模块(D159:不许第二份实现)');
    const body = source.slice(source.indexOf('async function summarizer('), source.indexOf('const text = String(turn?.text ?? \'\').trim();', source.indexOf('async function summarizer(')));
    assert.match(body, /pickSummarySession\(\{ maxCalls, callsOnDisk: summaryCallsOnDisk,/, '启动时必须按盘上用量+持久化计数承接代次');
    assert.match(body, /parseSummarySessionMeta\(stateStore\.getMeta\(SUMMARY_SESSION_META_KEY\)\)/, '持久化计数必须真的读出来用');
    assert.match(body, /rememberSummarySession\(\);/, '代次/用量必须落盘,否则 DSH 模式跨重启又归零');
    assert.match(body, /const key = summarySessionKey\(summarySessionGen\);/, '取键必须走共用函数');
    assert.match(body, /summarySessionCalls = summaryCallsOnDisk\(summarySessionGen\);/, '轮换到新一代时要承接盘上用量,不许按 0 起算');
    assert.doesNotMatch(body, /summarySessionGen === 0 \? 'qqbot-summary'/, '旧的内联取键写法不许留回来(那正是重启回到第 0 代的口子)');
    assert.doesNotMatch(body, /summarySessionCalls = 0;/, '轮换不许再把计数清零');
    // ⚠️ **问对库**(2026-10-15 的返工点;6B 1.150.84 改成 own 单库):影子退役后摘要历史就在
    //    桥的状态库,唯一的口必须还是这个函数 —— 谁再直连 stateStore 问,就等于埋回"问错库"。
    assert.match(source, /const summaryHistoryStore = \(\) => stateStore;/, '摘要用盘量必须走这一个口(own 单库)');
    assert.match(source, /return summaryHistoryStore\(\)\.conversationTurns\(/, '用盘量只许走这一个口');
    assert.doesNotMatch(source, /return stateStore\.conversationTurns\(summarySessionKey\(gen\)\)/, '不许绕开那个口直连状态库');
    assert.doesNotMatch(source, /shadowStore/, '影子的隔离库已经退役,不该再出现在生产装配里');
  });
}
