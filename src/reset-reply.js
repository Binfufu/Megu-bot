/**
 * **`/重置` 在"她还忙着"时该回哪一句**(2026-10-15,并行审查 F7)。
 *
 * 为什么单独立一个小模块:这是**用户看得见的那句话**,而它的分支判据要能离线测
 * (`src\index.js` 一 import 就跑 `main()`,不能为了测一句话把它拉起来)。
 * 与 `runner-contract.js` 同族:**措辞只有一份**,生产与判据都从这里取(D159)。
 *
 * 背景:DSH 的 `resetConversation` 永不抛;own 引擎在**有在途回合**时抛
 * (`engine: cannot reset a conversation with pending turns`)。同一条 `/重置`
 * 于是两路两副面孔 —— own 路那一刻被外层"处理消息失败"接住,**用户啥也收不到**。
 * 现在改成:忙就说人话(并说明怎么再来一次),兜住抛错,绝不静默消失。
 */

/** 两个分支的措辞(**唯一一份**;判据直接引用这里,不许在测试里抄字面量)。 */
export const RESET_BUSY_REPLY = '（她还在回上一条 —— 等这句说完再 /重置 一次就行）';
export const RESET_FAILED_REPLY = '（这会儿重置不了 —— 她还在回上一条，等这句说完再 /重置 一次）';

/**
 * 算这一条 `/重置` 该怎么回。
 *
 * ⚠️ **两个分支都要**:提前问 `isBusy` 是"用户看得见的意图"(还没动手,状态一个字没改);
 * 抛错那道是**兜住竞态** —— 问完到真重置之间那一瞬可能刚好来了一轮。
 *
 * @param {{isBusy?: Function, resetConversation?: Function}} runner 与 DshRunner 同形状
 * @param {string} conversationKey
 * @returns {{ok: true, sessionId: string}|{ok: false, reason: 'busy'|'failed', reply: string, error?: Error}}
 */
export function planReset(runner, conversationKey) {
  const key = conversationKey;
  if (typeof runner?.isBusy === 'function' && runner.isBusy(key)) {
    return { ok: false, reason: 'busy', reply: RESET_BUSY_REPLY };
  }
  try {
    return { ok: true, sessionId: runner.resetConversation(key) };
  } catch (error) {
    return { ok: false, reason: 'failed', reply: RESET_FAILED_REPLY, error };
  }
}
