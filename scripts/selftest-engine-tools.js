/**
 * **own 引擎的工具循环**(P3-b,2026-10-28)回归。
 *
 * 判据全部用**注入的假 llm**(零网络、零花费),钉的是接线语义:
 *   · 两步闭环:assistant(tool_calls) 原样接回 + tool 结果按 call_id 配对 + 只落最终正文;
 *   · 纯 tool_calls **不许**落到 `[跳过]`(P0 调查时的实锤缺陷);
 *   · 预算耗尽 = 显式"没能完成";坏 JSON 参数 / 伪造隐藏工具 → 结构化错误回给模型;
 *   · 整轮 client 快照:循环中途换"当前"client,本轮子调用仍钉死快照;
 *   · 四参调用(不带 toolContext)行为一字不变。
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { defineCapability, turnContextFor } from '../src/capabilities.js';

/** 可编排的假 llm:按脚本出结果(支持 toolCalls),记录每次 messages/callOptions。 */
function scriptedLlm(script) {
  const calls = [];
  let i = 0;
  const chat = async (messages, callOptions = {}) => {
    calls.push({ messages: JSON.parse(JSON.stringify(messages)), callOptions: { ...callOptions } });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return { text: step.text ?? '', toolCalls: step.toolCalls ?? null, finishReason: step.finishReason ?? (step.toolCalls ? 'tool_calls' : 'stop'), raw: {} };
  };
  return { chat, calls, get count() { return i; } };
}

/** 快照语义的假 llm:"当前"client 可热换,snapshot 绑定当时的 client。 */
function snapshotLlm(script) {
  const clientA = { tag: 'A' };
  const clientB = { tag: 'B' };
  let current = clientA;
  const hits = [];
  const makeChat = (tag) => async (messages, callOptions = {}) => {
    hits.push(tag);
    const step = script[Math.min(hits.length - 1, script.length - 1)];
    return { text: step.text ?? '', toolCalls: step.toolCalls ?? null, finishReason: 'stop', raw: { servedBy: tag } };
  };
  const llm = {
    chat: (m, o) => makeChat(current.tag)(m, o),
    snapshot: () => {
      const bound = current;
      return { chat: (m, o) => makeChat(bound.tag)(m, o) };
    },
    switchToB() { current = clientB; },
  };
  return { llm, hits };
}

function tempFixture(persona = '你是测试用的人设。') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-tools-'));
  const personaPath = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(personaPath, persona, 'utf8');
  return { store: new SqliteStateStore(path.join(dir, 'state.db')), personaPath, dir };
}

const searchCap = defineCapability({
  id: 'web_search',
  description: '搜索',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  effect: 'read-only',
  execute: async (args, ctx) => ({ ok: true, data: { args, by: ctx.turnContext.botId } }),
});
const TOOL_CALL = (id, name, argsJson) => ({ id, type: 'function', function: { name, arguments: argsJson } });

function baseToolContext(overrides = {}) {
  return {
    tools: [{ type: 'function', function: { name: 'web_search', description: '搜索', parameters: searchCap.inputSchema } }],
    capabilities: [searchCap],
    grant: { allowToolIds: new Set(['web_search']) },
    turnContext: turnContextFor({ botId: 'aris', actorId: 'u1', scene: 'c2c', conversationKey: 'k', purpose: 'chat' }),
    maxRounds: 3,
    ...overrides,
  };
}

export function registerEngineToolTests({ test, assert: a }) {
  test('两步闭环:assistant 原样接回、tool 结果配对、只落最终正文并带 toolsUsed', async () => {
    const fx = tempFixture();
    const executed = [];
    const cap = defineCapability({
      id: 'web_search', description: '搜索',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      effect: 'read-only',
      execute: async (args, ctx) => { executed.push({ args, botId: ctx.turnContext.botId }); return { ok: true, results: ['r1'] }; },
    });
    const llm = scriptedLlm([
      { toolCalls: [TOOL_CALL('c1', 'web_search', '{"query":"测试"}')] },
      { text: '答案正文' },
    ]);
    const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath, budget: null, log: {} });
    try {
      await engine.initialize();
      const result = await engine.runTurn('k', '问个事', 5000, null, baseToolContext({ capabilities: [cap] }));
      a.equal(result.text, '答案正文');
      a.equal(llm.calls.length, 2, '两次模型调用(调工具→回结果→再答)');
      const [first, second] = llm.calls;
      a.deepEqual(first.callOptions.tools, baseToolContext().tools, '第一次要带 tools');
      a.equal(second.callOptions.tools.length, 1, '续问同样带 tools');
      // 第二次请求里:assistant 原样接回 + tool 结果配对。
      const assistant = second.messages.find((m) => m.role === 'assistant');
      a.ok(assistant.tool_calls, 'assistant 的 tool_calls 必须原样带回');
      a.equal(assistant.tool_calls[0].id, 'c1');
      const toolMsg = second.messages.find((m) => m.role === 'tool');
      a.equal(toolMsg.tool_call_id, 'c1');
      a.match(toolMsg.content, /"ok":true/);
      a.match(toolMsg.content, /r1/);
      // 执行端收到结构化参数 + 可信上下文。
      a.deepEqual(executed, [{ args: { query: '测试' }, botId: 'aris' }]);
      // 落库:只有 user + 最终 assistant;meta 带 toolsUsed。
      const rows = fx.store.conversationTurns('k');
      a.deepEqual(rows.map((row) => row.role), ['user', 'assistant'], '工具中间消息不落库(append-only 不破)');
      a.equal(rows[1].content, '答案正文');
      a.deepEqual(rows[1].meta.toolsUsed, ['web_search']);
    } finally {
      await engine.stop();
      fx.store.close();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('预算耗尽:显式"没能完成",不许 [跳过] 也不许中间文本', async () => {
    const fx = tempFixture();
    const endless = scriptedLlm([{ toolCalls: [TOOL_CALL('c1', 'web_search', '{"query":"x"}')] }]);
    const engine = createOwnEngine({ llm: endless, store: fx.store, personaPath: fx.personaPath, budget: null, log: {} });
    try {
      await engine.initialize();
      const result = await engine.runTurn('k', '问', 5000, null, baseToolContext({ maxRounds: 1 }));
      a.match(result.text, /没能完成/, '预算耗尽要有显式失败正文');
      a.equal(result.text.includes('[跳过]'), false, '不许落到跳过标记');
      a.match(result.text, /web_search/);
      // 预算语义:maxRounds=1 = 完成 1 轮"调工具→回结果"后续问一次,模型仍要工具 → 停。
      a.equal(endless.calls.length, 2, 'maxRounds=1: 首次 + 一次续问,然后显式停');
    } finally {
      await engine.stop();
      fx.store.close();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('坏 JSON 参数 → INVALID_ARGUMENTS 回给模型,循环继续', async () => {
    const fx = tempFixture();
    const llm = scriptedLlm([
      { toolCalls: [TOOL_CALL('c1', 'web_search', '{坏掉的json')] },
      { text: '按失败如实作答' },
    ]);
    const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath, budget: null, log: {} });
    try {
      await engine.initialize();
      const result = await engine.runTurn('k', '问', 5000, null, baseToolContext());
      a.equal(result.text, '按失败如实作答');
      const toolMsg = llm.calls[1].messages.find((m) => m.role === 'tool');
      a.match(toolMsg.content, /INVALID_ARGUMENTS/, '坏参数必须作为结构化错误回给模型');
      a.doesNotMatch(toolMsg.content, /EXEC_FAILED/);
    } finally {
      await engine.stop();
      fx.store.close();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('伪造未授权工具 → DENIED 回给模型(执行端闸在循环内生效)', async () => {
    const fx = tempFixture();
    const llm = scriptedLlm([
      { toolCalls: [TOOL_CALL('c1', 'delete_everything', '{}')] },
      { text: '知道了' },
    ]);
    const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath, budget: null, log: {} });
    try {
      await engine.initialize();
      const result = await engine.runTurn('k', '问', 5000, null, baseToolContext());
      a.equal(result.text, '知道了');
      const toolMsg = llm.calls[1].messages.find((m) => m.role === 'tool');
      a.match(toolMsg.content, /UNSUPPORTED/, '没注册的工具必须被拒(UNSUPPORTED,不是静默执行)');
      a.doesNotMatch(toolMsg.content, /"ok":true/);
    } finally {
      await engine.stop();
      fx.store.close();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('整轮 client 快照:循环中途热换"当前"client,本轮子调用仍钉死快照', async () => {
    const fx = tempFixture();
    const { llm, hits } = snapshotLlm([
      { toolCalls: [TOOL_CALL('c1', 'web_search', '{"query":"x"}')] },
      { text: '最终答案' },
    ]);
    // 在**工具执行期间**热换(第一次模型调用之后、第二次子调用之前)—— 最苛刻的时点。
    const hotSwapCap = defineCapability({
      id: 'web_search', description: '搜索',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      effect: 'read-only',
      execute: async () => { llm.switchToB(); return { ok: true, results: [] }; },
    });
    const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath, budget: null, log: {} });
    try {
      await engine.initialize();
      const result = await engine.runTurn('k', '问', 5000, null, baseToolContext({ capabilities: [hotSwapCap] }));
      a.equal(result.text, '最终答案');
      a.deepEqual(hits, ['A', 'A'], `中途热换后本轮子调用仍必须走快照 client,实际 ${JSON.stringify(hits)}`);
    } finally {
      await engine.stop();
      fx.store.close();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('四参调用(无 toolContext)行为不变:不发 tools、一次调用、meta 无 toolsUsed', async () => {
    const fx = tempFixture();
    const llm = scriptedLlm([{ text: '普通回答' }]);
    const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath, budget: null, log: {} });
    try {
      await engine.initialize();
      const result = await engine.runTurn('k', '问', 5000, null);
      a.equal(result.text, '普通回答');
      a.equal(llm.calls.length, 1);
      a.equal(llm.calls[0].callOptions.tools, undefined, '不带 toolContext 就一个字节的 tools 都不发');
      const rows = fx.store.conversationTurns('k');
      a.equal(rows[1].meta.toolsUsed, undefined);
      a.ok(rows[1].meta.source, 'meta 形状保持');
    } finally {
      await engine.stop();
      fx.store.close();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('内部用途(summary)不经过循环:同样的调用不带 tools', async () => {
    const fx = tempFixture();
    const llm = scriptedLlm([{ text: '摘要正文' }]);
    const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath, budget: null, log: {} });
    try {
      await engine.initialize();
      await engine.runTurn('qqbot-summary-x', '压缩这段', 5000, null);
      a.equal(llm.calls.length, 1);
      a.equal(llm.calls[0].callOptions.tools, undefined, '摘要路径不许带工具(装配层也不会给,这里钉引擎侧)');
    } finally {
      await engine.stop();
      fx.store.close();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('wiring:index 装配、config 默认关、快照在 scoped 上(扫源码)', () => {
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    // 三个 chat 入口都带工具上下文;内部播报路径保持四参(不带)。
    const count = (indexSource.match(/buildToolContext\(message, conversationKey\)/g) ?? []).length;
    a.ok(count >= 2, `主答话+网页都要带工具上下文,实际 ${count}`);
    a.match(indexSource, /buildToolContext\(merged, conversationKey\)/, '合并答话也要带');
    // 判据顺序:总闸最前,协议闸在 advertise 之前( Responses 发了会 400)。
    const fnStart = indexSource.indexOf('function buildToolContext(');
    const fnBody = indexSource.slice(fnStart, fnStart + 1400);
    const enabledAt = fnBody.indexOf('if (!toolsCfg.enabled) return null;');
    const modelAt = fnBody.indexOf('if (toolsCfg.modelFunctionTools !== true) return null;');
    const respAt = fnBody.indexOf('isResponsesApi(');
    const advAt = fnBody.indexOf('advertisedTools(');
    a.ok(enabledAt >= 0 && modelAt > enabledAt && respAt > modelAt && advAt > respAt,
      '装配判据顺序必须是:总闸 → 模型已验证 → 协议闸 → advertise');
    a.match(fnBody, /purpose: 'chat'/, '装配只产生 chat 用途(内部用途没有工具)');
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    a.match(configSource, /asBool\('QQBOT_TOOLS', false\)/, '工具总闸必须默认关(行为一字不变)');
    a.match(configSource, /asBool\('QQBOT_TOOLS_MODEL_FN', false\)/, '模型支持必须显式声明(unknown 不赌)');
    a.match(configSource, /asNonNegativeInt\('QQBOT_TOOLS_MAX_ROUNDS', 3\)/, '循环预算是配置,不定死在引擎里');
    const settingsSource = fs.readFileSync(path.resolve('src', 'llm-settings.js'), 'utf8');
    a.match(settingsSource, /snapshot: \(\) =>/, 'scoped 必须提供整轮快照');
  });
}
