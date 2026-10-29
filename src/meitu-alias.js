/**
 * 角色名 → 图源 tag 的**别名表**(2026-10-23,代码层发图)。
 *
 * 群聊名称与图源 tag 之间使用人工映射,不为翻译额外调用模型。
 *
 * **作品判据(防止重名)**:表里的 key 可以写成「作品名的角色名」。
 * 空格不敏感,可省略「的」,也支持「角色名(作品名)」与全角括号。
 * 同一张表里可以同时有角色名与带作品名的 key —— 精确命中的那条优先。
 *
 * 表在 `data\meitu-alias.json`(运行期数据,不进版本库;路径由 `QQBOT_MEITU_ALIAS` 覆盖)。
 * 文件缺失或坏掉 → 用默认表,坏 JSON 额外带 `error` 让调用方 warn。
 * 默认表来自可选的本地内容 JSON;公开裁剪不带该内容时默认空表。
 * 本地内容不是运行期表的覆盖层:运行期有效表(包括空表)始终独立生效。
 *
 * **JSONC 备注(2026-10-24 / D319)**:运行期表允许写 `//` 行注释和 块注释 —— 主人要按
 * 作品/体型分区标注时,注释是唯一不污染键值的写法。**注释在读取时被剥掉**,而且是在**所有**
 * 读表处(本文件 / `src\panel.js` 的 tag→中文名反查 / `selftest-meitu-command` 的真盘判据)
 * 统一走 `stripJsonComments()` —— 同 D159,不许写第二份实现。字符串里的 `//` 不当注释。
 * ⚠️ 注释合法 ≠ 结构可以乱:少个逗号、引号没闭合仍然整表回退(D305 的老坑,守护判据照旧在)。
 */
import fs from 'node:fs';

/** 可选内容只在模块初始化读取;仅缺失允许空表,其余故障必须启动报错。 */
function loadDefaultAliases() {
  let text;
  try {
    text = fs.readFileSync(new URL('../content/local/meitu-alias-defaults.json', import.meta.url), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    // 不附原错误/cause:文件系统错误可能包含本地私有路径。
    throw new Error('默认别名内容读取失败（非缺失错误）');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse 的错误可能带原文片段,不能直接传播。
    throw new Error('默认别名内容不是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.entries(value).some(([key, tag]) => !key.trim() || typeof tag !== 'string' || !tag.trim())) {
    throw new Error('默认别名内容结构无效');
  }
  return value;
}

export const DEFAULT_ALIASES = loadDefaultAliases();

/**
 * 剥掉 JSONC 注释(`//` 行注释 / 块注释),**字符串里的 `//` 不当注释**。
 *
 * 注释统一换成空格、**保留换行** —— 这样坏 JSON 的报错行号不会飘,主人按报错行改得动。
 * 只做"剥注释"这一件事,不认识 JSON5 的尾逗号/单引号(出现照样按坏 JSON 回退,别偷偷放宽)。
 * 开头 BOM 一并去掉(Windows 编辑器偶尔会加,JSON.parse 不认)。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  const src = String(text ?? '').replace(/^\uFEFF/u, '');
  let out = '';
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        // 转义:下一个字符原样进结果,别让它被当成字符串结束引号。
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 只保留「字符串 → 非空字符串」的项;别的形状一律忽略(坏一行不该让整张表失效)。 */
function pickAliases(value) {  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const aliases = {};
  for (const [name, tag] of Object.entries(value)) {
    const key = String(name ?? '').trim();
    const target = typeof tag === 'string' ? tag.trim() : '';
    if (key && target) aliases[key] = target;
  }
  return aliases;
}

/**
 * 读别名表。**永不抛**:读不到就用默认表(否则一个坏文件能让整条指令静默消失)。
 *
 * @param {string} filePath `data\meitu-alias.json` 的绝对路径
 * @param {{readFileSync?: Function}} [deps] 测试注入用
 * @returns {{aliases: Record<string, string>, error?: string}}
 */
export function loadMeituAliases(filePath, deps = {}) {
  const read = deps.readFileSync ?? ((file) => fs.readFileSync(file, 'utf8'));

  let text;
  try {
    text = read(filePath);
  } catch (err) {
    // 缺失 = 正常(第一次部署还没建表);用默认表,不当错误。
    if (err?.code === 'ENOENT') return { aliases: { ...DEFAULT_ALIASES } };
    return { aliases: { ...DEFAULT_ALIASES }, error: `别名表读不出来: ${err?.message ?? err}` };
  }

  try {
    // JSONC:先剥注释再解析(字符串里的 `//` 不动)。
    const parsed = pickAliases(JSON.parse(stripJsonComments(text)));
    if (!parsed) return { aliases: { ...DEFAULT_ALIASES }, error: '别名表不是 JSON 对象' };
    // 文件存在但是空对象 = 主人清空了表,尊重它(不回退默认表)。
    return { aliases: parsed };
  } catch (err) {
    return { aliases: { ...DEFAULT_ALIASES }, error: `别名表不是合法 JSON: ${err?.message ?? err}` };
  }
}

/** 归一化一个名字:去所有空白、全角括号转半角。比较时两边都走这一步。 */
function normalizeAliasKey(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/gu, '')
    .replace(/（/gu, '(')
    .replace(/）/gu, ')');
}

/**
 * 一个输入名 → 所有等价写法(归一化之后)。
 * 覆盖:去空格、省略「的」、`角色(作品)` ↔ `作品+角色` 换位。
 */
function candidateKeys(name) {
  const base = normalizeAliasKey(name);
  const keys = new Set([base, base.replace(/的/gu, '')]);
  const paren = /^(.+?)\((.+?)\)$/u.exec(base);
  if (paren) {
    const joined = `${paren[2]}${paren[1]}`;
    keys.add(joined);
    keys.add(joined.replace(/的/gu, ''));
  }
  return { base, keys };
}

/**
 * 角色名 → tag。
 *
 * 三条路(顺序有意义):
 *   ① **归一化精确命中**:别名表的 key 与输入名按同一规则归一化后相等;
 *   ② **归一化宽松命中**:去掉「的」/括号换位后相等(作品判据靠这条);
 *   ③ 本身就是 tag 形状(`/^[a-z0-9_()]+$/i` 且**含下划线**)—— 允许直接写
 *      图源 tag。要求含下划线是为了不把普通单词当 tag 发出去。
 *
 * @param {string} name
 * @param {Record<string, string>} aliases
 * @returns {{ok: true, tag: string} | {ok: false, reason: 'unregistered'}}
 */
export function resolveCharacterTag(name, aliases) {
  const rawKey = String(name ?? '').trim();
  if (!rawKey) return { ok: false, reason: 'unregistered' };
  const table = aliases && typeof aliases === 'object' ? aliases : {};
  const entries = Object.entries(table);
  const { base, keys } = candidateKeys(rawKey);

  for (const [key, value] of entries) {
    if (normalizeAliasKey(key) !== base) continue;
    const tag = String(value ?? '').trim();
    if (tag) return { ok: true, tag };
  }

  // 宽松命中:去「的」/括号换位,兼容作品名与角色名的不同写法。
  for (const [key, value] of entries) {
    const loose = normalizeAliasKey(key).replace(/的/gu, '');
    if (!keys.has(loose)) continue;
    const tag = String(value ?? '').trim();
    if (tag) return { ok: true, tag };
  }

  if (/^[a-z0-9_()]+$/i.test(rawKey) && rawKey.includes('_')) return { ok: true, tag: rawKey };
  return { ok: false, reason: 'unregistered' };
}
