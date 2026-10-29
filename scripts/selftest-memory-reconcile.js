/**
 * 记忆软失效的**历史冲突一次性回溯**(P1-C 补账,2026-10-19)回归。
 *
 * 要治的形状:P1-C 的写时软失效只在**改口那一刻**生效,而老库里**早就并存**的冲突
 * (`fact` 里 `relation=老婆` 与 `relation=妹妹` 各一行、同一段 c2c 会话里两条互相矛盾的
 * note)不会被追溯 —— 读取侧会同时注入它们。修法是**一次性回溯**:同一判据把较旧的那条
 * `invalid_at` 掉,只软标记不物理删(ADD-only 语义,`latestOnly:false` 可审计)。
 *
 * ⚠️ 判据全部**真跑临时 SQLite 库**(`SqliteStateStore` / `openMemory` + 直插行),
 *    不读源码猜行为;`dryRun:true` 必须**一个字节都不写**,用 `total_changes()` + 行内容两根钉子钉住。
 *
 * 覆盖:
 *   · fact 回溯:保留 last_seen 最大的、平局取 id 大的;dryRun 不写;物理行数不变;幂等。
 *   · fact 单行组不算冲突(dry-run / apply 都不动)。
 *   · note 回溯(c2c):按 (at, seq) 判新旧(不是按插入顺序);dryRun 不写;旧行指向新行;幂等。
 *   · note 群聊不判定(归档拿不到发言人,同 kind 可能是不同人的偏好)。
 *   · note 非冲突(同 kind 同值 / 不同 kind / 抽不出 claims)一条都不失效。
 *   · 一致性(D159):`consolidate` 已经收敛的库再 reconcile → conflicts=0(两处判据漂了会红)。
 *   · 只读库:`reconcileNoteSupersedes` 返回 ok:false 且**不抛**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { noteClaims } from '../src/memory-notes.js';
import {
  archivePass, consolidate, noteStats, notesOf, openMemory, openMemoryReadOnly, reconcileNoteSupersedes,
} from '../src/memory-store.js';
import { SqliteStateStore } from '../src/sqlite-store.js';

const DAY = 86400_000;
const BASE = Date.UTC(2026, 9, 1, 4, 0); // 2026-10-01 04:00 UTC(与 selftest-memory-note-supersede 同一基准)

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-memory-reconcile-${tag}-`));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
/** 这条连接上"改了几行"的计数 —— dryRun 不写就用它钉(比文件 mtime 稳,也不受 WAL 影响)。 */
function totalChanges(db) {
  return Number(db.prepare('SELECT total_changes() AS n').get().n);
}

/**
 * 直插一条 fact。**必须直插**:`touchFact` 会当场把同组旧值软失效,造不出"历史并存"。
 * @returns {number} 行 id
 */
function insertFact(store, {
  scope, subject, kind, value, detail = null, source = 'told', firstSeen = 1000, lastSeen = 1000, seenCount = 1,
}) {
  return Number(
    store.handle.prepare(
      `INSERT INTO fact (scope, subject, kind, value, detail, source, first_seen, last_seen, seen_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(scope, subject, kind, value, detail, source, firstSeen, lastSeen, seenCount).lastInsertRowid,
  );
}

/** 造一份会话记录(照 `selftest-memory-note-supersede.js` 里那个固化用例的形状)。 */
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
function archiveTurns(db, sessionId, turns) {
  archivePass({ db, files: [{ id: sessionId, file: 'a' }], readRecords: () => recordsOf(turns) });
}

/** 手工插一段会话(scene 决定 note 回溯做不做)。 */
function insertSession(db, { id, conversation, scene, turns = 0 }) {
  db.prepare(
    `INSERT INTO session (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
     VALUES (?, ?, ?, ?, 1, ?, '', 'test', ?, ?)`,
  ).run(id, conversation, scene, 'test-target', BASE - DAY, turns, BASE);
}

/** 手工插一条 note(按 (at, seq) 判新旧,source 的 # 后缀就是 seq)。 */
function insertNote(db, { conversation, source, at, tier = 'mid', score = 3, text }) {
  return Number(
    db.prepare(
      `INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, tags, text)
       VALUES (?, ?, ?, ?, ?, ?, '测试用', '', ?)`,
    ).run(conversation, source, at, BASE, tier, score, text).lastInsertRowid,
  );
}

/** 造一个 **P1-C 之前**的 memory.db(note 表没有三列 —— 只读用例要它来触发 ok:false)。 */
function makeLegacyDb(file) {
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
     VALUES ('qqbot-c2c-legacy', 'qqbot-c2c-legacy#1', ?, ?, 'long', 5, '测试用老行', '', '记住我最喜欢喝美式')`,
  ).run(BASE - DAY, BASE);
  db.close();
}

export function registerMemoryReconcileTests({ test, assert }) {
  test('历史事实回溯:保留 last_seen 最大者(平局取 id 大),dryRun 不写、物理行不变、apply 后幂等', () => {
    const dir = tempDir('fact');
    try {
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      try {
        // 组 1:妹妹(旧) vs 老婆(近)—— 要保留"最近见过"的那条。
        const sisterId = insertFact(store, {
          scope: 'c2c:1', subject: 'self', kind: 'relation', value: '妹妹', firstSeen: 1000, lastSeen: 1000,
        });
        const wifeId = insertFact(store, {
          scope: 'c2c:1', subject: 'self', kind: 'relation', value: '老婆', firstSeen: 2000, lastSeen: 5000,
        });
        // 组 2:两条同 last_seen ⇒ 取 id 大者(后插入的那行)。
        const gastritisId = insertFact(store, {
          scope: 'c2c:2', subject: 'self', kind: 'health', value: '胃炎', firstSeen: 3000, lastSeen: 9000,
        });
        const coldId = insertFact(store, {
          scope: 'c2c:2', subject: 'self', kind: 'health', value: '感冒', firstSeen: 4000, lastSeen: 9000,
        });
        assert.ok(coldId > gastritisId, '前提:后插入的 id 更大');
        // 前提:历史冲突真的并存(直插绕过了 touchFact,两条都还"有效")。
        assert.equal(store.facts({ latestOnly: false }).length, 4);
        assert.equal(store.factStats().invalid, 0);

        const before = totalChanges(store.handle);
        const dry = store.reconcileFacts({ now: 10_000, dryRun: true });
        assert.equal(dry.dryRun, true);
        assert.equal(dry.groups, 2, '两组历史并存');
        assert.equal(dry.conflicts, 2, '每组退役一条');
        assert.equal(dry.kept.length, 2);
        assert.equal(dry.kept.find((item) => item.value === '老婆').id, wifeId, 'last_seen 大的留下');
        assert.equal(dry.kept.find((item) => item.kind === 'health').value, '感冒', '同 last_seen 取 id 大者');
        assert.equal(dry.invalidated.find((item) => item.id === sisterId).supersededBy, wifeId);
        assert.equal(dry.invalidated.find((item) => item.id === gastritisId).supersededBy, coldId);
        // dryRun 的硬判据:这条连接一行都没改,库里也没有任何 invalid_at。
        assert.equal(totalChanges(store.handle), before, 'dryRun 不许写一个字节');
        assert.equal(
          store.handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE invalid_at IS NOT NULL').get().n,
          0,
          'dryRun 后所有行仍有效',
        );

        // apply:同一个 now 落库。
        const applied = store.reconcileFacts({ now: 10_500 });
        assert.equal(applied.dryRun, false);
        assert.equal(applied.conflicts, 2);
        assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, 4, 'ADD-only:物理行数不变');
        const rows = store.handle.prepare('SELECT id, value, invalid_at, superseded_by FROM fact ORDER BY id').all();
        const sister = rows.find((row) => row.id === sisterId);
        assert.equal(sister.invalid_at, 10_500);
        assert.equal(sister.superseded_by, wifeId);
        assert.equal(rows.find((row) => row.id === wifeId).invalid_at, null, '保留的那条仍有效');
        assert.deepEqual(store.facts({ scope: 'c2c:1' }).map((item) => item.value), ['老婆']);
        assert.deepEqual(store.facts({ scope: 'c2c:2' }).map((item) => item.value), ['感冒']);
        assert.equal(store.facts({ scope: 'c2c:1', latestOnly: false }).length, 2, 'latestOnly:false 仍能审计');
        const stats = store.factStats();
        assert.equal(stats.total, 2, 'factStats 只数有效行');
        assert.equal(stats.invalid, 2);
        assert.equal(stats.total + stats.invalid, 4, '物理行数 = 有效 + 失效');

        // 幂等:再跑一次没有冲突、也不再改任何行。
        const changesAfterApply = totalChanges(store.handle);
        const again = store.reconcileFacts({ now: 20_000 });
        assert.equal(again.groups, 0);
        assert.equal(again.conflicts, 0, 'apply 之后必须幂等');
        assert.equal(totalChanges(store.handle), changesAfterApply, '没有冲突时一行都不写');
        assert.equal(
          store.handle.prepare('SELECT invalid_at FROM fact WHERE id = ?').get(sisterId).invalid_at,
          10_500,
          '幂等重跑不许刷新旧的失效时刻',
        );
      } finally {
        store.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('历史事实回溯:没有多行并存的组 → conflicts=0,dry-run 与 apply 都不动库', () => {
    const dir = tempDir('fact-noconflict');
    try {
      const store = new SqliteStateStore(path.join(dir, 'state.db'));
      try {
        insertFact(store, { scope: 'c2c:1', subject: 'self', kind: 'relation', value: '朋友' });
        insertFact(store, { scope: 'c2c:1', subject: 'self', kind: 'health', value: '胃炎' });
        insertFact(store, { scope: 'c2c:1', subject: 'other', kind: 'relation', value: '哥哥' });
        // 不同 kind / 不同 subject 都不是冲突(同 scope+subject+kind 才算一组)。
        const before = totalChanges(store.handle);
        const dry = store.reconcileFacts({ now: 5000, dryRun: true });
        assert.equal(dry.groups, 0);
        assert.equal(dry.conflicts, 0);
        const applied = store.reconcileFacts({ now: 5000 });
        assert.equal(applied.conflicts, 0);
        assert.equal(totalChanges(store.handle), before, '没有冲突就没有写');
        assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE invalid_at IS NOT NULL').get().n, 0);
      } finally {
        store.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('note 回溯(c2c):按 (at, seq) 判新旧(不是插入顺序),dryRun 不写、旧行指向新行、物理行=2、幂等', () => {
    const dir = tempDir('note-c2c');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-c2c-reconcile';
        insertSession(db, { id: 's1', conversation, scene: 'c2c', turns: 2 });
        // ⚠️ 故意**先插新说法、后插旧说法**:若实现按 id 判新旧,就会把新说法退役 —— 这条能咬住它。
        const newerId = insertNote(db, {
          conversation, source: 's1#2', at: BASE - 1000, text: '记住我现在最喜欢喝拿铁',
        });
        const olderId = insertNote(db, {
          conversation, source: 's1#1', at: BASE - 5000, text: '记住我最喜欢喝美式',
        });
        assert.ok(olderId > newerId, '前提:旧说法的 id 反而更大(插入顺序与时间顺序相反)');
        assert.deepEqual(noteClaims('记住我最喜欢喝美式'), [{ kind: 'preference', value: '喝美式' }]);
        assert.deepEqual(noteClaims('记住我现在最喜欢喝拿铁'), [{ kind: 'preference', value: '喝拿铁' }]);

        const before = totalChanges(db);
        const dry = reconcileNoteSupersedes(db, { now: BASE + 1000, dryRun: true });
        assert.equal(dry.ok, true, dry.error);
        assert.equal(dry.dryRun, true);
        assert.equal(dry.conversations, 1);
        assert.equal(dry.notes, 2);
        assert.equal(dry.conflicts, 1);
        assert.deepEqual(
          {
            id: dry.invalidated[0].id,
            kind: dry.invalidated[0].kind,
            oldValue: dry.invalidated[0].oldValue,
            newValue: dry.invalidated[0].newValue,
            supersededBy: dry.invalidated[0].supersededBy,
          },
          { id: olderId, kind: 'preference', oldValue: '喝美式', newValue: '喝拿铁', supersededBy: newerId },
          '旧说法(at 小)退役、指向新说法;kind/value 要能说明白',
        );
        assert.equal(totalChanges(db), before, 'dryRun 不许写');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note WHERE invalid_at IS NOT NULL').get().n, 0);

        const applied = reconcileNoteSupersedes(db, { now: BASE + 2000 });
        assert.equal(applied.conflicts, 1);
        const rows = db.prepare('SELECT id, invalid_at, superseded_by FROM note ORDER BY id').all();
        assert.equal(rows.length, 2, 'ADD-only:物理行数还是 2');
        const older = rows.find((row) => row.id === olderId);
        assert.equal(older.invalid_at, BASE + 2000);
        assert.equal(older.superseded_by, newerId);
        assert.equal(rows.find((row) => row.id === newerId).invalid_at, null, '新说法仍有效');
        assert.deepEqual(
          notesOf(db, { conversation }).map((row) => String(row.text)),
          ['记住我现在最喜欢喝拿铁'],
          '默认读路径只剩新说法',
        );
        assert.equal(notesOf(db, { conversation, latestOnly: false }).length, 2, '审计开关能看到两条');
        assert.deepEqual(
          noteStats(db, BASE + 2000),
          { long: 0, midAlive: 1, midAll: 1, recalled: 0, uses: 0, invalid: 1, merged: 0 },
        );

        const changesAfterApply = totalChanges(db);
        const again = reconcileNoteSupersedes(db, { now: BASE + 3000 });
        assert.equal(again.ok, true);
        assert.equal(again.conflicts, 0, 'apply 之后必须幂等');
        assert.equal(totalChanges(db), changesAfterApply, '没有冲突时一行都不写');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('note 回溯:群聊不判定(归档拿不到发言人,同 kind 可能是不同人的偏好)', () => {
    const dir = tempDir('note-group');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-group-A';
        insertSession(db, { id: 'g1', conversation, scene: 'group', turns: 2 });
        const olderId = insertNote(db, {
          conversation, source: 'g1#1', at: BASE - 5000, text: '记住我最喜欢喝美式',
        });
        const newerId = insertNote(db, {
          conversation, source: 'g1#2', at: BASE - 1000, text: '记住我现在最喜欢喝拿铁',
        });
        const result = reconcileNoteSupersedes(db, { now: BASE + 1000 });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.conversations, 0, 'group 会话不进回溯范围');
        assert.equal(result.notes, 0);
        assert.equal(result.conflicts, 0);
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM note WHERE invalid_at IS NOT NULL').get().n,
          0,
          '群聊两条冲突说法都必须仍然有效',
        );
        for (const id of [olderId, newerId]) {
          assert.equal(db.prepare('SELECT invalid_at FROM note WHERE id = ?').get(id).invalid_at, null);
        }
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('note 回溯:非冲突形状(同 kind 同值 / 不同 kind / 抽不出 claims)一条都不失效', () => {
    const dir = tempDir('note-noconflict');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-c2c-noconflict';
        insertSession(db, { id: 'c1', conversation, scene: 'c2c', turns: 4 });
        insertNote(db, { conversation, source: 'c1#1', at: BASE - 4000, text: '记住我最喜欢喝美式' });
        insertNote(db, { conversation, source: 'c1#2', at: BASE - 3000, text: '我最最喜欢喝美式' });
        insertNote(db, { conversation, source: 'c1#3', at: BASE - 2000, text: '记住我弟弟叫小明' });
        insertNote(db, { conversation, source: 'c1#4', at: BASE - 1000, text: '记住我们明天要考试' });
        assert.deepEqual(noteClaims('记住我们明天要考试'), [], '前提:这句抽不出 claims');
        const result = reconcileNoteSupersedes(db, { now: BASE + 1000 });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.notes, 4);
        assert.equal(result.conflicts, 0, '同值 / 不同 kind / 无 claims 都不是冲突');
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM note WHERE invalid_at IS NOT NULL').get().n,
          0,
        );
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('一致性(D159):consolidate 已收敛的库再跑 reconcile → conflicts=0(两处判据漂了会红)', () => {
    const dir = tempDir('consistency');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-c2c-A';
        archiveTurns(db, conversation, [
          [8, '记住我最喜欢喝美式', BASE - 2 * DAY],
          [20, '我最喜欢喝拿铁了', BASE - DAY],
        ]);
        const consolidated = consolidate(db, { now: BASE, windowMs: 30 * DAY });
        assert.ok(Number(consolidated.superseded) >= 1, `consolidate 应已软失效至少 1 条,实际 ${consolidated.superseded}`);
        assert.equal(notesOf(db, { conversation }).length, 1, 'consolidate 收敛后只剩一条有效说法');

        const before = totalChanges(db);
        const dry = reconcileNoteSupersedes(db, { now: BASE + 1000, dryRun: true });
        assert.equal(dry.ok, true, dry.error);
        assert.equal(dry.notes, 1, '只剩一条有效 note 可看');
        assert.equal(dry.conflicts, 0, 'consolidate 已收敛过的库,reconcile 不该再找出冲突');
        assert.equal(dry.invalidated.length, 0);
        const applied = reconcileNoteSupersedes(db, { now: BASE + 2000 });
        assert.equal(applied.conflicts, 0);
        assert.equal(totalChanges(db), before, '没有冲突时一行都不写');
        assert.equal(notesOf(db, { conversation, latestOnly: false }).length, 2, '被 consolidate 软失效的那条还物理在');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('note 回溯:只读库返回 ok:false 且不抛(调用方据此跳过,不影响正常记忆)', () => {
    const dir = tempDir('readonly');
    try {
      const file = path.join(dir, 'memory.db');
      makeLegacyDb(file);
      const db = openMemoryReadOnly(file);
      try {
        let result = null;
        assert.doesNotThrow(() => {
          result = reconcileNoteSupersedes(db, { now: BASE });
        }, '只读连接上补不了列只该降级,不许把"回溯"变成异常');
        assert.equal(result.ok, false, '补不上软失效列 → ok:false');
        assert.ok(typeof result.error === 'string' && result.error.length > 0, '要说得出原因');
        // 老行一条都没动(老库没有 invalid_at 列 —— 连列都没被加上)。
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note').get().n, 1);
        assert.equal(
          db.prepare('PRAGMA table_info(note)').all().some((col) => col.name === 'invalid_at'),
          false,
          '只读连接不许补列',
        );
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });
}
