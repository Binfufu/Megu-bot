/**
 * **常驻记忆块**(P1-E,2026-10-19,方案 §4;照搬 Letta memory blocks)回归。
 *
 * 要治的形状:身份/关系/约定这类"永远该在场"的事靠检索**碰运气** ——
 * 常驻块 = 每代首轮必含 XML(挂交接层,不经过检索);后台生成 ≈1 次/天,失败保留旧值;
 * read_only 块(关于她)任何写路径都拒;旧值进 history 可回滚。
 *
 * ⚠️ 判据**真跑临时 SQLite 库** + 纯函数直调(generate 用假回调 —— memory 层零 HTTP 的纪律)。
 *
 * 覆盖:
 *   · 初始化:四块就位、幂等(重复跑不动已填内容)、about-her read_only 带静态初值。
 *   · buildMemoryBlocks(纯编排):正常 JSON → 只产可写块;超长截断 limit_chars;
 *     坏 JSON / 空输出 / 非 JSON → error 且不抛(失败保留旧值);read_only 永不进 updates。
 *   · applyBlockUpdates:旧值进 history、值与 updated_at 落库;read_only 拒绝;同值不写。
 *   · renderMemoryBlocks:XML 形状、空块跳过、全空返回 ''。
 *   · wiring:index.js 的 handoffFor 必须拼 renderMemoryBlocks 且过 wrapInject(换代首轮必含块)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyBlockUpdates, buildMemoryBlocks, ensureBlockSchema, getMemoryBlocks,
  memoryBlockStats, openMemory, renderMemoryBlocks,
} from '../src/memory-store.js';

const BASE = Date.UTC(2026, 9, 1, 4, 0);

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-blocks-${tag}-`));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function registerBlockTests({ test, assert }) {
  test('块初始化:四块就位、幂等、about-her read_only 带静态初值', () => {
    const dir = tempDir('init');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        ensureBlockSchema(db, { aboutHerValue: '她是示例甲。' });
        const blocks = getMemoryBlocks(db);
        assert.equal(blocks.length, 4, '四块固定');
        assert.deepEqual(blocks.map((block) => block.label),
          ['about-her', 'about-owner', 'relation', 'promises']);
        assert.equal(blocks[0].readOnly, true, '关于她 = read_only');
        assert.equal(blocks[0].value, '她是示例甲。', 'read_only 块带静态初值');
        assert.equal(blocks.slice(1).every((block) => !block.readOnly), true, '其余三块可写');
        assert.equal(blocks.slice(1).every((block) => block.value === ''), true, '可写块初值空');
        // 幂等:重复初始化(哪怕 aboutHerValue 不同)不许动已就位的行。
        ensureBlockSchema(db, { aboutHerValue: '示例乙' });
        assert.equal(getMemoryBlocks(db)[0].value, '她是示例甲。', '幂等:已存在的行一动不动');
        const stats = memoryBlockStats(db);
        assert.deepEqual({ blocks: stats.blocks, filled: stats.filled, history: stats.history },
          { blocks: 4, filled: 1, history: 0 });
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('buildMemoryBlocks:只产可写块、超长截断、坏 JSON 不抛(失败保留旧值)', async () => {
    const dir = tempDir('build');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        ensureBlockSchema(db, { aboutHerValue: '她是示例甲。' });
        const current = getMemoryBlocks(db);
        const good = JSON.stringify({
          'about-owner': '用户喜欢被叫示例用户。'.repeat(20), // 远超 200 字 → 截断
          relation: '双方保持示例合作关系。',
          promises: '约定下周完成示例任务。',
          'about-her': '模型想改身份 —— 必须被无视。',
        });
        const result = await buildMemoryBlocks({
          current, notesText: '· 用户说下周去示例广场', generate: async () => good,
        });
        assert.equal(result.error, null, result.error);
        assert.equal(result.updates.length, 3, 'read_only 永不进 updates');
        assert.equal(result.updates.find((item) => item.label === 'about-her'), undefined);
        const owner = result.updates.find((item) => item.label === 'about-owner');
        assert.equal(owner.value.length <= 200, true, '超长截断到 limit_chars');
        // 坏 JSON:不抛,error 说清原因。
        for (const [label, bad] of [['空输出', ''], ['非JSON', '我觉得还行'], ['断JSON', '{"relation": "断了']]) {
          const badResult = await buildMemoryBlocks({
            current, notesText: '', generate: async () => bad,
          });
          assert.equal(badResult.updates.length, 0, `${label}:不产 updates`);
          assert.ok(typeof badResult.error === 'string' && badResult.error.length > 0, `${label}:要说清原因`);
        }
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('applyBlockUpdates:旧值进 history、read_only 拒绝、同值不写、updated_at 落库', () => {
    const dir = tempDir('apply');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        ensureBlockSchema(db, { aboutHerValue: '她是示例甲。' });
        const applied = applyBlockUpdates(db, [
          { label: 'relation', value: '双方保持示例合作关系。' },
          { label: 'promises', value: '约定下周完成示例任务。' },
          { label: 'about-her', value: '越权改身份' },
        ], { model: 'test-model', now: BASE + 1000 });
        assert.equal(applied.written, 2, '两条可写块落库');
        assert.equal(applied.skippedReadOnly, 1, 'read_only 被拒');
        const blocks = getMemoryBlocks(db);
        assert.equal(blocks.find((block) => block.label === 'relation').value, '双方保持示例合作关系。');
        assert.equal(blocks.find((block) => block.label === 'relation').model, 'test-model');
        assert.equal(blocks.find((block) => block.label === 'relation').updatedAt, BASE + 1000);
        assert.equal(blocks.find((block) => block.label === 'about-her').value, '她是示例甲。', 'read_only 原样');
        const stats = memoryBlockStats(db);
        assert.equal(stats.history, 2, '两条旧值进了 history(空初值也算旧值,回滚有据)');
        // 同值再写:不产生新 history(值没变就别刷账)。
        const again = applyBlockUpdates(db, [{ label: 'relation', value: '双方保持示例合作关系。' }], {
          model: 'test-model', now: BASE + 2000,
        });
        assert.equal(again.written, 0, '同值不写');
        assert.equal(memoryBlockStats(db).history, 2, 'history 不涨');
        // renderMemoryBlocks:XML 形状。
        const xml = renderMemoryBlocks(db);
        assert.ok(xml.startsWith('<memory_blocks>'), 'XML 开标签');
        assert.ok(xml.includes('<block label="relation">双方保持示例合作关系。</block>'));
        assert.ok(xml.endsWith('</memory_blocks>'), 'XML 闭标签');
        assert.ok(xml.includes('about-her') === false || xml.includes('她是示例甲。'),
          'read_only 有值也照渲染(它是常驻内容,只是不能被写)');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('renderMemoryBlocks:全空返回空串(交接一字不加)', () => {
    const dir = tempDir('render');
    try {
      const db = openMemory(path.join(dir, 'memory.db'));
      try {
        ensureBlockSchema(db, { aboutHerValue: '' });
        assert.equal(renderMemoryBlocks(db), '', '全部为空 → 一字不加');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('wiring:index.js 的 handoffFor 必须拼 renderMemoryBlocks 且过 wrapInject(换代首轮必含块)', () => {
    // 照 selftest-memory-wiring 的形状:扫源码(selftest 恒从仓库根跑)。
    const source = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    // ⚠️ 2026-10-28(P0 作用域):调用形状改成"把**过滤后**的块交给渲染",
    //    判据明改到新事实,并**追加**"必须先过作用域"这一条 —— 不是删旧判据让它变绿。
    assert.match(source, /renderMemoryBlocks\(memoryDb, \{ blocks: visible \}\)/, 'handoffFor 要渲染常驻块（按作用域过滤后）');
    assert.match(source, /filterBlocksForAccess\(getMemoryBlocks\(memoryDb\), access\)/, '块必须先过作用域过滤');
    assert.match(source, /wrapInject\('handoff', combined\)/, '块与交接合并后过同一份 D177 标记');
    // 反证:字样必须确实在 handoffFor 函数体内,不是文件别处(判据不是装饰)。
    const fnStart = source.indexOf('async function handoffFor(');
    const fnEnd = source.indexOf('\n  }', fnStart);
    const fnBody = source.slice(fnStart, fnEnd);
    assert.match(fnBody, /renderMemoryBlocks/, '字样必须在 handoffFor 函数体内');
    assert.match(fnBody, /memoryAccessFor\(/, '作用域判定必须在 handoffFor 函数体内');
  });
}
