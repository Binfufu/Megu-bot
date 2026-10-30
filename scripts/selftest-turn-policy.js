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
import { splitSpokenLines } from '../src/mood.js';
import { ENCYCLOPEDIA_NOTE } from '../src/kb.js';
import {
  TURN_MODES,
  composeModeNote,
  createTurnDecision,
  detectTurnMode,
  groupLinesForDelivery,
  noteGatesFor,
  outputPolicyFor,
  splitTurnSlots,
} from '../src/turn-policy.js';

export function registerTurnPolicyTests({ test, assert }) {
  test('口径判定:闲聊仍是闲聊，办事/求知被认出；结构**只标记保真**,不单独授予 task/knowledge', () => {
    const chat = ['今天好累啊', '在吗', '你为什么这样啊', '今天也辛苦了', '来两张甘雨美图', '哈哈哈'];
    for (const text of chat) {
      assert.equal(detectTurnMode(text).mode, 'chat', `闲聊不许被改成任务:${text}`);
    }
    const task = [
      '帮我看看这个任务要怎么做',
      '帮我分析线程池死锁，给复现和修复步骤',
      '给我列个这周的计划',
      '报错 401 Unauthorized 怎么解决',
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
    // **F2 形状变更**:裸结构(代码块/JSON/URL)只标记 preserveFormatting,不再判 task。
    const structuralOnly = ['```python\nprint(1)\n```', '{"a":1, "b":2}', '看 https://example.invalid/x 这个'];
    for (const text of structuralOnly) {
      const detected = detectTurnMode(text);
      assert.equal(detected.mode, 'chat', `结构信号不许单独授予权限:${text}`);
      assert.equal(detected.structural, true, `结构信号仍要标记保真需求:${text}`);
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

  test('F2 消费判据:真实 turnNotes/planSpokenLines 只消费入口决策（不再重判/重读 lastTurnMode）', async () => {
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    // 反证形状:旧的三处"各自重判"入口必须已经不存在(它们是 F2 修掉的病,不是接线)。
    // 去掉注释再查,免得只查字面注释自喂绿。
    const indexCode = indexSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(indexCode, /turnModeFor\(/, 'index.js 不许再有交付前的第二次口径重判');
    assert.doesNotMatch(indexCode, /preserveFormatting:\s*outputPolicyFor/,
      '保真开关不许再由交付处临时重判(只许读入口决策)');
    const notesStart = indexSource.indexOf('  async function turnNotes(');
    const notesEnd = indexSource.indexOf('\n  /**', notesStart);
    assert.ok(notesStart >= 0 && notesEnd > notesStart, 'turnNotes 切片要切得准');
    const planStart = indexSource.indexOf('  function planSpokenLines(');
    const planEnd = indexSource.indexOf('\n  /**', planStart);
    assert.ok(planStart >= 0 && planEnd > planStart, 'planSpokenLines 切片要切得准');

    const turnNotesCode = indexSource.slice(notesStart, notesEnd);
    const planCode = indexSource.slice(planStart, planEnd);
    const makeConsumer = () => {
      const lastTurnMode = new Map();
      const sandbox = {
        DIRECT_RESPONSE_NOTES,
        config: {
          policy: {
            stats: { enabled: false }, growth: { enabled: false }, seriousGuard: true,
            spoken: { enabled: true, maxChars: 60, emojiChance: 0 },
            maxChars: 1500,
          },
        },
        pendingStoryFor: () => null, companyTurnNote: () => null, affinityNote: () => null,
        describeFishingScene: () => null, readFishing: () => null,
        panelPromptNote: () => null, describeLedgerForPrompt: () => null,
        conversationKeyFor: (message) => message?.conversation ?? 'c-f2',
        longTermNote: async () => null, claimNote: () => null,
        turnPolicyFor: () => ({ suppressMood: false, suppressNudges: false }),
        detectTurnMode, noteGatesFor, outputPolicyFor, composeModeNote, createTurnDecision,
        lastTurnMode, rememberTurnMode: () => {},
        moodNotes: () => ['MOOD-LENGTH-STUB'],
        nextNudges: () => ['RANDOM-STYLE-STUB'],
        log: { info() {}, warn() {}, debug() {} },
        splitSpokenLines, groupLinesForDelivery, MAX_PASSIVE_SEQ: 5,
        maybeSpokenEmoji: () => null, recentSpokenEmoji: [],
      };
      return {
        ...vm.runInNewContext(`${turnNotesCode}\n${planCode}\n({ turnNotes, planSpokenLines })`, sandbox),
        lastTurnMode,
      };
    };

    const taskDecision = createTurnDecision(
      { content: '帮我分析线程池死锁，给复现和修复步骤', senderId: 'u1', messageId: 'm1' },
      { conversation: 'c-f2', instance: 'bot' },
    );
    const chatDecision = createTurnDecision(
      { content: '今天好累啊', senderId: 'u1', messageId: 'm2' },
      { conversation: 'c-f2', instance: 'bot' },
    );
    const consumer = makeConsumer();

    // ① 传 task 决策 + **闲聊正文**:必须按决策注入口径(证明不重新按正文判)。
    const taskNotes = (await consumer.turnNotes(null, { content: '今天好累啊', conversation: 'c-f2' }, [], null, { decision: taskDecision })).join('\n');
    assert.match(taskNotes, /本轮口径/, '决策是 task 时,即便正文像闲聊也要给 task 口径');
    assert.doesNotMatch(taskNotes, /MOOD-LENGTH-STUB|RANDOM-STYLE-STUB/, 'task 决策要压掉字数与随机风格');

    // ② 传 chat 决策 + **任务正文**:必须按决策维持闲聊口径(证明决策是唯一权威)。
    const chatNotes = (await consumer.turnNotes(null, { content: '帮我分析线程池死锁，给复现和修复步骤', conversation: 'c-f2' }, [], null, { decision: chatDecision })).join('\n');
    assert.doesNotMatch(chatNotes, /本轮口径/, '决策是 chat 时,即便正文像任务也不许自己改口');
    assert.match(chatNotes, /MOOD-LENGTH-STUB/);
    assert.match(chatNotes, /RANDOM-STYLE-STUB/);

    // ③ 决策冻结:入口之后改共享 lastTurnMode,也不许影响本轮(旧实现会重读它)。
    const followUpChat = createTurnDecision(
      { content: '第二步呢', senderId: 'u1' }, { conversation: 'c-f2', previous: 'chat', instance: 'bot' },
    );
    assert.equal(followUpChat.mode, 'chat');
    consumer.lastTurnMode.set('c-f2', 'task'); // 模拟同会话另一轮在这之后写了共享状态
    const frozenNotes = (await consumer.turnNotes(null, { content: '第二步呢', conversation: 'c-f2' }, [], null, { decision: followUpChat })).join('\n');
    assert.doesNotMatch(frozenNotes, /本轮口径/, '决策之后的共享状态变化不许改这一轮口径');

    // ④ 结构只标记保真:chat + 代码块 → 不加口径,但 plan 整行保真。
    const structuralDecision = createTurnDecision(
      { content: '```python\nprint(1)\n```', senderId: 'u1' }, { conversation: 'c-f2', instance: 'bot' },
    );
    assert.equal(structuralDecision.mode, 'chat');
    assert.equal(structuralDecision.structural, true);
    assert.equal(structuralDecision.outputPolicy.preserveFormatting, true, '结构信号必须把保真打开');
    const structuralNotes = (await consumer.turnNotes(null, { content: '```python\nprint(1)\n```', conversation: 'c-f2' }, [], null, { decision: structuralDecision })).join('\n');
    assert.doesNotMatch(structuralNotes, /本轮口径/, '结构信号不许授予 task/knowledge');

    // ⑤ planSpokenLines:有决策时,保真只读 decision(与调用方参不传 preserveFormatting 无关)。
    const code = '解释：\n```json\n{ "a": 1, "b": 2 }\n```\n最后一行。';
    const preserved = consumer.planSpokenLines(code, null, { label: '测', decision: structuralDecision });
    assert.equal(preserved.join('\n'), code, '结构保真决策必须整条逐字交付');
    const chatLines = consumer.planSpokenLines('第一句。\n第二句。', null, { label: '测', decision: chatDecision });
    assert.notDeepEqual(chatLines, ['第一句。\n第二句。'], 'chat 决策仍走口语分条(不被结构串味)');

    // ⑥ knowledge 单一 authority:关掉"百科说明"授权不撤销 knowledge 本身(不装傻)。
    const knowledgeNoNote = createTurnDecision(
      { content: '解释一下癌症筛查原理', senderId: 'u1' },
      { conversation: 'c-f2', instance: 'bot', allowKnowledgeNote: false },
    );
    assert.equal(knowledgeNoNote.knowledge.authorized, true, 'knowledge 授权仍在');
    assert.equal(knowledgeNoNote.noteGates.includeEncyclopediaNote, false, '只关说明那一段措辞');
    const knowledgeNotes = (await consumer.turnNotes(null, { content: '解释一下癌症筛查原理', conversation: 'c-f2' }, [], null, { decision: knowledgeNoNote })).join('\n');
    assert.match(knowledgeNotes, /本轮口径/, '关掉说明后 knowledge 口径仍在(不装傻)');
    assert.match(knowledgeNotes, /常识/, 'knowledge 口径必须保留常识授权');

    // ⑦ 决策对象不可变(冻结)。
    assert.equal(Object.isFrozen(createTurnDecision({ content: 'x', senderId: 'u' })), true);
    assert.throws(() => { 'use strict'; createTurnDecision({ content: 'x', senderId: 'u' }).mode = 'task'; }, TypeError);
    const slots = splitTurnSlots({
      content: '【引用材料 https://example.invalid/page 】\n这张也太好笑了',
      mentions: [{ id: 'other', username: 'someone', bot: false }],
    });
    assert.equal(slots.currentRequest, '这张也太好笑了', '引用材料不进当前请求槽');
    assert.match(slots.quote, /引用材料/, '引用材料单独进 quote 槽');
    assert.equal(slots.addressee[0].id, 'other', '@ 对象单独进 addressee 槽');

    // kb 的百科说明文本仍要与"分条讲清楚"相容(生效文本,不是源码字面量)。
    const effectiveNote = ENCYCLOPEDIA_NOTE;
    assert.equal(typeof effectiveNote, 'string', 'kb 必须导出可核对的百科说明文本');
    assert.match(effectiveNote, /需要分条讲清楚时就分条讲/, '生效说明里必须允许分条讲清楚');
    const kbSource = fs.readFileSync(path.resolve('src', 'kb.js'), 'utf8');
    assert.doesNotMatch(kbSource, /也不要列点/, 'kb 里"不要列点"与任务口径冲突，必须改掉');
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
