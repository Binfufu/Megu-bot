/**
 * 测试专用：在本机回环上取一个**不会被 Fetch 规范拦掉**的端口(2026-10-30)。
 *
 * 为什么需要:很多套件用 `server.listen(0, '127.0.0.1')` 拿系统临时端口,再用全局
 * `fetch` 连它。但 Fetch 规范有一张 **blocked port** 表(4045 / 6000 / 6665-6669 /
 * 10080 等),undici 对落到表里的端口直接抛 `TypeError: fetch failed -> bad port`,
 * 而不是发起连接。
 *
 * 本机(天河)的 Windows 动态端口范围被配成 **1024–15000**,正好把表里一批端口包了进去,
 * 于是 `listen(0)` 有小概率抽中 → 套件随机假红(实测:同一棵树三次全量里红过一次,
 * 报错是 `did not match /engine stopped/`,真实原因是 fetch 根本没连上)。
 * `listen(0)` 本身没错(不猜端口、不抢别人的),错在**没排除规范层面的不可用端口**。
 *
 * 用法:
 *   import { listenLoopback } from './test-local-port.mjs';
 *   const port = await listenLoopback(server);      // server 未监听
 *   const baseUrl = `http://127.0.0.1:${port}`;
 *
 * 语义:换一个端口重试,直到落在表外;真起不来(或 64 次都撞表)才抛,不吞错误。
 */
import net from 'node:net';

/** Fetch 规范 blocked port 表(asOf 2026-10-30,https://fetch.spec.whatwg.org/#port-blocking)。 */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

/** 这个端口能不能被 fetch 连?(纯函数,便于单测) */
export function isFetchablePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return false;
  return !BLOCKED_PORTS.has(value);
}

/**
 * 先量一个**可 fetch** 的回环端口再还给调用方(绑定 → 读数 → 立刻关).
 *
 * 用于那些"必须把端口号作为参数传进去"的 server 包装(例如 `createTavernGate().listen(port)`,
 * 它没有换端口重试的口子)。测试里存在极小的 TOCTOU 窗口,可接受。
 * @returns {Promise<number>}
 */
export async function pickLoopbackPort({ host = '127.0.0.1', attempts = 64 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = net.createServer();
    const port = await listenLoopback(probe, { host });
    await new Promise((resolve) => probe.close(resolve));
    if (isFetchablePort(port)) return port;
  }
  throw new Error('本机取不到可 fetch 的回环端口');
}

/** 让 server 监听回环上一个可 fetch 的临时端口,返回该端口。
 * @param {import('node:net').Server} server 尚未监听的 server
 * @param {{host?: string, attempts?: number}} [options]
 * @returns {Promise<number>}
 */
export async function listenLoopback(server, { host = '127.0.0.1', attempts = 64 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, host);
    });
    const port = server.address().port;
    if (isFetchablePort(port)) return port;
    // 撞上规范层面的不可用端口:关掉再换一个,不是跳过测试。
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error(`本机取不到可 fetch 的回环端口(${attempts} 次都落在 blocked port 表里)`);
}
