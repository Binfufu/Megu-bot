/**
 * 把错误翻成"人话"的小工具。
 *
 * 这里只放**需要判据**的翻译 —— 即"看的人必须能自己判断该不该管"的那些错误。
 * 通用的错误描述在 `src/log.js` 的 `describeError()`(串 cause 链),两者不重复:
 *   · `describeError()` 负责"把根因挖出来";
 *   · 这里负责"这个根因意味着什么、下一步做什么"。
 */

/**
 * 启动时的**瞬时**失败 —— 一眼看上去像故障,其实等一下自愈。
 *
 * 现场(2026-09-29 重启电脑后实测,惠惠与爱丽丝**同时**都栽了两次):
 *
 * ```
 * 10:43:37 [error] bridge 启动失败 TypeError: fetch failed
 *                ← Error: EE certificate key too weak (UNSPECIFIED)
 * 10:43:40 第二次:同样失败
 * 10:43:47 第三次:成功,随后 READY
 * ```
 *
 * **为什么这不是"平台封了"也不是"我们坏了"**(判据,别猜):
 *   · 同一台机器、两份不同的配置,**同时**出现 → 不是各自的问题;
 *   · 同一进程**重试两三次就成** → 不是稳定状态;
 *   · 报错里既有 `fetch failed / ConnectTimeout`(网络还没起来)
 *     又有 `EE certificate key too weak`(证书栈还没就绪) → 是**刚开机那几秒**的形状:
 *     DNS/网络/证书栈在系统启动后才逐步可用,而 bridge 起得比它早。
 *
 * **为什么不去写"自动重试"**：进程级重拉**已经**在兜这件事(`run.cmd` 的退出码 7 /
 * 标记文件、守护的退避重拉),再加一层是重复机制、也多一处能坏的地方。
 * 缺的只是"这句话说人话",所以这里只加**判据与出路**,不改行为。
 *
 * @param {unknown} err
 * @returns {string|null} null = 不是这一类(交给调用方按普通失败处理)
 */
export function describeTransientStartupError(err) {
  const text = collectErrorText(err);
  if (!text) return null;

  const certRace = /EE certificate key too weak|certificate key too weak/i.test(text);
  const netRace = /fetch failed|ENOTFOUND|ECONNREFUSED|ConnectTimeout|Connect Timeout|EAI_AGAIN|socket hang up|ECONNRESET/i.test(text);
  // 两条**同时**命中才算"刚开机那个竞态";只命中一条时更像真故障,别安慰人
  if (!(certRace && netRace)) return null;

  return [
    '⚠️ 看起来是**刚开机那几秒**的瞬时失败(网络/证书栈还没就绪),不是平台封禁、也不是代码坏了。',
    '  判据:报错里同时有 fetch/ConnectTimeout(网络)与 certificate key too weak(证书栈)。',
    '  bridge 起得比系统的网络栈早;启动器/守护会整进程重拉,通常第 2–3 次就成。',
    '  如果**连续失败多次仍起不来**,那才要查:看日志里有没有一行 `已获取 access_token`',
    '  (有 = 凭据被平台接受,问题在别处);没有就查这台机器能不能访问 api.bot.qq.com。',
  ].join('\n');
}

/**
 * 把 error 的整条 cause 链拼成一段文本(只看文字,不解释)。
 *
 * ⚠️ 为什么要自己走链:undici 的 `fetch failed` 把真正的原因藏在 `cause` 里,
 *    `String(err)` 只会给你"fetch failed" —— 而这个函数要判的正是**根因**里的关键字。
 */
function collectErrorText(err) {
  const seen = new Set();
  const parts = [];
  let cursor = err;
  for (let depth = 0; depth < 6 && cursor; depth += 1) {
    if (typeof cursor === 'object') {
      if (seen.has(cursor)) break;
      seen.add(cursor);
    }
    const fragment = [
      cursor?.name,
      cursor?.message,
      cursor?.code,
      cursor?.errno,
    ].filter((value) => value !== undefined && value !== null && value !== '').join(' ');
    if (fragment) parts.push(fragment);
    cursor = typeof cursor === 'object' ? cursor.cause : null;
  }
  if (typeof err === 'string') parts.push(err);
  return parts.join(' | ');
}
