#!/usr/bin/env node
/**
 * 公开集合泄露扫描（节点 A）——只看"将公开"的文件正文，找私有路径/域名/凭据形态。
 *
 * 用法：
 *   node scripts/scan-public-leaks.mjs --manifest scripts/zone-manifest.json [--json]
 *
 * 判据：命中的每条都要人工判定；`--allow <相对路径>` 只放行**文件级**已知安全例外，
 * 且不会因为放行而跳过该文件的其余模式。不是内容审计，不能证明"没有不可公开的内容"；
 * 它只覆盖可机器识别的形态（私有盘符路径、内网域名、真实 AppID/openid、密钥前缀等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildExportPlan } from './export-dry-run.mjs';
import { listTracked } from './zone-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 每条形如 {id, re, why}；正则统一带 g 便于逐行多命中。 */
export const LEAK_PATTERNS = Object.freeze([
  { id: 'windows-private-path', why: '本机私有绝对路径', re: /[A-Za-z]:\\\\?(?:DSH|PersonalDSH|paywatch-build|工作仓库|卡-全年龄)[\\/]/g },
  { id: 'private-domain', why: '私有域名', re: /\b[a-z0-9-]+\.meguming\.top\b/gi },
  { id: 'api-key-prefix', why: '疑似密钥前缀', re: /\b(?:sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g },
  { id: 'jwt-like', why: '疑似 JWT/令牌', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { id: 'private-key-block', why: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'qq-appid-assignment', why: '疑似真实 AppID 赋值', re: /\bQQ_APP_ID\s*=\s*\d{6,}/g },
  { id: 'openid-hex', why: '疑似真实 openid（32 位十六进制）', re: /\b[0-9A-F]{32}\b/g },
  { id: 'internal-ip', why: '内网地址', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
]);

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.cmd', '.ps1', '.py', '.example', '.gitignore', '.gitattributes']);

function isTextCandidate(rel) {
  const base = path.posix.basename(rel);
  if (base.startsWith('.')) return TEXT_EXT.has(path.posix.extname(base)) || base === '.gitignore' || base === '.gitattributes' || base === '.env.example';
  return TEXT_EXT.has(path.posix.extname(rel));
}

/** 允许清单：只放行人工判定为合成的测试字面量，按 (path, id) 精确匹配，不豁免同文件其他模式。 */
function loadAllowlist() {
  const file = path.join(here, 'public-leak-allowlist.json');
  if (!fs.existsSync(file)) return new Map();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const entry of data.entries ?? []) map.set(`${entry.path}\u0000${entry.id}`, entry.reason ?? '');
  return map;
}

/** 纯函数：给定 {路径: 文本} 返回命中列表（便于反证测试）。 */
export function scanTexts(texts, { allow = new Set(), allowlist = new Map() } = {}) {
  const hits = [];
  const allowed = [];
  for (const [rel, text] of Object.entries(texts)) {
    if (allow.has(rel)) continue;
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      for (const { id, why, re } of LEAK_PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (!m) continue;
        const hit = { path: rel, line: i + 1, id, why, match: m[0] };
        const reason = allowlist.get(`${rel}\u0000${id}`);
        if (reason) allowed.push({ ...hit, allowReason: reason });
        else hits.push(hit);
      }
    }
  }
  return { hits, allowed };
}

function parseArgs(argv) {
  const out = { allow: new Set(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') out.manifest = argv[++i];
    else if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--allow') out.allow.add(String(argv[++i]).replaceAll('\\', '/'));
    else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest) {
    console.log('用法: node scripts/scan-public-leaks.mjs --manifest <清单.json> [--repo <根>] [--allow <相对路径>] [--json]');
    return 0;
  }
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(here, '..');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8').replace(/^\uFEFF/, ''));
  const plan = buildExportPlan({ manifest, trackedFiles: listTracked(repo) });
  const texts = {};
  for (const rel of plan.publish) {
    if (!isTextCandidate(rel)) continue;
    texts[rel] = fs.readFileSync(path.join(repo, ...rel.split('/')), 'utf8');
  }
  const { hits, allowed } = scanTexts(texts, { allow: args.allow, allowlist: loadAllowlist() });
  if (args.json) {
    console.log(JSON.stringify({ scanned: Object.keys(texts).length, publish: plan.publish.length, hits, allowed }, null, 2));
    return hits.length ? 1 : 0;
  }
  console.log(`扫描公开候选 ${plan.publish.length} 个文件（文本 ${Object.keys(texts).length} 个），命中 ${hits.length} 条，允许清单放行 ${allowed.length} 条`);
  for (const hit of hits) console.log(`  ${hit.path}:${hit.line}  [${hit.id}] ${hit.why}  ${JSON.stringify(hit.match)}`);
  for (const hit of allowed) console.log(`  (allowed) ${hit.path}:${hit.line} [${hit.id}] ${hit.allowReason}`);
  if (hits.length) console.log('\n每条都要人工判定：可中性化、移出公开集，或作为已知安全例外显式 --allow（放行不豁免该文件其余模式）。');
  return hits.length ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = main();
