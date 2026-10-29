/** 虚构技能表演的旁白：识别与名称解析为纯逻辑，示例和提示词来自可选本地内容。 */
import { GAMEPLAY_CONTENT, gameplayText } from './local-gameplay-content.js';

/** 只识别结束词，不把正文当成触发；调用方负责场景、权限与发送。 */
export function isExplosionFinisher(text) {
  const source = String(text ?? '').trim();
  if (source === '') return false;
  const head = source.split('\n')[0].replace(/[\s\u3000]/g, '');
  return /^(explosion|ｅｘｐｌｏｓｉｏｎ|エクスプロ|ｅｘｐｌｏ)/i.test(head);
}

export const NARRATION_EXAMPLES = GAMEPLAY_CONTENT.narration.examples;

/** 支持原始 JSON 或已解析列表，保留原来的显式 fallback 覆盖语义。 */
export function resolveCasterName(knownBots, senderId, fallback = GAMEPLAY_CONTENT.narration.casterDefault) {
  let list = knownBots;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list) || !senderId) return fallback;
  const hit = list.find((entry) => entry && entry.id === senderId);
  return typeof hit?.name === 'string' && hit.name !== '' ? hit.name : fallback;
}

/** 首行结束词、显式名字/样例覆盖及顺序保持原样；这里只拼装文本，不调用模型。 */
export function buildNarrationPrompt({
  finisher = '',
  botName = null,
  caster = GAMEPLAY_CONTENT.narration.casterDefault,
  examples = NARRATION_EXAMPLES,
} = {}) {
  return gameplayText(GAMEPLAY_CONTENT.narration.prompt, {
    caster,
    finisher: String(finisher).split('\n')[0],
    identity: botName ? `「${botName}」` : GAMEPLAY_CONTENT.narration.narratorDefault,
    // 前导换行属于样例项，空数组不凭空多出尾换行；每项自己的换行原样保留。
    examples: examples.map((line) => `\n· ${line}`).join(''),
  });
}
