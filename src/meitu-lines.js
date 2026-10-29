/**
 * 「发N张美图」的**固定句库**(2026-10-23,被拦降档配套)。
 *
 * 为什么单独一个模块:这些基础回话**不走 LLM**（角色未命中可单次模型理解，失败回这里），
 * 但主人可能想自己改措辞 —— 所以句库独立成模块,并支持运行期覆盖文件
 * (`data\meitu-lines.json`,key → 变体数组或单字符串,**按 key 合并进默认表**)。
 *
 * 三条口径:
 *   ① **每条 key 配多条变体**,触发时 `pickLine` 随机选一条 —— 同一种情况连来两次
 *      不至于一字不差(句库是素材库,不是台词表);
 *   ② 文件缺失 = 用默认(不算错);坏 JSON = 用默认 + 带 `error` 字段让调用方 warn;
 *      某个 key 写坏了(不是字符串/数组、或剔完空串剩 0 条)= 只忽略那一个 key;
 *   ③ **运行期覆盖永不抛** —— 坏覆盖不许让指令静默消失；启动时本地三表坏结构则显式报错。
 *
 * 程序内置中性措辞；可选本地三表内容先绑定默认，再叠加原运行期覆盖。
 * blocked_apology / blocked_empty 必须客观说明审核或发送失败。
 */
import fs from 'node:fs';
import { LOCAL_TURN_CONTENT } from './local-turn-content.js';

/** 句库覆盖文件的默认位置(相对 bridge 根目录;`QQBOT_MEITU_LINES` 可改)。 */
export const MEITU_LINES_PATH = 'data/meitu-lines.json';

/** Effective default table; original per-key runtime overrides are still applied later. */
export const DEFAULT_LINES = LOCAL_TURN_CONTENT?.meituLines ?? {
  groupDisabled: ['这个群没有开美图指令'],
  cooldown: ['刚发过，等一会儿再要', '任务还在冷却中，请稍后再试'],
  unregistered: ['这次没能确定你想找的角色。', '还没认出你想找的角色，暂时无法找图。'],
  interpretFailed: ['这次没能把要求转换成找图指令。', '还没理解你想找的图片条件。'],
  noResult: ['没找到符合条件的新图', '查询完成，没有符合条件的新图', '没有更多可发送的新图'],
  sourceDown: ['图源连不上（检查代理）', '图源连接失败，请检查网络或代理'],
  uploadFailed: ['图下好了但发不出去', '图片已下载，但发送失败'],
  // Download failure is not the same as an empty source result.
  downloadFailed: ['找到了图片，但下载失败', '这次未能下载图片'],
  internal: ['（美图指令出错了，看日志）'],
  // Content review blocked the original; a lower-tier replacement was sent.
  blocked_apology: [
    '原图被审核拦下，已换一张普通图片',
    '那张图片未能过审，已改发普通图片',
    '原图被拦截，已补发一张普通图片',
    '审核拦下了原图，已发送替代的普通图片',
    '原图被审核留下，已发送一张普通图片',
  ],
  // One lower-tier retry also failed; do not imply any successful delivery.
  blocked_empty: [
    '原图被拦，替代图片也没能发出去',
    '审核拦截后补发失败，这次一张都没发出去',
    '原图及替代图片都没有送达，这次没有发出图片',
  ],
};

/** 把覆盖值统一成「非空字符串数组」;字符串/字符串数组之外的形状(数字等)= 忽略这个 key。 */
function normalizeVariants(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : null;
  }
  if (!Array.isArray(value)) return null;
  const variants = value.map((item) => String(item ?? '').trim()).filter(Boolean);
  return variants.length > 0 ? variants : null;
}

/**
 * 读句库:**默认表 + 覆盖文件按 key 合并**(文件里写对的 key 覆盖默认,别的 key 不动)。
 *
 * @param {string} filePath 覆盖文件的绝对路径(空/缺失 = 纯默认表)
 * @param {{readFileSync?: Function}} [deps] 测试注入用
 * @returns {{lines: Record<string, string[]>, error?: string}}
 */
export function loadMeituLines(filePath, deps = {}) {
  const read = deps.readFileSync ?? ((file) => fs.readFileSync(file, 'utf8'));
  // 一份**拷贝**:合并绝不能写进 DEFAULT_LINES(模块级单例,写脏了会泄漏到下一次调用)。
  const lines = {};
  for (const [key, variants] of Object.entries(DEFAULT_LINES)) lines[key] = [...variants];

  if (!filePath) return { lines };
  let text;
  try {
    text = read(filePath);
  } catch (err) {
    // 缺失 = 正常(运行期数据不进版本库,第一次部署还没有);用默认,不算错。
    if (err?.code === 'ENOENT') return { lines };
    return { lines, error: `美图句库读不出来: ${err?.message ?? err}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { lines, error: `美图句库不是合法 JSON: ${err?.message ?? err}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { lines, error: '美图句库不是 JSON 对象' };
  }

  for (const [key, value] of Object.entries(parsed)) {
    const variants = normalizeVariants(value);
    if (variants) lines[String(key)] = variants; // 坏 key 只忽略它自己(坏一行不拖垮整张表)。
  }
  return { lines };
}

/**
 * 从句库里随机选一条变体。key 不存在 / 变体为空 = **抛 TypeError** ——
 * 那是程序员错误(key 拼错、句库被清空),要大声,不许静默吐 undefined。
 *
 * @param {string} key
 * @param {Record<string, string[]>} lines
 * @param {() => number} [rng] 默认 Math.random;测试注入用
 * @returns {string}
 */
export function pickLine(key, lines, rng = Math.random) {
  const variants = lines ? lines[key] : undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new TypeError(`pickLine:句库里没有「${String(key)}」的可用变体(检查 key 与句库)`);
  }
  const roll = typeof rng === 'function' ? rng() : Math.random();
  let index = Math.floor(Number(roll) * variants.length);
  if (!Number.isInteger(index) || index < 0 || index >= variants.length) index = 0;
  return variants[index];
}
