/**
 * 边界契约的判据(1.106.6 / D178)。
 *
 * ⚠️ 这一组测试的意义:**那一页不许腐烂**。三种情况必须变红 ——
 * ① 页与数据不同步(有人手改了生成出来的 markdown);
 * ② 代码把边界挪走了(锚点找不到了);
 * ③ 同一件事长出了第二处实现(`count: 1` 的锚变成两处,也就是 D159 那条)。
 *
 * 还要证明**检查器真的会红**(拿假锚喂它)—— 否则"全绿"可能只是因为判据从来不响。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_ROWS,
  checkContract,
  countOccurrences,
  renderContractPage,
} from '../src/boundary-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'docs', '16-边界契约.md');
const io = { readFile: (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8') };

export function registerContractTests({ test, assert }) {
  test('边界契约(D178/1.106.6):那一页是派生的,而且条目都经得起核', () => {
    // ① 真仓库:每条锚都要命中(找不到 = 边界被挪走了)
    const real = checkContract(CONTRACT_ROWS, io);
    assert.ok(real.ok, `锚点对不上:\n${real.problems.join('\n')}`);

    // ② 提交的那一页必须与 render 出来**逐字一致** —— 手改生成页 = 红
    const page = fs.readFileSync(PAGE, 'utf8');
    assert.equal(page, renderContractPage(CONTRACT_ROWS), 'docs\\16-边界契约.md 与数据不同步:请跑 `node scripts\\contract.js --write`');

    // ③ 检查器**真的会红**:假锚 / 数量不符 / 缺字段,三种都要被抓
    const fakeRows = [
      { id: 'x1', boundary: 'b', owner: 'o', trigger: 't', how: 'h', anchors: [{ file: 'src/index.js', must: ['这句话源码里绝对没有'] }] },
      { id: 'x2', boundary: 'b', owner: 'o', trigger: 't', how: 'h', anchors: [{ file: '不存在的文件.js', must: ['x'] }] },
      { id: 'x3', boundary: 'b', owner: 'o', trigger: 't', how: 'h', anchors: [{ file: 'src/index.js', must: ['const MAX_PASSIVE_SEQ = 5;'], count: 2 }] },
      { id: 'x4', boundary: 'b', owner: '', trigger: 't', how: 'h', anchors: [{ file: 'src/index.js', must: ['const MAX_PASSIVE_SEQ = 5;'] }] },
      { id: 'x5', boundary: 'b', owner: 'o', trigger: 't', how: 'h', anchors: [] },
    ];
    const fake = checkContract(fakeRows, io);
    assert.equal(fake.ok, false, '"检查器全绿"不能是因为它从来不响');
    assert.equal(fake.problems.length, 5, `五种毛病各要报一条,实际:${JSON.stringify(fake.problems)}`);

    // ④ 那个"只此一处"的锚(D159):出站咽喉不许长出第二份实现
    const outboundWriters = CONTRACT_ROWS.find((row) => row.id === 'said').anchors
      .filter((anchor) => anchor.count === 1);
    assert.equal(outboundWriters.length >= 1, true, '"她说的话"必须有"恰好一处"的锚');
    assert.equal(countOccurrences(io.readFile('src/index.js'), 'recordOutbound({'), 1, '出站留痕只能有一处写入点');

    // ⑤ 调研点名要写清的四件必须在那一页里(用户 2026-10-10 的判据:"只看这一页就能判谁错")
    for (const needle of ['outbound', 'stats', 'fishing:', 'knownGroups']) {
      assert.ok(page.includes(needle), `那一页必须回答「${needle}」这类争议:${needle}`);
    }
    // 而且四个"边界"里最容易吵的两条要**明说方向相反**(她的身体共享 / 钓鱼按人)
    assert.ok(page.includes('一只 bot 一份,不按玩家分') && page.includes('按人'), '共享 vs 按人 要写清');
  });
}
