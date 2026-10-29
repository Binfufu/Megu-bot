/**
 * **身份绑定**的判据(D 第二刀 / 1.97.0 / D158)。
 *
 * 用户原话:「最好能让网页登录完的玩家能绑定自己 qq 昵称,这样在 qq 又能认出来是谁」。
 *
 * ⚠️ 三层,和这个项目别处一样:
 *   ① **纯函数**(口令的形状 / 认出 / 核销)—— 不碰库;
 *   ② **服务 + 假库**(一次性、过期、一对一、解绑);
 *   ③ **真 HTTP**(临时库 + 随机端口):没登录不给口令、登录后能发口令、私聊核销后
 *      `people.js` 那边**两行合成一行**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BIND_ALPHABET,
  BIND_CODE_LENGTH,
  BIND_META_PREFIX,
  BIND_TTL_MS,
  bindMetaKey,
  buildIdentityNote,
  createIdentityLinks,
  describeBinding,
  formatBindCode,
  looksLikeBindCode,
  makeBindCode,
  parseBindCode,
  redeemBindCode,
} from '../src/identity-link.js';
import { joinPeople, peopleFromAccounts, peopleFromAffinities, peopleFromPersons, describePerson, nameIsInvisible } from '../src/people.js';
import { PANEL_ROUTES, PANEL_WRITE_ROUTES, startPanel } from '../src/panel.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { createActionExec } from '../src/panel-actions.js';
import { createAccountService } from '../src/player-account.js';

/** 假的状态库(只实现这个模块用到的)。 */
function fakeStore() {
  const metas = new Map();
  return {
    metas,
    getMeta: (key) => (metas.has(key) ? metas.get(key) : null),
    setMeta: (key, value) => { metas.set(key, value); },
    listMetaKeys: (prefix = '') => [...metas.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
  };
}

export function registerIdentityTests({ test, assert }) {
  test('身份绑定(1.97.0):口令的**形状** —— 手抄不会看错,而且认得出"这是在绑定"', () => {
    // ① 字符集里没有 I/O/0/1(手抄最容易看错的四个)
    assert.ok(!BIND_ALPHABET.includes('I') && !BIND_ALPHABET.includes('O'));
    assert.ok(!BIND_ALPHABET.includes('0') && !BIND_ALPHABET.includes('1'));
    // ② 生成:确定性的随机源 → 确定性的口令(单测能钉住)
    const code = makeBindCode({ bytes: Buffer.from([0, 0, 0, 0, 0, 0]) });
    assert.equal(code, 'HH-AAAAAA');
    assert.equal(code.length, 'HH-'.length + BIND_CODE_LENGTH);
    // ③ 认得出(大小写、有没有横线、前后空格都行)
    for (const text of ['HH-K7M2QP', 'hh-k7m2qp', 'hhk7m2qp', ' hh K7M2QP ', '/绑定 HH-K7M2QP']) {
      assert.equal(parseBindCode(text), 'HH-K7M2QP', `认不出「${text}」`);
      assert.equal(looksLikeBindCode(text), true);
    }
    // ④ ⚠️ **不许把普通话说成口令**(否则她聊天时会一直以为你在绑定)
    for (const text of ['你好', 'HH', 'HH-', '绑定', 'K7M2QP', '今天天气不错','HH-!!!']) {
      assert.equal(parseBindCode(text), null, `「${text}」不该被当口令`);
    }
    assert.equal(formatBindCode('k7m2qp'), 'HH-K7M2QP');
    assert.equal(formatBindCode(''), '');
    // ⚠️ **两端空白也要去掉**(1.99.1 复核):不然前导空白会挡住"去前缀"那一步
    assert.equal(formatBindCode(' hh-k7m2qp '), 'HH-K7M2QP');
    assert.equal(formatBindCode('\tHH-K7M2QP\n'), 'HH-K7M2QP');
    // ⚠️ 生成时**正文不许以 HH 开头**(否则 `HH-HHAB23` 会被手抄成 `HH-AB23`)
    const hBytes = Buffer.alloc(BIND_CODE_LENGTH, BIND_ALPHABET.indexOf('H'));
    assert.equal(makeBindCode({ bytes: hBytes }), 'HH-AAAAAA', '撞上 HH 开头就重摇/退回固定值');
    // ⑤ meta 键:只认**规范的**正整数写法(否则同一个账号会有两个键)
    assert.equal(bindMetaKey(7), `${BIND_META_PREFIX}7`);
    assert.equal(bindMetaKey('7'), `${BIND_META_PREFIX}7`);
    assert.equal(bindMetaKey('abc'), null);
    assert.equal(bindMetaKey(''), null);
    assert.equal(bindMetaKey('0'), null, '0 不是账号');
    assert.equal(bindMetaKey('007'), null, '带前导零的写法不许建出第二个键');
    assert.equal(bindMetaKey('-3'), null);
    assert.equal(bindMetaKey(7.5), null);
  });

  test('身份绑定(1.97.0):核销是**纯函数** —— 过期/陌生/没带 id 一律不给过', () => {
    const now = 1_700_000_000_000;
    const pending = [{ code: 'HH-K7M2QP', playerId: 7, expiresAt: now + 60_000 }];
    // ① 正常
    const ok = redeemBindCode({ pending, text: 'HH-K7M2QP', now, openid: 'OPENID-A', displayName: '示例甲' });
    assert.equal(ok.ok, true);
    assert.equal(ok.playerId, 7);
    assert.equal(ok.openid, 'OPENID-A');
    assert.equal(ok.displayName, '示例甲');
    // ② 过期 → 明确说"过期",不是笼统的失败(页面上的提示不一样)
    assert.equal(redeemBindCode({ pending, text: 'HH-K7M2QP', now: now + 60_001, openid: 'X' }).error, 'expired_code');
    // ③ 陌生口令 / 不是口令 / 没有 openid
    assert.equal(redeemBindCode({ pending, text: 'HH-ZZZZZZ', now, openid: 'X' }).error, 'unknown_code');
    assert.equal(redeemBindCode({ pending, text: '你好', now, openid: 'X' }).error, 'not_a_code');
    assert.equal(redeemBindCode({ pending, text: 'HH-K7M2QP', now, openid: '' }).error, 'no_openid');
    // ④ 口令里带着坏账号 → 不给过(不猜是谁)
    assert.equal(redeemBindCode({ pending: [{ ...pending[0], playerId: 'x' }], text: 'HH-K7M2QP', now, openid: 'X' }).error, 'bad_player');
  });

  test('身份绑定(1.97.0):一次性的、有时限的,而且**一个人只有一个 QQ**', () => {
    const store = fakeStore();
    let clock = 1_700_000_000_000;
    const links = createIdentityLinks({ store, now: () => clock, log: { warn: () => {}, info: () => {} } });

    // ① 发口令:能拿到、而且**写进了库**(同一个账号再问还能看到那一枚)
    const issued = links.issue(7, { playerName: '示例队友甲' });
    assert.equal(issued.ok, true);
    assert.match(issued.code, /^HH-[A-Z2-9]{6}$/);
    assert.ok(issued.expiresAt > clock, '要有失效时刻');
    const pending = links.pendingOf(7);
    assert.equal(pending.code, issued.code, '同一枚口令(不能每次刷新都换一个)');
    assert.equal(links.byPlayer(7), null, '还没核销 → 不算绑上');

    // ② 核销 → 绑上;而且是**一次性的**(同一枚不能再核销一次)
    const first = links.redeem({ text: issued.code, openid: 'OPENID-A', displayName: '示例甲' });
    assert.equal(first.ok, true);
    assert.equal(first.playerId, 7);
    assert.equal(links.byPlayer(7).openid, 'OPENID-A');
    assert.equal(links.pendingOf(7), null, '用完就清掉(不许留着第二个人还能用)');
    assert.equal(links.redeem({ text: issued.code, openid: 'OPENID-B' }).error, 'unknown_code', '同一枚口令不许用第二次');
    assert.equal(links.byOpenid('OPENID-A').playerId, 7, '反查也要能查到');

    // ③ 过期:到点了就不认
    const again = links.issue(7);
    clock += BIND_TTL_MS + 1000;
    assert.equal(links.redeem({ text: again.code, openid: 'OPENID-A' }).error, 'expired_code');

    // ④ ⚠️ **一个人只有一个 QQ**:同一个 QQ 去绑另一个账号 → 旧的那条**解掉**(不是留两条)
    const other = links.issue(8);
    const moved = links.redeem({ text: other.code, openid: 'OPENID-A', displayName: '示例甲' });
    assert.equal(moved.ok, true);
    assert.equal(moved.playerId, 8);
    assert.equal(links.byPlayer(8).openid, 'OPENID-A');
    assert.equal(links.byPlayer(7), null, '换绑之后旧账号那条必须解掉');
    assert.equal(links.byOpenid('OPENID-A').playerId, 8, '反查只能指到一个');

    // ⑤ 解绑(网页上点「解绑」)
    assert.equal(links.unbind(8).ok, true);
    assert.equal(links.byPlayer(8), null);
    assert.equal(links.byOpenid('OPENID-A'), null);

    // ⑥ 人话:绑了就说绑了谁,没绑就直说
    assert.equal(describeBinding(null), '还没绑 QQ');
    assert.equal(describeBinding({ openid: 'X', displayName: '示例乙' }), '已绑定 QQ：示例乙');
    assert.equal(describeBinding({ openid: 'X' }), '已绑定 QQ');
    // ⑦ 坏值不许炸(库里有半条记录是常事)
    store.setMeta(`${BIND_META_PREFIX}9`, '{坏');
    assert.deepEqual(links.byPlayer(9), null);
  });

  test('身份绑定(1.97.0):**两套身份合成一个人** —— 没绑的照旧各自成行(行为不变)', () => {
    const accounts = peopleFromAccounts([{ id: 7, account: 'demo_b', nickname: '示例队友甲', disabled: false }]);
    const affinities = peopleFromAffinities([
      { key: 'affinity:OPENID-A', value: JSON.stringify({ id: 'OPENID-A', name: '示例甲', score: 12, tier: { label: '朋友' } }) },
      { key: 'affinity:OPENID-B', value: JSON.stringify({ id: 'OPENID-B', name: '示例丙', score: 3, tier: { label: '眼熟' } }) },
    ]);

    // ① **没绑**:两行照旧(与 1.91.0 的行为逐字相同)
    const before = joinPeople(accounts, affinities, []);
    assert.equal(before.people.length, 3, '没绑的时候:1 个账号 + 2 个熟人 = 3 行');
    assert.equal(before.merged.length, 0);

    // ② **绑了**:账号那一行**取代**了那个熟人 —— 一共 2 行,不是 3 行
    const after = joinPeople(accounts, affinities, [{ playerId: 7, openid: 'OPENID-A', displayName: '示例甲' }]);
    assert.equal(after.people.length, 2, '绑了之后:那个熟人不再是单独一行');
    assert.equal(after.merged.length, 1);
    assert.equal(after.merged[0].playerId, 7);
    const merged = after.people.find((row) => row.id === 'player:7');
    assert.ok(merged, '节点 id 仍然用账号那个(player:7)');
    assert.equal(merged.openid, 'OPENID-A', 'openid 也带上(要按 openid 回查也能查到)');
    assert.equal(merged.affinity.tierLabel, '朋友', '⚠️ 合的是身份,好感那本账照旧挂过来(而且只出档位)');
    assert.equal(merged.label, '示例队友甲', '名字优先用账号那边的昵称');
    assert.ok(describePerson(merged).includes('已绑 QQ'), `报表上要看得出来:${describePerson(merged)}`);
    // ③ 没被认领的熟人还在(只合该合的那一条)
    assert.ok(after.people.some((row) => row.id === 'person:OPENID-B'));
    // ④ 认不出的绑定(账号不存在)不许把熟人吞掉
    const ghost = joinPeople(accounts, affinities, [{ playerId: 999, openid: 'OPENID-A' }]);
    assert.equal(ghost.people.length, 3, '绑定指向一个不存在的账号 → 什么都不合');
  });

  test('三套身份(1.100.0):**她世界里的玩家**(`person` 表)也要合进来 —— 那是她会叫的名字', () => {
    // ① 同一个 openid 在多个群出现 → **一个人**(scope 累加、turns 相加)
    const persons = peopleFromPersons([
      { scope: 'group:G1', openid: 'OPENID-A', display: '示例甲', lastSeen: 100, turns: 5 },
      { scope: 'group:G2', openid: 'OPENID-A', display: 'Demo A', lastSeen: 200, turns: 3 },
      { scope: 'c2c:9', openid: 'OPENID-B', display: '\u3164\u3164', lastSeen: 50 },
    ]);
    assert.equal(persons.length, 2, '同一个人不许因为出现在两个群就变成两个人');
    const a = persons.find((row) => row.openid === 'OPENID-A');
    assert.equal(a.label, 'Demo A', '名字取**最近见到**的那个');
    assert.equal(a.toldName, 'Demo A', '而且记成"她被告知的名字"');
    assert.deepEqual(a.scenes.sort(), ['group:G1', 'group:G2'], '在哪些场合记过也要留着');
    assert.equal(a.turns, 8, '见过的次数相加');
    assert.equal(a.source, 'person');
    // ② 名字整条不可见 → 不编名字
    assert.equal(persons.find((row) => row.openid === 'OPENID-B').label, '（QQ 上的熟人）');
    // ③ 认不出的行直接跳过
    assert.deepEqual(peopleFromPersons([{ openid: '' }, null, { openid: '  ' }]), []);

    // ④ **三套合起来**:账号 + QQ 熟人 + 她记下的人 → 绑过的仍是一个人
    const accounts = peopleFromAccounts([{ id: 7, account: 'demo_b', nickname: '示例队友甲' }]);
    const affinities = peopleFromAffinities([
      { key: 'affinity:OPENID-A', value: JSON.stringify({ id: 'OPENID-A', name: '自动记的名', score: 12, tier: { label: '朋友' } }) },
    ]);
    const joined = joinPeople(accounts, affinities, [{ playerId: 7, openid: 'OPENID-A' }], persons);
    assert.equal(joined.merged.length, 1, '绑过了:合成一个');
    assert.equal(joined.people.length, 2, '账号那一行 + 没被认领的 OPENID-B');
    const merged = joined.people.find((row) => row.id === 'player:7');
    assert.equal(merged.label, '示例队友甲', '**玩家自己起的昵称最优先**');
    assert.equal(merged.affinity.tierLabel, '朋友', '档位仍来自 QQ 那本账');
    assert.deepEqual(merged.scenes.sort(), ['group:G1', 'group:G2'], '她在哪些场合记过他也要带上');

    // ⑤ 名字优先级:**玩家昵称 > 她被告知的名字(`/认人`)> 自动记的**
    const noNick = peopleFromAccounts([{ id: 7, account: 'demo_b', nickname: '' }]);
    const told = joinPeople(noNick, affinities, [{ playerId: 7, openid: 'OPENID-A' }], persons);
    assert.equal(told.people[0].label, 'Demo A', '没昵称时用**她被告知的名字**');
    // 没有第三套时,退回 affinity 自动记的名字(与 1.97.0 行为一致)
    const auto = joinPeople(noNick, affinities, [{ playerId: 7, openid: 'OPENID-A' }], []);
    assert.equal(auto.people[0].label, '自动记的名');
  });

  test('三套身份(1.100.0):`personByOpenid` **按人取**、最近见到在前(活库上真的能查)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-person-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    try {
      store.touchPerson({ scope: 'group:G1', openid: 'O-A', display: '旧的', scene: 'group' }, 1000);
      store.touchPerson({ scope: 'group:G2', openid: 'O-A', display: '新的', scene: 'group' }, 5000);
      store.touchPerson({ scope: 'group:G1', openid: 'O-B', display: '另一个人', scene: 'group' }, 3000);
      const rows = store.personByOpenid('O-A');
      assert.equal(rows.length, 2, '同一个人在两个群 → 两行(openid 按群发,D09)');
      assert.equal(rows[0].display, '新的', '最近的在前');
      assert.deepEqual(rows.map((r) => r.scope), ['group:G2', 'group:G1']);
      assert.deepEqual(store.personByOpenid(''), [], '空 openid 给空数组(不查全表)');
      assert.deepEqual(store.personByOpenid('没有这个人'), []);
      assert.deepEqual(store.personByOpenid('O-B').map((r) => r.display), ['另一个人']);
    } finally {
      try { store.close?.(); } catch { /* 已经关了 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('身份绑定(1.97.0):**她该知道的那一句** —— 只说"是同一个人",绝不报 id', () => {
    // ⚠️ 用**真的** `nameIsInvisible`(people.js 里那份),不用自写替身 ——
    //    第一版我在这里自己写了个"看起来一样"的正则,结果**漏了 HANGUL FILLER(\u3164)**,
    //    用例红得莫名其妙;用真函数就没有"替身与实现分叉"这回事。
    const hidden = nameIsInvisible;
    const player = { id: 7, account: 'demo_a', nickname: '示例甲' };
    const binding = { playerId: 7, openid: 'OPENID-REAL', displayName: '示例甲' };

    // ① QQ 那一轮:她要知道"这个人就是网页上的某某"(这样叫得出名字)
    const qq = buildIdentityNote({ scene: 'qq', player, binding, nameIsInvisible: hidden });
    assert.ok(qq.includes('示例甲'), `要说得出名字:${qq}`);
    assert.ok(!qq.includes('OPENID-REAL'), 'id 不许进提示词');
    assert.ok(!qq.includes('demo_a'), '账号名也不许进（那是登录名,不是称呼）');
    // ⚠️ **还要说清"什么时候用它"**(1.100.1 / D163):光陈述"是同一个人"没用 ——
    //    用户实测「绑定完没什么用,到 QQ 就不知道了」。所以这句必须给出用它的场合。
    assert.ok(/问起|称呼/.test(qq), `要交代"什么时候用这个名字":${qq}`);

    // ①-b ⚠️ **她被告知的名字(`/认人`)压过绑定时抓到的那个**(1.100.0 / D162):
    //      操作者明确说过的称呼,比她绑定那一刻顺手抓到的显示名更该用。
    const told = buildIdentityNote({
      scene: 'qq', player: { id: 7, account: 'demo_a', nickname: '' },
      binding: { playerId: 7, openid: 'OPENID-REAL', displayName: '绑定时抓的名' },
      toldName: '认人时给的名', nameIsInvisible: hidden,
    });
    assert.ok(told.includes('认人时给的名'), `要用她被告知的名字:${told}`);
    assert.ok(!told.includes('绑定时抓的名'), '别用绑定时那个');
    // 而**玩家自己起的昵称**仍然最优先
    const nick = buildIdentityNote({
      scene: 'qq', player: { id: 7, account: 'demo_a', nickname: '我自己起的' },
      binding: { playerId: 7, openid: 'OPENID-REAL', displayName: '绑定时抓的名' },
      toldName: '认人时给的名', nameIsInvisible: hidden,
    });
    assert.ok(nick.includes('我自己起的'), `玩家昵称最优先:${nick}`);
    // 反向(网页那一轮)同样:`/认人` 的名字压过绑定时抓的
    const webTold = buildIdentityNote({
      scene: 'web', binding: { openid: 'X', displayName: '绑定时抓的名' },
      toldName: '认人时给的名', nameIsInvisible: hidden,
    });
    assert.ok(webTold.includes('认人时给的名'), `网页那一轮也要用被告知的名字:${webTold}`);

    // ② 网页那一轮:反过来,她知道"这个人在 QQ 里叫什么"
    const web = buildIdentityNote({ scene: 'web', binding, nameIsInvisible: hidden });
    assert.ok(web.includes('示例甲'));
    assert.ok(!web.includes('OPENID-REAL'));

    // ③ ⚠️ **昵称整条不可见**时不许把空白当名字(库里真有这种昵称)——
    //    退回账号名是可以的(那也是他自己起的、看得见),但**空白字符一个都不许进去**。
    const invisible = buildIdentityNote({
      scene: 'qq', binding: { ...binding, displayName: '' },
      player: { id: 7, account: 'demo_a', nickname: '\u3164\u3164' }, nameIsInvisible: hidden,
    });
    assert.ok(!invisible.includes('\u3164'), '零宽/空白昵称不许进提示词');
    assert.ok(invisible.includes('demo_a'), '退回账号名(库里的最后一道)');
    // 连账号名都不可见时才走"没留名字"那一路
    const noName = buildIdentityNote({
      scene: 'qq', binding: { ...binding, displayName: '' },
      player: { id: 7, account: '\u3164', nickname: '\u3164\u3164' }, nameIsInvisible: hidden,
    });
    assert.ok(noName.includes('没留名字'), `都没名字时要照实说:${noName}`);

    // ④ 没绑的两个方向都要**照实说**(别让她以为人人都绑过)
    assert.ok(buildIdentityNote({ scene: 'qq' }).includes('没有账号'));
    assert.ok(buildIdentityNote({ scene: 'web', binding: null }).includes('还没把'));
    // ⚠️ **没绑**那一句与"绑了但账号行被删"必须分得开:
    //    后者由调用方(`index.js` 的 `identityNoteFor`)**直接不说** ——
    //    判据钉在这里:传 `player: null` 而 `binding` 有值时,这句话会与"绑过"矛盾。
    const contradiction = buildIdentityNote({ scene: 'qq', player: null, binding: { openid: 'X' } });
    assert.ok(contradiction.includes('没有账号'),
      '⚠️ 这一句就是"调用方必须在 player 为空时别说"的理由(印在这里当护栏)');
    // ⑤ 认不出的场景 → null(不猜)
    assert.equal(buildIdentityNote({ scene: 'none' }), null);
    assert.equal(buildIdentityNote({}), null);
  });

  test('身份绑定(1.97.0):接口在册;而且**真 HTTP** 走一遍 发口令 → 私聊核销 → 那一栏说得出来', async () => {
    // ① 路由必须在册(写路径漏一条就会 405)
    assert.equal(PANEL_ROUTES['GET /api/bind'], 'bindInfo');
    assert.equal(PANEL_ROUTES['POST /api/bind'], 'bindDo');
    assert.ok(PANEL_WRITE_ROUTES.includes('POST /api/bind'), 'POST /api/bind 必须在写路径白名单里');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-bind-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const port = 20_800 + Math.floor(Math.random() * 300);
    const token = 'bind-suite-token';
    const accounts = createAccountService({ store, log: () => {} });
    accounts.repo.insertInvite({ code: 'BINDCODE1' });
    const identityLinks = createIdentityLinks({ store, log: { warn: () => {}, info: () => {} } });
    const panel = startPanel({
      config: {
        policy: {
          mood: { theme: 'demo' }, stats: { theme: 'demo' }, warmup: { sleep: null },
          panel: { enabled: true, host: '127.0.0.1', port, token, refreshMs: 5000, allowedHosts: [] },
        },
        qq: { appId: 'APP' },
      },
      actionExec: createActionExec({ store, appId: 'APP', log: { info: () => {}, warn: () => {} } }),
      accounts,
      identityLinks,
      log: () => {},
      snapshot: () => ({}),
    });
    const base = `http://127.0.0.1:${port}`;
    const req = async (route, init = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try { return await fetch(`${base}${route}`, { ...init, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    };
    const q = String.fromCharCode(34);
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i += 1) {
        try { up = (await req('/account')).status === 200; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(up, '面板要起来');

      // ② **没登录** → 不给口令(服务端拦)
      const anon = await req('/api/bind', { method: 'POST', headers: { 'content-type': 'application/json', 'x-panel-token': token }, body: JSON.stringify({ action: 'issue' }) });
      assert.equal(anon.status, 403);
      const anonRead = await req('/api/bind', { headers: { 'x-panel-token': token } });
      assert.equal(anonRead.status, 403, '没登录也不许看绑没绑');

      // ③ 注册 → 拿票
      const html = await (await req('/account')).text();
      const nonce = new RegExp(`name=${q}nonce${q} value=${q}([^${q}]*)${q}`).exec(html)?.[1] ?? '';
      const reg = await req('/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', referer: `${base}/account` },
        body: new URLSearchParams({
          nonce, invite: 'BINDCODE1', account: 'demo_a', nickname: '示例甲',
          password: 'hunter2hunter2', password2: 'hunter2hunter2', question: '食物?', answer: '番茄',
        }).toString(),
        redirect: 'manual',
      });
      assert.equal(reg.status, 200);
      const identity = reg.headers.getSetCookie().find((row) => row.startsWith('hhauth='))?.split(';')[0] ?? '';
      const session = reg.headers.getSetCookie().find((row) => row.startsWith('hhpanel='))?.split(';')[0] ?? '';
      const cookie = `${identity}; ${session}`;
      const headers = { 'content-type': 'application/json', 'x-panel-token': token, cookie };

      // ④ 要口令 → 拿到一串;再读一次还是同一条(不许刷新就换)
      const issue = await req('/api/bind', { method: 'POST', headers, body: JSON.stringify({ action: 'issue' }) });
      assert.equal(issue.status, 200);
      const issued = await issue.json();
      assert.match(issued.code, /^HH-[A-Z2-9]{6}$/, `要拿到口令:${JSON.stringify(issued)}`);
      assert.equal(issued.bound, null, '还没核销 → 不算绑上');
      const again = await (await req('/api/bind', { headers: { 'x-panel-token': token, cookie } })).json();
      assert.equal(again.pending.code, issued.code, '刷新一次还是同一枚口令');

      // ⑤ **QQ 那边核销**(私聊那条路走的就是这个调用)
      const redeemed = identityLinks.redeem({ text: issued.code, openid: 'OPENID-REAL', displayName: '示例甲' });
      assert.equal(redeemed.ok, true);
      const boundNow = await (await req('/api/bind', { headers: { 'x-panel-token': token, cookie } })).json();
      assert.ok(boundNow.bound, '核销之后页面要看得出来绑上了');
      assert.equal(boundNow.bound.displayName, '示例甲');
      assert.equal(boundNow.pending, null, '绑上了就别再显示口令');
      // ⚠️ **openid 不出网**(它拿去就能冒充):页面上只给"看得出是哪一条"的形状
      assert.ok(!JSON.stringify(boundNow).includes('OPENID-REAL'), 'openid 不许原样出网');

      // ⑥ 解绑
      const cleared = await req('/api/bind', { method: 'POST', headers, body: JSON.stringify({ action: 'clear' }) });
      assert.equal(cleared.status, 200);
      assert.equal((await cleared.json()).bound, null);
    } finally {
      panel.close();
      try { store.close?.(); } catch { /* 已经关了 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
