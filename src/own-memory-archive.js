import { DatabaseSync } from 'node:sqlite';
import { classifyKind, cleanMemoryText, isToolConversation, parseInjectedNotes, whatSheSaid } from './memory-archive.js';
import { CHAT_INPUT_PROJECTION_VERSION, confirmedNotesSource, projectChatInput } from './chat-input-projection.js';
import { bigramTokens } from './memory-tags.js';
import { retagAll } from './memory-store.js';

/** Own source only; never scan DSH files or infer provenance from alternating rows. */
export function archiveOwnHistory({ db, stateFile, workspace = '', peopleNames = [], now = Date.now() }) {
  const source = new DatabaseSync(stateFile, { readOnly: true });
  let rows;
  try { rows = source.prepare('SELECT id, key, at, role, content, meta FROM conversation_turn ORDER BY id').all(); }
  finally { source.close(); }
  const users = new Map();
  let skipped = 0;
  for (const row of rows) {
    row.meta = row.meta ? JSON.parse(row.meta) : {};
    if (row.meta.source !== 'own-engine') { skipped++; continue; }
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.key !== 'string'
      || !Number.isSafeInteger(row.meta.resetId) || row.meta.resetId < 0
      || !['user', 'assistant'].includes(row.role)) throw new Error(`own memory invalid provenance: ${row.id}`);
    if (row.role === 'user') users.set(row.id, { user: row, reply: null });
  }
  for (const row of rows) {
    if (row.meta.source !== 'own-engine' || row.role !== 'assistant') continue;
    const pair = users.get(row.meta.userTurnId);
    if (!Number.isSafeInteger(row.meta.userTurnId) || row.meta.userTurnId <= 0
      || !pair || pair.user.id >= row.id || pair.user.key !== row.key || pair.user.meta.resetId !== row.meta.resetId || pair.reply) {
      throw new Error(`own memory invalid assistant linkage: ${row.id}`);
    }
    pair.reply = row;
  }
  const sessions = new Map();
  for (const pair of users.values()) {
    const key = pair.user.key;
    const boundary = pair.user.meta.resetId;
    const id = 'own:' + Buffer.from(key).toString('base64url') + ':' + boundary;
    if (!sessions.has(id)) sessions.set(id, { key, boundary, pairs: [] });
    sessions.get(id).pairs.push(pair);
  }
  const sessionInsert = db.prepare(`INSERT INTO session
    (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET turns=excluded.turns, imported_at=excluded.imported_at`);
  const turnInsert = db.prepare(`INSERT INTO turn
    (session_id, seq, at, kind, topic, mood, max_chars, max_sentences, interjection, state_line, nudge,
     user_text, user_chars, reply_at, reply_text, reply_chars, silent, in_tokens, out_tokens, cache_read_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, seq) DO UPDATE SET reply_at=excluded.reply_at,
      reply_text=excluded.reply_text, reply_chars=excluded.reply_chars, silent=excluded.silent,
      in_tokens=excluded.in_tokens, out_tokens=excluded.out_tokens, cache_read_tokens=excluded.cache_read_tokens
    WHERE turn.reply_at IS NULL AND excluded.reply_at IS NOT NULL`);
  // 派生 turn 按源档幂等重投影，不用破坏性 MEMORY_VERSION 重导（长期 note/块完全不动）。
  const previousTurn = db.prepare('SELECT user_text, kind FROM turn WHERE session_id=? AND seq=?');
  const projectDerived = db.prepare(`UPDATE turn SET kind=?, user_text=?, user_chars=?,
    topic=?, mood=?, max_chars=?, max_sentences=?, interjection=?, state_line=?, nudge=?
    WHERE session_id=? AND seq=? AND (kind IS NOT ? OR user_text IS NOT ? OR user_chars IS NOT ?
      OR topic IS NOT ? OR mood IS NOT ? OR max_chars IS NOT ? OR max_sentences IS NOT ?
      OR interjection IS NOT ? OR state_line IS NOT ? OR nudge IS NOT ?)`);
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const hasFts = hasTable('turn_fts');
  const hasEmbedding = hasTable('embedding');
  const hasMentions = hasTable('entity_mention');
  let changed = 0;
  let retagged = false;
  // Canonicalize the rule inputs: caller order/duplicates must not cause rewrites.
  const tagSignature = JSON.stringify({ version: CHAT_INPUT_PROJECTION_VERSION, peopleNames: [...new Set(peopleNames)].sort() });
  db.exec('BEGIN');
  try {
    for (const [id, session] of sessions) {
      const match = /^qqbot-(group|c2c|web)-(.+)$/.exec(session.key);
      sessionInsert.run(id, session.key, match?.[1] ?? 'unknown', match?.[2] ?? null,
        session.boundary, Number(session.pairs[0].user.at), workspace, 'own-state:' + stateFile, session.pairs.length, now);
      for (const { user, reply } of session.pairs) {
        const projected = projectChatInput(user.content, { source: user.meta.source, role: user.role,
          inputProjectionVersion: user.meta.inputProjectionVersion });
        // 元字段只从**确认由 producer 写下的 notes 片段**解析：用户在同一条消息里的
        // 「· 这次…」引文不会被当成桥的表达要求（F1 复核）。
        const notes = parseInjectedNotes(confirmedNotesSource(user.content, { source: user.meta.source,
          role: user.role, inputProjectionVersion: user.meta.inputProjectionVersion }));
        // 场合前缀属于归档展示归一化；引擎与这里的剥壳都只走同一清洁投影。
        const text = cleanMemoryText(projected.replace(/^\s*\[(群聊|私聊)\]\s*/, ''));
        const kind = isToolConversation(session.key) ? 'tool' : classifyKind(projected);
        const before = previousTurn.get(id, Number(user.id));
        const said = reply ? whatSheSaid({ reply_text: reply.content }) : null;
        const usage = reply?.meta.usage;
        const inserted = Number(turnInsert.run(id, Number(user.id), Number(user.at), kind,
          notes.topic, notes.mood, notes.maxChars, notes.maxSentences, notes.interjection, notes.stateLine, notes.nudge,
          text, text.length, reply ? Number(reply.at) : null, said, said?.length ?? 0,
          said === '[跳过]' || said === '' ? 1 : 0, usage?.promptTokens ?? null,
          usage?.completionTokens ?? null, usage?.cacheHitTokens ?? null).changes);
        const fields = [kind, text, text.length, notes.topic, notes.mood, notes.maxChars, notes.maxSentences,
          notes.interjection, notes.stateLine, notes.nudge];
        const rebuilt = Number(projectDerived.run(...fields, id, Number(user.id), ...fields).changes);
        changed += inserted || rebuilt ? 1 : 0;
        if (before && (before.user_text !== text || before.kind !== kind)) {
          // 只失效该 own 源轮的可重建索引，不碰 note/fact/常驻块/summary 或任何源记录。
          const sourceId = `${id}#${user.id}`;
          const tokens = hasFts ? bigramTokens(text).join(' ') : '';
          // 无 FTS 表时也清掉旧分词列，让既有 indexTurnFts 在能力恢复后能补索引。
          db.prepare('UPDATE turn SET fts_text=? WHERE session_id=? AND seq=?').run(tokens, id, Number(user.id));
          if (hasFts) {
            db.prepare('DELETE FROM turn_fts WHERE session_id=? AND seq=?').run(id, Number(user.id));
            if (tokens) db.prepare('INSERT INTO turn_fts(session_id,seq,fts_text) VALUES (?,?,?)').run(id, Number(user.id), tokens);
          }
          if (hasEmbedding) db.prepare('DELETE FROM embedding WHERE source=?').run(sourceId);
          if (hasMentions) db.prepare('DELETE FROM entity_mention WHERE source=?').run(sourceId);
        }
      }
    }
    // F1 读闸的 watermark:整库所有 own 行都按当前投影重投影成功,才允许读侧直接信任派生正文。
    // 与数据同一事务提交 —— 任何一行失败都回滚,watermark 不会提前升级(旧行继续走读侧投影)。
    db.prepare(`INSERT INTO meta(key,value) VALUES ('own_archive_projection_version',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(CHAT_INPUT_PROJECTION_VERSION));
    const previousTags = db.prepare("SELECT value FROM meta WHERE key='own_archive_tag_signature'").get()?.value;
    if (changed > 0 || previousTags !== tagSignature) {
      retagAll(db, { peopleNames, now });
      db.prepare(`INSERT INTO meta(key,value) VALUES ('own_archive_tag_signature',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(tagSignature);
      retagged = true;
    }
    db.prepare(`INSERT INTO meta(key,value) VALUES ('own_archive_at',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(now));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { sessions: sessions.size, turns: users.size, changed, skipped, retagged };
}
