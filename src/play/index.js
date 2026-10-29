/**
 * **玩法内核**(D105):两个适配器(QQ 桥 / 独立小网站)共用的那一个入口。
 *
 *     import { applyAction } from './play/index.js';
 *     const { state, events, lines } = applyAction(kind, state, action, ctx);
 *
 * 这里**只有纯函数**:不认识 QQ、不认识 HTTP、不碰 `state.db`。
 * 时间与随机从 `ctx` 注入(`{ now, random }`),所以同一个动作两次跑出来一样、可单测。
 */

import { isKnownActionKind, unknownAction } from './action.js';
import { fishingAction } from './fishing.js';
import { questAction } from './quest.js';

/**
 * **动作种类 → reducer** 的派发表。
 *
 * ⚠️ 1.65.1 复核抓到的问题:第一版写的是 `kind.startsWith('fishing.')` —— 那样一来
 *    "往 `ACTION_KINDS` 里加一个 `explore.begin`"会得到 `unknown_action`,
 *    也就是说"没声明才 fail closed"这句话只对了一半,而每加一个玩法都得回来改入口。
 *    现在**加玩法 = 加一行**,`ACTION_KINDS` 仍然是"声明过没有"的唯一判据。
 */
const REDUCERS = {
  'fishing.': fishingAction,
  // 委托三段闭环(B):`quest.accept` 不在这里 —— 那一段要动主世界的账(看板/钱/体力),
  // 归 `panel-actions.js`(与 `/接 N` 共用 `quest-take.js`);这里管**过程与结算**。
  'quest.': questAction,
};

/** 找这个 `kind` 该走哪个 reducer(纯函数;`null` = 没有)。 */
export function reducerFor(kind) {
  for (const [prefix, reducer] of Object.entries(REDUCERS)) {
    if (String(kind).startsWith(prefix)) return reducer;
  }
  return null;
}

/**
 * **类型化动作协议**的唯一入口。
 *
 * @param {string} kind 动作种类(必须先在 `action.js` 的 `ACTION_KINDS` 里声明;**fail closed**)
 * @param {object|null} state 该玩法当前的状态
 * @param {object} action 动作载荷
 * @param {object} ctx `{ now, random, userId, userName, scene, targetId, appId }`
 * @returns {{state: object|null, events: object[], lines: string[]}}
 */
export function applyAction(kind, state, action = {}, ctx = {}) {
  if (!isKnownActionKind(kind)) return unknownAction(state, kind);
  const reducer = reducerFor(kind);
  if (!reducer) return unknownAction(state, kind);
  return reducer(kind, state, action, ctx);
}

export * from './action.js';
export * from './fishing.js';
export * from './quest.js';
