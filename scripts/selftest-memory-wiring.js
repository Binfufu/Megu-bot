/**
 * 记忆 P1-C 的**装配接线判据**(2026-10-19,见 `docs\03` D263)。
 *
 * ## 为什么单开这么一份(而不是只测纯函数)
 *
 * 软失效的两个机制(`fact` / `note`)在各自模块里都有真跑临时库的用例,但
 * **"生产 main() 到底有没有把开关接上"** 是另一个问题:
 *   · 函数默认 `latestOnly = true` 时,单测全绿;
 *   · 而 `index.js` 里传了 `undefined`(或 `config` 少一层),生产就静默变成**不过滤** ——
 *     这正是本项目 D159/"判据被别的东西喂饱"那一族:测试绿着,行为是旧的。
 * 本文件第一版就抓到过一次真实的接线错误:config 曾被塞进 `longTerm` 子块,
 * 而 index.js 读的是 `memoryCfg.latestOnly` ⇒ undefined ⇒ 横幅打"读过滤 关"。
 * 所以这里钉两条**装配段**判据(本项目对装配段的惯例就是扫源码):
 *
 *   1. `config.policy.memory.latestOnly`:默认 true;`QQBOT_MEMORY_LATEST_ONLY=0` → false
 *      (回滚开关能用,而且真的从 memory 这一层读);
 *   2. `src/index.js` 必须把 `latestOnly` 同时接到**两条读路径**:
 *      `makeLongTermProvider`(note)与 `facts(...)`(fact),并调用 `ensureNoteSchema`
 *      补列、把 `consolidate` 的 `superseded` 打进日志。
 *
 * ⚠️ 扫源码的判据要能红:本文件带**反证**——把接线字样从源码里删掉后,
 *    同一个判定必须变成 false,否则这条判据只是"看起来在测"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `index.js` 里"读过滤接线"的四条证据。**纯函数**,便于做反证。
 * @returns {{ provider: boolean, facts: boolean, ensure: boolean, log: boolean }}
 */
export function latestOnlyWiring(source) {
  const text = String(source ?? '');
  return {
    // note 读路径:makeLongTermProvider 的实参里必须带 latestOnly
    provider: /makeLongTermProvider\(\{[\s\S]{0,1500}?latestOnly:\s*memoryCfg\.latestOnly/.test(text),
    // fact 读路径:facts({...}) 的实参里必须带 latestOnly
    facts: /\.facts\(\{[^}]*latestOnly:\s*memoryCfg\.latestOnly/.test(text),
    // note 老库补列:启动时必须真的调用(否则 note 的 invalid_at 永远不会存在)
    ensure: /ensureNoteSchema\(memoryDb\)/.test(text),
    // 软失效发生时日志里要说得出来(判据②:为什么够格/做了什么)
    log: /result\.superseded/.test(text),
  };
}

export function registerMemoryWiringTests({ test, assert }) {
  test('记忆 P1-C 回滚开关:默认过滤开;QQBOT_MEMORY_LATEST_ONLY=0 关(从 memory 这一层读)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-p1c-config-'));
    try {
      // 临时 root:loadConfig 只要求最小的 .env(QQ_APP_ID / QQ_CLIENT_SECRET)
      fs.mkdirSync(path.join(dir, 'bots', 'megumin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'bots', 'megumin', '.env'), 'QQ_APP_ID=test\nQQ_CLIENT_SECRET=test\n');
      delete process.env.QQBOT_MEMORY_LATEST_ONLY;
      assert.equal(loadConfig({ rootDir: dir }).policy.memory.latestOnly, true, '默认必须过滤');
      process.env.QQBOT_MEMORY_LATEST_ONLY = '0';
      assert.equal(loadConfig({ rootDir: dir }).policy.memory.latestOnly, false, '0 = 关(回滚到 P1-B 行为)');
      process.env.QQBOT_MEMORY_LATEST_ONLY = '1';
      assert.equal(loadConfig({ rootDir: dir }).policy.memory.latestOnly, true);
      delete process.env.QQBOT_MEMORY_LATEST_ONLY;
    } finally {
      delete process.env.QQBOT_MEMORY_LATEST_ONLY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('记忆 P1-C 装配接线:读过滤必须同时接到 note 与 fact 两条读路径(扫源码 + 反证)', () => {
    const source = fs.readFileSync(path.join(BRIDGE_ROOT, 'src', 'index.js'), 'utf8');
    const wiring = latestOnlyWiring(source);
    assert.deepEqual(
      wiring,
      { provider: true, facts: true, ensure: true, log: true },
      '生产 main() 的接线缺了:单测绿不代表生产真的在过滤旧说法',
    );
    // ⚠️ 反证:把接线字样删掉,判定必须当场变红 —— 否则这条判据是在自证。
    const broken = source.replace(/latestOnly:\s*memoryCfg\.latestOnly/g, '');
    assert.equal(latestOnlyWiring(broken).provider, false, '反证必须咬');
    assert.equal(latestOnlyWiring(broken).facts, false, '反证必须咬');
  });
}
