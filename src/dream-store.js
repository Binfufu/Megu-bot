/**
 * **刀二后半 · 梦境存储**(2026-10-13,D227;docs\21 §十)。
 *
 * ## 形状
 *
 * 表在 `sqlite-store.js` 的 SCHEMA 里(dream_room / dream_member / dream_msg,
 * 唯一建表入口),查询聚在这一层 —— 与 credits.js 同一族的做法。
 *
 * ## 两条铁律
 *
 *  · **只碰 dream_ 三张表**。梦是虚构、世界是真实关系:这里**绝不**读写
 *    conversation / memory 那一侧,身份与记忆隔离从这一层落实(docs\21 §十四点之 2/4)。
 *  · **卡不复制**:房间只引卡库 id(manifest),卡正文永远是卡库的单一真相;
 *    组装时才把卡内容拼进上下文(那就是 `dream-engine.js` 的事)。
 *
 * ## 记账口径(§十三项拍板之 1 + 用户 2026-10-13 拍板"先免费记账")
 *
 * dream_msg.meta 里落每轮的 usage —— **先免费不扣分,但账照记**:
 * 攒出真实的"N+1 次调用 token 分布"再反推一轮的价格,数字等用户定。
 */

import { randomBytes } from 'node:crypto';

/** 新房 id:'dream:' + 8 字节随机(可读、可当 URL 段、不猜得出别的房)。 */
export function newDreamRoomId() {
  return `dream:${randomBytes(5).toString('hex')}`;
}

/** 解一列 JSON,坏了当没有(与 sqlite-store 的 safeJson 同一条纪律)。 */
function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.store 状态库(用 store.handle 的 prepare;表在 SCHEMA 里)
 * @param {() => number} [deps.now]
 */
export function createDreamStore({ store, now = () => Date.now() } = {}) {
  const db = store.handle;
  const at = () => Math.floor(now());

  const q = {
    insertRoom: db.prepare(
      'INSERT INTO dream_room (id, title, manifest, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    getRoom: db.prepare('SELECT * FROM dream_room WHERE id = ?'),
    listRooms: db.prepare('SELECT * FROM dream_room ORDER BY updated_at DESC'),
    touchRoom: db.prepare('UPDATE dream_room SET updated_at = ? WHERE id = ?'),
    updateManifestStmt: db.prepare('UPDATE dream_room SET manifest = ?, updated_at = ? WHERE id = ?'),
    deleteRoom: db.prepare('DELETE FROM dream_room WHERE id = ?'),
    insertMember: db.prepare(
      'INSERT OR REPLACE INTO dream_member (room_id, member_id, name, card_id, kind, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    listMembers: db.prepare('SELECT * FROM dream_member WHERE room_id = ? ORDER BY joined_at, member_id'),
    deleteMembers: db.prepare('DELETE FROM dream_member WHERE room_id = ?'),
    deleteMember: db.prepare('DELETE FROM dream_member WHERE room_id = ? AND member_id = ?'),
    insertMsg: db.prepare(
      'INSERT INTO dream_msg (room_id, at, role, name, content, meta) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    listMsg: db.prepare('SELECT * FROM dream_msg WHERE room_id = ? ORDER BY id DESC LIMIT ?'),
    deleteMsgs: db.prepare('DELETE FROM dream_msg WHERE room_id = ?'),
    // —— 尾部删/改(2026-10-19 / D269:输入行「更多功能」四颗键要用)——————————————
    // ⚠️ **只许动尾部**:历史的主体仍然 append-only(前缀缓存的前提没变);
    //    这四条是"最后一条/最后一句之后"的专用口子,不许拿去做任意位置的编辑。
    lastMsg: db.prepare('SELECT * FROM dream_msg WHERE room_id = ? ORDER BY id DESC LIMIT 1'),
    deleteMsg: db.prepare('DELETE FROM dream_msg WHERE room_id = ? AND id = ?'),
    deleteAfter: db.prepare('DELETE FROM dream_msg WHERE room_id = ? AND id > ?'),
    updateMsg: db.prepare('UPDATE dream_msg SET content = ?, meta = ? WHERE room_id = ? AND id = ?'),
  };

  /** 建房(带成员一次落);manifest 是 JSON 值(对象),这里只存引用。 */
  function createRoom({ title, manifest = {}, createdBy = null, members = [] }) {
    if (!title || typeof title !== 'string') throw new Error('dream 房要有名字');
    const id = newDreamRoomId();
    const ts = at();
    q.insertRoom.run(id, title, JSON.stringify(manifest ?? {}), createdBy, ts, ts);
    for (const member of members) {
      q.insertMember.run(id, member.memberId, member.name, member.cardId ?? null, member.kind ?? 'char', ts);
    }
    return rowToRoom(q.getRoom.get(id));
  }

  const rowToRoom = (row) => row && {
    id: row.id,
    title: row.title,
    manifest: safeJson(row.manifest) ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  /**
   * **热更改 manifest**(1.130.0 / D227 追加三):读-改-写,合并式 patch。
   *
   *  · 合并语义:`{ ...旧manifest, ...patch }` —— patch 里没提的键原样保留;
   *  · `version` 每次自增一位(不管 patch 里写了什么,以本层算的为准);
   *  · 房不存在要**抛错**(调用方翻成 404),不许静默写出一间假房。
   */
  function updateManifest(roomId, patch = {}) {
    const room = q.getRoom.get(roomId);
    if (!room) throw new Error(`dream 房不存在:${roomId}`);
    const current = safeJson(room.manifest) ?? {};
    const next = { ...current, ...(patch ?? {}) };
    next.version = (Number(current.version) || 0) + 1;
    q.updateManifestStmt.run(JSON.stringify(next), at(), roomId);
    return rowToRoom(q.getRoom.get(roomId));
  }

  function getRoom(id) {
    return rowToRoom(q.getRoom.get(id));
  }

  function listRooms() {
    return q.listRooms.all().map(rowToRoom);
  }

  function addMember(roomId, { memberId, name, cardId = null, kind = 'char' }) {
    if (!memberId || !name) throw new Error('dream 成员要有 id 与名字');
    q.insertMember.run(roomId, memberId, name, cardId, kind, at());
    q.touchRoom.run(at(), roomId);
    return q.listMembers.all(roomId);
  }

  function removeMember(roomId, memberId) {
    q.deleteMember.run(roomId, memberId);
    q.touchRoom.run(at(), roomId);
  }

  /** 房内成员清单(锁人按 name 点名;kind = char / narrator)。 */
  function listMembers(roomId) {
    return q.listMembers.all(roomId).map((row) => ({
      id: row.member_id,
      name: row.name,
      cardId: row.card_id,
      kind: row.kind,
      joinedAt: row.joined_at,
    }));
  }

  /**
   * 追一条房内消息(append-only;历史只追加不重排 —— 前缀缓存的另一前提)。
   * @param {{roomId:string, role:'user'|'assistant', name?:string, content:string, meta?:object}} input
   */
  function appendMsg({ roomId, role, name = null, content, meta = null }) {
    if (role !== 'user' && role !== 'assistant') throw new Error(`dream 消息 role 非法:${role}`);
    if (typeof content !== 'string' || content === '') throw new Error('dream 消息不许是空串');
    const info = q.insertMsg.run(roomId, at(), role, name, content, meta ? JSON.stringify(meta) : null);
    q.touchRoom.run(at(), roomId);
    return Number(info.lastInsertRowid);
  }

  /** 一行 dream_msg → 对外的消息对象(history / lastMsg / 删除回执共用这一份口径)。 */
  function rowToMsg(row) {
    return {
      id: row.id,
      at: row.at,
      role: row.role,
      name: row.name,
      content: row.content,
      meta: safeJson(row.meta),
    };
  }

  /** 房内历史(旧的在前);meta 解成对象。limit 缺省 200,0 = 全量。 */
  function history(roomId, { limit = 200 } = {}) {
    const rows = limit > 0
      ? q.listMsg.all(roomId, limit).reverse()
      : db.prepare('SELECT * FROM dream_msg WHERE room_id = ? ORDER BY id').all(roomId);
    return rows.map(rowToMsg);
  }

  /** 最后一条消息(null = 还没有说话)。「更多功能」四颗键都从这里拿"尾部"。 */
  function lastMsg(roomId) {
    const row = q.lastMsg.get(roomId);
    return row ? rowToMsg(row) : null;
  }

  /**
   * **删掉最后一条消息**(「删除消息」键;一次一条)。
   * 只动尾部 —— 历史主体仍然 append-only,别拿它做任意位置删除。
   * @returns {object|null} 被删掉的那一条;房内本来就没有消息时回 null。
   */
  function deleteLastMsg(roomId) {
    const row = q.lastMsg.get(roomId);
    if (!row) return null;
    q.deleteMsg.run(roomId, row.id);
    q.touchRoom.run(at(), roomId);
    return rowToMsg(row);
  }

  /**
   * **删掉某个 id 之后的全部消息**(「重新生成」键:把最后一句用户发言之后的旧回复清掉再重生成)。
   * @returns {number} 真删掉了几条
   */
  function deleteMsgsAfter(roomId, afterId) {
    const info = q.deleteAfter.run(roomId, Number(afterId));
    const changes = Number(info.changes) || 0;
    if (changes > 0) q.touchRoom.run(at(), roomId);
    return changes;
  }

  /**
   * **改最后一条消息的正文/元数据**(「续写」键:把续写内容接在同一句话后面)。
   * ⚠️ 永远是**最后一条** —— 没有"按 id 改"的口子,防手滑改到历史中间。
   * @param {{content: string, meta?: object|null}} patch
   * @returns {object|null} 改完的那一条(null = 房内没有消息)
   */
  function updateLastMsg(roomId, { content, meta = undefined } = {}) {
    const row = q.lastMsg.get(roomId);
    if (!row) return null;
    if (typeof content !== 'string' || content === '') throw new Error('dream 消息不许是空串');
    const nextMeta = meta === undefined ? row.meta : (meta ? JSON.stringify(meta) : null);
    q.updateMsg.run(content, nextMeta, roomId, row.id);
    q.touchRoom.run(at(), roomId);
    return rowToMsg(q.lastMsg.get(roomId));
  }

  /** 删房(操作者能看/改/删 —— docs\03 边界;房内历史与成员一起删)。 */
  function deleteRoom(roomId) {
    q.deleteMsgs.run(roomId);
    q.deleteMembers.run(roomId);
    q.deleteRoom.run(roomId);
  }

  /**
   * 一间房的 usage 汇总(从 dream_msg.meta 里收) —— 免费记账期的定价反推数据。
   * assistant 行才带 usage;user 行 meta 为空。
   */
  function roomUsage(roomId) {
    const sum = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0 };
    for (const msg of history(roomId, { limit: 0 })) {
      const usage = msg.meta && msg.meta.usage;
      if (!usage) continue;
      // 续写把同一行话说长了(D269):那一行 meta.usage.calls 是合并后的次数;
      // 普通一轮没有这个字段时按 1 次算。
      sum.calls += Number(usage.calls) || 1;
      sum.promptTokens += usage.promptTokens ?? 0;
      sum.completionTokens += usage.completionTokens ?? 0;
      sum.cacheHitTokens += usage.cacheHitTokens ?? 0;
      sum.totalTokens += usage.totalTokens ?? 0;
    }
    return sum;
  }

  return {
    createRoom,
    getRoom,
    listRooms,
    updateManifest,
    addMember,
    removeMember,
    listMembers,
    appendMsg,
    history,
    lastMsg,
    deleteLastMsg,
    deleteMsgsAfter,
    updateLastMsg,
    deleteRoom,
    roomUsage,
  };
}
