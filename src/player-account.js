/**
 * **邀请码账号系统**(网页世界的"第 0 步";决策 D132)。
 *
 * ## 为什么账号要脱离 QQ
 *
 * 用户的判断(2026-10-04):换设备只要记得账号就行,不受平台限制。
 * 所以这里是**自己的账号密码**,存在**本机** `state.db`,和 QQ 的 openid 没有关系。
 *
 * ## 三条刻意的形状(照 `TODO.md` 的「网页世界」约定,别改)
 *
 * ① **密码绝不存明文**:`scrypt` + 每行一个随机盐,参数(alg/N/r/p)**跟着每一行存** ——
 *    将来调高 scrypt 成本时,老账号照样验得过,而不是"改个参数所有人登不进来"。
 * ② **注册要邀请码**:面板挂在公网,开放注册会被灌水。默认 **fail closed**
 *    (`openRegistration: false`)—— 没邀请码就是注册不了,而不是"忘了配就开放"。
 * ③ **判定全在本地纯函数**:这里不碰网络、不问 LLM(照「LLM 不当实时裁判」那条)。
 *
 * ## 与 D113 / D120 那两张票的关系
 *
 * D113 的**会话票**、D120 的**设备票**是"**进门**"的票(口令码/长 token → 能看世界);
 * 这里新加的**身份票**是"**你是谁**"的票(`playerId` → 能互动)。
 * 两张票**分工不合并**,这样:
 *   - 换口令码(`QQBOT_PANEL_CODE`)= 踢掉所有参观者,但**不**影响已注册玩家的账号;
 *   - 身份票的密钥是**库里一枚自成长的密钥**(见 `ACCOUNT_SECRET_META_KEY`),
 *     所以它不受口令码轮换影响 —— 而"踢某个人下线"改用 `session_epoch`。
 *
 * ⚠️ 身份票里带 `playerId` + `epoch` + 过期时刻,签名覆盖三者;改任何一项都对不上。
 *    退出登录 / 改密码 / 封禁都会让旧票失效(退出走内存黑名单,改密码走 epoch+1)。
 *
 * ⚠️ 表在 `src\sqlite-store.js` 的 `SCHEMA` 里(`CREATE TABLE IF NOT EXISTS` 是老库升级时
 *    自动补表的**唯一入口**);查询代码在这一层 —— 账号域聚在一个文件里,好测。
 */
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// --- 常量 -------------------------------------------------------------------

/**
 * `scrypt` 参数。**跟着每一行存**(见 SCHEMA 的 `params` 列),所以这里改了不会锁死老账号。
 *
 * N=16384 / r=8 / p=1 是 Node 文档的默认档,单次派生在本机约 50~80 ms ——
 * 对"人手输密码"够用,而**不是**为了让攻击者放弃(真要抗离线爆破得靠更长密码)。
 * `maxmem` 显式给大一点:`128 * N * r` = 16 MB,默认上限 32 MB 太贴边,参数一调就炸。
 */
export const SCRYPT_DEFAULTS = Object.freeze({ alg: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 });
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** 账号规则。**归一化在前、校验在后** —— 校验只看归一化后的值(别让"大写账号"绕过唯一性)。 */
export const ACCOUNT_MIN = 3;
export const ACCOUNT_MAX = 32;
export const ACCOUNT_RE = /^[a-z0-9][a-z0-9_.-]*$/;
export const NICKNAME_MAX = 24;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * 邀请码字母表:**去掉了 0/O、1/I/L 这些手输时必然搞混的字符**。
 * 邀请码是"在聊天里念、在手机上按"的东西 —— 形状要为这个服务,不是为随机数生成器。
 */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_LENGTH = 8;

/** 身份票(= "你是谁")。 */
export const PLAYER_COOKIE = 'hhauth';
export const PLAYER_HEADER = 'x-panel-player';
export const PLAYER_STORE_KEY = 'hhpanel.player';
export const PLAYER_TICKET_TTL_MS = 30 * 24 * 60 * 60_000;

/** 库里那枚"身份票密钥"的 meta 键(第一次用到时生成,之后长期不变)。 */
export const ACCOUNT_SECRET_META_KEY = 'accounts:secret';

/** 身份票的签名覆盖这四段(改任何一段都对不上)。 */
const TICKET_CONTEXT = 'panel-player';

// --- 归一化与校验(纯函数) -------------------------------------------------

/**
 * **账号归一化**(纯函数):小写、去首尾空白、去掉零宽字符与分隔噪声里的全角空格。
 *
 * ⚠️ 不做"猜"的事:不删中间的普通空格、不把 `0` 换成 `o`。**该拒的就拒**,
 *    否则"两个人以为是同一个账号"这种事故会藏在归一化里。
 */
export function normalizeAccount(raw) {
  return String(raw ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u3000]/g, ' ')
    .trim()
    .toLowerCase();
}

/** 账号能不能用;返回 null = 可以,否则是错误码。 */
export function accountProblem(account) {
  const value = normalizeAccount(account);
  if (value === '') return 'account_empty';
  if (value.length < ACCOUNT_MIN) return 'account_short';
  if (value.length > ACCOUNT_MAX) return 'account_long';
  if (!ACCOUNT_RE.test(value)) return 'account_charset';
  return null;
}

/** 昵称:可留空(留空就用账号当昵称)。只做"去空白 + 压掉连续空白"。 */
export function normalizeNickname(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

export function nicknameProblem(nickname, { account = '' } = {}) {
  const value = normalizeNickname(nickname) || normalizeAccount(account);
  if (value === '') return 'nickname_empty';
  if ([...value].length > NICKNAME_MAX) return 'nickname_long';
  return null;
}

/**
 * 密码强度(纯函数)。
 *
 * ⚠️ **刻意只做"最低门槛"**:长度 + 不是单一字符 + 不等于账号。
 *    复杂的"必须有大写/符号"规则在这里没有收益(用户是自己人,面板是本机世界),
 *    真正的防线是**邀请码**和**失败闸门**,不是逼人多打几个符号。
 */
export function passwordProblem(password, { account = '' } = {}) {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN) return 'password_short';
  if (value.length > PASSWORD_MAX) return 'password_long';
  if (/^(.)\1*$/.test(value)) return 'password_repeat';
  if (normalizeAccount(value) === normalizeAccount(account) && normalizeAccount(account) !== '') return 'password_is_account';
  if (/^\s|\s$/.test(value)) return 'password_ws';
  return null;
}

/** 密保答案归一化:大小写不敏感、压掉空白(答案是人手打的,不是密码)。 */
export function normalizeAnswer(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 邀请码归一化(纯函数):大写、去掉分隔符。
 *
 * ⚠️ 与口令码同一个思路(`normalizeCodeInput`):人念/人抄必然带噪声(`abcd-2345`、空格);
 *    但**不猜**——不做 `0→O` 这类替换,位数不对就是不对。
 */
export function normalizeInviteCode(raw) {
  return String(raw ?? '')
    .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** 打印用:`ABCD2345` → `ABCD-2345`(只是给人看的形状,库里存不带分隔符的)。 */
export function formatInviteCode(code) {
  const value = normalizeInviteCode(code);
  if (value.length !== INVITE_LENGTH) return value;
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

/** 生成一枚新邀请码(用 `crypto.randomInt`,不是 `Math.random` —— 后者可预测)。 */
export function generateInviteCode() {
  let out = '';
  for (let i = 0; i < INVITE_LENGTH; i += 1) out += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return out;
}

// --- 密码/答案的哈希 --------------------------------------------------------

/**
 * 生成一枚**临时密码**(D183 第三件:站长在后台重置某人的密码,把它念给他)。
 * ⚠️ 与邀请码**共用同一个字母表**(D159:别写第二份"避易混字符"的规则)——四段、每段四位。
 */
export function generateTempPassword() {
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let one = '';
    for (let i = 0; i < 4; i += 1) one += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
    groups.push(one);
  }
  return groups.join('-');
}

function paramsOf(params) {
  const merged = { ...SCRYPT_DEFAULTS, ...(params ?? {}) };
  return {
    alg: String(merged.alg ?? 'scrypt'),
    N: Number(merged.N) || SCRYPT_DEFAULTS.N,
    r: Number(merged.r) || SCRYPT_DEFAULTS.r,
    p: Number(merged.p) || SCRYPT_DEFAULTS.p,
    keylen: Number(merged.keylen) || SCRYPT_DEFAULTS.keylen,
  };
}

/** 派生一把密钥(异步:`scryptSync` 会把事件循环按住 50~80 ms,公网接口上那是可被利用的)。 */
async function derive(secret, { salt, params }) {
  const p = paramsOf(params);
  const buf = await scryptAsync(String(secret), Buffer.from(String(salt), 'hex'), p.keylen, {
    N: p.N, r: p.r, p: p.p, maxmem: SCRYPT_MAXMEM,
  });
  return buf.toString('hex');
}

/**
 * 把明文变成"盐 + 派生值 + 参数"(纯函数 + 一次 scrypt)。
 * ⚠️ **只返回这三个;明文本函数不留、不返回、不记日志。**
 */
export async function hashSecret(secret, { params = SCRYPT_DEFAULTS, salt = null } = {}) {
  const useSalt = salt ?? randomBytes(16).toString('hex');
  const useParams = paramsOf(params);
  const hash = await derive(secret, { salt: useSalt, params: useParams });
  return { salt: useSalt, hash, params: useParams };
}

/** 校验明文对不对(定时安全比较:逐字节提前返回会把哈希漏出去)。 */
export async function verifySecret(secret, { salt, hash, params }) {
  if (!salt || !hash) return false;
  const want = String(hash);
  let got = '';
  try {
    got = await derive(secret, { salt, params });
  } catch {
    return false;
  }
  if (got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'));
}

/** 参数是不是当前这套 —— 不是就顺手升级(登录成功后重算一次,密码不用改)。 */
export function paramsOutdated(params) {
  const p = paramsOf(params);
  return p.alg !== SCRYPT_DEFAULTS.alg || p.N !== SCRYPT_DEFAULTS.N || p.r !== SCRYPT_DEFAULTS.r
    || p.p !== SCRYPT_DEFAULTS.p || p.keylen !== SCRYPT_DEFAULTS.keylen;
}

// --- 身份票 -----------------------------------------------------------------

/**
 * **身份票**(自证、无状态):`<playerId>.<epoch>.<过期时刻>.<HMAC>`。
 *
 * ⚠️ 为什么不复用 `createSessionSigner`(D113):那张票**只签名过期时刻**,
 *    里面没有任何身份 —— 拿它当 `playerId` 用,就得在服务端另外存一张"票 → 谁"的表,
 *    那正是 D113 刻意躲开的东西(无状态才不用在内存里维持会话表)。
 * ⚠️ `epoch` 是"这个人当前这一代票"的编号:改密码/踢下线时 +1 → **旧票立刻全废**,
 *    而不用去维护任何黑名单(单张票的退出走 `panel.js` 的内存黑名单,和 D115 同一条路)。
 */
export function createPlayerSigner({ secret = '', ttlMs = PLAYER_TICKET_TTL_MS, now = () => Date.now() } = {}) {
  const key = createHash('sha256').update(`${TICKET_CONTEXT}:${secret}`).digest();
  const sign = (playerId, epoch, expiresAt) =>
    createHmac('sha256', key).update(`${playerId}.${epoch}.${expiresAt}`).digest('hex');

  return {
    ttlMs,
    mint(playerId, epoch) {
      const issuedAt = now();
      const expiresAt = issuedAt + ttlMs;
      const id = String(playerId);
      const generation = String(epoch);
      return `${id}.${generation}.${expiresAt}.${sign(id, generation, expiresAt)}`;
    },
    /** @returns {{ok: boolean, playerId?: number, epoch?: number, expiresAt?: number}} */
    verify(value) {
      const parts = String(value ?? '').split('.');
      if (parts.length !== 4) return { ok: false };
      const [rawId, rawEpoch, rawExpires, mac] = parts;
      const playerId = Number(rawId);
      const epoch = Number(rawEpoch);
      const expiresAt = Number(rawExpires);
      if (!Number.isInteger(playerId) || playerId <= 0) return { ok: false };
      if (!Number.isInteger(epoch) || epoch <= 0) return { ok: false };
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) return { ok: false };
      const want = sign(rawId, rawEpoch, rawExpires);
      if (mac.length !== want.length) return { ok: false };
      if (!timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(want, 'utf8'))) return { ok: false };
      return { ok: true, playerId, epoch, expiresAt };
    },
  };
}

// --- 给人看的话 -------------------------------------------------------------

/**
 * 错误码 → 人话。
 *
 * ⚠️ 两条刻意的:
 *   ① **登录失败只有一种说法**("账号或密码不对"):分开说"没这个账号"就是把用户名枚举出去;
 *   ② 找回密码失败也只有一种说法(同上)。
 */
export function describeAccountError(code) {
  switch (String(code ?? '')) {
    case 'account_empty': return '账号不能为空。';
    case 'account_short': return `账号至少要 ${ACCOUNT_MIN} 个字符。`;
    case 'account_long': return `账号最多 ${ACCOUNT_MAX} 个字符。`;
    case 'account_charset': return '账号只能用英文字母、数字和 . _ -(要以字母或数字开头)。';
    case 'account_taken': return '这个账号已经有人用了,换一个吧。';
    case 'account_reserved': return '这个账号名保留给站长，请换一个。';
    case 'nickname_empty': return '昵称不能为空。';
    case 'nickname_long': return `昵称最多 ${NICKNAME_MAX} 个字。`;
    case 'password_short': return `密码至少要 ${PASSWORD_MIN} 位。`;
    case 'password_long': return `密码最多 ${PASSWORD_MAX} 位。`;
    case 'password_repeat': return '密码不能是一个字重复到底。';
    case 'password_mismatch': return '两次输入的密码不一样。';
    case 'password_is_account': return '密码不能跟账号一样。';
    case 'password_ws': return '密码首尾不能是空白(容易在手输时被吃掉)。';
    case 'answer_missing': return '填了密保问题,就得填一个答案(否则将来找不回)。';
    case 'question_missing': return '填了密保答案,就得填一个问题。';
    case 'invite_required': return '注册需要一枚邀请码 —— 找操作者要。';
    // ⚠️ **不认 / 用过 / 过期 = 同一句话**(D208):分开说就等于告诉撞码的人"这枚码真的存在,
    //    只是用完了"。细分只留在内部错误码里(日志与单测看得见),人话只有这一句。
    case 'invite_unknown':
    case 'invite_used':
    case 'invite_expired':
    case 'invite_bad': return '这枚邀请码不认 —— 检查一下有没有抄错(分隔符可以省)，或者找操作者要一枚新的。';
    case 'bad_credentials': return '账号或密码不对。';
    case 'account_disabled': return '这个账号被停用了 —— 找操作者(本机管理员可以解)。';
    case 'recover_failed': return '账号或密保答案不对。';
    case 'recover_unavailable': return '这个账号没设密保问题 —— 只能找操作者在**本机**重置密码。';
    case 'locked': return '试错太多次,被暂时锁住了 —— 过一会儿再试。';
    case 'account_required': return '这一步要登录账号才能做(看世界不用登录,互动才要)。';
    case 'stale_form': return '这张页面放太久了(超过 10 分钟)。刷新一下再来。';
    case 'bad_origin': return '这次提交被安全闸门挡了(请求来源对不上)。回到本站重新打开一次。';
    case 'body_too_large': return '提交的内容太大了。';
    case 'unavailable': return '这台机器上没开账号系统。';
    default: return '没成功 —— 再试一次,或者找操作者。';
  }
}

/**
 * **对外的错误码收口**(D208):把"这枚码不认 / 已经用过 / 过期"合成**一个** `invite_bad`。
 *
 * 为什么要它:这三种码分开报,等于给撞码的脚本一个"猜中了但用完了"的信号(oracle)——
 * 攻击者据此就能确认某枚码**真的存在**。库里与日志里那一份细分照旧(`error` 字段不动),
 * 只有走到 HTTP 面之前收一次口。
 *
 * ⚠️ 只收邀请码这一类;登录、锁定、表单过期那些码原样放行(它们不泄露"码存不存在")。
 *
 * @param {string} code 内部错误码
 * @returns {string} 对外的错误码
 */
export function publicAccountError(code) {
  const value = String(code ?? '');
  if (value === 'invite_unknown' || value === 'invite_used' || value === 'invite_expired') return 'invite_bad';
  return value;
}

/** 数据库那行 → 能给前端看的形状。**哈希、盐、密保答案一律不出去**。 */
export function publicPlayer(row) {
  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    nickname: row.nickname,
    createdAt: row.created_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    hasQuestion: Boolean(row.question),
    disabled: Boolean(row.disabled),
  };
}

// --- 存储层(表在 sqlite-store.js 的 SCHEMA 里) ----------------------------

/**
 * 账号的读写。
 *
 * ⚠️ 为什么要一个 repo 而不是把方法加进 `SqliteStateStore`:
 *    账号这一块**自带事务语义**(邀请码扣次数 + 建账号必须一起成功),
 *    聚在一个文件里才看得清;而表结构仍然在 `sqlite-store.js`(唯一的建表入口)。
 */
/**
 * **账号分档**(D183 第二刀):`staff`(站长)/ `member`(带邀请码进来的)/ `readonly`(注册了但还没进内部)。
 *
 * ⚠️ 档位是**派生**的,**不新开一列**(D34:能算的一律派生):
 *   · 账号名在 `staff` 名单里 → `staff`(名单来自 `.env` 的 `QQBOT_ACCOUNTS_STAFF`);
 *   · `player.invite_code` 非空 → 这个人**是被人带进来的** → `member`;
 *   · 否则(开放注册自己进来的)→ `readonly`:**能看,不能动手**(用户 2026-10-11 的口径:
 *     「填了邀请码就进内部的网页,不填邀请码就是只读」)。
 *
 * ⚠️ 这是**服务端判据**;页面上的灰按钮只是提示(OWASP:每个请求都要验权、deny by default)。
 */
export function tierFor(row, { staff = [] } = {}) {
  if (!row) return 'guest';
  const wanted = (Array.isArray(staff) ? staff : [])
    .map((one) => String(one ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (wanted.includes(String(row.account ?? '').trim().toLowerCase())) return 'staff';
  return String(row.invite_code ?? '').trim() ? 'member' : 'readonly';
}

/** **能不能动手**(写路径的判据):`guest` 与 `readonly` 都不行。 */
export function mayInteract(tier) {
  return tier === 'member' || tier === 'staff';
}

export function createAccountRepo({ store, now = () => Date.now() }) {
  const db = store.handle;

  /** 一次事务(和 `SqliteStateStore` 的私有 `#transaction` 同形,但作用域在这一层)。 */
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  /**
   * 身份票的密钥:**库里一枚自成长的随机值**。
   *
   * ⚠️ 为什么不用口令码当密钥(那是 D113/D120 的做法):口令码是"踢掉所有人"的开关,
   *    换一次就所有人重登 —— 而**账号的登录不该被参观码的轮换牵连**。
   * ⚠️ 这枚密钥丢了 = 所有身份票失效(玩家要重新登录账号),但不影响密码,也不影响参观。
   */
  const secret = () => {
    const existing = store.getMeta(ACCOUNT_SECRET_META_KEY);
    if (existing && String(existing).length >= 32) return String(existing);
    const fresh = randomBytes(32).toString('hex');
    store.setMeta(ACCOUNT_SECRET_META_KEY, fresh);
    return fresh;
  };

  return {
    secret,
    db,

    // —— 邀请码 ——
    /**
     * 发一枚码。
     * ⚠️ 2026-10-14(D229):`room` 参数已删除 —— 它原来是"这枚码把人带进哪间网页群聊房"
     *    (1.112.0 / D200),而那一栏整条链路下线了。库里 `invite.room` 列留着不动(见下)。
     */
    insertInvite({ code, note = null, createdBy = null, maxUses = 1, expiresAt = null }) {
      db.prepare(
        `INSERT INTO invite (code, note, created_at, created_by, max_uses, uses, expires_at, room)
         VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`,
      ).run(normalizeInviteCode(code), note, now(), createdBy, 1, expiresAt);
      return this.getInvite(code);
    },
    getInvite(code) {
      return db.prepare('SELECT * FROM invite WHERE code = ?').get(normalizeInviteCode(code)) ?? null;
    },
    listInvites(limit = 100) {
      return db.prepare('SELECT * FROM invite ORDER BY created_at DESC LIMIT ?').all(Math.max(1, limit));
    },
    /**
     * 扣一次使用次数。**带条件的 UPDATE**:`uses < max_uses` 与过期判断都在 SQL 里 ——
     * 这样"两个人同时拿同一枚码注册"不会两个都过(读-改-写中间那一步没有窗口)。
     */
    consumeInvite({ code, playerId = null }) {
      const result = db
        .prepare(
          `UPDATE invite SET uses = uses + 1, last_used_at = ?, last_used_by = ?
           WHERE code = ? AND uses = 0 AND max_uses >= 1 AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .run(now(), playerId, normalizeInviteCode(code), now());
      return result.changes === 1;
    },
    /** 邀请码能不能用(只读预检;真正的判据在 `consumeInvite` 那条 SQL 里)。 */
    inviteProblem(code) {
      const row = this.getInvite(code);
      if (!row) return 'invite_unknown';
      if (row.expires_at && Number(row.expires_at) <= now()) return 'invite_expired';
      if (Number(row.uses) >= 1 || Number(row.max_uses) < 1) return 'invite_used';
      return null;
    },
    // ⚠️ **`listRooms()` 与 `roomAssignments()` 已删除**(2026-10-14 / D229):它们派生
    //    "哪枚码把人带进哪间网页群聊房"(1.112.0 / D200),而那一栏整条链路下线了。
    //    ⚠️ 库里 `invite.room` 这个**列还在**(留着不动 —— 改列要重建表,风险不值当),
    //       只是**没有任何代码读写它**;老值可从 `D:\废弃仓库` 的备份里查。

    // —— 玩家 ——
    insertPlayer({ account, nickname, salt, hash, params, question = null, answerSalt = null, answerHash = null, answerParams = null, email = null, inviteCode = null }) {
      const info = db
        .prepare(
          `INSERT INTO player (account, nickname, salt, hash, params, question, answer_salt, answer_hash, answer_params, email,
                               session_epoch, created_at, last_login_at, invite_code, disabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, 0)`,
        )
        .run(
          normalizeAccount(account),
          nickname,
          salt,
          hash,
          JSON.stringify(paramsOf(params)),
          question,
          answerSalt,
          answerHash,
          answerParams ? JSON.stringify(paramsOf(answerParams)) : null,
          email,
          now(),
          inviteCode,
        );
      return this.getPlayer(Number(info.lastInsertRowid));
    },
    getPlayer(id) {
      return db.prepare('SELECT * FROM player WHERE id = ?').get(Number(id)) ?? null;
    },
    findPlayerByAccount(account) {
      return db.prepare('SELECT * FROM player WHERE account = ?').get(normalizeAccount(account)) ?? null;
    },
    listPlayers(limit = 100) {
      return db.prepare('SELECT * FROM player ORDER BY created_at DESC LIMIT ?').all(Math.max(1, limit));
    },
    countPlayers() {
      return db.prepare('SELECT COUNT(*) AS n FROM player').get().n;
    },
    countInvites() {
      return db.prepare('SELECT COUNT(*) AS n FROM invite').get().n;
    },
    /** 记一次成功登录(只更新这一列,不动 epoch)。 */
    markLogin(id) {
      db.prepare('UPDATE player SET last_login_at = ? WHERE id = ?').run(now(), Number(id));
    },
    /**
     * 换密码(或"顺手升级 scrypt 参数")。
     * `bumpEpoch` 默认 true:**改密码 = 把别的设备全踢下线**(那是用户对"改密码"的预期)。
     */
    setPassword(id, { salt, hash, params }, { bumpEpoch = true } = {}) {
      db.prepare(
        `UPDATE player SET salt = ?, hash = ?, params = ?${bumpEpoch ? ', session_epoch = session_epoch + 1' : ''}
         WHERE id = ?`,
      ).run(salt, hash, JSON.stringify(paramsOf(params)), Number(id));
      return this.getPlayer(id);
    },
    /** 密保问题(注册时可留空;后来也能补设)。 */
    setQuestion(id, { question, answerSalt, answerHash, answerParams = null }) {
      db.prepare('UPDATE player SET question = ?, answer_salt = ?, answer_hash = ?, answer_params = ? WHERE id = ?')
        .run(question, answerSalt, answerHash, answerParams ? JSON.stringify(paramsOf(answerParams)) : null, Number(id));
      return this.getPlayer(id);
    },
    /** 邀请码记下"最后是谁用的"(建号时 player.id 才知道,所以这一步只能在插入之后)。 */
    attachInviteUser(code, playerId) {
      db.prepare('UPDATE invite SET last_used_by = ? WHERE code = ?').run(Number(playerId), normalizeInviteCode(code));
      return this.getInvite(code);
    },
    /**
     * **把一枚邀请码记到已有账号上**(D183 第二刀:只读 → 内部)。
     * ⚠️ 它是"兑换"那一步的落盘动作;扣次数是另一条带条件的 UPDATE(`consumeInvite`)。
     */
    setInviteCode(playerId, code) {
      db.prepare('UPDATE player SET invite_code = ? WHERE id = ?').run(normalizeInviteCode(code), Number(playerId));
      return this.getPlayer(playerId);
    },

    // —— 邀请申请("向站长要一枚码"的队列;D183 第二刀)——
    insertAccessRequest({ account = null, nickname = null, contact, note = null }) {
      const info = db.prepare(
        `INSERT INTO access_request (account, nickname, contact, note, at, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      ).run(account, nickname, contact, note, now());
      return this.getAccessRequest(Number(info.lastInsertRowid));
    },
    getAccessRequest(id) {
      return db.prepare('SELECT * FROM access_request WHERE id = ?').get(Number(id)) ?? null;
    },
    listAccessRequests({ status = 'pending', limit = 50 } = {}) {
      // status = null → 不按状态过滤,按时间倒序取最近(D250 反馈收件箱:"未处理的在前"
      // 由调用方把 pending 的状态列加粗实现,查询保持一份简单口径)。
      if (status == null) {
        return db.prepare('SELECT * FROM access_request ORDER BY at DESC LIMIT ?').all(Math.max(1, limit));
      }
      return db.prepare('SELECT * FROM access_request WHERE status = ? ORDER BY at DESC LIMIT ?')
        .all(String(status), Math.max(1, limit));
    },
    countPendingRequests() {
      return db.prepare("SELECT COUNT(*) AS n FROM access_request WHERE status = 'pending'").get().n;
    },
    setAccessRequestStatus(id, status, handledBy = null) {
      db.prepare('UPDATE access_request SET status = ?, handled_at = ?, handled_by = ? WHERE id = ?')
        .run(String(status), now(), handledBy, Number(id));
      return this.getAccessRequest(id);
    },
    /** 踢下线(所有设备):epoch +1,旧身份票立刻作废。 */
    bumpEpoch(id) {
      db.prepare('UPDATE player SET session_epoch = session_epoch + 1 WHERE id = ?').run(Number(id));
      return this.getPlayer(id);
    },
    setDisabled(id, disabled) {
      db.prepare('UPDATE player SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, Number(id));
      return this.getPlayer(id);
    },
    tx,
  };
}

// --- 服务层(把上面几块拼成"注册 / 登录 / 找回") --------------------------

/**
 * 一次 scrypt 大约几十毫秒 —— 用它当"账号不存在"时的**等时填充**,
 * 否则"回得快 = 这个账号不存在"本身就是一个枚举接口。
 */
const DUMMY = { salt: '00'.repeat(16), hash: '00'.repeat(64), params: SCRYPT_DEFAULTS };

/**
 * @param {object} options
 * @param {import('./sqlite-store.js').SqliteStateStore} options.store
 * @param {boolean} [options.openRegistration] 不带邀请码也能注册(默认 **false**,fail closed)
 * @param {(msg: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createAccountService({ store, openRegistration = false, staff = [], log = () => {}, now = () => Date.now() } = {}) {
  const repo = createAccountRepo({ store, now });
  const signer = createPlayerSigner({ secret: repo.secret(), now });
  const registry = { openRegistration: Boolean(openRegistration) };

  /** 登录/找回/注册共用的失败文案:只有一种说法,不告诉对方"哪一半错了"。 */
  const fail = (error, extra = {}) => ({ ok: false, error, note: describeAccountError(error), ...extra });

  const service = {
    repo,
    signer,
    registry,
    /** 站长账号名清单(1.112.0 / D200:群组名单里"哪几个账号在哪间房都在")。 */
    staffNames: (Array.isArray(staff) ? staff : []).map((one) => String(one ?? '').trim().toLowerCase()).filter(Boolean),

    /**
     * 注册。**要邀请码**(除非 `openRegistration`)。
     *
     * ⚠️ 顺序是刻意的:先把"形状"全验掉(不碰库),再扣邀请码 + 建账号(**一个事务**)——
     *    中间任何一步失败,邀请码不会被白白用掉。
     */
    async register({ account, password, nickname = '', invite = '', question = '', answer = '', email = '' } = {}) {
      const accountText = normalizeAccount(account);
      const problem = accountProblem(accountText)
        ?? nicknameProblem(nickname, { account: accountText });
      if (problem) return fail(problem);
      const pwProblem = passwordProblem(password, { account: accountText });
      if (pwProblem) return fail(pwProblem);

      const inviteCode = normalizeInviteCode(invite);
      // 开放注册只豁免“不填码”，提交的码仍须验证并在事务里扣次数。
      if (!registry.openRegistration && inviteCode === '') return fail('invite_required');
      if (inviteCode !== '') {
        const inviteProblem = repo.inviteProblem(inviteCode);
        if (inviteProblem) return fail(inviteProblem);
      }

      const questionText = normalizeNickname(question);
      const answerText = normalizeAnswer(answer);
      // ⚠️ 问题与答案**必须成对**:只填一个 = 用户以为设了密保,实际找不回 —— 宁可当场拒。
      if (questionText !== '' && answerText === '') return fail('answer_missing');
      if (questionText === '' && answerText !== '') return fail('question_missing');

      if (repo.findPlayerByAccount(accountText)) return fail('account_taken');

      const main = await hashSecret(password);
      const secretAnswer = questionText !== '' ? await hashSecret(answerText) : null;
      const fixedNickname = normalizeNickname(nickname) || accountText;

      let row;
      try {
        row = repo.tx(() => {
          // ① 扣邀请码(带条件的 UPDATE:并发下只有一个能扣到)
          if (inviteCode !== '') {
            const consumed = repo.consumeInvite({ code: inviteCode, playerId: null });
            if (!consumed) {
              // 事务里抛出去 → 一起回滚;外面按错误码翻译
              const err = new Error('invite_conflict');
              err.code = repo.inviteProblem(inviteCode) ?? 'invite_used';
              throw err;
            }
          }
          // ② 建账号
          const created = repo.insertPlayer({
            account: accountText,
            nickname: fixedNickname,
            salt: main.salt,
            hash: main.hash,
            params: main.params,
            question: questionText || null,
            answerSalt: secretAnswer?.salt ?? null,
            answerHash: secretAnswer?.hash ?? null,
            answerParams: secretAnswer?.params ?? null,
            email: normalizeNickname(email) || null,
            inviteCode: inviteCode || null,
          });
          // ③ 邀请码记下"带进来的是谁"(审计;id 要到上一句才知道)
          if (inviteCode !== '') repo.attachInviteUser(inviteCode, created.id);
          return created;
        });
      } catch (err) {
        if (err?.code && String(err.code).startsWith('invite_')) return fail(err.code);
        // 唯一索引撞了(并发注册同一个账号)→ 说"有人用了",不是 500
        if (/UNIQUE constraint failed/i.test(String(err?.message ?? ''))) return fail('account_taken');
        throw err;
      }
      log(`账号：注册成功（${row.account}，邀请码 ${inviteCode || '（开放注册）'}）`);
      return { ok: true, player: publicPlayer(row), ticket: signer.mint(row.id, row.session_epoch), epoch: row.session_epoch };
    },

    /** 登录。成功时顺手把 scrypt 参数升级到当前档(`bumpEpoch: false` —— 那不是"改密码")。 */
    async login({ account, password } = {}) {
      const row = repo.findPlayerByAccount(account);
      if (!row) {
        await verifySecret(password ?? '', DUMMY);   // 等时填充
        return fail('bad_credentials');
      }
      if (row.disabled) return fail('account_disabled');
      const ok = await verifySecret(password ?? '', { salt: row.salt, hash: row.hash, params: parseParams(row.params) });
      if (!ok) return fail('bad_credentials');
      let current = row;
      if (paramsOutdated(parseParams(row.params))) {
        const upgraded = await hashSecret(password);
        current = repo.setPassword(row.id, upgraded, { bumpEpoch: false });
        log(`账号：${row.account} 的密码哈希已按新参数重算（密码没变，登得进去）`);
      }
      repo.markLogin(current.id);
      const fresh = repo.getPlayer(current.id);
      log(`账号：登录成功（${fresh.account}）`);
      return { ok: true, player: publicPlayer(fresh), ticket: signer.mint(fresh.id, fresh.session_epoch), epoch: fresh.session_epoch };
    },

    /**
     * 找回密码(密保问题)。成功后 **epoch +1**:别的设备上的旧票立刻作废。
     * ⚠️ 没有设密保问题的账号**走不了这条路** —— 最后一根稻草是本机管理员重置
     *    (`scripts\account.js reset-password`),这条要写进帮助页(TODO 已定)。
     */
    async recover({ account, answer, newPassword } = {}) {
      const row = repo.findPlayerByAccount(account);
      if (!row || !row.question || !row.answer_hash) {
        await verifySecret(answer ?? '', DUMMY);
        return fail('recover_failed');
      }
      const ok = await verifySecret(normalizeAnswer(answer), {
        salt: row.answer_salt,
        hash: row.answer_hash,
        params: parseParams(row.answer_params),
      });
      if (!ok) return fail('recover_failed');
      const pwProblem = passwordProblem(newPassword, { account: row.account });
      if (pwProblem) return fail(pwProblem);
      const hashed = await hashSecret(newPassword);
      const after = repo.setPassword(row.id, hashed, { bumpEpoch: true });
      log(`账号：${row.account} 用密保问题找回了密码（其余设备已下线）`);
      return { ok: true, player: publicPlayer(after), ticket: signer.mint(after.id, after.session_epoch), epoch: after.session_epoch };
    },

    /**
     * 校验一枚身份票 → 玩家行。
     * 同步(不派生哈希),但**每一步都要过**:签名 → 没过期 → 这个人还在 → epoch 还是那一代。
     */
    verifyTicket(value) {
      const check = signer.verify(value);
      if (!check.ok) return { ok: false, error: 'bad_ticket' };
      const row = repo.getPlayer(check.playerId);
      if (!row) return { ok: false, error: 'unknown_player' };
      if (row.disabled) return { ok: false, error: 'account_disabled' };
      if (Number(row.session_epoch) !== Number(check.epoch)) return { ok: false, error: 'stale_ticket' };
      return { ok: true, player: publicPlayer(row), expiresAt: check.expiresAt };
    },

    countPlayers: () => repo.countPlayers(),
    countInvites: () => repo.countInvites(),
    /** 这个账号算哪一档(D183 第二刀)—— 面板用它决定"能不能看到关于别人的事 / 能不能动手"。 */
    tierOf(playerId) {
      const row = repo.getPlayer(Number(playerId));
      return row ? tierFor(row, { staff }) : 'guest';
    },

    /**
     * **兑换一枚邀请码**(D183 第二刀):把"只读"的账号升级成"内部"。
     *
     * ⚠️ 与注册那条路**共用同一套邀请码语义**(单次使用 / 过期 / 并发安全扣减,都在 `repo.tx` 里
     *    一起成事)—— 不许写第二份(D159)。重复兑换不消耗码:已经在内部就直接告诉他。
     */
    redeem({ playerId, invite = '' } = {}) {
      const row = repo.getPlayer(Number(playerId));
      if (!row) return fail('unknown_player');
      if (row.disabled) return fail('account_disabled');
      if (tierFor(row, { staff }) !== 'readonly') {
        return { ok: false, error: 'already_inside', note: '你已经在内部了 —— 这枚码留给下一个人吧。' };
      }
      const code = normalizeInviteCode(invite);
      if (code === '') return fail('invite_required');
      const problem = repo.inviteProblem(code);
      if (problem) return fail(problem);
      let fresh;
      try {
        fresh = repo.tx(() => {
          const consumed = repo.consumeInvite({ code, playerId: row.id });
          if (!consumed) {
            const err = new Error('invite_conflict');
            err.code = repo.inviteProblem(code) ?? 'invite_used';
            throw err;
          }
          const after = repo.setInviteCode(row.id, code);
          repo.attachInviteUser(code, row.id);
          return after;
        });
      } catch (err) {
        if (err?.code && String(err.code).startsWith('invite_')) return fail(err.code);
        throw err;
      }
      log(`账号：${fresh.account} 兑换邀请码升级成内部（${code}）`);
      return { ok: true, player: publicPlayer(fresh), tier: tierFor(fresh, { staff }) };
    },

    /**
     * 收到一条"**想要邀请码**"的申请(D183 第二刀)。
     *
     * ⚠️ **只入库,绝不自动通过**(调研里 Slack 那条:申请 → 人工批准)——
     *    面板挂在公网,"自动通过"等于自动把内部权限发给陌生人。
     *    站长在后台处理 + 惠惠在 QQ 里提醒(见 TODO 的第三件)。
     *
     * **2026-10-18 / D250 语义改为「信息反馈」**(用户拍板:/request 申请入口退役):
     *    note(想说的话)**必填** ≤500 字【暂定】;contact 降为可选 ≤64(反馈可以匿名,
     *    留了联系方式站长才找得回去);灌水闸门在 panel.js 那一侧(按访客计次)。
     */
    requestAccess({ account = '', nickname = '', contact = '', note = '' } = {}) {
      const body = String(note ?? '').trim();
      if (body === '') {
        return { ok: false, error: 'note_required', note: '想说的话不能空 —— 写一句再提交。' };
      }
      if (body.length > 500) return { ok: false, error: 'note_too_long', note: '想说的话太长了（500 字以内）。' };
      const touch = String(contact ?? '').trim();
      if (touch.length > 64) return { ok: false, error: 'contact_too_long', note: '联系方式太长了（64 字以内）。' };
      const row = repo.insertAccessRequest({
        account: String(account ?? '').trim().slice(0, 32) || null,
        nickname: String(nickname ?? '').trim().slice(0, 24) || null,
        // ⚠️ 表 schema 里 contact 是 NOT NULL(老口径)—— 匿名反馈存**空串**,不做迁移。
        contact: touch,
        note: body,
      });
      log(`账号：收到一条反馈（#${row.id}，联系方式 ${touch || '(没留)'}）`);
      return { ok: true, id: row.id, request: row };
    },
    /** **站长的收件箱**(第三件会用:面板后台 + 惠惠在 QQ 里提醒)。 */
    listRequests: (opts) => repo.listAccessRequests(opts),
    countPendingRequests: () => repo.countPendingRequests(),
    setRequestStatus: (id, status, by = null) => repo.setAccessRequestStatus(id, status, by),

    /**
     * **发一枚邀请码**(D183 第三件):站长在面板后台点一下就有,不用再去机器上跑脚本。
     * ⚠️ 生成时避开易混字符(`generateInviteCode`);撞码就重试 —— 那是这条路上唯一可能失败的地方。
     */
    mintInvite({ note = null, createdBy = 'panel', maxUses = 1, expiresAt = null } = {}) {
      for (let i = 0; i < 5; i += 1) {
        const code = generateInviteCode();
        if (repo.getInvite(code)) continue;
        const row = repo.insertInvite({ code, note, createdBy, maxUses, expiresAt });
        log(`账号：发了一枚邀请码（${formatInviteCode(code)}${note ? `，备注 ${note}` : ''}）`);
        return { ok: true, invite: row, display: formatInviteCode(row.code) };
      }
      return { ok: false, error: 'invite_gen_failed', note: '连着撞了 5 次码,再点一次。' };
    },
    listInvites: (limit = 20) => repo.listInvites(limit).map((row) => ({
      ...row, display: formatInviteCode(row.code),
    })),

    /**
     * 找回流程第一步(2026-10-19 / D271):按账号读出**密保问题文本**。
     * 问题不是秘密(注册时本来就要人看得见),答案才是;页面在填账号前不知道该显示谁的,
     * 所以给一个按账号读的口子。没这个账号 / 没设问题 → 一律 null,
     * 调用方给**同一句**说法(**不区分**两种情况 —— 与 D208 的口径同族)。
     */
    questionFor(account) {
      const row = repo.findPlayerByAccount(account);
      return row?.question ? String(row.question) : null;
    },

    /**
     * **重置某人的密码**(D183 第三件):生成一枚**临时密码**给他,并把 `session_epoch` +1 ——
     * **旧身份票立刻全废**(这正是"Steam 式:管理员给你一枚码"那条路,调研里 NIST 也认它是
     * "没有邮件服务时唯一稳的找回方式")。
     *
     * ⚠️ 这是**能顶掉一个人账号**的操作:所以只有 `staff` 能调,而且面板那一层**另加了一道**(nonce + 档位)。
     */
    async resetPassword({ account = '' } = {}) {
      const row = repo.findPlayerByAccount(account);
      if (!row) return { ok: false, error: 'unknown_player', note: '没有这个账号。' };
      const tempPassword = generateTempPassword();
      const hashed = await hashSecret(tempPassword);
      repo.setPassword(row.id, hashed, { bumpEpoch: true });
      log(`账号：重置了 ${row.account} 的密码（旧身份票已作废）`);
      return { ok: true, account: row.account, tempPassword };
    },

    listPlayers: (limit) => repo.listPlayers(limit).map(publicPlayer),
    listInvites: (limit) => repo.listInvites(limit),
  };

  return service;
}

/** 库里的 `params` 列是 JSON 文本;坏了就当默认档(不让一行坏数据把登录路径炸掉)。 */
function parseParams(raw) {
  try {
    return raw ? { ...SCRYPT_DEFAULTS, ...JSON.parse(raw) } : SCRYPT_DEFAULTS;
  } catch {
    return SCRYPT_DEFAULTS;
  }
}
