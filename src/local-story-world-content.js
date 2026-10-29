/** One optional fixed-schema local content document; no runtime data or package discovery. */
import fs from 'node:fs';

const fields = [
  'schemaVersion', 'storyEvents', 'storyPacks', 'storyClosingWords', 'storyClosingExamples',
  'storyRespondClosing', 'storySettleClosing', 'places', 'worldText', 'companions', 'moduleText',
  'characterDays', 'chronicleKinds', 'eventLabels', 'chronicleText', 'commandEffects',
  'cardClaimNotes', 'keywordGroups', 'arisPhrases', 'opsEffects',
];
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, required, optional = []) => isObject(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value) => Array.isArray(value) && value.every(text);
const textMap = (value) => isObject(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => text(key) && text(item));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const idsAre = (rows, ids) => Array.isArray(rows) && rows.length === ids.length && rows.every((row, index) => row?.id === ids[index]);

function eventsValid(events) {
  return Array.isArray(events) && events.length > 0 && events.every((event) =>
    keysAre(event, ['id', 'setup', 'branches']) && text(event.id) && text(event.setup)
    && Array.isArray(event.branches) && event.branches.length > 0 && event.branches.every((branch) =>
      keysAre(branch, ['id', 'weight', 'line', 'keywords', 'effect']) && text(branch.id)
      && finite(branch.weight) && branch.weight > 0 && text(branch.line) && strings(branch.keywords)
      && isObject(branch.effect) && Object.entries(branch.effect).every(([key, value]) =>
        ['money', 'satiety', 'health', 'mood', 'stamina', 'mana'].includes(key) && finite(value))));
}

function valid(value) {
  if (!keysAre(value, fields) || value.schemaVersion !== 1) return false;
  if (!eventsValid(value.storyEvents) || !keysAre(value.storyPacks, ['megumin', 'aris'])) return false;
  for (const [id, pack] of Object.entries(value.storyPacks)) {
    const required = id === 'megumin' ? ['id', 'label'] : ['id', 'label', 'events'];
    if (!keysAre(pack, required) || pack.id !== id || !text(pack.label)
        || (id !== 'megumin' && !eventsValid(pack.events))) return false;
  }
  if (!strings(value.storyClosingWords) || !value.storyClosingWords.length
      || !strings(value.storyClosingExamples) || !value.storyClosingExamples.length
      || !text(value.storyRespondClosing) || !text(value.storySettleClosing)) return false;
  if (!idsAre(value.places, ['home', 'fishing', 'guild', 'canteen', 'market', 'gallery'])
      || !value.places.every((place) => keysAre(place, ['id', 'name', 'kind', 'travelMs', 'blurb'])
        && text(place.name) && text(place.kind) && finite(place.travelMs) && place.travelMs > 0 && text(place.blurb))) return false;
  if (!keysAre(value.worldText, ['currency', 'questAcceptPrefix', 'questAcceptSuffix', 'questAcceptPlain']) || !Object.values(value.worldText).every(text)) return false;
  if (!idsAre(value.companions, ['megumin', 'aris']) || !value.companions.every((one) =>
    keysAre(one, ['id', 'name', 'fullName', 'theme', 'bot', 'stateDir', 'art', 'blurb'])
    && Object.values(one).every(text) && one.theme === one.id && one.bot === one.id && one.stateDir === one.id
    && /^[a-z0-9_-]+\.(?:png|jpg)$/i.test(one.art))) return false;
  if (!keysAre(value.moduleText, ['burst', 'sword', 'scout', 'talk', 'cook', 'fish', 'slow', 'weak', 'clumsy', 'nosy'])
      || !Object.entries(value.moduleText).every(([id, row]) => keysAre(row, ['name', ...(['burst', 'cook'].includes(id) ? ['note'] : [])])
        && text(row.name) && (!Object.hasOwn(row, 'note') || text(row.note)))) return false;
  if (!keysAre(value.characterDays, ['megumin', 'aris']) || !Object.values(value.characterDays).every((days) =>
    Array.isArray(days) && days.every((row) => keysAre(row, ['month', 'day', 'label', 'source'])
      && Number.isInteger(row.month) && row.month >= 1 && row.month <= 12
      && Number.isInteger(row.day) && row.day >= 1 && row.day <= 31 && text(row.label) && text(row.source)))) return false;
  if (!keysAre(value.chronicleKinds, ['meal', 'fed', 'selfcare', 'event', 'story', 'quest', 'fish', 'sell', 'home', 'potion', 'sleep', 'move', 'illness', 'heal'])
      || !Object.values(value.chronicleKinds).every(text)) return false;
  if (!keysAre(value.eventLabels, ['found_coin', 'someone_treats', 'sold_loot', 'bought_staff', 'tax', 'lost_pouch', 'donated']) || !Object.values(value.eventLabels).every(text)) return false;
  if (!keysAre(value.chronicleText, ['currency', 'manaLabel', 'healFailed']) || !Object.values(value.chronicleText).every(text)) return false;
  if (![value.commandEffects, value.cardClaimNotes, value.opsEffects].every(textMap)) return false;
  if (!keysAre(value.commandEffects, ['/重置', '/状态', '/成长', '/钱包', '/熟人', '/钓鱼', '/委托', '/接 <编号>', '/help', '/重启', '/更新', '/发', '/更新 预览', '/更新 账本', '/更新 回退', '/更新 基线 <版本>', '/更新 <编号>', '/群列表', '/忘了', '/旁白测试', '/发图', '发N张<角色>美图/涩图', '/认人', '/绑定'])
      || !keysAre(value.cardClaimNotes, ['/状态', '/钱包', '/更新', '/群列表', '/成长'])
      || !keysAre(value.opsEffects, ['handoff.js', 'release-status.js', 'log-tail.js', 'restart.js / restart.cmd', 'announce-preview.js', 'announce-reset.js', 'known-group-add.js', 'relay-status.js', 'rhythm-report.js', 'social-observer.js', 'card-eval.js', 'memory-v0.js', 'selftest.js', 'stats-report.js', 'economy-sim.js', 'growth-report.js', 'command-index.js', 'probe.js', 'warmup-status.js', 'memory-archive.js', 'idle-burn.js', 'purge-tool-notes.js', 'profile-scan.js', 'transcript.js', 'verify-qq.js', 'todo-index.js'])) return false;
  if (!Array.isArray(value.keywordGroups) || !value.keywordGroups.every((row) => keysAre(row, ['label', 'words']) && text(row.label) && strings(row.words))) return false;
  return Array.isArray(value.arisPhrases) && value.arisPhrases.every((row) => keysAre(row, ['phrase', 'note']) && text(row.phrase) && text(row.note));
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(new URL('../content/local/story-world.json', import.meta.url), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('本地故事世界内容读取失败');
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('本地故事世界内容不是合法 JSON'); }
  if (!valid(value)) throw new Error('本地故事世界内容结构无效');
  return value;
}

export const LOCAL_STORY_WORLD = load();
