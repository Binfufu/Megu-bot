/**
 * **进程级崩溃日志钩子**(2026-10-16,1.150.81)。
 *
 * ## 为什么要有它
 *
 * own 生产进程曾**静默死亡一次**(2026-10-16 11:14–11:34Z 之间,无任何错误日志)——
 * 崩溃后连"为什么死的"都没留下,残锁还是靠守护接管才发现。最可能的形状是
 * unhandledRejection / uncaughtException 级别的瞬崩,而那两种死的默认行为
 * 恰好是**一个字都不说**。
 *
 * ## 语义(与 Node 默认一致,差别只是"死因留档")
 *
 * - `uncaughtException` → 完整栈写进桥日志 → `exit(1)`(守护会把进程拉回来);
 * - `unhandledRejection` → 同上。
 * ⚠️ 装了这个钩子,**默认崩溃**就由这里接管 —— 所以必须**自己 exit(1)**,
 *    否则等于把"崩了要退"改成"崩了装没事"(那是把静默失效换个地方藏)。
 *
 * ⚠️ 只在 `main()`(生产入口)里安装;自测/探针的隔离进程**不装**,
 *    免得测试里故意抛的错被钩子改道(那些"故意红"是判据,不是事故)。
 */

/** 把两只钩子挂上 process。`log` 需要 `error(...)`(与 src/log.js 同形)。 */
export function installCrashLogging(log) {
  process.on('uncaughtException', (err) => {
    try { log.error(`uncaughtException(未捕获异常,进程退出): ${err?.stack ?? err}`); } catch { /* 日志失败也要退 */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    try { log.error(`unhandledRejection(未处理的 Promise 拒绝,进程退出): ${reason?.stack ?? reason}`); } catch { /* 同上 */ }
    process.exit(1);
  });
}
