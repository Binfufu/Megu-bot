/**
 * 指标的**纯函数**部分(2026-10-02,见 `docs\03` D94)。
 *
 * 为什么单独一个模块:报表里的每个数都该被测试钉住 ——
 * "P90 到底怎么算的"这种事埋在脚本里,不同算法差一档,而**手感会跟着变**。
 *
 * ⚠️ `percentile` 用的是**线性插值**(与 `numpy.percentile` 的默认行为一致)——
 * 这不是小事:同一个 P90,取"最近秩"还是插值能差出几十毫秒,
 * 而"模型变慢了没有"全靠这个数说。选了就把口径写下来,别让下一个人猜。
 */

/**
 * 线性插值分位数。空数组 → `null`(**不返回 0**:0 会被读成"很快",而真相是"没数据")。
 *
 * @param {number[]} values
 * @param {number} p 0–1(0.5 = P50)
 * @returns {number|null}
 */
export function percentile(values, p) {
  const list = (values ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const rank = Math.min(1, Math.max(0, Number(p) || 0)) * (list.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return list[low];
  return list[low] + (list[high] - list[low]) * (rank - low);
}

/** 一组数的摘要:`n / min / P50 / P90 / P99 / max / mean`。 */
export function summarize(values) {
  const list = (values ?? []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (list.length === 0) return { n: 0, min: null, p50: null, p90: null, p99: null, max: null, mean: null };
  const total = list.reduce((sum, value) => sum + value, 0);
  return {
    n: list.length,
    min: Math.min(...list),
    p50: percentile(list, 0.5),
    p90: percentile(list, 0.9),
    p99: percentile(list, 0.99),
    max: Math.max(...list),
    mean: total / list.length,
  };
}

/**
 * 每分钟速率。窗口 ≤ 0 → `null`(不猜:分母不知道就不给数)。
 *
 * @param {number} count
 * @param {number} windowMs
 */
export function ratePerMinute(count, windowMs) {
  const window = Number(windowMs);
  if (!Number.isFinite(window) || window <= 0) return null;
  return (Number(count) || 0) / (window / 60000);
}

/** 命中率(0–1)。分母为 0 → `null`(不是 0%)。 */
export function hitRate(hit, total) {
  const all = Number(total) || 0;
  if (all <= 0) return null;
  return (Number(hit) || 0) / all;
}

/** 毫秒数说成人话(`null` → `—`,免得 0 被当成"很快")。 */
export function formatMs(value) {
  // ⚠️ `Number(null)` 是 **0** —— 只判 isFinite 会把"没数据"打印成"0 ms"(测试当场抓过)。
  if (value === null || value === undefined || value === '') return '—';
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)} 分`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} 秒`;
  return `${Math.round(ms)} ms`;
}

/** 比例说成人话(`null` → `—`,理由同上:`Number(null)` 是 0)。 */
export function formatPercent(value, digits = 1) {
  if (value === null || value === undefined || value === '') return '—';
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * `metric` 表里 `count:*` 的合计 —— 恒等式核对用的那一半。
 *
 * ⚠️ **它必须同时吃两种形状**,因为读 `metric` 有两条路,而它们返回的形状不一样:
 *   · `SqliteStateStore.allMetrics()` → **对象** `{ 'count:turn.ms': 42 }`;
 *   · `openReadOnly().metrics()`      → **行数组** `[{ key, value }]`。
 * 第一版报表拿 `Object.entries(数组)` 去读 → 键变成 `'0' / '1' / '2'` →
 * **`Σ count:*` 恒等于 0**,于是恒等式永远报 ❌(自检第一次跑就抓到了)。
 * 两条路形状不同这件事本身是旧账(项目里有"两条读取路径返回同一形状"那条规矩),
 * 这里先把它**吃掉**,并且由测试把两种形状的结果钉成一致。
 *
 * @param {Array<{key: string, value: number}>|Record<string, number>} metrics
 * @returns {number}
 */
export function metricCounterSum(metrics) {
  const entries = Array.isArray(metrics)
    ? metrics.map((row) => [row?.key, row?.value])
    : Object.entries(metrics ?? {});
  let sum = 0;
  for (const [key, value] of entries) {
    if (String(key ?? '').startsWith('count:')) sum += Number(value) || 0;
  }
  return sum;
}
