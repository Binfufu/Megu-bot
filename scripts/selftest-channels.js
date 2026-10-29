/**
 * 通道策略表的判据(1.106.7 / D179)。与边界契约同源(实现共用 `src\anchored-page.js`):
 * 锚点要经得起核、生成页不许手改、检查器**真的会红**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_ROWS, checkChannels, renderChannelPage } from '../src/channel-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'docs', '17-通道策略表.md');
const io = { readFile: (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8') };

export function registerChannelTests({ test, assert }) {
  test('通道策略表(D179/1.106.7):每条通道都写了"满了/迟了",而且锚点经得起核', () => {
    // ① 真仓库:锚全中(找不到 = 那条通道的边界被挪走了)
    const real = checkChannels(CHANNEL_ROWS, io);
    assert.ok(real.ok, `锚点对不上:\n${real.problems.join('\n')}`);

    // ② 提交的那一页 = render 的结果(手改生成页 → 红)
    const page = fs.readFileSync(PAGE, 'utf8');
    assert.equal(page, renderChannelPage(CHANNEL_ROWS), 'docs\\17-通道策略表.md 与数据不同步:请跑 `node scripts\\channels.js --write`');

    // ③ 检查器真的会红(缺字段 / 空锚 / 数量不符,各一条)
    const fake = checkChannels([
      { id: 'c1', channel: 'x', cap: '', late: 'l', anchors: [{ file: 'src/index.js', must: ['const MAX_PASSIVE_SEQ = 5;'] }] },
      { id: 'c2', channel: 'x', cap: 'c', late: 'l', anchors: [] },
      { id: 'c3', channel: 'x', cap: 'c', late: 'l', anchors: [{ file: 'src/index.js', must: ['const MAX_PASSIVE_SEQ = 5;'], count: 3 }] },
    ], io);
    assert.equal(fake.ok, false, '"检查器全绿"不能是因为它从来不响');
    assert.equal(fake.problems.length, 3, `三种毛病各要报一条,实际:${JSON.stringify(fake.problems)}`);

    // ④ 调研点名的那三条"临时截断"必须在这页里有对策(截断 / 过期 / 没轮到)
    for (const needle of ['MAX_PASSIVE_SEQ', 'whereaboutsTtlMs', 'arrivalFreshnessMs', 'SUMMARY_MIN_INTERVAL_MS']) {
      assert.ok(page.includes(needle), `这一页必须给「${needle}」这类现场一个对策`);
    }
    // ⑤ 判据(用户口径:"抽一条现有日志能逐条对上表")—— 三个现成例子必须写在页里,
    //    其中一个必须是**对不上**的那条(对不上才是它有价值的地方)
    assert.ok(page.includes('按短句分 4 条发'), '要有"分条发"的真实日志例子');
    assert.ok(page.includes('距上次已 188 分钟'), '要有"摘要节流"的真实日志例子');
    assert.ok(page.includes('❌ **对不上**'), '要有一条"对不上"的例子(位置 TTL / 到达窗口那条死链)');
  });
}
