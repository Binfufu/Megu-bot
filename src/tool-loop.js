/**
 * **工具循环状态机**(P3-a,2026-10-28)—— Chat Completions 协议的工具调用循环。
 *
 * ## 照搬出处(2026-10-28 已核官方全文,不发明变体)
 *
 * DeepSeek「Tool Calls」官方示例的循环就是:模型回 `tool_calls` → 客户端**原样接回
 * 完整 assistant 消息** → 每个 call 追加一条 `{role:'tool', tool_call_id, content}`
 * → 继续请求,直到模型不再要工具。 https://api-docs.deepseek.com/guides/tool_calls/
 *
 * ## 这一层的边界
 *
 * · **纯函数**:不调 HTTP、不知道权限(执行交给 capabilities.executeAuthorized);
 * · **协议状态不落 conversation_turn**:引擎层把非 assistant 历史一律映射回 user,
 *   所以工具轮的中间消息**只活在本次循环内存里**,落库的只有最终正文(简化,写死在
 *   engine 接线处)——代价是重启后这轮工具上下文不可重放,收益是不破坏 append-only 历史;
 * · Responses 协议(function_call/function_call_output)是**另一个**适配器,留在
 *   llm.js 侧做,这里只有 Chat 形状(两协议形状不同,不许一份函数硬兼)。
 *
 * ## 预算
 *
 * 循环轮数由调用方传入(`maxRounds`),本层不定数值【数值未经拍板不定死】;
 * 预算耗尽 = **显式失败**(BUDGET_EXHAUSTED),不许把中间文本当最终答案发出去。
 */

/** 从统一 response 形状(`llm.js` 的返回)里取工具调用。 */
export function extractToolCalls(response) {
  const calls = response?.toolCalls;
  return Array.isArray(calls) ? calls : [];
}

/**
 * 构造要**原样接回**的 assistant 协议消息(官方要求:完整保留,不抄正文重拼)。
 * `reasoning_content` 等协议字段若上游给了也一并保留(带 tools 的思考态要求完整回传)。
 */
export function buildAssistantMessage(response) {
  const message = { role: 'assistant', content: response?.text ?? '' };
  const calls = extractToolCalls(response);
  if (calls.length > 0) message.tool_calls = calls;
  if (response?.raw?.reasoning_content != null) message.reasoning_content = response.raw.reasoning_content;
  return message;
}

/**
 * 构造工具结果消息(每个 call 一条,`tool_call_id` 一一配对)。
 * `content` = 结果的 JSON 序列化(官方示例是字符串;结构化数据原样进,模型可读)。
 *
 * @param {Array<{id: string, function?: {name?: string}}>} calls
 * @param {Map<string, object>} resultsByCallId `executeAuthorized` 的返回,按 call.id
 */
export function buildToolResultMessages(calls, resultsByCallId) {
  return (Array.isArray(calls) ? calls : []).map((call) => {
    const result = resultsByCallId.get(call.id);
    const body = result ?? { ok: false, error: { code: 'NO_RESULT', message: '该调用没有结果(循环中断)' } };
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(body),
      // 便于日志辨认是哪个工具(不是协议字段,发送前由 adapter 剥)
      _tool: call.function?.name ?? null,
    };
  });
}

/**
 * 循环下一步该做什么。
 *
 * @param {{rounds: number, maxRounds: number, response: object}} input
 * @returns {{action: 'execute'|'finish'|'budget-exhausted', calls: Array}}
 */
export function nextLoopAction({ rounds, maxRounds, response }) {
  const calls = extractToolCalls(response);
  const done = Number.isSafeInteger(maxRounds) && maxRounds > 0 ? maxRounds : 1;
  if (calls.length > 0 && rounds >= done) {
    return { action: 'budget-exhausted', calls };
  }
  if (calls.length > 0) return { action: 'execute', calls };
  return { action: 'finish', calls: [] };
}

/**
 * 预算耗尽时给模型的**显式失败正文**(不是 SILENT_TOKEN,不是中间文本)。
 * 用户应看到"没办完",而不是一句像答案的半成品。
 */
export function budgetExhaustedText(toolNames) {
  const names = (Array.isArray(toolNames) && toolNames.length > 0)
    ? toolNames.join('、')
    : '工具';
  return `（这次没能完成：${names}的调用次数超出本轮预算，已停止，以免给出半成品答案。可以稍后再试，或把问题拆小一点。）`;
}
