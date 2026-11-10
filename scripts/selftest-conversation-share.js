/**
 * **跨通道私聊共享会话**的判据(D329,2026-11-10)。
 *
 * 用户原话:「qq 和网页私聊的惠惠不共享短期记忆,qq 刚说的话在网页不知道」。
 * 这一层钉四件事:
 *   ① **同一个人**的两条私聊线真的并到一起(键相等,不是"看起来共享");
 *   ② ⚠️ **网页访问者不一定是 QQ 私聊那个人**:未绑定/未自洽绑定/别的账号
 *      必须各聊各的 —— 这是本功能最容易"顺手送掉隐私"的地方;
 *   ③ 群聊、QQ 场景不受影响;非法账号 id 一律 fail closed;
 *   ④ 装配层真的用上了这份判定(源码接线断言,防"模块写了没人调")。
 *
 * ⚠️ 共享的边界:`qqbot-c2c-<openid>` 就是 QQ 私聊那条线 —— 私聊派生内容
 *    (常驻块/洞察)因此按既有 c2c 作用域走,不由本模块另开口子;
 *    网页**未绑定**时仍是 `qqbot-web-<id>`(拒绝私有块),行为不变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveTurnConversationKey,
  sharedConversationTarget,
  verifiedBindingOpenid,
} from '../src/conversation-share.js';
import { memoryAccessForScene } from '../src/memory-scope.js';
import { sessionIdFor } from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 一个"网页上第 N 号账号 + 绑定记录"的最小形状(只喂判定要的字段)。 */
function bindingOf(playerId, openid) {
  return { playerId, openid, displayName: null };
}

/** 走**生产同一份**调用路径:message → 键(含绑定查询注入)。 */
function keyFor({ scene = 'web', targetId = '7', binding = null, reverse = null, throwLookup = false } = {}) {
  return resolveTurnConversationKey({
    message: { scene, targetId },
    sessionIdFor,
    lookupBinding: () => {
      if (throwLookup) throw new Error('bindings unreadable');
      return { binding, reverse };
    },
  });
}

export function registerConversationShareTests({ test, assert }) {
  test('共享私聊(D329):**已验证绑定**的网页账号,与那个 QQ 私聊用的是同一条会话线', () => {
    const forward = bindingOf(7, 'OPENID_OWNER');
    const reverse = bindingOf(7, 'OPENID_OWNER');
    const web = keyFor({ targetId: '7', binding: forward, reverse });
    assert.equal(web.shared, true, '绑定两侧自洽 → 必须共享');
    assert.equal(web.openid, 'OPENID_OWNER');
    // ⚠️ 判据的核心:网页这一轮的键,必须**恰好等于** QQ 私聊入站算出来的键。
    //    两条线共用一段 `conversation_turn` 历史就是靠这一条相等,而不是靠日志。
    assert.equal(web.key, sessionIdFor({ scene: 'c2c', targetId: 'OPENID_OWNER' }));
    assert.equal(web.key, 'qqbot-c2c-OPENID_OWNER');
    // 反方向同理:QQ 那条线本来就是这个键 —— 于是网页说过的话 QQ 也接得上。
    assert.equal(sessionIdFor({ scene: 'c2c', targetId: 'OPENID_OWNER' }), web.key);
    // 显式 targetId 带 `web:` 前缀(旧形状)也认,但不能因此变成另一个键。
    assert.equal(keyFor({ targetId: 'web:7', binding: forward, reverse }).key, web.key);
  });

  test('共享私聊(D329):⚠️ **没绑定 / 绑定不自洽 / 别的网页账号**一律各聊各的(网页不一定是他)', () => {
    // ① 网页账号压根没绑 QQ → 还是网页自己那条线
    const unbound = keyFor({ targetId: '7' });
    assert.equal(unbound.shared, false);
    assert.equal(unbound.key, sessionIdFor({ scene: 'web', targetId: '7' }));
    assert.equal(unbound.key, 'qqbot-web-7');

    // ② 两个**不同的人**绑了各自不同的 QQ:绝不能串线
    const a = keyFor({ targetId: '7', binding: bindingOf(7, 'OPENID_A'), reverse: bindingOf(7, 'OPENID_A') });
    const b = keyFor({ targetId: '8', binding: bindingOf(8, 'OPENID_B'), reverse: bindingOf(8, 'OPENID_B') });
    assert.equal(a.shared, true);
    assert.equal(b.shared, true);
    assert.notEqual(a.key, b.key, '不同绑定人的网页私聊不许并到同一条线');

    // ③ 正向说账号 7 绑了 OPENID_A,反查却指回账号 8(库里两份矛盾事实)→ 不共享
    const conflict = keyFor({ targetId: '7', binding: bindingOf(7, 'OPENID_A'), reverse: bindingOf(8, 'OPENID_A') });
    assert.equal(conflict.shared, false, '正反两条绑定事实对不上 → fail closed,绝不猜');
    assert.equal(conflict.key, 'qqbot-web-7');

    // ④ 反查不到(只有正向记录)→ 不共享
    assert.equal(keyFor({ targetId: '7', binding: bindingOf(7, 'OPENID_A'), reverse: null }).shared, false);
    // ⑤ 反查的 openid 字面不同(差一个空白也算)→ 不共享
    assert.equal(keyFor({ targetId: '7', binding: bindingOf(7, 'OPENID_A'), reverse: bindingOf(7, 'OPENID_A2') }).shared, false);
    // ⑥ 绑定记录里的 playerId 不是这个账号(坏数据)→ 不共享
    assert.equal(keyFor({ targetId: '7', binding: bindingOf(8, 'OPENID_A'), reverse: bindingOf(8, 'OPENID_A') }).shared, false);
    // ⑦ openid 空白 → 不共享
    assert.equal(keyFor({ targetId: '7', binding: bindingOf(7, '   '), reverse: bindingOf(7, '   ') }).shared, false);

    // ⑧ 绑定库读不出来(抛错)→ 不共享,而且**不许把这一轮带炸**
    const broken = keyFor({ targetId: '7', binding: bindingOf(7, 'OPENID_A'), reverse: bindingOf(7, 'OPENID_A'), throwLookup: true });
    assert.equal(broken.shared, false, '读不到绑定 = 没绑定(fail closed)');
    assert.equal(broken.key, 'qqbot-web-7');
  });

  test('共享私聊(D329):账号 id 只认规范正整数写法 —— 别的写法不许"猜成同一个人"', () => {
    const forward = bindingOf(7, 'OPENID_A');
    for (const bad of ['0', '007', '1e3', '-3', '3.5', '  ', '', null, 'abc', '7abc']) {
      const out = keyFor({ targetId: bad, binding: forward, reverse: forward });
      assert.equal(out.shared, false, `非法账号 id ${JSON.stringify(bad)} 不许共享`);
    }
    // 合法写法(数字/字符串等价)照常共享
    assert.equal(keyFor({ targetId: 7, binding: forward, reverse: forward }).shared, true);
    assert.equal(keyFor({ targetId: '7', binding: forward, reverse: forward }).shared, true);
  });

  test('共享私聊(D329):QQ 私聊与群聊**不经过**共享判定(群聊更不许并进任何私聊线)', () => {
    // QQ 私聊:键就是 c2c(即使传了绑定也不改)
    const qq = resolveTurnConversationKey({
      message: { scene: 'c2c', targetId: 'OPENID_A' },
      sessionIdFor,
      lookupBinding: () => { throw new Error('c2c 不该查绑定'); },
    });
    assert.equal(qq.shared, false);
    assert.equal(qq.key, 'qqbot-c2c-OPENID_A');
    // 群聊:哪怕发言者绑过网页,群聊仍是群聊那条线
    const group = resolveTurnConversationKey({
      message: { scene: 'group', targetId: 'GROUP_1' },
      sessionIdFor,
      lookupBinding: () => { throw new Error('group 不该查绑定'); },
    });
    assert.equal(group.shared, false);
    assert.equal(group.key, 'qqbot-group-GROUP_1');
    // 纯函数层:sharedConversationTarget 只认 web
    assert.deepEqual(sharedConversationTarget({ scene: 'group', playerId: '7', bindingOpenid: 'OPENID_A' }), null);
    assert.deepEqual(sharedConversationTarget({ scene: 'c2c', playerId: '7', bindingOpenid: 'OPENID_A' }), null);
    // verifiedBindingOpenid 是判定口径的唯一一份:两侧不齐就 null
    assert.equal(verifiedBindingOpenid({ playerId: 7, binding: bindingOf(7, 'X'), reverse: null }), null);
    assert.equal(verifiedBindingOpenid({ playerId: 7, binding: bindingOf(7, 'X'), reverse: bindingOf(7, 'X') }), 'X');
  });

  test('共享私聊(D329):⚠️ 共用 QQ 会话线的**网页那一轮**不继承 c2c 档的私有块/洞察(网页不一定是他)', () => {
    // 共享之后会话键是 `qqbot-c2c-<openid>`;若只按键判定,网页轮会白拿 c2c 档。
    // 用户 2026-11-10 的原话:「注意识别绑定qq私聊和网页私聊用户身份(目前QQ只有我能私聊,网页不一定)」——
    // 所以"这一轮从哪来"必须参与判定。
    const sharedKey = 'qqbot-c2c-OPENID_A';
    const webTurn = memoryAccessForScene({ scene: 'web', conversationKey: sharedKey, ownerIds: new Set(['OPENID_A']) });
    assert.equal(webTurn.privateBlocks, false, '网页那一轮不许拿私有常驻块(哪怕键是 c2c、哪怕 openid 在主人名单里)');
    assert.equal(webTurn.insights, false, '网页那一轮不许拿洞察');
    assert.equal(webTurn.reason, 'web-shared-conversation');

    // 同一把键,QQ 那一轮照旧按 c2c 档(有名单且是他 → 给)
    const qqTurn = memoryAccessForScene({ scene: 'c2c', conversationKey: sharedKey, ownerIds: new Set(['OPENID_A']) });
    assert.equal(qqTurn.privateBlocks, true);
    assert.equal(qqTurn.insights, true);
    // 没传场景(旧调用/旧沙箱切片)→ 与旧行为完全一致,不许因为新函数变严
    const legacy = memoryAccessForScene({ conversationKey: 'qqbot-c2c-OPENID_A', ownerIds: null });
    assert.equal(legacy.privateBlocks, true, '没传场景时保持旧口径(名单为空 → c2c 兼容档)');
    // 群聊照旧不给
    const group = memoryAccessForScene({ scene: 'group', conversationKey: 'qqbot-group-G1', ownerIds: new Set(['OPENID_A']) });
    assert.equal(group.privateBlocks, false);
    assert.equal(group.insights, false);
    // 未绑定网页(仍是 web 键)本来就不给
    const plainWeb = memoryAccessForScene({ scene: 'web', conversationKey: 'qqbot-web-7', ownerIds: null });
    assert.equal(plainWeb.privateBlocks, false);
  });

  test('共享私聊(D329):装配层真的用了这份判定(防"模块写了没人调"的静默失效)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    // ① 网页那一轮:会话键必须来自 conversationKeyFor(而不是直接 sessionIdFor(message))
    const webTurn = /async function runWebChatTurn\(message\) \{[\s\S]{0,400}?const conversationKey = conversationKeyFor\(message\);/.exec(source);
    assert.ok(webTurn, 'runWebChatTurn 必须用 conversationKeyFor(message) 取会话键');
    // ② 网页入口的"忙不忙"也要用同一个键(旧写法拿 `web:<id>` 去问引擎,永远判不忙)
    assert.match(source, /const turnKey = conversationKeyFor\(\{ scene: 'web', targetId: playerId \}\);/);
    assert.match(source, /if \(runner\.isBusy\(turnKey\)\)/, '判忙要用解析后的会话键');
    // ③ 必须把 identityLinks 的正/反两条记录一起递进去(少一条就无法 fail closed)
    assert.match(source, /const binding = identityLinks\.byPlayer\(playerId\);/);
    assert.match(source, /const reverse = binding\?\.openid \? identityLinks\.byOpenid\(binding\.openid\) : null;/);
    // ④ 模块本身不许偷偷引入依赖/IO(纯函数层)
    const moduleSource = fs.readFileSync(path.join(ROOT, 'src', 'conversation-share.js'), 'utf8');
    assert.ok(!/^import\s/m.test(moduleSource), 'conversation-share.js 必须是零依赖纯函数(不许 import)');
    // ⑤ 作用域按"这一轮从哪来"取档:两个注入点都必须用 memoryAccessForScene,不许退回按键判定
    assert.match(source, /memoryAccessForScene\(\{\s*\n\s*scene: turnOptions\?\.scene \?\? null,/, 'handoffFor 必须按本轮场景取记忆档');
    assert.match(source, /memoryAccessForScene\(\{\s*\n\s*scene: recallFor\?\.scene \?\? null,/, '洞察注入必须按本轮场景取记忆档');
    assert.ok(!/memoryAccessFor\(conversationKey, \{ ownerIds: config\.policy\.admin\?\.ids \?\? null \}\)/.test(source),
      '旧的"只按键判定"调用点必须已经换掉');
    // ⑥ 网页那一轮必须把 scene 交给引擎(否则交接层拿不到"从网页来")
    assert.match(source, /buildToolContext\(message, conversationKey\), \{ scene: 'web' \}\);/);
    // ⑦ 引擎必须把 turnOptions 透传给 handoff(否则 ⑥ 白传)
    const engineSource = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8');
    assert.match(engineSource, /runTurn\(conversationKey, text, turnTimeoutMs, imageBlocks, toolContext = null, turnOptions = \{\}\)/);
    assert.match(engineSource, /initialHandoff\(key, signal, \{ scene: turnOptions\?\.scene \?\? null \}\)/);
  });
}
