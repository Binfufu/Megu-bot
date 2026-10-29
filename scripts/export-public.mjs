#!/usr/bin/env node
/**
 * 本地公开候选导出，零依赖；不发布、不初始化公仓、不转换文本、不复制 Git 历史。
 * 用法：node scripts/export-public.mjs --repo <repo> --manifest <json>
 *       --out <不存在的仓外目录> --expected-commit <完整 SHA>
 * receipt 仅 stdout JSON，不在候选中添加额外文件。路径审计不等于内容扫描。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildExportPlan, exportPathProblem, exportPlanExitCode } from './export-dry-run.mjs';
import { listTracked } from './zone-check.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pathKey = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const samePath = (a, b) => pathKey(path.resolve(a)) === pathKey(path.resolve(b));
function within(root, target) {
  const rel = path.relative(pathKey(root), pathKey(target));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
// 只认 --repo/cwd：剥掉调用者环境里的 Git 拓扑变量，防止被重定向到另一个仓库/索引。
const GIT_TOPOLOGY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];
function gitEnv() {
  const env = { ...process.env };
  for (const key of GIT_TOPOLOGY_ENV) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0' };
}
function git(repo, args, allowNoRepo = false) {
  const run = spawnSync('git', args, {
    cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(),
  });
  if (run.error) fail('GIT_FAILED', run.error.message);
  if (allowNoRepo && run.status === 128 && /not a git repository/i.test(run.stderr)) return null;
  if (run.status !== 0) fail('GIT_FAILED', `Git 只读检查失败 (${run.status})`);
  return run.stdout;
}

/** 检查整个既有祖先链，拒绝 symlink/junction；不以 realpath 偷偷放行链接。 */
function checkDirectories(absolute) {
  const resolved = path.resolve(absolute);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of [null, ...resolved.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part !== null) current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('LINK_OR_SPECIAL', '目录祖先包含链接或非目录');
  }
  if (!samePath(fs.realpathSync.native(resolved), resolved)) fail('PATH_ESCAPE', '目录真实路径不一致');
  return resolved;
}
function regularFile(root, rel) {
  const problem = exportPathProblem(rel);
  if (problem) fail('INVALID_PATH', problem);
  const absolute = path.resolve(root, ...rel.split('/'));
  if (!within(root, absolute)) fail('PATH_ESCAPE', '文件越出根目录');
  checkDirectories(path.dirname(absolute));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('LINK_OR_SPECIAL', '仅接受非链接的正规文件（含拒绝硬链接）');
  if (!samePath(fs.realpathSync.native(absolute), absolute)) fail('PATH_ESCAPE', '文件真实路径不一致');
  return { absolute, stat };
}
function readRegular(root, rel) {
  const { absolute, stat } = regularFile(root, rel);
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) fail('SOURCE_CHANGED', '文件在打开时变化');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.size !== bytes.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) fail('SOURCE_CHANGED', '文件在读取时变化');
    return { bytes, mode: opened.mode };
  } finally { fs.closeSync(fd); }
}
function cleanBoundCommit(repo, expectedCommit) {
  const head = git(repo, ['rev-parse', '--verify', 'HEAD']).trim();
  if (head !== expectedCommit) fail('COMMIT_MISMATCH', 'HEAD 与 expected commit 不一致');
  const flags = git(repo, ['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  if (flags.some((record) => /^[a-zS]/.test(record))) fail('INDEX_HIDDEN', '拒绝 assume-unchanged/skip-worktree，避免隐藏修改假装干净');
  if (git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).length) {
    fail('DIRTY_TREE', '拒绝脏工作树（含未跟踪文件）；不会冒称它是 commit 的准确树');
  }
  return head;
}
function indexModes(repo) {
  const modes = new Map();
  for (const record of git(repo, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== '0' || modes.has(match[4])) fail('INDEX_INVALID', '索引有冲突或重复');
    modes.set(match[4], match[1]);
  }
  return modes;
}
function checkMode(modes, rel) {
  if (!['100644', '100755'].includes(modes.get(rel))) fail('LINK_OR_SPECIAL', 'Git 候选必须为正规 blob，拒绝链接和子模块');
}
function destination(repo, out) {
  const absolute = path.resolve(out);
  const parent = checkDirectories(path.dirname(absolute));
  if (fs.existsSync(absolute)) fail('TARGET_EXISTS', '目标必须不存在，拒绝覆盖');
  // existsSync 对 dangling symlink 返回 false，lstat 必须额外检查。
  try { fs.lstatSync(absolute); fail('TARGET_EXISTS', '目标已存在（含断链）'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (within(repo, absolute)) fail('TARGET_IN_REPO', '目标不得位于源仓内部');
  for (const arg of ['--absolute-git-dir', '--git-common-dir']) {
    const gitDir = path.resolve(repo, git(repo, ['rev-parse', arg]).trim());
    if (within(gitDir, absolute)) fail('TARGET_IN_REPO', '目标不得位于 Git 元数据/历史目录内');
  }
  // 独立目录：也不能落在另一个 Git worktree 或 bare repo 内。
  if (git(parent, ['rev-parse', '--git-dir'], true) !== null) fail('TARGET_IN_REPO', '目标父目录位于 Git 仓库内');
  const leaf = path.basename(absolute);
  if (exportPathProblem(leaf)) fail('INVALID_TARGET', '目标目录名不安全');
  return absolute;
}
function makeParent(root, rel) {
  let current = root;
  for (const part of rel.split('/').slice(0, -1)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkDirectories(current);
  }
}
function outputFiles(root, dir = root) {
  checkDirectories(dir);
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...outputFiles(root, absolute));
    else {
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      regularFile(root, rel);
      result.push(rel);
    }
  }
  return result.sort();
}

/** 只消费同一个机器计划；调用者不能注入另一份 publish 白名单或跳过硬闸。 */
export function exportPublic({ repo, manifest: manifestPath, out, expectedCommit }) {
  if (!repo || !manifestPath || !out || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedCommit ?? '')) {
    fail('USAGE', '必须给 repo/manifest/out/完整小写 expected commit');
  }
  const root = checkDirectories(path.resolve(repo));
  if (!samePath(git(root, ['rev-parse', '--show-toplevel']).trim(), root)) fail('REPO_ROOT', 'repo 必须为工作树根目录');
  const target = destination(root, out);
  const sourceCommit = cleanBoundCommit(root, expectedCommit);
  const manifestAbsolute = path.resolve(manifestPath);
  if (!within(root, manifestAbsolute)) fail('MANIFEST_OUTSIDE', 'manifest 必须在源仓内并受跟踪');
  const manifestRel = path.relative(root, manifestAbsolute).split(path.sep).join('/');
  const trackedFiles = listTracked(root);
  if (!trackedFiles.includes(manifestRel)) fail('MANIFEST_UNTRACKED', 'manifest 必须受跟踪并绑定提交');
  const modes = indexModes(root);
  checkMode(modes, manifestRel);
  const manifestBytes = readRegular(root, manifestRel).bytes;
  const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const plan = buildExportPlan({ manifest, trackedFiles });
  if (exportPlanExitCode(plan, true)) {
    fail('PLAN_BLOCKED', `debt=${plan.debt.length} missing=${plan.missing.length} safety=${plan.safety.length} unowned=${plan.unowned.length} invalidPaths=${plan.invalidPaths.length}`);
  }
  // 全部前置检查完成后才写目标；排除文件无需读取，更不会递归复制 .git。
  for (const rel of plan.publish) { checkMode(modes, rel); regularFile(root, rel); }
  cleanBoundCommit(root, expectedCommit);
  fs.mkdirSync(target); // 排他创建；绝不 recursive/覆盖已有目标。
  const files = [];
  for (const rel of plan.publish) {
    const source = readRegular(root, rel);
    makeParent(target, rel);
    const dest = path.join(target, ...rel.split('/'));
    const fd = fs.openSync(dest, 'wx', source.mode & 0o777);
    try { fs.writeFileSync(fd, source.bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const written = readRegular(target, rel).bytes;
    if (!written.equals(source.bytes) || sha256(written) !== sha256(source.bytes)) fail('VERIFY_FAILED', '目标逐字节/SHA256 回读不一致');
    files.push({ path: rel, bytes: written.length, sha256: sha256(written) });
  }
  const actual = outputFiles(target);
  if (JSON.stringify(actual) !== JSON.stringify([...plan.publish].sort())) fail('VERIFY_FAILED', '目标文件集合不等于 publish 计划');
  // 回读源和目标，钉住导出窗口内变化；失败不发成功 receipt，保留目录供人工检查。
  for (const item of files) {
    for (const base of [root, target]) {
      const bytes = readRegular(base, item.path).bytes;
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) fail('SOURCE_CHANGED', '导出期间源或目标字节发生变化');
    }
  }
  if (sha256(readRegular(root, manifestRel).bytes) !== sha256(manifestBytes)
    || JSON.stringify(listTracked(root)) !== JSON.stringify(trackedFiles)) fail('SOURCE_CHANGED', '清单或跟踪集合发生变化');
  cleanBoundCommit(root, expectedCommit);
  return {
    schemaVersion: 1, sourceCommit, expectedCommit, manifestSha256: sha256(manifestBytes),
    sourceKind: 'clean-worktree-candidate', dirty: false, commitTreeExact: false,
    published: false, contentScanPerformed: false,
    files,
  };
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      console.log('用法: node scripts/export-public.mjs --repo <仓库根> --manifest <清单.json> --out <不存在的独立目录> --expected-commit <完整 SHA>');
      return;
    }
    const keys = { '--repo': 'repo', '--manifest': 'manifest', '--out': 'out', '--expected-commit': 'expectedCommit' };
    if (!keys[token] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('USAGE', `未知参数或缺值: ${token}`);
    if (opts[keys[token]] !== undefined) fail('USAGE', `重复参数: ${token}`);
    opts[keys[token]] = argv[++i];
  }
  console.log(JSON.stringify(exportPublic(opts), null, 2));
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`[export-public] ${error.message}`); process.exitCode = error.code === 'USAGE' ? 2 : 1; }
}
