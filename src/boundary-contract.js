/**
 * **边界契约**(2026-10-10,`1.106.6` / D178)—— 一页回答"谁拥有 / 什么时候交回 / 怎么交回"。
 *
 * ## 为什么有它
 * **先把边界写成契约**——两个系统接起来之前,先把"谁拥有状态、什么时候交回、
 * 怎么交回"写死;否则出问题时只能靠猜,而且**每次猜的答案都不一样**。
 *
 * 本项目踩过的那些坑(实发 vs 转写、钱体力单行共享、看门口只探进程……)**全是边界没写清**的症状。
 *
 * ## 这一页怎么才不腐烂(关键设计)
 * ⚠️ **数据只此一份 = 本文件**。`node scripts\contract.js --write` 从它生成
 * `docs\16-边界契约.md`;`--check` 与单测再拿每行的 `anchors` 去**真源码**里核。
 * 于是有三种红:**页与数据不同步**、**代码把边界挪走了**、**同一件事出现了第二处实现**(`count`)。
 * 这满足 D159「不许写第二份必须一致的实现」:文档不是第二份,它是这份数据的**渲染**。
 *
 * ## 一条约定
 * `anchors` 只认**不会被无关改动碰到的字符串**(常量名、建表语句、函数名),
 * ⚠️ **不认行号** —— 行号会腐烂,而"这行话还在不在"不会。
 *
 * ⚠️ 1.106.7(D179):"锚点校验 + 渲染表格"的实现抽到 `src\anchored-page.js`,本文件只留自己的行与渲染。
 */
import { checkAnchors, countOccurrences, describeAnchor, renderTable } from './anchored-page.js';
import { neutralizeDecisionRefs } from './public-doc-text.js';

/**
 * 契约的每一行。
 *
 * @typedef {object} ContractRow
 * @property {string} id          稳定 id(表里不显示,校验与引用用)
 * @property {string} boundary    边界叫什么(给人看的)
 * @property {string} owner       **谁拥有**(权威在哪)
 * @property {string} trigger     **什么时候交回**(触发)
 * @property {string} how         **怎么交回**(落成什么)
 * @property {string} [note]      ⚠️ 最容易搞错的那一句
 * @property {Array<{file: string, must?: string[], match?: string[], flags?: string, count?: number}>} anchors
 * @property {boolean} [publicView]  `false` = 依赖网页面板模块、公开集里没有锚点可核,公开视图**不列**这一行。
 *                                  (2026-10-30 发布公开视图时调查:12 行里有 3 行的锚点落在 noPublish 面板模块。)
 * @property {Array<{file: string, must?: string[], match?: string[], flags?: string, count?: number}>} [publicAnchors]
 *                                  公开视图只核这几条(缺省用 `anchors`)。用于"一行里有一条锚属于私有模块"的情况,
 *                                  ⚠️ 只**少核**,不**伪造**——少核的那一条要在公开页里写出来。
 * @property {{owner?: string, trigger?: string, how?: string, note?: string}} [publicText]
 *                                  公开视图对这行文案的替换(去掉网页能力等公开集没有的内容)。
 */
export const CONTRACT_ROWS = Object.freeze([
  {
    id: 'said',
    boundary: '机器人实发正文',
    owner: '**出站唯一咽喉** `sendChunked()`(`src\\index.js`)—— 任何一条真的发出去的消息都从这里走',
    trigger: '每一条真的发出去的那一刻',
    how: '写 `state.db` 的 `outbound` 表(时间 / 会话 / 对象 / 主动还是回复 / 字数 / 正文,留 30 天)',
    note: '⚠️ `memory.db` 的 `turn.reply_text` 是**模型原文**,不是实发 —— 判"机器人到底发了什么"只认 `outbound`(D174/D175)',
    anchors: [
      { file: 'src/sqlite-store.js', must: ['CREATE TABLE IF NOT EXISTS outbound'], count: 1 },
      // ⚠️ **只此一处**:出站咽喉不许长出第二个实现(D159)
      { file: 'src/index.js', must: ['recordOutbound({'], count: 1 },
    ],
  },
  {
    id: 'memory',
    boundary: '记忆(轮次 / 摘要 / 标签 / 长期)',
    owner: '**归档管线** `src\\memory-archive.js` → `memory.db`',
    trigger: '每轮结束后按"触发方式"归档一次;启动与每 15 分钟再补收一次',
    how: '`turn` / `summary` / `note` 等表;`kind` 决定它进不进长期层',
    note: '⚠️ `selflife`(机器人自己过日子那一路)**不进长期层**(D176);机器人的话是否"像是人说的"看 `isHumanTurn`',
    anchors: [
      { file: 'src/memory-archive.js', must: ['export function classifyKind', 'export function isSelfLifePrompt', 'NON_MEMORY_KINDS'] },
    ],
  },
  {
    id: 'body',
    boundary: '机器人的身体(钱 / 体力 / 饱食 / 健康 / 心情 / 魔力)',
    owner: '**单行 `stats` 表**(`id = 1`)—— **一只 bot 一份,不按玩家分**',
    trigger: '每次能动数值的动作(吃饭 / 委托 / 睡觉 / 事件结算)',
    how: '直接改那一行;每一笔同时写 `stats_event` 流水(编年史与摘要都从流水派生)',
    note: '⚠️ **两个玩家共用机器人一个身体**:A 花的钱、A 扣的体力,B 立刻受影响 —— 这不是 bug,是"机器人只有一个身体"；这里记录的是共享状态口径',
    anchors: [
      { file: 'src/sqlite-store.js', match: ['CREATE TABLE IF NOT EXISTS stats \\([\\s\\S]{0,240}?CHECK \\(id = 1\\)'] },
    ],
  },
  {
    id: 'fishing',
    boundary: '钓鱼(钓位 / 鱼篓 / 这一竿)',
    owner: '**按人**:`fishing:<group|c2c>:<群id|应用id>:<userId>`(`src\\play\\fishing.js`)',
    trigger: '甩竿 / 收杆 / 结算,每个动作各自落一次',
    how: '按那个 key 读改写;一个人一个钓位',
    note: '⚠️ 与"机器人的身体"正相反:**钓鱼按人隔离**,所以两个人同时甩竿**不会互相顶掉**、鱼篓也不串号',
    anchors: [
      { file: 'src/play/fishing.js', must: ["fishing:${scene === 'group' ? 'group' : 'c2c'}:${place}:${userId || 'anon'}"] },
    ],
  },
  {
    id: 'position',
    boundary: '位置 / 在场("谁在哪")',
    owner: '**按玩家**:`world:player:<playerId>` 一条事实(`src\\player-world.js`);机器人自己的位置是另一条',
    trigger: '有人移动(`move.to`)/ 机器人出门与到达(位置事实带 TTL)',
    how: '写/读 `metas` 里的位置事实;TTL 到期即"不在这儿了"',
    note: '⚠️ 游客**没有位置**(不给匿名者编一个身份);机器人的位置 TTL 由 `whereaboutsTtlMs()` 派生(D172)',
    anchors: [
      { file: 'src/player-world.js', must: ['export const PLAYER_WORLD_PREFIX', "world:player:"] },
    ],
  },
  {
    id: 'home',
    publicView: false, // 锚点在 noPublish 的 src\panel-actions.js:公开树里没这条锚可核
    boundary: '家园(家具 / 收进去的东西)',
    owner: '**共享**:`home:shared` —— 一个大家一起互动的家,不是每人一个',
    trigger: '`home.put` / `home.take` 两种动作',
    how: "`home_item` 事实 + 布局挂 `meta['home:layout']`",
    note: '⚠️ **别按玩家分**:家园是"一个大家都能互动的世界"；这是共享状态的定义，不是每位玩家的独立存档',
    anchors: [
      { file: 'src/panel-actions.js', must: ['const HOME_KEY_RE = /^home:shared$/;'] },
    ],
  },
  {
    id: 'quest',
    boundary: '委托(这一局 / 看板)',
    owner: '**公会看板**:一局挂在看板键上(`quest_board:<…>`)',
    trigger: '接 / 走流程 / 结算 / 放弃 四种动作',
    how: '`openQuest()` 起一局,状态挂在看板键上;结算写 `stats_event`',
    note: '⚠️ 看板**共享**:A 接了,B 看到的是同一局(可能正是"抢"的玩法);同一条两人同时点「接」的幂等性**没验过**，不能由本页推断并发交互已验收',
    anchors: [
      { file: 'src/quest-take.js', must: ["export const QUEST_BOARD_KEY_PREFIX = 'quest_board:';"] },
      { file: 'src/panel-actions.js', must: ['const QUEST_RUN_RE = /^quest:(quest_board:'] },
    ],
    // 公开视图只核 QQ 侧那条;面板那条锚在 noPublish 模块里,不核也不冒充已核。
    publicAnchors: [
      { file: 'src/quest-take.js', must: ["export const QUEST_BOARD_KEY_PREFIX = 'quest_board:';"] },
    ],
  },
  {
    id: 'accounts',
    publicView: false, // 锚点在 noPublish 的 src\panel.js / src\panel-actions.js
    boundary: '网页世界的账号与互动闸门',
    owner: '`player` 表 + 邀请码(`scripts\\account.js invite-new`);闸门在 `src\\panel.js`',
    trigger: '注册(要邀请码)/ 登录 / 每次带非零 `nonce` 的写动作',
    how: '登录票据(`x-panel-device` / `x-panel-player`)+ `requireAccountForActions` 决定要不要账号',
    note: '⚠️ **看世界不用账号,动手才要**(默认 `requireAccountForActions=false`);⚠️ 网络出口**只查登录、不查 operator**(operator 只长在 QQ 侧)',
    anchors: [
      { file: 'src/panel.js', must: ['requireAccountForActions'] },
      { file: 'src/panel-actions.js', must: ['export const PANEL_ACTION_KINDS'] },
    ],
  },
  {
    id: 'session-key',
    boundary: '会话键(机器人跟"谁"说话)',
    owner: '`conversationKeyFor(message)`(`src\\index.js`)—— `qqbot-c2c-<openid>` / `qqbot-group-<群id>`,网页是 `qqbot-web-<playerId>`',
    trigger: '每条入站消息 / 每次主动发言',
    how: '会话键标识持久对话与记忆归档的 `conversation`;`/重置` 让它进下一"代"(`-g<N>`)',
    note: '⚠️ 键是**会话**不是"机器人的身份":私聊里关于对方的事实另用 `self`;机器人**只有一个身体**,不按 QQ 用户分身(D132/D171)',
    anchors: [
      { file: 'src/index.js', must: ['function conversationKeyFor(message)'] },
      { file: 'src/memory-archive.js', must: ['qqbot-group-<openid> / qqbot-c2c-<openid>'] },
    ],
    // 公开集没有网页:网页会话键那半句不在公开视图里出现。
    publicText: {
      owner: '`conversationKeyFor(message)`(`src\\index.js`)—— `qqbot-c2c-<openid>` / `qqbot-group-<群id>`',
    },
  },
  {
    id: 'restart',
    boundary: '重启后会丢的"内存态"',
    owner: '**进程内存**(`groupContext.knownGroups()`、暖群状态、连发窗口……)',
    trigger: '进程退出/重启 —— 没有交回,直接归零',
    how: '⚠️ **目前没有交回**:重启后要配"重启代数 + 状态重发"；状态恢复仍是明确缺口',
    note: '⚠️ "进程在跑" ≠ "这些状态还在":`knownGroups()` 只认**本次进程收到过消息**的群(D172 现场踩过)',
    anchors: [
      { file: 'src/group-context.js', must: ['knownGroups()'] },
    ],
  },
  {
    id: 'quota',
    boundary: '平台配额(几条 / 多快)',
    owner: '**平台**(入站一条消息最多 5 条被动回复)+ **机器人的情绪上限**(普通发言分条发)',
    trigger: '每次要发多条时',
    how: '`planSpokenLines()` 统一分条(答话/合并/早安/自发/网页同一份,D288),`sendSpokenLines()` 每段一条并**接续 `msg_seq`**;普通发言超量的段**并进最后一段**(不截断、不转主动配额),只有显式启用的特殊分段动作超限才走主动配额(20/分钟、1000/天)',
    note: '⚠️ 口语标点清理在**分条之后**(行尾剥 + 段内停顿标点变空格;`～` 保留,D288);段间节拍 = `spoken.baseDelayMs + 字数×perCharDelayMs`±15% 抖(【暂定】)',
    anchors: [
      { file: 'src/index.js', must: ['const MAX_PASSIVE_SEQ = 5;'] },
      { file: 'src/mood.js', must: ['export function splitSpokenLines', 'CHAT_TRAILING_PUNCT'] },
    ],
    // 公开集没有网页:分条规划的"同一份"里去掉网页那半句。
    publicText: {
      how: '`planSpokenLines()` 统一分条(答话/合并/早安/自发同一份),`sendSpokenLines()` 每段一条并**接续 `msg_seq`**;普通发言超量的段**并进最后一段**(不截断、不转主动配额),只有显式启用的特殊分段动作超限才走主动配额(20/分钟、1000/天)',
    },
  },
  {
    id: 'panel-actions',
    publicView: false, // 锚点在 noPublish 的 src\panel-actions.js / src\panel-view.js
    boundary: '面板能做什么(动作词表)',
    owner: '**真相在 `src\\panel-actions.js`**(`PANEL_ACTION_KINDS`);`src\\panel-view.js` 只是"前端投影"',
    trigger: '页面上按下一个按钮(`POST /api/actions`)',
    how: '动作 → 改状态 → 回一段"机器人做了什么"的话 + 事件;非零 `nonce` 防重放',
    note: '⚠️ **不许在前端再列一份动作清单**(D159);前端要什么由服务端随快照给',
    anchors: [
      { file: 'src/panel-actions.js', must: ['export const PANEL_ACTION_KINDS'] },
      { file: 'src/panel-view.js', must: ['真相在'] },
    ],
  },
]);

/** 每一行必须有这几样(单测与 `--check` 都按它判)。 */
export const REQUIRED_FIELDS = Object.freeze(['id', 'boundary', 'owner', 'trigger', 'how']);

/**
 * 公开集里**能真的核对**的契约行(2026-10-30)。
 *
 * 调查结论:12 行里有 3 行(`home` / `accounts` / `panel-actions`)的锚点在 noPublish 的网页/面板模块,
 * 公开树里没有那些文件 —— 它们整行不进公开视图;`quest` 行只有一条侧锚落在面板模块,用 `publicAnchors` 少核那一条。
 *
 * @param {readonly ContractRow[]} [rows]
 * @returns {readonly ContractRow[]}
 */
export function publicContractRows(rows = CONTRACT_ROWS) {
  return rows.filter((row) => row.publicView !== false);
}

/** 公开视图里每行的锚:有 `publicAnchors` 就用它(少核的那几条不许假装核过)。 */
function anchorsForPublic(row) {
  return row.publicAnchors ?? row.anchors ?? [];
}

/** 公开视图的文案:原字段 + 这行的 `publicText` 替换,最后统一去掉内部决策号。 */
function publicField(row, field) {
  const override = row.publicText?.[field];
  return neutralizeDecisionRefs(override ?? row[field] ?? '');
}

/**
 * 把契约渲染成**那一页**(markdown,确定性输出 —— 不含时间戳,否则每次生成都不一样)。
 *
 * @param {readonly ContractRow[]} [rows]
 * @returns {string}
 */
export function renderContractPage(rows = CONTRACT_ROWS) {
  const lines = [];
  lines.push('# 16 · 边界契约 —— 谁拥有 / 什么时候交回 / 怎么交回');
  lines.push('');
  lines.push('> ⚠️ **本页由 `node scripts\\contract.js --write` 生成,别手改**(数据在 `src\\boundary-contract.js`;');
  lines.push('> 改数据 → 重新生成 → `node scripts\\contract.js --check`;页与数据不同步时 `selftest` 会变红)。');
  lines.push('>');
  lines.push('> **用途**：说明共享与隔离边界、状态权威和交回机制；用真实源码锚点核对，不把模型叙述当状态证据。');
  lines.push('> 本页保留完整工程契约，包括网页相关行；网页不属于节点 A 公开能力，公开裁剪树缺少相关模块时不能声称完整锚检查通过。');
  lines.push('> 公开集可读的裁剪视图见 `docs\\16-边界契约-公开版.md`(`node scripts\\contract.js --public --write`),只列公开集里能真的核的边界。');
  lines.push('');
  lines.push(...renderTable(
    ['边界', '谁拥有(权威)', '交回触发', '怎么交回'],
    rows.map((row) => [row.boundary, row.owner, row.trigger, row.how]),
  ));
  lines.push('');
  lines.push('## 逐条:容易搞错的那一句 + 凭什么这么写(锚)');
  lines.push('');
  for (const row of rows) {
    lines.push(`### ${row.boundary}`);
    if (row.note) lines.push(`- ${row.note}`);
    for (const anchor of row.anchors ?? []) lines.push(`- ${describeAnchor(anchor)}`);
    lines.push('');
  }
  lines.push('## 这一页**不**管什么(免得被当万灵药)');
  lines.push('');
  lines.push('- 它不替代实现代码与专项测试，只记录**边界与权威**。');
  lines.push('- 它不保证"两个玩家玩起来是好的":共享钱包/共用体力**是口径问题,不是 bug**(要改就得动 `stats` 的分身,影响面大)。');
  lines.push('- `restart` 行中的进程内状态恢复仍是**缺口**，不能因为进程重新启动就认定状态已恢复。');
  return `${lines.join('\n')}\n`;
}

/**
 * 把契约渲染成**公开集视图**(2026-10-30)。
 *
 * 与私有全量页同一个数据源(`CONTRACT_ROWS`),区别只有三处:
 * ① 依赖网页/面板模块锚点的行整行不列(在「公开视图口径」里点名,不藏);
 * ② `quest` 这类"一条侧锚在私有模块"的行只核公开侧,并写明少核了哪半;
 * ③ 文案去掉内部决策号与公开集没有的网页能力(`publicText` + `neutralizeDecisionRefs`)。
 *
 * ⚠️ 公开树里跑 `node scripts\\contract.js --public --check` 就是按这个口径核;不核的行不冒充已核。
 *
 * @param {readonly ContractRow[]} [rows]
 * @returns {string}
 */
export function renderPublicContractPage(rows = CONTRACT_ROWS) {
  const visible = publicContractRows(rows);
  const excluded = rows.filter((row) => row.publicView === false);
  const trimmed = visible.filter((row) => row.publicAnchors);
  const lines = [];
  lines.push('# 16 · 边界契约(公开集视图) —— 谁拥有 / 什么时候交回 / 怎么交回');
  lines.push('');
  lines.push('> ⚠️ **本页由 `node scripts\\contract.js --public --write` 生成,别手改**(数据在 `src\\boundary-contract.js`;');
  lines.push('> 改数据 → 重新生成 → `node scripts\\contract.js --public --check`;页与数据不同步时公开自测会变红)。');
  lines.push('>');
  lines.push('> **用途**：说明公开集里的共享与隔离边界、状态权威和交回机制；用真实源码锚点核对，不把模型叙述当状态证据。');
  lines.push('> 公开视图只渲染**公开集里能真的核对**的边界行；完整工程契约(含网页相关行)是私有全量页 `docs\\16-边界契约.md`,不随公开集分发。');
  lines.push('');
  lines.push(...renderTable(
    ['边界', '谁拥有(权威)', '交回触发', '怎么交回'],
    visible.map((row) => [
      publicField(row, 'boundary'), publicField(row, 'owner'), publicField(row, 'trigger'), publicField(row, 'how'),
    ]),
  ));
  lines.push('');
  lines.push('## 公开视图口径(为什么少了几条)');
  lines.push('');
  lines.push('- 公开集不含网页面板/网页模块。以下三条边界**不在公开集**,其源码锚点也在面板模块里(公开树没有那些文件) —— 因此不列入本页,也**不做**锚点核对(不冒充"已核"):');
  for (const row of excluded) lines.push(`  - ${row.boundary}`);
  lines.push('- 完整口径见 `docs\\37-公开架构说明.md` §6「明确不在公开范围的东西」。');
  if (trimmed.length > 0) {
    lines.push(`- 下面这些行的锚点有一部分落在面板模块上:${trimmed.map((row) => `「${row.boundary}」`).join('、')}；本页**只核公开集里那条**,面板侧不核。`);
  }
  lines.push('- 内部决策号不在公开页出现；要追溯完整记录请回私有全量页。');
  lines.push('');
  lines.push('## 逐条:容易搞错的那一句 + 凭什么这么写(锚)');
  lines.push('');
  for (const row of visible) {
    const note = publicField(row, 'note');
    lines.push(`### ${publicField(row, 'boundary')}`);
    if (note) lines.push(`- ${note}`);
    for (const anchor of anchorsForPublic(row)) lines.push(`- ${describeAnchor(anchor)}`);
    lines.push('');
  }
  lines.push('## 这一页**不**管什么(免得被当万灵药)');
  lines.push('');
  lines.push('- 它不替代实现代码与专项测试，只记录**边界与权威**。');
  lines.push('- 它不保证"两个玩家玩起来是好的":共享钱包/共用体力**是口径问题,不是 bug**(要改就得动 `stats` 的分身,影响面大)。');
  lines.push('- `restart` 行中的进程内状态恢复仍是**缺口**，不能因为进程重新启动就认定状态已恢复。');
  return `${lines.join('\n')}\n`;
}

/**
 * 按 `anchors` 去真源码里核(**纯函数**:读文件由调用方注入,方便单测喂假数据)。
 *
 * ⚠️ 实现只有一份 —— 在 `src\anchored-page.js`(1.106.7/D179 抽出来,通道策略表也用它)。
 *
 * @param {readonly ContractRow[]} rows
 * @param {{readFile: (relativePath: string) => string}} io
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkContract(rows, io) {
  return checkAnchors(rows, io, { requiredFields: REQUIRED_FIELDS });
}

/**
 * 公开视图的锚点校验:只核公开集里真的存在的锚(`publicAnchors` 优先),**不伪造**。
 *
 * @param {readonly ContractRow[]} rows
 * @param {{readFile: (relativePath: string) => string}} io
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkPublicContract(rows, io) {
  const projected = publicContractRows(rows).map((row) => ({ ...row, anchors: anchorsForPublic(row) }));
  return checkContract(projected, io);
}

export { countOccurrences };
