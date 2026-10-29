/**
 * **桥生命体征判据**(`src\bridge-vitals.js` + 收发两侧接线;1.168.0 / D275)。
 *
 * 跑法:
 *
 *     node scripts\selftest-vitals.js
 *
 * 钉四层:
 *   ① 纯函数:计数器形状、stale 判定三态(**没数据 = unknown,不许读成 fresh**)、
 *     阈值边界(恰好 = fresh)、原子写不留 .tmp;
 *   ② 出站接线:QqApi 的两个消息出口真的记账(fetch 换成假的,真跑代码路径)——
 *     成功 / HTTP 错 / 网络错 各归各;
 *   ③ 老库迁移:没有 model 列的 own_llm_call 打开后补上,**老行如实 NULL**(不猜模型);
 *   ④ 梦境聚合口:dream_msg.meta 的 usage 出来,没账的行如实 null(不计零);
 *   ⑤ 入站接线:假 fetch + 假 WebSocket 造一个**真的 QqGateway**,把帧从 `start()`
 *      建好的套接字喂进去,走真实分发(READY/RESUMED 只记事件、消息事件两本账)——
 *      不再只测 recorder 自己(自证),也不靠"真启动"补这一刀。
 *
 * ⚠️ ⑤ 覆盖的是连接建立**之后**的分发路径;`main()` 的装配与真网关仍由真启动判据验
 *    (横幅起来后 `data\<bot>\bridge-status.json` 出现且随事件推进 —— selftest.js
 *    的纪律:单测不覆盖 main() 装配,真启动才算数)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createBridgeVitals, judgeStaleness, shouldWarnVitalsFailure, writeStatusAtomic, DEFAULT_STALE_AFTER_MS } from '../src/bridge-vitals.js';
import { QqApi, QqGateway } from '../src/qq.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { createDreamStore } from '../src/dream-store.js';
import { estimateCostCny } from '../src/usage-account.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 造一份关得干净的临时库。 */
function withTempStore(label, run) {
  const dir = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), `qqbot-vitals-${label}-`));
  const store = new SqliteStateStore(path.join(dir, 'state.db'));
  try {
    return run(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ① 纯函数
// ---------------------------------------------------------------------------

test('vitals:计数器把"见过什么/发过什么"分开记,快照只有计数与时刻', () => {
  const v = createBridgeVitals({ now: () => 1000 });
  v.noteEvent('READY', 1100);
  v.noteEvent('GROUP_MEMBER_ADD', 1200);
  v.noteMessage('GROUP_AT_MESSAGE_CREATE', 1300);
  v.noteSend(true, 1400);
  v.noteSend(false, 1500);
  v.noteSend(true, 1600);
  const snap = v.snapshot(1700);
  assert.equal(snap.startedAt, 1000);
  assert.equal(snap.lastEventAt, 1200, '最后事件 = 入群那次(后到的覆盖)');
  assert.equal(snap.lastEventType, 'GROUP_MEMBER_ADD');
  assert.equal(snap.lastMessageAt, 1300, '消息事件单独一本账');
  assert.equal(snap.lastMessageType, 'GROUP_AT_MESSAGE_CREATE');
  assert.deepEqual(
    { attempts: snap.sendAttempts, ok: snap.sendOk, failed: snap.sendFailed, lastOk: snap.lastSendOkAt, lastFail: snap.lastSendFailAt },
    { attempts: 3, ok: 2, failed: 1, lastOk: 1600, lastFail: 1500 },
  );
  assert.equal(snap.capturedAt, 1700);
  // 快照里不许混进身份/内容:字段白名单之外的键出现 = 有人往探针里塞东西了。
  const allowed = new Set([
    'startedAt', 'lastEventAt', 'lastEventType', 'lastMessageAt', 'lastMessageType',
    'sendAttempts', 'sendOk', 'sendFailed', 'lastSendOkAt', 'lastSendFailAt', 'capturedAt',
  ]);
  for (const key of Object.keys(snap)) {
    assert.ok(allowed.has(key), `快照出现了白名单之外的字段 ${key} —— 探针只许有计数与时刻`);
  }
  // 双审 Y10:两个**出口**也要钉白名单 —— 此前只有 snapshot() 被钉住,
  // bridge-status.json(快照+verdict/reason+bot/pid)一直没人守。
  const fileShape = { ...snap, ...judgeStaleness(snap, { now: 1700 }), bot: 'fixture-vitals-bot', pid: 1234 };
  assert.deepEqual(
    Object.keys(fileShape).sort(),
    [...allowed, 'verdict', 'reason', 'bot', 'pid'].sort(),
    'Y10:bridge-status.json 只许 15 键(快照 11 + verdict/reason + bot/pid)',
  );
  const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /writeStatusAtomic\(vitalsFile, \{\s*\.\.\.snap,\s*\.\.\.judgeStaleness\(snap, \{ now: Date\.now\(\) \}\),\s*bot: path\.basename\(path\.dirname\(String\(config\.policy\.stats\.dbFile\)\)\),\s*pid: process\.pid,/,
    'Y10:文件出口的装配形状必须与白名单一致(加字段会被这条咬到)');
});

test('vitals:判定三态 —— 没数据 = unknown(不许读成 fresh),窗口内 fresh,超窗 stale', () => {
  // 没数据:启动以来一条消息都没见过 —— "不知道"不是"很好"(与 metrics 的 null ≠ 0 同一条纪律)。
  assert.equal(judgeStaleness({ lastMessageAt: null }, { now: 99_999_999 }).verdict, 'unknown');
  assert.equal(judgeStaleness({}, { now: 99_999_999 }).verdict, 'unknown');
  // 时钟倒挂(最后消息在未来):不判,如实说。
  assert.equal(judgeStaleness({ lastMessageAt: 5_000 }, { now: 4_000 }).verdict, 'unknown');

  const snap = { lastMessageAt: 5_000 };
  // 恰好压线 = fresh(阈值是"超过才算")。
  assert.equal(judgeStaleness(snap, { now: 5_000 + DEFAULT_STALE_AFTER_MS }).verdict, 'fresh');
  // 超 1ms = stale —— 判据必须能红,边界钉在毫秒上。
  assert.equal(judgeStaleness(snap, { now: 5_000 + DEFAULT_STALE_AFTER_MS + 1 }).verdict, 'stale');
  // stale 的 reason 里带得有人话(面板/巡检直接展示)。
  const stale = judgeStaleness(snap, { now: 5_000 + DEFAULT_STALE_AFTER_MS + 1 });
  assert.match(stale.reason, /聋/, 'stale 的理由要说出"她可能聋了"这句人话');
  // 阈值是 `staleAfterMs` 参数(纯函数可传,判据用它钉边界);⚠️ 生产**没有** env/config
  // 入口 —— 要改默认阈值,就是改 `src\bridge-vitals.js` 里的 `DEFAULT_STALE_AFTER_MS` 再重启。
  assert.equal(judgeStaleness(snap, { now: 5_000 + 120_000, staleAfterMs: 60_000 }).verdict, 'stale');
});

test('vitals:原子写 —— 读回一致、不留 .tmp;快照+判定组合写进文件后能原样读回', () => {
  const file = path.join(fileURLToPath(new URL('../../', import.meta.url)), `qqbot-vitals-write-${process.pid}-${Date.now()}.json`);
  try {
    const v = createBridgeVitals({ now: () => 7_000 });
    v.noteMessage('GROUP_AT_MESSAGE_CREATE', 6_000);
    const snap = v.snapshot(() => 7_000);
    writeStatusAtomic(file, { ...snap, ...judgeStaleness(snap, { now: 7_000 }) });
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(back.lastMessageAt, 6_000);
    assert.equal(back.verdict, 'fresh');
    assert.equal(fs.existsSync(`${file}.tmp`), false, '原子写不许留下 .tmp(读到半截 JSON 的口子)');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('vitals:写失败要清掉残留 .tmp;失败告警按 1/10/100/每1000 节流(双审 Y16)', () => {
  // 让 rename 失败:目标路径已经是个**目录**(Windows 上 rename 到已存在目录会报错)。
  // 先确认写 tmp 成功、rename 失败,再看 .tmp 有没有被收拾掉。
  const dir = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'qqbot-vitals-fail-'));
  const target = path.join(dir, 'bridge-status.json');
  try {
    fs.mkdirSync(target);
    assert.throws(() => writeStatusAtomic(target, { at: 1 }), '目标不可写时必须如实抛错');
    assert.equal(fs.existsSync(`${target}.tmp`), false, 'Y16:写失败后不许把半截 .tmp 留在盘上');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 30 秒一拍:每天 2880 条 warn 会淹掉真问题,只在这些次数喊。
  const warned = [];
  for (let n = 1; n <= 2000; n += 1) if (shouldWarnVitalsFailure(n)) warned.push(n);
  assert.deepEqual(warned, [1, 10, 100, 1000, 2000], `Y16:告警节流点不对:${warned.join(',')}`);
  assert.equal(shouldWarnVitalsFailure(0), false);
  assert.equal(shouldWarnVitalsFailure(2), false);
});

// ---------------------------------------------------------------------------
// ② 出站接线(QqApi 的两个消息出口;fetch 换假的,真跑代码路径)
// ---------------------------------------------------------------------------
/** 换掉全局 fetch 跑一段(用完必还原 —— 别把别的用例的网断掉)。 */
async function withFetch(impl, run) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * 换掉全局 fetch + WebSocket,真跑一遍 QqGateway 的建连与分发。
 *
 * 不碰任何私有方法:只从公开的 `start()` 连上假套接字,再把 JSON 帧喂给它的
 * `message` 监听器 —— 走的正是网关真实的 `#onFrame → #onDispatch` 那条路。
 * 喂的是**帧**(拿到的原始字符串),不是直接调 `#onDispatch`,所以这判据能发现
 * "帧解析/opcode 分派"那一层的错,而不只是记录器本身的算术。
 */
async function withFakeGateway({ vitals }, run) {
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;
  let resolveSocket;
  const socketReady = new Promise((resolve) => { resolveSocket = resolve; });

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1; // OPEN —— #send 会照常把帧塞进 sent
      this.listeners = new Map();
      this.sent = [];
      resolveSocket(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) { this.sent.push(raw); }
    close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
    /** 把一帧喂给真实的 `message` 监听器(= 网关的 `#onFrame`)。 */
    feed(frame) {
      for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
    }
  }

  // 只服务 `#gatewayUrl()`:给它一个网关地址,其余请求不许发生。
  globalThis.fetch = async () => new Response(JSON.stringify({ url: 'ws://fake-gateway' }), { status: 200 });
  globalThis.WebSocket = FakeWebSocket;
  const gateway = new QqGateway({ tokens: { get: async () => 'token-x' }, apiBase: 'http://fake', intents: 0, vitals });
  try {
    const messages = [];
    gateway.on('message', (message) => messages.push(message));
    gateway.start();
    const ws = await socketReady;
    return await run({ gateway, ws, messages });
  } finally {
    gateway.stop();
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
  }
}

test('vitals:QqApi 出口把"平台接受了 / 拒了 / 网断了"各记一笔', async () => {
  const v = createBridgeVitals();
  const api = new QqApi({ tokens: { get: async () => 'token-x' }, apiBase: 'http://127.0.0.1:9', vitals: v });

  // 平台接受(200):记成功。
  await withFetch(async () => new Response(JSON.stringify({}), { status: 200 }), () => api.sendMedia({ openid: 'o', fileInfo: 'f' }));
  let snap = v.snapshot();
  assert.deepEqual({ attempts: snap.sendAttempts, ok: snap.sendOk, failed: snap.sendFailed }, { attempts: 1, ok: 1, failed: 0 });

  // 平台拒(HTTP 500):记失败,错误照抛(统计不许吞错)。
  await assert.rejects(
    withFetch(async () => new Response(JSON.stringify({ message: 'no' }), { status: 500 }), () => api.sendMedia({ openid: 'o', fileInfo: 'f' })),
  );
  snap = v.snapshot();
  assert.equal(snap.sendFailed, 1, 'HTTP 错要记失败');

  // 网断(fetch 抛):也记失败。
  await assert.rejects(
    withFetch(async () => { throw new TypeError('boom'); }, () => api.sendMedia({ openid: 'o', fileInfo: 'f' })),
  );
  snap = v.snapshot();
  assert.deepEqual({ attempts: snap.sendAttempts, ok: snap.sendOk, failed: snap.sendFailed }, { attempts: 3, ok: 1, failed: 2 });
  assert.ok(snap.lastSendFailAt !== null, '最后一次失败的时刻要记下');
});

test('vitals:QqGateway 构造向后兼容 —— 不传 vitals 也照常建(现有调用一个不许破)', () => {
  const gateway = new QqGateway({ tokens: { get: async () => 't' }, apiBase: 'http://x', intents: 0 });
  assert.ok(gateway, '不带 vitals 的构造(老形状)不许炸');
  const gateway2 = new QqGateway({ tokens: { get: async () => 't' }, apiBase: 'http://x', intents: 0, vitals: createBridgeVitals() });
  assert.ok(gateway2, '带 vitals 的构造(新形状)不许炸');
});

test('vitals:真实分发 —— READY/RESUMED 记事件但不记消息,消息事件两本都记(Y19)', async () => {
  const v = createBridgeVitals();
  await withFakeGateway({ vitals: v }, async ({ ws, messages }) => {
    // READY:连接生命周期事件 —— 证明"连上了",不证明"收得到消息"。
    ws.feed({ op: 0, s: 1, t: 'READY', d: { session_id: 'session-1', user: { id: 'bot-id', username: '示例助手' } } });
    let snap = v.snapshot();
    assert.equal(snap.lastEventType, 'READY',
      'READY 在 dispatch 里提前 return —— 事件计数必须放在 return 之前,否则连接活着这件事没人记(Y19)');
    assert.notEqual(snap.lastEventAt, null, 'READY 要留下 lastEventAt');
    assert.equal(snap.lastMessageAt, null, 'READY 不是消息事件 —— 不许记进消息账(生命周期/ACK 不算"收得到")');
    assert.equal(snap.lastMessageType, null);

    // RESUMED:重连恢复,同样证明连接活着(与 READY 走同一个提前 return)。
    ws.feed({ op: 0, s: 2, t: 'RESUMED', d: {} });
    snap = v.snapshot();
    assert.equal(snap.lastEventType, 'RESUMED', 'RESUMED 也要计数 —— 它和 READY 一样在 return 之前');
    assert.equal(snap.lastMessageAt, null, 'RESUMED 也不是消息事件');

    // 真消息事件:两本账都记 —— 事件账(来过东西)+ 消息账("收得到"的唯一证据)。
    ws.feed({
      op: 0, s: 3, t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'msg-1',
        content: '@示例助手 在吗',
        group_openid: 'group-1',
        author: { member_openid: 'member-1', username: '旅人' },
        timestamp: new Date().toISOString(),
      },
    });
    snap = v.snapshot();
    assert.equal(snap.lastEventType, 'GROUP_AT_MESSAGE_CREATE');
    assert.equal(snap.lastMessageType, 'GROUP_AT_MESSAGE_CREATE',
      '真消息事件要记进消息账 —— noteMessage 的位置与条件不变(消息类才记)');
    assert.notEqual(snap.lastMessageAt, null, '收到过消息 = 判"聋没聋"的唯一证据');
    assert.equal(messages.length, 1, '真实分发要一路走到 emit("message"),不只是记账');
  });
});

test('vitals:文本出口取 token 失败与富媒体记同一笔 —— 两条消息出口对称(Y17)', async () => {
  class TokenGetError extends Error {}
  const tokenError = new TokenGetError('模拟取 access_token 失败');
  const tokens = { get: async () => { throw tokenError; } };
  const noFetch = async () => { throw new Error('取 token 就失败了,不该走到 fetch'); };
  const counters = (v) => {
    const snap = v.snapshot();
    return { attempts: snap.sendAttempts, ok: snap.sendOk, failed: snap.sendFailed };
  };

  // 文本出口(#post):取票失败 = 一次发送失败,异常原样上抛。
  const textVitals = createBridgeVitals();
  const textApi = new QqApi({ tokens, apiBase: 'http://127.0.0.1:9', vitals: textVitals });
  await assert.rejects(
    withFetch(noFetch, () => textApi.sendGroup('group-1', { content: '你好' })),
    (err) => err === tokenError,
    '异常要原样抛出(类型/文案/重试路径都不许改)',
  );
  assert.deepEqual(counters(textVitals), { attempts: 1, ok: 0, failed: 1 },
    '文本出口取 token 失败也要记一次失败 —— 与 sendMedia 对称(Y17)');

  // 富媒体出口(sendMedia):现状就记 1 次失败,作为对照/锚。
  const mediaVitals = createBridgeVitals();
  const mediaApi = new QqApi({ tokens, apiBase: 'http://127.0.0.1:9', vitals: mediaVitals });
  await assert.rejects(
    withFetch(noFetch, () => mediaApi.sendMedia({ scene: 'group', openid: 'group-1', fileInfo: 'file-info' })),
    (err) => err === tokenError,
  );
  assert.deepEqual(counters(mediaVitals), { attempts: 1, ok: 0, failed: 1 },
    '富媒体出口照旧记一次失败 —— 对称不是把它改坏');
});

// ---------------------------------------------------------------------------
// ③④ store:老库迁移 + 梦境聚合口
// ---------------------------------------------------------------------------

test('vitals:老库(own_llm_call 没有 model 列)打开后补列,老行如实 NULL —— 不按当前配置猜', () => {
  const dir = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'qqbot-vitals-migrate-'));
  const dbFile = path.join(dir, 'old.db');
  try {
    // 造一份"迁移前"的旧形状库:手写 1.167.5 时代的表结构,塞一行老账。
    const raw = new DatabaseSync(dbFile);
    raw.exec(`
      CREATE TABLE own_llm_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        usage TEXT,
        error TEXT
      );
    `);
    raw.prepare("INSERT INTO own_llm_call (key,kind,at,status,usage) VALUES ('k','reply',123,'completed',?)")
      .run(JSON.stringify({ promptTokens: 10, completionTokens: 2, cacheHitTokens: 8, cacheMissTokens: 2 }));
    raw.close();

    const store = new SqliteStateStore(dbFile);
    try {
      const columns = store.handle.prepare('PRAGMA table_info(own_llm_call)').all().map((row) => row.name);
      assert.ok(columns.includes('model'), '打开旧库后 own_llm_call 必须补上 model 列');
      const rows = store.ownLlmCalls({ since: 0 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].model, null, '老行的模型如实 NULL —— 报表按"模型未知"列,不许按当前配置回填');
      // 新结算带 model:写入并读回。
      const id = store.startOwnLlmCall({ key: 'k2', kind: 'reply', at: 456 });
      store.finishOwnLlmCall(id, {
        status: 'completed', at: 457, model: 'deepseek-flash',
        usage: { promptTokens: 10, completionTokens: 2, cacheHitTokens: 8, cacheMissTokens: 2 },
      });
      const again = store.ownLlmCalls({ since: 0 }).find((row) => row.id === id);
      assert.equal(again.model, 'deepseek-flash');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vitals:dreamUsageSince —— 梦境的账从 dream_msg.meta 出来,没账的行如实 null', () => {
  withTempStore('dream', (store) => {
    const dreams = createDreamStore({ store });
    dreams.appendMsg({ roomId: 'r1', role: 'assistant', name: '示例助手', content: '带账的梦话', meta: { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } });
    dreams.appendMsg({ roomId: 'r1', role: 'user', name: '旅人', content: '玩家的话(不算)', meta: null });
    dreams.appendMsg({ roomId: 'r1', role: 'assistant', name: '示例助手', content: '没账的梦话', meta: null });

    const rows = store.dreamUsageSince({ since: 0 });
    assert.equal(rows.length, 2, '只收 assistant 行(user 行不是模型的账)');
    assert.equal(rows[0].usage?.promptTokens, 10);
    assert.equal(rows[1].usage, null, '没账的行如实 null —— 报表把它单列,不许计零');
  });
});

test('vitals:报表折价的口径锚 —— estimateCostCny 对同一条账出的数,就是报表该出的数', () => {
  // 这条钉的是"报表与口径是同一份":期望值现场用 estimateCostCny 算
  // (价目本身的正确性由 selftest-rate-cards 钉,不在这里重复)。
  const usage = { promptTokens: 1000, completionTokens: 500, cacheHitTokens: 800, cacheMissTokens: 200 };
  const at = Date.now();
  const expected = estimateCostCny({
    model: 'deepseek-flash', at,
    cacheMissTokens: usage.cacheMissTokens, cacheHitTokens: usage.cacheHitTokens, completionTokens: usage.completionTokens,
  });
  assert.ok(expected && expected.cny > 0, '可计价账必须折出正数(计零的报表永远"便宜")');
  assert.equal(expected.currency, 'CNY', '记账币种是 ¥(口径纪律①)');
});

export function registerVitalsTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerVitalsTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果(selftest.js 是主入口,这条只是方便单文件复跑)。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
