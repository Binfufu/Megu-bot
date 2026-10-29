#!/usr/bin/env node
/**
 * 公开导出预演（v0）——不复制文件，只回答"如果现在公开，会出去什么"。
 *
 * 判据（docs/35 §八）：公开 v0 = 程序（P 区）里未标 noPublish 的文件；
 *   · D 区（数据/内部记录）一律不出去；
 *   · C 区（内容/素材）默认不出去，官方内容另走内容包；
 *   · noPublish=true 不出去（网页面板/官方 UI/实例/待重写文档）。
 *
 * 用法：
 *   node scripts/export-dry-run.mjs --manifest scripts/zone-manifest.json [--verbose] [--json] [--strict]
 * --json 输出完整机器计划；默认仅 safety 红，--strict 加 debt/missing/无归属/非法路径红。
 * buildExportPlan({ manifest, trackedFiles }) 供导出器复用，不做内容扫描或内容变换。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildResolver, listTracked, validateManifest } from './zone-check.mjs';

/** 硬安全闸：出现在"将公开"里直接红（字面从严，只放行两个已知安全名）。 */
const SAFETY = [/\.env/i, /secret/i, /credential/i, /(^|\/)data\//i, /\.pem$/i, /(^|\/)id_rsa/i];
/** 仅名字例外，严格两条；绝不证明内容安全，也不豁免 contentDebt 或后续内容扫描。 */
const SAFETY_ALLOW = new Set(['.env.example', 'src/secret-box.js']);

/** 公开 v0 必带文件（缺了不算泄漏，但算"还不能发"）。 */
const REQUIRED_PUBLIC = ['package.json', 'LICENSE', 'NOTICE', '.env.example', 'CHANGELOG.md', '.gitignore', '.gitattributes', 'README.md'];

/** 跨平台保守的正规仓库相对文件名；不规范化危险输入后再放行。 */
export function exportPathProblem(p) {
  if (typeof p !== 'string' || p === '') return '路径必须是非空字符串';
  if (/[\\\x00-\x1f\x7f<>:"|?*]/u.test(p) || path.posix.isAbsolute(p)) return '非法/绝对路径';
  const parts = p.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '空段或点段/越界路径';
  if (parts.some((part) => /[. ]$/.test(part) || /^\.git$/i.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return 'Git 元数据或不安全的平台路径';
  return null;
}

/**
 * 纯计划：无文件系统/Git/内容读取，不修改输入；唯一归属来自既有 manifest resolver。
 * trackedFiles 必须是 listTracked(repo) 的完整结果；不递归捞取未跟踪文件。
 * noPublish 只排除，不因自身或被排除文件的 debt/敏感名字而阻断。
 */
export function buildExportPlan({ manifest, trackedFiles }) {
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`清单非法：${errors.join('; ')}`);
  if (!Array.isArray(trackedFiles)) throw new Error('trackedFiles 必须是数组');
  const resolve = buildResolver(manifest);
  const plan = { schemaVersion: 1, total: trackedFiles.length, publish: [], debt: [], excluded: [], safety: [], missing: [], unowned: [], invalidPaths: [] };
  const seen = new Set();
  for (const p of trackedFiles) {
    const problem = exportPathProblem(p);
    const key = typeof p === 'string' ? p.normalize('NFC').toLowerCase() : p;
    if (problem || seen.has(key)) {
      plan.invalidPaths.push({ path: p, reason: problem || '重复/大小写或 Unicode 规范化冲突路径' });
      continue;
    }
    seen.add(key);
    const hit = resolve(p);
    if (!hit) {
      plan.unowned.push(p);
      plan.excluded.push({ path: p, reason: '无归属（清单缺口）' });
      continue;
    }
    if (hit.zone !== 'P' || hit.noPublish === true) {
      let reason = 'D 区（数据/内部记录）';
      if (hit.zone === 'C') reason = 'C 区（内容/素材，默认不公开）';
      else if (hit.zone === 'P' && hit.noPublish === true) reason = 'noPublish（官方/网页/待重写）';
      plan.excluded.push({ path: p, reason });
      continue;
    }
    if (SAFETY.some((re) => re.test(p)) && !SAFETY_ALLOW.has(p)) {
      plan.safety.push(p);
      continue;
    }
    plan.publish.push(p);
    if (hit.contentDebt === true) plan.debt.push(p);
  }
  const publishSet = new Set(plan.publish);
  plan.missing = REQUIRED_PUBLIC.filter((p) => !publishSet.has(p));
  return plan;
}

/** 默认维持 v0 退出码；strict 是可发布性闸门，不是内容审计。 */
export function exportPlanExitCode(plan, strict = false) {
  return plan.safety.length || (strict && (plan.debt.length || plan.missing.length
    || plan.unowned.length || plan.invalidPaths.length)) ? 1 : 0;
}

function parseArgs(argv) {
  const out = { verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest) {
    console.log('用法: node scripts/export-dry-run.mjs --manifest <清单.json> [--repo <仓库根>] [--verbose] [--json] [--strict]');
    return 0;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(here, '..');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8').replace(/^\uFEFF/, ''));
  const files = listTracked(repo);
  const plan = buildExportPlan({ manifest, trackedFiles: files });
  if (args.json) {
    console.log(JSON.stringify({ repo, ...plan }, null, 2));
    return exportPlanExitCode(plan, args.strict);
  }
  const { publish, debt, excluded, safety: safetyHits, missing } = plan;
  const reasons = new Map();
  for (const e of excluded) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);

  console.log(JSON.stringify({
    repo,
    total: files.length,
    publish: publish.length,
    debt: debt.length,
    excluded: excluded.length,
    safetyHits: safetyHits.length,
    missingRequired: missing,
  }));

  console.log('\n== 将公开 ==');
  for (const p of (args.verbose ? publish : publish.slice(0, 80))) console.log(p);
  if (!args.verbose && publish.length > 80) console.log(`...（其余 ${publish.length - 80} 条加 --verbose）`);

  console.log('\n== 公开前必须外提/中性化的债务 ==');
  for (const p of (args.verbose ? debt : debt.slice(0, 60))) console.log(p);
  if (!args.verbose && debt.length > 60) console.log(`...（其余 ${debt.length - 60} 条加 --verbose）`);

  console.log('\n== 已排除（按原因） ==');
  for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${reason}`);
  if (args.verbose) for (const e of excluded) console.log(`  - ${e.path}  [${e.reason}]`);

  if (missing.length) console.log(`\n⚠️ 必带但未公开: ${missing.join(', ')}（README 待重写属已知债务）`);
  if (safetyHits.length) {
    console.error(`\n✗ 安全闸命中 ${safetyHits.length} 条（.env/secret/credential/data）:`);
    for (const p of safetyHits) console.error(`  ${p}`);
  }
  if (args.strict && plan.unowned.length) console.error(`\n✗ 无归属: ${plan.unowned.join(', ')}`);
  if (args.strict && plan.invalidPaths.length) console.error(`\n✗ 非法路径: ${JSON.stringify(plan.invalidPaths)}`);
  return exportPlanExitCode(plan, args.strict);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = main();
