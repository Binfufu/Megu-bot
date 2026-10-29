/**
 * **复制粘贴梗**(2026-10-14,用户委派):副实例的「念长梗」素材库 + 触发判据。
 *
 * ## 这是什么
 *
 * 互联网上有一类**长篇复制粘贴梗** —— 有人用一个**过分精确的提问**（年月日 + 经纬度 +
 * 「某个事件发生前的 41 秒发生了什么」这种多段追问）点名，被点名的人就**把一整段戏剧化长文
 * 照念出来**。用户给的例子就是某作品的长梗那段（"真拿你们没办法，坐好喽……"）。
 *
 * 副实例的人设硬规矩是「正常发言不超过两句话」——**念梗是这个规矩唯一的破例场合**，
 * 所以这件事必须由代码判、不能靠她自己猜（她自己猜 = 每轮都可能跑偏）。
 *
 * ## 分工（照 D163：事实与要求不能同居一栏）
 *
 * · **素材（事实）** → `copypastaFact()`：梗的**逐字原文**，随 `turnFacts()` 贴在消息旁边；
 * · **要求（表达）** → `copypastaNote()`：这一轮"整段念出来、别复述别续写"，
 *   随 `turnNotes()` 进「表达要求」块。
 *
 * ⚠️ **原文一律逐字照念**：本模块不裁剪、不改写、不摘要（裁剪版长度由 `validateEntry` 卡，
 *    卡掉的是整条，不是截断）。
 *
 * ## 库在哪
 *
 * `<工作区>\梗库-复制粘贴.json`（副实例的工作区 = `demo-workspace`）。
 * 库是**卡库侧的内容**，加梗只改 JSON，不动代码；库缺了/坏了**不报错**，
 * 只是这一轮没有梗可念（主实例的工作区里就没有这个文件）。
 *
 * ## 挑梗的口径（用户 2026-10-14 定，别自作聪明）
 *
 * **复制粘贴梗本来就没有逻辑** —— 所以挑梗**不看"问题主题"的语义相关性**，只认
 * `entry.keywords` 里那些词是否出现在这一轮的原话里；**关键词必须是该条正文里出现过的词**
 * （作品 / 人物 / 梗名 / 专有名词），**不许从帖子标题或题材推**：
 * 第一版 28 条里 22 条踩了这个坑（给示例作品那条打了「新宿」「示例作品」，而正文里根本没这些字），
 * 于是标签永远打不中、匹配退化成随机。一条都不沾 → **随机兜底**（这本身就是对的）。
 * 判据在 `scripts\selftest-copypasta.js`（关键词必须是正文子串 + 候选池全覆盖）。
 *
 * ## 触发判据（阈值都是**暂定**，等用户拍板）
 *
 * 两类信号相加，且**必须带一个"点梗意图"信号**才算命中 —— 光有"精确时间 + 发生了什么"
 * 是**真诚提问**（"2018年12月24日发生了什么？"），不该被梗岔开。
 *
 * | 类别 | 信号 | 分 |
 * |---|---|---|
 * | 意图 | 坐好 / 搬好板凳（"我已经坐好了"） | 3 |
 * | 意图 | 离谱坐标（北纬/东经/度分/°） | 2 |
 * | 意图 | 明说"复制粘贴 / 念一段 / 整段念" | 2 |
 * | 语境 | 精确时间（年月日 / 月日 / 分秒 / 时:分） | 2 |
 * | 语境 | "发生了什么 / 怎么回事 / 是什么" | 2 |
 * | 语境 | 多段追问（`/` 分段 ≥3 或问号 ≥2） | 1 |
 *
 * 命中线 `score >= 4`（**暂定**）且至少一个意图信号。
 */

import fs from 'node:fs';

/** 库文件名（放在角色卡工作区里）。 */
export const COPYPASTA_FILE = '梗库-复制粘贴.json';
/** 命中线（**暂定**，用户拍板后连判据一起改）。 */
export const COPYPASTA_TRIGGER_SCORE = 4;

/** 单条正文长度窗口（超出整条丢弃，**不截断**）。 */
export const COPYPASTA_MIN_CHARS = 120;
export const COPYPASTA_MAX_CHARS = 1500;

/**
 * 信号表。`weight` 相加；`intent=true` 的必须至少命中一个。
 * ⚠️ 正则都写成"宽进"（宁可多认几种写法），真正的闸门是**分数 + 意图**两道。
 */
export const COPYPASTA_SIGNALS = Object.freeze([
  { key: 'sitDown', intent: true, weight: 3, label: '坐好', re: /(我已经坐好|我坐好|坐好了|坐好咯|坐好喽|搬好(?:板凳|小板凳)|准备好听了)/ },
  { key: 'geo', intent: true, weight: 2, label: '离谱坐标', re: /(北纬|南纬|东经|西经|经纬度|°|度\s*\d+\s*分)/ },
  { key: 'explicit', intent: true, weight: 2, label: '明说念梗', re: /(复制粘贴|粘贴板|念一段|整段念)/ },
  { key: 'timeSpace', intent: false, weight: 2, label: '精确时间', re: /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*[:：]\s*\d{2}|\d+\s*秒)/ },
  { key: 'askWhat', intent: false, weight: 2, label: '问发生了什么', re: /(发生了什么|怎么回事|是什么|如何|怎样|经历了)/ },
  { key: 'multiSeg', intent: false, weight: 1, label: '多段追问', re: null },
]);

/**
 * 给这一轮的文本打分。
 *
 * @param {string} text 用户这一轮的原话
 * @returns {{score: number, intent: boolean, hits: string[]}}
 */
export function scoreCopypastaAsk(text) {
  const s = typeof text === 'string' ? text : '';
  const hits = [];
  let score = 0;
  let intent = false;
  for (const sig of COPYPASTA_SIGNALS) {
    let ok;
    if (sig.key === 'multiSeg') {
      const segs = s.split(/[/／]/).filter((x) => x.trim().length > 0).length;
      const qs = (s.match(/[?？]/g) ?? []).length;
      ok = segs >= 3 || qs >= 2;
    } else {
      ok = sig.re.test(s);
    }
    if (!ok) continue;
    score += sig.weight;
    hits.push(sig.label);
    if (sig.intent) intent = true;
  }
  return { score, intent, hits };
}

/**
 * 这一轮该不该念梗。
 *
 * 门槛：`score >= COPYPASTA_TRIGGER_SCORE` **且**带着意图信号（坐好 / 坐标 / 明说）。
 * 光有"精确时间 + 发生了什么"是真诚提问，不触发（反证锚点在单测里）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isCopypastaAsk(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.trim().length < 12) return false; // 太短的不可能是这种提问
  const { score, intent } = scoreCopypastaAsk(s);
  return intent && score >= COPYPASTA_TRIGGER_SCORE;
}

/**
 * 校验一条库条目。**不合规就整条丢**（不截断、不改写）。
 *
 * @param {object} raw
 * @param {Set<string>} seenIds 已用过的 id（重复 id 丢弃）
 * @returns {object|null} 规范化后的条目
 */
export function validateEntry(raw, seenIds = new Set()) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!id || seenIds.has(id)) return null;
  if (text.length < COPYPASTA_MIN_CHARS || text.length > COPYPASTA_MAX_CHARS) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k) => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim())
    : [];
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  seenIds.add(id);
  return {
    id,
    title,
    category: typeof raw.category === 'string' ? raw.category : '其他',
    keywords,
    chars: text.length, // 现算,不信文件里写的(会腐烂)
    source,
    text,
  };
}

/**
 * 读库。**读不到不是错误** —— 返回空库，这一轮就是没梗可念。
 *
 * @param {string} filePath
 * @param {{log?: Console}} [options]
 * @returns {{version: number, entries: object[], dropped: number, file: string, ok: boolean}}
 */
export function loadCopypastaCorpus(filePath, { log } = {}) {
  const empty = { version: 1, entries: [], dropped: 0, file: filePath, ok: false };
  if (!filePath) return empty;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    // ENOENT 是正常情况(主实例的工作区没有这个文件),别的错要出声
    if (err && err.code !== 'ENOENT') log?.warn?.(`复制粘贴梗库读不了（${filePath}）：${err.message}`);
    return empty;
  }
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  const seen = new Set();
  const entries = [];
  for (const item of list) {
    const ok = validateEntry(item, seen);
    if (ok) entries.push(ok);
  }
  const dropped = list.length - entries.length;
  if (dropped > 0) log?.warn?.(`复制粘贴梗库丢了 ${dropped} 条（id 重复 / 字数越界 / 结构不对）`);
  return { version: Number(raw?.version ?? 1), entries, dropped, file: filePath, ok: true };
}

/**
 * 挑一条梗：**按关键词命中挑相关的**，一条都不沾就随机给一条。
 *
 * 相关性 = 这一轮话里出现了多少个该条的关键词（长关键词权重更高）。
 *
 * @param {object[]} entries
 * @param {string} text 这一轮用户的原话
 * @param {{rand?: () => number}} [options] 注入假随机，单测用
 * @returns {object|null}
 */
export function pickCopypasta(entries, text, { rand = Math.random } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const s = typeof text === 'string' ? text : '';
  const scored = entries.map((e) => {
    let score = 0;
    for (const kw of e.keywords ?? []) {
      if (kw && s.includes(kw)) score += Math.max(1, kw.length); // 长词 = 更具体
    }
    return { e, score };
  });
  const best = Math.max(...scored.map((x) => x.score));
  const pool = best > 0 ? scored.filter((x) => x.score === best) : scored;
  return pool[Math.floor(rand() * pool.length) % pool.length].e;
}

/** 素材块（走「事实」那一栏；原文逐字，不加工）。 */
export function copypastaFact(entry, { title = true } = {}) {
  if (!entry) return '';
  const head = '【复制粘贴梗·原文照念（别改写、别续写、别摘要）】';
  return title && entry.title ? `${head}\n${entry.title}\n${entry.text}` : `${head}\n${entry.text}`;
}

/** 要求块（走「表达要求」那一栏；只说怎么演，不复述原文）。 */
export function copypastaNote(entry) {
  if (!entry) return '';
  return '这一轮那个人点的是「复制粘贴梗」：把上面那条【复制粘贴梗·原文照念】的正文**整段念出来**'
    + ' —— 这是"不超过两句话"的唯一破例场合。不要复述他的提问、不要解释、不要自己续写结尾；'
    + '念之前可以照素材自己的开场白，念完用一句你自己的短话收尾。';
}

/**
 * 一步到位：这一轮该念就给出两块，不该念返回 null。
 *
 * @param {{entries: object[]}} corpus
 * @param {string} text
 * @param {{rand?: () => number}} [options]
 * @returns {{entry: object, fact: string, note: string}|null}
 */
export function copypastaTurn(corpus, text, options = {}) {
  if (!isCopypastaAsk(text)) return null;
  const entry = pickCopypasta(corpus?.entries ?? [], text, options);
  if (!entry) return null;
  return { entry, fact: copypastaFact(entry), note: copypastaNote(entry) };
}
