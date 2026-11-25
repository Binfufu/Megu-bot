/**
 * **搜索指令统一路由**的判据（2026-11-24，命令路由收口）。
 *
 * 跑法:
 *
 *     node scripts\selftest-command-router.js
 *
 * 全部是**纯函数表**：不联网、不读真实数据、不起边车、不碰 QQ。
 *
 * 钉住本轮拍板的边界：
 *   ① **目标名词闸 / 交叉闸**：书/媒体名词 → book，永不走 meitu；图像名词 → image；
 *      两张词表分别只有一份（jm 的 `hasBookTarget` / meitu 的 `hasImageTarget`）；
 *   ② book 侧复用 strict/fuzzy 解析器 + 本轮新增自然句式（来几本/来点…的本子/有…吗/
 *      查(找)…本子/来本…/本子来点 等）；
 *   ③ image 侧保留既有形状，新增「搜图/搜N张…图/搜点…的图」系（不改美图动词表）；
 *   ④ 「搜本子 全彩」分词修复、「搜本子宫」不回归、「搜本 标签全彩/搜本作者甲」粘连键
 *      进结构化条件；
 *   ⑤ 误命中负例：来点乐子 / 发点牢骚 / 找点乐子 / 日本 / 本来 / 成本 / 基本 / 老板本来 /
 *      这个本子不错 —— 都不许落到 book/image 执行；
 *   ⑥ 两边都有 / 两边都没有但形状明显 → ambiguous + hint clarify（不猜边）。
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { allowsNonMentionTrigger, routeSearchCommand } from '../src/command-router.js';
import { hasBookTarget, normalizeCommandText, parseJmCommand } from '../src/jm-command.js';
import { hasImageTarget, parseMeituCommand } from '../src/meitu-command.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 断言路由结果：kind/component/action/hint/reason 逐项可选比对，其余结构字段必须齐全。 */
function expectRoute(text, expected = {}) {
  const route = routeSearchCommand(text);
  for (const key of ['kind', 'stage', 'component', 'action', 'parsed', 'hint', 'reason']) {
    assert.ok(Object.hasOwn(route, key), `${text} 缺少路由字段 ${key}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(route[key], value, `${text} 的 ${key}`);
  }
  return route;
}

// ---------------------------------------------------------------------------
// ① 目标名词闸 / 交叉闸
// ---------------------------------------------------------------------------

test('router:目标名词闸 —— 书/媒体名词归 book,永不走 meitu', () => {
  for (const text of ['来点本子', '找点本子', '来点全彩的本', '来点作者甲的本子', '搜点本子']) {
    const route = expectRoute(text, { kind: 'book', component: 'jm' });
    assert.notEqual(route.component, 'meitu', text);
    assert.equal(route.parsed?.character, undefined, `${text} 不许带美图角色`);
  }
  // 解析器内的兜底闸：就算路由漏了，美图解析器也不再认“找本子”的残缺指令。
  for (const text of ['来点本子', '来点全彩的本', '来点作者甲的本子']) {
    assert.equal(parseMeituCommand(text).ok, false, text);
  }
  // 图像侧既有形状照旧。
  for (const text of ['来点美图', '来点涩图', '来张爱丽丝的图']) {
    assert.equal(parseMeituCommand(text).ok, true, text);
  }
});

test('router:目标名词词表各只有一份 —— hasBookTarget / hasImageTarget', () => {
  assert.equal(hasBookTarget('来点本子'), true);
  assert.equal(hasBookTarget('来点全彩的本'), true);
  assert.equal(hasBookTarget('来几本漫画'), true);
  assert.equal(hasBookTarget('来点单行本'), true);
  assert.equal(hasBookTarget('我要资源'), true);
  // 复合词护栏复用 FUZZY_BEN_COMPOUNDS：这些“本”不是书。
  for (const text of ['日本', '本来', '成本', '基本', '剧本', '笔记本', '老板本来']) {
    assert.equal(hasBookTarget(text), false, text);
  }
  assert.equal(hasImageTarget('来点本子'), false);
  for (const text of ['来点美图', '来张照片', '来点壁纸', '发张截图', '来张擦边图']) {
    assert.equal(hasImageTarget(text), true, text);
  }
});

// ---------------------------------------------------------------------------
// ② book 侧 strict（既有解析器原样接住）
// ---------------------------------------------------------------------------

test('router:book strict —— 搜本/找本/下本/打包沿用 JM 解析器结果', () => {
  const search = expectRoute('搜本 全彩', {
    kind: 'book', stage: 'strict', component: 'jm', action: 'search', hint: null, reason: null,
  });
  assert.equal(search.parsed.keyword, '全彩');
  assert.equal(search.parsed.count, 5);
  assert.equal(routeSearchCommand('搜本 全彩', { maxJm: 3 }).parsed.count, 3);
  assert.equal(routeSearchCommand('找本 全彩 2').parsed.count, 2);
  expectRoute('下本 123456', { kind: 'book', stage: 'strict', action: 'download' });
  expectRoute('整本打包', { kind: 'book', stage: 'strict', action: 'pack' });
});

test('router:搜本子分词修复 —— 「搜本子 全彩」关键词是「全彩」不是「子 全彩」', () => {
  const route = expectRoute('搜本子 全彩', { kind: 'book', stage: 'strict', component: 'jm' });
  assert.equal(route.parsed.keyword, '全彩');
  assert.equal(routeSearchCommand('搜本子 全彩 2').parsed.count, 2);
  // 无分隔的「搜本子宫」仍按「搜本 子宫」解析（lookahead 不能乱咬）。
  assert.equal(parseJmCommand('搜本子宫').keyword, '子宫');
  assert.equal(routeSearchCommand('搜本子宫').parsed.keyword, '子宫');
  // 裸「搜本子」仍是格式错误（不能把“子”当关键词）。
  assert.equal(parseJmCommand('搜本子').reason, 'format');
  expectRoute('搜本子', { kind: 'book', hint: 'format', parsed: null });
});

test('router:粘连键进结构化条件 —— 「搜本 标签全彩」「搜本作者甲」', () => {
  const tag = expectRoute('搜本 标签全彩', { kind: 'book', stage: 'strict' });
  assert.deepEqual(tag.parsed.conditions, { tag: ['全彩'] });
  const author = expectRoute('搜本作者甲', { kind: 'book', stage: 'strict' });
  assert.deepEqual(author.parsed.conditions, { creator: ['甲'] });
  // 旧写法（冒号/空格）行为不变。
  assert.deepEqual(parseJmCommand('搜本 作者:甲').conditions, { creator: ['甲'] });
  assert.deepEqual(parseJmCommand('搜本 标签 齁').conditions, { tag: ['齁'] });
  assert.equal(parseJmCommand('搜本 全彩').keyword, '全彩');
});

// ---------------------------------------------------------------------------
// ③ book 侧 fuzzy（既有模糊解析器 + 本轮新增自然句式）
// ---------------------------------------------------------------------------

test('router:book fuzzy —— 既有「句尾本/本子」形状仍归 book', () => {
  for (const [text, keyword] of [
    ['来点全彩的本', '全彩'],
    ['来点作者甲的本子', '作者甲'],
    ['搜原神的本子', '原神'],
    ['来点原神的本子', '原神'],
  ]) {
    expectRoute(text, { kind: 'book', stage: 'fuzzy', component: 'jm', action: 'search' });
    assert.equal(routeSearchCommand(text).parsed.keyword, keyword, text);
  }
});

test('router:book fuzzy —— 新增自然句式全部识别（2026-11-24 现场说法）', () => {
  for (const [text, keyword] of [
    ['来几本全彩的', '全彩'],
    ['来几本原神的', '原神'],
    ['来两本全彩', '全彩'],
    ['来本全彩', '全彩'],
    ['来本子全彩', '全彩'],
    ['整点原神本子', '原神'],
    ['搜点原神本子', '原神'],
    ['要几本原神', '原神'],
    ['有原神本子吗', '原神'],
    ['查找原神本子', '原神'],
    ['找全彩本子', '全彩'],
    ['来点原神本子', '原神'],
  ]) {
    const route = expectRoute(text, { kind: 'book', component: 'jm', action: 'search', hint: null });
    assert.equal(route.parsed.keyword, keyword, text);
  }
  // 「来两本」的数量也要经过同一份数量夹取（不是固定上限）。
  assert.equal(routeSearchCommand('来两本全彩').parsed.count, 2);
});

test('router:book fuzzy —— 只说了“本子来点”、没有关键词 → hint keyword', () => {
  for (const text of ['本子来点', '来点本子', '来本子', '搜点本子', '整点本子', '要几本', '有本子吗']) {
    expectRoute(text, {
      kind: 'book', stage: 'fuzzy', component: 'jm', action: null, parsed: null, hint: 'keyword',
    });
  }
});

// ---------------------------------------------------------------------------
// ④ image 侧（既有形状一个不丢 + 新增「搜」系）
// ---------------------------------------------------------------------------

test('router:image 既有形状 —— 原句交给 parseMeituCommand,stage=strict', () => {
  for (const [text, character] of [
    ['来张爱丽丝的图', '爱丽丝'],
    ['找张爱丽丝美图', '爱丽丝'],
    ['发1张合成角色甲涩图', '合成角色甲'],
  ]) {
    const route = expectRoute(text, {
      kind: 'image', stage: 'strict', component: 'meitu', action: 'send', hint: null, reason: null,
    });
    assert.equal(route.parsed.character, character, text);
  }
  const random = routeSearchCommand('来点美图');
  assert.equal(random.kind, 'image');
  assert.equal(random.parsed.random, true);
});

test('router:image 新增「搜」系形状 —— 搜图/搜N张…图/搜点…的图', () => {
  for (const [text, character, count] of [
    ['搜图 爱丽丝', '爱丽丝', 1],
    ['搜图爱丽丝', '爱丽丝', 1],
    ['搜张爱丽丝的图', '爱丽丝', 1],
    ['搜点爱丽丝的图', '爱丽丝', 1],
    ['搜两张爱丽丝的图', '爱丽丝', 2],
    ['搜图 爱丽丝的图', '爱丽丝', 1],
  ]) {
    const route = expectRoute(text, {
      kind: 'image', stage: 'fuzzy', component: 'meitu', action: 'send',
    });
    assert.equal(route.parsed.character, character, text);
    assert.equal(route.parsed.count, count, text);
  }
  // 只有「搜图」没有角色 → 问一句搜谁。
  expectRoute('搜图', {
    kind: 'image', component: 'meitu', action: null, parsed: null, hint: 'keyword',
  });
  // 「搜图片」不是「搜图」+角色「片」：同样只问一句。
  expectRoute('搜图片', {
    kind: 'image', component: 'meitu', action: null, parsed: null, hint: 'keyword',
  });
  // 「搜索…」不属于本轮新增的「搜」形状，不吞成格式错误。
  expectRoute('搜索爱丽丝图片', { kind: 'none', parsed: null, hint: null });
});

// ---------------------------------------------------------------------------
// ⑤ ambiguous / none（不猜边、不误命中）
// ---------------------------------------------------------------------------

test('router:ambiguous —— 两边都有名词 → 澄清,不猜边', () => {
  expectRoute('来点本子图', {
    kind: 'ambiguous', stage: 'fuzzy', component: null, action: null, parsed: null,
    hint: 'clarify', reason: 'both-targets',
  });
});

test('router:ambiguous —— 没有目标名词但指令形状明显 → 澄清(不执行)', () => {
  for (const text of ['来点乐子', '发点牢骚', '找点乐子', '来点全彩', '搜 全彩']) {
    const route = expectRoute(text, {
      kind: 'ambiguous', component: null, action: null, parsed: null,
      hint: 'clarify', reason: 'no-target-noun',
    });
    assert.notEqual(route.kind, 'image', `${text} 不许再被当发图指令`);
    assert.notEqual(route.kind, 'book', `${text} 不许被当找本指令`);
  }
});

test('router:带「张」量词的残缺发图保持可用 —— 来3张随便的/来2张', () => {
  // 「张」本身就是图的数量词：既有「来3张随便的」「来2张」随机发图能力不能因为
  // 目标名词闸而退化成澄清（那会把老功能弄坏）。
  for (const text of ['来3张随便的', '来2张']) {
    const route = expectRoute(text, { kind: 'image', component: 'meitu', action: 'send', hint: null });
    assert.equal(route.parsed?.ok, true, text);
    assert.equal(route.parsed?.random, true, text);
  }
});

test('router:none —— 复合词闲聊/讨论不是命令', () => {
  for (const text of ['日本', '本来', '成本', '基本', '老板本来', '今天天气不错']) {
    expectRoute(text, { kind: 'none', component: null, parsed: null, hint: null });
  }
  // 提到了书但没有请求动词 → 不认（也不回格式提示）。
  expectRoute('这个本子不错', { kind: 'none', reason: 'no-command', parsed: null, hint: null });
  // 真正写了搜本动词、但形状不对 → book + 格式提示（不是 none）。
  expectRoute('搜本 年份:2024', { kind: 'book', hint: 'format', reason: 'unsupported' });
});

// ---------------------------------------------------------------------------
// ⑥ 归一化与边界
// ---------------------------------------------------------------------------

test('router:归一化只做一份 —— 残留 @/前导标点/句末标点', () => {
  assert.equal(normalizeCommandText('@副实例 搜本 全彩。'), '搜本 全彩');
  assert.equal(normalizeCommandText('，来点本子？'), '来点本子');
  assert.equal(normalizeCommandText('   '), '');
  expectRoute('   ', { kind: 'none', reason: 'empty' });
  expectRoute('@副实例 来点本子 @副实例', { kind: 'book', hint: 'keyword' });
});

test('router:裸「书/漫画」不再算目标名词 —— 秘书/书签/漫画风图不被误判两边都有', () => {
  // 2026-11-24 审查 P2-2：`书` 太宽（秘书/书签/图书）会把「来张秘书图」判成书+图 → 误澄清。
  for (const text of ['来张秘书图', '来张书签图', '来点漫画风图']) {
    const route = expectRoute(text, { kind: 'image' });
    assert.notEqual(route.hint, 'clarify', `${text} 不该两边都有去澄清`);
  }
  assert.equal(hasBookTarget('来张秘书图'), false);
  assert.equal(hasBookTarget('来张书签图'), false);
  // 真·书名词仍然算。
  assert.equal(hasBookTarget('来点漫画书'), true);
});

test('router:旧「来点<角色>」变澄清是接受的口径(有测试钉住，不再静默回归)', () => {
  // 「来点爱丽丝」旧入口会当发图；目标名词闸后没有"图"名词 → ambiguous 澄清。
  // 这是主人拍板"宁可问一句也不猜"的代价；要发图应写「来张爱丽丝的图」。
  const route = expectRoute('来点爱丽丝', { kind: 'ambiguous', hint: 'clarify' });
  assert.equal(route.component, null);
  expectRoute('来张爱丽丝的图', { kind: 'image', action: 'send' });
});

test('router:粘连键的已知代价钉现状 —— 搜本 角色扮演 → character=扮演', () => {
  // 粘连键修复（标签全彩/作者甲）的代价：`角色扮演` 会被切成 character=扮演。
  // 行为可接受但必须留下判据，日后加条件键别名时不能静默扩大。
  const route = expectRoute('搜本 角色扮演', { kind: 'book', component: 'jm', action: 'search' });
  assert.equal(route.parsed?.mode, 'structured');
  assert.deepEqual(route.parsed?.conditions?.character, ['扮演']);
});

test('router:非 @ 意图闸 —— 显式请求才放行，水群闲聊一律拒(审查 P1-1)', () => {
  const allow = [
    '搜本 全彩', '搜本子 全彩', '下本 1', '来点作者甲的本子', '来几本全彩的', '来点全彩的本',
    '搜点全彩的本', '找点全彩的本', '要几本全彩', '有全彩本子吗', '找全彩本子',
    '来张爱丽丝的图', '搜图 爱丽丝',
  ];
  for (const text of allow) {
    assert.equal(allowsNonMentionTrigger(routeSearchCommand(text), text), true, `应允许非 @：${text}`);
  }
  const deny = [
    '找本工作', '看本小说睡觉了', '整本账', '来张纸', '来两张纸', '来几张纸', '来点乐子',
    '这个本子不错', '我最近在看本小说', '来点爱丽丝',
  ];
  for (const text of deny) {
    const route = routeSearchCommand(text);
    assert.equal(allowsNonMentionTrigger(route, text), false, `不该允许非 @：${text}`);
  }
});

test('router:c106 真实语料 —— 裸「X本子」/省「本」简写/大吊图', () => {
  // 2026-11-23 c106 现场用户原话（transcript 实读）：他们不写动词/不写「本」。
  for (const [text, keyword] of [['加里奥本子', '加里奥'], ['佛耶戈本子', '佛耶戈'],
    ['巴德本子', '巴德'], ['格温本子', '格温'], ['向日葵本子', '向日葵']]) {
    const route = expectRoute(text, { kind: 'book', component: 'jm', action: 'search', reason: 'bare-book' });
    assert.equal(route.parsed?.keyword, keyword, text);
    assert.equal(route.parsed?.fuzzy, true, text);
    // 裸「X本子」只放行真 @（非 @ 水群里「作业本子」这类日常词不该自动开搜）。
    assert.equal(allowsNonMentionTrigger(route, text), false, `${text} 非 @ 不自动执行`);
  }
  // 闲聊/复合词必须不被裸「X本子」吃掉。
  for (const text of ['这个本子不错', '那个本子呢', '我买了个本子', '账本', '剧本', '画本子', '绘本']) {
    const route = routeSearchCommand(text);
    assert.notEqual(route.kind, 'book', `${text} 不该当搜本`);
  }
  // `下这个JM1485799` / `下那张 12345`：下载简写走同一份目标解析。
  const dl = expectRoute('下这个JM1485799', { kind: 'book', component: 'jm', action: 'download' });
  assert.deepEqual(dl.parsed?.targets, [{ kind: 'id', target: '1485799' }]);
  assert.deepEqual(expectRoute('下那张 12345', { action: 'download' }).parsed?.targets, [{ kind: 'id', target: '12345' }]);
  expectRoute('下这个abc', { kind: 'book', hint: 'format' });
  // `搜作者kusui` / `查标签全彩`：省「本」的结构化条件。
  const author = expectRoute('搜作者kusui', { kind: 'book', component: 'jm', action: 'search' });
  assert.equal(author.parsed?.mode, 'structured');
  assert.deepEqual(author.parsed?.conditions, { creator: ['kusui'] });
  assert.deepEqual(expectRoute('查标签全彩', { action: 'search' }).parsed?.conditions, { tag: ['全彩'] });
  assert.equal(allowsNonMentionTrigger(author, '搜作者kusui'), true);
  // 大吊图：图+角色+俚语后缀 → 擦边档角色图，不是闲聊。
  for (const [text, character] of [['来个加里奥大吊图', '加里奥'], ['来个镇长大吊图', '镇长']]) {
    const route = expectRoute(text, { kind: 'image', component: 'meitu', action: 'send' });
    assert.equal(route.parsed?.character, character, text);
    assert.equal(route.parsed?.tier, 'seitu', text);
    assert.equal(allowsNonMentionTrigger(route, text), true, text);
  }
});

test('router:翻页独立词与排序/页码写法（2026-11-25）', () => {
  // 翻页独立词：没有目标名词也认（明确的 JM 命令），@ 与非 @ 都放行。
  for (const [text, delta] of [['下一页', 1], ['上一页', -1]]) {
    const route = expectRoute(text, { kind: 'book', component: 'jm', action: 'page' });
    assert.equal(route.parsed?.delta, delta, text);
    assert.equal(allowsNonMentionTrigger(route, text), true, `${text} 非 @ 放行`);
  }
  // 带尾巴/闲聊不算翻页命令。
  for (const text of ['下一页啊', '翻下一页', '上一页是什么']) {
    const route = routeSearchCommand(text);
    assert.notEqual(route.action, 'page', `${text} 不该当翻页`);
  }
  // 排序/关键词页码走既有 search 动作。
  const hot = expectRoute('搜本 全彩 排序:热门', { kind: 'book', component: 'jm', action: 'search' });
  assert.equal(hot.parsed?.sort, 'mv');
  const p2 = expectRoute('搜本 全彩 页码:2', { action: 'search' });
  assert.equal(p2.parsed?.page, 2);
  assert.equal(p2.parsed?.keyword, '全彩');
  const structHot = expectRoute('搜本 作者:甲 排序:热门', { action: 'search' });
  assert.equal(structHot.parsed?.mode, 'structured');
  assert.equal(structHot.parsed?.sort, 'mv');
});

export function registerCommandRouterTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerCommandRouterTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
