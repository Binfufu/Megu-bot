/**
 * **两套数值框架 + 已注册机械体事件表 + 抓取许可**(2026-10-28 主人拍板)回归。
 *
 * 三个拍板分别钉成判据:
 *   ① 生物体/机械体两套数值:**既有生物体规则一个数字都不许变**(golden),机械体不产生货币开销、
 *      电量掉得慢、低电量才影响机能;
 *   ② 已注册机械体主题的事件表逐项保持结构,效果里**不出现钱的数值**;
 *   ③ web_fetch:私网/本机/元数据地址**永远硬挡**,可选域名白名单只许列表内(含子域)。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

/** Fixed-schema test fixture shared only by these four content-consumer suites. */
export async function loadNeutralContentFixture(moduleNames) {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const parent = path.resolve(repo, '..');
  const root = fs.mkdtempSync(path.join(parent, 'qqbot-neutral-c-'));
  const seed = path.join(root, 'seed');
  const run = path.join(root, 'run');
  const nativeRead = fs.readFileSync;
  const reads = new Map();
  let rejectedRealC = 0;
  fs.readFileSync = function (file, ...args) {
    const target = file instanceof URL ? fileURLToPath(file) : typeof file === 'string' ? path.resolve(file) : '';
    if (target && target.startsWith(path.join(repo, 'content') + path.sep)) {
      rejectedRealC += 1;
      throw new Error('real content forbidden in neutral test fixture');
    }
    if (target.startsWith(path.join(run, 'content') + path.sep)) reads.set(target, (reads.get(target) ?? 0) + 1);
    return nativeRead.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(path.parse(root).root, path.parse(repo).root, 'fixture stays on the repository volume');
    // Counterexample: a mistaken real-C read must throw BEFORE touching the disk.
    assert.throws(() => fs.readFileSync(new URL('../content/local/story-world.json', import.meta.url)), /real content forbidden/);
    assert.equal(rejectedRealC, 1);
    for (const dir of [seed, run]) {
      fs.mkdirSync(dir);
      fs.cpSync(path.join(repo, 'src'), path.join(dir, 'src'), { recursive: true });
      assert.equal(fs.existsSync(path.join(dir, 'content')), false);
      assert.equal(fs.existsSync(path.join(dir, '.env')), false);
      assert.equal(fs.existsSync(path.join(dir, 'data')), false);
    }
    const from = (dir, name) => import(pathToFileURL(path.join(dir, 'src', `${name}.js`)));
    const [world, commands, tuning, chronicle, body, mood, gameplay] = await Promise.all(
      ['world', 'commands', 'character-tuning', 'chronicle', 'body-theme', 'mood', 'local-gameplay-content'].map((name) => from(seed, name)));
    const makeEvents = (prefix) => Array.from({ length: 4 }, (_, index) => ({
      id: `${prefix}_${index}`, setup: `合成事件${prefix}${index}：正在整理测试场地`,
      branches: Array.from({ length: 4 }, (_, branch) => ({ id: `branch_${branch}`, weight: branch + 1,
        line: `合成走向${branch}`, keywords: [`合成线索${branch}`], effect: { mood: branch + 1, stamina: branch === 0 ? 0 : -branch } })),
    }));
    const storyWorld = {
      schemaVersion: 1, storyEvents: makeEvents('biological'),
      storyPacks: { megumin: { id: 'megumin', label: '合成生物体故事' }, aris: { id: 'aris', label: '合成机械体故事', events: makeEvents('mechanical') } },
      storyClosingWords: ['合成收尾'], storyClosingExamples: ['合成收尾示例'], storyRespondClosing: '合成回应收尾', storySettleClosing: '合成自决收尾',
      places: world.PLACES.map((row) => ({ ...row, name: `合成地点${row.id}`, blurb: '合成场地说明' })),
      worldText: { currency: '合成币', questAcceptPrefix: '合成接取「', questAcceptSuffix: '」', questAcceptPlain: '合成接取' },
      companions: ['megumin', 'aris'].map((id, index) => ({ id, name: `合成伙伴${index}`, fullName: `合成全名${index}`, theme: id, bot: id, stateDir: id, art: `fixture_${index}.png`, blurb: '合成伙伴说明' })),
      moduleText: Object.fromEntries(tuning.MODULE_TUNING.map((row, index) => [row.id, { name: `合成模块${index}`, ...(row.note === undefined ? {} : { note: '合成模块说明' }) }])),
      characterDays: { megumin: [{ month: 1, day: 2, label: '合成纪念甲', source: '合成日历甲' }], aris: [{ month: 7, day: 8, label: '合成纪念乙', source: '合成日历乙' }] },
      chronicleKinds: { ...chronicle.CHRONICLE_KINDS, illness: '合成不适', heal: '合成康复' },
      eventLabels: { ...chronicle.EVENT_LABEL, someone_treats: '合成对象请客' },
      chronicleText: { currency: '合成币', manaLabel: '合成储能', healFailed: '合成治疗未完成' },
      commandEffects: Object.fromEntries(commands.BRIDGE_COMMANDS.map((row) => [row.name, '合成命令说明'])),
      cardClaimNotes: Object.fromEntries(commands.CARD_CLAIMS.map((row) => [row.claim, '合成能力说明'])),
      keywordGroups: [{ label: '合成词组', words: ['合成关键词'] }], arisPhrases: [{ phrase: '合成播报', note: '合成播报说明' }],
      opsEffects: Object.fromEntries(commands.OPS_SCRIPTS.map((row) => [row.name, '合成操作说明'])),
    };
    const moodText = (theme, index) => ({ label: `合成交流主题${index}`,
      moods: Object.fromEntries(Object.keys(theme.moods).map((id) => [id, { label: `合成情绪${id}`, directive: '合成交流指令' }])),
      topics: Object.fromEntries(theme.topicOverrides.map(({ id }) => [id, { label: `合成话题${id}`, keywords: [`合成触发${id}`] }])),
      interjections: Object.fromEntries(Object.keys(theme.moods).map((id) => [id, [`合成语气${id}`]])),
      kaomoji: [{ text: '合成表情', tags: ['happy'] }], interjectionTopicGate: {},
    });
    const bodyText = (theme, index) => ({ label: `合成身体主题${index}`,
      values: Object.fromEntries(Object.entries(theme.values).map(([id, value]) => [id, {
        short: `${index === 0 ? '甲' : '乙'}${{ satiety: '饱食', health: '健康', mood: '心情', stamina: '体力', mana: '储能' }[id]}`,
        long: `合成${index}${id}`, states: value.states.map((_, at) => `合成${index}${id}档${at}`),
      }])),
      action: { verb: '合成补给', short: '合成补给', prompt: '合成补给完成', tag: '合成补给' },
      growth: { knownAs: '合成联系人', conceptAs: '合成概念', personRecorded: '合成记录人员', conceptRecorded: '合成记录概念' },
    });
    const moodBody = { schemaVersion: 1,
      mood: { megumin: moodText(mood.MEGUMIN_THEME, 0), aris: moodText(mood.ARIS_THEME, 1) },
      body: { megumin: bodyText(body.MEGUMIN_BODY, 0), aris: bodyText(body.ARIS_BODY, 1) },
      config: { groupKeywords: ['合成助手'], reportTargetName: '合成报数目标', bodyMismatchNote: '合成主题必须一致' },
      ruleLabels: { biological: '合成生物体规则', mechanical: '合成机械体规则' } };
    const gameplayContent = structuredClone(gameplay.DEFAULT_GAMEPLAY_CONTENT);
    gameplayContent.currency = { name: '合成币', note: '合成记账单位' };
    gameplayContent.statsText.manaEnough = '合成技能可以使用';
    gameplayContent.statsText.manaLow = '合成技能能量不足（需要{cost}）';
    gameplayContent.explosion.finishers = gameplayContent.explosion.finishers.map(() => '合成结束');
    fs.mkdirSync(path.join(run, 'content', 'local'), { recursive: true });
    for (const [name, value] of [['story-world', storyWorld], ['mood-body', moodBody], ['gameplay', gameplayContent]]) {
      fs.writeFileSync(path.join(run, 'content', 'local', `${name}.json`), JSON.stringify(value));
    }
    const modules = Object.fromEntries(await Promise.all(moduleNames.map(async (name) => [name, await from(run, name)])));
    for (const [name, property, value] of [['local-story-world-content', 'LOCAL_STORY_WORLD', storyWorld],
      ['local-mood-body-content', 'LOCAL_MOOD_BODY_CONTENT', moodBody], ['local-gameplay-content', 'GAMEPLAY_CONTENT', gameplayContent]]) {
      assert.deepEqual((await from(run, name))[property], value, 'loaded content must be the independently authored fixture');
      assert.equal(reads.get(path.join(run, 'content', 'local', `${name === 'local-story-world-content' ? 'story-world' : name === 'local-mood-body-content' ? 'mood-body' : 'gameplay'}.json`)), 1);
    }
    // Stronger counterexample: misdirect a disposable copy of the REAL loader to real C.
    // The loader must fail closed; the guard still rejects before reading any private bytes.
    const loaderPath = path.join(run, 'src', 'local-story-world-content.js');
    const loaderSource = nativeRead.call(fs, loaderPath, 'utf8');
    const wrongLoader = loaderSource.replace("new URL('../content/local/story-world.json', import.meta.url)",
      `new URL(${JSON.stringify(new URL('../content/local/story-world.json', import.meta.url).href)})`);
    assert.notEqual(wrongLoader, loaderSource, 'counterexample must actually change the loader destination');
    const wrongPath = path.join(run, 'src', '__misdirected_story_world.js');
    fs.writeFileSync(wrongPath, wrongLoader);
    await assert.rejects(() => import(pathToFileURL(wrongPath)), /^Error: 本地故事世界内容读取失败$/);
    assert.equal(rejectedRealC, 2, 'only the two deliberately rejected counterexamples may target real C');
    return { ...modules, fixture: { storyWorld, moodBody, gameplay: gameplayContent } };
  } finally {
    fs.readFileSync = nativeRead;
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('qqbot-neutral-c-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

export function registerBodyRulesTests({ test: register, assert: a }) {
  let BODY_KINDS, BIOLOGICAL_RULES, MECHANICAL_RULES, bodyRulesFor, bodyRulesForTheme;
  let DECAY, MONEY_DECAY, STAT_DEFAULTS, advanceStats, applyMeal, createStats;
  let STORY_EVENTS, STORY_CONTENT_PACKS, storyPackFor, storyPackStatus;
  let createWebSearchProvider, isPrivateHost, validateFetchUrl, getBodyTheme, fixture;
  let setup;
  const test = (name, check) => register(name, async () => {
    setup ??= loadNeutralContentFixture(['body-rules', 'stats', 'story', 'story-content', 'web-search-provider', 'body-theme']).then((loaded) => {
      ({ BODY_KINDS, BIOLOGICAL_RULES, MECHANICAL_RULES, bodyRulesFor, bodyRulesForTheme } = loaded['body-rules']);
      ({ DECAY, MONEY_DECAY, STAT_DEFAULTS, advanceStats, applyMeal, createStats } = loaded.stats);
      ({ STORY_EVENTS } = loaded.story);
      ({ STORY_CONTENT_PACKS, storyPackFor, storyPackStatus } = loaded['story-content']);
      ({ createWebSearchProvider, isPrivateHost, validateFetchUrl } = loaded['web-search-provider']);
      ({ getBodyTheme } = loaded['body-theme']);
      fixture = loaded.fixture;
    });
    await setup;
    return check();
  });
  test('框架注册:生物体/机械体两套；主题映射是显式的，认不出当场抛', () => {
    a.deepEqual([...BODY_KINDS], ['biological', 'mechanical']);
    a.equal(bodyRulesForTheme(''), BIOLOGICAL_RULES, '未配置 = 生物体(旧行为)');
    a.equal(bodyRulesForTheme(getBodyTheme('megumin').id), BIOLOGICAL_RULES);
    a.equal(bodyRulesForTheme(getBodyTheme('aris').id), MECHANICAL_RULES);
    a.equal(BIOLOGICAL_RULES.label, '合成生物体规则');
    a.equal(MECHANICAL_RULES.label, '合成机械体规则');
    a.equal(getBodyTheme('aris').label, '合成身体主题1');
    a.throws(() => bodyRulesForTheme('demo_unknown'), /未知身体主题/, '没登记的主题不许静默套用');
    a.throws(() => bodyRulesFor('alien'), /未知数值框架/);
    a.equal(bodyRulesFor('').kind, 'biological');
  });

  test('生物体 golden:抽框架前后一个数字都没变(行为不变的硬保证)', () => {
    a.deepEqual({ ...STAT_DEFAULTS }, { satiety: 60, health: 80, mood: 70, stamina: 70, mana: 90, money: 2000 });
    a.equal(DECAY.satietyPerHourAwake, 4);
    a.equal(DECAY.satietyPerHourAsleep, 2);
    a.equal(DECAY.starvingBelow, 20);
    a.equal(DECAY.manaPerHour, 5);
    a.deepEqual([MONEY_DECAY.perHourAwake, MONEY_DECAY.perHourAsleep], [150, 80]);
    a.equal(MONEY_DECAY.enabled, true);
  });

  test('机械体:电量掉得慢、钱不动、能源回得快（与生物体同一步长并列对照）', () => {
    const bio = advanceStats(createStats(T0, BIOLOGICAL_RULES), T0, T0 + 3_600_000, { rules: BIOLOGICAL_RULES });
    // ⚠️ 起点给**非零**的钱:0 会被 MONEY_MIN 夹住,反证时看不出差别(判据必须能红)。
    const mechStart = { ...createStats(T0, MECHANICAL_RULES), money: 1000 };
    const mech = advanceStats(mechStart, T0, T0 + 3_600_000, { rules: MECHANICAL_RULES });
    a.equal(Math.round(bio.satiety), 56, '生物体 1 小时 −4');
    a.equal(Math.round(mech.satiety), 68, '机械体 1 小时 −2');
    a.equal(Math.round(bio.money), 1850, '生物体钱按时间走');
    a.equal(Math.round(mech.money), 1000, '机械体不产生货币开销(非零起点也不动)');
    a.equal(Math.round(bio.mana), 95, '生物体 +5/h');
    a.equal(Math.round(mech.mana), 86, '机械体 +6/h');
    a.equal(Math.round(bio.stamina), 67);
    a.equal(Math.round(mech.stamina), 73);
  });

  test('机械体:低电量才掉机能（阈值 15、速率 1/h）；生物体照旧（20 / 2/h）', () => {
    const bioStart = { ...createStats(T0, BIOLOGICAL_RULES), satiety: 10, updatedAt: T0 };
    const mechStart = { ...createStats(T0, MECHANICAL_RULES), satiety: 10, updatedAt: T0 };
    const bio = advanceStats(bioStart, T0, T0 + 3_600_000, { rules: BIOLOGICAL_RULES });
    const mech = advanceStats(mechStart, T0, T0 + 3_600_000, { rules: MECHANICAL_RULES });
    a.equal(Math.round(bio.health), 78, '生物体：饿着 −2 健康');
    a.equal(Math.round(mech.health), 84, '机械体：低电量只 −1 机能');
    // 电量充足时机械体机能不因"饿"掉(它没有饿这回事)。
    const mechFull = { ...createStats(T0, MECHANICAL_RULES), satiety: 60, health: 85, updatedAt: T0 };
    a.equal(Math.round(advanceStats(mechFull, T0, T0 + 3_600_000, { rules: MECHANICAL_RULES }).health), 85);
  });

  test('机械体吃/充不花钱；生物体照旧扣钱', () => {
    const bio = applyMeal({ ...createStats(T0, BIOLOGICAL_RULES), money: 2000 }, { food: '定食', kcal: 600, paidBy: 'self' }, T0, BIOLOGICAL_RULES);
    const mech = applyMeal({ ...createStats(T0, MECHANICAL_RULES), money: 1000 }, { food: '充电', kcal: 600, paidBy: 'self' }, T0, MECHANICAL_RULES);
    a.ok(bio.stats.money < 2000, `生物体要花钱:${bio.stats.money}`);
    a.equal(mech.stats.money, 1000, '机械体不花钱(非零起点也不扣)');
    a.ok(mech.stats.satiety > 70, '电量照涨');
    a.equal(Math.round(mech.stats.satiety), Math.round(bio.stats.satiety - 60 + 70), '电量增益与生物体同一公式');
  });

  test('已注册机械体事件表:效果不含钱、结构与既有生物体包同形', () => {
    const pack = storyPackFor('aris');
    a.ok(pack, '已登记的机械体主题必须有内容包');
    a.notEqual(pack.events, STORY_EVENTS, '不是生物体原表');
    a.ok(pack.events.length >= 3, '至少三个事件');
    a.equal(storyPackStatus('aris').enabled, true);
    a.equal(Object.isFrozen(STORY_CONTENT_PACKS.aris.events), true);
    const ids = new Set();
    for (const event of pack.events) {
      a.ok(event.id && !ids.has(event.id), `事件 id 唯一:${event.id}`);
      ids.add(event.id);
      a.ok(typeof event.setup === 'string' && event.setup.length > 8, `${event.id} 要有 setup`);
      a.ok(Array.isArray(event.branches) && event.branches.length >= 2, `${event.id} 至少两档走向`);
      for (const branch of event.branches) {
        a.ok(branch.id && branch.line, `${event.id}/${branch.id} 要有 id 与 line`);
        a.ok(branch.weight > 0, `${event.id}/${branch.id} 权重必须为正`);
        a.ok(Array.isArray(branch.keywords) && branch.keywords.length > 0, `${event.id}/${branch.id} 要有兜底关键词`);
        a.equal('money' in (branch.effect ?? {}), false, `${event.id}/${branch.id} 不许有金钱效果(机械体没有货币概念)`);
      }
    }
    // 合成JSON经真实loader和注册表装配；既验证原引用契约，也逐字核对输入事件。
    a.equal(storyPackFor('megumin').events, STORY_EVENTS);
    a.deepEqual(pack.events, fixture.storyWorld.storyPacks.aris.events);
    a.deepEqual(STORY_EVENTS, fixture.storyWorld.storyEvents);
    a.equal(pack.label, '合成机械体故事');
  });

  test('抓取许可:私网/本机/元数据永远硬挡；公网默认可抓；白名单只许列表内(含子域)', () => {
    for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.1.5', '172.16.0.9', '169.254.169.254', '::1', 'svc.internal', 'nas.local', '0.0.0.0']) {
      a.equal(isPrivateHost(host), true, `${host} 必须判私网`);
    }
    a.equal(isPrivateHost('example.com'), false);
    for (const url of ['http://127.0.0.1/x', 'https://localhost:8080/a', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'https://metadata.google.internal/']) {
      const check = validateFetchUrl(url);
      a.equal(check.ok, false, `${url} 必须拒`);
      a.match(check.reason, /私网|本机|元数据|host/i);
    }
    a.equal(validateFetchUrl('https://example.com/a?q=1').ok, true, '公网默认可抓');
    // 白名单。
    const allow = { allowedHosts: ['example.com'] };
    a.equal(validateFetchUrl('https://example.com/a', allow).ok, true);
    a.equal(validateFetchUrl('https://a.example.com/b', allow).ok, true, '子域也算');
    a.equal(validateFetchUrl('https://other.com/b', allow).ok, false);
    a.match(validateFetchUrl('https://other.com/b', allow).reason, /不在许可清单/);
    a.equal(validateFetchUrl('https://notexample.com/b', allow).ok, false, '后缀相似不等于子域');
    // provider 层也真的走这份闸(被挡时一个请求都不发)。
    let called = 0;
    const provider = createWebSearchProvider({
      baseUrl: 'https://api.example.test', apiKey: 'fixture', allowedHosts: ['example.com'],
      fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({ title: 't', content: 'c' }) }; },
    });
    return (async () => {
      const blocked = await provider.fetchPage('http://127.0.0.1/x');
      a.equal(blocked.ok, false);
      const outside = await provider.fetchPage('https://other.com/x');
      a.equal(outside.ok, false);
      a.equal(called, 0, '被挡的 URL 一个请求都不许发');
      a.equal((await provider.fetchPage('https://example.com/a')).ok, true);
      a.equal(called, 1);
    })();
  });

  test('wiring:store 注入数值框架、index 传主题与白名单、config 有开关(扫源码)', () => {
    const storeSource = fs.readFileSync(path.resolve('src', 'sqlite-store.js'), 'utf8');
    a.match(storeSource, /constructor\(file, \{ legacyJsonPath, bodyRules = null \} = \{\}\)/, 'store 构造收数值框架');
    a.match(storeSource, /advanceStats\(stored, stored\.updatedAt, now, \{ sleep, rules: bodyRules \}\)/, '推进时间要带框架');
    a.match(storeSource, /applyMeal\(advanced, intake, now, bodyRules\)/, '进食要带框架');
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    a.match(indexSource, /const bodyRules = bodyRulesForTheme\(config\.policy\.stats\.theme\)/, 'index 按身体主题取框架');
    a.match(indexSource, /bodyRules,\n  \}\);/, 'store 创建时注入框架');
    a.match(indexSource, /allowedHosts: toolsCfg\.webFetchAllow/, '抓取白名单接到 provider');
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    a.match(configSource, /QQBOT_WEBFETCH_ALLOW/, '白名单配置项存在(默认空=公网)');
  });
}
