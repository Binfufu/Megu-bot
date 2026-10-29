/**
 * **记忆作用域守卫**(P0,2026-10-28)—— 常驻块/洞察只在该出现的地方出现。
 *
 * ## 为什么要有这一层
 *
 * 原文检索/交接是**按会话精确隔离**的(`memory-store` 里 `session.conversation = ?`),
 * 但派生层不是:
 *   · 常驻块(`memory_block`)**每实例四行、全库一份**;
 *   · 洞察(`insight`)按 `created_at` 全库取最新几条;
 *   · 两者都在 `index.js` 的交接/每轮注入处被**无条件**拼进任何会话。
 *
 * 于是同一个 bot 的**私聊内容**会经由这两条派生路径出现在**群聊**里 —— 一 bot 一库
 * 挡不住这件事(那是"实例之间"的隔离,这里是"同一个实例的会话之间")。
 * 合成数据实证(不是线上泄漏证据):私聊金丝雀既进了常驻块的生成输入、也进了
 * 两张渲染结果,而按会话过滤的对照查询不含它。
 *
 * ## 这一层管什么、不管什么
 *
 * 管:**某一段派生内容允许不允许出现在这个会话里**(纯函数,零 IO)。
 * 不管:内容怎么生成、怎么存、怎么检索 —— 那些继续留在 memory 层。
 *
 * ## 判据口径
 *
 * **fail closed**:认不出的会话形态、没有名单可比对的私聊以外的形态,一律**不给**私有内容;
 * 群聊只拿 `about-her`(她是谁的静态身份锚点,不是某个人的私事)。
 *
 * ## 已知残余(不在本层解决,别把这里吹成"全修好了")
 *
 * 1. 没配 `QQBOT_ADMIN_IDS` 时,私聊一律放行(为了不让主人**静默失去**常驻记忆)。
 *    这意味着"公开 bot 的陌生私聊"也能看到同一份块/洞察 —— 要收紧就得配名单,
 *    或在 P0-b 给块/洞察加 `conversation` 作用域列。
 * 2. 生成输入(`recentNotesText` / `recentInsightNotes`)仍是全库取最近 N 条:
 *    生成的是"这个 bot 对主人的理解",输出已被本层挡住不进群;但
 *    "不同人混进同一份洞察"这件事要等作用域列落地才算解决。
 * 3. 已经进入历史对话上下文的旧注入,本层够不着 —— 那要靠换代/受控交接。
 */

/** 会话 key 的形态:`qqbot-<scene>-<id>`(见 `index.js` 的 `sessionIdFor`)。 */
export const CONVERSATION_KEY_RE = /^qqbot-(c2c|group|web)-(.+)$/;

/**
 * 只有这一块是"公开的":她是谁(静态身份锚点,来自配置,不是某个人说过的话)。
 * 其余三块(关于主人 / 关系 / 约定)默认视为**私有**。
 */
export const PUBLIC_BLOCK_LABELS = Object.freeze(['about-her']);

/**
 * 拆会话 key。认不出 → `{ kind: 'unknown', id: null }`(调用方按 fail closed 处理)。
 *
 * @param {string} conversationKey
 * @returns {{kind: 'c2c'|'group'|'web'|'unknown', id: string|null}}
 */
export function parseConversationScope(conversationKey) {
  const match = CONVERSATION_KEY_RE.exec(String(conversationKey ?? ''));
  if (!match) return { kind: 'unknown', id: null };
  const [, kind, id] = match;
  return { kind, id: id === '' ? null : id };
}

/**
 * 这个会话允许看到哪些派生内容。**纯函数**。
 *
 * @param {string} conversationKey 形如 `qqbot-c2c-<openid>` / `qqbot-group-<群openid>`
 * @param {{ownerIds?: Set<string>|null}} [options]
 *   `ownerIds` = 主人 openid 名单(生产传 `config.policy.admin.ids`)。
 *   `null`/空 = 没配名单 —— 私聊保持既有行为,但**群聊照样不给私有内容**。
 * @returns {{kind: string, id: string|null, privateBlocks: boolean, insights: boolean, reason: string}}
 */
export function memoryAccessFor(conversationKey, { ownerIds = null } = {}) {
  const { kind, id } = parseConversationScope(conversationKey);
  const denied = (reason) => ({ kind, id, privateBlocks: false, insights: false, reason });
  if (kind === 'c2c') {
    const listed = ownerIds instanceof Set && ownerIds.size > 0;
    if (!listed) {
      // 兼容档:没配名单就分不出"主人私聊"和"陌生人私聊",宁可保留主人的记忆。
      // ⚠️ 代价写在文件头「已知残余 1」—— 这是**待收紧**的现状,不是设计目标。
      return { kind, id, privateBlocks: true, insights: true, reason: 'c2c-unverified-owner' };
    }
    if (id !== null && ownerIds.has(id)) {
      return { kind, id, privateBlocks: true, insights: true, reason: 'owner-c2c' };
    }
    return denied('other-user-c2c');
  }
  // 群聊:公共场合,私有内容一概不进(这是本次要治的主路径)。
  if (kind === 'group') return denied('group');
  // 网页私聊:玩家账号,不是"主人私聊"的口径;认不出是不是本人 → fail closed。
  if (kind === 'web') return denied('web');
  return denied('unknown-conversation');
}

/**
 * 按访问策略过滤常驻块。**纯函数** —— 不读库、不改入参。
 *
 * @param {Array<{label: string}>} blocks
 * @param {{privateBlocks?: boolean}} access `memoryAccessFor` 的返回
 * @returns {Array} 允许渲染的块(保序)
 */
export function filterBlocksForAccess(blocks, access) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (access?.privateBlocks === true) return list;
  return list.filter((block) => PUBLIC_BLOCK_LABELS.includes(String(block?.label ?? '')));
}

/**
 * 按访问策略过滤洞察。**纯函数** —— 洞察是"跨多条私聊笔记看出的模式",群聊一律不给。
 *
 * @param {Array<object>} rows
 * @param {{insights?: boolean}} access `memoryAccessFor` 的返回
 * @returns {Array} 允许渲染的行
 */
export function filterInsightsForAccess(rows, access) {
  const list = Array.isArray(rows) ? rows : [];
  return access?.insights === true ? list : [];
}

/**
 * 人话一句(给启动/排障日志用):**不打印内容**,只说这一档给了什么。
 * @param {ReturnType<typeof memoryAccessFor>} access
 */
export function describeMemoryAccess(access) {
  const blocks = access?.privateBlocks === true ? '块=全部' : '块=仅about-her';
  const insights = access?.insights === true ? '洞察=给' : '洞察=不给';
  return `${blocks}｜${insights}（${access?.reason ?? 'unknown'}）`;
}
