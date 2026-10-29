/**
 * **记忆反思层**(P2-A,2026-10-22,方案 §4.4 / D250 定稿 #6)。
 *
 * ## 照搬的是什么(照搬清单纪律:能一句话说出方案与出处)
 *
 *   · **GenAgents reflection**(Park et al. 2023,"Generative Agents",arXiv:2304.03442):
 *     定期把最近的记忆交给出一个小的总结调用,产出**少量高层结论**("洞察"),
 *     而不是把原文再抄一遍。我们改的一点:它用"重要性分数累加过阈值"触发,
 *     我们按 D250 定稿改成**固定 20h 一拍**(单用户 1 次/天,阈值累加那套是 25 个 agent
 *     的游戏时钟口径,照搬反而费钱)。
 *   · **Mem0 Synthesis**(mem0ai/mem0,2024 起):综合出的结论**必须带来源**,
 *     否则无法审计"这是从哪看出来的"。我们改的一点:它是"更新式"(新旧融合覆盖),
 *     我们按本项目记忆线的 ADD-only 纪律做成**只增不改**——旧洞察永远留着可审计。
 *
 * ## 三条边界(与摘要层 D91 同族,一条都不许破)
 *
 *   1. **本模块零模型调用** —— 生成是纯编排:`generate` 由调用方注入(生产 = summarizer
 *      那条子会话线),测试给假回调。它绝不出现在交接/对话路径上(死锁纪律,见 memory-store D91)。
 *   2. **只增不改** —— 写入路径只有 INSERT,坏输出一个字都不进库(绝不半写);
 *      旧洞察永远留着可审计(没有 UPDATE / DELETE 路径)。
 *   3. **引用必须是真的** —— 每条洞察必须带 derived_from(真实 note.id 数组);
 *      引用了不存在的笔记 = 整批拒收(引用答不出出处的洞察不许入库)。
 */

import { cleanMemoryText } from './memory-archive.js';

/**
 * 一条洞察至少要能引到几条笔记。洞察 = **跨多条**记忆的模式总结;
 * 只引一条的"洞察"其实是复述,那是检索的活 —— 直接拒,不浪费库位。
 */
export const INSIGHT_MIN_NOTES = 2;

/** 注入端的默认预算:≤3 条 × ≤120 字 = 360(生产由 config 的两数相乘派生,这里只兜底)。 */
export const INSIGHT_BUDGET_CHARS = 360;

/** node:sqlite 查表在不在(memory-store 里那份是私有函数,这里不引第二份依赖)。 */
function hasTable(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(name)));
  } catch {
    return false;
  }
}

/** note 表有没有某一列(老库靠 ensureNoteSchema 补列;补之前读写都按"没有"降级)。 */
function noteHasColumn(db, name) {
  try {
    return db.prepare('PRAGMA table_info(note)').all().some((col) => col?.name === name);
  } catch {
    return false;
  }
}

/**
 * 洞察**该不该生成**?**纯函数**,可测。判据:库里一条都没有 = 该写(第一条总要有人写);
 * 距最新一条不足 everyMs = 不急(20h 限频,D250 #6 的"1 次/天");everyMs = 0 = 每拍都算(测试/手动用)。
 *
 * @param {number|null} latestCreatedAt 库里最新一条洞察的 created_at(没有 = null)
 * @param {{everyMs?: number, now?: number}} [options]
 */
export function insightsDue(latestCreatedAt, { everyMs = 20 * 3600 * 1000, now = Date.now() } = {}) {
  if (latestCreatedAt == null) return true;
  if (!(Number(everyMs) > 0)) return true;
  return now - Number(latestCreatedAt) >= Number(everyMs);
}

/** 库里最新一条洞察的时刻(没有表/没有行 → null)。 */
export function latestInsightCreatedAt(db) {
  if (!hasTable(db, 'insight')) return null;
  const row = db.prepare('SELECT MAX(created_at) AS at FROM insight').get();
  return row?.at == null ? null : Number(row.at);
}

/**
 * 生成洞察的输入材料之一:**最近 N 条有效固化笔记,带真实 note.id**。
 * (与 memory-store 的 recentNotesText 同一条 SQL 口径 —— 软失效/合并掉的不要,
 * 一行一条 ≤80 字截断;区别只在它同时要 id,derived_from 的校验全靠这批真实 id。)
 *
 * @returns {Array<{id: number, text: string}>}
 */
export function recentInsightNotes(db, { limit = 30, charsPerNote = 80 } = {}) {
  if (!hasTable(db, 'note')) return [];
  const merged = noteHasColumn(db, 'merged_into') ? ' AND merged_into IS NULL' : '';
  const rows = db.prepare(
    `SELECT id, text FROM note WHERE invalid_at IS NULL${merged} ORDER BY at DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(200, limit)));
  return rows
    .map((row) => ({ id: Number(row.id), text: cleanMemoryText(String(row.text ?? '')).slice(0, charsPerNote) }))
    .filter((row) => Number.isInteger(row.id) && row.text !== '');
}

/**
 * 读最新的几条洞察(给注入与生成提示词用)。表不在 → [](老库/只读连接降级)。
 * derived_from 解析不出来 = 视为空数组(不让一条坏行把渲染整个带崩)。
 */
export function latestInsights(db, { limit = 10 } = {}) {
  if (!hasTable(db, 'insight')) return [];
  const rows = db.prepare(
    'SELECT id, text, derived_from, model, created_at FROM insight ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(Math.max(1, Math.min(50, limit)));
  return rows.map((row) => {
    let derivedFrom = [];
    try {
      const parsed = JSON.parse(String(row.derived_from ?? '[]'));
      if (Array.isArray(parsed)) derivedFrom = parsed.map(Number).filter(Number.isInteger);
    } catch {
      derivedFrom = [];
    }
    return {
      id: Number(row.id),
      text: String(row.text ?? ''),
      derivedFrom,
      model: row.model == null ? null : String(row.model),
      createdAt: Number(row.created_at) || 0,
    };
  });
}

/**
 * **纯编排**:拼提示词 → 调 generate → 严格解析 JSON → 产出要落库的洞察。
 * 与 buildMemoryBlocks 同一个形状(memory 层零 HTTP;generate 由调用方注入)。
 *
 * **输出 JSON 形状严格**(方案 §4.4 硬要求):只认 `{"insights":[{"text","derived_from"}]}`;
 * 坏 JSON / 空输出 / 缺字段 / **假引用** / 单条只引一篇 → 全部按"这一批不写"处理,
 * 返回 error 说清原因且**绝不抛**。任何一条不合格都整批拒(宁可这拍不写,也不写半批 —— 测试钉着)。
 *
 * @param {{notes: Array<{id: number, text: string}>,
 *          existing?: Array<{text: string}>,
 *          generate: (prompt: string) => Promise<string|null>,
 *          maxPerRun?: number, limitChars?: number}} options
 * @returns {Promise<{insights: Array<{text: string, derivedFrom: number[]}>, error: string|null, raw: string|null}>}
 */
export async function buildInsights({
  notes,
  existing = [],
  generate,
  maxPerRun = 3,
  limitChars = 120,
} = {}) {
  const cap = Math.max(1, Math.min(10, Number(maxPerRun) || 3));
  const chars = Math.max(1, Math.min(500, Number(limitChars) || 120));
  if (typeof generate !== 'function') {
    return { insights: [], error: 'generate 不是函数', raw: null };
  }
  // 笔记要先过一遍:没有 id 或没有正文的行不配当引用来源(引用必须是真实 note.id)。
  const validNotes = (Array.isArray(notes) ? notes : []).filter(
    (note) => note && Number.isInteger(Number(note.id)) && String(note.text ?? '').trim() !== '',
  );
  if (validNotes.length < INSIGHT_MIN_NOTES) {
    return {
      insights: [],
      error: `固化笔记不足(有效 ${validNotes.length} 条,跨笔记的模式至少要 ${INSIGHT_MIN_NOTES} 条)`,
      raw: null,
    };
  }
  const validIds = new Set(validNotes.map((note) => Number(note.id)));
  const notesText = validNotes.map((note) => `${note.id}. ${note.text}`).join('\n');
  const existingText = (Array.isArray(existing) ? existing : [])
    .map((item) => String(item?.text ?? '').trim())
    .filter(Boolean)
    .map((text) => `· ${text}`)
    .join('\n');
  const prompt = [
    '你在维护一个记忆系统的"洞察"层。**洞察 = 跨多条记忆的模式总结**(比如「他最近常熬夜」「你们在冷战」),',
    '不是复述任何一条笔记 —— 单条笔记里已经写明的事是检索的活,不归洞察管。',
    '',
    '要求:',
    '1. **第三人称、事实陈述**(「他…」「你们…」)—— 不要模仿她的语气、不要写台词、',
    '   不要用「吾」这类自称;它是背景观察,不是她要说的内容;',
    '2. 只写**跨多条笔记才看得出来的模式**:同一件事反复出现、状态有变化才值得写;',
    `3. 每条不超过 ${chars} 字,最多 ${cap} 条;宁缺毋滥 —— 没有新模式就少写或不写;`,
    '4. 不要编造:笔记里没有的事不许写;不确定的就不写;',
    '5. 每条必须带 derived_from:这条洞察是从哪几条笔记看出来的(编号数组,只能是下面列出的',
    `   真实编号,至少 ${INSIGHT_MIN_NOTES} 条 —— 说不出出处的洞察没有价值);`,
    '6. 不要与"已有洞察"重复(意思接近也算重复)。',
    '',
    '输出要求:只输出一个 JSON 对象,不要 JSON 以外的任何文字。形状:',
    '{"insights":[{"text":"洞察正文","derived_from":[12,15]}]}',
    '',
    '已有洞察(别重复):',
    existingText === '' ? '(还没有)' : existingText,
    '',
    `最近的固化笔记(行首数字 = 笔记编号,倒序):`,
    notesText,
  ].join('\n');
  let raw = null;
  try {
    raw = await generate(prompt);
  } catch (err) {
    return { insights: [], error: `生成调用失败:${err?.message ?? err}`, raw: null };
  }
  const text = String(raw ?? '').trim();
  if (text === '') return { insights: [], error: '模型没写出东西', raw: null };
  // 模型爱在 JSON 外面包说明/代码栏 —— 截最后一个 { 到第一个 }(照 buildMemoryBlocks 的同一步;
  // 贪不住就如实报错,这一批不写)。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { insights: [], error: '输出里没有 JSON 对象', raw: text };
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { insights: [], error: `JSON 解析失败:${err?.message ?? err}`, raw: text };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { insights: [], error: 'JSON 不是对象', raw: text };
  }
  if (!Array.isArray(parsed.insights)) return { insights: [], error: '输出缺 insights 字段(或不是数组)', raw: text };
  if (parsed.insights.length === 0) return { insights: [], error: '输出里没有洞察', raw: text };
  const list = parsed.insights.slice(0, cap); // 超量的直接不要(入库口径 = ≤maxPerRun)
  // 每一条都过严检:任何一条不合格 → **整批不写**(绝不半写;测试钉着这条)。
  const seen = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { insights: [], error: `第 ${index + 1} 条不是对象`, raw: text };
    }
    const insightText = String(item.text ?? '').trim();
    if (insightText === '') return { insights: [], error: `第 ${index + 1} 条缺 text(或为空)`, raw: text };
    if (!Array.isArray(item.derived_from) || item.derived_from.length === 0) {
      return { insights: [], error: `第 ${index + 1} 条缺 derived_from(或为空数组)`, raw: text };
    }
    const refs = new Set();
    for (const entry of item.derived_from) {
      const id = Number(entry);
      if (!Number.isInteger(id) || !validIds.has(id)) {
        return {
          insights: [],
          error: `第 ${index + 1} 条的 derived_from 引用了不存在的笔记(${JSON.stringify(entry) ?? entry})—— 整批不写`,
          raw: text,
        };
      }
      refs.add(id);
    }
    if (refs.size < INSIGHT_MIN_NOTES) {
      return {
        insights: [],
        error: `第 ${index + 1} 条只引用了 ${refs.size} 条笔记(单条来源是复述,不是洞察)—— 整批不写`,
        raw: text,
      };
    }
    const key = insightText;
    if (seen.has(key)) return { insights: [], error: `第 ${index + 1} 条与同批重复`, raw: text };
    seen.add(key);
  }
  const insights = list.map((item) => ({
    text: String(item.text).trim().slice(0, chars),
    derivedFrom: [...new Set(item.derived_from.map(Number))].sort((a, b) => a - b),
  }));
  // 与已有洞察去重(库里已有的措辞/意思照抄一遍没价值;全重复 = 这拍没有新模式,如实说)。
  const existingSet = new Set(
    (Array.isArray(existing) ? existing : []).map((item) => String(item?.text ?? '').trim()).filter(Boolean),
  );
  const fresh = insights.filter((item) => !existingSet.has(item.text));
  if (fresh.length === 0) return { insights: [], error: '输出全是已有洞察的重复', raw: text };
  return { insights: fresh, error: null, raw: text };
}

/**
 * 落库(**只增不改**:纯 INSERT,一个事务里全进或全不进 —— 绝不半写)。
 * 返回 written / refs(引用的笔记条数,给日志与审计)。
 */
export function appendInsights(db, insights, { model = null, now = Date.now() } = {}) {
  const list = (Array.isArray(insights) ? insights : []).filter(
    (item) => item && String(item.text ?? '').trim() !== ''
      && Array.isArray(item.derivedFrom) && item.derivedFrom.length > 0,
  );
  if (list.length === 0) return { written: 0, refs: 0 };
  if (!hasTable(db, 'insight')) return { written: 0, refs: 0 }; // 老库没表:不写(与读端降级对称)
  const ins = db.prepare(
    'INSERT INTO insight (text, derived_from, model, created_at) VALUES (?, ?, ?, ?)',
  );
  let refs = 0;
  db.exec('BEGIN');
  try {
    for (const item of list) {
      const derived = [...new Set(item.derivedFrom.map(Number))].filter(Number.isInteger);
      ins.run(String(item.text).trim(), JSON.stringify(derived), model == null ? null : String(model), now);
      refs += derived.length;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { written: list.length, refs };
}

/**
 * 渲染成注入正文(给 wrapInject('insight', …) 包起来;空 = 一字不加)。
 * 措辞照「这是背景不是台词」那套纪律(与 renderRecall 的【长期记忆·节选】同族);
 * 预算含首行,装不下的行直接不要(与 renderRecall / renderMemoryBlocks 同一截断口径)。
 *
 * `rows` = 调用方**已按作用域过滤好**的洞察(2026-10-28 / P0;口径只在 `src\memory-scope.js`)。
 * 不传 = 取全库最新(保持旧行为,纯渲染判据零改动)。
 */
export function renderInsights(db, { limit = 3, budgetChars = INSIGHT_BUDGET_CHARS, rows = null } = {}) {
  const source = Array.isArray(rows) ? rows : latestInsights(db, { limit });
  if (source.length === 0) return '';
  const header = '【记忆洞察】以下是跨多条记忆看出的背景观察，是背景不是台词：不要复述、不要照着念。';
  const lines = [header];
  let used = header.length;
  for (const row of source) {
    const line = `· ${row.text}`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
