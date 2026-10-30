/**
 * **群参与状态机判据**(`src\social-state.js`;1.170.0 / D277)。
 *
 * 跑法:
 *
 *     node scripts\selftest-social-state.js
 *
 * 钉四层:
 *   ① 全转移图:观望→试探(@)、任意→活跃( answered)、试探→观望(试探连击)、
 *     活跃/观望→退场(3 次无视)、退场→观望(冷却推进);
 *   ② 三条铁律:退场时调制 self/interact=0(**被叫/私聊根本不问状态机**——那是
 *     接线层的形状,由 index.js 的 if(!addressed) 守着,这里钉"状态机给不出
 *     '拦被叫'的理由");活跃态 = 现状(乘数全 1,零变化);被叫开口清连击;
 *   ③ 守卫:answered 之后再喂 noteIgnored **不计数**(定时器晚到不许冤枉她);
 *   ④ 元判据:连击边界(恰好第 3 次才退,第 2 次不退)+ 重启全回观望。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSocialStateMachine, SOCIAL_STATE_DEFAULTS } from '../src/social-state.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 固定时钟:每个用例自己推进(t0 起,毫秒)。 */
function fixedClock(t0 = 1_000_000) {
  let t = t0;
  return {
    now: () => t,
    jump: (ms) => { t += ms; },
    get: () => t,
  };
}

test('状态机:初始态 = 观望(重启全回观望,保守方向)', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  assert.equal(sm.stateOf('g1'), 'observing');
  const mod = sm.modulationFor('g1');
  assert.deepEqual({ state: mod.state, self: mod.self, interact: mod.interact }, {
    state: 'observing', self: SOCIAL_STATE_DEFAULTS.modulation.observing.self, interact: SOCIAL_STATE_DEFAULTS.modulation.observing.interact,
  });
});

test('状态机:全转移图 —— @ 抬试探、answered 抬活跃、无视连击降档、退场冷却回观望', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });

  // 观望 →(被 @)→ 试探
  assert.deepEqual(sm.noteAddressed('g'), { from: 'observing', to: 'trying', reason: '被 @——参与的开始' });
  assert.equal(sm.stateOf('g'), 'trying');

  // 试探 →(她开口后有人接话)→ 活跃:noteSpoke(自发)→ 窗口内群消息 = answered
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(60_000);
  assert.deepEqual(sm.noteGroupMessage('g'), { from: 'trying', to: 'active', reason: '她开口后有人接话——参与成立' });
  assert.equal(sm.stateOf('g'), 'active');

  // 活跃 →(自发开口连续 3 次无人接)→ 退场:第 2 次不许退,恰好第 3 次退(元判据:边界)
  for (let i = 1; i <= 2; i++) {
    clock.jump(10 * 60_000);
    sm.noteSpoke('g', { selfInitiated: true });
    clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 5_000);
    assert.equal(sm.noteIgnored('g'), null, `第 ${i} 次无视不该退(边界:第 ${SOCIAL_STATE_DEFAULTS.ignoredToRetreat} 次才退)`);
  }
  clock.jump(10 * 60_000);
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 5_000);
  const retreat = sm.noteIgnored('g');
  assert.deepEqual(retreat, { from: 'active', to: 'retreating', reason: `自发开口连续 ${SOCIAL_STATE_DEFAULTS.ignoredToRetreat} 次无人接——退场,把话语权还给群` });
  const mod = sm.modulationFor('g');
  assert.equal(mod.self, 0, '退场 = 自发全静');
  assert.equal(mod.interact, 0, '退场 = 互动全静');

  // 退场 →(冷却未到)→ 仍是退场;→(冷却到点)→ 观望(查询时推进,不靠定时器)
  clock.jump(SOCIAL_STATE_DEFAULTS.retreatCooldownMs - 60_000);
  assert.equal(sm.stateOf('g'), 'retreating', '冷却没到不许回');
  clock.jump(120_000);
  const st = sm.stateOf('g');
  assert.equal(st, 'observing', '冷却到点自动回观望');
});

test('状态机:试探期宽容一档 —— 连续 2 次无视回落观望(不是退场)', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  sm.noteAddressed('g');
  clock.jump(60_000);
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 5_000);
  sm.noteIgnored('g');
  clock.jump(10 * 60_000);
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 5_000);
  const back = sm.noteIgnored('g');
  assert.deepEqual(back, { from: 'trying', to: 'observing', reason: `试探期连续 ${SOCIAL_STATE_DEFAULTS.tryingIgnoredToBack} 次开口无人接,回落观望` });
});

test('状态机:被叫开口清连击 —— 上一轮"没人接"不算数', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  // 两次自发无视(连击 2)
  for (let i = 0; i < 2; i++) {
    clock.jump(10 * 60_000);
    sm.noteSpoke('g', { selfInitiated: true });
    clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 5_000);
    sm.noteIgnored('g');
  }
  // 被叫开口 → 连击清零(她被理睬过)
  clock.jump(10 * 60_000);
  sm.noteSpoke('g', { selfInitiated: false });
  // 再一次自发无视 = 连击从头数 1,不许退
  clock.jump(10 * 60_000);
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 5_000);
  assert.equal(sm.noteIgnored('g'), null, '被叫开口清零后,连击要重新数');
});

test('状态机:守卫 —— answered 之后喂 noteIgnored 不计数(定时器晚到不冤枉她)', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(60_000);
  sm.noteGroupMessage('g'); // 有人接了:连击与 lastSelfSpokeAt 都清
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 60_000);
  assert.equal(sm.noteIgnored('g'), null, '已经被人接过的开口,晚到的"没人接"不许数');
  assert.equal(sm.snapshotOf('g').ignoredSpree, 0, 'Y5:晚到回调绝不能暗中增加连击');
  for (let i = 0; i < SOCIAL_STATE_DEFAULTS.ignoredToRetreat; i++) {
    sm.noteIgnored('g');
  }
  assert.equal(sm.snapshotOf('g').ignoredSpree, 0, 'Y5:重复旧回调仍不可累加连击');
  assert.equal(sm.stateOf('g'), 'active', 'Y5:旧回调不能导致退场');
});

test('状态机:铁律 —— 活跃态 = 现状(乘数全 1);状态机给不出"拦被叫"的任何理由', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  sm.noteAddressed('g');
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(60_000);
  sm.noteGroupMessage('g');
  const mod = sm.modulationFor('g');
  assert.equal(mod.state, 'active');
  assert.equal(mod.self, 1, '活跃态的自发乘数 = 1(现状零变化)');
  assert.equal(mod.interact, 1, '活跃态的互动乘数 = 1');
  // 状态机的 API 面里**没有**"被叫拦不拦"这个函数 —— 被叫不问它(铁律在接线层
  // 由 if(!addressed) 守着);这里钉的是"调制表只含 self/interact 两个自发侧旋钮"。
  for (const state of Object.keys(SOCIAL_STATE_DEFAULTS.modulation)) {
    const keys = Object.keys(SOCIAL_STATE_DEFAULTS.modulation[state]);
    assert.deepEqual(keys.sort(), ['interact', 'self'], `${state} 的调制表只许有自发侧旋钮(self/interact)`);
  }
});

test('状态机:busyGroups 只报没回观望的群(诊断面)', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  sm.noteAddressed('a');
  sm.noteAddressed('b');
  assert.deepEqual(sm.busyGroups().sort(), ['a', 'b']);
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 60_000);
  sm.noteGroupMessage('a'); // a 有回应 → active(仍在 busy)
  clock.jump(SOCIAL_STATE_DEFAULTS.retreatCooldownMs + 60_000);
  // b 没有进一步信号:trying 不会自己冷却(只有退场有冷却)—— 这是有意的:
  // "没人理"要靠 ignored 信号降档,不是时间一到就当没事。
  assert.deepEqual(sm.busyGroups().sort(), ['a', 'b']);
});

test('R2:每个查询与写口到点仅发一条恢复,到期@顺序两跳', () => {
  const wiring = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(wiring, /createSocialStateMachine\(\{ onTransition: noteSocialTransition \}\)/, 'R2:生产必须将统一转移出口接到既有日志及metric');
  assert.doesNotMatch(wiring, /noteSocialTransition\([^\n]*socialState\.note/, 'R2:调用端不能重复记录转移');
  const exits = [
    sm => sm.stateOf('g'), sm => sm.modulationFor('g'),
    sm => sm.snapshotOf('g'), sm => sm.busyGroups(),
    sm => sm.noteAddressed('g'), sm => sm.noteSpoke('g'),
    sm => sm.noteGroupMessage('g'), sm => sm.noteIgnored('g'),
  ];
  for (const exit of exits) {
    const clock = fixedClock();
    const events = [];
    const sm = createSocialStateMachine({ now: clock.now, onTransition: (g, t) => events.push([g, t.from, t.to]) });
    for (let i = 0; i < SOCIAL_STATE_DEFAULTS.ignoredToRetreat; i++) {
      sm.noteSpoke('g', { selfInitiated: true });
      clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 1);
      sm.noteIgnored('g');
    }
    events.length = 0;
    clock.jump(SOCIAL_STATE_DEFAULTS.retreatCooldownMs - 1);
    sm.snapshotOf('g');
    assert.deepEqual(events, [], '冷却前不得恢复');
    clock.jump(1);
    exit(sm);
    assert.deepEqual(events[0], ['g', 'retreating', 'observing'], '消费端必须收到冷却恢复');
    assert.equal(events.filter(e => e[1] === 'retreating').length, 1);
    if (sm.stateOf('g') === 'trying') assert.deepEqual(events[1], ['g', 'observing', 'trying']);
    const count = events.length;
    sm.snapshotOf('g'); sm.modulationFor('g'); sm.busyGroups(); sm.stateOf('other');
    assert.equal(events.length, count, '重复查询及其他群不能重复上报');
  }
});

test('R4:真实中间入站后旧timer不得消费新开口,当前轮到期才计数', () => {
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  const a = clock.get();
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(120_000);
  sm.noteGroupMessage('g'); // B的真实触发入站先将A标answered
  const b = clock.get();
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(181_000); // A timer到了,B仅181秒
  sm.noteIgnored('g', clock.get(), { spokeAt: a });
  assert.equal(sm.snapshotOf('g').lastSelfSpokeAt, b, '旧timer必须保留B的回应窗口');
  assert.equal(sm.snapshotOf('g').ignoredSpree, 0);
  sm.noteIgnored('g', clock.get(), { spokeAt: b });
  assert.equal(sm.snapshotOf('g').ignoredSpree, 0, '本轮未到期也不能计数');
  clock.jump(40_000);
  sm.noteGroupMessage('g');
  assert.equal(sm.snapshotOf('g').lastSelfSpokeAt, null, 'B窗口内消息仍能接住B');
  assert.equal(sm.snapshotOf('g').ignoredSpree, 0);
  const c = clock.get();
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 1);
  sm.noteIgnored('g', clock.get(), { spokeAt: c });
  sm.noteIgnored('g', clock.get(), { spokeAt: c });
  assert.equal(sm.snapshotOf('g').ignoredSpree, 1, '当前到期轮只计一次');
});

test('Y6:自发分类只认同一轮真实被叫(addressed),不拿答话排版标志当分类', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('const answering = addressed || looksAddressedToBot');
  assert.ok(start > 0, 'Y6:生产自发开口处必须有状态机接线');
  const block = source.slice(start, start + 5200);
  assert.match(block, /noteSpoke\(groupId, \{ selfInitiated: !addressed \}/, 'Y6:自发分类必须用本轮真实被叫判定');
  assert.match(block, /if \(!addressed\) \{/, 'Y6:ignored 计时器只给真正自发的开口');
  // ⚠️ D288(1.171.0):`addressed: answering` 这个**排版**选项退役 —— 答话与纯主动走
  // 同一份 `planSpokenLines` 分条;`answering` 只留给日志/状态机分类(上面两行已钉)。
  // F2(2026-10-30):分条只带入口不可变决策,选项里不许再出现 addressed 分叉。
  assert.match(block, /\{ label: '自发发言', decision: turnDecision \}/,
    'D288+F2:自发发言同一份分条规划,只带入口决策(不再按 answered 分叉)');
  const spokenAt = block.indexOf("label: '自发发言'");
  assert.doesNotMatch(block.slice(Math.max(0, spokenAt - 200), spokenAt + 200), /addressed\s*:/,
    'D288:自发发言分条不许再出现 addressed 选项');
  // 行为对照:真自发建立窗口并计数;被叫不带 selfInitiated 不算"她找话"。
  const clock = fixedClock();
  const sm = createSocialStateMachine({ now: clock.now });
  sm.noteSpoke('g', { selfInitiated: true });
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 1);
  sm.noteIgnored('g');
  assert.equal(sm.snapshotOf('g').ignoredSpree, 1, '真自发应当进入 ignored 计数');
  sm.noteSpoke('g', { selfInitiated: false });
  clock.jump(SOCIAL_STATE_DEFAULTS.answeredWindowMs + 1);
  sm.noteIgnored('g');
  assert.equal(sm.snapshotOf('g').ignoredSpree, 0, '被叫开口要清连击,且不许建立新的 ignored 窗口');
});

test('Y4:自发闸只挡没被叫的那条路,@/关键词/私聊不进这条闸', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const gateAt = source.indexOf('if (!addressed) {\n      const social = socialState.modulationFor(groupId);');
  assert.ok(gateAt > 0, 'Y4:自发闸必须由 !addressed 守着(删掉它=退场会拦被叫)');
  const gate = source.slice(gateAt, gateAt + 900);
  assert.match(gate, /if \(social\.self <= 0\)/, 'Y4:退场档必须真的 return(不是只记日志)');
  assert.match(gate, /if \(social\.self < 1 && Math\.random\(\) >= social\.self\)/, 'Y4:观望/试探档必须真的按概率拦');
  // 互动(戳一戳/表情)是另一条自发侧闸:不经过"被叫"判定。
  // ⚠️ 2026-10-28 主人拍板「戳一戳跟 @ 一样高」:戳一戳与被叫同级、**不吃状态档**
  //    (socialFactor 只对 face 取 interact);纯表情照旧按 interact 打折。
  assert.match(source, /const socialFactor = kind === 'poke' \? 1 : social\.interact;/,
    'Y4:戳一戳与 @ 同级(不吃状态档),纯表情仍按 interact 档打折');
  assert.match(source, /const chance = Math\.min\(1, \(inWindow \? base \* cfg\.windowMultiplier : base\) \* socialFactor\);/,
    'Y4:互动反应的概率乘的是 socialFactor(poke=1,face=interact)');
  // @ 事件走 handleMessage 的独立分支,不该出现在状态机调制里
  const mentionAt = source.indexOf('if (message.isMention) {');
  assert.ok(mentionAt > 0, 'Y4:@ 必须有独立分支');
  assert.doesNotMatch(source.slice(mentionAt, mentionAt + 200), /modulationFor/, 'Y4:@ 分支不许被状态机拦');
});

test('Y3:自发闸排在读空气之后 —— 先判"该不该插话",再掷参与档(D277 原顺序)', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const airReadingAt = source.indexOf("if (!addressed && config.policy.group.gapMs > 0) {");
  assert.ok(airReadingAt > 0, 'Y3:读空气闸必须存在');
  const socialGateAt = source.indexOf('const social = socialState.modulationFor(groupId);\n      if (social.self <= 0) {');
  assert.ok(socialGateAt > 0, 'Y3:自发闸必须存在');
  assert.ok(airReadingAt < socialGateAt,
    'Y3:读空气(串中间别插话)要跑在参与状态机前面 —— 被读空气挡住的轮次不该先掷参与档的骰子');
});

test('Y2:同一次退场期内「自发开口全静」只喊一声 —— 重复尝试不刷屏', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const gateAt = source.indexOf('if (social.self <= 0) {');
  assert.ok(gateAt > 0, 'Y2:退场全静分支必须存在');
  const block = source.slice(gateAt, gateAt + 400);
  assert.match(block, /retreatLoggedSince\.get\(groupId\) !== snap\.since/, 'Y2:必须真的比对退场期(since),删掉比对=退场期每拍都喊');
  assert.match(block, /retreatLoggedSince\.set\(groupId,/, 'Y2:喊过之后要记住这个退场期');
});

test('4A:观察期仪器 —— answered→active 转移按 @/普通消息分开计数', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const callAt = source.indexOf('socialState.noteGroupMessage(message.targetId)');
  assert.ok(callAt > 0, '4A:群消息喂状态机的调用点必须存在');
  const block = source.slice(callAt - 200, callAt + 400);
  assert.match(block, /const answeredTransition = socialState\.noteGroupMessage/,
    '4A:调用点要接住转移返回值(只数 answered→active 的转移,不是每条消息)');
  assert.match(block, /social\.answered\.byMention/, '4A:@ 触发的 answered 要单独计数');
  assert.match(block, /social\.answered\.byPlain/, '4A:普通消息触发的 answered 要单独计数');
});

export function registerSocialStateTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerSocialStateTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
