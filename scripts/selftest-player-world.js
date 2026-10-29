/**
 * **玩家在世界里的位置**的判据(D 收尾 / 1.99.0 / D160)。
 *
 * ⚠️ 这一层是"共享小游戏"那一半的地基:**你也在某个地方**。
 *    判据分三层:
 *    ① **纯函数**(位置归一 / 默认落点 / 去处 / 走一趟);
 *    ② **服务 + 假库**(写事实、拦住重复出发、到点落地、同处);
 *    ③ **真 HTTP**(临时库 + 随机端口):没登录没有位置、登录后能走、拦得住乱走。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PLACE,
  PLAYER_WORLD_PREFIX,
  allPlayerFacts,
  createPlayerWorld,
  describePlayerWhereabouts,
  placeChoices,
  playerMoveFact,
  playerRoutes,
  playerWhereabouts,
  playerWorldKey,
  readPlayerFact,
} from '../src/player-world.js';
import { PANEL_ROUTES, PANEL_WRITE_ROUTES, startPanel } from '../src/panel.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { createActionExec } from '../src/panel-actions.js';
import { createAccountService } from '../src/player-account.js';

/** 假的状态库。 */
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

export function registerPlayerWorldTests({ test, assert }) {
  test('玩家位置(1.99.0):**与她的那份同构** —— 一条事实,同一套"在途/到期"规矩', () => {
    // ① 键只认数字 id(认不出给 null —— 不猜)
    assert.equal(playerWorldKey(7), `${PLAYER_WORLD_PREFIX}7`);
    assert.equal(playerWorldKey('7'), `${PLAYER_WORLD_PREFIX}7`);
    assert.equal(playerWorldKey(0), null);
    assert.equal(playerWorldKey('me'), null);

    // ② 没有事实 → **默认落在家园**(不是"猜他在哪",是这个世界给新玩家的落点)
    const fresh = playerWhereabouts({ now: 1000 });
    assert.equal(fresh.placeId, DEFAULT_PLACE);
    assert.equal(fresh.known, false, '要能分得清"真有事实"与"默认落点"');
    assert.equal(describePlayerWhereabouts(fresh), '他在家园');

    // ③ 有事实 → 就是那儿
    const fact = playerMoveFact({ target: 'guild', currentPlace: 'home', now: 1000 });
    assert.equal(fact.why, 'player', '⚠️ 是**他**在走(不是 self —— 到达报备只认 self)');
    assert.equal(fact.from, 'home');
    assert.equal(fact.to, 'guild');
    assert.equal(fact.arriveAt, 1000 + 300_000, '路上那几分钟照 travelMs 算');

    // ④ 在途:还没到点时说"正往…走",到了之后落地
    const onWay = playerWhereabouts({ fact, now: 1000 + 1000 });
    assert.equal(onWay.traveling, true);
    assert.equal(onWay.toName, '公会');
    assert.ok(describePlayerWhereabouts(onWay).includes('正往公会走'));
    const landed = playerWhereabouts({ fact, now: fact.arriveAt + 1 });
    assert.equal(landed.traveling, false);
    assert.equal(landed.placeId, 'guild');
    assert.equal(landed.known, true);

    // ⑤ 坏值 / 认不出的地方 → 当没有(不猜),但**不是**报错
    assert.equal(readPlayerFact([{ key: `${PLAYER_WORLD_PREFIX}7`, value: '{坏' }], 7), null);
    assert.deepEqual(allPlayerFacts([{ key: `${PLAYER_WORLD_PREFIX}7`, value: '{"place":"guild"}' }, { key: 'world:her', value: '{}' }])
      .map((row) => row.playerId), [7], '只挑玩家那些键');
  });

  test('玩家位置(1.99.0):去处**从世界那张表算**;在路上时不给去处', () => {
    const where = playerWhereabouts({ now: 1000 }); // 默认家园
    const routes = playerRoutes({ where });
    assert.ok(routes.length > 0, '家园总得能去几个地方');
    assert.ok(routes.every((row) => row.id && row.name && row.travelMs > 0), '每条都要有名字与路上时间');
    assert.ok(!routes.some((row) => row.id === 'home'), '不许给"去你已经在的地方"');
    // ⚠️ 在路上 → 一条都不给(半路改道会让"到点"这件事没法收场)
    assert.deepEqual(playerRoutes({ where: { traveling: true, placeId: 'home' } }), []);
    // 认不出的地方 → 也不给(不猜)
    assert.deepEqual(playerRoutes({ where: { traveling: false, placeId: '月球' } }), []);
    // 世界那几处都在表里
    const all = placeChoices();
    assert.ok(all.length >= 4);
    assert.ok(all.every((row) => row.id && row.name));
  });

  test('玩家位置(1.99.0):服务层 —— 走一趟、拦住重复出发、到点落地、**同处看得出来**', () => {
    const store = fakeStore();
    let clock = 1_700_000_000_000;
    const hers = { placeId: 'guild', traveling: false, placeName: '公会' };
    const world = createPlayerWorld({ store, now: () => clock, log: { warn: () => {}, info: () => {} }, herFact: () => hers });

    // ① 一开始:默认家园;她在公会 → **不同处**
    const first = world.view(7);
    assert.equal(first.where.placeId, 'home');
    assert.equal(first.withHer, false);
    assert.ok(first.routes.length > 0, '能去哪儿要由服务端给');

    // ② 走一趟 → 写进库(键就是 `world:player:7`),而且在途
    const moved = world.move(7, 'guild');
    assert.equal(moved.ok, true);
    assert.ok(store.getMeta(`${PLAYER_WORLD_PREFIX}7`), '要真的落库');
    const onWay = world.view(7);
    assert.equal(onWay.where.traveling, true);
    assert.equal(onWay.where.toName, '公会');
    assert.deepEqual(onWay.routes, [], '在路上不给去处按钮');

    // ③ ⚠️ 在路上再走 → 拒(不写假事实)
    const again = world.move(7, 'market');
    assert.equal(again.ok, false);
    assert.equal(again.error, 'already_traveling');

    // ④ 到点 → 落地;⚠️ 而且她在公会 → **同处**
    clock = moved.fact.arriveAt + 1000;
    const landed = world.view(7);
    assert.equal(landed.where.traveling, false);
    assert.equal(landed.where.placeId, 'guild');
    assert.equal(landed.withHer, true, '你到了她所在的地方 —— 这一眼才是"共享小游戏"');
    assert.ok(landed.herLine.includes('公会'));

    // ⑤ 已经在这儿 / 认不出的地方 → 拒,而且**说清为什么**
    assert.equal(world.move(7, 'guild').error, 'already_there');
    assert.equal(world.move(7, '月球').error, 'bad_place');
    assert.equal(world.move('x', 'guild').error, 'no_player');

    // ⑥ ⚠️ **她也在路上**时不算同处(半路的两个人不算碰上了)
    const world2 = createPlayerWorld({
      store, now: () => clock, log: { warn: () => {}, info: () => {} },
      herFact: () => ({ placeId: 'guild', traveling: true, toName: '市集' }),
    });
    assert.equal(world2.view(7).withHer, false);
  });

  test('玩家位置(1.99.0):接口在册;而且**真 HTTP** 走一遍 没登录没位置 → 登录后能走', async () => {
    assert.equal(PANEL_ROUTES['GET /api/player'], 'playerInfo');
    assert.equal(PANEL_ROUTES['POST /api/player'], 'playerMove');
    assert.ok(PANEL_WRITE_ROUTES.includes('POST /api/player'), 'POST /api/player 必须在写路径白名单里');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-pworld-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const port = 21_200 + Math.floor(Math.random() * 300);
    const token = 'pworld-suite-token';
    const accounts = createAccountService({ store, log: () => {} });
    const { generateInviteCode } = await import('../src/player-account.js');
    accounts.repo.insertInvite({ code: generateInviteCode() });
    const invite = accounts.repo.listInvites(5)[0].code;
    const panel = startPanel({
      config: {
        policy: {
          mood: { theme: 'megumin' }, stats: { theme: 'megumin' }, warmup: { sleep: null },
          panel: { enabled: true, host: '127.0.0.1', port, token, refreshMs: 5000, allowedHosts: [] },
        },
        qq: { appId: 'APP' },
      },
      actionExec: createActionExec({ store, appId: 'APP', log: { info: () => {}, warn: () => {} } }),
      accounts,
      playerWorld: createPlayerWorld({ store, log: { warn: () => {}, info: () => {} }, herFact: () => ({ placeId: 'home', traveling: false, placeName: '家园' }) }),
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

      // ① 没登录 → 没位置(不给匿名者编一个身份)
      assert.equal((await req('/api/player', { headers: { 'x-panel-token': token } })).status, 403);
      assert.equal((await req('/api/player', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-panel-token': token },
        body: JSON.stringify({ to: 'guild' }),
      })).status, 403);

      // ② 注册 → 拿票
      const html = await (await req('/account')).text();
      const nonce = new RegExp(`name=${q}nonce${q} value=${q}([^${q}]*)${q}`).exec(html)?.[1] ?? '';
      const reg = await req('/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', referer: `${base}/account` },
        body: new URLSearchParams({
          nonce, invite, account: 'walker', nickname: '走路的人',
          password: 'hunter2hunter2', password2: 'hunter2hunter2', question: '食物?', answer: '番茄',
        }).toString(),
        redirect: 'manual',
      });
      assert.equal(reg.status, 200, `注册应当成功(拿到 ${reg.status})`);
      const identity = reg.headers.getSetCookie().find((row) => row.startsWith('hhauth='))?.split(';')[0] ?? '';
      const session = reg.headers.getSetCookie().find((row) => row.startsWith('hhpanel='))?.split(';')[0] ?? '';
      const cookie = `${identity}; ${session}`;

      // ③ 读了才知道自己在哪儿(默认家园),而且**按钮由服务端给**
      const info = await (await req('/api/player', { headers: { 'x-panel-token': token, cookie } })).json();
      assert.equal(info.ok, true);
      assert.equal(info.where.placeId, 'home');
      assert.ok(info.routes.length > 0);
      assert.equal(info.withHer, true, '她也默认在家园 → 一开始就同处');

      // ④ 走一趟 → 在途;而且**落库了**(换一次请求也说得出来)
      const move = await req('/api/player', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-token': token, cookie },
        body: JSON.stringify({ to: 'guild' }),
      });
      assert.equal(move.status, 200, `走得动(拿到 ${move.status})`);
      const moved = await move.json();
      assert.equal(moved.where.traveling, true);
      assert.equal(moved.where.toName, '公会');
      const again = await (await req('/api/player', { headers: { 'x-panel-token': token, cookie } })).json();
      assert.equal(again.where.traveling, true, '位置事实落库了');

      // ⑤ 在路上再走 → 409(不是静默成功)
      const blocked = await req('/api/player', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-token': token, cookie },
        body: JSON.stringify({ to: 'market' }),
      });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error, 'already_traveling');

      // ⑥ 认不出的地方 → 400;空目标 → 400
      const bad = await req('/api/player', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-token': token, cookie },
        body: JSON.stringify({ to: '月球' }),
      });
      assert.equal(bad.status, 409);
      assert.equal((await bad.json()).error, 'bad_place');
      const empty = await req('/api/player', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-token': token, cookie },
        body: JSON.stringify({}),
      });
      assert.equal(empty.status, 400);
    } finally {
      panel.close();
      try { store.close?.(); } catch { /* 已经关了 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
