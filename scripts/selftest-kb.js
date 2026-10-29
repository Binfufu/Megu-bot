/**
 * **知识库接线**(W3 / P2-B,2026-10-22)回归判据。
 *
 * 背景:doc/doc_chunk 两张表(D95)一直是空库 —— `makeKnowledgeProvider` 做好了却没接进
 * QQ 消息路。本批做三件事:① `kb` kind 进 INJECT_KINDS;② memory.kb 配置块(默认关,
 * env `QQBOT_MEMORY_KB`);③ turnNotes 消息路径接线(命中才注入,预算独立 ≤300 字)。
 * 摄入路径沿用 D95 的 `scripts\kb-import.js`(默认 dry-run / --write 幂等覆盖 /
 * QQBOT_MEMORY_DB 逃生口),判据里**真跑它**(临时库)。
 *
 * ⚠️ 本文件**不注册进 scripts\selftest.js**(并行冲突,lead 统一注册)。
 *    单跑:node scripts\selftest-kb.js —— 文件自带 runner,退出码 0/1。
 *    同时导出 registerKbTests({ test, assert }),形状与 selftest-insights.js 一致,
 *    lead 注册时一行接上。
 *
 * 覆盖(判据 ↔ 纪律):
 *   ① 导入切块:真跑 kb-import.js —— 默认 dry-run **零写入**;--write 后 doc/doc_chunk
 *      成行(标题/空行切块,heading 进库);同 slug+edition 再写 = 覆盖不翻倍。
 *   ② 检索命中注入:makeKnowledgeProvider 命中 → 头行口径(原作经历 / 不是你们之间的
 *      经历,D95)、≤maxChunks、≤预算 300 字、过 wrapInject('kb')。
 *   ③ 未命中零注入:无交集 query → text === ''(消费端不拼任何东西);同一 query
 *      带**假向量**命中(向量路端到端;导入时向量留空,回填后才生效 —— kb-import 的说明)。
 *   ④ wrapInject 剥壳归零:stripInjectMarks 后知识库正文一字不剩、人话保留、换行不删行。
 *   ⑤ enabled 闸:config 默认关(QQBOT_MEMORY_KB 缺省 / =0 / =1),budgetChars/maxChunks
 *      默认值;turnNotes **消费端**切片(vm,照 selftest-longterm-consumption 的形状)——
 *      关 = kbNote 一次不调、notes 无 kb 标记;开 = 注入块到达 notes。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { INJECT_KINDS, wrapInject, stripInjectMarks } from '../src/inject-mark.js';
import { importDoc, knowledgeSource, knowledgeStats, libraryDocs, makeKnowledgeProvider, openMemory, saveEmbedding } from '../src/memory-store.js';
import { detectEncyclopedia, ENCYCLOPEDIA_NOTE } from '../src/kb.js';
import { DIRECT_RESPONSE_NOTES } from '../src/style.js';

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 判据用资料:两个小标题 × 各两段(切块要能分出 ≥2 块,heading 进库)。 */
const KB_DOC = [
  '# 合成小镇的街道',
  '',
  '合成小镇是新手合成探访者聚集的边陲小镇,大宅邸立在镇子中央,合成探访者学校的大门总为新人敞开。',
  '',
  '她第一次走进合成小镇的学校时,接下了讨伐纸箱的委托;管家还给她指过路:出了西门一直走,沼泽里全是纸箱。',
  '',
  '# 初到学校',
  '',
  '学校的接待员给了她第一份委托单。她说要成为最强的制图员,于是所有人都记住了这个名字。',
].join('\n');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(path.resolve(BRIDGE_ROOT, '..'), `qqbot-kb-${tag}-`));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
/** 真跑 scripts\kb-import.js(临时库走 QQBOT_MEMORY_DB 逃生口 —— 与生产同一个入口)。 */
function runKbImport(dbFile, extraArgs) {
  return spawnSync(process.execPath, ['scripts/kb-import.js', ...extraArgs], {
    cwd: BRIDGE_ROOT,
    env: { ...process.env, QQBOT_MEMORY_DB: dbFile },
    encoding: 'utf8',
  });
}

export function registerKbTests({ test, assert: rawAssert }) {
  const a = rawAssert || assert;

  test('导入切块:kb-import 默认 dry-run 零写入;--write 后 doc/doc_chunk 成行;同键再写=覆盖不翻倍', () => {
    const dir = tempDir('import');
    try {
      const dbFile = path.join(dir, 'memory.db');
      // kb-import 只往**已存在**的库写(它不建库)—— 先用 openMemory 造一个空库再交给它。
      const seed = openMemory(dbFile);
      seed.close();
      const docFile = path.join(dir, '资料.md');
      fs.writeFileSync(docFile, KB_DOC, 'utf8');
      const args = ['--slug', 'kb-selftest', '--edition', '试炼篇', '--file', docFile,
        '--title', '判据用资料', '--source', 'selftest-kb', '--license', '仅本机合成夹具', '--bot', 'fixture-kb-bot'];

      // ① 默认 = dry-run:进程成功,**一行都不写**(先看再写的习惯,profile-scan 同款)。
      const dry = runKbImport(dbFile, args);
      a.equal(dry.status, 0, `dry-run 要成功:${dry.stderr}`);
      a.ok(dry.stdout.includes('只预览'), `要明说这是预览:${dry.stdout.split('\n')[0]}`);
      const dryDb = openMemory(dbFile);
      try {
        a.equal(knowledgeStats(dryDb).docs, 0, 'dry-run 不许写 doc');
        a.equal(knowledgeStats(dryDb).chunks, 0, 'dry-run 不许写 doc_chunk');
      } finally {
        dryDb.close();
      }

      // ② --write:成行,heading/chars 与切块结果一致(检索库里存的是**成品**)。
      const write = runKbImport(dbFile, [...args, '--write']);
      a.equal(write.status, 0, `写入要成功:${write.stderr}`);
      a.ok(write.stdout.includes('已写入'), '要报"已写入"');
      const db = openMemory(dbFile);
      try {
        const stats = knowledgeStats(db);
        a.equal(stats.docs, 1, '一份资料');
        a.ok(stats.chunks >= 2, `标题+空行要切出 ≥2 块(拿到 ${stats.chunks})`);
        a.equal(stats.vectors, 0, '导入时**向量留空**(补算走 embed-backfill,kb-import 会提示)');
        const doc = libraryDocs(db)[0];
        a.equal(doc.slug, 'kb-selftest');
        a.equal(doc.edition, '试炼篇');
        a.equal(doc.title, '判据用资料');
        const chunks = db.prepare(
          'SELECT seq, heading, text, chars FROM doc_chunk WHERE doc_id = ? ORDER BY seq',
        ).all(doc.id);
        a.equal(chunks.length, stats.chunks);
        a.ok(chunks.every((row) => row.chars > 0 && String(row.text).trim() !== ''), '每块都有正文');
        a.equal(chunks.reduce((sum, row) => sum + row.chars, 0), doc.chars, '块字数总和 = doc.chars');
        a.equal(chunks[0].heading, '合成小镇的街道', '小标题要进 heading(它是检索线索)');

        // ③ 幂等:同 slug+edition 再写 = 覆盖(不翻倍)。
        const again = runKbImport(dbFile, [...args, '--write']);
        a.equal(again.status, 0);
        a.ok(again.stdout.includes('覆盖'), `要报覆盖:${again.stdout.split('\n').at(-2) ?? ''}`);
        a.equal(knowledgeStats(db).docs, 1, '覆盖不会变成两份');
        a.equal(libraryDocs(db)[0].chunks, chunks.length, '块数一致(整份替换)');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('检索命中注入:makeKnowledgeProvider 命中 → D95 口径头行、条数与预算都封顶、过 wrapInject("kb")', () => {
    const dir = tempDir('recall');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        importDoc(db, { slug: 'kb-selftest', edition: '试炼篇', text: KB_DOC });
        // 生产同款参数(config 默认:budgetChars 300 / maxChunks 2)。
        const provider = makeKnowledgeProvider({ db, budget: 300, limit: 2 });
        const hit = provider({ conversation: 'qqbot-c2c-KBSELF', query: '合成小镇学校是个什么地方' });
        a.ok(hit.text !== '', '有交集就要端出来');
        a.ok(hit.text.includes('原作经历'), '头一行要是口径(她在原作经历过,D95)');
        a.ok(hit.text.includes('不是你们之间的经历'), '必须挡住"把原作伙伴说成你们"(C 档最糟的错)');
        a.ok(hit.picked.length >= 1 && hit.picked.length <= 2, `条数封顶 maxChunks=2(拿到 ${hit.picked.length})`);
        a.ok(hit.text.length <= 300, `预算 300 是硬上限,实际 ${hit.text.length}`);
        a.ok(hit.text.includes('合成小镇'), '命中的内容要真的在注入文本里');
        // 注入端自报家门:kind `kb` 已登记,包出来的开标记要对。
        const wrapped = wrapInject('kb', hit.text);
        a.ok(wrapped.startsWith('[[bridge-inject kb]]'), '自报家门的开标记(kind=kb)');
        a.ok(wrapped.endsWith('[[/bridge-inject]]'), '闭标记固定');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('未命中零注入;同一个 query 回填向量后语义命中(导入留空 → 回填生效,端到端)', () => {
    const dir = tempDir('miss');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        const imported = importDoc(db, { slug: 'kb-selftest', edition: '试炼篇', text: KB_DOC });
        const provider = makeKnowledgeProvider({ db, budget: 300, limit: 2 });
        const missQuery = '帮我算一下这个积分';

        // ① 无向量 + 无标签交集 → **一个字都不加**(消费端拿到空串就不拼)。
        const miss = provider({ conversation: 'qqbot-c2c-KBSELF', query: missQuery });
        a.equal(miss.text, '', '没命中一字不加');
        a.equal(miss.picked.length, 0);

        // ② 向量留空是导入时的**设计**(kb.js/memory-store D95:共用 embedding 表,
        //    source = doc:<id>#<seq>,由 embed-backfill 补算)。回填前语义路必须沉默:
        const before = provider({ conversation: 'qqbot-c2c-KBSELF', query: missQuery, semantic: { vector: [1, 0, 0] } });
        a.equal(before.text, '', '候选没向量时语义路不命中');

        // ③ 假装 embed-backfill 跑过:给第 1 块补上向量 → 同一个 query 靠语义命中。
        saveEmbedding(db, { source: knowledgeSource(imported.docId, 1), vector: [1, 0, 0], model: 'selftest' });
        const after = provider({ conversation: 'qqbot-c2c-KBSELF', query: missQuery, semantic: { vector: [1, 0, 0] } });
        a.ok(after.text !== '', '回填后语义命中要注入');
        a.ok(after.picked.every((row) => String(row.id).startsWith('doc:')), '端出来的必须是知识块(doc:<id>#<seq>)');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('wrapInject 剥壳归零:归档读路径剥完,知识库正文一字不剩、人话保留、换行不删行', () => {
    a.ok(INJECT_KINDS.includes('kb'), 'INJECT_KINDS 要登记 kb(真 import,不扫字面)');
    a.throws(() => wrapInject('没有登记的kind', 'x'), '没登记的 kind 要当场抛(防手滑)');
    const dir = tempDir('strip');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        importDoc(db, { slug: 'kb-selftest', edition: '试炼篇', text: KB_DOC });
        const provider = makeKnowledgeProvider({ db, budget: 300, limit: 2 });
        const hit = provider({ conversation: 'qqbot-c2c-KBSELF', query: '合成小镇学校是个什么地方' });
        a.ok(hit.text !== '', '前置:命中才谈剥壳');
        const wrapped = wrapInject('kb', hit.text);
        const stripped = stripInjectMarks(`前一行人话\n${wrapped}\n后一行人话`);
        a.equal(stripped.includes('原作经历'), false, '口径头行不剩');
        a.equal(stripped.includes('合成小镇'), false, '知识库正文一字不剩');
        a.equal(stripped.includes('大宅邸'), false, '命中内容也不剩');
        a.equal(stripped.split('\n').length, 3, '换行不删行:整块换成一个空行');
        a.ok(stripped.includes('前一行人话') && stripped.includes('后一行人话'), '人话原样保留');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('enabled 闸:config 默认关(QQBOT_MEMORY_KB 缺省/=0/=1),turnNotes 消费端关=一次不调、开=块到达', async () => {
    // ── ① config 层:真读 loadConfig，仅使用同卷临时完整假配置，不读真实 .env。
    const configRoot = tempDir('config');
    const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('QQ_') || key.startsWith('QQBOT_')));
    fs.writeFileSync(path.join(configRoot, 'fixture.env'), 'QQ_APP_ID=fixture-app\nQQ_CLIENT_SECRET=fixture-secret\nQQBOT_LLM_KEY=fixture-key\nQQBOT_WORKSPACE=workspace\n');
    try {
      for (const key of Object.keys(savedEnv)) delete process.env[key];
      process.env.QQBOT_ENV_FILE = 'fixture.env';
      const off = loadConfig({ rootDir: configRoot });
      a.equal(off.policy.memory.kb.enabled, false, '**默认关**(库还没内容,默认开=空转)');
      a.equal(off.policy.memory.kb.budgetChars, 600, '预算默认 600(D95 §八「照长期记忆处理」;300 装不下 ≥210 字的块,D297)');
      a.equal(off.policy.memory.kb.maxChunks, 2, '条数默认 2');
      process.env.QQBOT_MEMORY_KB = '0';
      a.equal(loadConfig({ rootDir: configRoot }).policy.memory.kb.enabled, false, 'QQBOT_MEMORY_KB=0 = 关(回滚开关)');
      process.env.QQBOT_MEMORY_KB = '1';
      a.equal(loadConfig({ rootDir: configRoot }).policy.memory.kb.enabled, true, 'QQBOT_MEMORY_KB=1 = 开');
    } finally {
      for (const key of Object.keys(process.env)) if (key.startsWith('QQ_') || key.startsWith('QQBOT_')) delete process.env[key];
      Object.assign(process.env, savedEnv);
      cleanup(configRoot);
    }
    // 配置块与注入标记在源码里各就各位(照 selftest-insights 的 wiring 判据形状,防漏接)。
    const indexSource = fs.readFileSync(path.join(BRIDGE_ROOT, 'src', 'index.js'), 'utf8');
    a.match(indexSource, /wrapInject\('kb', ency \? /, '注入端要过 wrapInject("kb")(百科模式在块内附说明要求)');
    a.match(indexSource, /memoryCfg\.kb\?\.enabled && memoryDb && typeof kbNote === 'function'/, '消息路径要有回滚开关');
    a.match(indexSource, /detectEncyclopedia\(query\)/, '百科模式(D297):意图判定要接在 kbNote 内');
    a.match(indexSource, /ENCYCLOPEDIA_NOTE/, '百科说明要求常量要被注入端引用');
    const configSource = fs.readFileSync(path.join(BRIDGE_ROOT, 'src', 'config.js'), 'utf8');
    a.match(configSource, /asBool\('QQBOT_MEMORY_KB', false\)/, '开关默认关');
    a.match(configSource, /asBool\('QQBOT_MEMORY_KB_ENCY', true\)/, '百科模式独立回滚开关(默认开,套在 kb 总闸里)');

    // ── ② 消费端:真切 turnNotes 进 vm 沙箱(判据钉"notes 里到没到",不是钉"代码里写过")。
    const source = indexSource;
    const begin = source.indexOf('  async function turnNotes(');
    const end = source.indexOf('\n  /**', begin);
    a.ok(begin >= 0 && end > begin, '切片要切得准');
    const makeSandbox = (kbEnabled, kbNote) => {
      const calls = [];
      const run = vm.runInNewContext(`${source.slice(begin, end)}\nturnNotes`, {
        DIRECT_RESPONSE_NOTES,
        config: { policy: { stats: { enabled: false }, growth: { enabled: false }, seriousGuard: true } },
        pendingStoryFor: () => null,
        companyTurnNote: () => null,
        affinityNote: () => 'affinity-control',
        describeFishingScene: () => null,
        readFishing: () => null,
        panelPromptNote: () => null,
        describeLedgerForPrompt: () => null,
        conversationKeyFor: () => 'kb-sandbox-key',
        longTermNote: async () => null,
        claimNote: () => null,
        turnPolicyFor: () => ({ note: null, suppressMood: true, suppressNudges: true }),
        moodNotes: () => [],
        nextNudges: () => [],
        renderInsights: () => '',
        wrapInject,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        memoryCfg: {
          kb: { enabled: kbEnabled, budgetChars: 300, maxChunks: 2 },
          insights: { enabled: false },
        },
        // ⚠️ 两只沙箱都给**真值** memoryDb:关的那只唯一挡住它的就是 kb.enabled=false ——
        //    否则 memoryDb=null 也能挡,"enabled 闸"这条判据就没咬到它要咬的东西。
        memoryDb: {},
        kbNote: (recall) => { calls.push(recall); return kbNote(recall); },
      });
      return { run, calls };
    };
    const message = { content: '合成小镇的剧情后来怎么样了', senderId: 'sandbox-user' };
    // 关:kbNote **一次都不调**,notes 里没有 kb 标记(enabled=0 行为一字不变)。
    const offBox = makeSandbox(false, () => { throw new Error('关着还调 kbNote 就是漏了闸'); });
    const offNotes = await offBox.run(null, message, [], null);
    a.equal(offBox.calls.length, 0, '配置关 = 不检索、不调 kbNote');
    a.equal(offNotes.some((note) => String(note).includes('[[bridge-inject kb')), false, 'notes 里不许出现 kb 块');
    // 开:块**真的到达 notes**,而且 recall 从消息推出来(query = 说的那句话)。
    const onBox = makeSandbox(true, () => wrapInject('kb', '知识库判据指纹'));
    const onNotes = await onBox.run(null, message, [], null);
    a.equal(onBox.calls.length, 1, '开着且命中路径要调一次 kbNote');
    a.equal(onBox.calls[0]?.query, message.content, '检索 query = 这一轮那句话');
    a.equal(onBox.calls[0]?.conversation, 'kb-sandbox-key', '重复抑制记账按会话');
    a.ok(onNotes.some((note) => String(note).includes('[[bridge-inject kb]]') && String(note).includes('知识库判据指纹')),
      '知识块要真的到达本轮 notes(消费端见货)');
  });

  test('百科模式(D297):意图词表正反例;说明要求只随命中块进注入;剥壳后一字不剩', () => {
    // ── ① 纯函数:正例/反例(「为什么」泛,但它只影响回答形状,不新增触发路)。
    a.equal(detectEncyclopedia('细说一下合成条例'), true, '「细说」→ 百科模式');
    a.equal(detectEncyclopedia('为什么合成助手是向导'), true, '「为什么」→ 百科模式');
    a.equal(detectEncyclopedia('合成工具是什么'), true, '「是什么」→ 百科模式');
    a.equal(detectEncyclopedia('  百科：合成地区  '), true, '首尾空白不影响');
    a.equal(detectEncyclopedia('今天好热啊'), false, '闲聊不进百科模式');
    a.equal(detectEncyclopedia('在吗'), false, '打招呼不算求知识');
    a.equal(detectEncyclopedia(''), false, '空串不算');
    a.equal(detectEncyclopedia(null), false, '非字符串不算');
    // ── ② 组装形状:指令只加在命中块内部;剥壳归零判据对它同样成立(不漏进归档/记忆)。
    const plain = '【原作经历】以下是**她自己在原作故事里经历过**的：\n· 〔合成工具〕合成联系人把合成工具交给了她。';
    const withNote = `${plain}\n${ENCYCLOPEDIA_NOTE}`;
    a.ok(withNote.includes('【科普模式】') && withNote.includes('约 100 字'), '说明要求要点名回答形状(约100字/先给结论)');
    a.equal(stripInjectMarks(wrapInject('kb', withNote)).includes('科普模式'), false, '剥壳后指令一字不剩(不漏进她的记忆)');
    a.equal(stripInjectMarks(wrapInject('kb', plain)).includes('科普模式'), false, '没触发时块里没有指令');
  });
}

// ── 独立 runner:lead 统一注册进 selftest.js 之前,单跑本文件也必须全绿。 ──
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });
  registerKbTests({ test, assert });
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`  ok  ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL  ${name}\n      ${String(err?.stack ?? err).split('\n').join('\n      ')}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
