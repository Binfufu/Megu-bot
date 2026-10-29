import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/**
 * **世界与场所**(网页世界的骨架;用户 2026-10-05 拍板的新顺序见 `docs\03` D136)。
 *
 * ## 这一层是干什么的
 *
 * D136 定的顺序是:**角色 + 世界后台自动运行 → 页面先做出世界的场景 → 再做角色互动 → 最后美术**。
 * 这个模块是"场景"那一层的**骨架**:世界有哪些**场所**、她**此刻在哪个场所**、每个场所
 * 现在**有什么事**、她**正在往哪儿走**——全部是**纯函数**,不认识 HTTP、不碰库、不问模型。
 *
 * ## 三条刻意的形状
 *
 * ① **场所表写在代码里**(和 `FISHING_SPOTS` 同一条规矩):它是**设定**,不是玩家数据 ——
 *    落库只会多出一份会腐烂的副本。库里存的只有"**她此刻在哪 / 在做什么**"这种**事实**。
 * ② ⚠️ **"她在哪"是派生事实,能不存就不存**:现在的来源有三个
 *    ——`meta['world:her']`(她自己活动/场所互动写的那条)、**已有的账**
 *    (钓鱼状态就是"她在钓鱼场所"的证明)、以及**在途**(`from@since → to@arriveAt`,
 *    出发时就写进同一条事实里)。**推不出来就说不知道**,不许拿"家园"当默认值猜。
 * ③ ⚠️ **一个写者一次写**:位置事实**只有 `world:her` 这一个键**,在途状态也长在它上面 ——
 *    不新开 meta,于是不存在"布局写了、账本没写"那种半写风险(D143 那条纪律)。
 *
 * ## 📌 1.92.0:世界里有了"时间"(A 那一刀)
 *
 * 用户 2026-10-07:「先把世界系统做好」。要做的第一件事是**她真的在动**:
 *   · **所有**场所互动都写位置事实(钓鱼 / 接委托 / 摆放 / 移动,不再只有"她自己吃饭");
 *   · **场所间移动**带**旅行时间**(`travelMs`):她在路上时页面/QQ/聊天都说"正往公会走",
 *     到了那一刻自动落地成"她在公会" —— 这就是世界里第一条"**等一会儿会变**"的感觉;
 *   · 她自己的活动从 5 条扩到十几条 —— 否则轮换几下就被看穿。
 *
 * ## 数据形状(给页面 / QQ 报幕共用)
 *
 * ```
 * {
 *   her: { placeId, placeName, doing, since, elapsedMs, source, from, arriveAt, etaMs, traveling },
 *   places: [{ id, name, kind, blurb, here, summary, facts: [{k, v}] }],
 * }
 * ```
 */
import { phaseLabel } from './play/index.js';
import { FURNITURE } from './home.js';

/** 位置事实的 meta 键(**唯一**的那一个 —— 在途状态也长在它上面)。 */
export const WORLD_HER_KEY = 'world:her';

/**
 * **场所表**。`kind` 决定它在页面上怎么被聚合展示(将来也决定"能在这儿干什么")。
 *
 * ⚠️ 只放**现在这一层用得上的**场所:多写几个名字但页面上什么都没有,就是"功能很多的项目"
 *    那一步(D100 的教训:量不出来就砍)。`market` 是 1.85.0 加的 ——
 *    因为"她自己逛街"那条活动**真的会去那儿**,不给它一个场所,页面就只能说"不知道她在哪";
 *    它暂时只有一句说明可显示(等场所里的互动做起来才有事实)。
 * ⚠️ `travelMs` = **从任意场所走到这儿要多久**(1.92.0 加)。场所是全连通的
 *    (docs\08 3.4 的口径:places 全连通 + 固定 travelMs),所以"路程"按**目的地**算一份就够 ——
 *    不必维护一张 5×5 的距离表(那是"抄第二份"的经典形状)。
 */
export const PLACES = Object.freeze(LOCAL_STORY_WORLD?.places ?? [
  {
    "id": "home",
    "name": "住所",
    "kind": "home",
    "travelMs": 180000,
    "blurb": "示例世界的住所。"
  },
  {
    "id": "fishing",
    "name": "垂钓区",
    "kind": "activity",
    "travelMs": 360000,
    "blurb": "示例世界的垂钓区。"
  },
  {
    "id": "guild",
    "name": "任务中心",
    "kind": "hub",
    "travelMs": 300000,
    "blurb": "示例世界的任务中心。"
  },
  {
    "id": "canteen",
    "name": "餐厅",
    "kind": "food",
    "travelMs": 300000,
    "blurb": "示例世界的餐厅。"
  },
  {
    "id": "market",
    "name": "交易区",
    "kind": "street",
    "travelMs": 420000,
    "blurb": "示例世界的交易区。"
  },
  {
    "id": "gallery",
    "name": "图片展区",
    "kind": "gallery",
    "travelMs": 240000,
    "blurb": "示例世界的图片展区。"
  }
]);
const WORLD_TEXT = LOCAL_STORY_WORLD?.worldText ?? {
  currency: '货币', questAcceptPrefix: '在任务中心接下了「', questAcceptSuffix: '」', questAcceptPlain: '在任务中心接任务',
};

/**
 * **按开关筛过的场所表**(纯函数;2026-10-23 展览处刀 3 / D311)。
 *
 * 为什么要有它:回滚总闸 `QQBOT_GALLERY=0` 要能**把地图上那个点一起摘掉** ——
 * 不是只在 API 层 503、地图上还挂着个点着没反应的死点。过滤按 `kind` 认
 * (将来别的展览类场所也能共用同一个开关),调用方(装配层/面板快照)只传布尔。
 *
 * @param {{gallery?: boolean}} [options] false = 摘掉 `kind === 'gallery'` 的行
 * @returns {ReadonlyArray<object>} 场所列表(原表,或筛过的副本)
 */
export function placesFor({ gallery = true } = {}) {
  if (gallery !== false) return PLACES;
  return PLACES.filter((place) => place.kind !== 'gallery');
}

/** 按 id 取场所(取不到给 null —— **不猜**)。 */
export function placeById(id) {
  return PLACES.find((place) => place.id === String(id ?? '')) ?? null;
}

/**
 * **这儿的街通向哪儿**(1.92.0)—— 页面上"她能去的地方"从这张表来。
 *
 * ⚠️ 它**不是**一张距离表(距离按目的地算,见 `travelMs`);也不是"可达性"
 *    (场所本来全连通)。它回答的是**该给玩家看哪几个去处** —— 全都铺出来就是
 *    "一屏按钮"(成熟做法里那条:一排按钮比一长串更难看)。所以这是**设计声明**:
 *    每处最多三个、按"从这儿出去最自然的几个方向"挑。
 */
export const ROUTES = Object.freeze({
  home: ['guild', 'fishing', 'market'],
  guild: ['home', 'canteen', 'market'],
  canteen: ['guild', 'home', 'market'],
  market: ['home', 'guild', 'fishing'],
  fishing: ['home', 'guild', 'canteen'],
});

/** 从某处出发的去处(认不出给空数组 —— 不猜)。 */
export function routesFrom(placeId) {
  const ids = ROUTES[String(placeId ?? '')] ?? [];
  return ids.map((id) => placeById(id)).filter(Boolean);
}

/** 走到某个场所要多久(认不出给 null —— 不猜)。 */
export function travelMsTo(placeId) {
  return placeById(placeId)?.travelMs ?? null;
}

/** 从 `meta` 行里取一段 JSON(坏了就当没有)。 */
function readJson(metas, key) {
  const row = (metas ?? []).find((item) => String(item.key) === key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/** 取 `world:her` 那条事实(坏了/没有都给 null)。 */
export function readWhereabouts(metas = []) {
  return readJson(metas, WORLD_HER_KEY);
}

/**
 * **她此刻在哪个场所**(纯函数)。
 *
 * 三个来源,优先"记下来的":
 *   ① `meta['world:her']` = `{ place, doing, since, until }` —— **场所互动/她自己活动写的那条事实**;
 *      ⚠️ **在途**(同一行带 `to` / `arriveAt`)时:没到点 → 说"正往某处走";到点了 → **落地**成那儿;
 *   ② 派生:有钓鱼状态 = 她在**钓鱼场所**(钓鱼状态本来就是这条事实的证明,不必再存一遍);
 *   ③ 都没有 → `{ placeId: null }`,页面如实说"不知道她在哪"。
 *
 * @param {object} input
 * @param {Array<{key:string,value:string}>} [input.metas]
 * @param {Array<object>} [input.scenes] `buildSnapshot` 解析好的场景(有 `phase` / `phaseLabel`)
 * @param {number} [input.now]
 */
export function herWhereabouts({ metas = [], scenes = [], now = Date.now() } = {}) {
  const recorded = readWhereabouts(metas);
  // ⚠️ **过期的事实不算数**(1.85.0 / D140):记下来的只是"某一刻她在哪",不是永久身份 ——
  //    否则「她自己去市集」这条会让她**永远站在市集**。没有 `until` 的老记录按"不过期"处理
  //    (向后兼容:1.84.0 那批测试用的就是没有 until 的记录)。
  // ⚠️ **在途的记录不算过期**(1.92.0):`until` 是"这条事实的有效期",而路上那一段的
  //    有效期应该看 `arriveAt` —— 出发时写的 `until` 可能比到达时间还早(短途)。
  const until = recorded ? Number(recorded.until) : NaN;
  const traveling = Boolean(recorded && recorded.to);
  const expired = Number.isFinite(until) && until < now && !traveling;
  const recordedPlace = recorded && !expired ? placeById(recorded.place) : null;

  if (recordedPlace) {
    const since = Number.isFinite(Number(recorded.since)) ? Number(recorded.since) : null;
    const arriveAt = Number.isFinite(Number(recorded.arriveAt)) ? Number(recorded.arriveAt) : null;
    // —— 在途:还没到点,如实说"正往某处走" ——
    if (traveling && arriveAt !== null && arriveAt > now) {
      const target = placeById(recorded.to);
      return {
        placeId: recordedPlace.id,
        placeName: recordedPlace.name,
        where: recorded.where ?? null,
        doing: recorded.doing ?? (target ? `正往${target.name}走` : '在路上'),
        since,
        until: Number.isFinite(until) ? until : null,
        elapsedMs: since === null ? null : Math.max(0, now - since),
        from: recordedPlace.id,
        to: target?.id ?? null,
        toName: target?.name ?? null,
        arriveAt,
        etaMs: Math.max(0, arriveAt - now),
        traveling: true,
        source: 'recorded:traveling',
      };
    }
    // —— 到点(或没有在途):她就在记录的这个地方 ——
    return {
      placeId: recordedPlace.id,
      placeName: recorded.placeName || recordedPlace.name,
      where: recorded.where ?? null,
      doing: recorded.doing ?? null,
      since,
      until: Number.isFinite(until) ? until : null,
      elapsedMs: since === null ? null : Math.max(0, now - since),
      // ⚠️ 在途到点了但还没被 tick 收尾时:如实标"刚到",别假装她一直在
      from: null,
      to: null,
      toName: null,
      arriveAt,
      etaMs: 0,
      traveling: false,
      arrived: Boolean(traveling),
      source: 'recorded',
    };
  }

  const fishing = (scenes ?? []).find((scene) => scene && scene.kind === 'fishing' && scene.phase);
  if (fishing) {
    const since = Number.isFinite(Number(fishing.startedAt)) ? Number(fishing.startedAt) : null;
    return {
      placeId: 'fishing',
      placeName: placeById('fishing').name,
      where: null,
      doing: fishing.phaseLabel ?? phaseLabel({ phase: fishing.phase }),
      since,
      until: null,
      elapsedMs: since === null ? null : Math.max(0, now - since),
      from: null,
      to: null,
      toName: null,
      arriveAt: null,
      etaMs: 0,
      traveling: false,
      source: 'derived:fishing',
    };
  }

  return {
    placeId: null,
    placeName: null,
    where: null,
    doing: null,
    since: null,
    until: null,
    elapsedMs: null,
    from: null,
    to: null,
    toName: null,
    arriveAt: null,
    etaMs: 0,
    traveling: false,
    source: 'unknown',
  };
}

/**
 * 把"她自己这一轮的决定"翻译成一条**位置事实**(纯函数;写库由调用方做)。
 *
 * ⚠️ 为什么单独一个函数:`selfcare.js` 管"该不该 / 去干什么",这里管"那对应世界的哪个地方" ——
 *    两个判断都可能错,分开才能各自单测(翻译错一条,页面就会常年显示一个错地点,而且不报错)。
 *
 * ⚠️ **认不出场所就返回 null**(宁可"不知道她在哪",也不写一条错的事实)。
 *
 * @param {{action?: 'eat'|'life', eatery?: object, activity?: object}} decision
 * @param {{now?: number, ttlMs?: number}} [opts] `ttlMs` = 这条事实多久后过期(默认 30 分钟)
 * @returns {null | {place: string, placeName: string, where: string|null, doing: string,
 *   reason: string, since: number, until: number}}
 */
export function whereaboutsFromDecision(decision, { now = Date.now(), ttlMs = 30 * 60_000 } = {}) {
  if (!decision || !decision.action) return null;
  const since = Number(now) || Date.now();
  // 至少留 1 分钟,免得传 0 时写出一条"出生即过期"的记录
  const until = since + Math.max(60_000, Number(ttlMs) || 0);

  if (decision.action === 'eat') {
    const eatery = decision.eatery ?? {};
    const place = placeById('canteen');
    return {
      place: place.id,
      placeName: place.name,
      where: eatery.place ?? null,
      doing: eatery.food ? `吃${eatery.food}` : '吃饭',
      reason: '饿了(饱食低于阈值)',
      since,
      until,
    };
  }

  if (decision.action === 'life') {
    const activity = decision.activity ?? {};
    const place = placeById(activity.place);
    if (!place) return null;
    return {
      place: place.id,
      placeName: activity.placeName ?? place.name,
      where: null,
      doing: activity.line ?? activity.id ?? '在忙自己的事',
      reason: '没人说话,她自己过日子',
      since,
      until,
    };
  }

  return null;
}

/**
 * 一条**场所互动**对应的事实(纯函数;1.92.0)。
 *
 * 用户 2026-10-07:「先把世界系统做好」。缺口是:钓鱼 / 接委托 / 摆放**都不写位置事实** ——
 * 于是玩家在钓场钓了一下午,页面上"她在哪"还是"不知道"。这个函数把**已经发生的动作**
 * 翻成一条事实(它不判断该不该写、也不写库)。
 *
 * ⚠️ 认不出场所 / 动作 → `null`(**不猜**)。
 * ⚠️ 它**不覆盖**在途:`arriveAt > now` 时返回 null —— 她还在路上,别被一个动作"瞬移"过去
 *    (那正是这一版要修的"世界不连贯")。
 *
 * @param {object} input
 * @param {string} input.kind 动作名(`fishing.begin` / `quest.accept` / `home.put` / `move.to`)
 * @param {number} [input.now]
 * @param {number} [input.ttlMs] 这条事实多久后过期(默认 30 分钟)
 * @param {string} [input.target] 目的地(`move.to` 用)
 * @param {object|null} [input.current] 现在那条事实(`herWhereabouts()` 的输出**或**库里那一行都认)
 * @param {string|null} [input.why] 谁让她动的(`self` = 她自己走的一趟;见 D149 的到达报备)
 * @returns {null | object} 可直接 `JSON.stringify` 存进 `world:her`
 */
export function whereaboutsFromAction({
  kind = '',
  now = Date.now(),
  ttlMs = 30 * 60_000,
  target = null,
  detail = null,
  current = null,
  why = null,
} = {}) {
  // ⚠️ `current` 可以给**两形状之一**:`herWhereabouts()` 的输出(`placeId`)或库里那一行(`place`)。
  //    第一版只认库里那一行的形状,而写入方传的是 `herWhereabouts()` 的输出 ——
  //    "出发地"当场变成 null(测试抓到:走一趟之后 place 是 null)。
  const currentPlace = current?.place ?? current?.placeId ?? null;
  return whereaboutsFact({ kind, now, ttlMs, target, detail, currentPlace, current, why });
}

/**
 * **同一套逻辑,但"她"的那几个假设被拿掉了**(1.99.0 / D160):
 * 「谁在哪」不再只有她一个人 —— 玩家在场景里也有自己的位置事实(`world:player:<id>`)。
 *
 * ⚠️ 与 `whereaboutsFromAction` **共用同一段判断**(出发地认得出吗 / 在途不许被打断 /
 *    已经在这儿不写假事实 / 有效期要盖住整段路)—— 所以这里只是**多一个 `currentPlace` 入参**,
 *    不是第二份实现。📌 这正是 D159 那条教训(不许抄第二份)在代码里的落地。
 *
 * @param {object} input
 * @param {string} input.kind 动作名(`move.to` / `fishing.begin` / `quest.accept` / `home.put` / `home.take`)
 * @param {string|null} [input.currentPlace] 此刻在哪个场所(`null` = 不知道,不猜)
 * @param {object|null} [input.current] 现在那条事实(用来判"是不是在途")
 */
export function whereaboutsFact({
  kind = '',
  now = Date.now(),
  ttlMs = 30 * 60_000,
  target = null,
  detail = null,
  currentPlace = null,
  current = null,
  why = null,
} = {}) {
  const at = Number(now) || Date.now();
  // ⚠️ 还在路上(没到点)→ 什么动作都不改写位置:世界要保持连贯
  const onTheWay = Number.isFinite(Number(current?.arriveAt)) && Number(current.arriveAt) > at;
  if (onTheWay) return null;

  const base = { since: at, until: at + Math.max(60_000, Number(ttlMs) || 0), reason: `动作：${kind}` };

  // —— 移动:写**在途**那一份(place = 出发地,to/arriveAt = 目的地)——
  if (kind === 'move.to') {
    const from = currentPlace ? placeById(currentPlace) : null;
    const to = placeById(target);
    if (!to) return null;
    if (from && from.id === to.id) return null; // 已经在这儿了 —— 不写一条假事实
    // ⚠️ 认不出出发地(她本来"不知道在哪"):照走,只是**不编一个出发地**(页面会说"正往公会走")
    const fromId = from?.id ?? null;
    const travelMs = to.travelMs ?? 5 * 60_000;
    return {
      place: fromId,
      placeName: from?.name ?? null,
      where: null,
      doing: from ? `正往${to.name}走（从${from.name}出发）` : `正往${to.name}走`,
      since: at,
      // ⚠️ 有效期要**盖住整段路**(不然短途那条会被自己的 until 提前判定过期)
      until: at + travelMs + Math.max(60_000, Number(ttlMs) || 0),
      reason: '出发',
      // 谁让她动的(`self` = 她自己走的一趟)—— 1.92.1 的"到达报备"只认这一种
      why: why ?? null,
      from: fromId,
      to: to.id,
      toName: to.name,
      arriveAt: at + travelMs,
    };
  }

  // —— 场所互动:她人就在那个场所 ——
  //    ⚠️ 只列**真的会写事实**的那几个(1.95.1 复核抓到:`fishing.cast` / `fishing.reel_in`
  //    也写在这儿,但没人调用它们 —— 声明与实现不一致,删掉免得下次有人以为 "所有动作都写了")。
  const placeByAction = {
    'fishing.begin': 'fishing',
    'fishing.settle': 'fishing',
    'quest.accept': 'guild',
    'home.put': 'home',
    'home.take': 'home',
  };
  const placeId = placeByAction[String(kind)];
  const place = placeById(placeId);
  if (!place) return null;
  const doingByAction = {
    'fishing.begin': '在钓鱼场所挑钓点',
    'fishing.settle': '在钓鱼场所处置鱼获',
    'quest.accept': detail?.label ? `${WORLD_TEXT.questAcceptPrefix}${detail.label}${WORLD_TEXT.questAcceptSuffix}` : WORLD_TEXT.questAcceptPlain,
    'home.put': detail?.itemKey ? `在家园把「${detail.itemKey}」摆了出来` : '在家园摆弄东西',
    'home.take': detail?.itemKey ? `在家园把「${detail.itemKey}」收了起来` : '在家园摆弄东西',
  };
  return {
    place: place.id,
    placeName: place.name,
    where: null,
    doing: doingByAction[String(kind)] ?? `在${place.name}`,
    ...base,
  };
}

/**
 * **在途的推进**(纯函数;1.92.0):到点了就把在途那一份"落地"成目的地。
 *
 * ⚠️ 它只回一份**新的位置事实**(或 null = 这次不用改),写库仍由调用方做 ——
 *    于是"该不该落"可以单独单测,不必起一个 bridge。
 *
 * @param {object|null} current 现在那条 `world:her`
 * @param {number} [now]
 * @param {number} [ttlMs] 落地后这条事实的有效期
 */
export function settleTravel(current, { now = Date.now(), ttlMs = 30 * 60_000 } = {}) {
  const at = Number(now) || Date.now();
  if (!current || !current.to) return null;
  const arriveAt = Number(current.arriveAt);
  if (!Number.isFinite(arriveAt) || arriveAt > at) return null;
  const to = placeById(current.to);
  if (!to) return null;
  return {
    place: to.id,
    placeName: to.name,
    where: null,
    doing: `到了${to.name}`,
    since: arriveAt,
    until: at + Math.max(60_000, Number(ttlMs) || 0),
    reason: '走到了',
    from: null,
    to: null,
    toName: null,
    arriveAt: null,
  };
}

/** 每个场所现在"有什么事" —— 全部从**已有的事实**里聚合,这一层不产生新状态。 */
function placeView(place, { her, scenes = [], homeItems = [], questBoard = null, stats = null }) {
  const here = her?.placeId === place.id;
  const facts = [];
  let summary = place.blurb ?? '';

  if (place.id === 'home') {
    const ledger = Array.isArray(homeItems) ? homeItems : [];
    const total = ledger.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const placedRows = ledger.filter((item) => (Number(item.placed) || 0) > 0);
    const placed = placedRows.reduce((sum, item) => sum + Math.min(Number(item.placed) || 0, Number(item.count) || 0), 0);
    // ⚠️ 1.88.0:家园**有地方摆了** —— 摆出来的写清楚(位子 + 几件);还在地上的如实说"还没摆"
    summary = ledger.length === 0
      ? '还什么都没有带回来'
      : (placed > 0
        ? `摆出来 ${placed} 件 / 账上共 ${total} 件`
        : `${ledger.length} 种 · 共 ${total} 件（⚠️ 还没地方摆，只记在账上）`);
    for (const item of placedRows.slice(0, 4)) {
      const slot = FURNITURE.find((row) => row.id === item.slot);
      const n = Math.min(Number(item.placed) || 0, Number(item.count) || 0);
      facts.push({ k: slot ? slot.name : '架子上', v: `${item.key} ×${n}` });
    }
    for (const item of [...ledger].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 2)) {
      const loose = (Number(item.count) || 0) - Math.min(Number(item.placed) || 0, Number(item.count) || 0);
      if (loose > 0) facts.push({ k: item.key, v: `${loose} 件（还没摆）` });
    }
  }

  if (place.id === 'fishing') {
    const fishing = (scenes ?? []).filter((scene) => scene && scene.kind === 'fishing');
    if (fishing.length === 0) {
      summary = '现在没人在这儿钓';
    } else {
      const baskets = fishing.reduce((sum, scene) => sum + (scene.basketSummary?.count ?? 0), 0);
      const worth = fishing.reduce((sum, scene) => sum + (scene.basketSummary?.total ?? 0), 0);
      summary = `${fishing.length} 竿在钓 · 鱼篓合计 ${baskets} 件`
        + (worth > 0 ? `（约值 ${worth.toLocaleString('ja-JP')} ${WORLD_TEXT.currency}）` : '');
      for (const scene of fishing.slice(0, 3)) {
        facts.push({
          k: scene.userName || '有人',
          v: `${scene.phaseLabel ?? scene.phase}${scene.basketSummary?.count ? ` · 鱼篓 ${scene.basketSummary.count} 件` : ''}`,
        });
      }
    }
  }

  if (place.id === 'guild') {
    if (!questBoard) summary = '看板还没挂出来过';
    else if (questBoard.stale) summary = `看板已经撤了（超过 6 小时）`;
    else summary = `${(questBoard.rows ?? []).length} 条委托在板上`;
    for (const row of (questBoard?.rows ?? []).slice(0, 2)) {
      facts.push({ k: `#${row.index} ${row.label}`, v: `${row.reward} ${row.unit}` });
    }
  }

  if (place.id === 'canteen') {
    const satiety = Number(stats?.satiety);
    summary = Number.isFinite(satiety)
      ? `她自己饿了会来吃（现在饱食 ${Math.round(satiety)}）`
      : place.blurb;
  }

  // ⚠️ 1.92.0:**她在路上**时,目的地那一行要说清"她正往这儿来" ——
  //    否则玩家在页面上只看到"她不在任何地方"(因为 placeId 还是出发地)。
  const incoming = her?.traveling && her?.to === place.id;

  return { ...place, here, incoming, summary, facts };
}

/**
 * **世界的这一刻**(纯函数):她在哪 + 每个场所有什么事。
 *
 * @param {object} input
 * @param {Array<{key:string,value:string}>} [input.metas] 只要 `world:` 那几行(读 `world:her`)
 * @param {Array<object>} [input.scenes] `buildSnapshot` 解析好的场景
 * @param {Array<object>} [input.homeItems] `home_item` 账本
 * @param {object|null} [input.questBoard] 公会看板(含 `stale`)
 * @param {object|null} [input.stats] 数值(只用 `satiety`)
 * @param {number} [input.now]
 * @param {boolean} [input.gallery] 展览处开不开(默认开;`QQBOT_GALLERY=0` 时装配层传 false)
 */
export function describeWorld({
  metas = [],
  scenes = [],
  homeItems = [],
  questBoard = null,
  stats = null,
  now = Date.now(),
  gallery = true,
} = {}) {
  const her = herWhereabouts({ metas, scenes, now });
  return {
    her,
    places: placesFor({ gallery }).map((place) => placeView(place, { her, scenes, homeItems, questBoard, stats })),
  };
}

/** 一句"她在哪"的人话(QQ 报幕与页面抬头共用;不知道就如实说)。 */
export function describeWhereabouts(her) {
  if (!her || !her.placeId) return '不知道她这会儿在哪儿';
  if (her.traveling && her.toName) {
    return `她正从${her.placeName}往${her.toName}走（还有约 ${Math.max(1, Math.ceil((her.etaMs ?? 0) / 60_000))} 分钟）`;
  }
  const doing = her.doing ? `（${her.doing}）` : '';
  return `她在${her.placeName}${doing}`;
}
