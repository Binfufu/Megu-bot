#!/usr/bin/env node
/**
 * **边界契约**那一页的生成/校验器(1.106.6 / D178)。只读 + 可选写一个 markdown 文件。
 *
 * ```
 * node scripts\contract.js            # 打印那一页
 * node scripts\contract.js --write    # 写到 docs\16-边界契约.md
 * node scripts\contract.js --check    # 拿每条锚去真源码里核(不同步/挪走了就非零退出)
 * node scripts\contract.js --json     # 机器可读
 * ```
 *
 * ⚠️ 数据只此一份(`src\boundary-contract.js`);**别手改生成出来的那一页**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_ROWS, checkContract, renderContractPage } from '../src/boundary-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'docs', '16-边界契约.md');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

const io = { readFile: (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8') };

if (flag('--json')) {
  process.stdout.write(`${JSON.stringify(CONTRACT_ROWS, null, 2)}\n`);
} else if (flag('--check')) {
  const { ok, problems } = checkContract(CONTRACT_ROWS, io);
  if (ok) {
    process.stdout.write(`边界契约:${CONTRACT_ROWS.length} 条,锚全部命中 ✅\n`);
  } else {
    process.stdout.write(`边界契约:${problems.length} 处对不上 ❌\n`);
    for (const problem of problems) process.stdout.write(`  · ${problem}\n`);
    process.exitCode = 1;
  }
} else if (flag('--write')) {
  const page = renderContractPage(CONTRACT_ROWS);
  fs.writeFileSync(PAGE, page, 'utf8');
  const { ok, problems } = checkContract(CONTRACT_ROWS, io);
  process.stdout.write(`已写 ${path.relative(ROOT, PAGE)}( ${page.length} 字符)\n`);
  if (!ok) {
    process.stdout.write('⚠️ 但锚没全中:\n');
    for (const problem of problems) process.stdout.write(`  · ${problem}\n`);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(renderContractPage(CONTRACT_ROWS));
}
