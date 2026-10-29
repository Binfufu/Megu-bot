/**
 * **实体共现 + boost**(P1-F,2026-10-19,方案 §5)回归。
 *
 * 要治的形状:「示例甲最近怎么样」这类**实体类问题**,标签词表一个不命中、
 * 语义那维只能救"意思近"的 —— 而"哪些轮提到过示例甲"是**字面共现**,零模型调用。
 * 修法:`entity`/`entity_mention` 两表(派生数据,可整表重建)+ 检索打分加第五维
 * `entityScore`(权重 <1 盖不过标签,不进 importance —— 与语义那维同一条纪律)。
 *
 * ⚠️ 判据全部**真跑临时 SQLite 库**(openMemory + 直插 turn)+ 纯函数直调,不读源码猜行为。
 *
 * 覆盖:
 *   · 重建:名册/mention 生成正确;单字名不进(「甲」吃掉「踩甲乙」那个现场);
 *     非人话轮(kind=tool)不扫;重建两次幂等。
 *   · 整名匹配:「甲乙」靠完整名字串命中,不是分词。
 *   · recallDecision:实体共现是**判据1 的第四次扩展**(零标签/零语义/无 FTS 时准入),
 *     加分 <1 盖不过标签,不进 importance;why 说得出「实体共现」。
 *   · 回归:query 里没有名单中的名字时,行为与 P1-E **逐位一致**(连 mention 查询都不发);
 *     `entityBoost=0` 同样一字不变(回滚开关)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  entityHitsFor, entityStats, openMemory, pickLongTerm, rebuildEntities,
} from '../src/memory-store.js';
import { recallDecision } from '../src/memory-tags.js';

const BASE = Date.UTC(2026, 9, 1, 4, 0);

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-entity-${tag}-`));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 造库:一段会话两条人话 + 一条 tool 轮。返回 db 与关键 source。 */
function makeDb(dir) {
  const db = openMemory(path.join(dir, 'memory.db'));
  db.prepare(
    `INSERT INTO session (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
     VALUES ('s1', 'qqbot-group-A', 'group', 'g', 1, ?, '', 'test', 3, ?)`,
  ).run(BASE - 86400_000, BASE);
  const ins = db.prepare(
    `INSERT INTO turn (session_id, seq, at, kind, user_text) VALUES ('s1', ?, ?, ?, ?)`,
  );
  ins.run(2, BASE - 3000, 'mention', '示例甲昨天教我示例技能了');
  ins.run(4, BASE - 2000, 'mention', '测试甲乙这个游戏真难');
  ins.run(6, BASE - 1000, 'tool', '示例甲在工具轮里出现不该算共现');
  return { db, demoSource: 's1#2', pairSource: 's1#4', toolSource: 's1#6' };
}

/** 一条候选的快捷构造(candidatesFor/FTS 同形状)。 */
function cand(id, text, { at = BASE - 5000, tags = [], entityHits = null } = {}) {
  return {
    id, at, text, kind: 'mention', conversation: 'qqbot-group-A',
    tags, useCount: 0, lastUsedAt: 0, vector: null,
    ...(entityHits !== null ? { entityHits } : {}),
  };
}

export function registerEntityTests({ test, assert }) {
  test('实体重建:名册/mention 正确生成;单字名不进;非人话轮不扫;重建两次幂等', () => {
    const dir = tempDir('rebuild');
    try {
      const { db, demoSource, pairSource, toolSource } = makeDb(dir);
      try {
        const first = rebuildEntities(db, {
          names: [
            { name: '示例甲', kind: 'person' },
            { name: '示例技能', kind: 'concept' },
            { name: '甲', kind: 'person' }, // 单字名:吃掉「踩甲乙」的现场,必须拒
            { name: '甲乙', kind: 'person' },
          ],
        });
        assert.equal(first.entities, 3, '单字名被拒,名册 3 个');
        assert.ok(first.mentions >= 3, `mention 至少 3 轮次(实际 ${first.mentions})`);
        const stats = entityStats(db);
        assert.equal(stats.entities, 3);
        assert.equal(stats.mentions, first.mentions, 'entityStats 与重建返回一致');

        const hits = entityHitsFor(db, [demoSource, pairSource, toolSource]);
        assert.deepEqual(
          hits.get(demoSource)?.sort(),
          ['示例技能', '示例甲'],
          '人话轮命中两个名字(排序按码位,内容对就行)',
        );
        assert.deepEqual(hits.get(pairSource), ['甲乙'], '「甲乙」靠整名命中(不是「甲」)');
        assert.equal(hits.has(toolSource), false, 'tool 轮不进 mention(NON_MEMORY_KINDS)');

        // 幂等:重建两次,内容一致。
        rebuildEntities(db, {
          names: [
            { name: '示例甲', kind: 'person' },
            { name: '示例技能', kind: 'concept' },
            { name: '甲', kind: 'person' },
            { name: '甲乙', kind: 'person' },
          ],
        });
        const stats2 = entityStats(db);
        assert.equal(stats2.entities, stats.entities);
        assert.equal(stats2.mentions, stats.mentions, '重建两次行数一致(派生数据,不堆重复)');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('recallDecision:实体共现是判据1 的第四次扩展 —— 零标签零语义时准入,加分不进 importance', () => {
    const relevant = cand('s1#2', '示例甲昨天教我示例技能了', { entityHits: ['示例甲', '示例技能'] });
    const unrelated = cand('s9#1', '今天天气真的很好呀', {});
    const decision = recallDecision(
      [relevant, unrelated],
      '示例甲最近怎么样 教 示例技能',
      { now: BASE, limit: 3, minScore: 1, entities: { query: ['示例甲', '示例技能'], weight: 0.3 } },
    );
    assert.equal(decision.picked.length, 1, '只有实体共现那条进候选');
    assert.equal(decision.picked[0].id, 's1#2');
    // 加分 = 0.3 × min(命中数 2, 封顶 2) = 0.6;<1,盖不过一个标签命中。
    assert.equal(decision.picked[0].entityScore, 0.6);
    assert.ok(
      decision.picked[0].why.some((line) => line.includes('实体共现')),
      `why 要说得出实体共现:${JSON.stringify(decision.picked[0].why)}`,
    );
    assert.equal(
      decision.picked[0].raw.imp, 0,
      '实体共现不进 importance(「提过这个人」≠「这件事重要」)',
    );
    assert.ok(decision.picked[0].raw.rel > 0, '但它是相关度维(normalized 路径也认)');
  });

  test('回归:query 没点名实体时与 P1-E 逐位一致(pickLongTerm 负责过滤);boost=0 一字不变', () => {
    const dir = tempDir('regress');
    try {
      const { db } = makeDb(dir);
      try {
        rebuildEntities(db, { names: [{ name: '示例甲', kind: 'person' }] });
        // 直插一条带标签的轮次当"对照组"(与实体轮同会话、更早,标签 food 可被 query 命中)。
        db.prepare(
          `INSERT INTO turn (session_id, seq, at, kind, user_text) VALUES ('s1', 8, ?, 'mention', '记住我最喜欢喝冰美式')`,
        ).run(BASE - 6000);
        db.prepare(
          `INSERT INTO memory_tag (session_id, seq, tag, source, created_at) VALUES ('s1', 8, 'food', 'rule', ?)`,
        ).run(BASE - 6000);
        // 提及示例甲的那条(词表不命中,只有实体那一维)。
        db.prepare(
          `INSERT INTO memory_tag (session_id, seq, tag, source, created_at) VALUES ('s1', 2, 'game', 'rule', ?)`,
        ).run(BASE - 3000);
        // query 故意**不含**「示例甲」—— 按契约,pickLongTerm 要把"query 里没出现的名字"滤掉,
        // 此时的行为必须与实体块关掉时**逐位一致**(这是"无实体时行为不变"的主判据)。
        const query = '我们玩什么游戏好';
        const off = pickLongTerm(db, {
          conversation: 'qqbot-group-A', query, now: BASE, minAgeMs: 0,
          entityNames: [], entityBoost: 0, fts: { enabled: false },
        });
        const onQuiet = pickLongTerm(db, {
          conversation: 'qqbot-group-A', query, now: BASE, minAgeMs: 0,
          entityNames: ['示例甲'], entityBoost: 0.3, fts: { enabled: false },
        });
        assert.deepEqual(
          onQuiet.picked.map((memory) => [memory.id, memory.score]),
          off.picked.map((memory) => [memory.id, memory.score]),
          'query 没点名实体:开与关逐位一致',
        );
        // 同一支 query 点了名(「示例甲 吃 什么」):实体维生效,game 那条靠实体准入进池。
        const onNamed = pickLongTerm(db, {
          conversation: 'qqbot-group-A', query: '示例甲 吃 什么', now: BASE, minAgeMs: 0,
          entityNames: ['示例甲'], entityBoost: 0.3, fts: { enabled: false },
        });
        assert.ok(
          onNamed.picked.some((memory) => memory.id === 's1#2' && memory.entityScore > 0),
          '点名后实体轮被准入且带加分',
        );
        // 回滚开关:同一个点名 query,boost=0 → 实体轮不再准入。
        const offNamed = pickLongTerm(db, {
          conversation: 'qqbot-group-A', query: '示例甲 吃 什么', now: BASE, minAgeMs: 0,
          entityNames: ['示例甲'], entityBoost: 0, fts: { enabled: false },
        });
        assert.equal(
          offNamed.picked.some((memory) => memory.id === 's1#2'),
          false,
          'boost=0 时实体轮没有标签就不准入(回 P1-E 行为)',
        );
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('recallDecision 契约:entities.query 只认"已过滤名单" —— 传无关名字等价于没给', () => {
    const pool = [
      { ...cand('s1#5', '记住我最喜欢喝冰美式', { tags: ['food'] }), entityHits: ['示例甲'] },
      { ...cand('s1#6', '说好了下次请你吃夜宵', { tags: ['food', 'promise'] }), entityHits: [] },
    ];
    const baseline = recallDecision(
      pool.map(({ entityHits, ...rest }) => rest),
      '我们吃什么好',
      { now: BASE, limit: 3, minScore: 1 },
    );
    // entities.query 传一个谁都不沾的名字 → entityHits 过滤后为空 → 与没给 entities 等价。
    const withUnused = recallDecision(
      pool.map((memory) => ({ ...memory })),
      '我们吃什么好',
      { now: BASE, limit: 3, minScore: 1, entities: { query: ['示例乙'], weight: 0.3 } },
    );
    assert.deepEqual(
      withUnused.picked.map((memory) => [memory.id, memory.score]),
      baseline.picked.map((memory) => [memory.id, memory.score]),
      '无关名字不改变任何分数',
    );
  });

  test('实体加分盖不过一个标签命中(权重 <1 的纪律)', () => {
    const entityOnly = cand('s1#2', '示例甲昨天教我示例技能了', { entityHits: ['示例甲'] });
    const tagged = cand('s1#8', '我最喜欢喝冰美式了', { tags: ['food'] });
    const decision = recallDecision(
      [entityOnly, tagged],
      '示例甲 吃 什么',
      { now: BASE, limit: 3, minScore: 1, entities: { query: ['示例甲'], weight: 0.3 } },
    );
    assert.equal(decision.picked[0].id, 's1#8', '标签命中排第一');
    assert.equal(decision.picked[0].score > decision.picked[1].score, true, '实体分 +0.3 盖不过 +1 标签');
  });
}
