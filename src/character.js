/**
 * **角色:模块化生成 + 点数买卖**(1.104.0 / D168)。
 *
 * ## 这一层解决什么
 *
 * 用户 2026-10-07 原话:
 * > 「还有**角色模块化生成**的部分没做,看看能不能和**玩家创建自己角色**、
 * >  **ai 伙伴角色(惠惠)**结合起来,形成一个**玩家注册完账号就能创建角色** →
 * >  在**自己家园和世界内游玩**、**和 ai 伙伴互动** → **组队跑团**的动作链」。
 *
 * 而 `TODO.md` 里早就把这件事的设计口径写死了(★★★ [先设计] 角色构建 = 点数买卖):
 *   · **开卡有点数预算**;**技能模块化**成一张价目表;
 *   · **缺点可以倒贴点数**(成长方向与代价由玩家自己选);
 *   · ⚠️ 三条规矩:① **只做加法不做乘法**;② **缺点要有真实手感**;
 *     ③ **留一套"穷但稳"的保底能力**;
 *   · ⚠️ **数值全在内核算**,**LLM 只给名字上色**,不许决定数字。
 *
 * ## 两套模块(同一个"模块"概念,两种用途)
 *
 * | | 花不花点数 | 决定什么 | 存在哪 |
 * |---|---|---|---|
 * | **能力模块** `CHARACTER_MODULES` | 花(缺点倒贴) | **判定修正**(`lawful` / `tricky`) | 角色卡 |
 * | **外观模块** `APPEARANCE_MODULES` | **不花** | **长什么样**(拼出一张像素头像) | 角色卡 |
 *
 * ## ⚠️ 与游戏其余部分怎么接
 *
 * 委托内核(`src\play\quest.js`)每一步都带一个 `kind`(现在只有 `lawful` / `tricky`)
 * 和一位 `mod`——那位一直是 `0`,**就是留给这里的**:`modFor(sheet, kind)` 算出来的数
 * 会加进 `margin = roll + mod - dc`。所以"我练了什么"是**真的**影响跑团结果的,
 * 不是一句人设。
 *
 * ## ⚠️ 数字是**暂定**的
 *
 * 预算与价目表都是**操作者该拍板**的东西(这是他一直以来的口径:数字他定)。
 * 所以它们**全在 `src\character-tuning.js` 那一张表里**,这个文件只负责算 ——
 * 改价、改预算、改上下限都只动那一个文件,别处不许再写第二份。
 */
import {
  CHARACTER_BUDGET,
  DEFAULT_KIT,
  MAX_FLAWS,
  MODULE_TUNING,
  STAT_MAX_MOD,
  STAT_MIN_MOD,
} from './character-tuning.js';

export { CHARACTER_BUDGET, DEFAULT_KIT, MAX_FLAWS } from './character-tuning.js';

/** 判定轴 —— ⚠️ **必须与委托步段的 `kind` 对齐**(quest.js 里现在只有这两类)。 */
export const CHECK_KINDS = Object.freeze(['lawful', 'tricky']);

/** 判定轴的人话(页面与提示词都用这一份,不许各写各的)。 */
export const CHECK_KIND_LABELS = Object.freeze({
  lawful: '正面硬来',
  tricky: '机灵取巧',
});

/**
 * **能力模块价目表**(⚠️ 数字在 `character-tuning.js`,这里只是把它冻住)。
 *
 * 形状:`{ id, kind: 'skill'|'flaw', name, cost, mods: { lawful, tricky }, note? }`
 *   · `cost` **正数 = 花点数**,**负数 = 倒贴**(缺点);
 *   · `mods` **只做加法**(TODO 的规矩①)—— 全身没有一处乘法。
 */
export const CHARACTER_MODULES = Object.freeze(MODULE_TUNING.map((m) => Object.freeze({
  ...m,
  mods: Object.freeze({ ...m.mods }),
})));

// ---------------------------------------------------------------------------
// 外观模块(免费;拼像素头像)
// ---------------------------------------------------------------------------

/**
 * ⚠️ 外观用**字符网格**表示(每个字符 = 调色板里的一个键),而不是图片:
 *    · 纯函数、可单测(同一套选择 → 逐字相同的网格);
 *    · 页面那侧自己画到 canvas(与 `pixel-scene.js` 同一套"在 Node 里也能画"的精神);
 *    · 不需要任何二进制素材进仓库。
 *
 * 网格是 12 宽 × 16 高:**头发**贴在第 1~5 行,**衣服**贴在第 8~13 行,**配件**盖在头上。
 */
export const AVATAR_WIDTH = 12;
export const AVATAR_HEIGHT = 16;

/** 调色板:一个字符一个颜色(`.` = 透明)。 */
export const AVATAR_PALETTE = Object.freeze({
  S: '#f2c9a0', // 皮肤
  s: '#d9a878', // 皮肤(阴影)
  E: '#2b2b33', // 眼睛
  H: '#5a3a2a', // 头发(棕)
  h: '#3d2419', // 头发(深)
  C: '#c0392b', // 头发(红)/衣服(红)
  c: '#8e2b20', // 红(暗)
  B: '#2c5f9e', // 蓝
  b: '#1e4272', // 蓝(暗)
  W: '#eef1f5', // 白
  G: '#3fa45b', // 绿
  Y: '#e8c35a', // 金
  K: '#22222a', // 黑
});

const BASE_BODY = Object.freeze([
  '............',
  '...SSSSSS...',
  '..SSSSSSSS..',
  '..SESSSSES..',
  '..SSSSSSSS..',
  '..sSSSSSSs..',
  '...SSSSSS...',
  '....SSSS....',
  '..WWWWWWWW..',
  '.WWWWWWWWWW.',
  '.WWWWWWWWWW.',
  '.WWWWWWWWWW.',
  '.WWWWWWWWWW.',
  '..WWWWWWWW..',
  '...ss..ss...',
  '...ss..ss...',
]);

/** 外观模块:每件都是**贴到某个槽位**的一小块。 */
export const APPEARANCE_MODULES = Object.freeze([
  // —— 头发(贴在第 0 行起)——
  { id: 'hair_short', slot: 'hair', name: '短发', chars: { H: 'H' }, rows: [
    '....HHHH....',
    '...HHHHHH...',
    '..HHHHHHHH..',
    '..HHHHHHHH..',
    '..hHHHHHHh..',
  ] },
  { id: 'hair_long', slot: 'hair', name: '长发', chars: { H: 'H' }, rows: [
    '....HHHH....',
    '...HHHHHH...',
    '..HHHHHHHH..',
    '.HHHHHHHHHH.',
    '.HHHHHHHHHH.',
  ] },
  { id: 'hair_red', slot: 'hair', name: '红发', chars: { H: 'C' }, rows: [
    '....CCCC....',
    '...CCCCCC...',
    '..CCCCCCCC..',
    '..CCCCCCCC..',
    '..cCCCCCCc..',
  ] },
  { id: 'hair_bun', slot: 'hair', name: '丸子头', chars: { H: 'h' }, rows: [
    '.....hh.....',
    '....hhhh....',
    '..hhhhhhhh..',
    '..hhhhhhhh..',
    '...hhhhhh...',
  ] },
  // —— 衣服(贴在第 8 行起)——
  { id: 'outfit_red', slot: 'outfit', name: '红衣', chars: { W: 'C' }, rows: [
    '..CCCCCCCC..',
    '.CCCCCCCCCC.',
    '.CCCCCCCCCC.',
    '.CCCCCCCCCC.',
    '.CCCCCCCCCC.',
    '..CCCCCCCC..',
  ] },
  { id: 'outfit_blue', slot: 'outfit', name: '蓝衣', chars: { W: 'B' }, rows: [
    '..BBBBBBBB..',
    '.BBBBBBBBBB.',
    '.BBBBBBBBBB.',
    '.BBBBBBBBBB.',
    '.BBBBBBBBBB.',
    '..BBBBBBBB..',
  ] },
  { id: 'outfit_white', slot: 'outfit', name: '白衣', chars: { W: 'W' }, rows: [
    '..WWWWWWWW..',
    '.WWWWWWWWWW.',
    '.WWWWWWWWWW.',
    '.WWWWWWWWWW.',
    '.WWWWWWWWWW.',
    '..WWWWWWWW..',
  ] },
  { id: 'outfit_green', slot: 'outfit', name: '绿衣', chars: { W: 'G' }, rows: [
    '..GGGGGGGG..',
    '.GGGGGGGGGG.',
    '.GGGGGGGGGG.',
    '.GGGGGGGGGG.',
    '.GGGGGGGGGG.',
    '..GGGGGGGG..',
  ] },
  // —— 配件(盖在最上面)——
  { id: 'acc_none', slot: 'accessory', name: '不戴', rows: [] },
  { id: 'acc_hat', slot: 'accessory', name: '尖帽', rows: [
    '.....YY.....',
    '....YYYY....',
  ] },
  { id: 'acc_band', slot: 'accessory', name: '发带', rows: [
    '...CCCCCC...',
  ] },
]);

/** 槽位在哪一行开始贴(`hair` 从 0,`outfit` 从 8,`accessory` 从 0 覆在头发上)。 */
const SLOT_ROW = Object.freeze({ hair: 0, outfit: 8, accessory: 0 });

/** 外观槽位(选一个)。 */
export const APPEARANCE_SLOTS = Object.freeze(['hair', 'outfit', 'accessory']);

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 按 id 找能力模块。 */
export function moduleById(id) {
  const key = String(id ?? '').trim();
  return CHARACTER_MODULES.find((m) => m.id === key) ?? null;
}

/** 按 id 找外观模块。 */
export function appearanceById(id) {
  const key = String(id ?? '').trim();
  return APPEARANCE_MODULES.find((m) => m.id === key) ?? null;
}

/**
 * **校验一次开卡**(fail closed:认不出、重复、超支一律拒)。
 *
 * @param {object} input
 * @param {string[]} input.picks 能力模块 id
 * @param {number} [input.budget]
 * @returns {{ok:boolean, error?:string, note?:string, spent:number, remaining:number, picks:string[]}}
 */
export function validatePicks({ picks = [], budget = CHARACTER_BUDGET } = {}) {
  const budgetNum = Number(budget);
  if (!Number.isFinite(budgetNum) || budgetNum < 0) {
    return { ok: false, error: 'bad_budget', note: '点数预算不是一个正常的数。', spent: 0, remaining: 0, picks: [] };
  }
  const clean = [];
  for (const raw of Array.isArray(picks) ? picks : []) {
    const mod = moduleById(raw);
    if (!mod) {
      return { ok: false, error: 'unknown_module', note: `认不出这个模块：${String(raw)}`, spent: 0, remaining: 0, picks: clean };
    }
    if (clean.includes(mod.id)) {
      return { ok: false, error: 'duplicate_module', note: `同一个模块选了两次：${mod.name}`, spent: 0, remaining: 0, picks: clean };
    }
    clean.push(mod.id);
  }
  const spent = clean.reduce((sum, id) => sum + moduleById(id).cost, 0);
  // ⚠️ **缺点数量上限**(规矩②的对偶):"倒贴点数"很爽,而修正有个下限 ——
  //    只靠下限挡不住"堆一堆缺点换点数"(那正是白送点数)。所以这里按**数量**拒。
  const flaws = clean.filter((id) => moduleById(id).kind === 'flaw');
  if (flaws.length > MAX_FLAWS) {
    return {
      ok: false, error: 'too_many_flaws',
      note: `缺点最多带 ${MAX_FLAWS} 个（现在 ${flaws.length} 个）—— 倒贴点数不是白送。`,
      spent, remaining: budgetNum - spent, picks: clean,
    };
  }
  const remaining = budgetNum - spent;
  if (remaining < 0) {
    return {
      ok: false, error: 'overspend', note: `点数不够：花了 ${spent}，只有 ${budgetNum}。`,
      spent, remaining, picks: clean,
    };
  }
  return { ok: true, spent, remaining, picks: clean };
}

/**
 * **算出这张角色卡的判定修正**(只做加法;保底能力人人都有)。
 *
 * @param {string[]} picks
 * @returns {{lawful:number, tricky:number}}
 */
export function modsForPicks(picks = []) {
  const out = { ...DEFAULT_KIT };
  for (const id of Array.isArray(picks) ? picks : []) {
    const mod = moduleById(id);
    if (!mod) continue; // ⚠️ 认不出的就当没有(真正的拒绝在 `validatePicks` 里,这里不抛)
    for (const kind of CHECK_KINDS) out[kind] += Number(mod.mods?.[kind]) || 0;
  }
  for (const kind of CHECK_KINDS) {
    out[kind] = Math.max(STAT_MIN_MOD, Math.min(STAT_MAX_MOD, out[kind]));
  }
  return out;
}

/** 一条判定轴该加多少(给委托内核用;没有角色卡 = 0)。 */
export function modFor(sheet, kind) {
  if (!sheet || !sheet.mods) return 0;
  const value = Number(sheet.mods[kind]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * **建一张角色卡**(纯函数:同一个输入 → 逐字段相同的输出)。
 *
 * @param {object} input
 * @param {string} input.name 角色名(⚠️ 只当**名字**用:数字全在这里算,模型不参与)
 * @param {string[]} [input.picks]
 * @param {Record<string,string>} [input.appearance] 槽位 → 外观模块 id
 * @param {number} [input.budget]
 * @param {number} [input.now]
 * @returns {{ok:boolean, error?:string, note?:string, sheet?:object}}
 */
export function buildSheet({ name = '', picks = [], appearance = {}, budget = CHARACTER_BUDGET, now = Date.now() } = {}) {
  const check = validatePicks({ picks, budget });
  if (!check.ok) return { ok: false, error: check.error, note: check.note };
  const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
  if (!cleanName) return { ok: false, error: 'no_name', note: '给你的角色起个名字吧。' };
  const look = {};
  for (const slot of APPEARANCE_SLOTS) {
    const wanted = appearance?.[slot];
    const found = wanted ? appearanceById(wanted) : null;
    if (wanted && (!found || found.slot !== slot)) {
      return { ok: false, error: 'bad_appearance', note: `外观认不出这一件：${String(wanted)}` };
    }
    // 没选就用这一槽位的第一件(不逼人挑,也能出图)
    look[slot] = found?.id ?? APPEARANCE_MODULES.find((m) => m.slot === slot).id;
  }
  const mods = modsForPicks(check.picks);
  return {
    ok: true,
    sheet: {
      v: 1,
      name: cleanName,
      picks: check.picks,
      appearance: look,
      budget: Number(budget),
      spent: check.spent,
      remaining: check.remaining,
      mods,
      madeAt: Number(now) || Date.now(),
    },
  };
}

/**
 * **模块化拼出一张头像**(纯函数):底身 → 头发 → 衣服 → 配件。
 *
 * @param {object} [input]
 * @param {Record<string,string>} [input.appearance]
 * @returns {{width:number, height:number, rows:string[]}} 每个字符是一个调色板键(`.` = 透明)
 */
export function avatarFor({ appearance = {} } = {}) {
  const grid = BASE_BODY.map((row) => row.padEnd(AVATAR_WIDTH, '.').slice(0, AVATAR_WIDTH).split(''));
  const paint = (moduleId, slot) => {
    const mod = appearanceById(moduleId);
    if (!mod || mod.slot !== slot) return;
    const top = SLOT_ROW[slot] ?? 0;
    const map = mod.chars ?? {};
    mod.rows.forEach((row, index) => {
      const y = top + index;
      if (y < 0 || y >= AVATAR_HEIGHT) return;
      for (let x = 0; x < AVATAR_WIDTH; x += 1) {
        const ch = row[x] ?? '.';
        if (ch === '.') continue;
        grid[y][x] = map[ch] ?? ch;
      }
    });
  };
  // 顺序刻意的:头发 → 衣服 → 配件(配件盖在最上面)
  paint(appearance.hair, 'hair');
  paint(appearance.outfit, 'outfit');
  paint(appearance.accessory, 'accessory');
  return { width: AVATAR_WIDTH, height: AVATAR_HEIGHT, rows: grid.map((row) => row.join('')) };
}

/** 角色卡那一句话(页面与提示词共用)。 */
export function describeSheet(sheet) {
  if (!sheet) return '还没有角色';
  const mods = sheet.picks.map((id) => moduleById(id)).filter(Boolean);
  // ⚠️ 技能与缺点**分开说**(第一版把缺点也念成"会:跑不快" —— 那是一句反话)
  const skills = mods.filter((m) => m.kind === 'skill').map((m) => m.name);
  const flaws = mods.filter((m) => m.kind === 'flaw').map((m) => m.name);
  const parts = [String(sheet.name ?? '没名字')];
  if (skills.length) parts.push(`会：${skills.join('、')}`);
  if (flaws.length) parts.push(`短板：${flaws.join('、')}`);
  const axes = CHECK_KINDS
    .map((k) => `${CHECK_KIND_LABELS[k]} ${Number(sheet.mods?.[k]) >= 0 ? '+' : ''}${Number(sheet.mods?.[k]) || 0}`)
    .join('，');
  parts.push(`（${axes}）`);
  return parts.join('；');
}

// ---------------------------------------------------------------------------
// 服务(要一个库;不认 HTTP,也不认模型)
// ---------------------------------------------------------------------------

/** 角色卡的 meta 前缀(`character:<playerId>`,一人一键)。 */
export const CHARACTER_PREFIX = 'character:';

export function characterKey(playerId) {
  const id = Number(playerId);
  return Number.isInteger(id) && id > 0 ? `${CHARACTER_PREFIX}${id}` : null;
}

/**
 * @param {object} deps
 * @param {object} deps.store 状态库(只用 `getMeta` / `setMeta` / `listMetaKeys`)
 * @param {object} [deps.log]
 */
export function createCharacters({ store, log = console } = {}) {
  function get(playerId) {
    const key = characterKey(playerId);
    if (!key) return null;
    try {
      const raw = store.getMeta(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.name) return null;
      return { ...parsed, mods: modsForPicks(parsed.picks) };
    } catch (err) {
      // ⚠️ 坏了当"没有"(不猜)—— 与项目里别处同一条口径
      log.warn?.(`角色卡读不出来（当没有处理）: ${err?.message ?? err}`);
      return null;
    }
  }

  function save(playerId, input) {
    const key = characterKey(playerId);
    if (!key) return { ok: false, error: 'no_player', note: '先登录再说。' };
    const built = buildSheet(input);
    if (!built.ok) return built;
    try {
      store.setMeta(key, JSON.stringify(built.sheet));
    } catch (err) {
      log.warn?.(`角色卡没写下去: ${err?.message ?? err}`);
      return { ok: false, error: 'write_failed', note: '这张卡没存住，再试一次。' };
    }
    return { ok: true, sheet: built.sheet };
  }

  /** 所有角色卡(给人看"谁是谁"用;给的是**名字**那一层,不带内部键)。 */
  function all() {
    const out = [];
    try {
      const keys = store.listMetaKeys(CHARACTER_PREFIX) ?? [];
      for (const key of keys) {
        const playerId = Number(String(key).slice(CHARACTER_PREFIX.length));
        if (!Number.isInteger(playerId) || playerId <= 0) continue;
        const sheet = get(playerId);
        if (sheet) out.push({ playerId, name: sheet.name, picks: sheet.picks, mods: sheet.mods });
      }
    } catch (err) {
      log.warn?.(`角色卡列表读不出来: ${err?.message ?? err}`);
    }
    return out;
  }

  return { get, save, all };
}
