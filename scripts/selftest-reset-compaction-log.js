/**
 * **批2 判据:F7 `/重置` 在途语义 + F8 `compactionCalls` 上限**(2026-10-15,并行审查)。
 *
 * 两条都属于"量小但不修会腐烂"的那一族,所以判据钉的是**不变量**,不是当场的值:
 *   · F7 —— 用户**看得见**那句"这会儿重置不了"(以前 own 路被外层错误路径吞掉,
 *     她一个字都不回);而且重置**没成功**时不许污染交接抑制(那会静默丢一次旧记忆)。
 *   · F8 —— 持久结构**有上限**:50 次压缩之后 meta 行里的数组不再长长,
 *     而且留下的确实是**最近**的那些(层的顺序不许乱)。
 *
 * 反证(改回即红)写在每条注释里。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnEngine, COMPACTION_CALLS_KEPT, rememberCompactionCall } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { RESET_BUSY_REPLY, RESET_FAILED_REPLY, planReset } from '../src/reset-reply.js';

// 迷你预算:触发线低到几轮就超,把"压缩"这条路径逼出来(数值只属于这条判据,不是生产预算)。
// ⚠️ 三条要**一起给**:`rearmLevel = trigger − keepRecent − margin = 200`,而保留段
//    由 `keepForGap` 给(冷窗内 = `keepRecentTokens` = 20)⇒ 每轮十几 token 时,
//    压完之后水位立刻落回重武装线以内,**下一轮又能压一次**。
//    第一版只给 trigger/keepRecent(单轮 80+ token、保留段一口气 90)⇒ 永远卡在"迟滞"里,
//    70 轮只压了 1 次 —— 判据自己的**前提**断言当场红。这正是"分母不够就别下结论"在测试里的样子。
const TINY_BUDGET = Object.freeze({ triggerTokens: 300, keepRecentTokens: 20, summaryCapTokens: 200,
  hysteresisMarginTokens: 10, coldGapMs: 3_600_000, coldKeepTokens: 20 });

/** 临时目录清理:Windows 上库文件可能还被未 finalize 的句柄压着,别让清理失败冒充判据失败。 */
async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
}

export function registerResetAndCompactionLogTests({ test, assert }) {
  test('/重置(F7):在途时不抛给外层 —— 用户**看得见**那句,而且状态一个字没改', () => {
    // ① 忙 ⇒ 回"等这句说完"(而不是抛)。
    const busyRunner = { isBusy: () => true, resetConversation() { throw new Error('不该被调用'); } };
    const busy = planReset(busyRunner, 'k');
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, 'busy');
    assert.equal(busy.reply, RESET_BUSY_REPLY, '措辞取自 src\\reset-reply.js(唯一一份)');
    assert.match(busy.reply, /等这句说完再 \/重置 一次/, '要告诉用户怎么再来一次,不能只说"不行"');
    // ② **竞态**:问的时候不忙,真重置那一刻抛 ⇒ 也要变成一句人话,不许冒泡给外层。
    const racingRunner = { isBusy: () => false,
      resetConversation() { throw new Error('engine: cannot reset a conversation with pending turns'); } };
    const raced = planReset(racingRunner, 'k');
    assert.equal(raced.ok, false);
    assert.equal(raced.reason, 'failed');
    assert.equal(raced.reply, RESET_FAILED_REPLY);
    assert.match(String(raced.error?.message), /pending turns/, '原始错误要留着给日志(不吞根因)');
    // ③ 正常路径:返回值原样带出来,不抛不吞。
    const ok = planReset({ isBusy: () => false, resetConversation: () => 'qqbot-c2c-x-g2' }, 'k');
    assert.deepEqual(ok, { ok: true, sessionId: 'qqbot-c2c-x-g2' });
    // ⚠️ "own 引擎真的会拒绝"这一条**不由这组纯函数判据证明**(只测纯函数等于自证)——
    //    下一组用真引擎把它钉住。
  });

  test('/重置(F7):真 own 引擎在途回合时拒绝重置 —— 而 planReset 把它变成一句回话', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-pending-'));
    const personaPath = path.join(dir, 'persona.txt');
    fs.writeFileSync(personaPath, 'reset-persona');
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let engine;
    try {
      engine = createOwnEngine({ store, personaPath, budget: null,
        llm: { async chat() { await gate; return { text: '答完了', usage: null, finishReason: 'stop' }; } } });
      await engine.initialize();
      // 起一轮但不 await:此刻引擎处于"在途"。
      const inFlight = engine.runTurn('k', '这一轮先别答完');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(engine.isBusy('k'), true, '前提:在途这一轮把会话标成忙');
      // 反证锚点:引擎**确实**拒绝(这就是 F7 的现场);planReset 把它变成一句回话。
      assert.throws(() => engine.resetConversation('k'), /pending turns/,
        'own 引擎在途时抛 —— 去掉 planReset 那道闸门,这个抛就会冒泡到"处理消息失败",用户一个字都收不到');
      const planned = planReset(engine, 'k');
      assert.equal(planned.ok, false);
      assert.equal(planned.reason, 'busy');
      assert.equal(planned.reply, RESET_BUSY_REPLY, '用户看到的是人话,不是"处理消息失败"');
      release();
      const turn = await inFlight;
      assert.equal(turn.text, '答完了', '在途那一轮不受这次被拒的重置影响');
      // 忙完了就能重置 —— "这会儿不行"不等于"永远不行"。
      const after = planReset(engine, 'k');
      assert.equal(after.ok, true, '回合落定之后重置必须成功(否则那句"等这句说完再来"就是骗人)');
    } finally {
      release?.();
      await engine?.stop();
      store.close();
      await cleanupDir(dir);
    }
  });

  test('compactionCalls(F8):纯函数只留最近 50 条,顺序与内容不许被改', () => {
    assert.equal(COMPACTION_CALLS_KEPT, 50);
    // 空/坏输入不炸(与项目里其它"最近 N 条"助手同口径)。
    assert.deepEqual(rememberCompactionCall(undefined, { layer: 1 }), [{ layer: 1 }]);
    assert.deepEqual(rememberCompactionCall('坏的', { layer: 1 }), [{ layer: 1 }]);
    let list = [];
    for (let i = 1; i <= COMPACTION_CALLS_KEPT + 25; i += 1) {
      list = rememberCompactionCall(list, { at: i, layer: i % 2 ? 1 : 2 });
    }
    assert.equal(list.length, COMPACTION_CALLS_KEPT, '上限就是上限(反证:改回 push ⇒ 这里 75)');
    assert.equal(list[0].at, 26, '留下的是**最近**的 —— 最老的那些被丢掉');
    assert.equal(list.at(-1).at, COMPACTION_CALLS_KEPT + 25, '刚写进去的必须在末尾(顺序没被重排)');
    assert.deepEqual(list.map((c) => c.at), Array.from({ length: COMPACTION_CALLS_KEPT }, (_, i) => i + 26),
      '连续递增 = 既没丢中间也没重排');
  });

  test('compactionCalls(F8):旧库 200 条 + 真压一次之后,落盘的 meta 行停在上限', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-calls-'));
    const personaPath = path.join(dir, 'persona.txt');
    fs.writeFileSync(personaPath, '人设'.repeat(4));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const summaryCalls = [];
    let engine;
    try {
      // 摘要永远**比被压的段短**,所以每次都压得动 ⇒ 每一轮都产生一条 compactionCalls。
      engine = createOwnEngine({ store, personaPath, budget: TINY_BUDGET,
        llm: { async chat(messages) {
          const text = String(messages[0]?.content ?? '');
          if (/【旧摘要】|【待压缩的对话段】/.test(text)) {
            summaryCalls.push(text.length);
            return { text: '摘要', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
          }
          return { text: '她答了', usage: null, finishReason: 'stop' };
        } } });
      await engine.initialize();
      // 先铺一份"旧的、没有上限的"现场:200 条明细(形状合法,只是旧版本不裁)。
      // ⚠️ **为什么用这条路径而不是"连压 50 次"**:迟滞状态机决定压缩频率
      //    (`rearmLevel = trigger − keepRecent − margin` —— 压完要等水位落回重武装线才允许再压),
      //    70 轮实测只压得动 4 次。判据要的是**"上限这一条真的在跑"**,不是"压缩有多频繁";
      //    而"旧库 200 条 + 真压一次"正好同时覆盖**读进来裁**与**追加时裁**两个消费端。
      const legacy = Array.from({ length: 200 }, (_, i) => ({
        // coveredThrough 取负值:旧条目要**显然更早**于这次真跑压出来的那些,
        // 否则"覆盖位只向前"这条不变量会被夹具自己破坏(第一版就写成了 1..200)。
        at: i, usage: null, coveredThrough: -10000 + i, layer: 1 }));
      store.setMeta('own-engine:v1:k', JSON.stringify({ version: 1, summary: '', coveredId: 0, resetId: 0,
        lastAt: null, armed: true, compactionCalls: legacy, compactFailAt: null }));
      for (let i = 0; i < COMPACTION_CALLS_KEPT; i += 1) {
        await engine.runTurn('k', `第${i}句` + '内容'.repeat(6));
      }
      assert.ok(summaryCalls.length >= 1,
        `前提:这段真跑里至少要发生一次压缩(实际 ${summaryCalls.length} 次)—— 否则"追加时裁"没被打中`);
      const saved = JSON.parse(store.getMeta('own-engine:v1:k'));
      assert.ok(Array.isArray(saved.compactionCalls));
      assert.equal(saved.compactionCalls.length, COMPACTION_CALLS_KEPT,
        `落盘的数组必须停在上限(${COMPACTION_CALLS_KEPT}),实际 ${saved.compactionCalls.length} —— 反证:改回 push 且读盘不裁 ⇒ 这里 200+`);
      // 留下的必须是**最近**那批:旧条目 at=0..199,新压出来的排在它们后面。
      const last = saved.compactionCalls.at(-1);
      assert.ok(last.at >= 200, `最近一条是新压出来的(实际 at=${last.at}),不是旧数组里的老条目`);
      assert.ok(Number.isSafeInteger(last.coveredThrough) && last.coveredThrough > 0, '最近一条要带 coveredThrough');
      assert.ok(last.layer === 1 || last.layer === 2, '层号只许 1 或 2');
      // 窗口内部**单调**:覆盖位只向前推进(裁剪不许把顺序搞乱)。
      // ⚠️ 别断言"at 连续递增" —— 旧条目与新条目的 at 量级不同(旧的是序号),那是夹具的锅不是实现的。
      const covered = saved.compactionCalls.map((c) => c.coveredThrough);
      assert.deepEqual(covered, [...covered].sort((a, b) => a - b), '覆盖位非递减(压缩只向前推进)');
      assert.ok(covered.at(-1) > 0, '最近一条的覆盖位要落在真实的轮 id 上(不是夹具里那些负数)');
      // 上限是**持久结构**的事:meta 行不能随轮数单调膨胀。
      const bytes = Buffer.byteLength(store.getMeta('own-engine:v1:k'), 'utf8');
      assert.ok(bytes < 200_000, `meta 行要有界(实际 ${bytes} 字节)`);
    } finally {
      await engine?.stop();
      store.close();
      await cleanupDir(dir);
    }
  });

  test('compactionCalls(F8):旧库里那份无上限的数组,读进来就被裁到上限', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-legacy-'));
    const personaPath = path.join(dir, 'persona.txt');
    fs.writeFileSync(personaPath, '人设');
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    let engine;
    try {
      // 造一份"旧版本留下的"meta:200 条明细(形状合法,只是没有上限)。
      const legacy = Array.from({ length: 200 }, (_, i) => ({ at: i, usage: null, coveredThrough: i + 1, layer: 1 }));
      store.setMeta('own-engine:v1:k', JSON.stringify({ version: 1, summary: '', coveredId: 0, resetId: 0,
        lastAt: null, armed: true, compactionCalls: legacy, compactFailAt: null }));
      engine = createOwnEngine({ store, personaPath, budget: null,
        llm: { async chat() { return { text: '答了', usage: null, finishReason: 'stop' }; } } });
      await engine.initialize();
      await engine.runTurn('k', '随便一句'); // 触发 stateFor → 读盘 → 裁
      const saved = JSON.parse(store.getMeta('own-engine:v1:k'));
      assert.equal(saved.compactionCalls.length, COMPACTION_CALLS_KEPT, '旧库也要被裁(不许继续背着 200 条)');
      assert.equal(saved.compactionCalls.at(-1).coveredThrough, 200, '留的是最近那一批');
    } finally {
      await engine?.stop();
      store.close();
      await cleanupDir(dir);
    }
  });
}
