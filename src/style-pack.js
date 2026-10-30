/**
 * 风格包加载器（S1 可选风格，2026-10-30）。
 *
 * 一个风格包 = `content/styles/<id>/style.json`（C 区数据，永不执行代码）。本模块只做
 * 四件事：目录发现、严格 schema 校验、按 id 取包、把包的表现数据整理成策略对象。
 *
 * 形状照既有严格数据包先例（`src/content-pack.js` / `src/world-pack.js`，2026-10-29/30）：
 * - 零第三方依赖，只用 `node:fs`；读取函数可注入（离线测试用合成夹具）。
 * - **fail closed**：坏 JSON / 坏 schema / id 与目录不一致 / 重复 id / 未知显式 id → 抛错；
 *   错误信息只含包 id 与固定错误码，不含内容片段、绝对路径或原始解析器消息。
 * - 没有 `content/styles/` 目录 → 返回 `null`（旧安装行为：调用方继续用现行默认）。
 * - **只收表现数据**：固定 standing notes、mood 长度策略、标点保留、拆条策略、emoji
 *   开关与概率上限、nudges。账号/密钥/路径/预算/功能授权/工具/权限字段无法表达 ——
 *   每一层的键集合都是精确白名单，多一个键就是 `schema`/`data` 错误，绝不静默忽略。
 * - 角色轴（自称/性格/世界观/技能场景）不在这里：风格包是**媒介表达**数据，
 *   不携带角色内容，也不得据此授予功能或权限。
 * - 本模块只负责加载数据；config/index 已接入实例选择与消费，数据层不反向依赖运行入口。
 */
import { readFileSync, readdirSync } from 'node:fs';

const DEFAULT_DIR = new URL('../content/styles/', import.meta.url);
const STYLE_FILE = 'style.json';
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
/** 只认非空、互不重复、不含控制字符的字符串表（standing notes / nudges）。 */
const uniqueTexts = (value) => Array.isArray(value) && value.length > 0
  && value.every((item) => isText(item) && !CONTROL_CHARS.test(item))
  && new Set(value).size === value.length;
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const keysAre = (value, required, optional = []) => isObject(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const TOP_KEYS = ['schemaVersion', 'id', 'label', 'data'];
const DATA_KEYS = ['standingNotes', 'moodLength', 'punctuation', 'split', 'emoji', 'nudges'];
const MOOD_LENGTH_KEYS = ['maxCharsFactor', 'maxSentences'];

/** `moodLength`：两个子字段都可选；只放"怎么缩放/封顶"，不携带任何情绪内容。 */
function validMoodLength(value) {
  if (!keysAre(value, [], MOOD_LENGTH_KEYS)) return false;
  if (Object.hasOwn(value, 'maxCharsFactor')
    && !(finite(value.maxCharsFactor) && value.maxCharsFactor > 0)) return false;
  if (Object.hasOwn(value, 'maxSentences')
    && !(Number.isSafeInteger(value.maxSentences) && value.maxSentences >= 1)) return false;
  return true;
}

/**
 * 校验一个已解析的风格包对象。
 * @returns {string|null} 固定错误码（`schema` / `schema-version` / `id` / `label` /
 *   `standing-notes` / `mood-length` / `punctuation` / `split` / `emoji` / `nudges` / `data`），
 *   或 `null` 表示合法。错误码不含键名与原始值。
 */
export function validateStylePack(value) {
  if (!keysAre(value, TOP_KEYS)) return 'schema';
  if (value.schemaVersion !== 1) return 'schema-version';
  if (!isText(value.id) || !/^[a-z0-9][a-z0-9_-]*$/.test(value.id)) return 'id';
  if (!isText(value.label) || CONTROL_CHARS.test(value.label)) return 'label';
  if (!isObject(value.data)) return 'data';
  if (Object.keys(value.data).some((key) => !DATA_KEYS.includes(key))) return 'data';
  if (!uniqueTexts(value.data.standingNotes)) return 'standing-notes';
  if (!validMoodLength(value.data.moodLength)) return 'mood-length';
  if (!exactKeys(value.data.punctuation, ['preserve'])
    || typeof value.data.punctuation.preserve !== 'boolean') return 'punctuation';
  if (!exactKeys(value.data.split, ['enabled', 'maxLinesPerTurn'])
    || typeof value.data.split.enabled !== 'boolean'
    || !(Number.isSafeInteger(value.data.split.maxLinesPerTurn) && value.data.split.maxLinesPerTurn >= 1)) {
    return 'split';
  }
  if (!exactKeys(value.data.emoji, ['enabled', 'chanceMax'])
    || typeof value.data.emoji.enabled !== 'boolean'
    || !(finite(value.data.emoji.chanceMax) && value.data.emoji.chanceMax >= 0 && value.data.emoji.chanceMax <= 1)
    || (value.data.emoji.enabled === false && value.data.emoji.chanceMax !== 0)) {
    return 'emoji';
  }
  if (!uniqueTexts(value.data.nudges)) return 'nudges';
  return null;
}

function safeCode(error) {
  return /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? error.code : 'READ_ERROR';
}

function readJson(read, url, name) {
  let source;
  try {
    source = read(url, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`style pack "${name}": missing-style-file`);
    throw new Error(`style pack "${name}": ${safeCode(error)}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`style pack "${name}": invalid-json`);
  }
}

/** 目录名排序、唯一；点目录/普通文件不参与发现。注入 readdir 的条目形状与既有加载器一致。 */
function listDirectories(readdir, dir) {
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`style packs: ${safeCode(error)}`);
  }
  if (!Array.isArray(entries)) throw new Error('style packs: READ_ERROR');
  return entries
    .filter((entry) => entry && typeof entry.isDirectory === 'function' && entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => typeof name === 'string' && name !== '' && !name.startsWith('.'))
    .sort();
}

/**
 * 读取并校验全部风格包。
 * @param {{dir?: URL, read?: Function, readdir?: Function}} [options]
 *   读取面全部可注入（离线测试用合成夹具，不碰真实 `content/`）。`dir` 只接受 **URL**
 *   （与 `content-pack.js` / `world-pack.js` 的先例一致）。
 * @returns {{schemaVersion: 1, ids: string[], styles: Record<string, object>} | null}
 *   目录不存在 → null；任一包不合法 → 抛错（不静默跳过、不静默回退）。
 */
export function readStylePacks({ dir = DEFAULT_DIR, read = readFileSync, readdir = readdirSync } = {}) {
  const dirs = listDirectories(readdir, dir);
  if (dirs === null) return null;
  const styles = {};
  const ids = [];
  for (const name of dirs) {
    const value = readJson(read, new URL(`${name}/${STYLE_FILE}`, dir), name);
    const problem = validateStylePack(value);
    if (problem) throw new Error(`style pack "${name}": ${problem}`);
    if (value.id !== name) throw new Error(`style pack "${name}": id-mismatch`);
    if (Object.hasOwn(styles, value.id)) throw new Error(`style pack "${name}": duplicate-id`);
    styles[value.id] = value;
    ids.push(value.id);
  }
  return { schemaVersion: 1, ids, styles };
}

/** 模块单例：import 期按默认目录读一次；无 `content/styles/` → null（旧安装行为不变）。 */
export const STYLE_PACKS = readStylePacks();

/** 按 id 取风格包；未知 id 抛错（不返回 undefined 让调用方静默降级）。 */
export function stylePackById(id, packs = STYLE_PACKS) {
  if (!packs) throw new Error('style pack: no-packs-loaded');
  const pack = packs.styles[String(id)];
  if (!pack) throw new Error(`style pack: unknown-id "${String(id)}"`);
  return pack;
}

/**
 * 风格包 → 消费端策略对象（纯数据转换，不接线、不读环境）。
 *
 * 缺省只在**可选**字段上补中性值（`maxCharsFactor` 缺省 1 = 不缩放；`maxSentences`
 * 缺省 null = 不用风格层封顶，沿用情绪自己的上限）。这些不是策略决定，只是"没写就
 * 等于没限制"的固定表达；真正的策略数值全部来自包数据，不写死在代码里。
 * @param {object} style 已完成校验的包对象
 * @returns {{id: string, label: string, standingNotes: string[], nudges: string[],
 *   moodLength: {maxCharsFactor: number, maxSentences: number|null},
 *   punctuation: {preserve: boolean},
 *   split: {enabled: boolean, maxLinesPerTurn: number},
 *   emoji: {enabled: boolean, chanceMax: number}}}
 */
export function styleAsPolicy(style) {
  if (!isObject(style)) throw new Error('style pack: no-style');
  const problem = validateStylePack(style);
  if (problem) throw new Error(`style pack "${String(style.id)}": ${problem}`);
  const { data } = style;
  return {
    id: style.id,
    label: style.label,
    standingNotes: [...data.standingNotes],
    nudges: [...data.nudges],
    moodLength: {
      maxCharsFactor: data.moodLength.maxCharsFactor ?? 1,
      maxSentences: data.moodLength.maxSentences ?? null,
    },
    punctuation: { preserve: data.punctuation.preserve },
    split: { enabled: data.split.enabled, maxLinesPerTurn: data.split.maxLinesPerTurn },
    emoji: { enabled: data.emoji.enabled, chanceMax: data.emoji.chanceMax },
  };
}
