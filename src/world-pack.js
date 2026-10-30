/**
 * 世界包加载器（阶段 4 世界包化，2026-10-30）。
 *
 * 一个世界包 = `content/worlds/<id>/world.json`（C 区数据，永不执行代码）。本模块只做
 * 三件事：目录发现、严格 schema 校验、把包数据整理成既有消费者认的三个世界段聚合
 * （`storyWorld` / `turnWorld` / `moodWorld`）。
 *
 * 纪律：
 * - 零第三方依赖，只用 `node:fs`；读取函数可注入（离线测试用合成数据）。
 * - **fail closed**：坏 JSON / 坏 schema / id 重复或与目录名不符 / 未知版本 / 未知激活
 *   id / 多个 default → 抛错；错误信息只含包 id 与固定错误码，不含内容片段、绝对路径
 *   或原始解析器消息。
 * - 没有 `content/worlds/` 目录 → 返回 `null`（旧安装行为：读取器继续用旧快照）。
 * - 激活规则（顺序固定）：`env.QQBOT_WORLD` 非空 > 恰有一个 `default: true` > 无（null）；
 *   多个 `default: true` 抛错。
 * - 包不是执行单元；世界级内容只作**可选层**，旧快照仍是官方安装的回退权威。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { validatePackParams } from './pack-params.js';

const DEFAULT_DIR = new URL('../content/worlds/', import.meta.url);

/** 旧 `content/local/story-world.json` 的世界段键（15 个，顺序即聚合输出顺序）。 */
const STORY_SECTION_KEYS = [
  'storyEvents', 'storyClosingWords', 'storyClosingExamples', 'storyRespondClosing',
  'storySettleClosing', 'places', 'worldText', 'moduleText', 'chronicleKinds', 'eventLabels',
  'chronicleText', 'commandEffects', 'cardClaimNotes', 'keywordGroups', 'opsEffects',
];
const TURN_SECTION_KEYS = ['warmupTopics', 'meituLines'];
const MOOD_SECTION_KEYS = ['config', 'ruleLabels'];
const PLACE_IDS = ['home', 'fishing', 'guild', 'canteen', 'market', 'gallery'];
const MODULE_TEXT_IDS = ['burst', 'sword', 'scout', 'talk', 'cook', 'fish', 'slow', 'weak', 'clumsy', 'nosy'];
const MODULE_TEXT_NOTED = ['burst', 'cook'];
const CHRONICLE_KINDS = ['meal', 'fed', 'selfcare', 'event', 'story', 'quest', 'fish', 'sell', 'home',
  'potion', 'sleep', 'move', 'illness', 'heal'];
const EVENT_LABELS = ['found_coin', 'someone_treats', 'sold_loot', 'bought_staff', 'tax', 'lost_pouch', 'donated'];
const COMMAND_EFFECTS = ['/重置', '/状态', '/成长', '/钱包', '/熟人', '/钓鱼', '/委托', '/接 <编号>', '/help',
  '/重启', '/更新', '/发', '/更新 预览', '/更新 账本', '/更新 回退', '/更新 基线 <版本>', '/更新 <编号>',
  '/群列表', '/忘了', '/旁白测试', '/发图', '发N张<角色>美图/涩图', '/认人', '/绑定'];
const CARD_CLAIM_NOTES = ['/状态', '/钱包', '/更新', '/群列表', '/成长'];
const OPS_EFFECTS = ['handoff.js', 'release-status.js', 'log-tail.js', 'restart.js / restart.cmd',
  'announce-preview.js', 'announce-reset.js', 'known-group-add.js', 'relay-status.js', 'rhythm-report.js',
  'social-observer.js', 'card-eval.js', 'memory-v0.js', 'selftest.js', 'stats-report.js', 'economy-sim.js',
  'growth-report.js', 'command-index.js', 'probe.js', 'warmup-status.js', 'memory-archive.js', 'idle-burn.js',
  'purge-tool-notes.js', 'profile-scan.js', 'transcript.js', 'verify-qq.js', 'todo-index.js'];
const MEITU_LINE_KEYS = ['groupDisabled', 'cooldown', 'unregistered', 'interpretFailed', 'noResult',
  'sourceDown', 'uploadFailed', 'downloadFailed', 'internal', 'blocked_apology', 'blocked_empty'];
const WARMUP_TAGS = ['meal', 'poor', 'rich', 'general'];
const EFFECT_KEYS = ['money', 'satiety', 'health', 'mood', 'stamina', 'mana'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isTexts = (value) => Array.isArray(value) && value.every(isText);
const nonemptyTexts = (value) => isTexts(value) && value.length > 0;
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const keysAre = (value, required, optional = []) => isObject(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const textMap = (value, keys) => exactKeys(value, keys) && Object.values(value).every(isText);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function validEvents(events) {
  return Array.isArray(events) && events.length > 0 && events.every((event) =>
    keysAre(event, ['id', 'setup', 'branches']) && isText(event.id) && isText(event.setup)
    && Array.isArray(event.branches) && event.branches.length > 0 && event.branches.every((branch) =>
      keysAre(branch, ['id', 'weight', 'line', 'keywords', 'effect']) && isText(branch.id)
      && finite(branch.weight) && branch.weight > 0 && isText(branch.line) && isTexts(branch.keywords)
      && isObject(branch.effect) && Object.entries(branch.effect).every(([key, value]) =>
        EFFECT_KEYS.includes(key) && finite(value))));
}

function validPlaces(places) {
  return Array.isArray(places) && places.length === PLACE_IDS.length
    && places.every((place, index) => place?.id === PLACE_IDS[index]
      && keysAre(place, ['id', 'name', 'kind', 'travelMs', 'blurb'])
      && isText(place.name) && isText(place.kind) && finite(place.travelMs) && place.travelMs > 0
      && isText(place.blurb));
}

function validModuleText(moduleText) {
  if (!exactKeys(moduleText, MODULE_TEXT_IDS)) return false;
  return MODULE_TEXT_IDS.every((id) => {
    const row = moduleText[id];
    // 与旧读取器 `keysAre(row, ['name', ...(burst|cook ? ['note'] : [])])` 逐字一致：
    // burst/cook 的 `note` **必填**（消费者 `character-tuning.js` 直接读它）。
    return MODULE_TEXT_NOTED.includes(id)
      ? exactKeys(row, ['name', 'note']) && isText(row.name) && isText(row.note)
      : exactKeys(row, ['name']) && isText(row.name);
  });
}

function validKeywordGroups(groups) {
  return Array.isArray(groups) && groups.length > 0 && groups.every((row) =>
    keysAre(row, ['label', 'words']) && isText(row.label) && isTexts(row.words));
}

/** `storyWorld` 段：键集合与旧 `content/local/story-world.json` 的世界段完全一致。 */
function validStoryWorld(story) {
  if (!keysAre(story, STORY_SECTION_KEYS)) return false;
  if (!validEvents(story.storyEvents)) return false;
  if (!nonemptyTexts(story.storyClosingWords) || !nonemptyTexts(story.storyClosingExamples)) return false;
  if (!isText(story.storyRespondClosing) || !isText(story.storySettleClosing)) return false;
  if (!validPlaces(story.places)) return false;
  if (!exactKeys(story.worldText, ['currency', 'questAcceptPrefix', 'questAcceptSuffix', 'questAcceptPlain'])
    || !Object.values(story.worldText).every(isText)) return false;
  if (!validModuleText(story.moduleText)) return false;
  if (!textMap(story.chronicleKinds, CHRONICLE_KINDS)) return false;
  if (!textMap(story.eventLabels, EVENT_LABELS)) return false;
  if (!exactKeys(story.chronicleText, ['currency', 'manaLabel', 'healFailed'])
    || !Object.values(story.chronicleText).every(isText)) return false;
  if (!textMap(story.commandEffects, COMMAND_EFFECTS)) return false;
  if (!textMap(story.cardClaimNotes, CARD_CLAIM_NOTES)) return false;
  if (!textMap(story.opsEffects, OPS_EFFECTS)) return false;
  return validKeywordGroups(story.keywordGroups);
}

/** `turnWorld` 段：`warmupTopics` 与 `meituLines`，对齐旧 `content/local/turn-lines.json`。 */
function validTurnWorld(turn) {
  if (!exactKeys(turn, TURN_SECTION_KEYS)) return false;
  const topics = turn.warmupTopics;
  if (!Array.isArray(topics) || topics.length === 0) return false;
  if (!topics.every((topic) => exactKeys(topic, ['tag', 'text'])
    && WARMUP_TAGS.includes(topic.tag) && isText(topic.text))) return false;
  if (!topics.some((topic) => topic.tag === 'general')) return false;
  if (!exactKeys(turn.meituLines, MEITU_LINE_KEYS)) return false;
  return Object.values(turn.meituLines).every(nonemptyTexts);
}

/** `moodWorld` 段：世界级 `config` / `ruleLabels`，对齐旧 `content/local/mood-body.json`。 */
function validMoodWorld(mood) {
  if (!exactKeys(mood, MOOD_SECTION_KEYS)) return false;
  const { config, ruleLabels } = mood;
  if (!exactKeys(config, ['groupKeywords', 'reportTargetName', 'bodyMismatchNote'])) return false;
  if (!nonemptyTexts(config.groupKeywords) || !isText(config.reportTargetName)
    || !isText(config.bodyMismatchNote)) return false;
  return exactKeys(ruleLabels, ['biological', 'mechanical']) && Object.values(ruleLabels).every(isText);
}

/**
 * 校验一个已解析的世界包对象。
 * @returns {string|null} 固定错误码，或 `null` 表示合法。
 */
export function validateWorldPack(value) {
  if (!keysAre(value, ['schemaVersion', 'id', 'label', 'default', 'storyWorld', 'turnWorld', 'moodWorld'], ['params'])) {
    return 'schema';
  }
  if (value.schemaVersion !== 1) return 'schema-version';
  if (!isText(value.id) || !/^[a-z0-9][a-z0-9_-]*$/.test(value.id)) return 'id';
  if (!isText(value.label)) return 'label';
  if (typeof value.default !== 'boolean') return 'default';
  if (Object.hasOwn(value, 'params')) {
    // 固定错误码吞掉参数层诊断：既不含非法键名，也不含原始值。
    try { validatePackParams(value.params); } catch { return 'params'; }
  }
  if (!validStoryWorld(value.storyWorld)) return 'story-world';
  if (!validTurnWorld(value.turnWorld)) return 'turn-world';
  if (!validMoodWorld(value.moodWorld)) return 'mood-world';
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
    if (error?.code === 'ENOENT') throw new Error(`world pack "${name}": missing-world-file`);
    throw new Error(`world pack "${name}": ${safeCode(error)}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`world pack "${name}": invalid-json`);
  }
}

/** 目录名排序、唯一；点目录/普通文件不参与发现。注入 readdir 的条目形状与 content-pack 一致。 */
function listDirectories(readdir, dir) {
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`world packs: ${safeCode(error)}`);
  }
  if (!Array.isArray(entries)) throw new Error('world packs: READ_ERROR');
  return entries
    .filter((entry) => entry && typeof entry.isDirectory === 'function' && entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => typeof name === 'string' && name !== '' && !name.startsWith('.'))
    .sort();
}

function activeIdFor(worlds, ids, env) {
  const requested = env?.QQBOT_WORLD;
  if (typeof requested === 'string' && requested !== '') {
    if (!ids.includes(requested)) throw new Error(`world pack: unknown-id "${requested}"`);
    return requested;
  }
  const defaults = ids.filter((id) => worlds[id].default === true);
  if (defaults.length > 1) throw new Error('world packs: ambiguous-default');
  return defaults.length === 1 ? defaults[0] : null;
}

/**
 * 读取并校验全部世界包。
 * @param {{dir?: URL, read?: Function, readdir?: Function, env?: object}} [options]
 *   读取面全部可注入（离线测试用合成夹具，不碰真实 `content/`）。
 *   ⚠️ `dir` 只接受 **URL**（`new URL('../content/worlds/', import.meta.url)` 或
 *   `pathToFileURL('...')`），与 `content-pack.js` 的先例一致；实现内部用
 *   `new URL('<id>/world.json', dir)` 拼子文件，传字符串会在那里抛 TypeError。
 *   注入测试请用合成 URL 根（如 `new URL('fixture://content/worlds/')`）。
 *   `env` 只读取 `.QQBOT_WORLD`，不读子进程/网络/其他环境变量。
 * @returns {{schemaVersion: 1, ids: string[], worlds: Record<string, object>,
 *   activeId: string|null, active: object|null} | null}
 *   目录不存在 → null；任一包不合法 / 激活规则不成立 → 抛错（不静默跳过）。
 */
export function readWorldPacks({
  dir = DEFAULT_DIR,
  read = readFileSync,
  readdir = readdirSync,
  env = process.env,
} = {}) {
  const dirs = listDirectories(readdir, dir);
  if (dirs === null) return null;
  const worlds = {};
  const ids = [];
  for (const name of dirs) {
    const value = readJson(read, new URL(`${name}/world.json`, dir), name);
    const problem = validateWorldPack(value);
    if (problem) throw new Error(`world pack "${name}": ${problem}`);
    if (value.id !== name) throw new Error(`world pack "${name}": id-mismatch`);
    if (Object.hasOwn(worlds, value.id)) throw new Error(`world pack "${name}": duplicate-id`);
    worlds[value.id] = value;
    ids.push(value.id);
  }
  const activeId = activeIdFor(worlds, ids, env);
  return { schemaVersion: 1, ids, worlds, activeId, active: activeId === null ? null : worlds[activeId] };
}

/** 模块单例：import 期按默认目录读一次；无 `content/worlds/` → null（旧安装行为不变）。 */
export const WORLD_PACKS = readWorldPacks();

/** 按 id 取世界包；未知 id 抛错（不返回 undefined 让调用方静默降级）。 */
export function worldById(id, packs = WORLD_PACKS) {
  if (!packs) throw new Error('world pack: no-packs-loaded');
  const world = packs.worlds[String(id)];
  if (!world) throw new Error(`world pack: unknown-id "${String(id)}"`);
  return world;
}

/** 世界包 → 旧 `LOCAL_STORY_WORLD` 的 15 个世界段（不含角色段）。 */
export function worldAsStoryWorldSections(world) {
  if (!world) throw new Error('world pack: no-world');
  const sections = {};
  for (const key of STORY_SECTION_KEYS) sections[key] = world.storyWorld[key];
  return sections;
}

/** 世界包 → 旧 `LOCAL_TURN_CONTENT` 的世界级两张表。 */
export function worldAsTurnSections(world) {
  if (!world) throw new Error('world pack: no-world');
  const sections = {};
  for (const key of TURN_SECTION_KEYS) sections[key] = world.turnWorld[key];
  return sections;
}

/** 世界包 → 旧 `LOCAL_MOOD_BODY_CONTENT` 的世界级 `config` / `ruleLabels`。 */
export function worldAsMoodBodySections(world) {
  if (!world) throw new Error('world pack: no-world');
  const sections = {};
  for (const key of MOOD_SECTION_KEYS) sections[key] = world.moodWorld[key];
  return sections;
}

/**
 * 激活世界包的可选参数（阶段 3 `src/pack-params.js` 白名单，已在校验期过一遍）。
 * 无世界包 / 未激活 / 包内无 `params` → `{}`（旧行为不变）。
 */
export function activeWorldParams(packs = WORLD_PACKS) {
  const world = packs?.active;
  if (!world || !Object.hasOwn(world, 'params')) return {};
  validatePackParams(world.params);
  return world.params;
}

/** 无值元数据，只给启动诊断/日志用。 */
export function worldPackSummary(packs = WORLD_PACKS) {
  const ids = packs?.ids ?? [];
  return {
    available: ids.length > 0,
    ids: [...ids],
    activeId: packs?.activeId ?? null,
    defaultIds: ids.filter((id) => packs.worlds[id].default === true),
  };
}
