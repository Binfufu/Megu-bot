/**
 * **玩家在世界里的位置**(D 收尾 / 1.99.0 / D160)。
 *
 * ## 为什么要有它
 *
 * 到 1.98.0 为止,世界是"**她在动**"——「她此刻在公会」「正往家园走」都是事实,
 * 而**你在哪儿根本不存在**:页面上的「去XX」按钮说的是**让她**去(`move:<placeId>`,`why:'player'`)。
 * 共享小游戏那一半("我也有角色,能和她一起玩")最少要有这一件:**你也在某个地方**。
 *
 * ## 形状:一条事实,和她的那份**同构**
 *
 * ```
 *   world:her            ← 她的位置事实(1.92.0 起)
 *   world:player:<id>    ← 你的位置事实(这一版)
 * ```
 *
 * ⚠️ 三条刻意的口径:
 * ① **同构**:同一个 `whereaboutsFact()`(见 `world.js`)写出来 —— 于是"在途 / 到期 /
 *    已经在这儿"这些规矩对两个人**是同一套**,而不是各写一份(迟早分叉);
 * ② **默认在家园**:没有事实时按 `DEFAULT_PLACE` 算 —— 玩家第一次打开页面总得站在哪儿,
 *    而"家园"是这个世界里唯一属于你们两个人的地方(`docs\08` 的共享家园);
 * ③ ⚠️ **只认得出的人**:键是 `world:player:<playerId>`,而 `playerId` 来自登录身份 ——
 *    游客**没有位置**(不给匿名者编一个身份)。
 */
import { PLACES, placeById, routesFrom, whereaboutsFact } from './world.js';

/** 玩家位置事实的 meta 前缀。 */
export const PLAYER_WORLD_PREFIX = 'world:player:';

/** 没有事实时他站在哪(家园 —— 这个世界里唯一属于两个人的地方)。 */
export const DEFAULT_PLACE = 'home';

/** 这一条事实的 meta 键(认不出 id 就给 null)。
 * ⚠️ `world:player:` 这个前缀**天然落在** `panel.js` 的 `PANEL_META_PREFIXES` 里的 `world:`
 *    之下,所以装配层不用改就会把它读进来。 */
export function playerWorldKey(playerId) {
  const id = Number(playerId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return `${PLAYER_WORLD_PREFIX}${id}`;
}

/** 从一堆 meta 行里挑出某个玩家的那条(坏了/没有 → null)。 */
export function readPlayerFact(metas = [], playerId) {
  const key = playerWorldKey(playerId);
  if (!key) return null;
  const row = (metas ?? []).find((item) => String(item?.key) === key);
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row?.value ?? ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/** 所有玩家的位置事实(`{playerId, fact}` —— 给报表与"谁在这儿"用)。 */
export function allPlayerFacts(metas = []) {
  const out = [];
  for (const row of metas ?? []) {
    const key = String(row?.key ?? '');
    if (!key.startsWith(PLAYER_WORLD_PREFIX)) continue;
    const playerId = Number(key.slice(PLAYER_WORLD_PREFIX.length));
    if (!Number.isInteger(playerId) || playerId <= 0) continue;
    try {
      const parsed = JSON.parse(String(row?.value ?? ''));
      if (parsed && typeof parsed === 'object') out.push({ playerId, fact: parsed });
    } catch { /* 坏值跳过 —— 不猜 */ }
  }
  return out;
}

/**
 * **他现在在哪儿**(纯函数)。`traveling` 与"到点没到点"的规矩与 `herWhereabouts()` 同一套。
 *
 * @param {object} input
 * @param {object|null} [input.fact] `world:player:<id>` 那条事实
 * @param {number} [input.now]
 * @returns {{placeId:string, placeName:string, traveling:boolean, arriveAt:number|null,
 *   toName:string|null, since:number|null, known:boolean}}
 */
export function playerWhereabouts({ fact = null, now = Date.now() } = {}) {
  const at = Number(now) || Date.now();
  const arriveAt = Number.isFinite(Number(fact?.arriveAt)) ? Number(fact.arriveAt) : null;
  const isTravelFact = Boolean(fact?.to);
  const traveling = isTravelFact && arriveAt !== null && arriveAt > at;
  if (isTravelFact) {
    const to = placeById(fact?.to) ?? null;
    const from = placeById(fact?.place) ?? null;
    if (traveling) {
      return {
        placeId: from?.id ?? null,
        placeName: from?.name ?? null,
        traveling: true,
        arriveAt,
        toName: to?.name ?? fact?.toName ?? null,
        since: Number(fact?.since) || null,
        known: Boolean(from),
      };
    }
    // ⚠️⚠️ **到点了就当人在目的地**(D160):她的那条路有个 `travelTick` 到点收尾,
    //    而**玩家这条没有 tick** —— 不这么算的话,"走完那一趟"会永远显示出发地。
    //    (她那边也有同一形状的窗口:到点但 tick 还没落的 ≤1 拍;这里顺手把它一起收掉。)
    return {
      placeId: to?.id ?? null,
      placeName: to?.name ?? fact?.toName ?? null,
      traveling: false,
      arriveAt,
      toName: null,
      since: Number(fact?.since) || null,
      known: Boolean(to),
      arrived: true,
    };
  }
  const place = placeById(fact?.place) ?? null;
  if (place) {
    return {
      placeId: place.id, placeName: place.name, traveling: false,
      arriveAt: null, toName: null, since: Number(fact?.since) || null, known: true,
    };
  }
  // ⚠️ 没有事实 / 认不出 → **默认家园**(玩家第一次来总得站在哪儿);
  //    这**不是**"猜他在哪",而是"这个世界给新玩家的落点"。
  const fallback = placeById(DEFAULT_PLACE);
  return {
    placeId: fallback?.id ?? null, placeName: fallback?.name ?? null, traveling: false,
    arriveAt: null, toName: null, since: null, known: false,
  };
}

/** 他这一句人话(页面与提示词共用)。 */
export function describePlayerWhereabouts(where = {}) {
  if (!where) return '不知道他在哪';
  if (where.traveling) return `他正往${where.toName ?? '别处'}走`;
  return where.placeName ? `他在${where.placeName}` : '不知道他在哪';
}

/**
 * **他能去哪儿**(纯函数):去处表(`world.js` 的 `ROUTES`)已经是"世界长什么样"的唯一来源,
 * 这里只是把"从他现在这处出发"那几条取出来 —— **不另立一张表**。
 *
 * ⚠️ 在路上时**不给去处**(页面上的按钮该是灰的/没有):半路改道会让"到点"这件事没法收场。
 *
 * @returns {Array<{id:string, name:string, travelMs:number}>}
 */
export function playerRoutes({ where = null } = {}) {
  if (!where || where.traveling || !where.placeId) return [];
  return routesFrom(where.placeId).map((row) => ({
    id: row.id,
    name: placeById(row.id)?.name ?? row.id,
    travelMs: placeById(row.id)?.travelMs ?? 5 * 60_000,
  }));
}

/**
 * **他走一趟**(纯函数:给动作 + 他现在在哪 → 一条新事实;认不出给 null)。
 * ⚠️ 与她的那一套**同一个函数**(`whereaboutsFact`)—— 规矩不会分叉;
 *    `why` 固定写 `'player'`(是**他**在走,不是她),到达报备只认 `'self'`。
 */
export function playerMoveFact({ target = null, currentPlace = null, current = null, now = Date.now(), ttlMs } = {}) {
  return whereaboutsFact({
    kind: 'move.to',
    target,
    currentPlace,
    current,
    why: 'player',
    now,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}

/** 世界里有哪几处地方(页面给"去别处"那一排用;顺序照 `PLACES`)。 */
export function placeChoices() {
  return PLACES.map((row) => ({ id: row.id, name: row.name, travelMs: row.travelMs ?? 5 * 60_000 }));
}

/**
 * **建一份"玩家在世界里"的服务**(依赖注入;它不认识 HTTP,也不认识面板)。
 *
 * ⚠️ 两条口径:
 * ① **写之前先读**:`move` 与她的那条路一样,必须先看"他现在在哪 / 是不是在路上"
 *    (`whereaboutsFact` 自己会处理"在途不许被打断"与"已经在这儿不写假事实");
 * ② ⚠️ **同一处要看得出来**:`view` 会算 `withHer`(她此刻是不是也在这处)——
 *    那是"共享小游戏"最小的一眼:你到了公会,她在不在。
 */
export function createPlayerWorld({ store, now = () => Date.now(), log = console, herFact = null } = {}) {
  const readFact = (playerId) => {
    const key = playerWorldKey(playerId);
    if (!key) return null;
    try {
      const raw = store.getMeta(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      log.warn?.(`玩家位置：读不出来（当"没事实"处理）: ${err?.message ?? err}`);
      return null;
    }
  };

  /** 她此刻在哪(由装配层给 `herFact` 读取器 —— 面板那一层不该自己去查 `world:her`)。 */
  const herWhere = () => {
    try {
      return typeof herFact === 'function' ? (herFact() ?? null) : null;
    } catch { return null; }
  };

  const view = (playerId) => {
    const fact = readFact(playerId);
    const where = playerWhereabouts({ fact, now: now() });
    const hers = herWhere();
    // ⚠️ 只有"都没在路上、而且都在同一处"才算**同处**(半路的两个人不算碰上了)
    const withHer = Boolean(
      where.placeId && !where.traveling
      && hers?.placeId === where.placeId && !hers?.traveling,
    );
    return {
      where: {
        placeId: where.placeId,
        placeName: where.placeName,
        traveling: where.traveling,
        toName: where.toName,
        arriveAt: where.arriveAt,
      },
      line: describePlayerWhereabouts(where),
      routes: playerRoutes({ where }),
      withHer,
      herLine: hers ? (hers.traveling ? `她正往${hers.toName ?? '别处'}走` : hers.placeName ? `她在${hers.placeName}` : null) : null,
    };
  };

  return {
    view,
    readFact,

    /** **他走一趟**(写一条事实)。认不出目的地/已经在那儿/在路上 → 拒绝,而且**说清为什么**。 */
    move(playerId, target) {
      const key = playerWorldKey(playerId);
      if (!key) return { ok: false, error: 'no_player', note: '没认出你是谁。' };
      // ⚠️ **先判"这地方认不认得"**,再判"你能不能走" ——
      //    顺序反了的话,"在路上时去一个不存在的地方"会报 `already_traveling`,
      //    而那句话对提问的人是**答非所问**(复核口径:认不出的输入永远是同一个错)。
      const dest = placeById(target);
      if (!dest) return { ok: false, error: 'bad_place', note: '认不出那个地方。' };
      const before = readFact(playerId);
      const where = playerWhereabouts({ fact: before, now: now() });
      if (where.traveling) {
        return { ok: false, error: 'already_traveling', note: `你正往${where.toName ?? '别处'}走 —— 到了再说。` };
      }
      if (where.placeId === dest.id) {
        return { ok: false, error: 'already_there', note: `你已经在${where.placeName}了。` };
      }
      const fact = playerMoveFact({
        target,
        currentPlace: where.placeId,
        current: before,
        now: now(),
      });
      if (!fact) return { ok: false, error: 'cannot_move', note: '这一趟走不了。' };
      try {
        store.setMeta(key, JSON.stringify(fact));
      } catch (err) {
        log.warn?.(`玩家位置：没写下去: ${err?.message ?? err}`);
        return { ok: false, error: 'store_failed', note: '位置没存下来，再试一次。' };
      }
      const to = placeById(fact.to) ?? null;
      log.info?.(`玩家 #${playerId} 出门：往${to?.name ?? fact.to}走`);
      return { ok: true, fact };
    },
  };
}
