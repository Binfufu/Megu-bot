/**
 * **刀二A `src\context-budget.js` 的判据**(2026-10-14,`docs\21` §十二/§十三)。
 *
 * 纯函数判据:预算表数值钉死(防手滑改错档)、迟滞两态(反证锚点:注释掉迟滞逻辑
 * 这条必须红)、切分轮界对齐且不丢轮、gap-aware 两态、摘要区上限、组装顺序。
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSEMBLY_ORDER,
  CONTEXT_BUDGETS,
  SUMMARY_PROMPT,
  budgetFor,
  keepForGap,
  planCompaction,
  rearmLevel,
  splitHistory,
  summaryOverCap,
} from '../src/context-budget.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { approxTokens } from '../src/dream-cards.js';
import { INJECT_KINDS, hasInjectMarks, injectOpen, stripInjectMarks, wrapInject } from '../src/inject-mark.js';
import { stripInjectedBlocks } from '../src/transcript.js';

/** 造 n 轮历史,每轮 content 固定字数(costOf 可控)。 */
function turns(n, chars = 40) {
  return Array.from({ length: n }, (_, i) => ({ role: 'user', content: `${i}`.padEnd(chars, '.') }));
}

export function registerContextBudgetTests({ test, assert: rawAssert }) {
  const a = rawAssert || assert;

  test('context:预算表数值钉死(2026-10-14 拍板;改档必须连判据改+留决策条目)', () => {
    a.equal(CONTEXT_BUDGETS.world.triggerTokens, 65_536, '世界触发 64k');
    a.equal(CONTEXT_BUDGETS.world.keepRecentTokens, 16_384, '世界保留 16k');
    a.equal(CONTEXT_BUDGETS.world.summaryCapTokens, 8_192, '世界摘要上限 8k【暂定】');
    a.equal(CONTEXT_BUDGETS.world.hysteresisMarginTokens, 8_192, '世界迟滞余量 8k【暂定】');
    a.equal(CONTEXT_BUDGETS.world.coldGapMs, 6 * 3_600_000, '冷窗 6h【暂定】');
    a.equal(CONTEXT_BUDGETS.world.coldKeepTokens, 4_096, '冷收窄档 4k【暂定】');
    a.equal(CONTEXT_BUDGETS.dream.triggerTokens, 32_768, '梦境触发 32k');
    a.equal(CONTEXT_BUDGETS.dream.keepRecentTokens, 8_192, '梦境保留 8k');
    a.equal(CONTEXT_BUDGETS.dream.summaryCapTokens, 4_096, '梦境摘要上限 4k【暂定】');
    a.equal(budgetFor('world'), CONTEXT_BUDGETS.world, 'budgetFor 认 world');
    a.equal(budgetFor('dream'), CONTEXT_BUDGETS.dream, 'budgetFor 认 dream');
    a.equal(budgetFor('announce'), null, '播报零历史 → null,不硬造预算');
    a.equal(budgetFor('nope'), null, '认不出的场景 → null');
  });

  test('context:压缩触发与不触发', () => {
    const b = CONTEXT_BUDGETS.world;
    const under = planCompaction({ tokens: b.triggerTokens, armed: true, budget: b });
    a.equal(under.compact, false, '恰好等于触发线不算超(> 才压)');
    const over = planCompaction({ tokens: b.triggerTokens + 1, armed: true, budget: b });
    a.equal(over.compact, true, '超线 → 压');
    a.equal(over.armed, false, '压完卸武装');
    a.equal(over.reason, 'over_trigger');
  });

  test('context:迟滞两态 —— 压完未落回重武装水位前不许再压(反证锚点)', () => {
    const b = CONTEXT_BUDGETS.world;
    const rearm = rearmLevel(b);
    a.equal(rearm, 65_536 - 16_384 - 8_192, '重武装水位现算派生(D34)');
    // 卸武装后水位仍在高位(压不动/摘要过大落不下去)→ 不许连压
    const stillHigh = planCompaction({ tokens: b.triggerTokens + 500, armed: false, budget: b });
    a.equal(stillHigh.compact, false, '迟滞期内不压');
    a.equal(stillHigh.armed, false, '仍卸武装');
    a.equal(stillHigh.reason, 'hysteresis');
    // 落回水位以下 → 重新武装(但本轮不压)
    const settled = planCompaction({ tokens: rearm, armed: false, budget: b });
    a.equal(settled.compact, false, '重武装轮不压');
    a.equal(settled.armed, true, '重新武装');
    a.equal(settled.reason, 'rearm');
    // 重武装后再涨过触发线 → 又能压(状态机循环闭合)
    const again = planCompaction({ tokens: b.triggerTokens + 1, armed: settled.armed, budget: b });
    a.equal(again.compact, true, '武装状态下再次超线 → 压');
  });

  test('context:切分 —— 轮界对齐、不丢轮、不重排、预算内', () => {
    const costOf = (t) => 100; // 每轮恰好 100(口径可控)
    const h = turns(10);
    const { older, recent } = splitHistory(h, 350, costOf);
    a.equal(recent.length, 3, '350/100 → 保 3 轮(不切半轮)');
    a.equal(older.length, 7);
    a.deepEqual([...older, ...recent], h, '拼回 = 原序原项(不丢不重排)');
    a.equal(recent[0], h[7], '保的是最新的那段');
    // 单轮超预算:保留段至少一轮(不能把最近一句也摘要掉)
    const big = splitHistory(turns(3), 50, () => 100);
    a.equal(big.recent.length, 1, '单轮超预算仍保最近一轮');
    a.equal(big.older.length, 2);
    // 空入空出
    const empty = splitHistory([], 1000, costOf);
    a.deepEqual(empty, { older: [], recent: [] });
  });

  test('context:gap-aware 两态 —— 超窗收窄、未超窗/未知间隔不动', () => {
    const b = CONTEXT_BUDGETS.world;
    a.equal(keepForGap(b, 5 * 3_600_000), b.keepRecentTokens, '5h < 6h 冷窗 → 正常档');
    a.equal(keepForGap(b, 7 * 3_600_000), b.coldKeepTokens, '7h ≥ 冷窗 → 收窄档');
    a.equal(keepForGap(b, b.coldGapMs), b.coldKeepTokens, '恰好压线算冷(≥)');
    a.equal(keepForGap(b, null), b.keepRecentTokens, '间隔未知 → 保守不动前缀');
  });

  test('context:摘要区上限(二层压判据)与提示词', () => {
    const b = CONTEXT_BUDGETS.world;
    a.equal(summaryOverCap(b.summaryCapTokens, b), false, '恰好达上限不算超');
    a.equal(summaryOverCap(b.summaryCapTokens + 1, b), true, '超上限 → 压摘要的摘要');
    a.ok(SUMMARY_PROMPT.includes('不创作'), '摘要提示词含不创作护栏');
    a.ok(SUMMARY_PROMPT.length > 50, '提示词非空壳');
  });

  test('context:组装顺序钉死 —— 稳定块前置、易变注入只进本轮', () => {
    a.deepEqual([...ASSEMBLY_ORDER], ['stable', 'summary', 'history', 'turn']);
    a.equal(ASSEMBLY_ORDER.indexOf('stable'), 0, '稳定块必须在最前(公共前缀持久化)');
    a.equal(ASSEMBLY_ORDER.indexOf('turn'), ASSEMBLY_ORDER.length - 1, '本轮易变注入必须在最后');
  });

  // --- 刀二B:conversation_turn 存储(docs\21 §十二) --------------------------------

  /** 开一个临时库(用完删)。 */
  function tempStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-turn-'));
    return { store: new SqliteStateStore(path.join(dir, 'state.db')), dir };
  }

  test('context:conversation_turn 追加与读取 —— tokens 口径一致、usage 落库(g1)', () => {
    const { store, dir } = tempStore();
    try {
      const id = store.appendConversationTurn({
        key: 'qqbot-c2c-abc', role: 'user', content: '早上好呀',
        at: 1_700_000_000_000, meta: { scene: 'c2c' },
      });
      a.ok(Number.isInteger(id) && id > 0, '返回行 id');
      a.equal(store.appendConversationTurn({ key: 'x', content: '   ' }), null, '空 content 不记');
      const assistantId = store.appendConversationTurn({
        key: 'qqbot-c2c-abc', role: 'assistant', content: '早上好!今天想做什么?',
        at: 1_700_000_001_000,
        meta: { usage: { prompt: 6300, completion: 412, cacheHit: 1152, cacheMiss: 5148 } },
      });
      a.ok(assistantId > id, '同会话按插入顺序递增');
      const turns = store.conversationTurns('qqbot-c2c-abc');
      a.equal(turns.length, 2);
      a.equal(turns[0].role, 'user');
      a.equal(turns[0].tokens, approxTokens('早上好呀'), 'tokens 与 approxTokens 同一份口径(D159)');
      a.deepEqual(turns[1].meta.usage, { prompt: 6300, completion: 412, cacheHit: 1152, cacheMiss: 5148 }, 'usage 完整往返');
      a.equal(turns[0].meta.scene, 'c2c', 'meta JSON 往返');
      // 会话隔离:别的 key 读不到
      a.equal(store.conversationTurns('qqbot-group-xyz').length, 0);
    } finally {
      store.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('context:前缀逐字节稳定 —— 追加不改旧轮,重复读逐字相等(缓存命中前提)', () => {
    const { store, dir } = tempStore();
    try {
      store.appendConversationTurn({ key: 'k', role: 'user', content: '第一轮', at: 1 });
      const first = store.conversationTurns('k');
      const firstRender = JSON.stringify(first);
      a.equal(JSON.stringify(store.conversationTurns('k')), firstRender, '重复读逐字相等');
      store.appendConversationTurn({ key: 'k', role: 'assistant', content: '第二轮', at: 2 });
      const second = store.conversationTurns('k');
      a.equal(second.length, 2);
      a.equal(JSON.stringify(second[0]), JSON.stringify(first[0]), '追加不改旧轮(append-only)');
      a.ok(JSON.stringify(second).startsWith(firstRender.replace(/]$/, ',')), '旧前缀保持为稳定前缀');
    } finally {
      store.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('context:limit 取最近 N 轮且正序返回(裁剪的读取侧口径)', () => {
    const { store, dir } = tempStore();
    try {
      for (let i = 1; i <= 5; i += 1) {
        store.appendConversationTurn({ key: 'k', role: 'user', content: `第${i}轮`, at: i });
      }
      a.deepEqual(
        store.conversationTurns('k', { limit: 2 }).map((t) => t.content),
        ['第4轮', '第5轮'],
        '取最近 2 轮,时间正序',
      );
      a.equal(store.conversationTurns('k', { limit: 0 }).length, 5, 'limit=0 全量');
    } finally {
      store.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 刀二C:注入自报家门 + 归档剥壳(docs\21 §六 g2 / §十二) --------------------

  test('context:注入标记 —— wrap/strip 往返、未登记 kind 当场抛', () => {
    const block = wrapInject('handoff', '她昨天答应帮主人钓鱼。');
    a.ok(block.startsWith('[[bridge-inject handoff]]'), '开标记带 kind');
    a.ok(block.endsWith('[[/bridge-inject]]'), '闭标记固定');
    a.equal(stripInjectMarks(`前一句\n${block}\n后一句`), '前一句\n\n后一句', '剥壳后人话原样、块换行不删行');
    a.throws(() => wrapInject('nope', 'x'), /未登记/, '写错 kind 当场抛(别等剥壳静默漏)');
    a.ok(INJECT_KINDS.includes('summary') && INJECT_KINDS.includes('recall'), '登记表含摘要/检索');
  });

  test('context:剥壳 —— 嵌套、无标记原样过、截断剥到文末、孤立闭标记删行', () => {
    // 无标记:原样返回(不碰人话)
    const plain = '正常聊天\n没有标记';
    a.equal(stripInjectMarks(plain), plain);
    a.equal(hasInjectMarks(plain), false);
    // 嵌套:外块整个剥掉(含内块),外面前后的人话保留
    const nested = `人话A\n${injectOpen('handoff')}\n外层\n${injectOpen('facts')}\n内层\n[[/bridge-inject]]\n还是外层\n[[/bridge-inject]]\n人话B`;
    a.equal(stripInjectMarks(nested), '人话A\n\n人话B', '嵌套块整块剥净');
    // 截断的开标记:从它剥到文末(注入内容永远不算她的话)
    a.equal(stripInjectMarks('人话\n[[bridge-inject handoff]]\n注入未闭合\n后面的也丢'), '人话\n');
    // 孤立闭标记:删那一行,别的都不动
    a.equal(stripInjectMarks('人话1\n[[/bridge-inject]]\n人话2'), '人话1\n\n人话2');
    // 剥完非空:整段都是注入时剥完是空白(不炸、不返 null)
    a.equal(stripInjectMarks(wrapInject('recall', '检索结果')).trim(), '');
  });

  test('context:唯一咽喉 —— transcript.stripInjectedBlocks 也剥我们的标记(归档读路径共用)', () => {
    const mixed = `${wrapInject('handoff', '交接内容不该被归档')}\n<system-reminder>旧世界的角色卡</system-reminder>\n用户真正说的话`;
    const stripped = stripInjectedBlocks(mixed);
    a.ok(!hasInjectMarks(stripped), '我们的标记被唯一咽喉剥掉');
    a.ok(!stripped.includes('交接内容不该被归档'), '注入正文不进归档口径');
    a.ok(!stripped.includes('system-reminder'), '旧口径照常工作');
    a.ok(stripped.includes('用户真正说的话'), '人话保留');
  });
}
