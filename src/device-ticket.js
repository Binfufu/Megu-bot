/**
 * **设备票**(D120):登录一次之后,这台设备**换网址也照样认**。
 *
 * ## 为什么需要它(而不是只用 Cookie)
 *
 * Cookie 是**按域名绑定**的:浏览器绝不会把 `a.trycloudflare.com` 的 Cookie 发给
 * `b.trycloudflare.com`。而临时隧道的网址**每次重启都会变** —— 于是"登录过一次"这件事
 * 在换网址后就白费了,用户要重新输口令码。
 *
 * 设备票的存在形式是 `localStorage` + 请求头,**不绑域名**,所以换网址照样认。
 *
 * ## 形状
 *
 * ```
 * <签发时刻>.<过期时刻>.<HMAC(签发.过期)>
 * ```
 *
 * 无状态、自带走效期、密钥由口令码/token 派生 —— 和会话票同一个思路。
 *
 * ## ⚠️ 代价(必须写在这儿)
 *
 * - 它在 `localStorage` 里,**脚本可读**(会话 Cookie 是 HttpOnly,脚本读不到)。
 *   面板没引任何第三方脚本,所以风险敞口小;但这是真实的取舍。
 * - 有效期长(默认 **365 天**),因为"每次换网址都要重输"正是我们要消掉的东西。
 * - **作废办法**:换掉口令码(`QQBOT_PANEL_CODE`)= 密钥变了 = 所有设备票立刻失效。
 *   退出登录只能作废**当前这一枚**(见 `startPanel` 里的 revokedDevices)。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** 设备票默认有效期:一年。 */
export const DEVICE_TTL_MS = 365 * 24 * 60 * 60_000;
/** 请求头 / 本地存储用的名字。 */
export const DEVICE_HEADER = 'x-panel-device';
export const DEVICE_STORE_KEY = 'hhpanel.device';

/**
 * @param {object} options
 * @param {string} options.secret 派生密钥的原料(`token || code`)
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 */
export function createDeviceSigner({ secret = '', ttlMs = DEVICE_TTL_MS, now = () => Date.now() } = {}) {
  const key = createHash('sha256').update(`panel-device:${secret}`).digest();
  /** 签名覆盖"签发 + 过期":改任何一个都会对不上。 */
  const sign = (issuedAt, expiresAt) => createHmac('sha256', key).update(`${issuedAt}.${expiresAt}`).digest('hex');

  return {
    ttlMs,
    /** 登录成功时签发一枚。 */
    mint() {
      const issuedAt = now();
      const expiresAt = issuedAt + ttlMs;
      return `${issuedAt}.${expiresAt}.${sign(issuedAt, expiresAt)}`;
    },
    /**
     * 校验一枚设备票。
     * @returns {{ok: boolean, expiresAt?: number}}
     */
    verify(value) {
      const parts = String(value ?? '').split('.');
      if (parts.length !== 3) return { ok: false };
      const [issuedAt, expiresAt, mac] = parts;
      const issued = Number(issuedAt);
      const expires = Number(expiresAt);
      if (!Number.isFinite(issued) || !Number.isFinite(expires)) return { ok: false };
      if (expires <= now()) return { ok: false };
      const want = sign(issuedAt, expiresAt);
      if (mac.length !== want.length) return { ok: false };
      if (!timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(want, 'utf8'))) return { ok: false };
      return { ok: true, expiresAt: expires };
    },
    /** 滑动续期:用掉一半寿命之后换一枚新的(免得"一年后突然要重登")。 */
    renew(value) {
      const check = this.verify(value);
      if (!check.ok) return null;
      const [, expiresAt] = String(value).split('.');
      const left = Number(expiresAt) - now();
      return left < ttlMs / 2 ? this.mint() : null;
    },
  };
}
