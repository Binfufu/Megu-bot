/**
 * 世界包加载器判据（阶段 4 世界包化）。
 *
 * 跑法：
 *
 *     node scripts/selftest-world-pack.js
 *
 * 只使用**注入的合成 read/readdir/env** 与内存里的示例世界包：不读真实 `content/worlds/`
 * 做契约验证、不联网、不 git、不 spawn、不写任何文件（真实示例包只在最后一条做只读校验）。
 * 钉的是加载器的 fail-closed 契约：
 *   ① 合法包按目录发现，`worldById` 原样返回（逐字一致，不拷贝/不改写/不重排字段）；
 *   ② 没有 `content/worlds/` 目录 → `null`（旧安装行为），权限类读错仍然大声抛错；
 *   ③ 坏 JSON / 缺 world.json / 坏 schema / 未知版本 / id 与目录名不符 / 未知字段 /
 *      非法 params / 重复 id → 抛错；错误信息只含包 id 与错误码，不含绝对路径、
 *      注入 URL、内容片段或解析器消息；
 *   ④ 激活规则固定：`QQBOT_WORLD` > 唯一 `default:true` > null；多个 default 与未知
 *      env id 大声失败；空字符串视为未设置；
 *   ⑤ 三个世界段聚合形状满足既有消费者，且逐字等于包内对应段；
 *   ⑥ `storyWorld.moduleText` 的 `burst` / `cook` 必须带非空 `note`（消费者
 *      `src/character-tuning.js` 直接读它），其余 8 项只认 `name`；
 *   ⑦ 真实示例包 `content/worlds/example/world.json` 存在时通过校验（缺失时如实跳过）。
 *
 * 反证（断言必须真红，改完只留一条即可验证）：
 *   - 把 `if (problem) throw ...` 改成静默跳过 → 「坏 schema」用例红；
 *   - 把 readdir 的 ENOENT 分支改成返回空数组 → 「缺目录 → null」用例红；
 *   - 把错误信息拼上 `String(url)` → 「坏 JSON 不含路径」用例红；
 *   - 把 `defaults.length > 1` 的判断删掉 → 「多 default 红」用例红；
 *   - 把 `worldById` 未知 id 改成返回 `undefined` → 「未知 id 抛错」用例红；
 *   - 把聚合里 15 个世界键换成别的形状 → 「聚合形状」用例红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORLD_PACKS,
  activeWorldParams,
  readWorldPacks,
  validateWorldPack,
  worldAsMoodBodySections,
  worldAsStoryWorldSections,
  worldAsTurnSections,
  worldById,
  worldPackSummary,
} from '../src/world-pack.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const clone = (value) => JSON.parse(JSON.stringify(value));

/** 合成世界包根：用自定义 scheme，路径本身就不可能指向本机真实目录。 */
const WORLD_ROOT = new URL('fixture://content/worlds/');

/** 旧快照 15 个世界段的键（独立字面量：判据不喂实现）。 */
const STORY_KEYS = [
  'storyEvents', 'storyClosingWords', 'storyClosingExamples', 'storyRespondClosing',
  'storySettleClosing', 'places', 'worldText', 'moduleText', 'chronicleKinds', 'eventLabels',
  'chronicleText', 'commandEffects', 'cardClaimNotes', 'keywordGroups', 'opsEffects',
];
const PLACES = ['home', 'fishing', 'guild', 'canteen', 'market', 'gallery'];
const MODULES = ['burst', 'sword', 'scout', 'talk', 'cook', 'fish', 'slow', 'weak', 'clumsy', 'nosy'];
const KINDS = ['meal', 'fed', 'selfcare', 'event', 'story', 'quest', 'fish', 'sell', 'home',
  'potion', 'sleep', 'move', 'illness', 'heal'];
const LABELS = ['found_coin', 'someone_treats', 'sold_loot', 'bought_staff', 'tax', 'lost_pouch', 'donated'];
const COMMANDS = ['/重置', '/状态', '/成长', '/钱包', '/熟人', '/钓鱼', '/委托', '/接 <编号>', '/help',
  '/重启', '/更新', '/发', '/更新 预览', '/更新 账本', '/更新 回退', '/更新 基线 <版本>', '/更新 <编号>',
  '/群列表', '/忘了', '/旁白测试', '/发图', '发N张<角色>美图/涩图', '/认人', '/绑定'];
const CLAIMS = ['/状态', '/钱包', '/更新', '/群列表', '/成长'];
const OPS = ['handoff.js', 'release-status.js', 'log-tail.js', 'restart.js / restart.cmd',
  'announce-preview.js', 'announce-reset.js', 'known-group-add.js', 'relay-status.js', 'rhythm-report.js',
  'social-observer.js', 'card-eval.js', 'memory-v0.js', 'selftest.js', 'stats-report.js', 'economy-sim.js',
  'growth-report.js', 'command-index.js', 'probe.js', 'warmup-status.js', 'memory-archive.js', 'idle-burn.js',
  'purge-tool-notes.js', 'profile-scan.js', 'transcript.js', 'verify-qq.js', 'todo-index.js'];
const MEITU = ['groupDisabled', 'cooldown', 'unregistered', 'interpretFailed', 'noResult', 'sourceDown',
  'uploadFailed', 'downloadFailed', 'internal', 'blocked_apology', 'blocked_empty'];
const mapOf = (keys) => Object.fromEntries(keys.map((key) => [key, `示例-${key}`]));

/** 一个最小但完整的合法世界包；内容均为人工合成的中性示例。 */
function worldFixture(overrides = {}) {
  const world = {
    schemaVersion: 1,
    id: 'example',
    label: '示例世界',
    default: false,
    storyWorld: {
      storyEvents: [{
        id: 'event-a',
        setup: '示例场景：在路口遇到一件小事',
        branches: [{
          id: 'branch-a', weight: 2, line: '示例分支一', keywords: ['示例', '路口'],
          effect: { money: 3, mood: -1 },
        }, {
          id: 'branch-b', weight: 1, line: '示例分支二', keywords: ['示例'],
          effect: { stamina: -2 },
        }],
      }],
      storyClosingWords: ['示例收尾词一', '示例收尾词二'],
      storyClosingExamples: ['示例收尾句。'],
      storyRespondClosing: '示例回答收尾要求。',
      storySettleClosing: '示例结算收尾要求。',
      places: PLACES.map((id) => ({
        id, name: `示例地点-${id}`, kind: 'example', travelMs: 60_000, blurb: `示例说明-${id}`,
      })),
      worldText: {
        currency: '示例货币', questAcceptPrefix: '示例前缀', questAcceptSuffix: '示例后缀',
        questAcceptPlain: '示例接取',
      },
      moduleText: Object.fromEntries(MODULES.map((id) => [
        id,
        ['burst', 'cook'].includes(id) ? { name: `示例模块-${id}`, note: `示例备注-${id}` } : { name: `示例模块-${id}` },
      ])),
      chronicleKinds: mapOf(KINDS),
      eventLabels: mapOf(LABELS),
      chronicleText: { currency: '示例货币', manaLabel: '示例精力', healFailed: '示例未成功' },
      commandEffects: mapOf(COMMANDS),
      cardClaimNotes: mapOf(CLAIMS),
      keywordGroups: [{ label: '示例地点词', words: ['示例地点', '示例路口'] }],
      opsEffects: mapOf(OPS),
    },
    turnWorld: {
      warmupTopics: [
        { tag: 'meal', text: '示例饭点话题。' },
        { tag: 'poor', text: '示例手头紧话题。' },
        { tag: 'rich', text: '示例宽裕话题。' },
        { tag: 'general', text: '示例日常话题。' },
      ],
      meituLines: Object.fromEntries(MEITU.map((key) => [key, ['示例句一', '示例句二']])),
    },
    moodWorld: {
      config: {
        groupKeywords: ['示例世界', '示例关键字'],
        reportTargetName: '示例助手',
        bodyMismatchNote: '示例身体口径说明',
      },
      ruleLabels: { biological: '示例生物体', mechanical: '示例机械体' },
    },
  };
  return Object.assign(world, overrides);
}

/**
 * 注入式假文件系统：`files` 是 { 目录名: 包对象或原始文本 }。
 * `order` 控制 readdir 返回顺序（验证加载器自己会排序），`entries` 塞入非目录项。
 * read 只接受注入根下的 URL；任何真实路径都不可能被它读到。
 * ⚠️ `dir` 必须是 **URL**（与 content-pack 先例一致）：实现用
 * `new URL('<id>/world.json', dir)` 拼子文件，传字符串会抛 TypeError；
 * 真实目录注入请用 `pathToFileURL(dirPath)`。
 */
function fakeWorldDir(files, { order = Object.keys(files), entries = [], env = {} } = {}) {
  const calls = { readdir: [], read: [] };
  const readdir = (dir, options) => {
    calls.readdir.push({ dir: String(dir), options });
    const dirs = order.map((name) => ({ name, isDirectory: () => true }));
    return [...entries, ...dirs];
  };
  const read = (url, encoding) => {
    const href = String(url);
    calls.read.push({ href, encoding });
    const found = /\/worlds\/([^/]+)\/world\.json$/.exec(href);
    const name = found ? decodeURIComponent(found[1]) : '';
    if (!Object.hasOwn(files, name)) {
      const error = new Error(`ENOENT: ${href}`);
      error.code = 'ENOENT';
      throw error;
    }
    const value = files[name];
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return { dir: WORLD_ROOT, read, readdir, env, calls };
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
  assert.doesNotMatch(String(message), /[A-Za-z]:[\\/]/, `错误信息不应含绝对路径：${message}`);
  assert.doesNotMatch(String(message), /fixture:\/\//, `错误信息不应含注入 URL：${message}`);
  assert.doesNotMatch(String(message), /示例地点|示例分支|示例话题|示例助手|示例身体/, `错误信息不应含包内容：${message}`);
}

// ---------------------------------------------------------------------------
// ① 合法包 / 发现规则
// ---------------------------------------------------------------------------

test('world-pack:合法合成包按目录发现，worldById 原样返回（逐字一致）', () => {
  const world = worldFixture();
  assert.equal(validateWorldPack(world), null, '合成包本身必须是合法 schema');
  const io = fakeWorldDir({ example: world });
  const packs = readWorldPacks(io);

  assert.equal(packs.schemaVersion, 1);
  assert.deepEqual(packs.ids, ['example']);
  assert.deepEqual(packs.worlds.example, world, '包内容逐字一致，不裁剪/不改写/不重排字段');
  assert.deepEqual(worldById('example', packs), world, 'worldById 返回原值（字段逐字一致）');
  assert.equal(packs.activeId, null, '没有 default 且未设 env → 回退旧快照');
  assert.equal(packs.active, null);
  assert.equal(io.calls.readdir.length, 1, '目录发现只调用注入 readdir 一次');
  assert.equal(io.calls.read.length, 1, '每个包只调用注入 read 一次');
  assert.equal(io.calls.readdir[0].options?.withFileTypes, true, '目录发现必须请求 Dirent 形状');
});

test('world-pack:只发现目录、忽略点目录与普通文件，并按目录名排序', () => {
  const io = fakeWorldDir(
    { b: worldFixture({ id: 'b' }), a: worldFixture({ id: 'a' }) },
    {
      order: ['b', '.hidden', 'a'],
      entries: [{ name: 'README.md', isDirectory: () => false }],
    },
  );
  const packs = readWorldPacks(io);
  assert.deepEqual(packs.ids, ['a', 'b'], '按目录名排序；点目录与普通文件不参与发现');
  assert.equal(io.calls.read.length, 2, '只读取两个真实包的 world.json');
});

// ---------------------------------------------------------------------------
// ② 没有 content/worlds 目录 = 旧行为
// ---------------------------------------------------------------------------

test('world-pack:没有 content/worlds 目录 → null；权限类读错仍抛错且不含路径', () => {
  const io = { dir: WORLD_ROOT, read: null, readdir: () => {
    const error = new Error('ENOENT: fixture://content/worlds/');
    error.code = 'ENOENT';
    throw error;
  } };
  assert.equal(readWorldPacks(io), null, '缺目录返回 null，调用方才能回退旧快照');
  assert.ok(
    WORLD_PACKS === null || (WORLD_PACKS.schemaVersion === 1 && Array.isArray(WORLD_PACKS.ids)),
    '模块级 WORLD_PACKS 只允许 null（公开集/旧安装）或合法聚合（装包后）',
  );

  const denied = () => {
    const error = new Error('EACCES: fixture://content/worlds/');
    error.code = 'EACCES';
    throw error;
  };
  const error = capture(() => readWorldPacks({ dir: WORLD_ROOT, read: denied, readdir: denied }));
  assert.match(error.message, /EACCES/, '权限错不是"缺目录"，必须大声失败');
  assertNoPayloadLeak(error.message);
});

// ---------------------------------------------------------------------------
// ③ 坏 JSON / 缺文件 / 坏 schema / id 问题
// ---------------------------------------------------------------------------

test('world-pack:坏 JSON → invalid-json，错误信息不含绝对路径/内容片段', () => {
  const error = capture(() => readWorldPacks(fakeWorldDir({ example: '{ "schemaVersion": 1, 这不是 JSON' })));
  assert.match(error.message, /^world pack "example": invalid-json$/);
  assertNoPayloadLeak(error.message);
  assert.doesNotMatch(error.message, /schemaVersion/, '错误信息不应回显原始 JSON 片段');
});

test('world-pack:目录存在但缺 world.json → missing-world-file（不静默跳过该包）', () => {
  const error = capture(() => readWorldPacks(fakeWorldDir({}, { order: ['example'] })));
  assert.match(error.message, /^world pack "example": missing-world-file$/);
  assertNoPayloadLeak(error.message);
});

test('world-pack:顶层坏 schema（缺字段/多余字段/版本/id/label/default）→ 抛错，只含包 id 与错误码', () => {
  const mutations = [
    [(p) => { delete p.storyWorld; }, /: schema$/],
    [(p) => { p.extra = true; }, /: schema$/],
    [(p) => { p.schemaVersion = 2; }, /: schema-version$/],
    [(p) => { p.schemaVersion = 0; }, /: schema-version$/],
    [(p) => { p.id = 'Example With Space'; }, /: id$/],
    [(p) => { p.label = ''; }, /: label$/],
    [(p) => { p.default = 'false'; }, /: default$/],
    [(p) => { p.storyWorld = null; }, /: story-world$/],
    [(p) => { p.turnWorld = null; }, /: turn-world$/],
    [(p) => { p.moodWorld = null; }, /: mood-world$/],
  ];
  for (const [mutate, expected] of mutations) {
    const world = clone(worldFixture());
    mutate(world);
    assert.equal(validateWorldPack(world) !== null, true, `坏 schema 必须被 validateWorldPack 拒绝：${mutate}`);
    const error = capture(() => readWorldPacks(fakeWorldDir({ example: world })));
    assert.match(error.message, expected);
    assert.match(error.message, /^world pack "example": /, '只带包 id 与错误码');
    assertNoPayloadLeak(error.message);
  }
});

test('world-pack:storyWorld 15 个键逐个缺失/多余 → story-world（严格键集合）', () => {
  for (const key of STORY_KEYS) {
    const missing = clone(worldFixture());
    delete missing.storyWorld[key];
    assert.equal(validateWorldPack(missing), 'story-world', `缺 ${key}`);
  }
  const extra = clone(worldFixture());
  extra.storyWorld.extra = '示例多余字段';
  assert.equal(validateWorldPack(extra), 'story-world', 'storyWorld 不许有多余键');
  const extraTop = clone(worldFixture());
  extraTop.storyWorld = { ...extraTop.storyWorld, schemaVersion: 1 };
  assert.equal(validateWorldPack(extraTop), 'story-world', '世界段不该再带 schemaVersion');
});

test('world-pack:turnWorld / moodWorld 键集合与结构错 → 对应错误码', () => {
  const mutations = [
    ['turn-world', (p) => { delete p.turnWorld.meituLines; }],
    ['turn-world', (p) => { p.turnWorld.extra = true; }],
    ['turn-world', (p) => { p.turnWorld.warmupTopics = []; }],
    ['turn-world', (p) => { p.turnWorld.warmupTopics = [{ tag: 'unknown', text: '示例' }]; }],
    ['turn-world', (p) => { p.turnWorld.warmupTopics = [{ tag: 'meal', text: '示例' }]; }],
    ['turn-world', (p) => { delete p.turnWorld.meituLines.cooldown; }],
    ['turn-world', (p) => { p.turnWorld.meituLines.internal = []; }],
    ['mood-world', (p) => { delete p.moodWorld.config; }],
    ['mood-world', (p) => { p.moodWorld.extra = true; }],
    ['mood-world', (p) => { p.moodWorld.config.groupKeywords = []; }],
    ['mood-world', (p) => { delete p.moodWorld.ruleLabels.mechanical; }],
  ];
  for (const [code, mutate] of mutations) {
    const world = clone(worldFixture());
    mutate(world);
    assert.equal(validateWorldPack(world), code, mutate.toString());
  }
});

test('world-pack:storyWorld 内部各段边界错 → story-world', () => {
  const mutations = [
    (p) => { p.storyWorld.storyEvents = []; },
    (p) => { p.storyWorld.storyEvents[0].branches[0].weight = 0; },
    (p) => { p.storyWorld.storyEvents[0].branches[0].effect.hp = 1; },
    (p) => { p.storyWorld.storyEvents[0].branches[0].effect.money = 'x'; },
    (p) => { delete p.storyWorld.storyEvents[0].branches[0].line; },
    (p) => { p.storyWorld.storyClosingWords = []; },
    (p) => { p.storyWorld.storyRespondClosing = ''; },
    (p) => { p.storyWorld.places = p.storyWorld.places.slice(0, 5); },
    (p) => { p.storyWorld.places[0].travelMs = 0; },
    (p) => { p.storyWorld.places.reverse(); },
    (p) => { delete p.storyWorld.worldText.questAcceptPlain; },
    (p) => { delete p.storyWorld.moduleText.nosy; },
    (p) => { delete p.storyWorld.moduleText.burst.note; },
    (p) => { delete p.storyWorld.moduleText.cook.note; },
    (p) => { p.storyWorld.moduleText.burst.note = ''; },
    (p) => { p.storyWorld.moduleText.sword.note = '示例多余备注'; },
    (p) => { delete p.storyWorld.chronicleKinds.heal; },
    (p) => { p.storyWorld.chronicleKinds.extra = '示例'; },
    (p) => { delete p.storyWorld.eventLabels.tax; },
    (p) => { delete p.storyWorld.chronicleText.manaLabel; },
    (p) => { delete p.storyWorld.commandEffects['/help']; },
    (p) => { p.storyWorld.commandEffects['/help'] = ''; },
    (p) => { delete p.storyWorld.cardClaimNotes['/成长']; },
    (p) => { delete p.storyWorld.opsEffects['probe.js']; },
    (p) => { p.storyWorld.keywordGroups = []; },
    (p) => { p.storyWorld.keywordGroups = [{ label: '示例', words: [1] }]; },
  ];
  for (const mutate of mutations) {
    const world = clone(worldFixture());
    mutate(world);
    assert.equal(validateWorldPack(world), 'story-world', mutate.toString());
  }
});

test('world-pack:id 与目录名不符 / 同一 id 出现两次 → 抛错', () => {
  const mismatch = capture(() => readWorldPacks(fakeWorldDir({ other: worldFixture() })));
  assert.match(mismatch.message, /^world pack "other": id-mismatch$/, '包 id 必须等于目录名');

  const duplicate = capture(() => readWorldPacks(
    fakeWorldDir({ example: worldFixture() }, { order: ['example', 'example'] }),
  ));
  assert.match(duplicate.message, /^world pack "example": duplicate-id$/, '重复目录名/重复 id 必须抛错而不是后者覆盖前者');
});

test('world-pack:未知 id / 未加载 → 抛错，不返回 undefined', () => {
  const packs = readWorldPacks(fakeWorldDir({ example: worldFixture() }));
  assert.match(capture(() => worldById('no-such-world', packs)).message, /^world pack: unknown-id "no-such-world"$/);
  assert.match(capture(() => worldById('example', null)).message, /^world pack: no-packs-loaded$/);
  const fallback = capture(() => worldById('no-such-world'));
  assert.match(fallback.message, /unknown-id|no-packs-loaded/,
    '默认 WORLD_PACKS：公开集为 null，装包后为真实包；两种情况都必须大声失败');
  assert.match(capture(() => worldAsStoryWorldSections(null)).message, /no-world/);
});

// ---------------------------------------------------------------------------
// ④ 激活规则
// ---------------------------------------------------------------------------

test('world-pack:激活规则 env QQBOT_WORLD > 唯一 default > null，顺序固定', () => {
  const noDefault = fakeWorldDir({ a: worldFixture({ id: 'a' }), b: worldFixture({ id: 'b' }) });
  const none = readWorldPacks(noDefault);
  assert.equal(none.activeId, null, '没有 default 且未设 env → null（回退旧快照）');
  assert.equal(none.active, null);

  const oneDefault = readWorldPacks(fakeWorldDir({
    a: worldFixture({ id: 'a' }),
    b: worldFixture({ id: 'b', default: true }),
  }));
  assert.equal(oneDefault.activeId, 'b', '恰有一个 default:true → 选它');
  assert.deepEqual(oneDefault.active, oneDefault.worlds.b, 'active 是该包对象本身');

  const envWins = readWorldPacks(fakeWorldDir(
    { a: worldFixture({ id: 'a', default: true }), b: worldFixture({ id: 'b' }) },
    { env: { QQBOT_WORLD: 'b' } },
  ));
  assert.equal(envWins.activeId, 'b', 'env 优先于 default');

  const emptyEnv = readWorldPacks(fakeWorldDir(
    { a: worldFixture({ id: 'a', default: true }), b: worldFixture({ id: 'b' }) },
    { env: { QQBOT_WORLD: '' } },
  ));
  assert.equal(emptyEnv.activeId, 'a', '空字符串视为未设置');
});

test('world-pack:多个 default → ambiguous-default；未知 env id → unknown-id（都大声失败）', () => {
  const ambiguous = capture(() => readWorldPacks(fakeWorldDir({
    a: worldFixture({ id: 'a', default: true }),
    b: worldFixture({ id: 'b', default: true }),
  })));
  assert.match(ambiguous.message, /^world packs: ambiguous-default$/);
  assertNoPayloadLeak(ambiguous.message);

  const unknown = capture(() => readWorldPacks(fakeWorldDir(
    { a: worldFixture({ id: 'a' }) },
    { env: { QQBOT_WORLD: 'no-such-world' } },
  )));
  assert.match(unknown.message, /^world pack: unknown-id "no-such-world"$/);
  assertNoPayloadLeak(unknown.message);
});

// ---------------------------------------------------------------------------
// ⑤ 聚合形状 / 注入边界 / 参数
// ---------------------------------------------------------------------------

test('world-pack:三个世界段聚合形状逐字等于包内对应段（供既有消费者使用）', () => {
  const world = worldFixture();
  const packs = readWorldPacks(fakeWorldDir({ example: world }));
  const story = worldAsStoryWorldSections(packs.active ?? packs.worlds.example);
  const turn = worldAsTurnSections(packs.worlds.example);
  const mood = worldAsMoodBodySections(packs.worlds.example);

  assert.deepEqual(Object.keys(story), STORY_KEYS, '15 个世界段键、旧顺序');
  for (const key of STORY_KEYS) assert.deepEqual(story[key], world.storyWorld[key], key);
  assert.deepEqual(turn, { warmupTopics: world.turnWorld.warmupTopics, meituLines: world.turnWorld.meituLines });
  assert.deepEqual(mood, { config: world.moodWorld.config, ruleLabels: world.moodWorld.ruleLabels });
  assert.deepEqual(Object.keys(turn), ['warmupTopics', 'meituLines']);
  assert.deepEqual(Object.keys(mood), ['config', 'ruleLabels']);
});

test('world-pack:只经注入 read/readdir 取数，不触碰真实 content/、不联网、不 spawn', () => {
  const io = fakeWorldDir({ example: worldFixture() });
  const packs = readWorldPacks(io);
  assert.equal(io.calls.readdir.length, 1, '目录发现只能走注入 readdir');
  assert.equal(io.calls.read.length, 1, '包读取只能走注入 read');
  assert.ok(
    io.calls.read.every(({ href }) => href.startsWith('fixture://content/worlds/')),
    '读取目标必须是注入的合成根，不能落到真实盘路径',
  );
  assert.equal(packs.worlds.example.id, 'example');
});

test('world-pack:可选 params 合法绿；非法/未知/部署域键红且不回显秘密值', () => {
  const good = {
    QQBOT_MOOD_TTL_MS: 1,
    QQBOT_MOOD_KAOMOJI_CHANCE: 0.5,
    QQBOT_STYLE_NUDGES: 2,
    QQBOT_SPOKEN_MAX_CHARS: 120,
    QQBOT_SPOKEN_EMOJI_CHANCE: 0.1,
    QQBOT_POKE_REPLY_CHANCE: 1,
    QQBOT_FACE_REPLY_CHANCE: 0,
  };
  const packs = readWorldPacks(fakeWorldDir({ example: worldFixture({ default: true, params: good }) }));
  assert.deepEqual(activeWorldParams(packs), good, '激活包的已校验 params 原样返回');
  assert.deepEqual(activeWorldParams(readWorldPacks(fakeWorldDir({ example: worldFixture() }))), {},
    '包内无 params → {}');

  for (const key of Object.keys(good)) {
    for (const invalid of [true, null, {}, [], 'not-a-number', Infinity]) {
      const world = worldFixture({ params: { [key]: invalid } });
      assert.equal(validateWorldPack(world), 'params', `${key}=${String(invalid)}`);
    }
  }
  assert.equal(validateWorldPack(worldFixture({ params: { QQBOT_MOOD_TTL_MS: 0 } })), 'params');
  assert.equal(validateWorldPack(worldFixture({ params: { QQBOT_STYLE_NUDGES: 1.5 } })), 'params');
  assert.equal(validateWorldPack(worldFixture({ params: null })), 'params');

  for (const key of ['QQBOT_LLM_KEY', 'QQ_CLIENT_SECRET', 'QQBOT_STATE_DB', 'QQBOT_TOOLS']) {
    const world = worldFixture({ params: { [key]: 'synthetic-hidden-secret' } });
    assert.equal(validateWorldPack(world), 'params', key);
    const error = capture(() => readWorldPacks(fakeWorldDir({ example: world })));
    assert.match(error.message, /^world pack "example": params$/);
    assert.doesNotMatch(error.message, /synthetic-hidden-secret|QQBOT_|QQ_CLIENT/);
  }
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(validateWorldPack(worldFixture({ params: polluted })), 'params');
  assert.equal({}.polluted, undefined);
});

test('world-pack:worldPackSummary 只含无值元数据', () => {
  assert.deepEqual(worldPackSummary(null), { available: false, ids: [], activeId: null, defaultIds: [] });
  const packs = readWorldPacks(fakeWorldDir({ a: worldFixture({ id: 'a' }), b: worldFixture({ id: 'b', default: true }) }));
  assert.deepEqual(worldPackSummary(packs), { available: true, ids: ['a', 'b'], activeId: 'b', defaultIds: ['b'] });
  assert.doesNotMatch(JSON.stringify(worldPackSummary(packs)), /示例/, '摘要不许带内容值');
});

// ---------------------------------------------------------------------------
// ⑥ 真实示例包（只读；缺失时如实跳过）
// ---------------------------------------------------------------------------

test('world-pack:真实示例包 content/worlds/example/world.json 通过校验（缺失则跳过）', () => {
  const example = new URL('../content/worlds/example/world.json', import.meta.url);
  if (!fs.existsSync(example)) {
    console.log('  [skip] 真实示例包尚不存在（由 world-example 产出），本判据未验证');
    return;
  }
  const value = JSON.parse(fs.readFileSync(example, 'utf8'));
  assert.equal(validateWorldPack(value), null, '真实示例包必须通过世界包 schema');
  assert.equal(value.id, 'example', 'id 必须等于目录名');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.default, false, '示例包不应抢默认（default:false）');
  assert.deepEqual(Object.keys(value.storyWorld), STORY_KEYS);
  assert.deepEqual(Object.keys(value.turnWorld), ['warmupTopics', 'meituLines']);
  assert.deepEqual(Object.keys(value.moodWorld), ['config', 'ruleLabels']);
});

// 注册：既接受 selftest runner 的 test 函数，也接受 { test, assert } 形状。
export function registerWorldPackTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerWorldPackTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  console.log('[selftest-world-pack] 只跑合成夹具：不读真实 content/worlds 做契约验证、不联网、不 git、不 spawn');
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
