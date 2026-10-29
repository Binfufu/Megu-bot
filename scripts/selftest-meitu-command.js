/**
 * 「发N张<角色>美图/涩图」解析器的判据(2026-10-23 / 代码层发图)。
 *
 * 跑法:
 *
 *     node scripts\selftest-meitu-command.js
 *
 * 钉:
 *   ① 写法表:群里真会出现的几种写法(全角/半角标点、前后空格、句末标点);
 *      1.181.0 起每条带 `tier`(美图=meitu / 涩图=seitu)与 `random`;
 *   ② 异常:0 张、非指令;
 *   ③ 上限:超过 max 夹到 max(完整指令与残缺指令都夹),默认 5;
 *   ④ 关键词映射:擦边/足控/胸控/单人/多人/白丝/黑丝/泳装/英文 tag 原样,以及"最多 2 个标签";
 *   ⑤ 档位:名词定档(美图/涩图/色图/擦边图),写「美图」但修饰带「擦边/涩」→ 升涩图档;
 *   ⑥ 动词:发/来/找/搬(「搬」= 1.181.0,主人实测用的就是这个字);
 *   ⑦ **残缺指令**:「来3张随便的」/「来2张」/「发张美图」→ random,提取得到什么就搜什么;
 *   ⑦' **随机角色**(1.184.0):「来3张随机双马尾美图」→ random=true + 修饰按最长匹配切开;
 *      「随机」不进别名表(词形识别在解析器层),标记位/修饰位都钉着;
 *   ⑦'' **角色位词尾粘着修饰**(1.191.0):「来两张合成名戊裸足美图」→ 候选序列 + 按别名表挑
 *      (原样优先/纯修饰=随机);合成表 267+6 条逐个断言不被误剥、加「裸足」都能剥回去;
 *   ⑧ 前导「要/请」与词尾「的/图/向/级/片」;
 *   ⑨ `looksLikeMeituAttempt`:只拦"像这个指令"的,别把闲聊当格式错。
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  applyCharacterSlot,
  CATEGORY_RANDOM_WORDS,
  characterSlotVariants,
  DEFAULT_MEITU_MAX,
  isCategoryRandomWord,
  looksLikeMeituAttempt,
  MAX_NOISE_PREFIX,
  parseMeituCommand,
  pickCharacterSlot,
  TAG_WORDS,
} from '../src/meitu-command.js';
import { stripJsonComments } from '../src/meitu-alias.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 期望对象的公共形状填平(不写的字段按默认补齐),让表格只写有信息量的字段。 */
function expect({ count = 1, character = '', tags = [], tier = 'meitu', random = false, ignored = [] }) {
  return {
    ok: true,
    count,
    character,
    tags,
    ratingWanted: true,
    tier,
    random,
    ignored,
  };
}

// ---------------------------------------------------------------------------
// ① 写法表
// ---------------------------------------------------------------------------

/** [输入, 期望] —— 任何字段篡改都会红。 */
const PARSE_TABLE = [
  // 1.179.x 老写法:「美图」+「擦边」修饰 → 升涩图档(兼容,不破坏群里认熟的写法)。
  [
    '发1张合成名甲美图，要擦边、足控的',
    expect({ character: '合成名甲', tags: ['feet'], tier: 'seitu' }),
  ],
  [
    '发 3 张 合成角色甲 美图 擦边 足控',
    expect({ count: 3, character: '合成角色甲', tags: ['feet'], tier: 'seitu' }),
  ],
  // 「美图」不带擦边修饰 = **全年龄唯美档**(1.181.0 语义:检索路径分两条)。
  [
    '，发2张合成角色乙美图。',
    expect({ count: 2, character: '合成角色乙' }),
  ],
  [
    '  发1张 合成角色丙 美图！  ',
    expect({ character: '合成角色丙' }),
  ],
  [
    '发1张合成角色甲的图美图',
    expect({ character: '合成角色甲' }),
  ],
  [
    '发1张合成角色甲的图美图 要擦边的',
    expect({ character: '合成角色甲', tier: 'seitu' }),
  ],
  [
    // 作品判据:角色词整串保留,交给别名层按「作品名的角色名」解析。
    '发1张合成作品甲的合成名甲美图，要擦边、足控的',
    expect({ character: '合成作品甲的合成名甲', tags: ['feet'], tier: 'seitu' }),
  ],
  [
    // 「涩图」名词 = 擦边档。
    '发1张合成角色甲涩图',
    expect({ character: '合成角色甲', tier: 'seitu' }),
  ],
  [
    // 「色图」是常见打字变体,同涩图档。
    '发1张合成角色甲色图 足控',
    expect({ character: '合成角色甲', tags: ['feet'], tier: 'seitu' }),
  ],
  [
    '来3张合成角色甲擦边图',
    expect({ count: 3, character: '合成角色甲', tier: 'seitu' }),
  ],
  // 中文数字。
  [
    '发一张合成角色丙美图',
    expect({ character: '合成角色丙' }),
  ],
  [
    '来两张合成名甲美图',
    expect({ count: 2, character: '合成名甲' }),
  ],
  // 纯文本 @残留:平台事件带 mention 元数据,但文本里的 @ 不是段落、网关剥不掉。
  [
    '@合成助手，发1张合成角色甲美图',
    expect({ character: '合成角色甲' }),
  ],
  [
    '@合成助手乙 来1张合成角色甲美图 擦边',
    expect({ character: '合成角色甲', tier: 'seitu' }),
  ],
  // 「搬」动词(1.181.0):主人实测「搬合成名乙美图」没触发 —— 因为动词表里没有「搬」。
  [
    '搬1张合成名乙美图',
    expect({ character: '合成名乙' }),
  ],
  [
    '搬两张合成名乙涩图',
    expect({ count: 2, character: '合成名乙', tier: 'seitu' }),
  ],
  // 名词写歪(「图片」不是档位名词)→ 残缺路兜住:提取到角色就搜,默认美图档。
  [
    '发1张合成角色甲图片',
    expect({ character: '合成角色甲' }),
  ],
];

test('meitu-command:写法表(标点/空格/句末/角色尾巴/档位/动词)逐条对拍', () => {
  for (const [input, expected] of PARSE_TABLE) {
    assert.deepEqual(parseMeituCommand(input), expected, `输入 ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// ② 异常
// ---------------------------------------------------------------------------

test('meitu-command:0 张 → count 失败(不是"发 0 张"的语义)', () => {
  assert.deepEqual(parseMeituCommand('发0张合成角色甲美图'), { ok: false, reason: 'count' });
  assert.deepEqual(parseMeituCommand('发0张随便的'), { ok: false, reason: 'count' });
});

test('meitu-command:不是指令 → format 失败(不许把闲聊解析成发图)', () => {
  for (const text of ['今天天气不错', '', '   ', '画一张美图给我看看']) {
    assert.deepEqual(parseMeituCommand(text), { ok: false, reason: 'format' }, `输入 ${JSON.stringify(text)}`);
  }
  // ⚠️ 2026-10-23(1.188.1)按主人拍板**改判据**:「今天来一张美图吧」不再算闲聊 ——
  //    指令里的「来」就在第 3 个字,主人定的口径是"只要指令在句子里出现就认"。
  //    它现在按**残缺指令**解析成随机角色(见下面「噪点前缀」那组)。
  assert.equal(parseMeituCommand('今天来一张美图吧').ok, true);
});

// ---------------------------------------------------------------------------
// ③ 上限
// ---------------------------------------------------------------------------

test('meitu-command:超过 max 夹到 max;没给 max 用默认 5【暂定】;中文数字也认', () => {
  assert.equal(parseMeituCommand('发9张合成角色甲美图').count, DEFAULT_MEITU_MAX);
  assert.equal(parseMeituCommand('发9张合成角色甲美图', { max: 3 }).count, 3);
  assert.equal(parseMeituCommand('发3张合成角色甲美图', { max: 5 }).count, 3);
  // 上限写坏了不该把指令变成 0 张:回落默认值。
  assert.equal(parseMeituCommand('发4张合成角色甲美图', { max: 0 }).count, 4);
  assert.equal(parseMeituCommand('发9张合成角色甲美图', { max: -2 }).count, DEFAULT_MEITU_MAX);
  assert.equal(parseMeituCommand('发两张A美图').count, 2);
  assert.equal(parseMeituCommand('来十张A美图', { max: 20 }).count, 10);
  assert.equal(parseMeituCommand('找二十三张A美图', { max: 99 }).count, 23);
  // 残缺指令同样受 max 管。
  assert.equal(parseMeituCommand('来9张随便的', { max: 2 }).count, 2);
  assert.equal(parseMeituCommand('发9张美图', { max: 4 }).count, 4);
});

// ---------------------------------------------------------------------------
// ④ 关键词映射
// ---------------------------------------------------------------------------

test('meitu-command:关键词映射(擦边/足控/玉足/脚/胸控/单人/多人/白丝/黑丝/泳装)', () => {
  assert.deepEqual(parseMeituCommand('发1张A美图 擦边').tags, []);
  assert.deepEqual(parseMeituCommand('发1张A美图 足控').tags, ['feet']);
  assert.deepEqual(parseMeituCommand('发1张A美图 玉足').tags, ['feet']);
  assert.deepEqual(parseMeituCommand('发1张A美图 脚').tags, ['feet']);
  assert.deepEqual(parseMeituCommand('发1张A美图 胸控').tags, ['large_breasts']);
  assert.deepEqual(parseMeituCommand('发1张A美图 单人').tags, ['solo']);
  assert.deepEqual(parseMeituCommand('发1张A美图 多人').tags, ['multiple_girls']);
  assert.deepEqual(parseMeituCommand('发1张A美图 白丝').tags, ['thighhighs']);
  assert.deepEqual(parseMeituCommand('发1张A美图 黑丝').tags, ['pantyhose']);
  assert.deepEqual(parseMeituCommand('发1张A美图 丝袜').tags, ['pantyhose']);
  assert.deepEqual(parseMeituCommand('发1张A美图 泳装').tags, ['swimsuit']);
  assert.deepEqual(parseMeituCommand('发1张A美图 擦边的').tags, []);
  // 两个修饰并存(格式提示里的「足控/胸控」组合)。
  assert.deepEqual(parseMeituCommand('发1张A涩图 足控 胸控').tags, ['feet', 'large_breasts']);
});

test('meitu-command:英文 tag 原样收(大小写保留);不认识的进 ignored 但不报错', () => {
  const parsed = parseMeituCommand('发1张fixture_character_a美图 Feet long_hair 好看');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.tags, ['Feet', 'long_hair']);
  assert.deepEqual(parsed.ignored, ['好看']);
  // 「向」是词尾修饰,剥掉后仍要命中映射(足控向 → feet)。
  assert.deepEqual(parseMeituCommand('发1张A美图 足控向').tags, ['feet']);
});

test('meitu-command:最多保留 2 个标签,多出来的进 ignored(来源限制)', () => {
  const parsed = parseMeituCommand('发1张A美图 白丝 泳装 黑丝');
  assert.deepEqual(parsed.tags, ['thighhighs', 'swimsuit']);
  assert.deepEqual(parsed.ignored, ['pantyhose']);
});

test('meitu-command:重复标签去重', () => {
  assert.deepEqual(parseMeituCommand('发1张A美图 足控 脚 足').tags, ['feet']);
});

// ---------------------------------------------------------------------------
// ④' 修饰词大表(1.183.0,主人拍板"读一遍网站全加上")
// ---------------------------------------------------------------------------

test('meitu-command:修饰词表元判据 —— 表里每个词都能解析命中它的 tag(加词自动跟上)', () => {
  assert.ok(TAG_WORDS.length >= 150, `词表要有规模(实际 ${TAG_WORDS.length} 条)`);
  for (const { words, tag } of TAG_WORDS) {
    for (const word of words) {
      const parsed = parseMeituCommand(`发1张A美图 ${word}`);
      assert.ok(parsed.ok, `词「${word}」解析失败`);
      assert.ok(
        parsed.tags.includes(tag),
        `词「${word}」应命中 ${tag},实际 ${JSON.stringify(parsed.tags)}`,
      );
    }
  }
});

test('meitu-command:表里每个 tag 形状合法(小写/数字/下划线/连字符/括号) —— 查询 URL 要能拼', () => {
  for (const { tag } of TAG_WORDS) {
    assert.match(tag, /^[a-z0-9_()-]+(\([a-z_]+\))?$/u, `tag ${tag} 形状不对`);
  }
});

test('meitu-command:修饰全不命中 → 依旧不加修饰(tags 空),词进 ignored(主人 2026-10-23 定的口径)', () => {
  // 中文词不在表里 = 不硬塞兜底修饰,查询只带角色(+档位限定)。
  const parsed = parseMeituCommand('发1张A涩图 慵懒 神秘 华丽');
  assert.deepEqual(parsed.tags, [], '一个都没命中就一个修饰都不加');
  assert.equal(parsed.tier, 'seitu');
  assert.deepEqual(parsed.ignored, ['慵懒', '神秘', '华丽'], '没命中的词要留痕(日志看得见)');
  assert.deepEqual(parseMeituCommand('发1张A美图 未知中文词').tags, []);
  // 但英文 tag 形状仍然是"用户明确指定",原样收(1.179.x 起的特性,不算"没命中")。
  assert.deepEqual(parseMeituCommand('发1张A美图 some_tag').tags, ['some_tag']);
  // 组合抽查:新表词一起写也能命中(格式提示例子的近亲)。
  assert.deepEqual(parseMeituCommand('发1张A美图 双马尾 绝对领域').tags, ['twintails', 'zettai_ryouiki']);
});

// ---------------------------------------------------------------------------
// ⑤ 前导「要/请」
// ---------------------------------------------------------------------------

test('meitu-command:前导「要/请」剥掉(整段或每个词开头)', () => {
  assert.deepEqual(parseMeituCommand('发1张A美图，要擦边、足控的').tags, ['feet']);
  assert.deepEqual(parseMeituCommand('发1张A美图 请足控').tags, ['feet']);
  assert.deepEqual(parseMeituCommand('发1张A美图 要 白丝').tags, ['thighhighs']);
});

// ---------------------------------------------------------------------------
// ⑦ 残缺指令(2026-10-23 主人拍板:提取得到什么就搜什么,提取不到就随机)
// ---------------------------------------------------------------------------

test('meitu-command:残缺指令 —— 纯虚词/什么都不给 → random=true,默认美图档', () => {
  // 「随便的/啥图都行」这类是"随便给点",不是角色名。
  assert.deepEqual(parseMeituCommand('来3张随便的'), expect({ count: 3, random: true }));
  assert.deepEqual(parseMeituCommand('来2张啥图都行'), expect({ count: 2, random: true }));
  assert.deepEqual(parseMeituCommand('发2张'), expect({ count: 2, random: true }));
  assert.deepEqual(parseMeituCommand('来张美图'), expect({ random: true }), '没写数量默认 1【暂定】');
  assert.deepEqual(parseMeituCommand('发张美图'), expect({ random: true }));
  // 名词单独出现也算残缺(角色空)。
  assert.deepEqual(parseMeituCommand('来3张涩图'), expect({ count: 3, tier: 'seitu', random: true }));
  // @残留 + 残缺 组合。
  assert.deepEqual(parseMeituCommand('@合成助手 来3张随便的'), expect({ count: 3, random: true }));
});

test('meitu-command:指令**末尾**的纯文本 @ 也剥(1.195.0,主人:「@合成助手 放指令末尾」不能识别)', () => {
  // 末尾 @ 黏在角色名后面时,以前会整段当角色名(「合成名丁@合成助手」→ 没登记)。
  assert.deepEqual(parseMeituCommand('来张合成名丁@合成助手'), expect({ character: '合成名丁' }));
  assert.deepEqual(parseMeituCommand('来张合成名丁 美图@合成助手'), expect({ character: '合成名丁' }));
  // 空格 / 标点 / 句号 / 全名 都认。
  assert.deepEqual(parseMeituCommand('来两张合成名戊裸足美图 @合成助手'), expect({ count: 2, character: '合成名戊裸足' }));
  assert.deepEqual(parseMeituCommand('来两张合成名戊裸足美图@合成助手'), expect({ count: 2, character: '合成名戊裸足' }));
  assert.deepEqual(parseMeituCommand('来张合成名丁美图，@合成助手'), expect({ character: '合成名丁' }));
  assert.deepEqual(parseMeituCommand('来两张合成名丁美图。@合成助手乙'), expect({ count: 2, character: '合成名丁' }));
  // 头尾都有 @:两头都剥。
  assert.deepEqual(parseMeituCommand('@合成助手 来两张合成名丁美图 @合成助手'), expect({ count: 2, character: '合成名丁' }));
  // 剥掉之后不许再污染 ignored(以前会留一条「@合成助手」)。
  assert.deepEqual(parseMeituCommand('来两张合成名丁美图 @合成助手').ignored, []);
  // 反向护栏:不带指令的闲聊不许被"剥"成指令。
  assert.deepEqual(parseMeituCommand('今天好累 @合成助手'), { ok: false, reason: 'format' });
  assert.deepEqual(parseMeituCommand('@合成助手 你好'), { ok: false, reason: 'format' });
  // 末尾 @ 与残缺指令组合。
  assert.deepEqual(parseMeituCommand('来3张随便的 @合成助手'), expect({ count: 3, random: true }));
});

test('meitu-command:残缺指令 —— 提取得到角色/修饰就搜什么', () => {
  // 提取到角色:默认美图档(残缺指令不给涩图,除非写了涩/擦边字样)。
  assert.deepEqual(parseMeituCommand('来1张合成角色甲'), expect({ character: '合成角色甲' }));
  assert.deepEqual(parseMeituCommand('搬张合成名乙的'), expect({ character: '合成名乙' }));
  // 提取到修饰:角色随机,修饰保留。
  assert.deepEqual(parseMeituCommand('来2张足控的'), expect({ count: 2, tags: ['feet'], random: true }));
  // 提取到档位:涩图字样 → 涩图档随机。
  assert.deepEqual(parseMeituCommand('来2张随便的涩图'), expect({ count: 2, tier: 'seitu', random: true }));
});

test('meitu-command:残缺指令 —— 没写数量 + 角色紧贴档位名词(「来张合成名丁美图」)', () => {
  // 2026-10-23 现场回归:这类写法以前把「合成名丁美」当角色名去查别名表 → 回「没有登记」,
  // 涩图还会退成美图档(小组里 4 条真现场:「合成名庚美」「合成名辛美」「合成名壬美」「合成名癸美」)。
  assert.deepEqual(parseMeituCommand('来张合成名丁美图'), expect({ character: '合成名丁' }));
  assert.deepEqual(parseMeituCommand('发张合成名丁涩图'), expect({ character: '合成名丁', tier: 'seitu' }));
  assert.deepEqual(parseMeituCommand('搬张合成名乙色图'), expect({ character: '合成名乙', tier: 'seitu' }));
  assert.deepEqual(parseMeituCommand('来张合成名丁擦边图'), expect({ character: '合成名丁', tier: 'seitu' }));
  // 名词后面再跟「的/图」这类尾巴也认。
  assert.deepEqual(parseMeituCommand('来张合成名丁美图的'), expect({ character: '合成名丁' }));
  // 名词后面的字不是尾巴(修饰粘在一起)→ 不硬剥,角色位保持原文(不许猜)。
  assert.equal(parseMeituCommand('来张合成名丁美图足控').character, '合成名丁美图足控');
  // 名词与修饰分成两段(有空格的正常写法)照样各自归位。
  assert.deepEqual(
    parseMeituCommand('来张合成名丁美图 白丝'),
    expect({ character: '合成名丁', tags: ['thighhighs'] }),
  );
  // 「美图/随便美图」整体不许当角色名(与完整指令同一口径)。
  assert.deepEqual(parseMeituCommand('来张美图'), expect({ random: true }));
  assert.deepEqual(parseMeituCommand('来张随便美图'), expect({ random: true }));
});

// ---------------------------------------------------------------------------
// ⑦' 随机角色(1.184.0,主人:「来N张随机<修饰关键词>美图」—— 随机挑角色,仍按角色名分库)
// ---------------------------------------------------------------------------

test('meitu-command:随机角色 —— 角色位写「随机」= random=true(不查别名表)', () => {
  assert.deepEqual(parseMeituCommand('来3张随机美图'), expect({ count: 3, random: true }));
  assert.deepEqual(parseMeituCommand('发2张随机涩图'), expect({ count: 2, tier: 'seitu', random: true }));
  assert.deepEqual(parseMeituCommand('来张随机美图'), expect({ random: true }), '没写数量也认');
  assert.deepEqual(parseMeituCommand('搬一张随机美图'), expect({ random: true }));
  assert.deepEqual(parseMeituCommand('找3张随机角色美图'), expect({ count: 3, random: true }));
  // 「随机」出现在**修饰位**只是虚词,不干扰角色。
  assert.deepEqual(parseMeituCommand('来2张合成名丁美图 随机'), expect({ count: 2, character: '合成名丁' }));
});

test('meitu-command:随机角色 —— 「随机」后面粘着的修饰按认识的词最长匹配切开', () => {  assert.deepEqual(
    parseMeituCommand('来3张随机双马尾美图'),
    expect({ count: 3, tags: ['twintails'], random: true }),
  );
  assert.deepEqual(
    parseMeituCommand('来3张随机白丝双马尾美图'),
    expect({ count: 3, tags: ['thighhighs', 'twintails'], random: true }),
    '粘连多个修饰按出现顺序切',
  );
  assert.deepEqual(
    parseMeituCommand('来3张随机足控涩图'),
    expect({ count: 3, tags: ['feet'], tier: 'seitu', random: true }),
  );
  assert.deepEqual(
    parseMeituCommand('来3张随机要双马尾美图'),
    expect({ count: 3, tags: ['twintails'], random: true }),
  );
  // 带空格的正常写法、修饰写在名词后面 —— 一样。
  assert.deepEqual(
    parseMeituCommand('来3张随机 双马尾 美图'),
    expect({ count: 3, tags: ['twintails'], random: true }),
  );
  assert.deepEqual(
    parseMeituCommand('来3张随机美图 双马尾'),
    expect({ count: 3, tags: ['twintails'], random: true }),
  );
  // 认不出来的整段**不硬切**:原样进 ignored(日志看得见),不猜成某个修饰。
  assert.deepEqual(
    parseMeituCommand('来3张随机好看美图'),
    expect({ count: 3, random: true, ignored: ['好看'] }),
  );
  // 不带「随机」的角色名照旧(只有标记词开头才走随机)。
  assert.deepEqual(parseMeituCommand('来3张合成名丁美图'), expect({ count: 3, character: '合成名丁' }));
});

// ---------------------------------------------------------------------------
// ⑦''' 模糊量词「点/些」+ 类目词角色位(1.197.0,主人 2026-10-25 现场)
//    「来点萝莉图」以前连残缺指令都进不去(「点」不在「张」的字类),整条 format 失败
//    被当闲聊丢给模型(06:43 两条 LLM 答话就是这么来的);「来张随机萝莉图」解析出
//    character='萝莉',而「萝莉」是类目词 —— 按不按随机出图由**服务层**拿别名表判
//    (解析器只管词法,不查表 —— 与「合成名戊裸足」同一分工,别在这里猜)。
// ---------------------------------------------------------------------------

test('meitu-command:模糊量词「点/些」+ 类目词 —— 类目词就地转随机(1.198.0 口径)', () => {
  // 现场原样(2026-10-25 14:43/14:44 群里三条):类目词在解析层 skip → random=true,
  // 服务层走已拍板的随机机制 —— 「模糊请求」在解析层就表达完毕,不靠 service 兜底。
  assert.deepEqual(parseMeituCommand('来点萝莉图'), expect({ random: true }));
  assert.deepEqual(parseMeituCommand('来张随机萝莉图'), expect({ random: true }), '随机标记+类目词=纯随机');
  assert.deepEqual(parseMeituCommand('来点萝莉美图'), expect({ random: true }));
  // 「点/些」+ 具名角色:量词放宽对正常写法零影响。
  assert.deepEqual(parseMeituCommand('发点合成名丁图'), expect({ character: '合成名丁' }));
  assert.deepEqual(parseMeituCommand('找些合成角色甲图'), expect({ character: '合成角色甲' }));
  // 随机标记 + 类目词粘连:标记剥掉、类目词整段吞掉 = 纯随机(1.198.0 splitModifierRun 吞类目段)。
  assert.deepEqual(parseMeituCommand('来2张随机美少女图'), expect({ count: 2, random: true }));
  // 带「张」的老写法一个都不能变(量词扩字类不许咬到老行为)。
  assert.deepEqual(parseMeituCommand('来张合成名丁美图'), expect({ character: '合成名丁' }));
  assert.deepEqual(parseMeituCommand('来3张随便的'), expect({ count: 3, random: true }));
});

test('meitu-command:类目词表 —— 词形识别的唯一一份,具名角色不算类目', () => {
  for (const word of CATEGORY_RANDOM_WORDS) assert.equal(isCategoryRandomWord(word), true, word);
  assert.equal(isCategoryRandomWord('合成名丁'), false, '具名角色不是类目词');
  assert.equal(isCategoryRandomWord('合成角色甲'), false);
  assert.equal(isCategoryRandomWord('萝'), false, '前缀不算(全等匹配,与 MINOR_TAGS 的前缀级口径不同)');
  assert.equal(isCategoryRandomWord(''), false);
  assert.equal(isCategoryRandomWord(null), false);
  assert.equal(isCategoryRandomWord(undefined), false);
  // 中文类目词一律纯中文;ASCII 只许 NTR 系(梦境卡库分类名) —— 其余英文词该走 TAG_WORDS
  // 检索路径,混进类目词表等于放弃精确检索(1.198.0 补全时的护栏)。
  for (const word of CATEGORY_RANDOM_WORDS) {
    if (/^[a-z]+$/iu.test(word)) continue;
    assert.match(word, /^[\u4e00-\u9fff]+$/u, word);
  }
  assert.deepEqual(
    CATEGORY_RANDOM_WORDS.filter((word) => /^[a-z]+$/iu.test(word)).sort(),
    ['NTL', 'NTR', 'NTS'],
  );
  // 梦境卡库一级分类的拆词代表全在表里(E:\fixture-cards\,2026-10-25 清点;复合目录名已拆)。
  for (const word of ['假小子', '御姐', '人妻', '熟女', '百合', '纯爱', '调教', '校园', '妹妹', '女儿', '同人', '全年龄', '正常向']) {
    assert.equal(isCategoryRandomWord(word), true, word);
  }
  // 复合目录名「御姐，人妻」拆的是词 —— 原样整串不算类目。
  assert.equal(isCategoryRandomWord('御姐，人妻'), false);
});

test('meitu-command:类目词在解析层只跳过 —— 不进 tags 不当角色名,ASCII 类目词不被吃成 tag', () => {
  // ASCII 类目词必须跳过 tag 形状判断:否则「来点NTR图」会带着 ntr tag 去查询 → 图源 0 结果。
  assert.deepEqual(parseMeituCommand('来点NTR图'), expect({ random: true, tags: [] }));
  assert.deepEqual(parseMeituCommand('来点NTR美图'), expect({ random: true, tags: [] }));
  // 中文类目词照旧就地转随机(解析层 skip;具名角色不受影响 —— 查表在服务层,分工不变)。
  assert.deepEqual(parseMeituCommand('来点御姐图'), expect({ random: true }));
  assert.deepEqual(parseMeituCommand('来2张萝莉美图'), expect({ count: 2, character: '萝莉' }));
  // 完整指令里的 ASCII 类目词:解析层原样留角色位(它不查词表),service 层兜类目随机。
  assert.deepEqual(parseMeituCommand('来2张NTR美图'), expect({ count: 2, character: 'NTR' }));
  // ASCII 类目词出现在**修饰位**:静默跳过(与 VAGUE_WORDS 同口径,不进 tags 也不进 ignored)。
  assert.deepEqual(parseMeituCommand('来2张合成名丁美图 NTR'), expect({ count: 2, character: '合成名丁' }));
});

// ---------------------------------------------------------------------------
// 2026-10-28 c106 回归:角色槽边界与修饰区的有限强调前缀。
// ---------------------------------------------------------------------------

test('meitu-command:c106 原话 —— 类目后角色槽关闭,最大巨乳复用现有 tag,大大大只留 ignored', () => {
  assert.deepEqual(
    parseMeituCommand('@合成助手乙 再来几张熟女图，要最大的巨乳，要大大大'),
    expect({ count: 5, random: true, tags: ['large_breasts'], ignored: ['大大大'] }),
  );
});

test('meitu-command:随机后的未知修饰两条数量路径一致,不回升成角色', () => {
  for (const [quantity, count] of [['', 1], ['2', 2]]) {
    for (const noun of ['', '美图']) {
      assert.deepEqual(parseMeituCommand(`来${quantity}张随机好看${noun}`),
        expect({ count, random: true, ignored: ['好看'] }));
    }
    for (const input of [`来${quantity}张随机 高清`, `来${quantity}张熟女图 高清`, `来${quantity}张熟女的图 高清`, `来${quantity}张要高清`]) {
      assert.deepEqual(parseMeituCommand(input), expect({ count, random: true, ignored: ['高清'] }), input);
    }
    assert.deepEqual(parseMeituCommand(`来${quantity}张随机 高清 合成名丁`),
      expect({ count, random: true, ignored: ['高清', '合成名丁'] }), '角色槽关闭后不能再次打开');
    assert.deepEqual(parseMeituCommand(`来${quantity}张随机最大的巨乳美图`),
      expect({ count, random: true, tags: ['large_breasts'] }));
    // splitModifierRun 的未知原文仍是 plain,不能借新前缀逻辑改掉原来的分类口径。
    assert.deepEqual(parseMeituCommand(`来${quantity}张随机Feet美图`),
      expect({ count, random: true, ignored: ['Feet'] }));
  }
});

test('meitu-command:逗号分号顿号和要请关闭角色槽,完整角色不跨标点吞修饰', () => {
  for (const delimiter of ['，', ',', '；', ';', '、']) {
    assert.deepEqual(parseMeituCommand(`来张${delimiter}高清`), expect({ random: true, ignored: ['高清'] }));
    for (const quantity of ['', '2']) {
      const count = quantity ? 2 : 1;
      assert.deepEqual(parseMeituCommand(`来${quantity}张合成名丁${delimiter}高清美图`),
        expect({ count, character: '合成名丁', ignored: ['高清'] }));
      assert.deepEqual(parseMeituCommand(`来${quantity}张合成名丁${delimiter}巨乳美图`),
        expect({ count, character: '合成名丁', tags: ['large_breasts'] }));
    }
  }
  for (const lead of ['要', '请']) {
    assert.deepEqual(parseMeituCommand(`来张${lead}高清 神秘`), expect({ random: true, ignored: ['高清', '神秘'] }));
    assert.deepEqual(parseMeituCommand(`来2张合成名丁 ${lead}最大的巨乳美图`),
      expect({ count: 2, character: '合成名丁', tags: ['large_breasts'] }));
  }
});

test('meitu-command:强调前缀仅在明确修饰区精确命中已有 TAG_WORDS,不搜全串子串', () => {
  for (const prefix of ['最大的', '最大', '特别', '非常', '超级', '很']) {
    assert.deepEqual(parseMeituCommand(`来张要${prefix}巨乳的`),
      expect({ random: true, tags: ['large_breasts'] }));
    assert.deepEqual(parseMeituCommand(`来2张合成名丁美图 ${prefix}巨乳`),
      expect({ count: 2, character: '合成名丁', tags: ['large_breasts'] }));
  }
  for (const word of ['不要巨乳', '不是巨乳', '没有巨乳', '最大的巨乳仙子', '非常高清', '大大大']) {
    assert.deepEqual(parseMeituCommand(`来张要${word}`), expect({ random: true, ignored: [word] }), word);
    assert.deepEqual(parseMeituCommand(`来2张合成名丁美图 要${word}`),
      expect({ count: 2, character: '合成名丁', ignored: [word] }), word);
  }
  for (const name of ['合成短语甲', '熟女仙子', '巨乳仙子', '最大的巨乳']) {
    assert.deepEqual(parseMeituCommand(`来张${name}图`), expect({ character: name }), name);
    assert.deepEqual(parseMeituCommand(`来2张${name}美图`), expect({ count: 2, character: name }), name);
  }
  // 完整角色名首字可能就是要/请，不能被误当作修饰引导；未知整名也留给后续模型兜底。
  for (const name of ['要合成甲', '请合成乙', '要好看']) {
    assert.deepEqual(parseMeituCommand(`来2张${name}美图`), expect({ count: 2, character: name }));
  }
  // 完整指令类目保留给服务层别名优先;不能为了本次现场全量改走 flex。
  assert.deepEqual(parseMeituCommand('来2张熟女美图 高清'),
    expect({ count: 2, character: '熟女', ignored: ['高清'] }));
  // 只按完整 chunk 判断类目,不按前缀吞掉未知名字。
  assert.deepEqual(parseMeituCommand('来点合成短语甲图'), expect({ character: '合成短语甲' }));
});

// ---------------------------------------------------------------------------
// ⑦''' 「几张」= 5 张(1.199.0,主人拍板:问句量词直接按五张执行)
// ---------------------------------------------------------------------------

test('meitu-command:「几张」直接判定为五张(完整/残缺/@残留/噪点前缀 都认)', () => {
  assert.deepEqual(
    parseMeituCommand('来几张合成名丁美图'),
    expect({ count: 5, character: '合成名丁' }),
    '完整指令:几张=5 + 角色 + 档位名词',
  );
  assert.deepEqual(
    parseMeituCommand('发几张合成角色甲涩图'),
    expect({ count: 5, character: '合成角色甲', tier: 'seitu' }),
    '涩图档照常',
  );
  assert.deepEqual(
    parseMeituCommand('来几张'),
    expect({ count: 5, random: true }),
    '残缺指令:几张=5,没角色=随机',
  );
  assert.deepEqual(
    parseMeituCommand('@合成助手 来几张合成名丁美图'),
    expect({ count: 5, character: '合成名丁' }),
    '前导 @残留剥除不受影响',
  );
  // 前缀噪点 + 「几张」:这句话现在是**真指令**(随机 5 张) —— 1.199.0 的语义翻转;
  // looksLikeMeituAttempt 那边仍 false(带前缀开头不对),两套判据各管各的。
  assert.deepEqual(
    parseMeituCommand('今天发几张美图'),
    expect({ count: 5, random: true }),
  );
  // 护栏:动词后带「了」天然不匹配数量位 —— 「发来了几张…」是转述句,不是指令。
  assert.deepEqual(parseMeituCommand('发来了几张截图'), { ok: false, reason: 'format' });
  assert.deepEqual(parseMeituCommand('回来了几张图看看'), { ok: false, reason: 'format' });
  // 「十几/几十几」不认:split 正则数字类不收「几」→ NaN → count 失败(明确回格式话,不猜)。
  assert.deepEqual(parseMeituCommand('来十几张美图'), { ok: false, reason: 'count' });
  assert.deepEqual(parseMeituCommand('来几十几张合成作品乙的美图'), { ok: false, reason: 'count' });
});

// ---------------------------------------------------------------------------
// ⑦'' 前缀噪点(2026-10-23 / 1.188.1)
//   主人现场:「再来五张合成名庚美图，要泳装的」—— 前面一个「再」就整条走了 LLM。
//   口径(主人拍板):**只要指令在句子里出现就认**,前缀最多 MAX_NOISE_PREFIX 字噪点。
// ---------------------------------------------------------------------------

const NOISE_TABLE = [
  // 现场原样(1.188.0 现场 14:44 那条)。
  [
    '再来五张合成名庚美图，要泳装的',
    expect({ count: 5, character: '合成名庚', tags: ['swimsuit'] }),
  ],
  // 语气词 + 连词前缀。
  [
    '嗯…那就来两张合成角色甲涩图',
    expect({ count: 2, character: '合成角色甲', tier: 'seitu' }),
  ],
  // 闲聊前缀(在 24 字以内)。
  [
    '麻烦你了，再来五张合成名庚美图',
    expect({ count: 5, character: '合成名庚' }),
  ],
  // 动词换成「找」也一样。
  [
    '顺便找两张合成角色丙美图',
    expect({ count: 2, character: '合成角色丙' }),
  ],
  // 「搬」也放宽(1.181.0 的动词)。
  [
    '再搬两张合成名乙涩图',
    expect({ count: 2, character: '合成名乙', tier: 'seitu' }),
  ],
  // 前缀是她的名字。
  [
    '合成助手，帮我发1张合成角色甲美图',
    expect({ character: '合成角色甲' }),
  ],
  // 残缺指令跟着放宽(「再来2张」= 接着上一句继续要,随机角色)。
  [
    '那就再来2张',
    expect({ count: 2, random: true }),
  ],
  // 随机标记词一起放宽。
  [
    '嗯…再来三张随机双马尾美图',
    expect({ count: 3, random: true, tags: ['twintails'] }),
  ],
];

test('meitu-command:前缀噪点 —— 指令不在开头也认(主人 2026-10-23 拍板的宽度)', () => {
  for (const [input, expected] of NOISE_TABLE) {
    assert.deepEqual(parseMeituCommand(input), expected, `输入 ${JSON.stringify(input)}`);
  }
});

test('meitu-command:前缀噪点两条护栏 —— 复合词不当动词、隔太远不认', () => {
  // ① 复合词护栏:「回来/头发/寻找」里的动词只是词尾,不是指令(不挡就会误触发)。
  for (const text of ['我昨天回来3张照片真好看', '头发3张', '寻找2张合成角色丙美图']) {
    assert.deepEqual(parseMeituCommand(text), { ok: false, reason: 'format' }, `输入 ${JSON.stringify(text)}`);
  }
  // ② 距离上限:前缀最多 MAX_NOISE_PREFIX 字,再多就不认(更像闲聊里顺嘴提了一句)。
  const near = `${'这'.repeat(MAX_NOISE_PREFIX)}来2张合成角色甲美图`;
  assert.equal(parseMeituCommand(near).ok, true, '前缀正好等于上限要认');
  const far = `${'这'.repeat(MAX_NOISE_PREFIX + 1)}来2张合成角色甲美图`;
  assert.deepEqual(parseMeituCommand(far), { ok: false, reason: 'format' }, '超过上限不认');
  // ③ 起点确实是这条指令、但数量写坏(0 张)→ 确定失败,不许被后面的候选词救回来。
  assert.deepEqual(parseMeituCommand('那就来0张美图，再来2张美图'), { ok: false, reason: 'count' });
  // ④ 元判据:表里第一行随便改一个字段就必须红(别让表变成"自我复制")。
  const [input, expected] = NOISE_TABLE[0];
  assert.deepEqual(parseMeituCommand(input), expected);
  assert.notDeepEqual(parseMeituCommand(input), { ...expected, count: expected.count + 1 });
});

// ---------------------------------------------------------------------------
// ⑦'' 角色位词尾粘着修饰(1.191.0,主人:「来两张合成名戊裸足美图」被整段当角色名)
// ---------------------------------------------------------------------------

test('meitu-command:角色位候选 —— 原样在前、逐级剥词尾修饰', () => {
  // 纯词法(不查表):原样在前,剥得越多越靠后。
  assert.deepEqual(characterSlotVariants('合成名戊裸足'), [
    { character: '合成名戊裸足', tags: [], erotic: false },
    { character: '合成名戊', tags: ['barefoot'], erotic: false },
  ]);
  assert.deepEqual(characterSlotVariants('裸足'), [
    { character: '裸足', tags: [], erotic: false },
    { character: '', tags: ['barefoot'], erotic: false },
  ]);
  // 多个粘着修饰:剥出来的顺序仍是**原文顺序**(裸足在 白丝 之前)。
  assert.deepEqual(characterSlotVariants('合成名戊裸足白丝')[2], {
    character: '合成名戊',
    tags: ['barefoot', 'thighhighs'],
    erotic: false,
  });
  // 词尾升档词也算(「合成名戊擦边」→ 合成名戊 + 升涩图档)。
  assert.deepEqual(characterSlotVariants('合成名戊擦边')[1], {
    character: '合成名戊',
    tags: [],
    erotic: true,
  });
});

test('meitu-command:用别名表挑角色位 —— 原样优先,再逐级剥;纯修饰=随机', () => {
  const table = { 合成名戊: 'x', 合成雪: 'y', 合成名丁: 'z' };
  const isKnown = (name) => Object.prototype.hasOwnProperty.call(table, name);
  // 粘着修饰 → 剥开(主人报的那句)。
  assert.deepEqual(pickCharacterSlot('合成名戊裸足', isKnown), {
    character: '合成名戊', tags: ['barefoot'], erotic: false, random: false,
  });
  // 名字本身就是词尾修饰词(合成雪) → **原样优先**,不许剥成「合成」。
  assert.deepEqual(pickCharacterSlot('合成雪', isKnown), {
    character: '合成雪', tags: [], erotic: false, random: false,
  });
  // 名字以修饰词结尾、又加了修饰 → 先保整名,再剥外层的裸足。
  assert.deepEqual(pickCharacterSlot('合成雪裸足', isKnown), {
    character: '合成雪', tags: ['barefoot'], erotic: false, random: false,
  });
  // 角色位只剩修饰 → 随机角色 + 该修饰。
  assert.deepEqual(pickCharacterSlot('裸足', isKnown), {
    character: '', tags: ['barefoot'], erotic: false, random: true,
  });
  // 都登记不上 → 原样返回,交给上层回「没登记」(不许吞掉)。
  assert.deepEqual(pickCharacterSlot('路人甲裸足', isKnown), {
    character: '路人甲裸足', tags: [], erotic: false, random: false,
  });
});

test('meitu-command:修饰收口 —— 角色位剥出的修饰排前面,去重且最多 2 个', () => {
  assert.deepEqual(
    applyCharacterSlot({ tags: ['swimsuit'], tier: 'meitu' }, { tags: ['barefoot', 'swimsuit'], erotic: false }),
    { tags: ['barefoot', 'swimsuit'], tier: 'meitu' },
  );
  assert.deepEqual(
    applyCharacterSlot({ tags: ['solo', 'glasses'], tier: 'meitu' }, { tags: ['barefoot'], erotic: false }),
    { tags: ['barefoot', 'solo'], tier: 'meitu' },
    '超过 2 个截断',
  );
  assert.deepEqual(
    applyCharacterSlot({ tags: [], tier: 'meitu' }, { tags: [], erotic: true }),
    { tags: [], tier: 'seitu' },
    '剥出「擦边/涩」→ 升涩图档',
  );
});

test('meitu-command:合成别名表 —— 每个登记名一个都不许被剥,加「裸足」都要能剥回去', () => {
  // 固定267个合成名，加上修饰词尾/要请前缀边界，不依赖真实运行表或文件缺失而空过。
  // ① 登记名原样优先；② 每个登记名外加裸足都必须剥回原名并保留修饰。
  const names = [...Array.from({ length: 267 }, (_, i) => `合成登记${i}`),
    '合成雪', '合成裸足', '合成白丝', '合成泳装', '要合成甲', '请合成乙'];
  const syntheticJsonc = '// 合成分类备注\n' + JSON.stringify(Object.fromEntries(names.map((name, i) => [name, `fixture_tag_${i}`])));
  const table = JSON.parse(stripJsonComments(syntheticJsonc));
  assert.ok(table && typeof table === 'object' && Object.keys(table).length > 0, '别名表读出来是空的');
  const isKnown = (name) => Object.prototype.hasOwnProperty.call(table, name);
  const misPeeled = [];
  const misSplit = [];
  for (const name of Object.keys(table)) {
    const plain = pickCharacterSlot(name, isKnown);
    if (plain.character !== name || plain.tags.length > 0 || plain.random) misPeeled.push(name);
    const glued = pickCharacterSlot(`${name}裸足`, isKnown);
    if (glued.character !== name || !glued.tags.includes('barefoot')) misSplit.push(name);
  }
  assert.deepEqual(misPeeled, [], `这些登记名被当成了「名字+修饰」剥开:${misPeeled.join('、')}`);
  assert.deepEqual(misSplit, [], `这些名字加「裸足」没剥回去:${misSplit.join('、')}`);
});

test('meitu-command:解析器只管词法 —— 粘着修饰的原文保留,剥不剥由服务层按别名表挑', () => {
  // 解析器**不查别名表**(纯函数)。「合成名戊裸足」原样留在角色位,由 pickCharacterSlot 决定怎么切;
  // 这样「合成雪」这类名字以修饰词结尾的角色才不会被解析器擅自剥掉。
  assert.deepEqual(parseMeituCommand('来两张合成名戊裸足美图'), expect({ count: 2, character: '合成名戊裸足' }));
  assert.deepEqual(parseMeituCommand('来两张裸足美图'), expect({ count: 2, character: '裸足' }));
  // 修饰写在名词后面(有空格)照旧直接进 tags,不经过角色位。
  assert.deepEqual(
    parseMeituCommand('来两张合成名戊美图 裸足'),
    expect({ count: 2, character: '合成名戊', tags: ['barefoot'] }),
  );
});

// ---------------------------------------------------------------------------
// ⑧ 词尾剥除
// ---------------------------------------------------------------------------

test('meitu-command:词尾「的/图/向/级/片」连续剥(「图片」「片」都不留尾巴)', () => {
  assert.equal(parseMeituCommand('发1张合成角色甲图片').character, '合成角色甲');
  assert.equal(parseMeituCommand('来1张合成名乙的').character, '合成名乙');
  assert.equal(parseMeituCommand('搬1张合成名乙片的').character, '合成名乙');
  // 「美图」整体是名词,不许剥成「美」当角色名(2026-10-23 现场踩过的回归)。
  assert.deepEqual(parseMeituCommand('发1张美图'), expect({ random: true }));
  assert.deepEqual(parseMeituCommand('发1张 美图'), expect({ random: true }));
  // 完整指令里角色位是虚词 → 一样算随机(不许把「随便」当角色名去查别名表)。
  assert.deepEqual(
    parseMeituCommand('来2张随便的涩图'),
    expect({ count: 2, tier: 'seitu', random: true }),
  );
  assert.deepEqual(parseMeituCommand('来3张随便的美图'), expect({ count: 3, random: true }));
});

// ---------------------------------------------------------------------------
// ⑨ looksLikeMeituAttempt
// ---------------------------------------------------------------------------

test('meitu-command:looksLike 只认"发/来/找/搬 N张"开头(剥完 @残留)', () => {
  assert.equal(looksLikeMeituAttempt('发1张美图'), true);
  assert.equal(looksLikeMeituAttempt('发1张合成角色甲美图'), true);
  assert.equal(looksLikeMeituAttempt('发 3 张 合成角色甲 美图 擦边'), true);
  assert.equal(looksLikeMeituAttempt(' 发2张美图 '), true);
  assert.equal(looksLikeMeituAttempt('，发1张美图'), true);
  assert.equal(looksLikeMeituAttempt('来1张美图'), true);
  assert.equal(looksLikeMeituAttempt('搬1张合成名乙美图'), true);
  assert.equal(looksLikeMeituAttempt('@合成助手，发1张美图'), true);
  assert.equal(looksLikeMeituAttempt('@合成助手发1张美图'), true);
  assert.equal(looksLikeMeituAttempt('发张美图'), false, '残缺形状由 parseMeituCommand 直接接走,不走格式提示');
  assert.equal(looksLikeMeituAttempt('今天来一张美图吧'), false, '随口一说开头就不对,不拦');
  assert.equal(looksLikeMeituAttempt('今天发几张美图吧'), false);
  assert.equal(looksLikeMeituAttempt('发几张美图'), true, '1.199.0:「几张」进了数量字类,动词开头的「发几张」算指令形状');
});

export function registerMeituCommandTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerMeituCommandTests 需要 test');
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
