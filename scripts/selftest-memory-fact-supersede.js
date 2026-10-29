/**
 * 记忆系统 P1-C:事实(fact)的 **ADD-only 软失效** 回归(2026-10-19)。
 *
 * 为什么要有这一层(用户口径 = 记忆只增不删):
 *   旧行为是"同 scope+subject+kind+value 幂等,不同值各占一行" —— 于是「我弟弟」
 *   和「我哥哥」会**同时**被注入,模型只能自己挑,挑错了她就会叫错人。
 *   但直接删旧行又违反"记忆不可再生"那条纪律(删了就没法解释"她以前以为是弟弟")。
 *   所以:旧行**留着**,只打 `invalid_at` / `superseded_by` 从注入里退场;
 *   他改口回来时**复活原行**(同一句话永远只有一行)。这就是 ADD-only 软失效。
 *
 * ⚠️ 这份测试**不读源码猜行为**:每个用例都开一个真的临时 SQLite 库(node:sqlite),
 *    跑真的 touchFact / facts / factStats / forgetFacts —— 形状照 selftest-longterm-consumption.js,
 *    由 scripts/selftest.js 注册进全量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { renderFacts } from '../src/profile.js';

/** 开一个临时目录(每个用例独立,别让一个用例的失败/残留污染另一个)。 */
function tempStateDb(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-fact-supersede-${tag}-`));
  return { dir, file: path.join(dir, 'state.db') };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 老库的 fact 表形状(P1-C 之前:没有 superseded_by / merged_into / invalid_at)。 */
const LEGACY_FACT_SCHEMA = `
  CREATE TABLE fact (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope      TEXT NOT NULL,
    subject    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    detail     TEXT,
    source     TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX idx_fact_key ON fact(scope, subject, kind, value);
  CREATE INDEX idx_fact_seen ON fact(last_seen DESC);
`;

export function registerMemoryFactSupersedeTests({ test, assert }) {
  test('内存事实软失效:老库打开时自动补三列,老事实当"一直有效",重复打开幂等', () => {
    const { dir, file } = tempStateDb('migrate');
    // ① 手写一张 P1-C 之前的老表 + 两行老事实(模拟真库升级上来的样子)。
    const raw = new DatabaseSync(file);
    raw.exec(LEGACY_FACT_SCHEMA);
    raw.exec(`
      INSERT INTO fact (scope, subject, kind, value, detail, source, first_seen, last_seen, seen_count)
      VALUES ('c2c:1', 'self', 'health', '胃炎', 'chronic', 'told', 1000, 1000, 3),
             ('c2c:1', 'self', 'relation', '弟弟', NULL, 'told', 1000, 1000, 1)
    `);
    raw.close();

    // ② 打开 = 跑 SCHEMA + migrate:三列必须被 ALTER TABLE 补上(不是靠 CREATE TABLE IF NOT EXISTS)。
    const first = new SqliteStateStore(file);
    const columns = first.handle.prepare('PRAGMA table_info(fact)').all().map((row) => row.name);
    for (const column of ['superseded_by', 'merged_into', 'invalid_at']) {
      assert.ok(columns.includes(column), `老库迁移后 fact 缺列 ${column}: ${columns.join(',')}`);
    }
    assert.equal(first.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, 2, '迁移不许动行数');
    assert.equal(
      first.handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE invalid_at IS NOT NULL').get().n,
      0,
      '老事实没有失效记录 ⇒ 当作一直有效(否则升级当天她会忘光)',
    );
    // 老行要经**新读路径**读得出来,而且三个新字段都是空(= 有效)。
    const rows = first.facts({ scope: 'c2c:1', latestOnly: false });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.invalidAt === null && row.supersededBy === null && row.mergedInto === null));
    assert.equal(first.factStats().total, 2, '老事实照样算进 total');
    first.close();

    // ③ 再打开一次(启动路径每天都会跑迁移):列不许被加第二遍,行数也不许变。
    const second = new SqliteStateStore(file);
    const again = second.handle.prepare('PRAGMA table_info(fact)').all().map((row) => row.name);
    assert.equal(
      again.filter((name) => ['superseded_by', 'merged_into', 'invalid_at'].includes(name)).length,
      3,
      '重复迁移必须幂等(列只该有一份)',
    );
    assert.equal(second.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, 2);
    second.close();
    cleanup(dir);
  });

  test('内存事实软失效:改口只软失效旧行、物理行还在;注入只剩新值(ADD-only,P1-C)', () => {
    const { dir, file } = tempStateDb('supersede');
    const store = new SqliteStateStore(file);
    const scope = 'c2c:1';
    const subject = 'self';

    // ① 「我弟弟」→「我哥哥」:第二个 told 让第一个退役。
    const di = store.touchFact({ scope, subject, kind: 'relation', value: '弟弟', source: 'told' }, 1000);
    assert.equal(typeof di.id, 'number', 'touchFact 要返回本次命中的行 id(接线要拿它当 superseded_by)');
    assert.deepEqual(di.superseded, [], '第一条没有旧值可退役');
    const ge = store.touchFact({ scope, subject, kind: 'relation', value: '哥哥', source: 'told' }, 2000);
    assert.deepEqual(
      ge.superseded,
      [{ id: di.id, kind: 'relation', value: '弟弟' }],
      '被这次写失效的旧行要**逐条**返回(回执/日志要用)',
    );

    // ② 物理行还在(ADD-only 的判据:count 还是 2,不是 1)。
    assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, 2, '旧行不许被物理删');
    const oldPhysical = store.handle
      .prepare('SELECT id, invalid_at, superseded_by FROM fact WHERE value = ?')
      .get('弟弟');
    assert.equal(oldPhysical.invalid_at, 2000, 'invalid_at = 本次写的时刻');
    assert.equal(oldPhysical.superseded_by, ge.id, 'superseded_by 指回取代它的新行');

    // ③ 默认读路径(注入吃的就是这条)= 只剩新值。
    assert.deepEqual(store.facts({ scope, subject }).map((fact) => fact.value), ['哥哥']);
    // ④ 审计路径 latestOnly:false 能翻出旧行,而且时间戳都在。
    const audit = store.facts({ scope, subject, latestOnly: false });
    assert.equal(audit.length, 2, 'latestOnly:false 要能看到全部');
    const retired = audit.find((fact) => fact.value === '弟弟');
    assert.equal(retired.invalidAt, 2000);
    assert.equal(retired.supersededBy, ge.id);
    assert.equal(audit.find((fact) => fact.value === '哥哥').invalidAt, null, '新行是有效的');

    // ⑤ 注入级判据:真正拼进提示词的那段文本里不许再出现旧值。
    const rendered = renderFacts(store.facts({ scope, subject }));
    assert.match(rendered, /哥哥/, rendered);
    assert.doesNotMatch(rendered, /弟弟/, `旧值不该进注入:${rendered}`);
    store.close();
    cleanup(dir);
  });

  test('内存事实软失效:改口回来复活原行(同一句话只有一行),刚被取代的那行退役', () => {
    const { dir, file } = tempStateDb('revive');
    const store = new SqliteStateStore(file);
    const scope = 'c2c:1';
    const subject = 'self';

    const di = store.touchFact({ scope, subject, kind: 'relation', value: '弟弟', source: 'told' }, 1000);
    const ge = store.touchFact({ scope, subject, kind: 'relation', value: '哥哥', source: 'told' }, 2000);
    // 他改口回来:「还是我弟弟」 —— 老行要重新成立,而不是新起第三行。
    const back = store.touchFact({ scope, subject, kind: 'relation', value: '弟弟', source: 'told' }, 3000);
    assert.equal(back.id, di.id, '同一句话复用原行(不另起一行,否则同一句话会堆很多行)');
    assert.deepEqual(back.superseded, [{ id: ge.id, kind: 'relation', value: '哥哥' }]);

    assert.deepEqual(store.facts({ scope, subject }).map((fact) => fact.value), ['弟弟']);
    const audit = store.facts({ scope, subject, latestOnly: false });
    assert.equal(audit.length, 2, 'ADD-only:还是两行');
    const revived = audit.find((fact) => fact.value === '弟弟');
    assert.equal(revived.invalidAt, null, '复活 = invalid_at 清空');
    assert.equal(revived.supersededBy, null, '复活要连 superseded_by 一起清(不然它指着别人)');
    assert.equal(revived.seenCount, 2, '复活不是"假装没发生过":见到次数照样涨');
    const retiredNow = audit.find((fact) => fact.value === '哥哥');
    assert.equal(retiredNow.invalidAt, 3000);
    assert.equal(retiredNow.supersededBy, di.id);

    // 撤销不该被软失效挡住:/忘了 是用户显式删除,物理删照旧,而且删得到失效行。
    const removed = store.forgetFacts({ scope, subject, kind: 'relation', value: '哥哥' });
    assert.equal(removed.length, 1, 'forgetFacts 要能删到已软失效的行');
    assert.equal(removed[0].value, '哥哥');
    assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, 1);
    store.close();
    cleanup(dir);
  });

  test('内存事实软失效:mined 不许让任何行失效(回扫是猜的,别退役 told/declared)', () => {
    const { dir, file } = tempStateDb('mined');
    const store = new SqliteStateStore(file);
    const scope = 'c2c:1';
    const subject = 'self';

    // 「我胃不好」(他说的)→ 回扫又从旧会话里挖出「感冒」:两条都留着。
    store.touchFact({ scope, subject, kind: 'health', value: '胃炎', detail: 'chronic', source: 'told' }, 1000);
    const mined = store.touchFact(
      { scope, subject, kind: 'health', value: '感冒', detail: 'short', source: 'mined' },
      2000,
    );
    assert.deepEqual(mined.superseded, [], 'mined 是猜的,不许把 told 退役(来源只升不降的延伸)');
    assert.equal(
      store.handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE invalid_at IS NOT NULL').get().n,
      0,
      '没有任何行该被 mined 失效',
    );
    assert.deepEqual(
      store.facts({ scope, subject }).map((fact) => fact.value).sort(),
      ['感冒', '胃炎'],
      '两条都还在注入里(mined 与 told 并存的既有行为不变)',
    );
    store.close();
    cleanup(dir);
  });

  test('内存事实软失效:只退役同一作用域+对象+维度的旧值,别的维度/别人/别的群一条不动;factStats 只数有效行', () => {
    const { dir, file } = tempStateDb('scope');
    const store = new SqliteStateStore(file);

    store.touchFact({ scope: 'c2c:1', subject: 'self', kind: 'relation', value: '弟弟' }, 1000);
    store.touchFact({ scope: 'c2c:1', subject: 'self', kind: 'relation', value: '哥哥' }, 2000); // 退役「弟弟」
    store.touchFact({ scope: 'c2c:1', subject: 'self', kind: 'health', value: '胃炎', detail: 'chronic' }, 3000);
    store.touchFact({ scope: 'c2c:1', subject: 'other', kind: 'relation', value: '朋友' }, 4000);
    store.touchFact({ scope: 'group:9', subject: 'self', kind: 'relation', value: '哥哥' }, 5000);

    // ① 冲突判定只在 (scope, subject, kind) 之内:别人(scene 里另一个 subject)、
    //    别的维度、别的群的事实一条都没被退役。
    assert.deepEqual(
      store.facts({ scope: 'c2c:1' }).map((fact) => `${fact.subject}:${fact.kind}:${fact.value}`).sort(),
      ['other:relation:朋友', 'self:health:胃炎', 'self:relation:哥哥'],
    );
    assert.equal(store.facts({ scope: 'group:9' }).length, 1, '别的作用域不受影响');

    // ② factStats:total / 各 kind 只数有效行,invalid 单独给失效条数(可用于核账)。
    assert.deepEqual(store.factStats('c2c:1'), { total: 3, relation: 2, health: 1, invalid: 1 });
    const all = store.factStats();
    assert.equal(all.total, 4, '全库有效行 = c2c:1 三条 + group:9 一条');
    assert.equal(all.relation, 3);
    assert.equal(all.health, 1);
    assert.equal(all.invalid, 1);
    // 可核对的恒等式:物理行数 = 有效 + 失效(启动横幅报的是"她记得多少条")。
    assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, all.total + all.invalid);
    store.close();
    cleanup(dir);
  });

  test('内存事实软失效:mined 同值再 touch **不许复活**旧行(回扫猜的不许把已改口的说法翻回来)', () => {
    const { dir, file } = tempStateDb('mined-revive');
    const store = new SqliteStateStore(file);
    const scope = 'c2c:1';
    const subject = 'self';

    const di = store.touchFact({ scope, subject, kind: 'relation', value: '弟弟', source: 'told' }, 1000);
    const ge = store.touchFact({ scope, subject, kind: 'relation', value: '哥哥', source: 'told' }, 2000);
    assert.equal(di.id > 0, true);
    // 现场形状:profile-scan 回扫旧历史,用 mined 把**已被退役**的旧值又 touch 一次。
    const minedBack = store.touchFact({ scope, subject, kind: 'relation', value: '弟弟', source: 'mined' }, 3000);
    assert.equal(minedBack.isNew, false, '同值还是同一行(只做 upsert)');
    assert.deepEqual(minedBack.superseded, [], 'mined 不许动任何行的有效性');

    const retired = store.handle
      .prepare('SELECT invalid_at, superseded_by FROM fact WHERE value = ?')
      .get('弟弟');
    assert.equal(retired.invalid_at, 2000, 'mined 不许把被 told 退役的旧值复活(invalid_at 保持不变)');
    assert.equal(retired.superseded_by, ge.id);
    assert.deepEqual(store.facts({ scope, subject }).map((fact) => fact.value), ['哥哥'], '注入仍只剩新值');
    assert.equal(store.facts({ scope, subject, latestOnly: false }).length, 2, '物理行数不变(ADD-only)');
    // upsert 的"又见到一次"照常记账,但"见到过"不等于"重新成立"。
    const audit = store.facts({ scope, subject, latestOnly: false });
    assert.equal(audit.find((fact) => fact.value === '弟弟').seenCount, 2);
    assert.equal(store.factStats().invalid, 1);
    store.close();
    cleanup(dir);
  });

  test('内存事实软失效:同值重复 touch 不退役任何行(幂等)', () => {
    const { dir, file } = tempStateDb('idempotent');
    const store = new SqliteStateStore(file);
    const fact = { scope: 'c2c:1', subject: 'self', kind: 'relation', value: '弟弟', source: 'told' };

    const first = store.touchFact(fact, 1000);
    const again = store.touchFact(fact, 2000);
    assert.equal(first.isNew, true);
    assert.equal(again.isNew, false, '同 scope+subject+kind+value = 同一条');
    assert.deepEqual(again.superseded, [], '重复说同一句话不该退役任何行');
    assert.deepEqual(store.facts({ scope: 'c2c:1' }).map((row) => row.value), ['弟弟']);
    const rows = store.facts({ scope: 'c2c:1', latestOnly: false });
    assert.equal(rows.length, 1, '不该因为重复见到就多出一行');
    assert.equal(rows[0].seenCount, 2);
    assert.equal(store.factStats().invalid, 0);
    store.close();
    cleanup(dir);
  });
}
