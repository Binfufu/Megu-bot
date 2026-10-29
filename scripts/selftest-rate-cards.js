/**
 * **¥ 记账价目卡判据**(2026-10-15,主人核定价目 + 全局 skill `model-cost-accounting`)。
 *
 * 这个 suite 存在的理由:**成本算错的形状几乎都是"不报错"的** ——
 * 币种混了、档位写死了、折扣叠了两次、未知当零了,代码全都照跑,报表照样出数。
 * 所以每条纪律都要有判据,而且要能**在改回去时当场红**。
 */

import {
  ACCOUNTING_CURRENCY, CN_PUBLIC_HOLIDAYS, OFF_PEAK_DISCOUNT, PEAK_WINDOWS_UTC,
  RATE_CARDS, USD_TO_CNY,
  chinaDateKey, estimateCostCny, rateCardFor, rateFor, rateToCny, resolveRateTier, validateRateCard,
} from '../src/usage-account.js';

/**
 * 固定但**可复算**的三个时刻 —— 不写死日期(那样明年就腐烂),而是从两个已知锚点派生。
 * ⚠️ 判断依据只有两条**规则**(周一~周五的 UTC 两段 = 峰时;周末/法定假日整天错峰),
 *    日期怎么算出来的写在断言里,读的人能自己复算。
 */
const ANCHOR_WED_PEAK = Date.UTC(2026, 9, 14, 2, 0);   // 2026-10-14 周三 02:00Z(在官方 01–04 段内)
const ANCHOR_SAT_PEAK = Date.UTC(2026, 9, 17, 2, 0);   // 2026-10-17 周六 02:00Z(时段同峰、但周末整天错峰)
const WED_PEAK = ANCHOR_WED_PEAK;
const SAT_OFF = ANCHOR_SAT_PEAK;
const WED_OFF = ANCHOR_WED_PEAK + 10 * 3600 * 1000;    // 同一天 12:00Z(两个峰窗之外)
const HOLIDAY_OFF = Date.UTC(2026, 9, 1, 2, 0);        // 2026-10-01 国庆 02:00Z

export function registerRateCardTests({ test, assert }) {
  test('价目币种:名义货币 ≠ 结算货币 —— 中转站标 $ 但按 ¥1:1 扣,官方直连才是真美元', () => {
    // ① 官方直连:标的就是美元 ⇒ 折 ¥ 要乘汇率(隐藏汇率那类错会差 ≈6.7 倍)。
    const flash = rateCardFor('deepseek-flash');
    assert.equal(flash.billedCurrency, 'USD');
    assert.equal(flash.usdToBilled, USD_TO_CNY);
    const flashCny = rateToCny(rateFor('deepseek-flash', { at: WED_PEAK }));
    assert.equal(flashCny.currency, ACCOUNTING_CURRENCY);
    assert.equal(Number(flashCny.cacheMiss.toFixed(4)), Number((0.3 * USD_TO_CNY).toFixed(4)));
    // ② 中转站:页面标 $、实际扣 ¥(1:1)⇒ **不乘汇率**。
    const grok = rateCardFor('grok-4.5');
    assert.equal(grok.listCurrency, 'USD', '页面标的还是 $');
    assert.equal(grok.billedCurrency, 'CNY', '但结算币种是 ¥');
    assert.equal(grok.usdToBilled, 1, '1:1 —— 乘汇率就是把成本凭空虚增 6.7 倍');
    assert.equal(rateToCny(rateFor('grok-4.5', { at: WED_PEAK })).cacheMiss, 0.3);
    // ③ 记账币种只有一个:两条路的折钱结果都是 ¥ 口径(否则根本不能相减)。
    assert.equal(ACCOUNTING_CURRENCY, 'CNY');
    assert.equal(estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, cacheMissTokens: 1e6 }).currency, 'CNY');
    assert.equal(estimateCostCny({ model: 'grok-4.5', at: WED_PEAK, cacheMissTokens: 1e6 }).currency, 'CNY');
  });

  test('峰谷按调用时刻派生:周末/节假日整天错峰;官方错峰 = 峰时一半;不判时刻的写法当场红', () => {
    // ⚠️ 反证:把 `resolveRateTier` 改回"恒 peak" ⇒ 下面三条 offPeak 断言全红。
    // 先钉住"这几个锚点真的落在它们该落的星期/时刻上"(判据自己的前提,别把日历记错)。
    assert.equal(new Date(WED_PEAK).getUTCDay(), 3, '锚点必须是周三');
    assert.equal(new Date(SAT_OFF).getUTCDay(), 6, '锚点必须是周六');
    assert.equal(new Date(HOLIDAY_OFF).getUTCMonth(), 9, '国庆锚点必须在 10 月');
    assert.equal(resolveRateTier(WED_PEAK), 'peak', '周三 02:00Z 落在官方 01–04 段');
    assert.equal(resolveRateTier(WED_OFF), 'offPeak', '同一天 12:00Z 不在任何峰窗');
    assert.equal(resolveRateTier(SAT_OFF), 'offPeak', '周末整天错峰(时段同峰也不算)');
    assert.equal(resolveRateTier(HOLIDAY_OFF), 'offPeak', '国庆整天错峰');
    assert.equal(PEAK_WINDOWS_UTC.length, 2);
    assert.equal(OFF_PEAK_DISCOUNT, 0.5, '官方原话:off-peak = half of peak');
    // 官方直连:同一发用量,错峰正好是峰时的一半。
    const peak = estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, cacheMissTokens: 1e6 }).cny;
    const off = estimateCostCny({ model: 'deepseek-flash', at: SAT_OFF, cacheMissTokens: 1e6 }).cny;
    assert.equal(Number(off.toFixed(6)), Number((peak / 2).toFixed(6)),
      '周末半价必须**真的**折到账上 —— 写死峰时会把低峰账高估 2 倍');
    // 中国日历判"哪一天":UTC+8 的日期才是节假日口径。
    assert.equal(chinaDateKey(Date.UTC(2026, 8, 30, 17, 0)), '2026-10-01', 'UTC 17:00 = 北京次日 01:00');
    assert.ok(CN_PUBLIC_HOLIDAYS.includes('2026-10-01'));
    // 时刻取不到要**显式给**,不许拿"现在"来猜(账要能重放)。
    assert.throws(() => resolveRateTier(undefined), /epoch 毫秒/);
  });

  test('折扣不许叠两次:中西两家的价目形状不同 —— 官方按时刻折,中转站**显式没有**折', () => {
    // 官方:价目卡里存的是**峰时价**,折扣由档位给 ⇒ 峰时因子 1、错峰 0.5。
    assert.equal(rateFor('deepseek-flash', { at: WED_PEAK }).factor, 1);
    assert.equal(rateFor('deepseek-flash', { at: SAT_OFF }).factor, 0.5);
    // 中转站:没有错峰政策 ⇒ factor 恒 1(不是"忘了填"而是显式 null),并留一句说明。
    const grokPeak = rateFor('grok-4.5', { at: WED_PEAK });
    const grokOff = rateFor('grok-4.5', { at: SAT_OFF });
    assert.equal(grokPeak.factor, 1);
    assert.equal(grokOff.factor, 1, '没有折扣政策就不许凭时刻打折(那会凭空少一半成本)');
    assert.equal(grokOff.cacheMiss, grokPeak.cacheMiss);
    assert.match(grokOff.note, /没有错峰政策/);
    // ⚠️ 反证锚点:真被叠两次的话,这里的比会是 0.25 而不是 0.5。
    const a = estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, cacheMissTokens: 1e6 }).cny;
    const b = estimateCostCny({ model: 'deepseek-flash', at: SAT_OFF, cacheMissTokens: 1e6 }).cny;
    assert.ok(Math.abs(b / a - 0.5) < 1e-9, `错峰/峰时必须正好 0.5(现在 ${(b / a).toFixed(4)})`);
  });

  test('未知 = null,不许计零:没核过的模型/坏用量都不出钱数', () => {
    // ④ 这是全 suite 最重要的一条 —— 计零的报表永远"便宜"。
    assert.equal(rateCardFor('gpt-9-unknown'), null);
    assert.equal(estimateCostCny({ model: 'gpt-9-unknown', at: WED_PEAK, cacheMissTokens: 1e6 }), null,
      '未知模型必须返回 null(反证:改成返回 0 或抛错,这条红)');
    assert.equal(estimateCostCny({ at: WED_PEAK, cacheMissTokens: 1e6 }), null, '没给模型也不许猜一个');
    // 坏用量(负数/NaN/非数)同样不出钱数,而不是当 0 算。
    assert.equal(estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, cacheMissTokens: -1 }), null);
    assert.equal(estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, outputTokens: Number.NaN }), null);
    assert.equal(estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, cacheMissTokens: Number.POSITIVE_INFINITY }), null,
      '∞ 也不是钱');
    assert.equal(estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, cacheMissTokens: 'abc' }), null,
      '认不出的字符串不当 0');
    // ⚠️ 但"字符串数字"是**合法**的(`Number('1e6') === 1e6`)—— 第一版我在这里写反了期望。
    assert.equal(estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK, cacheMissTokens: '1000000' }).cny, 2.01);
    // 但**真零用量**是合法的(一轮确实没花钱),要算成 0 而不是 null。
    const zero = estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK });
    assert.equal(zero.cny, 0);
  });

  test('价目卡自检:每条都必须带出处与 asOf;缓存命中不许比未命中贵(那是在吼"抄错列了")', () => {
    for (const card of RATE_CARDS) {
      assert.deepEqual(validateRateCard(card), [], `${card.model} 的价目卡不完整`);
      assert.match(card.source, /\S/, '每条价目都要说得清出处');
      assert.match(card.asOf, /^\d{4}-\d{2}-\d{2}$/, 'asOf 要能写进结论("按哪天核的表")');
    }
    // 主人这次给的九张都在册(不是"抄了一部分")。
    const models = RATE_CARDS.map((c) => c.model).sort();
    assert.deepEqual(models, ['deepseek-flash', 'deepseek-v4-pro', 'gemini-3-flash', 'gemini-3.8-flash',
      'grok-4.5', 'grok-4.6', 'grok-4.7', 'grok-4.7-build-fast', 'grok-build-0.1'].sort());
    // 缓存命中必须便宜于未命中 —— 这条是**抓抄错列**的。
    const bad = { ...RATE_CARDS[0], model: 'x', billedPrice: { cacheHit: 9, cacheMiss: 1, output: 1 } };
    assert.match(validateRateCard(bad).join('|'), /cacheHit 比 cacheMiss 还贵/);
    assert.match(validateRateCard({}).join('|'), /缺 model|价目卡必须是对象/);
    // 前缀匹配认得变体(价目页上那些 `-build-fast` 尾巴)。
    assert.equal(rateCardFor('grok-4.7-build-fast').model, 'grok-4.7-build-fast', '精确优先于前缀');
    assert.equal(rateCardFor('grok-4.7-2026xxxx').model, 'grok-4.7');
  });

  test('缓存读取档:主人 2026-10-16 当页复读确认回位;"没核过回落"机制仍由合成卡钉着', () => {
    // ⚠️ **1.150.75 翻案**:1.150.74 曾把这两行的 0.15/0.03 改记 `cacheWrite`,理由是
    //    "按'缓存读取'填会命中比输入贵" —— 那个理由**算术上不成立**(0.15<0.6、0.03<0.15,
    //    "命中>未命中"指纹对这两行从来没红过)。主人 2026-10-16 复读价目页:读取档就是这两个数。
    for (const [model, hit, miss] of [['grok-4.7-build-fast', 0.15, 0.6], ['grok-build-0.1', 0.03, 0.15]]) {
      const card = rateCardFor(model);
      assert.equal(card.billedPrice.cacheHit, hit, `${model} 的读取档 = 主人确认值`);
      assert.ok(card.billedPrice.cacheHit < card.billedPrice.cacheMiss, `${model} 命中必须便宜于未命中`);
      assert.equal(card.cacheWrite, undefined, `${model} 不许再挂一个推出来的写入价(没核对过就不许有)`);
      assert.equal(card.asOf, '2026-10-16', '翻案要写明按哪天核的表');
      const rate = rateFor(model, { at: WED_PEAK });
      assert.equal(rate.cacheHit, hit, '折钱按确认值走');
      assert.equal(rate.cacheHitAssumed, false, '有主人真值就不许标"假设"');
    }
    // "没核过 ⇒ 回落输入价 + 标假设"这套**机制保留**(以后还会有没核过的档),换合成卡钉着:
    const real = rateCardFor('grok-4.7-build-fast');
    const synthetic = { ...real, model: 'synthetic-unverified',
      listPrice: { cacheHit: null, cacheMiss: 0.6, output: 1.8 },
      billedPrice: { cacheHit: null, cacheMiss: 0.6, output: 1.8 } };
    const assumed = rateFor('x', { at: WED_PEAK, card: synthetic });
    // ⚠️ 核心:回落**输入价**,不许当 0(当 0 = 白送缓存)、也不许当"比输入便宜"(没核过)。
    assert.equal(assumed.cacheHit, 0.6, '没核过 ⇒ 按输入价算(宁可高估)');
    assert.equal(assumed.cacheHitAssumed, true, '要能看出"这一档是假设出来的"');
    assert.equal(rateFor('deepseek-flash', { at: WED_PEAK }).cacheHitAssumed, false, '有真值的档不许标假设');
    // 坏形状照旧要报(都用合成卡,不碰真卡):cacheWrite 非正数、命中比未命中贵。
    assert.match(validateRateCard({ ...synthetic, model: 'x', cacheWrite: 0 }).join('|'), /cacheWrite 必须是正数/);
    assert.match(validateRateCard({ ...synthetic, model: 'y', billedPrice: { cacheHit: 9, cacheMiss: 0.6, output: 1.8 } }).join('|'), /cacheHit 比 cacheMiss 还贵/);
  });

  test('别名:deepseek-chat = deepseek-flash(主人2026-10-16确认同模型 + identify回显证据),不许折成unknown', () => {
    // 主人 2026-10-16 指认 deepseek-chat 就是 DSF-V4.1;API 实测(identify)请求 deepseek-chat
    // 得 200 且回显 deepseek-flash —— 别名成立 ⇒ own 侧账本记这个名字也必须折得出钱。
    const card = rateCardFor('deepseek-chat');
    assert.ok(card, '别名必须找得到卡(否则 own 每发 unknown,挡死阶段4 结论)');
    assert.equal(card.model, 'deepseek-flash', '别名落到 flash 卡');
    const priced = estimateCostCny({ model: 'deepseek-chat', at: WED_PEAK,
      cacheMissTokens: 1000, cacheHitTokens: 500, outputTokens: 10 });
    const direct = estimateCostCny({ model: 'deepseek-flash', at: WED_PEAK,
      cacheMissTokens: 1000, cacheHitTokens: 500, outputTokens: 10 });
    assert.ok(priced && priced.cny > 0, '别名模型要折得出钱');
    assert.equal(priced.cny, direct.cny, '同一发用量,别名与本体必须同一个数(同模型同价行)');
    // 边界:别名只认**整名**,不参与前缀匹配,大小写不豁免 —— 页面原样纪律。
    assert.equal(rateCardFor('deepseek-chat-2026'), null);
    assert.equal(rateCardFor('DEEPSEEK-CHAT'), null);
  });

  test('真实用量折钱:同一发用量在两条路上的钱数能直接比(这就是阶段4要的那把尺)', () => {
    // 用一批同形用量,分别按官方 flash 与中转站 grok 折 ¥ —— 比的是同一个记账币种。
    const usage = { cacheMissTokens: 3000, cacheHitTokens: 100_000, outputTokens: 500 };
    const flash = estimateCostCny({ model: 'deepseek-flash', at: WED_OFF, ...usage });
    const grok = estimateCostCny({ model: 'grok-4.5', at: WED_OFF, ...usage });
    assert.ok(flash.cny > 0 && grok.cny > 0);
    // 手算核对(防"公式对但口径错"):flash 错峰 miss ¥1.005/M、hit ¥0.0201/M、out ¥4.02/M。
    const expectFlash = (3000 * 1.005 + 100_000 * 0.0201 + 500 * 4.02) / 1_000_000;
    assert.equal(Number(flash.cny.toFixed(9)), Number(expectFlash.toFixed(9)),
      '错峰口径的价格必须一条条对得上(不是"差不多")');
    // 中转站没有折扣 ⇒ 同一发在周末也是原价(与 peak 时刻一模一样)。
    assert.equal(grok.cny, estimateCostCny({ model: 'grok-4.5', at: WED_PEAK, ...usage }).cny);
  });
}
