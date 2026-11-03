/**
 * 严肃话题**收紧**判据（2026-11-03，主人："这个几乎用不上，可以更严"）。
 *
 * 要钉的形状：
 *   ① 玩笑/否认语境（"不是真事/开玩笑/梦到"）→ 整轮不判严肃；
 *   ② 虚构语境（动漫/游戏/影视/小说）→ 只压 disaster，**不压**重病与丧亲；
 *   ③ 歧义词退场（"走了""爆炸""塌了""台风""疫情"…）不再误触发；
 *   ④ 真正的重病/丧亲/灾难仍然触发，且档位不变（critical / serious）。
 *
 * 运行：node scripts/selftest-chat-serious.mjs
 */
import assert from 'node:assert/strict';
import { detectSerious, turnPolicyFor, SERIOUS_CATEGORIES } from '../src/serious.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------------------------------------------------------------------------
// 1) 不该触发：日常歧义、玩笑、否认、虚构
// ---------------------------------------------------------------------------
test('日常歧义："我先走了" 不再算丧亲', () => {
  assert.equal(detectSerious('我先走了').level, null);
  assert.equal(detectSerious('他先走了，不等了').level, null);
});

test('玩笑/否认：整轮不判严肃', () => {
  for (const text of [
    '这是动漫里的爆炸，不是真事',
    '我不是真的难受，开玩笑的',
    '我梦到地震了',
    '刚才那个是梗图，别当真',
    '打个比方，就像地震一样',
  ]) assert.equal(detectSerious(text).level, null, text);
});

test('虚构语境：只压 disaster（动漫/游戏/影视/小说）', () => {
  for (const text of [
    '游戏里那波地震太爽了',
    '动漫里的火灾场面做得真好',
    '小说剧情里那场洪水写得很压抑',
    '这个电影里的车祸镜头很假',
  ]) assert.equal(detectSerious(text).level, null, text);
});

test('已退场的歧义词不再误触发（爆炸/塌了/台风/疫情/封城）', () => {
  for (const word of ['爆炸', '塌了', '台风', '疫情', '封城', '撞车']) {
    assert.equal(SERIOUS_CATEGORIES.disaster.includes(word), false, `${word} 不该还在词表里`);
  }
  assert.equal(detectSerious('手机爆炸了').level, null);
  assert.equal(detectSerious('这波操作太爆炸了').level, null);
});

// ---------------------------------------------------------------------------
// 2) 该触发：真重病 / 真丧亲 / 真灾难
// ---------------------------------------------------------------------------
test('真重病：critical，类别仍是 illness', () => {
  const r = detectSerious('我确诊了癌症，下个月化疗');
  assert.equal(r.level, 'critical');
  assert.deepEqual(r.categories, ['illness']);
});

test('真丧亲：critical；"爷爷去世了" 必须判', () => {
  assert.equal(detectSerious('家里有人去世了').level, 'critical');
  assert.equal(detectSerious('他留了遗书').level, 'critical');
});

test('真灾难：serious；地震/洪水/911 仍要判', () => {
  assert.equal(detectSerious('昨天大地震了，房子塌了').level, 'serious');
  assert.equal(detectSerious('老家发洪水了').level, 'serious');
  assert.equal(detectSerious('你听说 911 了吗').level, 'serious');
});

test('虚构语境**不压**重病/丧亲（"我在游戏里"不能当没听见）', () => {
  assert.equal(detectSerious('我妈住院了，我在游戏里刷副本').level, 'critical');
  assert.equal(detectSerious('他去世了，那天我还在打游戏').level, 'critical');
});

test('玩笑语境仍然压得住重病（本人已经声明是玩笑）', () => {
  assert.equal(detectSerious('我确诊了癌症，开玩笑的').level, null);
});

// ---------------------------------------------------------------------------
// 3) 判定之后的行为：收敛闸仍照旧
// ---------------------------------------------------------------------------
test('turnPolicyFor：命中就关花活并给态度提示；不命中一字不加', () => {
  const hit = turnPolicyFor('我确诊了癌症');
  assert.equal(hit.suppressNudges, true);
  assert.equal(hit.suppressMood, true);
  assert.match(hit.note, /严肃话题/);
  const none = turnPolicyFor('我先走了');
  assert.equal(none.note, null);
  assert.equal(none.suppressNudges, false);
  assert.equal(turnPolicyFor('我确诊了癌症', { enabled: false }).suppressNudges, false);
});

test('反证：排除逻辑真的在咬（同一句话，去掉排除就会误判）', () => {
  // 直接复刻"没有排除"的旧行为，证明差异来自排除而不是词表碰巧没命中
  const naive = (t) => (SERIOUS_CATEGORIES.disaster.some((w) => t.includes(w)) ? 'serious' : null);
  assert.equal(naive('游戏里那波地震太爽了'), 'serious');
  assert.equal(detectSerious('游戏里那波地震太爽了').level, null);
  const naiveJoke = (t) => (SERIOUS_CATEGORIES.illness.some((w) => t.includes(w)) ? 'critical' : null);
  assert.equal(naiveJoke('我确诊了癌症，开玩笑的'), 'critical');
  assert.equal(detectSerious('我确诊了癌症，开玩笑的').level, null);
});

// ---------------------------------------------------------------------------
const failed = [];
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed.push([name, e.message]); console.log(`FAIL ${name} :: ${e.message}`); }
}
console.log(`\nselftest-chat-serious: ${cases.length - failed.length}/${cases.length} passed`);
if (failed.length) process.exitCode = 1;
