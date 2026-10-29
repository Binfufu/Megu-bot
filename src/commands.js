import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/**
 * 命令与关键字总表 —— **单一来源**,由 `scripts\command-index.js` 生成 `docs\命令与关键字.md`。
 *
 * 为什么要有这个文件:
 *   1. 桥自己处理的命令(**不到达模型**)散在 `src/index.js` 的几个 `Set` 里,
 *      加上关键字表、加上角色卡里"自称支持"的命令 —— 三处,谁也不知道全貌。
 *      用户 2026-09-27 的原话:「现在手动命令越来越多了,输出一个 md 表格记一下方便我看」。
 *   2. 更要紧的是**防腐烂**:角色卡里写着 `/状态`,但桥真的处理它吗?以前只能靠人眼比。
 *      现在这张表 + `selftest` 的一条测试能直接回答"卡里许愿的命令,代码里到底有没有"。
 *
 * ⚠️ 改这里就要重新生成文档:`node scripts\command-index.js --write`
 *    (有测试盯着"文档与这张表一致",所以忘了会被测出来)。
 *
 * 字段:
 *   name      主命令(写进文档那一列)
 *   aliases   别名(同一件事的其它写法)
 *   scope     c2c(私聊) / group(群里) / both
 *   who       谁能用:anyone(任何人) / operator(操作者名单) / bridge(桥直接处理)
 *   effect    做了什么(一句话)
 *   source    实现在哪(方便跳过去改)
 *   since     哪个版本加的(便于判断新命令)
 */

/** 桥直接处理、**不会**到达模型的命令。 */
const BASE_COMMANDS = [
  {
    name: '/重置',
    aliases: ['/重来', '/reset'],
    scope: 'both',
    who: 'anyone',
    effect: '清空当前会话上下文,重新加载角色卡;这一轮**不注入记忆交接**(否则重置等于没重置)',
    source: 'src/index.js · RESET_COMMANDS',
  },
  {
    name: '/状态',
    aliases: ['/status'],
    scope: 'both',
    who: 'anyone',
    effect: "报当前身体状态；配置其他实例状态库时只读该实例，播报口吻由当前角色决定。",
    source: 'src/index.js · STATUS_COMMANDS',
  },
  {
    name: '/成长',
    aliases: ['/growth', '/等级'],
    scope: 'both',
    who: 'anyone',
    effect: '报养成进度:等级、经验、学会的概念、认识的人(D40)',
    source: 'src/index.js · GROWTH_COMMANDS',
  },
  {
    name: '/钱包',
    aliases: ['/钱', '/money'],
    scope: 'both',
    who: 'anyone',
    effect: "报告当前余额，金额来自实际账本；详细收支由相应查询入口提供。",
    source: 'src/index.js · WALLET_COMMANDS',
  },
  {
    name: '/熟人',
    aliases: ['/认识的人'],
    scope: 'both',
    who: 'anyone',
    effect: '列出**机器人认识的人各自的亲疏档位**(眼熟/认得/说得上话/朋友/交心)。' +
      '⚠️ **只说档位不说分**(D104:好感度"只有档位没有数值");' +
      '每人每天涨的上限是硬的 —— 刷屏刷不出"交心"',
    source: 'src/index.js · describeAffinityList',
  },
  {
    name: '/钓鱼',
    aliases: ['/去钓鱼'],
    scope: 'both',
    who: 'anyone',
    effect: '**甩竿钓鱼**(D101 形态三):立刻报出随机水域与钓点、给三种鱼饵,选一种就下饵开始等' +
      '(3~8 分钟,由 tick 收网)。等待期间**聊什么都不结束计时**;收网会 **@ 起钓的人**,然后问怎么处置' +
      '(烤/煮/煎/全卖/带回家风干)。也可以直接说"去钓鱼"触发。一局最多三竿',
    source: 'src/index.js · detectFishing / fishingTick',
  },
  {
    name: '/委托',
    aliases: ['/看板', '/委托面板'],
    scope: 'both',
    who: 'anyone',
    effect: '**显示公会看板**:三条档位各不相同的活(跑腿/正经/危险/看着不对劲),带报酬与体力开销。' +
      '面板由**代码掷**(D44:数字只能来自库),挂 6 小时;接着回 `/接 1`(或 /接 2、/接 3)真的接下来 —— ' +
      '报酬进钱、体力往下掉,并记一笔 `kind=quest` 流水。' +
      '⚠️ 接活有闸门:两条之间至少隔 2 小时、**每天最多 1 条**(面板是用户点出来的,' +
      '不设闸门就能连点刷钱 —— 见 D101 第五节)',
    source: 'src/index.js · QUEST_COMMANDS / QUEST_TAKE_RE',
  },
  {
    name: '/接 <编号>',
    aliases: ['/接委托 <编号>'],
    scope: 'both',
    who: 'anyone',
    effect: '接下 `/委托` 面板上的第 N 条(见上一条的闸门与账本口径)',
    source: 'src/index.js · takeQuest()',
  },
  {
    name: '/help',
    aliases: ['/帮助', '/指令', '/菜单'],
    scope: 'both',
    who: 'anyone',
    effect: '列出这边可用的指令(按场合过滤;只给运维者的那几个不会列给普通人)。正文从这张表生成,不手写第二份',
    source: 'src/index.js · HELP_COMMANDS',
  },
  {
    name: '/重启',
    aliases: ['/restart'],
    scope: 'c2c',
    who: 'operator',
    effect: '请求当前实例重启，仅认私聊操作者。自动重开取决于启动包装器；' +
      '公开 demo 不安装守护或自启，不承诺所有包装器收到请求后都会重开。',
    source: 'src/index.js · RESTART_COMMANDS',
  },
  {
    name: '/更新',
    aliases: ['/播报', '/release'],
    scope: 'both',
    who: '私聊=operator / 群里=anyone(幂等)',
    effect: '手动播报更新日志。群里那条走**被动回复**把播报送进本群,同群同版本只发一次;私聊那条会发往所有已知群,所以必须校验操作者(D32/D33)。' +
      '私聊还认子命令:`/更新 预览 [版本]`、`/更新 账本`、`/更新 回退`、`/更新 基线 <版本>`(D58)',
    source: 'src/index.js · ANNOUNCE_COMMANDS',
  },
  {
    name: '/发',
    aliases: ['/发布', '/send'],
    scope: 'c2c',
    who: 'operator',
    effect: '**确认发送**更新播报 —— 我在私聊问你"要发吗"之后回这句。不带参数 = 私聊 + 全部已知群;' +
      '`/发 私聊` 只发私聊;`/发 群 2` 只发第 2 个群;`/不发` 这次不发。只在**有等你确认的播报**时才算数(D50)',
    source: 'src/index.js · ANNOUNCE_REPLY_COMMANDS',
  },
  {
    name: '/更新 预览',
    aliases: ['/预览'],
    scope: 'c2c',
    who: 'operator',
    effect: '发私聊看一眼效果,不动账本(D55 —— 第一版会记成已播报,踩过)。' +
      '带版本号 = 假设上次发到那一版再念一遍:`/更新 预览 1.22.0`(D58)',
    source: 'src/index.js · handleAnnounceCommand',
  },
  {
    name: '/更新 账本',
    aliases: [],
    scope: 'c2c',
    who: 'operator',
    effect: '看播报账本:私聊与每个群**现在记到哪一版**、从没播报过的群是哪些、最近几次改动的时间线(D58)',
    source: 'src/index.js · ledgerText',
  },
  {
    name: '/更新 回退',
    aliases: [],
    scope: 'c2c',
    who: 'operator',
    effect: '把账本**退回上一条**(逐群各自回退,从没播报过的群不动)。' +
      '起因:2026-09-28 误发了一版,基线推进去了,`/更新 预览` 就只剩"没有新内容"这句死路(D58)',
    source: 'src/index.js · rollbackBaselines',
  },
  {
    name: '/更新 基线 <版本>',
    aliases: [],
    scope: 'c2c',
    who: 'operator',
    effect: '把**已有**基线的键拨到某一版(下次只播报它之后的改动)。版本必须在 `CHANGELOG.md` 里,否则拒绝;' +
      '从没播报过的群**不动**(它仍会拿到补课梗概)',
    source: 'src/index.js · setBaselinesTo',
  },
  {
    name: '/更新 <编号>',
    aliases: [],
    scope: 'c2c',
    who: 'operator',
    effect: '只发给编号对应的那个群(/群列表 查编号)',
    source: 'src/index.js · handleAnnounceCommand',
  },
  {
    name: '/群列表',
    aliases: ['/groups', '/群'],
    scope: 'c2c',
    who: 'operator',
    effect: '列出已知群与编号,**带群名和人数**(来自平台的群信息接口,D59),以及每个群"已播报到哪一版"。' +
      '群名查不到时照旧只显示 openid —— 那条命令不会因此不可用',
    source: 'src/index.js · GROUP_LIST_COMMANDS',
  },
  {
    name: '/忘了',
    aliases: ['/忘记', '/forget'],
    scope: 'both',
    who: 'anyone',
    effect: '撤销记错的事实（关系/偏好/雷区/健康）：`/忘了 健康 胃炎`;不带参数先列出来。' +
      '固化记忆走 `/忘了 记忆 <关键词>`;**滚动摘要走 `/忘了 摘要`**（它只有一份，不用给值）。' +
      '⚠️ **只能删你自己那条** —— 群里认不出操作者身份（私聊名单是另一个 id 空间），别人的得在后台改',
    source: 'src/index.js · handleForget',
  },
  {
    name: '/旁白测试',
    aliases: ['/旁白'],
    scope: 'group',
    who: 'anyone',
    effect: '立即运行已配置的动作旁白诊断；需要对应内容且已启用旁白。公开 demo 默认关闭，不提供专用动作内容。',
    source: 'src/index.js · narrateExplosion',
  },
  {
    name: '/发图',
    aliases: ['/出图'],
    scope: 'both',
    who: 'operator',
    effect: '可选像素形象发送入口，只给操作者。完整安装需具备对应绘图脚本、内容与 Python/Pillow；' +
      '节点 A 不分发该绘图内容，不将此命令列为 demo 已支持能力。',
    source: 'src/index.js · handleSendImage',
  },
  {
    name: '发N张<角色>美图/涩图',
    aliases: [],
    scope: 'group',
    who: 'anyone',
    effect: '按名称与数量解析发图请求，经别名、分级和安全过滤后由代码检索与发送；' +
      '仅允许的群可用。命中别名的正常请求不调模型；名称未命中时可能单次调用模型辅助理解。',
    source: 'src/meitu-command.js · parseMeituCommand / src/meitu-service.js · handleMeituCommand',
  },
  {
    name: '/认人',
    aliases: ['/知人'],
    scope: 'group',
    who: 'operator',
    effect: '手工把"@ 到的人"和他的**名字**对起来(认识的人)。名字可以省 —— 从 @ 的元数据里取;' +
      '@ 多个人就按顺序给名字。不带参数时列出这个群已认识的人。' +
      '⚠️ 平台没有群成员名单,所以**没说过话的人**需要通过实际提及元数据补充身份',
    source: 'src/index.js · handleLearnPerson',
  },
  {
    name: '/绑定',
    aliases: [],
    scope: 'c2c',
    who: 'anyone',
    effect: '可选网页账号与 QQ 身份绑定入口，仅限私聊，口令一次性且有时效；' +
      '不修改数值。网页不在节点 A 公开范围，因此 demo 不提供绑定口令的获取入口。',
    source: 'src/index.js · handleBindCommand',
  },
];
export const BRIDGE_COMMANDS = BASE_COMMANDS.map((row) => ({ ...row, effect: LOCAL_STORY_WORLD?.commandEffects[row.name] ?? row.effect }));

/**
 * 角色的**自称能力**:角色卡里写了这些命令/说法,但那是给模型看的台词提示。
 * 这张表用来回答"卡里许愿的东东,代码里真有吗" —— 有测试盯着。
 *
 * `implemented` = 桥真的处理(会截住,不到模型);`false` = **只是台词**,模型自由发挥。
 */
const BASE_CARD_CLAIMS = [
  { claim: '/状态', implemented: true, note: '桥处理,读真实数值' },
  { claim: '/钱包', implemented: true, note: '桥处理(D42)' },
  { claim: '/更新', implemented: true, note: '由实例开关 QQBOT_ANNOUNCE 控制' },
  { claim: '/群列表', implemented: true, note: '私聊操作者可用' },
  { claim: '/成长', implemented: true, note: 'D40' },
];
export const CARD_CLAIMS = BASE_CARD_CLAIMS.map((row) => ({ ...row, note: LOCAL_STORY_WORLD?.cardClaimNotes[row.claim] ?? row.note }));

/**
 * 关键词:命中就**跳过防抖与条数门槛**立刻考虑回复(仍受冷却限制)。
 * 唯一来源是 `src/config.js` 的 `DEFAULT_GROUP_KEYWORDS`;这里只做**归类**,
 * 便于文档里看清"哪些词会叫机器人"。
 */
export const KEYWORD_GROUPS = LOCAL_STORY_WORLD?.keywordGroups ?? [];

/**
 * `/help` 的正文 —— 纯函数,所以"机器人到底列了哪些命令"可以直接单测。
 *
 * 用户的要求:「另一角色加一个指令'/help',用来看可用的代码」。
 * 它是从 `BRIDGE_COMMANDS` **生成**的,不是手写的第二份清单 —— 手写的那种一定会腐烂
 * (这个项目已经吃过一次亏:D34 里三处写死的数字全过期了)。
 *
 * 两个刻意的选择:
 *   1. **按场合过滤** —— 群里只列群里能用的(`/更新 预览`、`/群列表` 只在私聊有意义),
 *      免得机器人在群里列出一堆"你在这儿打不了"的命令;
 *   2. **不列运维脚本** —— 那些要在 PowerShell 里跑,不是 QQ 里的命令。
 *      (`docs\命令与关键字.md` 里那张表才是给维护者看的完整版。)
 *
 * @param {{scope?: 'c2c'|'group', isOperator?: boolean, botName?: string|null}} [options]
 */
export function helpText({ scope = 'c2c', isOperator = false, botName = null } = {}) {
  const usable = BRIDGE_COMMANDS.filter((cmd) => {
    if (cmd.scope !== 'both' && cmd.scope !== scope) return false;
    // 只给运维者的命令(播报控制、群列表)不列给普通人 —— 列了也没用,还显得吵。
    if (cmd.who === 'operator' && !isOperator) return false;
    return true;
  });
  const lines = [];
  lines.push(`【可用指令】${botName ? `${botName} ` : ''}这边这些：`);
  for (const cmd of usable) {
    const alias = cmd.aliases.length > 0 ? `（也可写 ${cmd.aliases.join(' / ')}）` : '';
    // 作用那一栏在文档里写得比较长,聊天里要压短:取第一个句号/分号前的那一段。
    const short = String(cmd.effect).split(/[;；。]/)[0];
    lines.push(`· ${cmd.name}${alias} —— ${short}`);
  }
  lines.push('（这些是桥直接处理的指令，不会交给角色本身去"理解"。）');
  return lines.join('\n');
}
export const ARIS_PHRASES = LOCAL_STORY_WORLD?.arisPhrases ?? [];

/**
 * 运维/诊断脚本。**不是** QQ 命令(没人能在聊天里打),但属于"这个项目怎么用"的一部分 ——
 * 所以和命令放在一张表里,免得下次又要到处找。
 */
const BASE_OPS_SCRIPTS = [
  { name: 'handoff.js', effect: '完整私库维护入口：汇总版本、测试规模、实例状态与待验证事项，不属于公开包命令' },
  { name: 'release-status.js', effect: '版本编到哪了 / **播报发出去了吗**(逐群) / 下一版会不会自动发。只读' },
  { name: 'log-tail.js', effect: '**出事故第一件事**:日志最后几行(时间换算成本地)+ 念出"哪些关键行没出现"。只读' },
  { name: 'restart.js / restart.cmd', effect: '**一键重启**:写下重启标记并结束旧进程,原来那个 run.cmd 窗口会原地重开(D45)' },
  { name: 'announce-preview.js', effect: '播报预演:**自上次播报以来的梗概** + 机器人的转述,什么都不发送(`--verbatim` 连模型都不调;`--since X` 换基线)' },
  { name: 'announce-reset.js', effect: '清播报账本(`announced_version` / 逐群 / 问过的标记)—— **会写状态库**,默认只预演,要 `--yes`' },
  { name: 'known-group-add.js', effect: '把丢失的群**按 id 补回**群清单,并用平台的群信息接口**核对群名**(对不上拒绝写入);`--check` 只看现有群的群名/人数/主动发言权限(D59)' },
  { name: 'relay-status.js', effect: '搬运(D60)配置体检:**不联网、不发送** —— `TO` 里哪些群会被拒发(没配群名/在 DENY 里)、重启之后会发到几个群。只读' },
  { name: 'rhythm-report.js', effect: '回复节奏(**连发合并 + 打字抖动**的验收):回复延迟中位、连发比例、各合并窗口会吃掉多少轮、群聊里"自发:被叫"的比例。只读' },
  { name: 'social-observer.js', effect: '**读空气**观测:机器人的**主动开口**里有多少插在"别人还在你一句我一句"的对话串中间(打断率)、多少落在间隙。只读,不改行为' },
  { name: 'card-eval.js', effect: '**角色卡评测**:一组固定输入 + 判据,跑完看回答(机械判据自动核对,手感要人眼)。砍卡前后各跑一次做对比。评测集用 `--cases <路径>` 指定,默认在仓库上一级的工作目录里(见 scripts\\card-eval.js 顶部注释)' },
  { name: 'memory-v0.js', effect: '**分层记忆 v0 演练**:拿 memory.db 的真实轮次按固定词表打标签,报覆盖率 + 拿几句"考记忆"的话跑检索,看会挑出哪几条(只读,不改行为;`--show-text` 才打原文)' },
  { name: 'selftest.js', effect: '公开验证必须显式 `--public`；无参数与 `--full` 要求完整私库，不允许缺件时降级为小集' },
  { name: 'stats-report.js', effect: '身体状态、货币、速率与最近流水（只读）' },
  { name: 'economy-sim.js', effect: '**经济模拟**(只读、纯函数):按真实节奏推进 N 天,打印终局余额分布、"穷"的时间、日入日支,并自己判 D99 那两条判据。标定钱的常量用它' },
  { name: 'growth-report.js', effect: '养成:等级/经验/学会的概念/认识的人(只读,`--rebuild-curve` 重算等级)' },
  { name: 'command-index.js', effect: '生成本表所在的那份文档(`--write`)' },
  { name: 'probe.js', effect: '只读 SQL 探针:一条命令查任意状态库' },
  { name: 'warmup-status.js', effect: '暖群排期:各群这一槽是否掷过骰、计划几点开口' },
  { name: 'memory-archive.js', effect: '历史会话归档维护入口：将旧会话记录收进 memory.db；操作前备份，恢复与数据变更须独立确认' },
  { name: 'idle-burn.js', effect: '**账单现算**(D135):按「本地小时 × 来源」摊开 token 花销,并标出"无人说话的小时" —— 判据是它 < 0.03 元/小时;超过 0.05 就说明又有东西在挂机烧钱。只读' },
  { name: 'purge-tool-notes.js', effect: '**清掉"工具会话被固化成的记忆"**(D135:摘要/自检的提示词混进 note)。只动 note 表,默认只预览,`--write` 才删' },
  { name: 'profile-scan.js', effect: '「关于人的事实」历史回扫(入口①,默认只打印、群聊默认不收;`--write` 才落库)' },
  { name: 'transcript.js', effect: '看聊天记录(只读):`--group <openid 前几位> --since 22:00 --thinking` —— 按**桥的取法**读(只取 text 块),所以看到的一定等于群里实际发生的' },
  { name: 'verify-qq.js', effect: '凭据与 API 连通性检查（认 QQBOT_ENV_FILE）' },
  { name: 'todo-index.js', effect: '完整私库的内部待办索引维护入口，不属于节点 A 公开包命令' },
];

export const OPS_SCRIPTS = BASE_OPS_SCRIPTS.map((row) => ({ ...row, effect: LOCAL_STORY_WORLD?.opsEffects[row.name] ?? row.effect }));

/**
 * Deterministic public documentation view. Runtime exports above may use optional
 * local content; generated public pages must never project those overrides.
 * Public keyword defaults and persona phrases are intentionally empty. A user's
 * explicit instance configuration is not a program default or distributed card.
 */
export const PUBLIC_COMMAND_VIEW = Object.freeze({
  commands: BASE_COMMANDS,
  cardClaims: BASE_CARD_CLAIMS,
  keywordGroups: [],
  phrases: [],
  opsScripts: BASE_OPS_SCRIPTS.filter(({ name }) =>
    ['selftest.js', 'economy-sim.js', 'command-index.js'].includes(name)),
});
