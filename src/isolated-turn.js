/**
 * **隔离跑一轮**(2026-10-16,1.150.84,6B 去 DSH 化)。
 *
 * ## 为什么有它
 *
 * 离线工具（`scripts\announce-preview.js` 播报预演、`scripts\card-eval.js` 卡评测）原来
 * 经 `DshRunner` 起一个 `dsh` 子进程跑一轮 —— 那是 DSH 连接段的一部分。连接段退役后，
 * 这两件工具改成走**桥自己的引擎**：临时库 + 卡的人设文件 + own 引擎，跑完即销毁。
 *
 * 好处不只是"少一跳"：
 * 1. **不碰生产库**：临时目录里的 `state.db`，跑完删掉；
 * 2. **天然隔离**：每次调用一个全新库 ⇒ 用例之间不会互相污染（旧实现要自己记得换会话 id）；
 * 3. **与生产同一条路**：工具验的就是她真实装配（人设/引擎/采样参数），不再是另一条链。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnEngine } from './engine.js';
import { createLlmClient } from './llm.js';
import { SqliteStateStore } from './sqlite-store.js';
import { readEnvFileValue } from './bot-home.js';

/**
 * 跑一轮，返回 `{ text, timedOut, ... }`（与旧 runner.runTurn 同形状）。
 *
 * @param {object} args
 * @param {string} args.envFile    该 bot 的 .env（取直连 key / 模型）
 * @param {string} args.personaPath 卡的人设文件（工作区里的 AGENTS.md）
 * @param {string} args.key        会话键（每次调用一个新库，键只用于记账口径）
 * @param {string} args.prompt     这一轮的输入
 * @param {number} [args.timeoutMs]
 * @param {object} [args.log]
 */
export async function runIsolatedTurn({ envFile, personaPath, key, prompt, timeoutMs = 180_000, log }) {
  const env = (name) => readEnvFileValue(envFile, name);
  const apiKey = env('QQBOT_LLM_KEY') || env('QQBOT_LLM_DREAM_KEY');
  if (!apiKey) throw new Error(`own 引擎需要直连 key(QQBOT_LLM_KEY / QQBOT_LLM_DREAM_KEY):${envFile}`);
  const llm = createLlmClient({
    apiKey,
    baseUrl: env('QQBOT_LLM_BASEURL') || env('QQBOT_LLM_DREAM_BASEURL') || 'https://api.deepseek.com/v1',
    model: env('QQBOT_LLM_MODEL') || env('QQBOT_LLM_DREAM_MODEL') || 'deepseek-chat',
    timeoutMs,
    log,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-turn-'));
  const store = new SqliteStateStore(path.join(dir, 'state.db'));
  const engine = createOwnEngine({ llm, store, personaPath });
  try {
    await engine.initialize();
    return await engine.runTurn(key, prompt, timeoutMs);
  } finally {
    try { await engine.stop(); } catch { /* 收尾失败不影响已经拿到的结果 */ }
    try { store.close(); } catch { /* 同上 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
