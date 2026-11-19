/**
 * 通用本地目录收藏（JM 搬本子功能）的离线判据（2026-11-17）。
 *
 * 跑法：
 *
 *     node scripts/selftest-catalog.js
 *
 * 全部合成、零网络、零图片、零下载：
 *   · 数据层用 `:memory:` 或独立临时文件；
 *   · 服务层注入**假 provider**（只回合成条目，不联网）；
 *   · JM 接线注入**假 runFetch**，只允许 `--op resolve`，出现 download/pdf 立即判红；
 *   · 不启动 bot、不碰真 QQ、不写仓库 data/。
 *
 * 钉：
 *   ① 解析：收藏/取消收藏/收藏夹、标签、序号、作者/原作/标签条件、非法条件不静默丢；
 *   ② 数据：幂等收藏、取消再收藏、单元归父条目、多收藏夹不复制、元数据刷新不覆盖用户数据；
 *   ③ 未知 ≠ 空；标题/作者疑似重复只提示不合并；
 *   ④ 最近清单按群+人隔离，多群共享同一收藏集合；
 *   ⑤ 进程重启收藏仍在；缓存键含全部条件，写操作使旧缓存失效；
 *   ⑥ 本地/在线 provider 能力声明；不支持的条件明确报错，在线结果不写收藏；
 *   ⑦ 父组件开关/群白名单/接线哨兵；收藏路径不触发 download/pdf/图片。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogStore, CatalogSchemaError } from '../src/catalog-store.js';
import {
  DEFAULT_CATALOG_LINES,
  catalogCacheKey,
  catalogScopeFor,
  createCatalogQueryCache,
  createLocalCatalogProvider,
  createOnlineCatalogProvider,
  describeTags,
  handleCatalogCommand,
  searchCatalog,
} from '../src/catalog-service.js';
import { looksLikeCatalogAttempt, parseCatalogCommand } from '../src/catalog-command.js';
import { createJmCatalogProvider } from '../src/jm-catalog.js';
import { handleJmCommand } from '../src/jm-service.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

async function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-catalog-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const message = ({ group = 'g1', user = 'u1' } = {}) => ({
  scene: 'group',
  targetId: group,
  senderId: user,
  messageId: 'm-1',
  content: '',
  isMention: true,
});

let clock = 1_700_000_000_000;
const tick = () => { clock += 1000; return clock; };

function item(id, overrides = {}) {
  return {
    source: 'jm',
    entityType: 'work',
    sourceId: String(id),
    title: `合成作品${id}`,
    pageCount: 20,
    unitCount: 2,
    metadataFetchedAt: clock,
    metadataStatus: 'complete',
    creators: [{ name: `作者${id}`, role: 'author', seq: 0 }, { name: `原作${id}`, role: 'original', seq: 1 }],
    creatorsKnown: true,
    tags: ['全彩'],
    tagsKnown: true,
    aliases: [{ type: 'unit', id: `${id}1` }, { type: 'unit', id: `${id}2` }],
    ...overrides,
  };
}

function storeFor(options = {}) {
  return new CatalogStore(':memory:', { library: { kind: 'instance', ownerId: 'test' }, now: tick, ...options });
}

function serviceDeps(store, provider, pageSize = 8) {
  const replies = [];
  return {
    replies,
    deps: {
      store,
      provider,
      log: SILENT_LOG,
      now: tick,
      pageSize,
      reply: async (text) => { replies.push(text); },
    },
  };
}

async function runService(store, provider, text, scope = {}, { pageSize = 8 } = {}) {
  const { replies, deps } = serviceDeps(store, provider, pageSize);
  const result = await handleCatalogCommand({
    message: message(scope),
    parsed: parseCatalogCommand(text, { defaultSource: 'jm' }),
    deps,
  });
  return { result, replies };
}

function makeFakeProvider({ items = [], resolveCalls = [], throws = false } = {}) {
  return {
    id: 'fake-jm',
    version: '1',
    defaultSource: 'jm',
    async resolveItem({ id }) {
      resolveCalls.push(String(id));
      if (throws) throw new Error('fake network down');
      const found = items.find((entry) => entry.sourceId === String(id))
        ?? items.find((entry) => (entry.aliases ?? []).some((alias) => alias.id === String(id)));
      if (!found) return { ok: false, reason: 'not_found' };
      return { ok: true, item: found, resolvedFrom: found.sourceId === String(id) ? 'album' : 'unit' };
    },
  };
}

// ---------------------------------------------------------------------------
// ① 解析器（纯函数，无副作用）
// ---------------------------------------------------------------------------

test('catalog-command:收藏/取消收藏/收藏夹与标签、序号形状', () => {
  assert.deepEqual(parseCatalogCommand('收藏 1490076', { defaultSource: 'jm' }), {
    ok: true, action: 'favorite', target: { source: 'jm', id: '1490076' }, ordinal: null, tags: [],
  });
  assert.deepEqual(parseCatalogCommand('收藏 JM1490076 标签:想再看 标签:全彩', { defaultSource: 'jm' }), {
    ok: true, action: 'favorite', target: { source: 'jm', id: '1490076' }, ordinal: null, tags: ['想再看', '全彩'],
  });
  assert.deepEqual(parseCatalogCommand('收藏 #3', { defaultSource: 'jm' }), {
    ok: true, action: 'favorite', target: null, ordinal: 3, tags: [],
  });
  assert.equal(parseCatalogCommand('收藏 第3个', { defaultSource: 'jm' }).ordinal, 3);
  assert.deepEqual(parseCatalogCommand('收藏 jm:1490076', { defaultSource: 'jm' }), {
    ok: true, action: 'favorite', target: { source: 'jm', id: '1490076' }, ordinal: null, tags: [],
  });
  assert.deepEqual(parseCatalogCommand('收藏 JM:1490076', { defaultSource: 'jm' }), {
    ok: true, action: 'favorite', target: { source: 'jm', id: '1490076' }, ordinal: null, tags: [],
  }, '来源名大小写不敏感');
  assert.deepEqual(parseCatalogCommand('取消收藏 jm:1490076', { defaultSource: 'jm' }), {
    ok: true, action: 'unfavorite', target: { source: 'jm', id: '1490076' }, ordinal: null, tags: [],
  });
  assert.deepEqual(parseCatalogCommand('取消收藏 1490076', { defaultSource: 'jm' }), {
    ok: true, action: 'unfavorite', target: { source: 'jm', id: '1490076' }, ordinal: null, tags: [],
  });
});

const GROUPED_TAGS = ['重读', '雪景', 'AI生成', '修真风', '短篇', '彩页'];
const GROUPED_TAG_COMMANDS = [
  `收藏101 标签：${GROUPED_TAGS.join('  ')}`,
  `收藏101 标签：${GROUPED_TAGS.join('，')}`,
  `@副实例 收藏：ＪＭ１０１，标签 : 重读, 雪景、ＡＩ生成；修真风\n短篇 标签:彩页 标签:ai生成`,
];

for (const [index, text] of GROUPED_TAG_COMMANDS.entries()) {
  test(`catalog-command:成组标签写法 ${index + 1} 保留六个独立标签`, () => {
    assert.equal(looksLikeCatalogAttempt(text), true);
    assert.deepEqual(parseCatalogCommand(text, { defaultSource: 'jm' }), {
      ok: true, action: 'favorite', target: { source: 'jm', id: '101' }, ordinal: null, tags: GROUPED_TAGS,
    });
  });
}

test('catalog-command:标签和目标仍有边界；取消收藏不接受标签', () => {
  const parse = (text) => parseCatalogCommand(text, { defaultSource: 'jm' });
  assert.equal(parse('收藏 标签:重读').ok, false);
  assert.equal(parse('收藏 JM101 JM102 标签:重读').ok, false);
  assert.equal(parse('取消收藏 JM101 标签:重读、雪景').ok, false);
  assert.equal(parse('收藏 JM101 标签：，；').reason, 'tag');
  assert.equal(parse('收藏 JM101 标签:重读 标签:').reason, 'tag');
  assert.equal(parse(`收藏 JM101 标签:${'甲'.repeat(31)}`).reason, 'tag');
  const fiveMax = Array.from({ length: 5 }, (_, index) => `${'甲'.repeat(29)}${index}`).join(' ');
  assert.equal(parse(`收藏 JM101 标签:${fiveMax}`).tags.length, 5, '保留旧总字数预算');
  assert.equal(parse(`收藏 JM101 标签:${fiveMax} 乙`).reason, 'tag', '超过预算不截断');
  assert.equal(parse('收藏 ＃３ 标签:重读').ordinal, 3, '显式序号不变成作品编号');
  assert.deepEqual(parse('收藏 jm： 101 标签:重读').target, { source: 'jm', id: '101' });
});

test('catalog-command:收藏夹条件/页码/文本 AND 组合，未知条件明确拒绝', () => {
  assert.deepEqual(parseCatalogCommand('收藏夹', { defaultSource: 'jm' }), {
    ok: true, action: 'list', text: null, filters: {}, page: 1, sort: 'recent',
  });
  assert.deepEqual(parseCatalogCommand('收藏夹 2', { defaultSource: 'jm' }), {
    ok: true, action: 'list', text: null, filters: {}, page: 2, sort: 'recent',
  });
  const combo = parseCatalogCommand('收藏夹 作者:甲 原作:乙 标签:丙 2', { defaultSource: 'jm' });
  assert.equal(combo.ok, true);
  assert.deepEqual(combo.filters, { creator: ['甲'], original: ['乙'], tag: ['丙'] });
  assert.equal(combo.page, 2);
  assert.equal(parseCatalogCommand('收藏夹 全彩', { defaultSource: 'jm' }).text, '全彩');
  assert.equal(parseCatalogCommand('收藏夹 年份:2024', { defaultSource: 'jm' }).reason, 'unsupported');
  assert.equal(parseCatalogCommand('收藏夹 作者:', { defaultSource: 'jm' }).reason, 'format');
  assert.equal(parseCatalogCommand('收藏夹 0', { defaultSource: 'jm' }).reason, 'page');
  assert.equal(parseCatalogCommand('收藏 标签:x', { defaultSource: 'jm' }).reason, 'format');
  assert.equal(parseCatalogCommand('收藏 年份:2024', { defaultSource: 'jm' }).reason, 'unsupported');
});

test('catalog-command:普通闲聊不误判，@残留会剥掉', () => {
  for (const text of ['今天收藏了吗', '这个收藏夹不错', '你好']) {
    assert.equal(looksLikeCatalogAttempt(text), false, text);
  }
  for (const text of ['收藏', '收藏夹 年份:2024', '取消收藏']) {
    assert.equal(looksLikeCatalogAttempt(text), true, text);
  }
  assert.equal(parseCatalogCommand('@副实例 收藏 1490076 @副实例', { defaultSource: 'jm' }).target.id, '1490076');
});

// ---------------------------------------------------------------------------
// ② 数据层：schema / 幂等 / 关系
// ---------------------------------------------------------------------------

test('catalog-store:schema v1、WAL/外键、重复打开幂等', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'catalog.db');
    const first = new CatalogStore(file, { library: { kind: 'instance', ownerId: 'test' }, now: tick });
    assert.equal(Number(first.handle.prepare('PRAGMA user_version').get().user_version), 1);
    assert.equal(Number(first.handle.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
    assert.equal(String(first.handle.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    first.addFavorite({ item: item('101') });
    assert.equal(first.countFavorites(), 1);
    first.close();

    const second = new CatalogStore(file, { library: { kind: 'instance', ownerId: 'test' }, now: tick });
    assert.equal(Number(second.handle.prepare('PRAGMA user_version').get().user_version), 1);
    assert.equal(second.countFavorites(), 1, '进程重启后收藏仍在');
    assert.equal(second.getItem(1).title, '合成作品101');
    second.close();
  });
});

test('catalog-store:更高 schema 版本拒绝打开，不当坏库改名重建（负对照）', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'catalog.db');
    const store = new CatalogStore(file, { library: { ownerId: 'test' }, now: tick });
    store.handle.exec('PRAGMA user_version = 999');
    store.close();
    assert.throws(
      () => new CatalogStore(file, { library: { ownerId: 'test' }, now: tick }),
      CatalogSchemaError,
    );
    assert.equal(fs.existsSync(file), true, '原库必须保留');
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.deepEqual(leftovers, [], '不能把新版本库改名成坏库');
  });
});

test('catalog-store:重复收藏幂等，不新建行、不改首次收藏时间', () => {
  const store = storeFor();
  const first = store.addFavorite({ item: item('101'), tags: ['想再看'] });
  assert.equal(first.created, true);
  const firstTime = first.favoritedAt;
  clock += 60_000;
  const second = store.addFavorite({ item: item('101'), tags: ['想再看'] });
  assert.equal(second.created, false);
  assert.equal(store.countFavorites(), 1);
  assert.equal(store.countItems(), 1);
  assert.equal(store.getItem(1).favorite.favoritedAt, firstTime);
  assert.deepEqual(store.getItem(1).userTags, ['想再看']);
  store.close();
});

test('catalog-store:取消收藏只删关系，不删条目；取消后可再收藏', () => {
  const store = storeFor();
  store.addFavorite({ item: item('101') });
  const removed = store.removeFavorite({ source: 'jm', entityType: 'work', sourceId: '101' });
  assert.equal(removed.removed, true);
  assert.equal(store.countFavorites(), 0);
  assert.equal(store.countItems(), 1, '条目保留');
  assert.equal(store.getItem(1).title, '合成作品101');
  const again = store.addFavorite({ item: item('101') });
  assert.equal(again.created, true);
  assert.equal(store.countFavorites(), 1);
  assert.equal(store.countItems(), 1);
  store.close();
});

test('catalog-store:单元编号归入父条目，不把单元当条目', () => {
  const store = storeFor();
  const added = store.addFavorite({ item: item('101', { aliases: [{ type: 'unit', id: '111' }] }) });
  assert.equal(added.itemId, 1);
  const alias = store.findItemByAlias({ source: 'jm', aliasType: 'unit', aliasId: '111' });
  assert.equal(alias.id, 1);
  assert.equal(alias.sourceId, '101');
  assert.equal(store.countItems(), 1);
  // 再用单元 id 收藏同一个父条目：仍是一行。
  const second = store.addFavorite({ item: alias });
  assert.equal(second.created, false);
  assert.equal(store.countItems(), 1);
  store.close();
});

test('catalog-store:同一收藏进多个收藏夹不复制条目；移出成员不删条目', () => {
  const store = storeFor();
  const added = store.addFavorite({ item: item('101') });
  const second = store.ensureCollection('第二个收藏夹');
  assert.equal(store.addToCollection({ favoriteId: added.favoriteId, collectionId: second.id }).added, true);
  assert.deepEqual(store.listCollectionFavoriteIds(second.id), [added.favoriteId]);
  assert.equal(store.countItems(), 1);
  assert.equal(store.countFavorites(), 1);
  assert.equal(store.removeFromCollection({ favoriteId: added.favoriteId, collectionId: second.id }).removed, true);
  assert.deepEqual(store.listCollectionFavoriteIds(second.id), []);
  assert.equal(store.countItems(), 1, '移出收藏夹不删条目');
  assert.equal(store.countFavorites(), 1, '移出收藏夹不取消收藏');
  assert.ok(store.getItem(1).favorite, '收藏关系仍在');
  store.close();
});

test('catalog-store:元数据刷新只改标题/来源标签，不覆盖用户标签、备注、收藏时间', () => {
  const store = storeFor();
  const added = store.addFavorite({ item: item('101'), tags: ['我的标签'], note: '我的备注' });
  const before = store.getItem(added.itemId);
  clock += 60_000;
  store.refreshItemMetadata(item('101', {
    title: '刷新后的标题',
    tags: ['新来源标签'],
    creators: [{ name: '新作者', role: 'author' }],
    metadataFetchedAt: clock,
  }));
  const after = store.getItem(added.itemId);
  assert.equal(after.title, '刷新后的标题');
  assert.deepEqual(after.tags, ['新来源标签']);
  assert.deepEqual(after.creators.map((entry) => entry.name), ['新作者']);
  assert.deepEqual(after.userTags, ['我的标签']);
  assert.equal(after.favorite.note, '我的备注');
  assert.equal(after.favorite.favoritedAt, before.favorite.favoritedAt);
  store.close();
});

test('catalog-store:未知元数据 ≠ 已确认空；展示与筛选都分开', () => {
  const store = storeFor();
  store.addFavorite({ item: item('101', {
    creators: [], creatorsKnown: false, tags: [], tagsKnown: false, metadataStatus: 'unknown',
  }) });
  store.addFavorite({ item: item('102', {
    creators: [], creatorsKnown: true, tags: [], tagsKnown: true, metadataStatus: 'complete',
  }) });
  const unknown = store.findItem({ source: 'jm', entityType: 'work', sourceId: '101' });
  const empty = store.findItem({ source: 'jm', entityType: 'work', sourceId: '102' });
  assert.equal(unknown.creatorsKnown, false);
  assert.equal(empty.creatorsKnown, true);
  assert.deepEqual(unknown.creators, []);
  assert.deepEqual(empty.creators, []);

  const all = store.listFavorites({ page: 1, pageSize: 8 });
  const byId = new Map(all.items.map((entry) => [entry.sourceId, entry]));
  assert.equal(byId.get('101').creatorsKnown, false);
  assert.equal(byId.get('102').creatorsKnown, true);

  assert.equal(store.listFavorites({ filters: { creator: ['未知'] } }).total, 1);
  assert.equal(store.listFavorites({ filters: { tag: ['未知'] } }).total, 1);
  assert.equal(store.listFavorites({ filters: { original: ['未知'] } }).total, 1, '角色未知与确认没有原作分开');
  assert.equal(store.listFavorites({ filters: { original: ['作者101'] } }).total, 0);
  assert.equal(store.listFavorites({ filters: { creator: ['作者101'] } }).total, 0, '未知不能被当成"有作者"');
  assert.equal(store.listFavorites({ filters: { tag: ['全彩'] } }).total, 0, '未知不能被当成"有标签"');
  assert.match(describeTags({ ...unknown, userTags: ['自定'] }), /来源:未知/u, '有用户标签也不能把未知来源说成空');
  store.close();
});

test('catalog-store:标题/作者疑似重复只提示，不自动合并', () => {
  const store = storeFor();
  store.addFavorite({ item: item('101', {
    title: '同一个 标题', creators: [{ name: '共同作者', role: 'author' }],
  }) });
  store.addFavorite({ item: item('102', {
    title: '同一个标题', creators: [{ name: '共同作者', role: 'author' }],
  }) });
  assert.equal(store.countItems(), 2, '不自动合并');
  const suspects = store.findSuspectedDuplicates({
    title: '同一个标题', creators: [{ name: '共同作者' }], excludeItemId: 2,
  });
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].sourceId, '101');
  store.close();
});

test('catalog-store:条件真应用（作者/原作/标签/文本/用户标签），未知条件抛错', () => {
  const store = storeFor();
  store.addFavorite({ item: item('101', {
    title: 'A作品', creators: [{ name: '作者甲', role: 'author' }, { name: '原作甲', role: 'original' }],
    tags: ['全彩'],
  }), tags: ['想再看'] });
  store.addFavorite({ item: item('102', {
    title: 'B作品', creators: [{ name: '作者乙', role: 'author' }, { name: '原作乙', role: 'original' }],
    tags: ['黑白'],
  }) });
  assert.equal(store.listFavorites({ filters: { creator: ['作者甲'] } }).total, 1);
  assert.equal(store.listFavorites({ filters: { original: ['原作乙'] } }).total, 1);
  assert.equal(store.listFavorites({ filters: { tag: ['全彩'] } }).total, 1);
  assert.equal(store.listFavorites({ filters: { tag: ['想再看'] } }).total, 1);
  assert.equal(store.listFavorites({ text: 'B作品' }).total, 1);
  assert.equal(store.listFavorites({ filters: { creator: ['作者甲'], tag: ['黑白'] } }).total, 0, 'AND 生效');
  assert.equal(store.listFavorites({ sort: 'title', page: 1, pageSize: 1 }).items[0].sourceId, '101');
  assert.equal(store.listFavorites({ sort: 'title', page: 2, pageSize: 1 }).items[0].sourceId, '102');
  assert.throws(() => store.listFavorites({ filters: { year: ['2024'] } }), /不支持的筛选条件/u);
  assert.throws(() => store.listFavorites({ sort: 'drop' }), /不支持的排序/u);
  assert.throws(() => store.listFavorites({ page: 0 }), /页码/u);
  store.close();
});

test('catalog-store:同一文件内不同实例 library 互不共享收藏', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'catalog.db');
    const a = new CatalogStore(file, { library: { kind: 'instance', ownerId: 'instance-a' }, now: tick });
    const b = new CatalogStore(file, { library: { kind: 'instance', ownerId: 'instance-b' }, now: tick });
    a.addFavorite({ item: item('101') });
    assert.equal(a.countFavorites(), 1);
    assert.equal(b.countFavorites(), 0, '另一实例不能自动共享收藏');
    assert.equal(b.listFavorites({ page: 1, pageSize: 8 }).total, 0);
    assert.equal(b.findSuspectedDuplicates({ title: '合成作品101' }).length, 0, '疑似重复也不跨库泄露');
    b.addFavorite({ item: item('101') });
    assert.equal(a.countFavorites(), 1);
    assert.equal(b.countFavorites(), 1, '各自收藏同一来源条目是两条独立收藏关系');
    a.close();
    b.close();
  });
});

test('catalog-store:最近清单按库+作用域隔离，不串群/不串人', () => {
  const store = storeFor();
  const ids = [store.addFavorite({ item: item('101') }).itemId, store.addFavorite({ item: item('102') }).itemId];
  store.saveLastList({ scopeKind: 'group_user', scopeId: 'g1:u1', query: { page: 1 }, itemIds: ids, page: 1, total: 2 });
  store.saveLastList({ scopeKind: 'group_user', scopeId: 'g1:u2', query: { page: 1 }, itemIds: [ids[1]], page: 1, total: 1 });
  store.saveLastList({ scopeKind: 'group_user', scopeId: 'g2:u1', query: { page: 1 }, itemIds: [], page: 1, total: 0 });
  assert.deepEqual(store.getLastList({ scopeKind: 'group_user', scopeId: 'g1:u1' }).itemIds, ids);
  assert.deepEqual(store.getLastList({ scopeKind: 'group_user', scopeId: 'g1:u2' }).itemIds, [ids[1]]);
  assert.deepEqual(store.getLastList({ scopeKind: 'group_user', scopeId: 'g2:u1' }).itemIds, []);
  assert.equal(store.getLastList({ scopeKind: 'group_user', scopeId: 'g3:u1' }), null);
  store.close();
});

// ---------------------------------------------------------------------------
// ③ 服务层：回执 / 序号 / 隔离 / 不联网
// ---------------------------------------------------------------------------

test('catalog-service:收藏回执、重复收藏回「已收藏」、单元归父条目', async () => {
  const store = storeFor();
  const provider = makeFakeProvider({ items: [item('101')] });
  const first = await runService(store, provider, '收藏 101 标签:想再看');
  assert.equal(first.result.ok, true);
  assert.match(first.replies[0], /^已收藏：JM101/u);
  assert.match(first.replies[0], /标签：想再看/u);
  const again = await runService(store, provider, '收藏 101');
  assert.equal(again.result.reason, 'already');
  assert.match(again.replies[0], /^已收藏/u);
  assert.equal(store.countFavorites(), 1);

  const unit = await runService(store, provider, '收藏 1011');
  assert.equal(unit.result.ok, true);
  assert.match(unit.replies[0], /是单元，已归到作品/u);
  assert.equal(store.countItems(), 1);
  assert.equal(store.findItemByAlias({ source: 'jm', aliasType: 'unit', aliasId: '1011' }).sourceId, '101');
  store.close();
});

test('catalog-service:收藏夹分页/条件/空状态；最近清单按群+人隔离', async () => {
  const store = storeFor();
  const provider = makeFakeProvider({ items: [item('101'), item('102'), item('103')] });
  for (const id of ['101', '102', '103']) await runService(store, provider, `收藏 ${id}`);
  const page1 = await runService(store, provider, '收藏夹', { group: 'g1', user: 'u1' }, { pageSize: 2 });
  assert.match(page1.replies[0], /^收藏夹（第 1\/2 页，共 3 条）/u);
  assert.match(page1.replies[0], /1｜JM103｜/u);
  assert.match(page1.replies[0], /下一页：收藏夹 2/u);
  const page2 = await runService(store, provider, '收藏夹 2', { group: 'g1', user: 'u1' }, { pageSize: 2 });
  assert.match(page2.replies[0], /1｜JM101｜/u, '序号按当前页从 1 开始');

  const otherGroup = await runService(store, provider, '收藏夹', { group: 'g2', user: 'u1' });
  assert.match(otherGroup.replies[0], /共 3 条/u, '多群共享同一收藏集合');
  const otherUser = await runService(store, provider, '收藏夹', { group: 'g1', user: 'u2' });
  assert.match(otherUser.replies[0], /共 3 条/u);
  assert.notDeepEqual(
    store.getLastList({ scopeKind: 'group_user', scopeId: 'g1:u1' }).itemIds,
    store.getLastList({ scopeKind: 'group_user', scopeId: 'g2:u1' }).itemIds,
  );

  const filtered = await runService(store, provider, '收藏夹 作者:作者101');
  assert.match(filtered.replies[0], /JM101/u);
  assert.doesNotMatch(filtered.replies[0], /JM102/u);
  const missing = await runService(store, provider, '收藏夹 作者:不存在');
  assert.match(missing.replies[0], /本次检查范围内没有符合条件的收藏/u, '不冒充全站结论');
  store.close();
});

test('catalog-service:序号只绑定本群本人最近清单，最终落库用稳定条目 ID', async () => {
  const store = storeFor();
  const provider = makeFakeProvider({ items: [item('101'), item('102')] });
  for (const id of ['101', '102']) await runService(store, provider, `收藏 ${id}`, { group: 'g1', user: 'u1' });
  await runService(store, provider, '收藏夹', { group: 'g1', user: 'u1' });
  const other = await runService(store, provider, '收藏 #1', { group: 'g2', user: 'u1' });
  assert.equal(other.result.reason, 'no_list', '别群的清单不能串用');
  const own = await runService(store, provider, '取消收藏 #1', { group: 'g1', user: 'u1' });
  assert.equal(own.result.ok, true);
  assert.equal(store.countFavorites(), 1);
  assert.ok(store.getLastList({ scopeKind: 'group_user', scopeId: 'g1:u1' }).itemIds[0]);
  store.close();
});

test('catalog-service:翻页后序号按当前页清单绑定', async () => {
  const store = storeFor();
  const provider = makeFakeProvider({ items: [item('101'), item('102'), item('103')] });
  for (const id of ['101', '102', '103']) await runService(store, provider, `收藏 ${id}`);
  await runService(store, provider, '收藏夹 2', { group: 'g1', user: 'u1' }, { pageSize: 2 });
  const last = store.getLastList({ scopeKind: 'group_user', scopeId: 'g1:u1' });
  assert.deepEqual(last.itemIds.map((id) => store.getItem(id).sourceId), ['101']);
  const removed = await runService(store, provider, '取消收藏 #1', { group: 'g1', user: 'u1' });
  assert.equal(removed.result.ok, true);
  assert.equal(store.findItem({ source: 'jm', entityType: 'work', sourceId: '101' }).favorite, null);
  store.close();
});

test('catalog-service:取消收藏不发网络、不删条目；未收藏回固定话术', async () => {
  const store = storeFor();
  const provider = makeFakeProvider({ items: [item('101')] });
  await runService(store, provider, '收藏 101');
  const providerThatMustNotBeCalled = {
    id: 'offline', version: '1', defaultSource: 'jm',
    async resolveItem() { throw new Error('取消收藏不允许联网'); },
  };
  const removed = await runService(store, providerThatMustNotBeCalled, '取消收藏 101');
  assert.equal(removed.result.ok, true);
  assert.equal(store.countFavorites(), 0);
  assert.equal(store.countItems(), 1, '取消收藏不删条目');
  const missing = await runService(store, providerThatMustNotBeCalled, '取消收藏 101');
  assert.equal(missing.result.reason, 'not_favorite');
  assert.match(missing.replies[0], /没收藏过/u);
  store.close();
});

test('catalog-service:多候选只回清单，不自动挑；候选不落收藏', async () => {
  const store = storeFor();
  const provider = {
    id: 'ambig', version: '1', defaultSource: 'jm',
    async resolveItem() {
      return { ok: false, candidates: [item('201'), item('202')] };
    },
  };
  const result = await runService(store, provider, '收藏 999');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, 'ambiguous');
  assert.match(result.replies[0], /找到多个条目/u);
  assert.equal(store.countFavorites(), 0);
  assert.equal(store.countItems(), 0, '候选不自动入库/收藏');
  store.close();
});

test('catalog-service:provider 失败回固定话术，不暴露内部错误', async () => {
  const store = storeFor();
  const provider = makeFakeProvider({ throws: true });
  const result = await runService(store, provider, '收藏 101');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, 'unavailable');
  assert.equal(result.replies[0], DEFAULT_CATALOG_LINES.unavailable);
  assert.equal(store.countFavorites(), 0);
  store.close();
});

// ---------------------------------------------------------------------------
// ④ 查询/缓存/provider 能力
// ---------------------------------------------------------------------------

test('catalog-query:缓存键包含文本/条件/排序/分页/周期；不同条件不复用', () => {
  const store = storeFor();
  const provider = createLocalCatalogProvider(store);
  const base = { scope: 'local', text: null, filters: {}, sort: 'recent', page: 1, pageSize: 8 };
  const keys = new Set([
    catalogCacheKey(base, provider),
    catalogCacheKey({ ...base, text: '甲' }, provider),
    catalogCacheKey({ ...base, filters: { creator: ['甲'] } }, provider),
    catalogCacheKey({ ...base, filters: { tag: ['甲'] } }, provider),
    catalogCacheKey({ ...base, sort: 'title' }, provider),
    catalogCacheKey({ ...base, page: 2 }, provider),
    catalogCacheKey({ ...base, pageSize: 3 }, provider),
    catalogCacheKey({ ...base, period: 'week' }, provider),
  ]);
  assert.equal(keys.size, 8, '每个条件变化都必须产生不同缓存键');
  store.close();
});

test('catalog-query:同条件命中缓存；写收藏后 revision 变化使旧缓存失效', async () => {
  const store = storeFor();
  const provider = createLocalCatalogProvider(store);
  const cache = createCatalogQueryCache({ max: 10 });
  const query = { scope: 'local', sort: 'recent', page: 1, pageSize: 8 };
  const empty = await searchCatalog({ query, provider, cache });
  assert.equal(empty.ok, true);
  assert.equal(empty.total, 0);
  const cached = await searchCatalog({ query, provider, cache });
  assert.equal(cached.cached, true);
  store.addFavorite({ item: item('101') });
  const fresh = await searchCatalog({ query, provider, cache });
  assert.equal(fresh.cached, undefined, '收藏变化后不能复用旧缓存');
  assert.equal(fresh.total, 1);
  store.close();
});

test('catalog-query:本地条件被真正应用；在线 provider 不支持的条件明确报错且不写收藏', async () => {
  const store = storeFor();
  store.addFavorite({ item: item('101'), tags: ['想再看'] });
  store.addFavorite({ item: item('102') });
  const local = createLocalCatalogProvider(store);
  assert.equal((await searchCatalog({ query: { scope: 'local', filters: { creator: ['作者101'] } }, provider: local })).total, 1);
  assert.equal((await searchCatalog({ query: { scope: 'local', filters: { tag: ['想再看'] } }, provider: local })).total, 1);
  const bad = await searchCatalog({ query: { scope: 'local', filters: { year: ['2024'] } }, provider: local });
  assert.equal(bad.reason, 'unsupported');

  let onlineCalls = 0;
  const online = createOnlineCatalogProvider({
    id: 'fake-online',
    capabilities: { text: true, filters: { creator: false }, sorts: ['relevance'] },
    search: async () => {
      onlineCalls += 1;
      return { ok: true, items: [item('301')], total: 100, limited: true };
    },
  });
  const unsupported = await searchCatalog({
    query: { scope: 'online', text: '甲', filters: { creator: ['甲'] }, sort: 'relevance' },
    provider: online,
  });
  assert.equal(unsupported.reason, 'unsupported');
  assert.equal(onlineCalls, 0, '不支持的条件不能先调用再丢弃');
  const onlineOk = await searchCatalog({ query: { scope: 'online', text: '甲', sort: 'relevance' }, provider: online });
  assert.equal(onlineOk.ok, true);
  assert.equal(onlineOk.limited, true);
  assert.equal(store.countItems(), 2, '在线结果不自动写入收藏库');
  const onlinePage2 = await searchCatalog({
    query: { scope: 'online', text: '甲', sort: 'relevance', page: 2 },
    provider: createOnlineCatalogProvider({
      id: 'no-pages', capabilities: { text: true, sorts: ['relevance'], pagination: false },
      search: async () => { onlineCalls += 1; return { ok: true, items: [], total: 0 }; },
    }),
  });
  assert.equal(onlinePage2.reason, 'unsupported', '未声明翻页能力必须明确拒绝');
  assert.equal(onlineCalls, 1, '拒绝前不能再调用来源');
  store.close();
});

// ---------------------------------------------------------------------------
// ⑤ JM 接线：父开关/群白名单/无下载
// ---------------------------------------------------------------------------

function jmConfig(dir, groups = ['g1']) {
  return {
    jm: {
      enabled: true,
      groups,
      api: 'http://127.0.0.1:8790',
      max: 5,
      cooldownMs: 0,
      root: dir,
      timeoutMs: 5000,
    },
    catalog: { dbPath: path.join(dir, 'catalog.db'), pageSize: 8 },
    qq: { appId: 'fixture-app' },
  };
}

test('jm接线:群不在名单/名单为空时拒绝，收藏库一次都不打开', async () => {
  await withTemp(async (dir) => {
    for (const groups of [[], ['other-group']]) {
      const replies = [];
      let opened = false;
      const result = await handleJmCommand({
        message: message(),
        parsed: parseCatalogCommand('收藏 101', { defaultSource: 'jm' }),
        deps: {
          config: jmConfig(dir, groups),
          log: SILENT_LOG,
          reply: async (text) => { replies.push(text); },
          catalogStore: { get countFavorites() { opened = true; return 0; } },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'group_disabled');
      assert.equal(opened, false);
      assert.match(replies[0], /没开/u);
    }
  });
});

test('jm接线:收藏只调 --op resolve，绝不 download/pdf（负对照）', async () => {
  await withTemp(async (dir) => {
    const store = new CatalogStore(path.join(dir, 'catalog.db'), {
      library: { kind: 'instance', ownerId: 'test' }, now: tick,
    });
    const calls = [];
    const runFetch = async ({ args }) => {
      calls.push(args);
      assert.ok(args.includes('resolve'), `收藏只允许 resolve，实际 ${args.join(' ')}`);
      assert.equal(args.includes('download'), false, '收藏绝不能下载');
      assert.equal(args.includes('pdf'), false, '收藏绝不能取 PDF');
      return {
        code: 0,
        stderr: '',
        timedOut: false,
        stdout: JSON.stringify({
          ok: true, op: 'resolve', request: '101', kind: 'album',
          album: {
            id: '101', title: '合成作品101', authors: ['作者甲'], tags: ['全彩'],
            page_count: 30, unit_count: 2,
            units: [{ index: 1, unit_id: '111', title: '第1话' }, { index: 2, unit_id: '112', title: '第2话' }],
          },
          matchedUnit: null,
        }),
      };
    };
    const replies = [];
    const result = await handleJmCommand({
      message: message(),
      parsed: parseCatalogCommand('收藏 101', { defaultSource: 'jm' }),
      deps: {
        config: jmConfig(dir),
        catalogStore: store,
        log: SILENT_LOG,
        reply: async (text) => { replies.push(text); },
        runFetch,
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf('--op') + 1], 'resolve');
    assert.match(replies[0], /已收藏：JM101/u);
    const saved = store.findItem({ source: 'jm', entityType: 'work', sourceId: '101' });
    assert.equal(saved.title, '合成作品101');
    assert.deepEqual(saved.creators.map((entry) => entry.name), ['作者甲']);
    assert.deepEqual(saved.tags, ['全彩']);
    assert.equal(saved.unitCount, 2);
    assert.equal(saved.rolesKnown, false, 'JM 只给作者名，不能冒充"确认没有原作"');
    assert.equal(store.listFavorites({ filters: { original: ['未知'] } }).total, 1);
    store.close();
  });
});

test('jm接线:成组标签随收藏写入 SQLite，可按各个标签独立筛出', async () => {
  const store = storeFor();
  try {
    const calls = [];
    const replies = [];
    const runFetch = async ({ args }) => {
      const op = args[args.indexOf('--op') + 1];
      calls.push(op);
      assert.equal(op, 'resolve');
      return { stdout: JSON.stringify({ ok: true, kind: 'album', album: { id: '101', title: '合成作品' } }) };
    };
    for (const content of GROUPED_TAG_COMMANDS) {
      const result = await handleJmCommand({
        message: { ...message(), content },
        parsed: parseCatalogCommand(content, { defaultSource: 'jm' }),
        deps: {
          config: jmConfig('fixture-not-used'), catalogStore: store, runFetch,
          reply: async (text) => { replies.push(text); },
        },
      });
      assert.equal(result.ok, true, content);
      assert.match(replies.at(-1), /^已收藏.*JM101/u);
      const [saved] = store.listFavorites({}).items;
      assert.deepEqual(new Set(saved.userTags), new Set(GROUPED_TAGS));
      for (const tag of GROUPED_TAGS) {
        assert.equal(store.listFavorites({ filters: { tag: [tag] } }).total, 1, tag);
      }
    }
    assert.deepEqual(calls, ['resolve'], '同一条目只解析一次，不下载');
    assert.equal(store.countFavorites(), 1);
  } finally {
    store.close();
  }
});

test('jm接线:收藏夹/取消收藏不 spawn 抓取器（列表路径无网络）', async () => {
  await withTemp(async (dir) => {
    const store = new CatalogStore(path.join(dir, 'catalog.db'), {
      library: { kind: 'instance', ownerId: 'test' }, now: tick,
    });
    store.addFavorite({ item: item('101') });
    let spawns = 0;
    const runFetch = async () => { spawns += 1; throw new Error('列表/取消收藏不允许 spawn'); };
    const replies = [];
    for (const text of ['收藏夹', '取消收藏 101']) {
      const result = await handleJmCommand({
        message: message(),
        parsed: parseCatalogCommand(text, { defaultSource: 'jm' }),
        deps: {
          config: jmConfig(dir),
          catalogStore: store,
          log: SILENT_LOG,
          reply: async (line) => { replies.push(line); },
          runFetch,
        },
      });
      assert.equal(result.ok, true);
    }
    assert.equal(spawns, 0);
    assert.equal(store.countFavorites(), 0);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// ⑥ 接线哨兵（源码/生成物，证明真接上）
// ---------------------------------------------------------------------------

test('接线哨兵:index/config/commands/env 真的接上，且父开关关闭时不响应', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const indexSource = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  const jmBranchStart = indexSource.indexOf('config.jm?.enabled');
  const jmBranchEnd = indexSource.indexOf('// Bridge-level commands', jmBranchStart);
  assert.ok(jmBranchStart >= 0 && jmBranchEnd > jmBranchStart, '必须沿用 JM 父开关');
  const jmBranch = indexSource.slice(jmBranchStart, jmBranchEnd);
  assert.ok(jmBranch.includes('parseCatalogCommand(message.content'), '父开关分支内必须调收藏纯解析器');
  assert.ok(jmBranch.includes('handleJmCommand({'), '必须经 JM 服务层统一白名单/队列');
  assert.ok(jmBranch.includes('looksLikeCatalogAttempt'), '格式提示分支要存在');
  assert.ok(jmBranch.includes('DEFAULT_CATALOG_LINES'), '固定话术要接上');
  assert.ok(!indexSource.slice(0, jmBranchStart).includes('parseCatalogCommand(message.content'),
    '收藏解析不能被放到父开关之外');

  const configSource = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
  assert.ok(configSource.includes('QQBOT_CATALOG_DB'), 'catalog.dbPath 必须来自配置');
  assert.ok(configSource.includes('QQBOT_CATALOG_PAGE_SIZE'), '分页大小必须来自配置');
  const jmServiceSource = fs.readFileSync(path.join(root, 'src', 'jm-service.js'), 'utf8');
  assert.ok(jmServiceSource.includes("kind: 'instance'"), 'library 必须按实例作用域创建');

  const commandsSource = fs.readFileSync(path.join(root, 'src', 'commands.js'), 'utf8');
  assert.ok(commandsSource.includes('parseCatalogCommand'), '命令表必须登记收藏指令');
  const doc = fs.readFileSync(path.join(root, 'docs', '命令与关键字.md'), 'utf8');
  assert.ok(doc.includes('收藏 <条目ID>'), '生成的命令文档必须含收藏行（改了要重跑 command-index --write）');

  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.ok(env.includes('QQBOT_CATALOG_DB='), '.env.example 缺 QQBOT_CATALOG_DB');
  assert.ok(env.includes('QQBOT_CATALOG_PAGE_SIZE='), '.env.example 缺 QQBOT_CATALOG_PAGE_SIZE');

  // 收藏/筛选路径不得出现下载或图片请求：数据层/服务层源码里不能有 fetch/--op download/pdf。
  for (const file of ['catalog-store.js', 'catalog-command.js', 'catalog-service.js', 'jm-catalog.js']) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.equal(/\bfetch\s*\(/u.test(source), false, `${file} 不允许直接 fetch`);
    assert.equal(/--op['"\s]+(?:download|pdf)/u.test(source), false, `${file} 不允许 download/pdf`);
    assert.equal(/node:https?/u.test(source), false, `${file} 不允许直接网络模块`);
  }
});

export function registerCatalogTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerCatalogTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

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
