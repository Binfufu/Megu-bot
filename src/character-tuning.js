import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/**
 * **角色的数值:只在这一张表里**(1.104.0 / D168)。
 *
 * ⚠️⚠️ **为什么单独一个文件**:这是**操作者拍板**的东西(他一直以来的口径:
 * 数值他定、文档里不抄数字)。所以所有会变的数字集中在这一处 ——
 * 改档位、改价、改预算都只动这个文件,别处不许再写第二份(`character.js` 只负责算)。
 *
 * 三条规矩(TODO.md 里写死的,改表时别破):
 *   ① **只做加法不做乘法** —— `mods` 全是加数,任何"×1.5"都不许进来;
 *   ② **缺点要有真实手感** —— `flaw` 的 `mods` 必须**真的**削弱判定(负加数),
 *      否则就是白送点数;
 *   ③ **留一套"穷但稳"的保底能力** —— `DEFAULT_KIT` 人人都有、不占点数。
 *
 * 判定轴(`lawful` / `tricky`)**必须与委托步段的 `kind` 对齐** ——
 * 那两类是 `src\play\quest.js` 里现在真正会用到的(见那里的 `QUEST_CHECKS`)。
 */

/** 开卡点数预算。 */
export const CHARACTER_BUDGET = 50;

/**
 * 单条判定轴的修正上下限(`modsForPicks` 会把总和夹到这个区间)。
 *
 * ⚠️⚠️ **两个旋钮必须一起看**(第一版就漏了这件事):
 *   下限是个**保底**(角色别废到没法玩),但它同时意味着
 *   "**缺点堆够多之后,再堆就不疼了**" —— 那正是规矩②要防的**白送点数**。
 *   所以真正堵住漏洞的是 `MAX_FLAWS` 这个**数量**上限,而不是把下限调小:
 *   缺点要有手感(只做加法、真的削弱),但**不许无限叠**。
 */
export const STAT_MIN_MOD = -3;
export const STAT_MAX_MOD = 6;

/**
 * 最多能带几个缺点。
 *
 * ⚠️ 它的存在理由见上面 `STAT_MIN_MOD` 那段:**只靠数值下限挡不住"堆缺点换点数"**。
 *    超过就整张卡拒掉(fail closed),而不是悄悄少算几个。
 */
export const MAX_FLAWS = 3;

/** 保底能力:人人都有、不占点数(花完点数也不至于 0 修正等死)。 */
export const DEFAULT_KIT = Object.freeze({ lawful: 1, tricky: 1 });

/**
 * **能力模块价目表**。
 *
 * | 字段 | 意思 |
 * |---|---|
 * | `id` | 稳定标识(存进角色卡的就是它,改 id = 让旧卡失效) |
 * | `kind` | `skill`(花点数)/ `flaw`(倒贴点数) |
 * | `cost` | **正数花点数,负数倒贴** |
 * | `mods` | 各判定轴加多少(**只做加法**) |
 * | `note` | 给人看的一句话(可选) |
 *
 * ⚠️ `order` 只影响页面上的排列(先技能后缺点,价高的在前)。
 */
const MODULE_TEXT = LOCAL_STORY_WORLD?.moduleText ?? {
  "burst": {
    "name": "集中能力",
    "note": "集中处理正面问题"
  },
  "sword": {
    "name": "工具运用"
  },
  "scout": {
    "name": "观察"
  },
  "talk": {
    "name": "沟通"
  },
  "cook": {
    "name": "制作",
    "note": "生活场景中也可使用"
  },
  "fish": {
    "name": "垂钓"
  },
  "slow": {
    "name": "行动缓慢"
  },
  "weak": {
    "name": "力量不足"
  },
  "clumsy": {
    "name": "操作生疏"
  },
  "nosy": {
    "name": "表达疏漏"
  }
};
export const MODULE_TUNING = Object.freeze([
  // —— 技能 ——
  { id: 'burst', kind: 'skill', name: MODULE_TEXT.burst.name, cost: 14, mods: { lawful: 3, tricky: 0 }, note: MODULE_TEXT.burst.note },
  { id: 'sword', kind: 'skill', name: MODULE_TEXT.sword.name, cost: 10, mods: { lawful: 2, tricky: 0 } },
  { id: 'scout', kind: 'skill', name: MODULE_TEXT.scout.name, cost: 9, mods: { lawful: 0, tricky: 3 } },
  { id: 'talk', kind: 'skill', name: MODULE_TEXT.talk.name, cost: 8, mods: { lawful: 1, tricky: 2 } },
  { id: 'cook', kind: 'skill', name: MODULE_TEXT.cook.name, cost: 6, mods: { lawful: 0, tricky: 1 }, note: MODULE_TEXT.cook.note },
  { id: 'fish', kind: 'skill', name: MODULE_TEXT.fish.name, cost: 6, mods: { lawful: 0, tricky: 2 } },
  // —— 缺点(⚠️ 规矩②:必须真的削弱判定,否则就是白送点数)——
  { id: 'slow', kind: 'flaw', name: MODULE_TEXT.slow.name, cost: -7, mods: { lawful: -1, tricky: -2 } },
  { id: 'weak', kind: 'flaw', name: MODULE_TEXT.weak.name, cost: -7, mods: { lawful: -2, tricky: 0 } },
  { id: 'clumsy', kind: 'flaw', name: MODULE_TEXT.clumsy.name, cost: -5, mods: { lawful: -1, tricky: -1 } },
  { id: 'nosy', kind: 'flaw', name: MODULE_TEXT.nosy.name, cost: -4, mods: { lawful: 0, tricky: -1 } },
]);
