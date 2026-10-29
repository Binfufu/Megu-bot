/**
 * **隧道状态文件**(D121):临时隧道的网址**每次重启都会变**,而面板的
 * `ALLOWED_HOSTS` 与 `PUBLIC_URL` 都跟它绑着 —— 手工改两处 `.env` 再重启 bot
 * 是这套东西里最烦的一步(用户原话:"这一块的自动化要做起来,避免麻烦")。
 *
 * 于是改成:**让隧道把自己的网址写下来,面板每次请求现读**。
 * 换网址时面板**不需要重启**、`.env` 也不需要改 —— 自动化就闭环了。
 *
 * 文件:`data\tunnel.json`(被 gitignore 覆盖,不提交)
 * ```json
 * { "url": "https://xxx.trycloudflare.com", "host": "xxx.trycloudflare.com", "updatedAt": 1759... }
 * ```
 */
import fs from 'node:fs';
import path from 'node:path';

export const TUNNEL_STATE_FILE = 'tunnel.json';

/** 读隧道状态(读不出来就返回 null —— **绝不让一个坏文件把面板搞挂**)。 */
export function readTunnelState(rootDir) {
  try {
    const file = path.join(rootDir, 'data', TUNNEL_STATE_FILE);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
    if (!/^https?:\/\/[a-z0-9.-]+/i.test(url)) return null;
    const host = (typeof parsed?.host === 'string' && parsed.host.trim())
      ? parsed.host.trim().toLowerCase()
      : new URL(url).host.toLowerCase();
    return { url, host, updatedAt: Number(parsed?.updatedAt) || 0 };
  } catch {
    return null;
  }
}

/** 写隧道状态(给 `scripts\panel-tunnel.js` 用)。 */
export function writeTunnelState(rootDir, { url, host = null, now = Date.now() }) {
  const dir = path.join(rootDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    url: String(url).trim(),
    host: String(host ?? new URL(url).host).trim().toLowerCase(),
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, TUNNEL_STATE_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

/**
 * **允许的 Host**(D121):固定的那份(config)+ 隧道当前那份(**每次请求现读**)。
 *
 * ⚠️ 只有"当前隧道域名"才被动态放行 —— **不是** `*.trycloudflare.com` 通配。
 *    通配会把"任何人开的隧道域名"都算成合法来源,没必要。
 */
export function dynamicAllowedHosts({ base = [], rootDir }) {
  const live = readTunnelState(rootDir);
  return live ? [...base, live.host] : [...base];
}

/**
 * **这条隧道的网址还通吗**(1.102.1 / D166)—— 把"一次探测的结果"翻成"活/死"。
 *
 * ## 为什么必须有这条判据(用户报的现场)
 *
 * 原话:「**手机又打不开页面了**」。查下来:
 *   · 本机页面 200、隧道**进程也活着**、守护说"在跑";
 *   · 但那条网址的 **DNS 已经解析不了** —— 通道死了,进程还在。
 * 老的看门狗**只查"进程在不在"**,所以这种状态它永远看不见,只会一直说"在跑"。
 * 📌 教训与 D165 同族:**"看起来还在"不等于"还能用"** ——
 *    判据要问到**最末端**(用户真要走的那一步),而不是问最近的那个代理指标。
 *
 * ## 判定口径(⚠️ 刻意分两档)
 *
 *   · 网络层错(DNS 解析不了 / 连不上 / 超时)→ **死**;
 *   · Cloudflare 边缘回 502/503/504/530 → **死**(530 就是"隧道那头没接上"的原话);
 *   · **其余任何 HTTP 状态**(200/401/403/404…)都算**活** ——
 *     我们要判的是"**隧道通不通**",不是"**你有没有票**":401 恰好证明请求穿过了隧道、
 *     到了面板(裸地址就是 401)。
 *
 * @param {{status?: number, error?: any}} input
 * @returns {{alive: boolean, why: string}}
 */
export function tunnelProbeVerdict({ status = 0, error = null } = {}) {
  if (error) return { alive: false, why: `连不上（${describeProbeError(error)}）` };
  const code = Number(status) || 0;
  if (code === 0) return { alive: false, why: '没有状态码' };
  if ([502, 503, 504, 530].includes(code)) return { alive: false, why: `边缘回 ${code}（隧道那头没接上）` };
  return { alive: true, why: `HTTP ${code}` };
}

/**
 * 把一次探测的失败说成**人看得懂的一句话**。
 *
 * ⚠️ 为什么要专门写它(演练时踩的):`fetch` 失败时 `err.code` 常常是**数字**
 *    (演练里印出来的是「连不上（20）」—— 谁也看不懂),真正的病因藏在 `err.cause` 里
 *    (undici 把 `ENOTFOUND`/`EAI_AGAIN` 塞在那儿,与项目里别处"cause 链要走到根因"同一个坑)。
 *    所以这里**走一遍 cause 链**,取第一个像样的名字。
 */
export function describeProbeError(error) {
  const seen = new Set();
  let node = error;
  for (let depth = 0; node && depth < 5 && !seen.has(node); depth += 1) {
    seen.add(node);
    const code = typeof node.code === 'string' ? node.code : null;
    if (code) return code;
    if (node.name && node.name !== 'Error' && node.name !== 'TypeError') return node.name;
    node = node.cause ?? null;
  }
  const msg = String(error?.message ?? '').trim();
  return msg ? msg.slice(0, 60) : 'unknown';
}

/**
 * **命名隧道(固定网址)那一路的状态**(2026-10-11)。
 *
 * 背景:临时隧道退休之后,入口变成"**域名 + 命名隧道 + Windows 服务**":
 *   · 网址**固定**(不再需要 `data\tunnel.json` 那套动态状态);
 *   · 进程由 **SCM** 管(`Cloudflared` 服务,自动启动 + 失败自动重启);
 *   · 所以看门狗要盯的东西变了:**服务在不在跑** + **那条固定网址真的通不通**。
 *
 * 这一小段把 `sc.exe query` 的输出翻成两个事实 —— 抽成纯函数是为了**单测能钉住它**
 * (真服务不好在单测里装,但"这段文本表示什么"可以被钉死)。
 *
 * `sc.exe query <不存在的服务>` 的退出码是 **1060**;运行中是 `STATE : 4  RUNNING`。
 *
 * @param {string} text `sc.exe query` 的输出
 * @param {{status?: number}} [meta] 进程退出码
 * @returns {{exists: boolean, state: string|null}}
 */
export function parseScQuery(text = '', { status = 0 } = {}) {
  if (Number(status) === 1060) return { exists: false, state: null };
  const raw = String(text ?? '');
  if (/\b1060\b/.test(raw) && !/SERVICE_NAME/i.test(raw)) return { exists: false, state: null };
  if (!/SERVICE_NAME/i.test(raw)) return { exists: false, state: null };
  const m = /STATE\s*:\s*\d+\s+([A-Z_]+)/i.exec(raw);
  return { exists: true, state: m ? m[1].toUpperCase() : null };
}

/**
 * **命名隧道这一拍该做什么**(纯函数)。
 *
 * ⚠️ 这一条的措辞刻意是"**服务在跑** + **网址通**"两件事 —— 因为 D166 的现场就是
 *    "进程活着、网址已经死了"。只看服务状态的看门狗会一直说"在跑"。
 *
 * @param {{serviceExists?: boolean, serviceRunning?: boolean, probeAlive?: boolean}} input
 * @returns {{action: 'none'|'start-service'|'restart-service'|'no-service', why: string}}
 */
export function namedWatchPlan({ serviceExists = false, serviceRunning = false, probeAlive = false } = {}) {
  if (!serviceExists) return { action: 'no-service', why: '这台机器上没装命名隧道服务（Cloudflared）—— 那是临时隧道那一路' };
  if (!serviceRunning) return { action: 'start-service', why: '服务没在跑' };
  if (!probeAlive) return { action: 'restart-service', why: '服务在跑，但网址探不通（D166 那种状态）' };
  return { action: 'none', why: '服务在跑，网址通' };
}
