/**
 * **"锚点页"的共用内核**(2026-10-10,`1.106.7` / D179)。
 *
 * 项目里现在有两页"会被反复当裁决入口用"的东西:
 * ① `docs\16-边界契约.md`(谁拥有 / 怎么交回,数据在 `src\boundary-contract.js`);
 * ② `docs\17-通道策略表.md`(每条通道"满了怎么办 / 迟了怎么办",数据在 `src\channel-policy.js`)。
 *
 * ⚠️ 两页要做的事**一模一样**:数据唯一 → 渲染成 markdown → 拿每条锚去真源码里核 → 不同步就红。
 * 所以实现**只此一份**(D159):本文件收 `countOccurrences` / `checkAnchors` / `renderTable`,
 * 那两个数据模块各自只写"自己的行"和"自己的渲染细节"。
 *
 * 一条约定:**锚点只认不会腐烂的字符串**(建表语句、常量名、函数名、日志原话),**不认行号** ——
 * 行号是最容易腐烂的东西。
 */

/** 子串出现次数(不用正则,免得被锚点里的特殊字符咬)。 */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * 按每行的 `anchors` 去真源码里核(纯函数:读文件由调用方注入,方便单测喂假数据)。
 *
 * 每种毛病都要**单独报一条**(否则"全绿"可能只是因为检查器从来不响):
 * 缺字段 / id 重复 / 没有锚 / 读不到文件 / 找不到那段话 / 数量不符 / 正则不匹配。
 *
 * @param {readonly object[]} rows
 * @param {{readFile: (relativePath: string) => string}} io
 * @param {{requiredFields?: readonly string[]}} [options]
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkAnchors(rows, io, { requiredFields = ['id'] } = {}) {
  const problems = [];
  const seen = new Set();
  for (const row of rows) {
    for (const field of requiredFields) {
      if (!row[field]) problems.push(`${row.id ?? '(无 id)'}: 缺字段 ${field}`);
    }
    if (seen.has(row.id)) problems.push(`${row.id}: id 重复`);
    seen.add(row.id);
    if (!Array.isArray(row.anchors) || row.anchors.length === 0) {
      problems.push(`${row.id}: 没有锚 —— 这一行没人能核`);
      continue;
    }
    for (const anchor of row.anchors) {
      let text = null;
      try {
        text = io.readFile(anchor.file);
      } catch (err) {
        problems.push(`${row.id}: 读不到 ${anchor.file}(${err?.message ?? err})`);
        continue;
      }
      for (const needle of anchor.must ?? []) {
        const hits = countOccurrences(text, needle);
        if (hits === 0) problems.push(`${row.id}: \`${anchor.file}\` 里找不到 \`${needle}\``);
        else if (typeof anchor.count === 'number' && hits !== anchor.count) {
          problems.push(`${row.id}: \`${anchor.file}\` 里 \`${needle}\` 有 ${hits} 处,写的是 ${anchor.count} 处`);
        }
      }
      for (const pattern of anchor.match ?? []) {
        if (!new RegExp(pattern, anchor.flags ?? 's').test(text)) {
          problems.push(`${row.id}: \`${anchor.file}\` 里匹配不上 \`${pattern}\``);
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** markdown 表格(单元格里的 `|` 会被转义,免得表格散架;反斜杠也先转义,否则 `\|` 会被吃掉)。 */
export function renderTable(headers, rows) {
  const cell = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines;
}

/** 把一条锚写成给人看的一句话(两页共用同一套说法)。 */
export function describeAnchor(anchor) {
  const what = [
    ...(anchor.must ?? []).map((text) => `有 \`${text}\``),
    ...(anchor.match ?? []).map((text) => `匹配 \`${text}\``),
  ].join('、');
  const count = typeof anchor.count === 'number' ? `(**恰好 ${anchor.count} 处**)` : '';
  return `锚:\`${anchor.file}\` ${what}${count}`;
}
