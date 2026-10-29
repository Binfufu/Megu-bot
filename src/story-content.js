import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/**
 * **故事活动内容包**(P4,2026-10-28)—— 机制与角色内容分离。
 *
 * ## 为什么要有它
 *
 * `story.js` 的状态机(抛出 / 等回应 / 超时自决 / 一定落一笔数值 / 休闲收尾)是**通用机制**;
 * 具体事件的开场、走向、关键词与展示标签属于可选的本地内容。
 * 不能把一个角色的事件表隐式套给另一个角色。
 *
 * ## 规则(与能力等式同一条精神)
 *
 * **有内容包 → 这个角色能抛这类事件;没有内容包 → 这类玩法入口关闭**(只报备"在干嘛"),
 * **不是**退回别人的内容,也**不是**静默什么都不说。
 *
 * ## 新增角色时怎么用
 *
 * 在 `STORY_CONTENT_PACKS` 里加一个包(事件表可以只写几条),角色 id 与 `QQBOT_MOOD_THEME`/
 * 身体主题同一个标识符。**不写包就不开这类玩法**——这是有意的默认,避免"先跑起来再说"的串味。
 */
import { STORY_EVENTS } from './story.js';

/** Role-specific labels and event arrays live only in optional local content. */

/** 角色 id → 内容包。`events` 形状见 `story.js` 的 `STORY_EVENTS`(只有事实方向,不写台词)。 */
export const STORY_CONTENT_PACKS = Object.freeze(Object.fromEntries(
  Object.entries(LOCAL_STORY_WORLD?.storyPacks ?? {}).map(([id, pack]) => [id, Object.freeze({
    ...pack, events: id === 'megumin' ? STORY_EVENTS : Object.freeze(pack.events),
  })]),
));

/**
 * 按角色 id 取内容包。**纯函数**,认不出返回 `null` = 该角色不开放这类玩法(fail closed)。
 *
 * @param {string} roleId `QQBOT_MOOD_THEME` 同一标识符(megumin / aris / …)
 * @returns {{id: string, label: string, events: Array<object>}|null}
 */
export function storyPackFor(roleId) {
  const key = String(roleId ?? '').trim();
  if (key === '') return null;
  return STORY_CONTENT_PACKS[key] ?? null;
}

/**
 * 这个角色有没有故事活动玩法(给启动日志/装配用)。
 * 人话结果:`{ enabled, packId, reason }` —— 日志只打 reason,不打印事件内容。
 */
export function storyPackStatus(roleId) {
  const pack = storyPackFor(roleId);
  if (pack) return { enabled: true, packId: pack.id, reason: `内容包=${pack.id}(${pack.events.length} 个事件)` };
  return {
    enabled: false,
    packId: null,
    reason: `角色 ${JSON.stringify(String(roleId ?? ''))} 没有故事内容包 →  story 类活动只报备、不抛钩子`,
  };
}
