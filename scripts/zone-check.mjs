#!/usr/bin/env node
// ============================================================================
// zone-check.mjs · 三区校验器（P 程序 / C 内容 / D 数据）
//
// 依据：docs/35-多bot世界与开源路线-2026-10-29.md
//   §八 8.1 三区：P 程序（内核/适配器/基础网页/规则执行器/测试/运行工具）、
//          C 内容（角色包/世界包/规则包/主题包/知识包/示例配置）、
//          D 数据（记忆/存档/账号/日志/备份/密钥/内部记录）。
//          区是"种类"不是"公开/私有"；依赖必须单向 D → C → P，程序不得 import 具体角色/世界。
//   §九 路线图第 0 步：分区清单 + 校验器 + 导出 dry-run；越界 import 能红。
//
// 零第三方依赖：只用 node: 内置模块（node:fs / node:path / node:os / node:child_process）。
// glob 是自写子集（见 matchGlob / globToRegExp，约 40 行，零依赖）：
//   只支持 **（跨路径段，必须独占一段，如 src/**、**/x.js）
//         * （单段内任意字符，不跨 /）；
//   不支持 ? [ ] { } 与反斜杠转义；不引入任何 glob 库。
//   规则按声明顺序首条命中，overrides 按精确路径优先。
//
// 三个子命令：
//   --manifest <path>                校验清单（git ls-files 每个跟踪文件恰好唯一归属）
//   --compile <盘点目录> --out <json> 从盘点 md 表格聚合清单
//   --selftest                       在 os.tmpdir() 造迷你 fixture 自测（不依赖 git）
// 用法与退出码见 --help。
//
// 兼容：本文件同时导出 buildResolver / listTracked / globToRe / validateManifest / ZONES，
// 供 scripts/export-dry-run.mjs 这类只读消费方 import；被 import 时不执行 CLI。
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ZONES = Object.freeze(['P', 'C', 'D']);
const ZONE_SET = new Set(ZONES);
// 本机文件系统大小写不敏感时，导入目标回查跟踪表用小写键；归属匹配仍按清单原样（保守）。
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const MANIFEST_KEYS = new Set(['schemaVersion', 'rules', 'overrides', 'comment']);
const RULE_KEYS = new Set(['zone', 'match', 'note']);
const OVERRIDE_KEYS = new Set(['path', 'zone', 'contentDebt', 'noPublish', 'note']);
const USAGE_EXIT = 2;

// ---------------------------------------------------------------------------
// 路径小工具
// ---------------------------------------------------------------------------

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function keyOfPath(relPath) {
  return CASE_INSENSITIVE_FS ? relPath.toLowerCase() : relPath;
}

// 清单里的路径一律：仓库相对、正斜杠、无 ./、无 ..、不以 / 结尾。
function normalizeManifestPath(raw) {
  if (typeof raw !== 'string') throw new Error('路径必须是字符串');
  let value = raw.trim().replace(/\\/g, '/');
  if (value === '') throw new Error('路径不能为空');
  while (value.startsWith('./')) value = value.slice(2);
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) throw new Error(`不能是绝对路径：${raw}`);
  if (value.endsWith('/')) throw new Error(`不能以 / 结尾：${raw}`);
  const segments = value.split('/');
  if (segments.includes('')) throw new Error(`不能包含空路径段：${raw}`);
  if (segments.includes('.') || segments.includes('..')) throw new Error(`不能包含 . 或 .. 路径段：${raw}`);
  return value;
}

// ---------------------------------------------------------------------------
// 自写 glob matcher（约 40 行，零依赖）
// 只支持 **（跨段，独占一段）与 *（单段内）；其它字符按字面量。
// ---------------------------------------------------------------------------

const globCache = new Map();

function segToRegex(segment) {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if ('\\^$.*+?()[]{}|'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern === '') throw new Error('glob 不能为空');
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) throw new Error(`glob 不能是绝对路径：${pattern}`);
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const segments = pattern.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`glob 路径段非法：${pattern}`);
  }
  let source = '^';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    if (segment.includes('**')) throw new Error(`** 必须独占一个路径段：${pattern}`);
    source += segToRegex(segment);
    if (!last) source += '/';
  }
  const regexp = new RegExp(`${source}$`);
  globCache.set(pattern, regexp);
  return regexp;
}

function matchGlob(pattern, relPath) {
  return globToRegExp(pattern).test(relPath);
}

// 兼容导出（旧消费方用这个名字）。
export function globToRe(pattern) {
  return globToRegExp(pattern);
}

// ---------------------------------------------------------------------------
// 清单 schema 校验
// 归属语义：overrides 精确路径优先；rules 按声明顺序首条命中；
// "恰好归属一次" = 每个跟踪文件的唯一归属可解析（重复 override 路径算歧义错误）。
// 顶层可选 comment 仅作备注，不参与校验（兼容既有清单）。
// ---------------------------------------------------------------------------

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['清单必须是 JSON 对象'];
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) errors.push(`未知顶层字段：${key}`);
  }
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion 必须是数字 1');
  if (manifest.comment !== undefined && typeof manifest.comment !== 'string') errors.push('comment 必须是字符串');
  if (!Array.isArray(manifest.rules)) {
    errors.push('rules 必须是数组（可为空）');
  } else {
    manifest.rules.forEach((rule, i) => {
      const at = `rules[${i}]`;
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        errors.push(`${at} 必须是对象`);
        return;
      }
      for (const key of Object.keys(rule)) {
        if (!RULE_KEYS.has(key)) errors.push(`${at} 未知字段：${key}`);
      }
      if (!ZONE_SET.has(rule.zone)) errors.push(`${at}.zone 必须是 P/C/D 之一`);
      if (!Array.isArray(rule.match) || rule.match.length === 0) {
        errors.push(`${at}.match 必须是非空字符串数组`);
      } else {
        rule.match.forEach((pattern, j) => {
          if (typeof pattern !== 'string' || pattern.trim() === '') {
            errors.push(`${at}.match[${j}] 必须是非空字符串`);
            return;
          }
          try {
            globToRegExp(pattern);
          } catch (err) {
            errors.push(`${at}.match[${j}] ${err.message}`);
          }
        });
      }
      if (rule.note !== undefined && typeof rule.note !== 'string') errors.push(`${at}.note 必须是字符串`);
    });
  }

  const overrides = manifest.overrides === undefined ? [] : manifest.overrides;
  if (!Array.isArray(overrides)) {
    errors.push('overrides 必须是数组');
  } else {
    const seen = new Set();
    overrides.forEach((entry, i) => {
      const at = `overrides[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${at} 必须是对象`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!OVERRIDE_KEYS.has(key)) errors.push(`${at} 未知字段：${key}`);
      }
      if (!ZONE_SET.has(entry.zone)) errors.push(`${at}.zone 必须是 P/C/D 之一`);
      if (typeof entry.path !== 'string') {
        errors.push(`${at}.path 必须是字符串`);
      } else {
        try {
          const normalized = normalizeManifestPath(entry.path);
          if (seen.has(normalized)) errors.push(`${at}.path 重复（同一路径只能归属一次）：${normalized}`);
          seen.add(normalized);
        } catch (err) {
          errors.push(`${at}.path ${err.message}`);
        }
      }
      for (const flag of ['contentDebt', 'noPublish']) {
        if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
          errors.push(`${at}.${flag} 必须是布尔值`);
        }
      }
      if (entry.note !== undefined && typeof entry.note !== 'string') errors.push(`${at}.note 必须是字符串`);
    });
  }
  return errors;
}

function buildZoneIndex(manifest) {
  const overrides = new Map();
  for (const entry of manifest.overrides ?? []) {
    overrides.set(normalizeManifestPath(entry.path), entry);
  }
  const rules = manifest.rules.map((rule) => ({
    zone: rule.zone,
    note: rule.note ?? '',
    regexps: rule.match.map((pattern) => globToRegExp(pattern)),
  }));
  return {
    resolve(relPath) {
      const override = overrides.get(relPath);
      if (override) return { zone: override.zone, via: 'override', entry: override };
      for (const rule of rules) {
        if (rule.regexps.some((regexp) => regexp.test(relPath))) {
          return { zone: rule.zone, via: 'rule', entry: rule };
        }
      }
      return null;
    },
  };
}

// 兼容导出：返回 p => hit（hit 含 zone，override 命中时展开 contentDebt/noPublish）。
export function buildResolver(manifest) {
  const index = buildZoneIndex(manifest);
  return function resolve(relPath) {
    const hit = index.resolve(relPath);
    if (!hit) return null;
    if (hit.via === 'override') return { ...hit.entry, how: 'override' };
    return { zone: hit.zone, how: 'rule' };
  };
}

// ---------------------------------------------------------------------------
// git 与清单读取
// ---------------------------------------------------------------------------

// ⚠️ 2026-10-29 实伤：调用者环境若带 GIT_DIR/GIT_WORK_TREE，子进程 Git 会指向另一个仓库，
//    清单/导出会读到错误跟踪集合。这里只认 cwd，剥掉 Git 拓扑类环境变量。
const GIT_TOPOLOGY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];
function gitEnv() {
  const env = { ...process.env };
  for (const key of GIT_TOPOLOGY_ENV) delete env[key];
  return env;
}

function findRepoRoot(cwd) {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv() });
  if (run.error) throw new Error(`git 不可用：${run.error.message}`);
  if (run.status !== 0) throw new Error(`当前目录不在 git 仓库内（${cwd}）：${(run.stderr || '').trim()}`);
  return path.resolve(run.stdout.trim());
}

function listTrackedFiles(repoRoot) {
  const run = spawnSync('git', ['ls-files', '-z', '--cached'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: gitEnv(),
  });
  if (run.error) throw new Error(`git ls-files 失败：${run.error.message}`);
  if (run.status !== 0) throw new Error(`git ls-files 失败：${(run.stderr || '').trim()}`);
  return (run.stdout || '').split('\0').filter(Boolean).map(toPosix);
}

// 兼容导出：旧消费方按 (repo) 调用，拿正斜杠相对路径数组。
export function listTracked(repo = process.cwd()) {
  return listTrackedFiles(path.resolve(repo));
}

function loadManifestFile(manifestPath) {
  let text;
  try {
    // Windows 记事本可能写 UTF-8 BOM，先剥掉再 JSON.parse。
    text = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    throw new Error(`无法读取清单 ${manifestPath}：${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`清单 JSON 解析失败 ${manifestPath}：${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 静态 import 扫描（文本级近似，不做 AST）
// 去掉行注释/块注释后，只认两种指定形态，且只保留 ./ ../ 相对引用：
//   … from <模块说明符>        （import / export 皆算，它们都是静态依赖）
//   import(<模块说明符>)
// 说明：注释里的伪 import 会被剥掉；字符串里的 "from <模块说明符>" 无法区分（零依赖取舍）。
// ---------------------------------------------------------------------------

function stripJsComments(text) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      out += '  ';
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
      out += '  ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i++;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findImportSpecs(source) {
  const text = stripJsComments(source);
  const specs = [];
  // 行首的 import/export 语句；[^;] 允许 from 换行书写（多行 import { … } from <模块说明符>）。
  const staticRe = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
  const dynamicRe = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  let match;
  while ((match = staticRe.exec(text)) !== null) {
    const value = match[2];
    if (value.startsWith('./') || value.startsWith('../')) {
      specs.push({ value, line: lineOf(text, match.index) });
    }
  }
  while ((match = dynamicRe.exec(text)) !== null) {
    const value = match[2];
    if (value.startsWith('./') || value.startsWith('../')) {
      specs.push({ value, line: lineOf(text, match.index) });
    }
  }
  specs.sort((a, b) => a.line - b.line || a.value.localeCompare(b.value, 'en'));
  return specs;
}

// 把相对引用解析成仓内具体文件；解析不到返回 rel: null（由调用方记为"未判定"）。
function resolveImportTarget(repoRoot, fromRel, spec, trackedKeys) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) return { outside: true };
  if (target === '.') return { rel: null };
  const candidates = [
    target,
    `${target}.js`,
    `${target}.mjs`,
    `${target}.cjs`,
    `${target}/index.js`,
    `${target}/index.mjs`,
  ];
  for (const candidate of candidates) {
    const absolute = path.join(repoRoot, ...candidate.split('/'));
    let stat = null;
    try {
      stat = fs.statSync(absolute);
    } catch {
      stat = null;
    }
    if (stat && stat.isFile()) {
      return { rel: trackedKeys.get(keyOfPath(candidate)) || candidate };
    }
  }
  return { rel: null };
}

// ---------------------------------------------------------------------------
// 校验主流程（repoRoot / 清单 / 跟踪文件清单都可注入，selftest 因此不依赖 git）
// ---------------------------------------------------------------------------

function runCheck({ repoRoot, manifest, trackedFiles, manifestPath = '(内存清单)' }) {
  const result = {
    ok: false,
    manifestPath,
    repoRoot,
    errors: [],
    warnings: [],
    violations: [],
    unowned: [],
    stats: {
      tracked: 0,
      p: 0,
      c: 0,
      d: 0,
      contentDebt: 0,
      noPublish: 0,
      scannedFiles: 0,
      insideImports: 0,
      unresolved: 0,
    },
  };
  result.errors.push(...validateManifest(manifest));
  if (result.errors.length) return result;

  const index = buildZoneIndex(manifest);
  const tracked = [...new Set(trackedFiles.map(toPosix))].sort((a, b) => a.localeCompare(b, 'en'));
  result.stats.tracked = tracked.length;
  const trackedKeys = new Map();
  for (const file of tracked) trackedKeys.set(keyOfPath(file), file);

  const assignments = new Map();
  const overrideHits = new Set();
  for (const file of tracked) {
    const hit = index.resolve(file);
    if (!hit) {
      result.unowned.push(file);
      continue;
    }
    assignments.set(file, hit);
    if (hit.zone === 'P') result.stats.p++;
    else if (hit.zone === 'C') result.stats.c++;
    else result.stats.d++;
    if (hit.via === 'override') {
      overrideHits.add(hit.entry.path);
      if (hit.entry.contentDebt === true) result.stats.contentDebt++;
      if (hit.entry.noPublish === true) result.stats.noPublish++;
    }
  }
  for (const override of manifest.overrides ?? []) {
    if (!overrideHits.has(override.path)) {
      result.warnings.push(`override 未命中跟踪文件：${override.path}`);
    }
  }

  // P 区静态 import：落在仓内且归 C/D 即越界，逐条打印。
  for (const file of tracked) {
    const hit = assignments.get(file);
    if (!hit || hit.zone !== 'P') continue;
    if (!JS_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) continue;
    let source;
    try {
      source = fs.readFileSync(path.join(repoRoot, ...file.split('/')), 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      result.warnings.push(`P 区文件读取失败，跳过：${file}（${err.code || err.message}）`);
      continue;
    }
    result.stats.scannedFiles++;
    for (const spec of findImportSpecs(source)) {
      const resolved = resolveImportTarget(repoRoot, file, spec.value, trackedKeys);
      if (resolved.outside) continue;
      result.stats.insideImports++;
      if (!resolved.rel) {
        result.stats.unresolved++;
        result.warnings.push(`${file}:${spec.line} 相对引用 ${spec.value} 在仓内无法解析为具体文件，未判定`);
        continue;
      }
      const target = index.resolve(resolved.rel);
      if (!target) {
        result.stats.unresolved++;
        result.warnings.push(`${file}:${spec.line} 相对引用 ${spec.value} → ${resolved.rel} 未归属任何区，未判定`);
        continue;
      }
      if (target.zone !== 'P') {
        result.violations.push({ file, line: spec.line, spec: spec.value, target: resolved.rel, targetZone: target.zone });
      }
    }
  }

  result.ok = result.errors.length === 0 && result.violations.length === 0 && result.unowned.length === 0;
  return result;
}

function printCheckReport(result) {
  const s = result.stats;
  console.log(`[zone-check] 清单：${result.manifestPath}`);
  console.log(`[zone-check] 仓库：${result.repoRoot}`);
  for (const error of result.errors) console.error(`[错误] ${error}`);
  if (result.errors.length === 0) {
    console.log(`[zone-check] 跟踪文件 ${s.tracked} 个：P=${s.p} C=${s.c} D=${s.d}`);
    console.log(`[zone-check] contentDebt=${s.contentDebt} 个文件；noPublish=${s.noPublish} 个文件`);
    console.log(`[zone-check] P 区 import 扫描：${s.scannedFiles} 个文件，仓内相对引用 ${s.insideImports} 条，未判定 ${s.unresolved} 条`);
  } else {
    console.error('[zone-check] schema 未通过，跳过归属与 import 统计');
  }
  for (const file of result.unowned) console.error(`[无归属] ${file}`);
  for (const item of result.violations) {
    console.error(`[越界] ${item.file}:${item.line}  ${item.spec} → ${item.target}（${item.targetZone} 区）；P 区只能 import 仓内 P 区`);
  }
  for (const warning of result.warnings) console.warn(`[警告] ${warning}`);
  if (!result.ok && result.unowned.length) {
    console.error(`[zone-check] 无归属跟踪文件 ${result.unowned.length} 个；清单必须覆盖每个跟踪文件`);
  }
  const verdict = result.ok ? '通过' : '失败';
  console.log(
    `[zone-check] 结果：${verdict}（越界 ${result.violations.length}，无归属 ${result.unowned.length}，错误 ${result.errors.length}，未判定 ${s.unresolved}）`,
  );
}

// ---------------------------------------------------------------------------
// --compile：读盘点 md 表格，聚合为清单
// 表头固定 | 路径 | zone | contentDebt | noPublish | 依据 |，布尔只认 yes/no。
// 聚合：整棵同区子树 → 一条 "目录/**" 规则（父子目录不重复出规则）；
//       混区目录、根目录文件、带 contentDebt/noPublish 的行 → 逐文件 overrides。
// ---------------------------------------------------------------------------

function parseYesNo(raw) {
  const value = raw.trim().toLowerCase();
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

function splitTableRow(line) {
  const placeholder = '\u0000';
  let text = line.trim().replace(/\\\|/g, placeholder);
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.replaceAll(placeholder, '|').trim());
}

function isInventoryHeader(cells) {
  if (cells.length !== 5) return false;
  return (
    cells[0] === '路径'
    && cells[1].toLowerCase() === 'zone'
    && cells[2].toLowerCase() === 'contentdebt'
    && cells[3].toLowerCase() === 'nopublish'
    && cells[4].replaceAll('`', '').startsWith('依据')
  );
}

function isSeparatorRow(cells) {
  return cells.length >= 3 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseInventoryMarkdown(text, sourceFile) {
  const rows = [];
  const problems = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = splitTableRow(line);
    if (isInventoryHeader(cells)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (isSeparatorRow(cells)) continue;
    const at = `${sourceFile}:${i + 1}`;
    if (cells.length < 4 || cells.length > 5) {
      problems.push(`${at} 列数应为 5（路径/zone/contentDebt/noPublish/依据），实际 ${cells.length}`);
      continue;
    }
    const [rawPath, rawZone, rawDebt, rawPublish, rawNote = ''] = cells;
    const zone = rawZone.toUpperCase();
    if (!ZONE_SET.has(zone)) {
      problems.push(`${at} zone 只能是 P/C/D，实际 ${rawZone}`);
      continue;
    }
    const contentDebt = parseYesNo(rawDebt);
    if (contentDebt === null) {
      problems.push(`${at} contentDebt 只能是 yes/no，实际 ${rawDebt}`);
      continue;
    }
    const noPublish = parseYesNo(rawPublish);
    if (noPublish === null) {
      problems.push(`${at} noPublish 只能是 yes/no，实际 ${rawPublish}`);
      continue;
    }
    let filePath;
    try {
      filePath = normalizeManifestPath(rawPath.replaceAll('`', ''));
    } catch (err) {
      problems.push(`${at} 路径 ${err.message}`);
      continue;
    }
    rows.push({ path: filePath, zone, contentDebt, noPublish, note: rawNote, file: sourceFile, source: at });
  }
  return { rows, problems };
}

function compileInventory({ dir, out }) {
  const absoluteDir = path.resolve(dir);
  if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) {
    throw new Error(`盘点目录不存在：${absoluteDir}`);
  }
  const mdFiles = fs
    .readdirSync(absoluteDir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (mdFiles.length === 0) throw new Error(`盘点目录下没有 *.md：${absoluteDir}`);
  const allRows = [];
  for (const name of mdFiles) {
    const parsed = parseInventoryMarkdown(fs.readFileSync(path.join(absoluteDir, name), 'utf8'), name);
    if (parsed.problems.length) throw new Error(`盘点表格有问题：\n${parsed.problems.join('\n')}`);
    allRows.push(...parsed.rows);
  }
  if (allRows.length === 0) throw new Error('盘点表格里没有读到数据行（表头需为 | 路径 | zone | contentDebt | noPublish | 依据 |）');

  // 同一路径多次出现：值一致则去重；不一致直接失败，避免聚合歧义。
  const byPath = new Map();
  for (const row of allRows) {
    const prev = byPath.get(row.path);
    if (!prev) {
      byPath.set(row.path, row);
      continue;
    }
    if (prev.zone !== row.zone || prev.contentDebt !== row.contentDebt || prev.noPublish !== row.noPublish) {
      throw new Error(`同一路径盘点冲突：${row.path}（${prev.source} 与 ${row.source}）`);
    }
  }
  const rows = [...byPath.values()];

  // 目录聚合取"最大的全部同区子树"：整棵子树同区就出一条 目录/** 规则，
  // 父子目录不重复出规则；混区目录与根目录文件逐文件 overrides。
  const dirZones = new Map();
  const allDirs = new Set();
  for (const row of rows) {
    let current = path.posix.dirname(row.path);
    while (current !== '.') {
      allDirs.add(current);
      current = path.posix.dirname(current);
    }
  }
  for (const dir of allDirs) {
    const prefix = `${dir}/`;
    dirZones.set(dir, new Set(rows.filter((row) => row.path.startsWith(prefix)).map((row) => row.zone)));
  }
  const ruleDirs = [...allDirs]
    .filter((dir) => dirZones.get(dir).size === 1)
    .filter((dir) => {
      const parent = path.posix.dirname(dir);
      return parent === '.' || dirZones.get(parent)?.size !== 1;
    })
    .sort((a, b) => a.localeCompare(b, 'en'));

  const rules = ruleDirs.map((dir) => {
    const zone = [...dirZones.get(dir)][0];
    const first = rows.find((row) => row.path.startsWith(`${dir}/`));
    return { zone, match: [`${dir}/**`], note: `由 ${first.file} 盘点聚合：${dir}/ 全部为 ${zone} 区` };
  });
  const ruleDirSet = new Set(ruleDirs);
  const overrides = [];
  for (const row of rows) {
    let covering = null;
    let current = path.posix.dirname(row.path);
    while (current !== '.') {
      if (ruleDirSet.has(current)) {
        covering = current;
        break;
      }
      current = path.posix.dirname(current);
    }
    if (covering && !row.contentDebt && !row.noPublish) continue;
    const dirName = path.posix.dirname(row.path);
    let reason;
    if (covering) reason = `${row.source} 盘点特性标记（contentDebt/noPublish）`;
    else if (dirName === '.') reason = `${row.source} 盘点（根目录文件不生成目录规则）`;
    else reason = `${row.source} 盘点（${dirName}/ 同目录混区，逐文件）`;
    overrides.push({
      path: row.path,
      zone: row.zone,
      contentDebt: row.contentDebt,
      noPublish: row.noPublish,
      note: reason,
    });
  }
  rules.sort((a, b) => a.match[0].localeCompare(b.match[0], 'en'));
  overrides.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = { schemaVersion: 1, rules, overrides };

  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`聚合结果未通过 schema 校验：\n${errors.join('\n')}`);

  // 覆盖自检：每个盘点行都必须解析回同一 zone 与标记。
  const index = buildZoneIndex(manifest);
  for (const row of rows) {
    const hit = index.resolve(row.path);
    const flagsOk = (!row.contentDebt || hit?.entry.contentDebt === true) && (!row.noPublish || hit?.entry.noPublish === true);
    if (!hit || hit.zone !== row.zone || !flagsOk) {
      throw new Error(`聚合结果覆盖自检失败：${row.path}（期望 ${row.zone}，实际 ${hit?.zone ?? '无归属'}）`);
    }
  }

  const absoluteOut = path.resolve(out);
  fs.mkdirSync(path.dirname(absoluteOut), { recursive: true });
  fs.writeFileSync(absoluteOut, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, rows, mdFiles, out: absoluteOut, dir: absoluteDir };
}

function printCompileReport({ dir, mdFiles, manifest, rows, out }) {
  const zones = { P: 0, C: 0, D: 0 };
  for (const row of rows) zones[row.zone]++;
  console.log(`[zone-check] 盘点：${dir}（${mdFiles.length} 个 md）`);
  console.log(`[zone-check] 文件级盘点 ${rows.length} 条：P=${zones.P} C=${zones.C} D=${zones.D}`);
  console.log(`[zone-check] 聚合规则 ${manifest.rules.length} 条；overrides ${manifest.overrides.length} 条`);
  console.log(`[zone-check] 写出：${out}`);
}

// ---------------------------------------------------------------------------
// --selftest：tmpdir 迷你 fixture，注入假跟踪文件清单（不依赖 git）
// 断言：合法绿 / 无归属红 / P→D 越界红 / P→P 绿 / compile 产出 JSON / glob 子集
// ---------------------------------------------------------------------------

function writeFixture(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
}

function runSelftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-check-selftest-'));
  const failures = [];
  let total = 0;
  const assert = (name, condition, detail = '') => {
    total++;
    if (condition) {
      console.log(`✔ ${name}`);
      return;
    }
    failures.push(name);
    console.log(`✘ ${name}${detail ? `：${detail}` : ''}`);
  };
  console.log(`[zone-check] selftest fixture：${root}`);

  try {
    // 1) 合法绿：全部跟踪文件唯一归属，P 只 import P，contentDebt 计数正确。
    const greenRoot = path.join(root, 'green');
    const greenFiles = {
      'src/a.js': "import { b } from './b.js';\nexport const a = b;\n",
      'src/b.js': 'export const b = 1;\n',
      'content/char.js': 'export const char = {};\n',
      'data/mem.js': 'export const mem = [];\n',
      'docs/readme.md': '# 样例\n',
    };
    writeFixture(greenRoot, greenFiles);
    const greenManifest = {
      schemaVersion: 1,
      rules: [
        { zone: 'P', match: ['src/**'], note: '程序' },
        { zone: 'C', match: ['content/**'], note: '内容' },
        { zone: 'D', match: ['data/**'], note: '数据' },
        { zone: 'C', match: ['docs/**'], note: '文档' },
      ],
      overrides: [{ path: 'docs/readme.md', zone: 'C', contentDebt: true, noPublish: false, note: '示例' }],
    };
    const green = runCheck({
      repoRoot: greenRoot,
      manifest: greenManifest,
      trackedFiles: Object.keys(greenFiles),
      manifestPath: '(selftest/green)',
    });
    assert(
      '合法绿',
      green.ok && green.unowned.length === 0 && green.violations.length === 0 && green.stats.contentDebt === 1,
      `ok=${green.ok} 越界=${green.violations.length} 无归属=${green.unowned.length} contentDebt=${green.stats.contentDebt}`,
    );

    // 2) 无归属红：extra/note.txt 不在任何规则里。
    const unownedRoot = path.join(root, 'unowned');
    writeFixture(unownedRoot, { 'src/a.js': 'export const a = 1;\n', 'extra/note.txt': 'x\n' });
    const unowned = runCheck({
      repoRoot: unownedRoot,
      manifest: { schemaVersion: 1, rules: [{ zone: 'P', match: ['src/**'], note: '程序' }] },
      trackedFiles: ['src/a.js', 'extra/note.txt'],
      manifestPath: '(selftest/unowned)',
    });
    assert(
      '无归属红',
      !unowned.ok && unowned.unowned.includes('extra/note.txt'),
      `ok=${unowned.ok} 无归属=${JSON.stringify(unowned.unowned)}`,
    );

    // 3) P→D 越界红：src/bad.js 静态 import ../data/mem.js。
    const crossRoot = path.join(root, 'cross');
    writeFixture(crossRoot, {
      'src/bad.js': "import { mem } from '../data/mem.js';\n",
      'data/mem.js': 'export const mem = [];\n',
    });
    const cross = runCheck({
      repoRoot: crossRoot,
      manifest: {
        schemaVersion: 1,
        rules: [
          { zone: 'P', match: ['src/**'], note: '程序' },
          { zone: 'D', match: ['data/**'], note: '数据' },
        ],
      },
      trackedFiles: ['src/bad.js', 'data/mem.js'],
      manifestPath: '(selftest/cross)',
    });
    assert(
      'P→D越界红',
      !cross.ok
        && cross.violations.length === 1
        && cross.violations[0].target === 'data/mem.js'
        && cross.violations[0].targetZone === 'D',
      `ok=${cross.ok} 越界=${JSON.stringify(cross.violations)}`,
    );

    // 4) P→P 绿：扩展名省略 './b'、嵌套相对路径 './lib/c.js' 都归 P。
    const p2pRoot = path.join(root, 'p2p');
    writeFixture(p2pRoot, {
      'src/a.js': "import { b } from './b';\nimport { c } from './lib/c.js';\nexport const a = b + c;\n",
      'src/b.js': 'export const b = 1;\n',
      'src/lib/c.js': 'export const c = 2;\n',
    });
    const p2p = runCheck({
      repoRoot: p2pRoot,
      manifest: { schemaVersion: 1, rules: [{ zone: 'P', match: ['src/**'], note: '程序' }] },
      trackedFiles: ['src/a.js', 'src/b.js', 'src/lib/c.js'],
      manifestPath: '(selftest/p2p)',
    });
    assert(
      'P→P绿',
      p2p.ok && p2p.violations.length === 0 && p2p.stats.insideImports === 2,
      `ok=${p2p.ok} 仓内引用=${p2p.stats.insideImports} 越界=${p2p.violations.length}`,
    );

    // 5) compile：同区子树 → 规则；混区/根目录/带标记 → overrides；产物能通过校验。
    const compileRoot = path.join(root, 'compile');
    const inventoryDir = path.join(compileRoot, 'inventory');
    fs.mkdirSync(inventoryDir, { recursive: true });
    const sampleMd = [
      '# 盘点样例',
      '',
      '| 路径 | zone | contentDebt | noPublish | 依据 |',
      '|---|---|---|---|---|',
      '| `src/app.js` | P | no | no | 内核 |',
      '| `src/lib/tool.js` | P | no | no | 内核 |',
      '| `content/hero/a.js` | C | no | no | 角色包 |',
      '| `content/hero/b.js` | C | yes | no | 角色包 |',
      '| `mix/x.js` | P | no | no | 混区 |',
      '| `mix/y.js` | D | no | yes | 混区 |',
      '| `README.md` | C | no | no | 根文档 |',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(inventoryDir, 'sample.md'), sampleMd, 'utf8');
    const outFile = path.join(compileRoot, 'zone.json');
    compileInventory({ dir: inventoryDir, out: outFile });
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const rulePairs = written.rules.map((rule) => `${rule.zone} ${rule.match.join(',')}`).sort();
    const overridePairs = written.overrides
      .map((entry) => `${entry.path} ${entry.zone} ${entry.contentDebt ? 'yes' : 'no'} ${entry.noPublish ? 'yes' : 'no'}`)
      .sort();
    const expectedRules = ['C content/**', 'P src/**'].sort();
    const expectedOverrides = [
      'README.md C no no',
      'content/hero/b.js C yes no',
      'mix/x.js P no no',
      'mix/y.js D no yes',
    ].sort();
    const compiledFiles = ['src/app.js', 'src/lib/tool.js', 'content/hero/a.js', 'content/hero/b.js', 'mix/x.js', 'mix/y.js', 'README.md'];
    writeFixture(compileRoot, Object.fromEntries(compiledFiles.map((file) => [file, 'export const value = 1;\n'])));
    const compiledCheck = runCheck({
      repoRoot: compileRoot,
      manifest: written,
      trackedFiles: compiledFiles,
      manifestPath: outFile,
    });
    assert(
      'compile 产出 JSON',
      JSON.stringify(rulePairs) === JSON.stringify(expectedRules)
        && JSON.stringify(overridePairs) === JSON.stringify(expectedOverrides)
        && written.rules.length === 2
        && written.overrides.length === 4
        && compiledCheck.ok,
      `规则=${JSON.stringify(rulePairs)} overrides=${JSON.stringify(overridePairs)} 校验ok=${compiledCheck.ok}`,
    );

    // 6) glob 子集：* 不跨段，** 跨段，** 可吃零段，** 必须独占一段。
    let invalidRejected = false;
    try {
      globToRegExp('src/**x');
    } catch {
      invalidRejected = true;
    }
    assert(
      'glob 子集',
      matchGlob('src/*', 'src/a.js')
        && !matchGlob('src/*', 'src/a/b.js')
        && matchGlob('src/**', 'src/a/b.js')
        && matchGlob('**/*.js', 'a.js')
        && matchGlob('a/**/b.js', 'a/b.js')
        && matchGlob('a/**/b.js', 'a/x/y/b.js')
        && invalidRejected,
      `invalidRejected=${invalidRejected}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures.length) {
    console.log(`[zone-check] selftest：${total - failures.length}/${total} 通过；失败断言：${failures.join('、')}`);
    return false;
  }
  console.log(`[zone-check] selftest：${total}/${total} 通过`);
  return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`zone-check.mjs · 三区（P 程序 / C 内容 / D 数据）校验器

用法：
  node scripts/zone-check.mjs --manifest <清单.json> [--repo <仓库根>]
  node scripts/zone-check.mjs --compile <盘点目录> --out <清单.json>
  node scripts/zone-check.mjs --selftest
  node scripts/zone-check.mjs --help

子命令：
  --manifest <path>    校验清单（默认在当前目录所在 git 仓库运行，子目录也可以；--repo 可指定仓库根）：
                       · schema 合法；
                       · git ls-files 的每个跟踪文件恰好唯一归属（override 精确优先，rules 首条命中），
                         有文件无归属即 exit 1；
                       · P 区文件里 from <模块说明符> / import(<模块说明符>) 的 ./ ../ 相对引用，
                         若落在仓内且归 C 区或 D 区，逐条打印并 exit 1（P→P 绿）；
                       · 打印 contentDebt / noPublish 计数。
  --compile <dir>      读目录下 *.md 的盘点表格并聚合清单：
                       表头 | 路径 | zone | contentDebt | noPublish | 依据 |，布尔写 yes/no，
                       路径可用反引号包裹，依据列可空；
                       整棵同区子树 → 一条 "目录/**" 规则；混区目录/根目录文件 → 逐文件 overrides。
  --out <path>         配合 --compile 指定输出清单（覆盖写入，必要时建父目录）。
  --repo <dir>         只配合 --manifest：指定仓库根（默认从当前目录向上找 git）。
  --selftest           在 os.tmpdir() 造迷你 fixture 自测（不依赖 git），全过 exit 0。

清单 schema（schemaVersion 固定为 1，overrides 可省略，comment 可选）：
  {
    "schemaVersion": 1,
    "rules": [{ "zone": "P", "match": ["src/**"], "note": "程序" }],
    "overrides": [
      { "path": "src/mood.js", "zone": "P", "contentDebt": true, "noPublish": false, "note": "…" }
    ]
  }

归属与 glob：
  · overrides 精确路径优先；rules 按声明顺序首条匹配；路径为仓库相对、正斜杠、按 git 输出原样（大小写敏感）。
  · glob 只支持 **（跨路径段，必须独占一段）与 *（单段内，不跨 /）；不支持 ? [ ] { } 与转义。

退出码：
  0 通过；1 校验失败 / selftest 失败；2 参数或输入错误。`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    process.exit(USAGE_EXIT);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const opts = { manifest: null, compile: null, out: null, repo: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--manifest' || token === '--compile' || token === '--out' || token === '--repo') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 需要一个参数值`);
      opts[token.slice(2)] = value;
      i++;
    } else if (token === '--selftest') {
      opts.selftest = true;
    } else {
      throw new Error(`未知参数：${token}（--help 看用法）`);
    }
  }

  const modes = [opts.manifest !== null, opts.compile !== null, opts.selftest].filter(Boolean).length;
  if (modes !== 1) throw new Error('必须且只能指定 --manifest / --compile / --selftest 之一（--help 看用法）');
  if (opts.out !== null && opts.compile === null) throw new Error('--out 只能配合 --compile 使用');
  if (opts.compile !== null && opts.out === null) throw new Error('--compile 需要同时给 --out');
  if (opts.repo !== null && opts.manifest === null) throw new Error('--repo 只能配合 --manifest 使用');

  if (opts.selftest) process.exit(runSelftest() ? 0 : 1);

  if (opts.manifest !== null) {
    const manifestPath = path.resolve(opts.manifest);
    const repoRoot = opts.repo ? path.resolve(opts.repo) : findRepoRoot(process.cwd());
    const manifest = loadManifestFile(manifestPath);
    const result = runCheck({ repoRoot, manifest, trackedFiles: listTrackedFiles(repoRoot), manifestPath });
    printCheckReport(result);
    process.exit(result.ok ? 0 : 1);
  }

  const compiled = compileInventory({ dir: opts.compile, out: opts.out });
  printCompileReport(compiled);
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`[zone-check] 错误：${err.message}`);
    process.exit(USAGE_EXIT);
  }
}
