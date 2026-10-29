/**
 * **P1-C:note 的 ADD-only 软失效**(2026-10-19)。
 *
 * 要治的形状:她先记住「最喜欢喝美式」,后来又改口「最喜欢喝拿铁」——
 * 两条都留在库里,读取侧就会**同时端出互相矛盾的说法**(甚至会端出旧的那条)。
 * 修法是**软失效**:旧行标 `invalid_at` + `superseded_by`,不物理删
 * (被取代的说法以后又被说出来时,要能重新落一条有效行 —— ADD-only 语义)。
 *
 * ⚠️ 判据全部**真跑临时库**(`openMemory` + `archivePass` + `consolidate`),
 * 不读源码、不看注释:这几条要能红。
 *
 * 覆盖:
 *   · `ensureNoteSchema`:老库补三列、幂等;只读连接上 ok:false 且不抛;老库读路径不炸。
 *   · 核心冲突(c2c):后一条有效、前一条 invalid_at 非空且 superseded_by=后一条;不删行。
 *   · 历史补录:先有较晚说法、再补录更早的冲突说法 → 更早那条一插入就失效。
 *   · 群聊不收窄:group 会话里冲突说法**都有效**(归档拿不到发言人,同 kind 可能是不同人)。
 *   · 非冲突(不同 kind / 同值 / 抽不出 claims)不失效。
 *   · `superseded` 计数;`notesFor` / `notesOf` / `noteStats` 的 latestOnly 口径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { noteClaims } from '../src/memory-notes.js';
import {
  archivePass, consolidate, ensureNoteSchema, makeLongTermProvider, noteStats, notesFor, notesOf, openMemory,
  openMemoryReadOnly, pickLongTerm,
} from '../src/memory-store.js';

const DAY = 86400_000;
const BASE = Date.UTC(2026, 9, 1, 4, 0);

/** 造一份会话记录(照 `scripts/selftest.js` 里那个固化用例的形状:一轮 = user/message + assistant/message)。 */
function recordsOf(turns) {
  return [
    { type: 'session', id: 's', createdAt: BASE, cwd: 'E:\\x' },
    ...turns.flatMap(([seq, text, at]) => [
      { type: 'user/message', seq, time: at, data: { content: [{ type: 'text', text }] } },
      {
        type: 'assistant/message',
        seq: seq + 1,
        time: at + 1000,
        data: { message: { content: [{ type: 'text', text: '收到' }] } },
      },
    ]),
  ];
}

/** 把若干轮归档进指定会话。turns = [[seq, text, at], …] */
function archiveTurns(db, sessionId, turns) {
  archivePass({ db, files: [{ id: sessionId, file: 'a' }], readRecords: () => recordsOf(turns) });
}

/** 造一个**P1-C 之前**的 memory.db:note 表没有那三列(验老库迁移用)。 */
function makeLegacyDb(file, { text = '记住我最喜欢喝美式', tags = 'emotion,food' } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE note (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation TEXT NOT NULL,
    source       TEXT NOT NULL,
    at           INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    tier         TEXT NOT NULL,
    score        REAL NOT NULL,
    reasons      TEXT NOT NULL,
    tags         TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, tags, text)
     VALUES ('qqbot-c2c-legacy', 'qqbot-c2c-legacy#1', ?, ?, 'long', 5, '测试用老行', ?, ?)`,
  ).run(BASE - DAY, BASE, tags, text);
  db.close();
}

const noteRows = (db) => db.prepare('SELECT id, at, invalid_at, superseded_by, text FROM note ORDER BY at ASC, id ASC').all();
const textsOf = (list) => list.map((row) => String(row.text));

export function registerMemoryNoteSupersedeTests({ test, assert }) {
  test('note 软失效:ensureNoteSchema 给老库补三列(幂等),新库建表就带这三列', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-note-supersede-'));
    const file = path.join(dir, 'memory.db');
    try {
      makeLegacyDb(file);
      const db = openMemory(file);
      try {
        const before = db.prepare('PRAGMA table_info(note)').all().map((col) => col.name);
        assert.ok(!before.includes('invalid_at'), '前提:老库确实没有这三列(makeLegacyDb 是旧结构)');
        // 第一次:缺哪补哪,顺序固定。
        assert.deepEqual(ensureNoteSchema(db), { ok: true, added: ['superseded_by', 'merged_into', 'invalid_at'] });
        const after = db.prepare('PRAGMA table_info(note)').all().map((col) => col.name);
        for (const name of ['superseded_by', 'merged_into', 'invalid_at']) {
          assert.ok(after.includes(name), `补列后必须有 ${name}`);
        }
        // 老行一个字都不许动:行还在、invalid_at 是 NULL(仍有效)。
        assert.equal(db.prepare('SELECT COUNT(*) n FROM note').get().n, 1, '补列不许动已有行');
        assert.equal(db.prepare('SELECT invalid_at FROM note').get().invalid_at, null);
        // 幂等:再跑一次什么都不做。
        assert.deepEqual(ensureNoteSchema(db), { ok: true, added: [] });
      } finally {
        db.close();
      }
      // 新库由 MEMORY_SCHEMA 直接带列 —— 与 ensureNoteSchema 的列名/类型是同一张表的两处描述。
      const fresh = openMemory(path.join(dir, 'fresh.db'));
      try {
        const cols = fresh.prepare('PRAGMA table_info(note)').all().map((col) => col.name);
        for (const name of ['superseded_by', 'merged_into', 'invalid_at']) {
          assert.ok(cols.includes(name), `新库建表也要带 ${name}(两处描述不许漂)`);
        }
        assert.deepEqual(ensureNoteSchema(fresh), { ok: true, added: [] });
      } finally {
        fresh.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('note 软失效:只读连接上 ensureNoteSchema 返回 ok:false 不抛,读路径退回旧行为', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-note-supersede-ro-'));
    const file = path.join(dir, 'memory.db');
    try {
      makeLegacyDb(file);
      const db = openMemoryReadOnly(file);
      try {
        let result = null;
        assert.doesNotThrow(() => { result = ensureNoteSchema(db); }, '只读连接不许把"补列失败"变成异常');
        assert.equal(result.ok, false, '只读连接补不上列 → ok:false(调用方据此退回旧行为)');
        assert.ok(typeof result.error === 'string' && result.error.length > 0, '要说得出补不上列的原因');
        // 读路径遇到"没迁移的老库"只该降级,不该报 no such column。
        const rows = notesFor(db, { conversation: 'qqbot-c2c-legacy', query: '我最喜欢喝拿铁了', now: BASE + DAY });
        assert.equal(rows.length, 1, '老库读路径照旧能读出长期记忆(没有 invalid_at 列时不过滤、不抛)');
        const stats = noteStats(db, BASE + DAY);
        assert.deepEqual(stats, { long: 1, midAlive: 0, midAll: 0, recalled: 0, uses: 0, invalid: 0, merged: 0 },
          '没迁移的库:全部按有效算,invalid/merged 都报 0');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('note 软失效核心判据(c2c):新说法让旧说法退役,不是物理删', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-note-supersede-core-'));
    const db = openMemory(path.join(dir, 'memory.db'));
    try {
      const conv = 'qqbot-c2c-A';
      // 旧:明确要求记住(长期);新:同一 kind(偏好)但 value 不同(中期 —— 这样 notesFor
      // 两条通道各能端一条,`latestOnly:false` 才看得见"两条都在";notesFor 每档只端一条)。
      archiveTurns(db, conv, [
        [8, '记住我最喜欢喝美式', BASE - 2 * DAY],
        [20, '我最喜欢喝拿铁了', BASE - DAY],
      ]);

      const result = consolidate(db, { now: BASE, windowMs: 30 * DAY });
      assert.equal(result.long, 1, '旧说法插了一条长期');
      assert.equal(result.mid, 1, '新说法插了一条中期');
      assert.equal(result.superseded, 1, 'superseded 要报"这一拍标失效了几条"');

      const rows = noteRows(db);
      assert.equal(rows.length, 2, '⚠️ 物理行数必须是 2 —— 软失效不许删行(ADD-only)');
      const [older, newer] = rows;
      assert.ok(older.invalid_at !== null, '旧说法必须 invalid_at 非空');
      assert.equal(Number(older.superseded_by), Number(newer.id), '旧说法的 superseded_by 指向新说法');
      assert.equal(newer.invalid_at, null, '新说法仍然有效');
      assert.equal(newer.superseded_by, null, '新说法没有取代者');
      assert.match(String(newer.text), /拿铁/);

      // 读路径:默认只看有效的 → 只剩新说法;审计开关 latestOnly:false 能看见两条。
      // (T1-D:查询带真实标签 —— 零交集不再注入,这几条判据测的是 latestOnly 口径,不是话题兜底。)
      const alive = notesFor(db, { conversation: conv, query: '我最喜欢喝拿铁了', now: BASE });
      assert.deepEqual(textsOf(alive), ['我最喜欢喝拿铁了'], '默认读路径不许再端出被取代的旧说法');
      const all = notesFor(db, { conversation: conv, query: '我最喜欢喝拿铁了', now: BASE, latestOnly: false });
      assert.deepEqual(new Set(textsOf(all)), new Set(['记住我最喜欢喝美式', '我最喜欢喝拿铁了']),
        'latestOnly:false 是审计开关 —— 失效的那条物理还在、查得到');

      // `/忘了` 清单:失效的不该再列出来。
      assert.deepEqual(textsOf(notesOf(db, { conversation: conv })), ['我最喜欢喝拿铁了'],
        'notesOf 默认只列有效说法');
      assert.equal(notesOf(db, { conversation: conv, latestOnly: false }).length, 2,
        'notesOf latestOnly:false 能看全部');

      // 统计:long/mid 只数有效行;invalid 单独报;merged 是 P1-D 的(未合并时恒 0)。
      assert.deepEqual(noteStats(db, BASE), { long: 0, midAlive: 1, midAll: 1, recalled: 0, uses: 0, invalid: 1, merged: 0 },
        'noteStats 只统计有效行 + 新增 invalid(保留原有键)');

      // 两个读口都要接 latestOnly(Lead 从 config 透传;关掉 = 回 P1-B 行为,这是回滚开关)。
      const strict = pickLongTerm(db, { conversation: conv, query: '我最喜欢喝拿铁了', now: BASE, minAgeMs: 0 });
      assert.deepEqual(strict.notes.map((note) => note.text), ['我最喜欢喝拿铁了'], 'pickLongTerm 默认只看有效说法');
      const rollback = pickLongTerm(db, {
        conversation: conv, query: '我最喜欢喝拿铁了', now: BASE, minAgeMs: 0, latestOnly: false,
        // W1(2026-10-22):note 通道默认限 1 条;这条判据测的是 latestOnly 通道本身,显式放开上限。
        noteLimit: 2,
      });
      assert.equal(rollback.notes.length, 2, 'pickLongTerm latestOnly:false 把被取代的说法放回候选池');
      const strictProvider = makeLongTermProvider({ db, minAgeMs: 0 });
      const strictShown = strictProvider({ conversation: conv, query: '我最喜欢喝拿铁了', now: BASE });
      assert.deepEqual(strictShown.notes.map((note) => note.text), ['我最喜欢喝拿铁了'],
        'provider 默认读路径的 note 通道不许端出旧说法(原始轮档案由 recall 通道另治,不在本判据管辖区)');
      const rollbackProvider = makeLongTermProvider({ db, minAgeMs: 0, latestOnly: false, noteLimit: 2 });
      assert.ok(rollbackProvider({ conversation: conv, query: '我最喜欢喝拿铁了', now: BASE }).text.includes('美式'),
        'makeLongTermProvider 要把 latestOnly 透传下去(回滚开关真的能开)');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('note 软失效:历史补录的旧说法一插入就失效,不许把更新的说法顶掉', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-note-supersede-backfill-'));
    const db = openMemory(path.join(dir, 'memory.db'));
    try {
      const conv = 'qqbot-c2c-A';
      // ① 先只有"较晚"的那条(新说法)。
      archiveTurns(db, conv, [[20, '我最喜欢喝拿铁了', BASE - DAY]]);
      const first = consolidate(db, { now: BASE, windowMs: 30 * DAY });
      assert.equal(first.superseded, 0, '只有一条说法时没什么可失效的');
      const newerId = Number(noteRows(db)[0].id);

      // ② 再把**更早**的冲突说法补录进来(bootstrap 连跑几次会往更早推进)。
      archiveTurns(db, conv, [
        [8, '记住我最喜欢喝美式', BASE - 3 * DAY],
        [20, '我最喜欢喝拿铁了', BASE - DAY],
      ]);
      const second = consolidate(db, { now: BASE, windowMs: 30 * DAY });
      assert.equal(second.long, 1, '历史补录的那条确实插进去了(行是账本的一部分)');
      assert.equal(second.superseded, 1, '这条一插入就被标失效,superseded 要数到它');

      const rows = noteRows(db);
      assert.equal(rows.length, 2, '补录也是加行,不是覆盖');
      const older = rows.find((row) => Number(row.id) !== newerId);
      const newer = rows.find((row) => Number(row.id) === newerId);
      assert.ok(older.invalid_at !== null, '历史补录的旧说法必须一插入就失效');
      assert.equal(Number(older.superseded_by), newerId, '它指向更新的那条(不是反过来)');
      assert.equal(newer.invalid_at, null, '更新的那条不许被历史补录顶掉');
      const alive = notesFor(db, { conversation: conv, query: '我最喜欢喝拿铁了', now: BASE });
      assert.deepEqual(textsOf(alive), ['我最喜欢喝拿铁了'], '读路径仍然只有新说法');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('note 软失效:群聊不做冲突判定(拿不到发言人,同 kind 可能是不同人)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-note-supersede-group-'));
    const db = openMemory(path.join(dir, 'memory.db'));
    try {
      const conv = 'qqbot-group-A';
      archiveTurns(db, conv, [
        [8, '记住我最喜欢喝美式', BASE - 2 * DAY],
        [20, '我最喜欢喝拿铁了', BASE - DAY],
      ]);
      const result = consolidate(db, { now: BASE, windowMs: 30 * DAY });
      assert.equal(result.superseded, 0, '群聊里同样的 kind 不同 value 不许判冲突');
      const rows = noteRows(db);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.invalid_at === null), '群聊两条说法都必须仍然有效');
      assert.equal(noteStats(db, BASE).invalid, 0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('note 软失效:不同 kind / 同值 / 抽不出 claims 的一律不失效', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-note-supersede-nonconflict-'));
    const db = openMemory(path.join(dir, 'memory.db'));
    try {
      const conv = 'qqbot-c2c-A';
      archiveTurns(db, conv, [
        [8, '记住我最喜欢喝美式', BASE - 4 * DAY], // preference:喝美式(长期)
        [10, '我最最喜欢喝美式', BASE - 3 * DAY], // preference:喝美式(同值,不许失效)
        [12, '记住我弟弟叫小明', BASE - 2 * DAY], // relation:弟弟(不同 kind)
        [14, '记住我们明天要考试', BASE - DAY], // 抽不出 claims
      ]);
      const result = consolidate(db, { now: BASE, windowMs: 30 * DAY });
      assert.equal(result.superseded, 0, '非冲突的四种形状一条都不许失效');
      const rows = noteRows(db);
      assert.equal(rows.length, 4);
      assert.ok(rows.every((row) => row.invalid_at === null), '四行的 invalid_at 都必须还是 NULL');
      assert.deepEqual(noteStats(db, BASE), { long: 2, midAlive: 2, midAll: 2, recalled: 0, uses: 0, invalid: 0, merged: 0 });
      // 纯函数本身也钉一下(consolidate 用的就是它)。
      assert.deepEqual(noteClaims('记住我最喜欢喝美式'), [{ kind: 'preference', value: '喝美式' }]);
      assert.deepEqual(noteClaims('记住我们明天要考试'), [], '词表抽不出事实 → 没有 claims');
      assert.deepEqual(noteClaims(''), []);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('note 软失效:一拍里连着改口,superseded 计到每一条被退役的旧说法', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-note-supersede-count-'));
    const db = openMemory(path.join(dir, 'memory.db'));
    try {
      const conv = 'qqbot-c2c-A';
      archiveTurns(db, conv, [
        [8, '记住我最喜欢喝美式', BASE - 3 * DAY], // 长期
        [10, '我最喜欢喝牛奶了', BASE - 2 * DAY], // 中期
        [12, '我最喜欢喝拿铁了', BASE - DAY], // 中期,最新
      ]);
      const result = consolidate(db, { now: BASE, windowMs: 30 * DAY });
      assert.equal(result.superseded, 2, '改口两次 → 两条旧说法退役(美式、牛奶各一条)');
      const rows = noteRows(db);
      assert.equal(rows.length, 3, '三条物理行都在');
      const valid = rows.filter((row) => row.invalid_at === null);
      assert.equal(valid.length, 1, '最后只有最新那条有效');
      assert.match(String(valid[0].text), /拿铁/);
      assert.deepEqual(noteStats(db, BASE), { long: 0, midAlive: 1, midAll: 1, recalled: 0, uses: 0, invalid: 2, merged: 0 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
