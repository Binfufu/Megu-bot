/**
 * **身份绑定**:把"网页上的账号"和"QQ 里的这个人"对成同一个人(1.97.0 / D158)。
 *
 * ## 为什么要有它
 *
 * 用户原话:「**最好能让网页登录完的玩家能绑定自己 qq 昵称,这样在 qq 又能认出来是谁**」。
 *
 * 到 1.96.0 为止,库里**有两套互不相干的身份**(`src\people.js` 的模块注释里就记着这条):
 *
 * | 来源 | 库里是什么 | 谁 |
 * |---|---|---|
 * | 面板账号 | `player` 表 | 网页上那个玩家(`playerId`) |
 * | 熟人 | `meta['affinity:<openid>']` | QQ 里说过话的人(只有档位、没有账号) |
 *
 * ⚠️ **两套 id 之间没有任何对应关系** ⇒ 同一个人在网页上是一个 `player:7`,
 * 在 QQ 里是另一个 `person:<openid>`:她认不出"这是同一个人",报表上也会出现两行。
 *
 * ## 形状:一次性口令,不是"去 QQ 里填账号密码"
 *
 * ```
 *   网页(已登录)                 QQ(她那边)
 *   ─────────────                 ──────────
 *   点「绑定 QQ」→ 拿到口令        把口令发给她(私聊)
 *   HH-K7M2QP                     /绑定 HH-K7M2QP
 *        └──────── 她核销 ────────┘
 *              → meta['identity:bind:<playerId>']  ← 一个键就是这份关系
 * ```
 *
 * ⚠️ **四条刻意的口径**:
 * ① **口令是一次性的、有时限**(默认 15 分钟):它是"这台网页"和"这个 QQ"之间唯一的信物,
 *    能反复用的口令等于没有口令;
 * ② **一个人只有一个 QQ**(一对一):同一个人再绑就把旧的那条换成新的(而**不是**留下两条)——
 *    否则"她该对谁说话"就成了没答案的问题;
 * ③ ⚠️ **只在私聊里核销**(见 `index.js`):群里任何人都能打一句 `HH-…`,
 *    那等于把别人的账号抢走;
 * ④ **绑定不改数值、不改档位**:它只回答"这两条身份是同一个人"。
 *    ⚠️ 好感度(`affinity:<openid>`)仍然是 QQ 那条路上的那本账 —— 合并的是**身份**,不是账。
 */
import { randomBytes } from 'node:crypto';

/** 绑定关系的 meta 前缀(`identity:bind:<playerId>`)。 */
export const BIND_META_PREFIX = 'identity:bind:';

/** 口令长度(6 位;字符集 32 个 → 约 10 亿种,足够挡住瞎猜)。 */
export const BIND_CODE_LENGTH = 6;

/** 口令的字符集:去掉 **I/O/0/1**(手抄时会看错)的 Crockford 风格。 */
export const BIND_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 口令活多久(默认 15 分钟)。 */
export const BIND_TTL_MS = 15 * 60_000;

/** 一次能生成多少个还没用掉的口令(旧的那个会被顶掉)。 */
export const BIND_MAX_PENDING = 1;

/** 这一条绑定的 meta 键(认不出 `playerId` 就给 null —— 不猜)。 */
export function bindMetaKey(playerId) {
  // ⚠️ 只认**规范的**正整数写法(1.99.1 复核):`'0'` / `'007'` / `'1e3'` / `'-3'` 一律 null ——
  //    否则同一个账号会有两个键(`identity:bind:7` 与 `identity:bind:007`),
  //    那正是"两份事实"的开头。
  const raw = typeof playerId === 'number' ? String(playerId) : String(playerId ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return `${BIND_META_PREFIX}${Number(raw)}`;
}

/** 口令的显示形状:去掉一切非字符集的东西、折成大写、补上 `HH-`。 */
export function formatBindCode(raw) {
  // ⚠️ **先去掉两端空白**(1.99.1 复核):不然前导空白会挡住"去前缀"那一步 ——
  //    `' hh-k7m2qp '` 会变成 `HH-HHK7M2QP`。
  // ⚠️ 然后把已经带着的前缀去掉再拼 —— 否则 `HH-K7M2QP` 也会被拼成 `HH-HHK7M2QP`。
  const body = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/^HH[\s-]*/, '')
    .replace(/[^A-Z0-9]/g, '');
  return body === '' ? '' : `HH-${body}`;
}

/** 从一句人话里认出"这是不是一个口令"(发给她的那句话就是这个形状)。 */
export function looksLikeBindCode(text) {
  const body = String(text ?? '').replace(/^\/绑定\s*/, '').trim();
  // ⚠️ 前后**都不许有别的字**:随手说一句"HH-ABCD 这个是什么"不算绑定尝试
  //    (否则她会把正常聊天当成核销口令)。
  return /^HH[\s-]*[A-Z0-9]{4,12}$/i.test(body);
}

/** 把一句话里的口令取出来(认不出给 null)。 */
export function parseBindCode(text) {
  const body = String(text ?? '').replace(/^\/绑定\s*/, '').trim();
  if (!looksLikeBindCode(body)) return null;
  return formatBindCode(body);
}

/** 生成一个口令(纯函数:随机源可注入 —— 单测里给固定字节)。 */
export function makeBindCode({ bytes = null } = {}) {
  // ⚠️ **正文不许以 `HH` 开头**(1.99.1 复核):`HH-` + `HHAB23` = `HH-HHAB23`,
  //    而手抄的人很容易只抄正文 —— 那样会被解析成 `HH-AB23`(少了两位)。
  //    重摇一次就避开(概率 1/1024,值得花这一行)。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const buf = bytes ?? randomBytes(BIND_CODE_LENGTH);
    let out = '';
    for (let i = 0; i < BIND_CODE_LENGTH; i += 1) {
      out += BIND_ALPHABET[buf[i] % BIND_ALPHABET.length];
    }
    if (!out.startsWith('HH')) return `HH-${out}`;
  }
  // 4 次都撞上极小概率(或者调用方给的固定字节就是这样)—— 照发给它,别死循环。
  return 'HH-AAAAAA';
}

/**
 * **核销一枚口令**(纯函数):给"待用口令表 + 一句话 + 现在几点 + 是谁发的",说能不能绑。
 *
 * @param {object} input
 * @param {Array<{code:string, playerId:number|string, playerName?:string, expiresAt:number}>} input.pending
 * @param {string} input.text 他发来的那句话
 * @param {number} input.now
 * @param {string} input.openid 发这句话的人(QQ 那边的 id)
 * @param {string|null} [input.displayName] QQ 那边显示的名字(用来给报表一个"他叫什么")
 * @returns {{ok:boolean, error?:string, playerId?:number, playerName?:string, openid?:string,
 *   displayName?:string|null}}
 */
export function redeemBindCode({ pending = [], text, now = Date.now(), openid, displayName = null } = {}) {
  const code = parseBindCode(text);
  if (!code) return { ok: false, error: 'not_a_code' };
  const who = String(openid ?? '').trim();
  if (!who) return { ok: false, error: 'no_openid' };
  const hit = (pending ?? []).find((row) => formatBindCode(row?.code) === code);
  if (!hit) return { ok: false, error: 'unknown_code' };
  if (Number(hit.expiresAt) <= Number(now)) return { ok: false, error: 'expired_code' };
  const playerId = Number(hit.playerId);
  if (!Number.isInteger(playerId) || playerId <= 0) return { ok: false, error: 'bad_player' };
  return {
    ok: true,
    playerId,
    playerName: String(hit.playerName ?? '').trim() || null,
    openid: who,
    displayName: String(displayName ?? '').trim() || null,
  };
}

/** 这一条绑定的人话(页面与报表共用)。 */
export function describeBinding(row = {}) {
  if (!row || !row.openid) return '还没绑 QQ';
  const name = String(row.displayName ?? '').trim();
  return name ? `已绑定 QQ：${name}` : '已绑定 QQ';
}

/**
 * **她该知道的那一句**(1.97.0 / D158 的"最后一米"):这一轮说话的人是谁?
 *
 * ⚠️ 四条刻意的口径:
 * ① **只说"是同一个人",不报 id**:openid 与账号名都是内部标识 ——
 *    给模型看的是"这个人就是网页上的某某",不是一串能拿去冒用的东西;
 * ② **名字先过"看得见吗"那一关**(`nameIsInvisible`):昵称可以是空白/零宽字符,
 *    直接塞进提示词会变成一段莫名其妙的空(库里的真实现象,见 `people.js`);
 * ③ **两个方向都算**:
 *    · QQ 那一轮 → "他网页上的账号叫某某"(这样她在 QQ 里叫得出名字);
 *    · 网页那一轮 → "他在 QQ 里叫某某"(这样她在网页上也认得出是同一个人);
 * ④ **绑没绑都要给一句**(游客 / 没绑的人):照实说,别让她以为人人都绑过 ——
 *    否则她会对着一个陌生访客说出"我们是一伙的"那种话。
 *
 * @param {object} input
 * @param {'qq'|'web'|'none'} [input.scene] 这一轮从哪来
 * @param {{playerId?:number, nickname?:string|null, account?:string|null}} [input.player]
 *        这个 openid 绑到的账号(没有就是没绑)
 * @param {{openid?:string, displayName?:string|null}} [input.binding] 绑定记录本身
 * @param {string|null} [input.toldName] **她被告知该用的名字**(`person` 表里 `/认人` 记下的那个)
 * @param {(raw:string) => boolean} [input.nameIsInvisible]
 * @returns {string|null} 一句话;`scene` 认不出时给 null(不猜)
 */
export function buildIdentityNote({
  scene = 'none', player = null, binding = null, toldName = null, nameIsInvisible = null,
} = {}) {
  const hidden = typeof nameIsInvisible === 'function' ? nameIsInvisible : (raw) => String(raw ?? '').trim() === '';
  const visibleName = (raw) => {
    const text = String(raw ?? '').trim();
    return text === '' || hidden(text) ? '' : text;
  };
  if (scene === 'qq') {
    if (!binding || !player) {
      return '这一轮跟你说话的人在网页上**没有账号**（或者还没把两边绑起来）—— 别把他当成你认识的那个网友。';
    }
    // ⚠️ 名字优先级(1.100.0 / D162,与 `joinPeople` 同一条口径):
    //    **玩家自己起的昵称 > 她被告知的名字(`/认人`)> 绑定那一刻记下的 > 账号名** ——
    //    中间那个是**操作者明确告诉她的称呼**,比"绑定时顺手抓到的显示名"更该用。
    const webName = visibleName(player.nickname) || visibleName(toldName) || visibleName(player.account);
    if (!webName) {
      return '这一轮跟你说话的人，网页上的账号**绑过了**（就是网页上的同一个人），但他没留名字 —— 直接聊就行。';
    }
    // ⚠️ **写成"可以用"而不是"可以叫他"**(1.100.1 / D163):
    //    用户实测过"绑定完没什么用" —— 一句光是陈述事实的话,她不会拿来回话。
    //    这里明确给出**什么时候用它**(他问起 / 你要称呼他),她才知道该拿它做什么。
    return `这一轮跟你说话的人，就是网页上的「${webName}」（两边是同一个人）`
      + `—— **他问起你是谁、或者你要称呼他的时候，就用这个名字**（别解释你怎么知道的）。`;
  }
  if (scene === 'web') {
    if (!binding) {
      return '正在网页上跟你说话的人，**还没把他的 QQ 绑过来** —— 你还不知道他在 QQ 里是谁。';
    }
    // 反向也一样:`/认人` 那个名字比"绑定时抓到的"更该用
    const qqName = visibleName(toldName) || visibleName(binding.displayName);
    return qqName
      ? `正在网页上跟你说话的人，在 QQ 里叫「${qqName}」（两边是同一个人）`
        + `—— **他问起、或者你要称呼他的时候就用这个名字**。`
      : '正在网页上跟你说话的人，**QQ 那边已经绑过来了**（是同一个人），但那边没留名字。';
  }
  return null;
}

/**
 * **建一份绑定服务**(依赖注入:状态怎么存由调用方给)。
 *
 * @param {object} deps
 * @param {object} deps.store 状态库(`getMeta` / `setMeta` / `listMetaKeys` / `deleteMeta`?)
 * @param {() => number} [deps.now]
 * @param {object} [deps.log]
 */
export function createIdentityLinks({ store, now = () => Date.now(), log = console } = {}) {
  /**
   * 所有绑定(`{playerId, openid, displayName, boundAt, updatedAt}`)—— 键是 `identity:bind:`。
   *
   * ⚠️ **只回"绑上了"的那些**(openid 非空)。还没核销的账号只有 `pending`,
   *    它是**内部状态** —— 但核销那一步必须看得见它,所以那里直接读键(见 `redeem`)。
   */
  function all() {
    return rows().filter((row) => row.openid);
  }

  /** 原始行(含"只发过口令、还没核销"的那些)—— 内部用。 */
  function rows() {
    const out = [];
    let metas = [];
    try { metas = store.listMetaKeys(BIND_META_PREFIX) ?? []; } catch (err) {
      log.warn?.(`身份绑定：读不出来（当空处理）: ${err?.message ?? err}`);
      return out;
    }
    for (const meta of metas) {
      const key = String(meta?.key ?? '');
      if (!key.startsWith(BIND_META_PREFIX)) continue;
      const playerId = Number(key.slice(BIND_META_PREFIX.length));
      if (!Number.isInteger(playerId) || playerId <= 0) continue;
      try {
        const parsed = JSON.parse(String(meta.value ?? ''));
        out.push({
          playerId,
          openid: String(parsed?.openid ?? '').trim() || null,
          displayName: String(parsed?.displayName ?? '').trim() || null,
          boundAt: Number(parsed?.boundAt) || 0,
          updatedAt: Number(parsed?.updatedAt) || 0,
          playerName: String(parsed?.playerName ?? '').trim() || null,
          pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
        });
      } catch { /* 坏值当没有 —— 不猜 */ }
    }
    return out;
  }

  const byPlayer = (playerId) => all().find((row) => row.playerId === Number(playerId)) ?? null;
  const byOpenid = (openid) => {
    const who = String(openid ?? '').trim();
    return who ? (all().find((row) => row.openid === who) ?? null) : null;
  };

  /** 解绑(单独一个函数,别用 `this` —— 拆开之后好测、也不会因为换个调用方式就坏)。 */
  const unbind = (playerId, { silent = false } = {}) => {
    const id = Number(playerId);
    const key = bindMetaKey(id);
    if (!key) return { ok: false, error: 'bad_player' };
    const before = byPlayer(id);
    try {
      store.setMeta(key, JSON.stringify({
        openid: null, displayName: null, playerName: null, boundAt: 0, updatedAt: now(), pending: [],
      }));
    } catch (err) {
      log.warn?.(`身份绑定：解绑失败: ${err?.message ?? err}`);
      return { ok: false, error: 'store_failed' };
    }
    if (!silent) log.info?.(`身份绑定：账号 #${id} 解绑了 ${before?.openid ? String(before.openid).slice(0, 8) + '…' : '（本来就没绑）'}`);
    return { ok: true };
  };

  return {
    all,
    byPlayer,
    byOpenid,

    /**
     * 给这个账号**发一枚口令**(旧的那枚作废)。
     * @returns {{ok:boolean, error?:string, code?:string, expiresAt?:number}}
     */
    issue(playerId, { playerName = null, ttlMs = BIND_TTL_MS } = {}) {
      const id = Number(playerId);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'bad_player' };
      const key = bindMetaKey(id);
      if (!key) return { ok: false, error: 'bad_player' };
      const at = now();
      const current = byPlayer(id);
      // ⚠️ 已经绑过的人再点一次「绑定 QQ」= **换一台 QQ**:允许,但要**明说**(页面那一侧会提示)。
      const code = makeBindCode({});
      const row = {
        openid: current?.openid ?? null,
        displayName: current?.displayName ?? null,
        boundAt: current?.boundAt ?? 0,
        updatedAt: current?.updatedAt ?? 0,
        playerName: String(playerName ?? '').trim() || null,
        pending: [{ code, expiresAt: at + Math.max(60_000, Number(ttlMs) || BIND_TTL_MS), issuedAt: at }],
      };
      try {
        store.setMeta(key, JSON.stringify(row));
      } catch (err) {
        log.warn?.(`身份绑定：口令没写下去: ${err?.message ?? err}`);
        return { ok: false, error: 'store_failed' };
      }
      return { ok: true, code, expiresAt: at + Math.max(60_000, Number(ttlMs) || BIND_TTL_MS) };
    },

    /** 这个账号现在有没有**还没过期**的口令(页面刷新时要把那枚显示出来)。 */
    pendingOf(playerId) {
      const id = Number(playerId);
      const row = rows().find((item) => item.playerId === id);
      const alive = (row?.pending ?? []).filter((pend) => Number(pend?.expiresAt) > now());
      return alive.length ? { code: formatBindCode(alive[0].code), expiresAt: Number(alive[0].expiresAt) } : null;
    },

    /**
     * **核销**(QQ 那条路调它)。成功之后这一份关系就成立:
     * `identity:bind:<playerId>` 里写 `{openid, displayName, boundAt}`。
     */
    redeem({ text, openid, displayName = null } = {}) {
      const who = String(openid ?? '').trim();
      if (!who) return { ok: false, error: 'no_openid' };
      // 只在**有口令待核销**的那几条里找(状态库很小,这里不做索引 —— 少一个会分叉的东西)
      // ⚠️ 这里读**原始行**(`rows()`),不是"已绑定的那些"(`all()`)——
      //    还没绑过的账号只有 pending、没有 openid,用 `all()` 会找不到它的口令(第一版就是这个 bug)。
      const candidates = [];
      for (const row of rows()) {
        for (const pend of row.pending) {
          candidates.push({ code: pend?.code, playerId: row.playerId, expiresAt: Number(pend?.expiresAt) });
        }
      }
      const verdict = redeemBindCode({ pending: candidates, text, now: now(), openid: who, displayName });
      if (!verdict.ok) return verdict;

      // ⚠️ 一对一:这个人以前绑过**别的**账号的话,把那一条**解掉**(否则两条都指向他)
      const previous = byOpenid(who);
      if (previous && previous.playerId !== verdict.playerId) {
        unbind(previous.playerId, { silent: true });
        log.info?.(`身份绑定：${who.slice(0, 8)}… 从账号 #${previous.playerId} 换到 #${verdict.playerId}`);
      }
      const key = bindMetaKey(verdict.playerId);
      const at = now();
      const before = (() => {
        try { return JSON.parse(String(store.getMeta(key) ?? '')) ?? {}; } catch { return {}; }
      })();
      try {
        store.setMeta(key, JSON.stringify({
          openid: who,
          displayName: verdict.displayName ?? null,
          playerName: before.playerName ?? null,
          boundAt: at,
          updatedAt: at,
          pending: [],
        }));
      } catch (err) {
        log.warn?.(`身份绑定：绑不上（这一枚口令还在）: ${err?.message ?? err}`);
        return { ok: false, error: 'store_failed' };
      }
      return { ok: true, playerId: verdict.playerId, openid: who, displayName: verdict.displayName ?? null };
    },

    /** 解绑(网页上点「解绑」或"换 QQ"时用)。 */
    unbind,
  };
}
