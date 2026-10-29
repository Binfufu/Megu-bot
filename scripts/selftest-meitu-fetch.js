/**
 * 图源纯函数 + 落盘规则的判据(2026-10-23 / 代码层发图)。
 *
 * 跑法:
 *
 *     node scripts\selftest-meitu-fetch.js
 *
 * 不联网、不 spawn、不写真 D 盘(目录用 %TEMP%)。钉:
 *   ① URL 构造(Danbooru / Safebooru 的 tags、limit、page/pid);
 *   ② 归一化(post → 统一形状);
 *   ③ 黑名单 fail-closed(`oppai_loli` / `lolicon` / `child_on_child` / `aged_down` 都要命中);
 *   ④ rating 白名单 + requireTags;
 *   ⑤ pickNewPosts:score 降序、去重、跳过已存在、只认 jpg/jpeg/png;
 *   ⑥ 文件名 / 扩展名;
 *   ⑦ 角色目录消毒(Windows 非法字符、路径穿越、保留设备名、长度);
 *   ⑧ ensureCharDir 大小写不敏感复用,且穿越不出去;
 *   ⑨ 跨源 md5 去重(dedupeByMd5:留 danbooru / 高 score / 小 id;无 md5 保留不参与);
 *   ⑩ 旁挂 md5 索引(.md5-index.json:缺失/坏 JSON 兜空、落后重扫重建、add 合并写读回、
 *     filterUnseen 命中过滤、固定内容文件的已知 md5 对拍);
 *   ⑪ searchRungs 检索编排(src\meitu-fetch-core.js,2026-10-27 修「假没图」):
 *     提前停止必须数**去重后可用**的新图 —— 历史 md5 换图源/批内同图/不支持扩展名
 *     都不许把预算吃满,后续 rung 必须真被查询。
 *   ⑫ 翻页游标(src\meitu-cursor.js + searchRungs cursor,2026-10-28「热门续查」):
 *     从游标页接着扫、按 rung 分键、见底回卷 0、失败页不推进、预算满只记翻过的页;
 *     旁挂游标文件缺失/坏 JSON 兜空、合并写、非法键逐个丢。
 *   ⑬ 按群去重(2026-10-28):isSeenPost(md5 命中/退 source:id)、reuseTargetFor
 *     (同名文件/md5 索引别名/都没有)、reuseOnDisk(盘上已有文件算可用,预算不空转)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_EXTS,
  MINOR_TAGS,
  buildDanbooruUrl,
  buildRungs,
  buildSafebooruUrl,
  dedupeByMd5,
  extFromUrl,
  filterPosts,
  isBlockedPost,
  normalizeDanbooruPost,
  normalizeMd5,
  normalizeSafebooruPost,
  pickNewPosts,
} from '../src/meitu-search.js';
import { INDEX_FILE, addMd5Entries, filterUnseen, loadMd5Index } from '../src/meitu-index.js';
import { isSeenPost, reuseTargetFor, rungCursorKey, searchRungs } from '../src/meitu-fetch-core.js';
import { CURSOR_FILE, loadCursor, updateCursor } from '../src/meitu-cursor.js';
import { TIER_DIRS, ensureCharDir, imageFileName, sanitizeCharFolder } from '../src/meitu-store.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------------------------------------------------------------------------
// ① URL
// ---------------------------------------------------------------------------

test('meitu-search:Danbooru URL —— 角色 + 第一个修饰,tag 总数 ≤2', () => {
  const url = new URL(buildDanbooruUrl({ charTag: 'demo_a', tags: ['feet', 'long_hair'], page: 2 }));
  assert.equal(url.origin + url.pathname, 'https://danbooru.donmai.us/posts.json');
  assert.equal(url.searchParams.get('tags'), 'demo_a feet');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('page'), '2');
});

test('meitu-search:Danbooru URL —— 没有修饰时默认 rating:questionable,page 默认 1', () => {
  const url = new URL(buildDanbooruUrl({ charTag: 'demo_b' }));
  assert.equal(url.searchParams.get('tags'), 'demo_b rating:questionable');
  assert.equal(url.searchParams.get('page'), '1');
  // 显式空数组 = "只要角色本身"(抓取器的 general 兜底 rung)。
  const bare = new URL(buildDanbooruUrl({ charTag: 'demo_b', tags: [] }));
  assert.equal(bare.searchParams.get('tags'), 'demo_b');
});

test('meitu-search:Safebooru URL —— char + tags + sort:score,pid 从 0 起', () => {
  const url = new URL(buildSafebooruUrl({ charTag: 'demo_a', tags: ['feet', 'rating:questionable'], pid: 3 }));
  assert.equal(url.origin + url.pathname, 'https://safebooru.org/index.php');
  assert.equal(url.searchParams.get('page'), 'dapi');
  assert.equal(url.searchParams.get('s'), 'post');
  assert.equal(url.searchParams.get('q'), 'index');
  assert.equal(url.searchParams.get('json'), '1');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('pid'), '3');
  assert.equal(url.searchParams.get('tags'), 'demo_a feet rating:questionable sort:score');
});

// ---------------------------------------------------------------------------
// ② 归一化
// ---------------------------------------------------------------------------

test('meitu-search:Danbooru post 归一化(rating 字母 g/s/q/e → 整词;字段一个不少)', () => {
  const post = normalizeDanbooruPost({
    id: 123,
    rating: 'S',
    tag_string: 'demo_a feet long_hair',
    file_url: 'https://cdn.donmai.us/original/ab/cd/abcd.jpg',
    file_ext: '.JPG',
    score: 42,
    image_width: 1200,
    image_height: 1600,
  });
  assert.deepEqual(post, {
    source: 'danbooru',
    id: 123,
    rating: 'sensitive',
    tags: 'demo_a feet long_hair',
    url: 'https://cdn.donmai.us/original/ab/cd/abcd.jpg',
    ext: 'jpg',
    md5: '', // 这条 post 没带 md5 → 空串(单独有"取 md5/hash"的判据)
    score: 42,
    width: 1200,
    height: 1600,
  });
  // 四个档位都要对上(真跑 dry 探针时发现 API 给的是字母,不是整词)。
  assert.equal(normalizeDanbooruPost({ rating: 'g' }).rating, 'general');
  assert.equal(normalizeDanbooruPost({ rating: 'q' }).rating, 'questionable');
  assert.equal(normalizeDanbooruPost({ rating: 'e' }).rating, 'explicit');
});

test('meitu-search:Safebooru post 归一化(扩展名从 file_url 取)', () => {
  const post = normalizeSafebooruPost({
    id: '9',
    rating: 'questionable',
    tags: 'demo_a feet',
    file_url: 'https://safebooru.org/images/12/abc.PNG?123',
    score: '5',
    width: '800',
    height: '600',
  });
  assert.equal(post.source, 'safebooru');
  assert.equal(post.id, 9);
  assert.equal(post.rating, 'questionable');
  assert.equal(post.tags, 'demo_a feet');
  assert.equal(post.ext, 'png');
  assert.equal(post.score, 5);
  assert.equal(post.width, 800);
  assert.equal(post.height, 600);
});

// ---------------------------------------------------------------------------
// ③ 黑名单 fail-closed
// ---------------------------------------------------------------------------

test('meitu-search:黑名单 fail-closed —— oppai_loli / lolicon / child_on_child 都命中', () => {
  assert.equal(isBlockedPost({ tags: 'oppai_loli feet' }), true);
  assert.equal(isBlockedPost({ tags: 'lolicon big_breasts' }), true);
  assert.equal(isBlockedPost({ tags: 'child_on_child' }), true);
  assert.equal(isBlockedPost({ tags: 'aged_down' }), true);
  assert.equal(isBlockedPost({ tags: 'demo_a child' }), true);
  assert.equal(isBlockedPost({ tags: 'shota eyes' }), true);
  assert.equal(isBlockedPost({ tags: 'demo_a feet long_hair' }), false);
  // fail-closed:标签整个缺失/空 → 拦(没法核对就不发)。
  assert.equal(isBlockedPost({}), true);
  assert.equal(isBlockedPost({ tags: '' }), true);
});

test('meitu-search:黑名单是前缀/后缀级 —— 组合词也拦', () => {
  assert.equal(isBlockedPost({ tags: 'notloli_suffix' }), true, '后缀命中');
  assert.equal(isBlockedPost({ tags: 'underage_look' }), true, '前缀命中');
  assert.ok(MINOR_TAGS.includes('loli') && MINOR_TAGS.includes('cub'));
});

// ---------------------------------------------------------------------------
// ④ filterPosts
// ---------------------------------------------------------------------------

const post = (overrides) => ({
  source: 'danbooru',
  id: 1,
  rating: 'questionable',
  tags: 'demo_a feet',
  url: 'https://example.invalid/a.jpg',
  ext: 'jpg',
  score: 10,
  ...overrides,
});

test('meitu-search:filterPosts —— explicit 不在白名单里就丢(两个图源都不收 explicit)', () => {
  const kept = filterPosts([
    post({ id: 1, rating: 'questionable' }),
    post({ id: 2, rating: 'sensitive' }),
    post({ id: 3, rating: 'explicit' }),
    post({ id: 4, rating: 'general' }),
  ], { ratingAllow: ['sensitive', 'questionable'] });
  assert.deepEqual(kept.map((p) => p.id), [1, 2]);
});

test('meitu-search:filterPosts —— requireTags 是"必须都带"(整 tag 匹配,不拆下划线)', () => {
  const kept = filterPosts([
    post({ id: 1, tags: 'demo_a feet' }),
    post({ id: 2, tags: 'demo_a' }),
    post({ id: 3, tags: 'demo_a feet long_hair' }),
  ], { ratingAllow: ['questionable'], requireTags: ['demo_a', 'feet'] });
  assert.deepEqual(kept.map((p) => p.id), [1, 3]);
});

test('meitu-search:filterPosts —— 黑名单在 rating/tag 之后执行,命中即整张丢', () => {
  const kept = filterPosts([
    post({ id: 1, tags: 'demo_a feet' }),
    post({ id: 2, tags: 'demo_a feet loli' }),
    post({ id: 3, tags: 'demo_a feet oppai_loli' }),
  ], { ratingAllow: ['questionable'], requireTags: ['demo_a'] });
  assert.deepEqual(kept.map((p) => p.id), [1]);
});

// ---------------------------------------------------------------------------
// ⑤ pickNewPosts
// ---------------------------------------------------------------------------

test('meitu-search:pickNewPosts —— score 降序、去重、上限、跳过已存在', () => {
  const posts = [
    post({ id: 1, score: 5 }),
    post({ id: 2, score: 50 }),
    post({ id: 2, score: 50 }), // 同图源同 id 的重复
    post({ id: 3, score: 20 }),
    post({ id: 4, score: 99 }), // 已存在
    post({ id: 5, score: 100, ext: 'gif' }), // 扩展名不认
  ];
  const picked = pickNewPosts(posts, { count: 3, fileExists: (p) => p.id === 4 });
  assert.deepEqual(picked.map((p) => p.id), [2, 3, 1]);
});

test('meitu-search:pickNewPosts —— 没给 fileExists 就全当新图;count 至少 1', () => {
  const posts = [post({ id: 1 }), post({ id: 2 })];
  assert.deepEqual(pickNewPosts(posts, { count: 0 }).map((p) => p.id), [1]);
  assert.deepEqual(pickNewPosts(posts, {}).map((p) => p.id), [1]);
});

// ---------------------------------------------------------------------------
// ⑤' buildRungs(2026-10-23 从 CLI 挪进 src;被拦降档的档位覆盖也在这层)
// ---------------------------------------------------------------------------

test('meitu-search:buildRungs —— 不给 override 与旧 CLI 实现逐字节一致', () => {
  const rungs = buildRungs({ charTag: 'demo_a', tags: ['feet'], source: 'auto', proxyReady: true });
  assert.deepEqual(rungs, [
    { source: 'danbooru', tags: ['feet'], ratingAllow: ['sensitive', 'questionable'] },
    { source: 'danbooru', tags: ['rating:questionable'], ratingAllow: ['sensitive', 'questionable'] },
    { source: 'danbooru', tags: ['rating:sensitive'], ratingAllow: ['sensitive', 'questionable'] },
    { source: 'danbooru', tags: [], ratingAllow: ['general'] },
    { source: 'safebooru', tags: ['feet', 'rating:questionable'], ratingAllow: ['questionable'] },
    { source: 'safebooru', tags: ['rating:questionable'], ratingAllow: ['questionable'] },
    { source: 'safebooru', tags: [], ratingAllow: ['safe'] },
  ]);

  // 无修饰:danbooru 的首 rung 靠 rating:questionable 限定,其余同上。
  const bare = buildRungs({ charTag: 'x', tags: [], source: 'auto', proxyReady: true });
  assert.deepEqual(bare, [
    { source: 'danbooru', tags: ['rating:questionable'], ratingAllow: ['sensitive', 'questionable'] },
    { source: 'danbooru', tags: ['rating:sensitive'], ratingAllow: ['sensitive', 'questionable'] },
    { source: 'danbooru', tags: [], ratingAllow: ['general'] },
    { source: 'safebooru', tags: ['rating:questionable'], ratingAllow: ['questionable'] },
    { source: 'safebooru', tags: [], ratingAllow: ['safe'] },
  ]);
});

test('meitu-search:buildRungs —— 图源资格(auto=代理才带 danbooru;显式 danbooru 无代理也试直连)', () => {
  const noProxy = buildRungs({ charTag: 'x', tags: ['feet'], source: 'auto', proxyReady: false });
  assert.ok(noProxy.every((r) => r.source === 'safebooru'), '代理不可用时 danbooru 不进候选');

  const forced = buildRungs({ charTag: 'x', tags: ['feet'], source: 'danbooru', proxyReady: false });
  assert.ok(forced.length > 0 && forced.every((r) => r.source === 'danbooru'), '显式 danbooru = 无代理也试直连');

  const onlySafe = buildRungs({ charTag: 'x', tags: ['feet'], source: 'safebooru', proxyReady: true });
  assert.ok(onlySafe.every((r) => r.source === 'safebooru') && onlySafe.length === 3);
});

test('meitu-search:buildRungs —— ratingOverride=general:所有 rung 换档,tags 的 rating:* 剔除,塌缩去重', () => {
  const rungs = buildRungs({
    charTag: 'demo_a',
    tags: ['feet'],
    source: 'auto',
    proxyReady: true,
    ratingOverride: ['general'],
  });
  assert.ok(rungs.length > 0);
  for (const rung of rungs) {
    assert.ok(
      rung.tags.every((tag) => !/^rating:/iu.test(tag)),
      `override 下 tags 不许再带 rating:*(查 questionable 再用 general 过滤永远空):${rung.tags}`,
    );
    assert.deepEqual(
      rung.ratingAllow,
      rung.source === 'safebooru' ? ['safe'] : ['general'],
      '映射规则在 search 层:danbooru 用原词,safebooru 的 general → safe',
    );
  }
  // danbooru 的 questionable/sensitive/兜底三个 rung 换档后塌成同一条,只查一遍。
  assert.deepEqual(
    rungs.filter((r) => r.source === 'danbooru').map((r) => r.tags),
    [['feet'], []],
  );
  // safebooru 同理:tags 里的 rating:questionable 剔掉。
  assert.deepEqual(
    rungs.filter((r) => r.source === 'safebooru').map((r) => r.tags),
    [['feet'], []],
  );
});

test('meitu-search:buildRungs —— override 收单串也认;空/空白 override = 没给(与现状一致)', () => {
  const single = buildRungs({
    charTag: 'x', tags: [], source: 'safebooru', proxyReady: false, ratingOverride: 'general',
  });
  assert.ok(single.every((r) => r.ratingAllow.includes('safe')));

  const blank = buildRungs({
    charTag: 'x', tags: ['feet'], source: 'auto', proxyReady: true, ratingOverride: ['  '],
  });
  assert.deepEqual(blank, buildRungs({ charTag: 'x', tags: ['feet'], source: 'auto', proxyReady: true }));
});

// ---------------------------------------------------------------------------
// ⑤'' 档位(1.181.0):美图=全年龄唯美(g/s / safe),涩图=现状擦边(s/q)
// ---------------------------------------------------------------------------

test('meitu-search:buildRungs tier=meitu —— danbooru g+s(safebooru safe),永不收 questionable/explicit', () => {
  const withTag = buildRungs({ charTag: 'demo_a_(demo_group)', tags: ['feet'], source: 'auto', proxyReady: true, tier: 'meitu' });
  assert.deepEqual(withTag, [
    { source: 'danbooru', tags: ['feet'], ratingAllow: ['general', 'sensitive'] },
    { source: 'danbooru', tags: ['rating:s'], ratingAllow: ['general', 'sensitive'] },
    { source: 'danbooru', tags: [], ratingAllow: ['general'] },
    { source: 'safebooru', tags: ['feet', 'rating:safe'], ratingAllow: ['safe'] },
    { source: 'safebooru', tags: ['rating:safe'], ratingAllow: ['safe'] },
  ]);

  // 无修饰:首 rung 直接 rating:s 收偏上的唯美。
  const bare = buildRungs({ charTag: 'x', tags: [], source: 'auto', proxyReady: true, tier: 'meitu' });
  assert.deepEqual(bare, [
    { source: 'danbooru', tags: ['rating:s'], ratingAllow: ['general', 'sensitive'] },
    { source: 'danbooru', tags: [], ratingAllow: ['general'] },
    { source: 'safebooru', tags: ['rating:safe'], ratingAllow: ['safe'] },
  ]);

  // 任何 rung 都不许出现 questionable / explicit。
  for (const tier of ['meitu', 'seitu']) {
    for (const rung of buildRungs({ charTag: 'x', tags: ['feet'], source: 'auto', proxyReady: true, tier })) {
      assert.ok(!rung.ratingAllow.includes('explicit'), 'explicit 任何档都不收');
      if (tier === 'meitu') {
        assert.ok(!rung.ratingAllow.includes('questionable'), '美图档不许收 questionable');
      }
    }
  }
});

test('meitu-search:buildRungs tier=meitu + ratingOverride —— 被拦降档在美图档同样可用', () => {
  const rungs = buildRungs({
    charTag: 'x', tags: ['feet'], source: 'auto', proxyReady: true, tier: 'meitu', ratingOverride: ['general'],
  });
  for (const rung of rungs) {
    assert.deepEqual(rung.ratingAllow, rung.source === 'safebooru' ? ['safe'] : ['general']);
    assert.ok(rung.tags.every((tag) => !/^rating:/iu.test(tag)), 'override 下 rating:* 剔除');
  }
  // rating:s rung 换档后与纯全年龄兜底塌缩,只查一遍。
  assert.deepEqual(
    rungs.filter((r) => r.source === 'danbooru').map((r) => r.tags),
    [['feet'], []],
  );
});

// ---------------------------------------------------------------------------
// ⑤''' 跨源 md5 去重 + 旁挂 md5 索引(2026-10-23 第二刀;主人拍板)
// ---------------------------------------------------------------------------

/** 合法的 32 位十六进制 md5 常量(去重用;1/2/3/4 只是"不同的 md5")。 */
const M1 = 'a'.repeat(32);
const M2 = 'b'.repeat(32);
const M3 = 'c'.repeat(32);
const M4 = 'd'.repeat(32);

/** 固定内容文件的 md5 **已知值**(写死对拍:变了就说明 md5 算错了,不是测试过时)。 */
const MD5_HELLO = '5d41402abc4b2a76b9719d911017c592'; // "hello"
const MD5_ABC = '900150983cd24fb0d6963f7d28e17f72'; // "abc"

/** 建一个临时角色目录;调用方在 finally 里 rm。 */
function makeTempDir(prefix = 'qqbot-md5-idx-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 往目录里放一个"图片"(内容随便,扩展名对就行;md5 断言只看内容)。 */
function writeImage(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return path.join(dir, name);
}

test('meitu-search:normalize 取 md5(Danbooru)/hash(Safebooru),大小写归一、缺失给空串', () => {
  assert.equal(
    normalizeDanbooruPost({ id: 1, md5: 'ABCDEF0123456789ABCDEF0123456789' }).md5,
    'abcdef0123456789abcdef0123456789',
  );
  assert.equal(
    normalizeSafebooruPost({ id: 2, hash: 'FEDCBA9876543210FEDCBA9876543210' }).md5,
    'fedcba9876543210fedcba9876543210',
    'Safebooru 的字段名叫 hash,不是 md5',
  );
  // 字段缺失 / 不是字符串 → 空串(不参与去重,靠文件名兜底)。
  assert.equal(normalizeDanbooruPost({ id: 3 }).md5, '');
  assert.equal(normalizeSafebooruPost({ id: 4 }).md5, '');
  assert.equal(normalizeDanbooruPost({ id: 5, md5: 123 }).md5, '');
  assert.equal(normalizeSafebooruPost({ id: 6, hash: null }).md5, '');
  // 形状判据只有一份(normalizeMd5):非法长度/非十六进制 → 空串。
  assert.equal(normalizeMd5(' ABCDEF0123456789ABCDEF0123456789 '), 'abcdef0123456789abcdef0123456789');
  assert.equal(normalizeMd5('deadbeef'), '');
  assert.equal(normalizeMd5('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), '');
  assert.equal(normalizeMd5(null), '');
});

test('meitu-search:dedupeByMd5 —— 跨源同 md5 留 danbooru(哪怕 safebooru 的 score 更高)', () => {
  const safebooruPost = post({ source: 'safebooru', id: 9, md5: M1, score: 999 });
  const danbooruPost = post({ source: 'danbooru', id: 5, md5: M1, score: 1 });
  const { kept, dropped } = dedupeByMd5([safebooruPost, danbooruPost]);
  assert.deepEqual(kept.map((p) => `${p.source}:${p.id}`), ['danbooru:5']);
  assert.deepEqual(dropped.map((p) => `${p.source}:${p.id}`), ['safebooru:9']);
});

test('meitu-search:dedupeByMd5 —— 同源同 md5 留 score 高者,再 id 小者', () => {
  const byScore = dedupeByMd5([
    post({ id: 7, md5: M2, score: 1 }),
    post({ id: 8, md5: M2, score: 50 }),
    post({ id: 6, md5: M2, score: 49 }),
  ]);
  assert.deepEqual(byScore.kept.map((p) => p.id), [8]);
  assert.deepEqual(byScore.dropped.map((p) => p.id).sort(), [6, 7]);

  const byId = dedupeByMd5([
    post({ id: 30, md5: M3, score: 5 }),
    post({ id: 4, md5: M3, score: 5 }),
  ]);
  assert.deepEqual(byId.kept.map((p) => p.id), [4], 'score 打平时 id 小者留');
});

test('meitu-search:dedupeByMd5 —— 无 md5(或 md5 非法)的帖子原样保留,不参与去重', () => {
  const { kept, dropped } = dedupeByMd5([
    post({ id: 1 }),
    post({ id: 1 }), // 无 md5:同 id 也不在这层去重(文件名兜底)
    post({ id: 2, md5: '' }),
    post({ id: 3, md5: 'not-an-md5' }),
  ]);
  assert.deepEqual(kept.map((p) => p.id), [1, 1, 2, 3]);
  assert.equal(dropped.length, 0);
});

test('meitu-search:dedupeByMd5 —— 多组互不干扰,kept 保持入参顺序', () => {
  const { kept, dropped } = dedupeByMd5([
    post({ source: 'safebooru', id: 1, md5: M1 }),
    post({ source: 'danbooru', id: 2, md5: M1 }),
    post({ source: 'danbooru', id: 3, md5: M3 }),
    post({ source: 'safebooru', id: 4, md5: M3 }),
    post({ source: 'safebooru', id: 5, md5: M4 }),
    post({ source: 'danbooru', id: 6 }), // 无 md5:保留
  ]);
  assert.deepEqual(kept.map((p) => `${p.source}:${p.id}`), [
    'danbooru:2', 'danbooru:3', 'safebooru:5', 'danbooru:6',
  ]);
  assert.deepEqual(dropped.map((p) => `${p.source}:${p.id}`).sort(), ['safebooru:1', 'safebooru:4']);
});

test('meitu-index:索引缺失 = 空索引、rebuilt=false;空目录不凭空写索引文件', () => {
  const dir = makeTempDir();
  try {
    const loaded = loadMd5Index(dir);
    assert.equal(loaded.rebuilt, false);
    assert.equal(loaded.entries.size, 0);
    assert.equal(fs.existsSync(path.join(dir, INDEX_FILE)), false, '空目录不该建索引');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meitu-index:坏 JSON / 形状不对 = 当空索引、不抛', () => {
  const badJson = makeTempDir();
  const badShape = makeTempDir();
  try {
    fs.writeFileSync(path.join(badJson, INDEX_FILE), '{ 这不是 json');
    assert.doesNotThrow(() => loadMd5Index(badJson));
    const loaded = loadMd5Index(badJson);
    assert.equal(loaded.entries.size, 0);
    assert.equal(loaded.rebuilt, false);

    // 版本不认识 = 形状不对(宁可当空重扫,也不猜旧/新格式)。
    fs.writeFileSync(path.join(badShape, INDEX_FILE), JSON.stringify({
      version: 2, entries: { [M1]: 'danbooru_1.jpg' }, updatedAt: new Date().toISOString(),
    }));
    assert.equal(loadMd5Index(badShape).entries.size, 0);

    // 坏 JSON 但目录里有图:不抛,而且会重扫出真条目(自愈)。
    const selfHeal = makeTempDir();
    try {
      fs.writeFileSync(path.join(selfHeal, INDEX_FILE), 'null');
      writeImage(selfHeal, 'danbooru_1.jpg', 'hello');
      const healed = loadMd5Index(selfHeal);
      assert.equal(healed.rebuilt, true);
      assert.equal(healed.entries.size, 1);
      assert.equal(healed.entries.get(MD5_HELLO), 'danbooru_1.jpg');
    } finally {
      fs.rmSync(selfHeal, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(badJson, { recursive: true, force: true });
    fs.rmSync(badShape, { recursive: true, force: true });
  }
});

test('meitu-index:条目数落后(目录 2 张图、索引 1 条)→ rebuilt=true 且重扫出 2 条', () => {
  const dir = makeTempDir();
  try {
    writeImage(dir, 'danbooru_1.jpg', 'hello');
    writeImage(dir, 'safebooru_2.png', 'abc');
    fs.mkdirSync(path.join(dir, '文件夹看图.jpg')); // 同名目录不算图(Dirent.isFile)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
    // 旧索引只记得 1 条(模拟"上一版还没有索引/漏记")。
    fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({
      version: 1, entries: { [M1]: 'danbooru_1.jpg' }, updatedAt: new Date().toISOString(),
    }));

    const loaded = loadMd5Index(dir);
    assert.equal(loaded.rebuilt, true);
    assert.equal(loaded.entries.size, 2, '按实际图片数重扫,不是 1');
    // 固定内容 → 写死的已知 md5 对拍。
    assert.equal(loaded.entries.get(MD5_HELLO), 'danbooru_1.jpg');
    assert.equal(loaded.entries.get(MD5_ABC), 'safebooru_2.png');

    // 重建结果已原子写盘(且没有留下 .tmp)。
    assert.equal(fs.existsSync(path.join(dir, `${INDEX_FILE}.tmp`)), false);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(Object.keys(saved.entries).length, 2);
    assert.equal(typeof saved.updatedAt, 'string');

    // 再加载一次:索引完整了 → 不再重建。
    const again = loadMd5Index(dir);
    assert.equal(again.rebuilt, false);
    assert.equal(again.entries.size, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meitu-index:条数凑巧够但有图没进索引 → 也重建(删一张又下一张也不会漏)', () => {
  const dir = makeTempDir();
  try {
    writeImage(dir, 'danbooru_1.jpg', 'hello');
    writeImage(dir, 'safebooru_2.png', 'abc');
    // 2 条 ≥ 2 张图,但其中一条指向已删除的旧文件 → 有一张真图没被任何条目指到。
    fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({
      version: 1,
      entries: { [M1]: 'danbooru_1.jpg', [M2]: 'deleted_old.jpg' },
      updatedAt: new Date().toISOString(),
    }));
    const loaded = loadMd5Index(dir);
    assert.equal(loaded.rebuilt, true, '条数够但覆盖不全也算落后');
    assert.equal(loaded.entries.size, 2);
    assert.equal(loaded.entries.get(MD5_HELLO), 'danbooru_1.jpg');
    assert.equal(loaded.entries.get(MD5_ABC), 'safebooru_2.png');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meitu-index:write=false 的重建只读不写(--dry 探针不污染角色目录)', () => {
  const dir = makeTempDir();
  try {
    writeImage(dir, 'danbooru_1.jpg', 'hello');
    const dry = loadMd5Index(dir, { write: false });
    assert.equal(dry.rebuilt, true);
    assert.equal(dry.entries.size, 1);
    assert.equal(fs.existsSync(path.join(dir, INDEX_FILE)), false, 'dry 不许写盘');

    const written = loadMd5Index(dir, { write: true });
    assert.equal(written.rebuilt, true, '上次没写,这次仍算落后');
    assert.ok(fs.existsSync(path.join(dir, INDEX_FILE)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meitu-index:addMd5Entries 合并写盘(不覆盖已有)+ 读回 + filterUnseen 命中过滤', () => {
  const dir = makeTempDir();
  try {
    const first = addMd5Entries(dir, new Map([[M1, 'danbooru_1.jpg']]));
    assert.equal(first.ok, true);
    assert.equal(first.added, 1);
    assert.equal(first.count, 1);

    // 对象形状也收;第二次是"合并"不是覆盖。
    const second = addMd5Entries(dir, { [M2]: 'safebooru_2.png' });
    assert.equal(second.ok, true);
    assert.equal(second.added, 1);
    assert.equal(second.count, 2);

    // 重复项不重复写(added=0),仍然 ok。
    const third = addMd5Entries(dir, { [M1]: 'danbooru_1.jpg' });
    assert.equal(third.added, 0);
    assert.equal(third.count, 2);

    const loaded = loadMd5Index(dir); // 目录里没有真图:索引完整即原样读回
    assert.equal(loaded.rebuilt, false);
    assert.equal(loaded.entries.size, 2);
    assert.equal(loaded.entries.get(M1), 'danbooru_1.jpg');
    assert.equal(loaded.entries.get(M2), 'safebooru_2.png');

    // filterUnseen:命中索引的丢,没见过的/无 md5 的留。
    const filtered = filterUnseen(
      [{ md5: M1 }, { md5: M2 }, { md5: M3 }, { md5: '' }, {}],
      loaded.entries,
    );
    assert.deepEqual(filtered.kept.map((p) => p.md5), [M3, '', undefined]);
    assert.deepEqual(filtered.dropped.map((p) => p.md5), [M1, M2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meitu-index:写不进去只 warn 不抛(目录不存在/被占也安全)', () => {
  const dir = makeTempDir();
  try {
    const missing = path.join(dir, 'no-such-dir');
    let warned = '';
    const result = addMd5Entries(missing, { [M1]: 'danbooru_1.jpg' }, { log: (msg) => { warned = msg; } });
    assert.equal(result.ok, false);
    assert.ok(warned.includes('md5 索引写盘失败'), `写失败要 warn:${warned}`);
    // 读索引同理:目录不存在 = 空索引,不抛。
    assert.equal(loadMd5Index(missing).entries.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('meitu-store:文件名 = 图源_id.扩展名(ext 带不带点都认)', () => {
  assert.equal(imageFileName('danbooru', 123, 'jpg'), 'danbooru_123.jpg');
  assert.equal(imageFileName('safebooru', '9', '.png'), 'safebooru_9.png');
  assert.equal(imageFileName('danbooru', 1, ''), 'danbooru_1');
  assert.deepEqual(IMAGE_EXTS, ['jpg', 'jpeg', 'png']);
});

test('meitu-search:extFromUrl 只认 jpg/jpeg/png(带查询串/大小写都行)', () => {
  assert.equal(extFromUrl('https://x/a/b.JPG?token=1'), 'jpg');
  assert.equal(extFromUrl('https://x/a/b.jpeg'), 'jpeg');
  assert.equal(extFromUrl('https://x/a/b.png#frag'), 'png');
  assert.equal(extFromUrl('https://x/a/b.gif'), '');
  assert.equal(extFromUrl('https://x/a/b.webp'), '');
  assert.equal(extFromUrl(''), '');
});

// ---------------------------------------------------------------------------
// ⑦ 目录消毒
// ---------------------------------------------------------------------------

test('meitu-store:sanitizeCharFolder —— 中文保留、Windows 非法字符变 _,首尾点/空格去掉', () => {
  assert.equal(sanitizeCharFolder('示例甲'), '示例甲');
  assert.equal(sanitizeCharFolder('a<>:"/\\|?*b'), 'a_________b');
  assert.equal(sanitizeCharFolder('  ...abc...  '), 'abc');
  assert.equal(sanitizeCharFolder('   '), '_');
});

test('meitu-store:sanitizeCharFolder —— 路径穿越被压成一个目录名', () => {
  const folder = sanitizeCharFolder('..\\..\\evil');
  assert.ok(!folder.includes('\\') && !folder.includes('/'), `不该有路径分隔符:${folder}`);
  assert.ok(!folder.startsWith('.'), `不该以点开头:${folder}`);
  assert.equal(folder, '_.._evil');
});

test('meitu-store:sanitizeCharFolder —— Windows 保留设备名前缀 _,长度 ≤60', () => {
  assert.equal(sanitizeCharFolder('con'), '_con');
  assert.equal(sanitizeCharFolder('COM1'), '_COM1');
  assert.equal(sanitizeCharFolder('NUL.txt'), '_NUL.txt');
  assert.equal(sanitizeCharFolder('x'.repeat(100)).length, 60);
});

test('meitu-store:ensureCharDir —— 大小写不敏感复用,穿越不出去(临时目录)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-meitu-dir-'));
  try {
    const first = await ensureCharDir(root, 'demo_b');
    assert.equal(first.folder, 'demo_b');
    assert.ok(fs.existsSync(first.dir));

    const second = await ensureCharDir(root, 'DEMO_B');
    assert.equal(second.folder, 'demo_b', 'Windows 大小写不敏感,要复用已有目录而不是建两份');
    assert.equal(second.dir, first.dir);

    const escaped = await ensureCharDir(root, '..\\..\\escape');
    const rootAbs = path.resolve(root);
    assert.ok(path.resolve(escaped.dir).startsWith(`${rootAbs}${path.sep}`), `不该写到根目录外:${escaped.dir}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('meitu-store:ensureCharDir 按档位分目录 —— 美图 r13 / 涩图 r18,档内仍按角色', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-meitu-tier-'));
  try {
    assert.deepEqual(TIER_DIRS, { meitu: 'r13', seitu: 'r18' }, '档位 → 目录名只有一份表');

    const meitu = await ensureCharDir(root, '示例甲', { tier: 'meitu' });
    assert.equal(meitu.tierDir, 'r13');
    assert.equal(meitu.folder, '示例甲');
    assert.equal(path.resolve(meitu.dir), path.join(root, 'r13', '示例甲'));
    assert.ok(fs.existsSync(meitu.dir), '档位目录与角色目录都要建出来');

    const seitu = await ensureCharDir(root, '示例甲', { tier: 'seitu' });
    assert.equal(seitu.tierDir, 'r18');
    assert.equal(path.resolve(seitu.dir), path.join(root, 'r18', '示例甲'));
    assert.notEqual(meitu.dir, seitu.dir, '两档互不串目录');

    // 档内大小写不敏感复用仍生效。
    const lower = await ensureCharDir(root, 'demo_b', { tier: 'meitu' });
    const upper = await ensureCharDir(root, 'DEMO_B', { tier: 'meitu' });
    assert.equal(upper.dir, lower.dir);

    // 未给/未知 tier = 旧结构(不分子目录,兼容旧调用与存量)。
    const legacy = await ensureCharDir(root, 'demo_b');
    assert.equal(legacy.tierDir, '');
    assert.equal(path.resolve(legacy.dir), path.join(root, 'demo_b'));
    const unknown = await ensureCharDir(root, 'demo_b', { tier: 'weird' });
    assert.equal(unknown.tierDir, '', '不认识的档位按旧结构走,不猜目录');
    // 穿越仍挡在根内。
    const escaped = await ensureCharDir(root, '..\\..\\escape', { tier: 'meitu' });
    assert.ok(path.resolve(escaped.dir).startsWith(`${path.resolve(root)}${path.sep}`), escaped.dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('meitu-index:extraDirs —— 历史目录(旧结构/另一档)的 md5 并入重建,filterUnseen 挡住', () => {
  const MD5_XYZ = 'd16fb36f0911f878998c136191af705e'; // "xyz"
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-meitu-extra-'));
  try {
    const tierDir = path.join(root, 'r13', '示例甲'); // 本档(新抓)
    const legacyDir = path.join(root, '示例甲'); // 旧结构存量
    const otherTierDir = path.join(root, 'r18', '示例甲'); // 另一档同角色
    writeImage(tierDir, 'danbooru_1.jpg', 'hello');
    writeImage(legacyDir, 'danbooru_2.jpg', 'abc');
    writeImage(otherTierDir, 'safebooru_3.png', 'xyz');

    const loaded = loadMd5Index(tierDir, {
      // 末尾那个不存在的目录 = 旧结构从没建过的情况,不许抛。
      extraDirs: [legacyDir, otherTierDir, path.join(root, 'no-such-char')],
    });
    assert.equal(loaded.rebuilt, true);
    assert.equal(loaded.entries.size, 3, '本档 + 旧结构 + 另一档 三边的 md5 都要并入');
    assert.equal(loaded.entries.get(MD5_HELLO), 'danbooru_1.jpg');
    assert.equal(loaded.entries.get(MD5_ABC), 'danbooru_2.jpg', '旧结构文件名原样记下');
    assert.equal(loaded.entries.get(MD5_XYZ), 'safebooru_3.png');

    // 完成判定只看本档:再读一次不再反复重建(历史目录不进本档图片列表)。
    const again = loadMd5Index(tierDir, { extraDirs: [legacyDir, otherTierDir] });
    assert.equal(again.rebuilt, false, '条目已覆盖本档,不许每轮都重扫');

    // 历史图上过的 md5 被挡掉(跨档/存量都不会再下一遍)。
    const filtered = filterUnseen([{ md5: MD5_HELLO }, { md5: MD5_ABC }, { md5: MD5_XYZ }], again.entries);
    assert.deepEqual(filtered.kept, []);
    assert.equal(filtered.dropped.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑪ searchRungs 检索编排(2026-10-27 修「假没图」)—— 全部假 fetchJson,不联网。
// ---------------------------------------------------------------------------

/** 按查询次序吐预置页的假图源;记录每次 URL,便于断言"后面的 rung 真被查了"。 */
function makeFakeFetch(pages) {
  const calls = [];
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(String(url));
      return pages[Math.min(calls.length - 1, pages.length - 1)];
    },
  };
}

const TEST_CHAR = 'test_character';
const TEST_RUNGS = [
  { source: 'danbooru', tags: ['rating:s'], ratingAllow: ['sensitive'] },
  { source: 'safebooru', tags: ['rating:safe'], ratingAllow: ['safe'] },
];
const fakeRungUrl = (rung, charTag, page) => (rung.source === 'danbooru'
  ? buildDanbooruUrl({ charTag, tags: rung.tags, page: page + 1 })
  : buildSafebooruUrl({ charTag, tags: rung.tags, pid: page }));
const danbooruPost = (id, md5, ext = 'jpg') => ({
  id, rating: 's', tag_string: `${TEST_CHAR} solo`,
  file_url: `https://cdn.test/${id}.${ext}`, file_ext: ext, md5, score: 10,
});
const safebooruPost = (id, md5, ext = 'jpg') => ({
  id, rating: 'safe', tags: `${TEST_CHAR} solo`,
  file_url: `https://safe.test/${id}.${ext}`, image: `${id}.${ext}`, hash: md5, score: 8,
});

test('meitu-fetch:searchRungs —— 首 rung 全是历史 md5 不许提前停,后续 rung 必须真被查询', async () => {
  const { calls, fetchJson } = makeFakeFetch([
    [danbooruPost(1, M2), danbooruPost(2, M3)], // 文件名全新,但 md5 全在历史索引里
    [safebooruPost(9, MD5_HELLO)], // 兜底源才有真新图
  ]);
  const result = await searchRungs({
    rungs: TEST_RUNGS,
    charTag: TEST_CHAR,
    count: 1,
    md5Known: new Map([[M2, 'old1.jpg'], [M3, 'old2.jpg']]),
    rungUrl: fakeRungUrl,
    fetchJson,
  });
  // 旧口径:首 rung 按文件名数出 2 张"新图" ≥ count×2 → 停,兜底源从未被查,回假 no_result。
  assert.equal(calls.length, 2, `第二个 rung 必须被查询(实际只查了 ${calls.length} 次)`);
  assert.ok(calls[1].includes('safebooru.org'), `第二查要落到兜底源:${calls.at(-1)}`);
  const unseen = filterUnseen(dedupeByMd5(result.collected).kept, new Map([[M2, 'o'], [M3, 'o']]));
  assert.deepEqual(
    pickNewPosts(unseen.kept, { count: 1 }).map((post) => post.id),
    [9],
    '去重后最终能拿到兜底源的真新图',
  );
});

test('meitu-fetch:searchRungs —— 不支持的扩展名不虚增预算(gif 不算新图)', async () => {
  const { calls, fetchJson } = makeFakeFetch([
    [danbooruPost(1, M1, 'gif'), danbooruPost(2, M4, 'gif')], // 都发不出去,不许算预算
    [safebooruPost(9, MD5_ABC)],
  ]);
  const result = await searchRungs({
    rungs: TEST_RUNGS,
    charTag: TEST_CHAR,
    count: 1,
    rungUrl: fakeRungUrl,
    fetchJson,
  });
  assert.equal(calls.length, 2, 'gif 不许吃满预算,第二个 rung 必须被查');
  assert.ok(result.collected.some((post) => post.source === 'safebooru'), '兜底源的图要进候选');
});

test('meitu-fetch:searchRungs —— 批内跨 md5 重复只算一张(同图重传不虚增预算)', async () => {
  const { calls, fetchJson } = makeFakeFetch([
    [danbooruPost(1, M1), danbooruPost(2, M1)], // 同一 md5 重传,去重后只有 1 张
    [safebooruPost(3, M4)],
  ]);
  await searchRungs({
    rungs: TEST_RUNGS,
    charTag: TEST_CHAR,
    count: 1,
    rungUrl: fakeRungUrl,
    fetchJson,
  });
  assert.equal(calls.length, 2, '批内去重后不足预算,第二个 rung 必须被查');
});

// ---------------------------------------------------------------------------
// ⑫ 翻页游标(2026-10-28「热门续查」)—— searchRungs 语义 + 旁挂文件。
// ---------------------------------------------------------------------------

// 复用 ⑪ 的 TEST_CHAR:danbooruPost/safebooruPost 助手的 tag_string 里写死的是它,
// requireTags 按这里的 charTag 过筛 —— 两处必须是同一个角色,否则候选全被筛掉(判据会咬)。
const CURSOR_TEST_CHAR = TEST_CHAR;
const CURSOR_RUNGS = [
  { source: 'danbooru', tags: ['rating:s'], ratingAllow: ['sensitive'] },
  { source: 'safebooru', tags: ['rating:safe'], ratingAllow: ['safe'] },
];
const KEY_DANBOORU = rungCursorKey(CURSOR_RUNGS[0]);
const KEY_SAFEBORU = rungCursorKey(CURSOR_RUNGS[1]);

test('meitu-fetch:rungCursorKey —— 同源不同查询分键,分页空间独立', () => {
  assert.notEqual(KEY_DANBOORU, KEY_SAFEBORU);
  assert.equal(rungCursorKey({ source: 'danbooru', tags: [] }), 'danbooru:', '兜底 rung 也有自己的键');
  assert.equal(rungCursorKey({ source: 'danbooru', tags: ['feet'] }), 'danbooru:feet');
});

test('meitu-fetch:searchRungs 游标 —— 从游标页接着扫,不再每次从第 1 页撞同一批', async () => {
  const calls = [];
  const result = await searchRungs({
    rungs: CURSOR_RUNGS,
    charTag: CURSOR_TEST_CHAR,
    count: 1,
    cursor: new Map([[KEY_DANBOORU, 2]]),
    rungUrl: fakeRungUrl,
    fetchJson: async (url) => {
      calls.push(String(url));
      return [danbooruPost(90, M2), safebooruPost(91, M3)];
    },
  });
  assert.ok(calls[0].includes('page=3'), `danbooru 要从游标页(index 2 → URL page 3)接着扫:${calls[0]}`);
  assert.ok(calls[1].includes('pid=0'), `没有游标的 rung 照旧从头扫:${calls[1]}`);
  assert.deepEqual(result.cursorUpdates.map((item) => item.key).sort(), [KEY_DANBOORU, KEY_SAFEBORU].sort());
  assert.deepEqual(
    result.cursorUpdates.find((item) => item.key === KEY_DANBOORU),
    { key: KEY_DANBOORU, value: 0 },
    '两页都不满 = 见底,回卷到 0',
  );
});

test('meitu-fetch:searchRungs 游标 —— 满页推进 = 起始页 + 翻过的页数', async () => {
  const calls = [];
  // 两页都是"历史已知"的帖子(预算一直不满),才能真翻满 2 页 —— 预算语义由上面那条管。
  const result = await searchRungs({
    rungs: [CURSOR_RUNGS[0]],
    charTag: CURSOR_TEST_CHAR,
    count: 1,
    cursor: new Map([[KEY_DANBOORU, 5]]),
    md5Known: new Map([[M1, 'a.jpg'], [M4, 'b.jpg']]),
    rungUrl: fakeRungUrl,
    pageLimit: 2,
    fetchJson: async (url) => {
      calls.push(String(url));
      return [danbooruPost(1, M1), danbooruPost(2, M4)]; // 恰好满页(2 = pageLimit)
    },
  });
  assert.ok(calls[0].includes('page=6'), calls[0]);
  assert.ok(calls[1].includes('page=7'), calls[1]);
  assert.deepEqual(result.cursorUpdates, [{ key: KEY_DANBOORU, value: 7 }], '5 + 2 页 = 7,下轮从 index 7 接着扫');
});

test('meitu-fetch:searchRungs 游标 —— 预算满只记翻过的页,没翻的页下轮还有', async () => {
  const calls = [];
  const result = await searchRungs({
    rungs: [CURSOR_RUNGS[0]],
    charTag: CURSOR_TEST_CHAR,
    count: 1, // 预算 = 2,第一页给 2 张就够
    cursor: new Map(),
    rungUrl: fakeRungUrl,
    pagesPerRung: 3,
    pageLimit: 2,
    fetchJson: async (url) => {
      calls.push(String(url));
      return [danbooruPost(1, M1), danbooruPost(2, M2)];
    },
  });
  assert.equal(calls.length, 1, '预算在第 1 页就够,不许翻第 2 页');
  assert.deepEqual(result.cursorUpdates, [{ key: KEY_DANBOORU, value: 1 }], '只推进到 0+1,第 2 页留给下轮');
});

test('meitu-fetch:searchRungs 游标 —— 查询失败不推进(失败页下轮重试)', async () => {
  const result = await searchRungs({
    rungs: [CURSOR_RUNGS[0]],
    charTag: CURSOR_TEST_CHAR,
    count: 1,
    cursor: new Map([[KEY_DANBOORU, 4]]),
    rungUrl: fakeRungUrl,
    fetchJson: async () => {
      throw new Error('HTTP 500');
    },
  });
  assert.deepEqual(result.cursorUpdates, [], '一页都没翻成,游标不许动');
});

test('meitu-cursor:旁挂游标文件 —— 缺失兜空、合并写、读回一致、非法键逐个丢', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-meitu-cursor-'));
  try {
    assert.equal(loadCursor(root).size, 0, '缺失 = 空游标');
    assert.equal(loadCursor(path.join(root, 'no-such-dir')).size, 0, '目录不存在也安全');

    updateCursor(root, [{ key: 'danbooru:rating:s', value: 3 }, { key: 'safebooru:rating:safe', value: 0 }]);
    const loaded = loadCursor(root);
    assert.equal(loaded.get('danbooru:rating:s'), 3);
    assert.equal(loaded.get('safebooru:rating:safe'), 0);

    // 合并而不是覆盖:第二个查询的游标不能冲掉第一个。
    updateCursor(root, [{ key: 'danbooru:rating:s', value: 5 }]);
    const merged = loadCursor(root);
    assert.equal(merged.get('danbooru:rating:s'), 5);
    assert.equal(merged.get('safebooru:rating:safe'), 0, '别的键原样保留');

    fs.writeFileSync(path.join(root, CURSOR_FILE), 'not json at all', 'utf8');
    assert.equal(loadCursor(root).size, 0, '坏 JSON = 空游标,不抛');

    updateCursor(root, [{ key: 'danbooru:rating:s', value: 2 }, { key: 'bad', value: -1 }, { key: '', value: 9 }, { key: 'x', value: 1.5 }]);
    const cleaned = loadCursor(root);
    assert.equal(cleaned.get('danbooru:rating:s'), 2);
    assert.equal(cleaned.has('bad'), false, '负数页不许进游标');
    assert.equal(cleaned.has('x'), false, '非整数页不许进游标');
    assert.equal(cleaned.size, 1, '空键被丢');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑬ 按群去重(2026-10-28)—— isSeenPost / reuseTargetFor / reuseOnDisk 预算语义。
// ---------------------------------------------------------------------------

test('meitu-fetch:isSeenPost —— md5 命中 / 没 md5 退 source:id / 账形状不对不误判', () => {
  const seen = { md5s: new Set(['c'.repeat(32)]), ids: new Set(['safebooru:9']) };
  assert.equal(isSeenPost({ source: 'danbooru', id: 1, md5: 'c'.repeat(32) }, seen), true, 'md5 命中 = 看过');
  assert.equal(isSeenPost({ source: 'danbooru', id: 1, md5: 'd'.repeat(32) }, seen), false, 'md5 不同 = 没看过');
  assert.equal(isSeenPost({ source: 'safebooru', id: 9 }, seen), true, '没 md5 的按 source:id');
  assert.equal(isSeenPost({ source: 'safebooru', id: 10 }, seen), false);
  assert.equal(isSeenPost({ source: 'danbooru', id: 1, md5: 'c'.repeat(32) }, undefined), false, '没有账 = 不误判');
  assert.equal(isSeenPost({ source: 'danbooru', id: 1, md5: 'c'.repeat(32) }, {}), false, '空账 = 不误判');
});

test('meitu-fetch:reuseTargetFor —— 同名文件 / md5 索引指到的别名 / 都没有', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-meitu-reuse-'));
  try {
    // ① 同源同 id 的标准文件名。
    fs.writeFileSync(path.join(root, 'danbooru_1.jpg'), 'x');
    assert.deepEqual(
      reuseTargetFor({ source: 'danbooru', id: 1, ext: 'jpg', md5: 'c'.repeat(32) }, root, new Map()),
      { path: path.join(root, 'danbooru_1.jpg'), via: 'filename' },
    );
    // ② 同一内容换图源收录过:标准文件名不在,md5 索引指到**另一个**文件名 → 复用那份。
    fs.writeFileSync(path.join(root, 'safebooru_legacy_5.png'), 'x');
    const entries = new Map([['e'.repeat(32), 'safebooru_legacy_5.png']]);
    assert.deepEqual(
      reuseTargetFor({ source: 'safebooru', id: 5, ext: 'png', md5: 'e'.repeat(32) }, root, entries),
      { path: path.join(root, 'safebooru_legacy_5.png'), via: 'md5-index' },
    );
    // ③ 索引指到的文件已经没了 = 不复用(宁重下,不发死路径)。
    const stale = new Map([['f'.repeat(32), 'deleted_9.jpg']]);
    assert.equal(reuseTargetFor({ source: 'danbooru', id: 9, ext: 'jpg', md5: 'f'.repeat(32) }, root, stale), null);
    // ④ 都没有 / 目录为空。
    assert.equal(reuseTargetFor({ source: 'safebooru', id: 6, ext: 'png', md5: 'f'.repeat(32) }, root, entries), null);
    assert.equal(reuseTargetFor({ source: 'danbooru', id: 1 }, ''), null, '空目录 = 不复用');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('meitu-fetch:searchRungs reuseOnDisk —— 盘上已有的文件算可用(按群复用发送)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-meitu-reuse-budget-'));
  try {
    // 两张候选盘上都已有(按旧全库口径 = 0 可用;按群口径 = 2 张可直接复用)。
    fs.writeFileSync(path.join(root, 'danbooru_1.jpg'), 'x');
    fs.writeFileSync(path.join(root, 'danbooru_2.jpg'), 'x');
    const diskPosts = () => [danbooruPost(1, M1), danbooruPost(2, M2)];
    const pages = [diskPosts(), [safebooruPost(9, MD5_HELLO)]]; // 第 2 页只在旧口径下才会被翻到
    const { calls, fetchJson } = makeFakeFetch(pages);
    const common = {
      rungs: TEST_RUNGS,
      charTag: TEST_CHAR,
      count: 1, // 预算 = 2
      outDir: root,
      rungUrl: fakeRungUrl,
      fetchJson,
    };
    const reuse = await searchRungs({ ...common, reuseOnDisk: true });
    assert.equal(calls.length, 1, `盘上已有的算可用,预算第 1 页就够(实际查了 ${calls.length} 次)`);
    assert.equal(reuse.collected.length, 2, '候选要保留(下载循环负责复用)');
    calls.length = 0;
    const legacy = await searchRungs(common);
    assert.ok(legacy.collected.length > 0, '旧口径也收集候选');
    assert.ok(calls.length >= 2, '旧口径盘上已有的不算可用,要翻到第 2 页找新图');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export function registerMeituFetchTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerMeituFetchTests 需要 test');
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
