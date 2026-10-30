/**
 * 通用框架三基础问题 · T0 红测探针（2026-10-29）。
 *
 * 背景：`handover/20261029-aris-chat-foundations-plan.md`（本机私有工作笔记）+
 * 2026-10-28 只读诊断。三个基础问题：①临时注入/旧图不退出（上下文生命周期）；
 * ②搬图动作无反馈（聊天层不知道会/在做/做了什么）；③出站图片无消息身份绑定。
 *
 * 本脚本**直接调用真实生产模块**（createOwnEngine / SqliteStateStore / normalizeDispatch /
 * image-carry / handleMeituCommand / parseMeituCommand / createLlmClient），
 * 只替换网络、QQ 与模型响应；全部临时目录/内存库，不碰生产、不联网、不发 QQ。
 *
 * 两种模式（判据要能红，也要能说出为什么绿）：
 *   node scripts/selftest-foundation.js          → 探针模式：核对「现状校准」——
 *       故障项必须仍红（got=red）、对照项必须仍绿（got=green），全对上 exit 0；
 *       有任何漂移（比如有人顺手修了一处却没跑全量）exit 1 并指出。
 *   node scripts/selftest-foundation.js --gate   → 闸门模式：要求**全部**绿
 *       （T1–T4 修复落地后启用；在那之前它必然红，这是预期）。
 *
 * ⚠️ 本文件**不注册**进 scripts/selftest.js：全量必须保持绿，红测独立存在；
 *    各阶段修复把对应项翻绿后，随该阶段交付把整组判据收进常驻回归再删本文件的红校准。
 * 判据出处：2026-10-28 消费端离线探针（真实模块+假 LLM，exit 0 的那份结果）固化为常驻形态。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { listenLoopback } from './test-local-port.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { normalizeDispatch } from '../src/qq.js';
import { createConversationImageCarry } from '../src/image-carry.js';
import { wrapInject } from '../src/inject-mark.js';
import { handleMeituCommand } from '../src/meitu-service.js';
import { parseMeituCommand } from '../src/meitu-command.js';
import { createLlmClient, IMAGE_GROUNDING_NOTE } from '../src/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SILENT = { info() {}, warn() {}, debug() {}, error() {} };

/** 每条用例一个临时目录（人设 + SQLite + 美图夹具），结束删干净。 */
async function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-foundation-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 真引擎 + 真内存库 + 假 LLM（捕获实际收到的 messages/callOptions）。生产同形：不传 scene（world 预算）。 */
async function makeEngine(dir, { clock = { now: Date.parse('2026-10-29T00:00:00Z') } } = {}) {
  const personaPath = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(personaPath, '你是通用框架判据用的临时角色。', 'utf8');
  const store = new SqliteStateStore(path.join(dir, 'state.db'));
  const calls = [];
  const llm = {
    chat: async (messages, callOptions = {}) => {
      // ⚠️ callOptions 里带 AbortSignal/函数（引擎 cancellableChat 的真实形状），只能浅拷贝；
      //    判据只读其中的 images，不克隆。
      calls.push({ messages: structuredClone(messages), callOptions: { ...callOptions, signal: undefined } });
      return { text: '判据夹具回复', usage: null };
    },
  };
  const engine = createOwnEngine({ store, personaPath, llm, log: SILENT, now: () => clock.now });
  await engine.initialize();
  const close = async () => { await engine.stop(); store.close(); };
  const historyImages = (i = calls.length - 1) =>
    calls[i].messages.flatMap((m) => Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'image_url').map((b) => b.image_url.url) : []);
  const hasText = (needle, i = calls.length - 1) => JSON.stringify(calls[i].messages).includes(needle);
  return { engine, calls, close, clock, historyImages, hasText };
}

const results = [];
/** 记一条判据：want=期望终态（red=修复前应失败；green=现在就该成立），holds=期望状态是否实测成立。 */
function judge(id, want, holds, detail) {
  const got = holds ? 'green' : 'red';
  results.push({ id, want, got, ok: got === want, detail: String(detail ?? '') });
}

// ---------------------------------------------------------------------------
// 组1：上下文生命周期（T1 修复对象）
// ---------------------------------------------------------------------------

async function checkContextLifecycle(dir) {
  // 1) 一次性注入不得随历史无限重发：生产里 recall/facts 经 wrapInject 拼进本轮 user 文本，
  //    引擎把完整 content 落 conversation_turn 并在下轮原样重发 —— 期望（修复后）：历史投影剥离临时注入。
  {
    const e = await makeEngine(dir);
    try {
      const key = 'qqbot-group-injectcase';
      await e.engine.runTurn(key, `${wrapInject('recall', 'RECALL_CANARY_T0')}\n用户原话：昨天那件事真好笑`, 5000);
      e.clock.now += 24 * 3600 * 1000;
      await e.engine.runTurn(key, '完全换个话题：现在几点了？', 5000);
      judge('ctx.inject.not-persist', 'green', !e.hasText('RECALL_CANARY_T0'),
        '无关下一轮的实际 messages 不再携带上一轮临时 recall 注入(T1-A 历史投影已落地)');
    } finally { await e.close(); }
  }
  // 2) 无新图时不得无条件回放旧图：隔天无关话题仍把历史旧图塞进请求 —— 期望：不回放。
  {
    const e = await makeEngine(dir);
    try {
      const key = 'qqbot-group-imgcase';
      await e.engine.runTurn(key, '看这张图', 5000, ['data:image/png;base64,QUJD']);
      e.clock.now += 24 * 3600 * 1000;
      await e.engine.runTurn(key, '完全换个话题：现在几点了？', 5000);
      judge('ctx.image.no-auto-replay', 'green', !e.historyImages().includes('data:image/png;base64,QUJD'),
        '隔 24h 无关轮次不再回放旧图(T4 已落地:像素只来自本轮/桥层显式来源;历史文字提示保留)');
      // 对照：本轮有新图时，新图走 callOptions.images、旧图不再额外回放（现有保护仍在）。
      await e.engine.runTurn(key, '再看新这张', 5000, ['data:image/png;base64,REVG']);
      const ok = !e.historyImages().includes('data:image/png;base64,QUJD')
        && JSON.stringify(e.calls.at(-1).callOptions.images) === JSON.stringify(['data:image/png;base64,REVG']);
      judge('ctx.image.new-image-suppresses-replay', 'green', ok, '新图经 callOptions 单独传递且抑制旧图回放');
    } finally { await e.close(); }
  }
  // 3) 对照：群间隔离（按群 key 本就隔离，修复不得破坏）。
  {
    const e = await makeEngine(dir);
    try {
      await e.engine.runTurn('qqbot-group-a', 'ONLY_GROUP_A_CANARY', 5000);
      await e.engine.runTurn('qqbot-group-b', 'b群说话', 5000);
      judge('ctx.group.isolation', 'green', !e.hasText('ONLY_GROUP_A_CANARY'), '另一群请求不含前群内容');
    } finally { await e.close(); }
  }
  // 4) 对照：引擎 reset 本体有效（桥侧重置旁路不清是 T1-D 的事，这里钉引擎层不退化）。
  {
    const e = await makeEngine(dir);
    try {
      const key = 'qqbot-group-resetcase';
      await e.engine.runTurn(key, 'RESET_CANARY_T0', 5000, ['data:image/png;base64,QUJD']);
      e.engine.resetConversation(key);
      await e.engine.runTurn(key, '新会话第一句', 5000);
      const ok = !e.hasText('RESET_CANARY_T0') && e.historyImages().length === 0;
      judge('ctx.reset.clears', 'green', ok, 'reset 后旧文本与旧图均不再进入请求');
    } finally { await e.close(); }
  }
}

// ---------------------------------------------------------------------------
// 组2：后台摘要的共享有状态历史（T1-B 修复对象；生产 summarizer 走同一 runner 累积）
// ---------------------------------------------------------------------------

async function checkSummaryIsolation(dir) {
  const e = await makeEngine(dir);
  try {
    // T1-B 契约:无状态任务轮不携带此前任何任务材料(生产 summarizer 自 T1 起走这条路,
    // 不再借会话历史;引擎按 key 累积会话历史本身是会话语义,不再是故障)。
    try {
      await e.engine.runIsolatedTurn('摘要任务A：GROUP_A_ONLY_CANARY_T1 的材料', { key: 'qqbot-summary' });
      await e.engine.runIsolatedTurn('摘要任务B：CURRENT_B_CANARY 材料', { key: 'qqbot-summary' });
      judge('summary.isolated.no-cross-task', 'green', !e.hasText('GROUP_A_ONLY_CANARY_T1'),
        '同键连续两个无状态任务轮,后一请求不含前一任务材料,且每次只有本轮一条');
    } catch {
      judge('summary.isolated.no-cross-task', 'green', false, 'engine.runIsolatedTurn 未实现(T1-B 未落地?)');
    }
  } finally { await e.close(); }
}

// ---------------------------------------------------------------------------
// 组3：入站引用（T3 修复对象；真实 normalizeDispatch）
// ---------------------------------------------------------------------------

function checkInboundReference() {
  const base = { id: 'IN-T0', group_openid: 'g-ref', author: { member_openid: 'u1' }, content: '这张是谁？' };
  const attachment = { content_type: 'image/png', url: 'https://example.invalid/t0.png' };
  // 引用承载图片（平台只给引用 id / 嵌套引用附件）→ 归一化后既无图也无引用字段。
  const ref = normalizeDispatch('GROUP_AT_MESSAGE_CREATE',
    { ...base, message_reference: { message_id: 'OUT-42' }, referenced_message: { id: 'OUT-42', attachments: [attachment] } });
  const lost = ref && ref.images.length === 0
    && ref.replyToMessageId !== 'OUT-42';
  judge('inbound.reference.keeps-image-and-ref', 'green', !lost,
    '引用身份(replyToMessageId)已保留(T3);嵌套引用附件不混入顶层 images(来源分离,解析走发送绑定)');
  // 对照：同一附件在顶层 → 图片照常提取并进补图账。
  const direct = normalizeDispatch('GROUP_AT_MESSAGE_CREATE', { ...base, attachments: [attachment] });
  const carry = createConversationImageCarry();
  carry.remember('g-ref', direct, 1000);
  judge('inbound.direct-attachment.carried', 'green',
    Boolean(direct && direct.images.length === 1 && carry.sources('g-ref', null, { now: 1000 }).length === 1),
    '顶层附件图片照常提取并进补图账（修复不得破坏）');
}

// ---------------------------------------------------------------------------
// 组4：搬图动作反馈（T2/T3 修复对象；真实 handleMeituCommand + 假 QQ 出口）
// ---------------------------------------------------------------------------

async function checkMeituFeedback(dir) {
  const imageFile = path.join(dir, 'shiroko-t0.png');
  fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const aliasPath = path.join(dir, 'meitu-alias.json');
  fs.writeFileSync(aliasPath, JSON.stringify({ 白子: 'shiroko_(blue_archive)' }), 'utf8');
  const parsed = parseMeituCommand('来1张白子美图', { max: 5 });
  assert.equal(parsed.ok, true, '夹具指令必须能被真实解析器解析');

  const message = { scene: 'group', targetId: 'g1', senderId: 'u1', messageId: 'IN-1', isMention: true, content: '来1张白子美图' };
  const sentToGallery = [];
  const makeDeps = ({ sendMedia }) => ({
    config: { meitu: {
      enabled: true, groups: ['g1'], max: 5, cooldownMs: 0, source: 'auto',
      root: path.join(dir, 'root'), alias: aliasPath,
      lines: path.join(dir, 'meitu-lines.json'), missLog: path.join(dir, 'meitu-miss.jsonl'),
      maxBytes: 10_485_760, timeoutMs: 90_000, proxy: '',
    } },
    log: SILENT,
    now: () => Date.now(),
    runFetch: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, files: [{
      path: imageFile, source: 'danbooru', id: 424242, rating: 's', url: 'https://example.invalid/t0.jpg',
      md5: 'a'.repeat(32),
    }] }) }),
    uploadFile: async () => 'file_info_t0',
    sendMedia,
    reply: async () => {},
    gallery: { upsertFromFetch: async () => {}, recordSent: async (p) => { sentToGallery.push(p); } },
  });

  // 1) 发送收据：sendMedia 的平台返回体被丢弃、逐张身份没回传 —— 期望：结果带逐张收据
  //    （出站消息 id + source/id/md5），聊天层才有「发了哪张、发到哪条」可言。
  {
    sentToGallery.length = 0;
    const deps = makeDeps({ sendMedia: async () => ({ message_id: 'OUT-42' }) });
    const result = await handleMeituCommand({ message, parsed, deps });
    const hasReceipt = Array.isArray(result?.receipts) && result.receipts.length === 1
      && result.receipts[0].outboundMessageId === 'OUT-42'
      && result.receipts[0].md5 === 'a'.repeat(32)
      && result.receipts[0].source === 'danbooru' && result.receipts[0].sourceId === 424242;
    const identityUpstream = sentToGallery.length === 1 && sentToGallery[0].md5 === 'a'.repeat(32);
    judge('meitu.receipt.outbound-binding', 'green', Boolean(hasReceipt),
      `服务返回逐张收据(outboundMessageId/source/md5);图库侧身份在(recordSent.md5=${identityUpstream})(T2 已落地)`);
  }
  // 2) 任务可观察 + T3 绑定回环:真实 store 经 deps.recordMediaLink 落绑定,同作用域按出站 id 查回。
  {
    sentToGallery.length = 0;
    const store = new SqliteStateStore(':memory:');
    try {
      const deps = makeDeps({ sendMedia: async () => ({ message_id: 'OUT-43' }) });
      deps.recordMediaLink = (entry) => store.recordMediaLink({
        bot: 't0-bot', scene: 'group', target: 'g1',
        outboundId: entry?.outboundId, itemSeq: entry?.itemSeq,
        md5: entry?.md5, source: entry?.source, sourceId: entry?.sourceId,
      });
      const result = await handleMeituCommand({ message, parsed, deps });
      const links = store.mediaLinksByOutbound({ bot: 't0-bot', scene: 'group', target: 'g1', outboundId: 'OUT-43' });
      const bound = links.length === 1 && links[0].md5 === 'a'.repeat(32)
        && links[0].outboundId === 'OUT-43' && links[0].sourceId === '424242';
      judge('media.link.binds-and-resolves', 'green', bound,
        `发送收据→持久绑定→同作用域引用查找回环成立(任务状态=${result?.task?.status});跨群/重启后仍可查(同 API)`);
    } finally { store.close(); }
  }
  // 3) 任务可观察:成功后应能从返回值/存储看到「这个任务做了什么」——期望：result.task 存在。
  {
    const deps = makeDeps({ sendMedia: async () => ({ message_id: 'OUT-43' }) });
    const result = await handleMeituCommand({ message, parsed, deps });
    judge('meitu.task.observable', 'green', Boolean(result?.task?.status && result?.task?.resolved?.character),
      `成功发送后有任务级产物(status=${result?.task?.status},角色=${result?.task?.resolved?.character})供聊天层注入事实块(T2 已落地)`);
  }
  // 3) 对照：成功路径计数与「成功不占被动文本槽」不回退。
  {
    const deps = makeDeps({ sendMedia: async () => ({ message_id: 'OUT-44' }) });
    const result = await handleMeituCommand({ message, parsed, deps });
    judge('meitu.success.counts', 'green', result?.ok === true && result?.sent === 1 && result?.failed === 0,
      'ok/sent/failed 结算保持既有口径');
  }
  // 4) 对照：发送失败如实计 failed、不虚报成功。
  {
    const deps = makeDeps({ sendMedia: async () => { throw new Error('boom'); } });
    const result = await handleMeituCommand({ message, parsed, deps });
    judge('meitu.send-failure.counted', 'green',
      result?.ok === false && result?.sent === 0 && result?.failed === 1,
      `失败计数不回退（reason=${result?.reason}）`);
  }
}

// ---------------------------------------------------------------------------
// 组5：对照——视觉通道基线（真实 llm 客户端把图片与钉地注记发进 provider body）
// ---------------------------------------------------------------------------

async function checkVisionPassthrough() {
  let captured = null;
  const server = http.createServer((req, res) => {
    req.resume();
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { captured = JSON.parse(body); } catch { captured = null; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await listenLoopback(server);
  try {
    const llm = createLlmClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 't0', model: 't0-model', retryDelayMs: 1, log: SILENT });
    await llm.chat([{ role: 'user', content: '看图' }], { images: ['data:image/png;base64,QUJD'] });
    const raw = JSON.stringify(captured ?? {});
    const ok = raw.includes('image_url') && raw.includes('data:image/png;base64,QUJD')
      && raw.includes(IMAGE_GROUNDING_NOTE.slice(0, 24));
    judge('llm.vision.passthrough', 'green', ok,
      '正确传入的图片会连同钉地注记进入真实 provider body（T4「知道图片内容」的通道基线）');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------

const redExpected = [];

async function main() {
  const gate = process.argv.includes('--gate');
  await withTemp(async (dir) => {
    await checkContextLifecycle(dir);
    await checkSummaryIsolation(dir);
    checkInboundReference();
    await checkMeituFeedback(dir);
  });
  await checkVisionPassthrough();

  const rows = results.map((r) => ({
    ...r,
    pass: gate ? r.got === 'green' : r.got === r.want,
    fixBy: redExpected.find(([id]) => id === r.id)?.[1] ?? '(对照项，须保持绿)',
  }));
  const passed = rows.filter((r) => r.pass).length;
  const lines = [];
  lines.push(`qqbot 通用框架三基础问题 · T0 判据（${gate ? 'gate 闸门模式：要求全绿' : 'probe 探针模式：现状校准'}）`);
  lines.push(`基准树见 git HEAD；结果 ${passed}/${rows.length} 条符合${gate ? '闸门' : '校准'}期望。`);
  for (const r of rows) {
    lines.push(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.id} want=${r.want} got=${r.got}  ← ${r.fixBy}`);
    if (r.detail) lines.push(`       ${r.detail}`);
  }
  const report = lines.join('\n');
  console.log(report);
  const evidenceDir = path.join(ROOT, 'data', 'index');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `selftest-foundation-${gate ? 'gate' : 'probe'}.txt`);
  fs.writeFileSync(evidencePath, `${report}\n\nJSON:\n${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  console.log(`\n证据已写 ${evidencePath}`);
  const allPass = rows.every((r) => r.pass);
  if (!allPass) {
    if (gate) console.log('\n闸门未过：存在未翻绿的修复项。');
    else console.log('\n校准漂移：有判据的红绿与冻结现状不符 —— 先查是有人改了行为还是判据错了，不许静默改期望。');
    process.exitCode = 1;
  } else if (!gate) {
    console.log('\n现状校准成立：故障项仍红、对照项仍绿。修复阶段用 --gate 要求全绿。');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
