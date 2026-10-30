#!/usr/bin/env node
/**
 * **边界契约**两页的生成/校验器(1.106.6 / D178;公开视图 2026-10-30)。只读 + 可选写 markdown。
 *
 * ```
 * node scripts\contract.js                  # 打印私有全量页
 * node scripts\contract.js --write          # 写到 docs\16-边界契约.md(私有全量,含网页行)
 * node scripts\contract.js --check          # 拿每条锚去真源码里核(不同步/挪走了就非零退出)
 * node scripts\contract.js --json           # 机器可读(全量行)
 *
 * node scripts\contract.js --public                     # 打印公开集视图
 * node scripts\contract.js --public --write             # 写到 docs\16-边界契约-公开版.md
 * node scripts\contract.js --public --check             # 公开树里可跑:只核公开行 + 核页面同步
 * node scripts\contract.js --public --json              # 机器可读(只含公开行)
 * ```
 *
 * 公开视图的来由:12 行契约里有 3 行(`home` / `accounts` / `panel-actions`)的锚点落在
 * noPublish 的网页/面板模块,公开裁剪树里没有那些文件 —— 公开视图不列它们,`--public --check`
 * 也只核**公开集里真的存在**的锚。这不是"放宽判据":私有全量判据(`--check` 不带 `--public`)一字未改。
 *
 * ⚠️ 数据只此一份(`src\boundary-contract.js`);**别手改生成出来的那两页**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_ROWS,
  checkContract,
  checkPublicContract,
  publicContractRows,
  renderContractPage,
  renderPublicContractPage,
} from '../src/boundary-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'docs', '16-边界契约.md');
const PUBLIC_PAGE = path.join(ROOT, 'docs', '16-边界契约-公开版.md');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

const io = { readFile: (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8') };
const isPublic = flag('--public');
const rows = isPublic ? publicContractRows(CONTRACT_ROWS) : CONTRACT_ROWS;
const check = isPublic ? checkPublicContract : checkContract;
const target = isPublic ? PUBLIC_PAGE : PAGE;
const render = isPublic ? renderPublicContractPage : renderContractPage;

/** 页面与渲染结果必须逐字一致(手改生成页 = 红)。返回 null 表示同步。 */
function pageSyncProblem() {
  const writeCommand = isPublic ? 'node scripts\\contract.js --public --write' : 'node scripts\\contract.js --write';
  const expected = render(CONTRACT_ROWS);
  if (!fs.existsSync(target)) return `${path.relative(ROOT, target)} 不存在:请跑 \`${writeCommand}\``;
  const actual = fs.readFileSync(target, 'utf8');
  return actual === expected ? null : `${path.relative(ROOT, target)} 与数据不同步:请跑 \`${writeCommand}\``;
}

if (flag('--json')) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else if (flag('--check')) {
  const { ok, problems } = check(rows, io);
  const syncProblem = pageSyncProblem();
  const allProblems = syncProblem ? [...problems, syncProblem] : problems;
  if (ok && !syncProblem) {
    process.stdout.write(`边界契约${isPublic ? '(公开视图)' : ''}:${rows.length} 条,锚全部命中、页面同步 ✅\n`);
  } else {
    process.stdout.write(`边界契约${isPublic ? '(公开视图)' : ''}:${allProblems.length} 处对不上 ❌\n`);
    for (const problem of allProblems) process.stdout.write(`  · ${problem}\n`);
    process.exitCode = 1;
  }
} else if (flag('--write')) {
  const page = render(CONTRACT_ROWS);
  fs.writeFileSync(target, page, 'utf8');
  const { ok, problems } = check(rows, io);
  process.stdout.write(`已写 ${path.relative(ROOT, target)}(${page.length} 字符, ${rows.length} 条${isPublic ? ',公开视图' : ''})\n`);
  if (!ok) {
    process.stdout.write('⚠️ 但锚没全中:\n');
    for (const problem of problems) process.stdout.write(`  · ${problem}\n`);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(render(CONTRACT_ROWS));
}
