/**
 * 经济模拟器(**只读、纯函数、不碰任何库**)—— 用于给"钱"的常量标定与复核(D99)。
 *
 * 为什么需要它:钱的规则全在 `src\stats.js` / `src\economy.js` 的常量里,而一条规则好不好
 * **只能靠"她跑一段时间会怎样"回答**。D42 那一版就是这么量出来的(结论:"不会穷"),
 * 货币刻度变更后也必须重测 —— 因为余额刻度、委托金额、开销速率可能**同时**变化。
 *
 * 它逐小时推进:时间开销(清醒/睡眠)→ 每小时的若干轮里掷委托与随机事件 → 每天固定几顿饭。
 * 输入参数都取自**代码里的常量**,所以"改了常量再跑一次"就是标定。
 *
 * 判据(阶段 1,脚本会自己判 —— 阶段 3 把"花钱出口"补上之后目标会收紧,见 D99):
 *   ① 中位终局落在 **1,000 ~ 50,000 货币单位**(不是永远 0,也攒不下几十天的生活费);
 *   ② "低于穷线"的时间落在 **5% ~ 45%** —— 既不能是 0%(那 D42 那句"穷是动机"就是死的),
 *      也不能太高(用户原话是「不要一直说穷」)。
 *
 * 用法:
 *   node scripts\economy-sim.js                      # 默认:200 天 × 40 次
 *   node scripts\economy-sim.js --days 300 --runs 60
 *   node scripts\economy-sim.js --cooldown-hours 96  # 标定用:换个"委托间隔"再跑
 *   node scripts\economy-sim.js --json               # 给别的工具吃
 *
 * ⚠️ 默认值都是**估的活跃度**(每小时 2.5 轮、每天 10 次投喂 / 2 顿自己吃),
 * 想按真实节奏算,拿 `scripts\rhythm-report.js` 与 `metric-report.js` 的数去覆盖它们。
 */
import { MONEY_DECAY, MONEY_POOR, STAT_DEFAULTS } from '../src/stats.js';
import { RANDOM_EVENTS, TASK_CHANCE, TASK_COOLDOWN_MS, TASK_TIERS } from '../src/economy.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? Number(argv[index + 1]) : fallback;
};
const asJson = argv.includes('--json');
const DAYS = arg('days', 200);
const RUNS = arg('runs', 40);
const TURNS_PER_HOUR = arg('turns-per-hour', 2.5);
const GIFTS_PER_DAY = arg('gifts', 10);      // 别人投喂:免单,但也不给钱(D99)
const SELF_MEALS_PER_DAY = arg('self-meals', 2);
const SELF_MEAL_COST = arg('self-meal-cost', 900); // 600 kcal 定食 = 900 货币单位
const COOLDOWN_MS = arg('cooldown-hours', TASK_COOLDOWN_MS / HOUR_MS) * HOUR_MS;

/** 一个确定性的伪随机源:同一次运行必须可复现(标定要能对比)。 */
function makeRandom(seed) {
  let state = seed % 2147483648;
  if (state <= 0) state += 2147483647;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const pickWeighted = (rows, random) => {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  let roll = random() * total;
  for (const row of rows) {
    roll -= row.weight;
    if (roll < 0) return row;
  }
  return rows[rows.length - 1];
};
const pickInRange = ([min, max], random) => (max <= min ? min : min + Math.floor(random() * (max - min + 1)));

/**
 * 跑一次:返回终局余额、"穷"的时间占比、各项进出。
 * @param {{seed: number}} options
 */
function simulate({ seed }) {
  const random = makeRandom(seed);
  // 起点定在一个白天,免得第一天的睡眠段把"当天"整体带偏。
  const start = Date.UTC(2026, 9, 1, 8, 0);
  let money = STAT_DEFAULTS.money;
  let lastTaskAt = Number.NEGATIVE_INFINITY;
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let poorHours = 0;
  let lowest = money;
  const totals = { income: 0, decay: 0, meals: 0, tasks: 0, events: 0 };

  for (let day = 0; day < DAYS; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const now = start + day * DAY_MS + hour * HOUR_MS;
      const asleep = hour < 8 || hour >= 23;
      const decay = asleep ? MONEY_DECAY.perHourAsleep : MONEY_DECAY.perHourAwake;
      money = Math.max(0, money - decay);
      totals.decay += decay;

      const turns = Math.max(0, Math.round(TURNS_PER_HOUR));
      for (let turn = 0; turn < turns; turn += 1) {
        if (now - lastTaskAt >= COOLDOWN_MS && random() < TASK_CHANCE) {
          lastTaskAt = now;
          const tier = pickWeighted(TASK_TIERS, random);
          const delta = pickInRange(tier.reward, random) + (tier.extra ?? 0);
          money = Math.max(0, money + delta);
          if (delta >= 0) totals.income += delta;
          else totals.tasks += -delta;
        }
        if (now - lastEventAt >= HOUR_MS && random() < 0.04) {
          lastEventAt = now;
          const event = pickWeighted(RANDOM_EVENTS, random);
          const delta = pickInRange(event.delta, random);
          money = Math.max(0, money + delta);
          if (delta >= 0) totals.income += delta;
          else totals.events += -delta;
        }
      }

      if (money < MONEY_POOR) poorHours += 1;
      if (money < lowest) lowest = money;
    }
    // 自己吃的饭(带图/投喂那些顿是**别人请的**,免单 —— 见 D97/D99)
    const mealCost = SELF_MEALS_PER_DAY * SELF_MEAL_COST;
    money = Math.max(0, money - mealCost);
    totals.meals += mealCost;
  }

  const outgo = totals.decay + totals.meals + totals.tasks + totals.events;
  return {
    seed,
    money: Math.round(money),
    lowest: Math.round(lowest),
    poorPercent: Math.round((100 * poorHours) / (DAYS * 24) * 10) / 10,
    incomePerDay: Math.round(totals.income / DAYS),
    outgoPerDay: Math.round(outgo / DAYS),
  };
}

const runs = [];
for (let index = 0; index < RUNS; index += 1) runs.push(simulate({ seed: index * 7919 + 13 }));
const sorted = [...runs].sort((a, b) => a.money - b.money);
const median = sorted[Math.floor(sorted.length / 2)];
const mean = Math.round(sorted.reduce((sum, run) => sum + run.money, 0) / sorted.length);
const poorAvg = Math.round((sorted.reduce((sum, run) => sum + run.poorPercent, 0) / sorted.length) * 10) / 10;
const okMedian = median.money >= 1_000 && median.money <= 50_000;
const okPoor = poorAvg >= 5 && poorAvg <= 45;

if (asJson) {
  process.stdout.write(JSON.stringify({
    days: DAYS, runs: RUNS, cooldownHours: COOLDOWN_MS / HOUR_MS,
    turnsPerHour: TURNS_PER_HOUR, giftsPerDay: GIFTS_PER_DAY,
    median: median.money, mean, min: sorted[0].money, max: sorted[sorted.length - 1].money,
    poorPercent: poorAvg, incomePerDay: median.incomePerDay, outgoPerDay: median.outgoPerDay,
    criteria: { medianInRange: okMedian, poorHappens: okPoor },
  }, null, 2) + '\n');
} else {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out();
  out(`=== 经济模拟(货币单位,D99)===
  参数:${DAYS} 天 × ${RUNS} 次 ｜ 每小时 ${TURNS_PER_HOUR} 轮 ｜ 委托间隔 ${COOLDOWN_MS / HOUR_MS} 小时
        每天:投喂 ${GIFTS_PER_DAY} 次(免单)、自己吃 ${SELF_MEALS_PER_DAY} 顿(每顿 ${SELF_MEAL_COST})
        开销速率:清醒 ${MONEY_DECAY.perHourAwake}/小时、睡觉 ${MONEY_DECAY.perHourAsleep}/小时 ｜ 穷线 ${MONEY_POOR}`);
  out();
  out(`  终局余额   中位 ${median.money} ｜ 均值 ${mean} ｜ 最低 ${sorted[0].money} ｜ 最高 ${sorted[sorted.length - 1].money}`);
  out(`  过程最低   中位那次的坑底 ${median.lowest}`);
  out(`  "穷"的时间 平均 ${poorAvg}%（低于 ${MONEY_POOR} 货币单位）`);
  out(`  日入/日支  中位那次 ${median.incomePerDay} / ${median.outgoPerDay}`);
  out();
  out(`  判据① 中位终局落在 1,000~50,000 货币单位:${okMedian ? '✅ 是' : '❌ 否'}（${median.money}）`);
  out(`  判据② "穷"的时间落在 5%~45%:${okPoor ? '✅ 是' : '❌ 否'}（${poorAvg}%）`);
  out();
  out('  ⚠️ 这是**模拟**,不是实测 —— 真跑几天之后拿 `stats-report.js` 对一遍。');
  out();
}
