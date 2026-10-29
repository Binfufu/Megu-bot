/** 固定本地玩法展示内容：同步只读一次，不发现包、不加载代码、不接收数值规则。 */
import { readFileSync } from 'node:fs';

const LOCAL_URL = new URL('../content/local/gameplay.json', import.meta.url);
const chantIds = ['tv1-2', 'tv1-3', 'tv1-4', 'tv1-6', 'tv1-7', 'tv1-10-first', 'tv1-10-second', 'tv2-5', 'tv2-10', 'tv2-11', 'movie-10555', 'movie-11923', 'spinoff5-origin', 'spinoff9-upper', 'spinoff9-lower', 'spinoff9-combined', 'spinoff12'];
const chantLengths = ['long', 'long', 'mid', 'short', 'short', 'mid', 'mid', 'mid', 'short', 'short', 'mid', 'short', 'epic', 'mid', 'mid', 'long', 'epic'];
// 默认值只定义展示；不包含价格、权重、衰减、阈值、数值效果或随机规则。
export const DEFAULT_GAMEPLAY_CONTENT = {
  schemaVersion: 1,
  currency: { name: '金币', note: '游戏内记账单位，不代表现实货币' },
  moneyLabels: ['没有余额', '余额不足', '余额偏低', '余额尚可', '余额充裕', '余额很多'],
  interactionLabels: { praise: '被夸', poked: '被戳', ignored: '被冷落', fed: '被投喂', chat: '被搭话', intimate: '亲密互动', explosion: '释放技能', rest: '休息' },
  potionDisplay: { mana: { label: '能量补给', tag: '能量恢复品' }, stamina: { label: '体力补给', tag: '体力恢复品' } },
  statsText: { poorRate: '需要寻找工作来支付日常开销', comfortableRate: '当前余额可以支付日常开销', manaLow: '**能量不足以释放技能（要 {cost}）**,收到请求时先说明能量不足', manaEnough: '能量足够释放一次技能' },
  taskLines: ['完成了一项简单工作', '完成了一项普通工作', '完成了一项困难工作', '工作未完成，支付了违约金'],
  eventLines: ['路上拾到一些钱', '收到了一份餐食', '出售了一些材料', '购买了日常用品', '支付了服务费用', '遗失了一些钱', '向公益机构捐了一些钱'],
  questLabels: { trivial: '简单工作', normal: '普通工作', hard: '困难工作', fiasco: '风险工作' },
  economyText: {
    boardEmpty: '（当前没有可接的工作。）', boardHeader: '【工作看板】当前可选：',
    boardPay: '报酬 {reward} {unit}', boardPenalty: '报酬 {reward} {unit}（**可能赔付 {-penalty}**）',
    boardRow: '{index}. {label} —— {pay}，预计消耗体力 {stamina}', boardFooter: '选择一项后回复 `/接 1`（或 /接 2、/接 3）。',
    ledgerEntry: '· {line}（{sign}{delta} {currency}）', ledgerTail: '\n（以上是本轮已结算的收支，不要照读数字或单位名称。）',
    walletPrompt: '【系统】有人询问你的余额。\n你现在有 {amount}。\n请用自己的语气简短回答，准确说出 {currency} 的余额，不编造数字，不列开销或追问。',
  },
  healthLabels: ['状况危险', '身体不适', '恢复中', '轻度疲劳', '状态良好'],
  moodLabels: ['情绪很低', '难过', '失落', '生气', '平静', '愉快', '非常愉快', '过度兴奋'],
  extraMoodTexts: [
    { label: '紧张', note: '面临不熟悉的事情' }, { label: '害羞', note: '受到关注' },
    { label: '兴奋', note: '发生了好事' }, { label: '无聊', note: '暂时没有事情做' },
    { label: '孤独', note: '希望有人陪伴' }, { label: '得意', note: '做成了一件事情' },
    { label: '感激', note: '得到了帮助' }, { label: '吃醋', note: '希望得到关注' },
  ],
  diseaseTexts: [
    { name: '感冒', line: '鼻塞，头脑昏沉' }, { name: '发热', line: '体温升高，需要休息' },
    { name: '肠胃不适', line: '腹部不适' }, { name: '能量损伤', line: '使用技能后感到不适' },
    { name: '过度疲劳', line: '全身乏力' }, { name: '异常状态', line: '休息受到影响' },
  ],
  diseaseCauses: { commission: '工作期间受了凉', weather: '天气变化', fishing: '在水边待得太久', food: '饮食不当', explosion: '技能使用后的不适', adventure: '外出活动造成', random: '原因暂不明确' },
  tier10: {
    satiety: ['极度饥饿', '非常饥饿', '很饿', '有些饿', '略感饥饿', '半饱', '吃饱', '很饱', '过饱', '极度过饱'],
    health: ['极差', '很差', '较差', '不适', '恢复中', '有所恢复', '尚可', '良好', '健康', '非常健康'],
    mood: ['极低落', '很低落', '低落', '略低落', '平淡', '平静', '愉快', '很愉快', '兴奋', '非常兴奋'],
    stamina: ['耗尽', '接近耗尽', '很累', '疲劳', '尚有余力', '正常', '有精神', '精力良好', '精力充足', '精力充沛'],
    mana: ['耗尽', '接近耗尽', '很少', '不足', '约半满', '够用', '充足', '很多', '接近满额', '满额'],
  },
  conditionText: {
    seekSuccess: '治疗者帮助治好了{name}', seekFailure: '治疗没有使{name}好转，还带来了一些烦恼',
    bodySick: '我还不舒服——{name}，{line}。', bodyTreated: '已经接受治疗，目前需要继续恢复。', bodyHealthy: '我现在没有生病。',
    hungerPrefix: '我现在', hungerLow: '……有吃的吗', manaLow: '，能量不足以释放技能', manaEnough: '，可以使用技能', tiredLow: '，让我歇会儿',
    healthyHead: '我现在状态不错！', grumble: '希望能一起吃点好吃的。',
    help: '大概还要 {hours} 小时恢复，可以寻求治疗）—— {line}',
  },
  eateries: [
    { place: '附近的小吃摊', food: '简餐', line: '去小吃摊吃了点东西' },
    { place: '附近的食堂', food: '普通套餐', line: '去食堂吃了一份套餐' },
    { place: '附近的面包店', food: '面包', line: '去面包店买了一份面包' },
  ],
  lifeActivities: [
    { placeName: '住处', line: '在家整理常用工具' }, { placeName: '住处', line: '准备洗澡休息' },
    { placeName: '住处', line: '靠着窗边休息' }, { placeName: '住处', line: '洗好了换洗衣物' },
    { placeName: '住处', line: '整理明天要带的物品' }, { placeName: '住处', line: '清点了一下积蓄' },
    { placeName: '服务中心', line: '查看新的工作信息' }, { placeName: '服务中心', line: '阅读了一会儿书' },
    { placeName: '服务中心', line: '和别人聊起最近的活动' }, { placeName: '食堂', line: '在食堂喝水休息' },
    { placeName: '市场', line: '在市场逛了逛' }, { placeName: '市场', line: '在商店橱窗前看了一会儿' },
    { placeName: '水边', line: '在水边坐了一会儿' },
  ],
  selfcareText: {
    arrival: '{heard} 你自己走到了{placeName}。\n\n请随口说说接下来要做什么，不要写成系统通知。\n不想说就只回复 {silentToken}。',
    travel: '{heard} 你正自己前往{placeName}{activitySuffix}。\n\n可以简短说说出门的事，不要编造时间或系统信息。\n不想说就只回复 {silentToken}。',
    eatFacts: '你刚自己去了{place}，吃了{food}，支出了少量{currency}。不用念出数字。',
    lifeFacts: '你刚刚{line}。请根据这件事自然表达，不要报数。',
    c2c: '{heard} 这是你自己生活的片刻。\n向熟悉的人随口说一两句，不要写成报告或提问。',
    group: '{heard} 群里现在很安静。\n可以说一两句最近在做什么，不要带入私聊内容或点名。',
    silent: '如果现在不适合开口，只回复 {silentToken}。',
  },
  companyActivities: [
    { label: '一起逛街', line: '一起去逛街，买了一些日用品' }, { label: '一起休息', line: '一起躺下休息' },
    { label: '一起出门', line: '一起出门走了走' }, { label: '户外探索', line: '一起到户外活动，带回了一些材料' },
    { label: '做饭', line: '自己下厨做了一顿饭' }, { label: '练习技能', line: '一起进行了一次技能练习' },
  ],
  companyPrompt: '这一轮你们在{label}（{line}）。请接住邀请，自然描述感受，不要报数或提系统。',
  fishNames: [
    ['鲫鱼', '鳟鱼', '青花鱼', '鲈鱼', '泥鳅', '小章鱼', '不知名的鱼'],
    ['旧靴子', '水草', '木桶碎片', '旧信', '旧鱼钩'],
    ['旧短剑', '旧书', '钱袋', '银戒指'], ['水下收藏品', '鳞片', '旧箱子', '密封瓶'],
    ['古老的收藏品', '一箱金币', '珍贵的工艺品', '罕见的鱼鳞'],
  ],
  fishingSpots: [{ water: '城外的河流', spot: '桥墩下' }, { water: '附近的湖', spot: '芦苇旁' }, { water: '海边', spot: '退潮水洼' }, { water: '林间溪流', spot: '树干旁' }],
  baitLabels: { lure: '旧假饵', explosion_ash: '燃烧后的灰', aqua_bottle: '旧空瓶', yuuyuu_charm: '手制护符', kazuma_sock: '旧袜子', chomusuke_fur: '动物掉的毛', crimson_thread: '红线头' },
  explosion: {
    chants: chantIds.map((id, index) => ({ id, source: '原创通用技能示例', length: chantLengths[index], zh: ['光芒聚拢，准备完成。', '让这份力量向前绽放！'] })),
    finishers: Array.from({ length: 20 }, () => 'Explosion！'),
  },
  narration: {
    examples: ['练习场亮起一道光，旁边的纸风车转了两圈，观众鼓起掌来。', '靶标旁扬起少量尘土，记录员认真画了一颗星。', '技能演示结束，大家收好道具，准备休息。'],
    casterDefault: '施术者', narratorDefault: '旁白者',
    prompt: '【系统】刚才「{caster}」完成了一次虚构的技能演示，结束词：{finisher}\n\n你是{identity}。请为这次演示写一段轻松的虚构旁白。\n\n要求：不冒充真实新闻，不描述真实地点受损或真实人员伤亡，不引用既有角色；两句到四句，不要编造真实统计。\n\n风格示例：{examples}',
  },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const sameKeys = (v, keys) => isObject(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
function shape(value, fallback) {
  if (typeof fallback === 'string') return text(value);
  if (Array.isArray(fallback)) return Array.isArray(value) && value.length === fallback.length && value.every((item, i) => shape(item, fallback[i]));
  if (isObject(fallback)) return sameKeys(value, Object.keys(fallback)) && Object.keys(fallback).every((key) => shape(value[key], fallback[key]));
  return value === fallback;
}
function validChant(row, index) {
  return isObject(row) && Object.keys(row).every((key) => ['id', 'source', 'length', 'zh', 'jp', 'beats'].includes(key))
    && row.id === chantIds[index] && row.length === chantLengths[index] && text(row.source)
    && Array.isArray(row.zh) && row.zh.length > 0 && row.zh.every(text)
    && (row.jp === undefined || (Array.isArray(row.jp) && row.jp.length > 0 && row.jp.every(text)))
    && (row.beats === undefined || (Array.isArray(row.beats) && row.beats.length > 0
      && row.beats.every((beat) => text(beat) || (Array.isArray(beat) && beat.length > 0 && beat.every(text)))));
}
function validNarrationPrompt(prompt) {
  if (!text(prompt)) return false;
  const slots = [...new Set([...prompt.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))].sort();
  return slots.join(',') === 'caster,examples,finisher,identity';
}
/** 注入读取函数仅供离线错误边界判据；URL 与 schema 固定。错误不带正文、路径或 cause。 */
export function readLocalGameplayContent(read = readFileSync) {
  let raw;
  try { raw = read(LOCAL_URL, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return DEFAULT_GAMEPLAY_CONTENT;
    throw new Error('local gameplay content: read failed');
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('local gameplay content: invalid JSON'); }
  const keys = Object.keys(DEFAULT_GAMEPLAY_CONTENT);
  if (!sameKeys(value, keys) || !keys.filter((key) => key !== 'explosion').every((key) => shape(value[key], DEFAULT_GAMEPLAY_CONTENT[key]))
    || !validNarrationPrompt(value.narration.prompt)
    || !sameKeys(value.explosion, ['chants', 'finishers'])
    || !Array.isArray(value.explosion.chants) || value.explosion.chants.length !== chantIds.length
    || !value.explosion.chants.every(validChant)
    || !shape(value.explosion.finishers, DEFAULT_GAMEPLAY_CONTENT.explosion.finishers)) {
    throw new Error('local gameplay content: invalid schema');
  }
  return value;
}
export const GAMEPLAY_CONTENT = readLocalGameplayContent();
/** 只替换已知数据占位，不执行模板代码。 */
export function gameplayText(template, values = {}) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*|-penalty)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key]) : token);
}
