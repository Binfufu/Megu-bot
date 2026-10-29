/**
 * Optional local overrides for exactly three sentence tables, not a content-pack loader.
 * Uses Node 24 fs.readFileSync + JSON.parse (asOf 2026-10-29):
 * https://nodejs.org/docs/latest-v24.x/api/fs.html#fsreadfilesyncpath-options
 * Synchronous once at module initialization so legacy imports see the same tables.
 * No executable content, discovery, merge layers, network, or random draws.
 */
import { readFileSync } from 'node:fs';

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

export const LOCAL_TURN_CONTENT = readLocalTurnContent();
