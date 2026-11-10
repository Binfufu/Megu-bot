/**
 * Optional fixed-path infrastructure display/content data, not a package loader.
 * Same Node 24 readFileSync + JSON.parse boundary as the other local content tables:
 * ENOENT selects original neutral examples; any other read/parse/schema error is loud
 * and never includes local payload, parser excerpts, filesystem paths or causes.
 * No executable JSON, arbitrary regex source, discovery, numeric policy or network.
 */
import { readFileSync } from 'node:fs';

const CONTENT_URL = new URL('../content/local/infra.json', import.meta.url);
const PEOPLE_IDS = ['agent:her', 'agent:aris', 'player:self', 'person:creator', 'person:companion', 'person:aqua'];
const SPRITE_KEYS = ['MEGUMIN_SPRITE', 'TREE_SPRITE', 'BIG_TREE_SPRITE', 'REED_SPRITE', 'BUCKET_SPRITE'];
/**
 * 看病提示词模板里**登记的占位符**（白名单）。多了/少了都在 import 期炸:
 * 未登记的 `{xxx}` 会被原样留下(见 `template()`),而模板是要交给模型的正文 ——
 * 一个拼错的占位符不能静默地变成"{doctorr}"进她的嘴。
 */
export const HEALER_PROMPT_PLACEHOLDERS = ['place', 'doctor', 'work', 'disease', 'line', 'heard', 'silentToken'];
/**
 * 诊疗所当值医生提示词(成功/失败)。**只有具名占位,没有数字**:
 * 诊金与数值结算在 `src\index.js`(那里的 `AQUA_FEE` 是唯一口径),
 * 提示词只许说"钱付过了、多少不用报"。
 *
 * ⚠️ 这两段放进 `DEFAULT_INFRA_CONTENT` 也放进 C 区私有 `content/local/infra.json`
 *    (`keys()` 要求顶层键**精确相等**)—— 默认这份是**中性无 IP**的,缺私有内容时可用。
 */
const HEALER_PROMPTS = {
  success: '{heard} 你刚病了（{disease}），自己走去{place}看病。今天当值的是{doctor}，{work}；见了你，{line}。\n\n刚发生的事（系统给的，照做）：\n· 病已经治好了，钱也付过了（多少不用报）。这一趟是你自己去的，不是谁叫你去的。\n\n一句到两句：像从诊疗所出来、走在路上随口说一句那样——说说现在哪儿松快了，或者吐槽{doctor}两句。别写成「我已康复」这种通知体，别提问、别提系统。不想说就整条回 {silentToken}。',
  failure: '{heard} 你刚病了（{disease}），自己走去{place}看病。今天当值的是{doctor}，{work}；见了你，{line}。\n\n刚发生的事（系统给的，照做）：\n· {doctor}忙活了半天，病不但没好，你还被折腾得更难受了（钱包也轻了，多少不用报）。这一趟是你自己去的，不是谁叫你去的。\n\n一句到两句：像从诊疗所出来时带着一肚子气那样——抱怨两句、骂两句庸医也行。别写成「治疗失败」这种通知体，别提问、别提系统。不想说就整条回 {silentToken}。',
};
const marker = Array.from({ length: 48 }, (_, y) => y >= 12 && y < 36 ? '..........XXXXXXXXXXXX..........' : '.'.repeat(32));

/** Neutral examples only. Legacy node/sprite ids remain stable for existing consumers. */
export const DEFAULT_INFRA_CONTENT = {
  schemaVersion: 1,
  primaryName: '示例助手',
  secondaryName: '示例助手乙',
  healerName: '治疗者',
  /**
   * 诊疗所背景 NPC 名册(自助求医用)。`llm: null` = **这一轮不接模型**:
   * 当值医生只从名册里读名字/口头禅来拼提示词,那句台词仍由她那一次回复生成。
   * 将来要给医生接小模型,把 `llm` 换成 `{model, prompt}` 即可(接口先留在这里);
   * 代码现在只认 `null` 这一种,**本轮绝不新增任何模型调用**。
   */
  healers: {
    prompt: { ...HEALER_PROMPTS },
    doctors: [
      { id: 'clinic-1', name: '白袍医师', work: '正整理药柜', line: '先坐下，我看看', days: [1], llm: null },
      { id: 'clinic-2', name: '笑面医师', work: '在翻病历', line: '别紧张，小毛病', days: [2], llm: null },
      { id: 'clinic-3', name: '老医师', work: '在柜台后打盹', line: '这病我见得多', days: [0, 3], llm: null },
      { id: 'clinic-4', name: '年轻医师', work: '在磨药材', line: '先坐，我看看脉', days: [4], llm: null },
      { id: 'clinic-5', name: '药房医师', work: '在配药', line: '交给我吧', days: [5], llm: null },
      { id: 'clinic-6', name: '值班医师', work: '在写方子', line: '先说说哪里难受', days: [6], llm: null },
    ],
  },
  skillName: '技能',
  memoryTags: { person: ['朋友', '老师', '主人', '老板'], place: ['社区', '学校', '公司', '家'] },
  encyclopediaNote: '【科普模式】这一轮是「细说 / 为什么 / 是什么」这类求知识的问题：请基于上面的资料，给一段约 100 字的说明——先用一句话给结论，再补一两个关键细节；保持自己的语气，可以用自己的口吻讲出来，但这一轮不受「不超过两句话」的长度限制；需要分条讲清楚时就分条讲，不必强行压成一段。资料里没有的部分不要编。',
  relayFilePrefix: '聊天记录',
  announceTitleInstruction: '1. 第一行原样保留「{primaryName} x.y.z」这个版本号标题，不要改写、不要只写数字；',
  fishingNames: [],
  declaredPeople: [
    { id: 'agent:her', label: '主助手', kind: 'bot', self: true, derived: true, note: '当前实例的世界视角' },
    { id: 'agent:aris', label: '协作助手', kind: 'bot', derived: true, note: '可选的另一助手实例；展示不代表它当前在线' },
    { id: 'player:self', label: '玩家占位', kind: 'acquaintance', declared: true, note: '尚未关联账号时使用的声明占位，不是已识别用户' },
    { id: 'person:creator', label: '操作者', kind: 'creator', declared: true, relations: { tag: 'agent:her' }, note: '声明的操作者关系，不冒充运行期身份事实' },
    { id: 'person:companion', label: '同伴占位', kind: 'companion', declared: true, relations: { tag: 'agent:her' }, note: '声明的示例同伴，不属于既有作品' },
    { id: 'person:aqua', label: '治疗者占位', kind: 'goddess', declared: true, relations: { tag: 'agent:her' }, note: '治疗角色的兼容节点；kind 是既有图分类，不是人物设定' },
  ],
  pixel: {
    palette: { '.': null, X: '#5b9db8', T: '#4b8065', U: '#8b7355', L: '#8b7355', w: '#5688a6' },
    sprites: {
      MEGUMIN_SPRITE: marker,
      TREE_SPRITE: ['..T..', '.TTT.', 'TTTTT', '..U..'],
      BIG_TREE_SPRITE: ['...T...', '..TTT..', '.TTTTT.', 'TTTTTTT', '...U...', '...U...'],
      REED_SPRITE: ['.T.', 'TTT', '.T.'],
      BUCKET_SPRITE: ['LLLL', 'L..L', 'LLLL'],
    },
  },
};

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const texts = (value) => Array.isArray(value) && value.every(text);
const template = (value, allowed) => text(value) && !/[{}]/u.test(value.replace(/\{([^{}]*)\}/gu, (token, key) => allowed.includes(key) ? '' : token));
function validPeople(rows) {
  return Array.isArray(rows) && rows.length === PEOPLE_IDS.length && rows.every((row, index) => {
    const shape = DEFAULT_INFRA_CONTENT.declaredPeople[index];
    return keys(row, Object.keys(shape)) && row.id === PEOPLE_IDS[index] && row.kind === shape.kind
      && text(row.label) && text(row.note)
      && ['self', 'derived', 'declared'].every((key) => !Object.hasOwn(shape, key) || row[key] === shape[key])
      && (!Object.hasOwn(shape, 'relations') || keys(row.relations, ['tag']) && row.relations.tag === 'agent:her');
  });
}
/**
 * 诊疗所名册的严格校验(A 区契约):
 *   ① 层级键精确(`healers` = prompt + doctors;prompt = success + failure;doctor = 六列);
 *   ② 模板只许出现登记过的具名占位(不许数字、不许未知占位);
 *   ③ 名册 **6 人**、`llm === null`、`days` 是 0..6(local 星期几)且**每天恰好一个人当值**
 *      (`days` 长度 1 或 2 —— 同一人可以占两天);
 *   ④ id 不重复。
 * 任何一条不满足 → import 期炸(和其余固定内容同一条边界,不静默降级到半份名册)。
 */
function validHealers(healers) {
  if (!keys(healers, ['prompt', 'doctors']) || !keys(healers.prompt, ['success', 'failure'])) return false;
  if (!['success', 'failure'].every((kind) => template(healers.prompt[kind], HEALER_PROMPT_PLACEHOLDERS))) return false;
  const doctors = healers.doctors;
  if (!Array.isArray(doctors) || doctors.length !== 6) return false;
  const ids = new Set();
  const covered = new Set();
  for (const row of doctors) {
    if (!keys(row, ['id', 'name', 'work', 'line', 'days', 'llm']) || !text(row.id) || !text(row.name)
      || !text(row.work) || !text(row.line) || row.llm !== null) return false;
    if (ids.has(row.id)) return false;
    ids.add(row.id);
    if (!Array.isArray(row.days) || row.days.length < 1 || row.days.length > 2) return false;
    for (const day of row.days) {
      if (!Number.isInteger(day) || day < 0 || day > 6 || covered.has(day)) return false;
      covered.add(day);
    }
  }
  return covered.size === 7;
}
function validPixel(pixel) {
  if (!keys(pixel, ['palette', 'sprites']) || !object(pixel.palette) || !Object.hasOwn(pixel.palette, '.') || pixel.palette['.'] !== null
    || !Object.entries(pixel.palette).every(([key, value]) => /^[.A-Za-z]$/u.test(key) && (value === null || typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)))
    || !keys(pixel.sprites, SPRITE_KEYS)) return false;
  return Object.values(pixel.sprites).every((rows) => Array.isArray(rows) && rows.length > 0 && rows.length <= 256
    && rows.every((row) => typeof row === 'string' && row.length > 0 && row.length <= 256 && [...row].every((ch) => Object.hasOwn(pixel.palette, ch))));
}
function valid(value) {
  return keys(value, Object.keys(DEFAULT_INFRA_CONTENT)) && value.schemaVersion === 1
    && ['primaryName', 'secondaryName', 'healerName', 'skillName'].every((key) => text(value[key]))
    && keys(value.memoryTags, ['person', 'place']) && Object.values(value.memoryTags).every(texts)
    && template(value.encyclopediaNote, ['secondaryName']) && template(value.relayFilePrefix, ['secondaryName'])
    && template(value.announceTitleInstruction, ['primaryName']) && texts(value.fishingNames)
    && validPeople(value.declaredPeople) && validHealers(value.healers) && validPixel(value.pixel);
}

/** Injectable read boundary for offline checks; the runtime path and schema stay fixed. */
export function readLocalInfraContent(read = readFileSync) {
  let source;
  try { source = read(CONTENT_URL, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(DEFAULT_INFRA_CONTENT);
    throw new Error('local infra content: read failed');
  }
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error('local infra content: invalid JSON'); }
  if (!valid(value)) throw new Error('local infra content: invalid fixed schema');
  return value;
}
export const INFRA_CONTENT = readLocalInfraContent();

/**
 * **今天当班的医生**(纯函数;按**本地**星期几确定性轮班)。
 *
 * `days` 用 JS 的 `Date#getDay()` 口径:`0`=周日 … `6`=周六(名册契约见
 * `DEFAULT_INFRA_CONTENT.healers` 与 `validHealers()`)。名册由严格校验保证"每天恰好一个人",所以这里**不需要随机源** ——
 * 同一个 `now` 永远给同一个医生,单测可以钉死。
 *
 * @param {number|Date} [now] 时刻(默认现在)
 * @param {Array<object>} [doctors] 名册(默认读内容层;测试可注入)
 * @returns {null | {id: string, name: string, work: string, line: string, days: number[], llm: null}}
 */
export function doctorOnDuty(now = Date.now(), doctors = INFRA_CONTENT.healers?.doctors ?? []) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const weekday = new Date(Number.isFinite(at) ? at : Date.now()).getDay();
  return (Array.isArray(doctors) ? doctors : [])
    .find((row) => Array.isArray(row?.days) && row.days.includes(weekday)) ?? null;
}

/**
 * 用内容层的**看病模板**拼提示词(纯函数)。只替换登记过的具名占位,不做任意求值。
 *
 * @param {'success'|'failure'} kind 这一次治疗成功/失败(帮倒忙)
 * @param {{place?: string, doctor?: string, work?: string, disease?: string, line?: string,
 *   heard?: string, silentToken?: string}} [facts]
 * @returns {string} 拼好的提示词;模板缺失/不合法时返回空串(调用方 fail closed)
 */
export function fillHealerPrompt(kind, facts = {}, healers = INFRA_CONTENT.healers) {
  const source = healers?.prompt?.[kind];
  if (!text(source)) return '';
  return source.replace(/\{([a-zA-Z]+)\}/gu, (token, key) => {
    if (!HEALER_PROMPT_PLACEHOLDERS.includes(key)) return token;
    const value = facts?.[key];
    return typeof value === 'string' ? value : '';
  });
}

/** Only replace declared display placeholders, never evaluate strings as code. */
export function infraText(value) {
  return value.replace(/\{(primaryName|secondaryName)\}/gu, (_, key) => INFRA_CONTENT[key]);
}
/**
 * 把一个字符串当**正则字面量**安全嵌入（Node 22 兼容）。
 *
 * ⚠️ `RegExp.escape()` 是 Node 24+/V8 13 才有的 API；本仓 README 与 CI 矩阵都是 Node 22/24，
 * 在 Node 22 上直接调用会让整个模块 import 期崩（TypeError: RegExp.escape is not a function）。
 * 这里只转义正则语法字符——本仓用法都是短的中文名/货币名字面量，不依赖 RegExp.escape 的
 * 额外边界行为（如空串/数字开头），语义一致。
 */
export function escapeRegExpLiteral(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Names are literal data. Escaping prevents content from changing the grammar.
export const FISHING_NAME_PATTERN = new RegExp(`(一起|陪她|带她${INFRA_CONTENT.fishingNames.map((name) => `|带${escapeRegExpLiteral(name)}`).join('')})钓`);
const healer = escapeRegExpLiteral(INFRA_CONTENT.healerName);
export const HEALER_PATTERNS = [new RegExp(`求${healer}`), new RegExp(`找${healer}`), new RegExp(`让${healer}`), new RegExp(`${healer}(帮忙|治|救)`), new RegExp(`叫${healer}`)];
