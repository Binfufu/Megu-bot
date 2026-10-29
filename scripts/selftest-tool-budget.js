/**
 * **工具日预算 + 凭据回落**(P3,2026-10-28)回归。
 *
 * 主人 2026-10-28 拍板:搜索与 bot 同一份 key;日额度 1¥;全部群开放。
 * 判据钉的是四件事:
 *   · 预算账本:当日累计、超限、**跨日自愈**、坏 meta 不卡闸也不开闸;
 *   · withBudget:**成功才记账**(与官方"失败不计费"一致),超限时 execute 根本不跑;
 *   · provider:bot 同源的 baseUrl 带 `/v1` 尾时不许拼出 `/v1/v1/tools`;
 *   · wiring:index 缺省回落 bot slot、预算闸在 buildToolContext 里、config 默认 1¥。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { budgetDayKey, createToolBudget } from '../src/tool-budget.js';
import { defineCapability, withBudget } from '../src/capabilities.js';
import { createWebSearchProvider } from '../src/web-search-provider.js';

function metaStore() {
  const map = new Map();
  return {
    getMeta: (k) => map.get(k) ?? null,
    setMeta: (k, v) => map.set(k, String(v)),
  };
}

const DAY1 = new Date('2026-10-28T10:00:00+08:00').getTime();
const DAY2 = new Date('2026-10-29T10:00:00+08:00').getTime();

export function registerToolBudgetTests({ test, assert: a }) {
  test('预算账本:当日累计、超限、跨日自愈、坏 meta 当 0', () => {
    const store = metaStore();
    const budget = createToolBudget({ store, dailyLimitCny: 1, perCallCny: 0.0054, now: () => DAY1 });
    a.equal(budget.remainingCny(), 1);
    budget.record();
    a.ok(Math.abs(budget.spentCny() - 0.0054) < 1e-9, '记一笔');
    a.equal(budget.canSpend(), true);
    // 坏 meta:既不卡闸也不开闸 —— 当 0 处理(闸门坏掉时宁可回到"默认能查",次日重置也一样)。
    store.setMeta(`tools:search-spend:${budgetDayKey(DAY1)}`, 'not-a-number');
    a.equal(budget.spentCny(), 0);
    // 跨日:昨天的账不进今天。
    store.setMeta(`tools:search-spend:${budgetDayKey(DAY1)}`, '0.9');
    a.equal(budget.canSpend(), true, '剩 0.1 > 0');
    a.ok(Math.abs(budget.remainingCny() - 0.1) < 1e-9);
    store.setMeta(`tools:search-spend:${budgetDayKey(DAY1)}`, '1');
    a.equal(budget.canSpend(), false, '当日花完 → 关');
    const nextDay = createToolBudget({ store, dailyLimitCny: 1, perCallCny: 0.0054, now: () => DAY2 });
    a.equal(nextDay.canSpend(), true, '次日自愈,不欠账');
    // 非法参数:当场抛(闸门配错不许静默放开)。
    a.throws(() => createToolBudget({ store, dailyLimitCny: -1, perCallCny: 0.0054 }));
    a.throws(() => createToolBudget({ store: {}, dailyLimitCny: 1, perCallCny: 0.0054 }));
  });

  test('withBudget:成功才记账、失败不记、超限时 execute 根本不跑', async () => {
    let executed = 0;
    const cap = defineCapability({
      id: 'web_search', description: 'x',
      inputSchema: { type: 'object' },
      effect: 'read-only', costCny: 0.0054,
      execute: async () => { executed += 1; return { ok: true, results: [] }; },
    });
    const store = metaStore();
    const budget = createToolBudget({ store, dailyLimitCny: 1, perCallCny: 0.0054, now: () => DAY1 });
    const wrapped = withBudget(cap, budget);
    await wrapped.execute({}, {});
    a.equal(executed, 1);
    a.ok(budget.spentCny() > 0, '成功 → 记账');
    // 失败:不记账(官方失败不计费)。
    const failing = withBudget(defineCapability({
      id: 'web_search', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only',
      costCny: 0.0054, execute: async () => ({ ok: false, error: { code: 'RATE_LIMIT', retryable: true } }),
    }), budget);
    const before = budget.spentCny();
    const bad = await failing.execute({}, {});
    a.equal(bad.ok, false);
    a.equal(budget.spentCny(), before, '失败不许扣额度');
    // 超限:execute 不跑,结构化 BUDGET_EXCEEDED。
    const broke = createToolBudget({ store, dailyLimitCny: 0, perCallCny: 0.0054, now: () => DAY1 });
    const brokeCap = withBudget(cap, broke);
    const denied = await brokeCap.execute({}, {});
    a.equal(denied.error.code, 'BUDGET_EXCEEDED');
    a.equal(executed, 1, '超限时真 execute 一次都不跑');
    // defineCapability:costCny 非法当场抛;costCny 0 合法。
    a.throws(() => defineCapability({ id: 'x1', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only', costCny: -1, execute: async () => {} }));
    const free = defineCapability({ id: 'free_cap', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only', execute: async () => ({ ok: true }) });
    a.equal(free.costCny, 0);
  });

  test('provider 同源 baseUrl:带 /v1 尾不许拼出 /v1/v1/tools', async () => {
    let seenUrl = null;
    const provider = createWebSearchProvider({
      baseUrl: 'https://api.deepseek.com/v1', // bot 同源形状(chat 端点带 /v1)
      apiKey: 'fixture',
      fetchImpl: async (url) => { seenUrl = String(url); return { ok: true, status: 200, json: async () => ({ results: [] }) }; },
    });
    await provider.search('x');
    a.equal(seenUrl, 'https://api.deepseek.com/v1/tools/search', `实际 ${seenUrl}`);
  });

  test('wiring:index 凭据回落 bot slot、预算双闸、config 拍板值(扫源码)', () => {
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    a.match(indexSource, /searchBase = bot\?\.baseUrl/, '凭据缺省回落 bot slot(主人拍板:同一份 key)');
    a.match(indexSource, /searchKey = bot\?\.apiKey/, 'key 同源');
    a.match(indexSource, /withBudget\(defineCapability\(\{ \.\.\.spec, costCny: toolsCfg\.searchPerCallCny \}\), toolBudget\)/,
      '能力必须过 withBudget(成功才记账)');
    const fnStart = indexSource.indexOf('function buildToolContext(');
    const fnBody = indexSource.slice(fnStart, fnStart + 1600);
    const budgetAt = fnBody.indexOf('!toolBudget.canSpend()');
    a.ok(budgetAt > 0, 'buildToolContext 要有预算闸(花完当日不发)');
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    a.match(configSource, /asNonNegativeInt\('QQBOT_SEARCH_DAILY_LIMIT_CNY', 1\)/, '日额度默认 1¥(2026-10-28 拍板)');
    a.match(configSource, /QQBOT_SEARCH_PER_CALL_CNY/, '单价刻度可调');
  });
}
