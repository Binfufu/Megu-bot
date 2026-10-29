/**
 * 会话归档器判据（2026-10-16 / 1.150.85 / 6B 配套）。
 *
 * 只钉**纯函数与合成树**：桶目录解析、逐文件清单与哈希、以及最要紧的一条 ——
 * **校验不过就绝不删原件**（归档器存在的全部理由：宁可留着占地方，也不丢证据）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { archiveSessionDir, listFiles, sessionBucketDir, sha256File } from './archive-sessions.js';
import { ARCHIVE_DAYS, ARCHIVE_INTERVAL_DAYS, ARCHIVE_START_TIME, DEFAULT_ARCHIVE_TASK_NAME, buildCreateArgs } from './schedule-archive.js';
import { sessionDirName } from '../src/memory-archive.js';

const SCRIPT = fileURLToPath(new URL('./archive-sessions.js', import.meta.url));

export function registerArchiveSessionsTests({ test, assert }) {
  // 计划任务的命令形状(纯函数;数字 = 主人 2026-10-16 定的 30/30,不是暂定)
  test('会话归档计划:30 天保留 + 30 天一次;命令必须带 --apply(先归档校验再删),且两条路径都转义', () => {
    assert.equal(ARCHIVE_DAYS, 30, '保留窗口是主人定的 30 天');
    assert.equal(ARCHIVE_INTERVAL_DAYS, 30, '归档节奏是主人定的 30 天一次');
    const args = buildCreateArgs({ nodeExe: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'E:\\a b\\archive-sessions.js' });
    const joined = args.join(' ');
    assert.ok(args.includes('/create') && args.includes(DEFAULT_ARCHIVE_TASK_NAME), '任务名要能认出来');
    assert.deepEqual([args[args.indexOf('/sc') + 1], args[args.indexOf('/mo') + 1], args[args.indexOf('/st') + 1]],
      ['DAILY', '30', ARCHIVE_START_TIME], '节奏由 /sc DAILY /mo 30 /st 表达');
    assert.ok(args.includes('/rl') && args.includes('LIMITED'), '不提权(与守护同一档)');
    assert.match(joined, /--apply --days 30/, '必须带 --apply 与保留天数 —— 干跑不会清理,那不是我们要的定时任务');
    assert.match(joined, /\\"C:\\Program Files\\nodejs\\node\.exe\\"/, '带空格的 node 路径要转义');
    assert.match(joined, /\\"E:\\a b\\archive-sessions\.js\\"/, '带空格的脚本路径也要转义');
  });

  test('会话归档:桶目录按 QQBOT_HOME+工作区派生;复制逐文件哈希一致;坏目标绝不删原件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-root-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-dest-'));
    try {
      const workspace = path.join(root, 'workspace-x');
      fs.mkdirSync(path.join(root, 'bots', 'alpha'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bots', 'alpha', '.env'),
        `QQBOT_HOME=${path.join(root, 'home')}\nQQBOT_WORKSPACE=${workspace}\n`, 'utf8');
      const bucket = sessionBucketDir(root, 'alpha');
      assert.equal(bucket, path.join(root, 'home', 'sessions', sessionDirName(workspace)), '桶目录必须与守护同一套派生规则');

      // 合成一个会话目录（含子目录，验证递归清单）
      const session = path.join(bucket, 'qqbot-c2c-USER-g2');
      fs.mkdirSync(path.join(session, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(session, 'session.v4.jsonl.zstd'), 'AAAA', 'utf8');
      fs.writeFileSync(path.join(session, 'sub', 'extra.bin'), 'BB', 'utf8');
      const files = listFiles(session);
      assert.deepEqual(files.map((f) => f.rel), ['session.v4.jsonl.zstd', 'sub/extra.bin'], '清单要递归且排序稳定');

      // 正常归档:校验通过,清单带哈希
      const entry = archiveSessionDir({ srcDir: session, destDir: path.join(dest, 'alpha', 'qqbot-c2c-USER-g2'), bot: 'alpha', bucket: 'b' });
      assert.equal(entry.files.length, 2);
      assert.equal(entry.files[0].sha256, sha256File(path.join(session, 'session.v4.jsonl.zstd')), '清单哈希 = 源文件哈希');
      assert.ok(fs.existsSync(path.join(dest, 'alpha', 'qqbot-c2c-USER-g2', 'sub', 'extra.bin')), '子目录也要复制过去');

      // 反证:目标路径被占成"文件" ⇒ 复制必失败 ⇒ 调用方不许删原件
      const blocked = path.join(dest, 'blocked');
      fs.writeFileSync(blocked, 'x', 'utf8');
      let threw = false;
      try { archiveSessionDir({ srcDir: session, destDir: path.join(blocked, 'nope'), bot: 'alpha', bucket: 'b' }); }
      catch { threw = true; }
      assert.equal(threw, true, '归档失败必须抛(脚本据此保留原件)');
      assert.ok(fs.existsSync(path.join(session, 'session.v4.jsonl.zstd')), '**归档失败后原件还在** —— 这是本脚本与旧扫帚唯一的区别');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  test('会话归档(CLI):干跑不动原件;--apply 归档过期代、保留最新一代并落清单', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-cli-root-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-cli-dest-'));
    try {
      const workspace = path.join(root, 'workspace-y');
      fs.mkdirSync(path.join(root, 'bots', 'beta'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bots', 'beta', '.env'),
        `QQBOT_HOME=${path.join(root, 'home')}\nQQBOT_WORKSPACE=${workspace}\n`, 'utf8');
      const bucket = sessionBucketDir(root, 'beta');
      // 老一代(g1) + 最新一代(g2):g1 该被归档, g2 永远保留
      for (const [name, body] of [['qqbot-c2c-U-g1', 'OLD'], ['qqbot-c2c-U-g2', 'NEW']]) {
        fs.mkdirSync(path.join(bucket, name), { recursive: true });
        fs.writeFileSync(path.join(bucket, name, 'session.v4.jsonl.zstd'), body, 'utf8');
      }
      const oldDir = path.join(bucket, 'qqbot-c2c-U-g1');
      // 把 g1 的 mtime 推老(保留窗口按 mtime 判)
      const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
      fs.utimesSync(oldDir, past, past);

      // 干跑:一个字都不许动
      const dry = spawnSync(process.execPath, [SCRIPT, '--root', root, '--dest', dest, '--days', '30'], { encoding: 'utf8' });
      assert.equal(dry.status, 0, dry.stderr || dry.stdout);
      assert.match(dry.stdout, /干跑/);
      assert.ok(fs.existsSync(oldDir), '干跑绝不许删东西');

      // 真跑:g1 归档并清理, g2 留着
      const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--dest', dest, '--days', '30', '--apply'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.equal(fs.existsSync(oldDir), false, '过期代已清理');
      assert.ok(fs.existsSync(path.join(bucket, 'qqbot-c2c-U-g2', 'session.v4.jsonl.zstd')), '最新一代永远保留');
      const runs = fs.readdirSync(dest).filter((n) => n.includes('T'));
      assert.equal(runs.length, 1, '归档区落一个带时间戳的运行目录');
      const manifest = JSON.parse(fs.readFileSync(path.join(dest, runs[0], 'manifest.json'), 'utf8'));
      assert.equal(manifest.archived.length, 1);
      assert.equal(manifest.archived[0].session, 'qqbot-c2c-U-g1');
      const archived = path.join(dest, runs[0], 'beta', 'qqbot-c2c-U-g1', 'session.v4.jsonl.zstd');
      assert.ok(fs.existsSync(archived), '归档里有原件');
      assert.equal(fs.readFileSync(archived, 'utf8'), 'OLD', '内容逐字一致');
      const recorded = manifest.archived[0];
      assert.equal(recorded.files, 1, '清单记下文件数');
      assert.equal(recorded.bytes, 3, '清单记下字节数(OLD=3)');
      assert.equal(sha256File(archived), sha256File(archived), '归档件可读(哈希算得出来)');
      assert.match(manifest.deleted[0].session, /g1$/, '清单同时记录"清理了什么"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
}
