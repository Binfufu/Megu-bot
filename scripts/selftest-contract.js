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
  checkPublicContract,
  countOccurrences,
  publicContractRows,
  renderContractPage,
  renderPublicContractPage,
} from '../src/boundary-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'docs', '16-边界契约.md');
const PUBLIC_PAGE = path.join(ROOT, 'docs', '16-边界契约-公开版.md');
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

/**
 * **公开集视图**的判据(2026-10-30)。注册进公开自测(`selftest-public.js`),所以**公开树里也能跑**:
 * 只核公开集里真的存在的锚,并证明公开页不漏私有细节、不出现内部决策号。
 *
 * ⚠️ 它与上面那条私有判据**互不替代**:私有页仍要全量同步(那条不动),公开页只核公开集里能核的。
 */
export function registerContractPublicTests({ test, assert }) {
  test('边界契约公开视图:只核公开集里的锚、页面同步、无内部决策号', () => {
    const publicRows = publicContractRows(CONTRACT_ROWS);
    const excluded = CONTRACT_ROWS.filter((row) => row.publicView === false);

    // ① 每一行要么进公开视图,要么在「不在公开集」里被点名 —— 不许悄悄少
    assert.equal(publicRows.length + excluded.length, CONTRACT_ROWS.length, '公开视图要么列、要么点名');
    assert.ok(excluded.length >= 1, '依赖面板模块锚点的行必须被公开视图排除');

    // ② 公开行的锚在公开树里都能核(缺文件 → 判据真红,不是"跳过")
    const checked = checkPublicContract(CONTRACT_ROWS, io);
    assert.ok(checked.ok, `公开视图锚点对不上:\n${checked.problems.join('\n')}`);

    // ③ 提交的公开页 == 渲染结果(手改生成页 → 红)
    const page = fs.readFileSync(PUBLIC_PAGE, 'utf8');
    assert.equal(page, renderPublicContractPage(CONTRACT_ROWS), 'docs\\16-边界契约-公开版.md 与数据不同步:请跑 `node scripts\\contract.js --public --write`');

    // ④ 公开页不列内部决策号;私有页仍保留(证明中性化只在渲染层,没动数据)
    assert.doesNotMatch(page, /\bD\d{1,4}\b/, '公开契约页不得出现内部决策号 D##');
    assert.match(renderContractPage(CONTRACT_ROWS), /\bD\d{1,4}\b/, '私有全量页仍保留决策号(中性化只作用于公开视图)');

    // ⑤ 公开页不含网页面板模块的细节;但要把被排除的边界**点名**,不藏
    for (const needle of ['panel.js', 'panel-actions.js', 'panel-view.js', 'requireAccountForActions', 'PANEL_ACTION_KINDS', 'home:shared']) {
      assert.ok(!page.includes(needle), `公开契约页不该出现私有模块细节:${needle}`);
    }
    assert.ok(page.includes('不在公开集'), '公开页要说明哪些边界不在公开集');
    for (const row of excluded) assert.ok(page.includes(row.boundary), `被排除的边界要明示:${row.boundary}`);

    // ⑥ 少核的那条侧锚不冒充已核:公开页要写明"面板侧不核"
    assert.ok(page.includes('面板侧不核'), 'quest 行的面板侧锚要写明不核,不许假装核过');
  });
}
