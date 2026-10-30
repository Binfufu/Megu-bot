/**
 * 固定旧快照里的共享句表 + 角色风格表的回退读取。
 *
 * 阶段 2（角色包化）起：`styleNudges` 优先来自内容包（见 `src/content-pack.js`）；
 * 阶段 4（世界包化）起：世界包激活时 `warmupTopics` / `meituLines` 来自
 * `content/worlds/<id>/world.json`（见 `src/world-pack.js`），未激活时仍读本固定文件。
 *
 * Uses Node 24 fs.readFileSync + JSON.parse (asOf 2026-10-29):
 * https://nodejs.org/docs/latest-v24.x/api/fs.html#fsreadfilesyncpath-options
 * Synchronous once at module initialization so legacy imports see the same tables.
 * No executable content, discovery, merge layers, network, or random draws.
 */
import { readFileSync } from 'node:fs';
import { PACKS, packsAsStyleNudges } from './content-pack.js';
import { WORLD_PACKS, worldAsTurnSections } from './world-pack.js';

const LOCAL_URL = new URL('../content/local/turn-lines.json', import.meta.url);
const LINE_KEYS = ['groupDisabled', 'cooldown', 'unregistered', 'interpretFailed', 'noResult',
  'sourceDown', 'uploadFailed', 'downloadFailed', 'internal', 'blocked_apology', 'blocked_empty'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isTable = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

/** The read function is injectable for offline boundary tests; the URL stays fixed. */
export function readLocalTurnContent(read = readFileSync) {
  let text;
  try { text = read(LOCAL_URL, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    // Never include local payload, filesystem path, or parser excerpts in the error.
    const code = /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? error.code : 'READ_ERROR';
    throw new Error(`local turn content: ${code}`);
  }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('local turn content: invalid JSON'); }
  if (!exactKeys(value, ['styleNudges', 'warmupTopics', 'meituLines'])
    || !exactKeys(value.styleNudges, ['megumin', 'aris'])
    || !Object.values(value.styleNudges).every(isTable)
    || !Array.isArray(value.warmupTopics) || value.warmupTopics.length === 0
    || !value.warmupTopics.every((topic) => exactKeys(topic, ['tag', 'text'])
      && ['meal', 'poor', 'rich', 'general'].includes(topic.tag) && isText(topic.text))
    || !value.warmupTopics.some((topic) => topic.tag === 'general')
    || !exactKeys(value.meituLines, LINE_KEYS) || !Object.values(value.meituLines).every(isTable)) {
    throw new Error('local turn content: invalid three-table structure');
  }
  // Validate only: preserve every original character, item, duplicate and order.
  return value;
}

function mergeKeyed(base, overrides) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(overrides ?? {})) out[key] = value;
  return out;
}

/**
 * 世界段 + 角色段的合成（阶段 4）：
 * - 世界包激活时 `warmupTopics` / `meituLines` 来自世界包；
 * - `styleNudges` 仍内容包优先（角色包只覆盖它）/ 旧快照回退；
 * - 没有世界包时与改造前逐字段一致（无旧快照且无内容包 → null）。
 *
 * @param {object|null} legacyContent 旧快照（可缺省）
 * @param {{worldSections?: object|null, packSections?: object|null}} [options]
 */
export function composeTurnContent(
  legacyContent,
  { worldSections = null, packSections = packsAsStyleNudges(PACKS) } = {},
) {
  if (!legacyContent) {
    // 官方安装已迁移：世界两张表来自世界包，风格表来自内容包；都没有才回退 null。
    if (!worldSections && !packSections) return null;
    const content = {};
    if (packSections) content.styleNudges = { ...packSections.styleNudges };
    if (worldSections) {
      content.warmupTopics = worldSections.warmupTopics;
      content.meituLines = worldSections.meituLines;
    }
    return content;
  }
  if (!packSections && !worldSections) return legacyContent;
  const content = { ...legacyContent };
  if (packSections) content.styleNudges = mergeKeyed(content.styleNudges, packSections.styleNudges);
  if (worldSections) {
    content.warmupTopics = worldSections.warmupTopics;
    content.meituLines = worldSections.meituLines;
  }
  return content;
}

const legacyContent = readLocalTurnContent();
const activeWorld = WORLD_PACKS?.active ?? null;
export const LOCAL_TURN_CONTENT = composeTurnContent(legacyContent, {
  worldSections: activeWorld ? worldAsTurnSections(activeWorld) : null,
});
