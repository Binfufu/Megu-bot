/**
 * **卡库判据**（A 刀；2026-10-13）—— `scripts\selftest.js` 会 import 这份并跑。
 *
 * ⚠️ 为什么不自己 `process.exit`：这个项目的 `selftest` 是**一份**总数
 * （`N passed, N failed`），拆成两个进程会让"N 全绿"这句话失去意义。
 * 所以这里只导出 `registerDreamTests(test, assert)`，由主文件调。
 *
 * ## 判据的分工（这条比用例本身值钱）
 *
 * · **合成样本**测"边界"：截断的 PNG、畸形块长度、奇数长度的 base64、
 *   `keys`/`key` 两种写法、`position` 的数字与字符串两种编码。
 *   这些东西**真卡库里不一定有**，但一旦有一张就会静默出错（不抛异常那种最贵）。
 * · **合成卡真文件**测"这一整套从磁盘读入后结构成立"：
 *   纯 JSON 世界书、PNG 世界卡壳、内嵌世界书角色卡、工具生成器 —— 四类全部必跑。
 *   内容是显然合成的值，不依赖私人卡库，不再因本机缺席而跳过；
 *   条目数量、常驻/键控、位置/depth、完整正文等原强断言全部保留。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  GENERATOR_HINTS,
  INDEX_TEXT_CHARS,
  INDEX_VERSION,
  KIND,
  POSITION,
  POSITION_BY_NAME,
  approxTokens,
  cardId,
  classifyCard,
  fileNameOf,
  normalizeBook,
  normalizeBookEntries,
  normalizeCharacter,
  normalizeKeys,
  normalizePosition,
  parseCard,
  parseCardSync,
  parseCardText,
  PRIORITY_TAGS,
  childTagsFor,
  dedupeByDigest,
  tagPathMatches,
  readTextChunks,
  searchCards,
  searchCardsDetailed,
  stripExt,
  summarizeLibrary,
  utf8Bytes,
} from '../src/dream-cards.js';
import {
  healthReport,
  indexHeader,
  mergeRecords,
  parseIndex,
  parseIndexLine,
  queryCards,
  recordById,
  serializeIndex,
  staleCandidates,
} from '../src/dream-index.js';

// ---------------------------------------------------------------------------
// 造 PNG（为了能造**坏样本**）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 造一张最小 PNG（8 字节 IHDR + 若干 tEXt + IEND）。像素数据不需要 —— 解析器只看文本块。 */
function makePng(textChunks) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [sig, chunk('IHDR', ihdr)];
  for (const [key, value] of Object.entries(textChunks)) {
    parts.push(chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(String(value), 'utf8')])));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** ST 的 `chara` 块是 base64 的 JSON。 */
function charaOf(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** 一张够"像角色卡"的 v2 卡（有开场白、有示例，避免被判成世界卡）。 */
function sampleCard(overrides = {}) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '测试角色',
      description: '一个用来跑判据的角色。',
      personality: '冷静',
      scenario: '测试场景',
      first_mes: '「你好。」她说。',
      mes_example: '<START>\n{{user}}: 在吗\n{{char}}: 在。',
      creator_notes: '判据用',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['测试'],
      creator: 'selftest',
      character_version: '1.0',
      extensions: { talkativeness: '0.5' },
      ...overrides,
    },
  };
}

export function registerDreamTests(test, assert) {
  // -------------------------------------------------------------------------
  // ⓪ 文件夹标签(1.134.0:分类文件夹名 → tags,用户整理的 D:\卡 卡库)
  // -------------------------------------------------------------------------

  test('卡库：folderTagsFor —— 类别层之下每层文件夹名都是标签,类别层本身不算', async () => {
    const { folderTagsFor } = await import('../src/dream-cards.js');
    const root = 'E:\\fixture-cards';
    assert.deepEqual(
      folderTagsFor(root, 'E:\\fixture-cards\\角色卡\\示例分类甲\\某卡.png'),
      ['示例分类甲'],
      '角色卡下一层分类 = 标签',
    );
    assert.deepEqual(
      folderTagsFor(root, 'E:\\fixture-cards\\角色卡\\同人\\手游\\示例作品\\某卡.png'),
      ['同人', '手游', '示例作品'],
      '多层分类每层都是标签(保序)',
    );
    assert.deepEqual(folderTagsFor(root, 'E:\\fixture-cards\\角色卡\\直接躺着的.png'), [],
      '没有分类子文件夹 = 没有文件夹标签,不硬造');
    assert.deepEqual(folderTagsFor(root, 'E:\\fixture-cards\\主世界卡\\某世界卡.png'), [],
      '类别层自己(主世界卡)不是标签');
    assert.deepEqual(folderTagsFor(root, 'E:\\fixture-cards\\角色卡\\示例分类乙 \\某卡.png'), ['示例分类乙'],
      '文件夹名要 trim(分类名可能带尾随空格)');
    assert.deepEqual(folderTagsFor('E:\\别处', 'E:\\fixture-cards\\角色卡\\示例分类甲\\x.png'), [],
      '不属这个根的路径返回空');
    assert.deepEqual(folderTagsFor('E:\\fixture-cards', null), []);
  });

  // -------------------------------------------------------------------------
  // ① PNG 块读取
  // -------------------------------------------------------------------------

  test('卡库：readTextChunks 认得 tEXt，非 PNG 返回 null', () => {
    const png = makePng({ chara: 'x', note: '中文也行' });
    const chunks = readTextChunks(png);
    assert.deepEqual(Object.keys(chunks).sort(), ['chara', 'note']);
    assert.equal(chunks.note, '中文也行');
    // 非 PNG
    assert.equal(readTextChunks(Buffer.from('not a png at all', 'utf8')), null);
    assert.equal(readTextChunks(Buffer.alloc(0)), null);
    assert.equal(readTextChunks(null), null);
  });

  test('卡库：PNG 块长度畸形时**停下而不是抛/死循环**', () => {
    const png = makePng({ chara: charaOf(sampleCard()) });
    // 把 IHDR 之后第一个块的长度字段改成一个天文数字
    const broken = Buffer.from(png);
    broken.writeUInt32BE(0x7fffffff, 8);
    const chunks = readTextChunks(broken);
    // 它必须**返回一个对象**（可以空），而不是抛异常或转不出来
    assert.equal(typeof chunks, 'object');
    // 截断到一半也必须能返回
    const truncated = png.subarray(0, png.length - 7);
    assert.equal(typeof readTextChunks(truncated), 'object');
  });

  test('卡库：zTXt 压缩块在同步路径下被**跳过**（这是刻意的分工）', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const body = Buffer.concat([
      Buffer.from('chara', 'latin1'),
      Buffer.from([0, 0]), // 压缩方法 0
      zlib.deflateSync(Buffer.from(charaOf(sampleCard()), 'utf8')),
    ]);
    const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('zTXt', body), chunk('IEND', Buffer.alloc(0))]);
    const chunks = readTextChunks(png);
    // 同步版不认它 —— 于是 parseCardSync 拿不到卡（说明它没瞎猜）
    assert.equal(chunks.chara, undefined);
    assert.equal(parseCardSync({ path: 'x.png', bytes: png }), null);
  });

  // -------------------------------------------------------------------------
  // ② 正文解析（base64 / 明文 / 噪声）
  // -------------------------------------------------------------------------

  test('卡库：parseCardText 同时认 base64 与明文 JSON', () => {
    const card = sampleCard();
    const json = JSON.stringify(card);
    assert.equal(parseCardText(json).data.name, '测试角色');
    assert.equal(parseCardText(charaOf(card)).data.name, '测试角色');
    assert.equal(parseCardText('   '), null);
    assert.equal(parseCardText('这不是 JSON 也不是 base64!!!'), null);
    assert.equal(parseCardText('{ 坏 JSON'), null);
    assert.equal(parseCardText(undefined), null);
  });

  test('卡库：奇数长度的 base64 噪声不会解析成卡', () => {
    // 长度是奇数且不合法 → 不许把它当 base64 硬解
    const noise = 'abc';
    const parsed = parseCardText(noise);
    assert.ok(parsed === null || typeof parsed === 'object');
    // 真正要钉的是：**不能抛**
    assert.doesNotThrow(() => parseCardText('A'.repeat(999)));
  });

  // -------------------------------------------------------------------------
  // ③ 归一化
  // -------------------------------------------------------------------------

  test('卡库：normalizePosition 认数字 0~7，也认 before_char/after_char/at_depth', () => {
    assert.equal(normalizePosition(0), POSITION.before);
    assert.equal(normalizePosition(4), POSITION.atDepth);
    assert.equal(normalizePosition(7), POSITION.outlet);
    assert.equal(normalizePosition('before_char'), POSITION.before);
    assert.equal(normalizePosition('after_char'), POSITION.after);
    assert.equal(normalizePosition('at_depth'), POSITION.atDepth);
    // 越界/垃圾值一律退回 before（而不是 NaN —— NaN 会让整条排序塌掉）
    assert.equal(normalizePosition(99), POSITION.before);
    assert.equal(normalizePosition('胡说'), POSITION.before);
    assert.equal(normalizePosition(undefined), POSITION.before);
    assert.equal(normalizePosition(null), POSITION.before);
    // 名字表必须覆盖全部 8 个位置，少一个就是静默错位
    assert.equal(Object.keys(POSITION_BY_NAME).length, 8);
  });

  test('卡库：normalizeKeys 收 `keys`，也收老格式的 `key`（单个字符串）', () => {
    assert.deepEqual(normalizeKeys({ keys: ['a', 'b'] }), ['a', 'b']);
    assert.deepEqual(normalizeKeys({ key: 'a' }), ['a']);
    assert.deepEqual(normalizeKeys({ key: ['a', 'a', 'b'] }), ['a', 'b']);
    assert.deepEqual(normalizeKeys({ key: ['', '  ', 'a'] }), ['a']);
    assert.deepEqual(normalizeKeys({}), []);
    assert.deepEqual(normalizeKeys(null), []);
  });

  test('卡库：normalizeBookEntries 收数组与对象两种 entries，并补 uid', () => {
    const asArray = normalizeBookEntries({
      entries: [
        { uid: 3, comment: 'A', keys: ['k'], content: '正文', position: 4, depth: 2, order: 10 },
      ],
    });
    assert.equal(asArray.length, 1);
    assert.equal(asArray[0].position, POSITION.atDepth);
    assert.equal(asArray[0].bytes, utf8Bytes('正文'));
    assert.equal(asArray[0].constant, false);

    const asObject = normalizeBookEntries({
      entries: {
        0: { comment: 'B', key: ['x', 'y'], content: 'c', constant: true },
        1: { comment: 'C', key: 'z', content: 'd', position: 'after_char' },
      },
    });
    assert.equal(asObject.length, 2);
    assert.equal(asObject[0].constant, true);
    assert.equal(asObject[1].position, POSITION.after);
    // 没写 uid 的必须被补上**互不相同**的 uid（否则下游按 uid 去重会把两张并成一张）
    const uids = asObject.map((e) => e.uid);
    assert.equal(new Set(uids).size, uids.length);

    // 垃圾输入不抛
    assert.deepEqual(normalizeBookEntries(null), []);
    assert.deepEqual(normalizeBookEntries({ entries: 'nope' }), []);
    assert.deepEqual(normalizeBookEntries({ entries: [null, 1, 'x', [], {}] }).length, 1);
  });

  test('卡库：世界书条目的 extensions 里的旋钮也要读出来', () => {
    const [entry] = normalizeBookEntries({
      entries: [{
        comment: '带旋钮',
        keys: ['a'],
        content: 'x',
        extensions: { exclude_recursion: true, scan_depth: 3, match_whole_words: true, case_sensitive: true, ignore_budget: true, position: 'at_depth' },
      }],
    });
    assert.equal(entry.excludeRecursion, true);
    assert.equal(entry.scanDepth, 3);
    assert.equal(entry.matchWholeWords, true);
    assert.equal(entry.caseSensitive, true);
    assert.equal(entry.ignoreBudget, true);
  });

  test('卡库：normalizeCharacter 同时认 v1 平铺与 v2 的 data', () => {
    const v2 = normalizeCharacter(sampleCard());
    assert.equal(v2.name, '测试角色');
    assert.equal(v2.firstMes, '「你好。」她说。');
    assert.equal(v2.talkativeness, 0.5);
    assert.ok(v2.bytes > 0);

    const v1 = normalizeCharacter({
      name: '老卡',
      description: 'v1 平铺',
      first_mes: '你好',
      mes_example: '',
      personality: '',
      scenario: '',
      tags: [],
      alternate_greetings: [],
    });
    assert.equal(v1.name, '老卡');
    assert.equal(v1.description, 'v1 平铺');
    assert.equal(v1.firstMes, '你好');

    assert.equal(normalizeCharacter(null), null);
    assert.equal(normalizeCharacter({}), null);
    assert.equal(normalizeCharacter({ data: null }), null);
  });

  // -------------------------------------------------------------------------
  // ④ 类型判定
  // -------------------------------------------------------------------------

  test('卡库：世界卡判定要 first_mes 空 + 世界书够多 + 描述够长（三条齐）', () => {
    const book = { entries: Array.from({ length: 10 }, (_, i) => ({ comment: `e${i}`, keys: [`k${i}`], content: 'x' })) };
    // 三条齐 → worldcard
    assert.equal(classifyCard({
      character: { name: 'X', description: '世'.repeat(200), firstMes: '', personality: '', scenario: '', mesExample: '', alternateGreetings: [], tags: [] },
      book: normalizeBook(book),
      fileName: 'X.png',
    }), KIND.worldcard);
    // 有开场白 → character（哪怕世界书很长）
    assert.equal(classifyCard({
      character: { name: 'X', description: '世'.repeat(200), firstMes: '你好', personality: '', scenario: '', mesExample: '', alternateGreetings: [], tags: [] },
      book: normalizeBook(book),
      fileName: 'X.png',
    }), KIND.character);
    // 世界书太少 → character
    assert.equal(classifyCard({
      character: { name: 'X', description: '世'.repeat(200), firstMes: '', personality: '', scenario: '', mesExample: '', alternateGreetings: [], tags: [] },
      book: normalizeBook({ entries: [{ keys: ['a'], content: 'x' }] }),
      fileName: 'X.png',
    }), KIND.character);
    // 描述太短（空壳）→ character
    assert.equal(classifyCard({
      character: { name: 'X', description: '短', firstMes: '', personality: '', scenario: '', mesExample: '', alternateGreetings: [], tags: [] },
      book: normalizeBook(book),
      fileName: 'X.png',
    }), KIND.character);
  });

  test('卡库：没有角色正文 = 世界书（lorebook）', () => {
    assert.equal(classifyCard({ character: null, book: normalizeBook({ entries: [{ content: 'x' }] }), fileName: 'x.json', sourceKind: 'json' }), KIND.lorebook);
    assert.equal(classifyCard({ character: null, book: null, fileName: 'x.png' }), KIND.lorebook);
  });

  test('卡库：生成器卡靠明确的工具词标出来，**不许**被"转生/重生"里的"生成"骗到', () => {
    // 有完整开场白的生成器卡（工具夹里就是这种）
    const character = { name: '人物卡制作器', description: '做一个角色', firstMes: '请告诉我你要什么样的人', personality: '', scenario: '', mesExample: '', alternateGreetings: [], tags: [] };
    // ✅ 真工具：名字里有明确的工具词
    for (const name of ['示例人物卡制作器.png', '示例世界生成器1.png', '示例角色生成器.png', '示例人设提取demo-1000.png', '示例道具百科全书.png', '示例人物生成机器.png', '生成人物与示例开局方式.png']) {
      assert.equal(classifyCard({ character, book: null, fileName: name }), KIND.generator, name);
    }
    // ⚠️ **反例**（第一版全被判错，实测 25 张里至少 9 张是这种）：
    //    中文里"转生成/重生成"带着"生成"字面，但那是**角色卡最常见的起手式**
    for (const name of ['转生成为示例甲，进入示例世界！.png', '重生成示例乙的合成故事.png', '如果你定制生成的示例世界.png', '加上完全由AI生成的卡牌战斗的合成角色卡。示例战斗世界Ver2.0.png']) {
      assert.equal(classifyCard({ character, book: null, fileName: name }), KIND.character, name);
    }
    // `super gen v3` / `10分 气体生成器[已优化]` 这两张实测**判成 character** ——
    // ⚠️ 如实记：前者英文写法没有工具词、后者名字里是"气体生成器"（工具词表里没有它）。
    //    它们要么靠 overrides 手动标，要么以后加词。**不许为了让报告好看而放宽正则**
    //    （放宽的代价就是上面那 4 个反例又进来了）。
    assert.equal(classifyCard({ character, book: null, fileName: 'demo gen v3（合成样本）.png' }), KIND.character);
    // 名字里没有信号 → 就是普通角色卡
    assert.equal(classifyCard({ character, book: null, fileName: '示例甲.png' }), KIND.character);
  });

  test('卡库：路径里有"世界卡/世界书"且**确实带世界书**时，按目录认（实测 202 张只认出 45 张）', () => {
    const character = { name: '示例镇', description: '一个小镇', firstMes: '你醒了', personality: '', scenario: '', mesExample: '', alternateGreetings: [], tags: [] };
    const book = normalizeBook({ entries: Array.from({ length: 15 }, (_, i) => ({ comment: `e${i}`, keys: [`k${i}`], content: 'x' })) });
    // 带世界书 + 目录名 → worldcard（哪怕它有开场白 —— 作者就是这么做的）
    assert.equal(
      classifyCard({ character, book, fileName: '示例镇.png', path: 'D:\\cards\\已分类\\世界卡\\示例镇.png' }),
      KIND.worldcard,
    );
    // **同样的卡**放在别的目录 → 就是角色卡（有开场白，结构上分不开）
    assert.equal(
      classifyCard({ character, book, fileName: '示例镇.png', path: 'D:\\cards\\同人\\示例镇.png' }),
      KIND.character,
    );
    // 目录名说世界，但这张卡没世界书 → 不硬认成 worldcard（它得靠自己的结构说话）
    assert.equal(
      classifyCard({ character: { ...character, firstMes: '', description: '短' }, book: null, fileName: 'x.png', path: 'D:\\cards\\世界卡\\x.png' }),
      KIND.character,
    );
    // ⚠️ **裸世界书（没有角色正文）住在 `世界书\` 目录里时，必须是 lorebook 而不是 worldcard** ——
    //    这一条我第一版写反了（目录判型排在"没有角色正文"前面），把纯 JSON 世界书全说成了世界卡。
    assert.equal(
      classifyCard({ character: null, book, fileName: '某世界书.json', path: 'D:\\w\\世界书\\某世界书.json', sourceKind: 'json' }),
      KIND.lorebook,
    );
    // 显式清单压过目录名
    assert.equal(
      classifyCard({ character, book, fileName: '示例镇.png', path: 'D:\\cards\\世界卡\\示例镇.png', overrides: { '示例镇.png': KIND.character } }),
      KIND.character,
    );
    // 目录判型要**留痕**（报告里能看见有多少条走的是这条路，而不是靠猜）
    const parsed = parseCardSync({ path: 'D:\\cards\\世界卡\\示例镇.png', json: { data: character }, sourceKind: 'json' });
    assert.equal(parsed.record.kind, KIND.character); // 这个合成样本没带世界书 → 走结构判据
    assert.ok(!parsed.record.warnings.includes('by_dir'), '没走目录判型就不许留痕');
    // 真走目录判型时要留痕（这里显式给一份世界书）
    const withBook = parseCardSync({
      path: 'D:\\cards\\世界卡\\带书的.png',
      json: { data: { ...character, character_book: { entries: Array.from({ length: 6 }, (_, i) => ({ comment: `e${i}`, keys: [`k${i}`], content: 'x' })) } } },
      sourceKind: 'json',
    });
    assert.equal(withBook.record.kind, KIND.worldcard);
    assert.ok(withBook.record.warnings.includes('by_dir'), '目录判型必须留痕');
  });

  test('卡库：显式清单（overrides）压过一切，且最长键优先', () => {
    const overrides = {
      'D:\\cards\\世界卡\\': KIND.worldcard,
      'D:\\cards\\世界卡\\旁白.png': KIND.character,
    };
    // 最长键（具体文件）应该赢
    assert.equal(
      classifyCard({ character: null, book: null, fileName: '旁白.png', path: 'D:\\cards\\世界卡\\旁白.png', overrides }),
      KIND.character,
    );
    // 只命中前缀的走前缀
    assert.equal(
      classifyCard({ character: null, book: null, fileName: '别的.png', path: 'D:\\cards\\世界卡\\别的.png', overrides }),
      KIND.worldcard,
    );
    // 值不是合法类型 → 忽略清单，走结构判据
    assert.equal(
      classifyCard({ character: null, book: null, fileName: 'x.png', path: 'D:\\x.png', overrides: { 'D:\\x.png': '胡说' } }),
      KIND.lorebook,
    );
    // `$comment` 这类备注键不许当成清单
    assert.equal(
      classifyCard({ character: null, book: null, fileName: 'x.png', path: 'D:\\x.png', overrides: { '$comment': KIND.worldcard } }),
      KIND.lorebook,
    );
  });

  // -------------------------------------------------------------------------
  // ⑤ parseCard 端到端（合成）
  // -------------------------------------------------------------------------

  test('卡库：parseCardSync 从合成 PNG 走通，摘要与完整正文分家', () => {
    const card = sampleCard({ alternate_greetings: ['备一', '备二'] });
    const png = makePng({ chara: charaOf(card) });
    const parsed = parseCardSync({ path: 'D:\\cards\\测试角色.png', bytes: png, size: png.length, mtimeMs: 123 });
    assert.ok(parsed);
    assert.equal(parsed.record.kind, KIND.character);
    assert.equal(parsed.record.name, '测试角色');
    assert.equal(parsed.record.content.alternateGreetings, 2);
    assert.equal(parsed.record.mtimeMs, 123);
    assert.equal(parsed.record.id, cardId('D:\\cards\\测试角色.png'));
    // 摘要里**不许**有完整正文（否则索引库会膨胀到几百 MB）
    assert.equal(parsed.record.character, undefined);
    assert.equal(JSON.stringify(parsed.record).includes('「你好。」'), true); // firstMes 摘要里有
    // 完整正文里有逐字内容
    assert.equal(parsed.full.character.firstMes, '「你好。」她说。');
    assert.equal(parsed.full.character.alternateGreetings.length, 2);
  });

  test('卡库：ccv3（明文）与 chara（base64）给同一张卡时结果一致', () => {
    const card = sampleCard();
    const viaChara = parseCardSync({ path: 'a.png', bytes: makePng({ chara: charaOf(card) }) });
    const viaCcv3 = parseCardSync({ path: 'a.png', bytes: makePng({ ccv3: JSON.stringify(card) }) });
    assert.equal(viaChara.record.name, viaCcv3.record.name);
    assert.equal(viaChara.record.kind, viaCcv3.record.kind);
    assert.equal(viaChara.full.character.description, viaCcv3.full.character.description);
  });

  test('卡库：干脆没有卡数据的 PNG → null（不是空记录）', () => {
    const png = makePng({ note: '这不是卡' });
    assert.equal(parseCardSync({ path: 'x.png', bytes: png }), null);
    assert.equal(parseCardSync({ path: 'x.png', bytes: Buffer.from('nope') }), null);
  });

  test('卡库：纯 JSON 世界书（裸 entries）能直接当卡导进来', () => {
    const book = { name: '测试世界书', entries: { 0: { comment: '基调', content: '世界很大', keys: [] }, 1: { comment: '地点', keys: ['酒馆'], content: '有一间酒馆' } } };
    const parsed = parseCardSync({ path: 'D:\\w\\世界书.json', json: book, sourceKind: 'json' });
    assert.ok(parsed);
    assert.equal(parsed.record.kind, KIND.lorebook);
    assert.equal(parsed.record.book.entryCount, 2);
    assert.equal(parsed.full.book.entries.length, 2);
    assert.equal(parsed.full.character, null);
  });

  test('卡库：ID 由路径派生 —— 同样路径永远同样 id，不同路径不同 id', () => {
    assert.equal(cardId('D:\\a\\b.png'), cardId('D:\\a\\b.png'));
    assert.notEqual(cardId('D:\\a\\b.png'), cardId('D:\\a\\c.png'));
    assert.match(cardId('x'), /^[0-9a-f]{8}$/);
  });

  test('卡库：approxTokens 是粗估但单调（中文 1 字 ≈ 1，英文 4 字符 ≈ 1）', () => {
    assert.equal(approxTokens(''), 0);
    assert.ok(approxTokens('中'.repeat(100)) >= 95 && approxTokens('中'.repeat(100)) <= 105);
    assert.ok(approxTokens('a'.repeat(400)) >= 95 && approxTokens('a'.repeat(400)) <= 105);
    assert.ok(approxTokens('中'.repeat(50)) > approxTokens('中'.repeat(10)));
    assert.equal(approxTokens(null), 0);
  });

  test('卡库：fileNameOf / stripExt 认两种斜杠', () => {
    assert.equal(fileNameOf('D:\\cards\\a.png'), 'a.png');
    assert.equal(fileNameOf('/home/x/a.png'), 'a.png');
    assert.equal(stripExt('a.png'), 'a');
    assert.equal(stripExt('a.tar.gz'), 'a.tar');
    assert.equal(stripExt('.hidden'), '.hidden');
    assert.equal(stripExt('none'), 'none');
  });

  // -------------------------------------------------------------------------
  // ⑥ 检索与统计
  // -------------------------------------------------------------------------

  test('卡库：检索打分透明 —— 名字命中排在正文命中前面', () => {
    const records = [
      { id: '1', name: '示例甲世界', tags: [], book: null, kind: KIND.worldcard, content: {} },
      { id: '2', name: '别的东西', tags: [], book: null, kind: KIND.character, content: { description: '示例甲' } },
      { id: '3', name: '无关', tags: ['示例甲'], book: null, kind: KIND.character, content: {} },
    ];
    const hits = searchCards(records, { text: '示例甲' });
    assert.equal(hits.length, 3);
    assert.equal(hits[0].id, '1'); // 名字命中 100 > 标签 40 > 正文 8
    assert.equal(hits[1].id, '3');
    assert.equal(hits[2].id, '2');
    // 过滤
    assert.equal(searchCards(records, { text: '示例甲', kind: KIND.character }).length, 2);
    // 空词 = 全给（不筛）
    assert.equal(searchCards(records, {}).length, 3);
    // 多词是 **AND**：两个都是真词时只留同时命中两条的
    assert.equal(searchCards(records, { text: '示例甲 世界' }).length, 1);
    // ⚠️ 但"打错一个词就什么都搜不到"太脆（中文输入法天天有），所以规则是
    //    **严格 AND 一条都没有时，退回"命中任意词"**，并且 `partial` 标出来。
    const loose = searchCardsDetailed(records, { text: '示例甲 不存在的词' });
    assert.equal(loose.items.length, 3); // 退让 = 命中任意词的那 3 条
    assert.equal(loose.partial, true);
    assert.equal(loose.partialCount, 3);
    const strict = searchCardsDetailed(records, { text: '示例甲 世界' });
    assert.equal(strict.partial, false);
    // 一个词都不命中才是真的空
    assert.equal(searchCards(records, { text: '完全不存在' }).length, 0);
  });

  test('卡库：默认(无关键词)排序 —— PRIORITY_TAGS(同人)置顶,其余按名字(2026-10-14 / D227 追加十一)', () => {
    const records = [
      { id: 'a', name: 'demo_d', tags: ['示例分类丙'], kind: KIND.character, content: {} },
      { id: 'b', name: 'demo_a', tags: ['同人', '手游'], kind: KIND.character, content: {} },
      { id: 'c', name: 'demo_c', tags: [], kind: KIND.character, content: {} },
      { id: 'd', name: 'demo_b', tags: ['同人'], kind: KIND.character, content: {} },
    ];
    const hits = searchCards(records, {});
    // 同人两张在前(组内按名字),非同人按名字排后
    assert.deepEqual(hits.map((r) => r.id), ['b', 'd', 'c', 'a']);
    // 有关键词时打分规则不变:置顶加成不参与关键词打分
    const withText = searchCards(records, { text: 'demo_d' });
    assert.equal(withText[0].id, 'a');
    // 置顶清单本身钉住(用户拍板只有"同人",谁要加先改判据)
    assert.deepEqual(PRIORITY_TAGS, ['同人']);
  });

  test('卡库：dedupeByDigest —— 内容相同只留第一条,没 digest 的放行,名字相同不去重(1.136.0 / D227 追加十二)', () => {
    const records = [
      { id: 'a', name: '示例状态栏', digest: 'aaaaaaaaaaaaaaaa', path: 'E:\\fixture-cards\\角色卡\\示例分类甲\\甲\\x.json' },
      { id: 'b', name: '示例状态栏', digest: 'aaaaaaaaaaaaaaaa', path: 'E:\\fixture-cards\\角色卡\\示例分类甲\\乙\\x.json' },
      { id: 'c', name: '同名不同内容', digest: 'bbbbbbbbbbbbbbbb', path: 'E:\\fixture-cards\\角色卡\\示例分类甲\\丙\\y.json' },
      { id: 'd', name: '旧库没 digest', path: 'E:\\fixture-cards\\角色卡\\示例分类甲\\丁\\z.json' },
    ];
    const kept = dedupeByDigest(records);
    // 同 digest 只留第一条(a),保序;没 digest 的 d 原样放行
    assert.deepEqual(kept.map((r) => r.id), ['a', 'c', 'd']);
    // 空入空出;不改动记录本身
    assert.deepEqual(dedupeByDigest([]), []);
    assert.equal(kept[0], records[0]);
    // 索引版本必须带着 digest 字段这一档(版本对不上会强制全量重扫)
    assert.ok(INDEX_VERSION >= 3, 'INDEX_VERSION 应 ≥ 3(加 digest)');
  });

  test('卡库：tagPathMatches + childTagsFor —— 标签是分类文件夹路径,分级 chips(1.139.0 / D227 追加十五)', () => {
    // 前缀命中:选中 同人 = 同人**整棵子树**都算;选中 同人>手游 只留那一层
    assert.equal(tagPathMatches(['同人', '手游'], ['同人']), true);
    assert.equal(tagPathMatches(['同人', '手游'], ['同人', '手游']), true);
    assert.equal(tagPathMatches(['同人', '手游'], ['同人', '动画']), false);
    assert.equal(tagPathMatches(['示例分类甲'], ['同人']), false);
    assert.equal(tagPathMatches([], ['同人']), false);
    // 空路径 = 根(谁都算)
    assert.equal(tagPathMatches(['示例分类甲'], []), true);
    assert.equal(tagPathMatches([], []), true);
    // 大小写/空白不敏感(标签是文件夹名)
    assert.equal(tagPathMatches(['同人 '], ['同人']), true);
    // 下一级 chips:根 → 顶层文件夹名;选 同人 → 第二级;按条数降序
    const records = [
      { id: '1', tags: ['同人', '手游'] }, { id: '2', tags: ['同人', '手游'] }, { id: '3', tags: ['同人', '动画'] },
      { id: '4', tags: ['示例分类甲'] }, { id: '5', tags: [] },
    ];
    assert.deepEqual(childTagsFor(records, []), [['同人', 3], ['示例分类甲', 1]], '根 = 顶层,计数含整棵子树');
    assert.deepEqual(childTagsFor(records, ['同人']), [['手游', 2], ['动画', 1]], '选 同人 → 第二级');
    assert.deepEqual(childTagsFor(records, ['同人', '手游']), [], '叶子层没有下一级');
    assert.deepEqual(childTagsFor(records, ['示例分类甲']), [], '直接躺在分类里的卡没有下一级');
    assert.deepEqual(childTagsFor(records, [], (r) => (r.id === '4' ? ['同人', '游戏'] : r.tags)), [['同人', 4]],
      '注入 tagsOf(覆盖档合并口径)也要认');
    assert.equal(childTagsFor(records, [], () => [], 12).length, 0, '全无标签时没有 chips');
  });

  test('卡库：索引里只留正文前 INDEX_TEXT_CHARS 字 —— 全文在 full 档案里', () => {
    // ⚠️ 这条判据是**用真现场换来的**：整份正文进索引后 `index.jsonl` 56 MB，
    //    而它每次缓存失效都要在**面板进程主线程**上 JSON.parse 一遍（实测 285 ms，
    //    同进程里还跑着 QQ 收发）。截到 1000 字之后 27 MB / 149 ms。
    const long = '甲'.repeat(3000);
    const parsed = parseCardSync({
      path: 'D:\\cards\\长文卡.png',
      json: {
        spec: 'chara_card_v2',
        data: {
          name: '长文卡', description: long, personality: '', scenario: '', first_mes: long,
          mes_example: '', tags: [], alternate_greetings: [], extensions: {},
        },
      },
      sourceKind: 'json',
    });
    assert.equal(parsed.record.content.description.length, INDEX_TEXT_CHARS, '索引里的正文必须被截');
    assert.equal(parsed.record.content.firstMes.length, INDEX_TEXT_CHARS);
    // **全文不许被截** —— 它才是"真的开一场梦境"要用的东西
    assert.equal(parsed.full.character.description.length, 3000);
    assert.equal(parsed.full.character.firstMes.length, 3000);
    // 短文本原样留着（不许无脑加省略号/填充）
    const short = parseCardSync({
      path: 'D:\\cards\\短卡.png',
      json: { spec: 'chara_card_v2', data: { name: '短卡', description: '就一句', first_mes: '你好', personality: '', scenario: '', mes_example: '', tags: [], alternate_greetings: [], extensions: {} } },
      sourceKind: 'json',
    });
    assert.equal(short.record.content.description, '就一句');
  });

  test('卡库：库版本是 3（正文截断 + digest 字段那一版）—— 变了就要重建，不许"能用就跑"', () => {
    // ⚠️ 形状变了而版本没变 = 增量合并会把旧的胖记录原样留着，报告看着正常、索引还是 56 MB。
    //    `scripts\dream-index.js` 里那条"版本对不上就强制全量重扫"依赖这个常量。
    //    3 = 加 digest(文件 sha256 前 16 位,内容去重判据,1.136.0 / D227 追加十二)。
    assert.equal(INDEX_VERSION, 3);
    assert.equal(indexHeader().version, INDEX_VERSION);
  });

  test('卡库：summarizeLibrary 数字自洽（各类型之和 = 总数）', () => {
    const records = [
      { kind: KIND.character, name: 'a', bytes: 100, book: { entryCount: 3 }, sizes: { firstMes: 5 }, warnings: [] },
      { kind: KIND.worldcard, name: 'b', bytes: 200, book: { entryCount: 7 }, sizes: { firstMes: 0 }, warnings: ['world_shell'] },
      { kind: KIND.character, name: 'a', bytes: 50, book: null, sizes: { firstMes: 0 }, warnings: [] },
    ];
    const stats = summarizeLibrary(records);
    assert.equal(stats.total, 3);
    assert.equal(Object.values(stats.byKind).reduce((a, b) => a + b, 0), 3);
    assert.equal(stats.withBook, 2);
    assert.equal(stats.bookEntries, 10);
    assert.equal(stats.withFirstMes, 1);
    assert.equal(stats.duplicateNames, 1); // 两个 character:a
  });

  // -------------------------------------------------------------------------
  // ⑦ 索引库层
  // -------------------------------------------------------------------------

  test('索引：serializeIndex / parseIndex 往返一致，头行单独认', () => {
    const records = [{ id: 'a', path: 'p', name: 'n', kind: KIND.character, warnings: [] }];
    const text = serializeIndex(records, { generatedAt: '2026-10-13T00:00:00.000Z', roots: ['D:\\cards'] });
    const parsed = parseIndex(text);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].id, 'a');
    assert.equal(parsed.version, indexHeader().version);
    assert.equal(parsed.skipped, 0);
    // 头行没被算成记录
    assert.ok(!parsed.records.some((r) => r.$index === 'header'));
  });

  test('索引：坏行被跳过并计数，**不能让一行坏数据带走整个库**', () => {
    const text = [
      JSON.stringify({ $index: 'header', version: 1 }),
      JSON.stringify({ id: 'good', kind: KIND.character, warnings: [] }),
      '{ 这不是 JSON',
      '',
      'null',
      JSON.stringify({ id: 'good2', kind: KIND.character, warnings: [] }),
    ].join('\n');
    const parsed = parseIndex(text);
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.skipped, 2); // `{ 这不是 JSON` 与 `null`（后者解析出来不是对象）
    assert.equal(parseIndexLine('   '), null);
    assert.equal(parseIndexLine('[]'), null);
  });

  test('索引：mergeRecords 覆盖同 id、保留别的，并数清新增/更新', () => {
    const existing = [
      { id: 'a', name: '旧 A', kind: KIND.character, warnings: [] },
      { id: 'b', name: 'B', kind: KIND.character, warnings: [] },
    ];
    const incoming = [
      { id: 'a', name: '新 A', kind: KIND.character, warnings: [] },
      { id: 'c', name: 'C', kind: KIND.character, warnings: [] },
    ];
    const merged = mergeRecords(existing, incoming);
    assert.equal(merged.records.length, 3);
    assert.equal(recordById(merged.records, 'a').name, '新 A');
    assert.equal(recordById(merged.records, 'b').name, 'B');
    assert.equal(merged.added, 1);
    assert.equal(merged.updated, 1);
    // 增量合并**不许**丢记录（这是它存在的全部理由）
    assert.equal(merged.records.length, new Set(merged.records.map((r) => r.id)).size);
  });

  test('索引：staleCandidates 只挑没见过 / mtime 变了 / 大小变了的', () => {
    const existing = [
      { id: 'a', path: 'D:\\a.png', mtimeMs: 100, bytes: 10 },
      { id: 'b', path: 'D:\\b.png', mtimeMs: 200, bytes: 20 },
    ];
    const stale = staleCandidates(existing, [
      { path: 'D:\\a.png', mtimeMs: 100, size: 10 }, // 没变 → 跳过
      { path: 'D:\\b.png', mtimeMs: 201, size: 20 }, // mtime 变了 → 重扫
      { path: 'D:\\c.png', mtimeMs: 1, size: 1 }, // 新的 → 重扫
    ]);
    assert.deepEqual(stale.map((s) => s.path), ['D:\\b.png', 'D:\\c.png']);
    // mtime 拿不到（stat 失败）时也要重扫，不能因为"不知道变没变"就当成没变
    const stale2 = staleCandidates(existing, [{ path: 'D:\\a.png', mtimeMs: null, size: null }]);
    assert.equal(stale2.length, 0); // 两个都不知道就沿用 —— 这是**刻意的**：宁可漏重扫也不全量重扫
    const stale3 = staleCandidates(existing, [{ path: 'D:\\a.png', mtimeMs: null, size: 11 }]);
    assert.equal(stale3.length, 1); // 大小对不上 → 重扫
  });

  test('索引：queryCards 过滤 + 分页边界', () => {
    const records = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      name: `卡${i}`,
      kind: i % 2 === 0 ? KIND.character : KIND.worldcard,
      tags: i === 0 ? ['示例甲'] : [],
      book: i < 3 ? { entryCount: 5 } : null,
      warnings: [],
      content: {},
    }));
    assert.equal(queryCards(records, {}).total, 7);
    assert.equal(queryCards(records, { kind: KIND.character }).total, 4);
    assert.equal(queryCards(records, { hasBook: true }).total, 3);
    assert.equal(queryCards(records, { tag: '示例甲' }).total, 1);
    const page = queryCards(records, { limit: 3, offset: 3 });
    assert.equal(page.total, 7);
    assert.equal(page.items.length, 3);
    assert.equal(page.items[0].id, 'r3');
    // offset 超出 → 空数组而不是抛
    assert.deepEqual(queryCards(records, { limit: 3, offset: 99 }).items, []);
  });

  test('索引：healthReport 认得出"认不出来的文件"（覆盖率）', () => {
    const records = [{ id: 'a', kind: KIND.character, name: 'a', bytes: 1, book: null, sizes: { firstMes: 1, total: 5 }, warnings: [] }];
    const report = healthReport(records, { filesScanned: 4, unreadable: 3 });
    assert.equal(report.total, 1);
    assert.equal(report.unreadable, 3);
    assert.equal(report.generators, 0);
    assert.ok(report.coverage > 0 && report.coverage <= 100);
  });

  // -------------------------------------------------------------------------
  // ⑧ 合成卡真文件：四类结构全部必跑，不依赖私人卡库或存在性 skip
  // -------------------------------------------------------------------------

  // 保留原边界形状：29 条 = 10 常驻 + 19 键控，包含单字符 key、数字 position/depth。
  const sampleBook = () => ({ name: '示例世界甲', entries: Array.from({ length: 29 }, (_, i) => ({
    uid: i, comment: `示例条目${i}`, content: `合成正文${i}`,
    constant: i < 10, keys: i < 10 ? [] : [i === 10 ? '.' : `demo_key_${i}`],
    position: i < 10 ? 0 : 4, depth: i < 10 ? 0 : 4,
  })) });
  const FILE_FIXTURES = [
    {
      label: '示例世界甲（纯 JSON 世界书）',
      file: '世界书/demo-world-a.json',
      make: () => Buffer.from(JSON.stringify(sampleBook()), 'utf8'),
      sourceKind: 'json',
      check: (parsed) => {
        assert.equal(parsed.record.book.entryCount, 29, '世界书条目数变了');
        assert.equal(parsed.record.book.constantCount, 10, '常驻条目数变了');
        assert.equal(parsed.full.book.entries.length, 29);
        // 键控条目必须是 atDepth(4)、depth 4 —— 这是"位置字段读对了"的判据
        const keyed = parsed.full.book.entries.find((e) => !e.constant);
        assert.equal(keyed.position, POSITION.atDepth);
        assert.equal(keyed.depth, 4);
        // 常驻条目必须是 before(0)
        const constant = parsed.full.book.entries.find((e) => e.constant);
        assert.equal(constant.position, POSITION.before);
        // 荒唐 key（`["."]`）也要被原样读出来，不许被"清洗"掉
        assert.ok(parsed.full.book.entries.some((e) => e.keys.some((k) => k.length <= 1)));
      },
    },
    {
      label: '示例世界乙（卡壳装世界书）',
      file: '世界卡/demo-world-b.png',
      make: () => makePng({ chara: charaOf(sampleCard({
        name: '示例世界乙', description: '合成世界设定。'.repeat(20),
        character_book: { entries: Array.from({ length: 16 }, (_, i) => ({
          comment: `示例条目${i}`, keys: [`demo_key_${i}`], content: `合成正文${i}`, position: 'before_char',
        })) },
      })) }),
      sourceKind: 'png',
      check: (parsed) => {
        assert.equal(parsed.record.name, '示例世界乙');
        assert.equal(parsed.record.book.entryCount, 16);
        assert.equal(parsed.full.book.entries.length, 16);
        assert.ok(parsed.full.character.description.length > 100);
        // 卡壳里的 position 是字符串 `before_char` —— 读错这里会静默错位
        assert.ok(parsed.full.book.entries.some((e) => e.position === POSITION.before));
      },
    },
    {
      label: '示例旁白（角色卡内嵌世界书）',
      file: '角色卡/demo-narrator.png',
      make: () => makePng({ chara: charaOf(sampleCard({
        name: '示例旁白', description: '示例旁白的合成描述。', character_book: sampleBook(),
      })) }),
      sourceKind: 'png',
      check: (parsed) => {
        assert.equal(parsed.record.name, '示例旁白');
        assert.ok(parsed.full.character.description.includes('示例旁白'));
        // 角色卡自带世界观那条路，条目数仍钉死为 29。
        assert.equal(parsed.record.book.entryCount, 29);
      },
    },
    {
      label: '示例工具生成器卡',
      file: '工具/示例人物卡制作器.png',
      make: () => makePng({ chara: charaOf(sampleCard({ name: '示例人物卡制作器' })) }),
      sourceKind: 'png',
      check: (parsed) => {
        assert.equal(parsed.record.kind, KIND.generator);
        assert.ok(parsed.full.character.firstMes.length > 0);
      },
    },
  ];

  for (const item of FILE_FIXTURES) {
    test(`合成文件：${item.label}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-card-file-'));
      try {
        const file = path.join(dir, ...item.file.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, item.make());
        // 仍只传路径，必须走真实磁盘读取，不能用注入 bytes/json 绕过读盘链。
        const parsed = await parseCard({ path: file, sourceKind: item.sourceKind });
        assert.ok(parsed, `解析失败：${item.file}`);
        item.check(parsed);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // -------------------------------------------------------------------------
  // ⑨ CLI 真跑（在夹具上，**不碰真卡库**）
  // -------------------------------------------------------------------------

  /**
   * 为什么这一组值钱：前面那些判据测的都是**函数**，而 CLI 里住着"哪条命令调哪个函数"
   * 那一层接线 —— 而这一层坏掉的时候函数判据**全绿**（这个项目在 `main()` 装配段
   * 吃过的亏不止一次）。
   *
   * ⚠️ 所以它在**临时夹具**上真 spawn 一次 CLI，并用 `--index` 把库指到临时目录 ——
   *    `data\cards\index.jsonl` 是用户那 7000 张卡的真索引，**测试不许碰它**。
   */
  const CLI = fileURLToPath(new URL('./dream-index.js', import.meta.url));

  function makeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cards-'));
    fs.mkdirSync(path.join(dir, '世界书'), { recursive: true });
    // ① 一张正常角色卡
    fs.writeFileSync(path.join(dir, '示例甲.png'), makePng({ chara: charaOf(sampleCard({ name: '示例甲', first_mes: '「我是示例甲。」' })) }));
    // ② 一张"卡壳装世界书"（世界卡目录 + 带世界书 → 走目录判型）
    fs.mkdirSync(path.join(dir, '世界卡'), { recursive: true });
    fs.writeFileSync(path.join(dir, '世界卡', '示例镇.png'), makePng({
      chara: charaOf(sampleCard({
        name: '示例镇',
        first_mes: '你醒了。',
        character_book: { name: '示例镇', entries: Array.from({ length: 8 }, (_, i) => ({ comment: `条${i}`, keys: [`k${i}`], content: `正文${i}` })) },
      })),
    }));
    // ③ 一本纯 JSON 世界书（没有角色正文）
    fs.writeFileSync(path.join(dir, '世界书', '某世界书.json'), JSON.stringify({
      name: '某世界书',
      entries: { 0: { comment: '基调', content: '世界很大', keys: [] } },
    }));
    // ④ 一个根本不是卡的文件（PNG 扩展名 + 垃圾字节）
    fs.writeFileSync(path.join(dir, '坏文件.png'), Buffer.from('this is not a png at all', 'utf8'));
    return dir;
  }

  function runCli(argv) {
    const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', timeout: 60_000 });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  test('CLI：扫夹具 → 三类卡各归各位，坏文件被**报出来**而不是静默丢掉', () => {
    const dir = makeFixture();
    const index = path.join(dir, 'out', 'index.jsonl');
    try {
      const scan = runCli(['scan', '--root', dir, '--index', index, '--write']);
      assert.equal(scan.code, 0, scan.stdout + scan.stderr);
      assert.match(scan.stdout, /总记录\s+3/);
      assert.match(scan.stdout, /character=1/);
      assert.match(scan.stdout, /worldcard=1/);
      assert.match(scan.stdout, /lorebook=1/);
      assert.match(scan.stdout, /认不出来\s+1/);
      // 夹具里**两条**走的是目录判型：`世界卡\示例镇.png` → worldcard、`世界书\某世界书.json` → lorebook
      assert.match(scan.stdout, /目录判型\s+2/);
      // 认不出来的要**分桶**打出来 —— 只给条数的话，"103" 这个数字根本没法解释
      assert.match(scan.stdout, /分桶\s+unknown=1/);

      // 库文件真写出来了，而且**头行**在里面
      assert.ok(fs.existsSync(index));
      const parsed = parseIndex(fs.readFileSync(index, 'utf8'));
      assert.equal(parsed.records.length, 3);
      // ⚠️ 版本按**当版**算（1 → 2 是"正文截到 1000 字"那一版）—— 它变了就说明记录形状变过，
      //    而"形状变了却没升版本"会让增量合并把旧的胖记录留着（见 `scripts\dream-index.js` 那条强制重扫）
      assert.equal(parsed.version, INDEX_VERSION);
      // 完整正文也写出来了（每张一个文件）
      const world = parsed.records.find((r) => r.kind === KIND.worldcard);
      assert.ok(world, '夹具里那张世界卡没进库');
      assert.ok(fs.existsSync(path.join(path.dirname(index), 'full', `${world.id}.json`)));

      // 检索：⚠️ 一个"部分命中"的词 —— 第一版 CLI 的参数解析坏了，
      //    `search 示例甲` 实际搜的是空词、返回**全部**；用"只该命中 1 条"才抓得住它
      const search = runCli(['search', '示例甲', '--index', index]);
      assert.equal(search.code, 0);
      assert.match(search.stdout, /命中 1 条/);
      const all = runCli(['list', '--index', index]);
      assert.match(all.stdout, /命中 3 条/);
      // 看一张
      const show = runCli(['show', '示例甲', '--index', index]);
      assert.match(show.stdout, /示例甲/);
      assert.match(show.stdout, /开场白预览/);
      // 打正文
      const body = runCli(['body', '示例镇', '--index', index]);
      assert.match(body.stdout, /世界书「示例镇」8 条/);
      assert.match(body.stdout, /正文0/);
      // 找不到就说找不到（不猜、不返回别的卡）
      const missing = runCli(['show', '不存在的卡', '--index', index]);
      assert.equal(missing.code, 1);
      assert.match(missing.stdout, /找不到卡/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI：不带 --write 时**只预演**（一个字节都不写）', () => {
    const dir = makeFixture();
    try {
      const target = path.join(dir, 'out', 'index.jsonl');
      const scan = runCli(['scan', '--root', dir, '--index', target]);
      assert.equal(scan.code, 0);
      assert.match(scan.stdout, /预演/);
      assert.ok(!fs.existsSync(target), '预演居然写了文件');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI：根目录不存在时**明说**并退非零（不许静默扫 0 张还报成功）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cards-'));
    try {
      const index = path.join(dir, 'index.jsonl');
      const missing = runCli(['resolve', '--root', path.join(dir, '根本没有这个目录')]);
      assert.equal(missing.code, 1);
      assert.match(missing.stdout, /✘/);
      // 空库时 stats 要指路，而不是回一串零
      const stats = runCli(['stats', '--index', index]);
      assert.equal(stats.code, 1);
      assert.match(stats.stdout, /scan --write/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
