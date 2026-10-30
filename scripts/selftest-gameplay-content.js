/** 玩法内容两态定向判据；私有 golden 固定于 aa795d1，离线隔离，不读 .env/data。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(path.dirname(ROOT), '.gameplay-content-'));
const publicFixture = fs.mkdtempSync(path.join(path.dirname(ROOT), '.gameplay-public-'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/zone-manifest.json'), 'utf8'));
const excluded = new Set(manifest.overrides.filter((row) => row.noPublish).map((row) => row.path));
let passed = 0;
let failed = 0;
const GOLDEN = {
  // 2026-10-29：stats 指纹随公开集「角色名→中性词」注释清理更新（只改函数体内注释；函数体与数值投影未变，
  // 「无 C 数值投影与有 C 一致」对照仍绿）。其余哈希与 aa795d1 freeze 一致。
  stats: '3d163161935acce72416ddfc7bcdab9b0b783f490b80e8cfa83355732ab8d276',
  economy: 'c118bb4749a93434145fea8ff7c6e0da622e1259502a54b4a549226aec71e124',
  condition: '79401ddfbce419eeeadd443b2dd394c6f167d929fd25a2673ab14fd6943dd330',
  selfcare: '0b598d12c38de372a2a90d8e5f2346f4bbd8da990e9c5ff5fd3870455d3e6cd9',
  company: 'f2c90cde7403075caf6c3fba348a5dd046ef933fafb7cfc294d1dbc89d97e2b0',
  // 2026-10-30：explosion 指纹随「技能触发词外提」更新——模块新增非函数导出
  // NEUTRAL_TRIGGER_WORDS（公开中性默认词表），属于有意的序列化形状变化；玩法数值/行为
  // 未变，仍由下方「无 C 数值投影与有 C 一致」对照钉住。
  explosion: '8d34e40a71e378cccef4d95437e5e31b2b54aa46bf93342c2aebc47b564fa78c',
  narration: '5398510e83b4b083fac8ed8f9e888d1c77ea70812bdf3e8684edee9e1bc89ec5',
  narrationBoundary: '8ae29a8e2dd050329f478e8d4bce01d41b0c019dd379aaabd46853df46950cd5',
}; // 2026-10-29：以上在任何玩法源码修改前实跑 --freeze 取得。
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const probe = `
  import fs from 'node:fs';
  import assert from 'node:assert/strict';
  import net from 'node:net';
  import cp from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  import { createHash } from 'node:crypto';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  assert.equal(path.dirname(fileURLToPath(import.meta.url)), process.cwd(), '真实子进程基址必须是 fixture');
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('forbidden runtime activity'); };
  globalThis.fetch = forbidden;
  globalThis.WebSocket = class { constructor() { forbidden(); } };
  net.Socket.prototype.connect = net.Server.prototype.listen = forbidden;
  fs.watch = forbidden;
  cp.spawn = cp.spawnSync = cp.exec = cp.execSync = cp.execFile = cp.execFileSync = cp.fork = forbidden;
  syncBuiltinESMExports();
  const names = ['stats', 'economy', 'condition', 'selfcare', 'company', 'explosion', 'narration'];
  const m = {};
  for (const name of names) m[name] = await import(new URL('./src/' + name + '.js', import.meta.url));
  const now = Date.UTC(2026, 0, 1, 12);
  const s = m.stats, e = m.economy, c = m.condition, a = m.selfcare, p = m.company, x = m.explosion, n = m.narration;
  const out = {};
  for (const name of names) out[name] = { exports: Object.fromEntries(Object.entries(m[name]).filter(([, v]) => typeof v !== 'function')) };
  const values = [0, 1, 11, 12, 19, 20, 24, 25, 39, 40, 44, 45, 46, 49, 50, 54, 55, 59, 60, 61, 62, 64, 65, 79, 80, 81, 82, 84, 85, 92, 93, 99, 100];
  const state = s.createStats(now);
  out.stats.calls = values.map((v) => {
    const sample = { ...state, satiety: v, health: v, mood: v, stamina: v, mana: v, money: v * 1000 };
    return [s.describeMoney(v * 1000), s.describeForUser(sample), s.describeWallet(sample),
      s.describeForPrompt(sample), s.mealCost(v * 25), s.canAfford(sample, 600),
      s.advanceStats(sample, now, now + 7 * 3600000, { sleep: { start: 23, end: 7 } }),
      s.applyMeal(sample, { food: 'fixture', kcal: 600, health: 2, mood: 4, paidBy: 'self' }, now),
      s.applyMeal(sample, { food: 'fixture', kcal: 400, paidBy: 'other' }, now),
      s.applyPotion(sample, 'mana', now), s.applyPotion(sample, 'stamina', now),
      s.applyMoney(sample, -5000, now), s.renderStatDeltas([{ money: 120, mana: -55 }]),
      ...Object.keys(s.INTERACTIONS).map((kind) => s.applyInteraction(sample, kind, now))];
  });
  out.stats.food = ['给你吃面包', '喝魔力药剂', '抱抱', '你好'].map((text) => [s.isIntimate(text), s.detectPotion(text), s.detectFeeding(text), s.feedingNote({ text })]);
  out.economy.calls = [e.formatQuestBoard([]), e.walletPrompt(32000), e.describeLedgerForPrompt([{ line: 'fixture', delta: -123 }]), e.formatQuestBoard(e.rollQuestBoard({ random: () => 0.5 }))];
  out.economy.rolls = [];
  for (const r of [0, 0.01, 0.2, 0.74, 0.75, 0.94, 0.95, 0.989, 0.999999]) {
    let count = 0;
    const random = () => { count++; return count === 1 ? 0 : r; };
    out.economy.rolls.push([e.rollTask({ now, money: 0 }, random), count]);
    count = 0;
    out.economy.rolls.push([e.rollEvent({ now }, random), count]);
    out.economy.rolls.push(e.rollQuestBoard({ count: 4, random: () => r }));
  }
  out.economy.numbers = [0, 15, 1500, 32000, 10005, 9999999].map((v) => [e.chineseNumberCandidates(v), e.mentionsAmount(String(v), v), e.moneyMood({ money: v, now, lastTaskAt: now - 1000 })]);
  out.condition.calls = [];
  for (const cause of Object.keys(c.DISEASE_CAUSES)) {
    for (const r of [0, 0.25, 0.75, 0.999999]) {
      const ill = c.catchDisease({ cause, now, random: () => r });
      out.condition.calls.push([ill, c.seekAqua(ill, () => r), c.describeCondition({ condition: ill, now }), c.isIll(ill, now)]);
    }
  }
  out.condition.tiers = values.map((v) => [c.healthTier(v), c.moodTier(v), c.tier10Index(v), c.moodBiasFor({ lazy: 1, genki: 1, kind: 2, chuni: 3 }, v), ...Object.keys(c.TIER10).map((key) => c.tier10(key, v))]);
  out.condition.replies = [];
  for (const v of [5, 30, 60, 90]) for (const topic of ['illness', 'hunger', 'mana', 'tired', 'mood', 'overall']) {
    const stats = { satiety: v, health: v, mood: v, stamina: v, mana: v };
    out.condition.replies.push(c.bodyCheckReply({ stats, question: { topic }, now, random: () => 0.4 }));
    out.condition.replies.push(c.bodyCheckReply({ stats, condition: { id: 'cold', name: 'fixture', treated: true }, question: { topic }, now, random: () => 0.4 }));
    out.condition.replies.push(c.bodyCheckReply({ stats, question: { topic, vague: true }, now, random: () => 0.6 }));
  }
  out.selfcare.calls = [];
  for (const v of [5, 12, 24, 25, 60]) {
    out.selfcare.calls.push(a.pickEatery(v));
    for (const r of [0, 0.45, 0.99]) out.selfcare.calls.push(a.decideSelfCare({ now, stats: { satiety: v }, lastHumanAt: now - 86400000, currentPlace: 'home', random: () => r }));
  }
  out.selfcare.prompts = [];
  for (const scene of ['c2c', 'group']) {
    for (const eatery of a.EATERIES) out.selfcare.prompts.push(a.buildSelfCarePrompt({ scene, action: 'eat', eatery }));
    for (const activity of a.LIFE_ACTIVITIES) {
      out.selfcare.prompts.push(a.buildSelfCarePrompt({ scene, action: 'life', activity }));
      out.selfcare.prompts.push(a.buildTravelReportPrompt({ scene, activity }));
    }
    out.selfcare.prompts.push(a.buildArrivalReportPrompt({ scene, arrival: { placeName: 'fixture' } }));
  }
  out.company.calls = p.COMPANION_ACTIVITIES.map((activity) => [p.companyById(activity.id), p.detectCompany(activity.keywords[0]), p.companyNote({ activity })]);
  out.company.numbers = [p.fishTableWeight(), p.fishExpectedValue()];
  out.explosion.calls = [];
  for (const chant of x.EXPLOSION_CHANTS) out.explosion.calls.push([x.groupBeats(chant), x.groupBeats(chant, { maxBeats: 1 }), x.chantJapanese(chant.id)]);
  for (const length of [null, ...x.CHANT_LENGTHS]) for (const r of [0, 0.4, 0.999999]) {
    let count = 0;
    const result = x.buildExplosion({ length, random: () => { count++; return r; } });
    out.explosion.calls.push([result, count, x.pickChant({ recent: [result.chantId], length, random: () => r }), x.pickFinisher({ recent: [result.finisher], random: () => r })]);
  }
  out.narration.calls = [n.buildNarrationPrompt(), n.buildNarrationPrompt({ botName: 'fixture narrator', caster: 'fixture caster', finisher: 'Explosion!!!\\nsecond' }), n.resolveCasterName([], 'missing'), n.resolveCasterName([{ id: '1', name: 'fixture' }], '1')];
  const algorithms = { stats: ['advanceStats', 'applyMeal', 'mealCost', 'applyInteraction', 'applyMoney', 'applyPotion', 'applyStory', 'createStats'], economy: ['rollTask', 'rollEvent', 'rollQuestBoard', 'moneyMood', 'chineseNumberCandidates', 'mentionsAmount'], condition: ['pickDisease', 'catchDisease', 'isIll', 'moodBiasFor', 'healthTier', 'moodTier', 'tier10Index'], selfcare: ['decideSelfCare', 'pickActivity', 'pickEatery', 'whereaboutsTtlMs', 'arrivalFreshnessMs'], company: ['fishExpectedValue', 'fishTableWeight', 'detectCompany'], explosion: ['buildExplosion', 'pickChant', 'pickFinisher', 'groupBeats', 'chantJapanese'], narration: ['isExplosionFinisher'] };
  for (const [name, keys] of Object.entries(algorithms)) out[name].algorithms = keys.map((key) => [key, createHash('sha256').update(m[name][key].toString()).digest('hex')]);
  out.narrationBoundary = { prompts: [], names: [], triggers: [] };
  for (const botName of [null, '', 'fixture narrator', '{caster}'])
    for (const caster of [undefined, '', null, 'fixture caster', '{identity}'])
      for (const finisher of ['', 'Explosion!!!\\nsecond', null])
        for (const examples of [undefined, [], ['fixture'], ['first', 'last\\n']]) {
          out.narrationBoundary.prompts.push(n.buildNarrationPrompt({ botName, caster, finisher, examples }));
        }
  for (const known of [[], null, 'broken', '[{"id":"1","name":"fixture"}]', [{ id: '1', name: '' }]])
    for (const id of [null, '1', 'missing'])
      for (const fallback of [undefined, '', 'custom']) out.narrationBoundary.names.push(n.resolveCasterName(known, id, fallback));
  for (const finisher of ['', 'Explosion!!!', 'ＥＸＰＬＯＳＩＯＮ！', 'エクスプロォージョン', 'not a finisher'])
    out.narrationBoundary.triggers.push(n.isExplosionFinisher(finisher));
  assert.equal(forbiddenCalls, 0, '不得尝试联网/监听/子进程/watcher');
  console.log(JSON.stringify(out));
`;

function copyTree(relative, target = fixture, publicOnly = false) {
  const dir = path.join(ROOT, relative);
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = `${relative}/${item.name}`;
    if (publicOnly && excluded.has(child)) continue;
    if (item.isDirectory()) copyTree(child, target, publicOnly);
    else if (item.isFile() && /\.(js|json)$/.test(item.name)) {
      const dest = path.join(target, child);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, child), dest);
    } else if (item.isSymbolicLink()) throw new Error('fixture 不复制链接');
  }
}
function rawRun(cwd, code) {
  const env = { TZ: 'UTC' };
  for (const key of ['SystemRoot', 'WINDIR', 'PATH']) if (process.env[key]) env[key] = process.env[key];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}
function run(cwd = fixture, extra = '') {
  const code = probe.replace('console.log(JSON.stringify(out));', `${extra}\nconsole.log(JSON.stringify(out));`);
  const result = rawRun(cwd, code);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
// 丢弃展示文本；保留所有数值/布尔/空值及其对象键、非空结构，比较两态实际计算产物。
function numbers(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const result = value.map(numbers).filter((item) => item !== undefined);
    return result.length ? result : undefined;
  }
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, numbers(item)]).filter(([, item]) => item !== undefined));
    return Object.keys(result).length ? result : undefined;
  }
  return undefined;
}
function numericSnapshot(key, value) {
  if (key !== 'explosion') return numbers(value);
  // 每条咏唱探针的第 3 项仅是可选日文展示：无 C 时为 null，不是数值/控制状态。
  // 明确剔除此展示列，保留所有随机调用次数、其余 null/布尔和咏唱总数。
  const chantCount = value.exports.EXPLOSION_CHANTS.length;
  return numbers({ ...value, chantCount,
    calls: value.calls.map((row, index) => index < chantCount ? row.slice(0, 2) : row) });
}
const publicAssertions = `
  for (const file of ['.env', 'data', 'resources', 'content']) assert.equal(fs.existsSync(file), false, file + ' 不得出现在公开 fixture');
  assert.equal(s.CURRENCY.name, '金币');
  assert.equal(n.resolveCasterName([], 'missing'), '施术者');
  assert.equal(n.NARRATION_EXAMPLES.length, 3);
  const narrationPrompt = n.buildNarrationPrompt();
  assert.match(narrationPrompt, /虚构/);
  assert.match(narrationPrompt, /不描述真实地点受损或真实人员伤亡/);
  assert.doesNotMatch(narrationPrompt, /\\{(?:caster|identity|finisher|examples)\\}/);
  assert.doesNotMatch(JSON.stringify(out), /合成私有标记甲/); // 私有展示文本守卫：用合成标记做 canary（真实角色名不得进入公开集）
  const { GAMEPLAY_CONTENT } = await import(new URL('./src/local-gameplay-content.js', import.meta.url));
  assert.equal(n.NARRATION_EXAMPLES, GAMEPLAY_CONTENT.narration.examples, '消费真实加载产物');
`;
const privateContent = fs.readFileSync(path.join(ROOT, 'content/local/gameplay.json'), 'utf8');
const badFile = path.join(publicFixture, 'content/local/gameplay.json');
const secret = 'PRIVATE_PAYLOAD_E:/private-local/secrets/hidden.json';
function rejection(text, message = 'local gameplay content: invalid schema') {
  fs.mkdirSync(path.dirname(badFile), { recursive: true });
  fs.writeFileSync(badFile, text);
  const result = rawRun(publicFixture, `
    try {
      await import(new URL('./src/narration.js', import.meta.url));
      console.log('UNEXPECTED_IMPORT_SUCCESS');
    } catch (error) {
      const leaked = [error.message, error.stack, String(error.cause)].some((part) => /PRIVATE_PAYLOAD|private-local|hidden\\.json/.test(part));
      console.error(JSON.stringify({ message: error.message, cause: error.cause, leaked }));
      process.exitCode = 1;
    }
  `);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { message, leaked: false });
  assert.doesNotMatch(result.stderr, /PRIVATE_PAYLOAD|private-local|hidden\.json/);
  assert.ok(!result.stderr.includes(ROOT), '不得泄露实际私库路径');
  assert.ok(!result.stderr.includes(badFile), '不得泄露内容文件路径');
}
try {
  copyTree('src'); copyTree('content/local'); copyTree('content/worlds'); copyTree('content/packs');
  copyTree('src', publicFixture, true);
  for (const dir of [fixture, publicFixture]) fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const before = run();
  for (const [key, value] of Object.entries(before)) test(`${key} 私有逐字 golden`, () => assert.equal(hash(value), GOLDEN[key]));
  let after;
  test('公开真实裁剪新进程：无内容目录，中性生成且无角色泄漏', () => { after = run(publicFixture, publicAssertions); });
  for (const key of Object.keys(GOLDEN)) test(`${key} 无 C 数值投影与有 C 一致`, () => {
    assert.ok(after, '公开探针必须实际成功');
    assert.deepEqual(numericSnapshot(key, after[key]), numericSnapshot(key, before[key]));
  });
  test('反证：公开默认混入旧角色，真实探针必须红；还原再绿', () => {
    const file = path.join(publicFixture, 'src/local-gameplay-content.js');
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("casterDefault: '施术者'"));
    try {
      fs.writeFileSync(file, source.replace("casterDefault: '施术者'", "casterDefault: '合成私有标记甲'"));
      const result = rawRun(publicFixture, probe.replace('console.log(JSON.stringify(out));', publicAssertions));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /AssertionError/);
    } finally { fs.writeFileSync(file, source); }
    run(publicFixture, publicAssertions);
  });
  test('坏 JSON：实际启动导入红且错误不泄露正文/路径', () => rejection('{"secret":"' + secret + '"', 'local gameplay content: invalid JSON'));
  const corruptions = [
    ['缺旁白节', (v) => { delete v.narration; }],
    ['旁白节为 null', (v) => { v.narration = null; }],
    ['样例类型错误', (v) => { v.narration.examples = secret; }],
    ['样例数组长度错误', (v) => { v.narration.examples = []; }],
    ['提示词不是文本', (v) => { v.narration.prompt = { secret }; }],
    ['提示词漏占位', (v) => { v.narration.prompt = secret; }],
    ['提示词未知占位', (v) => { v.narration.prompt += '{privatePath}'; }],
    ['混入数值规则', (v) => { v.weights = { secret }; }],
    ['schema 版本不符', (v) => { v.schemaVersion = 2; }],
    ['咏唱结构错误', (v) => { v.explosion.chants[0].zh = secret; }],
  ];
  for (const [name, mutate] of corruptions) test(`${name}：实际导入红且不泄露`, () => {
    const value = JSON.parse(privateContent);
    value.currency.note = secret;
    mutate(value);
    rejection(JSON.stringify(value));
  });
  test('只读一次与读取异常：模块缓存不重读，非 ENOENT 不静默降级', () => {
    // 恢复合法文件后在独立进程内改坏，已加载模块及其他消费者仍共享同一份快照。
    fs.writeFileSync(badFile, privateContent);
    const result = rawRun(publicFixture, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const url = new URL('./src/local-gameplay-content.js', import.meta.url);
      const first = await import(url);
      fs.writeFileSync(new URL('./content/local/gameplay.json', import.meta.url), 'broken');
      const again = await import(url);
      const narration = await import(new URL('./src/narration.js', import.meta.url));
      assert.equal(again.GAMEPLAY_CONTENT, first.GAMEPLAY_CONTENT);
      assert.equal(narration.NARRATION_EXAMPLES, first.GAMEPLAY_CONTENT.narration.examples);
      assert.throws(() => first.readLocalGameplayContent(() => { throw Object.assign(new Error('PRIVATE_PAYLOAD'), { code: 'EACCES', path: 'E:/private-local/hidden.json' }); }), (error) => {
        assert.equal(error.message, 'local gameplay content: read failed');
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(first.readLocalGameplayContent(() => { throw { code: 'ENOENT' }; }), first.DEFAULT_GAMEPLAY_CONTENT);
      console.log('READ_ONCE_OK');
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /READ_ONCE_OK/);
  });
} finally {
  for (const [dir, prefix] of [[fixture, '.gameplay-content-'], [publicFixture, '.gameplay-public-']]) {
    assert.equal(path.dirname(dir), path.dirname(ROOT));
    assert.ok(path.basename(dir).startsWith(prefix));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`gameplay-content: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
