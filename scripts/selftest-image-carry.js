/**
 * 「窗内补图」保守闸的判据(2026-11-24)。
 *
 * 跑法:
 *
 *     node scripts\selftest-image-carry.js
 *
 * 全部纯逻辑、零网络、零依赖:只 import `src/image-carry.js`。
 *
 * 钉(与文件头「保守闸」对应):
 *   ① 紧邻:触发往回 1/2 条以内的图带上,隔 3 条不带;
 *   ② 无指代远图不带(宁可这轮没看到图,也不按错图答);
 *   ③ 有指代(这张/刚才/图里/什么颜色…)远图带;
 *   ④ `sources(key, null)` 与"触发没有序号信息"必须回旧行为(窗内全带);
 *   ⑤ 连发图顺序新→旧;
 *   ⑥ 非图消息 note 只推序号、不产生补图;
 *   ⑦ clear 后旧图不复活、旧序号作废(代际闸);
 *   ⑧ 3 分钟窗口照旧(窗口内再收窄,窗口外一律不带);
 *   ⑨ 旧导出(carriedImages/rememberCarriedImage/…)行为不变。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADJACENT_MAX_MESSAGES,
  IMAGE_CARRY_MAX_SOURCES,
  IMAGE_CARRY_MS,
  carriedExtraImages,
  carriedImages,
  createConversationImageCarry,
  hasDeicticImageRef,
  pruneCarriedImages,
  rememberCarriedImage,
} from '../src/image-carry.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

let seq = 0;
/** 合成消息:content 默认空串;images 传了才算"带图消息"。 */
const msg = (id, content = '', images = null) => {
  seq += 1;
  const message = { messageId: id ?? `m-${seq}`, content };
  if (images) message.images = images.map((url) => ({ url }));
  return message;
};
const img = (id, url = 'https://example.invalid/p.png') => msg(id, '', [url]);
const ids = (list) => list.map((message) => message.messageId);

// ---------------------------------------------------------------------------
// ① 紧邻 / ② 无指代远图 / ③ 指代远图
// ---------------------------------------------------------------------------

test('image-carry:note 每会话单调编号,seqOf/currentSeq 对得上', () => {
  const carry = createConversationImageCarry();
  const a = msg('a');
  const b = msg('b');
  assert.equal(carry.note('g', a), 1);
  assert.equal(carry.note('g', b), 2);
  assert.equal(carry.note('g', a), 1, '同一条消息重复 note 幂等');
  assert.equal(carry.note('other', msg('c')), 1, '每个会话各自从 1 开始');
  assert.equal(carry.currentSeq('g'), 2);
  assert.equal(carry.currentSeq('other'), 1);
  assert.equal(carry.currentSeq('never'), 0);
  assert.equal(carry.seqOf(a), 1);
  assert.equal(carry.seqOf(b), 2);
  assert.equal(carry.seqOf(msg('never')), undefined, '没编号的消息没有序号');
});

test('image-carry:紧邻 1/2 条带上,隔 3 条不带', () => {
  // 上一条:紧邻 1。seq1 文字、seq2 图、seq3 触发。
  const c1 = createConversationImageCarry();
  const near1 = img('img-near1');
  const trigger1 = msg('trig1', '不错');
  c1.note('g', msg('t0'), 1000);
  c1.note('g', near1, 1001);
  c1.remember('g', near1, 1001);
  c1.note('g', trigger1, 1002);
  assert.deepEqual(ids(c1.sources('g', trigger1, { now: 1002 })), ['img-near1']);

  // 上两条:紧邻 2。seq1 图、seq2 文字、seq3 触发。
  const c2 = createConversationImageCarry();
  const near2 = img('img-near2');
  const trigger2 = msg('trig2', '不错');
  c2.note('g', near2, 1000);
  c2.remember('g', near2, 1000);
  c2.note('g', msg('t1'), 1001);
  c2.note('g', trigger2, 1002);
  assert.deepEqual(ids(c2.sources('g', trigger2, { now: 1002 })), ['img-near2']);

  // 隔 3 条:seq1 图、seq2/3 文字、seq4 触发 → 不带。
  const c3 = createConversationImageCarry();
  const far3 = img('img-far3');
  const trigger3 = msg('trig3', '不错');
  c3.note('g', far3, 1000);
  c3.remember('g', far3, 1000);
  c3.note('g', msg('t2'), 1001);
  c3.note('g', msg('t3'), 1002);
  c3.note('g', trigger3, 1003);
  assert.deepEqual(c3.sources('g', trigger3, { now: 1003 }), [], '隔 3 条没有指代 → 不带');
});

test('image-carry:无指代远图不带,紧邻那张仍带', () => {
  const carry = createConversationImageCarry();
  const far = img('img-far');
  const near = img('img-near');
  const trigger = msg('trig', '你觉得呢');
  carry.note('g', far, 1000);
  carry.remember('g', far, 1000);
  carry.note('g', msg('t1'), 1001);
  carry.note('g', msg('t2'), 1002);
  carry.note('g', near, 1003);
  carry.remember('g', near, 1003);
  carry.note('g', trigger, 1004);
  assert.deepEqual(ids(carry.sources('g', trigger, { now: 1004 })), ['img-near'], '远图被闸掉,只带紧邻');
});

test('image-carry:有指代时远图也带(窗内,新→旧)', () => {
  for (const text of ['刚才那张图什么颜色', '图里是谁', '这张哪来的', '楼上发的照片', '看看截图']) {
    const carry = createConversationImageCarry();
    const far = img('img-far');
    const trigger = msg('trig', text);
    carry.note('g', far, 1000);
    carry.remember('g', far, 1000);
    carry.note('g', msg('t1'), 1001);
    carry.note('g', msg('t2'), 1002);
    carry.note('g', msg('t3'), 1003);
    carry.note('g', trigger, 1004);
    assert.deepEqual(ids(carry.sources('g', trigger, { now: 1004 })), ['img-far'], text);
  }
});

// ---------------------------------------------------------------------------
// ④ 旧行为兼容
// ---------------------------------------------------------------------------

test('image-carry:trigger null 与无序号触发消息保持旧行为(窗内全带)', () => {
  const carry = createConversationImageCarry();
  const first = img('img-1');
  const second = img('img-2');
  carry.remember('g', first, 1000);
  carry.remember('g', second, 1001);
  // 触发为 null:旧行为,窗内全部,新→旧。
  assert.deepEqual(ids(carry.sources('g', null, { now: 1001 })), ['img-2', 'img-1']);
  // 触发消息没 note(没有序号信息):同样回旧行为,而不是被保守闸清空。
  const plainTrigger = msg('plain-trigger', '继续');
  assert.deepEqual(ids(carry.sources('g', plainTrigger, { now: 1001 })), ['img-2', 'img-1']);
  // 触发自己已经在清单里时不能被当成"补图"返回。
  const self = img('img-self');
  carry.note('g', self, 1002);
  carry.remember('g', self, 1002);
  assert.deepEqual(ids(carry.sources('g', self, { now: 1002 })).includes('img-self'), false,
    '触发那条自己的图不重复进补图');
});

// ---------------------------------------------------------------------------
// ⑤ 顺序 / ⑥ 非图消息
// ---------------------------------------------------------------------------

test('image-carry:连发图顺序新→旧', () => {
  // 指代路径:三张连发全带。
  const deictic = createConversationImageCarry();
  const iA = img('A');
  const iB = img('B');
  const iC = img('C');
  const dTrigger = msg('dTr', '这几张哪张好看');
  deictic.note('g', iA, 1000);
  deictic.remember('g', iA, 1000);
  deictic.note('g', iB, 1001);
  deictic.remember('g', iB, 1001);
  deictic.note('g', iC, 1002);
  deictic.remember('g', iC, 1002);
  deictic.note('g', dTrigger, 1003);
  assert.deepEqual(ids(deictic.sources('g', dTrigger, { now: 1003 })), ['C', 'B', 'A']);

  // 紧邻路径:上一条 + 上两条两张,也是新→旧。
  const adjacent = createConversationImageCarry();
  const jA = img('A2');
  const jB = img('B2');
  const aTrigger = msg('aTr', '不错');
  adjacent.note('g', msg('t0'), 1000);
  adjacent.note('g', jA, 1001);
  adjacent.remember('g', jA, 1001);
  adjacent.note('g', jB, 1002);
  adjacent.remember('g', jB, 1002);
  adjacent.note('g', aTrigger, 1003);
  assert.deepEqual(ids(adjacent.sources('g', aTrigger, { now: 1003 })), ['B2', 'A2']);
});

test('image-carry:非图消息 note 只推进序号,不产生补图', () => {
  const carry = createConversationImageCarry();
  for (let index = 1; index <= 5; index += 1) {
    carry.note('g', msg(`t${index}`, '闲聊'), 1000 + index);
  }
  const trigger = msg('trig', '继续');
  carry.note('g', trigger, 1006);
  assert.equal(carry.currentSeq('g'), 6);
  assert.deepEqual(carry.sources('g', trigger, { now: 1006 }), [], '没有带图消息就没有补图');
  // 非图消息误传给 remember 也不能进账(旧行为)。
  carry.remember('g', msg('plain', '没图', null), 1007);
  assert.deepEqual(carry.sources('g', null, { now: 1007 }), []);
});

// ---------------------------------------------------------------------------
// ⑦ clear / ⑧ 时间窗
// ---------------------------------------------------------------------------

test('image-carry:clear 后旧图不复活,旧序号作废(代际闸)', () => {
  const carry = createConversationImageCarry();
  const oldImg = img('old-img');
  const oldTrigger = msg('old-trig', '这张什么颜色');
  carry.note('g', oldImg, 1000);
  carry.remember('g', oldImg, 1000);
  carry.note('g', oldTrigger, 1001);
  assert.deepEqual(ids(carry.sources('g', oldTrigger, { now: 1001 })), ['old-img']);

  carry.clear('g');
  assert.equal(carry.currentSeq('g'), 0);
  assert.equal(carry.seqOf(oldImg), undefined, 'clear 后旧图序号作废');
  assert.equal(carry.seqOf(oldTrigger), undefined, 'clear 后旧触发序号作废');
  assert.deepEqual(carry.sources('g', null, { now: 1001 }), [], '账清空后旧图不复活');

  // clear 后重新记账:新图用新代际的序号,旧图不会因序号归零被误认成"紧邻"。
  const freshImg = img('fresh-img');
  carry.note('g', freshImg, 2000);
  carry.remember('g', freshImg, 2000);
  assert.equal(carry.seqOf(freshImg), 1, '新一代从 1 开始');
  const freshTrigger = msg('fresh-trig', '这张呢');
  carry.note('g', freshTrigger, 2001);
  assert.deepEqual(ids(carry.sources('g', freshTrigger, { now: 2001 })), ['fresh-img']);
  // 旧消息重新入站会拿新号,不会拿回旧号(新代际已经发到 2)。
  assert.equal(carry.note('g', oldImg, 2002), 3);
});

test('image-carry:3 分钟窗口照旧(窗口内再收窄,窗口外一律不带)', () => {
  const t0 = 1_000_000;
  // 旧行为(null 触发)的窗口边界。
  const legacy = createConversationImageCarry();
  legacy.remember('g', img('legacy-img'), t0);
  assert.equal(legacy.sources('g', null, { now: t0 }).length, 1);
  assert.equal(legacy.sources('g', null, { now: t0 + IMAGE_CARRY_MS }).length, 1, '恰好 3 分钟仍在窗内');
  assert.equal(legacy.sources('g', null, { now: t0 + IMAGE_CARRY_MS + 1 }).length, 0, '超过 3 分钟不带');

  // 保守闸路径:窗口照样先裁(旧图不能借"紧邻"赖在窗口外)。
  const gated = createConversationImageCarry();
  const windowImg = img('window-img');
  gated.note('g', windowImg, t0);
  gated.remember('g', windowImg, t0);
  const trigger = msg('trig', '不错');
  gated.note('g', trigger, t0 + IMAGE_CARRY_MS + 1);
  assert.deepEqual(gated.sources('g', trigger, { now: t0 + IMAGE_CARRY_MS + 1 }), []);

  // 窗口外连指代也不带(窗口是硬边界,指代只决定窗内旧图带不带)。
  const deicticGated = createConversationImageCarry();
  const deicticImg = img('deictic-window-img');
  deicticGated.note('g', deicticImg, t0);
  deicticGated.remember('g', deicticImg, t0);
  const deicticTrigger = msg('dtrig', '刚才那张图什么颜色');
  deicticGated.note('g', deicticTrigger, t0 + IMAGE_CARRY_MS + 1);
  assert.deepEqual(deicticGated.sources('g', deicticTrigger, { now: t0 + IMAGE_CARRY_MS + 1 }), [],
    '窗口外指代也不带');
});

// ---------------------------------------------------------------------------
// ⑨ 导出与旧函数兼容
// ---------------------------------------------------------------------------

test('image-carry:常量/指代识别/旧导出行为兼容', () => {
  assert.equal(IMAGE_CARRY_MS, 3 * 60 * 1000);
  assert.equal(IMAGE_CARRY_MAX_SOURCES, 12);
  assert.equal(ADJACENT_MAX_MESSAGES, 2, '保守闸的紧邻上限暂定 2');
  for (const text of ['这张图什么颜色', '刚才发的那张', '图里是谁', '这几张哪张好看', '这个图',
    '那个图', '看这个图', '发的那张', '看照片', '刚拍的图', '图片里是谁', '什么颜色', '截图呢']) {
    assert.equal(hasDeicticImageRef(text), true, text);
  }
  for (const text of ['继续说说', '你好呀', '', null, undefined, 42,
    // 裸「这/那/此」不收：水群里这些绝大多数在说文字/话题，不是指着图。
    '这是什么', '楼上说得对', '看这个', '那么', '这个本子不错', '图书馆在哪',
    // 「你看/刚发」这类非图用语也不收（审查 P2-3：「你看这个视频」「刚发工资」不该开整窗）。
    '你看这个视频', '你看', '刚发工资', '刚拍完戏']) {
    assert.equal(hasDeicticImageRef(text), false, String(text));
  }

  // 老导出照旧:时间窗 + 条数 + 去重。
  const list = [];
  const one = img('one');
  rememberCarriedImage(list, one, 1000);
  rememberCarriedImage(list, one, 1000);
  assert.equal(list.length, 2);
  assert.deepEqual(carriedImages(list, { now: 1000 }).map((m) => m.messageId), ['one'], '同一条只算一次');
  assert.deepEqual(carriedExtraImages(list, one, { now: 1000 }), []);
  assert.equal(pruneCarriedImages(list, 1000 + IMAGE_CARRY_MS + 1).length, 0);
  assert.equal(pruneCarriedImages([], 1000).length, 0);
});

export function registerImageCarryTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerImageCarryTests 需要 test');
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
