import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/**
 * **旅伴**(2026-10-11 第四轮 / D190)—— 「谁陪着这个世界」这一层的**注册表**。
 *
 * ## 为什么单独一个模块
 *
 * 用户点名的两层结构:第一层**只画立绘 + 名字 + 一颗状态点**,第二层才是数值。
 * 「有几个伙伴、分别叫什么、立绘从哪来」是**设定**(和 `world.js` 的 `PLACES`、
 * `fishing.js` 的钓点同一条规矩):落库只会多出一份会腐烂的副本。
 * 所以名单写在这里,数值/事实**一律现读**。
 *
 * ## 三件事刻意
 *
 * ① **注册表只放"设定"**:id / 名字 / 皮肤文件 / 它属于哪只 bot。
 *    数值、位置、病情统统不在这里 —— 那些是事实,由调用方现读(D143:一个写者一次写)。
 * ② **跨实例只读**:默认角色与另一角色是**两只 bot + 两个 state.db**,而面板只挂在其中一只上。
 *    「旅伴」要能看到另一只,唯一安全的做法是**只读打开它的库**
 *    (`node:sqlite` 的 `readOnly: true`;WAL 也照样能读 —— 2026-10-11 实测过)。
 *    ⚠️ **永远不写**:读不到就如实标"离线",绝不去猜、更不去补一条假事实。
 * ③ **立绘走"MC 皮肤 + MC 小人"**(用户原话):皮肤 PNG 由服务端发,
 *    客户端用 canvas 画等距小人(见 `panel.js` 的 `drawMcSkin`)——
 *    **零外链、零依赖**,这是项目硬口径(`selftest-ui.js` 那条钉着)。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describeValue, getBodyTheme, labelFor, longLabelFor, VALUE_KEYS } from './body-theme.js';
import { describeCondition, healthTier, isIll, moodTier } from './condition.js';
import { nameIsInvisible } from './people.js';
import { affinityTier } from './affinity.js';
import { herWhereabouts, WORLD_HER_KEY } from './world.js';
// 日志/编年史:那一份**纯派生**的实现只有一处(`buildChronicle`)—— 面板与"看别的旅伴"共用它。
import { buildChronicle } from './chronicle.js';

/**
 * **伙伴名单**(唯一一份)。
 *
 * ⚠️ `bot` = 它在 `bots/<bot>/.env` 里跑的那一只;`stateDir` = 它的状态库在 `data/` 下的哪个目录
 *    (与 `bots/<bot>/.env` 的 `QQBOT_DATA_DIR` 一致 —— 那两个值是**同一件事**,别只改一边)。
 * ⚠️ `theme` 走 `body-theme.js` 的主题名(`megumin` / `aris`):**数值的标签与档位词从它来**,
 *    所以"电量 / 机能 / 温度"那套是自动的,不在这里抄第二份。
 * ⚠️ `art` 是**相对 assets 目录**(`assets/companions/`)的文件名。
 *    文件**可以不存在** —— 那时这一栏会画一个"还没画好的立绘"占位(见 `readSkin`),
 *    而不是让整张卡空着或让页面报错。
 */
export const COMPANIONS = Object.freeze((LOCAL_STORY_WORLD?.companions ?? []).map((one) => Object.freeze(one)));

/** 立绘(皮肤)放哪儿 —— **一条路**,别处不许再拼一遍。 */
export const SKIN_DIR = 'assets/companions';

/**
 * 认一个伙伴 id(认不出回 null —— **不猜**)。
 * @param {string} id
 */
export function companionById(id) {
  const want = String(id ?? '').trim();
  if (!want) return null;
  return COMPANIONS.find((one) => one.id === want) ?? null;
}

/** 皮肤文件在磁盘上的完整路径(不检查存不存在 —— 那是 `readSkin` 的事)。 */
export function skinPathFor(rootDir, id) {
  const one = companionById(id);
  if (!one) return null;
  return path.join(rootDir, SKIN_DIR, one.art);
}

/**
 * **皮肤字节**(带缓存;读不到回 null)。
 *
 * ⚠️ 缓存的是**字节**,不是"这张图好不好看" —— 皮肤是设定文件,进程活着的时候不会变;
 *    换皮肤要重启(和"场所表写在代码里"同一个代价,可以接受)。
 * ⚠️ 只有**真的存在**才缓存;不存在时下一次请求会再去看一眼(把图丢进去不用重启)。
 */
const skinCache = new Map();

export function readSkin(rootDir, id) {
  const one = companionById(id);
  if (!one) return null;
  const hit = skinCache.get(one.id);
  if (hit) return hit;
  const file = skinPathFor(rootDir, one.id);
  if (!file || !existsSync(file)) return null;
  try {
    const bytes = readFileSync(file);
    if (!bytes.length) return null;
    const entry = {
      bytes,
      mime: one.art.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
      // ⚠️ **内容版本号**(哈希前 10 位):进立绘 URL 当 `?v=` —— 换皮 = 换地址,
      //    浏览器/公网缓存当场失效。与 PWA 图标那次(只换文件不换网址,公网把旧图又发了一天)
      //    是同一个坑;字节本来就缓存在这里,哈希只算一次。
      tag: createHash('sha256').update(bytes).digest('hex').slice(0, 10),
    };
    skinCache.set(one.id, entry);
    return entry;
  } catch {
    return null;
  }
}

/** 一段 JSON(坏了当没有 —— 与 `panel.js` 的 `readJsonMeta` 同一口径)。 */
function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * **只读摸一下另一只 bot 的库**(纯读,一个字节都不写)。
 *
 * @param {string} dbFile `data/<bot>/state.db`
 * @returns {null | {stats: object|null, metas: Array<{key:string,value:string}>}}
 */
export function readOtherBotState(dbFile, { log = null } = {}) {
  if (!dbFile || !existsSync(dbFile)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true, fileMustExist: true });
    const stats = db.prepare('SELECT * FROM stats WHERE id = 1').get() ?? null;
    const metas = db.prepare('SELECT key, value FROM meta').all();
    return { stats, metas };
  } catch (err) {
    // ⚠️ best-effort:读不到不是错误(另一只可能刚重启 / 库在建)——
    //    这一层**绝不许**把面板的渲染带崩(与 D89/D91 那条纪律同一形状)。
    if (typeof log === 'function') log(`旅伴：读另一只的状态库失败（不影响这一只）: ${err?.message ?? err}`);
    return null;
  } finally {
    try { db?.close(); } catch { /* 关不掉就放着 */ }
  }
}

/**
 * **另一只的流水**(只读)。形状与 `stateStore.recentStatsEvents()` **逐字相同** ——
 * 因为下游是同一个 `buildChronicle`(字段名对不上就会静默画出一本空日志)。
 */
export function readOtherBotEvents(dbFile, { limit = 60, log = null } = {}) {
  if (!dbFile || !existsSync(dbFile)) return [];
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true, fileMustExist: true });
    return db.prepare('SELECT * FROM stats_event ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit)))
      .map((row) => ({
        ts: row.ts,
        kind: row.kind,
        satietyDelta: row.satiety_delta,
        healthDelta: row.health_delta,
        moodDelta: row.mood_delta,
        moneyDelta: row.money_delta,
        staminaDelta: row.stamina_delta ?? 0,
        manaDelta: row.mana_delta ?? 0,
      }));
  } catch (err) {
    if (typeof log === 'function') log(`旅伴：读另一只的流水失败（日志会空着）: ${err?.message ?? err}`);
    return [];
  } finally {
    try { db?.close(); } catch { /* 关不掉就放着 */ }
  }
}

/**
 * 把一份 `stats` 行翻成"页面上那五个数值 + 钱"(纯函数)。
 *
 * ⚠️ 与 `panel.js` 的 `buildSnapshot` **同一套口径**(同一个 `VALUE_KEYS`、同一个 `describeValue`),
 *    但**不是同一份代码**:那边读的是当前这只的实时值,这边读的是落库的行。
 *    两边都从 `body-theme.js` 取标签 —— 那才是唯一那份表。
 */
export function valuesFromStats(stats, theme = 'megumin') {
  const spec = getBodyTheme(theme);
  const values = [];
  for (const key of VALUE_KEYS) {
    const raw = Number(stats?.[key]);
    if (!Number.isFinite(raw)) continue;
    values.push({
      key,
      label: labelFor(key, spec) ?? key,
      longLabel: longLabelFor(key, spec) ?? key,
      value: Math.round(raw),
      tier: describeValue(key, raw, spec) || null,
    });
  }
  return values;
}

/** 把一份落库的 `stats` 行翻成病情那一块(与 `panel.js` 的 `conditions` 同一口径)。 */
export function conditionsFrom(stats, stored, now = Date.now()) {
  const health = Number.isFinite(Number(stats?.health)) ? Number(stats.health) : null;
  const mood = Number.isFinite(Number(stats?.mood)) ? Number(stats.mood) : null;
  return {
    summary: stats ? describeCondition({ health, mood, satiety: Number(stats?.satiety) }) : null,
    healthTier: Number.isFinite(health) ? healthTier(health)?.label ?? null : null,
    moodTier: Number.isFinite(mood) ? moodTier(mood)?.label ?? null : null,
    ill: stored ? isIll(stored, now) : false,
    illness: stored?.name ?? stored?.label ?? null,
    illnessId: stored?.id ?? null,
    cause: stored?.cause ?? null,
    endsAt: stored?.endsAt ?? null,
    treated: stored?.treated === true,
  };
}

/**
 * **每只旅伴的立绘状态 → 直接就是 `buildSnapshot` 的那两个参数**(由调用方读磁盘;
 * 纯函数那一层不碰文件系统)。
 *
 * ⚠️ **键名刻意与 `buildSnapshot` 的参数名逐字相同**,装配层用 `...companionSkinState(ROOT_DIR)`
 *    整个展开 —— 形状不许由人手拼。1.120.5 我把两张表塞进一个 `{exists, tags}` 大对象传下去,
 *    下游按 id 取到 undefined → 两张卡都写「立绘还没放进来」(1.121.1 被用户当场抓到)。
 *
 * `companionSkinTags[id]` = 皮肤字节的内容哈希前 10 位 —— 给立绘 URL 当 `?v=` 版本号;
 * **换皮 = 换地址**:浏览器与公网缓存立刻失效,不用等 max-age 过去、也不用用户强刷
 * (D218:另一角色换皮后用户看到的一直是旧图,就是这条链路缺了版本号)。
 *
 * @param {string} rootDir 桥的根目录(`assets/companions/` 在它下面)
 * @returns {{companionSkins: Record<string, boolean>, companionSkinTags: Record<string, string>}}
 */
export function companionSkinState(rootDir) {
  const companionSkins = {};
  const companionSkinTags = {};
  for (const one of COMPANIONS) {
    const skin = readSkin(rootDir, one.id);
    companionSkins[one.id] = Boolean(skin);
    if (skin) companionSkinTags[one.id] = skin.tag;
  }
  return { companionSkins, companionSkinTags };
}

/**
 * **把注册表与事实合起来 → 给页面那一份 `companions`**(纯函数)。
 *
 * @param {object} input
 * @param {{id?: string, name?: string, values?: object[], money?: number|null,
 *   conditions?: object|null, world?: object|null, affinity?: object[]|null,
 *   live?: boolean, note?: string|null}} [input.self] 当前这只 bot(事实由调用方现读)
 * @param {object} [input.others] `{ [id]: {values, money, conditions, world, live, note} }`
 * @param {object|null} [input.skins] `{ [id]: boolean }` —— **立绘文件真的在不在**(由调用方读磁盘);
 *        不传 = 不检查(预览台/单测没有磁盘,不该因此画成"缺图")
 * @param {object|null} [input.skinTags] `{ [id]: string }` —— 立绘的**内容版本号**
 *        (`companionSkinState()` 给的);有就拼进 `artUrl` 的 `?v=`,换皮即换地址
 * @returns {Array<object>} 顺序**跟着注册表**(设定说了算,不是"谁在线谁在前")
 */
export function describeCompanions({ self = null, others = {}, skins = null, skinTags = null } = {}) {
  return COMPANIONS.map((one) => {
    const mine = self && self.id === one.id ? self : null;
    const other = others[one.id] ?? null;
    const facts = mine ?? other ?? null;
    const live = Boolean(facts && facts.live !== false);
    // ⚠️ **立绘到底有没有真的文件,由服务端说了算**(`skins` 由调用方现读磁盘给进来)——
    //    不传就按"有"处理(预览台/单测里没有磁盘,不该因此画一张"缺图"的卡)。
    const hasArt = skins === null || skins === undefined ? true : Boolean(skins[one.id]);
    // 立绘 URL 带**内容版本号**(换皮 = 换地址,缓存当场失效);没给 tag(预览台/单测)就是裸地址
    const skinTag = skinTags ? (skinTags[one.id] ?? null) : null;
    return {
      id: one.id,
      name: one.name,
      fullName: one.fullName,
      theme: one.theme,
      blurb: one.blurb,
      // 立绘:客户端按 id 去 `/api/companions/art/<id>` 取(那张图存不存在由服务端管)
      artUrl: 'api/companions/art/' + one.id + (skinTag ? '?v=' + skinTag : ''),
      // ⚠️ 缺图时**如实说**(卡片会写一行"立绘还没放进来")—— 不假装它已经画好了
      artMissing: !hasArt,
      live,
      note: live ? null : (facts?.note ?? '这一只没在跑'),
      values: facts?.values ?? [],
      money: facts?.money ?? null,
      condition: facts?.conditions ?? null,
      world: facts?.world ?? null,
      affinity: facts?.affinity ?? null,
      // 日志(身体与生活那本流水)—— 跟着"这个人"的第一层→第二层走(2026-10-11 第五轮)
      chronicle: facts?.chronicle ?? null,
    };
  });
}

/**
 * 从"另一只的库"里组装那一份事实(供上面的 `others` 用)。
 *
 * ⚠️ 位置事实走 `world.js` 的 `herWhereabouts`(**不是**在别处再解析一次 `world:her`):
 *    于是"她在哪 / 在做什么 / 在途"这几条判断**只有一份实现**(D159)。
 *
 * @param {string} stateDir `data/` 下的目录名(见注册表的 `stateDir`)
 * @param {string} dataRoot `data/` 的绝对路径
 */
export function readCompanionFacts(stateDir, dataRoot, { now = Date.now(), log = null } = {}) {
  const dbFile = path.join(dataRoot, stateDir, 'state.db');
  const grabbed = readOtherBotState(dbFile, { log });
  if (!grabbed) return { live: false, note: '没在跑（读不到它的状态库）' };
  const { stats, metas } = grabbed;
  const theme = companionById(stateDir)?.theme ?? 'megumin';
  const worldRow = metas.find((row) => String(row.key) === WORLD_HER_KEY);
  const world = herWhereabouts({
    metas: worldRow ? [worldRow] : [],
    scenes: [],
    now,
  });
  const stored = parseJson(metas.find((row) => String(row.key) === 'condition:active')?.value ?? '') ?? null;
  // 日志(身体与生活那本流水):走**同一个** buildChronicle —— 面板那本是她这一只的,
  // 这一本是别人的;两处口径必须一样(否则"她那条 19:36 被投喂、我这条…"会对不上)。
  const chronicle = buildChronicle({ events: readOtherBotEvents(dbFile, { log }), metas, limit: 20 });  // 熟人:与面板同口径(D104:只报档位,不报分)
  const affinity = metas
    .filter((row) => String(row.key).startsWith('affinity:'))
    .map((row) => parseJson(row.value))
    .filter(Boolean)
    .map((row) => ({
      id: String(row.id ?? String(row.name ?? '')),
      // ⚠️ 名字可能是"整条都不可见"的字符(QQ 昵称里很常见)—— 与面板同一条口径:
      //    如实标出来,不假装它有一个名字(见 `people.js` 的 `nameIsInvisible`)。
      name: nameIsInvisible(row.name) ? '（没有名字的人）' : String(row.name ?? ''),
      tier: row.tier?.label ?? affinityTier(row.score ?? 0)?.label ?? null,
    }))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
  return {
    live: true,
    theme,
    values: valuesFromStats(stats, theme),
    money: Number.isFinite(Number(stats?.money)) ? Math.round(Number(stats.money)) : null,
    conditions: conditionsFrom(stats, stored, now),
    world,
    affinity: affinity.length ? affinity : null,
    chronicle,
  };
}
