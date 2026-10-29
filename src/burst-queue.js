/**
 * 「连发合并」的**计时状态机**(2026-09-30,见 `docs\03` D71)。
 *
 * 它只管时间与合并,不管"怎么说话":到点了就回调 `onReady(key, bursts, message)`,
 * 具体怎么跑一轮模型、怎么发出去,由调用方决定。这么切有两个理由:
 *
 * 1. **它可以被测**。原来这段住在 `index.js` 的 `main()` 里(装配代码),而
 *    "窗口重排 / 到点只开口一次 / 会话正忙时退避"恰恰是最容易写错、又最该有测试的地方
 *    (那个盲区真实咬过人,见 `docs\04` §6.4)。切出来之后可以用假计时器手动推进,
 *    不必等真的 3 秒、也不必碰真 QQ。
 * 2. **规则仍然在 `src\burst.js`**(纯函数:什么时候进窗口、提示词怎么拼、退避阶梯)。
 *    这里只是"把那些规则接到计时器上"。
 *
 * 形状:`会话key → { timer, bursts: [{text, at}], message, imageMessage, attempts }`。
 * `message` 留**最后一条** —— 被动回复要用它的 `msg_id`。
 * `imageMessage` 留**最后一条带图的** —— ⚠️ 图**不跟 newest 走**:
 * "先发一张图、再补一句话"是私聊里最常见的一类投喂,而 newest 那句话没有图,
 * 于是图会**被顶掉**(既没进模型,也没进投喂结算)。见 `docs\03` D96。
 */

/**
 * @param {object} [options]
 * @param {number} [options.intervalMs] 合并窗口;`<= 0` = 关闭(进队列的消息会立刻开口)
 * @param {() => number} [options.now] 时间源
 * @param {(fn: () => void, ms: number) => object} [options.setTimer] 计时器
 * @param {(timer: object) => void} [options.clearTimer]
 * @param {(key: string, bursts: Array<{text: string, at: number}>, message: object, imageMessage: object|null) => void} options.onReady
 *   **到点了**,该把这几条合成一轮说出去(调用方负责真的跑一轮)。
 *   `imageMessage` = 这一串里**最后一条带图的**(没有就是 null)—— 见文件头那条说明。
 * @param {(key: string) => boolean} [options.isBusy] 这个会话正忙吗(忙则退避,不丢消息)
 * @param {(ms: number) => number} [options.nextDelay] 退避阶梯(默认 `nextRecheckDelay`)
 * @param {(info: object) => void} [options.onFlush] flush 一次回调一次(测试用)
 * @param {(line: string) => void} [options.onInfo] 给人看的日志
 */
export function createBurstQueue(options) {
  const intervalMs = Number.isFinite(options?.intervalMs) ? options.intervalMs : 0;
  const now = options?.now ?? (() => Date.now());
  const setTimer = options?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options?.clearTimer ?? ((timer) => clearTimeout(timer));
  const isBusy = options?.isBusy ?? (() => false);
  const nextDelay = options?.nextDelay ?? ((attempt) => [10_000, 30_000, 60_000][Math.min(Math.max(0, attempt), 2)]);
  const onReady = options?.onReady ?? (() => {});
  const onFlush = options?.onFlush;
  const onInfo = options?.onInfo ?? (() => {});

  const pending = new Map();

  /** 把攒着的几条开口说出去,或者(会话正忙时)重新排一次队。 */
  function flush(conversationKey) {
    const entry = pending.get(conversationKey);
    if (!entry) return false;
    clearTimer(entry.timer);
    pending.delete(conversationKey);

    // 会话正忙:用户很可能在她回话的同时又补了一句 —— 那一句该等下一轮,
    // 既不能丢,也不能原地死循环。退避阶梯见 `src\burst.js` 的 `nextRecheckDelay`。
    if (isBusy(conversationKey)) {
      entry.attempts += 1;
      const delay = nextDelay(entry.attempts - 1);
      onInfo(
        `连发合并：会话 ${conversationKey} 有会话在跑，${(delay / 1000).toFixed(0)}s 后再看` +
        `（攒着 ${entry.bursts.length} 条，第 ${entry.attempts} 次推迟）`,
      );
      const timer = setTimer(() => flush(conversationKey), delay);
      timer?.unref?.();
      pending.set(conversationKey, { ...entry, timer });
      onFlush?.({ conversationKey, postponed: true, bursts: entry.bursts.length });
      return false;
    }

    onInfo(
      `连发合并：会话 ${conversationKey} 攒了 ${entry.bursts.length} 条` +
      `（跨度 ${(((entry.bursts.at(-1)?.at ?? 0) - (entry.bursts[0]?.at ?? 0)) / 1000).toFixed(1)}s），现在开口`,
    );
    onFlush?.({ conversationKey, postponed: false, bursts: entry.bursts.length });
    onReady(conversationKey, entry.bursts, entry.message, entry.imageMessage ?? null);
    return true;
  }

  /** 一条消息进入队列;已有的那一条会被追加,**窗口重新计时**。 */
  function push(message, conversationKey) {
    const existing = pending.get(conversationKey);
    const at = now();
    if (existing) {
      clearTimer(existing.timer);
      existing.bursts.push({ text: message.content, at });
      existing.message = message;
      // ⚠️ 图**单独记一条**:后补的那句文字会把 `message` 顶掉,但图不能被顶掉
      // (见文件头:"先发图、再补一句话")。
      if ((message.images?.length ?? 0) > 0) existing.imageMessage = message;
      onInfo(`连发合并：又有 1 条（会话 ${conversationKey} 共 ${existing.bursts.length} 条），窗口重新计时`);
      if (intervalMs <= 0) {
        flush(conversationKey);
        return;
      }
      const timer = setTimer(() => flush(conversationKey), intervalMs);
      timer?.unref?.();
      existing.timer = timer;
      return;
    }

    const timer = intervalMs > 0 ? setTimer(() => flush(conversationKey), intervalMs) : null;
    timer?.unref?.();
    pending.set(conversationKey, {
      timer,
      bursts: [{ text: message.content, at }],
      message,
      imageMessage: (message.images?.length ?? 0) > 0 ? message : null,
      attempts: 0,
    });
    // 窗口关掉时不留队列:立刻当成"一条就是一轮"(旧行为)。
    if (intervalMs <= 0) flush(conversationKey);
  }

  /** 收尾:清掉所有计时器,并报出"有几句没来得及开口"(绝不静默丢)。 */
  function stop() {
    const dropped = pending.size;
    for (const entry of pending.values()) clearTimer(entry.timer);
    pending.clear();
    if (dropped > 0) onInfo(`连发合并队列里还有 ${dropped} 个会话没来得及开口（本轮不补发）`);
    return dropped;
  }

  /** 丢弃某个会话的待发合并(不发送、不回调;返回丢掉的条数)。/重置 的"清空重来"语义(T1-D,2026-10-29)。 */
  function drop(conversationKey) {
    const entry = pending.get(conversationKey);
    if (!entry) return 0;
    clearTimer(entry.timer);
    pending.delete(conversationKey);
    return entry.bursts.length;
  }

  return {
    push,
    flush,
    drop,
    stop,
    size: () => pending.size,
    has: (conversationKey) => pending.has(conversationKey),
  };
}
