/**
 * 上下文与派生记忆的时态保真(C 刀 B,2026-11-11)。
 *
 * 现场(2026-11-02):一个月前的「我胃疼」在请求里与今天的话长得一模一样;
 * 摘要/常驻块/洞察都把旧近况写成"最近";模型于是有充分理由相信"他现在不舒服"。
 *
 * 本套件用**真实引擎 + 真实 SQLite**钉住四件事:
 *   ① 逐字历史跨日带日期(同一天不逐行重复,省 token);
 *   ② 摘要材料带时间与"谁说的";
 *   ③ 固化笔记/长期召回/洞察渲染带时间;常驻块与洞察的**输入**不再吃过期中期笔记,
 *      来源全部失效的洞察不再注入;
 *   ④ 现实观察边界同时到达普通回复与定时早安。
 *
 * ⚠️ 判据要能红:去掉 engine 的日期前缀、去掉 TTL 过滤、去掉洞察来源校验,
 *    对应用例必须变红(开发时已做撤修复反证)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOwnEngine, renderSummarySource } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import {
  applyBlockUpdates,
  ensureBlockSchema,
  getMemoryBlocks,
  openMemory,
  recentNotesText,
  renderNotes,
} from '../src/memory-store.js';
import {
  appendInsights,
  ensureInsightSchema,
  latestInsights,
  recentInsightNotes,
  renderInsights,
} from '../src/memory-insights.js';
import { renderRecall } from '../src/memory-tags.js';
import { REALITY_GROUNDING_NOTES } from '../src/style.js';
import { factVisible } from '../src/profile.js';
import { CHAT_INPUT_PROJECTION_VERSION, projectChatInput } from '../src/chat-input-projection.js';
import { ageLabel, formatDay, formatStamp } from '../src/time-label.js';

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-01T02:00:00.000Z'); // 本地 10-01 10:00(Asia/Shanghai)
const NOW = T0 + 32 * DAY;

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-time-${tag}-`));
}
function cleanup(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export function registerMemoryTimeTests({ test, assert: _assert }) {
  test('时间标签:日期/时刻/相对时间同一份口径', () => {
    assert.equal(formatDay(T0, { now: T0 }), '10-01');
    assert.equal(formatDay(T0, { now: NOW }), '10-01', '同一年不补年份');
    assert.equal(formatStamp(T0, { now: T0 }), '10-01 10:00');
    assert.equal(formatDay(NOW + 400 * DAY, { now: NOW }).startsWith('2027-'), true, '跨年补年份');
    assert.equal(ageLabel(30 * 1000), '约1分钟前');
    assert.equal(ageLabel(5 * HOUR), '约5小时前');
    assert.equal(ageLabel(32 * DAY), '约32天前');
    assert.equal(formatDay(0), '');
  });

  test('历史:跨日旧消息才有日期(当天连续对话不加,前缀稳定),原档内容不变', async () => {
    const dir = tempDir('engine');
    try {
      const personaPath = path.join(dir, 'AGENTS.md');
      fs.writeFileSync(personaPath, '判据用临时角色。', 'utf8');
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      const calls = [];
      const clock = { now: T0 };
      const engine = createOwnEngine({
        store, personaPath, budget: null, now: () => clock.now,
        log: { info() {}, warn() {} },
        llm: { async chat(messages) { calls.push(structuredClone(messages)); return { text: '夹具回复', usage: null }; } },
      });
      await engine.initialize();
      const key = 'qqbot-c2c-time';
      await engine.runTurn(key, 'OLD_CANARY 我胃疼', 5000);
      // 同一天再说一句:历史里的旧消息**不加日期** —— 前缀逐字节稳定是缓存命中前提。
      await engine.runTurn(key, 'SAME_DAY_CANARY 早上好', 5000);
      const sameDay = calls.at(-1).map((m) => String(m.content)).join('\n');
      assert.ok(!sameDay.includes(`[${formatDay(T0, { now: T0 })}] OLD_CANARY`), '当天连续对话不逐行加日期(保前缀)');
      assert.ok(sameDay.includes('OLD_CANARY'), '旧消息照常在场');
      // 32 天后:旧消息应带日期、新消息照常;请求里不能有"旧话像刚说"的形状。
      clock.now = NOW;
      await engine.runTurn(key, 'NEW_CANARY 看看腿', 5000);
      const request = calls.at(-1).map((m) => String(m.content)).join('\n');
      assert.ok(request.includes(`[${formatDay(T0, { now: NOW })}] OLD_CANARY`), `跨日旧消息要带发生日期: ${request.slice(0, 500)}`);
      assert.ok(request.includes('NEW_CANARY'), '本轮消息照常');
      // 原档仍是原文(时间前缀只影响本轮输入,不写回历史)。
      const raw = store.conversationTurns(key).map((row) => row.content).join('\n');
      assert.ok(raw.includes('OLD_CANARY') && !raw.includes(`[${formatDay(T0, { now: NOW })}] OLD_CANARY`), 'append-only 原档不许被改写');
      await engine.stop();
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  test('摘要材料:每行带日期与"用户/她",区分谁说的', () => {
    const text = renderSummarySource([
      { role: 'user', content: '我胃疼', at: T0 },
      { role: 'assistant', content: '注意休息', at: T0 + 1000 },
    ], { now: NOW });
    const lines = text.split('\n');
    assert.equal(lines[0], `[${formatStamp(T0, { now: NOW })}] 用户: 我胃疼`);
    assert.equal(lines[1], `[${formatStamp(T0 + 1000, { now: NOW })}] 她: 注意休息`);
    // 图片只报张数,不猜细节(旧纪律不变)
    assert.ok(renderSummarySource([{ role: 'user', content: '看图', at: T0, meta: { images: ['a'] } }], { now: NOW }).includes('附 1 张图片'));
  });

  test('固化笔记/长期召回:逐条带来源日期与长期/近期标记', () => {
    const notes = renderNotes([
      { text: '说好了下次请你吃夜宵', at: T0, tier: 'long' },
      { text: '他最近在加班', at: NOW - HOUR, tier: 'mid' },
    ], { now: NOW });
    assert.ok(notes.includes(`[长期·${formatDay(T0, { now: NOW })}]`), notes);
    assert.ok(notes.includes(`[近期·${formatDay(NOW - HOUR, { now: NOW })}]`), notes);
    const recall = renderRecall([
      { text: '他答应过周末一起吃饭', at: T0 },
    ], { now: NOW });
    assert.ok(recall.includes(`[${formatDay(T0, { now: NOW })}]`), recall);
  });

  test('常驻块/洞察输入:过期中期笔记不进材料,长期/近期材料带日期', () => {
    const dir = tempDir('inputs');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const insert = db.prepare(
          `INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insert.run('c', 's#old-mid', NOW - 40 * DAY, NOW - 40 * DAY, 'mid', 3, '[]', 'OLD_MID_CANARY');
        insert.run('c', 's#fresh-mid', NOW - HOUR, NOW - HOUR, 'mid', 3, '[]', 'FRESH_MID_CANARY');
        insert.run('c', 's#old-long', NOW - 40 * DAY, NOW - 40 * DAY, 'long', 5, '[]', 'OLD_LONG_CANARY');
        const blockInput = recentNotesText(db, { now: NOW, midTtlMs: 3 * DAY, limit: 30 });
        assert.ok(!blockInput.includes('OLD_MID_CANARY'), '过期中期不进常驻块材料');
        assert.ok(blockInput.includes('FRESH_MID_CANARY') && blockInput.includes('OLD_LONG_CANARY'), blockInput);
        assert.ok(blockInput.includes(`[近期·${formatDay(NOW - HOUR, { now: NOW })}]`), '材料带日期');
        assert.ok(blockInput.includes(`[长期·${formatDay(NOW - 40 * DAY, { now: NOW })}]`), '长期也带日期');
        const insightsInput = recentInsightNotes(db, { now: NOW, midTtlMs: 3 * DAY, limit: 30 });
        assert.deepEqual(insightsInput.map((row) => row.text).sort(), ['FRESH_MID_CANARY', 'OLD_LONG_CANARY']);
        assert.ok(insightsInput.every((row) => Number.isFinite(row.at) && row.tier), '输入带源时间与 tier');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('洞察:来源全部失效/过期后不再注入,但物理行仍可审计;混合来源保留', () => {
    const dir = tempDir('insight');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const insert = db.prepare(
          `INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insert.run('c', 's#1', NOW - HOUR, NOW - HOUR, 'mid', 3, '[]', '他最近常熬夜');
        insert.run('c', 's#2', NOW - 2 * HOUR, NOW - 2 * HOUR, 'mid', 3, '[]', '他白天起不来');
        insert.run('c', 's#3', NOW - 40 * DAY, NOW - 40 * DAY, 'mid', 3, '[]', '过期材料');
        insert.run('c', 's#4', NOW - 40 * DAY, NOW - 40 * DAY, 'long', 5, '[]', '长期材料');
        const ids = db.prepare('SELECT id, source FROM note').all();
        const idOf = (source) => ids.find((row) => row.source === source).id;
        appendInsights(db, [{ text: '他最近作息很乱', derivedFrom: [idOf('s#1'), idOf('s#2')] }], { now: NOW });
        appendInsights(db, [{ text: '由过期材料推出的旧结论', derivedFrom: [idOf('s#3'), idOf('s#4')] }], { now: NOW });
        const visible = latestInsights(db, { limit: 10, now: NOW, midTtlMs: 3 * DAY });
        assert.deepEqual(visible.map((row) => row.text).sort(), ['他最近作息很乱', '由过期材料推出的旧结论'].sort(),
          '混合来源(过期 mid + 有效 long)先保留;全部失效/过期才隐藏');
        const rendered = renderInsights(db, { now: NOW, midTtlMs: 3 * DAY });
        assert.ok(rendered.includes('他最近作息很乱'), rendered);
        assert.ok(rendered.includes('的观察'), '洞察带"多久以前"');
        // 旧结论的来源全部失效/过期后:不再注入,但物理行还在。
        db.prepare('UPDATE note SET invalid_at = ? WHERE source IN (?, ?)').run(NOW, 's#3', 's#4');
        const after = latestInsights(db, { limit: 10, now: NOW, midTtlMs: 3 * DAY });
        assert.deepEqual(after.map((row) => row.text), ['他最近作息很乱'], '只滤掉来源全失效的那条');
        db.prepare('UPDATE note SET invalid_at = ? WHERE source IN (?, ?)').run(NOW, 's#1', 's#2');
        assert.equal(latestInsights(db, { limit: 10, now: NOW, midTtlMs: 3 * DAY }).length, 0, '来源全失效 → 不再注入');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insight').get().n, 2, 'ADD-only:物理行仍在,可审计');
        // rows 参数不能绕过来源校验
        const bypassRows = [{ text: '绕过校验的旧洞察', derivedFrom: [idOf('s#1')], createdAt: NOW }];
        assert.equal(renderInsights(db, { rows: bypassRows, now: NOW, midTtlMs: 3 * DAY }), '', 'rows 也要过来源校验');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('现实观察边界:规则写进共享备注,普通回复与定时早安都接线', () => {
    const all = REALITY_GROUNDING_NOTES.join('\n');
    assert.ok(/不要替他描述或断言/.test(all), '无依据不虚构现实观察');
    assert.ok(/按他当前的说法更新/.test(all), '用户当前说法优先于旧病史');
    assert.ok(/上一条回复里的猜测不是新证据/.test(all), '不许拿自己的猜测继续坚持');
    assert.ok(/看不见的不要当成看见/.test(all), '没有视觉依据不许声称看见');
    // 接线:turnNotes 与 sendMorning 的函数体里都必须出现这条规则(源码反证见注释)。
    const source = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    const fnBody = (name) => {
      const start = source.indexOf(`function ${name}(`);
      assert.ok(start >= 0, `找不到 ${name}`);
      return source.slice(start, source.indexOf('\n  }', start));
    };
    assert.match(fnBody('turnNotes'), /REALITY_GROUNDING_NOTES/, '普通回复要带现实观察边界');
    assert.match(fnBody('sendMorning'), /REALITY_GROUNDING_NOTES/, '定时早安也要带同一条边界');
  });

  test('旧数据兼容:旧口径洞察/常驻块先停用可审计,重新生成后生效;旧 mined 健康不当当前', async () => {
    const dir = tempDir('legacy');
    try {
      // ① 旧洞察(policy_v 缺列 → 补 0):默认不注入,includeLegacy 仅审计可见;新写入 = 1。
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        db.prepare(
          `INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run('c', 's#1', NOW - HOUR, NOW - HOUR, 'long', 5, '[]', '旧材料一');
        const noteId = db.prepare('SELECT id FROM note WHERE source = ?').get('s#1').id;
        // 老库迁移:先造一张没有 policy_v 的 insight 表,再让 ensureInsightSchema 补列。
        db.exec('DROP TABLE insight');
        db.exec(`CREATE TABLE insight (
          id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, derived_from TEXT NOT NULL,
          model TEXT, created_at INTEGER NOT NULL
        )`);
        assert.deepEqual(ensureInsightSchema(db).added, ['policy_v'], '老表要补 policy_v');
        db.prepare('INSERT INTO insight (text, derived_from, model, created_at) VALUES (?, ?, ?, ?)')
          .run('旧口径洞察', JSON.stringify([noteId]), 'old', NOW);
        assert.equal(latestInsights(db, { now: NOW }).length, 0, '旧口径洞察默认不注入');
        assert.equal(latestInsights(db, { now: NOW, includeLegacy: true }).length, 1, '审计开关可见');
        assert.equal(renderInsights(db, { now: NOW }), '', '旧口径不渲染');
        appendInsights(db, [{ text: '新口径洞察', derivedFrom: [noteId] }], { now: NOW });
        assert.deepEqual(latestInsights(db, { now: NOW }).map((row) => row.text), ['新口径洞察'], '新口径正常注入');
      } finally {
        db.close();
      }
      // ② 旧常驻块(policy_v=0):读出来是旧口径;同值重新生成也要升到 1(否则永远不注入)。
      const memFile = path.join(dir, 'blocks.db');
      const raw = new DatabaseSync(memFile);
      raw.exec(`CREATE TABLE memory_block (
        label TEXT PRIMARY KEY, description TEXT NOT NULL, value TEXT NOT NULL DEFAULT '',
        limit_chars INTEGER NOT NULL DEFAULT 200, read_only INTEGER NOT NULL DEFAULT 0,
        model TEXT, updated_at INTEGER, build_ms INTEGER
      )`);
      // 老库里已有一块旧内容(没有 policy_v 列),模拟生产升级现场。
      raw.prepare(`INSERT INTO memory_block (label, description, value, limit_chars, read_only)
        VALUES ('relation', '关系状态', '旧内容', 200, 0)`).run();
      raw.close();
      const mem = openMemory(memFile);
      try {
        ensureBlockSchema(mem);
        const blocks = getMemoryBlocks(mem);
        assert.equal(blocks.find((block) => block.label === 'relation').policyV, 0, '老块 = 旧口径');
        applyBlockUpdates(mem, [{ label: 'relation', value: '' }], { now: NOW });
        assert.equal(getMemoryBlocks(mem).find((block) => block.label === 'relation').policyV, 0, '空值不算重建');
        applyBlockUpdates(mem, [{ label: 'relation', value: '旧内容' }], { now: NOW });
        const first = getMemoryBlocks(mem).find((block) => block.label === 'relation');
        assert.equal(first.policyV, 1, '写入后升级到新口径');
        // 同值再写:值没变也要保持新口径(不许退回旧口径)。
        applyBlockUpdates(mem, [{ label: 'relation', value: '旧内容' }], { now: NOW + 1000 });
        assert.equal(getMemoryBlocks(mem).find((block) => block.label === 'relation').policyV, 1);
      } finally {
        mem.close();
      }
      // ③ 旧 mined 健康(state 缺失)不当当前;told 旧行在窗口内仍可用。
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      try {
        store.touchFact({ scope: 'c2c:1', subject: 'self', kind: 'health', value: '胃疼', detail: 'short', source: 'mined' }, NOW - HOUR);
        // 模拟 A 刀之前的旧行:没有 state 列值(当时没有这个字段)。
        store.handle.prepare("UPDATE fact SET state = NULL WHERE value = '胃疼'").run();
        store.touchFact({ scope: 'c2c:1', subject: 'self', kind: 'health', value: '感冒', detail: 'short', source: 'told' }, NOW - HOUR);
        const rows = store.facts({ scope: 'c2c:1' });
        assert.equal(rows.length, 2, '物理行都保留');
        assert.equal(factVisible(rows.find((row) => row.value === '胃疼'), { now: NOW, healthWindowMs: 72 * HOUR }), false,
          '旧 mined 健康(猜的)不当当前');
        assert.equal(factVisible(rows.find((row) => row.value === '感冒'), { now: NOW, healthWindowMs: 72 * HOUR }), true,
          'told 旧行仍按窗口口径');
      } finally {
        store.close();
      }
      // ④ 投影版本升到 4:旧摘要/派生视图读时停用重建;旧裸 notes 里的"现实观察边界"也要能剥掉。
      assert.equal(CHAT_INPUT_PROJECTION_VERSION, 4, '投影版本必须升一位,旧摘要才会重建');
      const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
      assert.match(indexSource, /filter\(\(block\) => memoryCfg\.legacyDerived \|\| Number\(block\.policyV\) >= 1\)/,
        '交接注入必须过滤旧口径常驻块(否则旧块绕过 policy_v)');
      assert.match(indexSource, /Number\(block\.policyV\) < 1/, '旧口径块必须无条件到期重建,不等 20h');
      const legacyBare = `正文\n\n（本次表达要求，照做但不要念出来：）\n· ${REALITY_GROUNDING_NOTES[0]}`;
      assert.equal(projectChatInput(legacyBare, { source: 'own-engine', role: 'user', inputProjectionVersion: 2 }), '正文',
        '旧裸 notes 格式里新增的共享规则也要被剥掉(否则会当成用户原话入库)');
    } finally {
      cleanup(dir);
    }
  });
}
