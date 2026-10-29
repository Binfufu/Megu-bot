/**
 * **从"用户能写进消息里的 URL"下载图片**(2026-10-12 安全审查,D201)。
 *
 * 为什么需要它:搬运(聊天记录 → PDF)**解析的是群消息的文本**,而文本里的 URL 是
 * **发消息的人写什么就是什么** —— 于是 `[附件1] 类型:图片 URL:http://127.0.0.1:8799/ …`
 * 这一行就能让机器人去 fetch 本机、内网、云元数据(SSRF)。原来的实现是裸 `fetch(url)`:
 * 跟重定向、不限大小、不管地址。
 *
 * 所以这里的口径是**白名单 + 地址校验 + 钉住解析结果**三件一起:
 *   ① 只认 QQ 图片 CDN 的 **https**(端口必须 443/缺省,不许带凭据);
 *   ② DNS 解析出来的地址**必须全是公网 IPv4** —— 回环 / 私网 / 链路本地 / CGNAT /
 *      保留段一律拒(域名白名单挡不住"这个域名解析到 127.0.0.1");
 *   ③ 连接时**用校验过的那个地址**(`lookup`),让"检查完再解析一次"的窗口消失
 *      (DNS 重绑定);
 *   ④ 流式读取有上限,超了立刻断,不把大响应吃进内存。
 *
 * ⚠️ 为什么**不给入站那条路**(`images.js`,平台事件给的图片)套这一层:那条 URL 不是
 *    用户写的,套白名单只会在平台换 CDN 时**静默丢图**(这个项目踩过"她看不到图")。
 */
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 下载上限**复用**入站图片那条既有上限(10MB)—— 别在这儿另定一个数(D34)。 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 平台真实在用的图片 CDN(活日志里出现过 `multimedia.nt.qq.com.cn`)。 */
const QQ_IMAGE_HOSTS = new Set(['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn']);

/**
 * **这条 URL 许不许下**(纯函数,判据钉着)。
 * @throws {Error} `image_source_not_allowed`
 */
export function imageDownloadUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password
    || (url.port && url.port !== '443') || !QQ_IMAGE_HOSTS.has(url.hostname)) {
    throw new Error('image_source_not_allowed');
  }
  return url;
}

/**
 * **这个地址是不是"公网"**(纯函数)。只认 IPv4:IPv6 / IPv4-mapped 一律 false ——
 * 少一类地址就少一类绕过面(这条边界宁紧勿松)。
 */
export function publicDownloadAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)      // 运营商 NAT
    || (a === 169 && b === 254)                // 链路本地(云元数据 169.254.169.254)
    || (a === 172 && b >= 16 && b <= 31)       // 私网
    || (a === 192 && (b === 168 || b === 0))   // 私网 / IETF 保留与 TEST-NET
    || (a === 198 && (b === 18 || b === 19))); // 基准测试段
}

/**
 * 下载一张 QQ 图片。
 *
 * @param {string} raw 记录文本里那个 URL
 * @param {{maxBytes?: number, timeoutMs?: number, resolve?: Function, request?: Function}} [options]
 *        `resolve` / `request` 只为**测试注入**(单测不打真网络)。
 * @returns {Promise<Buffer>}
 */
export async function downloadQqImage(raw, { maxBytes = IMAGE_MAX_BYTES, timeoutMs = 30_000, resolve = lookup, request = https.get } = {}) {
  const url = imageDownloadUrl(raw);
  const addresses = await resolve(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some((row) => !publicDownloadAddress(row.address))) {
    throw new Error('image_address_not_public');
  }
  const pinned = addresses[0];
  return new Promise((resolveBody, reject) => {
    const req = request(url, {
      // ③ 连接只走校验过的那个地址(否则"校验"与"连接"是两个不同的解析结果)。
      lookup: (_host, options, callback) => (options?.all
        ? callback(null, [pinned])
        : callback(null, pinned.address, 4)),
    }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); return reject(new Error('image_http_' + res.statusCode)); }
      const length = Number(res.headers['content-length']);
      if (length > maxBytes) { res.destroy(); return reject(new Error('image_too_large')); }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(new Error('image_too_large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => (size ? resolveBody(Buffer.concat(chunks)) : reject(new Error('image_empty'))));
      res.on('aborted', () => reject(new Error('image_aborted')));
    });
    const timer = setTimeout(() => req.destroy(new Error('image_timeout')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}
