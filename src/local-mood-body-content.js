/**
 * 本地展示内容读取（旧快照回退）。
 *
 * 阶段 2（角色包化）起：角色内容优先来自 `content/packs/<id>/pack.json`（见
 * `src/content-pack.js`）；阶段 4（世界包化）起：世界级 `config` / `ruleLabels`
 * 优先来自 `content/worlds/<id>/world.json`（见 `src/world-pack.js`）。本文件只在
 * 没有内容包/世界包时读固定旧快照。固定路径、固定 schema、无目录发现、无代码执行。
 *
 * Node 24 fs.readFileSync + JSON.parse，asOf 2026-10-29:
 * https://nodejs.org/docs/latest-v24.x/api/fs.html#fsreadfilesyncpath-options
 */
import { readFileSync } from 'node:fs';
import { PACKS, packsAsMoodBodyContent } from './content-pack.js';
import { WORLD_PACKS, worldAsMoodBodySections } from './world-pack.js';

const CONTENT_URL = new URL('../content/local/mood-body.json', import.meta.url);
const MOOD_IDS = {
  megumin: ['chuni', 'snark', 'lazy', 'genki', 'tsundere', 'kind', 'narcissist', 'dramatic', 'angry', 'shy', 'foodie', 'frenzy', 'stubborn', 'plain'],
  aris: ['plain', 'curious', 'earnest', 'genki', 'puzzled', 'system', 'fanfare', 'shy', 'soft', 'heroic', 'solemn'],
};
const TOPIC_IDS = {
  megumin: ['explosion', 'praise', 'weakspot', 'kazuma', 'yuyu', 'food', 'poke', 'face'],
  aris: ['game', 'light', 'praise', 'weakspot', 'companion', 'poke', 'face'],
};
const VALUE_SIZES = { satiety: 6, health: 4, mood: 5, stamina: 5, mana: 5 };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length
  && expected.every((key) => Object.hasOwn(value, key));
const texts = (value) => Array.isArray(value) && value.every(text);
const nonemptyTexts = (value) => texts(value) && value.length > 0;
const textFields = (value, expected) => keys(value, expected) && Object.values(value).every(text);
function validMood(value, id) {
  if (!keys(value, ['label', 'moods', 'topics', 'interjections', 'kaomoji', 'interjectionTopicGate']) || !text(value.label)
    || !keys(value.moods, MOOD_IDS[id]) || !Object.values(value.moods).every((row) => textFields(row, ['label', 'directive']))
    || !keys(value.topics, TOPIC_IDS[id]) || !Object.values(value.topics).every((row) => keys(row, ['label', 'keywords']) && text(row.label) && nonemptyTexts(row.keywords))
    || !keys(value.interjections, MOOD_IDS[id]) || !Object.values(value.interjections).every(nonemptyTexts)
    || !Array.isArray(value.kaomoji) || value.kaomoji.length === 0 || !value.kaomoji.every((row) => keys(row, ['text', 'tags']) && text(row.text) && nonemptyTexts(row.tags))
    || !object(value.interjectionTopicGate)) return false;
  const all = Object.values(value.interjections).flat();
  return Object.entries(value.interjectionTopicGate).every(([line, topics]) => all.includes(line) && nonemptyTexts(topics)
    && topics.every((topic) => TOPIC_IDS[id].includes(topic)));
}
function validBody(value) {
  return keys(value, ['label', 'values', 'action', 'growth']) && text(value.label)
    && keys(value.values, Object.keys(VALUE_SIZES))
    && Object.entries(value.values).every(([id, row]) => keys(row, ['short', 'long', 'states'])
      && text(row.short) && text(row.long) && texts(row.states) && row.states.length === VALUE_SIZES[id])
    && textFields(value.action, ['verb', 'short', 'prompt', 'tag'])
    && textFields(value.growth, ['knownAs', 'conceptAs', 'personRecorded', 'conceptRecorded']);
}
/** Injectable read boundary for isolated tests; runtime path and schema are fixed. */
export function readLocalMoodBodyContent(read = readFileSync) {  let source;
  try { source = read(CONTENT_URL, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    const code = /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? error.code : 'READ_ERROR';
    throw new Error(`local mood/body content: ${code}`);
  }
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error('local mood/body content: invalid JSON'); }
  if (!keys(value, ['schemaVersion', 'mood', 'body', 'config', 'ruleLabels']) || value.schemaVersion !== 1
    || !keys(value.mood, ['megumin', 'aris']) || !validMood(value.mood.megumin, 'megumin') || !validMood(value.mood.aris, 'aris')
    || !keys(value.body, ['megumin', 'aris']) || !Object.values(value.body).every(validBody)
    || !keys(value.config, ['groupKeywords', 'reportTargetName', 'bodyMismatchNote']) || !nonemptyTexts(value.config.groupKeywords)
    || !text(value.config.reportTargetName) || !text(value.config.bodyMismatchNote)
    || !textFields(value.ruleLabels, ['biological', 'mechanical'])) throw new Error('local mood/body content: invalid fixed schema');
  return value;
}
function mergeKeyed(base, overrides) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(overrides ?? {})) out[key] = value;
  return out;
}

/**
 * 世界段 + 角色段的合成（阶段 4）：
 * - 世界包激活时 `config` / `ruleLabels` 来自世界包；
 * - `mood` / `body` 仍内容包优先（角色包只覆盖这两个按主题组织的映射）/ 旧快照回退；
 * - 没有世界包时与改造前逐字段一致（无旧快照且无内容包 → null）。
 *
 * 旧快照与世界包都缺 `mood` / `body` 时，聚合允许为
 * `{schemaVersion: 1, config, ruleLabels}`（消费者必须逐层空值安全）。
 *
 * @param {object|null} legacyContent 旧快照（可缺省）
 * @param {{worldSections?: object|null, packSections?: object|null}} [options]
 */
export function composeMoodBodyContent(
  legacyContent,
  { worldSections = null, packSections = packsAsMoodBodyContent(PACKS) } = {},
) {
  if (!legacyContent) {
    // 官方安装已迁移到世界包 + 角色包：旧快照不再存在时，世界段来自世界包、
    // 角色段来自内容包；两者都没有才回退 null（公开最小树）。
    if (!worldSections && !packSections) return null;
    const content = { schemaVersion: 1 };
    if (packSections) {
      content.mood = { ...packSections.mood };
      content.body = { ...packSections.body };
    }
    if (worldSections) {
      content.config = worldSections.config;
      content.ruleLabels = worldSections.ruleLabels;
    }
    return content;
  }
  if (!packSections && !worldSections) return legacyContent;
  const content = { ...legacyContent };
  if (packSections) {
    content.mood = mergeKeyed(content.mood, packSections.mood);
    content.body = mergeKeyed(content.body, packSections.body);
  }
  if (worldSections) {
    content.config = worldSections.config;
    content.ruleLabels = worldSections.ruleLabels;
  }
  return content;
}

const legacyContent = readLocalMoodBodyContent();
const activeWorld = WORLD_PACKS?.active ?? null;
export const LOCAL_MOOD_BODY_CONTENT = composeMoodBodyContent(legacyContent, {
  worldSections: activeWorld ? worldAsMoodBodySections(activeWorld) : null,
});
