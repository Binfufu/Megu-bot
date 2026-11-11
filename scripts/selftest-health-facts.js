/**
 * 健康事实的状态机与生命周期(C 刀 A,2026-11-11)。
 *
 * 现场(2026-11-02):主人一个月前说过一次胃疼,普通私聊仍被当成"现在不舒服";
 * 他说「我没事啊」,她还在坚持。诊断确认这一层的四个洞:
 *   ① 健康只做 includes:否定/问句/第三人一律记成"自己病了";
 *   ② short 只是标签,没有生命周期,旧症状永远算"现在";
 *   ③ 康复("我不胃疼了"/"我没事")抽不出来;
 *   ④ 不同症状会整维互相替代(胃病被胃疼顶掉)。
 *
 * 本套件用**真实纯函数 + 真实 SQLite + 真实引擎**钉住新口径(不读源码猜行为):
 *   · 抽取矩阵(正/反/问/第三人/泛化恢复);
 *   · 落库生命周期(过期退出、恢复、否认、并存、回扫不刷新、mined 不复活);
 *   · 渲染(过去自述、当前说法优先)与最终 messages(消费端);
 *   · 老库迁移(补四列,老行不丢)。
 *
 * ⚠️ 判据要能红:把 `factVisible` 的窗口判断或 `extractHealthSignals` 的否定分支去掉,
 *    本套件必须变红(开发时已做过撤修复反证)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { withFacts } from '../src/style.js';
import {
  extractFacts,
  extractHealthSignals,
  factVisible,
  healthDenialLine,
  parseEventTime,
  renderFacts,
} from '../src/profile.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WINDOW = 72 * HOUR;

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-health-${tag}-`));
}
function cleanup(dir) {
  // Windows 上 SQLite 关闭与杀软扫描可能短暂持有句柄:重试几次,别让"清临时目录"变成假红。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** 老库的 fact 表形状(C 刀 A 之前:没有 state/resolved_at/onset_at/event_at)。 */
const LEGACY_FACT_SCHEMA = `
  CREATE TABLE fact (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope      TEXT NOT NULL,
    subject    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    detail     TEXT,
    source     TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    superseded_by INTEGER,
    merged_into INTEGER,
    invalid_at INTEGER
  );
  CREATE UNIQUE INDEX idx_fact_key ON fact(scope, subject, kind, value);
  CREATE INDEX idx_fact_seen ON fact(last_seen DESC);
`;

export function registerHealthFactTests({ test, assert: _assert }) {
  test('健康语义:否定/问句/第三人/恢复都不再记成"自己病了"', () => {
    const kinds = (text) => extractFacts(text).map((fact) => `${fact.kind}:${fact.value}/${fact.detail}`);
    // 正向自述照收
    assert.deepEqual(kinds('我胃疼'), ['health:胃疼/short']);
    assert.deepEqual(kinds('我感冒了'), ['health:感冒/short']);
    assert.deepEqual(kinds('我确诊了癌症，下个月化疗'), ['health:癌症/serious'], 'serious 词表里同一件事只取一个');
    // 否定/恢复:不产出正向事实
    assert.deepEqual(kinds('我不胃疼了'), []);
    assert.deepEqual(kinds('我没有胃疼'), []);
    assert.deepEqual(kinds('我胃已经不疼了'), []);
    assert.deepEqual(kinds('胃疼已经好了'), []);
    // 问句 / 第三人:不许挂到说话人自己头上
    assert.deepEqual(kinds('你胃疼吗？'), []);
    assert.deepEqual(kinds('他胃疼'), []);
    assert.deepEqual(kinds('她最近感冒了'), []);
    // 语义事件仍要保留,交给更新路径(而不是"抽不到就什么都不做")
    const signals = extractHealthSignals('我不胃疼了');
    assert.equal(signals.events.length, 1);
    assert.equal(signals.events[0].polarity, 'resolved');
    assert.equal(extractHealthSignals('我没有胃疼').events[0].polarity, 'refuted');
    assert.equal(extractHealthSignals('你胃疼吗？').events[0].question, true);
    assert.equal(extractHealthSignals('他胃疼').events[0].subject, 'other');
    // 泛化恢复:只认整小句;「好了,走吧」不是病好了
    assert.equal(extractHealthSignals('我没事啊').generic, 'denial');
    assert.equal(extractHealthSignals('我没事啊').genericBody, true, '「我没事」是在说身体');
    assert.equal(extractHealthSignals('已经好了').generic, 'recovery');
    assert.equal(extractHealthSignals('已经好了').genericBody, false, '「已经好了」可能是别的事,不许顺手收尾症状');
    assert.equal(extractHealthSignals('好了,走吧').generic, null);
    assert.equal(extractHealthSignals('他没事').generic, null, '别人没事不是他的健康状态');
    // 复核补充:问句变体 / 家属第三人
    assert.equal(extractHealthSignals('我是不是胃疼').events[0].question, true, 'A-not-A 也是问句,不许当否认');
    assert.equal(extractHealthSignals('我感冒好了没').events[0].question, true);
    assert.equal(extractHealthSignals('我妈胃疼').events[0].subject, 'other', '家属的病不能挂到说话人身上');
    assert.equal(extractHealthSignals('我家的猫拉肚子').events[0].subject, 'other');
    // 同句「我没事,就是有点头晕」:症状仍要报出来(不能因为"没事"被吞掉)
    const mixed = extractHealthSignals('我没事，就是有点头晕');
    assert.equal(mixed.events.some((event) => event.value === '头晕' && event.polarity === 'active'), true, mixed.events);
  });

  test('健康生命周期:过期的 short 退出当前事实,慢性仍作为长期背景;恢复/否认退出', () => {
    const dir = tempDir('life');
    try {
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      const scope = 'c2c:1';
      const now = Date.now();
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'told', state: 'active', eventAt: now - 32 * DAY }, now - 32 * DAY);
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃炎', detail: 'chronic', source: 'told', state: 'active', eventAt: now - 32 * DAY }, now - 32 * DAY);
      const rows = store.facts({ scope });
      assert.equal(rows.length, 2, '数据一条都不许丢');
      const visible = rows.filter((fact) => factVisible(fact, { now, healthWindowMs: WINDOW }));
      assert.deepEqual(visible.map((fact) => fact.value), ['胃炎'], '32 天前的 short 不再冒充现在;慢性仍是背景');
      // 恢复:short 退出(物理行保留,只标 state/invalid_at)
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃炎', detail: 'chronic', source: 'told', state: 'resolved', eventAt: now }, now);
      assert.equal(store.facts({ scope }).some((fact) => fact.value === '胃炎'), false, '恢复后不进当前事实');
      assert.equal(store.facts({ scope, latestOnly: false }).some((fact) => fact.value === '胃炎'), true, '旧行仍可审计');
      // 否认:已有行退出,且不新建"病好了"这种事实
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'told', state: 'refuted', eventAt: now }, now);
      assert.equal(store.facts({ scope }).length, 0);
      assert.equal(store.facts({ scope, latestOnly: false }).length, 2, '否认/恢复只更新已有两行,没有新增');
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  test('健康并存:不同症状不再互相软失效(胃病+感冒/胃病+胃疼)', () => {
    const dir = tempDir('coexist');
    try {
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      const scope = 'c2c:1';
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃炎', detail: 'chronic', source: 'told', state: 'active' });
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '感冒', detail: 'short', source: 'told', state: 'active' });
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'told', state: 'active' });
      assert.deepEqual(store.facts({ scope }).map((fact) => fact.value).sort(), ['感冒', '胃炎', '胃疼']);
      assert.equal(store.factStats().invalid, 0, '一条都不许被整维替代');
      // 对照:关系维度仍是"改口就退役旧说法"(旧行为不许被这刀改掉)
      store.touchFact({ scope, subject: 'self', kind: 'relation', value: '弟弟', source: 'told' });
      const next = store.touchFact({ scope, subject: 'self', kind: 'relation', value: '哥哥', source: 'told' });
      assert.equal(next.superseded.length, 1, '关系改口照旧软失效旧说法');
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  test('历史回扫:旧消息不许刷新 last_seen、mined 不许复活已恢复的症状', () => {
    const dir = tempDir('mined');
    try {
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      const scope = 'c2c:1';
      const now = Date.now();
      const old = now - 30 * DAY;
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'told', state: 'active', eventAt: now - 3 * DAY }, now - 3 * DAY);
      const before = store.facts({ scope })[0].lastSeen;
      // 回扫 30 天前的旧消息:eventAt 早于已记事件 → 不刷新
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'mined', state: 'active', eventAt: old }, now);
      assert.equal(store.facts({ scope })[0].lastSeen, before, '旧消息不许把"最近一次自述"往前拉');
      // 恢复后 mined 不许复活
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'told', state: 'resolved', eventAt: now }, now);
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'mined', state: 'active', eventAt: now }, now);
      assert.equal(store.facts({ scope }).some((fact) => fact.value === '胃疼'), false, 'mined 不许复活');
      // 本人再说一次 → 复活
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'told', state: 'active', eventAt: now }, now);
      assert.equal(store.facts({ scope }).some((fact) => fact.value === '胃疼' && fact.state === 'active'), true, 'told 可以复活');
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  test('渲染:健康行必须带"过去自述"边界与"当前说法优先";过期/恢复行不出现', () => {
    const now = Date.now();
    const stale = { kind: 'health', value: '胃疼', detail: 'short', subject: 'self', lastSeen: now - 32 * DAY, state: 'active' };
    const fresh = { kind: 'health', value: '感冒', detail: 'short', subject: 'self', lastSeen: now - 2 * HOUR, state: 'active' };
    const chronic = { kind: 'health', value: '胃炎', detail: 'chronic', subject: 'self', lastSeen: now - 32 * DAY, state: 'active' };
    const resolved = { kind: 'health', value: '牙疼', detail: 'short', subject: 'self', lastSeen: now - HOUR, state: 'resolved' };
    const visible = [stale, fresh, chronic, resolved].filter((fact) => factVisible(fact, { now, healthWindowMs: WINDOW }));
    const rendered = renderFacts(visible, { now, currentSubject: 'self', healthWindowMs: WINDOW });
    assert.ok(!rendered.includes('胃疼'), rendered);
    assert.ok(!rendered.includes('牙疼'), rendered);
    assert.ok(rendered.includes('感冒') && rendered.includes('之后未再确认'), rendered);
    assert.ok(rendered.includes('胃炎') && rendered.includes('长期背景'), rendered);
    assert.ok(rendered.includes('过去的自述，不代表现在'), '必须给模型一条时态边界');
    assert.ok(rendered.includes('他当前说自己没事'), '必须说明当前说法优先');
    // 否认提示:窗口内出现,过期消失
    const line = healthDenialLine(now - HOUR, { now, windowMs: 48 * HOUR });
    assert.ok(line.includes('明确说过自己当前没事'), line);
    assert.equal(healthDenialLine(now - 49 * HOUR, { now, windowMs: 48 * HOUR }), '', '过期提示不许常驻');
    assert.equal(healthDenialLine(0, { now, windowMs: 48 * HOUR }), '', '没有记录就不加提示');
  });

  test('最终 messages:32 天前的胃疼不再出现在本轮请求里;否认后出现"以当前说法为准"', async () => {
    const dir = tempDir('engine');
    try {
      const personaPath = path.join(dir, 'AGENTS.md');
      fs.writeFileSync(personaPath, '离线判据用临时角色。', 'utf8');
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      const calls = [];
      const clock = { now: Date.now() };
      const engine = createOwnEngine({
        store, personaPath, budget: null, now: () => clock.now,
        log: { info() {}, warn() {} },
        llm: { async chat(messages) { calls.push(structuredClone(messages)); return { text: '判据夹具回复', usage: null }; } },
      });
      await engine.initialize();
      const key = 'qqbot-c2c-health';
      const scope = 'c2c:1';
      const old = clock.now - 32 * DAY;
      store.touchFact({ scope, subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'told', state: 'active', eventAt: old }, old);
      store.appendConversationTurn({ key, role: 'user', content: '我胃疼', at: old });
      store.appendConversationTurn({ key, role: 'assistant', content: '判据夹具旧回复', at: old + 1000 });
      const facts = store.facts({ scope }).filter((fact) => factVisible(fact, { now: clock.now, healthWindowMs: WINDOW }));
      const block = renderFacts(facts, { now: clock.now, currentSubject: 'self', healthWindowMs: WINDOW });
      await engine.runTurn(key, withFacts('看看腿', block ? [block] : []), 5000);
      const last = JSON.stringify(calls.at(-1));
      assert.ok(!last.includes('健康：胃疼'), `过期的健康事实不许进本轮事实块: ${last}`);
      // 用户明确否认后:提示必须出现在本轮,且旧事实仍不冒充当前
      const denial = healthDenialLine(clock.now - HOUR, { now: clock.now, windowMs: 48 * HOUR });
      await engine.runTurn(key, withFacts('我没事啊', [denial]), 5000);
      const denialRequest = JSON.stringify(calls.at(-1));
      assert.ok(denialRequest.includes('我没事啊'), '用户当前说法必须在请求里');
      assert.ok(denialRequest.includes('他当前的说法优先'), `否认提示必须到达模型: ${denialRequest}`);
      assert.ok(!denialRequest.includes('健康：胃疼'), '否认轮也不许把过期旧病当现状');
      await engine.stop();
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  test('老库迁移:补上 state/onset_at/event_at/resolved_at 四列,老行保留且可读', () => {
    const dir = tempDir('migrate');
    try {
      const file = path.join(dir, 'state.db');
      const raw = new DatabaseSync(file);
      raw.exec(LEGACY_FACT_SCHEMA);
      raw.exec(`
        INSERT INTO fact (scope, subject, kind, value, detail, source, first_seen, last_seen, seen_count)
        VALUES ('c2c:1', 'self', 'health', '胃炎', 'chronic', 'told', 1000, 1000, 2)
      `);
      raw.close();
      const store = new SqliteStateStore(file);
      const cols = store.handle.prepare('PRAGMA table_info(fact)').all().map((row) => row.name);
      for (const column of ['state', 'resolved_at', 'onset_at', 'event_at']) assert.ok(cols.includes(column), `缺列 ${column}`);
      const rows = store.facts({ scope: 'c2c:1' });
      assert.equal(rows.length, 1, '老行不许丢');
      assert.equal(rows[0].value, '胃炎');
      assert.equal(rows[0].state, null, '老行 state 留空 = 状态未知,由读路径按旧口径处理');
      // 迁移幂等:再开一次不报错、不重复加列
      store.close();
      const again = new SqliteStateStore(file);
      again.close();
    } finally {
      cleanup(dir);
    }
  });

  test('平台时间解析:ISO/秒/毫秒都认,认不出返回 null(不猜)', () => {
    const iso = '2026-11-02T06:44:00.000Z';
    assert.equal(parseEventTime(iso), Date.parse(iso));
    assert.equal(parseEventTime(1793599440), 1793599440000, '秒 → 毫秒');
    assert.equal(parseEventTime(1793599440000), 1793599440000, '毫秒原样');
    assert.equal(parseEventTime('1793599440'), 1793599440000);
    assert.equal(parseEventTime(''), null);
    assert.equal(parseEventTime('不是时间'), null);
    assert.equal(parseEventTime(-1), null);
  });

  test('接线:真实 index.js 的健康状态机/读取窗口/提示键两端一致(改坏必须被咬住)', () => {
    const source = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    const fnBody = (name) => {
      const start = source.indexOf(`function ${name}(`);
      assert.ok(start >= 0, `找不到 ${name}`);
      return source.slice(start, source.indexOf('\n  }', start));
    };
    /** 真实接线要成立的全部条件;抽成函数是为了能对"改坏的源码"做负对照。 */
    const wiringHolds = (value) => {
      const learn = (() => {
        const start = value.indexOf('function learnFactsFrom(');
        return start < 0 ? '' : value.slice(start, value.indexOf('\n  }', start));
      })();
      const facts = (() => {
        const start = value.indexOf('function factsNote(');
        return start < 0 ? '' : value.slice(start, value.indexOf('\n  }', start));
      })();
      return /extractHealthSignals\(text\)/.test(learn)
        && /forgetMeta\(healthDenialKey\(scope, 'self'\)\)/.test(learn)
        && /preExistingActive/.test(learn)
        && /factVisible\(fact, \{ now, healthWindowMs: memoryCfg\.health\.windowMs \}\)/.test(facts)
        && /healthDenialKey\(scope, currentSubject\)/.test(facts);
    };
    assert.equal(wiringHolds(source), true, '真实 index.js 接线必须成立');
    // 负对照:每改坏一处,判据必须红(不是恒真)。
    assert.equal(wiringHolds(source.replace(
      'factVisible(fact, { now, healthWindowMs: memoryCfg.health.windowMs })',
      'factVisible(fact)',
    )), false, '撤掉读取窗口 → 红');
    assert.equal(wiringHolds(source.replace(
      "stateStore.forgetMeta(healthDenialKey(scope, 'self'));",
      '',
    )), false, '撤掉"新自述清旧提示" → 红');
    assert.equal(wiringHolds(source.replace(
      'healthDenialKey(scope, currentSubject)',
      "healthDenialKey(scope, 'self')",
    )), false, '提示键两端不一致 → 红');
    assert.equal(wiringHolds(source.replace(/extractHealthSignals\(text\)/g, 'extractFacts(text)')), false, '撤掉健康状态机 → 红');
    assert.ok(fnBody('learnFactsFrom').includes('preExistingActive'), 'generic 收尾只能动本条之前的症状');
  });
}
