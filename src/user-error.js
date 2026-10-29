/**
 * QQ 用户错误只返回固定文案。原始异常（响应正文、地址、凭证、栈）仅供内部日志使用。
 * 兼容带 status 的 LLM 错误、QQ API code 和旧的 HTTP 错误消息及 cause 链。
 */
export function describeUserError(error) {
  const seen = new Set();
  let timedOut = false;
  for (let current = error, depth = 0; current != null && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current);
    const object = typeof current === 'object';
    const message = typeof current === 'string' ? current : object && typeof current.message === 'string' ? current.message : '';
    const status = [object && current.status, object && current.statusCode, object && current.code]
      .map((value) => typeof value === 'number' || typeof value === 'string' ? Number(value) : 0)
      .find((value) => Number.isInteger(value) && value >= 400 && value <= 599)
      ?? Number(message.match(/\bHTTP\s+(\d{3})\b/i)?.[1] ?? 0);
    if (status === 413) return '这次内容太长了，请缩短内容或分开发送。';
    if (status === 429) return '请求有点多，请稍后再试。';
    if (status >= 500 && status <= 599) return '服务暂时出了点问题，请稍后再试。';
    if (status === 408
      || /^(?:TimeoutError|AbortError)$/.test(object ? current.name : '')
      || /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(object ? current.code : '')
      || /\btime(?:d[ -]?out|out)\b|超时/i.test(message)) timedOut = true;
    current = object ? current.cause : null;
  }
  return timedOut ? '这次等待超时了，请稍后再试。' : '这次没能处理成功，请稍后再试。';
}
