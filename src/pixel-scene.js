/**
 * **像素场景层**(D124/D125):方格地图 → **斜下俯瞰**的画面数据 + 文字视图。
 *
 * ## 两条定下来的规矩
 *
 * 1. **像素是渲染,网格才是真相**:`buildPixelScene()` 的输入**就是** `snapshot()` 那一份状态,
 *    所以"界面上的她"和"账本里的她"不可能对不上(见 `docs\03` D124)。
 * 2. **视角是斜下俯瞰(3/4),不是正俯视**(D125,用户要"神界原罪 2 / BG3 那种"):
 *    正俯视看不出"人坐着""树有高度";斜视角里**远处窄、近处宽**(梯形),物体有高度。
 *
 * ## 斜视角怎么算(不引 3D 库)
 *
 * 这是一个**假的透视**:地面按"行"从远到近映射到屏幕,每行是一条**水平带**,
 * 行内每格是一条**竖直切片**。缩放只随深度变,所以:
 *   - 完全决定论(同一个 tick 画出来一样,能进测试);
 *   - 整数友好(像素不会歪);
 *   - 写起来二十行,不用矩阵。
 *
 * ```
 * 远处(小)  ┌──────────┐   horizon
 *          └────────────┘
 *        ┌────────────────┐
 *        └────────────────┘
 * 近处(大)┌────────────────────┐
 *        └────────────────────┘
 * ```
 */

import { INFRA_CONTENT } from './local-infra-content.js';

/** Pixel assets are JSON data; absent local content uses neutral geometric markers.
 * Legacy exported sprite names are stable renderer keys, not built-in character art. */
export const PALETTE = Object.freeze(INFRA_CONTENT.pixel.palette);
export const MEGUMIN_SPRITE = Object.freeze(INFRA_CONTENT.pixel.sprites.MEGUMIN_SPRITE);
export const TREE_SPRITE = Object.freeze(INFRA_CONTENT.pixel.sprites.TREE_SPRITE);
export const BIG_TREE_SPRITE = Object.freeze(INFRA_CONTENT.pixel.sprites.BIG_TREE_SPRITE);
export const REED_SPRITE = Object.freeze(INFRA_CONTENT.pixel.sprites.REED_SPRITE);
export const BUCKET_SPRITE = Object.freeze(INFRA_CONTENT.pixel.sprites.BUCKET_SPRITE);

/** 名字 → 精灵表。 */
export const SPRITES = Object.freeze({
  megumin: MEGUMIN_SPRITE,
  tree: TREE_SPRITE,
  bigTree: BIG_TREE_SPRITE,
  reed: REED_SPRITE,
  bucket: BUCKET_SPRITE,
});

/**
 * **八方向**(D128)。
 *
 * ## 为什么要"八方向",以及业界怎么省这笔钱
 *
 * 斜视角里"她面朝哪"必须能看出来,否则"朝东北钓鱼"这种画面就表达不了。
 * 但**八个方向 × N 帧**逐张手绘是美术预算的黑洞。业界的做法是
 * ([Voidless 的 4/8 向教程](https://voidless.dev/tutorials/characters-sprites/generate-sprite-rotations/)、
 * [pixelkiln](https://github.com/gfargo/pixelkiln/blob/main/docs/CHARACTERS.md)):
 *
 *   ① 只手绘**基准方向**(通常 3~5 个:南、东/西、北、以及一两个对角);
 *   ② 其余用**镜像**推出来 —— 因为角色左右对称,`西 = 东 水平翻转`;
 *   ③ ⚠️ **光照必须统一**:镜像只翻形状,如果原图光源在右上,
 *      翻出来的"西"就得把高光挪到左上,否则光会从两边来(一眼假)。
 *
 * 我们更省一层:**形状完全由代码的变换生成**(不额外画图),于是"八个方向"是
 * **一个有测试的纯函数**,而不是八张要同步维护的图。
 *
 * 光照约定:**光来自右上**(和河面反光一致)。所以镜像时把
 * 亮部字符 `h/Q/k/W` 与暗部字符 `H/P/p/K` **对调** —— 这就是"镜像之后重新打光"。
 */
export const DIRECTIONS = Object.freeze(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);

/** 亮度/暗部成对出现,镜像时对调(实现"重新打光")。 */
const LIGHT_SWAP = Object.freeze({ h: 'H', H: 'h', Q: 'P', P: 'Q', k: 'K', K: 'k' });

/** 水平镜像一张精灵(纯函数)。 */
export function mirrorSprite(rows) {
  return rows.map((row) => [...row].reverse().join(''));
}

/** 镜像并**重新打光**(把亮部与暗部对调,免得两边都有高光)。 */
export function mirrorLit(rows) {
  return mirrorSprite(rows).map((row) => [...row].map((ch) => LIGHT_SWAP[ch] ?? ch).join(''));
}

/**
 * **某个方向的精灵**(纯函数)。
 *
 * ⚠️ 现在的基准图是**右侧 3/4 背影**(她钓鱼时的样子),所以:
 *   - `e / se / ne` → 基准图本身(她本来就朝右下);
 *   - `w / sw / nw` → 镜像 + 重新打光;
 *   - `n / s` → 也走镜像家族(正面/背面还没有专门画;**如实标注**,不假装有)。
 * 真要更讲究,就给 `n / s` 各手绘一张基准图 —— 接口已经留好了。
 */
export function spriteForDirection(dir, base = MEGUMIN_SPRITE) {
  return (dir === 'w' || dir === 'sw' || dir === 'nw') ? mirrorLit(base) : base;
}

/** 方向的中文名(日志/调试用)。 */
export const DIRECTION_CN = Object.freeze({
  n: '北', ne: '东北', e: '东', se: '东南', s: '南', sw: '西南', w: '西', nw: '西北',
});

/**
 * **相机**(D125):斜下俯瞰的取景与比例,**所有渲染都读这一份**。
 *
 * ⚠️ 为什么要有它:取景参数散在渲染器里,就会出现"地图改了、精灵还是旧比例"这种错
 *    (这一版我连改三轮才把比例调对)。集中一处之后,**测试能直接断言比例**
 *    ——比如"她大约占画面十分之一"(用户 2026-10-04 明确要求)。
 */
export const CAMERA = Object.freeze({
  /** 内部画布宽度(浏览器那边按它等比放大)。 */
  viewWidth: 640,
  /** 地平线以上的天空高度:斜视角里只留远处一条。 */
  horizon: 72,
  /** 地面占的高度(越大地面的"进深"越被拉开)。 */
  groundRatio: 0.64,
  /** 指数的幂:1.2 让远处的行仍有厚度(1.5 会把远处压成一条线,天空就没了)。 */
  easePower: 1.2,
  /** 近处那一行比远处宽多少(会被 `minScale/maxScale` 夹住)。 */
  depthStretch: 0.9,
  /** ⚠️ 缩放的上下限:不夹住,近处的行会铺到画面外(见 `projectView` 的注释)。 */
  minScale: 0.9,
  maxScale: 1.65,
  /**
   * **精灵的像素单位**(= 屏幕上几个像素)。
   *
   * ⚠️ 定成 **2**:她那张 32×48 的图于是在屏幕上占 **64×96** 像素 ——
   *    在 640 宽的画面上约占 **10%**,正好是用户要的"占全画面 1/10",
   *    而且**大到能看清服装特征**(红裙/金边/腰带/黑颈圈/过膝袜)。
   * ⚠️ 前面三版把它做成"跟着格宽/行高走",结果她要么是巨人要么小到看不清 ——
   *    **精灵该定义在屏幕尺度上,不是世界尺度上**(这一条写在这儿,别再改回去)。
   */
  spriteUnit: 2,
});

/** 地块表:每格带**属性**(交互规则读属性,不读名字)。 */
export const TILES = Object.freeze({
  grass: { glyph: '·', color: '#4f8f3a', walk: true, breakable: false, flammable: true, texture: true, name: '草地' },
  soil: { glyph: ',', color: '#6b5433', walk: true, breakable: true, flammable: false, texture: true, name: '泥土' },
  water: { glyph: '≈', color: '#2f6b8f', walk: false, breakable: false, flammable: false, name: '河水' },
  rock: { glyph: '▲', color: '#6f6a7a', walk: false, breakable: true, flammable: false, texture: true, name: '石头' },
  bridge: { glyph: '=', color: '#8a5a2b', walk: true, breakable: true, flammable: true, name: '木板' },
  tree: { glyph: '♣', color: '#2f6b3a', walk: false, breakable: true, flammable: true, name: '树' },
  fence: { glyph: '#', color: '#7a6a52', walk: false, breakable: true, flammable: true, name: '栅栏' },
  sky: { glyph: ' ', color: '#8fc6e8', walk: false, breakable: false, flammable: false, texture: false, name: '天空' },
});

/**
 * **河岸**(斜视角的取景,照用户 2026-10-04 的要求):
 *   · 画面 3/4 是**面前那条河**(远处一条,近处一条);
 *   · 1/4 是**岸边**,她在岸上**坐在树下**钓鱼;
 *   · 树在**左下角**;她**斜背对画面**、露出半边身体和脸。
 *
 * 图上:`~`水 `.`天空 `#`草地 `,`泥 `T`树位(精灵另画)`G`大树位 `B`木桶位 `r`芦苇位
 */
const RIVERSIDE_ROWS = [
  '................................................',   // 0  天空(远处一条)
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',   // 1  远处的河(画面约 1/3)
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~nn~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  ',,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',   // 7  岸:泥
  ',,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  '################################################',   // 10 岸:草
  '######G#########################################',   // 11 草(大树在**左下角**)
  '################################B###############',   // 12 木桶在她右边
  '################################################',
  '################################################',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',   // 15 近处的河(画面下缘约 1/4)
  '~~~~~~~~nn~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
];

const TILE_BY_CHAR = Object.freeze({
  ' ': 'sky',
  // ⚠️ 线稿里 `.` 表示**天空**(它在最上面那几行) —— 这个映射写错,
  //    "最上面一行"就会变成草地(现场就这么翻过车:测试直接抓住)。
  '.': 'sky',
  '#': 'grass',
  ',': 'soil',
  '~': 'water',
  'n': 'water',
});

/**
 * 解析线稿 → 方格地图(纯函数)。
 * ⚠️ 线稿里的 `T`/`B` 是**物件位**,不是地块:它们进 `props`,让精灵盖在地块上。
 */
export function parseMap(rows) {
  const width = Math.max(...rows.map((row) => [...row].length));
  const props = [];
  const tiles = rows.map((row, y) => {
    const line = [...row];
    while (line.length < width) line.push('.');
    return line.map((ch, x) => {
      if (ch === 'T') { props.push({ sprite: 'tree', x, y }); return 'grass'; }
      if (ch === 'G') { props.push({ sprite: 'bigTree', x, y }); return 'grass'; }
      if (ch === 'B') { props.push({ sprite: 'bucket', x, y }); return 'grass'; }
      if (ch === 'r') { props.push({ sprite: 'reed', x, y }); return 'water'; }
      return TILE_BY_CHAR[ch] ?? 'grass';
    });
  });
  return { width, height: tiles.length, tiles, props };
}

/**
 * **场景数据**(纯函数):把世界状态翻译成"这一帧该画什么"。
 * 两种视图(文字 / 像素)共用这一份 —— 这是这一层的全部意义。
 *
 * @param {object} input
 * @param {object|null} [input.fishing] 钓鱼状态(来自快照;没有就是没在钓)
 * @param {number} [input.tick] 决定论的动画相位(水波/她呼吸靠它动)
 * @param {string} [input.timeOfDay] 'day' | 'dusk' | 'night'
 * @param {number} [input.zoom] 机位远近(1 = 默认)
 */
export function buildPixelScene({ fishing = null, tick = 0, timeOfDay = 'day', zoom = 1 } = {}) {
  const map = parseMap(RIVERSIDE_ROWS);
  // ⚠️ 她坐在河岸上钓鱼(坐标算出来的,不是画死的)。
  //    ⚠️ 站位必须取**靠中间**的列:斜视角里近处的行被放大,左边缘会跑到画面外
  //    (`projectView` 里那段注释记着这件事)。
  //    **朝向**:用户 2026-10-04 要"她朝**东北**方向在左下角河边钓鱼" ——
  //    面朝水面(东北),而人站在画面左侧,于是画面读起来就是"在左下角、朝右上钓鱼"。
  const hero = { x: 16, y: 11, sprite: 'megumin:ne', facing: 'ne' };
  const casting = Boolean(fishing);

  // 竿梢在她手边,浮标甩到**东北方向的河面**上(按相位轻微上下漂)
  const bobber = casting
    ? { x: 24 + ((tick >> 2) % 2), y: 3 + ((tick >> 3) % 2) }
    : null;

  return {
    map,
    hero,
    bobber,
    rod: casting ? { x: hero.x + 1, y: hero.y - 3 } : null,
    timeOfDay,
    zoom,
    phase: tick % 16,
    clouds: [{ x: (tick >> 1) % (map.width + 10) - 5, y: 0 }],
    props: map.props,
  };
}

/** 文字视图(调试 / 无 JS 兜底):她的 `@`、浮标 `o`、物件用自己的字形。 */
export function renderSceneText(scene) {
  const { map, hero, bobber } = scene;
  const lines = [];
  for (let y = 0; y < map.height; y += 1) {
    const row = [];
    for (let x = 0; x < map.width; x += 1) {
      row.push((TILES[map.tiles[y][x]] ?? TILES.grass).glyph);
    }
    lines.push(row);
  }
  for (const prop of scene.props ?? []) {
    if (!lines[prop.y]) continue;
    lines[prop.y][prop.x] = prop.sprite === 'bigTree' ? 'G' : prop.sprite === 'tree' ? 'T' : prop.sprite === 'bucket' ? 'B' : 'r';
  }
  if (bobber && lines[bobber.y]) lines[bobber.y][bobber.x] = 'o';
  if (lines[hero.y]) lines[hero.y][hero.x] = '@';
  return lines.map((row) => row.join('')).join('\n');
}

/**
 * **斜下俯瞰的投影**(纯函数,给渲染器用)。
 *
 * 屏幕宽度固定 `viewWidth`;地面每一行是一条水平带:
 *   - `horizon` 之上是天空;
 *   - 越靠下(越近)的行**越厚、每格越宽**;
 *   - 用 `ease = depth^1.5` 让远处压扁一点(视觉上更像斜视角,而不是均匀拉伸)。
 *
 * ⚠️ 它**只依赖地图尺寸与参数**,所以`同一份场景 + 同一组参数 = 同一套坐标`,
 *    可以拿来做测试(比如"物件必须落在地面带里""近处的格子比远处宽")。
 */
export function projectView(map, { viewWidth = CAMERA.viewWidth, horizon = CAMERA.horizon, zoom = 1 } = {}) {
  const rows = map.height;
  const totalDepth = rows - 1;
  const groundTop = horizon;
  const groundHeight = Math.round((viewWidth * CAMERA.groundRatio) / zoom);
  const bands = [];
  for (let y = 0; y < rows; y += 1) {
    const depth = totalDepth === 0 ? 0 : y / totalDepth;          // 0 = 最远
    const ease = Math.pow(depth, CAMERA.easePower);
    const top = Math.round(groundTop + groundHeight * ease);
    // ⚠️ **缩放要夹在 [minScale, maxScale] 之间**(D125 现场教训):
    //    不夹的话近处的行能到 2.8 倍宽,整行铺到画面之外 ——
    //    "左边缘在 -190 像素"于是精灵全被推到画面外(这一版为此白改了三轮)。
    const scale = Math.min(CAMERA.maxScale, Math.max(CAMERA.minScale, 0.8 + depth * CAMERA.depthStretch));
    bands.push({ row: y, yTop: top, scale, depth });
  }
  for (let y = 0; y < rows; y += 1) {
    const next = bands[y + 1]?.yTop ?? (groundTop + groundHeight + Math.round(groundHeight / rows) * 2);
    bands[y].height = Math.max(1, next - bands[y].yTop);
  }
  return { viewWidth, horizon, groundTop, groundHeight, bands, zoom };
}

/**
 * **精灵的像素单位**(纯函数,渲染器与测试共用):
 * ⚠️ 它**不跟地面行高走** —— 斜视角里最下面一行地面能有一百多像素高,
 *    拿它当单位会把精灵放成巨人(这一版踩了两次)。改成"跟**格宽**挂钩"。
 */
export function spriteUnit(view, map, zoom = 1) {
  return Math.max(1, Math.round(CAMERA.spriteUnit / zoom));
}

/** 某一行里某格占的屏幕区间(纯函数)。 */
export function cellRect(view, map, x, y) {
  const band = view.bands[y];
  if (!band) return null;
  const rowWidth = view.viewWidth * band.scale;
  const cellW = rowWidth / map.width;
  const left = (view.viewWidth - rowWidth) / 2 + x * cellW;
  return { left, width: cellW, top: band.yTop, height: band.height };
}

/**
 * **取精灵表**(渲染器与测试共用;D128 起支持**方向**)。
 *
 * 名字可以是 `'megumin'`(用基准图),也可以是 `'megumin:ne'` ——
 * 后者按方向现算(镜像 + 重新打光,见 `spriteForDirection`)。
 * ⚠️ 于是"八个方向的她"**不是八张图**,而是一个可测的纯函数。
 */
export function spriteFor(name) {
  const [base, dir] = String(name ?? '').split(':');
  if (dir && base === 'megumin') return spriteForDirection(dir);
  return SPRITES[base] ?? null;
}
