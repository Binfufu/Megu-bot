/**
 * **记忆作用域**(P0,2026-10-28)回归。
 *
 * 要治的形状:常驻块/洞察是"全库一份",却无条件拼进**任何**会话 ——
 * 于是同一个 bot 的私聊内容能经派生层出现在群聊里(合成数据实证;一 bot 一库挡不住)。
 *
 * 判据分三组:
 *   · 纯函数矩阵:哪种会话 key 拿得到私有块/洞察(fail closed);
 *   · **真临时库**端到端:同一份块/洞察,群里渲染不出金丝雀、主人私聊渲染得出;
 *   · wiring:index.js 的两个注入点必须真的过作用域(扫源码,防"改了模块没接线")。
 *
 * ⚠️ 反证(判据必须能红):把 `filterBlocksForAccess` 的 privateBlocks 判断去掉 →
 *    "群里不含金丝雀"当场红。本文件里那条"空访问必须掉块"的断言就是它的替代形状。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PUBLIC_BLOCK_LABELS,
  describeMemoryAccess,
  filterBlocksForAccess,
  filterInsightsForAccess,
  memoryAccessFor,
  parseConversationScope,
} from '../src/memory-scope.js';
import {
  applyBlockUpdates, ensureBlockSchema, getMemoryBlocks, openMemory, renderMemoryBlocks,
} from '../src/memory-store.js';
import { appendInsights, latestInsights, renderInsights } from '../src/memory-insights.js';

const CANARY = 'CANARY_PRIVATE_OWNER_ONLY';
const OWNER = 'A1B2C3D4E5F6A7B8C9D0E1F2';
const OTHER = 'F0E1D2C3B4A5968778695A4B';

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-scope-${tag}-`));
}

export function registerMemoryScopeTests({ test, assert }) {
  test('作用域:会话 key 形态解析（c2c / group / web / 认不出）', () => {
    assert.deepEqual(parseConversationScope(`qqbot-c2c-${OWNER}`), { kind: 'c2c', id: OWNER });
    assert.deepEqual(parseConversationScope('qqbot-group-123456'), { kind: 'group', id: '123456' });
    assert.deepEqual(parseConversationScope('qqbot-web-77'), { kind: 'web', id: '77' });
    assert.deepEqual(parseConversationScope('qqbot-summary-gen1'), { kind: 'unknown', id: null });
    assert.deepEqual(parseConversationScope(''), { kind: 'unknown', id: null });
    assert.deepEqual(parseConversationScope(null), { kind: 'unknown', id: null });
  });

  test('作用域矩阵:群/网页/陌生私聊一律拿不到私有内容，主人私聊才给', () => {
    const ownerIds = new Set([OWNER]);
    const owner = memoryAccessFor(`qqbot-c2c-${OWNER}`, { ownerIds });
    assert.deepEqual([owner.privateBlocks, owner.insights, owner.reason], [true, true, 'owner-c2c']);
    const other = memoryAccessFor(`qqbot-c2c-${OTHER}`, { ownerIds });
    assert.deepEqual([other.privateBlocks, other.insights, other.reason], [false, false, 'other-user-c2c']);
    const group = memoryAccessFor('qqbot-group-123456', { ownerIds });
    assert.deepEqual([group.privateBlocks, group.insights, group.reason], [false, false, 'group']);
    const web = memoryAccessFor('qqbot-web-77', { ownerIds });
    assert.deepEqual([web.privateBlocks, web.insights, web.reason], [false, false, 'web']);
    const unknown = memoryAccessFor('qqbot-summary-gen1', { ownerIds });
    assert.deepEqual([unknown.privateBlocks, unknown.insights, unknown.reason],
      [false, false, 'unknown-conversation']);
    // 没配名单:私聊保持既有行为(**待收紧**,文件头「已知残余 1」),群聊照样不给。
    const unlisted = memoryAccessFor(`qqbot-c2c-${OTHER}`, { ownerIds: null });
    assert.equal(unlisted.privateBlocks, true);
    assert.equal(unlisted.reason, 'c2c-unverified-owner');
    assert.equal(memoryAccessFor('qqbot-group-123456', { ownerIds: null }).privateBlocks, false);
  });

  test('反证:私有内容必须是"默认不给"，访问为空/未声明一律掉块掉洞察', () => {
    const blocks = [
      { label: 'about-her', value: '她是爱丽丝。' },
      { label: 'about-owner', value: CANARY },
      { label: 'relation', value: `${CANARY}-relation` },
      { label: 'promises', value: `${CANARY}-promise` },
    ];
    // 公开标签就那一个,且必须写死(不是"read_only 就算公开"的推导)。
    assert.deepEqual([...PUBLIC_BLOCK_LABELS], ['about-her']);
    for (const access of [undefined, null, {}, { privateBlocks: false }, { privateBlocks: 'yes' }]) {
      const kept = filterBlocksForAccess(blocks, access);
      assert.deepEqual(kept.map((block) => block.label), ['about-her'], `访问=${JSON.stringify(access)} 只留公开块`);
    }
    // 只有显式 true 才全给。
    assert.equal(filterBlocksForAccess(blocks, { privateBlocks: true }).length, 4);
    // 洞察:非 true 一律空(连公开的都没有 —— 洞察本来就是私有派生)。
    for (const access of [undefined, null, {}, { insights: false }, { insights: 1 }]) {
      assert.deepEqual(filterInsightsForAccess([{ text: CANARY }], access), []);
    }
    assert.equal(filterInsightsForAccess([{ text: CANARY }], { insights: true }).length, 1);
    // 入参不是数组时不抛(库坏/老库降级)。
    assert.deepEqual(filterBlocksForAccess(null, { privateBlocks: true }), []);
    assert.deepEqual(filterInsightsForAccess(undefined, { insights: true }), []);
  });

  test('端到端（真临时库）:同一份块/洞察，群里渲染不出金丝雀、主人私聊渲染得出', () => {
    const dir = tempDir('e2e');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        ensureBlockSchema(db, { aboutHerValue: '她是爱丽丝。' });
        applyBlockUpdates(db, [
          { label: 'about-owner', value: CANARY },
          { label: 'relation', value: '互称同伴。' },
        ], { model: 'test', now: 1 });
        appendInsights(db, [{ text: `${CANARY}-insight`, derivedFrom: [1, 2] }], { model: 'test', now: 1 });
        const ownerIds = new Set([OWNER]);

        // ① 群聊:私有块一个字都不出现,公开锚点仍然在。
        const group = memoryAccessFor('qqbot-group-123456', { ownerIds });
        const groupXml = renderMemoryBlocks(db, { blocks: filterBlocksForAccess(getMemoryBlocks(db), group) });
        assert.equal(groupXml.includes(CANARY), false, '群里不许出现私聊派生内容');
        assert.equal(groupXml.includes('about-her'), true, '公开身份锚点照给');
        assert.equal(renderInsights(db, { rows: filterInsightsForAccess(latestInsights(db), group) }), '',
          '群聊不给洞察');
        // ② 主人私聊:块与洞察都在。
        const ownerKey = `qqbot-c2c-${OWNER}`;
        const owner = memoryAccessFor(ownerKey, { ownerIds });
        const ownerXml = renderMemoryBlocks(db, { blocks: filterBlocksForAccess(getMemoryBlocks(db), owner) });
        assert.equal(ownerXml.includes(CANARY), true, '主人私聊照旧拿得到');
        assert.match(renderInsights(db, {
          rows: filterInsightsForAccess(latestInsights(db), owner),
        }), new RegExp(`${CANARY}-insight`), '主人私聊照旧有洞察');
        // ③ 陌生私聊:拿不到。
        const other = memoryAccessFor(`qqbot-c2c-${OTHER}`, { ownerIds });
        assert.equal(renderMemoryBlocks(db, {
          blocks: filterBlocksForAccess(getMemoryBlocks(db), other),
        }).includes(CANARY), false, '陌生私聊不许共享主人的块');
        // ④ 兼容:不传 blocks/rows 的旧调用**行为不变**(渲染层只管排版)。
        assert.equal(renderMemoryBlocks(db).includes(CANARY), true, '旧调用保持原行为（纯渲染判据不破）');
        assert.match(renderInsights(db), new RegExp(CANARY), '旧调用保持原行为');
        // ⑤ 日志措辞不含内容。
        const line = describeMemoryAccess(group);
        assert.equal(line.includes(CANARY), false, '排障行不许带内容');
        assert.match(line, /group/);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('wiring:两个注入点都必须过作用域（扫源码，防"模块写了没接线"）', () => {
    const source = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    assert.match(source, /import \{ filterBlocksForAccess, filterInsightsForAccess, memoryAccessFor \} from '\.\/memory-scope\.js'/,
      'import 必须与模块导出一致');
    const handoffStart = source.indexOf('async function handoffFor(');
    const handoffEnd = source.indexOf('\n  }', handoffStart);
    const handoffBody = source.slice(handoffStart, handoffEnd);
    assert.match(handoffBody, /memoryAccessFor\(conversationKey/, '交接:按会话 key 判作用域');
    assert.match(handoffBody, /filterBlocksForAccess\(/, '交接:块真的被过滤过');
    const notesStart = source.indexOf('  async function turnNotes(');
    const notesEnd = source.indexOf('\n  /**', notesStart);
    const notesBody = source.slice(notesStart, notesEnd);
    assert.match(notesBody, /filterInsightsForAccess\(/, '每轮:洞察真的被过滤过');
    // 反证:过滤不能是"过滤完又丢掉结果"—— 必须喂给渲染函数的对应参数。
    assert.match(handoffBody, /renderMemoryBlocks\(memoryDb, \{ blocks: visible \}\)/);
    assert.match(notesBody, /rows:/);
  });
}
