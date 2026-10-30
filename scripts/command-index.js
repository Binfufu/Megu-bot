/**
 * 生成 `docs\命令与关键字.md` —— 命令与关键字的**一张表**。
 *
 * 用途有两个,第二个才是关键:
 *   1. 用户看得方便(「现在手动命令越来越多了」);
 *   2. **防腐烂**:命令原来散在 `src/index.js` 的五个 `Set` 里、关键字在 `config.js`、
 *      而角色卡还"自称"支持一些命令 —— 三处没人对照。现在文档由 `src/commands.js`
 *      现算,`selftest` 里有一条测试比对"文档 == 这张表",所以改了代码忘了改文档会被测出来。
 *
 * 用法:
 *   node scripts\command-index.js           # 打印(不改文件)
 *   node scripts\command-index.js --write   # 写进 docs\命令与关键字.md
 *   node scripts\command-index.js --selftest # 离线验证公开视图与私有覆写边界
 *
 * ⚠️ 公开页**不列内部决策号**(`D##`):数据里的号是私有侧追溯用的,渲染时统一中性化
 * (`src\public-doc-text.js`) —— 不在 `src\commands.js` 里删,否则运行时的 `/help` 文案也跟着变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_COMMAND_VIEW } from '../src/commands.js';
import { neutralizeDecisionRefs } from '../src/public-doc-text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC_FILE = path.join(ROOT, 'docs', '命令与关键字.md');

const SCOPE_LABEL = { c2c: '私聊', group: '群聊', both: '私聊 / 群聊' };
const WHO_LABEL = { anyone: '任何人', operator: '操作者名单', bridge: '桥（不到模型）' };

/**
 * 渲染整份文档。**纯函数** —— 所以测试可以直接比对"文件内容 == render()",
 * 不用真的去跑命令。
 */
export function renderCommandDoc(view = PUBLIC_COMMAND_VIEW) {
  const { commands, cardClaims, keywordGroups, phrases, opsScripts } = view;
  /** 公开页文本:去内部决策号(D##),空串给一个占位,免得表格空一格。 */
  const publicText = (text) => neutralizeDecisionRefs(text ?? '') || '—';
  const lines = [];
  lines.push('# 命令与关键字(总表)');
  lines.push('');
  lines.push('> ⚠️ **这张表是生成出来的,不要手改。**');
  lines.push('> 来源是 `src/commands.js` 的 `PUBLIC_COMMAND_VIEW`（命令、能力核对、空默认关键词与公开工具），');
  lines.push('> 重新生成:`node scripts\\command-index.js --write`。');
  lines.push('>');
  lines.push('> `selftest.js` 里有一条测试比对"本文件 == 生成结果",所以改了代码忘记重新生成会被测出来。');
  lines.push('');
  lines.push('> 本页固定渲染程序的中性公开视图，不包含本机可选内容覆写，也不列内部决策号（渲染时已中性化）；命令协议存在不代表 demo 已启用所有可选功能。');
  lines.push('> 公开集不包含网页或专用形象素材；具体能力以实例配置和公开文件集合为准。');
  lines.push('');
  lines.push('## 一、桥识别并调度的命令');
  lines.push('');
  lines.push('桥负责识别命令与检查权限；部分可选入口仍可能调用模型组织回复或辅助理解，不能统称为零模型调用。');
  lines.push('');
  lines.push('| 命令 | 别名 | 哪里能用 | 谁能用 | 作用 | 实现在哪 |');
  lines.push('|---|---|---|---|---|---|');
  for (const cmd of commands) {
    lines.push(
      `| \`${cmd.name}\` | ${cmd.aliases.length > 0 ? cmd.aliases.map((a) => `\`${a}\``).join(' ') : '—'} | ` +
      `${SCOPE_LABEL[cmd.scope] ?? cmd.scope} | ${WHO_LABEL[cmd.who] ?? cmd.who} | ${publicText(cmd.effect)} | ${cmd.source} |`,
    );
  }
  lines.push('');
  lines.push('> 「操作者名单」= `QQBOT_ADMIN_IDS`,没配就回落到 `QQBOT_ANNOUNCE_C2C` / `QQBOT_MORNING_C2C`;');
  lines.push('> 三者都没有 = **谁都不能**(fail closed)。');
  lines.push('');
  lines.push('## 二、角色卡自称的能力(**核对用**)');
  lines.push('');
  lines.push('角色卡是给模型看的台词提示,所以卡里写的命令**不一定真的存在**。');
  lines.push('这张表把两边对上 —— 有测试盯着,防止"卡里许愿、代码没有"。');
  lines.push('');
  lines.push('| 卡里写的 | 代码里真有? | 说明 |');
  lines.push('|---|---|---|');
  for (const claim of cardClaims) {
    lines.push(`| \`${claim.claim}\` | ${claim.implemented ? '✅ 有' : '⚠️ 只是台词'} | ${publicText(claim.note)} |`);
  }
  lines.push('');
  lines.push('## 三、关键词(命中就立刻考虑回复)');
  lines.push('');
  lines.push('公开程序不分发角色专用默认关键词。实例可显式设置 `QQBOT_GROUP_KEYWORDS`；命中时跳过防抖与条数门槛，但仍受模式和冷却约束。');
  lines.push('');
  lines.push('| 分类 | 关键词 |');
  lines.push('|---|---|');
  for (const group of keywordGroups) {
    lines.push(`| ${group.label} | ${group.words.join('、')} |`);
  }
  lines.push('');
  const grouped = keywordGroups.reduce((sum, group) => sum + group.words.length, 0);
  lines.push(`公开默认关键词合计 **${grouped}** 个；用户本地配置不计入此生成页。`);
  lines.push('');
  lines.push('## 四、角色话术(不是命令)');
  lines.push('');
  lines.push('这些说法**不截住消息**,而是由提示词引导模型自己说出来 ——');
  lines.push('它们只是可选设定中的表达方式，不是程序指令；公开默认不附带角色专用话术。');
  lines.push('');
  lines.push('| 说法 | 说明 |');
  lines.push('|---|---|');
  for (const item of phrases) {
    lines.push(`| ${item.phrase} | ${publicText(item.note)} |`);
  }
  lines.push('');
  lines.push('## 五、公开离线工具(不是 QQ 命令)');
  lines.push('');
  lines.push('以下命令在仓库根目录运行；完整私库维护入口不列入公开工具表。');
  lines.push('');
  lines.push('| 脚本 | 干什么 |');
  lines.push('|---|---|');
  for (const script of opsScripts) {
    lines.push(`| \`scripts\\${script.name}\` | ${publicText(script.effect)} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Offline checks of the real source table under absent and injected local content. */
export async function selftestPublicCommandDoc() {
  const { default: assert } = await import('node:assert/strict');
  const source = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
  const binding = "import { LOCAL_STORY_WORLD } from './local-story-world-content.js';";
  assert.ok(source.includes(binding), 'test injection must match the actual content boundary');
  const marker = 'PRIVATE_CONTENT_SENTINEL';
  const protocols = (rows) => rows.map(({ name, aliases, scope, who, source: implementation }) =>
    ({ name, aliases, scope, who, source: implementation }));
  const fixture = {
    commandEffects: Object.fromEntries(PUBLIC_COMMAND_VIEW.commands.map(({ name }) => [name, marker])),
    cardClaimNotes: Object.fromEntries(PUBLIC_COMMAND_VIEW.cardClaims.map(({ claim }) => [claim, marker])),
    keywordGroups: [{ label: marker, words: [marker] }],
    arisPhrases: [{ phrase: marker, note: marker }],
    opsEffects: Object.fromEntries(PUBLIC_COMMAND_VIEW.opsScripts.map(({ name }) => [name, marker])),
  };
  const load = (content) => import(`data:text/javascript;base64,${Buffer.from(source.replace(binding,
    `const LOCAL_STORY_WORLD = ${JSON.stringify(content)};`)).toString('base64')}`);
  const absent = await load(null);
  const present = await load(fixture);
  const expected = renderCommandDoc();
  assert.equal(renderCommandDoc(absent.PUBLIC_COMMAND_VIEW), expected, 'absent content must not change public rendering');
  assert.equal(renderCommandDoc(present.PUBLIC_COMMAND_VIEW), expected, 'local overrides must not change public rendering');
  assert.ok(!JSON.stringify(present.PUBLIC_COMMAND_VIEW).includes(marker), 'public view must not contain injected private content');
  assert.ok(!expected.includes(marker), 'generated page must not contain injected private content');
  assert.doesNotMatch(expected, /\bD\d{1,4}\b/, '公开命令表不得出现内部决策号 D##(渲染时应中性化)');
  assert.ok(PUBLIC_COMMAND_VIEW.commands.some(({ effect }) => /\bD\d{1,4}\b/.test(effect)),
    '源数据仍保留决策号(中性化只在渲染层,不改运行时文案)');
  assert.equal(PUBLIC_COMMAND_VIEW.keywordGroups.length, 0, 'public defaults have no persona keywords');
  assert.equal(PUBLIC_COMMAND_VIEW.phrases.length, 0, 'public defaults have no persona phrases');
  assert.deepEqual(protocols(present.BRIDGE_COMMANDS), protocols(absent.BRIDGE_COMMANDS), 'local content must not change command protocol');
  assert.ok(present.helpText().includes(marker), 'runtime help must still consume local display overrides');
  assert.equal(present.CARD_CLAIMS[0].note, marker, 'runtime claims must still consume local content');
  assert.equal(present.KEYWORD_GROUPS[0].words[0], marker, 'runtime keyword groups must still consume local content');
  assert.equal(present.ARIS_PHRASES[0].phrase, marker, 'runtime phrases must still consume local content');
  assert.ok(present.OPS_SCRIPTS.some(({ effect }) => effect === marker), 'runtime operations text must still consume local content');
  assert.equal(fs.readFileSync(DOC_FILE, 'utf8'), expected, 'generated page must equal the public view rendering');
  console.log('command-index public: absent/present content, no-leak, runtime overrides, protocol and generated-page checks passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = renderCommandDoc();
  if (process.argv.includes('--selftest')) {
    await selftestPublicCommandDoc();
  } else if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(DOC_FILE), { recursive: true });
    fs.writeFileSync(DOC_FILE, text, 'utf8');
    console.log(`已写入 ${DOC_FILE}（${text.length} 字节）`);
  } else {
    process.stdout.write(text);
  }
}
