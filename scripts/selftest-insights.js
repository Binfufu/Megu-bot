/**
 * **记忆洞察**(P2-A,2026-10-22,方案 §4.4 / D250 定稿 #6)回归。
 *
 * 要治的形状:跨多条固化记忆的"模式总结"(如「他最近常熬夜」)以前根本不存在 ——
 * 检索只会把单条 note 端出来,模式层面的结论没有任何通道。洞察层 = 每 20h 一拍,
 * 拿最近 30 条 note + 已有洞察让模型总结 ≤3 条(每条 ≤120 字),每条**必带 derived_from**
 * (真实 note.id 数组,可审计);只增不改(追加式,旧洞察永远留着)。
 *
 * ⚠️ 判据**真跑临时 SQLite 库** + 纯函数直调(generate 用假回调 —— memory 层零 HTTP 的纪律)。
 *
 * 覆盖:
 *   · 表初始化:openMemory 自动建表(老库下次打开自动获得);追加式只增不改;没表的库读写全降级不抛。
 *   · insightsDue:纯函数限频(没有 = 该写;20h 内 = 不急;everyMs=0 = 每拍都算)。
 *   · buildInsights:好 JSON → 产洞察(字符串 id 也认、超长截断);假引用/缺字段/单条来源 → **整批不写**。
 *   · buildInsights:坏 JSON / 空输出 / 断 JSON / 缺 insights 字段 → 不抛、error 说清原因、什么都不产。
 *   · renderInsights:形状(首行措辞 + `·` 行)、只取最新 ≤3 条、预算装不下 → 一字不加;包标记后剥壳归零。
 *   · wiring:index.js 生成挂 summaryTick 且走 summarizer、注入过 wrapInject('insight')、
 *     交接路径(handoffFor)绝不调模型;INJECT_KINDS 登记 kind;config 有开关与限频。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INJECT_KINDS, wrapInject, stripInjectMarks } from '../src/inject-mark.js';
import {
  INSIGHT_MIN_NOTES, appendInsights, buildInsights, insightsDue, latestInsightCreatedAt,
  latestInsights, recentInsightNotes, renderInsights,
} from '../src/memory-insights.js';
import { openMemory } from '../src/memory-store.js';

const BASE = Date.UTC(2026, 9, 1, 4, 0);

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-insights-${tag}-`));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
/** 造一个"还没被 openMemory 升级过的老库":只有 note 表,没有 insight 表。 */
function legacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, at INTEGER, invalid_at INTEGER)');
  return db;
}

export function registerInsightTests({ test, assert }) {
  test('表初始化:openMemory 自动建表;追加式只增不改;老库(没表)读写全降级不抛', () => {
    const dir = tempDir('init');
    try {
      // 老库:没有 insight 表 —— 读写两端都按"没有洞察"降级,一个字不写、一个错不抛。
      const legacy = legacyDb(path.join(dir, 'legacy.db'));
      try {
        assert.equal(latestInsightCreatedAt(legacy), null, '没表 → 没有最新时刻');
        assert.deepEqual(appendInsights(legacy, [{ text: '他常熬夜', derivedFrom: [1, 2] }]),
          { written: 0, refs: 0 }, '没表 → 不写(与读端降级对称)');
        assert.deepEqual(latestInsights(legacy), []);
        assert.equal(renderInsights(legacy), '', '没表 → 渲染一字不加');
      } finally {
        legacy.close();
      }
      // 新库/被 openMemory 打开过的老库:表自动就位(MEMORY_SCHEMA 的 CREATE TABLE IF NOT EXISTS)。
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const first = appendInsights(db, [
          { text: '他最近常熬夜', derivedFrom: [11, 12] },
          { text: '你们在冷战', derivedFrom: [12, 13] },
        ], { model: 'test-model', now: BASE });
        assert.deepEqual(first, { written: 2, refs: 4 }, '两批三条引用都记上');
        const snapshot = latestInsights(db, { limit: 10 }).map((row) => `${row.id}:${row.text}`);
        // 追加式:再写一批,旧行一字不动(id/text/created_at 全保留,可审计)。
        appendInsights(db, [{ text: '新的洞察', derivedFrom: [11, 13] }], { model: 'test-model', now: BASE + 1000 });
        const after = latestInsights(db, { limit: 10 });
        assert.equal(after.length, 3, '只增:行数累计,不覆盖');
        assert.deepEqual(after.slice(1).map((row) => `${row.id}:${row.text}`), snapshot, '旧 insight 行原样');
        assert.deepEqual(after[0].derivedFrom, [11, 13], '新行的引用解析正常');
        assert.equal(appendInsights(db, [], { now: BASE + 2000 }).written, 0, '空列表不写');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('insightsDue 纯函数:没有 = 该写;20h 内 = 不急;过了 = 该写;everyMs=0 = 每拍都算', () => {
    const everyMs = 20 * 3600 * 1000;
    assert.equal(insightsDue(null, { everyMs, now: BASE }), true, '一条都没有 → 首拍就写');
    assert.equal(insightsDue(BASE - everyMs + 60_000, { everyMs, now: BASE }), false, '距上次不足 20h → 不急');
    assert.equal(insightsDue(BASE - everyMs, { everyMs, now: BASE }), true, '刚好 20h → 该写');
    assert.equal(insightsDue(BASE - 1, { everyMs: 0, now: BASE }), true, 'everyMs=0 → 每拍都算(测试/手动用)');
  });

  test('buildInsights:好 JSON → 产洞察(字符串 id 也认、超长截断);假引用/缺字段/单条来源 → 整批不写', async () => {
    const notes = [
      { id: 11, text: '他凌晨三点还在说话' },
      { id: 12, text: '他昨晚又两点才睡' },
      { id: 13, text: '三天没提游戏了' },
    ];
    const good = JSON.stringify({
      insights: [
        { text: '他最近常熬夜，凌晨还在说话。', derived_from: [11, 12] },
        { text: 'x'.repeat(200), derived_from: ['12', 13] }, // 字符串 id 也得认;远超 120 字 → 截断
      ],
    });
    const result = await buildInsights({ notes, generate: async () => good });
    assert.equal(result.error, null, result.error);
    assert.equal(result.insights.length, 2);
    assert.deepEqual(result.insights[0].derivedFrom, [11, 12]);
    assert.deepEqual(result.insights[1].derivedFrom, [12, 13], '字符串 id 归一成整数');
    assert.equal(result.insights[1].text.length <= 120, true, '超长截断到 limit_chars');
    // 整批不写的四种形状 —— 每种都 error 说清原因、insights 为空、不抛。
    const rejects = [
      ['假引用', JSON.stringify({ insights: [{ text: '他爱喝奶茶', derived_from: [11, 999] }] }), /引用了不存在的笔记/],
      ['一条好一条坏(不许半写)', JSON.stringify({
        insights: [
          { text: '他最近常熬夜', derived_from: [11, 12] },
          { text: '编的', derived_from: [41] },
        ],
      }), /引用了不存在的笔记/],
      ['缺 derived_from', JSON.stringify({ insights: [{ text: '他在冷战' }] }), /缺 derived_from/],
      ['空引用数组', JSON.stringify({ insights: [{ text: '他在冷战', derived_from: [] }] }), /缺 derived_from/],
      [`单条来源(复述不是洞察,至少要 ${INSIGHT_MIN_NOTES} 条)`, JSON.stringify({
        insights: [{ text: '他熬夜', derived_from: [11] }],
      }), /只引用了 1 条笔记/],
      ['缺 text', JSON.stringify({ insights: [{ derived_from: [11, 12] }] }), /缺 text/],
      ['超量只取前 3', JSON.stringify({
        insights: [
          { text: '一', derived_from: [11, 12] },
          { text: '二', derived_from: [12, 13] },
          { text: '三', derived_from: [11, 13] },
          { text: '四', derived_from: [11, 12] },
        ],
      }), null], // 不拒收,只截到 maxPerRun —— 单独断言
    ];
    for (const [label, raw, pattern] of rejects) {
      const bad = await buildInsights({ notes, generate: async () => raw });
      if (pattern) {
        assert.equal(bad.insights.length, 0, `${label}:不产 insights`);
        assert.ok(typeof bad.error === 'string' && pattern.test(bad.error), `${label}:error 要说清原因(${bad.error})`);
      } else {
        assert.equal(bad.error, null, `${label}:超量不是错误`);
        assert.equal(bad.insights.length, 3, `${label}:入库口径 = ≤3 条`);
      }
    }
  });

  test('buildInsights:坏 JSON/空输出/缺字段 → 不抛且什么都不产;旧值保留 = 表一字不涨', async () => {
    const dir = tempDir('badjson');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        appendInsights(db, [{ text: '已有洞察', derivedFrom: [11, 12] }], { now: BASE });
        const notes = [{ id: 11, text: '他凌晨还在说话' }, { id: 12, text: '他昨晚两点才睡' }];
        const bads = [
          ['空输出', ''],
          ['非JSON', '我觉得还行'],
          ['断JSON', '{"insights": [断了'],
          ['缺 insights 字段', '{"foo":1}'],
          ['insights 是空数组', '{"insights":[]}'],
          ['顶层是数组', '[]'],
        ];
        for (const [label, raw] of bads) {
          const bad = await buildInsights({ notes, generate: async () => raw });
          assert.equal(bad.insights.length, 0, `${label}:不产 insights`);
          assert.ok(typeof bad.error === 'string' && bad.error.length > 0, `${label}:要说清原因`);
        }
        // 旧值保留:追加式表上"不写"就是旧值原样 —— 行数一字不涨。
        const bad = await buildInsights({ notes, generate: async () => '' });
        appendInsights(db, bad.insights, { now: BASE + 1000 });
        assert.equal(latestInsights(db, { limit: 10 }).length, 1, '坏输出之后库里还是原来那一条');
        // 没攒够笔记:连模型都不该叫(generate 假回调记次数证明)。
        let called = 0;
        const thin = await buildInsights({
          notes: [{ id: 11, text: '只有一条' }],
          generate: async () => { called += 1; return '{"insights":[]}'; },
        });
        assert.equal(called, 0, '材料不足就不该花这次调用');
        assert.match(thin.error, /固化笔记不足/);
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('renderInsights:形状与措辞、只取最新 ≤3 条、预算装不下 → 一字不加;包标记后剥壳归零', () => {
    const dir = tempDir('render');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        assert.equal(renderInsights(db), '', '空表 → 一字不加');
        const longText = '他最近常熬夜，凌晨还在说话，白天起不来。';
        for (let index = 0; index < 5; index += 1) {
          appendInsights(db, [{ text: `${longText}第${index}条`, derivedFrom: [11, 12] }], {
            model: 'test-model', now: BASE + index * 1000,
          });
        }
        const text = renderInsights(db, { limit: 3 });
        const lines = text.split('\n');
        assert.ok(lines[0].includes('背景') && lines[0].includes('不是台词'), '首行措辞守「这是背景不是台词」纪律');
        assert.equal(lines.length, 4, `首行 + 最新 3 条(拿到 ${lines.length} 行)`);
        assert.ok(lines[1].includes('第4条'), '最新在前');
        assert.ok(lines[3].includes('第2条'), '最旧的被 limit 挡在门外');
        // 预算截断:预算连首行+一条都装不下 → 一字不加(与 renderRecall/renderMemoryBlocks 同口径)。
        assert.equal(renderInsights(db, { limit: 3, budgetChars: 50 }), '', '预算装不下 → 一字不加');
        // 注入端自报家门:wrapInject 包过的块,剥壳之后一个字都不剩(归档不把它当她说的话)。
        const wrapped = wrapInject('insight', text);
        assert.ok(wrapped.startsWith('[[bridge-inject insight]]'), '自报家门的开标记(kind=insight)');
        const stripped = stripInjectMarks(`前一行\n${wrapped}\n后一行`);
        assert.equal(stripped.includes('熬夜'), false, '剥壳后洞察正文不剩');
        assert.equal(stripped.split('\n').length, 3, '换行不删行:块换成一个空行');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('端到端:好输出 → 落库 → 渲染;与已有洞察去重(全重复 = 这拍没有新模式)', async () => {
    const dir = tempDir('e2e');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        // 输入材料从真表里来(note 两行),引用校验才有真 id 可对。
        db.prepare('INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run('qqbot-c2c-x', 's#1', BASE, BASE, 'long', 5, '[]', '他凌晨三点还在说话');
        db.prepare('INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run('qqbot-c2c-x', 's#2', BASE + 1, BASE + 1, 'long', 5, '[]', '他昨晚又两点才睡');
        const notes = recentInsightNotes(db, { limit: 30 });
        assert.equal(notes.length, 2, '输入 = 最近的有效固化笔记(带真实 id)');
        const first = await buildInsights({
          notes,
          generate: async () => JSON.stringify({
            insights: [{ text: '他最近常熬夜', derived_from: [notes[0].id, notes[1].id] }],
          }),
        });
        assert.equal(first.error, null, first.error);
        appendInsights(db, first.insights, { model: 'insights', now: BASE + 2000 });
        assert.equal(renderInsights(db).includes('他最近常熬夜'), true, '落库后渲染得出');
        // 与已有洞察去重:模型又总结出同一条 → 不算新模式;另一条是新的 → 只留新的。
        const again = await buildInsights({
          notes,
          existing: latestInsights(db, { limit: 10 }),
          generate: async () => JSON.stringify({
            insights: [
              { text: '他最近常熬夜', derived_from: [notes[0].id, notes[1].id] },
              { text: '你们的作息在互相拖', derived_from: [notes[1].id, notes[0].id] },
            ],
          }),
        });
        assert.equal(again.error, null, again.error);
        assert.deepEqual(again.insights.map((item) => item.text), ['你们的作息在互相拖'], '重复的被去掉');
        // 全重复 = 这拍没有新模式:如实报,一个字不写。
        const allDup = await buildInsights({
          notes,
          existing: latestInsights(db, { limit: 10 }),
          generate: async () => JSON.stringify({
            insights: [{ text: '他最近常熬夜', derived_from: [notes[0].id, notes[1].id] }],
          }),
        });
        assert.match(allDup.error, /全是已有洞察的重复/);
        assert.equal(appendInsights(db, allDup.insights).written, 0);
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('wiring:生成挂 summaryTick 走 summarizer、注入过 wrapInject(\'insight\')、交接路径不调模型、开关与 kind 都登记', () => {
    // 判据 1:kind 已登记(真 import,不扫字面)。
    assert.ok(INJECT_KINDS.includes('insight'), 'INJECT_KINDS 要登记 insight');
    const source = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    // 判据 2:注入端 —— 过 wrapInject 且有配置闸(配置关 = 一字不加)。
    assert.match(source, /wrapInject\('insight', insightText\)/, '洞察块要过同一份 D177 标记');
    assert.match(source, /memoryCfg\.insights\?\.enabled && memoryDb\b/, '注入与生成都要有回滚开关');
    // 判据 3:生成端 —— 必须挂在 summaryTick 函数体内,生成调用走 summarizer 那条线。
    const tickStart = source.indexOf('async function summaryTick(');
    const tickEnd = source.indexOf('\n  }', tickStart);
    const tickBody = source.slice(tickStart, tickEnd);
    assert.match(tickBody, /memoryCfg\.insights\?\.enabled && memoryDb && summarizerReady\(\)/, '生成在 summaryTick 里且有 runner 在线闸');
    assert.match(tickBody, /buildInsights\(\{/, 'summaryTick 里要调 buildInsights');
    assert.match(tickBody, /generate: \(prompt\) => summarizer\(prompt\)/, '生成调用走摘要同一条子会话线');
    assert.match(tickBody, /insightsDue\(latestInsightCreatedAt\(memoryDb\)/, '限频判据 = 库里最新洞察的 created_at');
    // 判据 4(死锁纪律):交接路径绝不调模型 —— handoffFor 函数体内不许出现洞察生成。
    const handoffStart = source.indexOf('async function handoffFor(');
    const handoffEnd = source.indexOf('\n  }', handoffStart);
    const handoffBody = source.slice(handoffStart, handoffEnd);
    // ⚠️ 2026-10-28(P0 作用域):形状明改成"过滤后的块交给渲染",切片判据跟着改到新事实 ——
    //    目的不变(证明这段切片切到的是 handoffFor 而不是文件别处)。
    assert.match(handoffBody, /renderMemoryBlocks\(memoryDb, \{ blocks: visible \}\)/, '反证:handoffFor 切片要切得准(常驻块在这里)');
    assert.doesNotMatch(handoffBody, /buildInsights|recentInsightNotes/, '交接路径不许出现洞察生成(死锁纪律)');
    // 判据 5:config 有开关与限频(QQBOT_MEMORY_INSIGHTS 默认开)。
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    assert.match(configSource, /insights: \{/, 'config 要有 memory.insights 块');
    assert.match(configSource, /asBool\('QQBOT_MEMORY_INSIGHTS', true\)/, '开关默认开');
    assert.match(configSource, /QQBOT_MEMORY_INSIGHTS_EVERY_HOURS', 20\)/, '限频默认 20h');
  });
}
