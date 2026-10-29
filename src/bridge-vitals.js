/**
 * 桥进程自己的「生命体征」:**收得到吗?发得出吗?**(2026-10-21,1.168.0 / D275)
 *
 * ### 解决什么病:「她在跑但她聋了」
 *
 * 现有的三层看门狗各盯一段,中间留着一个没人盯的洞:
 *
 *   · `supervisor.js` 盯 **进程**(锁 + PID + startedAt,崩了自己拉起来);
 *   · `tunnel-watch.js` 盯 **公网入口**(D166:进程在跑 ≠ 网址能用);
 *   · `embed-watch.js` 盯 **embedding 服务**(/health)。
 *
 * 但 **WebSocket 连着、进程活着、事件一条也不来**(网关静默 / 额度耗尽 / 审核下线)
 * 这个形状,三层都看不见 —— 日志不滚动是唯一的症状,靠人肉发现。
 *
 * 判据形状照搬成熟方案(用户 2026-10-21 拍板「阈值直接参考成熟方案定」):
 *
 *   · **盯「最后一条真实入站事件的年龄」,不盯连接心跳** —— Kafka 的 time-based
 *     consumer lag 就是这个形状(time-lag = now − 最后消费事件的时间戳);
 *   · **被动数据有年龄上限** —— Nagios/Icinga 的 freshness check(被动检查结果
 *     超过 freshness_threshold 就判 stale),社区惯例阈值是 **1 小时**。
 *
 * 所以 `DEFAULT_STALE_AFTER_MS` 取 60 分钟:出处 = Icinga freshness check 惯例,
 * **【暂定】** —— 两只 bot 的群况不同、白天夜里不同,要改先看 `bridge-status.json`
 * 里攒下来的真实年龄分布(主人拍板过再定死)。
 *
 * ### 口径(三件事分开,不许混)
 *
 *   · **收到** = dispatch 层见到消息类事件(`MESSAGE_EVENT_TYPES`)—— 哪怕正文空
 *     被丢弃,也证明"平台还在推、我们收得到";其它事件(入群/生命周期)只证明连接活着。
 *   · **发出** = `QqApi` 仅有的两个消息出口(文本 `#post` / 富媒体 `sendMedia`)各记
 *     成功/失败 —— 发送持续失败是额度耗尽的直接信号(与"收不到"是两种病)。
 *   · **没数据 ≠ 没聋**:启动后一条消息都没见过,判定是 `unknown` ——
 *     不是 fresh(不许把"没数据"读成"很好",与 `metrics.js` 的 `null ≠ 0` 同一条纪律)。
 *
 * ### 暴露面(两层,读的人不同)
 *
 *   · `data\<bot>\bridge-status.json`:30 秒心跳原子写(index.js 装配),给本机巡检/
 *     人工查看;文件里带 `capturedAt`,读到陈旧文件的人自己算年龄。一期没有自动消费者。
 *   · `/api/ping`(内部身份或长票)带 `vitals` 快照,一期只记录/暴露供人工巡检。
 *     ⚠️ 无票 ping 仍是 200 裸 ok/at,不带 vitals(D183);vitals 只给内部身份或长票,
 *     且快照里**只有计数与时间戳**,没有身份、没有内容。
 */

import fs from 'node:fs';
import path from 'node:path';

/** stale 判定默认阈值:60 分钟(Icinga freshness check 社区惯例;【暂定】)。 */
export const DEFAULT_STALE_AFTER_MS = 3_600_000;

/**
 * 造一份生命体征记录器(桥进程内**一份**,QQ 收发两侧共用)。
 *
 * @param {{now?: () => number}} [options]
 */
export function createBridgeVitals({ now = Date.now } = {}) {
  const startedAt = now();
  let lastEventAt = null;
  let lastEventType = null;
  let lastMessageAt = null;
  let lastMessageType = null;
  let sendAttempts = 0;
  let sendOk = 0;
  let sendFailed = 0;
  let lastSendOkAt = null;
  let lastSendFailAt = null;

  return {
    /** 进程内的启动时刻(重启后从零计 —— 判定只看窗口内,不跨重启)。 */
    startedAt: () => startedAt,

    /** dispatch 层见到任何平台事件(连接活着的证据)。 */
    noteEvent(type, at = now()) {
      lastEventAt = at;
      lastEventType = String(type ?? '');
    },

    /** 见到消息类事件(**"收得到"的唯一证据**;空正文被丢的也算)。 */
    noteMessage(type, at = now()) {
      lastMessageAt = at;
      lastMessageType = String(type ?? '');
    },

    /** 消息发送出口(文本/富媒体)记一笔;`ok` = 平台接受了。 */
    noteSend(ok, at = now()) {
      sendAttempts += 1;
      if (ok) {
        sendOk += 1;
        lastSendOkAt = at;
      } else {
        sendFailed += 1;
        lastSendFailAt = at;
      }
    },

    /**
     * 纯 JSON 快照(写盘与 /api/ping 共用一份形状;**只有计数与时刻**)。
     */
    snapshot(at = now()) {
      return {
        startedAt,
        lastEventAt,
        lastEventType,
        lastMessageAt,
        lastMessageType,
        sendAttempts,
        sendOk,
        sendFailed,
        lastSendOkAt,
        lastSendFailAt,
        capturedAt: at,
      };
    },
  };
}

/**
 * 「她聋了吗」判定(纯函数,判据进 selftest)。
 *
 * @param {{lastMessageAt?: number|null}} snapshot `createBridgeVitals().snapshot()` 的形状
 * @param {{now?: number, staleAfterMs?: number}} [options]
 * @returns {{verdict: 'fresh'|'stale'|'unknown', reason: string}}
 *   `fresh` = 窗口内见过消息事件;`stale` = 超过阈值;`unknown` = 没数据/时钟倒挂。
 */
export function judgeStaleness(snapshot, { now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const last = snapshot?.lastMessageAt;
  if (!Number.isFinite(last)) {
    return { verdict: 'unknown', reason: '启动以来还没收到过任何消息事件(没数据不算没聋)' };
  }
  const age = now - last;
  if (!Number.isFinite(age) || age < 0) {
    return { verdict: 'unknown', reason: '最后消息时刻在未来(时钟倒挂),不判' };
  }
  if (age <= staleAfterMs) {
    return { verdict: 'fresh', reason: `最后一条消息事件在 ${Math.round(age / 1000)} 秒前` };
  }
  return {
    verdict: 'stale',
    reason: `最后一条消息事件在 ${Math.round(age / 60_000)} 分钟前(超过 ${Math.round(staleAfterMs / 60_000)} 分钟阈值)—— 连接活着但她可能聋了`,
  };
}

/**
 * 原子写状态文件:先写临时文件再 rename,读的人永远看不到半截 JSON
 * (与 `supervisor.js` 的 `writeJsonAtomic` 同一个形状;Windows 上 rename 覆盖已存在文件)。
 *
 * ⚠️ 这里**不**做目录创建以外的事:写失败原样上抛,让调用方决定"心跳失败"怎么报
 * (index.js 的心跳只 warn,不许把机器人带崩 —— 与 D89"落账失败不许带走回忆"同一条纪律)。
 *
 * @param {string} file
 * @param {unknown} value
 */
export function writeStatusAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也不能盖住原错误 */ }
    // ⚠️ 双审 Y16:失败时把残留的 .tmp 清掉 —— 否则目标目录只读一次,盘上就永远
    //    留着一个半截 JSON(心跳每 30 秒重试一次,不会自己收拾)。
    
    throw err;
  }
}

/**
 * 心跳写失败要不要**这次**喊一声(双审 Y16)。
 *
 * 30 秒一拍 = 每天 2880 拍;目标文件一旦不可写(只读/被占),不节流就是 2880 条 warn/天/只,
 * 把日志撑大、把真问题埋掉。这里只在第 1 次、第 10 次、第 100 次、以及之后每 1000 次喊;
 * **连续失败计数由调用方维护,成功一次就归零**(恢复时还要喊一句"写回来了")。
 *
 * @param {number} consecutiveFailures 含本次的连续失败次数(从 1 开始)
 */
export function shouldWarnVitalsFailure(consecutiveFailures) {
  const n = Number(consecutiveFailures);
  if (!Number.isFinite(n) || n < 1) return false;
  if (n === 1 || n === 10 || n === 100) return true;
  return n > 100 && n % 1000 === 0;
}
