/** Pure bridge runner compatibility helpers. No process/filesystem/DSH runtime imports.
 * Legacy event extraction remains for retained history; it does not start a DSH service.
 */
export function extractAssistantText(event) {
  if (event?.type !== 'assistant/message') return null;
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  return text.trim() === '' ? null : text;
}

export function describeTurnEnd(reason) {
  switch (reason?.kind) {
    case 'completed': return null;
    case 'max-tokens': return '（回复达到输出长度上限，已被截断）';
    case 'aborted': return '（本轮已被中断）';
    case 'blocked': return '（本轮被策略拦截）';
    case 'error': return `（本轮出错：${reason.error?.code ?? 'UNKNOWN'}）`;
    default: return `（本轮异常结束：${reason?.kind ?? 'unknown'}）`;
  }
}

/** Preserve the existing SDK-compatible mapping; never rewrite stored conversation keys. */
export function sanitizeSessionId(candidate) {
  return candidate.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}
