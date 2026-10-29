/**
 * **斜下俯瞰的像素渲染器**(D125):把 `pixel-scene.js` 的场景数据画成画面。
 *
 * 这份渲染器有两个出口,用的是**同一套坐标**:
 *   ① `drawScene()` —— 在 Node 里画到内存画布,再编码成 PNG(这样"画面对不对"能被命令查出来);
 *   ② 面板页面里的那段 canvas 代码(同一套规则,搬到浏览器)。
 *
 * ⚠️ **斜视角的四个要点**(不这么做就不是"神界原罪 2/BG3 那种"):
 *   ① 地面按行映射成**梯形**:远处窄、近处宽(缩放在 `projectView()` 里算);
 *   ② 每个地块画成**竖直切片**,所以行与行之间不会出现缝;
 *   ③ **物件有高度**:精灵按脚底对齐到它所在的格子上,再由上往下画(所以能"立"在地面上);
 *   ④ **按深度排序**:近处的东西后画,自然盖住远处的(不然树会穿过她的身体)。
 */
import zlib from 'node:zlib';
import { CAMERA, PALETTE, SPRITES, TILES, cellRect, projectView, spriteFor, spriteUnit } from './pixel-scene.js';

/** 极小的 RGBA 画布(只有这一份实现,浏览器那边用同名的 API 画)。 */
export function createCanvas(width, height) {
  const data = new Uint8Array(width * height * 4);
  const api = {
    width,
    height,
    data,
    fill(x, y, w, h, hex) {
      if (!hex) return;
      const [r, g, b] = hexToRgb(hex);
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * width + xx) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
      }
    },
    /** 梯形填充:一行地块就是一条梯形(左边界和右边界随 y 线性变)—— 这是斜视角的关键。 */
    trapezoid(xTopL, xTopR, yTop, xBotL, xBotR, yBot, hex) {
      if (!hex) return;
      const [r, g, b] = hexToRgb(hex);
      const top = Math.max(0, Math.floor(yTop));
      const bot = Math.min(height, Math.ceil(yBot));
      for (let yy = top; yy < bot; yy += 1) {
        const t = (yy - yTop) / Math.max(1, yBot - yTop);
        const l = Math.round(xTopL + (xBotL - xTopL) * t);
        const rr = Math.round(xTopR + (xBotR - xTopR) * t);
        for (let xx = Math.max(0, l); xx < Math.min(width, rr); xx += 1) {
          const i = (yy * width + xx) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
      }
    },
    blend(x, y, w, h, hex, alpha) {
      if (!hex) return;
      const [r, g, b] = hexToRgb(hex);
      for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(height, Math.ceil(y + h)); yy += 1) {
        for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(width, Math.ceil(x + w)); xx += 1) {
          const i = (yy * width + xx) * 4;
          data[i] = Math.round(data[i] * (1 - alpha) + r * alpha);
          data[i + 1] = Math.round(data[i + 1] * (1 - alpha) + g * alpha);
          data[i + 2] = Math.round(data[i + 2] * (1 - alpha) + b * alpha);
          data[i + 3] = 255;
        }
      }
    },
    line(x0, y0, x1, y1, hex) {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let s = 0; s <= steps; s += 1) {
        api.fill(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, 1, 1, hex);
      }
    },
  };
  return api;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 手写 PNG(真彩色 + alpha,无过滤)。只用内置 zlib。 */
export function encodePng(canvas) {
  const { width, height, data } = canvas;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])) >>> 0);
    return Buffer.concat([len, typeBuf, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** 天色(按 timeOfDay 给天空/远山/滤镜)。 */
function skyFor(timeOfDay) {
  if (timeOfDay === 'night') return { sky: '#1b2340', far: '#2a3355', haze: 'rgba(20,20,45,0.42)' };
  if (timeOfDay === 'dusk') return { sky: '#e0906a', far: '#a86a7a', haze: 'rgba(200,90,60,0.18)' };
  return { sky: '#8fc6e8', far: '#6fa8c8', haze: null };
}

/**
 * **精灵不再逐像素发**(D130)。
 *
 * ⚠️ 原来她那张 32×48 的图按"每个像素一条绘制指令"发下去 ——
 *    unit=2 时是 **1920 条指令**(约 115 KB 的 JSON)。而它本来只是**几十行字符**。
 *    → 改成发 `{sp:'sprite', cells:[…字符串…], x, y, unit, chars:[…]}`,
 *    页面按字符查调色板自己展开。**形状与配色仍然只有一份出处**(那张字符表),
 *    只是换了个更省的传输形式。
 */
function spriteOp(rows, drawX, drawY, unit) {
  const chars = [];
  const map = new Map();
  const frame = rows.map((row) => {
    let line = '';
    for (const ch of row) {
      if (!map.has(ch)) { map.set(ch, chars.length); chars.push(ch); }
      line += String.fromCharCode(65 + map.get(ch));   // 用 A/B/C… 代替原字符,再省一点
    }
    return line;
  });
  return { op: 'sprite', x: drawX, y: drawY, unit, chars, frame };
}

/**
 * **地面按行合并**(D130):同一行里**连续同类地块**合成一条。
 *
 * 原来是"一格一条梯形" —— 48×18 = 864 条,而一整行常常是同一个类型。
 * 合并之后通常只剩几十条;页面按 `kind` 查 `TILES` 拿颜色,**投影数学仍在服务端算**。
 */
function tileRuns(map, view, viewWidth) {
  const runs = [];
  for (let y = 0; y < map.height; y += 1) {
    const band = view.bands[y];
    const rowWidth = viewWidth * band.scale;
    const rowLeft = (viewWidth - rowWidth) / 2;
    const cellW = rowWidth / map.width;
    const nextBand = view.bands[y + 1];
    const nextRowWidth = nextBand ? viewWidth * nextBand.scale : rowWidth;
    const nextLeft = (viewWidth - nextRowWidth) / 2;
    const nextCellW = nextRowWidth / map.width;
    let start = 0;
    for (let x = 1; x <= map.width; x += 1) {
      if (x < map.width && map.tiles[y][x] === map.tiles[y][start]) continue;
      runs.push({
        op: 'tiles',
        kind: map.tiles[y][start],
        from: start,
        to: x,
        a: [rowLeft + start * cellW, band.yTop],
        b: [rowLeft + x * cellW, band.yTop],
        c: [nextLeft + x * nextCellW, band.yTop + band.height],
        d: [nextLeft + start * nextCellW, band.yTop + band.height],
      });
      start = x;
    }
  }
  return runs;
}

/**
 * **产出绘制指令**(纯函数;D130 起为"省流量"改过形状)。
 *
 * ⚠️ 这一版的重点是**小**:用户 2026-10-05 报"网址难打开",量出来 `/api/state`
 *    有 **254 KB**、每 5 秒一次。改动:
 *      · 精灵发**字符网格**(她那张图从 1920 条指令降到 1 条);
 *      · 地面发**行合并的 tiles**(864 条 → 几十条);
 *      · 水波/滤镜照旧。
 *    投影与合并都在服务端算完,页面只执行 —— "两视图同源"那条纪律没变。
 */
export function drawOps(scene, { viewWidth = CAMERA.viewWidth, horizon = CAMERA.horizon, zoom = 1 } = {}) {
  const map = scene.map;
  const view = projectView(map, { viewWidth, horizon, zoom: scene.zoom ?? zoom });
  const height = view.groundTop + view.groundHeight + 6;
  const colors = skyFor(scene.timeOfDay);
  const ops = [];
  const fill = (x, y, w, h, color) => { if (color) ops.push({ op: 'fill', x, y, w, h, color }); };
  const blend = (x, y, w, h, color, alpha) => { if (color && alpha > 0) ops.push({ op: 'blend', x, y, w, h, color, alpha }); };
  const line = (x0, y0, x1, y1, color) => { if (color) ops.push({ op: 'line', x0, y0, x1, y1, color }); };

  // ① 天空 + 远景(先整屏铺底,免得地面行比画面窄时露黑角)
  fill(0, 0, viewWidth, height, colors.sky);
  fill(0, 0, viewWidth, Math.max(view.groundTop, 1), colors.sky);
  fill(0, Math.max(0, view.groundTop - 10), viewWidth, 10, colors.far);
  for (const c of scene.clouds ?? []) {
    const cx = Math.round(c.x * 6);
    blend(cx, 6, 30, 5, '#ffffff', 0.45);
    blend(cx + 8, 4, 16, 3, '#ffffff', 0.45);
  }

  // ② 地面:按行合并成 runs(页面按 kind 查 TILES 拿颜色)
  for (const run of tileRuns(map, view, viewWidth)) ops.push(run);

  // ③ 水波:⚠️ **按行合并成一条**(原来每格一条 = 400+ 条指令,这是第二大块)
  for (let y = 0; y < map.height; y += 1) {
    const band = view.bands[y];
    if (band.height < 2) continue;
    const rowWidth = viewWidth * band.scale;
    const rowLeft = (viewWidth - rowWidth) / 2;
    const cellW = rowWidth / map.width;
    let start = -1;
    for (let x = 0; x <= map.width; x += 1) {
      const isWater = x < map.width && map.tiles[y][x] === 'water';
      if (isWater && start === -1) start = x;
      if (!isWater && start !== -1) {
        // 这一段水面:按相位在行内错开画一道细波纹(整段一条指令)
        const from = rowLeft + start * cellW + (scene.phase % 4);
        const width = Math.max(2, (x - start) * cellW - 4);
        blend(from, band.yTop + 1, width, 1, '#ffffff', 0.26);
        start = -1;
      }
    }
  }

  // ④ 物件与她:按深度排序(近的后画,自然盖住远的)—— 发**字符网格**,不逐像素
  const drawables = [];
  for (const prop of scene.props ?? []) {
    drawables.push({ depth: prop.y, kind: 'sprite', sprite: prop.sprite, x: prop.x, y: prop.y });
  }
  drawables.push({ depth: scene.hero.y, kind: 'hero', sprite: scene.hero.sprite, x: scene.hero.x, y: scene.hero.y });
  drawables.sort((a, b) => a.depth - b.depth || a.x - b.x);

  let heroScreen = null;
  const unit = spriteUnit(view, map, scene.zoom ?? 1);
  for (const item of drawables) {
    const rect = cellRect(view, map, item.x, item.y);
    if (!rect) continue;
    const rows = spriteFor(item.sprite);
    if (!rows) continue;
    const band = view.bands[item.y];
    const spriteW = rows[0].length * unit;
    const footY = band.yTop + band.height;
    const drawX = Math.round(rect.left + rect.width / 2 - spriteW / 2);
    const drawY = Math.round(footY - rows.length * unit);
    blend(drawX + unit, footY - Math.max(1, Math.floor(unit / 3)), spriteW - unit * 2, Math.max(1, Math.floor(unit / 3)), '#000000', 0.26);
    ops.push(spriteOp(rows, drawX, drawY, unit));
    if (item.kind === 'hero') heroScreen = { x: drawX, y: drawY, w: spriteW, unit, row: item.y };
  }

  // ⑤ 鱼竿与钓线
  if (scene.rod && scene.bobber && heroScreen) {
    const rodFromX = heroScreen.x + heroScreen.w - heroScreen.unit * 2;
    const rodFromY = heroScreen.y + Math.round(heroScreen.unit * 10);
    const bob = cellRect(view, map, scene.bobber.x, scene.bobber.y);
    if (bob) {
      const bx = Math.round(bob.left + bob.width / 2);
      const band = view.bands[scene.bobber.y];
      const by = Math.round(band.yTop + band.height / 2);
      line(rodFromX - heroScreen.unit * 3, rodFromY - heroScreen.unit * 4, rodFromX, rodFromY, PALETTE.l);
      line(rodFromX - heroScreen.unit * 3, rodFromY - heroScreen.unit * 4 - 1, rodFromX, rodFromY - 1, PALETTE.L);
      line(rodFromX - heroScreen.unit * 3, rodFromY - heroScreen.unit * 4, bx, by, '#efe6c8');
      fill(bx - 2, by - 3, 4, 5, PALETTE.R);
      fill(bx - 2, by - 3, 4, 2, PALETTE.W);
    }
  }

  // ⑥ 天色滤镜
  if (scene.timeOfDay === 'dusk') blend(0, 0, viewWidth, height, '#c85a3c', 0.16);
  if (scene.timeOfDay === 'night') blend(0, 0, viewWidth, height, '#14142d', 0.4);

  return { width: viewWidth, height, ops };
}

/**
 * **把绘制指令压成"短数组"**(D130)。
 *
 * ⚠️ 为什么必须压:用户 2026-10-05 报"网址变得这么难打开"。
 *    量出来是这样:`/api/state` **254 KB**,每 5 秒拉一次 —— 手机上就是 50 KB/s 常驻流量。
 *    而其中一大半是**她那张图的每一个像素一条指令**(32×48 × unit² = 1920 条)。
 *
 * 压缩办法(不引任何库,纯 JSON 友好的短数组):
 *   · 键名换成位置:`{op:'fill',x,y,w,h,color}` → `['f',x,y,w,h,'#rrggbb']`
 *   · **颜色去重**:`'#1d1a22'` 每次出现 9 字节,改成调色板下标 `1` —— 这是最大的一块;
 *   · 像素合并:同一行连续的同色像素合成一条 `fill`(她那张图能少一大截)。
 *
 * 解压(`expandPlan`)在页面里跑,所以**页面仍然是"只执行指令",不含投影数学**。
 */
/** 地块颜色表(页面也要用:紧凑指令里的 `tiles` 只带地块名,颜色由这张表查)。 */
export const TILE_COLOR_TABLE = Object.freeze(
  Object.fromEntries(Object.entries(TILES).map(([k, v]) => [k, v.color])),
);

export function packPlan(plan) {
  const colors = [];
  const colorIndex = new Map();
  const idx = (hex) => {
    if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); }
    return colorIndex.get(hex);
  };
  const ops = [];
  for (const op of plan.ops) {
    if (op.op === 'fill') ops.push([0, op.x, op.y, op.w, op.h, idx(op.color)]);
    else if (op.op === 'blend') ops.push([1, op.x, op.y, op.w, op.h, idx(op.color), op.alpha]);
    else if (op.op === 'line') ops.push([2, op.x0, op.y0, op.x1, op.y1, idx(op.color)]);
    // ⚠️ `tiles` 只带**地块名**(颜色在页面查表),`sprite` 只带**字符网格** —— 这是省下来的大头
    else if (op.op === 'tiles') ops.push([3, ...op.a, ...op.b, ...op.c, ...op.d, op.kind]);
    else if (op.op === 'sprite') ops.push([4, op.x, op.y, op.unit, op.chars, op.frame]);
  }
  return { v: 1, width: plan.width, height: plan.height, colors, ops };
}

/** 像素合并:同一行里连续的同色小方块合成一条(只对 `fill` 生效)。 */
export function mergeRuns(ops) {
  const out = [];
  const byRow = new Map();
  const rest = [];
  for (const op of ops) {
    if (op.op !== 'fill' || op.h !== op.w) { rest.push(op); continue; }
    const key = `${op.y}|${op.h}|${op.color}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(op);
  }
  for (const list of byRow.values()) {
    list.sort((a, b) => a.x - b.x);
    let run = null;
    for (const op of list) {
      if (run && op.x === run.x + run.w) { run.w += op.w; continue; }
      run = { ...op };
      out.push(run);
    }
  }
  // ⚠️ 顺序会影响覆盖关系,所以"合并结果"要按原顺序往回插:
  //    这里用一条保守规则 —— 合并后的指令放回**它第一条**原来的位置。
  const order = new Map();
  ops.forEach((op, i) => order.set(op, i));
  out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return [...out, ...rest].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
/** 把绘制指令执行到一张内存画布上(Node 侧出 PNG 用)。 */
export function applyOps(plan) {
  const cv = createCanvas(plan.width, plan.height);
  // ⚠️ `tiles`(行合并)与 `sprite`(字符网格)是 D130 为省流量引入的**紧凑指令**,
  //    这里要按和页面**完全一样**的规则展开($TILES / $PALETTE 都在本模块可见)。
  const spriteRowsCache = new Map();
  for (const op of plan.ops) {
    if (op.op === 'fill') cv.fill(op.x, op.y, op.w, op.h, op.color);
    else if (op.op === 'blend') cv.blend(op.x, op.y, op.w, op.h, op.color, op.alpha);
    else if (op.op === 'line') cv.line(op.x0, op.y0, op.x1, op.y1, op.color);
    else if (op.op === 'tiles') {
      const colors = tileRunColors(op);
      cv.trapezoid(op.a[0], op.b[0], op.a[1], op.d[0], op.c[0], op.d[1], colors);
    } else if (op.op === 'sprite') {
      for (let sy = 0; sy < op.frame.length; sy += 1) {
        const line = op.frame[sy];
        for (let sx = 0; sx < line.length; sx += 1) {
          const ch = op.chars[line.charCodeAt(sx) - 65];
          const color = PALETTE[ch];
          if (color) cv.fill(op.x + sx * op.unit, op.y + sy * op.unit, op.unit, op.unit, color);
        }
      }
    }
  }
  return cv;
}

/** `tiles` 指令的颜色(查地块表)。 */
function tileRunColors(op) {
  return (TILES[op.kind] ?? TILES.grass).color;
}

/** 兼容入口:直接得到画布(内部就是 `applyOps`)。 */
export function drawScene(scene, opts = {}) {
  return applyOps(drawOps(scene, opts));
}

/** 整数倍放大(非整数倍会让像素错位)。 */
export function scaleCanvas(cv, zoom) {
  if (zoom <= 1) return cv;
  const big = createCanvas(cv.width * zoom, cv.height * zoom);
  for (let y = 0; y < cv.height; y += 1) {
    for (let x = 0; x < cv.width; x += 1) {
      const i = (y * cv.width + x) * 4;
      const hex = `#${[cv.data[i], cv.data[i + 1], cv.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      big.fill(x * zoom, y * zoom, zoom, zoom, hex);
    }
  }
  return big;
}
