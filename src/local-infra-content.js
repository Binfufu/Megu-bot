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
const marker = Array.from({ length: 48 }, (_, y) => y >= 12 && y < 36 ? '..........XXXXXXXXXXXX..........' : '.'.repeat(32));

/** Neutral examples only. Legacy node/sprite ids remain stable for existing consumers. */
export const DEFAULT_INFRA_CONTENT = {
  schemaVersion: 1,
  primaryName: '示例助手',
  secondaryName: '示例助手乙',
  healerName: '治疗者',
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
    && validPeople(value.declaredPeople) && validPixel(value.pixel);
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
/** Only replace declared display placeholders, never evaluate strings as code. */
export function infraText(value) {
  return value.replace(/\{(primaryName|secondaryName)\}/gu, (_, key) => INFRA_CONTENT[key]);
}
// Names are literal data. Native RegExp.escape prevents content from changing the grammar.
export const FISHING_NAME_PATTERN = new RegExp(`(一起|陪她|带她${INFRA_CONTENT.fishingNames.map((name) => `|带${RegExp.escape(name)}`).join('')})钓`);
const healer = RegExp.escape(INFRA_CONTENT.healerName);
export const HEALER_PATTERNS = [new RegExp(`求${healer}`), new RegExp(`找${healer}`), new RegExp(`让${healer}`), new RegExp(`${healer}(帮忙|治|救)`), new RegExp(`叫${healer}`)];
