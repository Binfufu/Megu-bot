/**
 * **工具日预算**(P3,2026-10-28)—— 主人拍板:搜索日额度上限 **1¥**。
 *
 * ## 口径(全部写给复查的人看)
 *
 * · **周期 = 自然日本地日**(超限后到次日 0 点自动恢复);
 * · **只记成功调用** —— DeepSeek 官方就是"失败不计费",闸门口径与账单口径一致;
 * · **单价进配置**【暂定】:官方价 $0.75/1000 次成功请求,按 7.2 汇率 ≈ ¥0.0054/次。
 *   汇率不追涨跌、不从网上现拉 —— 主人拍板的是"1¥/日"这道闸,换算系数只是闸门的刻度,
 *   `QQBOT_SEARCH_PER_CALL_CNY` 随时可调,调了立刻生效;
 * · **存储注入**:用桥现成的 `state.db` meta 键(`getMeta`/`setMeta`),重启累计不丢,
 *   不建新表、不开新库。
 */

/** 本地自然日键(YYYY-MM-DD;`toLocaleDateString('sv')` 正好给这个形状)。 */
export function budgetDayKey(ts) {
  return new Date(ts).toLocaleDateString('sv');
}

/**
 * 造一个日预算账本。
 *
 * @param {{store: {getMeta: Function, setMeta: Function}, key?: string,
 *          dailyLimitCny: number, perCallCny: number, now?: () => number}} input
 *   `dailyLimitCny` = 主人拍板的日上限(¥);`perCallCny` = 每次成功调用的估算成本(¥)。
 */
export function createToolBudget({ store, key = 'tools:search-spend', dailyLimitCny, perCallCny, now = Date.now }) {
  if (!store || typeof store.getMeta !== 'function' || typeof store.setMeta !== 'function') {
    throw new Error('createToolBudget: store 需要 getMeta/setMeta(用 state.db 的 meta,不建新表)');
  }
  const limit = Number(dailyLimitCny);
  const cost = Number(perCallCny);
  if (!Number.isFinite(limit) || limit < 0) throw new Error('createToolBudget: dailyLimitCny 非法');
  if (!Number.isFinite(cost) || cost < 0) throw new Error('createToolBudget: perCallCny 非法');
  const metaKey = (ts) => `${key}:${budgetDayKey(ts)}`;

  function readCny(ts) {
    const raw = store.getMeta(metaKey(ts));
    const value = Number(raw);
    // 坏值/缺值 = 0(没花过)—— 不让一条坏 meta 把闸门卡死,也不让它把闸门打开。
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  return {
    /** 今日已花(¥)。 */
    spentCny(ts = now()) {
      return readCny(ts);
    },
    /** 今日还剩(¥);夹到 ≥0。 */
    remainingCny(ts = now()) {
      return Math.max(0, limit - readCny(ts));
    },
    /** 记一笔成功调用。返回累计值。 */
    record(costOverride = null, ts = now()) {
      const add = Number(costOverride ?? cost);
      const total = readCny(ts) + (Number.isFinite(add) && add > 0 ? add : 0);
      // 存 6 位小数的字符串 —— meta 是字符串口诀,setMeta 只收字符串。
      store.setMeta(metaKey(ts), String(Math.round(total * 1e6) / 1e6));
      return total;
    },
    /** 今日是否还能调(remaining > 0)。 */
    canSpend(ts = now()) {
      return this.remainingCny(ts) > 0;
    },
  };
}
