import { EventEmitter } from 'node:events';
import { stripLeakedControlMarkup } from './control-markup.js';
import { describeError, log } from './log.js';

/** Gateway opcodes. */
export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

/**
 * WebSocket close codes that must never be retried, versus those where QQ wants
 * a RESUME rather than a fresh IDENTIFY. Everything else re-identifies.
 */
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);
const RESUME_CLOSE_CODES = new Set([4008, 4009]);

/**
 * Send-message error codes meaning the passive-reply window is gone, so the
 * message is worth retrying as an active one.
 *
 * `304103` and `40034005` are both documented as "msg_id 已过期，不能回复";
 * the other two are the older spellings still seen in the wild.
 */
const PASSIVE_EXPIRED_CODES = new Set([40034005, 304103, 304026, 304027]);

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove a leading speaker label from every line.
 *
 * Models like to prefix each paragraph with the character's name — `【主实例】` —
 * because the card's format section showed it. That is a script convention, not
 * something a chat message should carry, and because past turns are in the
 * session history the habit persists even after the card is corrected.
 *
 * Only the *bot's own* name is stripped, so a deliberate `【状态】…` status bar
 * survives.
 */
function stripNameLabels(text, names) {
  const usable = names.filter((name) => typeof name === 'string' && name.trim() !== '');
  if (usable.length === 0) return text;
  const alternation = usable.map((name) => escapeRegExp(name.trim())).join('|');
  // Horizontal whitespace only — `\s` would also match newlines and swallow the
  // blank line between paragraphs while stripping a label from the next one.
  const pattern = new RegExp(
    `^[ \\t\\u3000]*(?:【(?:${alternation})】|\\[(?:${alternation})\\]|(?:${alternation})[：:])[ \\t\\u3000]*`,
    'gm',
  );
  return text.replace(pattern, '');
}

/**
 * Remove mentions and speaker labels from outgoing text.
 *
 * QQ turns a leading `@昵称` into a real mention that notifies the person. A
 * conversation bot replying to whoever just spoke has no reason to ping them,
 * so it is stripped. CQ codes are removed too, since other bot frameworks leak
 * them into text.
 *
 * ⚠️ **2026-10-02 实测:`<@!openid>` 在群消息里不会变成提及**(用户打了 `/提及测试`,
 * 发出去的是 `<@!他的 group_openid>`,**没有收到任何 @ 提醒**)。
 * 所以 `<@!…>` 一律**照旧剥掉**,不留任何例外 —— 官方文档里那条
 * `<@user_id>` / `<@!user_id>` 的写法属于**频道消息**那一支([内嵌格式][1]),
 * **群聊这条路上不成立**。要叫某个人,**在正文里写名字**(见 `namePrefix()`)。
 *
 * [1]: https://bot.qq.com/wiki/develop/api-v2/server-inter/channel/message/format.html
 *
 * @param {string} text
 * @param {{names?: string[]}} [options] the bot's own display names.
 */
export function sanitizeOutgoingText(text, { names = [] } = {}) {
  // ⚠️ 1.167.4（D273）：模型偶尔把原生工具协议标记泄漏成正文（`<｜｜DSML｜｜…>`，
  //    见 `src\control-markup.js` 顶部现场）。这里是**所有出站消息的必经之路**，
  //    剥除挂在这一层，调用方就不可能漏（MEMORY 侧另在 `whatSheSaid()` 剥同一份）。
  return stripNameLabels(
    stripLeakedControlMarkup(text)
      .replace(/<@!?[^>]*>/g, '')
      .replace(/\[CQ:at,[^\]]*\]/g, '')
      .replace(/^[\s\u3000]*@[^\s@]{1,24}(?=[\s\u3000]|$)/, ''),
    names,
  )
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** `WebSocket.OPEN`, spelled numerically to avoid depending on the static. */
const WS_OPEN = 1;

/** Strip leading/trailing whitespace and any `<@!id>` mention markers. */
export function stripMentions(content) {
  // The ids are hex openids (`<@A0500000…>`), not digits — a `\d+` pattern
  // quietly left them in the text, where they reached the model and read as
  // "@somebody" in the prompt.
  return (content ?? '').replace(/<@!?[^>\s]+>/g, '').trim();
}

/** Decode the base64 `ext` of a face element, e.g. `{"text":"超级6"}`. */
function decodeFaceExt(ext) {
  if (typeof ext !== 'string' || ext === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'));
    return typeof parsed?.text === 'string' && parsed.text !== '' ? parsed.text : null;
  } catch {
    return null;
  }
}

/**
 * Turn QQ's inline face markup into something a model can read.
 *
 * Verified shapes (real payloads, 2026-09-26 / 2026-09-30):
 *
 * | what | content |
 * |---|---|
 * | 戳一戳 (double-tap the bot's avatar) | `<faceType=3,faceId="443",ext="…">[戳一戳]请使用最新版手机QQ体验新功能。` |
 * | **互动表情**(会话那一栏:超级6 / 比个心 / 放大招 / 戳一下…) | **与上面同形** —— `<faceType=3,faceId="NNN",ext="…">[戳一戳]请使用最新版手机QQ体验新功能。` |
 * | 大表情 (a big sticker) | `<faceType=3,faceId="489",ext="…">` — nothing after the tag |
 * | 小表情 | `<faceType=1,faceId="344",ext="…">` |
 *
 * So `faceType=3` alone does **not** mean a poke — the `[戳一戳]` marker is what
 * does. Assuming otherwise made every big sticker look like a poke. The `ext`
 * field is the sticker's *name* ("知识增加", "阴阳怪气") for a sticker and the
 * custom action text ("戳一下", "超级6") for a poke; both are worth keeping,
 * because the model can react to a named sticker and cannot react to a blob.
 *
 * ⚠️ **但"互动表情"和"戳一戳"目前分不开**(2026-09-30,别急着下结论):
 * 两者的正文**逐字相同**(占位句也一样),`faceId` 的语义也没被证实
 * (用户指出 `faceId=443`(名字"戳一下")其实是互动表情面板里的,而真戳是双击头像)。
 * 差别可能只在**事件类型/有没有伴随一条 @ 事件**上,而那需要采样才能定 ——
 * 见 `isPokeMessage` 的注释与 `docs\03` D71 补记四。
 */
export function cleanInboundText(raw) {
  let text = String(raw ?? '');

  // The poke: markup followed by a client placeholder that names nobody.
  text = text.replace(/<faceType=3[^>]*>\s*\[戳一戳\]?\s*请使用最新版手机QQ体验新功能[。.]?/g, (whole) => {
    const action = decodeFaceExt(/ext="([^"]*)"/.exec(whole)?.[1]);
    return action ? `[戳一戳：${action}]` : '[戳一戳]';
  });

  // Any remaining face markup. A `[戳一戳]` right after the tag still means a
  // poke (the placeholder sentence is optional in some clients).
  text = text.replace(/<faceType=(\d+)[^>]*>(\[戳一戳\])?/g, (whole, type, pokeMarker) => {
    const label = decodeFaceExt(/ext="([^"]*)"/.exec(whole)?.[1]);
    if (pokeMarker) return label ? `[戳一戳：${label}]` : '[戳一戳]';
    if (String(type) === '3') return label ? `[大表情：${label}]` : '[大表情]';
    return label ? `[表情：${label}]` : '[表情]';
  });

  // A stray poke placeholder whose markup was already consumed.
  text = text.replace(/请使用最新版手机QQ体验新功能[。.]?/g, '');
  return stripMentions(text);
}

/**
 * 这个 face 标记是不是"戳一戳"。
 *
 * ⚠️ **2026-09-30:这条判据还不完整,别照着任何 faceId 数字去写死东西。**
 *
 * 现在手里有**两条互相矛盾**的证据:
 *   ① 我们一直以来的假设(9/26 的实验)是"`[戳一戳]` 标记 = 被戳";而 2026-09-30
 *      群里实录的是 `收到戳一戳 群=…（[戳一戳：放大招]）` —— **互动表情"放大招"
 *      也被这条判据判成了戳一戳**;
 *   ② 用户 2026-09-30 说 `faceId=443`(名字"戳一下")**同样是互动表情面板里的**,
 *      而真正的戳一戳是"**双击头像**"这个不一样的动作;并且同一时刻平台还会额外推一条
 *      `收到群聊消息(@) 文字=0`(见 `docs\03` D71 补记四)。
 *
 * 所以**目前没有证据**说明"靠 faceId 或那句 `[戳一戳]` 占位句能把两者分开"。
 * 中途有一版拿 `faceId=443` 当"真戳"的判据是**未经验证的假设**,已经退回。
 * 要定这条判据,只能先**采到同一个人、同一个客户端、两种动作各自的原始 payload**。
 *
 * 在采到样本之前保持**旧行为**:带 `[戳一戳]` 标记就算戳一戳 ——
 * 它的错法是"多回应一次",而不是"把真实的互撩当表情忽略掉"。
 */
export function isPokeMessage(data) {
  const content = String(data?.content ?? '');
  if (content.includes('[戳一戳]')) return true;
  return content.includes('戳一戳') && /<faceType=3[^>]*>/.test(content);
}

/**
 * Whether a payload carries an inline face (QQ 表情 / 大表情) — the other small
 * gesture worth reacting to, and a much weaker signal than a poke.
 */
export function hasFaceMarkup(data) {
  if (typeof data?.content === 'string' && /<faceType=\d+[^>]*>/.test(data.content)) return true;
  return (Array.isArray(data?.msg_elements) ? data.msg_elements : []).some((element) =>
    /faceType["'\s:=]*\d+/.test(JSON.stringify(element ?? {})));
}

/** Thrown for a QQ OpenAPI business failure. */
export class QqApiError extends Error {
  constructor(message, code, body) {
    super(message);
    this.name = 'QqApiError';
    this.code = code;
    this.body = body;
  }

  /** True when retrying without `msg_id` (an active message) is worth attempting. */
  get passiveExpired() {
    return PASSIVE_EXPIRED_CODES.has(this.code);
  }
}

/**
 * Caches the app access token and refreshes it before expiry. QQ returns
 * business errors with HTTP 200, so the `code` field is authoritative.
 */
export class TokenManager {
  #token = null;
  #expiresAt = 0;
  #inflight = null;

  constructor({ appId, clientSecret, apiBase }) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.apiBase = apiBase;
  }

  async get() {
    if (this.#token && Date.now() < this.#expiresAt - 60_000) return this.#token;
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#refresh().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refresh() {
    const response = await fetch(`${this.apiBase}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new QqApiError(`获取 access_token 失败: HTTP ${response.status}`, response.status, body);
    }
    if (body?.code) {
      throw new QqApiError(
        `获取 access_token 失败: code=${body.code} ${body.message ?? ''}`.trim(),
        body.code,
        body,
      );
    }
    if (!body?.access_token) {
      throw new QqApiError('获取 access_token 失败: 响应中没有 access_token', undefined, body);
    }

    this.#token = body.access_token;
    const expiresIn = Number(body.expires_in) || 7200;
    this.#expiresAt = Date.now() + expiresIn * 1000;
    log.info(`已获取 access_token，有效期 ${expiresIn}s`);
    return this.#token;
  }
}

/** Thin QQ OpenAPI client for the message endpoints this bridge needs. */
export class QqApi {
  /** 生命体征(1.168.0 / D275;可选 —— 缺了不统计,现有测试不用传)。 */
  #vitals = null;

  constructor({ tokens, apiBase, vitals = null }) {
    if (typeof tokens?.get !== 'function') {
      throw new TypeError('QqApi 需要一个 TokenManager 实例（{ tokens }）');
    }
    this.tokens = tokens;
    this.apiBase = apiBase;
    this.#vitals = vitals;
  }

  /** Reply in a direct (C2C) conversation. */
  async sendDirect(userOpenid, { content, msgId, msgSeq }) {
    return this.#post(`/v2/users/${encodeURIComponent(userOpenid)}/messages`, { content, msgId, msgSeq });
  }

  /** Reply in a group conversation. */
  async sendGroup(groupOpenid, { content, msgId, msgSeq }) {
    return this.#post(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, { content, msgId, msgSeq });
  }

  async #post(path, { content, msgId, msgSeq }) {
    const payload = { content, msg_type: 0 };
    // `msg_id` makes this a passive reply, which is exempt from active-message
    // quotas; distinct `msg_seq` values allow several replies to one message.
    if (msgId) {
      payload.msg_id = msgId;
      payload.msg_seq = msgSeq ?? 1;
    }

    try {
      // 取 token 也在 try 内:取票失败同样记一次发送失败(Y17)。
      // ⚠️ 与 `sendMedia` / `#postRaw` 对称 —— 它们本来就把取票包在 try 里,
      //    文本出口原先露在 try 外,同一种故障在两条出口上一记 1、一记 0。
      const token = await this.tokens.get();
      const response = await fetch(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });

      const body = await response.json().catch(() => null);
      const code = body?.err_code ?? body?.code;
      if (!response.ok || (code !== undefined && code !== 0)) {
        throw new QqApiError(
          `发送消息失败: HTTP ${response.status} code=${code ?? 'n/a'} ${body?.message ?? ''}`.trim(),
          code ?? response.status,
          body,
        );
      }
      // 生命体征(D275):平台**接受**了这条消息 —— "发得出"的证据。
      this.#vitals?.noteSend(true);
      return body;
    } catch (err) {
      // 发送失败(额度耗尽/频控/网络)是另一种病的直接信号 —— 与"收不到"分开记。
      this.#vitals?.noteSend(false);
      throw err;
    }
  }

  /**
   * 群基本信息:`group_name` / `group_member_num` / `group_finger_memo` …
   *
   * 平台文档写着这个接口"仅白名单机器人可用"(错误码 11253),但**这两只实测能用**
   * (2026-09-28,D59)—— 所以"按群名核对 openid"这条路是通的:
   * `/群列表` 靠它显示名字,搬运白名单/黑名单靠它挡住"openid 抄错一个字符"。
   * 频率限制 30 QPM,调用方自己缓存。
   */
  async getGroupInfo(groupOpenid) {
    return this.#get(`/v2/groups/${encodeURIComponent(groupOpenid)}/info`);
  }

  /**
   * 机器人在这个群里的状态:`allow_proactive_msg`(能不能主动发言)、
   * `recv_msg_setting`(能收到全部消息还是只有 @)、`member_role`。
   *
   * ⚠️ `40034105 主动消息发送失败,无权限` 是**逐群**的,不是"这只机器人没有权限" ——
   * 判据就来自这个接口(2026-09-28 实测:火星试验田 `false`,另两个群 `true`)。
   */
  async getGroupBotState(groupOpenid) {
    return this.#get(`/v2/groups/${encodeURIComponent(groupOpenid)}/bot_state`);
  }

  /**
   * 发一条**富媒体**消息(`msg_type:7` + `media.file_info`;file_info 来自上传接口)。
   * `msg_id` 给了就是被动回复,不给就是主动消息(吃 20/qpm 的单群频控)。
   */
  async sendMedia({ scene = 'group', openid, fileInfo, msgId = null, msgSeq = 1 }) {
    const kind = scene === 'user' ? 'users' : 'groups';
    try {
      const body = await this.#postRaw(
        `/v2/${kind}/${encodeURIComponent(openid)}/messages`,
        { msg_type: 7, media: { file_info: fileInfo }, ...(msgId ? { msg_id: msgId, msg_seq: msgSeq } : {}) },
        '发送富媒体消息失败',
      );
      // 生命体征(D275):富媒体也是"发消息"的两个出口之一(另一个是文本 #post)。
      // ⚠️ uploadFile 那些上传接口**不算**发消息 —— 它们走同一个 #postRaw 但不是消息出口。
      this.#vitals?.noteSend(true);
      return body;
    } catch (err) {
      this.#vitals?.noteSend(false);
      throw err;
    }
  }

  /**
   * 上传**本机**文件(图片/视频/文件)并拿回 `file_info`。
   *
   * 为什么走分片上传而不是 `url` 直传:URL 直传要文件在公网可达,而我们组装出来的 PDF 在本机;
   * 上传接口**没有** `file_data` 直传字段,所以本地文件只有这条路
   * (prepare → 逐片 PUT → part_finish → files 合并,单聊用 `users`、群聊用 `groups`,两者不互通)。
   *
   * ⚠️ **必须重试**:实测第一次 HTML 上传就是 `40093001`(平台原话"请重试")挂的 —— 瞬时故障,
   * 重试一次就过。所以这里默认重试 3 次、退避递增。
   */
  async uploadFile({ scene = 'group', openid, fileName, buffer, fileType = 4, retries = 3 }) {
    const kind = scene === 'user' ? 'users' : 'groups';
    const root = `/v2/${kind}/${encodeURIComponent(openid)}`;
    const crypto = await import('node:crypto');
    const hash = (algo, data) => crypto.createHash(algo).update(data).digest('hex');
    let lastError = null;

    for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
      try {
        const prepared = await this.#postRaw(`${root}/upload_prepare`, {
          file_type: fileType,
          file_size: String(buffer.length),
          file_name: fileName,
          md5: hash('md5', buffer),
          sha1: hash('sha1', buffer),
          md5_10m: hash('md5', buffer.subarray(0, 10_002_432)),
        });
        let cursor = 0;
        for (const part of prepared?.parts ?? []) {
          const size = Number(part.block_size ?? prepared?.block_size ?? 0);
          const slice = buffer.subarray(cursor, cursor + size);
          cursor += size;
          const uploaded = await fetch(part.presigned_url, {
            method: 'PUT',
            body: slice,
            signal: AbortSignal.timeout(120_000),
          });
          if (!uploaded.ok) throw new QqApiError(`分片上传失败: HTTP ${uploaded.status}`, uploaded.status, null);
          await this.#postRaw(`${root}/upload_part_finish`, {
            upload_id: prepared?.upload_id,
            part_index: part.index,
            block_size: String(size),
            md5: hash('md5', slice),
          });
        }
        const merged = await this.#postRaw(`${root}/files`, {
          file_type: fileType,
          upload_id: prepared?.upload_id,
          file_name: fileName,
          srv_send_msg: false,
        });
        if (merged?.file_info) return merged.file_info;
        throw new QqApiError('合并后没有 file_info', undefined, merged);
      } catch (err) {
        lastError = err;
        log.warn(`上传「${fileName}」第 ${attempt}/${retries} 次失败: ${describeError(err)}`);
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      }
    }
    throw lastError ?? new Error('上传失败');
  }

  /** 原样 POST 一个 JSON body(与 `#post` 同一套鉴权/错误翻译,但内容由调用方给)。 */
  async #postRaw(path, payload, what = '请求失败') {
    const token = await this.tokens.get();
    const response = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => null);
    const code = body?.err_code ?? body?.code;
    if (!response.ok || (code !== undefined && code !== 0)) {
      throw new QqApiError(
        `${what}: HTTP ${response.status} code=${code ?? 'n/a'} ${body?.message ?? ''}`.trim(),
        code ?? response.status,
        body,
      );
    }
    return body;
  }

  /**
   * 撤回自己发过的群消息(`DELETE /v2/groups/{openid}/messages/{id}`)。
   *
   * ⚠️ 平台硬规定:**发出超过 2 分钟不可撤回** —— 所以"发现漏网"的补救窗口只有 120 秒,
   * 这也是搬运默认"问一声再发"的理由之一(D60)。
   */
  async recallGroupMessage(groupOpenid, messageId) {
    const token = await this.tokens.get();
    const response = await fetch(
      `${this.apiBase}/v2/groups/${encodeURIComponent(groupOpenid)}/messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE', headers: { Authorization: `QQBot ${token}` }, signal: AbortSignal.timeout(20_000) },
    );
    const body = await response.json().catch(() => null);
    const code = body?.err_code ?? body?.code;
    if (!response.ok || (code !== undefined && code !== 0)) {
      throw new QqApiError(
        `撤回失败: HTTP ${response.status} code=${code ?? 'n/a'} ${body?.message ?? ''}`.trim(),
        code ?? response.status,
        body,
      );
    }
    return body;
  }

  /** 只读 GET(和 `#post` 共用同一套鉴权与错误翻译)。 */
  async #get(path) {
    const token = await this.tokens.get();
    const response = await fetch(`${this.apiBase}${path}`, {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.json().catch(() => null);
    const code = body?.err_code ?? body?.code;
    if (!response.ok || (code !== undefined && code !== 0)) {
      throw new QqApiError(
        `请求 ${path} 失败: HTTP ${response.status} code=${code ?? 'n/a'} ${body?.message ?? ''}`.trim(),
        code ?? response.status,
        body,
      );
    }
    return body;
  }
}

/**
 * Long-lived QQ event Gateway connection: identify, heartbeat, resume, and
 * bounded reconnect. Emits `message` (normalized), `ready`, and `fatal`.
 */
export class QqGateway extends EventEmitter {
  #ws = null;
  #heartbeatTimer = null;
  #ackTimer = null;
  #sessionId = null;
  #lastSeq = null;
  #stopped = true;
  #attempts = 0;
  #seenMessageIds = new Map();
  #botId = null;
  #botName = null;
  /** 生命体征(1.168.0 / D275;可选 —— 缺了不统计)。 */
  #vitals = null;
  /** Event types with no handler, so the log says so once instead of never. */
  #unhandledEventTypes = new Set();

  /**
   * The bot's own display name, learned from READY.
   *
   * Used to strip the `【名字】` speaker label models like to prefix, so it has
   * to be the real nickname rather than a hardcoded one.
   */
  get botName() {
    return this.#botName;
  }

  constructor({ tokens, apiBase, intents, selfIds = [], onForeignBot = null, vitals = null }) {
    super();
    if (typeof tokens?.get !== 'function') {
      throw new TypeError('QqGateway 需要一个 TokenManager 实例（{ tokens }）');
    }
    this.#onForeignBot = typeof onForeignBot === 'function' ? onForeignBot : null;
    this.#vitals = vitals;
    this.tokens = tokens;
    this.apiBase = apiBase;
    this.intents = intents;
    /**
     * Group-scoped openids that mean "this bot".
     *
     * Learned from traffic (`selfIdsFrom`) and optionally seeded from
     * `QQBOT_SELF_GROUP_IDS`. Needed because a group mention carries the bot's
     * *group* openid, which never matches the global id from READY (D09) — and
     * because it is different in every group, so hand-maintaining it would be a
     * chore that learning removes.
     */
    this.selfIds = new Set(Array.isArray(selfIds) ? selfIds : []);
    /**
     * Group-scoped openids that mean "**another** bot in one of our groups".
     *
     * 一个群里可以有两只机器人(主实例 + 副实例)。平台的 `bot: true` 只说明
     * "被 @ 的是个机器人",不说明是**哪一只** —— 而有的 payload 里 mention entry
     * 没有 `username`,那时旧代码只剩这一条依据,于是"@ 另一只"被当成"@ 我"。
     *
     * 判据不用手工配:谁 @ 那只机器人时,它的 openid 就在 mention entry 里,
     * 见 `foreignBotIdsFrom`。学下来之后,未知的 `bot: true` id 就认得出来了。
     */
    this.foreignBotIds = new Set();
  }

  /** 把学到的"别的机器人"喂给调用方落盘(D54)。 */
  #onForeignBot = null;

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#clearTimers();
    if (this.#ws) {
      try {
        this.#ws.close(1000, 'bridge shutdown');
      } catch {
        /* already closing */
      }
      this.#ws = null;
    }
  }

  async #gatewayUrl() {
    const token = await this.tokens.get();
    for (const path of ['/gateway/bot', '/gateway']) {
      try {
        const response = await fetch(`${this.apiBase}${path}`, {
          headers: { Authorization: `QQBot ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const body = await response.json();
        if (body?.url) return body.url;
      } catch (err) {
        log.warn(`获取网关地址失败 ${path}: ${describeError(err)}`);
      }
    }
    throw new Error('无法获取 QQ 网关地址（/gateway/bot 与 /gateway 均失败）');
  }

  async #connect() {
    if (this.#stopped) return;

    let url;
    try {
      url = await this.#gatewayUrl();
    } catch (err) {
      // #gatewayUrl() 还会在此之上去取 access_token，而那次 fetch 不在内层
      // try 里，所以这里必须带 cause 链，否则网络故障只会留下一句
      // “fetch failed”，根因（DNS / 连接超时 / TLS）全部丢失。
      log.error(`获取网关地址失败: ${describeError(err)}`);
      this.#scheduleReconnect('获取网关地址失败');
      return;
    }
    if (this.#stopped) return;

    log.info(`正在连接 QQ 网关 ${url}`);
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.addEventListener('open', () => log.debug('网关连接已建立，等待 Hello'));
    ws.addEventListener('message', (event) => this.#onFrame(event.data));
    ws.addEventListener('error', () => log.warn('网关 WebSocket 报错'));
    ws.addEventListener('close', (event) => this.#onClose(event.code, event.reason));
  }

  #onFrame(raw) {
    let payload;
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      log.warn('忽略无法解析的网关消息');
      return;
    }

    if (typeof payload.s === 'number') this.#lastSeq = payload.s;

    switch (payload.op) {
      case OP.HELLO:
        this.#onHello(payload.d ?? {});
        return;
      case OP.HEARTBEAT_ACK:
        if (this.#ackTimer) clearTimeout(this.#ackTimer);
        this.#ackTimer = null;
        return;
      case OP.DISPATCH:
        this.#onDispatch(payload.t, payload.d);
        return;
      case OP.RECONNECT:
        log.info('网关要求重连');
        this.#ws?.close(4009, 'server requested reconnect');
        return;
      case OP.INVALID_SESSION:
        log.warn('会话已失效，将重新鉴权');
        this.#sessionId = null;
        this.#lastSeq = null;
        this.#ws?.close(4007, 'invalid session');
        return;
      default:
        log.debug(`忽略 opcode ${payload.op}`);
    }
  }

  async #onHello({ heartbeat_interval: intervalMs }) {
    // hello 里的周期来自对端。1.204.9 安全加固(CodeQL js/resource-exhaustion):
    // 夹在 1s~5min,异常值(0/负数/超大/NaN)既不会把心跳打成忙等,也不会让连接假活。
    const HEARTBEAT_MIN_MS = 1_000;
    const HEARTBEAT_MAX_MS = 300_000;
    const requested = Number(intervalMs);
    const interval = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(requested, HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS)
      : 45_000;

    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), interval);

    // The handshake needs a live access token; a refresh failure here is fatal
    // for this connection, and the close handler owns reconnecting.
    if (this.#sessionId && this.#lastSeq !== null) {
      const token = await this.#tokenOrClose();
      if (token === null) return;
      log.info(`恢复会话 ${this.#sessionId}（seq=${this.#lastSeq}）`);
      this.#send({
        op: OP.RESUME,
        d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#lastSeq },
      });
    } else {
      await this.#identify();
    }

    // Ping immediately so a half-open connection is detected early rather than
    // after a full interval.
    this.#heartbeat();
  }

  async #identify() {
    const token = await this.#tokenOrClose();
    if (token === null) return;
    log.info(`发送 Identify（intents=${this.intents}）`);
    this.#send({
      op: OP.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: this.intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh-qqbot-bridge', $device: 'dsh-qqbot-bridge' },
      },
    });
  }

  async #tokenOrClose() {
    try {
      return await this.tokens.get();
    } catch (err) {
      log.error(`握手取 token 失败，将重连: ${describeError(err)}`);
      this.#ws?.close(4009, 'token unavailable');
      return null;
    }
  }

  #heartbeat() {
    this.#send({ op: OP.HEARTBEAT, d: this.#lastSeq });
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = setTimeout(() => {
      log.warn('心跳未收到 ACK，判定连接已失效并重连');
      this.#ws?.close(4009, 'heartbeat timeout');
    }, 60_000);
  }

  /**
   * Whether this message id was already handled recently.
   *
   * Bounded by both count and age: QQ redelivers for delivery guarantees, but
   * the window only has to cover a reconnect, not the process lifetime.
   */
  #isDuplicate(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return false;
    const now = Date.now();
    const DUPLICATE_WINDOW_MS = 5 * 60_000;

    if (this.#seenMessageIds.size > 500) {
      for (const [id, seenAt] of this.#seenMessageIds) {
        if (now - seenAt > DUPLICATE_WINDOW_MS) this.#seenMessageIds.delete(id);
      }
    }

    if (this.#seenMessageIds.has(messageId)) return true;
    this.#seenMessageIds.set(messageId, now);
    return false;
  }

  #onDispatch(type, data) {
    // ---- 生命体征(D275)----
    // 任何事件都证明"连接活着" —— **包括 READY/RESUMED 这类连接生命周期事件**:
    // 它们下面会提前 return,计数放在 return 之后就会漏掉(Y19)。
    this.#vitals?.noteEvent(type);

    if (type === 'READY') {
      this.#sessionId = data?.session_id ?? null;
      // Learned here so full-mode @ detection can match the bot by exact id.
      this.#botId = data?.user?.id ?? null;
      this.#botName = data?.user?.username ?? null;
      this.#attempts = 0;
      log.info(`网关鉴权成功，机器人「${data?.user?.username ?? '未知'}」已上线`);
      this.emit('ready', data);
      return;
    }
    if (type === 'RESUMED') {
      this.#attempts = 0;
      log.info('网关会话已恢复');
      return;
    }

    log.debug(`收到事件 ${type}`);

    // 消息类事件才证明"收得到" —— 哪怕正文空被丢弃,平台推了消息事件本身就说明
    // 事件流没断。「她聋了吗」的判据只认消息事件,其它事件(入群/生命周期)只更新
    // lastEventAt 供诊断,不参与 stale 判定。位置/条件不变:仍在归一化之前按类型判。
    if (MESSAGE_EVENT_TYPES.has(type)) this.#vitals?.noteMessage(type);

    // Learn the bot's own group openid from ordinary traffic: a real @ of the
    // bot arrives as a mention entry carrying *our* nickname, so a new group
    // needs no configuration at all. Learned before judging, so this very
    // message already benefits from it.
    for (const id of selfIdsFrom(data, { botName: this.#botName })) {
      if (!this.selfIds.has(id)) {
        this.selfIds.add(id);
        log.info(`记住自己在群里的 openid：${id}（昵称「${this.#botName}」）`);
      }
    }

    // 同一份流量里还带着**别的机器人**的 openid(见 `foreignBotIdsFrom`)。
    // 学它的原因是判定的最后一道闸要靠它:"@ 了另一只机器人"不该算 "@ 我"。
    for (const id of foreignBotIdsFrom(data, {
      botId: this.#botId,
      selfIds: this.selfIds,
      known: this.foreignBotIds,
    })) {
      this.foreignBotIds.add(id);
      const name = mentionEntries(data).find((entry) => entryId(entry) === id)?.username ?? '无名';
      log.info(`记住群里另一只机器人：${id}（昵称「${name}」）—— 以后 @ 它不会被当成 @ 我`);
      // ⚠️ 学到的 id 必须**落盘**(D54):它原来只在内存里,重启即忘 ——
      // 于是每次重启后的头几条对方机器人的消息又会被当成真人(实测)。
      try {
        this.#onForeignBot?.(id, name);
      } catch (err) {
        log.warn(`记住别的机器人时落盘失败（不影响对话）: ${err?.message ?? err}`);
      }
    }

    // ---- 「戳一戳 vs 互动表情」取证采样(2026-09-30) ----
    //
    // 为什么要有这一段:用户反映**互动表情面板**(超级6 / 比个心 / 放大招 / 戳一下…)
    // 被我们当成"戳一戳";而真正的戳一戳是**双击头像**(只能在群里做,私聊没有头像)。
    // 两者在私聊收到的 payload 看起来一模一样
    // (`<faceType=3,faceId="NNN",ext="…">[戳一戳]请使用最新版手机QQ体验新功能。`),
    // 所以"能不能分开"这件事**没法靠读代码回答**,只能采对照样本(见 `docs\03` D71 补记四)。
    //
    // 两条判据放在这里:
    //   · **事件类型 + msg_id** —— 同一次动作若被推成两条事件,id 会相同;
    //   · **@ 事件是不是跟着一起来了** —— 群里实测"真戳"后面紧跟着一条
    //     `GROUP_AT_MESSAGE_CREATE`(正文为空、`mentions` 里有她自己)。
    // ⚠️ 采样完成、判据定下来之后,这两行可以降成 debug,但**别删**。
    const rawContent = String(data?.content ?? '');
    const rawFaceIds = [...rawContent.matchAll(/faceId="?(\d+)/g)].map((m) => m[1]);
    const rawNames = [...rawContent.matchAll(/ext="([^"]*)"/g)].map((m) => decodeFaceExt(m[1]) ?? '(解不开)');
    const isGroupAtEvent = type === 'GROUP_AT_MESSAGE_CREATE';
    if (rawFaceIds.length > 0 || isGroupAtEvent || isPokeMessage(data)) {
      log.info(
        `[face] 事件=${type} id=${data?.id ?? '(无)'} faceId=${JSON.stringify(rawFaceIds)} ` +
        `名字=${JSON.stringify(rawNames)} 占位句=${/请使用最新版/.test(rawContent) ? '有' : '无'} ` +
        `mentions=${Array.isArray(data?.mentions) ? data.mentions.length : 0} ` +
        `元素=${data?.msg_elements ? JSON.stringify(data.msg_elements).slice(0, 200) : 'null'} ` +
        `正文=${JSON.stringify(rawContent.slice(0, 110))}`,
      );
    }

    const message = normalizeDispatch(type, data, {
      botId: this.#botId,
      botName: this.#botName,
      selfIds: this.selfIds,
      foreignBotIds: this.foreignBotIds,
    });

    // 归一化之后的**判定**单独一行:上面那行是"平台给了什么",这行是"我们当成什么"。
    // 被丢掉的空 @ 事件也在这里现形(`判=丢弃`)—— 它不再是一个看不见的洞。
    // ⚠️ "丢弃"只对**看起来跟戳/表情有关**的那些打,否则群里每一条空消息都会刷一行。
    const interestingDrop = message === null && (isGroupAtEvent || rawFaceIds.length > 0);
    if (message?.isPoke || message?.isFace || hasFaceMarkup(data) || isGroupAtEvent || interestingDrop) {
      log.info(
        `[face] 判定 id=${data?.id ?? '(无)'} → ` +
        `${message === null ? '丢弃(没正文也没图)' : message.isPoke ? 'poke' : message.isFace ? 'face' : message.isMention ? 'mention' : '普通消息'}` +
        `（会话=${message ? (message.scene === 'c2c' ? '私聊' : '群聊') : '—'}）`,
      );
    }

    if (message) {
      // A poke is worth dumping once in full: QQ does not document what it puts
      // in `msg_elements`, and the target of the poke is exactly what we need to
      // know (the placeholder text replaces it). Cheap — pokes are rare.
      if (message.isPoke) {
        const raw = JSON.stringify({ content: data?.content, msg_elements: data?.msg_elements ?? null });
        log.info(`戳一戳原始 payload：${raw.length > 600 ? `${raw.slice(0, 600)}…` : raw}`);
      }

      // Log the basis for every group @: a mis-judged mention is invisible in
      // the reply itself, and this is the line that showed a second bot in the
      // group being answered as if it were us.
      if (message.scene === 'group' && message.isMention) {
        const evidence = mentionEvidence(data, {
          botId: this.#botId,
          selfIds: this.selfIds,
          foreignBotIds: this.foreignBotIds,
        });
        log.info(
          `判为 @（${type === 'GROUP_AT_MESSAGE_CREATE' ? '专用@事件' : '全量事件'}）：` +
          `selfMarkers=${JSON.stringify(evidence.selfMarkers)} ` +
          `otherMarkers=${JSON.stringify(evidence.otherMarkers)} ` +
          `mentionIds=${JSON.stringify(evidence.mentionIds)} ` +
          `botFlag=${JSON.stringify(evidence.botFlagNames)}`,
        );
      }

      // **被叫仲裁的可见性**(1.172.0 / D291):让贤不许静默 —— 否则"她怎么不理人"
      // 又会变成查无可查的那一类(与 1.167.3「挡住时不记」同族)。
      if (message.scene === 'group' && message.yieldedToForeignBot) {
        const first = (message.mentions ?? []).find((entry) => entry?.bot && entry?.username);
        log.info(
          `多 bot 被叫仲裁：@ 顺序里排第一个的机器人是「${first?.username ?? '别的 bot'}」→ 我让贤（只旁听，不接话）`,
        );
      }

      // QQ documents the mention fields less precisely than the detection needs,
      // and the two id spaces do not line up. So when a group message carries
      // mention evidence yet we decided it was not addressed, say what we saw —
      // that is the one case worth learning from, and it is rare in normal use.
      if (message.scene === 'group' && !message.isMention) {
        const mentions = Array.isArray(data?.mentions) ? data.mentions : [];
        const elements = Array.isArray(data?.msg_elements) ? data.msg_elements : [];
        if (mentions.length > 0 || elements.length > 0) {
          log.info(
            `群消息含提及信息但未判为 @：mentions=${JSON.stringify(mentions)} ` +
            `elementAuthors=${JSON.stringify(elements.map((el) => el?.author ?? null))} ` +
            `foreignBotIds=${JSON.stringify([...this.foreignBotIds])} ` +
            `botId=${this.#botId ?? 'null'}`,
          );
        }
      }

      // QQ documents that "相同 msg_id 可能重复推送" to guarantee delivery, so a
      // duplicate would otherwise produce a second identical reply.
      if (this.#isDuplicate(message.messageId)) {
        log.warn(`忽略重复推送的消息 ${message.messageId}`);
        return;
      }
      this.emit('message', message);
      return;
    }

    // A message event we dropped is worth saying out loud — and worth dumping in
    // full: "no text, no image" is also what a poke looks like when the platform
    // sends it without the `<faceType=3,…>` markup, so the payload is the only
    // way to tell an unrenderable poke from a genuinely empty message.
    if (MESSAGE_EVENT_TYPES.has(type)) {
      const shape = JSON.stringify({
        content: data?.content ?? null,
        msg_elements: data?.msg_elements ?? null,
        mentions: data?.mentions ?? null,
      });
      log.warn(`${type} 没有文字也没有图片，已忽略：${shape.length > 400 ? `${shape.slice(0, 400)}…` : shape}`);
      return;
    }

    const note = LIFECYCLE_NOTES[type];
    if (note) {
      log.info(note);
      return;
    }

    // ---- 有人入群 → **把昵称收进名册**(2026-10-09) ----
    //
    // 用户原话:「**或者能不能让她直接记看到的群聊发言人昵称**」。能 —— 而且名册**已经在库里**:
    // `person` 表每次见到某人说话就更新 `display`(D78)。缺的是**入口**:只在"他开口"时才长。
    //
    // 📌 调研(2026-10-09)查到:官方**已经有**「获取群成员列表」接口
    //    `GET /v2/groups/{group_openid}/members`(返回 `username` 昵称、`member_role`、分页 30/次),
    //    但**需要内邀白名单**(错误码 11253「该接口仅白名单机器人可用」)。
    //    在拿到白名单之前,"入群事件"是**唯一**能让名册长在"还没说话的人"身上的入口 ——
    //    而它用的 intent 正是我们**早就订阅**的 `GROUP_AND_C2C_EVENT (1<<25)`。
    //    ⚠️ 代价:官方文档**没有**给 GROUP_MEMBER_ADD 的 payload 示例,字段名是**实测**出来的 ——
    //    所以下面用"多个候选字段 + 缺了就照实喊一声"的写法,而不是写死一个猜的路径。
    if (type === 'GROUP_MEMBER_ADD') {
      const groupId = String(data?.group_openid ?? '');
      const member = data?.member ?? data ?? {};
      const memberId = String(
        member?.member_openid ?? member?.openid ?? member?.id ?? data?.member_openid ?? '',
      );
      const username = String(member?.username ?? member?.nickname ?? data?.username ?? '').trim();
      if (groupId && memberId) {
        this.emit('memberJoined', { groupId, memberId, username });
        log.info(`群里来了新人：${username || `（${memberId.slice(0, 8)}…）`}（群 ${groupId.slice(0, 8)}…）—— 收进名册`);
      } else {
        // 字段名没猜中时**照实说**,别静默丢 —— 否则"名册不长"永远查不出原因。
        log.warn(`GROUP_MEMBER_ADD 没认出群/成员 id（超集字段可能变了）：${JSON.stringify(data ?? {}).slice(0, 300)}`);
      }
      return;
    }
    if (type === 'GROUP_MEMBER_REMOVE') {
      const groupId = String(data?.group_openid ?? '');
      const member = data?.member ?? data ?? {};
      const memberId = String(member?.member_openid ?? member?.openid ?? member?.id ?? '');
      log.info(`群里有人走了：${memberId ? `${memberId.slice(0, 8)}…` : '(没给 id)'}（群 ${groupId.slice(0, 8)}…）`);
      return;
    }

    // Anything else is logged once per process. An unrecognised event that is
    // silently dropped looks exactly like one that never arrived — and that is
    // the difference between "the platform does not push pokes" and "we ignore
    // them". Once per type is enough to learn the shape without flooding.
    if (!this.#unhandledEventTypes.has(type)) {
      this.#unhandledEventTypes.add(type);
      const shape = JSON.stringify(data ?? {});
      log.info(
        `收到未处理的事件类型 ${type}（同类只打印一次）：${shape.length > 400 ? `${shape.slice(0, 400)}…` : shape}`,
      );
    }
  }

  #send(frame) {
    if (this.#ws?.readyState !== WS_OPEN) return;
    this.#ws.send(JSON.stringify(frame));
  }

  #onClose(code, reason) {
    this.#clearTimers();
    this.#ws = null;
    if (this.#stopped) return;

    const detail = `code=${code} ${reason || ''}`.trim();
    if (FATAL_CLOSE_CODES.has(code)) {
      const hint =
        code === 4914
          ? '机器人已下架，只允许连接沙箱环境'
          : code === 4915
            ? '机器人已被封禁'
            : '鉴权参数被拒绝，请检查 intents 与机器人权限';
      log.error(`网关关闭且不可重试（${detail}）：${hint}`);
      this.emit('fatal', new Error(`QQ 网关拒绝连接: ${detail}（${hint}）`));
      this.#stopped = true;
      return;
    }

    if (RESUME_CLOSE_CODES.has(code)) {
      log.info(`网关关闭（${detail}），将尝试恢复会话`);
    } else {
      log.warn(`网关关闭（${detail}），将重新鉴权`);
      this.#sessionId = null;
      this.#lastSeq = null;
    }
    this.#scheduleReconnect(detail);
  }

  #scheduleReconnect(why) {
    if (this.#stopped) return;
    this.#attempts += 1;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.#attempts, 6)) + Math.random() * 1000;
    log.info(`${why}；${Math.round(delay)}ms 后重连（第 ${this.#attempts} 次）`);
    setTimeout(() => void this.#connect(), delay);
  }

  #clearTimers() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#heartbeatTimer = null;
    this.#ackTimer = null;
  }
}

/** Dispatch types that carry a user message (and so should never be dropped silently). */
const MESSAGE_EVENT_TYPES = new Set([
  'C2C_MESSAGE_CREATE',
  'GROUP_AT_MESSAGE_CREATE',
  'GROUP_MESSAGE_CREATE',
]);

/**
 * Group/C2C lifecycle events we do not act on but that explain missing messages —
 * notably the two "通知已关闭" toggles, which silently stop delivery.
 */
const LIFECYCLE_NOTES = {
  GROUP_ADD_ROBOT: '机器人已被添加到群聊',
  GROUP_DEL_ROBOT: '机器人已被移出群聊',
  GROUP_MSG_REJECT: '⚠ 该群已关闭机器人通知 —— 这个群不会再收到任何消息',
  GROUP_MSG_RECEIVE: '该群已重新开启机器人通知',
  FRIEND_ADD: '用户添加了机器人',
  FRIEND_DEL: '用户删除了机器人',
  C2C_MSG_REJECT: '⚠ 用户关闭了主动消息推送',
  C2C_MSG_RECEIVE: '用户开启了主动消息推送',
};

/** Attachment MIME types the model can actually read. */
const READABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Pull the readable images out of a message's attachments.
 *
 * QQ also sends `voice`, `video/mp4` and `file` attachments; those are ignored
 * rather than forwarded, because the model accepts only raster images.
 *
 * ⚠️ **2026-10-02 现场(用户报"副实例几乎从来看不到图")**:同一个网关有**两种**携带附件的方式 ——
 *   · `data.attachments[]`(老形状,纯图消息常走这条);
 *   · `data.msg_elements[]`(网关的结构化元素,里面是 `{attachments:[…]}` 嵌一层;
 *     **带文字的图、表情包那类走这条**)。
 * 原来这里**只看前者**,于是"图 + 一句文字"的消息永远是 `图片=0` ——
 * 图根本没进模型,她却照样回一句不搭界的话(看起来像"逃避")。
 * 现在两条路都扫,并且**按 url 去重**(同一条消息两种形状都带同一张图时会重复)。
 */
export function extractImages(data) {
  const images = [];
  const seen = new Set();
  /** 从一个"可能带附件"的容器里收图。 */
  const collect = (holder) => {
    const attachments = Array.isArray(holder?.attachments) ? holder.attachments : [];
    for (const attachment of attachments) {
      const mimeType = String(attachment?.content_type ?? '').toLowerCase();
      if (!READABLE_IMAGE_TYPES.has(mimeType)) continue;
      if (typeof attachment?.url !== 'string' || attachment.url === '') continue;
      if (seen.has(attachment.url)) continue;
      seen.add(attachment.url);
      images.push({
        url: attachment.url,
        mimeType,
        filename: attachment.filename,
        width: attachment.width,
        height: attachment.height,
        size: attachment.size,
      });
    }
  };
  collect(data);
  // `msg_elements` 在两种形态之间摇摆:网关有时给对象数组,有时给**JSON 字符串**。
  const elements = data?.msg_elements;
  const parsed = typeof elements === 'string'
    ? (() => { try { return JSON.parse(elements); } catch { return []; } })()
    : elements;
  if (Array.isArray(parsed)) {
    for (const element of parsed) collect(element);
  }
  return images;
}

/** Whether a mention/element entry refers to a specific id in any of its id fields. */
function entryHasId(entry, id) {
  return entry?.id === id || entry?.member_openid === id || entry?.user_openid === id;
}

/** The id an entry refers to, whichever field carries it. */
function entryId(entry) {
  return entry?.id ?? entry?.member_openid ?? entry?.user_openid ?? null;
}

/** The mention-ish entries of a payload: `mentions[]` plus `msg_elements[].author`. */
function mentionEntries(data) {
  return [
    ...(Array.isArray(data?.mentions) ? data.mentions : []),
    ...(Array.isArray(data?.msg_elements) ? data.msg_elements.map((el) => el?.author) : []),
  ].filter(Boolean);
}

/**
 * Every id named by a `<@id>` marker in the text.
 *
 * The ids are hex openids, not digits — an earlier `\d+` pattern silently failed
 * to match them, which both leaked the markers into the prompt and made the
 * mention check unable to tell whose id it was looking at.
 */
export function markerIds(content) {
  if (typeof content !== 'string') return [];
  return [...content.matchAll(/<@!?([^>\s]+)>/g)].map((match) => match[1]);
}

/**
 * Every id that means "this bot": the global id from READY, plus any
 * group-scoped openid that has been configured or learned.
 *
 * QQ hands out a *group-scoped* `member_openid` for the bot, and it never equals
 * the global `user.id` (D09). Ids are also **different in every group**, so they
 * are learned at runtime rather than configured by hand — see `selfIdsFrom`.
 */
function knownSelfIds({ botId = null, selfIds = [] } = {}) {
  return new Set([botId, ...(selfIds ?? [])].filter(Boolean));
}

/**
 * Ids in a payload that are demonstrably the bot's own, because the mention
 * entry carries the bot's own nickname.
 *
 * This is what makes the whole thing self-maintaining: a real @ of the bot
 * arrives as `{ id: '<group openid>', bot: true, username: '主实例' }`, so the
 * group-scoped id can be collected from ordinary traffic instead of being
 * looked up per group and pasted into `.env`.
 */
export function selfIdsFrom(data, { botName = null } = {}) {
  if (typeof botName !== 'string' || botName === '') return [];
  return mentionEntries(data)
    .filter((entry) => typeof entry?.username === 'string' && entry.username === botName)
    .map(entryId)
    .filter(Boolean);
}

/**
 * 从状态库的 `meta.foreign_bot_ids` 里读回"别的机器人"(D54)。
 *
 * 存的是一个 JSON 数组(id 与昵称)。**读坏了就当没有** —— 这是缓存性质的提示,
 * 不该因为一行脏数据让 bridge 起不来(和 `readLock` 的宽容度一致)。
 *
 * @param {string|null|undefined} value
 * @returns {Array<{id: string, name: string|null}>}
 */
export function parseForeignBotIds(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (typeof entry === 'string') return { id: entry, name: null };
        if (entry && typeof entry.id === 'string') {
          return { id: entry.id, name: typeof entry.name === 'string' ? entry.name : null };
        }
        return null;
      })
      .filter((entry) => entry && entry.id !== '');
  } catch {
    return [];
  }
}

/**
 * Ids in a payload that belong to **some other bot** in the group.
 *
 * This closes the last hole in the @ judgement. `bot: true` means *"the mentioned
 * party is a bot"*, not *"the mentioned party is this bot"* — and when the mention
 * entry carries no `username` (it does not always), that flag was all that was
 * left to go on. So "@some-other-bot" was answered as if it were us.
 *
 * The evidence needed to settle it arrives anyway: whenever anyone @s the other
 * bot, that mention entry carries its openid. Collect those, and an unknown
 * `bot: true` id can be recognised as *the other bot* instead of as us.
 *
 * @param {object} data dispatch body.
 * @param {{botId?: string|null, selfIds?: Iterable<string>, known?: Iterable<string>}} [context]
 * @returns {string[]} ids belonging to other bots
 */export function foreignBotIdsFrom(data, context = {}) {
  const mine = knownSelfIds(context);
  const known = new Set(context.known ?? []);
  return mentionEntries(data)
    .filter((entry) => entry?.bot === true)
    .map(entryId)
    .filter((id) => Boolean(id) && !mine.has(id) && !known.has(id));
}

/**
 * Whether the bot itself appears in a message's mention list.
 *
 * Signals, in descending order of trustworthiness:
 *
 * 1. **An id we know is ours** — the global id from READY, or a group openid
 *    learned from earlier traffic. Exact and sound.
 * 2. **The mention entry's nickname is our own.** The platform supplies
 *    `username` alongside the mention, which settles "which bot is this?"
 *    without any configuration — and it is what tells us apart from the *other*
 *    bot in the group.
 * 3. **A text marker naming a known id of ours.** What it must *not* do is treat
 *    any `<@…>` as "me": that is what made every "@somebody else" look like an @
 *    of the bot.
 * 4. **A mention entry naming another bot we have learned about** — that @ is
 *    theirs, and we say no outright (see `foreignBotIdsFrom`).
 * 5. **The bare `bot` flag**, and only as a last resort: it means "the mentioned
 *    party is a bot", not "the mentioned party is *this* bot".
 *
 * @param {object} data dispatch body.
 * @param {{botId?: string, botName?: string, selfIds?: Iterable<string>,
 *          foreignBotIds?: Iterable<string>}} [context]
 */
export function mentionsBot(data, context = {}) {
  const entries = mentionEntries(data);
  const known = knownSelfIds(context);
  const foreign = new Set(context.foreignBotIds ?? []);
  const markers = markerIds(data?.content);
  const botName = typeof context.botName === 'string' && context.botName !== '' ? context.botName : null;

  if (entries.some((entry) => [...known].some((id) => entryHasId(entry, id)))) return true;
  if (botName && entries.some((entry) => entry.username === botName)) return true;
  if (markers.some((id) => known.has(id))) return true;

  // The text names somebody we do not recognise: this @ belongs to them.
  if (markers.length > 0 && markers.every((id) => !known.has(id))) return false;

  // Something in this payload is provably another bot's mention, and **nothing is
  // ours** (the two checks above already failed). That is their @, not ours.
  //
  // Why this is safe even though `foreignBotIds` is learned, not configured: a
  // group openid is bound to one group *and* one bot, so an id only ever lands in
  // here by being attached to a mention entry flagged `bot: true` whose id is not
  // one of ours. It cannot name a human.
  if (entries.some((entry) => foreign.has(entryId(entry)))) return false;

  return entries.some((entry) => {
    if (entry?.bot !== true) return false;
    // A named robot that is not us is the other bot in the group.
    if (botName && typeof entry.username === 'string' && entry.username !== '' && entry.username !== botName) {
      return false;
    }
    return true;
  });
}

/**
 * Why a group message was judged as addressed to the bot (or not).
 *
 * Logged for every group @: a wrong judgement is invisible in the reply itself,
 * and this is the line that turned "she answers everyone" into "the text marker
 * names somebody else".
 */
export function mentionEvidence(data, context = {}) {
  const known = knownSelfIds(context);
  const markers = markerIds(data?.content);
  const foreign = new Set(context.foreignBotIds ?? []);
  return {
    markers,
    selfMarkers: markers.filter((id) => known.has(id)),
    otherMarkers: markers.filter((id) => !known.has(id)),
    mentionIds: mentionEntries(data).map(entryId).filter(Boolean),
    botFlagNames: mentionEntries(data).filter((entry) => entry?.bot === true).map((entry) => entry.username ?? '(无名)'),
    // 判定的最后一道闸:这些 id 是**别的机器人**的(见 `foreignBotIdsFrom`)。
    foreignBotIds: mentionEntries(data).map(entryId).filter((id) => id && foreign.has(id)),
  };
}

/**
 * Map a dispatch event to a normalized inbound message, or null if not a user message.
 *
 * A message qualifies when it carries text *or* an image: an @ with only a photo
 * attached is a perfectly ordinary thing to send. The one empty payload that is
 * kept is a bare @ of the bot, which arrives with nothing left after the
 * platform strips the mention itself.
 *
 * @param {string} type dispatch event name.
 * @param {object} data event body.
 * @param {{botId?: string, botName?: string, selfIds?: string[],
 *          foreignBotIds?: Iterable<string>}} [context]
 *   the bot's global id and nickname (from READY), plus any configured
 *   group-scoped ids of its own, plus the ids of other bots in its groups.
 */
export function normalizeDispatch(type, data, context = {}) {
  const content = cleanInboundText(data?.content);
  const images = extractImages(data);
  // T3(2026-10-29):引用身份只保留 **id**(平台给的关联锚点)——引用正文/嵌套附件是
  // 另一来源,不在此混入顶层 images;「引用的图是什么」由上层凭 id 查发送绑定解析。
  const replyToMessageId = data?.message_reference?.message_id
    ?? data?.referenced_message?.id ?? null;

  const isC2c = type === 'C2C_MESSAGE_CREATE';
  const isGroup = type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE';
  if (!isC2c && !isGroup) return null;

  // ⚠️ **私聊没有头像,所以私聊里根本不存在"真戳"**(2026-09-30 用户指出 + 实测)。
  // 而 QQ 的**互动表情**(那一栏里的"戳一下 / 超级6 / 放大招"…)用的是**和戳一戳
  // 一模一样的 payload**(`<faceType=3,faceId="NNN",ext="…">[戳一戳]请使用最新版…`)。
  // 所以在私聊里把它当戳一戳,只有一个后果:**拿概率去决定理不理一条普通消息**
  // (1.24.5 那次"连发 5 个互动表情她回 5 轮又只有 35% 概率回应"就是这么来的)。
  // 判据:`isPoke` 只在**群**里成立。
  //
  // 📌 群里那半**仍然分不开**(采样结论见 `docs\03` D71 补记五):真戳与互动表情
  //    在群聊里都是 `GROUP_MESSAGE_CREATE` + 同一份 payload,`faceId` 也复用。
  //    所以群聊**保持旧行为**(带 `[戳一戳]` 标记就算戳)—— 那是"多回应一次",
  //    而不是"把真实的互撩忽略掉"。
  const isPoke = isGroup && isPokeMessage(data);
  // A face message is only a *gesture* when there is nothing else in it: an emoji
  // with actual text is an ordinary message and goes the normal route.
  //
  // ⚠️ **带图片的表情包不是手势**(2026-09-30 实测踩过):QQ 的**表情包**(贴纸)是
  // **附件** —— 正文只剩一个 `[表情]` 占位符,于是这里的"剥掉表情标记后为空"成立、
  // 被判成"纯表情手势"。而私聊的表情包其实是一条**正经消息**(用户就是在发东西),
  // 后果是它绕开了连发合并:连着发四个表情包 → 她回四轮(`docs\03` D71 现场)。
  // 所以判据再加一条:**有附件就不是手势**。
  const faceOnly = !isPoke
    && images.length === 0
    && hasFaceMarkup(data)
    && content.replace(/\[(表情|大表情)(：[^\]\n]*)?\]/g, '').trim() === '';

  // With 全量消息 on, an @ may arrive as the full-mode event instead of the
  // dedicated one, so the mention list has to be checked here too.
  let isMention = isC2c
    ? true
    : type === 'GROUP_AT_MESSAGE_CREATE' || mentionsBot(data, context);

  // —— **多 bot 被叫仲裁**(1.172.0 / D291,两道闸之一)——
  // 一条消息同时 @ 我和别的**已知** bot 时,只有**排第一个**的那个 bot 算被叫,
  // 其余让贤 —— 否则两只都答,群里就是"抢答"(2026-10-21 现场:
  // `mentionIds=[主实例, 副实例]`,两只都开了口)。
  // ⚠️ 它同时掐掉 `mentionsBot` 的 **bot 标志兜底**误伤:消息只 @ 副实例(名单里
  // 有的)时,bot:true 会让"算 @ 我"成立 —— 那正是"@副实例 但主实例也跟着回"的主形状。
  // 业界同款:OpenClaw `ignoreOtherMentions`(@别的 bot → 整条忽略)、
  // Gugu-web「QQ AT 消息按 is_you 过滤非自己的 @」;出处见 `docs\03` D291。
  // ⚠️ 只认**名单里**的 bot(`foreignBotIds`):不认识的新 bot 不参与仲裁 ——
  // bot 标志兜底对它们保持原样(名单是自动学+落盘的,D54)。
  const foreignBots = new Set(context.foreignBotIds ?? []);
  const myIds = knownSelfIds(context);
  // **证据源两条都要**(1.172.1 / D291 复核):mentions[]/msg_elements 条目 + 正文
  // `<@id>` 标记。`mentionsBot` 第 3 条(1262)就靠标记判 @ —— 条目可能缺席,
  // 闸一不该比它瞎(复核真跑构造过:markers-only 双 @ 在 1.172.0 双答)。
  // ⚠️ 标记必须读**原始 payload**:归一化的 `content` 已被 cleanInboundText 剥掉
  // `<@id>`,在这上面找标记 = 永远空集(1.172.1 真跑抓到)。
  // 正文标记顺序 = @ 出现顺序 → **标记先行**(两源冲突时正文顺序是真相),条目补漏,去重保序。
  const groupMentionIds = isGroup
    ? [...markerIds(data?.content), ...mentionEntries(data).map(entryId).filter(Boolean)]
        .filter((id, index, all) => all.indexOf(id) === index)
    : [];
  const firstForeignMention = groupMentionIds.findIndex((id) => foreignBots.has(id));
  const myFirstMention = groupMentionIds.findIndex((id) => myIds.has(id));
  const mentionsForeignBot = firstForeignMention !== -1;
  const yieldedToForeignBot = isGroup && isMention && mentionsForeignBot
    && (myFirstMention === -1 || firstForeignMention < myFirstMention);
  if (yieldedToForeignBot) isMention = false;

  // **@ 了别人**(1.196.0 / D322):mentionIds 里只要有一个不是我的 id —— **人类也算、
  // 陌生 bot 也算** —— 这条消息就是"对别人说的",宽口径(第二人称)与读空气都不许
  // 把它当成在跟她说(2026-10-24 主人现场:「@其他用户时主实例又当成在跟她说话」)。
  // 这是 OpenClaw `ignoreOtherMentions` 的**完整口径**("another bot **or user**")——
  // 比 D291 的"只认已知 bot"更蛮横、但对所有 bot 通用:不依赖 foreignBotIds 名单。
  // ⚠️ 它只在"**没有** @ 我"时才由 index.js 的让贤闸消费(isMention=true 时不进那条路)。
  const mentionsOthers = groupMentionIds.some((id) => !myIds.has(id));

  // An empty payload is normally not worth a model call. Two exceptions:
  //   * an @ with nothing after it — the platform strips the bot's own @ from
  //     `content`, so somebody calling the bot over arrives as "no text, no image";
  //   * a poke, which also arrives with an empty body in some payload shapes
  //     (the tagged one, `<faceType=3,…>[戳一戳]…`, is the other).
  // Both are somebody getting the bot's attention rather than an empty message.
  // ⚠️ 让贤的那条也算"有人被叫到了"(1.172.0):否则 "@主实例 @副实例" 不带正文时
  // 会被当空消息丢掉,两个 bot 都沉默 —— 丢不丢由 index.js 的让贤闸决定,不在这层。
  const bareSummons = isGroup && (isMention || yieldedToForeignBot || isPoke || faceOnly) && content === '';
  if (content === '' && images.length === 0 && !bareSummons) return null;

  if (isC2c) {
    const openid = data?.author?.user_openid;
    if (!openid) return null;
    return {
      scene: 'c2c',
      targetId: openid,
      senderId: openid,
      senderName: data?.author?.username,
      messageId: data?.id,
      replyToMessageId,
      content,
      images,
      isMention: true,
      isPoke,
      isFace: faceOnly,
      // 这条消息 @ 了谁(openid + 昵称 + 是不是机器人)—— `/认人` 要靠它把"@ 到的人"
      // 与他的名字对起来(2026-10-01,D78)。`username` **不一定有**,调用方要能接受 null。
      mentions: mentionEntries(data).map((entry) => ({
        id: entryId(entry),
        username: typeof entry?.username === 'string' ? entry.username : null,
        bot: entry?.bot === true,
      })),
      timestamp: data?.timestamp,
    };
  }

  // Full mode (`GROUP_MESSAGE_CREATE`) delivers every group message; the @ event
  // (`GROUP_AT_MESSAGE_CREATE`) is the only one that proves the bot was addressed.
  // Both carry identical fields, so they share one branch.
  if (type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE') {
    const groupOpenid = data?.group_openid;
    if (!groupOpenid) return null;
    return {
      scene: 'group',
      targetId: groupOpenid,
      senderId: data?.author?.member_openid,
      senderName: data?.author?.username,
      messageId: data?.id,
      replyToMessageId,
      content,
      images,
      isMention,
      // **被叫仲裁结果**(1.172.0 / D291):这条消息是否点名了**别的已知 bot**、
      // 以及我是否因 @ 顺序让了贤。index.js 的群回复闸消费前者(点名别人 → 不接话);
      // 后者只做日志与判据,不再有第二个消费者(D159:字段跟实现走,别抄第二份)。
      mentionsForeignBot,
      yieldedToForeignBot,
      // **@ 了别人(人类也行)**(1.196.0 / D322):让贤闸的通用条件 —— 不依赖 bot 名单。
      mentionsOthers,
      isPoke,
      isFace: faceOnly,
      mentions: mentionEntries(data).map((entry) => ({
        id: entryId(entry),
        username: typeof entry?.username === 'string' ? entry.username : null,
        bot: entry?.bot === true,
      })),
      timestamp: data?.timestamp,
    };
  }

  return null;
}
