/**
 * 记忆**近重复合并**(P1-D,2026-10-19)回归。
 *
 * 要治的形状:同一句话说两遍(clean 后逐字相同)或几乎同义(向量余弦 ≥0.90)会作为
 * 两条 note 各自占一份注入预算。修法是 `planNoteMerges`:先精确、再余弦(Mem0 / Zep 的
 * 近重复 dedupe 口径),旧的写 `merged_into` 指向保留的那条(分最高 → at 最新 → id 最大),
 * **只软标记不物理删**,读路径默认不端出(`latestOnly:false` 审计可见)。
 *
 * ⚠️ 判据全部**真跑临时 SQLite 库**(`openMemory` + 直插 note 行 + `saveEmbedding` 直插向量),
 *    不读源码猜行为;`dryRun:true` 必须**一个字节都不写**,用 `total_changes()` 钉住。
 *
 * 覆盖:
 *   · 精确去重(clean 后相同,含空白差异):dryRun 不写;canonical 取分最高;apply 后读路径
 *     消失、noteStats.merged 计数、latestOnly:false 仍能审计;apply 之后幂等。
 *   · 余弦合并(≥0.90 并组,<0.90 不并;组内重选 canonical);链式组(P~S、P~Q → 三条一组)。
 *   · 负形状:<8 字不参与余弦;没向量不参与;model 不同不比;跨会话不合并(连精确都不并)。
 *   · 只读库:`planNoteMerges` 返回 ok:false 且**不抛**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanMemoryText } from '../src/memory-archive.js';
import {
  noteStats, notesFor, notesOf, openMemory, openMemoryReadOnly, planNoteMerges, saveEmbedding,
} from '../src/memory-store.js';

const DAY = 86400_000;
const BASE = Date.UTC(2026, 9, 1, 4, 0); // 2026-10-01 04:00 UTC(与 memory 系列同一基准)

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-memory-merge-${tag}-`));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
/** 这条连接上"改了几行"的计数 —— dryRun 不写就用它钉(比文件 mtime 稳,也不受 WAL 影响)。 */
function totalChanges(db) {
  return Number(db.prepare('SELECT total_changes() AS n').get().n);
}

/** 手工插一段会话(scene 与合并无关,保持与真库同形状)。 */
function insertSession(db, { id, conversation, scene = 'c2c', turns = 2 }) {
  db.prepare(
    `INSERT INTO session (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
     VALUES (?, ?, ?, 'test-target', 1, ?, '', 'test', ?, ?)`,
  ).run(id, conversation, scene, BASE - DAY, turns, BASE);
}

/** 手工插一条 note(绕过 consolidate —— 要的是"已并存"的形状)。 */
function insertNote(db, { conversation, source, at, tier = 'mid', score = 3, text, tags = '' }) {
  return Number(
    db.prepare(
      `INSERT INTO note (conversation, source, at, created_at, tier, score, reasons, tags, text)
       VALUES (?, ?, ?, ?, ?, ?, '测试用', ?, ?)`,
    ).run(conversation, source, at, BASE, tier, score, tags, text).lastInsertRowid,
  );
}

/** 造一个**没迁移过**的 memory.db(note 表没有 P1-C 三列 —— 只读用例要它来触发 ok:false)。 */
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

/** 单位向量 `[1, 0]` 与 `[t, sqrt(1-t²)]` 的余弦恰好是 t —— 造"可控相似度"用。 */
function vecAt(cos) {
  return [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];
}

export function registerMemoryMergeTests({ test, assert }) {
  test('近重复合并:精确去重(clean 后相同)——dryRun 不写、canonical 取分最高、读路径消失、幂等', () => {
    const dir = tempDir('exact');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-c2c-merge-exact';
        insertSession(db, { id: 's1', conversation });
        const lowerId = insertNote(db, {
          conversation, source: 's1#1', at: BASE - 2000, score: 3, text: '记住我最喜欢喝美式',
          tags: 'emotion,food', // T1-D:零交集不再注入 —— 夹具按真实归档形状带标签
        });
        // 尾随空格:cleanMemoryText 会规整掉 —— "clean 后逐字相同"要吃这条。
        const higherId = insertNote(db, {
          conversation, source: 's1#2', at: BASE - 1000, score: 5, text: '记住我最喜欢喝美式 ',
          tags: 'emotion,food',
        });
        assert.equal(
          cleanMemoryText('记住我最喜欢喝美式 ') === cleanMemoryText('记住我最喜欢喝美式'), true,
          '前提:两条 clean 后逐字相同',
        );
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM note WHERE merged_into IS NOT NULL').get().n, 0,
          '前提:merged_into 还没人写(P1-D 之前的库)',
        );

        const before = totalChanges(db);
        const dry = planNoteMerges(db, { dryRun: true });
        assert.equal(dry.ok, true, dry.error);
        assert.equal(dry.dryRun, true);
        assert.equal(dry.notes, 2);
        assert.equal(dry.groups.length, 1, '精确重复并成一组');
        assert.equal(dry.merges, 1, '组里一条退役');
        assert.deepEqual(
          { canonical: dry.groups[0].canonical.id, member: dry.groups[0].members[0].id, via: dry.groups[0].members[0].via },
          { canonical: higherId, member: lowerId, via: 'exact' },
          '分最高的留下,另一条 exact 并入',
        );
        // dryRun 的硬判据:这条连接一行都没改,库里也没有任何 merged_into。
        assert.equal(totalChanges(db), before, 'dryRun 不许写一个字节');
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM note WHERE merged_into IS NOT NULL').get().n, 0,
          'dryRun 后所有行仍未合并',
        );

        const applied = planNoteMerges(db, { dryRun: false });
        assert.equal(applied.merges, 1);
        const rows = db.prepare('SELECT id, merged_into FROM note ORDER BY id').all();
        assert.equal(rows.length, 2, 'ADD-only:物理行数不变');
        assert.equal(rows.find((row) => row.id === lowerId).merged_into, higherId, '旧的指向保留那条');
        assert.equal(rows.find((row) => row.id === higherId).merged_into, null, '保留那条不写');

        // 读路径:默认不再端出被合并的行;审计开关能看全;统计单独报 merged。
        assert.deepEqual(
          notesOf(db, { conversation }).map((row) => String(row.text).trim()),
          ['记住我最喜欢喝美式'],
          'notesOf 默认只剩保留那条',
        );
        assert.equal(notesOf(db, { conversation, latestOnly: false }).length, 2, 'latestOnly:false 仍能审计');
        const pool = notesFor(db, { conversation, query: '记住我最喜欢喝美式', now: BASE + DAY });
        assert.deepEqual(
          pool.map((note) => String(note.id)).sort(),
          ['s1#2'],
          'notesFor 默认候选池只剩保留那条(s1#2),被合并的 s1#1 不再进池',
        );
        const stats = noteStats(db, BASE + DAY);
        assert.equal(stats.merged, 1, 'merged 单独计数');
        assert.equal(stats.midAll, 1, '各项只统计未合并的行');

        // 幂等:再跑一次没有组、也不再写。
        const changesAfterApply = totalChanges(db);
        const again = planNoteMerges(db, { dryRun: false });
        assert.equal(again.ok, true);
        assert.equal(again.groups.length, 0, 'apply 之后必须幂等');
        assert.equal(again.merges, 0);
        assert.equal(totalChanges(db), changesAfterApply, '没有组时一行都不写');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('近重复合并:余弦 ≥0.90 并组(链式三条)、<0.90 不并、组内重选 canonical(分最高→at 最新)', () => {
    const dir = tempDir('cosine');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-c2c-merge-cos';
        insertSession(db, { id: 's2', conversation, turns: 8 });
        // P(分4,最旧)~Q(分4,较新)cos=0.95;P~S(分2,最新)cos=0.97;R 放在 50° 方向:
        // cos(P,R)=0.643、cos(Q,R)=0.850、cos(S,R)=0.810 —— 与组内三条都 <0.90,不许被误并。
        // 组 = {P,Q,S} 链式连通;canonical = 分最高(P/Q 打平)→ at 最新的 Q。
        const pId = insertNote(db, {
          conversation, source: 's2#1', at: BASE - 4000, score: 4, text: '记住我最喜欢喝冰美式',
        });
        const qId = insertNote(db, {
          conversation, source: 's2#2', at: BASE - 3000, score: 4, text: '我最喜欢喝冰美式了',
        });
        const rId = insertNote(db, {
          conversation, source: 's2#3', at: BASE - 2000, score: 4, text: '记住我弟弟叫小明',
        });
        const sId = insertNote(db, {
          conversation, source: 's2#4', at: BASE - 1000, score: 2, text: '记住我最喜欢喝冰美式呀',
        });
        saveEmbedding(db, { source: 's2#1', vector: vecAt(1.0), model: 'test-model' });
        saveEmbedding(db, { source: 's2#2', vector: vecAt(0.95), model: 'test-model' });
        saveEmbedding(db, { source: 's2#3', vector: vecAt(0.6428), model: 'test-model' });
        saveEmbedding(db, { source: 's2#4', vector: vecAt(0.97), model: 'test-model' });

        const dry = planNoteMerges(db, { dryRun: true });
        assert.equal(dry.ok, true, dry.error);
        assert.equal(dry.notes, 4);
        assert.equal(dry.compared, 6, '四个代表两两都比过(没有短文本/缺向量/model 不一致的跳过)');
        assert.equal(dry.groups.length, 1, '0.95/0.97 并成一组,50° 方向不许进组');
        const group = dry.groups[0];
        const memberIds = group.members.map((member) => member.id).sort((a, b) => a - b);
        assert.deepEqual(memberIds, [pId, sId].sort((a, b) => a - b), '组员是 P 与 S');
        assert.equal(group.canonical.id, qId, '分打平 → at 最新的 Q 当 canonical');
        assert.equal(group.members.every((member) => member.via === 'cosine'), true, '余弦并组要如实标 via');
        assert.equal(
          group.members.find((member) => member.id === pId).cos >= 0.9, true,
          '成员要带得上当时的余弦分数(复核要看)',
        );

        // apply(白名单点头全部余弦成员 —— 2026-10-19 拍板:余弦必须过人工复核才写):
        const applied = planNoteMerges(db, { dryRun: false, onlyIds: [pId, sId] });
        assert.equal(applied.ok, true, applied.error);
        assert.equal(applied.merges, 2);
        const rows = db.prepare('SELECT id, merged_into FROM note ORDER BY id').all();
        assert.equal(rows.find((row) => row.id === pId).merged_into, qId);
        assert.equal(rows.find((row) => row.id === sId).merged_into, qId);
        assert.equal(rows.find((row) => row.id === qId).merged_into, null);
        assert.equal(rows.find((row) => row.id === rId).merged_into, null, '0.80 的那条不许被误并');
        assert.deepEqual(
          notesOf(db, { conversation }).map((row) => row.source).sort(),
          ['s2#2', 's2#3'].sort(),
          '读路径只剩 Q 与 R',
        );
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('近重复合并:负形状 —— <8 字 / 没向量 / model 不同都不参与余弦,谁也不许被误并', () => {
    const dir = tempDir('negative');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-c2c-merge-neg';
        insertSession(db, { id: 's3', conversation, turns: 6 });
        // 短文本(3 字):cos=1.0 也不并;score 最高 —— 若误参与,它会当 canonical,这条就红。
        const shortId = insertNote(db, {
          conversation, source: 's3#1', at: BASE - 1000, score: 9, text: '嘻嘻喵',
        });
        // 8+ 字但没有向量:不参与余弦(仍参与精确,但没有同文本伙伴)。
        const veclessId = insertNote(db, {
          conversation, source: 's3#2', at: BASE - 2000, score: 9, text: '记住我弟弟叫小明呀',
        });
        // 同 model 且 cos=1.0 但文本不同 → 按 0.90 会并;**model 不同就不比**。
        const m1Id = insertNote(db, {
          conversation, source: 's3#3', at: BASE - 3000, score: 1, text: '记住我每天早上都要跑步',
        });
        const m2Id = insertNote(db, {
          conversation, source: 's3#4', at: BASE - 4000, score: 1, text: '记住我每天晚上都要泡脚',
        });
        saveEmbedding(db, { source: 's3#1', vector: vecAt(1.0), model: 'test-model' });
        saveEmbedding(db, { source: 's3#3', vector: vecAt(1.0), model: 'model-one' });
        saveEmbedding(db, { source: 's3#4', vector: vecAt(1.0), model: 'model-two' });

        const dry = planNoteMerges(db, { dryRun: true });
        assert.equal(dry.ok, true, dry.error);
        assert.equal(dry.notes, 4);
        assert.equal(dry.groups.length, 0, '三种负形状一条都不许并');
        assert.equal(dry.merges, 0);
        assert.equal(dry.short, 1, '短文本要单独报数');
        assert.equal(dry.vectorless, 1, '有资格比但没有向量的要单独报数');

        const beforeApply = totalChanges(db);
        const applied = planNoteMerges(db, { dryRun: false });
        assert.equal(applied.merges, 0, '没有组就没有合并');
        assert.equal(totalChanges(db), beforeApply, '一行都不许写');
        const rows = db.prepare('SELECT id, merged_into FROM note ORDER BY id').all();
        assert.deepEqual(rows.map((row) => row.merged_into), [null, null, null, null], '四行全都保持未合并');
        for (const id of [shortId, veclessId, m1Id, m2Id]) {
          assert.equal(
            db.prepare('SELECT merged_into FROM note WHERE id = ?').get(id).merged_into, null,
            `id=${id} 未被合并`,
          );
        }
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('近重复合并:跨会话不合并(同文本 / 同向量都不行),同会话内各自并各自的', () => {
    const dir = tempDir('crossconv');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const convA = 'qqbot-c2c-merge-a';
        const convB = 'qqbot-c2c-merge-b';
        insertSession(db, { id: 's4', conversation: convA });
        insertSession(db, { id: 's5', conversation: convB });
        // 各会话内一对精确重复;两组的文本与向量完全相同 —— 跨会话也不许并。
        const aKeep = insertNote(db, {
          conversation: convA, source: 's4#1', at: BASE - 1000, score: 5, text: '记住我最喜欢喝冰美式',
        });
        insertNote(db, { conversation: convA, source: 's4#2', at: BASE - 2000, score: 3, text: '记住我最喜欢喝冰美式' });
        const bKeep = insertNote(db, {
          conversation: convB, source: 's5#1', at: BASE - 1000, score: 5, text: '记住我最喜欢喝冰美式',
        });
        insertNote(db, { conversation: convB, source: 's5#2', at: BASE - 2000, score: 3, text: '记住我最喜欢喝冰美式' });
        saveEmbedding(db, { source: 's4#1', vector: vecAt(1.0), model: 'test-model' });
        saveEmbedding(db, { source: 's5#1', vector: vecAt(1.0), model: 'test-model' });

        const dry = planNoteMerges(db, { dryRun: true });
        assert.equal(dry.ok, true, dry.error);
        assert.equal(dry.groups.length, 2, '会话内各自成组');
        assert.equal(dry.merges, 2, '每组退役一条');
        for (const group of dry.groups) {
          assert.equal(group.canonical.id === aKeep || group.canonical.id === bKeep, true, 'canonical 是各组分高的');
          assert.equal(
            group.members.every((member) => member.via === 'exact'), true,
            '组内是精确重复(不是被跨会话余弦拉进来的)',
          );
        }

        const applied = planNoteMerges(db, { dryRun: false });
        assert.equal(applied.merges, 2);
        const cross = db.prepare(
          `SELECT n.id AS id, m.conversation AS keep_conv
             FROM note n JOIN note m ON m.id = n.merged_into
            WHERE n.conversation <> m.conversation`,
        ).all();
        assert.deepEqual(cross, [], '不许出现指向别的会话的合并');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('近重复合并:白名单制 —— 余弦成员只有 --only 点头的写库;没过复核的 apply 必须 fail closed', () => {
    const dir = tempDir('only');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const conversation = 'qqbot-c2c-merge-only';
        insertSession(db, { id: 's6', conversation, turns: 10 });
        // 余弦组:P(4,最旧)~Q(4,较新)0.95、P~S(2)0.97;精确组:两条同文本。
        const pId = insertNote(db, {
          conversation, source: 's6#1', at: BASE - 4000, score: 4, text: '记住我最喜欢喝冰美式',
        });
        const qId = insertNote(db, {
          conversation, source: 's6#2', at: BASE - 3000, score: 4, text: '我最喜欢喝冰美式了',
        });
        const sId = insertNote(db, {
          conversation, source: 's6#3', at: BASE - 1000, score: 2, text: '记住我最喜欢喝冰美式呀',
        });
        const eKeep = insertNote(db, {
          conversation, source: 's6#4', at: BASE - 2000, score: 5, text: '记住我弟弟叫小明',
        });
        const eMerge = insertNote(db, {
          conversation, source: 's6#5', at: BASE - 2500, score: 3, text: '记住我弟弟叫小明 ',
        });
        saveEmbedding(db, { source: 's6#1', vector: vecAt(1.0), model: 'test-model' });
        saveEmbedding(db, { source: 's6#2', vector: vecAt(0.95), model: 'test-model' });
        saveEmbedding(db, { source: 's6#3', vector: vecAt(0.97), model: 'test-model' });

        // dry-run:候选照报全量(P、S 两条余弦都会浮出来),但 skipped 要如实报"不会写库"的量。
        const dry = planNoteMerges(db, { dryRun: true });
        assert.equal(dry.ok, true, dry.error);
        assert.equal(dry.groups.length, 2, '余弦组 + 精确组都报出来');
        assert.equal(dry.skipped, 2, '没给白名单时,两条余弦成员全部计 skipped');
        assert.equal(dry.merges, 1, 'merges 口径 = 将写数:只有精确那 1 条');

        // fail closed:有余弦候选却没给白名单,apply 必须拒绝且一个字节不写。
        const before = totalChanges(db);
        let refused = null;
        assert.doesNotThrow(() => {
          refused = planNoteMerges(db, { dryRun: false });
        }, '拒绝要返回 ok:false,不是抛异常');
        assert.equal(refused.ok, false, '未复核的 apply 要 fail closed');
        assert.ok(String(refused.error).includes('人工复核'), `错误要说清原因:${refused?.error}`);
        assert.equal(totalChanges(db), before, '拒绝时一行都不许写');

        // 白名单生效:只点头 S —— S 写库,P 跳过,精确组照常写(不受白名单约束)。
        const allowed = planNoteMerges(db, { dryRun: false, onlyIds: [sId] });
        assert.equal(allowed.ok, true, allowed.error);
        assert.equal(allowed.merges, 2, 'S + 精确 1 条');
        assert.equal(allowed.skipped, 1, 'P 被白名单拦下');
        const rows = db.prepare('SELECT id, merged_into FROM note ORDER BY id').all();
        assert.equal(rows.find((row) => row.id === sId).merged_into, qId, '点头的 S 并进 canonical');
        assert.equal(rows.find((row) => row.id === pId).merged_into, null, '没点头的 P 保持未合并');
        assert.equal(rows.find((row) => row.id === eMerge).merged_into, eKeep, '精确成员不受白名单约束');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('近重复合并:只读库返回 ok:false 且不抛(调用方据此跳过,不影响正常记忆)', () => {
    const dir = tempDir('readonly');
    try {
      const file = path.join(dir, 'memory.db');
      makeLegacyDb(file);
      const db = openMemoryReadOnly(file);
      try {
        let result = null;
        assert.doesNotThrow(() => {
          result = planNoteMerges(db, { dryRun: true });
        }, '只读连接上补不了列只该降级,不许把"合并计划"变成异常');
        assert.equal(result.ok, false, '补不上 merged_into 列 → ok:false');
        assert.ok(typeof result.error === 'string' && result.error.length > 0, '要说得出原因');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note').get().n, 1);
        assert.equal(
          db.prepare('PRAGMA table_info(note)').all().some((col) => col.name === 'merged_into'),
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
