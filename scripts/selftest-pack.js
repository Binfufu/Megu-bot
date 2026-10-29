/**
 * 内容包加载器判据（角色包化）。
 *
 * 跑法：
 *
 *     node scripts/selftest-pack.js
 *
 * 只使用**注入的合成 read/readdir** 与内存里的示例包：不读真实 `content/`、不联网、
 * 不 git、不 spawn、不写任何文件。钉的是加载器的 fail-closed 契约：
 *   ① 合法包按目录发现，`packById` 原样返回（逐字一致，不拷贝/不改写/不重排字段）；
 *   ② 没有 `content/packs/` 目录 → `null`（旧行为：调用方回退旧本地文件）；
 *      权限类读错仍然大声抛错；
 *   ③ 坏 JSON / 缺 pack.json / 坏 schema / id 与目录名不符 / 重复 id / 未知 id → 抛错；
 *      错误信息只含包 id 与错误码，不含绝对路径或包内容片段；
 *   ④ 包内 `companion.art` 只认单层 png/jpg 文件名（不许路径分隔符）；
 *   ⑤ 聚合导出（mood/body、style nudges、story 角色段）形状与既有消费者一致。
 *
 * API 以 `src/content-pack.js` 的实际导出为准；若实现参数名调整，以该文件为准同步本套件。
 *
 * 反证（断言必须真红，改完只留一条即可验证）：
 *   - 把 `readContentPacks` 里 `if (problem) throw ...` 改成静默跳过 → 「坏 schema」用例红；
 *   - 把 `readdir` 的 ENOENT 分支改成返回空结构 → 「缺目录 → null」用例红；
 *   - 把错误信息拼上 `String(url)` → 「坏 JSON 不含路径」用例红；
 *   - 把 `packById` 未知 id 改成返回 `undefined` → 「未知 id 抛错」用例红；
 *   - 把聚合里的 `topicTable` 换成 `topics` → 「聚合形状」用例红。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKS,
  packById,
  packsAsMoodBodyContent,
  packsAsStoryRoleSections,
  packsAsStyleNudges,
  readContentPacks,
  validatePack,
} from '../src/content-pack.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const clone = (value) => JSON.parse(JSON.stringify(value));

/** 合成包根：用自定义 scheme，路径本身就不可能指向本机真实目录。 */
const PACK_ROOT = new URL('fixture://content/packs/');

/** 一个最小但完整的合法包；示例 id/文案均为人工合成，不含任何真实角色内容。 */
function packFixture(overrides = {}) {
  const pack = {
    schemaVersion: 1,
    id: 'example',
    role: { label: '示例角色' },
    themes: { mood: 'example', body: 'example', style: 'example' },
    mood: {
      label: '示例情绪',
      ids: ['calm'],
      topics: ['demo'],
      moods: { calm: { label: '平静', directive: '保持平静。' } },
      topicTable: { demo: { label: '示例话题', keywords: ['示例'] } },
      interjections: { calm: ['示例插话'] },
      kaomoji: [{ text: '(・ω・)', tags: ['示例'] }],
      interjectionTopicGate: { 示例插话: ['demo'] },
    },
    body: {
      label: '示例身体主题',
      values: Object.fromEntries(
        ['satiety', 'health', 'mood', 'stamina', 'mana'].map((key) => [
          key,
          { short: `${key}-短`, long: `${key}-长`, states: ['状态甲', '状态乙'] },
        ]),
      ),
      action: { verb: '示例动作', short: '示例短句', prompt: '示例提示', tag: 'example' },
      growth: { knownAs: '示例甲', conceptAs: '示例乙', personRecorded: '示例丙', conceptRecorded: '示例丁' },
    },
    style: { nudges: ['保持简洁。'] },
    story: {
      pack: { id: 'example', label: '示例故事段' },
      phrases: [{ phrase: '示例短语', note: '示例备注' }],
    },
    companion: null,
    characterDays: [{ month: 1, day: 1, label: '示例纪念日', source: '示例来源' }],
  };
  return Object.assign(pack, overrides);
}

/**
 * 注入式假文件系统：`files` 是 { 目录名: 包对象或原始文本 }。
 * `order` 控制 readdir 返回顺序（用来验证加载器自己会排序），`entries` 塞入非目录项。
 * read 只接受注入根下的 URL；任何真实路径都不可能被它读到。
 */
function fakeContentDir(files, { order = Object.keys(files), entries = [] } = {}) {
  const calls = { readdir: [], read: [] };
  const readdir = (dir, options) => {
    calls.readdir.push({ dir: String(dir), options });
    const dirs = order.map((name) => ({ name, isDirectory: () => true }));
    return [...entries, ...dirs];
  };
  const read = (url, encoding) => {
    const href = String(url);
    calls.read.push({ href, encoding });
    const found = /\/packs\/([^/]+)\/pack\.json$/.exec(href);
    const name = found ? decodeURIComponent(found[1]) : '';
    if (!Object.hasOwn(files, name)) {
      const error = new Error(`ENOENT: ${href}`);
      error.code = 'ENOENT';
      throw error;
    }
    const value = files[name];
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return { dir: PACK_ROOT, read, readdir, calls };
}

function capture(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return assert.fail('预期抛错，但没有抛');
}

/** 错误信息不许带盘符绝对路径、注入 URL 或包内文案（只允许包 id 与错误码）。 */
function assertNoPayloadLeak(message) {
  assert.doesNotMatch(message, /[A-Za-z]:[\\/]/, `错误信息不应含绝对路径：${message}`);
  assert.doesNotMatch(message, /fixture:\/\//, `错误信息不应含注入 URL：${message}`);
  assert.doesNotMatch(message, /示例角色|示例情绪|示例插话/, `错误信息不应含包内容：${message}`);
}

// ---------------------------------------------------------------------------
// ① 合法包 / 发现规则
// ---------------------------------------------------------------------------

test('content-pack:合法合成包按目录发现，packById 原样返回（逐字一致）', () => {
  const pack = packFixture();
  assert.equal(validatePack(pack), null, '合成包本身必须是合法 schema');
  const io = fakeContentDir({ example: pack });
  const packs = readContentPacks(io);

  assert.equal(packs.schemaVersion, 1);
  assert.deepEqual(packs.ids, ['example']);
  assert.deepEqual(packs.packs.example, pack, '包内容逐字一致，不裁剪/不改写/不重排字段');
  assert.deepEqual(packById('example', packs), pack, 'packById 返回原值（字段逐字一致）');
  assert.equal(typeof packById('example', packs), 'object', '返回包对象而不是 id/布尔值');
  assert.equal(io.calls.readdir.length, 1, '目录发现只调用注入 readdir 一次');
  assert.equal(io.calls.read.length, 1, '每个包只调用注入 read 一次');
});

test('content-pack:只发现目录、忽略点目录与普通文件，并按目录名排序', () => {
  const io = fakeContentDir(
    { a: packFixture({ id: 'a' }), b: packFixture({ id: 'b' }) },
    {
      order: ['b', '.hidden', 'a'],
      entries: [{ name: 'README.md', isDirectory: () => false }],
    },
  );
  const packs = readContentPacks(io);
  assert.deepEqual(packs.ids, ['a', 'b'], '按目录名排序；点目录与普通文件不参与发现');
  assert.equal(io.calls.read.length, 2, '只读取两个真实包的 pack.json');
});

// ---------------------------------------------------------------------------
// ② 没有 content/packs 目录 = 旧行为
// ---------------------------------------------------------------------------

test('content-pack:没有 content/packs 目录 → null；权限类读错仍抛错且不含路径', () => {
  const enoent = () => {
    const error = new Error('ENOENT: fixture://content/packs/');
    error.code = 'ENOENT';
    throw error;
  };
  assert.equal(readContentPacks({ dir: PACK_ROOT, read: enoent, readdir: enoent }), null,
    '缺目录返回 null，调用方才能回退旧本地文件');
  assert.ok(
    PACKS === null || (PACKS.schemaVersion === 1 && Array.isArray(PACKS.ids)),
    '模块级 PACKS 只允许 null（公开集）或合法聚合（维护仓）',
  );

  const denied = () => {
    const error = new Error('EACCES: fixture://content/packs/');
    error.code = 'EACCES';
    throw error;
  };
  const error = capture(() => readContentPacks({ dir: PACK_ROOT, read: denied, readdir: denied }));
  assert.match(error.message, /EACCES/, '权限错不是"缺目录"，必须大声失败');
  assertNoPayloadLeak(error.message);
});

// ---------------------------------------------------------------------------
// ③ 坏 JSON / 缺文件 / 坏 schema / id 问题
// ---------------------------------------------------------------------------

test('content-pack:坏 JSON → invalid-json，错误信息不含绝对路径/内容片段', () => {
  const error = capture(() => readContentPacks(fakeContentDir({ example: '{ "schemaVersion": 1, 这不是 JSON' })));
  assert.match(error.message, /invalid-json/);
  assertNoPayloadLeak(error.message);
  assert.doesNotMatch(error.message, /schemaVersion/, '错误信息不应回显原始 JSON 片段');
});

test('content-pack:目录存在但缺 pack.json → missing-pack-file（不静默跳过该包）', () => {
  const error = capture(() => readContentPacks(fakeContentDir({}, { order: ['example'] })));
  assert.match(error.message, /missing-pack-file/);
  assertNoPayloadLeak(error.message);
});

test('content-pack:坏 schema（缺字段/多余字段/版本/id）→ 抛错，只含包 id 与错误码', () => {
  const mutations = [
    [(p) => { delete p.style; }, /: schema$/],
    [(p) => { p.extra = true; }, /: schema$/],
    [(p) => { p.schemaVersion = 2; }, /: schema-version$/],
    [(p) => { p.id = 'Example With Space'; }, /: id$/],
  ];
  for (const [mutate, expected] of mutations) {
    const pack = clone(packFixture());
    mutate(pack);
    assert.equal(validatePack(pack) !== null, true, `坏 schema 必须被 validatePack 拒绝：${mutate}`);
    const error = capture(() => readContentPacks(fakeContentDir({ example: pack })));
    assert.match(error.message, expected);
    assert.match(error.message, /^content pack "example": /, '只带包 id 与错误码');
    assertNoPayloadLeak(error.message);
  }
});

test('content-pack:mood 键集合不一致（ids/moods/topics/topicTable/interjections/gate）→ mood', () => {
  const mutations = [
    (p) => { delete p.mood.moods.calm; },
    (p) => { p.mood.moods.extra = { label: '多余', directive: '多余' }; },
    (p) => { delete p.mood.topicTable.demo; },
    (p) => { p.mood.topicTable.extra = { label: '多余', keywords: ['示例'] }; },
    (p) => { delete p.mood.interjections.calm; },
    (p) => { p.mood.ids.push('calm'); },
    (p) => { p.mood.topics.push('demo'); },
    (p) => { p.mood.interjectionTopicGate['示例插话'] = ['unknown-topic']; },
    (p) => { p.mood.interjectionTopicGate['不存在的插话'] = ['demo']; },
    (p) => { p.mood.kaomoji = []; },
  ];
  for (const mutate of mutations) {
    const pack = clone(packFixture());
    mutate(pack);
    assert.equal(validatePack(pack), 'mood', mutate.toString());
  }
});

test('content-pack:body/style/story/companion/characterDays 结构错 → 对应错误码', () => {
  const withCompanion = clone(packFixture());
  withCompanion.companion = {
    id: 'example', name: '示例', fullName: '示例角色', theme: 'example',
    bot: 'example', stateDir: 'example', art: 'example.png', blurb: '示例说明',
  };
  assert.equal(validatePack(withCompanion), null, '合法 companion 必须通过');

  const mutations = [
    ['body', (p) => { delete p.body.values.mana; }],
    ['body', (p) => { p.body.action.extra = 'x'; }],
    ['body', (p) => { p.body.values.mood.states = []; }],
    ['style', (p) => { p.style.nudges = []; }],
    ['story', (p) => { delete p.story.pack.label; }],
    ['story', (p) => { p.story.pack.events = []; }],
    ['story', (p) => { p.story.phrases = [{ phrase: '只有短语' }]; }],
    ['companion', (p) => { p.companion = { ...withCompanion.companion, theme: 'other' }; }],
    ['companion', (p) => { p.companion = { ...withCompanion.companion, art: '../example.png' }; }],
    ['companion', (p) => { p.companion = { ...withCompanion.companion, art: 'sub/example.png' }; }],
    ['characterDays', (p) => { p.characterDays = [{ month: 13, day: 1, label: '示例', source: '示例' }]; }],
  ];
  for (const [code, mutate] of mutations) {
    const pack = clone(packFixture());
    mutate(pack);
    assert.equal(validatePack(pack), code, mutate.toString());
  }
});

test('content-pack:id 与目录名不符 / 同一 id 出现两次 → 抛错', () => {
  const mismatch = capture(() => readContentPacks(fakeContentDir({ other: packFixture() })));
  assert.match(mismatch.message, /id-mismatch/, '包 id 必须等于目录名');

  const duplicate = capture(() => readContentPacks(
    fakeContentDir({ example: packFixture() }, { order: ['example', 'example'] }),
  ));
  assert.match(duplicate.message, /duplicate-id/, '重复目录名/重复 id 必须抛错而不是后者覆盖前者');
});

test('content-pack:未知 id / 未加载 → 抛错，不返回 undefined', () => {
  const packs = readContentPacks(fakeContentDir({ example: packFixture() }));
  assert.match(capture(() => packById('no-such-pack', packs)).message, /unknown-id/);
  assert.match(capture(() => packById('example', null)).message, /no-packs-loaded/);
  const fallback = capture(() => packById('no-such-pack'));
  assert.match(fallback.message, /unknown-id|no-packs-loaded/,
    '默认 PACKS：公开集为 null，维护仓为真实包；两种情况都必须大声失败');
});

// ---------------------------------------------------------------------------
// ④ 聚合导出 / 注入边界
// ---------------------------------------------------------------------------

test('content-pack:聚合形状与既有消费者一致（mood/body/style/story 角色段）', () => {
  const pack = packFixture();
  const packs = readContentPacks(fakeContentDir({ example: pack }));

  assert.deepEqual(packsAsMoodBodyContent(packs), {
    mood: {
      example: {
        label: pack.mood.label,
        moods: pack.mood.moods,
        topics: pack.mood.topicTable,
        interjections: pack.mood.interjections,
        kaomoji: pack.mood.kaomoji,
        interjectionTopicGate: pack.mood.interjectionTopicGate,
      },
    },
    body: { example: pack.body },
  });
  assert.deepEqual(packsAsStyleNudges(packs), { styleNudges: { example: pack.style.nudges } });
  assert.deepEqual(packsAsStoryRoleSections(packs), {
    storyPacks: { example: pack.story.pack },
    companionsById: {},
    characterDays: { example: pack.characterDays },
    phrasesByRole: { example: pack.story.phrases },
  });
  assert.equal(packsAsMoodBodyContent(null), null);
  assert.equal(packsAsStyleNudges(null), null);
  assert.equal(packsAsStoryRoleSections(null), null);
});

test('content-pack:只经注入 read/readdir 取数，不触碰真实 content/、不联网、不 spawn', () => {
  const io = fakeContentDir({ example: packFixture() });
  const packs = readContentPacks(io);
  assert.equal(io.calls.readdir.length, 1, '目录发现只能走注入 readdir');
  assert.equal(io.calls.read.length, 1, '包读取只能走注入 read');
  assert.ok(
    io.calls.read.every(({ href }) => href.startsWith('fixture://content/packs/')),
    '读取目标必须是注入的合成根，不能落到真实盘路径',
  );
  assert.equal(packs.packs.example.id, 'example');
});

export function registerPackTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerPackTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  console.log('[selftest-pack] 只跑合成夹具：不读真实 content/、不联网、不 git、不 spawn');
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`❌ ${name}`);
      console.error(error?.stack ?? error);
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
