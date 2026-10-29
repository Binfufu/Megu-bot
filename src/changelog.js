/**
 * Parse `CHANGELOG.md`.
 *
 * The changelog is the only version history this project has (there is no git),
 * so it is written in a deliberately machine-readable shape:
 *
 *     ## [1.0.0] — 2026-09-26
 *     ### 新增
 *     ...
 *     ### 播报
 *     ...
 *
 * A future "narrator" bot is meant to read the newest release and announce it,
 * so the format is parsed rather than prose-matched. Pure functions only: the
 * caller does the file I/O, which keeps this inside the unit tests.
 */

import { INFRA_CONTENT } from './local-infra-content.js';

/** `## [1.0.0] — 2026-09-26` (an ASCII hyphen is accepted too). */
const RELEASE_HEADING = /^##\s+\[([^\]]+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/;
/** Any other `## …` heading, e.g. the "1.0 之前" appendix. */
const OTHER_HEADING = /^##\s+(.+?)\s*$/;
/** `### 新增` and friends. */
const SECTION_HEADING = /^###\s+(.+?)\s*$/;

/**
 * @typedef {object} Release
 * @property {string} version
 * @property {string} date `YYYY-MM-DD`
 * @property {Record<string, string>} sections section title → body text
 * @property {string} body the whole entry, headings included
 */

/**
 * @param {string} text contents of CHANGELOG.md
 * @returns {{releases: Release[], others: Array<{title: string, body: string}>}}
 *   In file order, which this file keeps newest-first.
 */
export function parseChangelog(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const releases = [];
  const others = [];
  let current = null; // { version, date, lines, sections, sectionName }
  let other = null;

  const closeRelease = () => {
    if (!current) return;
    releases.push({
      version: current.version,
      date: current.date,
      sections: current.sections,
      body: current.lines.join('\n').trim(),
    });
    current = null;
  };
  const closeOther = () => {
    if (!other) return;
    others.push({ title: other.title, body: other.lines.join('\n').trim() });
    other = null;
  };

  for (const line of lines) {
    const release = RELEASE_HEADING.exec(line);
    if (release) {
      closeRelease();
      closeOther();
      current = {
        version: release[1].trim(),
        date: release[2],
        lines: [line],
        sections: {},
        sectionName: null,
      };
      continue;
    }

    const heading = OTHER_HEADING.exec(line);
    if (heading) {
      closeRelease();
      closeOther();
      other = { title: heading[1], lines: [line] };
      continue;
    }

    if (current) {
      current.lines.push(line);
      const section = SECTION_HEADING.exec(line);
      if (section) {
        current.sectionName = section[1];
        current.sections[current.sectionName] = '';
      } else if (current.sectionName) {
        current.sections[current.sectionName] += `${line}\n`;
      }
      continue;
    }

    if (other) other.lines.push(line);
  }

  closeRelease();
  closeOther();

  for (const release of releases) {
    for (const [name, body] of Object.entries(release.sections)) {
      release.sections[name] = trimSection(body);
    }
  }
  return { releases, others };
}

/**
 * 小节正文的收尾清理。
 *
 * **必须去掉行尾的分隔线**(`---`):条目之间是用 `---` 隔开的,而它不属于任何小节,
 * 解析时会自然落到**最后一个小节**里。曾经因此把一整行 `---` 发进 QQ ——
 * 播报正文是"直接发出去/交给模型念"的东西,多一行横线就是多一行脏数据。
 */
function trimSection(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || /^(-{3,}|\*{3,}|_{3,})$/.test(last)) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

/**
 * The newest release — the first entry in the file.
 *
 * @param {string} text
 * @returns {Release|null}
 */
export function latestRelease(text) {
  return parseChangelog(text).releases[0] ?? null;
}

/**
 * One release by version, ignoring a leading `v`.
 *
 * @param {string} text
 * @param {string} version
 * @returns {Release|null}
 */
export function findRelease(text, version) {
  const wanted = String(version ?? '').replace(/^v/, '').trim();
  return parseChangelog(text).releases.find((release) => release.version.replace(/^v/, '') === wanted) ?? null;
}

/** Every version in the file, newest first. */
export function listVersions(text) {
  return parseChangelog(text).releases.map((release) => release.version);
}

// ---------------------------------------------------------------------------
// 播报梗概(D49)
// ---------------------------------------------------------------------------

/** `### 播报` 里的大纲行:`· 一条一件事`。 */
function outlineItems(release) {
  return String(release?.sections?.['播报'] ?? '')
    .split(/\r?\n/)
    .filter((line) => /^\s*·/.test(line))
    .map((line) => line.replace(/^\s*·\s*/, '').trim())
    .filter((line) => line !== '');
}

/** `## [1.2.3]` → 1.2.3 的三段数字(认不出来就 null)。 */
function parseVersionNumber(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 「大更新」的判据:**有新增内容**(`### 新增` 小节非空),而且**不是补丁号**
 * (x.y.**0**)。两个条件都要:
 *   · 只看"有新增" —— 1.22.2 加了个脚本也算新增,可它对群友不是"大更新";
 *   · 只看补丁号 —— 1.20.0 那种"修了一堆"的版本也不算大更新(D48 之前的教训)。
 * 判据是**机械的**,所以它不会腐烂:不需要谁记得回来改一个表。
 */
export function isMajorRelease(release) {
  const number = parseVersionNumber(release?.version);
  const additions = String(release?.sections?.['新增'] ?? '').trim();
  return Boolean(number) && number[2] === 0 && additions !== '';
}

/**
 * 去重用的键:**前 10 个"有效字符"**。
 *
 * 为什么不能直接比字符串:同一件事在几版里会被反复写进「播报」(1.22.1 / 1.22.2
 * 当时就是"把上一版的要点也带上"写的,为了补播报),而措辞会差一个标点 ——
 * `双击 restart.cmd 或者私聊发 /重启 就行` 和 `双击 restart.cmd，或者私聊发一句 /重启`。
 * 去掉标点/空白再取前 10 个字,这两条就认得出来了。
 *
 * ⚠️ 2026-09-28 补一条(D57):**开头多一个"更新/新增/加了"也算同一件事**。
 * 小改动改成一条一行、全都列出来之后,这个洞当场露出来了 ——
 * 1.22.3 的第一条是「**更新**播报会把之前没播报过的大更新一起补上…」,
 * 而 1.23.0 已经念过「播报会把之前没播报过的大更新一起补上…」:前 10 个字
 * 差了一个"更新",于是同一件事被念了两遍(旧的"只列 4 条"把它藏住了)。
 * 所以取键之前先把开头这些**没有信息量的动词**剥掉。
 */
export function digestKey(text) {
  return String(text ?? '')
    .replace(/[\s，,。、：:；;！!？?（）()「」“”"'’‘—-]/g, '')
    .replace(/^(更新|新增|加了|修了|修掉|以后|现在)+/, '')
    .slice(0, 10);
}
/**
 * 小改动每一条的"标题化":**只在太离谱时才截**,而且断在标点上。
 *
 * 来历(两步,别把第二步退回去):
 *   · D57(2026-09-28):一条小改动要**占一行**(旧实现把 4~7 条挤成一行 `a…、b…、c…`);
 *     当时为了保住"一行"的观感,把每条截到 **20 字**。
 *   · D64(2026-09-29):用户说「更新内容过长的条目**不要打断,无意义**」。
 *     量化之后他是对的:仓库里最长的小改动只有 **28 字**,而 20 字的上限
 *     在 14 条真实条目里砍坏了 **10 条** —— 砍掉的正是信息本身:
 *     `副实例能把群里的聊天记录打包成一个 P…`、`/群列表 现在带群名和人数`(丢了"不用再对着 openid 猜")。
 *     所以上限放宽到 **60 字**:真实条目**永远碰不到**,它只剩"病态输入"的保险丝作用。
 *
 * 断在标点上的时候**不加省略号**:截出来的是一个完整的小句(「副实例不再有"睡觉"时间」),
 * 尾巴上再挂一个 `…` 只是噪音。只有整句里一个标点都没有、只能硬切时才留 `…`。
 */
export function headline(text, limit = 60) {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf('，'),
    head.lastIndexOf(','),
    head.lastIndexOf('（'),
    head.lastIndexOf('('),
    head.lastIndexOf('：'),
    head.lastIndexOf(':'),
    head.lastIndexOf('；'),
    head.lastIndexOf(';'),
    head.lastIndexOf('、'),
    // 破折号也是"一句话说到这儿就完了"的地方(`…不再挤成一行 —— 一条一行、带编号`)。
    head.lastIndexOf('—'),
    head.lastIndexOf('～'),
    head.lastIndexOf('~'),
  );
  // 硬切时把 `…` 算进 limit 里,否则"截到 limit 字"会变成 limit+1 字(有测试盯着)。
  // 断在破折号上时要**把它整串一起收掉**(`——` 是两个字符,只切一刀会剩一个 `—`)。
  if (cut >= Math.floor(limit / 2)) return head.slice(0, cut).replace(/[\s—–-]+$/, '');
  return `${head.slice(0, limit - 1)}…`;
}

/**
 * 拼出这一次要播报的正文。
 *
 * **为什么不是"只发最新那一条"**(用户的反馈:播报逻辑有问题):
 * 播报这件事停了很久,而这段时间里落地的是**记忆、身体、养成、金币**这些大东西;
 * 只念最新那条补丁,群里永远不知道她有这些能力。所以规则改成
 * "**自上次播报以来**":
 *
 *   · 老的、从没播报过的大更新(播报功能上线之前的)  → 由 CHANGELOG 里那段
 *     「补课」小节提供梗概(那一节是**历史**,不会腐烂);
 *   · 大更新(x.y.0 且有新增)  → 各取最多 `maxPerMajor` 条,从新到旧;
 *   · 小更新(补丁)             → 一条一行、带编号、**不截断**(上限只是保险丝,D64)。
 *
 * **渲染用 `entries`,判断"有没有内容"用 `lines`**:两者内容一一对应,但 `entries`
 * 里每一条自带行首符号(`· ` 或 `1. `)。分成两个字段是因为旧实现里"正文"是把 `lines`
 * 统一加上 `· ` 拼出来的 —— 那样编号列表根本表达不出来。
 *
 * @param {string} text CHANGELOG.md 全文
 * @param {object} [options]
 * @param {string|null} [options.sinceVersion] 上次播报过的版本;没有(或认不出来)= 从没播报过
 * @param {number} [options.maxItems] 大更新最多列几条
 * @param {number} [options.maxPerMajor] 每个大版本最多取几条
 * @param {number} [options.minorLimit] 病态长段落的保险丝(默认 60;真实条目最长 28 字,碰不到它 —— D64)
 * @returns {{version: string, name: string, mode: 'first'|'since', versions: string[],
 *   lines: string[], entries: Array<{kind: string, marker: string, text: string}>, text: string}|null}
 */
export function buildAnnounceDigest(text, {
  sinceVersion = null,
  // ⚠️ **8 → 10**(2026-10-02,D101):那次积压了 **9 个版本**,8 条装不下最老的两个大更新 ——
  // 而其中一个正是「货币换成货币单位」(用户一定会察觉的大改动),被静默挤掉了。
  // 取 10 的判据:积压期"每个大版本各取 2 条"要能覆盖到**货币/身体/生活**那几条主线;
  // 再多就该靠"只保留用户端条目"来瘦身(见 CHANGELOG 头部的写法规范),而不是继续抬上限。
  maxItems = 10,
  maxPerMajor = 2,
  minorLimit = 60,
  majorOnly = true,
} = {}) {
  const { releases, others } = parseChangelog(text);
  const latest = releases[0];
  if (!latest) return null;

  // ⚠️ **2026-10-06 用户改口径**：「副实例播报**只播每个大版本的大内容**(极简),小更新不计入播报」。
  //    判据是**机械的**(`isMajorRelease`:有「新增」小节 且 补丁号是 0)—— 不靠谁记得回来改。
  //    `majorOnly:false` 留给"手动查询"那条路(`/更新`):他想看一眼小改动时仍然看得到。
  if (majorOnly && !isMajorRelease(latest)) return null;

  const wanted = String(sinceVersion ?? '').replace(/^v/, '').trim();
  const stopAt = wanted === '' ? -1 : releases.findIndex((release) => release.version.replace(/^v/, '') === wanted);
  // 认得出基线 = 只补它之后的那几条;认不出(从没播报过)= 全部都要补。
  const pending = stopAt === -1 ? releases : releases.slice(0, stopAt);

  const latestBody = String(latest.sections?.['播报'] ?? '');
  const headerName = (/^\s*([^\s\d]+)\s+v?\d/.exec(latestBody)?.[1] ?? INFRA_CONTENT.primaryName).trim();
  const mode = stopAt === -1 ? 'first' : 'since';

  const lines = [];
  const entries = [];
  const seen = new Set();
  const mark = (line) => seen.add(digestKey(line));
  const known = (line) => seen.has(digestKey(line));
  const push = (line) => {
    const value = String(line ?? '').trim();
    if (value === '' || known(value)) return false;
    mark(value);
    lines.push(value);
    entries.push({ kind: 'item', marker: '· ', text: value });
    return true;
  };

  // 基线那一版**已经播报过**了,所以它自己的要点也算"念过的" —— 否则下一版里
  // 那些"顺手带上上一版要点"的行会被当成新鲜事再念一遍。
  if (stopAt !== -1) for (const item of outlineItems(releases[stopAt])) mark(item);

  // ① 补课:播报功能上线之前那些大东西(记忆 / 暖群 / 情绪 …),只在"从没播报过"时带。
  if (mode === 'first') {
    const capsule = others.find((section) => /补课|上线之前/.test(section.title));
    for (const line of String(capsule?.body ?? '').split(/\r?\n/)) {
      if (!/^\s*[-*]\s+/.test(line)) continue;
      if (lines.length >= maxItems) break;
      push(line.replace(/^\s*[-*]\s+/, ''));
    }
  }

  // ② 大更新:从新到旧,每个最多 maxPerMajor 条(去重 —— 同一件事会在好几版里重复念)。
  //    ⚠️ 2026-10-06:**极简**——一个大版本最多 3 条,总条数上限收到 6(用户:「注意极简播报」)。
  const majorLines = [];
  for (const release of pending) {
    if (!isMajorRelease(release)) continue;
    for (const item of outlineItems(release).slice(0, Math.min(3, maxPerMajor))) {
      if (majorLines.length >= Math.min(6, maxItems)) break;
      majorLines.push(item);
    }
  }
  for (const item of majorLines) push(item);

  // ③ 小更新:一条一行、带编号(D57)。
  //
  // ⚠️ 取的是**这一版里第一条还没被念过的**要点,不是"第一条":1.22.1 / 1.22.2
  //    的「播报」小节当初是"顺手把上一版的要点也带上"写的(为了补播报),
  //    它们的**第一条**其实是 /help —— 直接取第一条会把这句重复念三遍(实测)。
  //
  // ⚠️ 条数**不设上限**:旧实现有 `maxMinorMentions=4`,于是标题写着"另外还有 7 处",
  //    下面只列 4 条 —— 同一件事在两个地方各说一遍,必然会分叉。现在数字就是
  //    列出来的条数,有测试盯着(`小改动:一条一行带编号,条数与标题一致`)。
  const minorItems = [];
  for (const release of pending) {
    if (isMajorRelease(release)) continue;
    const fresh = outlineItems(release).find((item) => !known(item));
    if (fresh === undefined) continue;
    mark(fresh);
    minorItems.push(headline(fresh, minorLimit));
  }
  if (minorItems.length > 0) {
    // ⚠️ 标题必须和"它前面有没有东西"对上(用户 2026-09-29 的现场):
    //    小改动那一节前面**只有大更新条目**时才轮得到"另外"。
    //    补丁连发(比如 1.23.5→1.23.10)时前面一条都没有,而旧实现照写"另外还有 6 处小改动"
    //    —— "另外"什么?读起来就是缺了一段。所以那种情况直接说"6 处小改动"。
    const title = majorLines.length > 0
      ? `另外还有 ${minorItems.length} 处小改动：`
      : `${minorItems.length} 处小改动：`;
    lines.push(title);
    entries.push({ kind: 'minor-title', marker: '· ', text: title });
    minorItems.forEach((item, index) => {
      lines.push(item);
      entries.push({ kind: 'minor', marker: `${index + 1}. `, text: item });
    });
  }

  const header = mode === 'first'
    ? [`${headerName} ${latest.version}`, '', '这次一并补上之前没播报过的更新:']
    : [`${headerName} ${latest.version}`, '', '本次更新内容:'];
  const body = [...header, '', ...entries.map((entry) => `${entry.marker}${entry.text}`)].join('\n');

  return {
    version: latest.version.replace(/^v/, ''),
    name: headerName,
    mode,
    versions: pending.map((release) => release.version),
    lines,
    entries,
    text: body,
  };
}
