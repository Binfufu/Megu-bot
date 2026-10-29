/**
 * `TODO.md` 的解析 —— 纯函数,只做一件事:把那份人手写的清单变成**行**。
 *
 * 为什么要变成行(D35):待办天然就是表格里的记录 —— 有分区、有优先级、有状态、
 * 有"还没验证"这个位。人眼扫一份 96 行的 Markdown 能凑合,但回答不了
 * "还有哪些 ★★★ 没验证""哪个分区最重"这类**跨行**的问题,而且**扫漏了不会报错**。
 * 这正是 SQL 的主场(生信里的样本表就是同一件事)。
 *
 * ⚠️ **`TODO.md` 仍然是唯一的真相**,这里产出的只是**可再生的派生数据**:
 * 删掉索引库不丢任何东西,重建一次就有了(和 `samtools index` / `.fai` 一个道理)。
 * 所以这里**绝不**反向写回 Markdown。
 *
 * 全是纯函数,所以解析规则本身可以单测(见 selftest 的"待办索引"一节)。
 */

/** 索引库的表结构。文件名和内容都随版本走,重建即可,不需要迁移。 */
export const TODO_SCHEMA = `
CREATE TABLE IF NOT EXISTS item (
  section    TEXT    NOT NULL,
  ordinal    INTEGER NOT NULL,   -- 在文件里的出现顺序,给人看的序号
  title      TEXT    NOT NULL,
  priority   INTEGER,            -- 3 / 2 / 1;NULL = 没标星
  status     TEXT    NOT NULL,   -- doing / todo / idea
  unverified INTEGER NOT NULL,   -- ★★★ 那一档 = "还没验证过"(本项目约定)
  line       INTEGER NOT NULL,   -- 在 TODO.md 里的行号,方便跳过去改
  body       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_section ON item(section, ordinal);
CREATE INDEX IF NOT EXISTS idx_item_unverified ON item(unverified, priority);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 索引格式版本 —— 改了上面的表结构就 +1(旧库直接重建,不做迁移)。 */
export const TODO_INDEX_VERSION = 1;

/** 「进行中」与「想法池」是特殊分区:前者是状态,后者是"还没决定做不做"。 */
const DOING_SECTION = /^进行中/;
const IDEA_SECTION = /想法池|存疑/;

/**
 * 条目**必须顶格**(`- ` 在第 0 列);缩进的 `  - xxx` 是条目的子说明,属于上一条。
 *
 * 这条踩过一次:三个 pattern 原来都写成 `^\s*-\s*…`,于是**每一条子说明都被当成
 * 新的待办**(进行中从 2 条变成 9 条),而"条数变多"看起来并不像错误。
 * 现在 `item` 里那个 `body` 字段才是子说明该待的地方。
 */
const STARRED = /^- \*\*(★+[☆★]*)\s*(.+?)\*\*\s*[:：]?\s*(.*)$/;
/** `- **想法池**:…` 这种有粗体但没星标的。 */
const BOLD_ONLY = /^- \*\*(.+?)\*\*\s*[:：]?\s*(.*)$/;
/** `- 一句普通的话`。 */
const PLAIN = /^- (.*)$/;
/** 缩进的续行(子条目或说明)。 */
const CONTINUATION = /^\s+\S/;

/**
 * 解析 `TODO.md`。
 *
 * @param {string} text
 * @returns {{items: Array<{section: string, ordinal: number, title: string,
 *   priority: number|null, status: string, unverified: boolean, line: number, body: string}>}}
 */
export function parseTodo(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const items = [];
  let section = '';
  let current = null;
  let ordinal = 0;

  const close = () => {
    if (!current) return;
    current.body = current.lines.join('\n').trim();
    delete current.lines;
    items.push(current);
    current = null;
  };

  lines.forEach((line, index) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      close();
      section = heading[1].trim();
      return;
    }
    if (/^#\s/.test(line)) {
      // 文件标题:不属于任何分区
      close();
      return;
    }

    const starred = STARRED.exec(line);
    const bold = starred ? null : BOLD_ONLY.exec(line);
    const plain = starred || bold ? null : PLAIN.exec(line);

    if (starred || bold || plain) {
      // 分区之前的引言/说明用 `>` 写,不会被 PLAIN 命中 —— 这里再挡一道,
      // 免得将来有人把说明写成普通 bullet 就混进待办里。
      if (section === '') return;
      close();
      ordinal += 1;
      const stage = section;
      current = {
        section,
        ordinal,
        title: (starred ? starred[2] : bold ? bold[1] : plain[1]).trim().replace(/[:：]\s*$/, ''),
        priority: starred ? (starred[1].match(/★/g) ?? []).length : null,
        status: DOING_SECTION.test(stage) ? 'doing' : IDEA_SECTION.test(stage) ? 'idea' : 'todo',
        // 约定:★★★ = "还没验证过"(见 docs/00 与 TODO.md 顶部规则)
        unverified: starred ? (starred[1].match(/★/g) ?? []).length === 3 : false,
        line: index + 1,
        lines: [line],
      };
      return;
    }

    if (current && CONTINUATION.test(line)) {
      current.lines.push(line);
      return;
    }
    // 空行不断开条目(条目内部本来就有空行),其它情况关闭当前条目
    if (current && line.trim() !== '') close();
  });
  close();
  return { items };
}

/** 概览:按分区、按优先级、"还没验证"的条数。给人看的一屏。 */
export function todoStats(items) {
  const bySection = new Map();
  const byPriority = new Map();
  for (const item of items) {
    bySection.set(item.section, (bySection.get(item.section) ?? 0) + 1);
    const key = item.priority ?? 0;
    byPriority.set(key, (byPriority.get(key) ?? 0) + 1);
  }
  return {
    total: items.length,
    unverified: items.filter((item) => item.unverified).length,
    doing: items.filter((item) => item.status === 'doing').length,
    bySection: [...bySection].map(([section, count]) => ({ section, count })),
    byPriority: [...byPriority]
      .sort((a, b) => b[0] - a[0])
      .map(([priority, count]) => ({ priority, count })),
  };
}

/** 一行摘要:`★★★ 标题（进行中）`。命令行与交接快照共用。 */
export function formatItem(item) {
  const stars = item.priority ? '★'.repeat(item.priority) + '☆'.repeat(3 - item.priority) : '   ';
  return `${stars} ${item.title}（${item.section}｜TODO.md:${item.line}）`;
}
