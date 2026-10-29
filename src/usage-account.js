/**
 * **usage 记账与对账口径**(2026-10-14,`docs\21` §十二 成本账第三版 / 刀三B 影子对账用)。
 *
 * ## 为什么要有这个文件
 *
 * "old DSH 估的值"与"自有引擎的真值"要用**同一把尺**量,否则对账本身就成了第二份口径(D159)。
 * 这份尺子量三件事:
 *  · **DSH 侧**(旧路):会话文件里每条 `assistant/message` 的 `usage`(`inputTokens` 新增输入 /
 *    `cacheReadTokens` 缓存命中 / `outputTokens` / `reasoningTokens`);
 *  · **自有侧**(刀三B):`conversation_turn.meta.usage`(`promptTokens` / `completionTokens` /
 *    `cacheHitTokens` / `cacheMissTokens`,来自 `llm.js` 的真 usage);
 *  · **钱**:按官方价把 token 折成美元(峰时/错峰两档)。
 *
 * ## 判据(docs\21 §十二 成本账第二版**修正后**的口径,不是第一版那句"省 2/3")
 *
 *   ① **加权单轮 ≤ 现状**(把暖轮/冷轮按真实比例混起来算);② **暖轮 ≤ 现状一半**。
 * 两条同时成立才算"自研确实便宜";冷缓存轮贵 2~3.7 倍是已知事实,不假装它不存在。
 *
 * ⚠️ 价格是**官方现价**(2026-10-14 取自 api-docs.deepseek.com,deepseek-flash 峰时:
 * 命中 $0.006/M、未命中 $0.30/M、输出 $1.20/M;错峰 = 峰时一半)。上游随时可改价 ——
 * 改价只需改这张表,判据跟着走。
 */

/** DSH 会话文件里 usage 的四个字段(顺序即报表顺序)。 */
export const DSH_USAGE_FIELDS = Object.freeze(['inputTokens', 'cacheReadTokens', 'outputTokens', 'reasoningTokens']);

/** 官方价(美元 / 1M token)。**峰时**;错峰 = 一半。
 *  ⚠️ 这是**旧口径**(只服务 `estimateCost`/`compareVerdict` 那两条路)。
 *  新口径走下面的 **¥ 记账价目卡**(`RATE_CARDS`)—— 见那一节的四条纪律。 */
export const PRICES = Object.freeze({
  peak: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }),
  offPeak: Object.freeze({ cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }),
});

// ===========================================================================
// **¥ 记账价目卡**(2026-10-15,主人核定;口径规则见全局 skill `model-cost-accounting`)
//
// 为什么另起一张而不是改 `PRICES`:旧表被既有判据钉着(错峰 = 峰时一半),动它会连坐;
// 而新表的**记账币种、档位派生、模型键**三件事都得换口径 —— 换口径不该去改旧尺子。
//
// 四条纪律(违反了就会算出"像钱的东西"):
//   ① **名义货币 ≠ 结算货币** —— 中转站标 `$` 但实际扣 ¥(1:1)。价目卡同时存
//      `listPrice`(页面原样)+ `billedCurrency`(真实结算),**一律换算到 ¥ 再比**。
//      ⚠️ 隐藏汇率最毒:把人民币数字当美元用 ⇒ 成本差 ≈6.7 倍,而且**不报错**。
//   ② **峰谷按调用时刻派生**(`resolveRateTier`),不许写死高档 —— 官方错峰是半价,
//      写死峰时会把低峰时段的账高估最多 2×。
//   ③ 每条价目带 **`source` + `asOf`** —— 上游会调价、会换模型,结论必须能说清按哪张表。
//   ④ **未知 = null**,不许计零(计零的报表永远"便宜"),也不许把 provider 标称的
//      **能力上限**当成**生产容量上限**。
// ===========================================================================

/** 记账币种:本项目的成本一律折到这一个币种再比(主人 2026-10-15 定)。 */
export const ACCOUNTING_CURRENCY = 'CNY';

/** USD → CNY 换算系数。**只用于"标的就是美元"的官方直连价**;
 *  ⚠️ **不适用于**"标 $ 实际扣 ¥"的中转站(那种是 1:1,`billedCurrency: 'CNY'` + `usdToBilled: 1`)。 */
export const USD_TO_CNY = 6.7;

/**
 * 官方错峰规则(DeepSeek 2026-10-15 英文页原话,取 UTC):
 * *Off-peak rates are half of the peak rates. Peak hours are 01:00–04:00 and
 * 06:00–10:00 UTC, Monday through Friday, excluding Chinese public holidays.*
 * ⇒ 每段是 `[起, 止)` 的 UTC 小时;周一=1。
 */
export const PEAK_WINDOWS_UTC = Object.freeze([
  { fromHour: 1, toHour: 4 },   // 01:00–04:00 UTC
  { fromHour: 6, toHour: 10 },  // 06:00–10:00 UTC
]);
export const PEAK_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]); // 周一~周五

/** 折扣策略:错峰 = 峰时 × 0.5(官方现价)。判据里凡"错峰"都要走这里,不许手写 0.5。 */
export const OFF_PEAK_DISCOUNT = 0.5;

/**
 * 中国法定节假日(YYYY-MM-DD,UTC+8 日期;**这些日子整天错峰**)。
 *
 * ⚠️ **要每年核对更新** —— 不在这张表里的年份按"不放假"算(那几个 UTC 段仍算峰时)。
 *    宁可漏(高估成本)也不要猜(猜低会得出假的"便宜")。官方原文把"Chinese public
 *    holidays"整段排除在峰时之外,所以放假日的判定是**成本口径的一部分**,不是附加功能。
 */
export const CN_PUBLIC_HOLIDAYS = Object.freeze([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-21', '2026-02-22', '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21', '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);

/** 北京时间(UTC+8)的 `YYYY-MM-DD` —— 假日的自然语言日期是中国的,判它要按中国日历。 */
export function chinaDateKey(ms) {
  return new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 这次调用落在**哪一档**(纯函数,输入是时刻)。
 * @param {number} ms epoch 毫秒
 * @returns {'peak'|'offPeak'}
 */
export function resolveRateTier(ms, options = {}) {
  const at = Number(ms);
  if (!Number.isFinite(at)) throw new Error('resolveRateTier: 时刻必须是 epoch 毫秒(取不到就显式给,别猜)');
  const holidays = options.holidays ?? CN_PUBLIC_HOLIDAYS;
  const windows = options.windows ?? PEAK_WINDOWS_UTC;
  const weekdays = options.weekdays ?? PEAK_WEEKDAYS;
  if (holidays.includes(chinaDateKey(at))) return 'offPeak';
  const date = new Date(at);
  if (!weekdays.includes(date.getUTCDay())) return 'offPeak'; // 周末整天错峰
  const hour = date.getUTCHours();
  return windows.some((w) => hour >= w.fromHour && hour < w.toHour) ? 'peak' : 'offPeak';
}

/**
 * 一张价目卡要满足的形状(判据也按这个查 —— 少了字段就是"没核过",不是"默认值")。
 */
export function validateRateCard(card) {
  const problems = [];
  const rate = (v) => Number.isFinite(v) && v >= 0;
  if (!card || typeof card !== 'object') return ['价目卡必须是对象'];
  for (const key of ['model', 'billedCurrency', 'listPrice', 'billedPrice', 'source', 'asOf']) {
    if (card[key] === undefined || card[key] === null || card[key] === '') problems.push(`缺 ${key}`);
  }
  if (!rate(card.usdToBilled)) problems.push('usdToBilled 必须是数(1 = 标 $ 按 ¥1:1 扣)');
  for (const key of ['cacheHit', 'cacheMiss', 'output']) {
    // `cacheHit: null` 是**允许**的:意思是"这一档没核过"(见 `rateFor` 的回落注释),
    // 但 `cacheMiss` / `output` 必须有值 —— 那两个是成本的主项,不能空着。
    if (key === 'cacheHit') {
      if (card.listPrice?.[key] !== null && !rate(card.listPrice?.[key])) problems.push('listPrice.cacheHit 必须是数或 null');
      if (card.billedPrice?.[key] !== null && !rate(card.billedPrice?.[key])) problems.push('billedPrice.cacheHit 必须是数或 null');
      continue;
    }
    if (!rate(card.listPrice?.[key])) problems.push(`listPrice.${key} 必须是数`);
    if (!rate(card.billedPrice?.[key])) problems.push(`billedPrice.${key} 必须是数`);
  }
  // 缓存命中必须**便宜于**未命中 —— 反了就是抄错列(中转站页面上真出现过)。
  // `cacheHit: null` 不算抄错(那是"这一档没核过"),只要别填成比未命中还贵的数。
  if (rate(card.billedPrice?.cacheHit) && rate(card.billedPrice?.cacheMiss)
    && card.billedPrice.cacheHit > card.billedPrice.cacheMiss) {
    problems.push('billedPrice.cacheHit 比 cacheMiss 还贵 —— 缓存命中不该比未命中贵,先回查价目页的列');
  }
  // 「缓存写入」如果给了,必须是**正数**(它是另一件事,可以比输入贵;0 不是"免费",是没填对)。
  if (card.cacheWrite !== undefined && !(Number.isFinite(card.cacheWrite) && card.cacheWrite > 0)) {
    problems.push('cacheWrite 必须是正数');
  }
  // ⚠️ `provider`(谁在收钱)与 `providerHint`(我们 .env 里的配置标签)本来就可以不同
  //    —— 例如官方直连 provider=deepseek、配置写的是 deepseek-official。**不算问题**。
  return problems;
}

/**
 * **价目卡**(¥ 记账 / 1M token;`listPrice` 是页面原样、`billedPrice` 是真实结算)。
 *
 * | model | provider | listPrice(页面) | 结算 | source / asOf |
 * |---|---|---|---|---|
 * | deepseek-flash / deepseek-v4-pro | deepseek(官方) | $ 峰时 | **$ 真美元**(×USD_TO_CNY 折 ¥) | 主人 2026-10-15 截图 + 官方英文页(同次核对) |
 * | grok-* / gemini-* | longapi(中转站) | $ 标注 | **¥ 1:1** | 主人 2026-10-15 截图(两张) |
 *
 * ⚠️ **待主人确认一处**:中转站那几张的 `listPrice` 与 `billedPrice` 我按**同一个数**填
 *    (判据:`billedPrice = listPrice × usdToBilled`,grok 系 `usdToBilled=1`)。
 *    也就是说 `$2/1M` 理解为 **¥2/1M**。**若真实是"$2 按汇率折 ¥",表里只改 `usdToBilled`**
 *    —— 结构不用动、逐发账不用重采,这也是把两件事分开存的价值。
 */
const OFFICIAL_FLASH = Object.freeze({
  model: 'deepseek-flash', provider: 'deepseek', providerHint: 'deepseek-official',
  // **别名**(2026-10-16 主人确认 deepseek-chat = DSF-V4.1 同模型;identify 实测请求 deepseek-chat
  // 得 200 且回显 deepseek-flash,证据 data/index/model-identify-2026-10-16T10-17-32-335Z.json)。
  // ⚠️ 别名只解"名字那一层";价格身份的最终确认仍是账单核对(缓存探针那两发)。
  aliases: Object.freeze(['deepseek-chat']),
  listCurrency: 'USD', billedCurrency: 'USD', usdToBilled: USD_TO_CNY,
  listPrice: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }),
  billedPrice: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }),
  source: 'DeepSeek 官方价目页(中文截图 ¥/1M + 英文页 $/1M,两套等价,2026-10-15 同次核对)',
  asOf: '2026-10-15',
  discounts: Object.freeze({ offPeak: OFF_PEAK_DISCOUNT, windows: 'PEAK_WINDOWS_UTC', holidays: 'CN_PUBLIC_HOLIDAYS' }),
});
const OFFICIAL_PRO = Object.freeze({
  model: 'deepseek-v4-pro', provider: 'deepseek', providerHint: 'deepseek-official',
  listCurrency: 'USD', billedCurrency: 'USD', usdToBilled: USD_TO_CNY,
  listPrice: Object.freeze({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }),
  billedPrice: Object.freeze({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }),
  source: '同上(官方英文页 deepseek-v4-pro 列)',
  asOf: '2026-10-15',
  discounts: Object.freeze({ offPeak: OFF_PEAK_DISCOUNT, windows: 'PEAK_WINDOWS_UTC', holidays: 'CN_PUBLIC_HOLIDAYS' }),
});
/** 中转站那几张的公共部分(标 $、**实际扣 ¥ 1:1**)。 */
const longapi = (model, listPrice, extra = {}) => Object.freeze({
  model, provider: 'longapi', providerHint: 'longapi',
  listCurrency: 'USD', billedCurrency: 'CNY', usdToBilled: 1,
  listPrice: Object.freeze(listPrice), billedPrice: Object.freeze(listPrice),
  source: '龙API 价目页(主人 2026-10-15 截图两张);主人注明"标注的 $ 实际花的是 ¥"',
  asOf: '2026-10-15',
  ...extra,
  // 中转站没有错峰政策 ⇒ 折扣**显式没有**(不是"忘了填")
  discounts: Object.freeze({ offPeak: null, windows: null, holidays: null }),
});

export const RATE_CARDS = Object.freeze([
  OFFICIAL_FLASH,
  OFFICIAL_PRO,
  longapi('grok-4.5', { cacheHit: 0.045, cacheMiss: 0.3, output: 0.9 }),
  longapi('grok-4.6', { cacheHit: 0.075, cacheMiss: 0.3, output: 0.9 }),
  longapi('grok-4.7', { cacheHit: 0.075, cacheMiss: 0.3, output: 0.9 }),
  // ⚠️ **2026-10-16 翻案(主人当页复读确认)**:1.150.74 曾把这两行改成 `cacheWrite`,
  //    理由是"按页面列名'缓存读取'填会命中比输入贵" —— 那个理由**算术上不成立**
  //    (0.15 < 0.6、0.03 < 0.15,"命中>未命中"那条抄错列指纹对这两行从来没红过)。
  //    主人 2026-10-16 复读价目页:「缓存读取」就是 $0.15 / $0.03 ⇒ 回位为 `cacheHit`;
  //    `cacheWrite` 撤销(页面写入档没核对过,不猜 —— 宁可没有,不许挂一个推出来的数)。
  longapi('grok-4.7-build-fast', { cacheHit: 0.15, cacheMiss: 0.6, output: 1.8 },
    { source: '龙API 价目页(主人 2026-10-15 截图);「缓存读取」列主人 2026-10-16 当页复读确认(1.150.74 的改判已翻案)', asOf: '2026-10-16' }),
  longapi('grok-build-0.1', { cacheHit: 0.03, cacheMiss: 0.15, output: 0.3 },
    { source: '同 grok-4.7-build-fast(2026-10-16 当页复读确认)', asOf: '2026-10-16' }),
  longapi('gemini-3-flash', { cacheHit: 0.015, cacheMiss: 0.15, output: 0.9 }),
  longapi('gemini-3.8-flash', { cacheHit: 0.0225, cacheMiss: 0.225, output: 1.125 }),
].map(Object.freeze));

/** 按模型名找价目卡:**先精确,再别名(整名,不参与前缀),再"配置里的名字以卡上模型开头"**
 *  (便于 `grok-4.7-2026xxxx` 这类带尾巴的 id);找不到 = **null**(不猜)。
 *  ⚠️ 反过来判(卡名以配置名开头)会让未知模型撞上短名卡片 —— 踩过。 */
export function rateCardFor(model) {
  const name = String(model ?? '').trim();
  if (name === '') return null;
  const exact = RATE_CARDS.find((card) => card.model === name);
  if (exact) return exact;
  const aliased = RATE_CARDS.find((card) => Array.isArray(card.aliases) && card.aliases.includes(name));
  if (aliased) return aliased;
  const prefix = RATE_CARDS.filter((card) => name.startsWith(card.model))
    .sort((a, b) => b.model.length - a.model.length)[0];
  return prefix ?? null;
}

/** 每 1M token 的**结算币种**价(按档位折过折扣;**没有折扣政策就不折**)。 */
export function rateFor(model, { at, card } = {}) {
  const priced = card ?? rateCardFor(model);
  if (!priced) return null; // ④ 未知就不是 0
  const hasDiscount = Number.isFinite(priced.discounts?.offPeak);
  const tier = hasDiscount ? resolveRateTier(at) : 'peak';
  const factor = tier === 'offPeak' ? priced.discounts.offPeak : 1;
  const unit = priced.billedPrice;
  // ⚠️ `cacheHit: null` = **这一档没核过**(哪张卡哪天再出现没核过的档,机制留着照用)。
  //    按"不假设缓存能省钱"处理 ⇒ 回落输入价(宁可高估成本,也不假设一个没核过的折扣)。
  const hit = Number.isFinite(unit.cacheHit) ? unit.cacheHit : unit.cacheMiss;
  return {
    card: priced, tier, factor, currency: priced.billedCurrency,
    cacheHit: hit * factor, cacheMiss: unit.cacheMiss * factor, output: unit.output * factor,
    cacheHitAssumed: !Number.isFinite(unit.cacheHit),
    note: hasDiscount ? null : '这一家没有错峰政策(价目不随时刻变)',
  };
}

/** 把结算币种的单价折成 ¥/1M(官方直连真美元 ⇒ ×USD_TO_CNY;中转站 1:1)。 */
export function rateToCny(rate) {
  if (!rate) return null;
  const factor = rate.card.usdToBilled;
  return { ...rate, currency: ACCOUNTING_CURRENCY,
    cacheHit: rate.cacheHit * factor, cacheMiss: rate.cacheMiss * factor, output: rate.output * factor };
}

/**
 * 把一次(或一批)用量折成 **¥**。⚠️ 与旧 `estimateCost` 的区别:
 *   · 币种明确是 ¥(记账币种),不再叫 `Usd`;
 *   · **未知模型/未知档位返回 `null`** —— 不返回 0(计零的报表永远"便宜");
 *   · 档位按 `at` 派生;不传 `at` 时**必须**显式传 `card` 或接受"按峰时"的保守口径并自己知道。
 *
 * @param {{model?: string, at?: number, card?: object, cacheMissTokens?: number, cacheHitTokens?: number,
 *          inputTokens?: number, cacheReadTokens?: number, outputTokens?: number, completionTokens?: number}} args
 * @returns {{cny: number, tier: string, currency: 'CNY', rate: object}|null}
 */
/**
 * 同一发用量**一律按峰时**折(用于"全按峰时会高估多少"的对照)。
 * 峰时锚点**从价目卡自己的窗口定义派生**(周一 02:00 UTC),不写死日期 —— 那位老大难就是硬编码。
 */
export function estimateCostCnyAtPeak(args = {}) {
  const card = args.card ?? rateCardFor(args.model);
  if (!card) return null;
  const window = (card.discounts?.windows ? PEAK_WINDOWS_UTC : null)?.[0];
  const anchor = window
    // 2026-01-05 是周一;取它的 02:00 UTC = 落在第一段峰窗内。
    ? Date.UTC(2026, 0, 5, window.fromHour, 0)
    : Date.UTC(2026, 0, 5, 2, 0);
  return estimateCostCny({ ...args, card, at: anchor, model: card.model });
}

export function estimateCostCny(args = {}) {
  let rate = rateFor(args.model, { at: args.at, card: args.card });
  if (!rate) return null;
  rate = rateToCny(rate);
  // ⚠️ 先判"有没有给",再判"是不是好数" —— `Number(NaN ?? 0)` 还是 NaN,别指望 ?? 兜住非有限值。
  const token = (value) => {
    if (value === undefined || value === null) return 0;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const miss = token(args.cacheMissTokens ?? args.inputTokens);
  const hit = token(args.cacheHitTokens ?? args.cacheReadTokens);
  const output = token(args.outputTokens ?? args.completionTokens);
  if (miss === null || hit === null || output === null) return null; // 坏用量不算钱(也不当 0)
  const cny = (miss * rate.cacheMiss + hit * rate.cacheHit + output * rate.output) / 1_000_000;
  return { cny, tier: rate.tier, currency: ACCOUNTING_CURRENCY, rate };
}

/** 从一条 DSH 会话记录里取 usage(认不出返回 null,不硬造 0)。 */
export function usageOfRecord(record) {
  const usage = record?.data?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  let any = false;
  for (const field of DSH_USAGE_FIELDS) {
    const value = usage[field];
    out[field] = typeof value === 'number' ? value : 0;
    if (typeof value === 'number') any = true;
  }
  return any ? out : null;
}

/** 汇总一组 DSH 记录(与 usage-report 同一份口径)。 */
export function sumSessionUsage(records) {
  const totals = Object.fromEntries(DSH_USAGE_FIELDS.map((f) => [f, 0]));
  let calls = 0;
  for (const record of records ?? []) {
    const usage = usageOfRecord(record);
    if (!usage) continue;
    calls += 1;
    for (const field of DSH_USAGE_FIELDS) totals[field] += usage[field];
  }
  return { calls, totals };
}

/**
 * 汇总自有引擎的轮次(只算带 usage 的 assistant 轮)。
 * 暖轮 = `cacheHitTokens > 0` 的调用;冷轮 = 有 usage 但命中为 0(缓存已清)。
 * **按暖/冷分组分别累计** —— 判据②"暖轮 ≤ 现状一半"要量的是暖轮那一组,不是全体均值。
 * @param {Array<{meta?: {usage?: object}}>} turns
 */
export function sumTurnUsage(turns) {
  const empty = () => ({ cacheMiss: 0, cacheHit: 0, output: 0 });
  const totals = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  const warm = empty();
  const cold = empty();
  let calls = 0;
  let warmTurns = 0;
  let coldTurns = 0;
  for (const turn of turns ?? []) {
    const usage = turn?.meta?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const prompt = Number.isFinite(usage.promptTokens) ? usage.promptTokens : null;
    const hit = Number.isFinite(usage.cacheHitTokens) ? usage.cacheHitTokens : 0;
    const completion = Number.isFinite(usage.completionTokens) ? usage.completionTokens : 0;
    const miss = Number.isFinite(usage.cacheMissTokens)
      ? usage.cacheMissTokens
      : (prompt === null ? null : Math.max(0, prompt - hit));
    if (prompt === null && miss === null) continue; // 没真值的行不算（不硬造 0）
    calls += 1;
    totals.promptTokens += prompt ?? (miss + hit);
    totals.completionTokens += completion;
    totals.cacheHitTokens += hit;
    totals.cacheMissTokens += miss ?? 0;
    const bucket = hit > 0 ? warm : cold;
    if (hit > 0) warmTurns += 1; else coldTurns += 1;
    bucket.cacheMiss += miss ?? 0;
    bucket.cacheHit += hit;
    bucket.output += completion;
  }
  return { calls, warmTurns, coldTurns, totals, warm, cold };
}

/** A billable usage row requires output and an explicit cache split; missing is not zero. */
export function completeOwnUsage(usage) {
  const token = value => Number.isSafeInteger(value) && value >= 0;
  if (!usage || !token(usage.completionTokens) || !token(usage.cacheHitTokens)) return false;
  const { promptTokens: prompt, cacheHitTokens: hit, cacheMissTokens: miss } = usage;
  if (prompt != null && !token(prompt)) return false;
  if (miss != null && !token(miss)) return false;
  if (prompt == null && miss == null) return false;
  if (prompt != null && hit > prompt) return false;
  if (prompt != null && miss != null && miss + hit !== prompt) return false;
  return true;
}

/** HTTP attempts are the cost source, logical rows only determine coverage. */
export function sumOwnAttemptUsage(calls = [], attempts = []) {
  const byId = new Map(calls.map(call => [call.id, call]));
  const covered = new Set(attempts.map(row => row.call_id));
  const result = sumOwnCallUsage(attempts.map(row => ({ ...row,
    kind: byId.get(row.call_id)?.kind ?? 'unknown' })));
  const missingCalls = calls.filter(call => !covered.has(call.id)).length;
  const orphanAttempts = attempts.filter(row => !byId.has(row.call_id)).length;
  const pendingCalls = calls.filter(call => call.status === 'pending').length;
  const pendingAttempts = attempts.filter(row => row.status === 'pending').length;
  const coverageComplete = missingCalls === 0 && orphanAttempts === 0 && pendingCalls === 0 && pendingAttempts === 0;
  return { ...result, logicalCalls: calls.length, httpAttempts: attempts.length, missingCalls,
    orphanAttempts, pendingCalls, pendingAttempts,
    accountingComplete: result.unknownCalls === 0 && coverageComplete,
    retryAccountingComplete: coverageComplete,
    scope: 'HTTP attempts; unknown usage and missing coverage block acceptance' };
}

/** Logical engine calls, including summaries and empty replies; unknown is not free. */
export function sumOwnCallUsage(rows) {
  const known = (rows ?? []).filter(row => completeOwnUsage(row.usage));
  const summary = sumTurnUsage(known.map(row => ({ meta: { usage: row.usage } })));
  const unknownCalls = (rows ?? []).length - known.length;
  const kinds = {};
  for (const row of rows ?? []) kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
  return { ...summary, logicalCalls: (rows ?? []).length, unknownCalls, kinds,
    accountingComplete: unknownCalls === 0, retryAccountingComplete: false,
    scope: 'logical engine calls; HTTP retry attempts not separately metered' };
}

/**
 * 把 token 折成美元。**两条来源都能用**:DSH 侧给 `inputTokens`/`cacheReadTokens`,
 * 自有侧给 `cacheMissTokens`/`cacheHitTokens` —— 名字不同,入参统一成下面这五个。
 * @param {{cacheMissTokens?: number, cacheHitTokens?: number, inputTokens?: number,
 *          cacheReadTokens?: number, outputTokens?: number, completionTokens?: number,
 *          prices?: object}} args
 */
export function estimateCost(args = {}) {
  const prices = args.prices ?? PRICES.peak;
  const miss = (args.cacheMissTokens ?? args.inputTokens ?? 0);
  const hit = (args.cacheHitTokens ?? args.cacheReadTokens ?? 0);
  const output = (args.outputTokens ?? args.completionTokens ?? 0);
  return (miss * prices.cacheMiss + hit * prices.cacheHit + output * prices.output) / 1_000_000;
}

/** 每轮平均成本(调用数为 0 时返回 null,不硬造 0 —— 0 会被读成"便宜")。 */
export function costPerCall(totalUsd, calls) {
  return calls > 0 ? totalUsd / calls : null;
}

/**
 * 对账判据(docs\21 §十二 成本账第二版):
 *   ① 加权单轮 ≤ 现状;② 暖轮 ≤ 现状一半。数据不足(任一侧 0 次调用)时**不下结论**。
 * @param {{own: {calls: number, warmTurns: number, coldTurns: number, totals: object},
 *          dsh: {calls: number, totals: object}, prices?: object}} args
 */
export function compareVerdict({ own, dsh, prices } = {}) {
  if (own?.accountingComplete === false || own?.retryAccountingComplete === false) {
    return { verdict: 'insufficient', weightedOk: null, warmOk: null,
      note: '调用账含未知项或尚未逐次计量HTTP重试，不能推定成本达标' };
  }
  if (!own || !dsh || own.calls === 0 || dsh.calls === 0) {
    return { verdict: 'insufficient', weightedOk: null, warmOk: null, note: '数据不足:某一侧还没攒到调用(观察期继续跑)' };
  }
  const dshPerCall = estimateCost({ ...dsh.totals, prices }) / dsh.calls;
  const ownTotal = estimateCost({ ...own.totals, prices });
  const ownPerCall = ownTotal / own.calls;
  // 暖轮单独口径(判据②量的就是这一组);没有暖轮就 null,不拿冷轮冒充
  const warmPerCall = own.warmTurns > 0 ? estimateCost({ ...own.warm, prices }) / own.warmTurns : null;
  const coldPerCall = own.coldTurns > 0 ? estimateCost({ ...own.cold, prices }) / own.coldTurns : null;
  const weightedOk = ownPerCall <= dshPerCall;
  const warmOk = warmPerCall === null ? null : warmPerCall <= dshPerCall / 2;
  return {
    verdict: weightedOk && warmOk ? 'win' : 'not_yet',
    weightedOk,
    warmOk,
    dshPerCall,
    ownPerCall,
    warmPerCall,
    coldPerCall,
    note: weightedOk && warmOk
      ? '两条判据同时成立(加权不贵、暖轮省一半)—— 可以进刀四'
      : '未同时满足:回查迟滞/gap-aware 窗口/前缀稳定性,或继续攒数据',
  };
}
