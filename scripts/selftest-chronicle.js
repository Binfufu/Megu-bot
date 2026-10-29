/**
 * **日志 / 编年史**的判据(C 后半截 / D154)。
 *
 * ⚠️ 这一层是**纯派生**:编年史 = `stats_event` 流水 + 位置事实,不新开存储。
 *    所以判据也只需要喂它几行假流水 —— 不碰库、不碰 HTTP。
 */
import { loadNeutralContentFixture } from './selftest-body-rules.js';

const T0 = 1_700_000_000_000;
const event = (extra = {}) => ({ ts: T0, kind: 'meal', satietyDelta: 0, healthDelta: 0, moodDelta: 0, staminaDelta: 0, manaDelta: 0, moneyDelta: 0, detail: null, ...extra });

export function registerChronicleTests({ test: register, assert }) {
  let CHRONICLE_KINDS, buildChronicle, describeChronicleEntry, describeDeltas, pickAwayHighlights, pickSpecialEntries, renderSpecialLine, summarizeAway;
  let daysFor, daysToday, renderDayLine, buildSnapshot, panelShellExpanded, renderPanelPage;
  const expandedPage = (args = {}) => panelShellExpanded(renderPanelPage(args));
  let setup;
  const test = (name, check) => register(name, async () => {
    setup ??= loadNeutralContentFixture(['chronicle', 'character-days', 'panel']).then((loaded) => {
      ({ CHRONICLE_KINDS, buildChronicle, describeChronicleEntry, describeDeltas, pickAwayHighlights, pickSpecialEntries, renderSpecialLine, summarizeAway } = loaded.chronicle);
      ({ daysFor, daysToday, renderDayLine } = loaded['character-days']);
      ({ buildSnapshot, panelShellExpanded, renderPanelPage } = loaded.panel);
    });
    await setup;
    return check();
  });
  test('编年史(D154):**只讲有后果的事** —— 全 0 增量与看不懂的种类都不进日志', () => {
    // ⚠️ **内部 id 不许出现在日志里**(D111 的口径):`detail.label` 存的是 `someone_treats`
    //    这种 id,页面/弹窗上必须是"有人请她吃了一顿"。
    const treat = describeChronicleEntry(event({ kind: 'event', moneyDelta: 800, detail: { label: 'someone_treats' } }));
    assert.ok(treat, '她自己的小事件要进日志');
    assert.ok(!treat.text.includes('someone_treats'), `不许把内部 id 念出去:${treat.text}`);
    assert.equal(treat.text, '合成对象请客');
    // 认不出的 id → 含糊过去(不猜、也不漏 id)
    const unknown = describeChronicleEntry(event({ kind: 'event', moneyDelta: 100, detail: { label: 'made_up_event' } }));
    assert.ok(!unknown.text.includes('made_up_event'));
    assert.equal(unknown.text, '她遇上一点小事');
    // 连 label 都没有时也不许炸
    assert.ok(describeChronicleEntry(event({ kind: 'event', moneyDelta: 100 })),
      '没有 label 的事件也要能进(它讲的是"发生了什么")');

    // ① 看得懂的种类:有数值变化 → 一行
    const meal = describeChronicleEntry(event({ kind: 'meal', satietyDelta: 24, moneyDelta: -900, detail: { food: '定食' } }));
    assert.ok(meal, '吃饭那笔要进编年史');
    assert.equal(meal.text, '吃了定食');
    assert.ok(meal.deltas.includes('饱食+24'), `数值要写出来:${meal.deltas}`);
    assert.ok(meal.deltas.includes('花掉 900 合成币'), '钱要报数');

    // ② ⚠️ **全 0 增量的那一类不进**(那是"有人碰了一下",不是"发生了一件事")
    assert.equal(describeChronicleEntry(event({ kind: 'chat' })), null, '被搭话(0 增量)不算一件事');
    assert.equal(describeChronicleEntry(event({ kind: 'panel' })), null, '面板审计行也不算');
    assert.equal(describeChronicleEntry(event({ kind: '根本不存在的种类' })), null, '看不懂就不猜');
    assert.equal(describeChronicleEntry(null), null);
    // ③ 但**叙事型**的那几种哪怕 0 增量也进(它们讲的是过程,不是数值)
    const quest = describeChronicleEntry(event({ kind: 'quest', detail: { label: '示例委托甲' } }));
    assert.ok(quest, '委托要进(讲的是过程)');
    assert.ok(quest.text.includes('示例委托甲'));
    assert.ok(describeChronicleEntry(event({ kind: 'move' })), '她出门了也要进');

    // ④ 结算那条与接活那条要**分得开**(看 detail 里有没有 grade)
    const settled = describeChronicleEntry(event({ kind: 'quest', moneyDelta: 750, detail: { label: '送信', grade: 'crit_success' } }));
    assert.ok(settled.text.includes('结算'), `结算那笔要说"结算":${settled.text}`);

    // ⑤ 数值那一行:钱只说"进账/花掉",别的用涨跌号
    assert.equal(describeDeltas({ moodDelta: 6, moneyDelta: 0 }), '心情+6');
    assert.equal(describeDeltas({ moneyDelta: -1500 }), '花掉 1500 合成币');
    assert.equal(describeDeltas({}), '');
    for (const kind of Object.keys(CHRONICLE_KINDS)) {
      assert.ok(CHRONICLE_KINDS[kind], `${kind} 要有人话`);
    }
  });

  test('编年史(D154):**新的在前、条数有上限**,而且位置事实单独补(它不在流水里)', () => {
    const events = [
      event({ ts: T0 + 3000, kind: 'fish', moneyDelta: 2400 }),
      event({ ts: T0 + 2000, kind: 'chat' }),
      event({ ts: T0 + 1000, kind: 'meal', satietyDelta: 20, detail: { food: '面包' } }),
      event({ ts: T0, kind: 'quest', detail: { label: '送信' } }),
    ];
    const rows = buildChronicle({ events, limit: 10 });
    assert.equal(rows.length, 3, 'chat 那一笔被丢掉,其余三条留下');
    assert.deepEqual(rows.map((row) => row.ts), [T0 + 3000, T0 + 1000, T0], '新的在前');

    // ⚠️ 位置事实**不在流水里**(它是"她此刻在哪"):在途与"刚到了"各补一条
    const metas = [{
      key: 'world:her',
      value: JSON.stringify({ place: 'demo_home', placeName: '示例住处', to: 'demo_station', toName: '示例站点', arriveAt: T0 + 5000, since: T0 + 1000, doing: '正往示例站点走' }),
    }];
    const withTravel = buildChronicle({ events, metas, limit: 10 });
    assert.ok(withTravel.some((row) => row.kind === 'move' && row.text.includes('出门')), '在途要补一条"她出门了"');
    const landed = buildChronicle({
      events,
      metas: [{ key: 'world:her', value: JSON.stringify({ place: 'demo_station', placeName: '示例站点', arrivedAt: T0 + 6000, since: T0 + 6000 }) }],
      limit: 10,
    });
    assert.ok(landed.some((row) => row.text.includes('她到了示例站点')), '"刚到了"也要补一条');
    // 坏掉的 JSON 不许把整栏搞炸(照实际:退回"只有流水")
    const broken = buildChronicle({ events, metas: [{ key: 'world:her', value: '{坏' }], limit: 10 });
    assert.equal(broken.length, 3, '坏值就当没有那条,别抛也别猜');
    // 条数上限
    assert.equal(buildChronicle({ events, limit: 1 }).length, 1);
  });

  test('「你不在的时候」(D154):只讲**你去忙之后**发生的事,而且**超过一天就不说"你不在"**', () => {
    const entries = buildChronicle({
      events: [
        event({ ts: T0 + 5000, kind: 'meal', satietyDelta: 20, detail: { food: '定食' } }),
        event({ ts: T0 + 4000, kind: 'quest', moneyDelta: 750, detail: { label: '送信', grade: 'crit_success' } }),
        event({ ts: T0 - 60_000, kind: 'fish', moneyDelta: 2400 }),
      ],
      limit: 10,
    });
    // ① 有"上次到访"时:只数那之后的事
    const away = summarizeAway({ entries, lastSeenAt: T0, now: T0 + 10 * 60_000 });
    assert.equal(away.fresh, true, '离开 10 分钟 → 算是"你不在的这段时间"');
    assert.deepEqual(away.items.map((row) => row.kind), ['quest', 'meal'], '只讲那之后发生的事(按分量排)');
    assert.ok(away.items.every((row) => row.ts > T0));
    // ② 没来过的(第一次打开)→ 不假装知道你不在多久
    const first = summarizeAway({ entries, lastSeenAt: null });
    assert.equal(first.fresh, false);
    assert.equal(first.items.length, 0, '第一次打开不弹"你不在的时候"');
    // ③ 离开太久(>24 小时)→ 不说这句(读起来像指责,而且没人真的离开一天)
    const stale = summarizeAway({ entries, lastSeenAt: T0, now: T0 + 25 * 60 * 60_000 });
    assert.equal(stale.fresh, false);
    // ④ 按分量挑:委托(10)排在吃(6)前面,最多 max 条
    const picked = pickAwayHighlights(entries, { since: T0, max: 1 });
    assert.equal(picked.length, 1);
    assert.equal(picked[0].kind, 'quest');
  });

  test('编年史(D154):**快照里带得出来、页面上画得出来** —— 日志区与"你不在"那块都在', () => {
    const config = { policy: { mood: { theme: 'demo' }, stats: { theme: 'demo' }, panel: { enabled: true, host: '127.0.0.1', port: 0, token: '' } }, qq: { appId: 'APP' } };
    const stats = { satiety: 60, health: 80, mood: 70, stamina: 70, mana: 90, money: 2_000 };
    const events = [
      { ts: T0 + 1000, kind: 'meal', satietyDelta: 20, healthDelta: 0, moodDelta: 4, staminaDelta: 10, manaDelta: 0, moneyDelta: -900, detail: { food: '定食' } },
      { ts: T0, kind: 'chat' },
    ];
    const snap = buildSnapshot({ config, stats, metas: [], events, now: T0 + 2000 });
    assert.ok(Array.isArray(snap.chronicle), '快照里要有 chronicle');
    assert.equal(snap.chronicle.length, 1, 'chat 那一笔不该进编年史');
    assert.equal(snap.chronicle[0].text, '吃了定食');
    // 不快照进事件时也要安全(空数组,而不是 undefined —— 页面要能直接遍历)
    assert.deepEqual(buildSnapshot({ config, stats, metas: [], now: T0 }).chronicle, []);

    // 页面:日志那块、底部那个 tab、"你不在"那块、以及把 chronicle 画出来的代码
    // ⚠️ 1.106.16 起日志**不再是独立分区**:它与"她 / 记录"并成「角色」那一栏(用户点名),
    //    所以这里查的是**它那块容器**在不在(客户端仍然往 `#app-log` 里画)。
    const html = expandedPage({});
    assert.ok(html.includes('id="app-log"') && html.includes('id="zone-role"'), '日志要在「角色」那一栏里');
    assert.ok(html.includes('data-zone="role"'), '窄屏要有「角色」那个 tab');
    assert.ok(html.includes('id="away"') && html.includes('away-close'), '"你不在的时候"那块要在页面上');
    assert.ok(html.includes('s.chronicle'), '页面要读快照里的 chronicle');
    assert.ok(html.includes('maybeShowAway(s)'), '渲染那一步要试着弹一次');
    assert.ok(html.includes("AWAY_LAST_SEEN"), '"上次到访"要存在本机(服务端不记这个)');
    // ⚠️ 弹窗那块必须是"可关闭"的(设计里明说:不强迫逐条点)
    assert.ok(html.includes("close.addEventListener('click', hide)"), '要能关掉');
    // ⚠️⚠️ **D 的三块新东西必须带上大票**(1.99.1 复核抓到):一开始它们是**裸 fetch** ——
    //    于是 D120 那两张"不绑域名"的票(x-panel-device / x-panel-player)对它们无效:
    //    隧道换一次网址、Cookie 一丢,`/api/state` 还认得出你,这三块却全 403。
    //    判据:页面里发往这三条路的请求**都要带 authHeaders(...)**。
    for (const route of ['/api/chat', '/api/player', '/api/bind']) {
      // ⚠️ 别用"到右括号为止"的正则:这些调用是多行的、里面还有嵌套括号;
      //    取"调用点往后一小段"就够了(带没带票就在那一小段里)。
      const marker = `fetch('${route}'`;
      const spots = [];
      for (let at = html.indexOf(marker); at !== -1; at = html.indexOf(marker, at + 1)) spots.push(at);
      assert.ok(spots.length >= 2, `${route} 应当有读与写两条请求(拿到 ${spots.length} 条)`);
      for (const at of spots) {
        const window = html.slice(at, at + 140);
        assert.ok(window.includes('authHeaders('), `${route} 的请求要带大票:${window.slice(0, 100)}`);
      }
    }
  });

  test('她自己的经历(D176/1.106.4):生病进编年史,而且"有特殊性"有一条可量的门槛', () => {
    // ① **生病 / 病好了**原来不在 `CHRONICLE_KINDS` 里 —— 面板与摘要都看不到(用户点名要记)
    assert.ok(CHRONICLE_KINDS.illness, '生病要进编年史');
    assert.ok(CHRONICLE_KINDS.heal, '病好了也要');
    const ill = describeChronicleEntry(event({ kind: 'illness', detail: { disease: '合成症甲' } }));
    assert.ok(ill, '生病那笔即使数值为 0 也要进(它是"她身上发生的一件事")');
    assert.equal(ill.text, '生病了（合成症甲）');
    const healed = describeChronicleEntry(event({ kind: 'heal', healthDelta: 40, detail: { disease: '合成症甲', ok: true } }));
    assert.equal(healed.text, '病好了');
    assert.equal(
      describeChronicleEntry(event({ kind: 'heal', detail: { disease: '合成症甲', ok: false } })).text,
      '合成治疗未完成',
      '没治好也是一件事,照记',
    );

    // ② **门槛**:≥ 8 的进摘要(委托/小事件收尾/生病/随机事件),≤ 6 的日常不进
    const entries = buildChronicle({
      events: [
        event({ ts: T0, kind: 'quest', moneyDelta: 12_000, detail: { label: '示例委托乙' } }),
        event({ ts: T0 - 1000, kind: 'illness', detail: { disease: '合成症甲' } }),
        event({ ts: T0 - 2000, kind: 'meal', satietyDelta: 20, moneyDelta: -900, detail: { food: '定食' } }),
        event({ ts: T0 - 3000, kind: 'selfcare', detail: { id: 'wand' } }),
        event({ ts: T0 - 4000, kind: 'sleep', staminaDelta: 30 }),
      ],
    });
    const picked = pickSpecialEntries(entries);
    assert.ok(picked.length >= 2, `委托 + 生病至少要挑出来(现在 ${picked.length})`);
    for (const row of picked) assert.ok(row.weight >= 8, `挑出来的必须是"有特殊性"的:${row.text}(${row.weight})`);
    assert.ok(!picked.some((row) => row.text.includes('定食')), '吃饭是日常,不许进摘要');
    assert.ok(!picked.some((row) => row.text.includes('她自己过日子')), '整理工具这类日常不许进摘要');

    // ③ 条数上限与时间窗
    const many = [
      event({ ts: T0, kind: 'quest', moneyDelta: 1, detail: { label: 'A' } }),
      event({ ts: T0 - 1, kind: 'story', moodDelta: 3 }),
      event({ ts: T0 - 2, kind: 'illness', detail: { disease: 'B' } }),
    ].map((row) => describeChronicleEntry(row));
    assert.equal(pickSpecialEntries(many, { max: 2 }).length, 2, '最多 2 条(暂定)');
    assert.equal(
      pickSpecialEntries(many, { since: T0 - 1, max: 5 }).length,
      1,
      '窗口是"之后发生的才算"(since 之后只剩一条)',
    );
    assert.deepEqual(pickSpecialEntries([], {}), [], '空输入给空数组');
    assert.deepEqual(pickSpecialEntries([{ kind: 'meal', weight: 6, ts: T0 }], {}), [], '全是日常 → 一条都不挑');

    // ④ 拼成"给摘要看"的那一行:有日期、有事实;空数组给空串(调用方不用判)
    const line = renderSpecialLine(pickSpecialEntries(entries));
    assert.ok(line.includes('委托') || line.includes('生病'), line);
    assert.equal(renderSpecialLine([]), '', '没有特殊事就不加那一段');
    assert.equal(renderSpecialLine(null), '');
  });

  test('她的日子(D176/1.106.4):合成日历经JSON装配,按北京时间判"今天"', () => {
    // 明确合成日期与来源；稳定主题键仅用于校验真实日历注册器，绝不读取私有日历。
    assert.deepEqual(daysFor('megumin').map((row) => [row.month, row.day, row.label]), [[1, 2, '合成纪念甲']]);
    assert.deepEqual(daysFor('aris').map((row) => [row.month, row.day, row.label]), [[7, 8, '合成纪念乙']]);
    assert.deepEqual(daysFor('不认识的主题'), [], '认不出 → 空数组(不猜)');

    const beijing = (iso) => Date.parse(iso);
    assert.equal(daysToday('megumin', { now: beijing('2026-01-02T02:00:00Z') }).length, 1, '北京时间1/2上午');
    assert.equal(daysToday('megumin', { now: beijing('2026-01-01T20:00:00Z') }).length, 1, '按北京时间算,不是UTC');
    assert.equal(daysToday('megumin', { now: beijing('2026-01-01T10:00:00Z') }).length, 0, '北京时间1/1傍晚还没到');
    assert.equal(daysToday('megumin', { now: beijing('2026-01-03T02:00:00Z') }).length, 0, '过了就不是了');
    assert.equal(daysToday('aris', { now: beijing('2026-07-08T02:00:00Z') }).length, 1);
    assert.equal(daysToday('aris', { now: beijing('2026-01-02T02:00:00Z') }).length, 0, '两组日历不许串');

    const line = renderDayLine(daysToday('megumin', { now: beijing('2026-01-02T02:00:00Z') }));
    assert.ok(line.includes('1月2日'), line);
    assert.ok(line.includes('合成日历甲'), `那一行要带出处:${line}`);
    assert.equal(line, '今天是她合成纪念甲（1月2日，出处：合成日历甲）');
    assert.equal(renderDayLine([]), '');
  });
}
