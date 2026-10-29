/**
 * **瞬时故障重试**(2026-10-01,见 `docs\03` D88 的复盘)。
 *
 * ## 为什么要有这个文件
 *
 * 现场:爱丽丝的旁白在**一个群成功、另一个群失败** —— 失败那次是
 * `TypeError: fetch failed ← ConnectTimeoutError (api.bot.qq.com:443, timeout 10000ms)`。
 * 也就是说**代码没问题、群也没问题**,是那一次连接撞上了网络抖动。
 *
 * 这个项目里已经有先例:图片上传遇到 `40093001` 时**必须重试**(实测第一次必挂、重试就过),
 * 见 `src/qq.js`。这里把那条经验抽成一个通用小函数,**只做一件事**:
 * 失败就按递增间隔再试,试完还不行就把最后一次的错**抛出去**(交给调用方决定怎么办)。
 *
 * ⚠️ 两条边界:
 *   · **只用于"重试无害"的动作** —— 发送、拉取这类;有副作用又可能已经生效的操作不要用;
 *   · **次数与间隔必须显式给**,不给默认值就等着某个地方偷偷重试 100 次把配额烧光。
 */

/**
 * @template T
 * @param {() => Promise<T>} fn 要执行的异步动作
 * @param {{attempts?: number, delayMs?: number, onError?: (error: unknown, attempt: number) => void,
 *          sleep?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<T>} 第一次成功的结果;全都失败时抛**最后一次**的错
 */
export async function retryAsync(fn, {
  attempts = 3,
  delayMs = 1500,
  onError = null,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  const total = Math.max(1, Number(attempts) || 1);
  let lastError = null;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (typeof onError === 'function') onError(error, attempt);
      // 最后一次失败不再等 —— 等完也没有下一次了。
      if (attempt < total) await sleep(Math.max(0, delayMs) * attempt);
    }
  }
  throw lastError;
}
