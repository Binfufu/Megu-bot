/**
 * 记忆库的读写 —— bridge 与命令行脚本共用一份实现。
 *
 * ## 为什么 bridge 要碰记忆库
 *
 * `dsh` **不能恢复既有会话**(见 `src/dsh.js` 的 `#resolveSession`):
 * 每个新进程都会给每个会话**代数 +1**,新会话从零开始。所以"重启 = 失忆"是必然的,
 * 除非 **bridge 自己把记忆带上** —— 这就是这个模块存在的理由:
 *
 *   1. **归档**:把散落的孤儿会话收进 `memory.db`(派生索引,见 D38);
 *   2. **交接**:取出"这个会话之前聊过什么",拼成一段有预算的文本,
 *      在**新一代会话的第一轮**注入提示词(`src/dsh.js` 的 `#runConversation`)。
 *
 * 只有第 2 步做到,机器人才真的"记得";只做第 1 步,那只是给你查的档案。
 *
 * ## 分层:为什么不用"每轮都问模型"
 *
 * - **最近的轮次给原文** —— 精确,且免费;
 * - **更早的给压缩行**(一行一轮) —— 以 5~10 倍的压缩换到很长的历史视野;
 * - **累计事实**(聊过多少轮、最早哪天) —— 从表里聚合,免费。
 *
 * 这三层都不需要模型调用,所以交接可以随时做、不花 token、也不会因为"摘要跑失败"
 * 而让对话卡住。**模型写的那种"滚动摘要"是下一步**(见 TODO):它更好,但要缓存 + 预算,
 * 而且不该在启动路径上同步调模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FTS_SCHEMA, HANDOFF_RECENT, KNOWN_SESSION_VERSIONS, MEMORY_SCHEMA, MEMORY_VERSION, NON_MEMORY_KINDS, RESIDUE_KIND, SESSION_FILE_NAMES, SUMMARY_REFRESH_TURNS, SUMMARY_TARGET_CHARS, SUMMARY_VERSION, buildHandoffText, buildHandoffWithSummary, classifyKind, cleanMemoryText, describeUnknownSessions, extractTurns, isHumanTurn, isInjectedBlock, isToolConversation, sessionDirName, sessionFileVersion, shortTime, unknownSessionVersions, whatSheSaid, whatWasSaid, workspaceKeyOf } from './memory-archive.js';
import { noteClaims, scoreTurn } from './memory-notes.js';
import { CHAT_INPUT_PROJECTION_VERSION, projectChatInput } from './chat-input-projection.js';
import { CHUNK_MAX, chunkKnowledge, renderKnowledge } from './kb.js';
import { bigramTokens, cosineSimilarity, ftsMatchExpression, normalizeTags, recallDecision, renderRecall, tagsFor } from './memory-tags.js';
import { log } from './log.js';

/** 打开(必要时创建)记忆库。 */
export function openMemory(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec(MEMORY_SCHEMA);
  return db;
}

/** 供只读查看用(不建表、不写)。 */
export function openMemoryReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  return db;
}

/**
 * own 派生行是否已按**当前投影规则**迁移完成(`own-memory-archive` 成功提交时写 watermark)。
 *
 * ⚠️ 为什么读侧也要判(F1 反证抓到的缺口):启动归档失败(源档读失败/库忙/坏 provenance)时
 *    归档 tick **不拦**已经打开的 memoryDb(`memory-archive-tick` 的既有语义),于是未迁移的
 *    旧 turn/FTS 仍会被交接与长期层消费 —— 旧裸 notes 就又一次随"记忆"进提示词。
 *    迁移没完成 ⇒ 不信任派生正文,按统一投影在**读侧**再算一遍(源码档不删、note 不删)。
 */
export function ownDerivedProjectionReady(db) {
  try {
    const value = db.prepare("SELECT value FROM meta WHERE key = 'own_archive_projection_version'").get()?.value;
    return Number(value) >= CHAT_INPUT_PROJECTION_VERSION;
  } catch {
    return false;
  }
}

/**
 * 读侧统一清洁:只有「own 源 + 迁移未完成」的旧派生行才做旧格式兼容投影;
 * 已迁移/非 own 行原样返回(干净行零变化,重复读幂等)。
 *
 * ⚠️ **正文与 kind 一起现算**(F1 审查抓到):归档没成功时旧 kind 可能是被污染的
 * (例如临时 notes 让 `warmup` 命中),`isHumanTurn` 会因此把整轮从交接/长期层丢掉 ——
 * 只修正文不修 kind = 事实仍然消失。这里按同一投影现算 kind,原档不动。
 */
export function projectDerivedRead(row, ready) {
  const text = String(row?.user_text ?? '');
  if (ready || !String(row?.session_file ?? '').startsWith('own-state:')) return text;
  const projected = projectChatInput(text, { source: 'own-engine', role: 'user' });
  if (row && typeof row.kind === 'string') {
    row.kind = isToolConversation(row.conversation ?? row.session_id) ? 'tool' : classifyKind(projected);
  }
  return projected;
}

/**
 * 找这个工作区的会话目录:**先按公式算,算不中就按名字解开比对**。
 *
 * ⚠️ **绝不退化成"扫所有工作区"**(老行为,2026-10-08 / D170 改掉):
 *    老代码在目标目录不存在时会把 `sessions/` 下**每一个**工作区都当成候选 ——
 *    于是"公式对不上"的代价是**安静地把别的桶的会话收进她的记忆**,而不是报错。
 *    与 D169 同一条纪律:**读错地方必须能发现,不许静默**。
 * ⚠️ 也不能简单 `return null` 了事:公式万一还有没覆盖到的形状(比如代理对/emoji 路径),
 *    这里**按名字解开再比对**能自己兜住 —— 兜的是"同一个工作区",不是别人。
 */
export function findWorkspaceDir(dshHome, workspace) {
  const base = path.join(dshHome, 'sessions');
  if (!fs.existsSync(base)) return null;
  const wanted = sessionDirName(workspace);
  const direct = path.join(base, wanted);
  if (fs.existsSync(direct)) return direct;
  const key = workspaceKeyOf(wanted);
  for (const name of fs.readdirSync(base)) {
    if (workspaceKeyOf(name) === key) return path.join(base, name);
  }
  return null;
}

/** 会话记录文件在哪:`~/.dsh/sessions/--E-DSH-<工作区>--/<会话id>/session.v<N>.jsonl.zstd`。
 *
 *  ⚠️ **2026-10-15 修**:这里原来**写死** `session.v3.jsonl.zstd`,而磁盘上已经全是 v4
 *  ⇒ 一个文件都找不到 ⇒ `archiveOnStartup` 走"连日志都不打"的静默 return,
 *  报表上表现为"全库 qqbot* 读 0"。现在文件名从 `SESSION_FILE_NAMES` 派生(新的在前),
 *  同一会话目录里 v3/v4 并存时**只算一份**(优先新的),不让会话数翻倍。
 */
/** 同一个会话目录里按**同一份 `SESSION_FILE_NAMES`** 取一份(新的在前);
 *  没有认识的版本、但摆着不认识的会话文件(比如 v5)⇒ 返回 `unknown` 让调用方报出来,
 *  不许安静地跳过(D169)。`findSessionFiles` 与 `findSessionFilesUnder` 共用这一份 ——
 *  两处各写一遍,就会再漂成"磁盘 v4 / 读取端 v3"那次的样子。 */
function pickSessionFile(names, dir) {
  const name = SESSION_FILE_NAMES.find((candidate) => names.includes(candidate));
  if (name) return { file: path.join(dir, name), version: sessionFileVersion(name), unknown: null };
  const unknown = unknownSessionVersions(names);
  return unknown.length > 0 ? { file: null, version: null, unknown } : null;
}

export function findSessionFiles(dshHome, workspace) {
  const root = findWorkspaceDir(dshHome, workspace);
  if (!root) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; } // 单个会话目录读不动 ⇒ 跳过,别带走整趟
    const picked = pickSessionFile(names, dir);
    if (picked?.file) files.push({ id: entry.name, file: picked.file });
  }
  return files;
}

/**
 * **跨工作区**的会话文件扫描(报表脚本专用):递归扫一个 sessions 根,
 * 每个会话目录按 `pickSessionFile` 取一份 —— 与 `findSessionFiles` 同一张表、同一个取舍。
 *
 * ⚠️ 与 `findSessionFiles` 的分工:那个**按工作区定位**(归档/写入路径;D170:绝不退化成扫所有工作区);
 *    这个给 `usage-report` / `context-report` / `inspect-session` 这类**跨工作区报表**用
 *    (按会话名前缀过滤是调用方显式做的事)。1.150.76 之前,这三个脚本**各自手抄**一份
 *    `session.v3.jsonl.zstd` 文件名 —— 磁盘升到 v4 就一起静默失明(1.150.73 现场的同族)。
 * ⚠️ 目录里只有**读取端不认识**的会话文件时,不进 `files`,但**必须**进 `unknown`
 *    —— "不认识就明说",不许安静地少收(D169)。
 *
 * @returns {{files: Array<{id: string, file: string, version: number}>,
 *            unknown: Array<{dir: string, version: number, count: number}>}}
 */
export function findSessionFilesUnder(root) {
  const files = [];
  const unknown = [];
  const scan = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      let names;
      try { names = fs.readdirSync(full); } catch { continue; } // 读不动 ⇒ 跳过,别带走整趟
      const picked = pickSessionFile(names, full);
      if (picked?.file) {
        files.push({ id: entry.name, file: picked.file, version: picked.version });
      } else {
        for (const u of picked?.unknown ?? []) unknown.push({ dir: entry.name, version: u.version, count: u.count });
        scan(full);
      }
    }
  };
  scan(root);
  return { files, unknown };
}

/**
 * 归档一轮(增量、幂等)。
 *
 * ## ⚠️ 2026-10-01:"派生索引"这个前提**已经不成立了**
 *
 * 原来这里写着"重导零风险:这只是派生索引,真相在那些 .jsonl.zstd 里"。
 * **那句话现在是错的** —— 守护的会话保留策略(默认 **7 天**)会把老的会话目录**删掉**,
 * 于是"真相"自己会消失。实测(2026-10-01):
 *
 * | 时刻(本地) | 发生了什么 |
 * |---|---|
 * | 07:22 | 会话保留:`megumin 删除 13 个 / 释放 412.1 KB(保留 110 个,最近 7 天)` |
 * | 12:10 | 判据从 v5 变到 v6 → 整库重导 → 只读得到还在磁盘上的 111 个 → **丢了 13 个会话 / 67 轮** |
 *
 * 67 轮是**不可再生**的(源文件已删,没有 memory.db 备份)。所以现在:
 *
 * 1. **重导前先备份**(`options.dbFile` 给了就 `VACUUM INTO <库>.pre-v<旧版本>`,可回滚);
 * 2. **把"源文件已经不在"的那些轮次先收起来,重导后再放回去**(并把标签按**当前**判据重贴)——
 *    它们的分类只能保留旧值(没原文可重算),但**一行都不该丢**;
 * 3. **重导后轮次变少了就大声报**——这是"库在悄悄缩水"的唯一信号。
 *
 * @param {object} options
 * @param {DatabaseSync} options.db
 * @param {Array<{id: string, file: string}>} options.files
 * @param {(file: string) => Array<object>} options.readRecords 解码函数(由调用方注入,
 *   这样 `src/` 不必知道 zstd 分帧那套细节)
 * @param {string} [options.rootDir] 用来把文件路径写成相对路径
 * @param {string} [options.dbFile] 库文件路径 —— 给了才会在重导前做备份
 * @param {number} [options.now]
 * @returns {{newTurns: number, sessions: number, turns: number, unreadable: number,
 *            kept: number, lost: number}}
 */
export function archivePass({
  db,
  files,
  readRecords,
  rootDir = null,
  dbFile = null,
  peopleNames = [],
  now = Date.now(),
}) {
  // 判据/表结构变了 → **重导**。
  // 幂等键是 (会话, seq),`INSERT OR IGNORE` 不会更新已有的行;不重导的话,
  // 旧分类会永远留在库里,而库看起来完全正常 —— 那就是"诊断工具说谎"。
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'memory_version'").get()?.value;
  const stale = stored !== undefined && stored !== String(MEMORY_VERSION);
  const turnsBefore = db.prepare('SELECT COUNT(*) n FROM turn').get().n;
  let orphans = { sessions: [], turns: [] };
  if (stale) {
    log.info(`记忆归档：判据从 v${stored} 变到 v${MEMORY_VERSION}，重导（派生索引）`);
    // ① 备份:重导是**破坏性**的(见上面那段),给一条回滚路。
    if (dbFile) {
      const backup = `${dbFile}.pre-v${stored}`;
      try {
        // ⚠️ `VACUUM INTO` 要求目标**不存在**;已存在 = 这一步已经备份过了。
        db.exec(`VACUUM INTO '${String(backup).replace(/'/g, "''")}'`);
        log.info(`记忆归档：重导前已备份到 ${path.basename(backup)}(留作回滚)`);
      } catch (err) {
        log.warn(`记忆归档：重导前的备份没做成（${err.message}）—— 继续重导`);
      }
    }
    // ② 收住"源文件已经不在磁盘上"的那些轮次:它们是**不可再生**的。
    const known = new Set(files.map((entry) => entry.id));
    const orphanIds = db.prepare('SELECT id FROM session').all()
      .map((row) => row.id)
      .filter((id) => !known.has(id));
    if (orphanIds.length > 0) {
      const slots = orphanIds.map(() => '?').join(',');
      orphans = {
        sessions: db.prepare(`SELECT * FROM session WHERE id IN (${slots})`).all(...orphanIds),
        turns: db.prepare(`SELECT * FROM turn WHERE session_id IN (${slots})`).all(...orphanIds),
      };
      log.info(
        `记忆归档：${orphanIds.length} 个会话的源文件已经不在了（会话保留策略删的），` +
        `先收住它们的 ${orphans.turns.length} 轮 —— 重导后会放回去`,
      );
    }
    db.exec('DELETE FROM turn');
    db.exec('DELETE FROM session');
    // ⚠️ 标签也要一起清(v3 新增)。不清的话重导后旧标签会**留在库里**,
    //    而 turn 的行号可能已经换过 —— 那就是"索引指向了不存在的东西"。
    db.exec('DELETE FROM memory_tag');
  }

  const insertSession = db.prepare(
    `INSERT INTO session (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET turns = excluded.turns, imported_at = excluded.imported_at`,
  );
  const insertTurn = db.prepare(
    `INSERT OR IGNORE INTO turn (session_id, seq, at, turn_no, kind, topic, mood, max_chars, max_sentences,
       interjection, state_line, nudge, user_text, user_chars, reply_at, reply_text, reply_chars, silent,
       in_tokens, out_tokens, cache_read_tokens, reasoning_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTag = db.prepare(
    `INSERT OR IGNORE INTO memory_tag (session_id, seq, tag, source, created_at) VALUES (?, ?, ?, 'rule', ?)`,
  );

  let newTurns = 0;
  let unreadable = 0;
  db.exec('BEGIN');
  try {
    for (const { id, file } of files) {
      let records;
      try {
        records = readRecords(file);
      } catch {
        // 正在写入的会话可能读到半截 —— 跳过,下次再收,别让整轮归档失败
        unreadable += 1;
        continue;
      }
      if (records.length === 0) continue;
      const { session, turns } = extractTurns(id, records, {
        importedAt: now,
        file: rootDir ? path.relative(rootDir, file) : file,
      });
      insertSession.run(
        session.id, session.conversation, session.scene, session.target, session.generation,
        session.created_at, session.cwd, session.file, session.turns, session.imported_at,
      );
      for (const turn of turns) {
        const result = insertTurn.run(
          turn.session_id, turn.seq, turn.at, turn.turn_no, turn.kind, turn.topic, turn.mood,
          turn.max_chars, turn.max_sentences, turn.interjection, turn.state_line, turn.nudge,
          turn.user_text, turn.user_chars, turn.reply_at, turn.reply_text, turn.reply_chars, turn.silent,
          turn.in_tokens, turn.out_tokens, turn.cache_read_tokens, turn.reasoning_tokens,
        );
        if (result.changes > 0) newTurns += 1;
      }
    }
    // ③ 把"源文件已经不在"的那些放回去。它们的 `kind`/分类只能保留旧值(没原文可重算),
    //    但**标签**会由下面那次全量重贴按当前规则算出来。
    for (const session of orphans.sessions) {
      insertSession.run(
        session.id, session.conversation, session.scene, session.target, session.generation,
        session.created_at, session.cwd, session.file, session.turns, session.imported_at,
      );
    }
    let kept = 0;
    for (const turn of orphans.turns) {
      const result = insertTurn.run(
        turn.session_id, turn.seq, turn.at, turn.turn_no, turn.kind, turn.topic, turn.mood,
        turn.max_chars, turn.max_sentences, turn.interjection, turn.state_line, turn.nudge,
        turn.user_text, turn.user_chars, turn.reply_at, turn.reply_text, turn.reply_chars, turn.silent,
        turn.in_tokens, turn.out_tokens, turn.cache_read_tokens, turn.reasoning_tokens,
      );
      if (result.changes > 0) kept += 1;
    }
    // ④ **全量重贴标签**(见 `retagAll`):于是"标签"永远等于"当前规则 + 当前人名表" ——
    //    新学到一个昵称(比如「饭否」),它昨天那些错标签今天就会被改过来。
    retagAll(db, { peopleNames, now });
    // ④.5 访问账(D89)只清理"指向已经不存在的轮次"的那些(测试库/删过会话的库)。
    //     ⚠️ **必须同时排除 `note`**:固化记忆的 source 也是 `会话#seq`,而它的轮次可能早就
    //        被会话保留策略删掉了 —— 只按 `turn` 过滤会把固化记忆的访问账一起误删。
    db.exec(
      `DELETE FROM access
        WHERE source NOT IN (SELECT session_id || '#' || seq FROM turn)
          AND source NOT IN (SELECT source FROM note)`,
    );
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    meta.run('memory_version', String(MEMORY_VERSION));
    meta.run('archived_at', new Date(now).toISOString());
    db.exec('COMMIT');
    if (kept > 0) log.info(`记忆归档：把 ${kept} 轮"源文件已不在"的历史放回去了（不可再生，一行都不许丢）`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const turns = db.prepare('SELECT COUNT(*) n FROM turn').get().n;
  // ④ 缩水就大声说。这是"库在悄悄变小"的唯一信号 —— 而它曾经真的悄悄发生过一次。
  const lost = Math.max(0, turnsBefore - turns);
  if (stale && lost > 0) {
    log.warn(
      `记忆归档：⚠️ 重导后轮次少了 ${lost} 条（${turnsBefore} → ${turns}）—— ` +
      '源文件可能已被会话保留策略删掉；本次没救回来的部分是不可再生的',
    );
  }
  return {
    newTurns,
    unreadable,
    sessions: db.prepare('SELECT COUNT(*) n FROM session').get().n,
    turns,
    kept: orphans.turns.length,
    lost: stale ? lost : 0,
  };
}

/**
 * 把记忆库**一致地**备份到 `dest`,并回读校验(2026-10-01,D77)。
 *
 * ⚠️ **不能直接拷 `memory.db` 文件**:它是 WAL 模式,主文件只是"上一个检查点"的状态,
 * 拷出来会**丢掉还没检查点的写入** —— 实测里那 67 轮刚恢复的行就全在 `-wal` 里,
 * 直接拷会"备份出一个少了 67 轮的库",而它看起来完全正常。
 * `VACUUM INTO` 会把当前所有已提交内容写成一个干净、自洽的新库。
 *
 * @param {DatabaseSync} db 活的库
 * @param {string} dest 目标文件(必须**不存在** —— 不覆盖已有备份)
 * @returns {{file: string, sessions: number, turns: number}}
 */
export function backupTo(db, dest) {
  // ⚠️ 路径里的单引号要转义,否则 `VACUUM INTO '...'` 会被拼坏。
  db.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(dest, { readOnly: true });
  try {
    return {
      file: dest,
      sessions: copy.prepare('SELECT COUNT(*) n FROM session').get().n,
      turns: copy.prepare('SELECT COUNT(*) n FROM turn').get().n,
    };
  } finally {
    copy.close();
  }
}

/**
 * 从这个**快照**里把现在缺失的会话/轮次补回来(**只增不改**,可反复跑)。
 *
 * 为什么需要它(2026-10-01 现场):守护的会话保留策略删掉了 13 个老会话目录,而我做了
 * 一次判据改版重导 → 67 轮不可再生地没了。**但它们并没有真的消失**:
 * SQLite 是 WAL 模式,主库文件里还是**上一个检查点**的状态(`data\<bot>\memory.db`,不含 `-wal`),
 * 把那个文件单独复制出来读,就能看到丢之前的样子。
 *
 * ⚠️ 两个前提,别当成万能:
 *   1. 快照的**表结构要跟现在兼容**(列对不上会直接报错,不会乱写);
 *   2. 它只能补"**现在没有**"的行 —— 已经有的不会覆盖(所以不会把当前判据改回去)。
 *
 * @param {DatabaseSync} db 目标库(活的那只)
 * @param {string} snapshotFile 快照文件(比如从主库文件复制出来的一份)
 * @param {{now?: number}} [options]
 * @returns {{sessions: number, turns: number, tags: number}}
 */
export function restoreFrom(db, snapshotFile, { now = Date.now() } = {}) {
  const snap = new DatabaseSync(snapshotFile, { readOnly: true });
  try {
    const liveSessions = new Set(db.prepare('SELECT id FROM session').all().map((row) => row.id));
    const liveTurns = new Set(
      db.prepare("SELECT session_id || '#' || seq AS id FROM turn").all().map((row) => row.id),
    );
    // ⚠️ 列名写死(不用 SELECT *):快照太老时**报错**比悄悄少写一列好。
    const sessions = snap.prepare(
      'SELECT id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at FROM session',
    ).all().filter((row) => !liveSessions.has(row.id));
    const turns = snap.prepare(
      `SELECT session_id, seq, at, turn_no, kind, topic, mood, max_chars, max_sentences, interjection,
              state_line, nudge, user_text, user_chars, reply_at, reply_text, reply_chars, silent,
              in_tokens, out_tokens, cache_read_tokens, reasoning_tokens
         FROM turn`,
    ).all().filter((row) => !liveTurns.has(`${row.session_id}#${row.seq}`));

    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO session (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT OR IGNORE INTO turn (session_id, seq, at, turn_no, kind, topic, mood, max_chars, max_sentences,
         interjection, state_line, nudge, user_text, user_chars, reply_at, reply_text, reply_chars, silent,
         in_tokens, out_tokens, cache_read_tokens, reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTag = db.prepare(
      `INSERT OR IGNORE INTO memory_tag (session_id, seq, tag, source, created_at) VALUES (?, ?, ?, 'rule', ?)`,
    );

    let tags = 0;
    db.exec('BEGIN');
    try {
      for (const row of sessions) {
        insertSession.run(
          row.id, row.conversation, row.scene, row.target, row.generation,
          row.created_at, row.cwd, row.file, row.turns, row.imported_at,
        );
      }
      for (const row of turns) {
        insertTurn.run(
          row.session_id, row.seq, row.at, row.turn_no, row.kind, row.topic, row.mood,
          row.max_chars, row.max_sentences, row.interjection, row.state_line, row.nudge,
          row.user_text, row.user_chars, row.reply_at, row.reply_text, row.reply_chars, row.silent,
          row.in_tokens, row.out_tokens, row.cache_read_tokens, row.reasoning_tokens,
        );
        // 补回来的行按**当前**词表重贴标签(标签只依赖 kind + user_text)。
        // ⚠️ 带上 `session_id`:工具会话(摘要/自检)的轮次不是人说的话(D135),
        //    而这批行是**刚导进来的**,kind 已经按新规则标好、这里只是同一口径再兜一次。
        for (const tag of tagsForTurn({ kind: row.kind, user_text: row.user_text, session_id: row.session_id })) {
          insertTag.run(row.session_id, row.seq, tag, now);
          tags += 1;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { sessions: sessions.length, turns: turns.length, tags };
  } finally {
    snap.close();
  }
}

/**
 * 取一个会话的记忆:累计事实 + 最近若干轮(新的在前)。
 *
 * **默认排除播报轮**(`kind='announce'`):那一轮的"用户消息"是 bridge 自己写的系统指令,
 * 回复是整篇更新日志 —— 它不是对话,而且会把交接的预算吃光(实测:协作角色的私聊记忆里
 * 10 条"最近几轮"有 5 条是播报)。归档里留着,交接时不带。
 *
 * ⚠️ **第二道闸:注入块也不是"人说的话"**(2026-10-02 补,D39 那条的收尾)。
 * 上一代会话的**交接块**(`【记忆交接】…`)在会话记录里是一条 `user/message`,
 * 于是它会被当成"最近几轮"**原样喂回去** —— 当年实测能在 `verify-dsh.js --handoff`
 * （该脚本已随 6B 退役）的输出里直接看见它连着出现，作为用户发言出现(摘要套摘要,还占掉
 * 1400 字预算里的位置)。
 * `kind` 认不出它(它的 kind 与真人发言一样),只能看正文 —— 复用 `isInjectedBlock`,
 * 与标签层 / 回扫 / 固化那三处**同一道判据**(判据只写一处)。
 *
 * ⚠️ `aggregate`(一共聊过 N 轮)照旧走 SQL 计数,不跟着过滤:给它扫全库不值得,
 * 而注入块**每代每段会话只有一条**(重启才写一次),对那个数的影响可以忽略。
 *
 * @param {DatabaseSync} db
 * @param {string} conversation `qqbot-group-<openid>` / `qqbot-c2c-<openid>`
 * @param {number} limit
 * @param {{excludeKinds?: string[]}} [options]
 */
export function conversationMemory(db, conversation, limit = 120, { excludeKinds = ['announce'] } = {}) {
  // ⚠️ 会话隔离用 `session.conversation = ?`(**精确**,与 candidatesFor 同一条口径——不是
  //    `session_id LIKE '<键>%'` 前缀)。2026-10-22 修复:6B 后 own 轮的 session_id 是
  //    `own:<base64url(键)>:<resetId>`,前缀根本不是会话键,LIKE 一条都匹配不上——
  //    滚动摘要/交接只见 6B 前旧轮(两库缺口 1481 轮),而重算判据走 session 表数得到新轮,
  //    于是每过间隔把同一份旧窗口**反复重摘白付钱**(摘要台架 summary-ab 实测抓到)。
  const skip = excludeKinds.length > 0
    ? ` AND kind NOT IN (${excludeKinds.map(() => '?').join(',')})`
    : '';
  const args = excludeKinds.length > 0 ? [conversation, ...excludeKinds] : [conversation];
  // F1 读闸:own 迁移未完成时,派生正文按统一投影现算再消费(见 ownDerivedProjectionReady)。
  const ready = ownDerivedProjectionReady(db);

  const aggregate = db.prepare(
    `SELECT COUNT(*) AS turns, MIN(t.at) AS first_at, MAX(t.at) AS last_at
       FROM turn t JOIN session s ON s.id = t.session_id
      WHERE s.conversation = ?${skip}`,
  ).get(...args);
  // ⚠️ 过滤放在 JS 里,所以**分页取**(不能 `LIMIT limit` 之后再滤 —— 那样会少给几条,
  //    而且是静默少给)。注入块很稀,正常情况下第一页就够。
  const pageSize = Math.max(50, Math.min(500, limit));
  const rows = [];
  for (let offset = 0; rows.length < limit; offset += pageSize) {
    const page = db.prepare(
      `SELECT t.session_id AS session_id, t.seq AS seq, t.at AS at, t.kind AS kind, t.mood AS mood,
              t.user_text AS user_text, t.reply_text AS reply_text, t.silent AS silent,
              s.file AS session_file
         FROM turn t JOIN session s ON s.id = t.session_id
        WHERE s.conversation = ?${skip} ORDER BY t.at DESC LIMIT ? OFFSET ?`,
    ).all(...args, pageSize, offset);
    if (page.length === 0) break;
    for (const row of page) {
      row.user_text = projectDerivedRead(row, ready);
      if (isInjectedBlock(row.user_text)) continue;
      // ⚠️ 注入残文(2026-10-22)同样不进这份取样口 —— 摘要与交接共用它(见上)。
      //    判 kind 就够(归档写路径已标),不用再跑一遍规则;`aggregate` 照旧不过滤
      //    (那是账本计数,"一共聊过多少轮"不因标记而变)。
      if (row.kind === RESIDUE_KIND) continue;
      rows.push(row);
      if (rows.length >= limit) break;
    }
  }
  // ⚠️ `session_id` / `seq` 也要带上(2026-10-02):滚动摘要(D91)需要给每一轮一个稳定 id
  //    (与 note.source / access.source 同一套),交接本身用不到这两列。
  return { aggregate, rows };
}

/**
 * 造一个"交接提供者" —— own 引擎要的就是这个形状。
 *
 * 抽出来是为了**能被独立验证**（原先 `scripts\verify-dsh.js --handoff <会话>` 用的就是它；
 * 那个脚本已随 6B 退役，现在这条路由 `scripts\probe-own-main.mjs` 这类探针覆盖），
 * 所以"她到底记不记得"可以在不启动 bridge、不惊动群的情况下真跑一次。
 * (`src/index.js` 在它外面再包一层"`/重置` 之后不交接"。)
 *
 * @param {{db: DatabaseSync, budget?: number, recent?: number, limit?: number}} options
 * @returns {(conversationKey: string) => Promise<string|null>}
 */
export function makeHandoffProvider({
  db,
  budget = 1400,
  recent = 10,
  limit = 200,
  summary = false,
  summaryBudget = 480,
} = {}) {
  return async function handoff(conversationKey) {
    const memory = conversationMemory(db, conversationKey, limit);
    // 第三层(滚动摘要,D91)。⚠️ **这里只读缓存,绝不调模型** ——
    //    交接是在 `runTurn` **内部**被 await 的,而模型调用也要走同一个 `runner`;
    //    在这里再发一个请求 = **同一个子进程里套第二个请求**(死锁)。
    //    所以摘要由别处的拍子算好、存进库,这里只负责"有就用"。
    let summaryText = null;
    if (summary) {
      try {
        // T1-C(2026-10-29)读时版本闸:旧装配口径(摘要任务跨来源共享会话)生成的摘要不直接入口,
        // 交接回落原文层;summaryDue 已把版本不符判为 due,下一拍按新规则重算。原行保留不删。
        const row = getSummary(db, conversationKey);
        summaryText = row && Number(row.version) === Number(SUMMARY_VERSION) ? row.text : null;
        if (row && summaryText === null && String(row.text ?? '').trim() !== '') {
          log.info(`滚动摘要：${conversationKey} 旧规则 v${row.version} 摘要暂不入口，等按 v${SUMMARY_VERSION} 重算`);
        }
        const plan = summaryPlan(db, { conversation: conversationKey, recent });
        if (plan.due) {
          log.info(`滚动摘要：${plan.reason} —— 这一代先用${summaryText ? '旧摘要' : '原文那一层'}，等下次拍子重算`);
        }
      } catch (err) {
        log.warn(`读取滚动摘要失败（不影响交接）: ${err.message}`);
      }
    }
    return buildHandoffWithSummary({
      rows: memory.rows,
      aggregate: memory.aggregate,
      who: String(conversationKey).includes('-group-') ? '这个群' : '私聊',
      budget,
      recent,
      summary: summaryText,
      summaryBudget,
    });
  };
}

/**
 * 按配置造交接提供者 —— **生产与测试共用同一处接线**(P0-1,2026-10-18)。
 *
 * 为什么要有这一层薄壳:`makeHandoffProvider` 的 `summary` 默认 `false`,而生产
 * 调用点原来只传 db/budget/recent —— 于是摘要表**每 3 小时算一次、从没进过 prompt**
 * (只有 `/忘了 摘要` 会读它)。这个 bug 是"生产装配代码 + 默认参数"两处合起来造成的,
 * 单测怎么测 provider 都测不到。抽出来以后:接线本身就是可测函数,不再靠人去读 index.js。
 *
 * @param {{db: DatabaseSync, memoryCfg: object}} options
 * @returns {(conversationKey: string) => Promise<string|null>}
 */
export function makeHandoffFromConfig({ db, memoryCfg } = {}) {
  if (!db) return null;
  const summaryCfg = memoryCfg?.summary ?? {};
  return makeHandoffProvider({
    db,
    budget: memoryCfg?.budget,
    recent: memoryCfg?.recent,
    // 只有**显式开启**才算开:配置缺字段/旧对象一律按关(与默认值一致,不偷偷改变行为)。
    summary: summaryCfg.enabled === true,
    summaryBudget: summaryCfg.budget,
  });
}

/** 归档是否新鲜、有几只机器人写了进来 —— 给 `handoff.js` 与启动横幅用。 */
export function memorySummary(db) {
  const archivedAt = db.prepare("SELECT value FROM meta WHERE key = 'archived_at'").get()?.value ?? null;
  return {
    sessions: db.prepare('SELECT COUNT(*) n FROM session').get().n,
    turns: db.prepare('SELECT COUNT(*) n FROM turn').get().n,
    archivedAt,
  };
}

// ---------------------------------------------------------------------------
// 中期 / 长期记忆:固化"值得记住的事"(D78)
// ---------------------------------------------------------------------------

/**
 * note 表的**P1-C 新列**(ADD-only 软失效,2026-10-19)。顺序固定,`ensureNoteSchema` 按它补。
 * ⚠️ 与 `memory-archive.js` 的 `MEMORY_SCHEMA` 是**同一张表的两处描述**:那边管新库建表,
 *    这边管老库补列 —— 列名/类型两边必须一致(`selftest-memory-note-supersede` 钉着)。
 */
const NOTE_LATE_COLUMNS = Object.freeze([
  ['superseded_by', 'INTEGER'],
  ['merged_into', 'INTEGER'],
  ['invalid_at', 'INTEGER'],
]);

/** note 表有没有这一列?老库没迁移过时,读路径要**退回旧行为**,而不是报 no such column。 */
function hasNoteColumn(db, name) {
  try {
    return db.prepare('PRAGMA table_info(note)').all().some((col) => col.name === String(name));
  } catch {
    return false;
  }
}

/**
 * **给老库的 note 表补 P1-C 那三列**(ADD-only 软失效)。
 *
 * 与 `ensureFtsSchema` 同一个形状与边界:
 *   · 新库由 `MEMORY_SCHEMA` 直接带列;老库的表已经存在,`CREATE TABLE IF NOT EXISTS`
 *     不会改它 ⇒ 只能 `ALTER TABLE ... ADD COLUMN` 补;
 *   · **不抛**:只读连接(离线演练、备份回读)走到这里会失败,返回 ok:false 让调用方退回旧行为
 *     —— 和 `hasAccessTable` / `ensureFtsSchema` 同一条纪律:新代码遇到没迁移的库只该降级,
 *     不该把启动或整轮对话带崩;
 *   · **幂等**:已经有列就跳过,反复跑无副作用。
 * ⚠️ **不动 `MEMORY_VERSION`**(与 `fts_text` 同一先例):只加列不改判据,不需要破坏性重导(D77)。
 *
 * @param {DatabaseSync} db
 * @returns {{ok: true, added: string[]} | {ok: false, error: string}}
 *   `added` 是本次真的补上的列名(老库第一次跑 = 缺的那几列;已迁移过 = 空数组)。
 */
export function ensureNoteSchema(db) {
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(note)').all().map((col) => col.name));
    const added = [];
    for (const [name, type] of NOTE_LATE_COLUMNS) {
      if (cols.has(name)) continue;
      db.exec(`ALTER TABLE note ADD COLUMN ${name} ${type}`);
      added.push(name);
    }
    return { ok: true, added };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** note.source 是 `会话#seq`;取回 seq 用于 (at, seq) 的正序比较。 */
function seqOfNoteSource(source) {
  const text = String(source ?? '');
  const cut = text.lastIndexOf('#');
  return cut >= 0 ? Number(text.slice(cut + 1)) || 0 : 0;
}

/** 冲突里"谁更旧":先比 at,同一毫秒再比 seq。返回 <0 = a 更旧。 */
function compareNoteAge(a, b) {
  const atA = Number(a?.at) || 0;
  const atB = Number(b?.at) || 0;
  if (atA !== atB) return atA - atB;
  return (Number(a?.seq) || 0) - (Number(b?.seq) || 0);
}

/**
 * P1-C 冲突判定核心:**一条新说法(fresh)与已处理的仍有效 note 之间,谁取代谁。**
 *
 * **`consolidate`(写时)与 `reconcileNoteSupersedes`(历史一次回溯)共用这一份判据** ——
 * 两处各写一遍必然漂(D159:不许写第二份"必须一致"的实现);而
 * 「consolidate 已经收敛的库再跑 reconcile 应当 conflicts=0」就是钉这个的测试。
 *
 * 语义与 `consolidate` 原来的内层循环逐一对应:
 *   · 逐条 claim、逐条 existing(跳过已失效的),只认"**同 kind、value 不同**";
 *   · existing 比 fresh **新** ⇒ fresh 是历史补录(一插入就失效),返回 `freshOlder` + 那条更新的;
 *   · existing 比 fresh **旧** ⇒ 那条 existing 退役,收进 `victims`(fresh 保留);
 *   · fresh 一旦被判失效就**不再去退役别人**(否则两条会互指、可能一条有效都不剩)。
 *
 * @param {Array<{id: number, at: number, seq: number, text: string,
 *   claims: Array<{kind: string, value: string}>, invalid?: boolean}>} existing 已处理的 note(带 claims)
 * @param {{id: number, at: number, seq: number, claims: Array<{kind: string, value: string}>}} fresh
 * @returns {{freshOlder: boolean,
 *   newer: {kind: string, value: string, freshValue: string, other: object}|null,
 *   victims: Array<{kind: string, value: string, freshValue: string, other: object}>}}
 *   `newer` = 让 fresh 变成历史补录的那条;`victims` = 该被 fresh 取代的既有 note(原引用)。
 */
function noteSupersedePlan(existing, fresh) {
  const victims = [];
  const claimed = new Set();
  for (const claim of fresh.claims ?? []) {
    for (const other of existing) {
      if (other.invalid || other.id === fresh.id) continue;
      const matched = (other.claims ?? []).find(
        (candidate) => candidate.kind === claim.kind && candidate.value !== claim.value,
      );
      if (!matched) continue;
      if (compareNoteAge(other, fresh) > 0) {
        return {
          freshOlder: true,
          newer: { kind: claim.kind, value: matched.value, freshValue: claim.value, other },
          victims,
        };
      }
      // 同一条 existing 可能被 fresh 的多个 claim 命中 —— 只退役一次(原来靠 other.invalid 挡住)。
      if (claimed.has(other.id)) continue;
      claimed.add(other.id);
      victims.push({ kind: claim.kind, value: matched.value, freshValue: claim.value, other });
    }
  }
  return { freshOlder: false, newer: null, victims };
}

/**
 * **回头**(consolidate):把最近一段的轮次按代码算的分过一遍,够分的固化成 `note`。
 *
 * 这就是用户说的「**每天分几次回头记录熵值高的信息**」。它跟"标签检索"是两条路:
 *   · 标签检索 = **被动**(有人问到相关话题才想起来);
 *   · 固化 = **主动**(没人问,但这条重要 → 它进了库,读取侧有独立通道)。
 *
 * 幂等:唯一键是 `source`(`session_id#seq`),跑第二次只会补新的。
 *
 * ## P1-C(2026-10-19):新旧说法冲突 → **软失效**,不物理删
 *
 * 规则版(**零模型调用**):同一段会话(c2c)里两条 note 用**同一套事实抽取**(`noteClaims`,
 * 即 `extractFacts`)抽出**同一个 kind、value 不同** ⇒ 较旧(`at` 小)那条
 * `invalid_at = now`、`superseded_by = 新行 id`;新行若比已有的更旧(**历史补录**),
 * 则**一插入就被标失效**,`superseded_by` 指向更新的那条 —— 旧说法不许把新说法顶掉。
 * 不删行:被取代的说法以后又被说出来时,要能重新落一条有效行(ADD-only)。
 *
 * ⚠️ **只在 c2c 生效**(判 `session.scene`):群聊归档拿不到发言人
 * (`memory-archive.js` 头注),同 kind 很可能是**不同人的不同偏好**,判成"新说法取代旧说法"
 * 就是误伤。这是**有意收窄**,不是漏了群聊。
 *
 * @param {object} options
 * @param {number} [options.windowMs] 最多往回看多久(默认 3 天)—— 第一次跑时别把全库翻一遍
 * @param {number} [options.max] 一拍最多处理多少轮(默认 300,防一次吃太多)
 * @param {string[]} [options.peopleNames]
 * @returns {{scanned: number, mid: number, long: number, superseded: number, samples: string[]}}
 *   `mid` / `long` 是**插入**的条数(含一插入就失效的历史补录);
 *   `superseded` 是这一拍**被标失效**的行数(旧说法退役 + 历史补录一插入就失效),给日志用。
 */
export function consolidate(db, {
  now = Date.now(),
  windowMs = 3 * 24 * 3600 * 1000,
  max = 300,
  peopleNames = [],
} = {}) {
  const stored = Number(db.prepare("SELECT value FROM meta WHERE key = 'consolidated_at'").get()?.value);
  void stored;
  // ⚠️ 下界**只看窗口**,不看上次跑到哪:`NOT EXISTS(note)` 已经把"记过的"排掉了,
  //    再按 `at DESC` 取一批 → **每跑一次都会往更早的历史推进一批**(bootstrap 可以连跑几次)。
  const since = now - windowMs;
  const slots = NON_MEMORY_KINDS.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT t.session_id, t.seq, t.at, t.kind, t.user_text, s.conversation, s.scene,
            s.file AS session_file
       FROM turn t JOIN session s ON s.id = t.session_id
      WHERE t.at > ? AND t.kind NOT IN (${slots}) AND length(t.user_text) > 0
        AND NOT EXISTS (SELECT 1 FROM note n WHERE n.source = t.session_id || '#' || t.seq)
      ORDER BY t.at DESC LIMIT ?`,
  ).all(since, ...NON_MEMORY_KINDS, Math.max(1, Math.min(2000, max)));
  // F1 读闸:迁移未完成的 own 行先按统一投影现算,再进打分/固化(原档与 note 不动)。
  const projectionReady = ownDerivedProjectionReady(db);
  for (const row of rows) row.user_text = projectDerivedRead(row, projectionReady);
  // ⚠️ **工具会话(摘要/自检/评测)的"用户消息"是提示词,不是人说的话**(2026-10-06,D135)。
  //    新行现在会被归档层标成 `kind='tool'`(已在 NON_MEMORY_KINDS 里),但**旧库里的行**
  //    还是 `mention` —— 不能靠重导来治(源文件可能已被保留策略删掉,见 D77),
  //    所以这里按会话 id 再挡一次。实测:不挡的话当前角色 46 条固化里 9 条是摘要指令原文。
  const candidates = rows.filter((row) => !isToolConversation(row.session_id) && !isToolConversation(row.conversation));
  // ⚠️ **P1-C 生效顺序**:SQL 取的是"最近的 max 条"(at DESC),但**冲突判定必须按时间正序** ——
  //    否则一次历史补录(bootstrap 连跑几次会往更早推进)里,旧说法会先把新说法顶掉。
  //    排序只改判定顺序;`scanned` 仍是本拍取到的候选数。
  candidates.sort((a, b) => compareNoteAge(a, b));

  // P1-C 软失效要 note 表有那三列。**这里也补一次**(幂等):不依赖调用方是否已经接线
  // ensureNoteSchema —— 补不上(只读连接)时**不抛**,这一拍退回 P1-B 的"只加不失效"行为。
  const noteSchema = ensureNoteSchema(db);
  const canSupersede = noteSchema.ok && hasNoteColumn(db, 'invalid_at');
  if (!canSupersede) {
    log.warn(
      `记忆固化：note 表补不上软失效列（${noteSchema.ok ? '没有 invalid_at 列' : noteSchema.error}）` +
      '—— 这一拍不做新旧说法冲突检测',
    );
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO note (conversation, source, at, created_at, tier, score, reasons, tags, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  /** 把一条 note 标失效(不物理删)。只在它还有效时生效,所以重复标不会多算。 */
  const invalidate = db.prepare(
    'UPDATE note SET invalid_at = ?, superseded_by = ? WHERE id = ? AND invalid_at IS NULL',
  );
  let mid = 0;
  let long = 0;
  let superseded = 0;
  const samples = [];
  // ⚠️ **同样的话只固化一次**(2026-10-01 实测):测试用的同一句指令出现过三次,
  //    于是中期记忆里躺着三条一模一样的东西。按 `text` 去重(每段会话各算各的)。
  //    ⚠️ P1-C:只把**有效**的算进去 —— 失效的说法以后又被说出来时能重新落一条有效行。
  const seenByConversation = new Map();
  const noteTextRows = canSupersede
    ? db.prepare('SELECT conversation, text FROM note WHERE invalid_at IS NULL').all()
    : db.prepare('SELECT conversation, text FROM note').all();
  for (const row of noteTextRows) {
    if (!seenByConversation.has(row.conversation)) seenByConversation.set(row.conversation, new Set());
    seenByConversation.get(row.conversation).add(row.text);
  }
  /** 这段会话里**仍有效**的 note(冲突判定的对照面);事务内按需加载,并随本拍插入/失效更新。 */
  const validNotes = new Map();
  const notesInConversation = (conversation) => {
    if (validNotes.has(conversation)) return validNotes.get(conversation);
    const list = canSupersede
      ? db.prepare('SELECT id, source, at, text FROM note WHERE conversation = ? AND invalid_at IS NULL')
        .all(conversation)
        .map((row) => ({
          id: Number(row.id),
          at: Number(row.at),
          seq: seqOfNoteSource(row.source),
          text: String(row.text ?? ''),
          invalid: false,
          claims: noteClaims(String(row.text ?? '')),
        }))
      : [];
    validNotes.set(conversation, list);
    return list;
  };
  db.exec('BEGIN');
  try {
    for (const row of candidates) {
      // 注入块(交接/系统提示)不是"人说的话" —— 与标签层同一道闸。
      if (isInjectedBlock(row.user_text)) continue;
      const { score, tier, tags, reasons } = scoreTurn({ kind: row.kind, user_text: row.user_text }, { peopleNames });
      if (!tier) continue;
      const clean = cleanMemoryText(row.user_text).slice(0, 300);
      if (clean === '') continue;
      const known = seenByConversation.get(row.conversation) ?? new Set();
      if (known.has(clean)) continue; // 同一段会话里同样的话只记一次
      const result = insert.run(
        row.conversation, `${row.session_id}#${row.seq}`, row.at, now, tier, score,
        reasons.join('；'), tags.join(','), clean,
      );
      if (result.changes === 0) continue;
      const noteId = Number(result.lastInsertRowid);
      if (tier === 'long') long += 1; else mid += 1;
      // 留几条样本给日志 —— 判据②:要能看出"它凭什么觉得这条值得记"。
      if (samples.length < 3) samples.push(`${tier} ${score} 分：${reasons.join('、')}`);

      // ---- P1-C:新旧说法冲突(规则版,零模型调用)----
      const fresh = {
        id: noteId,
        at: Number(row.at),
        seq: Number(row.seq),
        text: clean,
        invalid: false,
        claims: canSupersede ? noteClaims(clean) : [],
      };
      // ⚠️ 群聊**不做**(判 scene):归档拿不到发言人,同 kind 很可能是不同人的不同偏好。
      const conflictAllowed = canSupersede && row.scene === 'c2c' && fresh.claims.length > 0;
      if (conflictAllowed) {
        const existing = notesInConversation(row.conversation);
        // 判定本身在 noteSupersedePlan 里 —— 与 reconcileNoteSupersedes(历史回溯)**同一份**
        // 判据(D159)。这里只负责把它的结论落成 SQL。
        const plan = noteSupersedePlan(existing, fresh);
        if (plan.freshOlder) {
          // 已有那条**更新** ⇒ 这条是历史补录:一插入就失效,指向更新的那条。
          if (invalidate.run(now, plan.newer.other.id, noteId).changes > 0) {
            fresh.invalid = true;
            superseded += 1;
          }
        } else {
          for (const victim of plan.victims) {
            // 已有那条更旧 ⇒ 旧说法退役,新行指过去(不物理删)。
            if (invalidate.run(now, noteId, victim.other.id).changes > 0) {
              victim.other.invalid = true;
              superseded += 1;
              known.delete(victim.other.text); // ADD-only:那句话以后再说,要能重新落一条有效行
            }
          }
        }
        existing.push(fresh);
      }
      // ⚠️ 去重只收**有效**的说法:历史补录一插入就失效的那条不算"说过"(ADD-only)。
      if (!fresh.invalid) {
        known.add(clean);
        seenByConversation.set(row.conversation, known);
      }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('consolidated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(now));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { scanned: candidates.length, mid, long, superseded, samples };
}

/**
 * **历史冲突的一次性回溯软失效(note 侧,P1-C 补账,2026-10-19;用户当天拍板)。**
 *
 * 为什么需要它:P1-C 的 `consolidate` 只在**写的那一刻**判新旧说法;老库里**早就并存**的
 * 冲突(同一段 c2c 会话里两条互相矛盾的说法都还是 `invalid_at IS NULL`)不会被追溯,
 * 读取侧会**同时端出**它们。这个函数把每段 c2c 会话里仍有效的 note 按 `(at, seq)` 正序
 * 重放一遍,把被更新说法取代的行软失效。
 *
 * 边界(与 `consolidate` 完全同一套,不是漏了):
 *   · **只处理 `session.scene = 'c2c'` 的会话** —— 群聊归档拿不到发言人
 *     (`memory-archive.js` 头注),同 kind 很可能是**不同人的不同偏好**,判成"新说法取代旧说法"就是误伤;
 *   · **只软标记、不物理删**:旧行 `invalid_at = now`、`superseded_by` 指向取代它的那行;
 *     `latestOnly:false` / `notesOf(latestOnly:false)` 仍能审计;
 *   · `dryRun:true` **一个字节都不写**;`--apply` 之后**幂等**(再跑 conflicts=0);
 *   · 只读连接 / 老库补不上列 ⇒ 返回 `ok:false` **不抛**(调用方跳过即可,不影响正常记忆);
 *   · 判据与 `consolidate` **共用** `noteSupersedePlan` 这一份(D159)。规则一旦漂,
 *     「consolidate 已收敛的库再 reconcile → conflicts=0」那条测试会红。
 *
 * @param {import('node:sqlite').DatabaseSync} db 记忆库(`openMemory` 打开的写连接)
 * @param {{now?: number, dryRun?: boolean}} [options]
 * @returns {{ok: true, dryRun: boolean, conversations: number, notes: number, conflicts: number,
 *   invalidated: Array<{id: number, conversation: string, text: string, kind: string,
 *     oldValue: string, newValue: string, supersededBy: number}>}
 *   | {ok: false, error: string}}
 *   `conversations` = 扫到的 c2c 会话段数;`notes` = 其中仍有效的 note 行数;
 *   `conflicts` = 将被/已被软失效的行数。
 */
export function reconcileNoteSupersedes(db, { now = Date.now(), dryRun = false } = {}) {
  // ① 老库补列(ADD-only 软失效的前提)。只读连接上它会失败 → 如实 ok:false,不抛。
  const schema = ensureNoteSchema(db);
  if (!schema.ok) return { ok: false, error: schema.error };
  const hasSession = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get(),
  );
  // ② 没有 session 表就**判不出 scene** —— 明说,不静默当成"没有冲突"。
  if (!hasSession) return { ok: false, error: '记忆库没有 session 表，无法判定 c2c 会话' };

  const rows = db.prepare(
    `SELECT n.id AS id, n.conversation AS conversation, n.source AS source, n.at AS at, n.text AS text
       FROM note n
       JOIN (SELECT DISTINCT conversation FROM session WHERE scene = 'c2c') s
         ON s.conversation = n.conversation
      WHERE n.invalid_at IS NULL
      ORDER BY n.conversation, n.at, n.id`,
  ).all();

  // ③ 按会话分组,组内按 (at, seq) 正序重放 —— 与 consolidate 的判定顺序一致(历史补录不能顶掉新说法)。
  const conversations = new Map();
  for (const row of rows) {
    const conversation = String(row.conversation);
    const item = {
      id: Number(row.id),
      at: Number(row.at),
      seq: seqOfNoteSource(row.source),
      text: String(row.text ?? ''),
      claims: noteClaims(String(row.text ?? '')),
      invalid: false,
    };
    const list = conversations.get(conversation);
    if (list) list.push(item);
    else conversations.set(conversation, [item]);
  }

  const invalidated = [];
  for (const [conversation, list] of conversations) {
    list.sort((a, b) => compareNoteAge(a, b) || a.id - b.id);
    const existing = [];
    for (const fresh of list) {
      const plan = noteSupersedePlan(existing, fresh);
      if (plan.freshOlder) {
        // 这条比库里已有的说法**更旧** ⇒ 一进来就失效,指向那更新的(与写时历史补录同一行为)。
        fresh.invalid = true;
        invalidated.push({
          id: fresh.id,
          conversation,
          text: fresh.text,
          kind: plan.newer.kind,
          oldValue: plan.newer.freshValue,
          newValue: plan.newer.value,
          supersededBy: Number(plan.newer.other.id),
        });
      } else {
        for (const victim of plan.victims) {
          victim.other.invalid = true;
          invalidated.push({
            id: Number(victim.other.id),
            conversation,
            text: victim.other.text,
            kind: victim.kind,
            oldValue: victim.value,
            newValue: victim.freshValue,
            supersededBy: fresh.id,
          });
        }
      }
      existing.push(fresh);
    }
  }

  if (!dryRun && invalidated.length > 0) {
    const invalidate = db.prepare(
      'UPDATE note SET invalid_at = ?, superseded_by = ? WHERE id = ? AND invalid_at IS NULL',
    );
    db.exec('BEGIN');
    try {
      for (const row of invalidated) invalidate.run(now, row.supersededBy, row.id);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也只能让原错误冒出去 */
      }
      throw err;
    }
  }

  return {
    ok: true,
    dryRun,
    conversations: conversations.size,
    notes: rows.length,
    conflicts: invalidated.length,
    invalidated,
  };
}

/**
 * **近重复合并计划(P1-D,2026-10-19;方案 `项目\方案-记忆系统升级-P1后段与P2-2026-10-19.md` §3)。**
 *
 * 要治的形状:同一句话说两遍(`cleanMemoryText` 后逐字相同)或几乎同义(向量余弦高),
 * 会作为两条 note **各自占一份注入预算** —— 合并后旧的写 `merged_into` 指向保留的那条,
 * 读路径默认不再端出(与 `invalid_at` 同族,但**语义不同**:合并 ≠ 失效,只是"同义重复")。
 *
 * 两阶段(照搬 Mem0 / Zep 的近重复 dedupe:先精确、再向量):
 *   ① **精确**:同会话内 `cleanMemoryText` 后逐字相同 → 并成一组;
 *   ② **余弦**:①之后的组代表之间,同会话、双方 clean 文本 **≥ `minChars` 字**(「嘻嘻」这类
 *      短句不参与,避免噪声)、各自向量都在 `embedding` 表里且 **model 相同**(换了模型的
 *      旧向量不能拿来比,`embeddingMap` 同一条纪律)、余弦 **≥ `threshold`** → 并成一组。
 *
 * 保留哪条:**分(score)最高 → at 最新 → id 最大**,旧的写 `merged_into` 指向它。
 *
 * 边界(与 `reconcileNoteSupersedes` 同一套安全纪律):
 *   · **只处理仍有效的行**(`invalid_at IS NULL AND merged_into IS NULL`)—— 被软失效的、
 *     已合并的不回来;所以 `--apply` 之后**幂等**(再跑 groups=0);
 *   · **只软标记、不物理删**:`latestOnly:false` / 审计路径仍能翻出来;`merged_into` 可清空回滚;
 *   · `dryRun:true` **一个字节都不写**;只读连接 / 老库补不上列 ⇒ 返回 `ok:false` 不抛;
 *   · **不改 `MEMORY_VERSION`**(只加列不改判据,同 `ensureNoteSchema` 的先例);
 *   · **合并只在同会话内**(群聊 note 跨发言人,跨会话的相似可能是不同人的不同事)。
 *
 * 上线前候选对**人工复核**;复核后的落地形状是**白名单制**(2026-10-19 主人拍板):
 * 余弦候选在真库上的误并率 89%(「吃」簇短句在 bge-small-zh 里 0.91~0.96 纠缠,真同义对
 * 0.9225 比误并对 0.9621 分还低 —— 没有可用的阈值线),所以**余弦成员只有出现在
 * `onlyIds` 里才写库**;精确去重(逐字相同)零风险,不受白名单约束。
 *
 * @param {import('node:sqlite').DatabaseSync} db 记忆库(`openMemory` 打开的连接)
 * @param {{threshold?: number, minChars?: number, dryRun?: boolean,
 *   onlyIds?: Iterable<number>|null}} [options]
 *   `onlyIds` = 人工点头允许合并的**余弦成员** note id 全集;null/省略 = 还没走人工复核,
 *   此时 `apply` 会**拒绝执行**(fail closed —— 候选对必须有人点过头)。
 * @returns {{ok: true, dryRun: boolean, threshold: number, minChars: number,
 *   notes: number, compared: number, vectorless: number, short: number,
 *   edges: Array<{a: number, b: number, via: 'exact'|'cosine', cos: number|null}>,
 *   groups: Array<{canonical: {id: number, text: string, score: number, at: number},
 *     members: Array<{id: number, text: string, score: number, at: number, via: string, cos: number|null}>}>,
 *   merges: number, skipped: number}
 *   | {ok: false, error: string}}
 *   `notes` = 参与判定的有效行数;`compared` = 实际算过余弦的行对数;
 *   `vectorless` = 文本够长但没有向量(只参与精确去重)的行数;`short` = <minChars 不参与余弦的行数;
 *   `merges` = 将写/已写 `merged_into` 的行数;`skipped` = 白名单外的余弦成员数(dry-run 也报,
 *   就是"这些不会写库"的数量)。
 */
export function planNoteMerges(db, { threshold = 0.9, minChars = 8, dryRun = true, onlyIds = null } = {}) {
  // ① 老库补列(merged_into 在 P1-C 已随三列备好;这里兜底)。只读连接上它会失败 → ok:false,不抛。
  const schema = ensureNoteSchema(db);
  if (!schema.ok) return { ok: false, error: schema.error };

  // ② 取仍有效的 note(未失效、未合并)。按 id 正序,组代表选择才稳定。
  const rows = db.prepare(
    `SELECT id, conversation, source, at, score, text
       FROM note
      WHERE invalid_at IS NULL AND merged_into IS NULL
      ORDER BY id`,
  ).all();
  const items = rows.map((row) => {
    const clean = cleanMemoryText(String(row.text ?? ''));
    return {
      id: Number(row.id),
      conversation: String(row.conversation),
      source: String(row.source),
      at: Number(row.at),
      score: Number(row.score) || 0,
      text: String(row.text ?? ''),
      clean,
      short: clean.length < minChars,
    };
  });

  // ③ 并查集(id → 根 id)。
  const parent = new Map(items.map((item) => [item.id, item.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
    return ra !== rb;
  };

  const edges = [];

  // ④ 阶段①精确:同会话 + clean 全等(空文本不算 —— 没内容的东西没有"重复"可言)。
  const exactSeen = new Map();
  for (const item of items) {
    if (item.clean === '') continue;
    const key = `${item.conversation}\u0000${item.clean}`;
    const first = exactSeen.get(key);
    if (first === undefined) exactSeen.set(key, item);
    else if (union(first.id, item.id)) edges.push({ a: first.id, b: item.id, via: 'exact', cos: null });
  }

  // ⑤ 阶段②余弦:每组派一个代表(组内 id 最小)参加;代表向量从 embedding 表按 source 查。
  //    ⚠️ note 没有自己的向量 —— 用的是它 source 指向那轮 turn 的向量(`会话#seq` 同一套 id,
  //    P0 方案 #8 的实测口径就是它),所以"同 model 才比"必须钉住。
  const vecRows = hasTable(db, 'embedding')
    ? db.prepare('SELECT source, model, vec FROM embedding').all()
    : [];
  const vectors = new Map(); // source -> { model, vec }
  for (const row of vecRows) {
    const key = String(row.source);
    if (!vectors.has(key)) vectors.set(key, { model: String(row.model), vec: unpackVector(row.vec) });
  }
  // 组代表:根 id → 组内 id 最小的行(插入顺序稳定)。
  const reps = new Map();
  for (const item of items) {
    const root = find(item.id);
    const current = reps.get(root);
    if (current === undefined || item.id < current.id) reps.set(root, item);
  }
  // 同会话的代表两两比(双方都得:clean ≥ minChars、有向量、同 model)。
  const byConversation = new Map();
  for (const rep of reps.values()) {
    const list = byConversation.get(rep.conversation);
    if (list) list.push(rep);
    else byConversation.set(rep.conversation, [rep]);
  }
  // 有资格比(非短文本)但没有向量的行数 —— 单独一遍数,不混进配对循环(否则重复计数)。
  const vectorless = items.filter((item) => !item.short && !vectors.has(item.source)).length;
  let compared = 0;
  for (const list of byConversation.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      const va = vectors.get(a.source);
      if (!va) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        const vb = vectors.get(b.source);
        if (!vb) continue; // 任一方没向量就不比(它仍留在精确阶段的结果里)
        if (a.short || b.short) continue; // 短文本不参与余弦(避免「嘻嘻」这类噪声)
        if (va.model !== vb.model) continue; // 换过模型:旧向量不能拿来比
        compared += 1;
        const cos = cosineSimilarity(va.vec, vb.vec);
        if (cos >= threshold && union(a.id, b.id)) {
          edges.push({ a: a.id, b: b.id, via: 'cosine', cos: Number(cos.toFixed(4)) });
        }
      }
    }
  }

  // ⑥ 汇总连通分量(≥2 才是合并组),每组重选 canonical:分最高 → at 最新 → id 最大。
  const clusters = new Map();
  for (const item of items) {
    const root = find(item.id);
    const list = clusters.get(root);
    if (list) list.push(item);
    else clusters.set(root, [item]);
  }
  const groups = [];
  let merges = 0;
  for (const list of clusters.values()) {
    if (list.length < 2) continue;
    const canonical = [...list].sort((a, b) => b.score - a.score || b.at - a.at || a.id - b.id)[0];
    const members = list
      .filter((item) => item.id !== canonical.id)
      .map((item) => {
        // 每个成员的"并上来的那一步":精确(同文本)优先说清,余弦带上当时的分数。
        const edge = edges.find(
          (item2) => (item2.a === item.id || item2.b === item.id)
            && (item2.a === canonical.id || item2.b === canonical.id),
        ) ?? edges.find((item2) => item2.a === item.id || item2.b === item.id);
        return {
          id: item.id,
          text: item.text,
          score: item.score,
          at: item.at,
          via: edge?.via ?? 'exact',
          cos: edge?.cos ?? null,
        };
      });
    merges += members.length;
    groups.push({
      canonical: { id: canonical.id, text: canonical.text, score: canonical.score, at: canonical.at },
      members,
    });
  }

  // ⑦ 白名单(2026-10-19 主人拍板):余弦成员**只有点过头才写**;精确成员不受约束。
  //    `skipped` 在 dry-run 也报 —— 它就是"这些候选不会写库"的数量。
  const allowed = onlyIds ? new Set([...onlyIds].map(Number)) : null;
  const cosineMembers = groups.flatMap((group) => group.members.filter((member) => member.via === 'cosine'));
  const skipped = cosineMembers.filter((member) => !allowed?.has(member.id)).length;
  if (!dryRun && skipped > 0 && !allowed) {
    // fail closed:有人工复核这一关没走,就不许把余弦候选写进真库。
    return {
      ok: false,
      error: `余弦候选 ${skipped} 条还没过人工复核:apply 必须给 onlyIds(点头的成员 id);`
        + '精确去重不受影响,可以单独 apply',
    };
  }
  // merges 口径统一为"将写/已写"(白名单拦掉的不算):dry-run 与 apply 同一把尺。
  merges -= skipped;

  // ⑧ apply:事务写 merged_into(WHERE 再钉一遍"仍有效且未合并",并发下也不写重)。
  if (!dryRun && merges > 0) {
    const merge = db.prepare(
      'UPDATE note SET merged_into = ? WHERE id = ? AND merged_into IS NULL AND invalid_at IS NULL',
    );
    db.exec('BEGIN');
    try {
      for (const group of groups) {
        for (const member of group.members) {
          if (member.via === 'cosine' && !allowed?.has(member.id)) continue; // 白名单外:不写
          merge.run(group.canonical.id, member.id);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也只能让原错误冒出去 */
      }
      throw err;
    }
  }

  return {
    ok: true,
    dryRun,
    threshold,
    minChars,
    notes: items.length,
    compared,
    vectorless,
    short: items.filter((item) => item.short).length,
    edges,
    groups,
    merges,
    skipped,
  };
}

/**
 * **删掉固化记忆**(2026-10-01,D81/D82):`/忘了 记忆 <关键词>` 用。
 *
 * 为什么需要它:固化是**代码按分自动挑的**,一定会挑错(实测把测试指令
 * 「你说一遍:琪露诺…」挑成了中期记忆,于是每轮都被端出来)。
 * 只有"能写不能删"的记忆层是不合格的 —— 所以撤销必须覆盖这里,而不只是 `fact`。
 *
 * ⚠️ 与 `fact` 的撤销一样,**返回删掉的每一条**(回执要逐条念回来)。
 * 值用 `LIKE %…%`(人记不住确切措辞)。
 */
export function forgetNotes(db, { conversation = null, value = null } = {}) {
  if (!conversation) return [];
  const where = ['conversation = ?'];
  const args = [conversation];
  if (value) {
    where.push('text LIKE ?');
    args.push(`%${value}%`);
  }
  const clause = where.join(' AND ');
  const rows = db.prepare(`SELECT source, tier, text FROM note WHERE ${clause}`).all(...args);
  if (rows.length > 0) db.prepare(`DELETE FROM note WHERE ${clause}`).run(...args);
  return rows;
}

/**
 * 这一段会话里固化下来的记忆(最新在前),给 `/忘了` 列出来用。
 *
 * ⚠️ P1-C(2026-10-19):默认 `latestOnly = true` —— `/忘了 记忆` 列出的是"**她还记着的事**",
 * 被新说法取代的行不该再出现在清单里(`false` 可看全部,审计/排错用)。
 */
export function notesOf(db, { conversation = null, limit = 20, latestOnly = true } = {}) {
  if (!conversation) return [];
  const valid = latestOnly && hasNoteColumn(db, 'invalid_at') ? ' AND invalid_at IS NULL' : '';
  // P1-D(2026-10-19):被近重复合并的行默认也不再端出(合并 ≠ 失效,但"同义重复"同样
  // 不该占清单/预算;`latestOnly:false` 审计时全部可见)。
  const merged = latestOnly && hasNoteColumn(db, 'merged_into') ? ' AND merged_into IS NULL' : '';
  return db.prepare(
    `SELECT source, tier, score, text, at FROM note WHERE conversation = ?${valid}${merged} ORDER BY at DESC LIMIT ?`,
  ).all(conversation, Math.max(1, Math.min(100, limit)));
}

/** 库里现在有多少条固化记忆(给启动横幅与报表用)。 */
export function noteStats(db, now = Date.now(), { midTtlMs = 3 * 24 * 3600 * 1000 } = {}) {
  // P1-C:各项只统计**仍有效**的行;`invalid` 单独报被软失效的条数。
  // ⚠️ 老库(还没 ensureNoteSchema)没有 invalid_at 列 → 退回旧行为(全算有效、invalid=0),
  //    不许因为"新代码读到没迁移的库"就报 no such column(记忆坏了只该降级)。
  const soft = hasNoteColumn(db, 'invalid_at');
  const valid = soft ? ' AND invalid_at IS NULL' : '';
  // P1-D(2026-10-19):被合并的行不计入各项,单独报 `merged`(老库没列 → 0,降级不报错)。
  const merged = hasNoteColumn(db, 'merged_into');
  const unmerged = merged ? ' AND merged_into IS NULL' : '';
  // ⚠️ 访问账要**先问表在不在**:只读连接(离线演练、备份回读)建不了表,
  //    而这条查询直接 JOIN 它 —— 表不在时报错会把整只机器人的记忆初始化带崩(D89 现场)。
  const recalled = hasAccessTable(db)
    ? db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(a.use_count), 0) AS uses
         FROM note n JOIN access a ON a.source = n.source
        WHERE a.use_count > 0${soft ? ' AND n.invalid_at IS NULL' : ''}`,
    ).get()
    : { n: 0, uses: 0 };
  return {
    long: db.prepare(`SELECT COUNT(*) n FROM note WHERE tier = 'long'${valid}${unmerged}`).get().n,
    midAlive: db.prepare(`SELECT COUNT(*) n FROM note WHERE tier = 'mid' AND at >= ?${valid}${unmerged}`).get(now - midTtlMs).n,
    midAll: db.prepare(`SELECT COUNT(*) n FROM note WHERE tier = 'mid'${valid}${unmerged}`).get().n,
    // 访问账(D89):被端过的条数与总次数 —— 让"她是不是老端同一条"看得见。
    recalled: Number(recalled?.n) || 0,
    uses: Number(recalled?.uses) || 0,
    // P1-C:已软失效(被更新说法取代)的条数。
    invalid: soft ? db.prepare('SELECT COUNT(*) n FROM note WHERE invalid_at IS NOT NULL').get().n : 0,
    // P1-D:已近重复合并(同义重复,读路径默认不再端出)的条数。
    merged: merged ? db.prepare('SELECT COUNT(*) n FROM note WHERE merged_into IS NOT NULL').get().n : 0,
  };
}

/**
 * 取这一轮该端出来的**固化记忆**(最多两条:长期一条、中期一条)。
 *
 * 两条通道的取舍(都进日志,判据②):
 *   · **长期**:承诺/第一次/身份这类 —— **不因久远淘汰**;与当前话题有交集时优先,
 *     这句话本身没话题时("哦""在吗")也端出来 —— 那正是"她一直记着的事"最该出现的时候;
 *   · **中期**:几天内的事 —— 只在有话题交集、或这句话没话题时端出;过了 TTL 不再出现。
 *
 * ⚠️ 这是**受控的独立通道**,不是放松判据①:条数硬上限 2、来源唯一、每条都带 why。
 *
 * ⚠️ P1-C(2026-10-19):默认 `latestOnly = true` —— 只看**仍有效**的 note
 * (`invalid_at IS NULL`;老行都是 NULL,所以老库行为不变)。`false` 是**审计/回滚**用的:
 * 把被新说法取代的行也放回候选池(P1-B 行为)。
 * ⚠️ P1-D(2026-10-19):被近重复合并的行(`merged_into IS NOT NULL`)同样默认不进候选池
 * —— 合并 ≠ 失效,但"同义重复"端两次只是浪费预算;`latestOnly:false` 一并放开。
 */
export function notesFor(db, {
  conversation = null,
  query = '',
  now = Date.now(),
  peopleNames = [],
  midTtlMs = 3 * 24 * 3600 * 1000,
  limit = 2,
  /**
   * 这一段会话里**已经端过**的 id(跨轮那本账,见 `pickLongTerm`)。
   * ⚠️ 它在**挑之前**就得生效:先挑出"最好的那条"再把它滤掉,会让这个通道这一轮**空着** ——
   * 而正确行为是"换一条次好的端出来"。
   */
  excludeIds = null,
  /** P1-C 软失效:true = 只看仍有效的行;false = 连被取代的也看(审计 / 回滚开关)。 */
  latestOnly = true,
} = {}) {
  if (!conversation) return [];
  // ⚠️ 老库没有 invalid_at 列时**退回旧行为**(不报 no such column):离线演练/备份回读走的就是这条路。
  const valid = latestOnly && hasNoteColumn(db, 'invalid_at') ? ' AND n.invalid_at IS NULL' : '';
  // P1-D:被近重复合并的行默认不进候选池(同义重复,端两次浪费预算);审计开关同样放开它。
  const merged = latestOnly && hasNoteColumn(db, 'merged_into') ? ' AND n.merged_into IS NULL' : '';
  const acc = accessColumns(db, 'n.source');
  const rows = db.prepare(
    `SELECT n.id AS id, n.source AS source, n.at AS at, n.tier AS tier, n.score AS score,
            n.reasons AS reasons, n.tags AS tags, n.text AS text${acc.select}
       FROM note n${acc.join}
      WHERE n.conversation = ?${valid}${merged} AND (n.tier = 'long' OR n.at >= ?)
      LIMIT 200`,
  ).all(conversation, now - midTtlMs).filter((row) => !excludeIds?.has?.(String(row.source)));
  if (rows.length === 0) return [];

  const queryTags = new Set(tagsFor(query, { peopleNames }));
  const overlap = (row) => String(row.tags ?? '').split(',').filter((tag) => tag && queryTags.has(tag)).length;
  /** 打分 = 固化分 - 刚端过的降权分(见 `accessFreshness`)。**没端过的记忆一分不降。** */
  const rankOf = (row) => Number(row.score) - accessFreshness(
    { lastUsedAt: Number(row.last_used_at) || 0 },
    now,
  );

  const picked = [];
  for (const tier of ['long', 'mid']) {
    const pool = rows.filter((row) => row.tier === tier);
    if (pool.length === 0) continue;
    // 交集多的优先 → 打分高的优先(固化分减去"刚端过"的降权)→ 被想起过更多的优先(打平局)。
    // ⚠️ `use_count` 只在这最后一档起作用:相关度与分数相同的时候,它才决定先后。
    const best = pool
      .map((row) => ({ row, hit: overlap(row), rank: rankOf(row) }))
      .sort((a, b) => b.hit - a.hit || b.rank - a.rank
        || (Number(b.row.use_count) || 0) - (Number(a.row.use_count) || 0)
        || b.row.at - a.row.at)[0];
    if (!best) continue;
    // T1-D(2026-10-29):注入要有依据 —— 标签零交集就不端(**含长期通道**)。
    // "这句话没话题"不再等于"随便端一条旧事";身份与约定由常驻块/交接承载,
    // 相关旧事等真正相关的那一轮再回来。零召回是合法结果,不为凑数硬塞。
    if (best.hit === 0) continue;
    const ageDays = Math.max(0, (now - best.row.at) / (24 * 3600 * 1000));
    const useCount = Number(best.row.use_count) || 0;
    const fresh = accessFreshness({ lastUsedAt: Number(best.row.last_used_at) || 0 }, now);
    picked.push({
      id: best.row.source,
      at: best.row.at,
      score: best.row.score,
      tier,
      text: String(best.row.text),
      // 访问账(D89):让"这条被端过几次"进日志(判据②:说得出为什么)。
      useCount,
      lastUsedAt: Number(best.row.last_used_at) || 0,
      channel: tier === 'long' ? '长期（重要，不因久远淘汰）' : '中期（最近几天）',
      why: [
        `通道 ${tier === 'long' ? '长期/重要' : '中期/最近'}`,
        best.hit > 0 ? `与当前话题有 ${best.hit} 个标签交集` : null,
        `固化分 ${best.row.score}（${best.row.reasons}）`,
        fresh > 0 ? `刚端过（降权 -${fresh.toFixed(2)}）` : null,
        useCount > 0 ? `被想起过 ${useCount} 次` : null,
        `约 ${Math.round(ageDays)} 天前`,
      ].filter(Boolean),
    });
  }
  return picked.slice(0, Math.max(1, limit));
}

/** 把固化记忆渲染成注入用的几行(与标签检索**共用一个预算**,见 D77 判据③)。 */
export function renderNotes(picked, { budgetChars = 300 } = {}) {
  if (!picked || picked.length === 0) return '';
  const lines = [];
  let used = 0;
  for (const note of picked) {
    const line = `· ${cleanMemoryText(note.text).slice(0, 80)}`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 分层记忆 v1:标签落库 + 每轮检索(D75)
//
// 与交接(D39)的分工,这两层**各管一件事**:
//   · 交接 = 每代会话的**第一轮**给"梗概 + 最近原文",预算 1400 字,一换代一次;
//   · 长期层 = **每一轮**给"按标签挑出来的少数几条",预算另算(默认 300 字)。
// 后者治的正是前者的盲区:一个跑了一周没重启的会话**永远看不到**交接,
// 但"第一次见面 / 答应过的事"本来就不该等到重启才想起来。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// **access 强化:被想起过的记忆**(2026-10-01 第二批,D89)
//
// 1.32.0(D82)先做了便宜的那一半:同一条固化记忆 30 分钟内不再端出(进程内、按会话)。
// 那一半治的是"**同一段会话里连着端 5 次**";剩下那半治的是两件它管不到的事:
//   · **跨代**:重启之后进程内的记录就没了 —— 同一条又从头开始端;
//   · **ranking**:原来"多久以前"看的是**事发生的时间**,与"它被端过几次"无关,
//     所以一条被反复想起的老记忆**永远不会降权**。
//
// 所以这里落两个数(`use_count` / `last_used_at`),再给打分加两道新键 ——
// **别把这两件事混起来**(这是刻意的设计,不是偷懒):
//   · `last_used_at` 只用来**降权**(刚端过的先让位)——
//     它**不参与** `recency` 那个半衰期项,否则"越想越新鲜"会让它越端不出来,方向正好反了;
//   · `use_count` 只用来**打平局**(相关度一样时,被想起过的更值钱)——
//     它**不进** `score`,否则次数会盖过"命中几个标签"。
// 于是"被想起过"这件事是**加分项**,但永远压不过相关度与重要性。
// 打分公式本身(`hit + importance + recency`)一个字没改 —— 只读的库(离线演练)旧行为完全不变。
// ---------------------------------------------------------------------------

/** 同一条被端出来之后,多久之内算"刚端过"(降权的窗口)。 */
export const ACCESS_FRESH_MS = 3 * 24 * 3600 * 1000;
/** 刚端过时降多少分。⚠️ 要 **>1**:降 1 分只够压过"没有交集",压不过一条 2 分的命中。 */
export const ACCESS_FRESH_PENALTY = 2.5;
/** `use_count` 的加成:`0.35 * log2(1 + 次数)` —— 用过 1 次 +0.35、3 次 +0.7、7 次 +1.05,封顶 +1。 */
export const ACCESS_COUNT_WEIGHT = 0.35;

/**
 * 记一笔"这条记忆被端出来了"。**幂等键就是 `source`**(与 `note.source` 同一套 id)。
 *
 * ⚠️ **调用方要容忍失败**:`memory-v0.js --simulate` 用的是只读连接,
 * 而"记录访问"失败**绝不该**影响对话或离线演练(和记忆层其他部分同一条纪律)。
 *
 * @param {DatabaseSync} db
 * @param {Array<{id: string, conversation?: string}|string>} items 被端出来的那些(对象或 id 字符串)
 * @param {{conversation?: string, now?: number}} [options] `conversation` 是兜底:
 *   有些条目(标签检索挑出来的原文)身上没有会话 key,而访问账要按会话记。
 * @returns {number} 真的写了几行
 */
export function recordRecall(db, items, { conversation = null, now = Date.now() } = {}) {
  const list = (items ?? []).filter(Boolean).map((item) => (typeof item === 'string'
    ? { id: item, conversation: null }
    : { id: item.id, conversation: item.conversation ?? null }));
  if (list.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO access (source, conversation, use_count, last_used_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(source) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at`,
  );
  db.exec('BEGIN');
  try {
    let written = 0;
    for (const item of list) {
      if (!item.id) continue;
      stmt.run(String(item.id), String(item.conversation ?? conversation ?? ''), now);
      written += 1;
    }
    db.exec('COMMIT');
    return written;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 取一份 `source` → `{useCount, lastUsedAt}` 的表(没记录的不出现)。 */
export function accessMap(db, { conversation = null } = {}) {
  const rows = conversation
    ? db.prepare('SELECT source, use_count, last_used_at FROM access WHERE conversation = ?').all(conversation)
    : db.prepare('SELECT source, use_count, last_used_at FROM access').all();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.source), { useCount: Number(row.use_count) || 0, lastUsedAt: Number(row.last_used_at) || 0 });
  }
  return map;
}

/**
 * 「刚端过」的降权分(≥0;**越大越该让位**)。纯函数,所以可测、可复核。
 *
 * 三条边界:
 *   · **没记录 = 0** —— 从没被端过的记忆一分不降(它们本来就该有机会);
 *   · **线性衰减到 0**:3 天内从 2.5 分线性回到 0,过了窗口就是普通记忆;
 *   · ⚠️ 它**不是**"用过就更值钱"的那一笔(那是 `accessBonus`),两笔分开算,理由见文件头。
 */
export function accessFreshness(access, now, {
  freshMs = ACCESS_FRESH_MS,
  penalty = ACCESS_FRESH_PENALTY,
} = {}) {
  const lastUsedAt = Number(access?.lastUsedAt ?? 0);
  if (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0) return 0;
  const age = now - lastUsedAt;
  if (age >= freshMs) return 0;
  return penalty * (1 - Math.max(0, age) / freshMs);
}

/**
 * 「被想起过」的加分(≥0)。纯函数。
 *
 * 用 `log2(1+次数)` 而不是线性:第 1 次最值钱,第 10 次不该比第 2 次强十倍。
 * ⚠️ 它**只用来打平局**(相关度一样时被想起过的优先),**不进 `score`** —— 见文件头。
 */
export function accessBonus(access, { weight = ACCESS_COUNT_WEIGHT } = {}) {
  const count = Number(access?.useCount ?? 0);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return weight * Math.log2(1 + count);
}

/**
 * 把访问记录贴到候选上 —— **取候选的地方都要走这一步**,否则打分看到的永远是"没被端过"。
 *
 * @param {Array<object>} items
 * @param {Map<string, {useCount: number, lastUsedAt: number}>} map
 */
export function withAccess(items, map) {
  if (!map || map.size === 0) return items ?? [];
  return (items ?? []).map((item) => {
    const access = map.get(String(item.id));
    return access ? { ...item, useCount: access.useCount, lastUsedAt: access.lastUsedAt } : item;
  });
}

/**
 * 库里有没有这张表?
 *
 * ⚠️ 为什么要问这一句(2026-10-01 现场):`access` / `summary` 都是**新加的表**,
 * 而两个地方用的是**只读连接**(`memory-v0.js --simulate`、备份回读),只读连接**建不了表** ——
 * 于是"新代码 + 还没迁移过的库"会直接报 `no such table: …`,
 * 把一次离线演练(甚至启动横幅)变成一次崩溃。所以:表不在就退回到旧行为,
 * 而不是抛错(和这一层的其他纪律一致:记忆坏了只该变成"这轮没有长期记忆")。
 */
function hasTable(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(name)));
  } catch {
    return false;
  }
}

function hasAccessTable(db) {
  return hasTable(db, 'access');
}

/** 访问账那几列与那条 join(表不在时整块消失,查询退回旧形状)。 */
function accessColumns(db, sourceExpr) {
  if (!hasAccessTable(db)) return { select: '', join: '' };
  return {
    select: ', a.use_count AS use_count, a.last_used_at AS last_used_at',
    join: ` LEFT JOIN access a ON a.source = ${sourceExpr}`,
  };
}

/** 向量那一列与那条 join(D92,同上:表不在就整块消失)。 */
function vectorColumns(db, sourceExpr, model) {
  if (!hasTable(db, 'embedding') || !model) return { select: '', join: '' };
  return {
    select: ', e.vec AS vec_blob',
    join: ` LEFT JOIN embedding e ON e.source = ${sourceExpr} AND e.model = '${String(model).replace(/'/g, "''")}'`,
  };
}

/**
 * 一轮该有哪些**内容标签**(纯规则 + 落库前校验,判据 4)。
 *
 * 三类轮次**不产生记忆**,理由各不相同:
 *   · `warmup` / `self` / `command` —— 正文是**桥自己写的提示词**或操作者的命令,
 *     不是"人说的话"(实测:当前角色被打标签的 270 轮里有 121 轮是这类,见 NON_MEMORY_KINDS);
 *   · `announce` —— 播报那一轮的"用户消息"是桥写的系统指令、回复是整篇日志(D39 已排除);
 *   · 注入块(`【记忆交接】`/`【系统】`…) —— 它是**过去对话的摘要**,给它打标签会让
 *     "摘要套摘要"一轮一轮滚起来(见 `src\memory-archive.js` 的 isInjectedBlock);
 *   · `tool` —— **工具/自检会话**(摘要/verify/card-eval)的"用户消息"是桥写的提示词
 *     (2026-10-06,D135;旧库里这些行还是 `mention`,所以传 `session_id` 一起判)。
 *
 * @param {{kind?: string, user_text?: string, session_id?: string, conversation?: string}} turn
 * @returns {string[]}
 */
export function tagsForTurn(turn, { peopleNames = [] } = {}) {
  if (!turn) return [];
  if (!isHumanTurn(turn)) return [];
  if (isInjectedBlock(turn.user_text)) return [];
  return normalizeTags(tagsFor(turn.user_text, { peopleNames }));
}

/**
 * **按当前规则重贴所有标签**(2026-10-01,D78)。
 *
 * 为什么要"每次都重贴"而不是"只贴新行":
 *   · 词表/判据一改,旧行的标签就变成了**谎话**(这个项目靠 `MEMORY_VERSION` 重导来治,
 *     但重导现在是**破坏性**的 —— 源文件可能已被会话保留策略删掉,见 D77);
 *   · 更要紧的是**认识的人**:群友昵称是**边聊边学**的。今天才知道「饭否」是个昵称,
 *     昨天那行「用白丝脚踩饭否」的 `food` 错标签必须跟着改过来。
 *
 * 成本可以忽略(千级轮次 × 一次词表扫描),所以每拍归档都重贴一遍 —— 于是
 * **"标签"从此永远等于"当前规则 + 当前人名表"**,不会再有"陈旧但看起来正常"的标签。
 *
 * @returns {number} 重贴的标签条数
 */
export function retagAll(db, { peopleNames = [], now = Date.now() } = {}) {
  const rows = db.prepare('SELECT session_id, seq, kind, user_text FROM turn').all();
  db.exec('DELETE FROM memory_tag');
  const insertTag = db.prepare(
    `INSERT OR IGNORE INTO memory_tag (session_id, seq, tag, source, created_at) VALUES (?, ?, ?, 'rule', ?)`,
  );
  let count = 0;
  for (const row of rows) {
    for (const tag of tagsForTurn({ kind: row.kind, user_text: row.user_text, session_id: row.session_id }, { peopleNames })) {
      insertTag.run(row.session_id, row.seq, tag, now);
      count += 1;
    }
  }
  return count;
}

/**
 * 给一轮写标签(幂等)。`archivePass` 走的是同一条规则,这里留一个**可直接调用的入口**
 * —— 目的只有一个:让"未知标签会被丢掉"这条能在一个 :memory: 库上单独测出来。
 *
 * @returns {string[]} 真的落库的标签(被校验丢掉的不会出现)
 */
export function tagTurn(db, { sessionId, seq, kind = null, text = '', source = 'rule', now = Date.now() } = {}) {
  const tags = tagsForTurn({ kind, user_text: text, session_id: sessionId });
  const insert = db.prepare(
    'INSERT OR IGNORE INTO memory_tag (session_id, seq, tag, source, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const tag of tags) insert.run(sessionId, seq, tag, source, now);
  return tags;
}

/** 一轮的标签(给报表/演练脚本读)。顺序按词表,和落库/日志的口径一致。 */
export function tagsOfTurn(db, sessionId, seq) {
  return normalizeTags(
    db
      .prepare('SELECT tag FROM memory_tag WHERE session_id = ? AND seq = ?')
      .all(sessionId, seq)
      .map((row) => row.tag),
  );
}

/**
 * 检索**候选**:先在 SQL 里按"会话 + 标签 + 排掉桥自己写的轮次 + 够旧"收窄,再交给纯函数打分。
 *
 * 为什么要分成两步:索引不该占 token,也不该把整个库读进内存 ——
 * 但**排序规则必须是纯函数**(可测、可复核)。所以 SQL 只负责"哪些行值得看",
 * `src\memory-tags.js` 负责"哪几条真的值得说"。
 *
 * ⚠️ 会话隔离用 `session.conversation = ?`(**精确**,不是 LIKE 前缀):
 * 前缀匹配会让 `qqbot-c2c-ABC` 命中 `qqbot-c2c-ABCD`,那是"查出来的比你以为的多"。
 *
 * @param {object} options
 * @param {boolean} [options.allConversations] 只给**离线演练**用(跨会话看"这一段历史里
 *   会挑出什么")。生产路径**永远**走单会话 —— 没有会话就不猜(见下)。
 * @param {number|null} [options.olderThan] 只取 `at <=` 这个时刻的轮次。
 *   传 `now - 10 分钟` 是刻意的:"刚刚说过的"还在活着的上下文里,
 *   用长期层再提醒一遍既浪费 token、又会让她听起来像在复读。
 * @returns {Array<{id: string, at: number, text: string, kind: string, tags: string[]}>}
 */
export function candidatesFor(db, {
  conversation = null,
  allConversations = false,
  tags = [],
  excludeKinds = NON_MEMORY_KINDS,
  olderThan = null,
  max = 500,
  embeddingModel = null,
  semanticOnly = false,
} = {}) {
  const wanted = normalizeTags(tags);
  // ⚠️ **语义那条路不需要标签交集**(D92):那正是它存在的理由 ——
  //    "命不中的词等于没有",而语义能命中的恰恰是**一个标签都没有**的那种话。
  if (wanted.length === 0 && !(semanticOnly && embeddingModel)) return [];
  // 生产路径的铁律:不知道是哪段记忆,就不要猜一段出来。
  if (!allConversations && !conversation) return [];
  const skip = excludeKinds.length > 0 ? ` AND t.kind NOT IN (${excludeKinds.map(() => '?').join(',')})` : '';
  const scoped = allConversations ? '1 = 1' : 's.conversation = ?';
  const scopeArgs = allConversations ? [] : [conversation];
  const age = olderThan === null ? '' : ' AND t.at <= ?';
  const ageArgs = olderThan === null ? [] : [olderThan];
  const c2cTags = `t.session_id || '#' || t.seq`;
  const acc = accessColumns(db, c2cTags);
  const vec = vectorColumns(db, c2cTags, embeddingModel);
  // 标签那条路:按命中的标签收窄;**语义那条路:所有够旧的人话都进候选** ——
  // ⚠️ 用 **LEFT JOIN**,否则"一个标签都没有"的轮次(恰恰是语义要救的那一半)会被 JOIN 直接筛掉。
  const tagClause = wanted.length > 0
    ? `g.tag IN (${wanted.map(() => '?').join(',')})`
    : '1 = 1';
  const tagArgs = wanted.length > 0 ? wanted : [];
  const rows = db.prepare(
    `SELECT t.session_id, t.seq, t.at, t.kind, t.user_text, s.conversation AS conversation,
            s.file AS session_file,
            group_concat(g.tag) AS tags${acc.select}${vec.select}
       FROM turn t
       JOIN session s ON s.id = t.session_id
       LEFT JOIN memory_tag g ON g.session_id = t.session_id AND g.seq = t.seq${acc.join}${vec.join}
      WHERE ${scoped} AND ${tagClause}${skip}${age}
      GROUP BY t.session_id, t.seq
      ORDER BY t.at DESC
      LIMIT ?`,
  ).all(...scopeArgs, ...tagArgs, ...excludeKinds, ...ageArgs, Math.max(1, Math.min(2000, max)));
  const ready = ownDerivedProjectionReady(db);

  return rows.map((row) => ({
    id: `${row.session_id}#${row.seq}`,
    at: row.at,
    text: projectDerivedRead(row, ready),
    kind: row.kind,
    // 会话 key 也带上:访问账(D89)要按会话记,`/忘了 记忆` 也是按会话删的。
    conversation: row.conversation ?? null,
    // SQL 里的顺序是任意的 → 按词表顺序重排,日志才可复核。
    tags: normalizeTags(String(row.tags ?? '').split(',')),
    // 访问记录(D89):有了它,打分才知道"这条被端过几次、最后一次是何时"。
    useCount: Number(row.use_count) || 0,
    lastUsedAt: Number(row.last_used_at) || 0,
    // 向量(D92):语义那一维用它算余弦。
    vector: row.vec_blob ? unpackVector(row.vec_blob) : null,
  }));
}

// ---------------------------------------------------------------------------
// P1-A 关键词通道(FTS5 + bigram;2026-10-18)
//
// 照搬:RRF 融合公式与 k=1(Graphiti)、FTS5 官方建表/MATCH/bm25 语法;
// 自写:只有 bigram 分词(memory-tags.js)与这三层薄封装(建表/回填/检索)。
// 三条边界(与记忆层其他部分同族):
//   · FTS5 不可用(老 SQLite/只读连接)→ 全部返回空,行为退回纯标签+语义;
//   · 回填失败不抛给归档(下一拍照样重试);
//   · 查询不跨会话(生产铁律:不知道是哪段记忆就不猜)。
// ---------------------------------------------------------------------------

/** 建 FTS5 虚表 + 给老库补 `fts_text` 列。FTS5 不可用时 `ok:false`(调用方退回旧行为)。 */
export function ensureFtsSchema(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(turn)').all().map((col) => col.name);
    const added = !cols.includes('fts_text');
    if (added) db.exec("ALTER TABLE turn ADD COLUMN fts_text TEXT NOT NULL DEFAULT ''");
    db.exec(FTS_SCHEMA);
    return { ok: true, added };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 增量回填:`fts_text` 还是空的轮次 → 分词、写列、进虚表。拍子上跑,一拍一批。
 * 幂等:先按 (session_id, seq) 删旧虚表行再插,重复跑不会堆重复行。
 */
export function indexTurnFts(db, { limit = 5000 } = {}) {
  if (!hasTable(db, 'turn_fts')) return { indexed: 0, error: 'no-fts-table' };
  const rows = db.prepare(
    "SELECT session_id, seq, user_text FROM turn WHERE fts_text = '' AND length(user_text) > 0 LIMIT ?",
  ).all(Math.max(1, Math.min(20000, limit)));
  if (rows.length === 0) return { indexed: 0 };
  const upd = db.prepare('UPDATE turn SET fts_text = ? WHERE session_id = ? AND seq = ?');
  const del = db.prepare('DELETE FROM turn_fts WHERE session_id = ? AND seq = ?');
  const ins = db.prepare('INSERT INTO turn_fts (session_id, seq, fts_text) VALUES (?, ?, ?)');
  let indexed = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const tokens = bigramTokens(cleanMemoryText(row.user_text)).join(' ');
      upd.run(tokens, row.session_id, row.seq);
      if (tokens !== '') {
        del.run(row.session_id, row.seq);
        ins.run(row.session_id, row.seq, tokens);
        indexed += 1;
      }
    }
    db.exec('COMMIT');
    return { indexed };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 关键词检索:同一段会话里,按 bm25(越小越相关)排,返回与 `candidatesFor` 同形状的候选,
 * 外加 `ftsRank`(0 起;RRF 用它)。
 */
export function searchTurnsByFts(db, {
  conversation = null,
  query = '',
  olderThan = null,
  limit = 50,
  excludeKinds = NON_MEMORY_KINDS,
} = {}) {
  if (!conversation) return [];
  if (!hasTable(db, 'turn_fts')) return [];
  const expression = ftsMatchExpression(query);
  if (expression === '') return [];
  const skip = excludeKinds.length > 0
    ? ` AND t.kind NOT IN (${excludeKinds.map(() => '?').join(',')})`
    : '';
  const age = olderThan === null ? '' : ' AND t.at <= ?';
  let rows;
  try {
    // ⚠️ FTS5 的 `bm25()` **不能与 GROUP BY 同用**（"unable to use function bm25 in the requested context"）
    //    ⇒ 标签改用相关子查询取，别 JOIN + GROUP BY（第一版这么写，查询被 catch 吞成"没有关键词命中"）。
    rows = db.prepare(
      `SELECT t.session_id, t.seq, t.at, t.user_text, s.conversation AS conversation,
              s.file AS session_file,
              (SELECT group_concat(m.tag) FROM memory_tag m
                WHERE m.session_id = t.session_id AND m.seq = t.seq) AS tags,
              bm25(turn_fts) AS bm
         FROM turn_fts
         JOIN turn t ON t.session_id = turn_fts.session_id AND t.seq = turn_fts.seq
         JOIN session s ON s.id = t.session_id
        WHERE turn_fts MATCH ? AND s.conversation = ?${skip}${age}
        ORDER BY bm ASC
        LIMIT ?`,
    ).all(expression, conversation, ...excludeKinds, ...(olderThan === null ? [] : [olderThan]),
      Math.max(1, Math.min(200, limit)));
  } catch {
    // MATCH 语法/虚表异常 → 当成"这一轮没有关键词通道"(与记忆层其他 best-effort 同族)。
    return [];
  }
  // F1 读闸:旧 FTS 索引要到归档迁移后才可信;迁移未完成时按统一投影现算正文。
  const ready = ownDerivedProjectionReady(db);
  return rows.map((row, rank) => ({
    id: `${row.session_id}#${row.seq}`,
    at: row.at,
    text: projectDerivedRead(row, ready),
    conversation: row.conversation ?? null,
    tags: normalizeTags(String(row.tags ?? '').split(',')),
    useCount: 0,
    lastUsedAt: 0,
    vector: null,
    ftsRank: rank,
    ftsBm25: Number(row.bm) || 0,
  }));
}

// ---------------------------------------------------------------------------
// P1-F 实体共现 + boost(2026-10-19,方案 §5;零模型调用)
//
// 名册与 mention 都是**派生数据,可整表重建**(方案原话):名单变了/规则变了就 rebuild,
// 与固化/事实那种"重建之后还该成立"的账本语义完全两回事(同标签表那族)。
// 名单由**调用方给**(生产 = person.display + concept.label),这里不发明名字。
// ---------------------------------------------------------------------------

/** 实体名单的最短长度。单字名误伤太容易(「饭」吃掉「踩饭否」那个现场),名单来源再把关 + 这里再挡一道。 */
const ENTITY_MIN_CHARS = 2;

/**
 * **整表重建**实体名册与 mention(方案 §5:派生数据,可整表重建)。
 *
 * 扫描对象 = 人话轮次(`turn.user_text`,与检索候选同一片海);匹配 = **整名 includes**
 * (「饭否」靠完整名字串命中,不做分词 —— 同 `tagsFor` 遮罩的口径)。
 * 幂等:每次全量重扫,重复跑内容一致;事务包裹,失败回滚不留半张表。
 *
 * @param {DatabaseSync} db
 * @param {{names?: Array<string|{name: string, kind?: string}>, limit?: number}} [options]
 *   `names` 生产传 person.display(kind 'person')+ concept.label(kind 'concept')。
 * @returns {{entities: number, mentions: number, turns: number}}
 */
export function rebuildEntities(db, { names = [], limit = 20000 } = {}) {
  const seen = new Map();
  for (const item of names ?? []) {
    const raw = typeof item === 'string' ? { name: item, kind: 'person' } : item;
    const name = String(raw?.name ?? '').trim();
    if (name.length < ENTITY_MIN_CHARS || seen.has(name)) continue;
    seen.set(name, String(raw?.kind ?? 'person'));
  }
  const skip = NON_MEMORY_KINDS.length > 0
    ? ` AND t.kind NOT IN (${NON_MEMORY_KINDS.map(() => '?').join(',')})`
    : '';
  const rows = db.prepare(
    `SELECT t.session_id, t.seq, t.user_text
       FROM turn t
      WHERE length(t.user_text) > 0${skip}
      ORDER BY t.at ASC, t.seq ASC
      LIMIT ?`,
  ).all(...NON_MEMORY_KINDS, Math.max(1, Math.min(200000, limit)));

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM entity_mention');
    db.exec('DELETE FROM entity');
    const insEntity = db.prepare('INSERT INTO entity (name, kind) VALUES (?, ?)');
    for (const [name, kind] of seen) insEntity.run(name, kind);
    const idByName = new Map(
      db.prepare('SELECT id, name FROM entity').all().map((row) => [row.name, Number(row.id)]),
    );
    const insMention = db.prepare('INSERT OR IGNORE INTO entity_mention (entity_id, source) VALUES (?, ?)');
    let mentions = 0;
    for (const row of rows) {
      const text = cleanMemoryText(String(row.user_text ?? ''));
      if (text === '') continue;
      const source = `${row.session_id}#${row.seq}`;
      for (const name of seen.keys()) {
        if (!text.includes(name)) continue;
        insMention.run(idByName.get(name), source);
        mentions += 1;
      }
    }
    db.exec('COMMIT');
    return { entities: seen.size, mentions, turns: rows.length };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 实体两表的行数(启动横幅/报表用)。表不在(老库/只读)→ 全 0,不抛。 */
export function entityStats(db) {
  if (!hasTable(db, 'entity')) return { entities: 0, mentions: 0 };
  return {
    entities: Number(db.prepare('SELECT COUNT(*) AS n FROM entity').get().n) || 0,
    mentions: Number(db.prepare('SELECT COUNT(*) AS n FROM entity_mention').get().n) || 0,
  };
}

/**
 * 查一批轮次各自命中了哪些实体名:`source → 名字数组`。
 * 表不在 / 空列表 → 空 Map(调用方当"没有实体共现",行为退回 P1-E)。
 */
export function entityHitsFor(db, sources) {
  const list = (sources ?? []).filter(Boolean);
  if (list.length === 0 || !hasTable(db, 'entity')) return new Map();
  const rows = db.prepare(
    `SELECT m.source AS source, e.name AS name
       FROM entity_mention m JOIN entity e ON e.id = m.entity_id
      WHERE m.source IN (${list.map(() => '?').join(',')})`,
  ).all(...list);
  const map = new Map();
  for (const row of rows) {
    const bucket = map.get(String(row.source));
    if (bucket) bucket.push(String(row.name));
    else map.set(String(row.source), [String(row.name)]);
  }
  return map;
}

/**
 * **点名实体的轮次补位**(P1-F):query 点了名的实体,mention 过它的轮次要**进候选池** ——
 * 否则实体准入(`recallDecision` 里的第四次扩展)永远轮不上:候选池是**先**按标签收窄的,
 * 标签不命中的实体轮根本进不了池(第一版就栽在这,与 FTS 通道"补位"同款修法)。
 *
 * 与 `candidatesFor` 同形状;只查本会话(生产铁律)、只查人话轮、只查 `olderThan` 之前的。
 * 表不在 / 名单空 → 空数组(行为退回 P1-E)。
 */
export function turnsMentioningEntities(db, { conversation = null, names = [], olderThan = null, max = 100 } = {}) {
  const wanted = (names ?? []).map(String).filter((name) => name.length >= 2);
  if (wanted.length === 0 || !conversation || !hasTable(db, 'entity')) return [];
  const age = olderThan === null ? '' : ' AND t.at <= ?';
  const ageArgs = olderThan === null ? [] : [olderThan];
  const rows = db.prepare(
    `SELECT t.session_id, t.seq, t.at, t.kind, t.user_text, s.conversation AS conversation,
            s.file AS session_file,
            (SELECT group_concat(g.tag) FROM memory_tag g
              WHERE g.session_id = t.session_id AND g.seq = t.seq) AS tags
       FROM entity_mention m
       JOIN entity e ON e.id = m.entity_id
       JOIN turn t ON t.session_id || '#' || t.seq = m.source
       JOIN session s ON s.id = t.session_id
      WHERE e.name IN (${wanted.map(() => '?').join(',')}) AND s.conversation = ?${age}
      GROUP BY t.session_id, t.seq
      ORDER BY t.at DESC
      LIMIT ?`,
  ).all(...wanted, conversation, ...ageArgs, Math.max(1, Math.min(500, max)));
  // F1 读闸:实体共现是**第四条**进 prompt 的通道,同样要现算清洁正文/kind
  // (审查抓到:这一条原来直接回 raw user_text,归档未迁移时旧临时要求会借实体召回回流)。
  const projectionReady = ownDerivedProjectionReady(db);
  return rows.map((row) => {
    const text = projectDerivedRead(row, projectionReady);
    return {
      id: `${row.session_id}#${row.seq}`,
      at: Number(row.at),
      text,
      kind: row.kind,
      conversation: row.conversation ?? null,
      tags: normalizeTags(String(row.tags ?? '').split(',')),
      useCount: 0,
      lastUsedAt: 0,
      vector: null,
    };
  });
}

// ---------------------------------------------------------------------------
// P1-E 常驻记忆块(2026-10-19,方案 §4;照搬 Letta memory blocks,<20 块,我们固定 4 块)
//
// 四块固定:关于她(read_only,人设锚点,模型改不动)/ 关于主人 / 关系状态 / 约定。
// 写入路径只有一条:后台生成(摘要拍,≈1 次/天,失败保留旧值);旧值进 history。
// 注入:每代首轮必含 XML(挂在交接层)—— 不经过检索,检索碰不到"永远该在场"的事。
// ---------------------------------------------------------------------------

/** 四块的固定定义。value 留空由初始化/生成填;description 同时是给生成模型的说明。 */
export const MEMORY_BLOCKS_DEFAULTS = Object.freeze([
  {
    label: 'about-her', description: '关于她自己的身份锚点(名字与存在感;细节靠角色卡,这里只防遗忘)',
    limitChars: 200, readOnly: true,
  },
  { label: 'about-owner', description: '关于主人:称呼、偏好、雷区、最近在意的事', limitChars: 200, readOnly: false },
  { label: 'relation', description: '与主人的关系现状:怎么互相称呼、亲疏与承诺到哪一步', limitChars: 200, readOnly: false },
  { label: 'promises', description: '约定与待兑现:答应过什么、还没了结什么、已完成的收进一句', limitChars: 200, readOnly: false },
]);

/** 可被后台生成改写的块(即非 read_only)。 */
const WRITABLE_LABELS = MEMORY_BLOCKS_DEFAULTS.filter((block) => !block.readOnly).map((block) => block.label);

/**
 * 建默认块行(幂等;INSERT OR IGNORE)。`aboutHerValue` = about-her 的静态初值
 * (bot 名 + 一句身份锚点;它是 read_only,生成器永远不改它)。
 */
export function ensureBlockSchema(db, { aboutHerValue = '' } = {}) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO memory_block (label, description, value, limit_chars, read_only)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (const block of MEMORY_BLOCKS_DEFAULTS) {
      const value = block.label === 'about-her' ? String(aboutHerValue ?? '') : '';
      ins.run(block.label, block.description, value, block.limitChars, block.readOnly ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getMemoryBlocks(db);
}

/** 读全部块(按固定顺序);表不在 → [](老库/只读连接降级)。 */
export function getMemoryBlocks(db) {
  if (!hasTable(db, 'memory_block')) return [];
  const rows = db.prepare(
    'SELECT label, description, value, limit_chars, read_only, model, updated_at, build_ms FROM memory_block',
  ).all();
  const order = new Map(MEMORY_BLOCKS_DEFAULTS.map((block, index) => [block.label, index]));
  return rows
    .map((row) => ({
      label: String(row.label),
      description: String(row.description ?? ''),
      value: String(row.value ?? ''),
      limitChars: Number(row.limit_chars) || 200,
      readOnly: Number(row.read_only) === 1,
      model: row.model == null ? null : String(row.model),
      updatedAt: row.updated_at == null ? null : Number(row.updated_at),
      buildMs: row.build_ms == null ? null : Number(row.build_ms),
    }))
    .sort((a, b) => (order.get(a.label) ?? 99) - (order.get(b.label) ?? 99));
}

/**
 * 渲染成交接里前置的 XML 块。空块跳过;全部为空 → ''(交接一字不加)。
 * budgetChars = 块段总预算(默认 900:4×200 + 标签开销)。
 *
 * `blocks` = 调用方**已按作用域过滤好**的块(2026-10-28 / P0)。
 * ⚠️ 为什么不在这里自己过滤:作用域口径只有 `src\memory-scope.js` 一份,
 * 渲染只管排版 —— 这里再判一次就会出现"两份必须一致"的实现(D159)。
 * 不传 = 读全库(**保持旧行为**:纯渲染判据与历史调用零改动)。
 */
export function renderMemoryBlocks(db, { budgetChars = 900, blocks = null } = {}) {
  const source = Array.isArray(blocks) ? blocks : getMemoryBlocks(db);
  const filled = source.filter((block) => block.value.trim() !== '');
  if (filled.length === 0) return '';
  const lines = [];
  let used = 0;
  for (const block of filled) {
    const line = `<block label="${block.label}">${block.value}</block>`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  return ['<memory_blocks>', ...lines, '</memory_blocks>'].join('\n');
}

/**
 * **纯编排**:拼 prompt → 调 `generate` → 解析 JSON → 产出可写的 updates。
 * 模型调用由调用方注入(与 summarizeConversation 同一个形状,memory 层零 HTTP);
 * 坏 JSON / 缺块都**不抛** —— 生成失败保留旧值(方案 §4 的硬要求)。
 *
 * @param {{current: Array<{label: string, value: string, description: string, limitChars: number}>,
 *   notesText: string, generate: (prompt: string) => Promise<string|null>, now?: number}} options
 * @returns {Promise<{updates: Array<{label: string, value: string}>, error: string|null, raw: string|null}>}
 */
export async function buildMemoryBlocks({ current, notesText, generate, now = Date.now() } = {}) {
  const writable = (current ?? []).filter(
    (block) => !block.readOnly && WRITABLE_LABELS.includes(block.label),
  );
  if (writable.length === 0 || typeof generate !== 'function') {
    return { updates: [], error: writable.length === 0 ? '无可写块' : 'generate 不是函数', raw: null };
  }
  const spec = writable.map((block) => `- "${block.label}"(≤${block.limitChars}字):${block.description}`).join('\n');
  const currentText = writable
    .map((block) => `- "${block.label}":${block.value.trim() === '' ? '(还空着)' : block.value}`)
    .join('\n');
  const prompt = [
    '你在维护一个记忆系统的常驻摘要块。下面给出各块的职责、当前内容,与最近固化的记忆笔记。',
    '请**只依据笔记**更新各块:笔记里没有的不要编;已了结的约定收进一句"已完成";块与块之间别重复。',
    '',
    '各块职责:',
    spec,
    '',
    '当前内容:',
    currentText,
    '',
    '最近固化的记忆笔记(倒序):',
    String(notesText ?? '').trim() === '' ? '(这一段还没有固化笔记)' : notesText,
    '',
    '输出要求:只输出一个 JSON 对象,键就是块名(不带引号外的任何文字),值是更新后的块内容。',
  ].join('\n');
  let raw = null;
  try {
    raw = await generate(prompt);
  } catch (err) {
    return { updates: [], error: `生成调用失败:${err?.message ?? err}`, raw: null };
  }
  const text = String(raw ?? '').trim();
  if (text === '') return { updates: [], error: '模型没写出东西', raw: null };
  // 模型爱在 JSON 外面包一句说明/代码栏 —— 截最后一个 { 到第一个 }(贪不住就如实报错,保留旧值)。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { updates: [], error: '输出里没有 JSON 对象', raw: text };
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { updates: [], error: `JSON 解析失败:${err?.message ?? err}`, raw: text };
  }
  if (!parsed || typeof parsed !== 'object') return { updates: [], error: 'JSON 不是对象', raw: text };
  const updates = [];
  for (const block of writable) {
    const value = parsed[block.label];
    if (typeof value !== 'string' || value.trim() === '') continue; // 模型没给这块 → 保留旧值
    updates.push({ label: block.label, value: value.trim().slice(0, block.limitChars) });
  }
  if (updates.length === 0) return { updates: [], error: '输出里没有可写块的内容', raw: text };
  return { updates, error: null, raw: text };
}

/**
 * 落库:旧值进 history、新值覆盖(≤limit_chars 截断在 buildMemoryBlocks 已做,这里再兜一道)。
 * **read_only 拒绝**(任何写路径都过这道闸 —— "关于她"模型改不动的判据)。事务,幂等无谓。
 */
export function applyBlockUpdates(db, updates, { model = null, now = Date.now() } = {}) {
  const list = (updates ?? []).filter((item) => item && typeof item.label === 'string');
  if (list.length === 0) return { written: 0, skippedReadOnly: 0 };
  const sel = db.prepare('SELECT label, value, limit_chars, read_only FROM memory_block WHERE label = ?');
  const insHistory = db.prepare(
    'INSERT INTO memory_block_history (label, value, replaced_at) VALUES (?, ?, ?)',
  );
  const upd = db.prepare(
    'UPDATE memory_block SET value = ?, model = ?, updated_at = ? WHERE label = ?',
  );
  let written = 0;
  let skippedReadOnly = 0;
  db.exec('BEGIN');
  try {
    for (const item of list) {
      const row = sel.get(item.label);
      if (!row) continue;
      if (Number(row.read_only) === 1) {
        skippedReadOnly += 1;
        continue;
      }
      const value = String(item.value ?? '').trim().slice(0, Number(row.limit_chars) || 200);
      if (value === '' || value === String(row.value ?? '')) continue;
      insHistory.run(item.label, String(row.value ?? ''), now);
      upd.run(value, model == null ? null : String(model), now, item.label);
      written += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { written, skippedReadOnly };
}

/** 块的行数/历史行数(启动横幅与审计用)。表不在 → 全 0。 */
export function memoryBlockStats(db) {
  if (!hasTable(db, 'memory_block')) return { blocks: 0, filled: 0, history: 0 };
  const rows = getMemoryBlocks(db);
  return {
    blocks: rows.length,
    filled: rows.filter((block) => block.value.trim() !== '').length,
    history: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_block_history').get().n) || 0,
  };
}

/** 生成块的输入材料:最近 N 条有效固化笔记,一行一条(≤80 字截断,与交接口径一致)。 */
export function recentNotesText(db, { limit = 30, charsPerNote = 80 } = {}) {
  if (!hasTable(db, 'note')) return '';
  const merged = hasNoteColumn(db, 'merged_into') ? ' AND merged_into IS NULL' : '';
  const rows = db.prepare(
    `SELECT text FROM note WHERE invalid_at IS NULL${merged} ORDER BY at DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(200, limit)));
  return rows
    .map((row) => `· ${cleanMemoryText(String(row.text ?? '')).slice(0, charsPerNote)}`)
    .filter((line) => line !== '· ')
    .join('\n');
}

/**
 * 长期层**这一轮到底端哪几条** —— 抽成独立函数(2026-10-01,D89)。
 *
 * 为什么要抽出来:`makeLongTermProvider` 只能用一次(它自己在进程内记着"刚端过什么"),
 * 所以"同一段会话里跨代、跨轮都别重复端"这件事需要一本**落盘的账**;
 * 而"记不记这笔账"必须与"挑哪几条"分开 —— 账是副作用,挑选是纯逻辑。
 *
 * @param {object} options
 * @param {Set<string>|null} [options.excludeIds] 这一段会话里**已经端过**的 id(跨轮那本账)
 * @param {(id: string) => boolean} [options.tooRecent] 进程内那道窗口(D82),仍保留
 * @returns {{text: string, picked: Array<object>, notes: Array<object>, reason: string|null}}
 */
export function pickLongTerm(db, {
  conversation = null,
  query = '',
  now = Date.now(),
  budget = 300,
  limit = 3,
  minScore,
  halfLifeMs,
  minAgeMs = 10 * 60 * 1000,
  midTtlMs = 3 * 24 * 3600 * 1000,
  peopleNames = [],
  excludeIds = null,
  tooRecent = null,
  semantic = null,
  embeddingModel = null,
  // P1-A:关键词通道。默认开(表不在时 searchTurnsByFts 自己返回空,老库零影响)。
  fts = null,
  // P1-B:打分模式(legacy|normalized)。默认交给 memory-tags 的 DEFAULT_SCORING。
  scoring = null,
  // P1-C:软失效读路径开关。true(默认)= 只看仍有效的 note;false = 回到 P1-B 行为(审计/回滚)。
  latestOnly = true,
  // W1 衰减治理(2026-10-22):note 通道上限(诊断:2 note 占满 top3 挤掉原文通道)与
  // recency 权重(normalized 模式作用在归一化之后;诊断:recency 是挤位主引擎)。
  noteLimit = 1,
  recencyWeight = 0.5,
  // P1-F:实体共现。`entityNames` = 名单(person.display + concept.label,生产由 index 现给);
  // `entityBoost` = 命中加成权重(0 = 关,回滚开关;权重进 config,不写死 —— 方案 §5 判据)。
  entityNames = [],
  entityBoost = 0,
} = {}) {
  const ftsEnabled = fts?.enabled !== false;
  const ftsLimit = Math.max(1, Math.min(200, Number(fts?.limit) || 50));
  const empty = { text: '', picked: [], notes: [], reason: null, queryTags: [], trigger: false };
  // 没有会话 key = 不知道这是哪段记忆,那就**不要猜**(宁可这轮没有)。
  if (!conversation) return { ...empty, reason: '没有会话 key —— 不知道这是哪段记忆,不猜' };
  const contentTags = tagsFor(query, { peopleNames });
  // ① **固化记忆**(中期/长期)先来:它是"回头"挑出来的,比临时撞上的原文更值得出现。
  // ⚠️ 2026-10-22(W1 衰减治理):**限 noteLimit 条**。诊断实测 top3 = 2 note + 1 turn,
  //    76% 的席位被"固化时间晚于 query 的未来 note"占死,一条 note 独占 20/35 case
  //    —— 两条 note 就等于把原文通道挤没。默认 1 = 按排名留最好的那条(mid/long 同场竞争)。
  const notes = notesFor(db, { conversation, query, now, peopleNames, midTtlMs, excludeIds, latestOnly })
    .filter((note) => !tooRecent?.(note.id))
    .slice(0, Math.max(1, noteLimit));
  const noteText = renderNotes(notes, { budgetChars: budget });
  // ② 再按标签挑原文;同一轮已经在固化里出现过的、以及刚端过的,都不重复印。
  //    ⚠️ 带了语义向量时,**没有标签交集也要去取候选**(D92:那正是覆盖率要治的那一半)。
  const noted = new Set(notes.map((note) => note.id));
  const candidates = (contentTags.length > 0 || semantic?.vector?.length)
    ? candidatesFor(db, {
      conversation,
      tags: contentTags,
      olderThan: now - minAgeMs,
      embeddingModel,
      semanticOnly: Boolean(semantic?.vector?.length),
    })
      .filter((memory) => !noted.has(memory.id)
        && !excludeIds?.has?.(memory.id)
        && !tooRecent?.(memory.id))
    : [];
  // P1-A:**并进关键词通道** —— 只**补位**,不给已有候选加名次分。
  // 为什么不是双路 RRF 融合:现有打分是"标签命中数 + 重要性 + recency + 语义"的**加和式**,
  // 单方面给标签候选再加一个 FTS 名次分,会把它挤出 limit=3(实测 recall@3 0.824→0.706)。
  // 真正的`Σ 1/(k+rank)`双路融合要等 P1-B 把打分归一化后再做;P1-A 只保证
  // "标签/语义都空手时,字面命中能补一条"(改法来自 Graphiti 的 RRF 名次分,用于准入)。
  const ftsHits = ftsEnabled
    ? searchTurnsByFts(db, { conversation, query, olderThan: now - minAgeMs, limit: ftsLimit })
    : [];
  let pool = candidates;
  if (ftsHits.length > 0) {
    const access = accessMap(db, { conversation });
    const seen = new Set(candidates.map((memory) => memory.id));
    for (const hit of ftsHits) {
      if (seen.has(hit.id) || noted.has(hit.id) || excludeIds?.has?.(hit.id) || tooRecent?.(hit.id)) continue;
      pool.push(withAccess([hit], access)[0]);
      seen.add(hit.id);
    }
  }
  // P1-F:实体共现 —— query 里出现的实体名,与候选轮 mention 过的名字求交(**整名匹配**,方案 §5)。
  // query 里没有名单中的名字 = 一切照旧(连 mention 查询都不发,零开销回滚路径)。
  const queryEntities = entityBoost > 0
    ? entityNames.filter((name) => String(name).length >= 2 && query.includes(String(name)))
    : [];
  const entitiesOption = queryEntities.length > 0 ? { query: queryEntities, weight: entityBoost } : null;
  if (entitiesOption) {
    // **补位**(与 FTS 通道同款):点名实体的轮次,标签不命中也拉进池 ——
    // 候选池先按标签收窄,实体准入(recallDecision 里)对池外的轮次够不着。
    const accessForEntity = accessMap(db, { conversation });
    const seenIds = new Set(pool.map((memory) => memory.id));
    for (const hit of turnsMentioningEntities(db, {
      conversation, names: queryEntities, olderThan: now - minAgeMs,
    })) {
      if (seenIds.has(hit.id) || noted.has(hit.id) || excludeIds?.has?.(hit.id) || tooRecent?.(hit.id)) continue;
      pool.push(withAccess([hit], accessForEntity)[0]);
      seenIds.add(hit.id);
    }
    const hits = entityHitsFor(db, pool.map((memory) => memory.id));
    for (const memory of pool) memory.entityHits = hits.get(memory.id) ?? [];
  }
  const decision = recallDecision(pool, query, {
    now, limit, minScore, halfLifeMs, peopleNames, semantic,
    recencyWeight,
    ...(scoring ? { scoring } : {}),
    ...(entitiesOption ? { entities: entitiesOption } : {}),
  });
  const remaining = budget - (noteText ? noteText.length + 1 : 0);
  const recalled = decision.picked.length > 0 && remaining > 0
    ? renderRecall(decision.picked, { budgetChars: remaining })
    : '';
  const text = [noteText, recalled].filter(Boolean).join('\n');
  if (text) return { ...decision, notes, text };

  if (decision.picked.length > 0) {
    return {
      ...decision,
      notes,
      text: '',
      reason: `挑中 ${decision.picked.length} 条,但长期层预算 ${budget} 字连第一条都装不下 —— 这轮不注入`,
    };
  }
  // ⚠️ "没有交集"有两种,**必须分开说**(诊断工具不许说谎):
  //    一种是库里真没有,另一种是**有、但都在最近 N 分钟内** —— 那不算"没有记忆",
  //    而是"刚说过的不用再提醒"。少了这一句,复核的人会以为词表或库出了问题。
  if (decision.picked.length === 0 && contentTags.length > 0 && minAgeMs > 0) {
    const withoutGate = candidatesFor(db, { conversation, tags: contentTags, max: 50 });
    if (withoutGate.length > 0) {
      return {
        ...decision,
        notes,
        text: '',
        reason: `有 ${withoutGate.length} 条交集,但都在最近 ${Math.round(minAgeMs / 60_000)} 分钟内` +
          '(刚说过的,不再提醒 —— 它还在活着的上下文里)',
      };
    }
  }
  return { ...decision, notes, text: '' };
}

/**
 * 造一个"长期层提供者" —— 与 `makeHandoffProvider` 同一个形状,便于**离线真跑**
 * (`scripts\memory-v0.js --simulate` 用的就是这个)。
 *
 * 返回值里除了文本,还有**为什么**(判据 2):
 *   · `picked` 每条自带 `why`(命中标签 / 重要性 / 多久以前);
 *   · 一条都没挑出来时 `reason` 说清是哪一类原因(没有内容标签 / 没有交集 / 分数不够 / 预算装不下)。
 *
 * 它**绝不抛错**:记忆坏了只是"这轮没有长期记忆",不该影响对话(与交接同一条纪律)。
 *
 * @param {{db: DatabaseSync, budget?: number, limit?: number, minScore?: number,
 *          halfLifeMs?: number, minAgeMs?: number, peopleNames?: string[],
 *          midTtlMs?: number, latestOnly?: boolean}} options
 *   `latestOnly`(默认 true,P1-C):只看仍有效的固化记忆;`false` 是回滚/审计开关。
 *   `minAgeMs`(默认 10 分钟)是"刚说过的别再提醒"那道闸:**最近的轮次还在活着的
 *   上下文里**,长期层再复述一遍既浪费 token、又让她听起来像在回音。
 * @returns {(arg: {conversation?: string, query?: string, now?: number}) =>
 *   {text: string, picked: Array<object>, notes: Array<object>, reason: string|null,
 *    queryTags: string[], trigger: boolean}}
 */
export function makeLongTermProvider({
  db,
  budget = 300,
  limit = 3,
  minScore,
  halfLifeMs,
  minAgeMs = 10 * 60 * 1000,
  midTtlMs = 3 * 24 * 3600 * 1000,
  // ⚠️ **刚端出来过的,这轮别再端**(2026-10-01 现场,用户报的 bug)。
  //    实测同一条固化记忆被**连着注入了 5 次**(日志里同一个 id 反复出现),
  //    于是当前角色一直在念同一句话(那次是「琪露诺の算术教室…」)。
  //    这正是"access 强化"里最便宜的那一半:被想起过的先歇一会儿。
  repeatSuppressMs = 30 * 60 * 1000,
  peopleNames = [],
  fts = null,
  // P1-C:软失效读路径开关(Lead 从 config 的 memory.latestOnly 传进来;关掉 = 回 P1-B 行为)。
  latestOnly = true,
  // W1 衰减治理两旋钮(Lead 从 config 的 memory.retrieval 传进来;见 pickLongTerm 同名参数)。
  noteLimit = 1,
  recencyWeight = 0.5,
  // P1-F:实体共现(名单 + 加成权重,Lead 从 config 的 memory.entity 传进来;weight 0/名单空 = 关)。
  entityNames = [],
  entityBoost = 0,
} = {}) {
  // 每段会话各自记一份"刚端过什么" —— 进程内即可:换代会话本身就是新的活上下文。
  const recentlyShown = new Map();
  const tooRecent = (conversation, id, now) => {
    const at = recentlyShown.get(conversation)?.get(id);
    return typeof at === 'number' && now - at < repeatSuppressMs;
  };
  const markShown = (conversation, ids, now) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    if (!recentlyShown.has(conversation)) recentlyShown.set(conversation, new Map());
    const bucket = recentlyShown.get(conversation);
    for (const id of ids) bucket.set(id, now);
    // 别让它无限长大:只留最近 200 条。
    if (bucket.size > 200) {
      for (const [id, at] of bucket) {
        if (bucket.size <= 200) break;
        if (now - at >= repeatSuppressMs) bucket.delete(id);
      }
    }
  };
  /**
   * 这一段会话"已经端过"的那些 id —— `pickLongTerm` 用它**换一条次好的端**,
   * 而不是"挑中最好那条、再把它滤掉"(那样这个通道这一轮就空着了)。
   */
  const recentIdSet = (conversation) => {
    const bucket = recentlyShown.get(conversation);
    return bucket && bucket.size > 0 ? new Set(bucket.keys()) : null;
  };
  /** 两本"已经端过"的账合并成一本(进程内窗口那本 + 调用方会话级那本)。 */
  const mergeIds = (a, b) => {
    if (!a || a.size === 0) return b;
    if (!b || b.size === 0) return a;
    return new Set([...a, ...b]);
  };
  return function recallLongTerm({
    conversation = null, query = '', now = Date.now(), peopleNames: perCall = null, excludeIds = null,
    entityNames: perCallEntities = null,
  } = {}) {
    const empty = { text: '', picked: [], notes: [], reason: null, queryTags: [], trigger: false };
    // 人名表**每轮现读**(它是边聊边学的) —— 工厂级的只是默认值。
    const names = perCall ?? peopleNames;
    try {
      const result = pickLongTerm(db, {
        conversation, query, now, peopleNames: names,
        budget, limit, minScore, halfLifeMs, minAgeMs, midTtlMs, latestOnly,
        noteLimit, recencyWeight,
        fts,
        // P1-F:实体名单也**每轮现读**(人名边聊边学、概念边玩边学会) —— 工厂级只给权重与默认名单。
        entityNames: perCallEntities ?? entityNames,
        entityBoost,
        // 两本账都要传给挑选那一步:进程内那本(30 分钟窗口)+ 调用方的会话级那本(D89)。
        excludeIds: mergeIds(excludeIds, recentIdSet(conversation)),
        tooRecent: (id) => tooRecent(conversation, id, now),
      });
      if (result.text) {
        // 记下"这一轮端了什么":① 进程内(下一轮就不再端);② **落盘**(D89,跨代也不端)。
        markShown(
          conversation,
          [...result.notes.map((note) => note.id), ...result.picked.map((memory) => memory.id)],
          now,
        );
        // ⚠️ **落盘失败绝不该把这一轮的回忆也带走**(2026-10-01 现场):只读连接
        //    (`memory-v0.js --simulate`、备份回读)写不了 access 表,
        //    而那条错误一旦冒出去,整轮就变成"检索失败(不影响对话)"—— 记忆明明已经挑出来了。
        //    所以这一笔按 best-effort 处理:失败只写一行警告,回忆照常注入。
        try {
          recordRecall(db, [...result.notes, ...result.picked], { conversation, now });
        } catch (err) {
          log.warn(`长期记忆：这一轮的访问账没记上（不影响回忆）: ${err.message}`);
        }
      }
      return result;
    } catch (err) {
      return { ...empty, reason: `检索失败(不影响对话)：${err.message}` };
    }
  };
}

// ---------------------------------------------------------------------------
// 知识库:第二个记忆来源(2026-10-02,D95)
//
// 对话记忆是"她/你说过的话";知识库是"**她在原作里经历过的**"(用户 2026-10-02 的口径)。
// 两条硬边界:① 不许跟"你们之间的事"混;② 永不进交接 / 摘要 / 固化 / 关于人的事实。
// ---------------------------------------------------------------------------

/** 知识块在 `embedding` 表里的 source(`doc:<doc_id>#<seq>`,与 `会话#seq` 同一套 id 空间)。 */
export function knowledgeSource(docId, seq) {
  return `doc:${docId}#${seq}`;
}

/**
 * 导入一份资料(**幂等**:同一 `(slug, edition)` 覆盖)。
 *
 * ⚠️ 一个事务里做四件事:① 建/更新 doc;② 删掉这份资料的旧块;③ 写新块;④ **作废它的旧向量**。
 * 第 ④ 步不能忘:重新切块之后,旧向量对应的文本已经不存在了 —— 错位的向量比没有向量更糟
 * (它会把 A 段算成 B 段,而且看起来一切正常)。作废之后由 `embed-backfill.js` 重算。
 */
export function importDoc(db, {
  slug, edition, title = null, source = null, license = null, text = '', now = Date.now(), max = CHUNK_MAX,
} = {}) {
  const cleanSlug = String(slug ?? '').trim();
  const cleanEdition = String(edition ?? '').trim();
  if (cleanSlug === '' || cleanEdition === '') throw new Error('导入资料要 slug 与 edition（幂等键是两者一起）');
  const chunks = chunkKnowledge(text, { max });
  if (chunks.length === 0) throw new Error('这份资料切不出任何块（空文本？）');
  const chars = chunks.reduce((sum, chunk) => sum + chunk.chars, 0);
  const existing = hasTable(db, 'doc')
    ? db.prepare('SELECT id FROM doc WHERE slug = ? AND edition = ?').get(cleanSlug, cleanEdition)
    : null;

  db.exec('BEGIN');
  try {
    let docId = existing ? Number(existing.id) : null;
    if (docId === null) {
      docId = Number(db.prepare(
        `INSERT INTO doc (slug, edition, title, source, license, chars, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(cleanSlug, cleanEdition, title, source, license, chars, now, now).lastInsertRowid);
    } else {
      db.prepare(
        `UPDATE doc SET title = COALESCE(?, title), source = COALESCE(?, source), license = COALESCE(?, license),
           chars = ?, updated_at = ? WHERE id = ?`,
      ).run(title, source, license, chars, now, docId);
    }
    db.prepare('DELETE FROM doc_chunk WHERE doc_id = ?').run(docId);
    const insert = db.prepare('INSERT INTO doc_chunk (doc_id, seq, heading, text, chars) VALUES (?, ?, ?, ?, ?)');
    for (const [index, chunk] of chunks.entries()) {
      insert.run(docId, index + 1, chunk.heading, chunk.text, chunk.chars);
    }
    let droppedVectors = 0;
    if (hasTable(db, 'embedding')) {
      droppedVectors = Number(db.prepare('DELETE FROM embedding WHERE source LIKE ?').run(`doc:${docId}#%`).changes ?? 0);
    }
    db.exec('COMMIT');
    return { docId, chunks: chunks.length, chars, droppedVectors, replaced: Boolean(existing) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 库里有哪些资料(每份带块数与已算好的向量数)。 */
export function libraryDocs(db) {
  if (!hasTable(db, 'doc')) return [];
  const hasEmbedding = hasTable(db, 'embedding');
  const extra = hasEmbedding
    ? `, (SELECT COUNT(*) FROM embedding e WHERE e.source LIKE 'doc:' || d.id || '#%') AS vectors`
    : ', 0 AS vectors';
  const sql = `SELECT d.id, d.slug, d.edition, d.title, d.source, d.license, d.chars, d.imported_at, d.updated_at,
      (SELECT COUNT(*) FROM doc_chunk c WHERE c.doc_id = d.id) AS chunks ${extra}
     FROM doc d ORDER BY d.slug ASC, d.updated_at DESC`;
  return db.prepare(sql).all().map((row) => ({
    id: Number(row.id),
    slug: String(row.slug),
    edition: String(row.edition),
    title: row.title ?? null,
    source: row.source ?? null,
    license: row.license ?? null,
    chars: Number(row.chars) || 0,
    chunks: Number(row.chunks) || 0,
    vectors: Number(row.vectors) || 0,
    importedAt: Number(row.imported_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }));
}

/** 取知识块(检索与回填共用;`docId` 省略 = 全部)。 */
export function knowledgeChunks(db, { docId = null, limit = 5000 } = {}) {
  if (!hasTable(db, 'doc_chunk')) return [];
  const cap = Math.max(1, Math.min(50000, Number(limit) || 5000));
  const rows = docId === null
    ? db.prepare('SELECT doc_id, seq, heading, text, chars FROM doc_chunk ORDER BY doc_id, seq LIMIT ?').all(cap)
    : db.prepare('SELECT doc_id, seq, heading, text, chars FROM doc_chunk WHERE doc_id = ? ORDER BY seq LIMIT ?').all(docId, cap);
  return rows.map((row) => ({
    id: knowledgeSource(row.doc_id, row.seq),
    docId: Number(row.doc_id),
    seq: Number(row.seq),
    heading: row.heading ?? null,
    text: String(row.text),
    chars: Number(row.chars) || 0,
  }));
}

/** 知识库的规模(启动横幅与报表用)。 */
export function knowledgeStats(db) {
  if (!hasTable(db, 'doc')) return { docs: 0, chunks: 0, chars: 0, vectors: 0 };
  const docs = Number(db.prepare('SELECT COUNT(*) AS n FROM doc').get().n) || 0;
  const chunks = hasTable(db, 'doc_chunk') ? Number(db.prepare('SELECT COUNT(*) AS n FROM doc_chunk').get().n) || 0 : 0;
  const chars = hasTable(db, 'doc_chunk')
    ? Number(db.prepare('SELECT COALESCE(SUM(chars), 0) AS n FROM doc_chunk').get().n) || 0 : 0;
  const vectors = hasTable(db, 'embedding')
    ? Number(db.prepare("SELECT COUNT(*) AS n FROM embedding WHERE source LIKE 'doc:%'").get().n) || 0 : 0;
  return { docs, chunks, chars, vectors };
}

/**
 * 造一个"知识库提供者" —— 形状与 `makeLongTermProvider` 一致,但**它自己一套账**。
 *
 * ⚠️ 三处与对话记忆**刻意不同**:
 *   ① **不记 `access` 账**:那张表记的是"她什么时候想起过某件旧事";
 *      而原作经历不是"被想起来的",它就是她的一部分 —— 每轮端出来反而是对的。
 *      重复抑制只用**进程内**那一份(30 分钟窗口)。
 *   ② **`at` 统一给 `now`**:资料没有"新近"这回事。给同一个常量 = 不加近因那一维,
 *      但分数整体抬高一档,于是"只靠语义命中"(标签零交集)也过得了 minScore —— 那正是要的。
 *   ③ **预算独立**:默认 600 字 / 2 条(用户 2026-10-02 定的"跟长期记忆一样处理"),
 *      而且**永不进交接**(判据 3)。
 *
 * @returns {(arg: {conversation?: string|null, query?: string, now?: number,
 *   semantic?: object|null, excludeIds?: Set<string>|null}) =>
 *   {text: string, picked: Array<object>, reason: string|null, queryTags: string[]}}
 */
export function makeKnowledgeProvider({
  db, budget = 600, limit = 2, minScore = 1, repeatSuppressMs = 30 * 60 * 1000, maxPool = 5000,
} = {}) {
  const recentlyShown = new Map();
  return function recallKnowledge({
    conversation = null, query = '', now = Date.now(), semantic = null, excludeIds = null,
  } = {}) {
    const empty = { text: '', picked: [], reason: null, queryTags: [] };
    try {
      const chunks = knowledgeChunks(db, { limit: maxPool });
      if (chunks.length === 0) return empty;
      const vectors = embeddingMap(db, { limit: 50000 });
      const bucket = recentlyShown.get(conversation) ?? new Map();
      const excluded = new Set([...(excludeIds ?? []), ...bucket.keys()]);
      const candidates = chunks.map((chunk) => ({
        id: chunk.id,
        at: now,
        // ⚠️ 小标题也进检索文本:它是原文自带的分段语义。
        text: chunk.heading ? `${chunk.heading}｜${chunk.text}` : chunk.text,
        tags: tagsFor(chunk.text),
        vector: vectors.get(chunk.id) ?? null,
      }));
      const decision = recallDecision(candidates, query, { now, limit, minScore, semantic, excludeIds: excluded });
      const text = renderKnowledge(decision.picked, { budgetChars: budget });
      if (text !== '') {
        for (const picked of decision.picked) bucket.set(String(picked.id), now);
        // 这本账只关"30 分钟内别重复",丢了不影响正确性 —— 别让它无限长大。
        if (bucket.size > 500) bucket.clear();
        recentlyShown.set(conversation, bucket);
      }
      return { text, picked: decision.picked, reason: decision.reason, queryTags: decision.queryTags };
    } catch (err) {
      return { ...empty, reason: `知识库检索失败（不影响对话）：${err.message}` };
    }
  };
}

// ---------------------------------------------------------------------------
// **滚动摘要:第三层**(2026-10-02,D91)
//
// 分工(与 D77 那张表一致):前面两层管"最近"——交接给最近十几轮的原文,
// 长期层每轮给几条挑出来的;这一层管"**很久以前**"。它治的是交接那 1400 字
// **早就顶满**这件事(实测 1399):更早的历史只能一行一轮地挤,越久越挤不下。
//
// 三条边界(照 D91 的三个坑):
//   · **不在启动路径上同步调模型**:这一层只负责"组装材料 / 读写缓存 / 判该不该重算",
//     模型调用由 bridge 注入(`options.summarize`)。离线脚本不传就**只读缓存**,一个 token 都不花;
//   · **防她背摘要**:提示词里写明"这是背景不是台词"(与交接块同一套措辞);
//   · **可重建**:`SUMMARY_VERSION` 变了就算过期,下次重算 —— 它不在 `MEMORY_VERSION` 那条链上。
// ---------------------------------------------------------------------------

/**
 * 两次自动重算之间**最少**隔多久(默认 3 小时)。
 *
 * ⚠️ 2026-10-06(D135)加它,因为它上一条判据("攒够 `SUMMARY_REFRESH_TURNS` 轮新记录")
 *    **恒为真**:游标后面的轮次数永远等于"留给交接的最近 `recent` 轮"那个窗口(实测 14~85),
 *    所以每个 15 分钟的拍子都会重算一次 —— 384 次调用/天/只,吃掉了两只机器人 **98.4%** 的账单。
 *    摘要是**给"更早以前"用的梗概**,最近的话永远由交接给原文,所以晚几小时重算没有代价;
 *    冷清群也不会因为"时间到了"就白算(仍要**同时**攒够新轮次才动)。
 */
export const SUMMARY_MIN_INTERVAL_MS = 3 * 3600 * 1000;

/**
 * 摘要**该不该重算**?**纯函数**,可测。
 *
 * @param {{version?: number, coveredTurns?: number}|null} summary 库里现有的那一份
 * @param {{newTurns?: number, version?: number, minTurns?: number, builtAt?: number|null,
 *          minIntervalMs?: number, now?: number}} [options]
 */
export function summaryDue(summary, {
  newTurns = 0,
  version = SUMMARY_VERSION,
  minTurns = SUMMARY_REFRESH_TURNS,
  // ⚠️ 字段名是 `createdAt`(**`getSummary()` 返回的形状**),不是库里的列名 `created_at`。
  //    第一版这里写的是下划线版 → `builtAt` 恒为 null → **这道闸从来没合上过**,
  //    而单测没抓住(测试里手写的对象带了 `created_at`)。真数据一跑就露了 ——
  //    所以现在两个都认,并且 `scripts\selftest.js` 里补了一条**走真库往返**的用例。
  builtAt = summary?.createdAt ?? summary?.created_at ?? null,
  minIntervalMs = SUMMARY_MIN_INTERVAL_MS,
  now = Date.now(),
} = {}) {
  // 没有摘要 → 该算(第一条总要有人写)。
  if (!summary || !String(summary.text ?? '').trim()) return true;
  // 规则变了 → 该算(可重建)。⚠️ **这一支不许被最小间隔挡住** —— 否则以后升级
  //    `SUMMARY_VERSION` 会永远不生效(重算是"可重建"这条纪律的落点)。
  if (Number(summary.version ?? 0) !== Number(version)) return true;
  // 攒够了新轮次 → 才轮到"该不该现在算"。⚠️ 用**覆盖之后新增的轮次**而不是"距上次多久":
  //    冷清群里"过了一周"可能只聊了三句,只按时间算就会反复白算。
  if (!(Number(newTurns ?? 0) >= Math.max(1, Number(minTurns) || 1))) return false;
  // ⚠️ **再加一道最小间隔(2026-10-06,D135)** —— 因为实测发现"攒够新轮次"这个判据
  //    **恒为真**:游标 `coversUpTo` 是"摘要区间里最后一轮",它后面**永远留着最近 `recent` 轮**
  //    (那些是留给交接用原文的),于是 `countTurnsAfter(游标)` 恒等于那个窗口的大小(实测 14~85),
  //    永远 ≥ 门槛 12 → 每 15 分钟就白算一次(96 次/天/会话)。现场指纹:日志里
  //    「攒了 14 轮新记录」**连续八次一模一样**。
  //    所以现在要求"攒够了 **且** 距上次真的过了 minIntervalMs"。
  if (builtAt != null && Number(minIntervalMs) > 0 && now - Number(builtAt) < Number(minIntervalMs)) return false;
  return true;
}

/**
 * 组装**喂给模型**的那份材料(要摘要的旧轮次,按时间正序,一行一轮)。
 *
 * ⚠️ 这里**复用交接的写法**(`whatWasSaid` / `whatSheSaid`)而不是另写一套:
 * 两处对"桥自己写的指令"的处理必须一致,否则摘要里会混进
 * 「现在是早上,你可以跟大家打个招呼」那种排程提示词(D75 那个坑)。
 *
 * @param {Array<object>} rows 交给 `conversationMemory` 取回来的行(新的在前)
 * @param {{recent?: number, maxChars?: number}} [options]
 * @returns {{text: string, turns: number, coversUpTo: string|null}}
 */
export function buildSummaryInput(rows, { recent = HANDOFF_RECENT, maxChars = 6000 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && (row.user_text || row.reply_text));
  if (list.length === 0) return { text: '', turns: 0, coversUpTo: null };
  const chronological = [...list].reverse(); // 旧的在前
  // **排除最近 recent 轮** —— 它们仍然由交接给原文(更准),摘要只覆盖更早的。
  const older = chronological.slice(0, Math.max(0, chronological.length - Math.max(0, recent)));
  if (older.length === 0) return { text: '', turns: 0, coversUpTo: null };
  const lines = [];
  let used = 0;
  // 从**最近**的旧轮次往回排,保证截断发生在最久远的那头。
  for (const row of [...older].reverse()) {
    const line = `${shortTime(row.at)} ${whatWasSaid(row)} → ${whatSheSaid(row, 40)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return {
    text: lines.join('\n'),
    turns: lines.length,
    // 游标 = 这批里**最后一轮**(最晚的那条)的 id —— 下次只看它之后的。
    coversUpTo: rowId(older[older.length - 1]),
  };
}

/** 一轮的稳定 id(与 `note.source` / `access.source` 同一套)。 */
function rowId(row) {
  return row?.session_id && Number.isFinite(Number(row?.seq)) ? `${row.session_id}#${row.seq}` : null;
}

/**
 * 把材料交给模型、拿回摘要。**纯函数**:调用方注入 `summarize`(测试里给假的)。
 *
 * ## ⚠️ 2026-10-02 改成**第三人称事实陈述**(用户 2026-10-02 拍板)
 *
 * 第一版写的是"用**她的口吻**写"。实测(当前角色的群,127 轮 → 301 字)读起来很像她说话:
 * 「开局谁管饭吾就认谁当队友…」—— 但那正是**风险**:摘要每代会话都进提示词,
 * 用她的口吻写就等于给了她一段**现成的台词**,她会照着念(和"背摘要"是同一个病)。
 * 用户的原话是"如果改成第三人称会更聪明更自然就改",而这也正是本层设计里那句
 * **"这是背景,不是台词"**该有的写法 —— 口吻归角色卡,事实归摘要。
 *
 * 四条要求(别在调用点各写一套):
 *   · **第三人称事实陈述**(「她答应过…」「群里聊过…」),不模仿任何人的语气;
 *   · 只写**发生过什么**,不写"我记得"这类元话语(防她背摘要);
 *   · 别编 —— 材料里没有的事不许写(与"数字只能来自库"同族);
 *   · 给她一个**能接着说下去**的状态(还在等什么、答应过什么没做),而不是流水账。
 */
export async function summarizeConversation({
  history,
  summarize,
  who = '这个会话',
  budgetChars = SUMMARY_TARGET_CHARS,
  facts = '',
} = {}) {
  if (typeof summarize !== 'function') return null;
  if (!String(history ?? '').trim()) return null;
  const factLine = String(facts ?? '').trim();
  const prompt = [
    `下面是一段${who}的过往对话记录（一行一轮：时间 对方说的话 → 她的回复）。`,
    `请把它压缩成一段不超过 ${budgetChars} 字的**背景资料**。`,
    '',
    '要求：',
    '1. **第三人称、事实陈述**（「她答应过…」「群里聊过…」「有人问过她…」）——',
    '   **不要模仿她的语气**、不要写台词、不要用「吾」这类自称；它是档案，不是她说的话；',
    '2. 只写**发生过什么**：聊过哪些事、答应过谁什么、关系/称呼有什么变化、有什么还没了结；',
    '3. 不要写"我记得""根据记录"这类话 —— 这是背景，不是她要说的内容；',
    '4. 不要编造记录里没有的事；不确定的就不写；',
    '5. 直接给那一段文字，不要标题、不要列表、不要解释。',
    // ⚠️ **1.106.4(D176)**:她"自己过日子"那些话**不进对话记录**(见 `NON_MEMORY_KINDS` 的
    //    `selflife`),但**有特殊性的那几件**要留在摘要里 —— 它们来自 `stats_event`(代码给的事实),
    //    不是从她的自言自语里读出来的。日用小事(擦魔杖/泡澡/吃饭)不在这一段里,别自己补。
    ...(factLine === '' ? [] : [
      '',
      '另外,**她自己的经历**(下面这些是系统给的**事实**,照写、别编、别展开成故事;',
      '记录里没有的日常小事——吃饭、泡澡、擦魔杖之类——**不要写进来**):',
      factLine,
    ]),
    '',
    '记录：',
    history,
  ].join('\n');
  const written = await summarize(prompt, { budgetChars });
  const text = cleanMemoryText(String(written ?? '')).slice(0, budgetChars * 2);
  return text.trim() === '' ? null : text;
}

/** 读一份摘要(不存在返回 null)。 */
export function getSummary(db, conversation) {
  if (!conversation) return null;
  if (!hasTable(db, 'summary')) return null;
  const row = db.prepare(
    'SELECT conversation, text, covers_up_to, covered_turns, version, created_at, build_ms FROM summary WHERE conversation = ?',
  ).get(String(conversation));
  if (!row) return null;
  return {
    conversation: String(row.conversation),
    text: String(row.text ?? ''),
    coversUpTo: row.covers_up_to == null ? null : String(row.covers_up_to),
    coveredTurns: Number(row.covered_turns) || 0,
    version: Number(row.version) || 0,
    createdAt: Number(row.created_at) || 0,
    buildMs: Number(row.build_ms) || 0,
  };
}

/** 写一份摘要(覆盖式:一段会话只有一份)。 */
export function saveSummary(db, { conversation, text, coversUpTo = null, coveredTurns = 0, buildMs = null, now = Date.now() } = {}) {
  if (!conversation) return null;
  db.prepare(
    `INSERT INTO summary (conversation, text, covers_up_to, covered_turns, version, created_at, build_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation) DO UPDATE SET
       text = excluded.text, covers_up_to = excluded.covers_up_to, covered_turns = excluded.covered_turns,
       version = excluded.version, created_at = excluded.created_at, build_ms = excluded.build_ms`,
  ).run(String(conversation), String(text ?? ''), coversUpTo, Math.max(0, coveredTurns), SUMMARY_VERSION, now, buildMs);
  return getSummary(db, conversation);
}

/**
 * **删掉一段会话的滚动摘要**(2026-10-02,D91 的小尾巴)。返回删掉的那一份;本来就没有 → `null`。
 *
 * ⚠️ 为什么必须能删:与 D80/D81 同一条纪律 —— **能写不能删的记忆层不合格**
 * (事实与固化记忆都已经有撤销了,摘要不能是例外)。
 *
 * ⚠️ 删掉**不等于失忆**:`summary` 是**派生数据**(`SUMMARY_VERSION` 单独一个号),
 * 下一拍 `summaryPlan` 会判成"还没有摘要"并按当前规则重算;删的当下,那一段
 * "更早的"暂时回到原文那一层。回执必须把这句话说清楚,否则用户以为删掉了内容。
 */
export function forgetSummary(db, conversation) {
  if (!conversation || !hasTable(db, 'summary')) return null;
  const existing = getSummary(db, conversation);
  if (!existing) return null;
  db.prepare('DELETE FROM summary WHERE conversation = ?').run(String(conversation));
  return existing;
}

/**
 * 这段会话现在的摘要状况:该不该重算、要摘哪些轮次。
 *
 * **它只做判断与组装,不调模型** —— 于是离线脚本可以拿它复核"下一次会摘什么",一分钱不花。
 */
export function summaryPlan(db, {
  conversation = null,
  now = Date.now(),
  recent = HANDOFF_RECENT,
  minTurns = SUMMARY_REFRESH_TURNS,
  minIntervalMs = SUMMARY_MIN_INTERVAL_MS,
  limit = 400,
  budgetChars = SUMMARY_TARGET_CHARS,
  peopleNames = [],
} = {}) {
  void peopleNames;
  if (!conversation) return { summary: null, due: false, input: null, newTurns: 0, reason: '没有会话 key' };
  const summary = getSummary(db, conversation);
  // 旧轮次:多取一些,`buildSummaryInput` 会把最近 `recent` 轮剔掉。
  const memory = conversationMemory(db, conversation, limit);
  const input = buildSummaryInput(memory.rows, { recent });
  const newTurns = countTurnsAfter(db, conversation, summary?.coversUpTo ?? null);
  const builtAt = summary?.createdAt ?? summary?.created_at ?? null;
  const waitedMs = builtAt == null ? null : Math.max(0, now - Number(builtAt));
  const due = summaryDue(summary, { newTurns, minTurns, builtAt, minIntervalMs, now }) && Boolean(input?.text);
  const reason = !input?.text
    ? '还没有"更早的轮次"可摘（最近这些由交接给原文，更准）'
    : due
      ? (!summary
        ? '还没有摘要'
        : Number(summary.version) !== SUMMARY_VERSION
          ? `摘要规则从 v${summary.version} 变到 v${SUMMARY_VERSION}`
          : `攒了 ${newTurns} 轮新记录，且距上次已 ${Math.round((waitedMs ?? 0) / 60000)} 分钟`)
      : (Number(newTurns) < Math.max(1, minTurns)
        ? `不急（覆盖之后只有 ${newTurns} 轮新记录，门槛 ${minTurns}）`
        : `不急（距上次才 ${Math.round((waitedMs ?? 0) / 60000)} 分钟，最小间隔 ${Math.round(minIntervalMs / 60000)} 分钟）`);
  return { summary, due, input, newTurns, reason, budgetChars };
}

/** 从 `coversUpTo` 之后数有多少轮(没有游标 = 全部)。 */
function countTurnsAfter(db, conversation, coversUpTo) {
  const pattern = `${conversation}%`;
  if (!coversUpTo) {
    return db.prepare(
      `SELECT COUNT(*) n FROM turn t JOIN session s ON s.id = t.session_id
        WHERE s.conversation = ? AND length(t.user_text) > 0`,
    ).get(conversation).n;
  }
  // 游标是 `会话id#seq`。⚠️ **不能拿 seq 比大小**:跨代的会话 id 不一样,seq 各自从头数,
  // 所以按"那一轮的时刻(at)之后的轮次"数 —— 与 `buildSummaryInput` 的时间序口径一致。
  const [sessionId, seqText] = String(coversUpTo).split('#');
  const seq = Number(seqText) || 0;
  return db.prepare(
    `SELECT COUNT(*) n FROM turn t JOIN session s ON s.id = t.session_id
      WHERE s.conversation = ? AND length(t.user_text) > 0
        AND t.at > COALESCE((SELECT at FROM turn WHERE session_id = ? AND seq = ?), 0)`,
  ).get(conversation, sessionId, seq).n;
}

/** 最近活跃的几段会话(给滚动摘要的拍子用:只对"真的还在聊"的会话算,别把整个库翻一遍)。
 *
 *  ⚠️ 2026-10-06(D135):**工具会话不算"还在聊的会话"** —— 摘要把 `qqbot-summary` 自己
 *     也当成了会话,于是它每 15 分钟摘要一次**自己写下的摘要**(自指环),账单的大头就是它。
 *     判据(日志):不该再出现 `滚动摘要：qqbot-summary …`。
 */
export function activeConversations(db, limit = 8, { withinMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const cap = Math.max(1, Math.min(50, limit));
  // ⚠️ **多取一些再过滤**:剔掉工具会话之后仍要凑够 `cap` 段真会话,
  //    否则"最近活跃的 8 段"会静默变成 6 段(少摘要几段 = 她忘事,而且不报错)。
  const rows = db.prepare(
    `SELECT s.conversation AS conversation, MAX(t.at) AS last_at
       FROM turn t JOIN session s ON s.id = t.session_id
      WHERE t.at >= ?
      GROUP BY s.conversation
      ORDER BY last_at DESC
      LIMIT ?`,
  ).all(now - withinMs, Math.min(50, cap * 3));
  return rows
    .map((row) => String(row.conversation))
    .filter((key) => !isToolConversation(key))
    .slice(0, cap);
}

// ---------------------------------------------------------------------------
// **向量:第三维相关度**(2026-10-02,D92)
//
// 分工与 access 那次一样:**数据的读写留在这里**(bridge 与脚本共用一份),
// **"向量从哪来"抽成纯函数**(`embedRequestFor`) —— 于是补向量的脚本能单独测,
// 而 bridge 本体里**没有一行 HTTP**(它只读已经存好的向量;没有就退回标签那套)。
// ---------------------------------------------------------------------------

/** `source` 列里存的东西(与 note.source / access.source 同一套 id)。 */
function embeddingSourceOf(key) {
  return String(key ?? '');
}

/** 把 `{id}` 变成存库用的 source(它已经在用 `会话#seq` 这套 id,直接用)。 */
function embeddingIdOf(item) {
  return String(typeof item === 'string' ? item : item?.id ?? '');
}

/** 向量的二进制形态:float32 小端。**纯函数**。 */
export function packVector(values) {
  const list = Array.from(values ?? [], Number);
  const buffer = Buffer.alloc(list.length * 4);
  for (let i = 0; i < list.length; i += 1) buffer.writeFloatLE(Number.isFinite(list[i]) ? list[i] : 0, i * 4);
  return buffer;
}

/** 反过来。**纯函数**。 */
export function unpackVector(blob) {
  if (!blob) return [];
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const count = Math.floor(buffer.length / 4);
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

/**
 * 写一条向量。`source` = 会话#seq(与 `note.source` 同一套)。
 * ⚠️ `model` 一起存下来:**换模型/换维度时必须能看出旧向量作废**。
 */
export function saveEmbedding(db, { source, vector, model = 'unknown', now = Date.now() } = {}) {
  if (!source || !Array.isArray(vector) || vector.length === 0) return 0;
  db.prepare(
    `INSERT INTO embedding (source, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET model = excluded.model, dim = excluded.dim,
       vec = excluded.vec, created_at = excluded.created_at`,
  ).run(embeddingSourceOf(source), String(model), vector.length, packVector(vector), now);
  return 1;
}

/**
 * 取一批向量(`id → number[]`)。
 *
 * ⚠️ 三条边界(与 access 那次同族):
 *   · 表不在(只读连接 / 还没迁过的库)→ 返回空 Map,**不抛错**;
 *   · `matchingOnly`(给了模型名):**只认同一个模型算的** —— 换了模型之后旧向量不能拿来比
 *     (语义空间变了,拿它算相似度会静默给出乱码分数);
 *   · 超过 `limit` 的行丢掉(它是 Map,不排序 —— 调用方要的是"有没有",不是"全部")。
 */
export function embeddingMap(db, { model = null, matchingOnly = false, limit = 5000 } = {}) {
  if (!hasTable(db, 'embedding')) return new Map();
  const rows = db.prepare(
    `SELECT source, vec FROM embedding${matchingOnly && model ? ' WHERE model = ?' : ''} LIMIT ?`,
  ).all(...(matchingOnly && model ? [String(model)] : []), Math.max(1, limit));
  const map = new Map();
  for (const row of rows) map.set(String(row.source), unpackVector(row.vec));
  return map;
}

/** 库里向量有多少条 / 是哪个模型的(启动横幅与补向量脚本都要看)。 */
export function embeddingStats(db) {
  if (!hasTable(db, 'embedding')) return { count: 0, models: [], dims: [] };
  const rows = db.prepare('SELECT model, dim, COUNT(*) n FROM embedding GROUP BY model, dim').all();
  return {
    count: rows.reduce((sum, row) => sum + Number(row.n), 0),
    models: [...new Set(rows.map((row) => String(row.model)))],
    dims: [...new Set(rows.map((row) => Number(row.dim)))],
  };
}

/**
 * **补向量**:哪些轮次/固化记忆还没有向量、该喂什么文本。**纯函数**(不写库、不联网)。
 *
 * 两条口径:
 *   · 喂给模型的文本 = 人说的话(`user_text`),**不带**桥自己写的注入说明 —— 那些是要求,不是内容;
 *   · 已经**有向量且模型一致**的跳过;模型变了则**重算**(否则会拿旧语义空间的向量去比,静默错)。
 *
 * @returns {{todo: Array<{id: string, text: string}>, skipped: number, stale: number}}
 */
export function embeddingBacklog(db, { model = null, conversation = null, limit = 500 } = {}) {
  if (!hasTable(db, 'embedding')) return { todo: [], skipped: 0, stale: 0 };
  const skip = NON_MEMORY_KINDS.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT t.session_id, t.seq, t.user_text, s.conversation, s.file AS session_file,
            e.source AS has_vec, e.model AS vec_model
       FROM turn t
       JOIN session s ON s.id = t.session_id
       LEFT JOIN embedding e ON e.source = t.session_id || '#' || t.seq
      WHERE t.kind NOT IN (${skip}) AND length(t.user_text) > 0
        ${conversation ? 'AND s.conversation = ?' : ''}
      ORDER BY t.at DESC LIMIT ?`,
  ).all(...NON_MEMORY_KINDS, ...(conversation ? [conversation] : []), Math.max(1, Math.min(5000, limit)));
  const projectionReady = ownDerivedProjectionReady(db);
  const todo = [];
  let skipped = 0;
  let stale = 0;
  for (const row of rows) {
    const id = `${row.session_id}#${row.seq}`;
    // ⚠️ **桥自己写的与工具会话都不给算向量**(2026-10-02 dry-run 抓到的):
    //    ① 注入块(`【记忆交接】…`)—— 给桥的指令算向量 = 拿它跟人话比相似度(D75 那个病);
    //    ② `qqbot-summary* / qqbot-verify* / card-eval-*` 这类**工具/自检会话** ——
    //       它们的"用户消息"是提示词(比如摘要指令),不是任何人对她说的话。
    if (isInjectedBlock(row.user_text)) { skipped += 1; continue; }
    if (isToolConversation(row.conversation) || isToolConversation(row.session_id)) { skipped += 1; continue; }
    const text = cleanMemoryText(projectDerivedRead(row, projectionReady));
    if (text === '') { skipped += 1; continue; }
    if (row.has_vec) {
      // 模型换了 → 旧向量作废(**重算**,而不是拿着旧语义空间的向量继续用)
      if (model && String(row.vec_model ?? '') !== String(model)) {
        stale += 1;
        todo.push({ id, text, conversation: row.conversation ?? null });
      } else skipped += 1;
      continue;
    }
    todo.push({ id, text, conversation: row.conversation ?? null });
  }
  // 知识库(2026-10-02,D95):资料块用**同一张** embedding 表,source = doc:<doc_id>#<seq>。
  // ⚠️ 与轮次共用服务与模型,但**不共用 `conversation`** —— 资料不属于任何一段对话。
  if (hasTable(db, 'doc_chunk')) {
    const docRows = db.prepare(
      `SELECT c.doc_id, c.seq, c.heading, c.text, e.source AS has_vec, e.model AS vec_model
         FROM doc_chunk c
         LEFT JOIN embedding e ON e.source = 'doc:' || c.doc_id || '#' || c.seq
        ORDER BY c.doc_id, c.seq LIMIT ?`,
    ).all(Math.max(1, Math.min(5000, limit)));
    for (const row of docRows) {
      const id = `${knowledgeSource(row.doc_id, row.seq)}`;
      const text = cleanMemoryText(row.heading ? `${row.heading}｜${row.text}` : row.text);
      if (text === '') {
        skipped += 1;
        continue;
      }
      if (row.has_vec) {
        if (model && String(row.vec_model ?? '') !== String(model)) {
          stale += 1;
          todo.push({ id, text, conversation: null });
        } else skipped += 1;
        continue;
      }
      todo.push({ id, text, conversation: null });
    }
  }
  // 自愈通道(F1):上面按 `at DESC LIMIT` 取窗口,窗口内每轮都已有当前模型向量时,
  // **更老**那些"向量被失效删掉"的轮永远进不了 backlog(每拍 todo=0,语义召回永久缺口)。
  // 这里只补「缺向量 / 模型过期」的行;既有 skipped/stale 计数口径不变(它们仍由上面主查询算)。
  const remaining = Math.max(1, Math.min(5000, limit)) - todo.length;
  if (remaining > 0) {
    const seen = new Set(todo.map((item) => item.id));
    // 窗口留足余量:JS 侧还会滤掉注入块/工具会话,取窄了会再次"饿死"更老的失效项。
    const healWindow = Math.min(5000, Math.max(50, remaining * 20));
    const healRows = db.prepare(
      `SELECT t.session_id, t.seq, t.user_text, s.conversation, s.file AS session_file
         FROM turn t
         JOIN session s ON s.id = t.session_id
         LEFT JOIN embedding e ON e.source = t.session_id || '#' || t.seq
        WHERE t.kind NOT IN (${skip}) AND length(t.user_text) > 0
          AND (e.source IS NULL OR (? IS NOT NULL AND e.model <> ?))
          ${conversation ? 'AND s.conversation = ?' : ''}
        ORDER BY t.at DESC LIMIT ?`,
    ).all(...NON_MEMORY_KINDS, model ?? null, model ?? null,
      ...(conversation ? [conversation] : []), healWindow);
    for (const row of healRows) {
      if (todo.length >= Math.max(1, Math.min(5000, limit))) break;
      const id = `${row.session_id}#${row.seq}`;
      if (seen.has(id)) continue;
      const text = cleanMemoryText(projectDerivedRead(row, ownDerivedProjectionReady(db)));
      if (text === '' || isInjectedBlock(row.user_text)
        || isToolConversation(row.conversation) || isToolConversation(row.session_id)) continue;
      seen.add(id);
      todo.push({ id, text, conversation: row.conversation ?? null });
    }
  }
  return { todo, skipped, stale };
}

/** 这一条向量是哪个模型算的(没有则 null)。 */
export function embeddingModelOf(db, source) {
  if (!hasTable(db, 'embedding')) return null;
  const row = db.prepare('SELECT model FROM embedding WHERE source = ?').get(embeddingSourceOf(source));
  return row ? String(row.model) : null;
}

/**
 * 这段会话是不是**工具/自检**会话(不是真对话)。
 *
 * ⚠️ 2026-10-06(D135):判据本体**挪到了 `memory-archive.js`**(那里是归档层,归档时就该定 kind),
 *    这里保留导出只是为了**老调用方**(脚本/测试)不改 —— 两份正则迟早分叉,所以只留一份。
 */
export { isToolConversation };

/**
 * **把一批 id 拼成"该发给 embedding 服务"的请求体** —— 纯函数,所以补向量的脚本可单测。
 *
 * 为什么把"怎么发"也抽出来:这个项目里 bridge **没有 HTTP 依赖**,
 * 而"给一批文本算向量"是一次性/离线动作 —— 让**脚本**去发请求、bridge 只读结果,
 * 是最小改动面(与 D89 那条"落账失败不许带走回忆"同族:边界外的东西不许拖住边界内)。
 */
export function embedRequestFor({ url, model, items } = {}) {
  const list = (items ?? []).filter((item) => item?.id && String(item.text ?? '').trim() !== '');
  return {
    url: String(url ?? '').replace(/\/+$/, ''),
    model: model ?? null,
    body: {
      model: model ?? undefined,
      input: list.map((item) => String(item.text).slice(0, 2000)),
    },
    ids: list.map((item) => String(item.id)),
  };
}

/**
 * 把服务返回的向量**配回 id 并验形状** —— 纯函数。
 * ⚠️ 数量对不上 / 维度不一致 → **报错,不许静默错位**(错位的向量比没有向量更糟:
 * 它会把 A 的话算成 B 的记忆,而且看起来一切正常)。
 */
export function pairEmbeddings({ ids, data } = {}) {
  const list = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(ids) || !Array.isArray(list)) throw new Error('返回体形状不对：需要 data[] 与 ids[]');
  if (ids.length !== list.length) {
    throw new Error(`返回条数对不上：要 ${ids.length} 条，拿到 ${list.length} 条 —— 拒绝写库`);
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 1) {
    const vector = list[i]?.embedding ?? list[i];
    if (!Array.isArray(vector) || vector.length === 0) throw new Error(`第 ${i} 条没有向量`);
    out.push({ id: String(ids[i]), vector: vector.map(Number) });
  }
  const dim = out[0].vector.length;
  for (const entry of out) {
    if (entry.vector.length !== dim) throw new Error(`维度不一致：${entry.vector.length} vs ${dim} —— 拒绝写库`);
  }
  return { dim, vectors: out };
}

/**
 * 向**本机 embedding 服务**要一个向量。**唯一一处 HTTP**(整个 bridge 只有这里)。
 *
 * 三条设计(都是"边界外的东西不许拖住边界内"那条纪律的应用):
 *   · **只打本机**(URL 由配置给,默认 127.0.0.1)—— bridge 不依赖任何外部服务;
 *   · **超时很短、失败即 null** → 调用方退回标签那套(与 D89 那次"落账失败不许带走回忆"同族);
 *   · **没有服务就一个请求都不发**(配置关着时连调用都不会走到这里)。
 *
 * @param {string} text 要算向量的那句话
 * @param {{url?: string, model?: string, timeoutMs?: number, fetchImpl?: Function}} [options]
 * @returns {Promise<number[]|null>}
 */
export async function fetchQueryVector(text, {
  url = '',
  model = null,
  timeoutMs = 800,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  const query = String(text ?? '').trim();
  if (base === '' || query === '' || typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(50, timeoutMs));
  try {
    const response = await fetchImpl(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model ?? undefined, input: [query.slice(0, 2000)] }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const vector = body?.data?.[0]?.embedding ?? body?.embedding;
    return Array.isArray(vector) && vector.length > 0 ? vector.map(Number) : null;
  } catch {
    // 连不上 / 超时 / 返回体不对 —— 都当成"这一轮没有语义那一维",不打扰对话。
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * **增量补向量**(2026-10-18,P0-3):让 bridge 自己在拍子上补,不再依赖人记得跑脚本。
 *
 * 为什么要有它(现场):向量表 678 条**全部停在 10-02/03 的 DSH 时代** ——
 * own 时代 3,400+ 轮一条向量都没有,而 `QQBOT_MEMORY_EMBEDDING=true` 是开着的。
 * 语义那一维不是"坏了",是**从来没覆盖过新数据**:每轮查询向量算得出来,但候选池
 * (标签命中的轮次)里没有向量可比 —— 静默变笨,正是最难发现的那一类(D92 就量过)。
 *
 * 四条边界(与 `fetchQueryVector` 同族):
 *   · 只打本机 URL;没配/表不在 → 一个请求都不发,如实返回原因;
 *   · 失败**不抛**给调用方(拍子是后台的,炸了不该带走归档);
 *   · 条数/维度对不上 → 拒绝写库(pairEmbeddings 抛,由这里兜住并报错);
 *   · 一次只补一小批(默认 64,下一拍接着补),不阻塞归档/摘要。
 *
 * @returns {Promise<{todo: number, written: number, dim?: number, stale?: number, error?: string}>}
 */
export async function backfillEmbeddings({
  db,
  url = '',
  model = null,
  limit = 64,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!hasTable(db, 'embedding')) return { todo: 0, written: 0, error: 'no-table' };
  // ⚠️ URL 先判:没配地址时**连"要不要补"都不该问** —— 拍子上一次都不许发请求,
  //    而且这个事实要在返回值里说得出(测试钉的就是"没配 = no-url",不是"恰好没活干")。
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (base === '') return { todo: 0, written: 0, error: 'no-url' };
  const backlog = embeddingBacklog(db, { model, limit });
  if (backlog.todo.length === 0) return { todo: 0, written: 0, stale: backlog.stale };
  const request = embedRequestFor({ url: base, model, items: backlog.todo });
  if (request.ids.length === 0 || typeof fetchImpl !== 'function') {
    return { todo: backlog.todo.length, written: 0, stale: backlog.stale, error: 'no-url' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetchImpl(`${request.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok) return { todo: request.ids.length, written: 0, error: `HTTP ${response.status}` };
    const body = await response.json();
    const { dim, vectors } = pairEmbeddings({ ids: request.ids, data: body });
    let written = 0;
    db.exec('BEGIN');
    try {
      for (const entry of vectors) {
        written += saveEmbedding(db, { source: entry.id, vector: entry.vector, model });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { todo: request.ids.length, written, dim, stale: backlog.stale };
  } catch (error) {
    return { todo: request.ids.length, written: 0, stale: backlog.stale, error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * **向量覆盖率**(2026-10-18,P0-3):多少"该有向量"的轮次真的有同模型向量。
 *
 * 为什么要在启动横幅上念出来:这次静默失效的病根就是**覆盖率没人看** ——
 * 678/4,114 条摆在那就没人发现,直到审计去数。以后它进横幅,一眼就能看出"掉没掉"。
 *
 * ⚠️ **分母必须与 `embeddingBacklog` 同口径**(2026-10-18 首版当场踩到):第一版只按
 * `kind` 过滤,于是注入块(`【记忆交接】…` / 「这一轮的事实」)与工具会话(摘要提示词)
 * 也被算进分母 —— 横幅读 39.3%,而评测脚本读 100%,**同一件事两个数**。那些行
 * **本来就不该有向量**(给桥的指令算向量 = 拿它跟人话比相似度,D75 那个病),
 * 所以分母也要按同一组判据剔掉。判据的分母错了,数字就是错的。
 *
 * @returns {{eligible: number, withVec: number, ratio: number}}
 */
export function embeddingCoverage(db, { model = null } = {}) {
  if (!hasTable(db, 'embedding')) return { eligible: 0, withVec: 0, ratio: 0 };
  const rows = db.prepare(
    `SELECT t.session_id, t.seq, t.user_text, s.conversation, e.source AS has_vec
       FROM turn t
       JOIN session s ON s.id = t.session_id
       LEFT JOIN embedding e ON e.source = t.session_id || '#' || t.seq
        ${model ? 'AND e.model = ?' : ''}`,
  ).all(...(model ? [String(model)] : []));
  let eligible = 0;
  let withVec = 0;
  for (const row of rows) {
    if (isInjectedBlock(row.user_text)) continue;
    if (isToolConversation(row.conversation) || isToolConversation(row.session_id)) continue;
    if (cleanMemoryText(row.user_text) === '') continue;
    eligible += 1;
    if (row.has_vec) withVec += 1;
  }
  return { eligible, withVec, ratio: eligible === 0 ? 0 : withVec / eligible };
}

/**
 * **标签覆盖率**(2026-10-18,P0-5):人类轮次里有多少条至少有一个内容标签。
 *
 * 为什么重要:标签是检索的**第一路**(SQL 先按标签交集收窄候选),覆盖率就是召回上限。
 * 实测(2026-10-18):megumin 2,895 人类轮里只有 469 条(16.2%)、aris 4.7% 有标签 ——
 * 这个数字以前没人现算,所以"标签层只覆盖约四分之一"一直是句感觉。
 * 现在进横幅,调词表/规则前后能直接对照。
 *
 * @returns {{human: number, tagged: number, ratio: number}}
 */
export function tagCoverage(db) {
  if (!hasTable(db, 'memory_tag')) return { human: 0, tagged: 0, ratio: 0 };
  const skip = NON_MEMORY_KINDS.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) AS human,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM memory_tag m WHERE m.session_id = t.session_id AND m.seq = t.seq
            ) THEN 1 ELSE 0 END) AS tagged
       FROM turn t
      WHERE t.kind NOT IN (${skip}) AND length(t.user_text) > 0`,
  ).get(...NON_MEMORY_KINDS);
  const human = Number(row?.human) || 0;
  const tagged = Number(row?.tagged) || 0;
  return { human, tagged, ratio: human === 0 ? 0 : tagged / human };
}

/**
 * 该不该补一次归档?**纯函数,可测**。
 *
 * 为什么需要"补归档"(2026-10-01 实测发现):归档原来**只在 bridge 启动时跑一次**,
 * 而 `dsh` 是把每一轮**连续写在会话文件里**的。于是一段跑了一整天的会话,
 * 它当天说过的话**根本没进 `memory.db`** —— 长期层(每轮检索)只能看到"上次重启之前"的内容。
 * 实测:手动跑之前,当前角色的库是 **872 分钟前**的快照,而那天早上刚聊过一大段。
 *
 * `everyMs <= 0` = 关掉这道拍子(回到"只在启动/手动归档")。
 *
 * @param {number} lastAt 上次归档的时刻(毫秒)
 * @param {number} now
 * @param {number} everyMs 间隔
 */
export function archiveDue(lastAt, now, everyMs) {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return false;
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
  return now - lastAt >= everyMs;
}

/**
 * 启动时跑一次归档 —— 尽力而为,失败只记一条警告。
 *
 * 放在启动路径上是因为**交接要读它**:上一代会话的记录必须先收进库,
 * 新一代才能读到。增量 + 幂等,成本是"几个文件 + 几十行 SQL"。
 *
 * @param {boolean} [options.quiet] 定时补归档用:没有新轮次时**一个字都不打**
 *   (每 N 分钟一条"归档了 0 条"会把日志淹掉)。
 */
/**
 * 扫这个工作区的会话目录,挑出**读取端不认识**的会话格式(D169)。
 *
 * ⚠️ 为什么单独一个函数:`findSessionFiles` 只挑它认识的版本,**看不见的就当不存在** ——
 *    而那正是"静默失明"的地方。这里专门去看那些"看见了但不认识"的。
 */
export function unknownSessionsIn({ dshHome, workspace, known = KNOWN_SESSION_VERSIONS }) {
  try {
    const root = findWorkspaceDir(dshHome, workspace);
    if (!root) return [];
    const names = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const file of fs.readdirSync(path.join(root, entry.name))) names.push(file);
    }
    return unknownSessionVersions(names, { known });
  } catch {
    return [];   // 读不动就不告警:这不是"格式不认识",别误报
  }
}

export function archiveOnStartup({ db, dshHome, workspace, readRecords, rootDir = null, quiet = false, dbFile = null, peopleNames = [] }) {
  try {
    const files = findSessionFiles(dshHome, workspace);
    // ⚠️ **先看有没有"看见了但不认识"的格式**(D169):这条必须在下面那个静默 return **之前**,
    //    否则"整个工作区都换成新格式"这种最严重的失明**一句话都不会留**。
    const unknown = unknownSessionsIn({ dshHome, workspace });
    if (unknown.length) log.warn(`记忆归档：${describeUnknownSessions(unknown)}`);
    if (files.length === 0) return unknown.length ? { sessions: 0, turns: 0, newTurns: 0, unreadable: 0, unknown } : null;
    const stats = archivePass({ db, files, readRecords, rootDir, dbFile, peopleNames });
    stats.unknown = unknown;
    if (quiet && stats.newTurns === 0) return stats;
    log.info(
      `记忆归档：${stats.sessions} 会话 / ${stats.turns} 轮（本次新增 ${stats.newTurns}` +
      `${stats.unreadable ? `，${stats.unreadable} 个文件读不了` : ''}）` +
      // 同一句话里带上"另外还有多少读不了" —— 免得"新增 0"被当成"今天没人说话"
      `${unknown.length ? ` ${describeUnknownSessions(unknown)}` : ''}`,
    );
    return stats;
  } catch (err) {
    log.warn(`记忆归档失败（不影响对话）: ${err.message}`);
    return null;
  }
}


