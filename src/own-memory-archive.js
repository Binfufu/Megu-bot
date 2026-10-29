import { DatabaseSync } from 'node:sqlite';
import { classifyKind, cleanMemoryText, isToolConversation, parseInjectedNotes, stripInjectedNotes, whatSheSaid } from './memory-archive.js';
import { stripInjectedBlocks } from './transcript.js';
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
  let changed = 0;
  let retagged = false;
  // Canonicalize the rule inputs: caller order/duplicates must not cause rewrites.
  const tagSignature = JSON.stringify({ version: 1, peopleNames: [...new Set(peopleNames)].sort() });
  db.exec('BEGIN');
  try {
    for (const [id, session] of sessions) {
      const match = /^qqbot-(group|c2c|web)-(.+)$/.exec(session.key);
      sessionInsert.run(id, session.key, match?.[1] ?? 'unknown', match?.[2] ?? null,
        session.boundary, Number(session.pairs[0].user.at), workspace, 'own-state:' + stateFile, session.pairs.length, now);
      for (const { user, reply } of session.pairs) {
        const notes = parseInjectedNotes(user.content);
        const text = cleanMemoryText(stripInjectedNotes(stripInjectedBlocks(user.content)));
        const said = reply ? whatSheSaid({ reply_text: reply.content }) : null;
        const usage = reply?.meta.usage;
        changed += Number(turnInsert.run(id, Number(user.id), Number(user.at),
          isToolConversation(session.key) ? 'tool' : classifyKind(user.meta.rawText ?? user.content),
          notes.topic, notes.mood, notes.maxChars, notes.maxSentences, notes.interjection, notes.stateLine, notes.nudge,
          text, text.length, reply ? Number(reply.at) : null, said, said?.length ?? 0,
          said === '[跳过]' || said === '' ? 1 : 0, usage?.promptTokens ?? null,
          usage?.completionTokens ?? null, usage?.cacheHitTokens ?? null).changes);
      }
    }
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
