/**
 * Connectivity check for the QQ half of the bridge — no DSH runtime, no model call.
 *
 * Fetches an access token, resolves the gateway URL, connects, identifies, and
 * waits for READY, then disconnects. Proves that the credentials are valid, the
 * intents are permitted, and the gateway is reachable.
 *
 * Usage: node scripts/verify-qq.js
 *        第二只机器人：先设 QQBOT_ENV_FILE=bots\demo\.env，验证的是协作角色那只的凭证。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, resolveEnvFile } from '../src/config.js';
import { QqGateway, TokenManager } from '../src/qq.js';
import { log } from '../src/log.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 和 bridge 一样认 QQBOT_ENV_FILE —— 否则对第二只机器人来说这条命令是假的：
// 它会去读当前角色的配置，然后把"当前角色一切正常"报成"协作角色连上了"。
const envFile = resolveEnvFile(ROOT_DIR);
const loaded = loadEnvFile(envFile);
log.setLevel(process.env.QQBOT_LOG_LEVEL ?? 'info');

if (!loaded) {
  process.stderr.write(`未找到 ${envFile}，请先填写 QQ_APP_ID 与 QQ_CLIENT_SECRET\n`);
  process.exit(1);
}

const appId = process.env.QQ_APP_ID;
const clientSecret = process.env.QQ_CLIENT_SECRET;
const apiBase = (process.env.QQ_API_BASE ?? 'https://api.bot.qq.com').replace(/\/+$/, '');
const intents = Number.parseInt(process.env.QQBOT_INTENTS ?? '33554432', 10);

const missing = [];
if (!appId) missing.push('QQ_APP_ID');
if (!clientSecret) missing.push('QQ_CLIENT_SECRET');
if (missing.length > 0) {
  process.stderr.write(`${envFile} 里还没填：${missing.join('、')}\n`);
  process.exit(1);
}

const mask = (value) => (value.length <= 10 ? '*'.repeat(value.length) : `${value.slice(0, 6)}…${value.slice(-4)}`);
const out = (line) => process.stdout.write(`${line}\n`);

out(`配置文件     : ${envFile}`);
out(`AppID        : ${appId}`);
out(`ClientSecret : ${mask(clientSecret)}`);
out(`Intents      : ${intents}`);
out(`API Base     : ${apiBase}`);
out('');

const tokens = new TokenManager({ appId, clientSecret, apiBase });
const timeoutMs = Number(process.env.VERIFY_QQ_TIMEOUT_MS ?? 45_000);

let gateway = null;
let settled = false;

function finish(code) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  gateway?.stop();
  process.exit(code);
}

const timer = setTimeout(() => {
  out('');
  out('✗ 超时：连接或鉴权未在限定时间内完成。');
  out('  常见原因：机器人未上线/已下架、intents 无权限、或网络无法直连 api.bot.qq.com。');
  finish(1);
}, timeoutMs);

try {
  const token = await tokens.get();
  out(`✓ access_token 获取成功（${mask(token)}）`);

  gateway = new QqGateway({ tokens, apiBase, intents });

  gateway.on('ready', (data) => {
    out('✓ 网关鉴权成功（READY）');
    out('');
    out(`  机器人名称 : ${data?.user?.username ?? '未知'}`);
    out(`  机器人 ID  : ${data?.user?.id ?? '未知'}`);
    out(`  session_id : ${data?.session_id ?? '未知'}`);
    out('');
    out('QQ 侧链路正常。想真正把她跑起来：');
    out('    双击 bots\\<bot>\\run.cmd  （或设 QQBOT_ENV_FILE 后 node scripts\\launch.js）');
    finish(0);
  });

  gateway.on('fatal', (err) => {
    out('');
    out(`✗ 网关拒绝连接：${err.message}`);
    if (process.env.QQBOT_SANDBOX !== 'true') {
      out('  提示：机器人未上线时只能连沙箱环境，可在 .env 里设 QQBOT_SANDBOX=true。');
    }
    finish(1);
  });

  gateway.start();
} catch (err) {
  out('');
  out(`✗ 失败：${err.message}`);
  const code = err?.code;
  if (code === 100016) out('  AppID 或 ClientSecret 不正确，请核对开放平台「开发设置」。');
  else if (code === 100007) out('  AppID 无效，或机器人已被封禁/删除。');
  else if (code === 100001) out('  请求过于频繁，稍后重试。');
  else if (code === 10004) out('  AppID 对应的机器人不存在。');
  finish(1);
}
