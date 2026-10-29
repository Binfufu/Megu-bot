/**
 * **own 路采样配置接线 + `finish_reason` 截断提示 + 生效值横幅**(2026-10-15,并行审查 F4/F5/F6)。
 *
 * 三条都是**静默失效/口径不一致**那一族,所以判据一律钉在**消费端**:
 *   · F5 —— 环境变量 → 配置 → 装配 → **真 HTTP body**;只断言"配置读到了"等于没判据;
 *   · F6 —— `finish_reason` → 引擎 reason → **用户看得见的那句提示**(`describeTurnEnd`);
 *   · F4 —— 横幅打的是不是**生效值**;装配段不执行 `main()`,所以这条必须扫源码。
 *
 * 反证(改回即红)写在每组的注释里。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngineConfig, buildEngineRequestOptions, describeDshOnlyRequestOptions } from '../src/config.js';
import { createOwnEngine, reasonForFinish } from '../src/engine.js';
import { createLlmClient, validateLlmRequestOptions } from '../src/llm.js';
import { describeTurnEnd } from '../src/runner-contract.js';
import { SqliteStateStore } from '../src/sqlite-store.js';

const BRIDGE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 造一个"只读环境变量"的口 —— 测试绝不碰进程环境(相邻用例会串味)。 */
const envReader = (map) => (name) => map[name];

export function registerOwnRequestOptionsTests({ test, assert }) {
  test('own采样(F5):QQBOT_LLM_* 读进来、坏值在网络之前拒绝、绝不从 DSH 那对回落', () => {
    // ① 配了就生效,而且 **DREAM 那一对**是回落(与 key/model 同一套口径)。
    assert.deepEqual(buildEngineRequestOptions(envReader({
      QQBOT_LLM_REASONING_EFFORT: 'high', QQBOT_LLM_MAX_TOKENS: '256000',
    })), { reasoningEffort: 'high', maxTokens: 256000 });
    assert.deepEqual(buildEngineRequestOptions(envReader({
      QQBOT_LLM_DREAM_REASONING_EFFORT: 'low', QQBOT_LLM_DREAM_MAX_TOKENS: '4096',
    })), { reasoningEffort: 'low', maxTokens: 4096 });
    assert.deepEqual(buildEngineRequestOptions(envReader({
      QQBOT_LLM_DREAM_REASONING_EFFORT: 'low', QQBOT_LLM_REASONING_EFFORT: 'max',
    })), { reasoningEffort: 'max' }, '世界档那一对压过梦境档');
    // ② 没配 = 逐字保持旧行为(不放这个键 ⇒ body 里一个字段都不多)。
    assert.deepEqual(buildEngineRequestOptions(envReader({})), {});
    // ③ 大小写与首尾空格**归一化**(操作员手抄 .env 的善意,不算坏值)。
    assert.deepEqual(buildEngineRequestOptions(envReader({ QQBOT_LLM_REASONING_EFFORT: ' OFF ' })),
      { reasoningEffort: 'off' });
    // ④ 真坏值在**网络之前**当场抛(而且走的是 llm.js 那一个校验口,D159)。
    for (const bad of ['medium', 'HIGH2', 'enabled']) {
      assert.throws(() => buildEngineRequestOptions(envReader({ QQBOT_LLM_REASONING_EFFORT: bad })),
        /unsupported reasoningEffort/, `档位 ${bad} 必须被拒`);
    }
    for (const bad of ['0', '-1', '1.5', 'abc', '-256000']) {
      assert.throws(() => buildEngineRequestOptions(envReader({ QQBOT_LLM_MAX_TOKENS: bad })),
        /QQBOT_LLM_MAX_TOKENS 必须是正安全整数/, `maxTokens ${bad} 必须被拒`);
    }
    // `256000.0` 数值上就是 256000(与 DSH 路 `asInt` 的口径一致:那一路也会读成 256000)——
    // 口径一致比"看起来更严"重要,否则同一个值两条路一个收一个拒。
    assert.deepEqual(buildEngineRequestOptions(envReader({ QQBOT_LLM_MAX_TOKENS: '256000.0' })),
      { maxTokens: 256000 });
    // ⚠️ **绝不从 QQBOT_DSH_* 回落**:那会让 own 路悄悄继承一份没人给它定的采样参数。
    assert.deepEqual(buildEngineRequestOptions(envReader({
      QQBOT_DSH_REASONING_EFFORT: 'high', QQBOT_DSH_MAX_TOKENS: '256000',
    })), {}, 'DSH 那两项**不许**被 own 路继承(要的是显式配置 + 显式 warn)');
    // ⑤ 配了 DSH 专用项 = 能报出**名字**(装配段据此 warn);没配 = 空数组(不制造狼来了)。
    assert.deepEqual(describeDshOnlyRequestOptions(envReader({
      QQBOT_DSH_REASONING_EFFORT: 'high',
    })), ['QQBOT_DSH_REASONING_EFFORT']);
    assert.deepEqual(describeDshOnlyRequestOptions(envReader({})), []);
    // ⑥ 配置对象真的带着这两样进装配(下面那条静态判据再看装配段有没有真的传)。
    assert.ok('requestOptions' in buildEngineConfig(), 'buildEngineConfig 必须把采样参数带出来');
  });

  test('own采样(F5):配置→装配→**真 HTTP body** —— engine 支持不够,装配没传就等于没修', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-wiring-'));
    const personaPath = path.join(dir, 'persona.txt');
    fs.writeFileSync(personaPath, 'sampling-persona');
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const bodies = [];
    let engine;
    try {
      // ⚠️ 这里**故意走配置那一层**取值(而不是手写 {reasoningEffort:'high'})——
      //    手写就绕过了"配置读进来"这半截,而那半截正是 F5 缺的那一段。
      const requestOptions = buildEngineRequestOptions(envReader({
        QQBOT_LLM_REASONING_EFFORT: 'high', QQBOT_LLM_MAX_TOKENS: '256000',
      }));
      engine = createOwnEngine({ store, personaPath, budget: null, requestOptions,
        llm: createLlmClient({ baseUrl: 'https://offline.invalid', apiKey: 'offline', model: 'deepseek-flash', attempts: 1,
          fetchImpl: async (_url, request) => {
            bodies.push(JSON.parse(request.body));
            return new Response(JSON.stringify({ choices: [{ message: { content: '离线答复' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200 });
          } }) });
      await engine.initialize();
      await engine.runTurn('wiring', '采样接线这一句');
      assert.equal(bodies.length, 1, '正好一发');
      assert.equal(bodies[0].model, 'deepseek-flash');
      assert.equal(bodies[0].max_tokens, 256000, '生效的 max_tokens 必须真的进 body');
      assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
      assert.equal(bodies[0].reasoning_effort, 'high', '生效的档位必须真的进 body');
      // 对照:没配 ⇒ body 里**一个都不多**(旧行为逐字不变)。
      await engine.stop(); engine = null;
      engine = createOwnEngine({ store, personaPath, budget: null,
        requestOptions: buildEngineRequestOptions(envReader({})), llm: createLlmClient({
          baseUrl: 'https://offline.invalid', apiKey: 'offline', model: 'deepseek-flash', attempts: 1,
          fetchImpl: async (_url, request) => {
            bodies.push(JSON.parse(request.body));
            return new Response(JSON.stringify({ choices: [{ message: { content: '离线答复' }, finish_reason: 'stop' }] }), { status: 200 });
          } }) });
      await engine.initialize();
      await engine.runTurn('wiring-default', '没配这一句');
      assert.equal('max_tokens' in bodies[1], false);
      assert.equal('thinking' in bodies[1], false);
      assert.equal('reasoning_effort' in bodies[1], false);
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('截断提示(F6):finish_reason=length → 用户**看得见**那句提示(own 与 DSH 同一口径)', async () => {
    // ① 纯函数那一层:kind 翻对了,而且**文案是消费端那一份**(不在这里另写一句)。
    assert.deepEqual(reasonForFinish('length'), { kind: 'max-tokens' });
    assert.deepEqual(reasonForFinish('stop'), { kind: 'completed' });
    assert.deepEqual(reasonForFinish(null), { kind: 'completed' }, '认不出 = completed(不猜)');
    assert.equal(describeTurnEnd(reasonForFinish('length')), '（回复达到输出长度上限，已被截断）');
    // ② 真引擎那一层:HTTP 回的 length 必须原样走到 runTurn 的 reason 上。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-finish-'));
    const personaPath = path.join(dir, 'persona.txt');
    fs.writeFileSync(personaPath, 'finish-persona');
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const reply = (content, finish_reason) => async () => new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), { status: 200 });
    let engine;
    try {
      // 截断的那一轮
      engine = createOwnEngine({ store, personaPath, budget: null,
        llm: createLlmClient({ baseUrl: 'https://offline.invalid', apiKey: 'offline', model: 'm', attempts: 1,
          fetchImpl: reply('话说到一半', 'length') }) });
      await engine.initialize();
      const truncated = await engine.runTurn('k', '长一点');
      assert.equal(truncated.reason.kind, 'max-tokens');
      assert.equal(describeTurnEnd(truncated.reason), '（回复达到输出长度上限，已被截断）',
        '消费端必须能看见这句 —— 反证:把 reasonForFinish 改回恒 completed,这一行当场红');
      assert.equal(truncated.timedOut, false);
      // ③ 空回复也照同一条口径(她选择不说 + 被截断,两件事互不覆盖)。
      await engine.stop(); engine = null;
      engine = createOwnEngine({ store, personaPath, budget: null,
        llm: createLlmClient({ baseUrl: 'https://offline.invalid', apiKey: 'offline', model: 'm', attempts: 1,
          fetchImpl: reply('', 'length') }) });
      await engine.initialize();
      const silent = await engine.runTurn('silent', '空');
      assert.equal(silent.text, '[跳过]');
      assert.equal(silent.reason.kind, 'max-tokens');
      // ④ 正常收尾不许被误判成截断。
      await engine.stop(); engine = null;
      engine = createOwnEngine({ store, personaPath, budget: null,
        llm: createLlmClient({ baseUrl: 'https://offline.invalid', apiKey: 'offline', model: 'm', attempts: 1,
          fetchImpl: reply('正常答完', 'stop') }) });
      await engine.initialize();
      const normal = await engine.runTurn('n', '正常');
      assert.equal(normal.reason.kind, 'completed');
      assert.equal(describeTurnEnd(normal.reason), null, '正常收尾不该给用户加任何提示');
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('生效值横幅(F4)+ 装配接线:own 打自己的模型,退役的引擎模式有 warn(扫源码)', () => {
    const raw = fs.readFileSync(path.join(BRIDGE_ROOT, 'src', 'index.js'), 'utf8');
    // ⚠️ **先剥注释再断言**(2026-10-15 反证当场抓到):第一版直接扫原文,于是把
    //    `// requestOptions: config.engine.requestOptions,` 这种**被注释掉的装配**
    //    当成了"接了线" —— 判据绿着而生产根本没传(这正是"判据自证/狼来了"那一族)。
    const index = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // 反证:把 requestOptions 那行注释掉 ⇒ 当场红。
    assert.ok(/requestOptions: config\.engine\.requestOptions/.test(index),
      'own 引擎的装配必须**真的传** requestOptions(注释掉不算)—— engine 支持不等于生产传了(F5 就是缺这一段)');
    // 6B(1.150.84):引擎只剩 own 一条路 —— 不再有 own/shadow/dsh 三行横幅,判据改成两条:
    // ① own 那行必须真打(扫源码,注释掉不算);② 退役的 QQBOT_ENGINE 要被显式 warn(配置静默丢弃族)。
    assert.ok(/logEngineModelLine\(\)/.test(index), 'own 路必须打一行**自己的生效值**横幅(F4)');
    assert.ok(/QQBOT_ENGINE=\$\{config\.engine\.mode\} 已退役/.test(index),
      '配了已退役的 QQBOT_ENGINE 必须**显式 warn** —— 读到了却没生效是配置静默丢弃族');
    assert.ok(/dshOnlyRequestOptions\?\.length/.test(index) && /log\.warn/.test(index),
      'DSH 专用项在 own 下必须**显式 warn**(同上)');
    assert.ok(!/engineMode === 'shadow'/.test(index), '影子的分支已经退役,不该再出现在生产装配里');
    // 横幅里必须带**模型与 baseUrl**,而且采样参数打的是生效值(不是"读到了")。
    const line = index.slice(index.indexOf('function logEngineModelLine'));
    const body = line.slice(0, line.indexOf('\n  }'));
    assert.ok(/llm\.model/.test(body), '要打生效模型');
    assert.ok(/llm\.baseUrl/.test(body), '要打 baseUrl');
    assert.ok(/requestOptions\?\.reasoningEffort/.test(body) && /requestOptions\?\.maxTokens/.test(body),
      '采样参数要打生效值');
    assert.ok(/未设档位\/未设输出上限/.test(body), '没配时要**明说没设**,别让人以为配了');
    // 启动那行:版本横幅的位置不变(别的判据还在看它),但**报的模型必须是生效值**。
    // ⚠️ 2026-10-17(D236)反证:改之前这行报的是 `model=${config.dsh.provider}/${config.dsh.model}`
    //    —— 那两项是已退役 DSH 连接段的配置,**一个消费者都没有**。症状是同一次启动里
    //    横幅说 deepseek-flash、24 行后 `[引擎] own 路生效值` 说 deepseek-chat。
    //    而横幅是**唯一被写进判据的启动证据** ⇒ 它报错模型 = 把"验过了"变成验了个假的。
    assert.ok(/bridge 启动：version=\$\{version\}/.test(raw), '启动横幅不许被动过');
    const banner = raw.slice(raw.indexOf('bridge 启动：'), raw.indexOf('bridge 启动：') + 200);
    assert.ok(/llm\.model/.test(banner), '横幅必须报**生效**模型(config.engine.llm.model)');
    assert.ok(!/config\.dsh\.(provider|model|profile)/.test(banner),
      '横幅不许再报已退役的 DSH 字段(profile/provider/model 都没消费者了)');
  });


  test('采样校验只有一个口(F5/D159):配置层与客户端层用的是同一个函数', () => {
    // 这条是"不许写第二份"的判据:配置层若自己写一套字面量,两边迟早漂移。
    const src = fs.readFileSync(path.join(BRIDGE_ROOT, 'src', 'config.js'), 'utf8');
    assert.ok(/import \{ validateLlmRequestOptions \} from '\.\/llm\.js'/.test(src),
      'config.js 必须复用 llm.js 的校验口');
    // 客户端那一层认死枚举(它才是"发出去之前"的最后一道),大小写都不给过。
    assert.throws(() => validateLlmRequestOptions({ reasoningEffort: 'HIGH' }), /unsupported reasoningEffort/);
    // 配置层多一层归一化(trim + 小写)是**善意**,但归一化**之后**仍不合法的值照样被同一个口拒掉
    // —— 两条一起看才说明"没有第二份字面量":`HIGH` 被归一化成 `high` 才通过的。
    assert.deepEqual(buildEngineRequestOptions(envReader({ QQBOT_LLM_REASONING_EFFORT: 'HIGH' })),
      { reasoningEffort: 'high' }, '大写靠归一化通过,而不是靠放宽枚举');
    assert.throws(() => buildEngineRequestOptions(envReader({ QQBOT_LLM_REASONING_EFFORT: 'HIGHEST' })),
      /unsupported reasoningEffort/);
  });
}
