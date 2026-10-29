/**
 * **归档侧注入残文闸 · 判据**(2026-10-22;量化出处 `.archify\FTS封顶与重复归档量化-20261022.md` §二)。
 *
 * 单独跑:`node scripts\selftest-residue.js`。
 * ⚠️ **没有**注册进 `scripts\selftest.js` —— 注册由 lead 统一做(它导出
 * `registerResidueTests({ test, assert })`,与 selftest-entity.js 同一个形状)。
 *
 * 判据全部**真跑临时 SQLite 库**(openMemory + 真 archivePass/consolidate,清洗脚本真 spawn),
 * 规则夹具使用**既有规则前缀 + 明显合成正文**，不复制私人会话或身份，
 * 不读源码猜行为。覆盖:
 *   ① 规则逐条形状(5 条 × 合成正文,first-match 顺序也对);
 *   ② 反咬:含关键词**片段**的普通消息不许被标;顺带钉住一条**已接受的取舍**
 *      (有人逐字打出桥的整句会被标 —— 评测侧 2026-10-18 起就这么算,闸不另设宽严);
 *   ③ 归档写路径:残文轮 kind=residue 落库;classifyKind 已判过的保持原 kind(不被抹);
 *   ④ candidatesFor 取不到(标签路 + 语义路);
 *   ⑤ consolidate 不吃(对照:正常人话轮照旧固化);
 *   ⑥ 摘要/交接取样口(conversationMemory)不给残文行;
 *   ⑦ eval 与闸是**同一份判据**:eval 脚本 import RESIDUE_RULES、不再有自己的第二份;
 *   ⑧ 清洗脚本(clean-archive-residue.mjs)真跑:预演出数 → --apply 改 kind(行数不变)→ 再跑幂等。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  MEMORY_VERSION, NON_MEMORY_KINDS, RESIDUE_KIND, RESIDUE_RULES,
  cleanMemoryText, isArchiveResidue, isToolConversation,
} from '../src/memory-archive.js';
import {
  archivePass, candidatesFor, consolidate, conversationMemory, openMemory, saveEmbedding, tagsOfTurn,
} from '../src/memory-store.js';

// ---------------------------------------------------------------------------
// 夹具：保留规则识别前缀，中间正文与身份全部为合成值。
// ---------------------------------------------------------------------------

/** R1 注入块 —— 【系统】钓鱼提示词(合成场景)。 */
const FISHING = '【系统】你现在在水边钓鱼,写**一两句**话发出去。 要求: 1. 用**你自己角色**的语气（不要用别的角色的口癖）； 2. **带一个括号里的短旁白**,写你此刻的动作或神态,例如「（一边晃腿一边等着）」「（把鱼篓往脚边挪了挪）」； 3. 不要报数字、不要提"系统/数值/概率";不要解释;不要提问求回应。 事实:对方提议**用「测试纸片」当鱼饵**。你**答应了**。 写你答应下来、顺手把那个东西挂上钩的样子,一到两句。 **不要**提"概率""亲疏""好感"这类词。';
/** R1 注入块 —— 早安排程提示词(合成场景)。 */
const MORNING = '现在是早上。你在跟一个关系很近的人说话。\n这次不用端着，放松一点：可以问他睡得好不好、吃早饭了没有，语气亲近、随意。\n一句到两句就够，别写成小作文，也别像客服。\n\n如果这个时间开口不合适，就只回复 [跳过]。';
/** R2 注入残文 —— 连发合并块(合成场景)。 */
const BURST = '（下面是你刚才连着的 3 条消息，按时间顺序；回复当作一次说完，不要逐条答。）\n你\n（+1.9 秒）是\n（+4.2 秒）猪';
/** R2 注入残文 —— 自发钩子带（系统结算(合成场景)。 */
const SELFLIFE_HOOK = '你没在跟谁对话，就是自己过日子的间隙，顺手跟关系很近的人说一句。 一句到两句，随意、像自言自语被听见了，别写成报告，也别提问。 刚刚发生的事（系统结算，照做但别念数字）：你饿了，就自己去了**合成探访者合成社区楼下的食堂**，要了最便宜的定食，这一顿让代币少了一些（少了多少不用报）。 如果这会儿开口不合适，就只回复 [跳过]。';
/** R3 群上下文残文 —— **当前两只库里 0 行**,形状取自生成器代码 `src\group-context.js` 的
 *  固定首行(判据规矩:首句是代码常量,不是猜关键词)。 */
const GROUP_CONTEXT = '最近群里的消息（供你参考，不必逐条回应）：\n合成助手乙：今天合成社区食堂有定食';
/** R4 旧库桥提示词 —— 钩子开场(合成场景)。 */
const HOOK = '你之前提过一件事：合成社区食堂快打烊了,剩下一堆卖不掉的定食。到现在也没人搭话。\n\n要求：\n1. **你自己把这件事往下走完**（结果是什么由你定，别停在半路）；\n2. 一到两句，像自言自语；\n3. **最后一句必须交代你去干什么了**（去睡了 / 去洗澡 / 再去合成社区看一眼 之类）——这一句是"这件事到此为止"的标志，不能省；\n4. **不要**报钱数。';
/** R4 的"垫了一句"形态 —— 评测注释里**不锚行首**的理由,取 `src\story.js` 生成器的原句
 *  再垫上安静那句(合成垫句场景 是同族,但它还带（系统给的,会先撞中 R2)。 */
const QUIET_HOOK_PLAIN = '群里这会儿很安静。你没在跟谁对话,是自己过日子的间隙,顺手跟关系很近的人说一句。';
/** R2 的"垫了一句"完整形态(合成垫句场景 —— 垫句 + （系统给的,R2 先于 R4 咬中,与 dry-run 分桶一致)。 */
const QUIET_HOOK = '群里这会儿很安静。你没在跟谁对话，是自己过日子的间隙被大家撞见了。\n\n刚刚发生的事（系统给的**事实方向**，台词你自己说）：示例助手在合成广场测试装置，把纸箱推到了另一边。';
/** R5 非语言占位(合成场景)。 */
const IMAGE = '（发来一张图片，没有文字）';
const ONLY_AT = '（只 @ 了你，没有说别的）';
const FACETYPE = '<@00000000000000000000000000000001> <faceType=1,faceId="344">';

const R1 = '注入块（【记忆交接】【系统】等桥提示词）';
const R2 = '注入残文（这一轮的事实 / 本次表达要求 / 系统给的事实方向）';
const R3 = '群上下文残文（最近群里的消息）';
const R4 = '旧库桥提示词（你没在跟谁对话 / 你之前提过一件事）';
const R5 = '非语言占位（图片/表情/戳一戳/纯 @/平台标记）';

// ---------------------------------------------------------------------------
// 临时库:真 archivePass 走一遍(与生产同一写路径,不手插行)。
// ---------------------------------------------------------------------------

const SESSION = 'qqbot-c2c-RESIDUE01-g1';
const CONVERSATION = 'qqbot-c2c-RESIDUE01';

const userMsg = (seq, at, text) => ({ type: 'user/message', seq, time: at, data: { content: [{ type: 'text', text }] } });
const botMsg = (seq, at, text) => ({
  type: 'assistant/message', seq, time: at,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: {} },
});

/**
 * 一段会话:人话对照轮 + 残文轮 + "classifyKind 已判过"的轮。
 * 预期 kind 是**跑出来的现状**:HOOK/QUIET_HOOK 含 `自己过日子的间隙`/`你之前提过一件事`,
 * `classifyKind` 先判成 selflife —— 残文闸**只收"本来会当成人话"的轮次**,不抹具体 kind。
 */
function buildRecords(now) {
  const script = [
    ['帮我记住 我对花生过敏', '好，记住了：你对花生过敏。', 'mention'],
    [FISHING, '（一边把袜子挂上钩）这饵够别致的。', RESIDUE_KIND],
    [BURST, '一次说完:我是,猪。', RESIDUE_KIND],
    [IMAGE, '（图片看不清,发点文字?）', RESIDUE_KIND],
    ['群里已经安静了一会儿。你可以主动开口说一句,把气氛带起来。', '有人吗?随便聊聊嘛。', 'warmup'],
    [HOOK, '（往合成社区那边走)食堂的事还没完。', 'selflife'],
    [QUIET_HOOK, '（在城外练了一发演示装置）', 'selflife'],
  ];
  const records = [];
  let seq = 1;
  for (let i = 0; i < script.length; i += 1) {
    const at = now - (script.length - i) * 60_000;
    records.push(userMsg(seq, at, script[i][0]));
    records.push(botMsg(seq + 1, at + 1000, script[i][1]));
    seq += 2;
  }
  return { records, expect: script.map(([text, , kind], i) => ({ seq: 1 + i * 2, kind, text })) };
}

function makeTempDb(now = Date.now()) {
  const dir = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'qqbot-residue-'));
  const db = openMemory(path.join(dir, 'memory.db'));
  const { records, expect } = buildRecords(now);
  archivePass({
    db,
    files: [{ id: SESSION, file: 'selftest-residue-fixture.jsonl' }],
    readRecords: () => records,
    now,
  });
  return { dir, db, expect, now };
}

/** 造一个"存量库"形状:残文还混在 mention 里(清洗脚本要治的就是它)。 */
function makeLegacyDb(now = Date.now()) {
  const dir = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'qqbot-residue-legacy-'));
  const db = openMemory(path.join(dir, 'memory.db'));
  db.prepare(
    `INSERT INTO session (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
     VALUES (?, ?, 'c2c', 'X', 1, ?, '', 'test', 4, ?)`,
  ).run(SESSION, CONVERSATION, now - 3600_000, now);
  const ins = db.prepare('INSERT INTO turn (session_id, seq, at, kind, user_text) VALUES (?, ?, ?, ?, ?)');
  ins.run(SESSION, 2, now - 4000, 'mention', '帮我记住 我对花生过敏');
  ins.run(SESSION, 4, now - 3000, 'mention', FISHING);
  ins.run(SESSION, 6, now - 2000, 'mention', HOOK);
  ins.run(SESSION, 8, now - 1000, 'mention', IMAGE);
  return { dir, db, file: path.join(dir, 'memory.db'), now };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
}

const kindInDb = (db, seq) => String(
  db.prepare('SELECT kind FROM turn WHERE session_id = ? AND seq = ?').get(SESSION, seq)?.kind ?? '',
);

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

export function registerResidueTests({ test, assert }) {
  test('残文规则:5 条逐条形状(合成正文)与 first-match 顺序', () => {
    // 评测报告的分桶名 = 这些 label,顺序与 eval 原版逐字一致(搬进来时没动一个字)。
    assert.deepEqual(
      RESIDUE_RULES.map((rule) => rule.label),
      [R1, R2, R3, R4, R5],
    );
    assert.equal(isArchiveResidue(FISHING), R1, '【系统】钓鱼(合成钓鱼场景)');
    assert.equal(isArchiveResidue(MORNING), R1, '早安排程(合成早安场景)');
    assert.equal(isArchiveResidue(BURST), R2, '连发合并块(合成连发场景)');
    assert.equal(isArchiveResidue(SELFLIFE_HOOK), R2, '自发钩子带（系统结算(合成自发场景)');
    assert.equal(isArchiveResidue(QUIET_HOOK), R2, '垫句 + （系统给的:R2 先于 R4 咬中(合成垫句场景,与 dry-run 分桶一致)');
    assert.equal(isArchiveResidue(GROUP_CONTEXT), R3, '群上下文首行(生成器代码常量;现库 0 行)');
    assert.equal(isArchiveResidue(HOOK), R4, '钩子开场(合成钩子场景)');
    assert.equal(isArchiveResidue(QUIET_HOOK_PLAIN), R4, '垫了一句、没带括号块的形态,不锚行首也能咬(story.js 原句)');
    assert.equal(isArchiveResidue(IMAGE), R5, '图片占位(整句,合成图片场景)');
    assert.equal(isArchiveResidue(ONLY_AT), R5, '纯 @ 占位(整句,合成纯@场景)');
    assert.equal(isArchiveResidue(FACETYPE), R5, '<faceType= 平台标记(合成平台标记)');
    // first-match:整块(R1)优先于块残文(R2) —— 与评测同序。
    assert.equal(isArchiveResidue('【系统】播报账本\n（下面是你刚才连着的 2 条消息'), R1);
  });

  test('反咬:普通消息含关键词片段不被标(误伤纪律)', () => {
    const no = (text, why) => assert.equal(isArchiveResidue(text), null, why);
    no('这一轮的事实性发言就到这里', '裸关键词「这一轮的事实」没有全角括号块,不咬');
    no('我把最近群里的消息都翻了一遍', '裸关键词「最近群里的消息」没有「（供你参考」,不咬');
    no('群里这会儿很安静,就我们俩', '评测里那句"垫了一句"的**前半句**单独出现是人话,不咬');
    no('（发来一张图片，没有文字）这句是转述', '占位符判据锚 ^…$ 整句,拼进人话就不咬');
    no('我记得你之前提过一些事', '「提过一些事」≠「提过一件事」,不咬');
    no('看看这个【梗】真好笑', '【 必须在开头才像桥的提示块,中间出现是人话');
    no('我没在跟谁说话呀', '「没在跟谁」≠桥的原句「你没在跟谁对话」,不咬');
    no('帮我记住 我对花生过敏', '正常人话轮(判据 ⑤ 的对照轮)必须零命中');
    // 已接受的取舍(评测侧 2026-10-18 起):有人**逐字**打出桥的整句会被标 ——
    // 闸跟评测同一份宽严,不在这里偷偷放宽(放宽 = 写第二份判据,D159)。
    assert.equal(isArchiveResidue('你之前提过一件事：昨天说的那家店'), R4);
  });

  test('归档写路径:残文轮 kind=residue 落库;具体 kind 不被抹;MEMORY_VERSION 未动', () => {
    assert.ok(NON_MEMORY_KINDS.includes(RESIDUE_KIND), 'residue 要在排除清单里(检索/固化一路的闸)');
    const { dir, db, expect } = makeTempDb();
    try {
      for (const row of expect) {
        assert.equal(kindInDb(db, row.seq), row.kind, `seq=${row.seq}(${row.text.slice(0, 12)}…) 应为 kind=${row.kind}`);
      }
      // 残文轮不产生标签(与 tagsForTurn 的 isHumanTurn 同一道闸)。
      for (const row of expect.filter((item) => item.kind === RESIDUE_KIND)) {
        assert.deepEqual(tagsOfTurn(db, SESSION, row.seq), [], `残文轮 seq=${row.seq} 不该有标签`);
      }
      // 纪律:这次**不**推库版本(旧行由清洗脚本治,不重导)。
      assert.equal(MEMORY_VERSION, 6, '残文闸不该动 MEMORY_VERSION(kind 是 TEXT 列)');
    } finally {
      db.close();
      cleanup(dir);
    }
  });

  test('candidatesFor 取不到残文轮(标签路 + 语义路)', () => {
    const { dir, db, expect, now } = makeTempDb();
    try {
      const control = `${SESSION}#${expect[0].seq}`;
      const residueSeqs = expect.filter((item) => item.kind === RESIDUE_KIND).map((item) => item.seq);
      // 直插标签(绕开 tagsForTurn,专门证 SQL 那道 kind 闸,与标签规则无关)。
      const ins = db.prepare("INSERT OR IGNORE INTO memory_tag (session_id, seq, tag, source, created_at) VALUES (?, ?, 'food', 'test', ?)");
      ins.run(SESSION, expect[0].seq, now);
      ins.run(SESSION, residueSeqs[0], now);
      const tagged = candidatesFor(db, { conversation: CONVERSATION, tags: ['food'] });
      assert.ok(tagged.some((item) => item.id === control), '对照轮(人话)照旧进候选');
      assert.equal(tagged.some((item) => item.id === `${SESSION}#${residueSeqs[0]}`), false, '带标签的残文轮也不进候选');
      // 语义路(不要标签交集的那条)同样被 kind 挡住。
      for (const seq of [expect[0].seq, ...residueSeqs]) {
        saveEmbedding(db, { source: `${SESSION}#${seq}`, vector: [0.2, 0.4, 0.6], model: 'probe-model', now });
      }
      const semantic = candidatesFor(db, {
        conversation: CONVERSATION, tags: [], semanticOnly: true, embeddingModel: 'probe-model', olderThan: now - 60_000,
      });
      assert.ok(semantic.some((item) => item.id === control), '语义路的对照轮照旧进候选');
      for (const seq of residueSeqs) {
        assert.equal(semantic.some((item) => item.id === `${SESSION}#${seq}`), false, `语义路不给残文行(seq=${seq})`);
      }
    } finally {
      db.close();
      cleanup(dir);
    }
  });

  test('consolidate 不吃残文轮(对照:人话轮照旧固化)', () => {
    const base = Date.now();
    const { dir, db, expect, now } = makeTempDb(base);
    try {
      const result = consolidate(db, { now: now + 1000 });
      const sources = new Set(db.prepare('SELECT source FROM note').all().map((row) => String(row.source)));
      for (const row of expect.filter((item) => item.kind === RESIDUE_KIND)) {
        assert.equal(sources.has(`${SESSION}#${row.seq}`), false, `残文轮 seq=${row.seq} 不许固化`);
      }
      assert.equal(sources.has(`${SESSION}#${expect[0].seq}`), true, '对照人话轮照旧固化(证明闸是选择性的)');
      assert.ok(result.scanned >= 1, `扫到了候选(实际 ${result.scanned})`);
    } finally {
      db.close();
      cleanup(dir);
    }
  });

  test('摘要/交接取样口(conversationMemory)不给残文行', () => {
    const { dir, db, expect } = makeTempDb();
    try {
      const memory = conversationMemory(db, CONVERSATION, 50);
      const ids = new Set(memory.rows.map((row) => `${row.session_id}#${row.seq}`));
      for (const row of expect.filter((item) => item.kind === RESIDUE_KIND)) {
        assert.equal(ids.has(`${SESSION}#${row.seq}`), false, `残文轮 seq=${row.seq} 不进摘要取样`);
      }
      assert.equal(ids.has(`${SESSION}#${expect[0].seq}`), true, '对照轮照旧进取样');
      // selflife 轮不是这次闸的对象(现状:取样口只挡 announce/isInjectedBlock/residue,
      // selflife 是 D176 之前就有的行为,这里钉住**不偷偷改变它**)。
      assert.equal(ids.has(`${SESSION}#${expect[5].seq}`), true, 'selflife 轮进取样口是**现状**,不由这次改动偷偷变');
    } finally {
      db.close();
      cleanup(dir);
    }
  });

  test('评测与闸是同一份判据:eval 已 import,不再有第二份规则表', () => {
    const evalFile = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'eval-memory-recall.mjs'),
      'utf8',
    );
    assert.match(
      evalFile,
      /import\s*\{[^}]*RESIDUE_RULES[^}]*\}\s*from\s*'\.\.\/src\/memory-archive\.js'/,
      'eval 必须从 src import 规则(D159)',
    );
    assert.doesNotMatch(evalFile, /const\s+RESIDUE_RULES\s*=/, 'eval 里不许再 declare 第二份规则表');
    assert.match(evalFile, /function turnRejectReason/, '剔除入口还在(报告分桶靠它)');
    // 与评测的 bucket 逻辑做**同输入同输出**对照:残文桶名必须逐字等于 isArchiveResidue
    // 的返回(同一份规则表跑出来的,想漂都没得漂)。
    const fixtures = [FISHING, MORNING, BURST, SELFLIFE_HOOK, GROUP_CONTEXT, HOOK, QUIET_HOOK, QUIET_HOOK_PLAIN, IMAGE, ONLY_AT, FACETYPE];
    for (const text of fixtures) {
      let bucket = null;
      for (const rule of RESIDUE_RULES) {
        if (rule.test(text)) { bucket = rule.label; break; }
      }
      assert.equal(bucket, isArchiveResidue(text), '评测分桶 === 闸返回值');
    }
    // 工具会话的判据同源(评测先判 kind/tool 再看规则;闸只管文本这一层)。
    assert.equal(isToolConversation('qqbot-summary-x'), true);
    assert.ok(cleanMemoryText(IMAGE) !== '', '占位行不是空正文 —— 剔它靠的是规则,不是长度');
  });

  test('清洗脚本真跑:预演出数 → --apply 改 kind(行数不变)→ 再跑幂等', () => {
    const base = Date.now();
    const { dir, db, file, now } = makeLegacyDb(base);
    try {
      db.close();
      const run = (args) => spawnSync(process.execPath, [
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'clean-archive-residue.mjs'),
        '--db', file, ...args,
      ], { encoding: 'utf8', cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..') });
      // ① 预演:3 行待标(HOOK 在存量库里是 mention —— 清洗治的就是这种旧行)。
      const dry = run([]);
      assert.equal(dry.status, 0, `预演退出码 0(实际 ${dry.status}:${dry.stderr})`);
      assert.match(dry.stdout, /将标记 3/, '预演数出 3 行残文');
      assert.match(dry.stdout, /旧库桥提示词（你没在跟谁对话 \/ 你之前提过一件事）: 1/, '按规则的分布里 R4 有 1 行');
      // ② apply:改 kind,不删行。
      const applyRun = run(['--apply']);
      assert.equal(applyRun.status, 0, `apply 退出码 0(实际 ${applyRun.status}:${applyRun.stderr})`);
      assert.match(applyRun.stdout, /已备份:/, 'apply 先 VACUUM INTO 备份');
      assert.match(applyRun.stdout, /已标记:3 行/, 'apply 标了 3 行');
      const check = openMemory(file);
      try {
        assert.equal(check.prepare('SELECT COUNT(*) n FROM turn').get().n, 4, '账本 4 行一条不少(不物理删)');
        assert.equal(
          check.prepare("SELECT COUNT(*) n FROM turn WHERE kind = 'mention'").get().n, 1,
          '只剩人话对照轮还是 mention',
        );
        assert.equal(
          check.prepare("SELECT COUNT(*) n FROM turn WHERE kind = 'residue'").get().n, 3,
          '3 行残文已标 residue',
        );
      } finally {
        check.close();
      }
      // ③ 幂等:再跑一遍,预演 0、apply 0。
      const dry2 = run([]);
      assert.match(dry2.stdout, /将标记 0/, '再预演:0 行(已标的不重标)');
      const apply2 = run(['--apply']);
      assert.equal(apply2.status, 0);
      assert.match(apply2.stdout, /已标记:0 行/, '再 apply:0 行(幂等)');
    } finally {
      cleanup(dir);
    }
  });
}

// ---------------------------------------------------------------------------
// 单独跑:`node scripts\selftest-residue.js`
// ---------------------------------------------------------------------------

async function runStandalone() {
  const assert = (await import('node:assert/strict')).default;
  const cases = [];
  registerResidueTests({ test: (name, fn) => cases.push([name, fn]), assert });
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      process.stdout.write(`✓ ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`✗ ${name}\n  ${err?.message ?? err}\n`);
    }
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = fileURLToPath(import.meta.url).toLowerCase();
if (invoked === self) await runStandalone();
