/**
 * 群身份:群名、人数,以及"这个 openid 到底是不是我以为的那个群"。
 *
 * 为什么单独有这个模块(2026-09-28,D59):
 *   ① 用户要"屏蔽万紫千红那个五人群",而**平台只给 openid、不给群名** ——
 *      `known_group` 那张表是从"收到过的消息"里长出来的**派生索引**,
 *      我曾把它当成"她所在的群清单",于是把一个群认成了"她不在里面"(实际在)。
 *   ② openid 还是**逐机器人不同**的:同一个万紫千红,当前角色看到 `CA1EA919…`、
 *      协作角色看到 `A1000000…`。所以"按 openid 配白名单"这件事**必须能核对**。
 *   ③ 平台其实有 `GET /v2/groups/{id}/info`(返回 `group_name` / `group_member_num`,
 *      文档写着"仅白名单机器人",实测这两只**能用**)。于是核对是可能的 ——
 *      这里放的就是核对与展示的**纯逻辑**,API 调用在 `src/index.js` 与脚本里。
 */

/**
 * 群名标准化:去掉首尾空白、把全角空格当空格、去掉常见装饰符。
 *
 * ⚠️ 只用于**核对**,不用于显示 —— 显示的永远是从平台拿到的原名。
 */
function normalizeName(value) {
  return String(value ?? '')
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/^[\s\-—–]+|[\s\-—–]+$/g, '')
    .trim();
}

/**
 * "这个群是不是我以为的那个?"
 *
 * 两种模式**故意不对称**:
 *   · `exact`(白名单:允许发到哪些群)—— 必须**完全相等**。松一点就是"发错群"。
 *   · `contains`(黑名单:绝不允许发到哪些群)—— 只要**包含**就算命中。
 *     装饰过的群名(`万紫千红🌸`、`【万紫千红】`)躲不过这一条。
 *
 * @param {{expected?: string|null, actual?: string|null, mode?: 'exact'|'contains'}} [options]
 * @returns {{ok: boolean, reason: string}}
 */
export function checkGroupIdentity({ expected = null, actual = null, mode = 'exact' } = {}) {
  const want = normalizeName(expected);
  if (want === '') return { ok: true, reason: '没写期望的群名（跳过核对）' };
  const got = normalizeName(actual);
  if (got === '') return { ok: false, reason: `拿不到群名，无法核对是不是「${want}」` };
  const ok = mode === 'contains' ? got.includes(want) : got === want;
  return {
    ok,
    reason: ok
      ? `群名核对通过：「${got}」`
      : `群名核对**没过**：期望${mode === 'contains' ? '包含' : '等于'}「${want}」，实际是「${got}」`,
  };
}

/** `lastSeen` 时间戳说成人话(和播报账本同一套口径)。 */
function whenText(at, now = Date.now()) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '很久以前';
  const minutes = Math.round((now - value) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * `/群列表` 的正文 —— 纯函数(数据由 `index.js` 读库 + 查 info 接口后传进来)。
 *
 * 用户 2026-09-28 的现场:他要"屏蔽万紫千红",而列表里只有 `A1000000…` 这种前缀 ——
 * **没法核对哪个 id 是哪个群**。加上群名与人数之后,这件事变成一眼可查。
 *
 * @param {object} options
 * @param {Array<{id: string, lastSeen?: number, announced?: string|null}>} [options.groups]
 * @param {Record<string, {name?: string|null, memberNum?: number|null}|null>} [options.infos]
 *   `null` = 这个群的名字查不到(权限/网络),那时**照旧列出 openid**,并说明原因。
 * @param {string|null} [options.latest] 当前版本(用来标"从没播报过")
 * @param {number} [options.now]
 * @returns {string}
 */
export function formatGroupList({ groups = [], infos = {}, latest = null, now = Date.now() } = {}) {
  if (groups.length === 0) {
    return '还没有已知群聊。\n先在那个群里 @ 她一次 —— 她收到过消息才认得那个群。';
  }
  const lines = [`已知群聊（${groups.length} 个）：`];
  groups.forEach((group, index) => {
    const info = infos?.[group.id] ?? null;
    const name = info?.name ? `「${info.name}」` : '（名字查不到）';
    const members = Number.isFinite(info?.memberNum) ? `${info.memberNum} 人` : '人数未知';
    const announced = group.announced
      ? `本群已播报 ${group.announced}`
      : `本群**从没播报过**${latest ? `（下次会带补课梗概）` : ''}`;
    lines.push(`${index + 1}. ${name} ${members}　\`${String(group.id).slice(0, 8)}…\``);
    lines.push(`   最近活跃 ${whenText(group.lastSeen, now)} · ${announced}`);
  });
  lines.push(
    '',
    '发 `/更新` = 私聊 + 全部；`/更新 2` = 只发第 2 个；`/更新 预览` = 只发私聊。',
    '（群名与人数来自平台的群信息接口；查不到时会照旧只显示 openid。）',
  );
  return lines.join('\n');
}
