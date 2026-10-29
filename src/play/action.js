/**
 * **类型化动作协议**(D105,2026-10-03)。**纯函数 + 无副作用**。
 *
 * 背景(用户 2026-10-03 拍板的方向):QQ **降级成轻量渠道**,复杂玩法搬到**独立小网站**,
 * 架构是"**一个内核 + 两个薄适配器**" —— 内核仍是 `src\*.js` 纯函数 + `state.db` + tick + DSH,
 * **服务端权威**(状态很重:账本/时间衰减/离线推进),网站只渲染 + 发动作。
 *
 * 这一层就是"两个适配器共用的那一个入口":
 *
 *     applyAction(kind, state, action) -> { state, events[], lines[] }
 *
 * 三条纪律(照 D102 那张绑定表的精神):
 *   ① **内核不认识 QQ、也不认识 HTTP** —— 输入是 `(state, action)`,输出是 `(state, events, lines)`;
 *      "发消息""写库""调模型"全在**适配器**里(见 `src\index.js` 的接线);
 *   ② **随机与时间都是注入的**(`ctx.random` / `ctx.now`)—— 否则同一个动作两次结果不同,单测没法钉;
 *   ③ **台词可以交给模型,但事实与数值必须由内核给** —— 于是 `lines` 里是**代码写死的文案**,
 *      模型写的那部分由适配器用 `action.flavor` 传进来(见 `src\play\fishing.js` 的注释)。
 */

/**
 * 所有已声明的动作种类。
 *
 * ⚠️ **fail closed**:没在这张表里的 `kind` 一律 `unknown_action`(绝不当成"随便走一条")。
 *    理由与 `src\stat-binding.js` 的绑定表同源:没声明 = 没人想过它的后果。
 */
export const ACTION_KINDS = Object.freeze({
  /** 开局:随机水域/钓点 + 三个鱼饵(立刻,不过模型)。 */
  'fishing.begin': true,
  /** 选饵 → 下饵,从这一刻起计时。 */
  'fishing.cast': true,
  /** 收杆:进"怎么处置"这一步(空鱼篓就直接结束)。 */
  'fishing.reel_in': true,
  /** 按档位处置(吃/卖/风干/扔/留):**这一步才动数值**。 */
  'fishing.settle': true,
  /** 到点那一拍(tick 里跑,不看聊天):上钩 / 超时替她选饵 / 太久没人理自己收杆。 */
  'fishing.tick': true,
  /** 委托三段闭环(B / 1.93.0):接取那一段由 `quest.accept` 落账,这里声明过程与结算。 */
  'quest.step': true,
  'quest.settle': true,
  'quest.abandon': true,
});

/** 这个 `kind` 声明过没有(纯函数)。 */
export function isKnownActionKind(kind) {
  return typeof kind === 'string' && ACTION_KINDS[kind] === true;
}

/** 没声明过的动作:原样退回状态 + 一条 warn,绝不当成"成功"。 */
export function unknownAction(state, kind) {
  return {
    state: state ?? null,
    events: [{ type: 'warn', reason: 'unknown_action', kind: kind ?? null, line: `（未声明的事件：${String(kind)}）` }],
    lines: [],
  };
}

/** 把 `(state, events, lines)` 归一化,免得每个 reducer 各写一遍。 */
export function result(state, events = [], lines = []) {
  return {
    state,
    events: events.filter(Boolean),
    // ⚠️ **`null` 要留着** —— 钓鱼那几步的 `lines[0]` 是"模型写的那一段"(适配器没拿到就传 null),
    //    在这里把它滤掉会让适配器**错位**(本应发事实却去发第一行)。只滤真正的空串/undefined。
    lines: lines.filter((line) => line !== undefined && line !== ''),
  };
}
