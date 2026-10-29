/**
 * 戳一戳 / 表情反应路径的**源码扫描判据**(1.195.0)。
 *
 * 跑法:
 *
 *     node scripts\selftest-interaction.js
 *
 * 钉:
 *   ① `maybeInteractionReply` 的形参里触发消息叫 `message`(签名被改名 → 本判据当场红,跟着改);
 *   ② 该函数里**第一处** `rollEconomy({...})` 的 text 必须来自 `message?.content`,
 *      且不许读 `source`(那是前代 bug:1.58.0 起引用了不存在的 `source`,每次掷中概率就
 *      ReferenceError、被外层 catch 吞成「反应失败」日志 —— 戳一戳/表情反应长期哑火)。
 *
 * 为什么用源码扫描而不是单测:这个函数是 `createBridge` 闭包里的内部函数、没有导出,
 * 单测打不进去;这类"引用一个不存在的名字"的 bug 只有运行时才炸、还被 catch 吞掉,
 * 表现是**功能静默哑火**(前代 1.58.0 → 1.195.0,TODO ★★☆)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 读 src/index.js 里 `maybeInteractionReply` 那一段(函数头 + 第一处 rollEconomy 调用)。 */
function readReactionSlice() {
  const source = fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.js'), 'utf8');
  const start = source.indexOf('async function maybeInteractionReply(');
  assert.ok(start >= 0, 'src\\index.js 里找不到 maybeInteractionReply(改名了?这条判据要跟着改)');
  const ledgerAt = source.indexOf('rollEconomy({', start);
  assert.ok(ledgerAt > start, 'maybeInteractionReply 里找不到 rollEconomy 调用');
  const gap = ledgerAt - start;
  assert.ok(gap < 4000, `第一处 rollEconomy 离函数头 ${gap} 字,不像是在这个函数里 —— 判据要重锚`);
  const ledgerEnd = source.indexOf('\n', ledgerAt);
  return {
    signature: source.slice(start, start + 120),
    ledgerLine: source.slice(ledgerAt, ledgerEnd > 0 ? ledgerEnd : undefined),
  };
}

test('interaction:maybeInteractionReply 的触发消息叫 message,且 rollEconomy 读的是它', () => {
  const { signature, ledgerLine } = readReactionSlice();
  // 签名:形参顺序 (groupId, message, kind)。
  assert.match(
    signature,
    /maybeInteractionReply\(\s*groupId\s*,\s*message\s*,/u,
    '形参改名了 —— 判据里的 message 要跟着改',
  );
  // 经济入参必须来自触发消息。
  assert.match(ledgerLine, /message\?\.content/u, 'rollEconomy 的 text 必须来自 `message?.content`');
  // 不许再出现读 `source` 属性/下标的写法(那个名字在这个函数里不存在)。
  assert.ok(
    !/[^.\w`]source\s*[.?\[]/u.test(ledgerLine),
    `这行还在读 \`source\` —— 会 ReferenceError:${ledgerLine.trim()}`,
  );
});

export function registerInteractionTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerInteractionTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
