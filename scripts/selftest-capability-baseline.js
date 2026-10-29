/**
 * **能力基线采集**(P0,2026-10-28)回归。
 *
 * 它要回答的是"两只 bot 到底差在哪",所以它自己**不许说谎、不许漏密钥**:
 *   · 密钥只报 `set/unset`,全量输出里一个字都不能出现;
 *   · 模型是否支持视觉/工具 → 必须是 `unknown`(没发请求就是没证据);
 *   · 读不到 ≠ 没配(BOM 那种坑会把"配了"报成"没配",必须真跑一次带 BOM 的夹具)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvFileValue } from '../src/bot-home.js';
import { collectBaseline } from './capability-baseline.mjs';

const FAKE_KEY = 'sk-FIXTURE-MUST-NOT-LEAK-9f2c';

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-capbase-${tag}-`));
}

/** 夹具:`bom` = 模拟 PowerShell `Set-Content -Encoding utf8` 写出的文件。 */
function writeEnv(dir, { bom = false, lines }) {
  const file = path.join(dir, 'fixture.env');
  const body = `${bom ? '\uFEFF' : ''}${lines.join('\n')}\n`;
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

export function registerCapabilityBaselineTests({ test, assert }) {
  test('env 读取:BOM 开头的文件也必须读得到第一个键（反证:静默把"配了"报成"没配"）', () => {
    const dir = tempDir('bom');
    try {
      const plain = writeEnv(dir, { lines: [`QQBOT_LLM_KEY=${FAKE_KEY}`, 'QQBOT_LLM_MODEL=m1'] });
      assert.equal(readEnvFileValue(plain, 'QQBOT_LLM_KEY'), FAKE_KEY);
      const withBom = writeEnv(dir, { bom: true, lines: [`QQBOT_LLM_KEY=${FAKE_KEY}`, 'QQBOT_LLM_MODEL=m1'] });
      assert.equal(readEnvFileValue(withBom, 'QQBOT_LLM_KEY'), FAKE_KEY, 'BOM 不许把第一个键吃掉');
      assert.equal(readEnvFileValue(withBom, 'QQBOT_LLM_MODEL'), 'm1');
      // 真没有 = 空串(调用方据此报 unset,不抛)。
      assert.equal(readEnvFileValue(withBom, 'QQBOT_NOT_THERE'), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('基线:密钥只报 set/unset（全量输出零泄漏）、模型/协议/开关照实、能力标 unknown', () => {
    const dir = tempDir('base');
    try {
      const envFile = writeEnv(dir, {
        bom: true,
        lines: [
          `QQBOT_LLM_KEY=${FAKE_KEY}`,
          'QQBOT_LLM_BASEURL=https://api.example.test/v1',
          'QQBOT_LLM_MODEL=fixture-model',
          'QQBOT_LLM_REASONING_EFFORT=high',
          'QQBOT_MOOD_THEME=aris',
          'QQBOT_MEMORY_KB=1',
          'QQBOT_MEITU=0',
          'QQBOT_ADMIN_IDS=OWNER_A,OWNER_B',
          'QQBOT_MAX_IMAGES=2',
        ],
      });
      const baseline = collectBaseline({ envFile });
      const serialized = JSON.stringify(baseline);
      // ① 零泄漏(含"半截"也不行 —— 直接查整串)。
      assert.equal(serialized.includes(FAKE_KEY), false, '密钥本体不许出现在基线里');
      assert.equal(serialized.includes('FIXTURE-MUST-NOT-LEAK'), false, '也不许出现可辨识片段');
      assert.equal(baseline.model.key, 'set', '只报"配了没有"');
      // ② 模型与协议形状。
      assert.equal(baseline.model.name, 'fixture-model');
      assert.equal(baseline.model.baseUrl.host, 'api.example.test');
      assert.equal(baseline.model.baseUrl.looksResponses, false, '普通 baseUrl → chat/completions');
      assert.equal(baseline.model.reasoningEffort, 'high');
      // ③ 能力必须是 unknown,不许拿"名字像"当证据。
      for (const key of ['visionSupport', 'functionToolsSupport', 'builtinWebSearchSupport']) {
        assert.equal(baseline.model[key], 'unknown', `${key} 没发请求就不许下结论`);
      }
      // ④ 开关读生效值(env 优先,缺省标 code-default)。
      assert.equal(baseline.switches.moodTheme.value, 'aris');
      assert.equal(baseline.switches.knowledgeBase.value, true);
      assert.equal(baseline.switches.meitu.value, false, 'QQBOT_MEITU=0 → 关');
      assert.equal(baseline.switches.spokenSplit.source, 'code-default');
      // ⑤ 边界类只报计数。
      assert.equal(baseline.scopes.adminIdsCount, 2);
      assert.equal(baseline.scopes.memoryScopeStrictness, 'owner-listed');
      assert.equal(baseline.scopes.maxImages, '2');
      // ⑥ 自我否定那节必须在(防止拿基线当"能力已证")。
      assert.ok(Array.isArray(baseline.notProven) && baseline.notProven.length >= 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('基线:没配 admin 名单必须如实报 legacy-c2c-open（不许假装已隔离）', () => {
    const dir = tempDir('legacy');
    try {
      const envFile = writeEnv(dir, { lines: ['QQBOT_LLM_MODEL=m1'] });
      const baseline = collectBaseline({ envFile });
      assert.equal(baseline.switches.moodTheme.source, 'code-default(megumin)');
      assert.equal(baseline.scopes.memoryScopeStrictness, 'legacy-c2c-open');
      assert.equal(baseline.model.key, 'unset');
      // 角色卡没给 → 明说没提供,不编一个默认路径。
      assert.equal(baseline.persona.provided, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('基线:env 文件不存在时大声失败（不静默产出空基线）', () => {
    const dir = tempDir('missing');
    try {
      let error = null;
      try {
        collectBaseline({ envFile: path.join(dir, 'nope.env') });
      } catch (err) {
        error = err;
      }
      assert.ok(error, '必须抛');
      assert.match(String(error.message), /不存在/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
