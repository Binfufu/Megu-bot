/**
 * 酒馆门（tavern gate）：给原生 SillyTavern 套一层「用网页账号登录」的门。
 *
 * 用户 2026-10-19 拍板：「子域名账号密码同步成我的网页账号密码，同时记住登录」。
 * 于是这一层只做三件事，别的一律不做：
 *   ① 登录：账号/密码的唯一真相在 `state.db` 的 `player` 表 + `src\player-account.js`
 *      —— 本文件**不另存密码**，也**不自己实现 scrypt/票**（复用 `createAccountService`）；
 *   ② 记住登录：登录成功发一枚**和网页同一格式**的身份票（`createPlayerSigner`），
 *      cookie 30 天；网页改密码（session_epoch +1）→ 这枚票当场失效；
 *   ③ 反代：票有效才把请求转给只监听 127.0.0.1 的 ST；无效就回登录页 / API 回 401。
 *
 * ⚠️ 三条刻意：
 *   - 上游只允许本机（`127.0.0.1`）—— 门是唯一公网入口，ST 不直接见公网；
 *   - 客户端带来的 `Remote-User` / `X-Authentik-Username` 一律**删掉**（CVE-2026-44649 那一族：
 *     SSO 头注入冒充管理员）；即便现在没开 ST 的 SSO，也先把这条边界钉住；
 *   - 登录失败的**对外说法只有一种**（"账号或密码不对"）—— 与 `player-account.js` 同一条口径。
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createAccountService, describeAccountError, createPlayerSigner, verifySecret } from './player-account.js';

/** 与网页同名同格式的票（复用同一把 `accounts:secret` 与同一套 epoch 语义）。 */
export const TAVERN_COOKIE = 'hhauth';
export const LOGIN_PATH = '/__login';
export const LOGOUT_PATH = '/__logout';
export const HEALTH_PATH = '/__health';
export const TAVERN_TICKET_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * 独立本地账号的固定身份（2026-10-20，D272 追加）：
 * 9e9 这个 id 不会与自增的 player 行撞上；epoch 固定 1。票仍用同一把 `accounts:secret` 签，
 * 但**不查 player 表** —— 本地账号就是"单独一份账号密码"，与网页账号互不依赖。
 */
const LOCAL_PLAYER_ID = 9_000_000_000;
const LOCAL_EPOCH = 1;

const MAX_FORM_BYTES = 8 * 1024;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const ATTEMPT_MAX = 8;

const HOP_HEADERS = new Set([
    'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
    // SSO 头注入：客户端带进来的一律不当身份
    'authorization', 'remote-user', 'x-authentik-username', 'x-authentik-groups', 'x-authentik-email',
]);

const LOGIN_PAGE_CSP = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
].join('; ');

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function parseCookies(header) {
    const jar = {};
    for (const part of String(header ?? '').split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        const key = part.slice(0, index).trim();
        if (!key) continue;
        jar[key] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return jar;
}

/** 只允许站内路径；挡 `//evil` / 绝对 URL / 反斜杠。 */
export function safeNext(value) {
    const text = String(value ?? '').trim();
    if (!text.startsWith('/')) return '/';
    if (text.startsWith('//') || text.includes('\\')) return '/';
    if (text.startsWith(LOGIN_PATH) || text.startsWith(LOGOUT_PATH)) return '/';
    return text;
}

function clientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return forwarded || String(req.socket?.remoteAddress ?? '');
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_FORM_BYTES) {
                reject(new Error('body_too_large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function loginHtml({ next = '/', error = '', account = '' } = {}) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f4f5f7">
<title>梦魔酒馆 · 登录</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    padding: calc(24px + env(safe-area-inset-top, 0px)) 16px calc(24px + env(safe-area-inset-bottom, 0px));
    background: #f4f5f7; color: #1f2328;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  main { width: min(360px, 100%); background: #fff; border: 1px solid rgba(0,0,0,.08);
    border-radius: 16px; padding: 22px 20px; box-shadow: 0 10px 30px rgba(0,0,0,.06); }
  h1 { margin: 0 0 2px; font-size: 20px; }
  .sub { margin: 0 0 18px; color: #57606a; font-size: 13px; }
  label { display: block; margin: 0 0 12px; font-size: 13px; color: #57606a; }
  input { display: block; width: 100%; margin-top: 6px; padding: 11px 12px; font: inherit;
    border: 1px solid rgba(0,0,0,.16); border-radius: 10px; background: #fff; color: #1f2328; }
  button { width: 100%; margin-top: 6px; padding: 12px; border: 0; border-radius: 10px;
    background: #1f6feb; color: #fff; font: inherit; font-weight: 600; }
  .err { margin: 12px 0 0; color: #b42318; font-size: 13px; }
  .foot { margin: 14px 0 0; color: #8b949e; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>梦魔酒馆</h1>
  <p class="sub">用网页账号登录（登录一次，30 天内记住）</p>
  <form method="POST" action="${LOGIN_PATH}" autocomplete="on">
    <input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
    <label>账号<input name="account" value="${escapeHtml(account)}" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
    <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">登录</button>
  </form>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <p class="foot">账号与网页是同一份；改了网页密码，这里用新密码即可。</p>
</main>
</body>
</html>`;
}

function sendHtml(res, status, html, extraHeaders = {}) {
    const body = Buffer.from(html, 'utf8');
    res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': LOGIN_PAGE_CSP,
        ...extraHeaders,
    });
    res.end(body);
}

function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
    });
    res.end(body);
}

/**
 * 只读打开账号库（不跑 schema 迁移 —— 那个活儿归 bridge 的 `SqliteStateStore`）。
 * ⚠️ 但 `createAccountService.login()` 会写 `last_login_at`，所以句柄必须可写；
 *    `busy_timeout` 让它在 bridge 写库时等一等，而不是抛 SQLITE_BUSY。
 */
function openAccountStore(file) {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    return {
        handle: db,
        getMeta: (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
        setMeta: (key, value) => db.prepare(
            `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(key, String(value), Date.now()),
    };
}

/**
 * @param {object} options
 * @param {string} options.dbFile 账号库（`data\<bot>\state.db`）
 * @param {string} [options.upstream] 上游 ST（只该是 127.0.0.1）
 * @param {string[]} [options.allow] 允许登录的账号名；空 = 所有未停用账号
 * @param {boolean} [options.staffOnly] 额外要求 `tierOf === 'staff'`（默认关；allow 名单更直接）
 * @param {number} [options.cookieTtlMs]
 * @param {object} [options.localAccount] 独立本地账号（可选）：`{ account, nickname?, salt, hash, params }`
 *   —— 密码是 scrypt 哈希（由 `scripts\tavern-gate-add-local.mjs` 生成），**不依赖 state.db 的 player 行**，
 *   也不受 allow 名单约束；与网页账号是两套凭据。
 */
export function createTavernGate({
    dbFile,
    upstream = 'http://127.0.0.1:8000',
    allow = [],
    staffOnly = false,
    cookieTtlMs = TAVERN_TICKET_TTL_MS,
    localAccount = null,
    now = () => Date.now(),
    log = () => {},
} = {}) {
    if (!dbFile) throw new Error('tavern-gate: 缺 dbFile');
    const target = new URL(upstream);
    if (target.hostname !== '127.0.0.1' && target.hostname !== '::1' && target.hostname !== 'localhost') {
        throw new Error('tavern-gate: upstream 必须是本机地址（127.0.0.1 / ::1 / localhost）');
    }

    const store = openAccountStore(dbFile);
    const accounts = createAccountService({ store, openRegistration: false, staff: [], log: (line) => log(line) });
    const allowed = (Array.isArray(allow) ? allow : []).map((one) => String(one ?? '').trim().toLowerCase()).filter(Boolean);
    const attempts = new Map();

    // 独立本地账号：只要配置里有它，就单独一条登录/验票路径（不查 player 表、不受 allow 约束）。
    const local = localAccount && typeof localAccount.account === 'string' && localAccount.account.trim()
        ? {
            account: localAccount.account.trim().toLowerCase(),
            nickname: typeof localAccount.nickname === 'string' && localAccount.nickname.trim()
                ? localAccount.nickname.trim()
                : localAccount.account.trim(),
            salt: localAccount.salt,
            hash: localAccount.hash,
            params: localAccount.params,
            id: LOCAL_PLAYER_ID,
        }
        : null;
    const localSecret = local ? String(store.getMeta('accounts:secret') ?? '') : '';
    if (local && !localSecret) {
        throw new Error('tavern-gate: 配了 localAccount 但账号库缺 accounts:secret（先让 bridge 跑起来生成它）');
    }
    const localSigner = local ? createPlayerSigner({ secret: localSecret }) : null;

    const isAllowedAccount = (player) => {
        if (!player) return false;
        if (staffOnly && accounts.tierOf(player.id) !== 'staff') return false;
        if (allowed.length === 0) return true;
        return allowed.includes(String(player.account ?? '').trim().toLowerCase());
    };

    const bucketOf = (key) => {
        const stamp = now();
        const row = attempts.get(key);
        if (!row || row.resetAt <= stamp) {
            const fresh = { count: 0, resetAt: stamp + ATTEMPT_WINDOW_MS };
            attempts.set(key, fresh);
            return fresh;
        }
        return row;
    };

    const sessionOf = (req) => {
        const ticket = parseCookies(req.headers.cookie)[TAVERN_COOKIE];
        if (!ticket) return null;
        const check = accounts.verifyTicket(ticket);
        if (check.ok && isAllowedAccount(check.player)) return check.player;
        // 本地账号票：签名能过（同一把 secret），但 player 表里没有这个人 —— 这里按固定 id 认。
        if (localSigner) {
            const localCheck = localSigner.verify(ticket);
            if (localCheck.ok && localCheck.playerId === LOCAL_PLAYER_ID) {
                return { id: LOCAL_PLAYER_ID, account: local.account, nickname: local.nickname };
            }
        }
        return null;
    };

    const cookieHeader = (req, ticket) => {
        const proto = String(req.headers['x-forwarded-proto'] ?? '');
        const secure = proto.includes('https') ? '; Secure' : '';
        return `${TAVERN_COOKIE}=${ticket}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(cookieTtlMs / 1000)}${secure}`;
    };

    const wantsJson = (req) => {
        const accept = String(req.headers.accept ?? '');
        return accept.includes('application/json') || String(req.url ?? '').startsWith('/api/');
    };

    const proxy = (req, res) => {
        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (HOP_HEADERS.has(key)) continue;
            headers[key] = value;
        }
        headers.host = target.host;
        headers['x-forwarded-for'] = clientIp(req);
        if (req.headers['x-forwarded-proto']) headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'];

        const upstreamReq = http.request({
            hostname: target.hostname,
            port: target.port || 80,
            path: req.url,
            method: req.method,
            headers,
        }, (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstreamReq.on('error', (error) => {
            log(`上游不可用: ${error.message}`);
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            }
            res.end('酒馆暂时不可用。');
        });
        req.on('aborted', () => upstreamReq.destroy());
        req.pipe(upstreamReq);
    };

    const server = http.createServer(async (req, res) => {
        let url;
        try {
            url = new URL(String(req.url ?? '/'), 'http://tavern.local');
        } catch {
            res.writeHead(400).end('bad request');
            return;
        }
        const pathname = url.pathname;

        if (pathname === HEALTH_PATH) {
            sendJson(res, 200, { ok: true, upstream: target.href, allow: allowed.length });
            return;
        }

        if (pathname === LOGOUT_PATH) {
            res.writeHead(302, {
                location: LOGIN_PATH,
                'set-cookie': `${TAVERN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
                'cache-control': 'no-store',
            });
            res.end();
            return;
        }

        if (pathname === LOGIN_PATH) {
            const next = safeNext(url.searchParams.get('next') ?? '/');
            if (req.method === 'GET' || req.method === 'HEAD') {
                const player = sessionOf(req);
                if (player) {
                    res.writeHead(302, { location: next, 'cache-control': 'no-store' });
                    res.end();
                    return;
                }
                sendHtml(res, 200, loginHtml({ next }));
                return;
            }
            if (req.method !== 'POST') {
                res.writeHead(405, { allow: 'GET, POST' }).end();
                return;
            }

            // 同源检查：挡"别的站挂一张表单把受害者登进攻击者账号"（login CSRF）。
            // ⚠️ 2026-10-20 现场：真浏览器（手机 WebView / PWA / 隐私模式）提交表单会带 `Origin: null`，
            //    这是"不透明来源"，**没法据此判断来源** —— 旧实现把它当非法 URL 回 400（同一句文案），
            //    主人"每次登录都被安全闸门挡住"就是这么来的。现在与"没带 Origin"同口径放行；
            //    能解析的 Origin 仍严格比对 Host（跨站照样 403），并且挡住时记日志（旧实现静默不记）。
            const origin = req.headers.origin;
            if (origin) {
                let originHost = '';
                try {
                    originHost = new URL(origin).host.toLowerCase();
                } catch {
                    originHost = ''; // null / 不透明来源：当没带
                }
                const requestHost = String(req.headers.host ?? '').toLowerCase();
                if (originHost && originHost !== requestHost) {
                    log(`登录被同源检查挡住: origin=${origin} host=${req.headers.host} ip=${clientIp(req)}`);
                    sendHtml(res, 403, loginHtml({ next: '/', error: '这次提交被安全闸门挡住了。' }));
                    return;
                }
            }

            let body;
            try {
                body = await readBody(req);
            } catch {
                sendHtml(res, 413, loginHtml({ next: '/', error: '提交的内容太大了。' }));
                return;
            }
            const form = new URLSearchParams(body);
            const account = String(form.get('account') ?? '').trim().slice(0, 64);
            const password = String(form.get('password') ?? '').slice(0, 256);
            const formNext = safeNext(form.get('next') ?? '/');

            const bucket = bucketOf(`${clientIp(req)}|${account.toLowerCase()}`);
            bucket.count += 1;
            if (bucket.count > ATTEMPT_MAX) {
                sendHtml(res, 429, loginHtml({ next: formNext, error: '试错太多次，歇一会儿再来。', account }));
                return;
            }

            // 登录：本地独立账号走自己的 scrypt 校验；同名时本地优先（网页账号同名也不会串）。
            const result = local && account.toLowerCase() === local.account
                ? (await verifySecret(password, local)
                    ? {
                        ok: true,
                        local: true,
                        player: { id: LOCAL_PLAYER_ID, account: local.account, nickname: local.nickname },
                        ticket: localSigner.mint(LOCAL_PLAYER_ID, LOCAL_EPOCH),
                        epoch: LOCAL_EPOCH,
                    }
                    : { ok: false, error: 'bad_credentials' })
                : await accounts.login({ account, password });
            if (!result.ok) {
                log(`登录失败: account=${account} ip=${clientIp(req)} code=${result.error ?? 'unknown'}`);
                const message = result.error === 'account_disabled'
                    ? describeAccountError('account_disabled')
                    : describeAccountError('bad_credentials');
                sendHtml(res, 401, loginHtml({ next: formNext, error: message, account }));
                return;
            }
            if (!result.local && !isAllowedAccount(result.player)) {
                log(`登录被拒（不在 allow 名单）: ${result.player.account}`);
                sendHtml(res, 403, loginHtml({ next: formNext, error: '这个账号不能进酒馆。', account }));
                return;
            }

            attempts.delete(`${clientIp(req)}|${account.toLowerCase()}`);
            log(`登录成功: ${result.player.account} (${result.player.nickname})${result.local ? ' [独立账号]' : ''}`);
            res.writeHead(302, {
                location: formNext,
                'set-cookie': cookieHeader(req, result.ticket),
                'cache-control': 'no-store',
            });
            res.end();
            return;
        }

        const player = sessionOf(req);
        if (!player) {
            if (wantsJson(req)) {
                sendJson(res, 401, { ok: false, error: 'need_login' });
                return;
            }
            const next = safeNext(url.pathname + url.search);
            res.writeHead(302, {
                location: `${LOGIN_PATH}?next=${encodeURIComponent(next)}`,
                'cache-control': 'no-store',
            });
            res.end();
            return;
        }

        proxy(req, res);
    });

    // 生成/流式一次可能好几分钟：别让 Node 的默认超时替我们掐断。
    server.requestTimeout = 0;
    server.headersTimeout = 65_000;
    server.keepAliveTimeout = 65_000;

    return {
        server,
        accounts,
        listen(port, host = '127.0.0.1') {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => resolve(server.address()));
            });
        },
        close() {
            return new Promise((resolve) => {
                try { server.closeAllConnections?.(); } catch { /* 老 Node 没有 */ }
                server.close(() => {
                    try { store.handle.close(); } catch { /* ignore */ }
                    resolve();
                });
            });
        },
    };
}
