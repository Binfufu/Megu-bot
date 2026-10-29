/**
 * **积分账本回归**(2026-10-12 / D203):网页聊天按档限额,超出走积分。
 *
 * 判据分三层:
 *   ① **纯函数**:`decideTurn` 的 free/paid/blocked 三岔、按档额度(**游客 0 = 只能看**,1.120.0)、
 *      游客指纹(同票同号、异票异号、库里不留原票);
 *   ② **服务层**:账本按 subject 分本(严禁串台)、免费额度用完闸门拦、发积分后能继续、
 *      余额扣到 0 再拦(用 readonly 档当样本 —— 游客那档现在是 0,循环不了);
 *   ③ **真 HTTP**:游客在门口就被 403 login_required 拦下(**一个轮都不跑**),登录后按
 *      member 档聊、**她超时没回的那一轮不算**、额度填满后 402 带充值档位、发分续命。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { panelShellExpanded, startPanel } from '../src/panel.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { createAccountService, generateInviteCode } from '../src/player-account.js';
import { createIdentityLinks } from '../src/identity-link.js';
import { createWebChat } from '../src/webchat.js';
// ⚠️ 2026-10-14(D229):`createRoomService`(网页群聊房)已随「群组」那一栏删除 —— 这里不再 import。
import { createCredits, decideTurn, quotaForTier, subjectForGuestKey, subjectForPlayer, FREE_QUOTA } from '../src/credits.js';

const TOKEN = 'credits-suite-token';

export function registerCreditTests({ test, assert }) {
  test('积分(纯):decideTurn 三岔 —— 额度内 free、超额度有分 paid、没分 blocked', () => {
    assert.equal(decideTurn({ used: 0, quota: 10, balance: 0 }), 'free');
    assert.equal(decideTurn({ used: 9, quota: 10, balance: 0 }), 'free');
    assert.equal(decideTurn({ used: 10, quota: 10, balance: 0 }), 'blocked');
    assert.equal(decideTurn({ used: 12, quota: 10, balance: 3 }), 'paid');
    assert.equal(decideTurn({ used: 12, quota: 10, balance: 0 }), 'blocked');
    // 负数 / 垃圾输入不许炸,也不许放行
    assert.equal(decideTurn({ used: -5, quota: 10, balance: 0 }), 'free');
    assert.equal(decideTurn({}, 'x'), 'blocked');
  });

  test('积分(纯):按档额度 —— 游客 0(只能看)/ 只读 100 / 带码 200,staff 不限;未知档 fail closed', () => {
    assert.equal(quotaForTier('guest'), 0, '游客 0:1.120.0 起分享出去的票只能看');
    assert.equal(decideTurn({ used: 0, quota: 0, balance: 0 }), 'blocked', '额度 0 就是进不去');
    assert.equal(quotaForTier('readonly'), FREE_QUOTA.readonly);
    assert.equal(quotaForTier('member'), FREE_QUOTA.member);
    assert.equal(quotaForTier('staff'), Number.POSITIVE_INFINITY);
    assert.equal(quotaForTier('nonsense'), FREE_QUOTA.guest, '认不出的档不给多(fail closed)');
  });

  test('积分(纯):游客指纹 —— 同票同号、异票异号、账号号不混、库里不留原票', () => {
    const a1 = subjectForGuestKey('ticket-aaa');
    const a2 = subjectForGuestKey('ticket-aaa');
    const b = subjectForGuestKey('ticket-bbb');
    assert.ok(a1 && a1.startsWith('guest:'), '游客代号要有固定前缀');
    assert.equal(a1, a2, '同一枚票 = 同一本账(不然每天白送 10 轮 × N)');
    assert.notEqual(a1, b, '不同票不许串台');
    assert.ok(!a1.includes('ticket-aaa'), '代号里不许出现原票(票会轮换,代号不能跟着换)');
    assert.equal(subjectForPlayer(7), 'player:7');
    assert.equal(subjectForPlayer(0), null, '非法 id 拒绝');
    assert.equal(subjectForGuestKey(''), null, '空票拒绝(fail closed)');
  });

  test('积分(服务):账本分本、免费额度闸门、发积分续命、扣到 0 再拦(readonly 当样本)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-credits-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    try {
      const credits = createCredits({ store, log: { info: () => {}, warn: () => {} } });
      const reader = subjectForGuestKey('device-xyz');
      const other = subjectForGuestKey('device-other');

      // 前 100 轮全在免费额度内;第 101 次闸门要拦
      for (let i = 0; i < FREE_QUOTA.readonly; i += 1) {
        const verdict = credits.gate(reader, 'readonly');
        assert.equal(verdict.ok, true, `第 ${i + 1} 轮要放行`);
        const charged = credits.recordTurn(reader, 'readonly');
        assert.equal(charged.verdict, 'free', `第 ${i + 1} 轮不扣积分`);
      }
      const blocked = credits.gate(reader, 'readonly');
      assert.equal(blocked.ok, false, '免费额度用完要拦');
      assert.equal(blocked.reason, 'quota_exhausted');
      assert.equal(blocked.balance, 0);

      // ⚠️ **严禁串台**:另一个人自己的账还是满的
      assert.equal(credits.gate(other, 'readonly').ok, true, '别人的账不许被带走');
      assert.equal(credits.usedToday(reader), FREE_QUOTA.readonly);
      assert.equal(credits.usedToday(other), 0);

      // 发 3 分 → paid 通过、每轮扣 1;扣完再拦
      assert.equal(credits.grant(reader, 3, { note: '测试', by: 'tester' }).balance, 3);
      assert.equal(credits.gate(reader, 'readonly').verdict, 'paid');
      for (let i = 0; i < 3; i += 1) {
        const charged = credits.recordTurn(reader, 'readonly');
        assert.equal(charged.verdict, 'paid', `积分轮 ${i + 1} 要扣分`);
      }
      assert.equal(credits.balanceOf(reader), 0, '3 分正好花完');
      assert.equal(credits.gate(reader, 'readonly').ok, false, '花完再拦');

      // 账目对得上:支出 = 3,全部有流水
      const log = credits.recent(50).filter((row) => row.subject === reader);
      assert.equal(log.filter((row) => row.kind === 'spend').length, 3, '三笔支出都要留痕');
      assert.equal(log.filter((row) => row.kind === 'grant').length, 1, '一笔入账要留痕');
    } finally {
      store.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('积分(HTTP):游客 403 在门口拦下(一个轮都不跑);登录后她超时不计、填满 402、发分续命', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-credits-http-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const port = 22_900 + Math.floor(Math.random() * 200);
    const accounts = createAccountService({ store, log: () => {} });
    const identityLinks = createIdentityLinks({ store, log: { warn: () => {}, info: () => {} } });
    accounts.repo.insertInvite({ code: 'CREDITS1' });
    let timedOutNext = false;
    const asked = [];
    const runTurn = async ({ text }) => {
      asked.push(text);
      if (timedOutNext) return { text: '', timedOut: true };
      return { text: '（她回）' + text, timedOut: false };
    };
    const credits = createCredits({ store, log: { info: () => {}, warn: () => {} } });
    const chat = createWebChat({ store, runTurn, log: { info: () => {}, warn: () => {} } });
    const panel = startPanel({
      config: {
        policy: {
          mood: { theme: 'megumin' }, stats: { theme: 'megumin' }, warmup: { sleep: null },
          panel: { enabled: true, host: '127.0.0.1', port, token: TOKEN, refreshMs: 5000, allowedHosts: [] },
        },
        qq: { appId: 'APP' },
      },
      actionExec: null,
      accounts, identityLinks, chat,
      credits,
      log: () => {},
      snapshot: () => ({}),
    });
    const base = `http://127.0.0.1:${port}`;
    const say = () => fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-token': TOKEN },
      body: JSON.stringify({ text: '嗨' }),
    });
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i += 1) {
        try { up = (await fetch(`${base}/api/ping`)).status === 200; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(up, '面板要起来');

      const q = String.fromCharCode(34);

      // ① 游客(只带头票,没账号):在门口就被拦 —— 403 login_required,**一个轮都不跑**。
      //    ⚠️ 口径与 402 分开:游客没法充值,把他引到充值弹窗是骗人(1.120.0 / D214)。
      const guestSay = await say();
      assert.equal(guestSay.status, 403, `游客要被 403 拦下(拿到 ${guestSay.status})`);
      assert.equal((await guestSay.json()).error, 'login_required');
      assert.equal(asked.length, 0, '被拦的那句不许真去跑一轮');
      const guestRead = await fetch(`${base}/api/chat`, { headers: { 'x-panel-token': TOKEN } });
      assert.equal(guestRead.status, 403, '游客连读聊天那一窗也不给(整条路要账号)');

      // ② 注册一个 member(带码),拿 Cookie
      const regHtml = await (await fetch(`${base}/account`)).text();
      const nonce1 = new RegExp(`name=${q}nonce${q} value=${q}([^${q}]*)${q}`).exec(regHtml)?.[1] ?? '';
      const reg = await fetch(`${base}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
        body: new URLSearchParams({
          nonce: nonce1, invite: 'CREDITS1', account: 'credmem', nickname: '有码的',
          password: 'hunter2hunter2', password2: 'hunter2hunter2',
        }).toString(),
        redirect: 'manual',
      });
      const cookie = (reg.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
      assert.ok(cookie.includes('hhauth='), '要注册成功');
      const sayWith = () => fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-token': TOKEN, cookie },
        body: JSON.stringify({ text: '嗨' }),
      });

      // ③ 登录后聊三句(第 2 句让她沉默):**她真的回了才算一轮**(1 → 1 → 2)
      const usedSeq = [];
      for (let i = 0; i < 3; i += 1) {
        timedOutNext = i === 1;
        const res = await sayWith();
        assert.equal(res.status, 200, `第 ${i + 1} 轮要放行`);
        usedSeq.push((await res.json()).quota?.used);
      }
      timedOutNext = false;
      assert.deepEqual(usedSeq, [1, 1, 2], '她沉默那轮不算(1 → 1 → 2)');

      // ④ 把今天的额度直接填满(账本判据②已钉,这里不走 100 次 HTTP)→ 下一句 402(弹赞助说明)
      const pid = store.handle.prepare('SELECT id FROM player WHERE account = ?').get('credmem')?.id;
      assert.ok(pid, '注册出来的那个人要真在库里');
      const subject = subjectForPlayer(pid);
      store.handle.prepare('UPDATE credit_day SET turns = ? WHERE subject = ?').run(FREE_QUOTA.member, subject);
      const denied = await sayWith();
      assert.equal(denied.status, 402, '额度用完要 402');
      const deniedBody = await denied.json();
      assert.equal(deniedBody.error, 'quota_exhausted');
      // ⚠️ 2026-10-23 充值退役:402 不再带充值档位 —— 页面弹的是赞助说明(公益站,无档位)。
      assert.ok(!('recharge' in deniedBody), '402 不许再带充值档位(公益站,弹赞助说明)');

      // ⑤ 站长发 2 分 → 又能聊两轮(paid),然后再次被拦
      credits.grant(subject, 2, { note: '测试', by: 'tester' });
      const ok1 = await sayWith();
      assert.equal(ok1.status, 200, '发分后要能聊');
      assert.equal((await ok1.json()).quota?.balance, 1, '扣 1 还剩 1');
      await sayWith();
      const deniedAgain = await sayWith();
      assert.equal(deniedAgain.status, 402, '积分花完再拦');
    } finally {
      await panel.close();
      try { store.close?.(); } catch { /* 已经关了 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('积分(HTTP):member 档每天 200 轮 —— 闸门按档算,页面要有额度角标与充值弹窗', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-credits-member-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const port = 23_100 + Math.floor(Math.random() * 200);
    const accounts = createAccountService({ store, log: () => {} });
    const identityLinks = createIdentityLinks({ store, log: { warn: () => {}, info: () => {} } });
    accounts.repo.insertInvite({ code: 'MEMBERQ1' });
    const credits = createCredits({ store, log: { info: () => {}, warn: () => {} } });
    const chat = createWebChat({ store, runTurn: async ({ text }) => ({ text: '嗯' + text, timedOut: false }), log: { info: () => {}, warn: () => {} } });
    const panel = startPanel({
      config: {
        policy: {
          mood: { theme: 'megumin' }, stats: { theme: 'megumin' }, warmup: { sleep: null },
          panel: { enabled: true, host: '127.0.0.1', port, token: TOKEN, refreshMs: 5000, allowedHosts: [] },
        },
        qq: { appId: 'APP' },
      },
      actionExec: null,
      accounts, identityLinks, chat,
      credits,
      log: () => {},
      snapshot: () => ({}),
    });
    const base = `http://127.0.0.1:${port}`;
    const q = String.fromCharCode(34);
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i += 1) {
        try { up = (await fetch(`${base}/api/ping`)).status === 200; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(up, '面板要起来');

      // 注册一个 member(带码 → 200/天)
      const regHtml = await (await fetch(`${base}/account`)).text();
      const nonce1 = new RegExp(`name=${q}nonce${q} value=${q}([^${q}]*)${q}`).exec(regHtml)?.[1] ?? '';
      const reg = await fetch(`${base}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
        body: new URLSearchParams({
          nonce: nonce1, invite: 'MEMBERQ1', account: 'credmem', nickname: '有码的',
          password: 'hunter2hunter2', password2: 'hunter2hunter2',
        }).toString(),
        redirect: 'manual',
      });
      const cookie = (reg.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
      assert.ok(cookie.includes('hhauth='), '要注册成功');

      const history = await (await fetch(`${base}/api/chat`, { headers: { cookie } })).json();
      assert.equal(history.quota?.quota, FREE_QUOTA.member, 'member 档的免费额度要按 200 算');

      // 页面要有:额度角标、赞助说明弹窗、402 接线(便宜判据,防回归)
      // ⚠️ D239 拆壳:quota_exhausted / paintQuota 在 app 资产里 —— 回填后再扫。
      const html = panelShellExpanded(await (await fetch(`${base}/`, { headers: { cookie } })).text());
      assert.ok(html.includes('id="chat-quota"'), '私聊的额度角标要在');
      // ⚠️ 2026-10-14(D229):群聊的额度角标(#room-quota)随那一栏删除 —— 反着钉它不许回来
      assert.ok(!html.includes('id="room-quota"'), '群聊的额度角标要随群组栏一起删掉(D229)');
      // ⚠️ 2026-10-23 充值退役:充值弹窗换成赞助说明弹窗 —— 反着钉 paywall 不许回来。
      assert.ok(html.includes('id="sponsor-note"'), '赞助说明弹窗要在');
      assert.ok(html.includes('openSponsorNote'), '弹赞助说明的函数要在');
      assert.ok(!html.includes('id="paywall"'), '充值弹窗要随充值退役删掉(不许回来)');
      assert.ok(html.includes('quota_exhausted'), '402 的接线要在');
      assert.ok(html.includes('paintQuota'), '角标上色的函数要在');
    } finally {
      await panel.close();
      try { store.close?.(); } catch { /* 已经关了 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
