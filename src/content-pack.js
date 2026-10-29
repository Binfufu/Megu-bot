/**
 * 内容包加载器（阶段 2 角色包化，2026-10-29）。
 *
 * 一个内容包 = `content/packs/<id>/pack.json`（C 区数据，永不执行代码）。本模块只做
 * 三件事：目录发现、严格 schema 校验、把包数据整理成既有消费者认的聚合形状。
 *
 * 纪律：
 * - 零第三方依赖，只用 `node:fs`；读取函数可注入（离线测试用合成数据）。
 * - **fail closed**：坏 JSON / 坏 schema / id 重复或与目录名不符 → 抛错；错误信息只含
 *   包 id 与错误码，不含内容片段或绝对路径。
 * - 没有 `content/packs/` 目录 → 返回 `null`（旧行为：调用方继续读 `content/local/`）。
 * - 包不是执行单元、不做合并层以外的策略覆盖；情绪/数值策略仍在 P 区代码。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { validatePackParams } from './pack-params.js';

const DEFAULT_DIR = new URL('../content/packs/', import.meta.url);
const VALUE_KEYS = ['satiety', 'health', 'mood', 'stamina', 'mana'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isTexts = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const keysAre = (value, required, optional = []) => isObject(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const uniqueTexts = (value) => isTexts(value) && new Set(value).size === value.length;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function validEvent(event) {
  return exactKeys(event, ['id', 'setup', 'branches']) && isText(event.id) && isText(event.setup)
    && Array.isArray(event.branches) && event.branches.length > 0 && event.branches.every((branch) =>
      exactKeys(branch, ['id', 'weight', 'line', 'keywords', 'effect']) && isText(branch.id)
      && finite(branch.weight) && branch.weight > 0 && isText(branch.line) && isTexts(branch.keywords)
      && isObject(branch.effect) && Object.entries(branch.effect).every(([key, value]) =>
        ['money', 'satiety', 'health', 'mood', 'stamina', 'mana'].includes(key) && finite(value)));
}

function validMood(mood) {
  if (!exactKeys(mood, ['label', 'ids', 'topics', 'moods', 'topicTable', 'interjections', 'kaomoji', 'interjectionTopicGate'])) return false;
  if (!isText(mood.label) || !uniqueTexts(mood.ids) || !uniqueTexts(mood.topics)) return false;
  if (!exactKeys(mood.moods, mood.ids)) return false;
  if (!Object.values(mood.moods).every((row) => exactKeys(row, ['label', 'directive']) && isText(row.label) && isText(row.directive))) return false;
  if (!exactKeys(mood.topicTable, mood.topics)) return false;
  if (!Object.values(mood.topicTable).every((row) => exactKeys(row, ['label', 'keywords']) && isText(row.label) && isTexts(row.keywords))) return false;
  if (!exactKeys(mood.interjections, mood.ids)) return false;
  if (!Object.values(mood.interjections).every(isTexts)) return false;
  if (!Array.isArray(mood.kaomoji) || mood.kaomoji.length === 0) return false;
  if (!mood.kaomoji.every((row) => exactKeys(row, ['text', 'tags']) && isText(row.text) && isTexts(row.tags))) return false;
  if (!isObject(mood.interjectionTopicGate)) return false;
  const allLines = Object.values(mood.interjections).flat();
  return Object.entries(mood.interjectionTopicGate).every(([line, topics]) =>
    allLines.includes(line) && isTexts(topics) && topics.every((topic) => mood.topics.includes(topic)));
}

function validBody(body) {
  if (!exactKeys(body, ['label', 'values', 'action', 'growth']) || !isText(body.label)) return false;
  if (!exactKeys(body.values, VALUE_KEYS)) return false;
  if (!Object.values(body.values).every((row) => exactKeys(row, ['short', 'long', 'states'])
    && isText(row.short) && isText(row.long) && isTexts(row.states))) return false;
  return exactKeys(body.action, ['verb', 'short', 'prompt', 'tag']) && Object.values(body.action).every(isText)
    && exactKeys(body.growth, ['knownAs', 'conceptAs', 'personRecorded', 'conceptRecorded'])
    && Object.values(body.growth).every(isText);
}

function validStory(story) {
  if (!exactKeys(story, ['pack', 'phrases'])) return false;
  const pack = story.pack;
  const packKeys = Object.hasOwn(pack, 'events') ? ['id', 'label', 'events'] : ['id', 'label'];
  if (!exactKeys(pack, packKeys) || !isText(pack.id) || !isText(pack.label)) return false;
  if (Object.hasOwn(pack, 'events')) {
    if (!Array.isArray(pack.events) || pack.events.length === 0 || !pack.events.every(validEvent)) return false;
  }
  return Array.isArray(story.phrases) && story.phrases.every((row) =>
    exactKeys(row, ['phrase', 'note']) && isText(row.phrase) && isText(row.note));
}

function validCompanion(companion) {
  if (companion === null) return true;
  if (!exactKeys(companion, ['id', 'name', 'fullName', 'theme', 'bot', 'stateDir', 'art', 'blurb'])) return false;
  if (!Object.values(companion).every(isText)) return false;
  return companion.theme === companion.id && companion.bot === companion.id && companion.stateDir === companion.id
    && /^[a-z0-9_-]+\.(?:png|jpg)$/i.test(companion.art);
}

function validCharacterDays(days) {
  return Array.isArray(days) && days.every((row) => exactKeys(row, ['month', 'day', 'label', 'source'])
    && Number.isInteger(row.month) && row.month >= 1 && row.month <= 12
    && Number.isInteger(row.day) && row.day >= 1 && row.day <= 31 && isText(row.label) && isText(row.source));
}

/** 校验一个已解析的包对象；返回错误码字符串或 null。 */
export function validatePack(value) {
  if (!keysAre(value, ['schemaVersion', 'id', 'role', 'themes', 'mood', 'body', 'style', 'story', 'companion', 'characterDays'], ['params'])) return 'schema';
  if (Object.hasOwn(value, 'params')) {
    try { validatePackParams(value.params); } catch { return 'params'; }
  }
  if (value.schemaVersion !== 1) return 'schema-version';
  if (!isText(value.id) || !/^[a-z0-9][a-z0-9_-]*$/.test(value.id)) return 'id';
  if (!exactKeys(value.role, ['label']) || !isText(value.role.label)) return 'role';
  if (!exactKeys(value.themes, ['mood', 'body', 'style']) || !Object.values(value.themes).every(isText)) return 'themes';
  if (!validMood(value.mood)) return 'mood';
  if (!validBody(value.body)) return 'body';
  if (!exactKeys(value.style, ['nudges']) || !isTexts(value.style.nudges)) return 'style';
  if (!validStory(value.story)) return 'story';
  if (!validCompanion(value.companion)) return 'companion';
  if (!validCharacterDays(value.characterDays)) return 'characterDays';
  return null;
}

function readJson(read, url) {
  let source;
  try {
    source = read(url, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('content pack: missing-pack-file');
    const code = /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? error.code : 'READ_ERROR';
    throw new Error(`content pack: ${code}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error('content pack: invalid-json');
  }
}

/**
 * 读取并校验全部内容包。
 * @returns {{schemaVersion: 1, ids: string[], packs: Record<string, object>} | null}
 *   目录不存在 → null；任一包不合法 → 抛错（不静默跳过）。
 */
export function readContentPacks({ dir = DEFAULT_DIR, read = readFileSync, readdir = readdirSync } = {}) {
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    const code = /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? error.code : 'READ_ERROR';
    throw new Error(`content packs: ${code}`);
  }
  const dirs = entries
    .filter((entry) => entry && typeof entry.isDirectory === 'function' && entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
    .sort();
  const packs = {};
  const ids = [];
  for (const name of dirs) {
    const file = new URL(`${name}/pack.json`, dir);
    const value = readJson(read, file);
    const problem = validatePack(value);
    if (problem) throw new Error(`content pack "${name}": ${problem}`);
    if (value.id !== name) throw new Error(`content pack "${name}": id-mismatch`);
    if (Object.hasOwn(packs, value.id)) throw new Error(`content pack "${name}": duplicate-id`);
    packs[value.id] = value;
    ids.push(value.id);
  }
  return { schemaVersion: 1, ids, packs };
}

export const PACKS = readContentPacks();

/** 按 id 取包；未知 id 抛错（不返回 undefined 让调用方静默降级）。 */
export function packById(id, packs = PACKS) {
  if (!packs) throw new Error('content pack: no-packs-loaded');
  const pack = packs.packs[String(id)];
  if (!pack) throw new Error(`content pack: unknown-id "${String(id)}"`);
  return pack;
}

/**
 * Optional tuning for the selected mood theme. Missing packs/params preserve
 * the old defaults. Ambiguous themes with parameter blocks fail closed rather
 * than choosing a pack by directory order.
 */
export function packParamsForTheme(theme, packs = PACKS) {
  if (!packs) return {};
  const matches = packs.ids.map((id) => packs.packs[id])
    .filter((pack) => pack.themes.mood === theme && Object.hasOwn(pack, 'params'));
  if (matches.length > 1) throw new Error('content pack: ambiguous-params-theme');
  if (!matches.length) return {};
  validatePackParams(matches[0].params);
  return matches[0].params;
}

/** 包 → 既有 `LOCAL_MOOD_BODY_CONTENT.mood/.body` 形状（其余键由调用方与旧快照合并）。 */
export function packsAsMoodBodyContent(packs = PACKS) {
  if (!packs) return null;
  const mood = {};
  const body = {};
  for (const id of packs.ids) {
    const pack = packs.packs[id];
    mood[pack.themes.mood] ??= {
      label: pack.mood.label,
      moods: pack.mood.moods,
      topics: pack.mood.topicTable,
      interjections: pack.mood.interjections,
      kaomoji: pack.mood.kaomoji,
      interjectionTopicGate: pack.mood.interjectionTopicGate,
    };
    body[pack.themes.body] ??= pack.body;
  }
  return { mood, body };
}

/** 包 → `LOCAL_TURN_CONTENT.styleNudges` 形状。 */
export function packsAsStyleNudges(packs = PACKS) {
  if (!packs) return null;
  const styleNudges = {};
  for (const id of packs.ids) {
    const pack = packs.packs[id];
    styleNudges[pack.themes.style] ??= pack.style.nudges;
  }
  return { styleNudges };
}

/**
 * 包 → `LOCAL_STORY_WORLD` 的角色段形状（由读者按旧快照顺序合并，见
 * `local-story-world-content.js`）：`{storyPacks, companionsById, characterDays, phrasesByRole}`。
 */
export function packsAsStoryRoleSections(packs = PACKS) {
  if (!packs) return null;
  const storyPacks = {};
  const companionsById = {};
  const characterDays = {};
  const phrasesByRole = {};
  for (const id of packs.ids) {
    const pack = packs.packs[id];
    storyPacks[id] = pack.story.pack;
    characterDays[id] = pack.characterDays;
    phrasesByRole[id] = pack.story.phrases;
    if (pack.companion) companionsById[id] = pack.companion;
  }
  return { storyPacks, companionsById, characterDays, phrasesByRole };
}
