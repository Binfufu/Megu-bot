/**
 * **DSH 会话文件版本与读取口**(2026-10-15,续查价目时当场撞见)。
 *
 * ⚠️ 现场:磁盘上**全是 `session.v4.jsonl.zstd`**,而读取端声明的是
 *    `KNOWN_SESSION_VERSIONS = [3]`、`findSessionFiles` 里**写死** v3 文件名 ⇒
 *    "一个文件都找不到" ⇒ `archiveOnStartup` 走那条**连日志都不打**的静默 return。
 *    这正是 D169 那条判据要防的形状(它当时防住了"看见了但不认识",但**前提是读取口先看得见**)。
 *
 * 判据要问的是**消费端**:拿真工作区路径去数文件,而不是问常量写了什么。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KNOWN_SESSION_VERSIONS, SESSION_FILE_NAMES, sessionDirName } from '../src/memory-archive.js';
import { findSessionFiles, findSessionFilesUnder, findWorkspaceDir } from '../src/memory-store.js';

/** 造一个"像真的一样"的 DSH 会话目录:工作区目录 + 若干会话 uuid 目录 + v4 文件。 */
function makeSessionsTree(dshHome, workspace, { version = 4, count = 2 } = {}) {
  const dir = path.join(dshHome, 'sessions', sessionDirName(workspace));
  fs.mkdirSync(dir, { recursive: true });
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = `sess-${i}`;
    const sessionDir = path.join(dir, id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, `session.v${version}.jsonl.zstd`), 'not-a-real-frame');
    ids.push(id);
  }
  return { dir, ids };
}

export function registerSessionVersionTests({ test, assert }) {
  test('会话文件版本:读取端认识的版本**只有一处**,而且它必须跟得上磁盘(反证:磁盘 v4 读不到就是红)', () => {
    // ① 文件名表与版本表必须**同一来源**(两处各写一遍 ⇒ 迟早漂成现在这样)。
    assert.ok(Array.isArray(SESSION_FILE_NAMES) && SESSION_FILE_NAMES.length > 0, '要有唯一的文件名表');
    for (const name of SESSION_FILE_NAMES) {
      const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name);
      assert.ok(m, `文件名形状不对: ${name}`);
      assert.ok(KNOWN_SESSION_VERSIONS.includes(Number(m[1])),
        `${name} 在文件名表里,却不在 KNOWN_SESSION_VERSIONS 里 —— 两张表漂了`);
    }
    for (const v of KNOWN_SESSION_VERSIONS) {
      assert.ok(SESSION_FILE_NAMES.includes(`session.v${v}.jsonl.zstd`),
        `v${v} 在版本表里,却没有对应文件名`);
    }
    // ② **行为**:磁盘上是 v4 时,读取口必须真的看得见(这条是现场那次的形状)。
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-'));
    const workspace = 'workspace-relative';
    try {
      const { ids } = makeSessionsTree(home, workspace, { version: 4, count: 2 });
      assert.ok(findWorkspaceDir(home, workspace), '工作区目录要认得出');
      const files = findSessionFiles(home, workspace);
      assert.equal(files.length, ids.length,
        `v4 会话必须被数出来(实际 ${files.length} / 应为 ${ids.length})—— 反证:把 v4 从文件名表里删掉,这条红`);
      assert.deepEqual(files.map((f) => f.file.split(path.sep).at(-1)).sort(),
        ['session.v4.jsonl.zstd', 'session.v4.jsonl.zstd'], '拿到的确实是 v4 文件');
      // ③ 新旧并存时优先新的那份,而且**不重复计数**。
      fs.writeFileSync(path.join(path.dirname(files[0].file), 'session.v3.jsonl.zstd'), 'old');
      const both = findSessionFiles(home, workspace);
      assert.equal(both.length, ids.length, '同一会话目录里 v3/v4 并存时**只算一份**(否则会话数翻倍)');
      assert.ok(both.every((f) => f.file.endsWith('session.v4.jsonl.zstd')), '优先新版本');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('跨工作区报表的同一路径:v3+v4 都数得出、并存只算一份;不认识的版本要报出来不许静默(D159/D169)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-walker-'));
    try {
      const sessions = path.join(home, 'sessions');
      const mk = (rel, fileNames) => {
        const dir = path.join(sessions, rel);
        fs.mkdirSync(dir, { recursive: true });
        for (const name of fileNames) fs.writeFileSync(path.join(dir, name), 'x');
      };
      // 三个工作区形状:纯 v4 / 纯 v3 / v3+v4 并存;外加一个只装 v5 的"未来版本"会话目录。
      mk(path.join(sessionDirName('A'), 's1'), ['session.v4.jsonl.zstd']);
      mk(path.join(sessionDirName('E:\\B'), 's2'), ['session.v3.jsonl.zstd']);
      mk(path.join(sessionDirName('E:\\C'), 's3'), ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']);
      mk(path.join(sessionDirName('E:\\C'), 's4'), ['session.v5.jsonl.zstd']);
      const { files, unknown } = findSessionFilesUnder(sessions);
      assert.deepEqual(files.map((f) => f.id).sort(), ['s1', 's2', 's3'],
        'v3 与 v4 都要被数出来 —— 反证:哪个脚本再手抄 v3,s1 就消失(1.150.73 现场的形状)');
      const s3 = files.find((f) => f.id === 's3');
      assert.ok(s3.file.endsWith('session.v4.jsonl.zstd'), '并存时只算一份、优先新版本');
      assert.deepEqual(unknown, [{ dir: 's4', version: 5, count: 1 }],
        '不认识的版本必须报出来(D169) —— 静默跳过 = 下一轮就是"为什么少了几个会话"');
      // 三个报表脚本不许再手抄文件名 —— 都得走同一路径(F4 教训:先剥注释再断言,
      // 否则注释里举的反例会替实现"通过")。
      for (const script of ['usage-report.js', 'context-report.js', 'inspect-session.js']) {
        const text = fs.readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8')
          .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        assert.ok(text.includes('findSessionFilesUnder('), `${script} 必须用共享的会话扫描器(D159)`);
        assert.ok(!text.includes('session.v3.jsonl.zstd'), `${script} 不许再手抄会话文件名`);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('归档入口:磁盘是 v4 时不许走"连日志都不打"的静默 return(消费端:真目录 + 假读取器)', async () => {
    const { archiveOnStartup } = await import('../src/memory-store.js');
    const { openMemory } = await import('../src/memory-store.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-'));
    const workspace = 'workspace-relative';
    const dbFile = path.join(home, 'memory.db');
    const db = openMemory(dbFile);
    try {
      makeSessionsTree(home, workspace, { version: 4, count: 3 });
      let readCount = 0;
      // 假读取器:只数"入口有没有把文件交给读侧" —— 判据问的正是这一段(不是解析语义)。
      const stats = archiveOnStartup({ db, dshHome: home, workspace,
        readRecords: () => { readCount += 1; return []; } });
      assert.ok(stats, 'v4 在场时不许返回 null(= 当成"没有会话")');
      assert.equal(readCount, 3, `3 个 v4 文件都要被读(实际 ${readCount})—— 反证:只认 v3 ⇒ 0`);
    } finally {
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
