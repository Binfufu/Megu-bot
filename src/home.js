/**
 * **家园:家具与摆件**(1.88.0;**装饰那一轴**的第一刀)。
 *
 * ## 这一层解决什么
 *
 * 用户 2026-10-06 点名"场所把家园和公会也做上"。公会那一刀(1.86.0)接的是**委托**;
 * 家园这一刀接的是**"带回来的东西有地方摆"** —— 面板上原来只能如实写着"⚠️ 还没地方摆,只记在账上"。
 *
 * ## 三条刻意的形状
 *
 * ① ⚠️ **不新开 meta 键**:账本 `home_item` 的每一行**本来就有一个 `available` 字段**
 *    (当年写它就是为了"有地方摆了"那一天)。摆上/取下 = 给那一行打 `slot` / `placed`,
 *    于是**一个写者、一次写** —— 不存在"布局写了、账本没写"的半写风险(C 档那条)。
 * ② ⚠️ **不动数值**:它是用户定过的"成长分**数值**与**装饰**"里的装饰轴 ——
 *    摆放不给任何数值效果。所以判据不写"加了多少属性",写**账实一致**与**可逆**。
 * ③ **纯函数**:这里只算"下一步该是什么样",不认识库、不认识 HTTP、不认模型 —— 可单测。
 *
 * ## 数据形状(账本里的一行)
 * ```
 * { key: '风干鱼', count: 9, available: true, slot: 'rack', placed: 6, firstAt: … }
 *   count = 账上有几件;placed = 摆出来几件(0 ≤ placed ≤ count);slot = 摆在哪个位子
 *   available = placed > 0(面板据此不再说"还没地方放")
 * ```
 */

/** 家具 / 摆件位。`kinds` 是这个位子**收哪一类**东西(见 `itemKindOf`)。 */
export const FURNITURE = Object.freeze([
  {
    id: 'rack',
    name: '晾鱼架',
    kinds: ['dried', 'fish'],
    note: '把带回来的鱼挂起来晾着 —— 她那条"带回家风干"就落在它头上',
  },
  {
    id: 'hearth',
    name: '灶台',
    kinds: ['dried'],
    note: '做饭的地方（这一版只摆着看，不进任何数值）',
  },
  {
    id: 'shelf',
    name: '书架',
    kinds: ['misc'],
    note: '杂物与书 —— 认不出是什么东西的，都归这儿',
  },
  {
    id: 'sill',
    name: '窗台',
    kinds: ['misc', 'dried'],
    note: '窗台上放点小东西，看着心里舒服',
  },
]);

/** 按 id 取家具(取不到给 null —— **不猜**)。 */
export function furnitureById(id) {
  return FURNITURE.find((row) => row.id === String(id ?? '')) ?? null;
}

/**
 * 这个东西算哪一类(**纯函数**;认不出就归 `misc`,于是**永远有一个位子收它**)。
 *
 * ⚠️ 用名字判断有点土,但它诚实:账本里存的就是中文名(`风干鱼`),没有更细的分类字段。
 *    哪天账本带上真正的 `kind` 字段,这个函数就退化成"读那个字段"。
 */
export function itemKindOf(key) {
  const name = String(key ?? '').trim();
  if (!name) return 'misc';
  if (name.includes('风干')) return 'dried';
  if (/[鱼虾蟹贝螺]/.test(name)) return 'fish';
  return 'misc';
}

/**
 * **摆上 / 取下的判定**(纯函数,不改入参)。
 *
 * @param {object} input
 * @param {Array<object>} [input.items] 账本行(`home_item` 里的 `items`)
 * @param {string} input.itemKey 哪件东西
 * @param {string} [input.slotId] 哪个位子(`take` 时可省)
 * @param {'put'|'take'} [input.mode]
 * @param {number} [input.count] 几件(默认 1)
 * @returns {{ok:false,reason:string,note:string} | {ok:true,items:Array<object>,itemKey:string,slot:object|null,placed:number,moved:number}}
 */
export function planHomeMove({ items = [], itemKey = '', slotId = '', mode = 'put', count = 1 } = {}) {
  const list = Array.isArray(items) ? items.map((row) => ({ ...row })) : [];
  const key = String(itemKey ?? '').trim();
  if (!key) return { ok: false, reason: 'bad_item', note: '没说要摆哪件东西（刷新看看）。' };
  const row = list.find((item) => item.key === key);
  if (!row) return { ok: false, reason: 'no_such_item', note: `账上没有「${key}」这件东西（刷新看看）。` };
  const total = Number(row.count) || 0;
  const placed = Math.max(0, Math.min(Number(row.placed) || 0, total));
  const want = Math.max(1, Math.min(99, Number(count) || 1));

  if (mode === 'take') {
    if (placed <= 0) {
      return { ok: false, reason: 'not_placed', note: `「${key}」没摆在架子上。` };
    }
    const moved = Math.min(want, placed);
    row.placed = placed - moved;
    if (row.placed === 0) { row.slot = null; row.available = false; }
    return { ok: true, items: list, itemKey: key, slot: furnitureById(row.slot), placed: row.placed, moved };
  }

  const slot = furnitureById(slotId);
  if (!slot) return { ok: false, reason: 'bad_slot', note: '这个摆件位认不出来（刷新看看）。' };
  const kind = itemKindOf(key);
  if (!slot.kinds.includes(kind)) {
    return {
      ok: false,
      reason: 'slot_kind',
      note: `「${slot.name}」不放这一类东西（${key} 算「${KIND_LABEL[kind]}」）。`,
    };
  }
  // 换位子:先把原来摆着的收回来(同一个位子就是加数量)
  if (row.slot && row.slot !== slot.id) {
    row.placed = 0;
  }
  const room = total - (row.placed || 0);
  if (room <= 0) {
    return { ok: false, reason: 'over_ledger', note: `账上只有 ${total} 件「${key}」，全摆出来了。` };
  }
  const moved = Math.min(want, room);
  row.slot = slot.id;
  row.placed = (row.placed || 0) + moved;
  row.available = true;
  return { ok: true, items: list, itemKey: key, slot, placed: row.placed, moved };
}

const KIND_LABEL = { dried: '鱼干', fish: '鱼', misc: '杂物' };

/** 一句人话回执(面板与将来的别处共用)。 */
export function describeHomeMove({ mode = 'put', itemKey = '', slot = null, moved = 1, placed = 0 } = {}) {
  if (mode === 'take') return `把「${itemKey}」从${slot ? slot.name : '架子上'}取下来了 ${moved} 件（还摆着 ${placed} 件）`;
  return `把「${itemKey}」摆到了${slot ? slot.name : '架子上'}（${moved} 件，这个位子上现在共 ${placed} 件）`;
}

/**
 * **家园这一刻**(纯函数):每个位子上摆着什么、账实对不对得上。
 *
 * ⚠️ **账实一致**是这一层的硬判据:`placed` 永远不许超过账上的 `count`。
 *    真出现不一致(比如东西被卖掉了、账本变了),这里**如实报出来**,页面显示时按 `backed` 截断 ——
 *    宁可显示"少一件",也不许凭空变出一件。
 */
export function describeHome(items = []) {
  const list = (Array.isArray(items) ? items : []).map((row) => {
    const total = Number(row.count) || 0;
    const placed = Math.max(0, Number(row.placed) || 0);
    return {
      key: String(row.key ?? ''),
      total,
      placed,
      placedRaw: placed,
      backed: Math.min(placed, total),
      slot: row.slot ? String(row.slot) : null,
      mismatch: placed > total,
    };
  });
  const slots = FURNITURE.map((slot) => {
    const mine = list.filter((row) => row.slot === slot.id && row.placedRaw > 0);
    return {
      id: slot.id,
      name: slot.name,
      note: slot.note,
      items: mine.map((row) => ({ key: row.key, placed: row.backed, placedRaw: row.placedRaw, mismatch: row.mismatch })),
      count: mine.reduce((sum, row) => sum + row.backed, 0),
    };
  });
  return {
    slots,
    placedTotal: list.reduce((sum, row) => sum + row.backed, 0),
    ledgerTotal: list.reduce((sum, row) => sum + row.total, 0),
    // 摆出来但账上不够的(或多出来的)—— 如实报,不吞
    mismatched: list.filter((row) => row.mismatch).map((row) => ({ key: row.key, placed: row.placedRaw, total: row.total })),
    // 能摆但还摆在地上的(面板据此给「摆上去」按钮)
    loose: list.filter((row) => row.total - row.backed > 0).map((row) => ({ key: row.key, count: row.total - row.backed })),
  };
}
