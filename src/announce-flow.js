/**
 * 播报的"问一句再发"流程(D50)。
 *
 * 用户的原始要求:
 *   「每编一个新的版本号,每次都编写更新日志并输出给爱丽丝,爱丽丝询问我是否发送和发送范围,
 *     在我 qq 私聊确认发送后再发送」
 *
 * 所以自动模式不再等于"自动发",而是三拍:
 *   ① **问**:还有没播报的内容 → 私聊问操作者一次(每个版本只问一次,不骚扰);
 *   ② **等**:什么都不发,直到操作者回话;
 *   ③ **发**:按他选的范围发,并把结果回报给他。
 *
 * 这个模块**只有纯函数**:怎么问、怎么读他的回答、按范围该用哪条基线。
 * 发消息、写状态库都在 `src/index.js`(`announceOnce` / `offerAnnounce`),这样这里能单测。
 */

/**
 * 这次播报该拿哪条"上次播报到哪"的基线。
 *
 * ⚠️ 这一条是**踩出来的**(2026-09-27 现场):基线原来是全局一个 ——
 * 私聊播报成功之后它就变成最新版,于是**群播报**算出来"没有新内容",
 * 正文只剩标题,发出去就是一条空消息(`正文覆盖 0 个版本,0 条大纲`)。
 * 群是逐群投递的,基线也必须逐群记。
 *
 * @param {{scope?: string, groupId?: string|null}} target
 * @returns {string} `meta` 里的键
 */
export function announceBaselineKey({ scope = null, groupId = null } = {}) {
  const toGroup = scope === 'thisGroup' || scope === 'group';
  return toGroup && groupId ? `announced_group:${groupId}` : 'announced_version';
}

/** 这次到底有没有东西可播 —— 没有就**不许发**(空壳比不发更糟)。 */
export function hasAnnounceContent(digest) {
  return Array.isArray(digest?.lines) && digest.lines.length > 0;
}

/**
 * 发完之后要不要把基线推到这一版。
 *
 * ⚠️ **预览不算发布**(D55,用户实测踩到):`/更新 预览` 把基线记成 1.23.1 之后,
 * 紧接着的 `/更新`(私聊+群)直接报"没有新内容" —— 他只是想先看一眼。
 * 所以预览只发私聊、**不写任何基线**;真要推进基线就得是"发出去"的那一次。
 *
 * @param {{sent?: number, preview?: boolean}} options
 */
export function shouldRecordAnnounce({ sent = 0, preview = false } = {}) {
  return sent > 0 && preview !== true;
}

/** 问一次就够了:同一版本问过就不再问(`meta` 键)。 */
export function announceOfferKey(version) {
  return `announce_offered:${String(version ?? '').replace(/^v/, '')}`;
}

/**
 * 拼"要不要发、发哪里"那条私聊。
 *
 * ⚠️ 摘要按 `digest.entries` 渲染,所以**每条带着它自己的行首符号**(`·` 或 `1. `)——
 * 问句里看到的形状要和真发出去的一致,否则"看着能发、发出去是另一回事"(D57)。
 * 老形状(只有 `lines`)也认,退化成 `·` 一行一条。
 *
 * @param {object} options
 * @param {{version: string, name: string, mode: string, lines: string[],
 *   entries?: Array<{marker: string, text: string}>}} options.digest
 * @param {Array<{id: string, label?: string}>} [options.groups] 已知群(顺序 = /群列表 的编号)
 * @param {string[]} [options.freshGroups] 从没播报过的群的 id(会带补课梗概)
 * @param {number} [options.maxLines] 正文里最多列几条(默认 5)
 * @returns {string}
 */
export function buildAnnounceQuestion({ digest, groups = [], freshGroups = [], maxLines = 5 } = {}) {
  const entries = Array.isArray(digest?.entries) && digest.entries.length > 0
    ? digest.entries
    : (digest?.lines ?? []).map((text) => ({ marker: '· ', text }));
  const lines = entries.slice(0, maxLines).map((entry) => `${entry.marker}${entry.text}`);
  const more = entries.length > lines.length
    ? [`· …还有 ${entries.length - lines.length} 条`]
    : [];
  const fresh = new Set(freshGroups);
  const groupLines = groups.map((group, index) => {
    const number = index + 1;
    return `${number}=${String(group.id).slice(0, 8)}…${fresh.has(group.id) ? '(从没播报过)' : ''}`;
  });

  return [
    `【更新播报】${digest?.name ?? ''} ${digest?.version ?? '?'} 的播报写好了` +
    (digest?.mode === 'first' ? '（含补课：记忆、金币、养成、身体那些）' : ''),
    '',
    ...lines,
    ...more,
    '',
    '要发吗?发到哪里?',
    `· /发        → 私聊 + 全部已知群（${groups.length} 个）`,
    '· /发 私聊    → 只发私聊',
    groups.length > 0 ? `· /发 群 N    → 只发第 N 个群（${groupLines.join(' ')}）` : null,
    '· /预览       → 只发私聊看一眼（会记成已播报）',
    '· /不发       → 这次不发，等你编下一个版本再问',
  ].filter((line) => line !== null).join('\n');
}

/** 把中文数字/全角数字都认成数字(「群 ２」「群二」都算)。 */
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function toIndex(token) {
  if (token === undefined) return null;
  const text = String(token).trim().replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(text)) return Number(text);
  return CN_DIGITS[text] ?? null;
}

/**
 * 读操作者的回答。
 *
 * 只在"确实问过、还在等他回话"时才调用 —— 所以这里可以放心接受口语:
 * 平时聊天里出现"发"不会被误判(没问过就不会走到这儿)。
 *
 * @param {string} text 操作者在私聊里说的话
 * @returns {{action: 'send'|'skip'|'preview'|null, scope: 'all'|'c2c'|'group'|null, groupIndex: number|null}}
 *   `action: null` = 这不是一个回答(当普通聊天处理)
 */
export function parseAnnounceReply(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { action: null, scope: null, groupIndex: null };
  // 命令词去掉开头的 `/`,以及"发一下 / 发吧 / 发送"这类口语尾巴
  const body = raw.replace(/^[/／]/, '').replace(/[!！。.，,~～]/g, '').trim();
  const compact = body.replace(/\s+/g, '');

  // ① 不发
  if (/^(不发|先不发|不用发|别发|算了|取消|跳过|no|n)$/i.test(compact)) {
    return { action: 'skip', scope: null, groupIndex: null };
  }
  // ② 只看一眼(只发私聊,且会记成已播报 —— 文案里写明了)
  if (/^(预览|先看看|看看|preview)$/i.test(compact)) {
    return { action: 'preview', scope: 'c2c', groupIndex: null };
  }
  // ③ 明确"只发私聊"
  if (/^(私聊|只发私聊|发私聊)$/.test(compact)) {
    return { action: 'send', scope: 'c2c', groupIndex: null };
  }
  // ④ 指定群:`群 2` / `第2个群` / `2群` / `群二` 都认(前面带不带"发"都行)
  const GROUP_NUMBER = '([0-9０-９一二两三四五六七八九十]+)';
  const bodyWithoutSend = body.replace(/^发\s*/, '');
  for (const candidate of [body, bodyWithoutSend]) {
    const patterns = [
      new RegExp(`^(?:第)?群\\s*${GROUP_NUMBER}(?:个)?$`),
      new RegExp(`^(?:第)?${GROUP_NUMBER}\\s*(?:个)?群$`),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(candidate.trim());
      if (!match) continue;
      const index = toIndex(match[1]);
      if (index !== null) return { action: 'send', scope: 'group', groupIndex: index };
    }
  }
  // ⑤ 发(默认:私聊 + 全部已知群)
  if (/^(发|发送|发出去|发吧|发一下|全部|都发|发全部|发所有|可以发|好|好的|行|ok|yes|y)$/i.test(compact)) {
    return { action: 'send', scope: 'all', groupIndex: null };
  }
  return { action: null, scope: null, groupIndex: null };
}

// ---------------------------------------------------------------------------
// 命令参数、账本历史与回退(D58)
// ---------------------------------------------------------------------------

/** 私聊里 `/更新` 那一族命令的用法 —— 一个来源,出错和 `/help` 都用它。 */
export const ANNOUNCE_USAGE = [
  '· `/更新` 私聊 + 全部已知群',
  '· `/更新 2` 只发第 2 个群（`/群列表` 看编号）',
  '· `/更新 预览` 只发私聊看一眼（**不动账本**）',
  '· `/更新 预览 1.22.0` 假设上次发到 1.22.0，再念一遍（还是不动账本）',
  '· `/更新 账本` 看私聊与每个群现在记到哪一版、上一条是什么',
  '· `/更新 回退` 把账本退回上一条（**逐群各自回退**）',
  '· `/更新 基线 1.22.0` 下次只播报这一版**之后**的改动',
].join('\n');

/**
 * `/更新 …` 的参数解析 —— **纯函数**,所以每种写法都能单测(装配代码里测不到)。
 *
 * 为什么要有 `预览 <版本>`:基线等于最新版时,"先看一眼"就变成一句
 * 「没有新内容」的死路(2026-09-28 用户实测),而那条路恰恰是他最需要的 ——
 * 刚发完想重看一眼文案。给个版本号就绕开了:**只为这一次预演假设一个起点**,
 * 什么都不写(D55 的"预览不是发布"原样保留)。
 *
 * @param {string[]} rest `/更新` 后面的参数
 * @param {{groupCount?: number}} [options]
 * @returns {{action: 'send'|'preview'|'ledger'|'rollback'|'baseline'|'error',
 *   scope?: string, groupIndex?: number|null, version?: string|null, message?: string}}
 */
export function parseAnnounceCommandArgs(rest = [], { groupCount = 0 } = {}) {
  const arg = String(rest[0] ?? '').trim().toLowerCase();
  const second = String(rest[1] ?? '').trim().replace(/^v/, '');
  const base = { action: 'error', scope: null, groupIndex: null, version: null };

  if (arg === '') return { ...base, action: 'send', scope: 'all' };
  if (arg === '预览' || arg === 'preview' || arg === '0') {
    return { ...base, action: 'preview', scope: 'c2c', version: second === '' ? null : second };
  }
  if (arg === '账本' || arg === 'ledger' || arg === 'status') return { ...base, action: 'ledger' };
  if (arg === '回退' || arg === 'rollback' || arg === 'undo') return { ...base, action: 'rollback' };
  if (arg === '基线' || arg === 'baseline') {
    if (second === '') return { ...base, message: '要写成 `/更新 基线 1.22.0`（版本号必须在 CHANGELOG.md 里有）。' };
    return { ...base, action: 'baseline', version: second };
  }
  if (/^\d+$/.test(arg)) {
    const index = Number.parseInt(arg, 10);
    if (index < 1 || index > groupCount) {
      return { ...base, message: `没有编号 ${index} 的群。` };
    }
    return { ...base, action: 'send', scope: 'group', groupIndex: index };
  }
  return { ...base, message: `不认识的参数「${rest[0]}」。` };
}

/**
 * 触发方式的人话 —— **启动横幅与诊断脚本共用一份**(`describeAnnounceTrigger`)。
 *
 * ⚠️ 这里曾经会说谎:`confirm`(D50 之后是**默认**)在横幅里被打成
 * 「自动（启动 + 定时）」。2026-09-28 用户看到基线自己动了,第一反应就是
 * "是不是她自动发的" —— 诊断工具说谎比不说更糟(D50 的教训),所以有测试钉住。
 */
export function describeAnnounceTrigger(trigger) {
  const value = String(trigger ?? '').trim().toLowerCase();
  if (value === 'manual') return '手动（只认 /更新）';
  if (value === 'auto') return '自动（启动 + 定时）';
  return '问你一声（私聊确认后才发）';
}

/** `meta` 里那一个键:播报账本的历史(JSON 数组,append-only)。 */
export const BASELINE_HISTORY_KEY = 'announced_history';
/** 历史最多留几条 —— 它是"最近几次改过什么",不是审计日志。 */
export const BASELINE_HISTORY_LIMIT = 20;

/**
 * 读历史。**读坏了就当没有** —— 它是一条提示性记录,不该因为一行脏 JSON
 * 让"回退"整条路炸掉(和 `parseForeignBotIds` 一样的宽容度,D54)。
 *
 * @param {string|null|undefined} raw
 * @returns {Array<{key: string, value: string|null, at: number}>}
 */
export function parseBaselineHistory(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? ''));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry.key !== 'string' || entry.key === '') return null;
        const value = entry.value === null || entry.value === undefined ? null : String(entry.value);
        return { key: entry.key, value, at: Number(entry.at) || 0 };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 追加一条历史,返回**新的** JSON 字符串(给 `setMeta` 用);超出上限丢最旧的。
 *
 * @param {string|null|undefined} raw 现在库里的那个值
 * @param {{key: string, value: string|null, at: number}} entry
 * @param {{limit?: number}} [options]
 */
export function appendBaselineHistory(raw, entry, { limit = BASELINE_HISTORY_LIMIT } = {}) {
  const history = parseBaselineHistory(raw);
  if (!entry || typeof entry.key !== 'string' || entry.key === '') return JSON.stringify(history);
  history.push({ key: entry.key, value: entry.value ?? null, at: Number(entry.at) || 0 });
  return JSON.stringify(history.slice(-Math.max(1, limit)));
}

/**
 * 回退方案:每个基线键回到**上一次与当前值不同**的那条历史。
 *
 * ⚠️ **逐键算,不是"一个全局值"** —— 这正是它和终端 `announce-reset --set` 的区别。
 * 2026-09-28 的现场:爱丽丝三个群里有一个**从没播报过**,拿 `--set` 去退会把那个群
 * 也写成"已播报 1.23.4"(源码里 missingGroups 会被补上),它就永远拿不到补课梗概了。
 *
 * 找不到可回退记录的键(从没写过历史、或值一直没变)**原样不动**,并单独列出来 ——
 * 不能悄悄当成"回退到空"。
 *
 * @param {{entries?: Array<{key: string, value: string|null, at: number}>,
 *          baselines?: Record<string, string|null>}} [options]
 * @returns {{changes: Array<{key: string, from: string|null, to: string|null}>, untouched: string[]}}
 */
export function planBaselineRollback({ entries = [], baselines = {} } = {}) {
  const changes = [];
  const untouched = [];
  for (const [key, current] of Object.entries(baselines ?? {})) {
    const now = current === null || current === undefined ? null : String(current);
    const target = [...entries].reverse().find((entry) => entry.key === key && entry.value !== now);
    if (!target) {
      untouched.push(key);
      continue;
    }
    changes.push({ key, from: now, to: target.value });
  }
  return { changes, untouched };
}

/** 时间戳说成人话(账本里用):今天说时刻,更早说月/日。 */
function whenText(at, now = Date.now()) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const date = new Date(value);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/**
 * `/更新 账本` 的正文 —— 纯函数(数据由 `index.js` 从状态库读出来)。
 *
 * 为什么值得有:2026-09-28 那次"基线怎么又变了"的排查,全靠开库看 `meta`。
 * 这个命令把同一件事搬到 QQ 里:**私聊记到哪、每个群记到哪、上一条是什么**。
 *
 * @param {{latest?: string|null, baselines?: Array<{key: string, value: string|null, updatedAt?: number}>,
 *          groups?: string[], entries?: Array<{key: string, value: string|null, at: number}>,
 *          now?: number}} [options]
 */
export function describeBaselineLedger({ latest = null, baselines = [], groups = [], entries = [], now = Date.now() } = {}) {
  const label = (key) => {
    if (key === 'announced_version') return '私聊';
    const id = key.replace('announced_group:', '');
    const index = groups.indexOf(id);
    return `群 ${id.slice(0, 8)}…${index >= 0 ? `（编号 ${index + 1}）` : ''}`;
  };
  const lines = [`【播报账本】最新版本 ${latest ?? '?'}`];
  const global = baselines.find((row) => row.key === 'announced_version');
  lines.push(`· 私聊：${global?.value ? `已播报 ${global.value}（${whenText(global.updatedAt, now)}）` : '还没播报过'}`);
  for (const id of groups) {
    const row = baselines.find((item) => item.key === `announced_group:${id}`);
    const index = groups.indexOf(id) + 1;
    lines.push(
      `· 群 ${id.slice(0, 8)}…（编号 ${index}）：` +
      (row?.value ? `已播报 ${row.value}（${whenText(row.updatedAt, now)}）` : '**从没播报过** —— 下次会带补课梗概'),
    );
  }
  const seen = new Set(groups.map((id) => `announced_group:${id}`));
  for (const row of baselines) {
    if (row.key === 'announced_version' || seen.has(row.key)) continue;
    lines.push(`· ${label(row.key)}：已播报 ${row.value ?? '?'}（这个群已经不在已知列表里了）`);
  }

  const recent = entries.slice(-6).reverse();
  if (recent.length > 0) {
    lines.push('', '最近几次改动（新 → 旧）：');
    for (const entry of recent) {
      lines.push(`· ${entry.value ?? '(空)'} @ ${label(entry.key)}（${whenText(entry.at, now)}）`);
    }
    lines.push('', '要退回去：`/更新 回退`（退回上一条）；想指定版本：`/更新 基线 1.22.0`。');
  } else {
    lines.push('', '（还没有改动历史 —— 这条命令是 1.23.6 才有的，之前发过的那几次不在里面。）');
  }
  return lines.join('\n');
}

/** 回退结果说成人话(纯函数)。 */
export function describeRollback({ changes = [], untouched = [] } = {}, { groups = [] } = {}) {
  const label = (key) => {
    if (key === 'announced_version') return '私聊';
    const id = key.replace('announced_group:', '');
    const index = groups.indexOf(id);
    return `群 ${id.slice(0, 8)}…${index >= 0 ? `（编号 ${index + 1}）` : ''}`;
  };
  if (changes.length === 0) {
    const why = untouched.length > 0
      ? `账本里没有可回退的记录（${untouched.map(label).join('、')} 都没有"上一次"）。`
      : '账本里什么都没有 —— 没有可回退的记录。';
    return `（${why}要指定版本就用 \`/更新 基线 1.22.0\`。）`;
  }
  const lines = ['（已回退：'];
  for (const change of changes) lines.push(`· ${label(change.key)}：${change.from ?? '(空)'} → ${change.to ?? '(空)'}`);
  if (untouched.length > 0) lines.push(`· 没动：${untouched.map(label).join('、')}（没有"上一次"可退）`);
  lines.push('', '下一次 `/更新` 会从回退后的那一版**之后**开始念。想看文案先 `/更新 预览`。）');
  return lines.join('\n');
}

/** 版本号在不在 CHANGELOG 里 —— `/更新 基线` 的守卫(拨到不存在的版本等于从头补课)。 */
export function isKnownVersion(known = [], version) {
  const wanted = String(version ?? '').replace(/^v/, '').trim();
  return wanted !== '' && known.map((item) => String(item).replace(/^v/, '')).includes(wanted);
}

/**
 * 拼播报正文时该按哪套口径 —— **手动那条路不卡"极简"**(2026-10-11 / D197)。
 *
 * 2026-10-06 用户定的口径是「爱丽丝**自动播报**只播大版本的大内容(极简),小更新不计入」。
 * 但 `buildAnnounceDigest({ majorOnly: true })` 的实现是**在开头直接 `return null`** ——
 * 判据落在"**最新一版**是不是大更新"上,于是只要最新那版不是大更新,
 * **连手动 `/更新` 想看一眼文案都一起被挡死**。
 *
 * 现场(2026-10-11):`1.110.0` 只有「变更」+「播报」、`1.111.0` 只有「修复」+「播报」——
 * 都没有「新增」小节 → 不算大更新 → 爱丽丝的播报**整条链路静默**:
 * 不再问你、`/更新` 不发、群里 @ 也不发,只回一句"读不到 CHANGELOG.md"(而文件是好的)。
 *
 * 所以口径按"**这一下是不是人明确要求的**"分,并且**只有这一个来源**:
 *   · 手动(`/更新`、`/更新 预览`、群里 @ 她 `/更新`)→ 不卡,他要看就给;
 *   · 自动(启动 + 每拍)→ 卡,只播大版本。
 *
 * ⚠️ 这原来是**只写在注释里**的意图(`majorOnly:false` 留给手动那条路),
 *    而生产调用点一次都没传过 —— grep 全仓只有单测在传,所以那句注释从写下起就是假的,
 *    套件却一直绿。现在把它变成代码 + 判据。
 *
 * @param {{manual?: boolean}} [options] `manual` = 操作者明确要求的这一下
 * @returns {{majorOnly: boolean}} 直接摊给 `buildAnnounceDigest()`
 */
export function announceDigestOptions({ manual = false } = {}) {
  return { majorOnly: !manual };
}

/**
 * `buildAnnounceDigest()` 给了 `null` 时,**把真原因说成人话**。
 *
 * ⚠️ 这条是**事故换来的**(2026-10-11):调用点原来把两种完全不同的情况混成一句
 * 「读不到 CHANGELOG.md」——
 *   ① 文件真的缺失/读不动;
 *   ② 文件好好的,只是**最新一版不是大更新**,按极简口径跳过。
 * 那次是②,而用户看到的是①:他去查文件、我也照着那句话查了一圈权限与路径,
 * 全都白费 —— **报错指错方向比不报错更贵**。
 *
 * @param {{latestVersion?: string|null, majorOnly?: boolean}} [options]
 *   `latestVersion` = 当前能读出来的最新版本号(读不到就给 null)
 * @returns {string} 一句能直接发给操作者的话
 */
export function describeDigestMiss({ latestVersion = null, majorOnly = true } = {}) {
  const version = String(latestVersion ?? '').replace(/^v/, '').trim();
  if (version === '') return '读不到 CHANGELOG.md（文件缺失或读不动）';
  if (!majorOnly) return `CHANGELOG.md 里没有可播的版本条目（最新读出来是 ${version}）`;
  return (
    `${version} 不是大更新（没有「新增」小节）—— **自动**播报按极简口径不发；` +
    '这是口径、不是读不到文件。手动 `/更新` 不受这条限制。'
  );
}
