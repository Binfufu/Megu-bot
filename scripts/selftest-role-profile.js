/**
 * **角色口径严格化 + 提示词串味清理**(P4,2026-10-28)回归。
 *
 * 要治的三件事(全部来自真实体感:"机械体角色会照着旧默认角色的设定演"):
 *   ① 主题拼错**静默退回旧默认角色** —— 现在非空未知主题当场抛;未写/空串仍是旧默认角色默认;
 *   ② 身体状态行不按玩法闸给提示 —— 合成主题也会收到不属于它的技能说明;
 *   ③ 涨跌行两处调用没传主题 —— 合成甲乙资源标签会混用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadNeutralContentFixture } from './selftest-body-rules.js';

const BASE_STATS = { satiety: 50, health: 80, mood: 60, stamina: 70, mana: 80, money: 120 };

export function registerRoleProfileTests({ test: register, assert: a }) {
  let BODY_THEMES, getBodyTheme, MOOD_THEMES, getMoodTheme, describeForPrompt, describeForUser, renderStatDeltas;
  let setup;
  const test = (name, check) => register(name, async () => {
    setup ??= loadNeutralContentFixture(['body-theme', 'mood', 'stats']).then((loaded) => {
      ({ BODY_THEMES, getBodyTheme } = loaded['body-theme']);
      ({ MOOD_THEMES, getMoodTheme } = loaded.mood);
      ({ describeForPrompt, describeForUser, renderStatDeltas } = loaded.stats);
    });
    await setup;
    return check();
  });
  test('主题取值:未写/空串仍按旧默认角色(旧行为)，非空拼错当场抛(不再静默串味)', () => {
    a.equal(getBodyTheme(undefined), BODY_THEMES.megumin);
    a.equal(getBodyTheme(''), BODY_THEMES.megumin);
    a.equal(getBodyTheme(null), BODY_THEMES.megumin);
    a.equal(getBodyTheme('aris'), BODY_THEMES.aris);
    a.throws(() => getBodyTheme('ariss'), /未知身体主题/, '拼错必须大声失败');
    a.equal(getMoodTheme(undefined), MOOD_THEMES.megumin);
    a.equal(getMoodTheme(''), MOOD_THEMES.megumin);
    a.equal(getMoodTheme('aris'), MOOD_THEMES.aris);
    a.throws(() => getMoodTheme('Aris'), /未知情绪主题/, '大小写拼错也算不认识');
    a.equal(getBodyTheme('megumin').label, '合成身体主题0');
    a.equal(getBodyTheme('aris').label, '合成身体主题1');
  });

  test('身体状态行:合成技能/钱两条约束按玩法闸给，机械体不再收到串味要求', () => {
    const megumin = describeForPrompt(BASE_STATS, BODY_THEMES.megumin, { explosionEnabled: true, moneyEnabled: true });
    a.match(megumin, /合成技能可以使用/);
    a.match(megumin, /钱/);
    // 关掉技能:只报合成资源,不写技能可用/不足说明。
    const noExplosion = describeForPrompt(BASE_STATS, BODY_THEMES.aris, { explosionEnabled: false, moneyEnabled: true });
    a.doesNotMatch(noExplosion, /合成技能可以使用|合成技能能量不足/, '关掉玩法就不许再提合成技能');
    a.match(noExplosion, /合成1mana/, '资源值本身照报(合成乙口径)');
    // 关掉钱:整行不给(含"别装穷"那句行为约束)。
    const noMoney = describeForPrompt(BASE_STATS, BODY_THEMES.aris, { explosionEnabled: false, moneyEnabled: false });
    a.doesNotMatch(noMoney, /钱/, '没有货币概念就不给钱那一行');
    a.doesNotMatch(noMoney, /装穷/);
    // 默认参数 = 旧行为(两样都开)。
    const defaults = describeForPrompt(BASE_STATS, BODY_THEMES.megumin);
    a.match(defaults, /合成技能可以使用/);
    a.match(defaults, /钱/);
    a.equal(defaults, megumin, '默认两闸与显式开启逐字一致');
    a.match(defaults, /钱 120 合成币/);
    const lowEnergy = describeForPrompt({ ...BASE_STATS, mana: 1 }, BODY_THEMES.megumin, { explosionEnabled: true, moneyEnabled: false });
    a.match(lowEnergy, /合成技能能量不足（需要55）/, '合成玩法低能量文案与既有消耗数值均须到达');
  });

  test('涨跌行:同一笔变化在两个主题下用各自口径的标签', () => {
    const deltas = [{ manaDelta: 20, staminaDelta: -5 }];
    const megumin = renderStatDeltas(deltas, { theme: BODY_THEMES.megumin });
    a.match(megumin, /甲储能\+20/);
    a.match(megumin, /甲体力-5/);
    const aris = renderStatDeltas(deltas, { theme: BODY_THEMES.aris });
    a.match(aris, /乙储能\+20/, `实际 ${aris}`);
    a.match(aris, /乙体力-5/, `实际 ${aris}`);
    a.doesNotMatch(aris, /甲储能|甲体力/, '机械体口径里不许出现旧默认角色的词');
    // 不传 theme = 旧默认(megumin) —— 兼容,但生产调用点必须显式传(wiring 钉着)。
    a.match(renderStatDeltas(deltas), /甲储能/);
    a.equal(megumin, '[甲体力-5 甲储能+20]');
    a.equal(aris, '[乙体力-5 乙储能+20]');
  });

  test('wiring:index 两处涨跌行都传主题、状态行传玩法闸、config 有权重开关(扫源码)', () => {
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    // 涨跌行:两处调用都必须带 theme。
    const deltaCalls = indexSource.match(/renderStatDeltas\([^)]*\)/g) ?? [];
    a.ok(deltaCalls.length >= 2, `应有至少两处涨跌行调用,实际 ${deltaCalls.length}`);
    for (const call of deltaCalls) {
      a.match(call, /theme: getBodyTheme\(config\.policy\.stats\.theme\)/, `涨跌行必须传本实例主题:${call}`);
    }
    // 状态行:技能/钱两闸都要从配置来。
    a.match(indexSource, /explosionEnabled: config\.policy\.explosion\.enabled/, '技能约束按玩法开关');
    a.match(indexSource, /moneyEnabled: config\.policy\.stats\.money/, '钱那一行按实例开关');
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    a.match(configSource, /asBool\('QQBOT_STATS_MONEY', true\)/, '钱开关默认开(旧默认角色行为不变)');
  });

  test('报数目标解耦:口径跟"目标"走(名字+身体主题),兜底也用目标主题', () => {
    // 兜底那一路是纯函数:`describeForUser` 传目标主题时,措辞必须是目标的。
    const arisWords = describeForUser(BASE_STATS, { theme: BODY_THEMES.aris });
    a.match(arisWords, /乙饱食/, `实际 ${arisWords}`);
    a.doesNotMatch(arisWords, /甲饱食/, '目标若按合成乙口径,兜底不许出现甲饱食');
    const meguminWords = describeForUser(BASE_STATS, { theme: BODY_THEMES.megumin });
    a.match(meguminWords, /甲饱食/);
    // 装配侧:名字与主题都从配置来,且两处兜底都用 targetTheme。
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    const fnStart = indexSource.indexOf('async function sendScanReport(');
    const fnBody = indexSource.slice(fnStart, fnStart + 3200);
    a.match(fnBody, /const targetTheme = getBodyTheme\(config\.policy\.reportTargetTheme\)/, '目标主题从配置来');
    a.match(fnBody, /const targetName = config\.policy\.reportTargetName/, '目标名字从配置来');
    a.match(fnBody, /你要对「\$\{targetName\}」做一次身体数值扫描/, '播报对象必须用目标名,不许写死旧默认角色');
    a.match(fnBody, /longLabelFor\('satiety', targetTheme\)/, '事实标签用目标口径');
    const fallbacks = fnBody.match(/theme: targetTheme/g) ?? [];
    a.equal(fallbacks.length, 2, `两条兜底都必须用目标主题,实际 ${fallbacks.length}`);
    a.doesNotMatch(fnBody, /theme: getBodyTheme\(config\.policy\.stats\.theme\)/, '报数者自己的主题不许再出现在兜底里');
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    a.match(configSource, /raw\('QQBOT_REPORT_TARGET_NAME'\) \?\? LOCAL_MOOD_BODY_CONTENT\?\.config\.reportTargetName \?\? '示例助手'/, '目标名严格按显式配置→本地内容→中性默认取值');
    a.match(configSource, /raw\('QQBOT_REPORT_TARGET_THEME'\) \?\? 'megumin'/, '目标主题默认=现有行为');
  });

  test('病程闸:机械体实例可关（随机/坏食物/委托三条路同一闸），默认开', () => {
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    // 单点闸:tryCatchIllness 入口 + illnessTick 入口。
    const catchStart = indexSource.indexOf('function tryCatchIllness(');
    const catchBody = indexSource.slice(catchStart, catchStart + 400);
    a.match(catchBody, /config\.policy\.stats\.illness === false/, '掷病入口必须有闸');
    const tickStart = indexSource.indexOf('async function illnessTick(');
    const tickBody = indexSource.slice(tickStart, tickStart + 400);
    a.match(tickBody, /config\.policy\.stats\.illness === false/, '病程 tick 也要被闸住');
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    a.match(configSource, /asBool\('QQBOT_STATS_ILLNESS', true\)/, '病程开关默认开(旧默认角色行为不变)');
  });
}
