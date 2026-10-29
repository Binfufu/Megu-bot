/**
 * 出站 / 记忆入库的「模型协议标记泄漏」回归（2026-10-20 / 1.167.4 / D273）。
 *
 * 现场：2026-10-20 14:01:32，惠惠在群里发了 42 个字的一串乱码：
 *   `<｜｜DSML｜｜ calls="intake"></｜｜DSML｜｜ calls>`
 * 它是 deepseek-flash 的原生文本工具协议（DSML），模型在没声明 tools 的请求里
 * 偶尔把"想调用的工具"写进正文；桥里没人解析、也没人剥，分条器又按换行硬切，
 * 于是垃圾单独成一条发进群（数据库化石：state.db outbound #310 / memory.db turn seq 525）。
 *
 * 这份判据钉四件事：
 *   ① 剥除函数本身（成对 / 落单 / 半角 / 正常正文不误伤）；
 *   ② 两个消费端都接上（出站唯一咽喉的 `sanitizeOutgoingText`、记忆归档 `whatSheSaid`）；
 *   ③ **真跑一遍事发形状**：分条器切完之后只剩一句能发，第二条是空串（= 不会发）；
 *   ④ 清洗脚本的契约（默认 dry-run 不写、`--apply` 才写、只动命中的那行）。
 *
 * ⚠️ 写这份判据时踩到的坑：不能把颜文字 `(´･ω･`)` 写进模板字符串 —— 里面的反引号
 *    会当场把字符串断成两行（AGENTS 里"大模板反引号"同族）。所以下面一律单引号拼接。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hasLeakedControlMarkup, stripLeakedControlMarkup } from '../src/control-markup.js';
import { sanitizeOutgoingText } from '../src/qq.js';
import { whatSheSaid } from '../src/memory-archive.js';
import { normalizeSpokenForJudge, splitSpokenLines } from '../src/mood.js';

const LEAK = '<｜｜DSML｜｜ calls="intake"></｜｜DSML｜｜ calls>';
const KAOMOJI = '(´･ω･`)';
const REAL_LINE = '省省吧，一长串聊天记录截图，谁看得下去 ' + KAOMOJI;

export function registerOutboundMarkupTests({ test, assert }) {
  test('协议标记泄漏①:DSML 成对/落单/半角 token 都要剥，正常正文不许误伤', () => {
    // —— 事发原文的那一整行（含空行）——
    assert.equal(stripLeakedControlMarkup(REAL_LINE + '\n\n' + LEAK), REAL_LINE,
      '整对 DSML（开 + 空体 + 闭）要一次吃完，正文原样留下');
    assert.equal(stripLeakedControlMarkup(LEAK), '',
      '整条只有标记 → 空串（调用方按空串跳过这条，不许发一条空/乱码）');
    assert.equal(stripLeakedControlMarkup('好的' + LEAK), '好的',
      '夹在句尾的标记也要剥干净');
    assert.equal(stripLeakedControlMarkup('<｜｜DSML｜｜ calls="intake">'), '',
      '落单的开标记（流式被切断/只吐一半）也要剥');
    assert.equal(stripLeakedControlMarkup('</｜｜DSML｜｜ calls>'), '',
      '落单的闭标记也要剥');
    assert.equal(stripLeakedControlMarkup('前<|end▁of▁sentence|>后'), '前后',
      '半角竖线 + 整枚特殊 token（真实特殊 token 是竖线紧挨 `>` 那种）也要剥');

    // —— 不许误伤：这些形状在正常聊天里都合法 ——
    assert.equal(stripLeakedControlMarkup('A|B 与 <c> 和 ' + KAOMOJI), 'A|B 与 <c> 和 ' + KAOMOJI,
      '竖线分隔、普通尖括号、颜文字都不受影响');
    assert.equal(stripLeakedControlMarkup('<intake reject/>'), '<intake reject/>',
      '本项目自己的文本标记不归这一层剥（stats.js 的 extractIntake 负责），不许抢');
    assert.equal(stripLeakedControlMarkup('【状态】魔力：满 · 体力：正常'), '【状态】魔力：满 · 体力：正常',
      '状态栏照旧');
    assert.equal(stripLeakedControlMarkup(''), '', '空入空出');

    // 「有没有」与剥除必须是同一套形状（sendChunked 用它决定要不要记 warn）
    assert.equal(hasLeakedControlMarkup(REAL_LINE + '\n\n' + LEAK), true);
    assert.equal(hasLeakedControlMarkup(REAL_LINE), false);
    assert.equal(hasLeakedControlMarkup('<intake reject/>'), false);
  });

  test('协议标记泄漏②:出站唯一咽喉与记忆归档都要剥（两个消费端，一份实现）', () => {
    // 出站咽喉（sendChunked 里的 sanitizeOutgoingText）—— 名字前缀也照旧剥
    assert.equal(sanitizeOutgoingText(LEAK), '',
      '出站侧：整条只有标记 → 空串 → sendChunked 的「为空」分支跳过发送');
    assert.equal(sanitizeOutgoingText('【惠惠】' + REAL_LINE + '\n\n' + LEAK, { names: ['惠惠'] }), REAL_LINE,
      '出站侧：名字前缀 + 泄漏标记一起剥掉，正文原样');
    assert.ok(!sanitizeOutgoingText(REAL_LINE + '\n\n' + LEAK).includes('｜'),
      '出站文本里不许再出现全角竖线');

    // 记忆归档侧（whatSheSaid）—— 否则这行会被当成"她说的话"进摘要/检索
    assert.equal(whatSheSaid({ reply_text: '她说\n\n' + LEAK }, 200), '她说',
      '记忆归档：泄漏标记不许进 reply_text 的清洗结果');
    assert.equal(whatSheSaid({ reply_text: LEAK }, 200), '（没回）',
      '整条只有标记 = 等于没说话（不是把乱码当她说的话）');
    assert.equal(whatSheSaid({ reply_text: '没事<intake reject/>', silent: 0 }, 200), '没事',
      '记忆侧照旧剥 intake 标记（没被这层改坏）');
  });

  test('协议标记泄漏③:真跑事发形状 —— 分条 + 清洗之后只有一句能发（第二条是空串）', () => {
    // 事发轮：71 字 → 分条器切成 27 + 42（日志「71 字 → 27+42，每段上限 30」），
    // 42 字那条就是泄漏标记。这里按同一条链重建：分条 → 逐条清洗 → 只数非空的。
    const raw = REAL_LINE + '\n\n' + LEAK;
    const lines = splitSpokenLines(raw, { maxChars: 30, maxLines: 4 });
    assert.equal(lines.length, 2, '分条器仍按换行切两条（形状与事发当天一致）');

    const sendable = lines
      .map((line) => sanitizeOutgoingText(line, { names: [] }))
      .filter((line) => line !== '');
    assert.equal(sendable.length, 1, '剥完只剩一句能发 —— 第二条不会再变成乱码气泡');
    // ⚠️ D288(1.171.0):出站会做口语标点清理(段内 `，` 变空格)—— "她本来那句"按
    // 同一份判据归一后比对,不许在这里另写一份归一(D159)。
    assert.equal(normalizeSpokenForJudge(sendable[0]), normalizeSpokenForJudge(REAL_LINE),
      '留下的就是她本来那句(标点清理不算改话)');
    assert.ok(!sendable.some((line) => line.includes('DSML') || line.includes('｜')),
      '发出去的句子集合里不许有 DSML / 全角竖线');
  });

  test('协议标记泄漏④:清洗脚本默认 dry-run、--apply 才写，且只动命中的那一行', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsml-clean-'));
    const file = path.join(dir, 'memory.db');
    const dirty = '她说\n\n' + LEAK;
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE turn (session_id TEXT, seq INTEGER, at INTEGER, reply_text TEXT, reply_chars INTEGER)');
      const insert = db.prepare('INSERT INTO turn VALUES (?,?,?,?,?)');
      insert.run('own:x', 7, Date.now(), dirty, dirty.length);
      insert.run('own:x', 8, Date.now(), '正常的一句', 5);
    } finally {
      db.close();
    }
    const script = fileURLToPath(new URL('./clean-dsml-leak.js', import.meta.url));

    // ① 默认 dry-run：不许写盘
    const dry = spawnSync(process.execPath, [script, '--db', file], { encoding: 'utf8' });
    assert.equal(dry.status, 0, `dry-run 应退出 0:${dry.stderr}`);
    assert.ok(dry.stdout.includes('加 --apply'), 'dry-run 要告诉人"还没写"');
    let check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(check.prepare('SELECT reply_text FROM turn WHERE seq=7').get().reply_text, dirty,
        'dry-run 不许改库');
    } finally { check.close(); }

    // ② --apply 真写：命中行洗干净，未命中的行一字不动
    const applied = spawnSync(process.execPath, [script, '--db', file, '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, `--apply 应退出 0:${applied.stderr}`);
    check = new DatabaseSync(file, { readOnly: true });
    try {
      const row = check.prepare('SELECT reply_text, reply_chars FROM turn WHERE seq=7').get();
      assert.equal(row.reply_text, '她说', '命中行要洗成原来的正文');
      assert.equal(row.reply_chars, 2, 'reply_chars 要跟着新正文更新');
      assert.equal(check.prepare('SELECT reply_text FROM turn WHERE seq=8').get().reply_text, '正常的一句',
        '没命中的行不许动');
    } finally { check.close(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
