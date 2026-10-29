import { LOCAL_MOOD_BODY_CONTENT } from './local-mood-body-content.js';
/** Local display content is separate from the unchanged runtime policy. */

/** Local display content is separate from the unchanged runtime policy. */
export const BIOLOGICAL_RULES = Object.freeze({
  kind: 'biological',
  label: LOCAL_MOOD_BODY_CONTENT?.ruleLabels.biological ?? '生物体：基础状态与日常开销',
  defaults: Object.freeze({ satiety: 60, health: 80, mood: 70, stamina: 70, mana: 90, money: 2_000 }),
  decay: Object.freeze({
    satietyPerHourAwake: 4,
    satietyPerHourAsleep: 2,
    healthPerHourStarving: 2,
    healthPerHourAsleep: 1,
    moodPerHourToBaseline: 1,
    starvingBelow: 20,
    staminaPerHourAwake: 3,
    staminaPerHourAsleep: 12,
    manaPerHour: 5,
  }),
  moneyDecay: Object.freeze({ enabled: true, perHourAwake: 150, perHourAsleep: 80 }),
  meal: Object.freeze({ kcalPerSatiety: 25, maxSatietyPerMeal: 40, erisPerKcal: 1.5, moneyEnabled: true }),
});

/** Local display content is separate from the unchanged runtime policy. */
export const MECHANICAL_RULES = Object.freeze({
  kind: 'mechanical',
  label: LOCAL_MOOD_BODY_CONTENT?.ruleLabels.mechanical ?? '机械体：基础状态与能源（无货币开销）【暂定】',
  defaults: Object.freeze({ satiety: 70, health: 85, mood: 65, stamina: 75, mana: 80, money: 0 }),
  decay: Object.freeze({
    satietyPerHourAwake: 2,
    satietyPerHourAsleep: 0.5,
    healthPerHourStarving: 1,
    healthPerHourAsleep: 2,
    moodPerHourToBaseline: 1.2,
    starvingBelow: 15,
    staminaPerHourAwake: 2,
    staminaPerHourAsleep: 15,
    manaPerHour: 6,
  }),
  moneyDecay: Object.freeze({ enabled: false, perHourAwake: 0, perHourAsleep: 0 }),
  meal: Object.freeze({ kcalPerSatiety: 25, maxSatietyPerMeal: 100, erisPerKcal: 0, moneyEnabled: false }),
});

/** 框架名清单(配置校验/测试用)。 */
export const BODY_KINDS = Object.freeze(['biological', 'mechanical']);

/** 框架注册表。 */
export const BODY_RULE_PROFILES = Object.freeze({
  biological: BIOLOGICAL_RULES,
  mechanical: MECHANICAL_RULES,
});

/** Local display content is separate from the unchanged runtime policy. */
export const THEME_BODY_KIND = Object.freeze({
  megumin: 'biological',
  aris: 'mechanical',
  demo: 'biological', // 示例只沿用既有框架，不另定数值。
});

/** 按框架名取规则。**认不出当场抛**(不静默套用别人的数值)。 */
export function bodyRulesFor(kind) {
  const key = String(kind ?? '').trim();
  if (key === '') return BIOLOGICAL_RULES; // Empty configuration keeps the legacy default.
  const rules = BODY_RULE_PROFILES[key];
  if (!rules) {
    throw new Error(`未知数值框架:${JSON.stringify(kind)}(只认 ${BODY_KINDS.join(' / ')})`);
  }
  return rules;
}

/** Local display content is separate from the unchanged runtime policy. */
export function bodyRulesForTheme(themeId) {
  const key = String(themeId ?? '').trim();
  if (key === '') return BIOLOGICAL_RULES;
  const kind = THEME_BODY_KIND[key];
  if (!kind) {
    throw new Error(`未知身体主题:${JSON.stringify(themeId)} —— 没有登记数值框架(见 src\\body-rules.js 的 THEME_BODY_KIND)`);
  }
  return bodyRulesFor(kind);
}
