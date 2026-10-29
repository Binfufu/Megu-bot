/**
 * **前端健壮性回归**(2026-10-12 / D202,方案 = docs\19)。
 *
 * 这一轮修的是"状态变了页面还对不对"那一半(安全审查查的是"谁能做什么"),
 * 判据分两层:
 *   ① **真 HTTP**:聊天与群聊"说一句"的服务端幂等 —— 同一枚 nonce 只算一条
 *      (双击/弱网重发/断线自动重试都不会把同一句话说两遍);
 *   ② **扫渲染出来的页面**:客户端那几样必须在(输入法判断、失败占位、软键盘护栏、
 *      退出清本机票)—— 这类判据便宜且防回归,与"大模板不许反引号"同一条路数。
 *
 * ⚠️ 浏览器层的判据(输入法真的不发、失败态真的显示)在 `scripts\panel-input-probe.mjs`
 *    (CDP 真浏览器,无头跑;那份是"问浏览器本人",这份是"接口与源码")。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { panelShellExpanded, startPanel } from '../src/panel.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { createActionExec } from '../src/panel-actions.js';
import { createAccountService, generateInviteCode } from '../src/player-account.js';
import { createIdentityLinks } from '../src/identity-link.js';
// ⚠️ 2026-10-14(D229):`createRoomService`(网页群聊房)已随「群组」那一栏删除 —— 这里不再 import。
import { createWebChat } from '../src/webchat.js';

const TOKEN = 'robust-suite-token';

export function registerRobustTests({ test, assert }) {
  test('健壮(D202):聊天**说一句**服务端幂等 —— 同一枚 nonce 只算一条', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-robust-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const port = 22_300 + Math.floor(Math.random() * 300);
    const accounts = createAccountService({ store, log: () => {} });
    const identityLinks = createIdentityLinks({ store, log: { warn: () => {}, info: () => {} } });
    accounts.repo.insertInvite({ code: 'ROBUST01' });
    const runTurn = async ({ text }) => ({ text: '（她回）' + text, timedOut: false });
    const chat = createWebChat({ store, runTurn, log: { info: () => {}, warn: () => {} } });
    const panel = startPanel({
      config: {
        policy: {
          mood: { theme: 'megumin' }, stats: { theme: 'megumin' }, warmup: { sleep: null },
          panel: { enabled: true, host: '127.0.0.1', port, token: TOKEN, refreshMs: 5000, allowedHosts: [] },
        },
        qq: { appId: 'APP' },
      },
      actionExec: createActionExec({ store, appId: 'APP', log: { info: () => {}, warn: () => {} } }),
      accounts, identityLinks, chat,
      log: () => {},
      snapshot: () => ({}),
    });
    const base = `http://127.0.0.1:${port}`;
    const req = async (route, init = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try { return await fetch(`${base}${route}`, { ...init, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    };
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i += 1) {
        try { up = (await req('/api/ping')).status === 200; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(up, '面板要起来');

      // 注册一个 member(私聊要 member 档;群聊大厅只读也能说 —— 两个口径都顺手验)
      const q = String.fromCharCode(34);
      const regHtml = await (await req('/account')).text();
      const nonce1 = new RegExp(`name=${q}nonce${q} value=${q}([^${q}]*)${q}`).exec(regHtml)?.[1] ?? '';
      const reg = await req('/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
        body: new URLSearchParams({
          nonce: nonce1, invite: 'ROBUST01', account: 'robust', nickname: '结实的',
          password: 'hunter2hunter2', password2: 'hunter2hunter2', question: '食物?', answer: '番茄',
        }).toString(),
        redirect: 'manual',
      });
      const cookie = (reg.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
      assert.ok(cookie.includes('hhauth='), '要注册成功拿到身份票');

      const post = (route, body) => req(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      });

      // —— 私聊:同一枚 nonce 发两遍 → 只有一条;换一枚 → 第二条出现 ——
      const first = await post('/api/chat', { text: '你好', nonce: 'FIXED-A' });
      assert.equal(first.status, 200, '第一次要说成功');
      assert.equal((await first.json()).replay, undefined, '第一次不是重放');
      const again = await post('/api/chat', { text: '你好', nonce: 'FIXED-A' });
      const againBody = await again.json();
      assert.equal(again.status, 200, '重放的那次也回 200(客户端在等回执)');
      assert.equal(againBody.replay, true, '重放要如实标出来(页面拿它说"没有重复发")');
      const fresh = await post('/api/chat', { text: '你好', nonce: 'FIXED-B' });
      assert.equal((await fresh.json()).replay, undefined, '换了 nonce 就是新的一条');
      const history = await (await req('/api/chat', { headers: { cookie } })).json();
      const said = history.messages.filter((row) => row.who === 'player' && row.text === '你好');
      assert.equal(said.length, 2, `两枚 nonce = 两条(重复那次不算);实际 ${said.length}`);
      assert.equal(history.messages.filter((row) => row.who === 'her').length >= 2, true, '她也回过话(runTurn 桩)');

      // ⚠️ 2026-10-14(D229):原来这里还有"群聊(大厅)同一个幂等口径"那一段 ——
      //    网页群聊房整条链路删除后它没有对象了,判据改成**反证**:那两条路必须真的不在。
      assert.equal((await req('/api/room?room=plaza')).status, 404, 'GET /api/room 要 404(D229)');
      assert.equal((await post('/api/room?room=plaza', { action: 'say', text: '大家好', nonce: 'ROOM-A' })).status, 405,
        '已删除的 POST 路径按全站默认写保护返回 405(D229)');

      // —— 没 nonce 的老客户端照旧能说(幂等是加固,不是新门槛)——
      const legacy = await post('/api/chat', { text: '老客户端' });
      assert.equal(legacy.status, 200, '不带 nonce 也要能说(向后兼容)');
    } finally {
      await panel.close();
      try { store.close?.(); } catch { /* 已经关了 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('健壮(D202):渲染出来的页面**带齐**那几样客户端护栏(输入法 / 失败占位 / 软键盘 / 退出清票)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-robust-src-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const port = 22_600 + Math.floor(Math.random() * 200);
    const panel = startPanel({
      config: {
        policy: {
          mood: { theme: 'megumin' }, stats: { theme: 'megumin' }, warmup: { sleep: null, enabled: false },
          panel: { enabled: true, host: '127.0.0.1', port, token: TOKEN, refreshMs: 5000, allowedHosts: [] },
        },
        qq: { appId: 'APP' },
      },
      log: () => {},
      snapshot: () => ({ panel: 3, generatedAt: Date.now(), readOnly: true, character: {}, values: [], conditions: {}, scenes: [], affinity: [], homeItems: [], questBoard: null, money: 0, currency: '通用货币' }),
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      let html = '';
      for (let i = 0; i < 40 && !html; i += 1) {
        try { const res = await fetch(`${base}/`, { headers: { 'x-panel-token': TOKEN } }); if (res.ok) html = await res.text(); }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(html.length > 1000, '页面要渲染得出来');
      // ⚠️ D239 拆壳:这些护栏判据钉的是**浏览器执行的代码** —— 回填后再扫。
      html = panelShellExpanded(html);
      // ① 输入法:输入框都要判组字(方案第 1 条 P1 —— 这类判据便宜,防回归)
      const composing = (html.match(/isComposing/g) ?? []).length;
      assert.ok(composing >= 1, `剩下的输入框都要判 isComposing(实际 ${composing} 处)`);
      assert.ok(html.includes('keyCode === 229'), '老浏览器的组字键值也要兜住');
      assert.ok(html.includes('event.shiftKey || event.ctrlKey'), '带修饰键的回车不当发送');
      // ② 失败态:取不到要有**如实的占位**,而不是永远"加载中…"(方案第 2 条 P1)
      assert.ok(html.includes('取不到消息'), '失败占位的那句话要在');
      assert.ok(html.includes('markListFail'), '失败标记的函数在(探针要按名字调它)');
      // ③ 软键盘护栏(方案第 5 条;2026-10-12 第二轮 / D206 加固)
      assert.ok(html.includes('visualViewport'), '软键盘护栏要在');
      assert.ok(html.includes('interactive-widget=resizes-content'),
        '视口 meta 要声明 resizes-content —— 否则安卓键盘只是"盖"在 fixed 层上(那时只能事后滚,慢)');
      assert.ok(html.includes('--composer-viewport-height'),
        '键盘高度要落到那个 CSS 变量上(布局跟着缩,而不是等下一轮轮询顺带滚)');
      assert.ok(html.includes("addEventListener('focusin'"), '点进输入框也要触发同步(键盘已开时不会有 resize)');
      // ④ 退出清本机票(方案第 6 条)
      assert.ok(html.includes('form[action="/api/account/logout"]'), '退出表单的接线要在');
      assert.ok(html.includes('localStorage.removeItem('), '退出时要把本机身份票清掉');
      // ⑤ 弹窗的键盘那一半(方案第 4 条)
      assert.ok((html.match(/away-close/g) ?? []).length >= 2, '「知道了」按钮:模板 + 脚本都要提到');
      // ⑥ 上滑不许被拽回 + "回到底部"那颗圆钮(2026-10-12 / D209)
      assert.ok(!html.includes('stick: stick || keepLatest'), '重画不许再无条件粘底(那是"上滑被拽回"的根因)');
      assert.ok(html.includes('function updateJumpLatest'), '那颗圆钮的显隐要有实现');
      assert.ok(html.includes('id="chat-jump"') && !html.includes('id="room-jump"'),
        '私聊那颗"回到底部"要在;群聊那颗随那一栏删除(D229)');
      assert.ok(html.includes('arrow-down-to-line'), '图标要用"横线带向下箭头"那一枚(用户点名)');
      assert.ok(html.includes('.jump-latest[hidden] { display:none !important; }'),
        '作者规则会压过 UA 的 [hidden] —— 必须显式写 display:none !important');
    } finally {
      await panel.close();
      try { store.close?.(); } catch { /* 已经关了 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
