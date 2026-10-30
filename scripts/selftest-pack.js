/**
 * 内容包加载器判据（角色包化）。
 *
 * 跑法：
 *
 *     node scripts/selftest-pack.js
 *
 * 只使用**注入的合成 read/readdir** 与内存里的示例包：不联网、不 git、不 spawn、不写任何文件。
 * 模块级的 `PACKS`（内容包加载器）与 `src/explosion.js` 导入会读本仓固定 content 路径；
 * 公开集没有这些目录/文件时分别是 `null` 与中性默认，不依赖私有内容也能跑。
 * 钉的是加载器与触发词的 fail-closed / 行为不变契约：
 *   ① 合法包按目录发现，`packById` 原样返回（逐字一致，不拷贝/不改写/不重排字段）；
 *   ② 没有 `content/packs/` 目录 → `null`（旧行为：调用方回退旧本地文件）；
 *      权限类读错仍然大声抛错；
 *   ③ 坏 JSON / 缺 pack.json / 坏 schema / id 与目录名不符 / 重复 id / 未知 id → 抛错；
 *      错误信息只含包 id 与错误码，不含绝对路径或包内容片段；
 *   ④ 包内 `companion.art` 只认单层 png/jpg 文件名（不许路径分隔符）；
 *   ⑤ 聚合导出（mood/body、style nudges、story 角色段、技能触发词）形状与既有消费者一致；
 *   ⑥ 可选 `skill` 段（技能触发词内容外提）：合法绿、坏形状 fail closed；
 *   ⑦ 触发词行为不变：公开集默认词表只含中性通用词（冻结摘要），官方安装生效并集由
 *      两个角色包的 `skill` 段恢复成改造前那组词（冻结摘要），正则由字面词表生成；
 *   ⑧ 可选 `order` 段：合法绿、坏形状 fail closed；聚合导出按 (order ?? 最大, id) 排序，
 *      官方安装聚合键序保持 megumin→aris（`PACKS.ids` 本身仍是目录序）。
 *
 * API 以 `src/content-pack.js` / `src/explosion.js` 的实际导出为准；若实现参数名调整，以这两个文件为准同步本套件。
 *
 * 反证（断言必须真红，改完只留一条即可验证）：
 *   - 把 `readContentPacks` 里 `if (problem) throw ...` 改成静默跳过 → 「坏 schema」用例红；
 *   - 把 `readdir` 的 ENOENT 分支改成返回空结构 → 「缺目录 → null」用例红；
 *   - 把错误信息拼上 `String(url)` → 「坏 JSON 不含路径」用例红；
 *   - 把 `packById` 未知 id 改成返回 `undefined` → 「未知 id 抛错」用例红；
 *   - 把聚合里的 `topicTable` 换成 `topics` → 「聚合形状」用例红；
 *   - 删掉 `validatePack` 的 `skill` 校验 → 「skill 坏形状」用例红；
 *   - 往 `NEUTRAL_TRIGGER_WORDS` 塞一个作品专属词 → 「公开集默认词表冻结摘要」用例红；
 *   - 把官方包 `skill` 段去掉/改词 → 「官方安装生效并集冻结摘要」用例红；
 *   - 在 `src/explosion.js` 里硬编码官方包声明词 → 「专属词不出现在公开源码」用例红；
 *   - 删掉 `validatePack` 的 `order` 校验 → 「order 坏形状」用例红；
 *   - 把聚合循环从 `orderedPackIds()` 改回 `packs.ids` → 「官方安装聚合键序」用例红。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKS,
  packById,
  packParamsForTheme,
  packsAsMoodBodyContent,
  packsAsSkillTriggerWords,
  packsAsStoryRoleSections,
  packsAsStyleNudges,
  readContentPacks,
  validatePack,
} from '../src/content-pack.js';
import {
  NEUTRAL_TRIGGER_WORDS,
  explosionTriggerSource,
  explosionTriggerWords,
  isExplosionRequest,
} from '../src/explosion.js';

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

test('content-pack:可选参数段合法绿，每个白名单类型/边界非法红', () => {
  const good = {
    QQBOT_MOOD_TTL_MS: 1, QQBOT_MOOD_KAOMOJI_CHANCE: 0,
    QQBOT_STYLE_NUDGES: 0, QQBOT_SPOKEN_MAX_CHARS: 0,
    QQBOT_SPOKEN_EMOJI_CHANCE: 1, QQBOT_POKE_REPLY_CHANCE: 1,
    QQBOT_FACE_REPLY_CHANCE: 0,
  };
  const pack = packFixture({ params: good });
  assert.equal(validatePack(pack), null);
  const loaded = readContentPacks(fakeContentDir({ example: pack }));
  assert.deepEqual(packParamsForTheme('example', loaded), good);
  for (const key of Object.keys(good)) {
    for (const invalid of [true, null, {}, [], 'not-a-number', Infinity, -1]) {
      assert.equal(validatePack(packFixture({ params: { [key]: invalid } })), 'params', key);
    }
  }
  assert.equal(validatePack(packFixture({ params: { QQBOT_MOOD_TTL_MS: 0 } })), 'params');
  assert.equal(validatePack(packFixture({ params: { QQBOT_STYLE_NUDGES: 1.5 } })), 'params');
  assert.equal(validatePack(packFixture({ params: { QQBOT_POKE_REPLY_CHANCE: 1.01 } })), 'params');
});

test('content-pack:未知/敏感/部署参数禁止进入包，错误不回显秘密值', () => {
  for (const key of ['QQBOT_LLM_KEY', 'QQ_CLIENT_SECRET', 'QQBOT_STATE_DB', 'QQBOT_TOOLS', 'QQBOT_SEARCH_DAILY_LIMIT_CNY', 'QQBOT_MOOD_TLL_MS']) {
    const pack = packFixture({ params: { [key]: 'synthetic-hidden-secret' } });
    assert.equal(validatePack(pack), 'params');
    const error = capture(() => readContentPacks(fakeContentDir({ example: pack })));
    assert.match(error.message, /: params$/);
    assert.doesNotMatch(error.message, /synthetic-hidden-secret|QQBOT_|QQ_CLIENT/);
  }
  for (const value of [null, [], 1, 'text']) assert.equal(validatePack(packFixture({ params: value })), 'params');
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(validatePack(packFixture({ params: polluted })), 'params');
  assert.equal({}.polluted, undefined);
});

test('content-pack:无参数段/无匹配/无目录保持空来源，不改变原聚合', () => {
  const pack = packFixture();
  const loaded = readContentPacks(fakeContentDir({ example: pack }));
  assert.deepEqual(packParamsForTheme('example', loaded), {});
  assert.deepEqual(packParamsForTheme('missing', loaded), {});
  assert.deepEqual(packParamsForTheme('example', null), {});
  const tuned = readContentPacks(fakeContentDir({ example: packFixture({ params: { QQBOT_STYLE_NUDGES: 2 } }) }));
  assert.deepEqual(packsAsMoodBodyContent(tuned), packsAsMoodBodyContent(loaded));
  assert.deepEqual(packsAsStyleNudges(tuned), packsAsStyleNudges(loaded));
  assert.deepEqual(packsAsStoryRoleSections(tuned), packsAsStoryRoleSections(loaded));
});

test('content-pack:多个参数包命中同一主题必须红，不按目录顺序静默选一个', () => {
  const a = packFixture({ id: 'a', params: { QQBOT_STYLE_NUDGES: 1 } });
  const b = packFixture({ id: 'b', params: { QQBOT_STYLE_NUDGES: 2 } });
  const loaded = readContentPacks(fakeContentDir({ a, b }));
  assert.throws(() => packParamsForTheme('example', loaded), /ambiguous-params-theme/);
  assert.deepEqual(packParamsForTheme('example', readContentPacks(fakeContentDir({ a }))), a.params);
});

// ---------------------------------------------------------------------------
// ⑤ 可选 `skill` 段（技能触发词内容外提）
// ---------------------------------------------------------------------------

test('content-pack:可选 skill 段合法绿、逐字保留；无 skill 段保持旧行为', () => {
  const skill = { triggerWords: ['演示技能', '演示咒文'] };
  const pack = packFixture({ skill });
  assert.equal(validatePack(pack), null, '合法 skill 段必须通过');
  assert.equal(validatePack(packFixture()), null, '没有 skill 段仍是合法包（旧包兼容）');
  const loaded = readContentPacks(fakeContentDir({ example: pack }));
  assert.deepEqual(packById('example', loaded).skill, skill, 'skill 段逐字保留（不裁剪/不改写）');
  assert.deepEqual(packsAsSkillTriggerWords(loaded), ['演示技能', '演示咒文']);
  assert.deepEqual(packsAsSkillTriggerWords(null), [], '公开集（无包）→ 空数组');
});

test('content-pack:skill 坏形状 fail closed，错误只含包 id 与固定码', () => {
  const BAD_WORD = '隐形触发词';
  const badShapes = [
    null, true, 1, 'triggerWords', [],
    {}, { triggerWords: [] }, { triggerWords: [''] }, { triggerWords: ['   '] },
    { triggerWords: '演示技能' }, { triggerWords: [1] },
    { triggerWords: [BAD_WORD, BAD_WORD] },
    { triggerWords: [BAD_WORD], extra: true },
    { extra: true },
    { triggerWords: [`${BAD_WORD}\u0000`] },
    { triggerWords: [`${BAD_WORD}\n`] },
    { triggerWords: [`${BAD_WORD}\u007f`] },
  ];
  for (const skillValue of badShapes) {
    const mutated = packFixture({ skill: skillValue });
    assert.equal(validatePack(mutated), 'skill', `坏 skill 必须被 validatePack 拒绝：${JSON.stringify(skillValue)}`);
    const error = capture(() => readContentPacks(fakeContentDir({ example: mutated })));
    assert.match(error.message, /^content pack "example": skill$/, '错误只带包 id 与错误码');
    assertNoPayloadLeak(error.message);
    assert.doesNotMatch(error.message, new RegExp(BAD_WORD), '错误不回显触发词内容');
  }
});

test('content-pack:skill 触发词聚合按聚合展示顺序去重，无 skill 段不贡献', () => {
  const a = packFixture({ id: 'a', skill: { triggerWords: ['甲词', '共用词'] } });
  const b = packFixture({ id: 'b', skill: { triggerWords: ['共用词', '乙词'] } });
  const c = packFixture({ id: 'c' });
  const packs = readContentPacks(fakeContentDir({ a, b, c }));
  assert.deepEqual(packsAsSkillTriggerWords(packs), ['甲词', '共用词', '乙词']);
  assert.deepEqual(packsAsSkillTriggerWords(readContentPacks(fakeContentDir({ c }))), []);
});

// ---------------------------------------------------------------------------
// ⑤b 可选 `order` 段（聚合展示顺序）
// ---------------------------------------------------------------------------

test('content-pack:可选 order 合法绿（非负安全整数），坏形状 fail closed', () => {
  for (const order of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
    const pack = packFixture({ order });
    assert.equal(validatePack(pack), null, `合法 order 必须通过：${order}`);
    const loaded = readContentPacks(fakeContentDir({ example: pack }));
    assert.equal(packById('example', loaded).order, order, 'order 原样保留');
  }
  const badOrders = [-1, -0.5, 1.5, '1', Number.NaN, Infinity, -Infinity, true, null, [], {},
    Number.MAX_SAFE_INTEGER + 1];
  for (const order of badOrders) {
    const mutated = packFixture({ order });
    assert.equal(validatePack(mutated), 'order', `坏 order 必须被 validatePack 拒绝：${String(order)}`);
    const error = capture(() => readContentPacks(fakeContentDir({ example: mutated })));
    assert.match(error.message, /^content pack "example": order$/, '错误只带包 id 与错误码');
    assertNoPayloadLeak(error.message);
  }
});

test('content-pack:聚合按 (order ?? 最大, id) 排序；无 order 按 id 保持旧逻辑', () => {
  const themed = (id, order) => packFixture({
    id,
    ...(order === undefined ? {} : { order }),
    themes: { mood: `${id}-mood`, body: `${id}-body`, style: `${id}-style` },
    story: { pack: { id: `${id}-story`, label: `${id} 故事段` }, phrases: [] },
  });
  // order 压过 id：id 升序本是 a,b，但 order 让 b 先
  const ordered = readContentPacks(fakeContentDir({ a: themed('a', 2), b: themed('b', 1) }));
  assert.deepEqual(ordered.ids, ['a', 'b'], 'PACKS.ids 保持目录/发现序，不被 order 改写');
  const moodBody = packsAsMoodBodyContent(ordered);
  assert.deepEqual(Object.keys(moodBody.mood), ['b-mood', 'a-mood']);
  assert.deepEqual(Object.keys(moodBody.body), ['b-body', 'a-body']);
  assert.deepEqual(Object.keys(packsAsStyleNudges(ordered).styleNudges), ['b-style', 'a-style']);
  assert.deepEqual(packsAsSkillTriggerWords(ordered), [], '没有 skill 段的包不贡献触发词');
  const story = packsAsStoryRoleSections(ordered);
  for (const section of [story.storyPacks, story.characterDays, story.phrasesByRole]) {
    assert.deepEqual(Object.keys(section), ['b', 'a']);
  }
  // 无 order → 旧逻辑（按包 id 升序 = 原目录发现序）
  const plain = readContentPacks(fakeContentDir({ a: themed('a'), b: themed('b') }));
  assert.deepEqual(Object.keys(packsAsMoodBodyContent(plain).mood), ['a-mood', 'b-mood']);
  assert.deepEqual(Object.keys(packsAsStyleNudges(plain).styleNudges), ['a-style', 'b-style']);
  // 重复 order → 包 id 稳定兜底
  const tied = readContentPacks(fakeContentDir({ a: themed('a', 1), b: themed('b', 1) }));
  assert.deepEqual(Object.keys(packsAsMoodBodyContent(tied).mood), ['a-mood', 'b-mood']);
});

test('content-pack:官方安装聚合键序 = megumin→aris（旧展示序），PACKS.ids 保持目录序', () => {
  if (PACKS === null) return; // 公开集没有官方包
  assert.deepEqual(PACKS.ids, ['aris', 'megumin'], 'PACKS.ids 仍是目录发现序（既有消费者依赖）');
  const moodBody = packsAsMoodBodyContent();
  assert.deepEqual(Object.keys(moodBody.mood), ['megumin', 'aris'], '情绪主题键序：megumin 先');
  assert.deepEqual(Object.keys(moodBody.body), ['megumin', 'aris'], '身体主题键序：megumin 先');
  assert.deepEqual(Object.keys(packsAsStyleNudges().styleNudges), ['megumin', 'aris']);
  const story = packsAsStoryRoleSections();
  assert.deepEqual(Object.keys(story.storyPacks), ['megumin', 'aris']);
  assert.deepEqual(Object.keys(story.companionsById), ['megumin', 'aris']);
  assert.deepEqual(Object.keys(story.characterDays), ['megumin', 'aris']);
  assert.deepEqual(Object.keys(story.phrasesByRole), ['megumin', 'aris']);
});

// ---------------------------------------------------------------------------
// ⑥ 触发词：公开集默认（中性）与官方安装（行为不变）
// ---------------------------------------------------------------------------

const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** 冻结词表摘要：词按 UTF-16 排序后以 `\n` 连接再取 sha256（与词序无关）。 */
const wordsDigest = (words) => sha256Text([...words].sort().join('\n'));
/**
 * 改造前冻结：公开集默认词表=只含中性通用词；官方安装生效并集=原硬编码集合。
 * 公开文件不写作品专属词字面量；快照摘要就是"加/删/换任何一个词必红"的锚点。
 */
const FROZEN_NEUTRAL_TRIGGER_SHA256 = '96a669af16390b77a4cf8878cd9abb90532181037b35f311725ca4903241a0d8';
const FROZEN_OFFICIAL_TRIGGER_SHA256 = 'ed4a60e4b281a367f287aad29a7d6336507e6efb31e5bb52e18205326b48e8e8';
const canonicalTriggerSource = (words) => `(${words.map((word) => String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;

test('技能触发词:公开集默认只有中性通用词（冻结摘要），加专属词必红', () => {
  assert.deepEqual([...NEUTRAL_TRIGGER_WORDS], ['来一发', '放一个', '咏唱', '念咒', '咒文'],
    '中性默认词表逐字冻结（公开可直接运行）');
  assert.equal(wordsDigest(NEUTRAL_TRIGGER_WORDS), FROZEN_NEUTRAL_TRIGGER_SHA256,
    '默认词表摘要冻结：新增/删改任何一个词都会红');
  assert.equal(wordsDigest(explosionTriggerWords(null)), FROZEN_NEUTRAL_TRIGGER_SHA256,
    '无内容包（公开集）时生效词表只剩中性默认词');
  for (const word of NEUTRAL_TRIGGER_WORDS) {
    assert.equal(isExplosionRequest(`请${word}试试`), true, `中性词必须命中：${word}`);
    assert.equal(isExplosionRequest(word), true, `中性词单独出现必须命中：${word}`);
  }
  assert.equal(isExplosionRequest('今天天气不错'), false, '随便一句不许炸');
});

test('技能触发词:生效正则由字面词表生成且大小写不敏感（无隐藏词）', () => {
  const effective = explosionTriggerWords();
  assert.equal(explosionTriggerSource(), canonicalTriggerSource(effective),
    '正则源码必须恰好等于字面词表生成的并集：直接往正则里塞词会红');
  for (const word of effective) {
    if (!/[A-Za-z]/.test(word)) continue;
    assert.equal(isExplosionRequest(word.toUpperCase()), true, `大写变体必须命中：${word.toUpperCase()}`);
    assert.equal(isExplosionRequest(word.toLowerCase()), true, `小写变体必须命中：${word.toLowerCase()}`);
  }
});

test('技能触发词:官方安装生效并集等于改造前硬编码集合（冻结摘要）', () => {
  if (PACKS === null) return; // 公开集没有官方包：上一条默认词表判据覆盖公开行为
  assert.equal(wordsDigest(explosionTriggerWords()), FROZEN_OFFICIAL_TRIGGER_SHA256,
    '官方安装生效并集必须逐字等于改造前那组词（由两个角色包 skill 段提供）');
  const declared = packsAsSkillTriggerWords();
  assert.ok(declared.length > 0, '官方安装的角色包必须声明 skill.triggerWords');
  const matrix = [];
  for (const word of declared) {
    matrix.push([word, true], [`请${word}吧`, true], [`不要${word}`, true]);
    if (/[A-Za-z]/.test(word)) matrix.push([word.toUpperCase(), true], [word.toLowerCase(), true]);
  }
  for (const word of NEUTRAL_TRIGGER_WORDS) matrix.push([word, true]);
  matrix.push(['今天天气不错', false], ['', false], [null, false], [0, false]);
  for (const [input, expected] of matrix) {
    assert.equal(isExplosionRequest(input), expected, `冻结矩阵不一致：${JSON.stringify(input)}`);
  }
});

test('技能触发词:作品专属词不出现在公开源码/默认词表（官方安装按包内容反证）', () => {
  const source = readFileSync(new URL('../src/explosion.js', import.meta.url), 'utf8');
  if (PACKS === null) return; // 公开集无官方包可反证；默认词表摘要已在上方钉住
  // ⚠️ `GAMEPLAY_CONTENT.explosion` 这类标识符合法（ASCII 词不能按 includes 扫）；
  //    对 ASCII 词只查字符串字面量，对非 ASCII 词（不可能是标识符）直接查整份源码。
  const quotedStrings = [...source.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)]
    .flatMap((match) => [match[1], match[2]])
    .filter((text) => typeof text === 'string');
  for (const word of packsAsSkillTriggerWords()) {
    assert.equal(quotedStrings.some((text) => text.includes(word)), false,
      `src/explosion.js 的字符串字面量不得含角色包声明词：${word}`);
    if (!/^[\x00-\x7f]*$/.test(word)) {
      assert.equal(source.includes(word), false, `src/explosion.js 不得硬编码角色包声明词：${word}`);
    }
    for (const neutral of NEUTRAL_TRIGGER_WORDS) {
      assert.equal(neutral.includes(word) || word.includes(neutral), false,
        `中性默认词表不得包含角色包声明词：${word}`);
    }
  }
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
  console.log('[selftest-pack] 合成夹具为主；包/触发词读本仓固定 content 路径（公开集为中性/空），不联网、不 git、不 spawn');
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
