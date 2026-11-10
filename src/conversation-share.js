/**
 * **跨通道私聊共享会话**(2026-11-10 / D329)。
 *
 * ## 它解决什么
 *
 * 用户原话:「qq 和网页私聊的惠惠不共享短期记忆,qq 刚说的话在网页不知道」。
 *
 * 到 1.208.12 为止,同一个人的两段私聊是**两条互不相干的会话线**:
 *   · QQ 私聊  → `qqbot-c2c-<openid>`(identity-link 只让"她认得这是谁");
 *   · 网页私聊 → `qqbot-web-<playerId>`;
 * 而模型只读**当前那条线**的历史(`engine.runTurn` 里的 `store.conversationTurns(key)`)。
 * 于是"记忆共用"在效果上只成立到"她认得出人",接不上刚才那句话。
 *
 * ## 口径(和 `webchat.js` 那四条同样刻意)
 *
 * ① **只并"同一个人"的两条私聊线**:网页账号在服务端**已验证绑定**到某个 QQ 时,
 *    网页私聊改用那个 QQ 的私聊会话键 —— 两边此后读写同一段历史;
 * ② ⚠️ **没绑定 / 绑定不一致 / 别的网页账号 / 群聊一律不动**:网页访问者不一定
 *    是 QQ 私聊那个人(用户 2026-11-10 明确提醒),不能因为"QQ 现在只有主人在私聊"
 *    就把所有网页用户并进那条线;
 * ③ ⚠️ **绑定必须两侧自洽**:`identity:bind:<playerId>` 说 openid 是谁,
 *    反查 `byOpenid(openid)` 也必须指回同一个 playerId。库里有两条互相矛盾的
 *    事实时**不共享**(fail closed)—— 宁可两端各聊各的,也不猜;
 * ④ **只改会话/历史归属,不改"这一轮从哪来"**:提示词里仍然说的是"正在网页上
 *    跟你说话"(身份那句见 `index.js` 的 `identityNoteFor`),她不会把渠道搞错。
 *
 * ⚠️ 本模块**零依赖纯函数**(不读库、不发日志):绑定怎么取、会话键怎么拼都由
 *    调用方注入。于是"到底什么情况才共享"可以单独判据,不必起 bot。
 */

/** 允许并入 QQ 私聊线的来源场景(只有网页私聊;群聊/QQ 原样)。 */
export const SHAREABLE_SCENES = Object.freeze(['web']);

/**
 * 规范的网页账号 id(只认 `1`、`42` 这种正整数写法)。
 *
 * ⚠️ 与 `identity-link.js` 的 `bindMetaKey` 同一条口径:`'0'`/`'007'`/`'1e3'`/`'-3'`
 * 一律不认 —— 否则同一个账号会经由两种写法对应到两个绑定键,"共享给谁"变成没答案的问题。
 */
function canonicalPlayerId(value) {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * 网页账号绑定到的 QQ openid —— **两侧自洽**才返回,否则 null(fail closed)。
 *
 * @param {object} input
 * @param {number|string} input.playerId 网页账号 id
 * @param {{playerId?:number|string, openid?:string|null}|null} input.binding
 *        正向记录(`identityLinks.byPlayer(playerId)` 的结果)
 * @param {{playerId?:number|string, openid?:string|null}|null} input.reverse
 *        反查记录(`identityLinks.byOpenid(binding.openid)` 的结果)
 * @returns {string|null} 规范化的 QQ openid;任何一项对不上就是 null
 */
export function verifiedBindingOpenid({ playerId, binding = null, reverse = null } = {}) {
  const id = canonicalPlayerId(playerId);
  if (id === null) return null;
  const openid = String(binding?.openid ?? '').trim();
  if (openid === '') return null;
  // 正向记录若不是"这个账号"的,它就不是绑定 —— 不猜。
  if (Number(binding?.playerId) !== id) return null;
  // ⚠️ 反查必须存在且指回**同一个人、同一个 openid**:少一条就说明库里有两份
  //    不一致的事实(旧版遗留/并发写坏),这时共享"可能把别人的历史接过来"。
  if (!reverse) return null;
  if (Number(reverse?.playerId) !== id) return null;
  if (String(reverse?.openid ?? '').trim() !== openid) return null;
  return openid;
}

/**
 * 这一轮要用的**共享会话目标**(`{scene, targetId}`,交给 `sessionIdFor`)。
 *
 * @param {object} input
 * @param {string} input.scene 消息场景(`web` / `c2c` / `group` / ...)
 * @param {number|string} input.playerId 网页账号 id(只看 `web` 场景)
 * @param {string|null} input.bindingOpenid 已验证的 QQ openid(未绑定给 null)
 * @returns {{scene:'c2c', targetId:string}|null} 不需要共享时给 null(调用方保持原键)
 */
export function sharedConversationTarget({ scene, playerId, bindingOpenid = null } = {}) {
  if (!SHAREABLE_SCENES.includes(String(scene ?? ''))) return null;
  if (canonicalPlayerId(playerId) === null) return null;
  const openid = String(bindingOpenid ?? '').trim();
  if (openid === '') return null;
  // 与 QQ 入站消息**同一个形状**:`{scene:'c2c', targetId: openid}`。
  // 不在这里拼 `qqbot-` 前缀 —— 会话键只有 `index.js` 的 `sessionIdFor` 一份实现。
  return { scene: 'c2c', targetId: openid };
}

/**
 * **这一轮的会话键**(装配层唯一入口;纯函数,依赖全注入)。
 *
 * 只有"网页场景 + 账号已验证绑定"这一种情况会返回 QQ 私聊线的键;
 * 其余(未绑定网页、别的账号、群聊、QQ)一律原样 `sessionIdFor({scene,targetId})`。
 *
 * ⚠️ `lookupBinding` 抛错 = 读不到绑定 → 不共享(fail closed),绝不让"读不出"
 *    退化成"那就共享吧"。
 *
 * @param {object} input
 * @param {{scene?:string, targetId?:string|number, senderId?:string|number}} input.message
 * @param {(target:{scene:string, targetId:any}) => string} input.sessionIdFor 会话键生成(生产传 `index.js` 的同一份)
 * @param {(playerId:string) => ({binding?:object|null, reverse?:object|null})|null} [input.lookupBinding]
 * @returns {{key:string, shared:boolean, openid:string|null}}
 */
export function resolveTurnConversationKey({ message = {}, sessionIdFor, lookupBinding = null } = {}) {
  const scene = String(message?.scene ?? '');
  const targetId = message?.targetId;
  if (typeof sessionIdFor !== 'function') throw new Error('resolveTurnConversationKey: sessionIdFor is required');
  // 非网页场景不经过共享判定(QQ 私聊本来就在那条线上;群聊不该并)。
  if (!SHAREABLE_SCENES.includes(scene)) {
    return { key: sessionIdFor({ scene, targetId }), shared: false, openid: null };
  }
  const rawPlayerId = String(targetId ?? message?.senderId ?? '').replace(/^web:/, '');
  let binding = null;
  let reverse = null;
  if (canonicalPlayerId(rawPlayerId) !== null && typeof lookupBinding === 'function') {
    try {
      const found = lookupBinding(rawPlayerId) ?? {};
      binding = found.binding ?? null;
      reverse = found.reverse ?? null;
    } catch {
      binding = null; // 读不出绑定 = 没绑定(各聊各的)
      reverse = null;
    }
  }
  const openid = verifiedBindingOpenid({ playerId: rawPlayerId, binding, reverse });
  const shared = sharedConversationTarget({ scene, playerId: rawPlayerId, bindingOpenid: openid });
  return {
    key: sessionIdFor(shared ?? { scene, targetId }),
    shared: shared !== null,
    openid,
  };
}
