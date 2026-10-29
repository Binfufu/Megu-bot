/** Targeted local mood/body content checks; no bot, network or full runner. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const neutral = args.includes('--neutral');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CONTENT_URL = new URL('../content/local/mood-body.json', import.meta.url);
const TURN_CONTENT_URL = new URL('../content/local/turn-lines.json', import.meta.url);
const readCounts = { moodBody: 0, turnLines: 0 };
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (/^(QQBOT_|QQ_)/.test(key)) delete process.env[key];
// Explicit nonexistent fixture path: loadConfig must never discover a real .env.
process.env.QQBOT_ENV_FILE = fileURLToPath(new URL('../content/local/__mood_body_test_missing__.env', import.meta.url));
process.env.QQ_APP_ID = 'fixture'; process.env.QQ_CLIENT_SECRET = 'fixture';
process.env.QQBOT_LLM_KEY = 'fixture'; process.env.QQBOT_ENGINE = 'own';
if (neutral || arg('--fault')) {
  const read = fs.readFileSync;
  fs.readFileSync = function (file, ...options) {
    if (neutral && String(file) === String(TURN_CONTENT_URL)) {
      readCounts.turnLines += 1;
      const e = new Error('missing fixture'); e.code = 'ENOENT'; throw e;
    }
    if (String(file) === String(CONTENT_URL)) {
      readCounts.moodBody += 1;
      if (neutral) { const e = new Error('missing fixture'); e.code = 'ENOENT'; throw e; }
      if (arg('--fault') === 'json') return '{ private payload';
      const value = JSON.parse(read.call(this, file, ...options));
      if (arg('--fault') === 'section') delete value.body;
      else if (arg('--fault') === 'order') value.mood.megumin.interjections.chuni.reverse();
      else if (arg('--fault') === 'label') value.ruleLabels.biological += 'changed';
      else throw new Error('unknown boundary fault');
      return JSON.stringify(value);
    }
    return read.call(this, file, ...options);
  };
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
}
let imports = 0; const rng = Math.random;
Math.random = () => { imports += 1; return 0.25; };
let mood, body, rules, config;
try {
  [mood, body, rules, config] = await Promise.all([import('../src/mood.js'), import('../src/body-theme.js'), import('../src/body-rules.js'), import('../src/config.js')]);
} finally { Math.random = rng; }
assert.equal(imports, 0, 'content/module initialization consumes no random draws');
const serialize = (value) => JSON.stringify(value, (_, item) => item instanceof RegExp
  ? { $regex: { source: item.source, flags: item.flags } }
  : typeof item === 'number' && !Number.isFinite(item) ? { $number: String(item) } : item);
const json = (value) => JSON.parse(serialize(value));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const constants = (mod) => Object.fromEntries(Object.entries(mod).filter(([, value]) => typeof value !== 'function'));

function configSample(theme, keywords) {
  if (theme === undefined) delete process.env.QQBOT_MOOD_THEME; else process.env.QQBOT_MOOD_THEME = theme;
  delete process.env.QQBOT_BODY_THEME;
  if (keywords === undefined) delete process.env.QQBOT_GROUP_KEYWORDS; else process.env.QQBOT_GROUP_KEYWORDS = keywords;
  const loaded = config.loadConfig({ rootDir: ROOT });
  return { groupKeywords: loaded.policy.group.keywords,
    reportTargetName: loaded.policy.reportTargetName, reportTargetTheme: loaded.policy.reportTargetTheme,
    statsTheme: loaded.policy.stats.theme };
}
function snapshot() {
  const exported = { mood: constants(mood), body: constants(body), rules: constants(rules), keywords: config.DEFAULT_GROUP_KEYWORDS };
  const records = [];
  for (const theme of [mood.MEGUMIN_THEME, mood.ARIS_THEME, mood.DEMO_THEME]) {
    const texts = ['', 'hello', ...theme.topicOverrides.flatMap((row) => row.keywords.filter((key) => typeof key === 'string'))];
    for (const text of texts) {
      for (const roll of [0, 0.17, 0.5, 0.999999]) {
        let draws = 0; const random = () => { draws += 1; return [roll, 0.2, 0, 0.7][(draws - 1) % 4]; };
        const ctx = { now: 1_000_000, text, ttlMs: 10000, theme, random, stats: { satiety: 5, health: 10, mood: 15, money: 0 } };
        const first = mood.decideMood(null, ctx);
        const repeated = mood.decideMood(first.state, { ...ctx, now: ctx.now + 1 });
        const expired = mood.decideMood(repeated.state, { ...ctx, now: ctx.now + 20000 });
        records.push(['mood', theme.id, text, roll, mood.detectTopic(text, theme), first, mood.buildMoodNote(first), repeated, expired, draws]);
      }
    }
  }
  for (const theme of [body.MEGUMIN_BODY, body.ARIS_BODY, body.DEMO_BODY]) {
    for (const key of body.VALUE_KEYS) {
      for (const value of [-1, NaN, 0, 100, ...theme.values[key].states.flatMap(([at]) => [at - 1, at, at + 1])]) {
        records.push(['body', theme.id, key, value, body.describeValue(key, value, theme), body.labelFor(key, theme), body.longLabelFor(key, theme)]);
      }
    }
  }
  for (const theme of [undefined, 'megumin', 'aris', 'demo']) {
    for (const keywords of [undefined, '', 'one,two']) records.push(['config', theme ?? null, keywords ?? null, configSample(theme, keywords)]);
  }
  process.env.QQBOT_MOOD_THEME = 'aris'; process.env.QQBOT_BODY_THEME = 'megumin';
  try { config.loadConfig({ rootDir: ROOT }); assert.fail('theme mismatch must throw'); }
  catch (error) { records.push(['config-mismatch', error.message]); }
  delete process.env.QQBOT_BODY_THEME; delete process.env.QQBOT_MOOD_THEME;
  for (const text of ['one。two！', '甲，乙；丙。', 'https://example.test/a。下一句', '(・_・;)。再说一句', '😀𠮷～']) {
    records.push(['spoken', text, mood.splitSpokenLines(text, { maxChars: 8 }), mood.normalizeSpokenForJudge(text), mood.truncateForMood(text, 8)]);
  }
  return { exportsJson: serialize(exported), records: json(records) };
}
function extractContent() {
  const moodText = (theme) => ({
    label: theme.label,
    moods: Object.fromEntries(Object.entries(theme.moods).map(([id, value]) => [id, { label: value.label, directive: value.directive }])),
    topics: Object.fromEntries(theme.topicOverrides.map((row) => [row.id, { label: row.label, keywords: row.keywords }])),
    interjections: theme.interjections, kaomoji: theme.kaomoji, interjectionTopicGate: theme.interjectionTopicGate ?? {},
  });
  const bodyText = (theme) => ({ label: theme.label,
    values: Object.fromEntries(Object.entries(theme.values).map(([key, value]) => [key, { short: value.short, long: value.long, states: value.states.map(([, text]) => text) }])),
    action: theme.action, growth: theme.growth,
  });
  return { schemaVersion: 1, mood: { megumin: moodText(mood.MEGUMIN_THEME), aris: moodText(mood.ARIS_THEME) },
    body: { megumin: bodyText(body.MEGUMIN_BODY), aris: bodyText(body.ARIS_BODY) },
    config: { groupKeywords: config.DEFAULT_GROUP_KEYWORDS, reportTargetName: configSample(undefined).reportTargetName,
      bodyMismatchNote: current.records.find(([kind]) => kind === 'config-mismatch')[1].split(' —— ').at(-1) },
    ruleLabels: { biological: rules.BIOLOGICAL_RULES.label, mechanical: rules.MECHANICAL_RULES.label } };
}
const current = snapshot();
if (arg('--capture')) {
  const sources = {};
  for (const name of ['mood', 'body-theme', 'config', 'body-rules']) sources[`src/${name}.js`] = sha(fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url)));
  const baseline = { capturedAt: new Date().toISOString(), sources, ...current };
  fs.writeFileSync(arg('--capture'), JSON.stringify(baseline) + '\n', { flag: 'wx' });
  assert.ok(arg('--content'));
  fs.writeFileSync(arg('--content'), JSON.stringify(extractContent(), null, 2) + '\n', { flag: 'wx' });
  console.log(`baseline frozen: ${current.records.length} records, exports sha256=${sha(current.exportsJson)}`);
} else {
  if (arg('--verify')) {
    const baseline = JSON.parse(fs.readFileSync(arg('--verify'), 'utf8'));
    assert.equal(current.exportsJson, baseline.exportsJson, 'all exported constants and property order match old modules');
    assert.deepEqual(current.records, baseline.records, 'old/new deterministic consumer outputs and draw counts match');
    console.log(`golden identical: ${current.records.length} records, exports sha256=${sha(current.exportsJson)}`);
  }
  const { readLocalMoodBodyContent, LOCAL_MOOD_BODY_CONTENT } = await import('../src/local-mood-body-content.js');
  const missing = () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
  assert.equal(readLocalMoodBodyContent(missing), null);
  const fixture = structuredClone(extractContent());
  // Neutral mode has no C pools; build a small original valid schema fixture.
  for (const section of Object.values(fixture.mood)) {
    for (const row of Object.values(section.topics)) if (row.keywords.length === 0) row.keywords.push('topic');
    for (const pool of Object.values(section.interjections)) if (pool.length === 0) pool.push('phrase');
    if (section.kaomoji.length === 0) section.kaomoji.push({ text: 'expression', tags: ['happy'] });
  }
  assert.deepEqual(readLocalMoodBodyContent(() => JSON.stringify(fixture)), fixture);
  const mutations = [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.unexpected = 'field'; },
    (value) => { value.mood.aris.moods.plain.directive = ''; },
    (value) => { value.mood.megumin.topics.food.keywords = [1]; },
    (value) => { value.mood.aris.interjectionTopicGate = { unknown: ['game'] }; },
    (value) => { value.mood.aris.kaomoji = []; },
    (value) => { value.mood.megumin.interjections.plain = []; },
    (value) => { value.mood.megumin.topics.food.keywords = []; },
    (value) => { value.config.groupKeywords = []; },
    (value) => { value.body.aris.values.health.states.pop(); },
    (value) => { value.body.megumin.action.verb = null; },
    (value) => { value.config.reportTargetName = []; },
    (value) => { value.ruleLabels.biological = 42; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(fixture); mutate(bad);
    assert.throws(() => readLocalMoodBodyContent(() => JSON.stringify(bad)), /^Error: local mood\/body content: invalid fixed schema$/);
  }
  const denied = () => { const error = new Error('E:/private/payload'); error.code = 'EACCES'; throw error; };
  assert.throws(() => readLocalMoodBodyContent(denied), /^Error: local mood\/body content: EACCES$/);
  for (const text of ['{ private payload', '{}', '[]', 'null']) assert.throws(() => readLocalMoodBodyContent(() => text), (e) => /^local mood\/body content:/.test(e.message) && !e.message.includes('private payload'));
  assert.equal(mood.MEGUMIN_THEME.moods, mood.MOODS);
  assert.equal(mood.ARIS_THEME.moods, mood.ARIS_MOODS);
  assert.equal(body.BODY_THEMES.megumin, body.MEGUMIN_BODY);
  assert.equal(rules.BODY_RULE_PROFILES.biological, rules.BIOLOGICAL_RULES);
  assert.equal(mood.MOOD_THEMES.demo, mood.DEMO_THEME);
  assert.ok(!mood.DEMO_THEME.label.includes('megumin'));
  if (neutral) {
    assert.equal(LOCAL_MOOD_BODY_CONTENT, null);
    assert.deepEqual(readCounts, { moodBody: 1, turnLines: 1 }, 'each local file is read once despite multiple import consumers');
    for (const theme of [mood.MEGUMIN_THEME, mood.ARIS_THEME]) {
      assert.ok(theme.interjections && Object.values(theme.interjections).every((pool) => pool.length === 0));
      assert.equal(theme.kaomoji.length, 0);
      assert.ok(theme.topicOverrides.every((topic) => topic.keywords.length === 0));
      assert.ok(!/惠惠|爱丽丝|和真|爆裂|红魔|阿库|蔚蓝|厄里斯|邦邦/.test(serialize(theme)), 'no private text through style/theme assembly');
    }
    assert.equal(body.MEGUMIN_BODY.label, '中性身体状态');
    assert.equal(mood.MEGUMIN_THEME.label, '中性交流主题');
    assert.deepEqual(config.DEFAULT_GROUP_KEYWORDS, ['示例助手', 'demo']);
    assert.equal(configSample(undefined).reportTargetName, '示例助手');
    for (const text of [mood.MEGUMIN_THEME.label, mood.ARIS_THEME.label, serialize(mood.MOODS), serialize(mood.ARIS_MOODS), serialize(body.MEGUMIN_BODY), serialize(body.ARIS_BODY), serialize(config.DEFAULT_GROUP_KEYWORDS), rules.BIOLOGICAL_RULES.label, rules.MECHANICAL_RULES.label]) {
      assert.ok(!/惠惠|爱丽丝|和真|爆裂|红魔|阿库|蔚蓝|厄里斯|邦邦/.test(text), 'neutral display content must not carry private persona text');
    }
  }
  console.log(`mood/body ${neutral ? 'neutral ENOENT' : 'private/default'}: aliases, error contract and consumers passed`);
  if (!neutral && !args.includes('--no-child')) {
    let child = spawnSync(process.execPath, [SELF, '--neutral', '--no-child'], { cwd: ROOT, stdio: 'inherit' });
    assert.equal(child.status, 0);
    if (arg('--verify')) for (const fault of ['json', 'section', 'order', 'label']) {
      child = spawnSync(process.execPath, [SELF, '--verify', arg('--verify'), '--fault', fault, '--no-child'], { cwd: ROOT, stdio: 'ignore' });
      assert.equal(child.status, 1, `negative control ${fault} must fail`);
      console.log(`negative control ${fault}: rejected`);
    }
  }
}
for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
