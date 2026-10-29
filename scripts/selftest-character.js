/**
 * **角色:模块化生成 + 点数买卖**的判据(1.104.0 / D168)。
 *
 * ⚠️ 三层,与项目里别处一样:
 *   ① **纯函数**:价目表形状、fail closed、只做加法、保底、缺点上限、头像拼装;
 *   ② **服务**:存/读/坏值当没有;
 *   ③ **与委托内核的接线**(这是"结合"那一句的真正判据):角色修正**真的**进了 `margin`。
 */
import { loadNeutralContentFixture } from './selftest-body-rules.js';

function fakeStore() {
  const metas = new Map();
  return {
    metas,
    getMeta: (key) => (metas.has(key) ? metas.get(key) : null),
    setMeta: (key, value) => { metas.set(key, value); },
    listMetaKeys: (prefix) => [...metas.keys()].filter((k) => k.startsWith(prefix)),
  };
}

export function registerCharacterTests({ test: register, assert }) {
  let AVATAR_HEIGHT, AVATAR_WIDTH, APPEARANCE_MODULES, APPEARANCE_SLOTS, CHARACTER_MODULES, CHECK_KINDS, DEFAULT_KIT;
  let avatarFor, buildSheet, createCharacters, describeSheet, modFor, modsForPicks, moduleById, validatePicks;
  let CHARACTER_BUDGET, MAX_FLAWS, MODULE_TUNING, STAT_MAX_MOD, STAT_MIN_MOD, legalMoves, openQuest, questAction;
  let setup;
  const test = (name, check) => register(name, async () => {
    setup ??= loadNeutralContentFixture(['character', 'character-tuning', 'play/quest']).then((loaded) => {
      ({ AVATAR_HEIGHT, AVATAR_WIDTH, APPEARANCE_MODULES, APPEARANCE_SLOTS, CHARACTER_MODULES, CHECK_KINDS, DEFAULT_KIT,
        avatarFor, buildSheet, createCharacters, describeSheet, modFor, modsForPicks, moduleById, validatePicks } = loaded.character);
      ({ CHARACTER_BUDGET, MAX_FLAWS, MODULE_TUNING, STAT_MAX_MOD, STAT_MIN_MOD } = loaded['character-tuning']);
      ({ legalMoves, openQuest, questAction } = loaded['play/quest']);
    });
    await setup;
    return check();
  });
  test('角色(1.104.0):价目表**形状**不许坏 —— 只做加法、缺点倒贴、保底不占点数', () => {
    assert.ok(CHARACTER_MODULES.length >= 8, '模块要够捏');
    for (const mod of CHARACTER_MODULES) {
      assert.ok(['skill', 'flaw'].includes(mod.kind), `${mod.id} 的 kind 只能是 skill/flaw`);
      assert.ok(Number.isFinite(mod.cost) && mod.cost !== 0, `${mod.id} 的 cost 要是个非零数`);
      // ⚠️ **规矩①**:只有 skill 花钱、flaw 倒贴;反过来就是设计错了
      assert.equal(mod.kind === 'skill', mod.cost > 0, `${mod.id}:技能要花点数、缺点要倒贴`);
      for (const key of Object.keys(mod.mods)) {
        assert.ok(CHECK_KINDS.includes(key), `${mod.id} 的判定轴 ${key} 不是委托内核认的那两类`);
      }
      // ⚠️ **规矩②**:缺点必须**真的**削弱(至少一条轴是负的),否则就是白送点数
      if (mod.kind === 'flaw') {
        assert.ok(CHECK_KINDS.some((k) => Number(mod.mods[k]) < 0), `${mod.id} 是个不疼的缺点`);
      }
    }
    // 价目表只有一份:改数字只该动 character-tuning
    assert.equal(CHARACTER_MODULES.length, MODULE_TUNING.length);
    assert.deepEqual(DEFAULT_KIT, { lawful: 1, tricky: 1 });
    assert.ok(MAX_FLAWS >= 1);
    assert.ok(STAT_MIN_MOD < 0 && STAT_MAX_MOD > 0);
  });

  test('角色(1.104.0):开卡**fail closed** —— 认不出/重复/超支/缺点过量一律拒', () => {
    assert.equal(validatePicks({ picks: [] }).ok, true, '空手也能开卡(保底)');
    assert.equal(validatePicks({ picks: [] }).spent, 0);
    assert.equal(validatePicks({ picks: ['nope'] }).error, 'unknown_module');
    assert.equal(validatePicks({ picks: ['burst', 'burst'] }).error, 'duplicate_module');
    assert.equal(validatePicks({ picks: null }).ok, true, '没给 picks = 空');
    // 超支
    const all = CHARACTER_MODULES.filter((m) => m.kind === 'skill').map((m) => m.id);
    const over = validatePicks({ picks: all, budget: 1 });
    assert.equal(over.ok, false);
    assert.equal(over.error, 'overspend');
    // ⚠️ **缺点数量上限**(规矩②的对偶):只靠数值下限挡不住"堆缺点换点数"
    const flaws = CHARACTER_MODULES.filter((m) => m.kind === 'flaw').map((m) => m.id);
    const tooMany = validatePicks({ picks: flaws.slice(0, MAX_FLAWS + 1) });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error, 'too_many_flaws');
    assert.ok(tooMany.note.includes('白送'), `要说清为什么拒:${tooMany.note}`);
    assert.equal(validatePicks({ picks: flaws.slice(0, MAX_FLAWS) }).ok, true);
    // 预算本身是坏值也要拒(fail closed)
    assert.equal(validatePicks({ picks: [], budget: -1 }).error, 'bad_budget');
    assert.equal(validatePicks({ picks: [], budget: 'x' }).error, 'bad_budget');
  });

  test('角色(1.104.0):修正=**保底+加数**(只做加法)、有上下限、同一个输入逐字相同', () => {
    const empty = modsForPicks([]);
    assert.deepEqual(empty, { ...DEFAULT_KIT }, '空手 = 保底');
    const one = modsForPicks(['scout']);
    for (const kind of CHECK_KINDS) {
      assert.equal(one[kind], DEFAULT_KIT[kind] + (moduleById('scout').mods[kind] || 0),
        '算出来必须**正好是加法**(没有乘法、没有隐藏系数)');
    }
    // 上限 / 下限
    const huge = modsForPicks(CHARACTER_MODULES.filter((m) => m.kind === 'skill').map((m) => m.id));
    for (const kind of CHECK_KINDS) {
      assert.ok(huge[kind] <= STAT_MAX_MOD, `${kind} 要封顶`);
      assert.ok(huge[kind] >= STAT_MIN_MOD, `${kind} 要有下限`);
    }
    const allFlaws = modsForPicks(CHARACTER_MODULES.filter((m) => m.kind === 'flaw').map((m) => m.id));
    for (const kind of CHECK_KINDS) assert.ok(allFlaws[kind] >= STAT_MIN_MOD, '下限保住别废掉');
    // 认不出的模块在算修正时**当没有**(拒绝在 validatePicks 那一层)
    assert.deepEqual(modsForPicks(['nope']), { ...DEFAULT_KIT });
    assert.deepEqual(modsForPicks(null), { ...DEFAULT_KIT });
    // 确定性
    assert.deepEqual(modsForPicks(['burst', 'slow']), modsForPicks(['burst', 'slow']));
    // modFor(给内核用的那一个)
    assert.equal(modFor({ mods: { lawful: 3 } }, 'lawful'), 3);
    assert.equal(modFor({ mods: { lawful: 3 } }, 'tricky'), 0);
    assert.equal(modFor(null, 'lawful'), 0, '没角色卡 = 0(不猜)');
    assert.equal(modFor({}, 'lawful'), 0);
  });

  test('角色(1.104.0):建卡(名字/外观)+ **头像模块化拼出来**(纯函数、逐字相同)', () => {
    assert.equal(buildSheet({ name: '  ' }).error, 'no_name');
    assert.equal(buildSheet({ name: '阿' }).ok, true, '一个字也是名字');
    assert.equal(buildSheet({ name: 'x'.repeat(40) }).sheet.name.length, 12, '名字封顶 12 个字');
    assert.equal(buildSheet({ name: '甲', picks: ['nope'] }).error, 'unknown_module');
    assert.equal(buildSheet({ name: '甲', appearance: { hair: 'outfit_red' } }).error, 'bad_appearance',
      '外观放到错槽位也要拒');
    // 没选外观 → 每槽位给默认那件(不逼人挑,也能出图)
    const plain = buildSheet({ name: '甲', now: 1000 });
    for (const slot of APPEARANCE_SLOTS) assert.ok(plain.sheet.appearance[slot], `${slot} 要有默认`);
    assert.equal(plain.sheet.madeAt, 1000, '时间是注入的');
    // 头像:尺寸对、字符都在调色板里、同一套选择逐字相同
    const look = { hair: 'hair_red', outfit: 'outfit_blue', accessory: 'acc_hat' };
    const a = avatarFor({ appearance: look });
    const b = avatarFor({ appearance: look });
    assert.equal(a.width, AVATAR_WIDTH);
    assert.equal(a.height, AVATAR_HEIGHT);
    assert.equal(a.rows.length, AVATAR_HEIGHT);
    assert.deepEqual(a.rows, b.rows, '同一个输入 → 逐字相同的图');
    for (const row of a.rows) assert.equal(row.length, AVATAR_WIDTH, '每行宽度一致');
    // ⚠️ 模块化拼装:**换了头发,只有那几行变**(不然就不是"模块"了)
    const other = avatarFor({ appearance: { ...look, hair: 'hair_bun' } });
    assert.notDeepEqual(a.rows, other.rows, '换发型要真的换');
    const bodyRows = a.rows.slice(8);   // 衣服那一段
    assert.deepEqual(bodyRows, other.rows.slice(8), '换发型不该动衣服');
    // 认不出的外观当没给(拼装这一层不抛)
    assert.equal(avatarFor({ appearance: { hair: 'nope' } }).rows.length, AVATAR_HEIGHT);
    // 描述那句话:技能与缺点**分开**说(第一版把缺点念成"会:跑不快")
    const desc = describeSheet(buildSheet({ name: '甲', picks: ['burst', 'slow'], now: 1 }).sheet);
    assert.ok(desc.includes('会：合成模块0'), desc);
    assert.ok(desc.includes('短板：合成模块6'), desc);
    assert.ok(!desc.includes('会：合成模块0、合成模块6'), '缺点不许混进"会"里');
    assert.equal(moduleById('burst').name, '合成模块0', '必须消费合成JSON中的展示名');
    assert.equal(moduleById('slow').name, '合成模块6');
    assert.equal(describeSheet(null), '还没有角色');
  });

  test('角色(1.104.0):服务层 —— 存/读;**坏值当没有**(不猜、不抛)', () => {
    const store = fakeStore();
    const svc = createCharacters({ store, log: { warn: () => {} } });
    assert.equal(svc.get(1), null, '没建过就是没有');
    assert.equal(svc.save(0, { name: '甲' }).error, 'no_player');
    assert.equal(svc.save(1, { name: '' }).error, 'no_name');
    const saved = svc.save(1, { name: '示例甲', picks: ['burst'], appearance: { hair: 'hair_red' } });
    assert.equal(saved.ok, true);
    assert.ok(store.getMeta('character:1'), '要真的落进 meta(一人一键)');
    const back = svc.get(1);
    assert.equal(back.name, '示例甲');
    assert.deepEqual(back.mods, modsForPicks(['burst']), '读回来时修正是**现算**的');
    // 坏值:当没有,不抛
    store.setMeta('character:2', '{坏');
    assert.equal(svc.get(2), null);
    store.setMeta('character:3', JSON.stringify({ v: 1 }));   // 没名字
    assert.equal(svc.get(3), null);
    // 列表(给人看"谁是谁")
    const all = svc.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].playerId, 1);
    assert.equal(all[0].name, '示例甲');
    // 覆盖(重捏)
    assert.equal(svc.save(1, { name: '示例乙', picks: [] }).ok, true);
    assert.equal(svc.get(1).name, '示例乙');
    assert.equal(svc.all().length, 1, '重捏不许变成两张卡');
  });

  test('角色(1.104.0):⚠️ **接进委托判定** —— 同一个骰值,修正好的人结果真的不一样', () => {
    const row = { index: 1, tier: 'normal', label: '送信', reward: 1000, penalty: -100, stamina: 10 };
    const state = openQuest(row, { now: 1000, runId: 'q1' });
    assert.ok(legalMoves(state).some((m) => m.kind === 'quest.step'), '正常能推进');
    // ⚠️ 固定骰子:同一个 rng → 同一对骰子;唯一变量就是"谁在跑"
    const rng = () => 0.25;
    const weak = questAction('quest.step', state, {}, { now: 2000, rng, modFor: () => -3 });
    const strong = questAction('quest.step', state, {}, { now: 2000, rng, modFor: () => 5 });
    const w = weak.events.find((e) => e.type === 'quest_check');
    const s = strong.events.find((e) => e.type === 'quest_check');
    assert.equal(w.roll, s.roll, '骰子是同一个(所以差别只来自角色)');
    assert.equal(w.actorMod, -3);
    assert.equal(s.actorMod, 5);
    assert.equal(s.margin - w.margin, 8, '修正差多少,余量就差多少(纯加法)');
    assert.ok(s.margin > w.margin);
    // ⚠️ 不注入 = 老行为(既有调用一条都不受影响)
    const plain = questAction('quest.step', state, {}, { now: 2000, rng });
    const p = plain.events.find((e) => e.type === 'quest_check');
    assert.equal(p.actorMod, 0);
    assert.equal(p.mod, p.stepMod);
    // 注入的那个会被**如实记进库**(落 dc/roll 是既有纪律,现在连"谁的修正"也落)
    assert.ok(Number.isFinite(s.actorMod) && Number.isFinite(s.mod));
    // 认不出的轴 = 0(不猜)
    const weird = questAction('quest.step', state, {}, { now: 2000, rng, modFor: () => Number.NaN });
    assert.equal(weird.events.find((e) => e.type === 'quest_check').actorMod, 0);
  });
}
