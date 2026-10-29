/**
 * 阶段4/5 备料仪器的判据（2026-10-16 / 1.150.77）。
 *
 * 两台仪器都是"只读或受控真实调用"的脚本,**测试只钉纯函数与合成树**:
 *   · probe-cache-bill.mjs:前缀确定性(第 2 发命中缓存的前提)、usage 归一、
 *     期望成本三口径(按档 / 一律峰时 / 全 miss 对照)、unknown 挡判赢、脱敏;
 *   · stage5-baseline.mjs:合成仓库树上数得出行数、**缺失记缺失不许记 0**、
 *     运行横幅从日志尾里捞得出、**key 值绝不进输出**。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildPrefixText, buildProbeMessages, normalizeLlmUsage, expectedCostCny, evidencePathFor, redact, classifyIdentify } from './probe-cache-bill.mjs';
import { classifySessionDir, aggregateSplit } from './cost-split.js';
import { collectBaseline, collectBotBaseline, runtimeFromLog } from './stage5-baseline.mjs';
import { selectBatchCases, summarizeBatch } from './replay-engine.mjs';
import { sessionDirName } from '../src/memory-archive.js';
import { estimateCostCny } from '../src/usage-account.js';

/** 从固定锚点派生一个"真周三"(官方峰窗 UTC 01:00–04:00 内=峰时;12:00Z=错峰),自检星期。 */
function wednesdayHours(hourUtc) {
  let d = new Date(Date.UTC(2026, 0, 1));
  while (d.getUTCDay() !== 3) d = new Date(d.getTime() + 24 * 3600 * 1000);
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc));
  if (d.getUTCDay() !== 3) throw new Error('锚点自检失败:不是周三');
  return d.getTime();
}

export function registerStage4InstrumentTests({ test, assert }) {
  test('缓存探针:前缀与消息确定性(第2发命中的前提),usage归一畸形回null不许计零', () => {
    const a = buildPrefixText({ tokens: 64 });
    const b = buildPrefixText({ tokens: 64 });
    assert.equal(a, b, '同参数两次生成必须逐字节相同(不同 ⇒ 第2发命中纯属巧合)');
    const bigger = buildPrefixText({ tokens: 256 });
    assert.ok(bigger.length > a.length, 'tokens 越大前缀越长');
    const msgs = buildProbeMessages(a);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.ok(msgs[0].content.startsWith(a), '前缀必须在消息开头(前缀缓存按开头匹配)');

    assert.equal(normalizeLlmUsage(null), null);
    assert.equal(normalizeLlmUsage('x'), null);
    assert.equal(normalizeLlmUsage({}), null, '全是非数的字段 = 没拿到 usage,不许造一个出来');
    const u = normalizeLlmUsage({ prompt_tokens: 1000, completion_tokens: 100,
      prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, total_tokens: 1100 });
    assert.deepEqual(
      { p: u.promptTokens, c: u.completionTokens, h: u.cacheHitTokens, m: u.cacheMissTokens, t: u.totalTokens },
      { p: 1000, c: 100, h: 800, m: 200, t: 1100 });
    assert.ok(u.raw && u.raw.prompt_tokens === 1000, '原体必须全留(对账单要对 provider 自己的字段名)');
    const derived = normalizeLlmUsage({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 800 });
    assert.equal(derived.cacheMissTokens, 200, '缺 miss 字段时按 prompt−hit 推,不许当 0');
  });

  test('缓存探针:期望成本三口径(按档/一律峰时/全miss对照),未知模型=null(unknown挡判赢)', () => {
    const peak = wednesdayHours(2);
    const usage = { promptTokens: 1000, completionTokens: 100, cacheHitTokens: 800, cacheMissTokens: 200, totalTokens: 1100 };
    const exp = expectedCostCny({ priceModel: 'deepseek-flash', at: peak, usage });
    const direct = estimateCostCny({ model: 'deepseek-flash', at: peak,
      cacheMissTokens: 200, cacheHitTokens: 800, outputTokens: 100 });
    assert.equal(exp.cny, direct.cny, '期望成本必须就是那把被钉着的尺算出来的数');
    assert.equal(exp.tier, 'peak', '周三 02:00Z 在峰窗内');
    assert.ok(exp.allMissCny > exp.cny, '全 miss 对照必须更贵(否则"命中更便宜"这前提就反了)');
    assert.ok(exp.ifAllPeakCny >= exp.cny, '一律峰时 ≥ 按真实时刻(错峰半价)');
    assert.equal(expectedCostCny({ priceModel: 'no-such-model', at: peak, usage }), null,
      '没核过的模型回 null(不许猜一个数出来)');
    assert.equal(expectedCostCny({ priceModel: 'deepseek-flash', at: peak, usage: null }), null);
    assert.equal(expectedCostCny({ priceModel: 'deepseek-flash', at: peak,
      usage: { ...usage, cacheMissTokens: null } }), null, '关键字段缺失 ⇒ unknown');
    // 杂项但重要:证据文件名合法 + 脱敏真把 key 抹掉。
    const p = evidencePathFor(os.tmpdir(), 'cache-bill-probe');
    assert.match(path.basename(p), /^cache-bill-probe-[\d-]+T[\d-]+Z\.json$/, '文件名只许时间戳差异且 Windows 合法');
    assert.equal(redact('Bearer abc and abc again', 'abc'), 'Bearer <redacted> and <redacted> again');
  });

  test('identify 鉴定:判定只认形状,不许把"没开通"猜成"不存在"、也不许把4xx一律当不存在', () => {
    assert.equal(classifyIdentify(200, { model: 'deepseek-flash' }), 'ok');
    assert.equal(classifyIdentify(400, { error: { message: 'Model Not Exist', code: 'model_not_exist' } }), 'model-not-exist');
    assert.equal(classifyIdentify(400, { error: { message: '模型不存在' } }), 'model-not-exist');
    assert.equal(classifyIdentify(404, { error: { message: 'unknown model' } }), 'model-not-exist');
    assert.equal(classifyIdentify(402, { error: { message: 'Insufficient Balance' } }), 'not-enabled-or-no-balance',
      '402/403 = 认识但没开通/没余额 —— 与"不存在"是两回事(主人的"没开过v4pro"落在这一格)');
    assert.equal(classifyIdentify(403, {}), 'not-enabled-or-no-balance');
    assert.equal(classifyIdentify(429, { error: { message: 'rate limited' } }), 'http-429', '认不出的形状如实报状态码,不归类');
    assert.equal(classifyIdentify(500, null), 'http-500');
  });

  test('cost-split:类别只有一份判断;分桶钱数逐项手算对;折不出价进计数不进桶(缺失≠0)', () => {
    assert.equal(classifySessionDir('qqbot-c2c-3CB4-g84'), 'chat');
    assert.equal(classifySessionDir('qqbot-group-17A4-g15'), 'chat');
    assert.equal(classifySessionDir('qqbot-summary-g37'), 'summary');
    assert.equal(classifySessionDir('qqbot-summary-2-g4'), 'summary');
    assert.equal(classifySessionDir('qqbot-announce-preview-muig'), 'other', '既非聊天也非摘要 ⇒ other,不猜');
    const peak = wednesdayHours(2);
    const entries = [
      { cls: 'chat', usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 100 }, at: peak },
      { cls: 'summary', usage: { inputTokens: 500, cacheReadTokens: 2000, outputTokens: 50 }, at: peak },
      { cls: 'summary', usage: { inputTokens: 300, cacheReadTokens: 0, outputTokens: 20 }, at: peak },
      { cls: 'chat', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 }, at: null }, // 没时刻 ⇒ 折不出价
    ];
    const { byClass, unpriced, window } = aggregateSplit(entries);
    const flash = estimateCostCny({ model: 'deepseek-flash', at: peak, cacheMissTokens: 1000, cacheHitTokens: 500, outputTokens: 100 });
    assert.equal(byClass.chat.cny, Number(flash.cny.toFixed(4)), 'chat 桶 = 那把被钉着的尺算出来的数');
    assert.equal(byClass.chat.calls, 1);
    assert.equal(byClass.summary.calls, 2);
    assert.equal(byClass.summary.miss, 800);
    assert.equal(byClass.summary.hit, 2000);
    assert.equal(unpriced, 1, '折不出价的要**数出来**(缺失≠0,也不许悄悄进桶)');
    assert.equal(byClass.chat.miss, 1000);
    assert.equal(window.days, 0, '同一时刻的窗口 = 0 天');
    assert.equal(window.from, new Date(peak).toISOString());
    // 峰谷计数也是消费端证据的一部分(峰时那发必须记在 peak 桶)。
    assert.equal(byClass.chat.peakCalls, 1);
    assert.equal(byClass.chat.offPeakCalls, 0);
  });

  test('阶段5基线:合成仓库树上行数对、缺失记缺失(不许记0)、横幅捞得出、key绝不进输出', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-baseline-'));
    try {
      // --- 合成:bots\tb\.env(带一个假 key,专测非泄漏) ---
      const dshHome = path.join(root, 'dsh-home-tb');
      const wsAbs = path.resolve(root, '..', 'ws-tb');
      fs.mkdirSync(path.join(root, 'bots', 'tb'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bots', 'tb', '.env'),
        `QQBOT_ENGINE=own\nQQBOT_DSH_PROFILE=qqbot-test\nQQBOT_DSH_MODEL=deepseek-flash\n`
        + `QQBOT_WORKSPACE=..\\ws-tb\nQQBOT_HOME=${dshHome}\nQQBOT_LLM_DREAM_KEY=sk-secret-123\n`);
      // --- 合成:主库三张表 ---
      fs.mkdirSync(path.join(root, 'data', 'tb'), { recursive: true });
      const state = new DatabaseSync(path.join(root, 'data', 'tb', 'state.db'));
      state.exec('CREATE TABLE conversation_turn (id INTEGER PRIMARY KEY);'
        + 'CREATE TABLE own_llm_call (id INTEGER PRIMARY KEY, usage TEXT);'
        + 'CREATE TABLE own_llm_attempt (id INTEGER PRIMARY KEY, call_id INTEGER, usage TEXT);');
      for (const id of [1, 2, 3]) state.prepare('INSERT INTO conversation_turn VALUES (?)').run(id);
      state.prepare('INSERT INTO own_llm_call VALUES (?, ?)').run(1, '{"x":1}');
      state.prepare('INSERT INTO own_llm_call VALUES (?, ?)').run(2, null);
      state.prepare('INSERT INTO own_llm_attempt VALUES (?, ?, ?)').run(1, 1, '{"y":2}');
      state.prepare('INSERT INTO own_llm_attempt VALUES (?, ?, ?)').run(2, 2, null);
      state.close();
      // --- 合成:影子隔离库(usage-null 那一格正是"影子只记次数"的形状) ---
      fs.mkdirSync(path.join(root, 'data', 'tb', 'shadow'), { recursive: true });
      const shadow = new DatabaseSync(path.join(root, 'data', 'tb', 'shadow', 'state.db'));
      shadow.exec('CREATE TABLE own_llm_call (id INTEGER PRIMARY KEY, usage TEXT);');
      shadow.prepare('INSERT INTO own_llm_call VALUES (?, ?)').run(1, null);
      shadow.prepare('INSERT INTO own_llm_call VALUES (?, ?)').run(2, null);
      shadow.close();
      // --- 合成:bridge.log 两次启动,横幅要捞最后一条 ---
      // 横幅形状跟生产走(2026-10-17 / D236:已退役的 profile=/provider/model= 那三段删掉了;
      // 这里只喂给"捞版本号"的解析器,但夹具形状要真,否则针会一直钝着)。
      fs.writeFileSync(path.join(root, 'data', 'tb', 'bridge.log'),
        '2026-10-15T01:00:00.000Z [info] bridge 启动：version=1.150.74 cwd=E:\\tb model=deepseek-chat\n'
        + '2026-10-15T01:00:01.000Z [info] 机器人已就绪：旧的一次\n'
        + '2026-10-16T04:46:41.610Z [info] bridge 启动：version=1.150.75 cwd=E:\\tb model=deepseek-chat\n'
        + '2026-10-16T04:46:42.610Z [info] 机器人已就绪：测试助手\n');
      // --- 合成:DSH 会话树(1 个 v3) ---
      const sessDir = path.join(dshHome, 'sessions', sessionDirName(wsAbs), 'sess-1');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'session.v3.jsonl.zstd'), 'x');
      // memory.db **故意不建** —— 缺失必须记缺失。

      const baseline = collectBaseline(root, { packageVersion: '1.150.77-test' });
      assert.equal(baseline.bots.length, 1);
      const tb = baseline.bots[0];
      assert.equal(tb.engine, 'own');
      assert.equal(tb.runtime.lastBannerVersion, '1.150.75', '横幅要捞**最后**一条,不是第一条');
      assert.deepEqual(tb.runtime.lastReady, { at: '2026-10-16T04:46:42.610Z', who: '测试助手' });
      assert.equal(tb.stateDb.conversationTurn.rows, 3);
      assert.equal(tb.stateDb.ownLlmCall.rows, 2);
      assert.equal(tb.stateDb.ownLlmAttemptWithUsage.rows, 1, 'attempt 带 usage 数要单独数(那才是能折钱的)');
      assert.equal(tb.shadowDb.ownLlmCall.rows, 2);
      assert.equal(tb.shadowDb.ownLlmCallUsageNull.rows, 2, '影子库全是 usage:null —— 只记次数,不能折钱');
      assert.equal(tb.sessions.count, 1);
      assert.deepEqual(tb.sessions.byVersion, [{ version: 3, count: 1 }]);
      assert.equal(tb.ownLlm.keyConfigured, true);
      assert.equal(tb.memoryDb.present, false, '没建的库记"缺失"');
      assert.equal(tb.memoryDb.session, undefined, '缺失的库不许顺手填一个 0 出来');
      assert.ok(!JSON.stringify(baseline).includes('sk-secret-123'),
        '**key 值绝不进输出**(只许"配没配"这个布尔)');

      // 缺失族的另一半:连 .env 都没有的 bot 目录,各字段要么缺要么明说,不许冒出默认值。
      fs.mkdirSync(path.join(root, 'bots', 'empty'), { recursive: true });
      const bare = collectBotBaseline(root, 'empty');
      assert.equal(bare.envFilePresent, false);
      assert.equal(bare.engine, '(未配)');
      assert.equal(bare.runtime.present, false);
      assert.equal(bare.sessions.present, false, 'QQBOT_HOME 未配 ⇒ 会话段如实说"没配",不是 0 个');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // 分批抽样历史回放(1.150.83):抽样必须确定性+覆盖时间轴两端;汇总必须"缺失记缺失"。
  test('历史回放分批:等距抽样确定且覆盖两端;零分母不进比率,失败例只计数不进合计', () => {
    const pool = Array.from({ length: 200 }, (_, i) => ({ at: 1_700_000_000_000 + i * 3_600_000, id: i }));
    const one = selectBatchCases(pool, 20);
    const two = selectBatchCases(pool, 20);
    assert.equal(one.length, 20);
    assert.deepEqual(one.map(c => c.id), two.map(c => c.id), '同输入同输出(否则两次批量不可比)');
    assert.ok(one[0].id < 20, '抽样要覆盖时间轴头部');
    assert.ok(one.at(-1).id > 179, '抽样要覆盖时间轴尾部(尾部的历史更重要)');
    assert.equal(selectBatchCases(pool.slice(0, 5), 50).length, 5, '样本不足时全给,不报错');
    assert.deepEqual(selectBatchCases([], 10), []);
    assert.deepEqual(selectBatchCases(pool, 0), [], 'n=0 是空批,不是"全给"');

    const summary = summarizeBatch([
      { ok: true, oldMiss: 100, oldHit: 900, oldOut: 20, newPrompt: 500, newHit: 400, newOut: 10, oldCny: 0.02, newCny: 0.01, extraCalls: 0, historyRows: 5 },
      { ok: true, oldMiss: 0, oldHit: 0, oldOut: 0, newPrompt: 999, newHit: 0, newOut: 5, oldCny: 0, newCny: 0.005, extraCalls: 2, historyRows: 0 },
      { ok: false, error: 'boom' },
    ]);
    assert.equal(summary.cases, 3);
    assert.equal(summary.ok, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.ratioCases, 1, '旧输入为 0 的 case 不进比率(不是算成 0)');
    assert.equal(summary.medianInputRatio, 0.5);
    assert.equal(summary.costRatioCases, 1, 'oldCny=0 不进成本比率');
    assert.equal(summary.oldInputTokens, 1000, '失败例不进合计');
    assert.equal(summary.extraCalls, 2, '额外调用(摘要等)要计数,好让报告解释"这一轮不止一发"');
  });
}
