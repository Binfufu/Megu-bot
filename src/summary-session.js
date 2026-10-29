/**
 * **摘要子会话的取键规则**(2026-10-15)。
 *
 * 背景(D135):摘要子会话曾经共用一个固定会话 —— 实测它连跑 832 次、前缀涨到 79 万 token,
 * 吃掉了两只机器人 98.4% 的账单。所以有了"用满 N 次就换一代键"的轮换。
 *
 * ⚠️ **这次补的是轮换的那个缺口**:原来的 `gen/calls` 是**纯进程内**变量,而历史是**落盘**的。
 *    进程一重启 → 计数归零 → 又回到 `qqbot-summary` 这条**已经攒满的旧会话**继续追加。
 *    实测(2026-10-15 影子库):`qqbot-summary` 48 个 user 轮 / 209153 字符,
 *    而 `-1`(65~89)与 `-2`(90~103)的 id 区间与主键(1~151)**交错** —— 正是"重启回到第 0 代"的指纹。
 *    ⇒ 现在从**盘上已有的 user 轮数**决定承接哪一代:用满的代绝不回头。
 *
 * 口径:一次摘要调用落一条 user 轮,所以"这一代被用过几次" = 这个键上的 user 轮条数。
 * 上限(`maxCalls`)是配置里的值,这里不另立数字。
 */

/** 摘要子会话的键前缀(观测器/判据共用这一份,不许各写一遍)。 */
export const SUMMARY_KEY_PREFIX = 'qqbot-summary';

/** 代次计数落在状态库的这个 meta 键上(跨重启;DSH 模式没有我们的会话库,只能靠它)。 */
export const SUMMARY_SESSION_META_KEY = 'summary_session';

/** 第 0 代仍用老键 `qqbot-summary`(与旧日志、旧判据对得上);第 N 代加后缀。 */
export function summarySessionKey(gen) {
  const n = Number.isSafeInteger(gen) && gen > 0 ? gen : 0;
  return n === 0 ? SUMMARY_KEY_PREFIX : `${SUMMARY_KEY_PREFIX}-${n}`;
}

export function planSummarySession({ maxCalls, callsOnDisk }) {
  const cap = Number.isSafeInteger(maxCalls) && maxCalls > 0 ? maxCalls : 1;
  const used = typeof callsOnDisk === 'function' ? callsOnDisk : () => 0;
  const count = (gen) => {
    const n = Number(used(gen));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  let gen = 0;
  // 防御:盘上若出现异常长的一串满代,也不许在这里转成死循环。
  while (gen < 10000 && count(gen) >= cap) gen += 1;
  return { gen, calls: count(gen) };
}

/**
 * 选"该用哪一代":把**盘上用量**与**持久化的计数**取更靠前的那个。
 *
 * 为什么要两个来源:
 *   · 盘上用量 —— 真实的对话历史在哪一代(own 模式与影子模式的库不同,调用方负责问对库);
 *   · 持久化计数 —— 后端根本没有我们的库时(DSH 模式),只能靠它跨重启记住"用到第几代了"。
 * 两者都坏 ⇒ 退回第 0 代(与旧行为一致),绝不凭空跳代。
 *
 * @param {{maxCalls: number, callsOnDisk: (gen: number) => number, persisted?: {gen: number, calls: number}|null}} options
 * @returns {{gen: number, calls: number, from: 'disk'|'persisted'|'none'}}
 */
export function pickSummarySession({ maxCalls, callsOnDisk, persisted = null }) {
  const disk = planSummarySession({ maxCalls, callsOnDisk });
  const saved = persisted && Number.isSafeInteger(persisted.gen) && persisted.gen >= 0
    && Number.isSafeInteger(persisted.calls) && persisted.calls >= 0 ? persisted : null;
  if (!saved) return { ...disk, from: disk.gen > 0 || disk.calls > 0 ? 'disk' : 'none' };
  if (saved.gen > disk.gen) return { gen: saved.gen, calls: saved.calls, from: 'persisted' };
  if (saved.gen === disk.gen && saved.calls > disk.calls) return { gen: saved.gen, calls: saved.calls, from: 'persisted' };
  return { ...disk, from: disk.gen > 0 || disk.calls > 0 ? 'disk' : 'none' };
}

/** 从 meta 里读持久化的计数(坏值当没有 —— 与旧行为一致,不猜)。 */
export function parseSummarySessionMeta(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const gen = Number(parsed.gen); const calls = Number(parsed.calls);
    if (!Number.isSafeInteger(gen) || gen < 0 || !Number.isSafeInteger(calls) || calls < 0) return null;
    return { gen, calls };
  } catch { return null; }
}
