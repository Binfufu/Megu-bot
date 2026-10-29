/**
 * **积分账本**(1.115.0 / D203):网页聊天**按档限额,超出走积分**。
 *
 * ## 口径(用户 2026-10-12 拍板,对照 DZMM 的积分制)
 *
 * · **每人每天免费轮数按档分**:游客 **0**（2026-10-12 用户拍板:分享出去的票**只能看、
 *   不能说话** —— "门票外泄"的天然止损;真拦游客的那道闸在 `panel.js` 的聊天路由,
 *   回 `403 login_required`,**不是** 402 —— 游客没法充值,别把他往充值弹窗上引）。
 *   注册无码(readonly)**100**、带邀请码进来的(member)**200**。数字只有这里有
 *   (`FREE_QUOTA`),表里不存档位 —— 档位从账号派生
 *   (`player-account.js` 的 `tierFor`),能算的一律派生(D34)。
 *   ⚠️ `staff` 不限:那是站长的运营号,把自己锁在门外的事不干(他没说要限;要限改这里)。
 * · **只有她真的回了话才算一轮**:超时、沉默、跑失败都不算 —— 被闸门拦下的更不算。
 *   所以**先查闸门再跑一轮,她回了才记账**;两者之间并发达最多让"超出"晚一轮被拦,
 *   不会多扣钱(扣积分有条件 UPDATE 兜着,见 `spend`)。
 * · 超出免费额度后每轮扣 **1 积分**;积分只能由站长发(admin 后台 / account 脚本),
 *   充值入口先留着不接(等付款码)。
 * · **每个账号一本账,严禁串台**:代号 `subject` = `player:<id>` 或
 *   `guest:<指纹哈希前缀>`。游客没有账号,用**设备票 / 长票**的哈希做指纹 ——
 *   库里不存原始票(票会轮换,代号不能跟着换),哈希也不倒推。
 *
 * ## 与账单(idle-burn.js)的关系
 *
 * 那边算的是"**我们**花多少钱"(token 成本);这里算的是"**用户**还剩多少免费额度"。
 * (2026-10-23 充值退役转公益站:充值档位表 RECHARGE_PACKAGES 已删 —— 公益站无付费档位;
 *   定价的来龙去脉见 git 历史与 D203/D205,成本口径的纪律照旧往下管。)
 *
 * 📌 **主人 2026-10-15 定的方向(当时那两句"等付款码再最终拍"就此收口)**:
 *    「面向用户的定价先参考 DZMM 的做法,**赚取合适的利润**就行」+「以后价目表都要
 *      换算对标到 **¥** 再讨论价钱」。
 *   ⇒ ① **定价参考 DZMM、取合理利润**(不追求把成本压到极限再定价);
 *     ② **成本侧一律 ¥ 记账**(见 `usage-account.js` 的 ¥ 记账价目卡 +
 *     全局 skill `model-cost-accounting`:名义货币 ≠ 结算货币、峰谷按调用时刻派生);
 *     ③ 充值档位与每轮额度仍是**运营决策**,与"成本怎么算"是两件事 —— 成本口径由
 *     skill 管,定价数字由主人拍。
 *   ⚠️ 上面那个"一轮约 ¥0.003"是 2026-10-12 的旧锚点,而且是**按旧口径(只挂峰时、
 *      单一模型)**算的 ⇒ 换用新价目卡之后要**重新算一遍**再写进任何对外文案。
 *
 * ⚠️ 这个模块**不 import 任何东西**(纯逻辑 + 注入的依赖),SQL 的表在
 * `sqlite-store.js` 的 SCHEMA 里(唯一的建表入口),查询聚在这一层。
 */
import { createHash } from 'node:crypto';

/** 每天免费轮数,按档分(用户 2026-10-12 拍板;staff 不限 = 站长运营号)。 */
export const FREE_QUOTA = Object.freeze({
  /** ⚠️ 游客 0 = 根本不进账本闸(服务端在更早处就 403);留 0 让 `quotaForTier('nonsense')` 这类 fail closed 兜底也是 0。 */
  guest: 0,
  readonly: 100,
  member: 200,
  staff: Infinity,
});

// 充值档位表 RECHARGE_PACKAGES 与 packageForPrice 已于 2026-10-23 随「充值退役转公益站」删除
// (唯一的消费方是 pay 服务与 402 的档位附带;公益站不再有付费档位)。

/** 本地日(北京时间 +8;与 idle-burn.js 的小时口径同一条)。 */
export function creditDayKey(ms = Date.now()) {
  return new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 10);
}

/** 账号的账本代号(每账号一本账,严禁串台)。 */
export function subjectForPlayer(playerId) {
  const id = Number(playerId);
  return Number.isInteger(id) && id > 0 ? `player:${id}` : null;
}

/**
 * 游客的账本代号:设备票 / 长票的 **sha256 前 16 位十六进制**。
 * ⚠️ 收到的 key 必须是"这台设备稳定持有的那枚票";三样都没有时返回 null
 *    (那就没法记账 —— 闸门 fail closed,宁可不让他聊,也不能给他一本无法对账的账)。
 */
export function subjectForGuestKey(key) {
  const raw = String(key ?? '').trim();
  if (raw === '') return null;
  return `guest:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

/**
 * **这一轮算什么**(纯函数;闸门与记账共用这一份判据,不许写第二份 —— D159):
 *   · `free`   = 还在免费额度内(用了不扣积分);
 *   · `paid`   = 超出额度,但账上有积分(扣 1);
 *   · `blocked`= 超出额度且账上没积分(闸门拦下,附充值提示)。
 */
export function decideTurn({ used, quota, balance } = {}) {
  const usedToday = Math.max(0, Number(used) || 0);
  const limit = Number(quota);
  const credits = Math.max(0, Number(balance) || 0);
  // 垃圾输入不许放行(staff 的 Infinity 例外:那是不限量的正确形态)
  if (limit !== Number.POSITIVE_INFINITY && !Number.isFinite(limit)) return 'blocked';
  if (Number.isFinite(limit) && usedToday >= limit) return credits > 0 ? 'paid' : 'blocked';
  return 'free';
}

/** 档位 → 免费额度(未知档位当游客,不给多 —— fail closed)。 */
export function quotaForTier(tier) {
  return FREE_QUOTA[tier] ?? FREE_QUOTA.guest;
}

/**
 * **建一份积分账本**(依赖注入;不认识 HTTP、不认识账号 —— 那两样由调用方给)。
 *
 * @param {object} deps
 * @param {object} deps.store 状态库(要用 `store.handle` 的 prepare;表在 SCHEMA 里)
 * @param {() => number} [deps.now]
 * @param {object} [deps.log]
 */
export function createCredits({ store, now = () => Date.now(), log = console } = {}) {
  const db = store.handle;

  /** 今天用过几轮(没有行 = 0;⚠️ Number(undefined) 是 NaN,?? 兜不住 —— 别合并成一行)。 */
  function usedToday(subject, day = creditDayKey(now())) {
    const row = db.prepare('SELECT turns FROM credit_day WHERE subject = ? AND day = ?').get(subject, day);
    if (!row) return 0;
    return Number(row.turns) || 0;
  }

  /** 账上还有多少积分(credit_log 永不删,SUM 就是余额 —— 对账唯一来源)。 */
  function balanceOf(subject) {
    const row = db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM credit_log WHERE subject = ?').get(subject);
    return Number(row?.s) || 0;
  }

  /** 额度视图(页面与闸门共用):剩几轮免费、账上几积分。 */
  function view(subject, tier) {
    const quota = quotaForTier(tier);
    const used = usedToday(subject);
    const balance = balanceOf(subject);
    return {
      subject,
      tier,
      quota,
      used,
      freeLeft: Number.isFinite(quota) ? Math.max(0, quota - used) : null,
      balance,
      verdict: decideTurn({ used, quota, balance }),
    };
  }

  /** **闸门**(发轮之前查):blocked = 拒,并带充值提示要的一切。 */
  function gate(subject, tier) {
    const state = view(subject, tier);
    if (state.verdict !== 'blocked') return { ok: true, ...state };
    return {
      ok: false,
      ...state,
      reason: 'quota_exhausted',
      note: Number.isFinite(state.quota)
        ? `今天的免费额度（${state.quota} 轮）用完了，积分也花光了。`
        : '今天的免费额度用完了。',
    };
  }

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw err;
    }
  };

  /**
   * **记账**(她真的回了话之后调用):今天 +1 轮;**这一轮算不算免费要在自增之前判**
   * (第 10 轮本身是额度内的第 10 轮,不是"超出"——判完再 +1,别把当下这轮冤枉成 paid)。
   * 超出额度的那次**条件扣 1 积分**:先判再插、事务包住,并发下最多把最后 1 分花成 0,
   * 不会花成负数。
   * @returns {{ok: boolean, verdict?: string, balance?: number, used?: number, error?: string}}
   */
  function recordTurn(subject, tier) {
    if (!subject) return { ok: false, error: 'no_subject' };
    const at = now();
    const day = creditDayKey(at);
    return tx(() => {
      const usedBefore = usedToday(subject, day);
      const verdict = decideTurn({ used: usedBefore, quota: quotaForTier(tier), balance: balanceOf(subject) });
      db.prepare(`INSERT INTO credit_day (subject, day, turns, updated_at) VALUES (?, ?, 1, ?)
          ON CONFLICT (subject, day) DO UPDATE SET turns = turns + 1, updated_at = excluded.updated_at`)
        .run(subject, day, at);
      if (verdict === 'paid') {
        db.prepare('INSERT INTO credit_log (subject, delta, kind, note, at) VALUES (?, -1, ?, NULL, ?)')
          .run(subject, 'spend', at);
      }
      return { ok: true, verdict, balance: balanceOf(subject), used: usedBefore + 1 };
    });
  }

  /** **站长发积分**(admin 后台 / 充值到账 / account 脚本;delta 可负 = 冲正,但 kind 照实写)。 */
  function grant(subject, delta, { note = null, by = null } = {}) {
    const amount = Math.trunc(Number(delta) || 0);
    if (!subject) return { ok: false, error: 'no_subject' };
    if (amount === 0) return { ok: false, error: 'zero_delta' };
    const at = now();
    const info = db.prepare('INSERT INTO credit_log (subject, delta, kind, note, at) VALUES (?, ?, ?, ?, ?)')
      .run(subject, amount, amount > 0 ? 'grant' : 'refund', note ?? (by ? `by ${by}` : null), at);
    log.info?.(`积分：${subject} ${amount > 0 ? '+' : ''}${amount}${by ? `（${by}）` : ''}`);
    // ⚠️ 把流水 id 也带回去:充值单要 grant_id 指向它对账(credit_log 是唯一账本)。
    return { ok: true, balance: balanceOf(subject), logId: Number(info.lastInsertRowid) };
  }

  /** 最近几条流水(给 admin 后台对账用)。 */
  function recent(limit = 30) {
    return db.prepare('SELECT subject, delta, kind, note, at FROM credit_log ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Number(limit) || 30)));
  }

  /** 某个账号代号最近 N 天的用量(给 admin 后台看谁在重度使用)。 */
  function usageDays(subject, days = 7) {
    return db.prepare('SELECT day, turns FROM credit_day WHERE subject = ? ORDER BY day DESC LIMIT ?')
      .all(subject, Math.max(1, Math.min(60, Number(days) || 7)));
  }

  return { view, gate, recordTurn, grant, recent, usageDays, balanceOf, usedToday };
}
