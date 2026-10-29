/**
 * 「聊天记录」搬运的纯逻辑(R1-lite,D60)。
 *
 * 用户的目的不是"把内容搬过去",而是**一条消息代替 N 条**(不刷屏)。QQ 的合并转发卡片
 * 发送侧不支持(`msg_type` 只有 0/2/7),所以做法是:私聊里收到记录 → 打包成一个 PDF → 发群。
 *
 * ⚠️ 这个模块存在的**唯一理由是 gate(闸门)**:实测(2026-09-28)发现
 *   · 平台把记录**展平成纯文本**塞进 `content`(见 docs/01);
 *   · **嵌套的聊天记录会被吞掉内容**,只剩一个"有发送者、没有任何内容"的空块 ——
 *     用户那条「夹着很多嵌套」的记录 = 15 个消息块里 **11 个空块**;
 *   · 全嵌套的记录**根本没投递到机器人**(日志里没有那次到达)。
 * 所以:**只要有一个空块,就说明这条记录的内容不完整** —— 打出来的 PDF 会**静默丢内容**,
 * 那比不做更糟。用户明确要求:"只把只有图文的打成 pdf,其他的机器人不弄了"。
 *
 * 这里全是纯函数(单测覆盖),网络/上传/发送在 `src/qq.js` 与 `src/index.js`。
 */

import { INFRA_CONTENT, infraText } from './local-infra-content.js';

/** One shared display prefix for this module and the application assembler. */
export const RELAY_FILE_PREFIX = infraText(INFRA_CONTENT.relayFilePrefix);

const RECORD_HEADER = /^\[(.{1,40}?的聊天记录)\]$/;
const MESSAGE_HEADER = /^===\s*消息\s*(\d+)\s*===$/;
const SENDER_LINE = /^\[发送者\]\s*(.+)$/;
const ATTACHMENT_LINE = /^\[附件(\d+)\]\s*(.*)$/;
const URL_IN_LINE = /URL:(https?:\/\/\S+)/;
const TYPE_IN_LINE = /类型:([^\s]+)/;
const NAME_IN_LINE = /文件名:([^\s]+)/;

/** 能被搬的附件类型(实测展平文本里是中文:图片 / 视频 / 语音 / 文件)。 */
const RELAYABLE_KINDS = new Set(['图片']);

/**
 * 这条消息是不是一条「聊天记录」?
 *
 * ⚠️ 标题**不固定**:实测见过 `[群聊的聊天记录]` 和 `[月·莲（プラティナ）的聊天记录]` ——
 * 所以只认"`[XXX的聊天记录]`"这个形状,不写字面量。
 */
export function isChatRecord(text) {
  const first = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
  return RECORD_HEADER.test(first ?? '');
}

/**
 * 解析成结构化条目。认不出的行**保留在 texts 里**(宁可多一段文字,也不要静默丢)。
 *
 * @param {string} text 展平后的记录全文
 * @returns {{header: string|null, messages: Array<{index: number, sender: string|null,
 *   texts: string[], attachments: Array<{kind: string, url: string|null, name: string|null}>}>}}
 */
export function parseChatRecord(text) {
  const messages = [];
  let header = null;
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const head = RECORD_HEADER.exec(line);
    if (head) { header = head[1]; continue; }
    const message = MESSAGE_HEADER.exec(line);
    if (message) {
      current = { index: Number(message[1]), sender: null, texts: [], attachments: [] };
      messages.push(current);
      continue;
    }
    if (!current) continue;
    const sender = SENDER_LINE.exec(line);
    if (sender) { current.sender = sender[1].trim(); continue; }
    const attachment = ATTACHMENT_LINE.exec(line);
    if (attachment) {
      const rest = attachment[2];
      current.attachments.push({
        kind: TYPE_IN_LINE.exec(rest)?.[1] ?? '未知',
        url: URL_IN_LINE.exec(rest)?.[1] ?? null,
        name: NAME_IN_LINE.exec(rest)?.[1] ?? null,
      });
      continue;
    }
    current.texts.push(line);
  }
  return { header, messages };
}

/**
 * 闸门:这条记录能不能"完整搬运"?
 *
 * 用户的要求原文:「只把只有图文的打成 pdf,其他的机器人不弄了,太麻烦而且危险」。
 * 所以判据是**白名单式**的:
 *   ① **不许有空块** —— 空块 = 嵌套记录(内容已被平台吞掉),搬出去就是丢内容;
 *   ② 附件类型只允许**图片**;
 *   ③ 至少要有一个附件或一行文字(空记录没有意义)。
 *
 * @param {{header: string|null, messages: Array}} record
 * @returns {{ok: boolean, reason: string, stats: object}}
 */
export function classifyChatRecord(record) {
  const messages = record?.messages ?? [];
  const empty = messages.filter((m) => m.attachments.length === 0 && m.texts.length === 0);
  const kinds = {};
  for (const message of messages) {
    for (const attachment of message.attachments) kinds[attachment.kind] = (kinds[attachment.kind] ?? 0) + 1;
  }
  const images = messages.flatMap((m) => m.attachments.filter((a) => a.kind === '图片'));
  const texts = messages.flatMap((m) => m.texts);
  const stats = {
    messages: messages.length,
    emptyBlocks: empty.length,
    images: images.length,
    textLines: texts.length,
    kinds,
    senders: [...new Set(messages.map((m) => m.sender).filter(Boolean))],
  };

  if (messages.length === 0) return { ok: false, reason: '这条记录里一条消息都没解析出来', stats };
  if (empty.length > 0) {
    // 这一条是**实测出来的**:嵌套记录只剩空块,内容已经不在文本里了。
    return {
      ok: false,
      reason: `这条里有 ${empty.length} 条**嵌套的聊天记录**(平台只留下发送者、内容拿不到),搬出去会丢内容`,
      stats,
    };
  }
  const unsupported = Object.keys(kinds).filter((kind) => !RELAYABLE_KINDS.has(kind));
  if (unsupported.length > 0) {
    return { ok: false, reason: `这条里有不搬的类型:${unsupported.join('、')}`, stats };
  }
  if (images.length === 0 && texts.length === 0) return { ok: false, reason: '这条记录里没有图片也没有文字', stats };
  return { ok: true, reason: `只有图片与文字(${images.length} 张图 / ${texts.length} 行文字)`, stats };
}

/**
 * 决定拒绝时回给操作者的话 —— 说清"为什么不做"以及"你该怎么做"。
 * @param {{reason: string, stats: object}|null} verdict
 */
export function describeRelayRefusal(verdict) {
  const stats = verdict?.stats ?? {};
  const lines = [`（这条聊天记录**没有搬运**:${verdict?.reason ?? '不认识的格式'}。）`];
  if (stats.emptyBlocks > 0) lines.push('· 嵌套的那些内容在平台送给我的文本里就不存在,不是你那边少发了');
  lines.push('· 你可以自己在群里用 QQ 的「合并转发」把它转过去 —— 我不会猜着搬');
  return lines.join('\n');
}

/**
 * 文字那一半到底"进没进 PDF"—— 纯函数,单测覆盖。
 *
 * 背景(2026-09-28 查出来的缺口):`renderTextPages()` 靠 GDI+ 把文字画成图嵌进 PDF,
 * **失败时返回空数组**。原先只有 `_CONFIRM=false` 那条路做了"另发一条文字消息"的兜底,
 * 而默认的 `confirm` 路径(`/搬`)只发 PDF —— 于是"渲染失败 + 记录里有文字"就是**静默丢字**,
 * 正是 D60 里写死不许发生的那件事。根因是 confirm 是后加的(`c4c44c5`),没把先写的兜底搬过来。
 *
 * 所以判据收进这里一处出,两条路都走它:
 *   · 没有文字 → 不需要兜底;
 *   · 有文字**且**渲染出了页 → 文字已经在 PDF 里了,不需要兜底;
 *   · 有文字、一页都没渲染出来 → **必须**另发,`lines` 就是那批原文。
 *
 * @param {{lines?: string[], pages?: number}} [input]
 * @returns {{needed: boolean, lines: string[]}}
 */
export function decideTextFallback({ lines, pages } = {}) {
  const kept = (lines ?? []).map((line) => String(line)).filter((line) => line.trim() !== '');
  return { needed: kept.length > 0 && (pages ?? 0) === 0, lines: kept };
}

/** 另外那条文字消息的正文(和 PDF 里的行保持同一份来源)。 */
export function formatRelayTextFallback(lines) {
  return `（文字部分，来自转发的聊天记录）\n${(lines ?? []).join('\n')}`;
}

/**
 * 有图**重编码失败**时回给操作者的话(2026-09-29)。
 *
 * 为什么是"整条不发"而不是"少放一张":`buildPdf()` 会把每张图声明成 `/Filter /DCTDecode`,
 * 塞一张解不出来的进去,结果是**操作者看到"发成功了"、群里点开却没有图** ——
 * 2026-09-29 就是这么踩的(PNG 被当成 JPEG 嵌进去,`jpegInfo()` 还给了个兜底的 1280×1707)。
 * 所以这里**fail closed**,并且给一条能走的路(QQ 自己的「合并转发」)。
 *
 * @param {Array<{index: number, reason: string}>} failed
 */
export function describeRelayImageFailure(failed) {
  const lines = [
    `（这条**没有搬运**：有 ${failed.length} 张图我的工具解不开，` +
    '与其发一份"点开少几张图"的，不如不发。）',
  ];
  for (const item of failed.slice(0, 5)) lines.push(`· 第 ${item.index} 张：${item.reason}`);
  if (failed.length > 5) lines.push(`· 另外还有 ${failed.length - 5} 张`);
  lines.push('· 这条路你可以自己走：在群里用 QQ 的「合并转发」把记录转过去，图文都完整');
  return lines.join('\n');
}

/**
 * 已经有**一条待确认**的搬运时,回给操作者的话(2026-09-29,现场见 TODO)。
 *
 * 为什么必须有这一层(而不是继续覆盖):`pendingRelay` 只有**一个槽**。
 * 现场:用户连着发了两条「聊天记录」,两条都打包成功、都往操作者私聊发了一份
 * "待确认"的 PDF;后打包完的那条把前一条从槽里**顶掉**。于是操作者回 `/搬` 时,
 * **他确认的那条提示**和**真发出去的那份内容**不是同一条 —— 内容没丢,
 * 但"人过目"这一层被破坏了,而 D60 里"问一声再发"的**全部意义**就是这一层。
 *
 * 所以这里 fail closed:**不覆盖、也不发**,明说要先处理掉上一条。
 * ⚠️ 注意这是"两件真事**:`槽里是谁`(who)和`操作者最后看到的是谁`(last shown)
 * 可能已经分叉 —— 文案要把"看到的那条编号"写出来,否则操作者不知道该确认哪个。
 *
 * @param {{seq?: number, imageCount?: number, at?: number}} pending 当前槽里的那条
 * @param {number|null} [shownSeq] 操作者**最后看到**的那条编号(可能已经被顶掉)
 * @returns {string} 给操作者的一段话;没有待确认时调用方不该调它
 */
export function describeRelayBusy(pending = {}, shownSeq = null) {
  const ago = pending.at ? `（${Math.max(0, Math.round((Date.now() - pending.at) / 1000))} 秒前备好）` : '';
  const slot = `#${pending.seq ?? '?'}`;
  // ⚠️ 图数**必须**写出来(2026-09-29:第一版漏了,被我自己的测试当场抓住):
  //    操作者手上可能同时躺着两份 PDF,只给编号他没法把它和眼前那份对上号。
  const what = Number.isFinite(pending.imageCount) ? `${pending.imageCount} 图` : '一条待确认';
  const shown = shownSeq ?? pending.seq ?? null;
  const mismatch = shown !== null && String(shown) !== String(pending.seq);

  const lines = [
    `（这条**没有搬**：上一条${slot} 还在等你确认${ago} —— ${what}，一次只处理一条。` +
    '两条都在等的时候，回 `/搬` 会分不清你确认的是哪一条。）',
    `· 先处理上一条：回 \`/搬\` 发出它，或 \`/不搬\` 丢弃它`,
    `· 然后再把这一条记录发一次（我没有替你排队，也没替你发）`,
  ];
  if (mismatch) {
    // 这一格是整段话里最重要的:操作者手上那份 PDF 的编号和槽里的**不是同一个**
    lines.push(`· ⚠️ 你刚看到的待确认是 #${shown}，但槽里现在是${slot} —— 回 \`/搬\` 发出去的是${slot}`);
  }
  return lines.join('\n');
}

/**
 * **自动转发**模式下,发完给操作者的那一条回执(2026-09-29,用户选了方案 B)。
 *
 * 背景:用户原话「搬运那个直接改成副实例不问我搬不搬了,没什么意义,让她自动转发」——
 * 于是 `QQBOT_RELAY_CONFIRM=false`,记录一到就打包直发目标群,不再等人点头。
 *
 * **为什么还留这一条通知**(而不是一声不响):平台的撤回窗口只有 **2 分钟**,
 * 而这 2 分钟只有在"你知道刚发了什么"的前提下才有用。没有回执,那 2 分钟等于不存在。
 * 所以它的目的很窄:**让你对得上号,并在必要时说 `/撤回`**。
 *
 * ⚠️ 措辞上的两条硬要求(和 `describeRelayBusy()` 同一族:说出口的机制必须真存在):
 *   · 不能让操作者以为"还有东西在等他确认" —— 这次是**已经发出去了**;
 *   · 不能承诺超出平台能力的补救 —— 只说 **2 分钟**。
 *
 * @param {object} input
 * @param {number} input.sent 成功发出的群数
 * @param {number} input.total 目标群数
 * @param {string[]} [input.groupNames] 成功发到的群名(给人看的;没有就退回 id 前缀)
 * @param {number} [input.imageCount] 这条记录里有几张图
 * @param {number} [input.textLines] 有几行文字
 * @param {boolean} [input.textFallback] 文字是否**另发**了一条(渲染失败时的兜底)
 * @returns {string} 给操作者的一段话
 */
export function describeRelayAutoForward({
  sent,
  total,
  groupNames = [],
  imageCount = 0,
  textLines = 0,
  textFallback = false,
} = {}) {
  const parts = [`${imageCount} 张图`];
  if (textLines > 0) {
    parts.push(textFallback ? `${textLines} 行文字（另发了一条）` : `${textLines} 行文字（在 PDF 里）`);
  }
  const lines = [`（自动转发：已发出到 ${sent}/${total} 个群 —— ${parts.join('、')}。）`];
  if (groupNames.length > 0) lines.push(`· 发到了：${groupNames.join('、')}`);
  if (sent < total) {
    // 有群没发成功:这**不是**"过一会儿就好",要明确说去看日志
    lines.push(`· ⚠️ 有 ${total - sent} 个群**没成功**（不是稍后重试）—— 看日志里「搬运失败（群 …）」那一行`);
  }
  lines.push('· 发错了就 **2 分钟内**发 `/撤回`（平台硬规定，超时收不回）');
  return lines.join('\n');
}

/**
 * 搬运发到群里的**文件名**(纯函数,单测覆盖)。
 *
 * 用户 2026-09-29 要求用内容侧的命名前缀吸引读者(文案本身不由这里猜)——
 * 文件名是**给群里的人看的**(下载时/文件卡片上就显示它),所以它算**文案**,
 * 和日志里那些内部记号不是一回事。
 *
 * 两条约束都是必要的:
 *   · **唯一**:一次搬运可能发好几个群,而上传接口按 `file_name` 认文件 ——
 *     同一毫秒发出几条一模一样的名字是自找麻烦,所以后缀带毫秒 + 一个序号。
 *   · **长度**:平台对 `file_name` 没有公开的长度/字节限制,所以这里自己收在
 *     `maxBytes` 以内。真要撞上平台的上限,也应该在**这里**先表现出来,
 *     而不是让群里的人收不到东西。
 *
 * @param {string} [prefix] 给人看的名字(沿用内容侧默认文案)
 * @param {number} [at] 时间戳(毫秒)
 * @param {number} [count] 这次要发几个群
 * @param {{maxBytes?: number}} [options]
 * @returns {string[]} 逐个目标群的文件名
 */
export function relayFileNames(prefix = RELAY_FILE_PREFIX, at = Date.now(), count = 1, { maxBytes = 80 } = {}) {
  const safePrefix = String(prefix ?? '').trim() || '聊天记录';
  const total = Math.max(1, Number(count) || 1);
  const stamp = String(Math.floor(Number(at) || Date.now()));
  return Array.from({ length: total }, (_, index) => {
    const suffix = total > 1 ? `-${stamp}-${index + 1}` : `-${stamp}`;
    // 后缀先留出来,剩下的字节才给前缀 —— 否则超长前缀会把后缀挤掉,唯一性就没了
    const room = Math.max(4, maxBytes - Buffer.byteLength(`${suffix}.pdf`, 'utf8'));
    return `${truncateToBytes(safePrefix, room)}${suffix}.pdf`;
  });
}

/** 按 **UTF-8 字节**截断,不把汉字切成半个(截坏了会变成乱码)。 */
function truncateToBytes(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > limit) break;
    out += char;
  }
  return out;
}

/**
 * 搬运的配置(纯函数,单测覆盖)。规矩照 D20:**写错就报错**,
 * 不许悄悄退回"不搬"或"全搬" —— 后者会把家人的群拉进来。
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{enabled: boolean, to: string[], deny: string[], verifyNames: boolean, expect: Map<string,string>}}
 */
export function parseRelayConfig(env = {}) {
  const text = (key) => String(env[key] ?? '').trim();
  const bool = (key, fallback) => {
    const value = text(key).toLowerCase();
    if (value === '') return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${key} 只能是 true / false，收到 ${JSON.stringify(env[key])}`);
  };
  const ids = (key) => text(key).split(/[,\s]+/).map((id) => id.trim().toUpperCase()).filter(Boolean);
  const invalid = [...ids('QQBOT_RELAY_TO'), ...ids('QQBOT_RELAY_DENY')].filter((id) => !/^[0-9A-F]{32}$/.test(id));
  if (invalid.length > 0) {
    throw new Error(`QQBOT_RELAY_TO / QQBOT_RELAY_DENY 里的 openid 必须是 32 位十六进制：${invalid.join('、')}`);
  }
  const expect = new Map();
  for (const pair of text('QQBOT_RELAY_EXPECT_NAMES').split(',').map((v) => v.trim()).filter(Boolean)) {
    const [id, ...rest] = pair.split('=');
    const name = rest.join('=').trim();
    if (!/^[0-9A-Fa-f]{32}$/.test(id.trim()) || name === '') {
      throw new Error(`QQBOT_RELAY_EXPECT_NAMES 要写成 id=群名（逗号分隔），收到 ${JSON.stringify(pair)}`);
    }
    expect.set(id.trim().toUpperCase(), name);
  }
  // ⚠️ **来源是群,不是私聊**(用户的最终要求:副实例在「火星试验田」里自己发现记录)。
  // 群 openid 逐机器人不同,所以这个值必须是**副实例视角**的那一个。
  const from = text('QQBOT_RELAY_FROM').toUpperCase();
  if (from !== '' && !/^[0-9A-F]{32}$/.test(from)) {
    throw new Error(`QQBOT_RELAY_FROM 必须是 32 位十六进制的群 openid，收到 ${JSON.stringify(env.QQBOT_RELAY_FROM)}`);
  }
  const enabled = bool('QQBOT_RELAY', false);
  if (enabled && from === '') {
    throw new Error('QQBOT_RELAY=true 必须同时配 QQBOT_RELAY_FROM（来源群的 openid）—— 否则不知道从哪个群里搬');
  }
  return {
    enabled,
    from,
    to: ids('QQBOT_RELAY_TO'),
    deny: ids('QQBOT_RELAY_DENY'),
    verifyNames: bool('QQBOT_RELAY_VERIFY_NAMES', true),
    // **问一声再发**(默认开):桥把打好的 PDF 先发到操作者私聊,回 `/搬` 才发群。
    // 理由(用户 2026-09-28):代码只能做**结构性**过滤,内容安全必须由人过目 ——
    // "自动"省下的是一次点击,代价是发出去 2 分钟后**收不回**。
    confirm: bool('QQBOT_RELAY_CONFIRM', true),
    expect,
  };
}

/** 搬运的控制命令(私聊、操作者)。 */
const RELAY_COMMANDS = new Set(['/搬', '/搬家', '/relay', '/不搬', '/丢弃', '/撤回', '/recall']);

/**
 * 读操作者的搬运指令。**只认这几个字面量** —— 不猜口语(搬运是会发出去的动作)。
 * @param {string} text
 * @returns {'send'|'drop'|'recall'|null}
 */
export function parseRelayCommand(text) {
  const head = String(text ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!RELAY_COMMANDS.has(head)) return null;
  if (head === '/搬' || head === '/搬家' || head === '/relay') return 'send';
  if (head === '/不搬' || head === '/丢弃') return 'drop';
  return 'recall';
}
