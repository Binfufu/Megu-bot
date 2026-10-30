/** 技能台词的选择与分句；本地展示内容可选，缺省采用原创通用示例。 */
import { GAMEPLAY_CONTENT } from './local-gameplay-content.js';
import { packsAsSkillTriggerWords } from './content-pack.js';

export const EXPLOSION_CHANTS = GAMEPLAY_CONTENT.explosion.chants;
export const EXPLOSION_FINISHERS = GAMEPLAY_CONTENT.explosion.finishers;

/**
 * 公开集（无内容包）的默认触发词：只放**中性通用**说法，不含任何作品/角色专属词。
 * 角色专属触发词属 C 区内容，由角色包可选 `skill.triggerWords` 提供（格式见 docs/39）。
 */
export const NEUTRAL_TRIGGER_WORDS = Object.freeze(['来一发', '放一个', '咏唱', '念咒', '咒文']);

/**
 * 把一个字符串当**正则字面量**安全嵌入（Node 22 兼容；思路同
 * `local-infra-content.js` 的 `escapeRegExpLiteral`）。包内容只作字面量，不得改变语法。
 */
function escapeRegExpLiteral(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 实际生效的触发词 = 中性默认词 + 所有已加载角色包 `skill.triggerWords` 的字面并集。
 * 不传参/传 undefined 时读取模块级已加载包；显式传 null（或空聚合）只剩中性默认词。
 */
export function explosionTriggerWords(packs) {
  return [...new Set([...NEUTRAL_TRIGGER_WORDS, ...packsAsSkillTriggerWords(packs)])];
}

/** 触发判定正则；`i` 不区分大小写（含英文大小写）语义与改造前一致。 */
const TRIGGER = new RegExp(`(${explosionTriggerWords().map(escapeRegExpLiteral).join('|')})`, 'i');

/** 生效触发正则的源码文本（判据用：公开集不得含作品专属词）。 */
export function explosionTriggerSource() {
  return TRIGGER.source;
}

export function isExplosionRequest(text) {
  const source = String(text ?? '');
  if (source === '') return false;
  return TRIGGER.test(source);
}

/** 选择逻辑、随机次数、近期避重及长度分类保持原样。 */
export function pickChant({ recent = [], length = null, random = Math.random } = {}) {
  const pool = EXPLOSION_CHANTS.filter((chant) => (length ? chant.length === length : true));
  const candidates = pool.filter((chant) => !recent.includes(chant.id));
  const list = candidates.length > 0 ? candidates : (pool.length > 0 ? pool : EXPLOSION_CHANTS);
  return list[Math.floor(random() * list.length) % list.length];
}

export function groupBeats(chant, { maxBeats = 4 } = {}) {
  const limitWanted = Math.max(1, Number(maxBeats) || 1);
  // 显式节拍优先:**够用就原样用**(那是作者/用户定的节奏),超了才合并。
  const explicit = Array.isArray(chant?.beats) && chant.beats.length > 0
    ? chant.beats.map((beat) => (Array.isArray(beat) ? beat.join('') : String(beat)))
    : null;
  const lines = explicit ?? (chant?.zh ?? []);
  if (lines.length === 0) return [];
  const limit = Math.min(limitWanted, lines.length);
  if (lines.length <= limit) return lines;
  // 均匀合并:每组至少 1 句,余数摊给前面的组 —— **保持原有边界**,只是把相邻的并起来。
  const per = Math.floor(lines.length / limit);
  const extra = lines.length % limit;
  const out = [];
  let cursor = 0;
  for (let group = 0; group < limit; group += 1) {
    const size = per + (group < extra ? 1 : 0);
    out.push(lines.slice(cursor, cursor + size).join(''));
    cursor += size;
  }
  return out;
}

export function pickFinisher({ recent = [], random = Math.random } = {}) {
  const candidates = EXPLOSION_FINISHERS.filter((line) => !recent.includes(line));
  const list = candidates.length > 0 ? candidates : EXPLOSION_FINISHERS;
  return list[Math.floor(random() * list.length) % list.length];
}

export function buildExplosion({
  recentChants = [],
  recentFinishers = [],
  length = null,
  maxBeats = 4,
  random = Math.random,
} = {}) {
  const chant = pickChant({ recent: recentChants, length, random });
  const finisher = pickFinisher({ recent: recentFinishers, random });
  const beats = groupBeats(chant, { maxBeats });
  return {
    chant: beats.join('\n'),
    beats,
    finisher,
    chantId: chant.id,
    chantSource: chant.source,
    length: chant.length,
  };
}

export function chantJapanese(chantId) {
  const jp = EXPLOSION_CHANTS.find((chant) => chant.id === chantId)?.jp;
  // ⚠️ 第二季 / 剧场版 / 外传那几版**没有日文原文**(没抓到,不编),所以这里可能是空的。
  if (!Array.isArray(jp) || jp.length === 0) return null;
  return jp.join('\n');
}

export const CHANT_LENGTHS = Object.freeze(['epic', 'long', 'mid', 'short']);
