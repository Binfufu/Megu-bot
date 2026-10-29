/**
 * **任务口径**(P1,2026-10-28)回归。
 *
 * 要治的形状:角色卡的两句限制 + 情绪字数上限 + 随机"只回很短/先问清楚/游戏式解释"
 * 一起把"办事"挤没了;而唯一的例外(科普模式)还绑在知识库命中上。
 *
 * 判据分四组:
 *   · 判定矩阵:闲聊不许被误判成任务(误判只是"可以多说",但也要少误判);
 *   · 权限矩阵:task/knowledge 必须**关掉**字数、随机风格、固定口语要求,并要求保真;
 *   · 与严肃话题的正交:知识题不许被"短而真诚地安慰"顶掉;
 *   · wiring:index.js 真接线了,kb 的"不要列点"矛盾真的消掉了(扫源码)。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DIRECT_RESPONSE_NOTES } from '../src/style.js';
import { ENCYCLOPEDIA_NOTE } from '../src/kb.js';
import {
  TURN_MODES,
  composeModeNote,
  detectTurnMode,
  groupLinesForDelivery,
  noteGatesFor,
  outputPolicyFor,
} from '../src/turn-policy.js';

export function registerTurnPolicyTests({ test, assert }) {
  test('口径判定:闲聊仍是闲聊，办事/求知被认出，带结构的输入按任务', () => {
    const chat = ['今天好累啊', '在吗', '你为什么这样啊', '今天也辛苦了', '来两张甘雨美图', '哈哈哈'];
    for (const text of chat) {
      assert.equal(detectTurnMode(text).mode, 'chat', `闲聊不许被改成任务:${text}`);
    }
    const task = [
      '帮我看看这个任务要怎么做',
      '帮我分析线程池死锁，给复现和修复步骤',
      '给我列个这周的计划',
      '报错 401 Unauthorized 怎么解决',
      '```python\nprint(1)\n```',
      '把这个 JSON 改成数组：{"a":1}',
    ];
    for (const text of task) {
      assert.equal(detectTurnMode(text).mode, 'task', `该按任务办:${text}`);
    }
    const knowledge = [
      '左边的是牛奶，右边的是咖啡浓缩液。两个混合起来是什么',
      '解释一下癌症筛查原理',
      '程序走了哪个分支？',
      '有什么区别',
    ];
    for (const text of knowledge) {
      assert.equal(detectTurnMode(text).mode, 'knowledge', `该按求知答:${text}`);
    }
    // 认不出 = 维持现状(失败的默认必须是 chat,不许强行改口吻)。
    assert.equal(detectTurnMode('').mode, 'chat');
    assert.equal(detectTurnMode(null).mode, 'chat');
    assert.equal(detectTurnMode('嗯').reason, 'default');
    assert.deepEqual([...TURN_MODES], ['chat', 'task', 'knowledge']);
  });

  test('追问继承:上一轮在办事/讲知识，「第二步呢」不许被拉回闲聊', () => {
    assert.equal(detectTurnMode('第二步呢', { previous: 'task' }).mode, 'task');
    assert.equal(detectTurnMode('然后呢', { previous: 'knowledge' }).mode, 'knowledge');
    assert.equal(detectTurnMode('详细点', { previous: 'task' }).followUp, true);
    // 上一轮是闲聊就不继承(不许凭空造任务)。
    assert.equal(detectTurnMode('第二步呢', { previous: 'chat' }).mode, 'chat');
    // 上一轮值非法时按 chat 处理,不猜。
    assert.equal(detectTurnMode('然后呢', { previous: 'bogus' }).mode, 'chat');
  });

  test('权限矩阵:聊天照旧；任务/求知关掉字数、随机风格、固定口语要求并要求保真', () => {
    const chat = outputPolicyFor('chat');
    assert.deepEqual(
      [chat.allowMoodLength, chat.allowRandomNudges, chat.allowStandingNotes, chat.preserveFormatting],
      [true, true, true, false],
    );
    for (const mode of ['task', 'knowledge']) {
      const policy = outputPolicyFor(mode);
      assert.equal(policy.allowMoodLength, false, `${mode}:不许再注入字数上限`);
      assert.equal(policy.allowRandomNudges, false, `${mode}:不许再抽"只回很短/先问清楚/游戏式解释"`);
      assert.equal(policy.allowStandingNotes, false, `${mode}:不许再要求不用标点/不总结`);
      assert.equal(policy.preserveFormatting, true, `${mode}:交付必须保真`);
      assert.equal(policy.allowStructured, true);
    }
    // 未知 mode 退回 chat(不抛、不放宽)。
    assert.equal(outputPolicyFor('bogus').mode, 'chat');
  });

  test('口径说明只给权限、不给指标；闲聊一个字都不加', () => {
    assert.equal(composeModeNote('chat'), null);
    for (const mode of ['task', 'knowledge']) {
      const note = composeModeNote(mode);
      assert.ok(typeof note === 'string' && note.length > 0);
      // 反证形状:一旦写成"不超过 N 字/句"就又变成模板(D22 同族)。
      assert.doesNotMatch(note, /不超过\s*\d+\s*(字|句)/, `${mode}:说明里不许出现字数/句数指标`);
      assert.doesNotMatch(note, /\d+\s*条以内/, `${mode}:不许出现条数指标`);
      assert.match(note, /不要念出来/, '这是给模型的私有要求,不许念出来');
    }
    assert.match(composeModeNote('task'), /不受角色卡里「不超过两句话」「不列点」/);
    assert.match(composeModeNote('knowledge'), /不要编/);
  });

  test('与严肃话题正交:知识题不被"短而真诚地安慰"顶掉，真正的闲聊安慰照旧', () => {
    const seriousComfort = { suppressMood: true, suppressNudges: true, note: '（严肃话术）' };
    // 闲聊里的重病/丧亲:安慰策略保留,口径不加(维持原行为)。
    const chatGates = noteGatesFor('chat', seriousComfort);
    assert.equal(chatGates.includeSeriousComfort, true);
    assert.equal(chatGates.includeModeNote, false);
    assert.equal(chatGates.includeMoodLength, false, '严肃场合情绪字数本来就被压掉');
    // 知识题(如"解释一下癌症筛查原理"):给口径,不拿安慰话顶替答案。
    const knowledgeGates = noteGatesFor('knowledge', seriousComfort);
    assert.equal(knowledgeGates.includeSeriousComfort, false, '知识请求不许被安慰话顶掉');
    assert.equal(knowledgeGates.includeModeNote, true);
    // 普通闲聊:三段都在。
    const plain = noteGatesFor('chat', {});
    assert.deepEqual(
      [plain.includeMoodLength, plain.includeRandomNudges, plain.includeSeriousComfort, plain.includeModeNote],
      [true, true, false, false],
    );
  });

  test('wiring:index.js 真接线、kb 的「不要列点」矛盾已消（扫源码）', () => {
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    assert.match(indexSource, /import \{ composeModeNote, detectTurnMode, groupLinesForDelivery, noteGatesFor, outputPolicyFor \} from '\.\/turn-policy\.js'/,
      'import 必须与模块导出一致');
    // turnNotes:判定一次、按 gates 决定注入(而不是散落的 if)。
    const notesStart = indexSource.indexOf('  async function turnNotes(');
    const notesEnd = indexSource.indexOf('\n  /**', notesStart);
    const notesBody = indexSource.slice(notesStart, notesEnd);
    assert.match(notesBody, /detectTurnMode\(message\?\.content/, 'turnNotes 要按真实用户正文判口径');
    assert.match(notesBody, /noteGatesFor\(turnMode\.mode, policy\)/, '注入由 gates 决定');
    assert.match(notesBody, /if \(gates\.includeMoodLength\) notes\.push\(\.\.\.moodNotes\(moodDecision\)\)/,
      '情绪字数必须受 gates 管');
    assert.match(notesBody, /if \(gates\.includeRandomNudges\) notes\.push\(\.\.\.nextNudges\(\)\)/,
      '随机/固定风格必须受 gates 管');
    // 交付:三个真实答题入口都要传保真开关(QQ 答话 / 合并答话 / 网页)。
    const preserveCount = (indexSource.match(/preserveFormatting: outputPolicyFor\(turnModeFor\(/g) ?? []).length;
    assert.equal(preserveCount, 3, `三个答题入口都要传保真开关，实际 ${preserveCount}`);
    assert.match(indexSource, /function planSpokenLines\(text, decision, \{ label = '发言', preserveFormatting = false \} = \{\}\)/,
      'planSpokenLines 要有 preserveFormatting 参数');
    // 保真分支必须**早于**口语切分(否则保护的是已经坏掉的文本)。
    const planStart = indexSource.indexOf('  function planSpokenLines(');
    const planBody = indexSource.slice(planStart, planStart + 1600);
    const preserveAt = planBody.indexOf('if (preserveFormatting)');
    const splitAt = planBody.indexOf('splitSpokenLines(');
    assert.ok(preserveAt >= 0 && splitAt > preserveAt, '保真分支必须排在 splitSpokenLines 之前');
    // P2:保真分支必须按**整行**预分组,且与出站 chunkText 用**同一个上限**(D159)。
    assert.match(planBody, /groupLinesForDelivery\(whole, config\.policy\.maxChars\)/,
      '任务轮分组必须与出站同一上限');
    // kb 的百科说明不许再与"需要分条"打架。
    // 2026-10-29：说明文本已外提到非公开内容（有 C 用原文、公开用中性默认），
    // 所以这里不再断言源文件字面量，而是断言**实际生效的说明文本**（含 C 时仍是原口径）。
    const kbSource = fs.readFileSync(path.resolve('src', 'kb.js'), 'utf8');
    assert.doesNotMatch(kbSource, /也不要列点/, 'kb 里"不要列点"与任务口径冲突，必须改掉');
    assert.match(kbSource, /LOCAL_INFRA_CONTENT|encyclopediaNote/, 'kb 的百科说明必须走外提内容接线');
    const effectiveNote = ENCYCLOPEDIA_NOTE;
    assert.equal(typeof effectiveNote, 'string', 'kb 必须导出可核对的百科说明文本');
    assert.match(effectiveNote, /需要分条讲清楚时就分条讲/, '生效说明里必须允许分条讲清楚');
  });

  test('P2 交付分组:只搬运换行,一个字符不改;超长单行独立;与出站同上限', () => {
    // 保真的硬判据:组间用 \n 接回 = 逐字等于原文。
    const multi = '第一行说明\n```python\nif True:\n    print(1)\n```\n最后一行';
    const grouped = groupLinesForDelivery(multi, 20);
    assert.equal(grouped.join('\n'), multi, '分组不许改任何字符');
    assert.ok(grouped.length > 1, '小上限下应分成多条');
    for (const group of grouped) {
      assert.ok(group.length <= 20 || group.split('\n').length === 1, '每组不超上限(超长单行除外)');
    }
    // 超长单行:独占一条,不在这一层硬切(出站兜底)。
    const long = 'x'.repeat(50);
    const groupedLong = groupLinesForDelivery(`短行\n${long}`, 20);
    assert.equal(groupedLong[0], '短行');
    assert.equal(groupedLong[1], long, '超长单行单独成组');
    assert.equal(groupedLong.length, 2);
    // 空输入与无上限。
    assert.deepEqual(groupLinesForDelivery('', 100), []);
    assert.deepEqual(groupLinesForDelivery('   \n  ', 100), []);
    assert.deepEqual(groupLinesForDelivery('原文', 0), ['原文']);
    // 代码缩进/JSON 冒号原样(这是 P0 修过的损坏形状,钉死不许回归)。
    const code = '```json\n{"ok": true, "n": 2}\n```';
    assert.equal(groupLinesForDelivery(code, 500).join('\n'), code);
  });

  test('P2 集成（真实 planSpokenLines 切片）:任务轮整行保真、闲聊轮维持口语切分', async () => {
    const source = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    const begin = source.indexOf('  function planSpokenLines(');
    const end = source.indexOf('\n  /**', begin);
    assert.ok(begin >= 0 && end > begin, '切片要切得准');
    const { splitSpokenLines } = await import('../src/mood.js');
    const { groupLinesForDelivery } = await import('../src/turn-policy.js');
    // ⚠️ 切片源码里有模板串(`${label}…`),必须用**拼接**喂给 vm ——
    // 放进外层模板字符串会让 `${label}` 被外层求值(大模板反引号同族坑)。
    const run = vm.runInNewContext(source.slice(begin, end) + '\nplanSpokenLines', {
      config: { policy: { spoken: { enabled: true, maxChars: 60, emojiChance: 0 }, maxChars: 1500 } },
      splitSpokenLines, groupLinesForDelivery,
      MAX_PASSIVE_SEQ: 5,
      maybeSpokenEmoji: () => null,
      recentSpokenEmoji: [],
      log: { info() {}, warn() {} },
    });
    // 闲聊:维持现状(按句切、去行尾标点)。
    const chat = await run('先确认服务地址。再检查端口是否可达。', null, { label: '测' });
    assert.deepEqual(chat, ['先确认服务地址', '再检查端口是否可达']);
    // 任务:短代码 → 一条,逐字等于原文(缩进/花括号/冒号全在)。
    const code = '```python\nif True:\n    if True:\n        print(1)\n```';
    const task = await run(code, null, { label: '测', preserveFormatting: true });
    assert.deepEqual(task, [code], '任务轮必须逐字保真');
    // 任务:长文 → 按整行分组,join 回去逐字等于原文(上限与出站同一口径)。
    // 每行 ≈34 字 × 60 行 ≈ 2000 字 > 1500 上限,必然分成多条。
    const long = Array.from({ length: 60 }, (_, i) => `第${i + 1}步：检查第${i + 1}项配置并且把这一行写得更长一些以便触发分组。`).join('\n');
    const grouped = await run(long, null, { label: '测', preserveFormatting: true });
    assert.ok(grouped.length > 1, '长任务答案应分成多条');
    assert.equal(grouped.join('\n'), long, '分组只搬运换行,逐字保真');
    // 空文本:一条都不发。
    assert.deepEqual(await run('  ', null, { label: '测', preserveFormatting: true }), []);
  });

  test('P2 集成（真实 turnNotes 切片）:任务轮不注入字数/风格,知识题不被安慰话顶掉', async () => {
    const source = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    const begin = source.indexOf('  async function turnNotes(');
    const end = source.indexOf('\n  /**', begin);
    assert.ok(begin >= 0 && end > begin, '切片要切得准');
    const policy = await import('../src/turn-policy.js');
    const serious = await import('../src/serious.js');
    const sandbox = {
      DIRECT_RESPONSE_NOTES,
      // 真口径模块(替代闭包 import —— vm 里没有模块系统)。
      detectTurnMode: policy.detectTurnMode,
      noteGatesFor: policy.noteGatesFor,
      composeModeNote: policy.composeModeNote,
      // 闭包状态与协作函数的桩。
      lastTurnMode: new Map(),
      rememberTurnMode: () => {},
      log: { info() {}, warn() {} },
      moodNotes: () => ['MOOD-STUB:2 句以内、不超过 40 字'],
      nextNudges: () => ['NUDGE-STUB:这次只回一个很短的句子'],
      // 真严肃层:知识题(癌症筛查)会命中 critical —— 正好验"不被安慰话顶掉"。
      turnPolicyFor: serious.turnPolicyFor,
      pendingStoryFor: () => null,
      companyTurnNote: () => null,
      affinityNote: () => null,
      describeFishingScene: () => null,
      readFishing: () => null,
      panelPromptNote: () => null,
      describeLedgerForPrompt: () => null,
      conversationKeyFor: (message) => `k-${String(message?.content ?? '').slice(0, 6)}`,
      longTermNote: async () => null,
      claimNote: () => null,
      config: { policy: { stats: { enabled: false }, growth: { enabled: false }, seriousGuard: true } },
    };
    // 同上:拼接,不用外层模板(切片源码里有模板串)。
    const run = vm.runInNewContext(source.slice(begin, end) + '\nturnNotes', sandbox);
    const notesFor = async (text) => (await run(null, { content: text })).join('\n');

    // ① 任务轮:有口径说明,**没有**情绪字数、**没有**随机风格。
    const task = await notesFor('帮我分析线程池死锁，给复现和修复步骤');
    assert.match(task, /本轮口径/, '任务轮要有口径说明');
    assert.doesNotMatch(task, /MOOD-STUB/, '任务轮不许注入情绪字数上限');
    assert.doesNotMatch(task, /NUDGE-STUB/, '任务轮不许注入"只回很短"类随机风格');

    // ② 闲聊轮:维持现状(情绪+风格都在,口径说明一字不加)。
    const chat = await notesFor('今天好累啊');
    assert.match(chat, /MOOD-STUB/);
    assert.match(chat, /NUDGE-STUB/);
    assert.doesNotMatch(chat, /本轮口径/);

    // ③ 知识题撞上严肃词:给口径、给不了安慰话(不被"短而真诚"顶掉),也压掉花活。
    const knowledge = await notesFor('解释一下癌症筛查原理');
    assert.match(knowledge, /本轮口径/, '知识题要有口径说明');
    assert.doesNotMatch(knowledge, /严肃话题/, '知识题不许被安慰策略顶替');
    assert.doesNotMatch(knowledge, /MOOD-STUB/, '知识题同样不许字数上限');
    // ④ 真闲聊撞上严肃词(家人生病):安慰策略保留、无口径说明 —— 原行为不回归。
    const comfort = await notesFor('家人确诊癌症了，我很难受');
    assert.match(comfort, /严肃话题/, '真丧亲/重病场合安慰策略必须还在');
    assert.doesNotMatch(comfort, /本轮口径/);
    assert.doesNotMatch(comfort, /MOOD-STUB/, '严肃闲聊本来就该压掉情绪字数(D80)');
  });
}
