/**
 * **人(环节点)**:把两个来源的"人"归一化成元素图要的形状(1.91.0 / D147)。
 *
 * ## 为什么单独一个文件
 *
 * 图那一层(`src\elements.js`)**不认识库** —— 它只收现成的行。而"谁在这个世界里"有**两个来源**:
 *
 * | 来源 | 库里是什么 | 它是什么人 |
 * |---|---|---|
 * | **面板账号** | `player` 表(`src\player-account.js`) | 网页上那个玩家(`playerId` 挂在所有互动上) |
 * | **熟人** | `meta['affinity:<openid>']`(1.65 起) | QQ 里说过话的人(只有档位,没有账号) |
 *
 * ⚠️ **两套身份现在还没对上**(账号在网页、openid 在 QQ)—— 这里**不许猜**:
 *    各自成节点,`source` 写清楚是从哪来的;等网页聊天那版把两个 id 对上,只是在这里加一条合并。
 *
 * ⚠️ **分数不出去**:`affinity` 只带 `tierLabel`(档位),`score` 只进图当**内部字段**
 *    (D104 的口径:**只有档位对外**)。
 */

/** 人的 id 前缀(`person:` 是人类;`agent:` 是"她/它自己"这种非人主体)。 */
export const PERSON_ID_PREFIX = 'person:';

/** 归一化一个 id(缺了前缀就补上;空值给 null —— **不猜**)。 */
export function personIdOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.includes(':') ? text : `${PERSON_ID_PREFIX}${text}`;
}

/**
 * 名字是不是"整条都不可见"(与 `panel.js` 的 `displayNameOr` **同一套字符集**)。
 *
 * ⚠️ 库里真有这种昵称:QQ 允许用**空白 / 不可见字符**当昵称,于是报表上会打出一条
 *    什么都没有的行。这里判"整条都不可见",**正常的名字一个字都不动**。
 *
 * ⚠️ **这里是第二份**(第一份在 `panel.js` 的 `displayNameOr`)。为什么没合并成一份:
 *    合就得让 `panel.js` 依赖一个新模块 —— 而它是全项目最脆的文件(那个大模板字符串
 *    注释里出现反引号就会 500,判据要出图才算数)。**权衡后决定不动它**:
 *    两处**必须同时改**(`panel.js` 里那句注释也写着这条)。哪天 panel 那边加了字符,这里会不同步。
 */
const INVISIBLE_NAME_RE = /[\s\u200B-\u200D\uFEFF\u3164\uFFA0\u115F\u1160]/g;

export function nameIsInvisible(raw) {
  return String(raw ?? '').replace(INVISIBLE_NAME_RE, '') === '';
}

/** 零宽字符(拼在名字**中间**的那些)—— 去掉,但不算"整条不可见"。 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * **面板账号** → 人。
 *
 * @param {Array<object>} rows `player` 表的行(或 `publicPlayer()` 的输出)
 * @returns {Array<object>}
 */
export function peopleFromAccounts(rows = []) {
  return (rows ?? [])
    .map((row) => {
      const id = Number(row?.id);
      if (!Number.isInteger(id) || id <= 0) return null;
      const account = String(row?.account ?? '').trim();
      // ⚠️ 昵称可能是"整条不可见"(`ㅤ` 那种)—— 那就退回账号;账号也没有才用编号。
      //    **不编一个名字出来。**
      const rawNickname = String(row?.nickname ?? '').trim();
      const nickname = nameIsInvisible(rawNickname) ? '' : rawNickname;
      return {
        id: `player:${id}`,
        label: nickname || account || `玩家 #${id}`,
        kind: 'acquaintance',
        source: 'account',
        account: account || null,
        nickname: nickname || null,
        disabled: row?.disabled === true,
        acceptsGifts: row?.disabled !== true,
      };
    })
    .filter(Boolean);
}

/**
 * **熟人**(`meta['affinity:<openid>']` 那一族)→ 人。
 *
 * ⚠️ 落盘的值里**可能没有 `id`**(1.65 的第一版就是那样)—— 那就**从 meta 键的尾巴取**,
 *    而不是拿名字当 id(名字是显示用的,会重复、会改;id 不会)。
 * ⚠️ 名字可能整条都是"不可见字符"(面板上是 `displayNameOr` 挡着)—— 这里照实说
 *    "（QQ 上的熟人）",**别在报表上留一行空白**。**不编一个名字出来。**
 *
 * @param {Array<{key:string,value:string}>} metas `stateStore.listMetaKeys('affinity:')` 的输出
 * @param {{affinityTier?: (score:number) => {label?:string}|null}} [deps] 档位函数(`affinity.js`)
 */
export function peopleFromAffinities(metas = [], { affinityTier = null } = {}) {
  const people = [];
  for (const row of metas ?? []) {
    const key = String(row?.key ?? '');
    if (!key.startsWith('affinity:')) continue;
    let parsed = null;
    try { parsed = JSON.parse(String(row?.value ?? '')); } catch { parsed = null; }
    const openid = String(parsed?.id ?? key.slice('affinity:'.length)).trim();
    const id = personIdOf(openid);
    if (!id) continue;
    const rawName = String(parsed?.name ?? '').replace(ZERO_WIDTH_RE, '').trim();
    const name = nameIsInvisible(rawName) ? '' : rawName;
    const score = Number.isFinite(Number(parsed?.score)) ? Number(parsed.score) : 0;
    const tier = parsed?.tier?.label ?? (typeof affinityTier === 'function' ? affinityTier(score)?.label : null);
    people.push({
      id,
      label: name || '（QQ 上的熟人）',
      kind: 'acquaintance',
      source: 'affinity',
      openid: openid || null,
      acceptsGifts: true,
      affinity: { score, tierLabel: tier ?? null },
    });
  }
  return people;
}

/**
 * **把"面板账号"、"QQ 熟人"、"她世界里的玩家"合成一个人**(1.97.0 / D158;1.100.0 / D162 补第三套)。
 *
 * ⚠️ 这是 1.91.0 那份注释里留的那一步(原文:「**两套身份现在还没对上**……
 *    等网页聊天那版把两个 id 对上,只是在这里加一条合并」)。现在那一步到了:
 *    网页上登录的玩家可以**绑一个 QQ**(`src\identity-link.js` 的一次性口令),
 *    于是 `player:7` 与 `person:<openid>` **说的可以是同一个人**。
 *
 * 1.100.0 补上**第三套**(`person` 表 = 她按群记下来的那个人,也就是她**在提示词里叫的名字**)。
 * ⚠️ 名字的优先级是刻意的:**玩家自己起的昵称 > 她被告知的名字(`/认人`) > 自动记下的名字** ——
 *    前一个是本人在网页上给自己起的名,中间那个是**操作者明确告诉她的称呼**,最后才是顺带记的。
 *
 * 三条口径:
 * ① **合的是身份,不是账**:好感度仍然是 `affinity:<openid>` 那本账(QQ 那条路上的),
 *    这里只是把它**挂到同一个人的节点上**(`affinity` 字段照旧只出档位);
 * ② **两个 id 都留着**:节点 id 用账号那个(`player:7`),但 `openid` 一并带上 ——
 *    谁要按 openid 回查也能查到,不必再猜;
 * ③ **没绑的不动**:没有绑定关系时,行为与以前**逐字相同**(各自成节点)。
 *
 * @param {Array<object>} accounts `peopleFromAccounts()` 的输出
 * @param {Array<object>} affinities `peopleFromAffinities()` 的输出
 * @param {Array<{playerId:number, openid:string, displayName?:string|null}>} bindings
 *        `src\identity-link.js` 的 `all()` 的输出
 * @param {Array<object>} [persons] `peopleFromPersons()` 的输出(**第三套**:她按群记下的人)
 * @returns {{people: Array<object>, merged: Array<{playerId:number, openid:string, label:string}>}}
 */
export function joinPeople(accounts = [], affinities = [], bindings = [], persons = []) {
  const byOpenid = new Map();
  for (const row of affinities ?? []) {
    const openid = String(row?.openid ?? '').trim();
    if (openid) byOpenid.set(openid, row);
  }
  // ⚠️ 第三套(她按群记的人)按 openid 并到熟人那一侧:**名字以它为准**(她被告知的称呼),
  //    但**好感档位仍然来自 affinity**(那是账,不是名字)。
  for (const row of persons ?? []) {
    const openid = String(row?.openid ?? '').trim();
    if (!openid) continue;
    const hit = byOpenid.get(openid);
    if (!hit) { byOpenid.set(openid, row); continue; }
    byOpenid.set(openid, { ...hit, toldName: row.toldName ?? null, scenes: row.scenes ?? [], source: 'affinity+person' });
  }
  const usedOpenids = new Set();
  const merged = [];
  const people = [];
  for (const account of accounts ?? []) {
    const playerId = Number(String(account?.id ?? '').replace(/^player:/, ''));
    const link = (bindings ?? []).find((row) => Number(row?.playerId) === playerId && String(row?.openid ?? '').trim());
    const mate = link ? byOpenid.get(String(link.openid).trim()) : null;
    if (!link || !mate) { people.push(account); continue; }
    usedOpenids.add(String(link.openid).trim());
    merged.push({ playerId, openid: String(link.openid).trim(), label: account.label ?? mate.label });
    people.push({
      ...account,
      // ⚠️ 名字优先级:**玩家自己起的昵称 > 她被告知的名字(`/认人`)> 自动记的 > 账号名**
      label: account.nickname || mate.toldName || mate.label || account.label,
      openid: String(link.openid).trim(),
      // ⚠️ 档位从 QQ 那条账上取(合的是身份,账还是那本账)
      affinity: mate.affinity ?? null,
      // 她在哪几个场合记过这个人(第三套带上来的)
      scenes: mate.scenes ?? [],
      linked: true,
      note: '面板账号 + QQ 是同一个人（identity:bind）',
    });
  }
  // 没被任何账号认领的熟人:照旧各自成节点
  for (const [openid, row] of byOpenid) {
    if (!openid || usedOpenids.has(openid)) continue;
    people.push(row);
  }
  return { people, merged };
}

/**
 * **她世界里的玩家**(`person` 表)→ 人(**第三套身份**,1.100.0 / D162)。
 *
 * 前两套是"面板账号"与"QQ 熟人(affinity)";这是第三套,而它一直**没被合进来**:
 *
 * | 库里是什么 | 它是什么人 |
 * |---|---|
 * | `person(scope, openid, display, scene, first_seen, last_seen, turns)` | **她按群/私聊记下来的人** —— 也就是她**在提示词里叫的那个人** |
 *
 * ⚠️ 三条刻意的口径:
 * ① **`openid` 在不同 scope 下不是同一个 openid**(D09:群成员 openid 按群发)——
 *    所以这是"同一个 openid 在几个群里出现过"的合并,**不是**"同一个人只有一个 openid";
 *    节点 id 仍然按 openid 走(与 `affinity:` 那一套**同一个 id 空间**,于是两边能对上);
 * ② **名字可能整条不可见**(平台允许):那就退回"（QQ 上的熟人）",**不编名字**;
 * ③ **`/认人` 指定的名字要看得出来**:`display` 就是她**被告知**该用的那个名字 ——
 *    所以它在合并里的优先级**高于** `affinity` 自动记下的名字(见 `joinPeople`)。
 *
 * @param {Array<object>} rows `stateStore.people()` 或 `person` 表的行
 * @returns {Array<object>}
 */
export function peopleFromPersons(rows = []) {
  const byOpenid = new Map();
  for (const row of rows ?? []) {
    const openid = String(row?.openid ?? '').trim();
    const id = personIdOf(openid);
    if (!id) continue;
    const rawName = String(row?.display ?? '').replace(ZERO_WIDTH_RE, '').trim();
    const name = nameIsInvisible(rawName) ? '' : rawName;
    const lastSeen = Number(row?.lastSeen ?? row?.last_seen) || 0;
    const turns = Number(row?.turns) || 0;
    const scope = String(row?.scope ?? '').trim() || null;
    const hit = byOpenid.get(id);
    if (!hit) {
      byOpenid.set(id, {
        id,
        label: name || '（QQ 上的熟人）',
        kind: 'acquaintance',
        source: 'person',
        openid: openid || null,
        acceptsGifts: true,
        // ⚠️ **名字是"她被告知该用的"** —— 与 affinity 自动记的不是一回事
        toldName: name || null,
        scenes: scope ? [scope] : [],
        lastSeen,
        turns,
      });
      continue;
    }
    // 同一个 openid 出现在多个 scope:名字取**最近见到的那个**,scope 累加
    if (scope && !hit.scenes.includes(scope)) hit.scenes.push(scope);
    if (name && lastSeen >= hit.lastSeen) { hit.label = name; hit.toldName = name; }
    hit.lastSeen = Math.max(hit.lastSeen, lastSeen);
    hit.turns += turns;
  }
  return [...byOpenid.values()];
}

/** 把两个来源合起来(同一 id 只留一条;**先账号后熟人** —— 重复时以更"实"的那条为准)。 */
export function mergePeople(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const row of group ?? []) {
      const id = personIdOf(row?.id);
      if (!id || byId.has(id)) continue;
      byId.set(id, { ...row, id });
    }
  }
  return [...byId.values()];
}

/** 人的一句话(报告与页面共用):谁 + 什么身份 + 从哪来 + 现在什么档位。 */
export function describePerson(row = {}) {
  const kindLabel = {
    bot: '机器人',
    creator: '操作者',
    companion: '同伴',
    goddess: '女神',
    acquaintance: '熟人',
    npc: 'NPC',
  }[row.kind] ?? row.kind ?? '人';
  const sourceLabel = {
    account: '面板账号',
    affinity: 'QQ 熟人',
    declared: '声明(库里还没有)',
  }[row.source ?? (row.declared ? 'declared' : '')] ?? null;
  const tier = row.affinity?.tierLabel ? ` · ${row.affinity.tierLabel}` : '';
  const parts = [row.label ?? row.id, kindLabel];
  if (sourceLabel) parts.push(sourceLabel);
  // ⚠️ 绑过 QQ 的要**说出来**(1.97.0):否则报表上"面板账号 + QQ 熟人"合成一个人之后
  //    看不出来它凭什么合成一条 —— 那是"看着像合并、其实是巧合"的形状。
  if (row.linked === true) parts.push('已绑 QQ');
  return `${parts.join(' · ')}${tier}`;
}
