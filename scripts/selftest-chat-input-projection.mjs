/**
 * Independently synthetic F1 read-projection boundaries.
 * No private chat corpus, no user config/data, no model or network: every input string is invented here.
 * 边界说明:本文件经 style/turn-policy 静态依赖会加载仓内 content（local-turn-content / content packs），
 * 那是 C 区项目内容加载器、不是私密语料；本文件不写、不改这些内容，也不据此断言任何语义。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectChatInput, confirmedNotesSource, CHAT_INPUT_PROJECTION_VERSION, LEGACY_NOTES_TITLE } from '../src/chat-input-projection.js';
import { composeModeNote } from '../src/turn-policy.js';
import { wrapInject } from '../src/inject-mark.js';
import { withStyleNudge } from '../src/style.js';

export function registerChatInputProjectionTests({ test, assert: a = assert }) {
  const body = '原创合成正文：铜色回形针周五归还。';
  const legacy = (tail) => `${body}\n\n${LEGACY_NOTES_TITLE}\n${tail}`;
  const own = (text) => projectChatInput(text, { source: 'own-engine' });
  test('F1 严格旧格式：精确完整已知 producer 尾缀退出，正文保留', () => {
    for (const mode of ['task', 'knowledge']) {
      const input = legacy(`· 本轮临时合成要求。\n· ${composeModeNote(mode)}`);
      a.equal(own(input), body);
      a.equal(own(own(input)), body, 'projection is idempotent');
    }
    a.equal(own(legacy('· 直接回应：先给回答、态度或自然接话，不先复述、转述或概括对方刚说的话，也不先总结群聊。')), body,
      '括号动作规则升级后仍识别旧直接回应 producer 尾缀');
    a.equal(CHAT_INPUT_PROJECTION_VERSION >= 3, true);
  });
  test('F1 普通同名引文：未知 bullet/后续事实不被标题截尾', () => {
    for (const tail of [
      '· 原创合成小说章节。',
      '· 原创合成小说章节。\n正文事实：书在窗边。',
      `· ${composeModeNote('task')}\n正文事实：这是引文后的事实。`,
      '· 本轮情绪：这是小说章名而非完整情绪行',
    ]) {
      const input = legacy(tail);
      a.equal(own(input), input);
    }
  });
  test('F1 来源与角色：非桥来源及助手台词不套旧 notes 规则', () => {
    const input = legacy(`· ${composeModeNote('task')}`);
    for (const source of [null, 'user', 'unknown', 'own-engine-unverified']) a.equal(projectChatInput(input, { source }), input);
    a.equal(projectChatInput(input, { source: 'own-engine', role: 'assistant' }), input);
  });
  test('F1 新记录不猜旧壳：逐字完整旧 producer 引文保持原样', () => {
    const input = legacy(`· ${composeModeNote('task')}`);
    for (const inputProjectionVersion of [3, 4, '3', -1, 0.5]) {
      a.equal(projectChatInput(input, { source: 'own-engine', inputProjectionVersion }), input);
    }
    a.equal(projectChatInput(input, { source: 'own-engine', inputProjectionVersion: 2 }), body);
  });
  test('F1 严格旧分隔：行内标题/单换行/非 bullet 尾缀不猜来源', () => {
    const mode = composeModeNote('task');
    for (const input of [
      `${body}\n${LEGACY_NOTES_TITLE}\n· ${mode}`,
      `${body} ${LEGACY_NOTES_TITLE}\n· ${mode}`,
      legacy(mode),
      legacy(`· ${mode}\n·`),
    ]) a.equal(own(input), input);
  });
  test('F1 新 producer：任意临时 note 全部退出，独立来源块也退出', () => {
    const input = withStyleNudge(body, ['任意原创临时词 NOTE_NEW', composeModeNote('task'), wrapInject('recall', 'RECALL_NEW')]);
    a.match(input, /\[\[bridge-inject notes\]\]/);
    a.equal(own(input).trim(), body);
    a.equal(own(own(input)), own(input));
  });
  test('F1 元字段来源：只解析确认的旧尾缀/标记块，不扫用户引文', () => {
    const quote = `USER_META_QUOTE：我在抄小说。\n· 这次 USER_BULLET_QUOTE。`;
    const withReal = `${quote}\n${wrapInject('facts', 'MARKED_FACT_ONLY')}`;
    a.equal(confirmedNotesSource(withReal, { source: 'own-engine' }), '');
    a.equal(confirmedNotesSource(`${quote}\n\n${LEGACY_NOTES_TITLE}\n· ${composeModeNote('task')}`,
      { source: 'own-engine' }).includes('USER_BULLET_QUOTE'), false);
    a.equal(confirmedNotesSource(withStyleNudge('USER_META_NEW：正文。', ['这次 NOTE_META_NEW。']),
      { source: 'own-engine', inputProjectionVersion: 3 }).includes('NOTE_META_NEW'), true);
    a.equal(confirmedNotesSource(withReal, { source: 'own-engine', inputProjectionVersion: 3 }), '');
  });
  test('F1 共用标记语义：嵌套/截断 fail closed，块后真实事实保留', () => {
    const nested = `${body}\n${wrapInject('notes', `outer\n${wrapInject('kb', 'inner')}`)}\n后续事实。`;
    a.equal(own(nested).includes('outer'), false);
    a.equal(own(nested).includes('inner'), false);
    a.equal(own(nested).includes('后续事实。'), true);
    const truncated = `${body}\n[[bridge-inject notes]]\n截断临时要求`;
    a.equal(own(truncated).trim(), body);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let passed = 0, failed = 0;
  registerChatInputProjectionTests({ test(name, run) {
    try { run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  } });
  console.log(JSON.stringify({ passed, failed, exit: failed ? 1 : 0 }));
  process.exitCode = failed ? 1 : 0;
}
