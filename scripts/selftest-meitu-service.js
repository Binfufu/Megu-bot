/**
 * 「发N张<角色>美图」服务层的判据(2026-10-23 / 代码层发图;被拦降档同日补)。
 *
 * 跑法:
 *
 *     node scripts\selftest-meitu-service.js
 *
 * 全部用**假依赖**:假 runFetch(不 spawn、不联网)、假 uploadFile/sendMedia(不碰真 QQ)、
 * 临时目录(不写真 D 盘)。钉:
 *   ① 群白名单(空名单/不在名单都拒绝,且不抓图);
 *   ② 冷却(按群;开始就记时间);
 *   ③ 别名未登记;
 *   ④ runFetch no_result / source_down 的固定回话(回话 ∈ 句库成员,非写死单串);
 *   ⑤ 成功发送 2 张:上传→发送的顺序、参数形状、fileType;
 *   ⑥ 上传失败只回"图下好了但发不出去"(句库成员);
 *   ⑦ 按群串行(两条同群指令不会同时抓图);
 *   ⑧ **被拦降档**(40034006/「消息内容违规」):再抓一次 general 档补发 + 委屈道歉句;
 *      降档没图 → blocked_empty;非 blocked 的上传错误 → 不降档、行为不变。
 *   ⑨ **失败兜底与结算**(2026-10-27):runFetch 抛异常也必须 internal 收场 + 记需求池,
 *      绝不 reject(P1);部分发送成功 + 降档落空 → 已发数不丢、占冷却、回委屈道歉;
 *      补发数量 = 剩余差额(不超发);download_failed 有独立回话。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMeituCommand, describeMeituTask, MEITU_REPLIES } from '../src/meitu-service.js';
import { createActionLog } from '../src/action-log.js';
import { normalizeDispatch } from '../src/qq.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { parseMeituCommand } from '../src/meitu-command.js';
import { createMeituInterpreter } from '../src/meitu-interpret.js';
import { createLlmClient } from '../src/llm.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

/** 每条用例一个临时根目录,结束就删。 */
async function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'qqbot-meitu-service-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一张"图"(内容不重要 —— 服务层不校验文件头,那是抓取器的活)。 */
function makeImageFile(dir, name = 'a.png') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  return file;
}

const PARSED = {
  ok: true,
  count: 1,
  character: '合成角色甲',
  tags: ['feet'],
  ratingWanted: true,
  tier: 'seitu',
  random: false,
  ignored: [],
};

/**
 * 假依赖工厂。`files` 是 runFetch 要返回的落盘路径列表。
 */
function makeDeps({
  dir,
  files = [],
  groups = ['g1'],
  cooldownMs = 0,
  proxy = '',
  now = () => Date.now(),
  runFetch,
  uploadFile,
  sendMedia,
  reply,
} = {}) {
  const calls = { fetch: [], upload: [], send: [], reply: [] };
  const aliasFile = path.join(dir, 'meitu-alias.json');
  if (!fs.existsSync(aliasFile)) fs.writeFileSync(aliasFile, JSON.stringify({ 合成角色甲: 'fixture_character_a' }));
  const deps = {
    config: {
      meitu: {
        enabled: true,
        groups,
        max: 5,
        cooldownMs,
        source: 'auto',
        root: dir,
        alias: path.join(dir, 'meitu-alias.json'),
        lines: path.join(dir, 'meitu-lines.json'),
        missLog: path.join(dir, 'meitu-miss.jsonl'),
        maxBytes: 10_485_760,
        timeoutMs: 90_000,
        proxy,
      },
    },
    log: SILENT_LOG,
    now,
    runFetch: runFetch ?? (async (input) => {
      calls.fetch.push(input);
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          files: files.map((file, index) => ({
            path: file,
            source: 'danbooru',
            id: 1000 + index,
            rating: 'questionable',
            url: `https://example.invalid/${index}.jpg`,
          })),
          rungs: [],
        }),
        stderr: '',
      };
    }),
    uploadFile: uploadFile ?? (async (args) => {
      calls.upload.push(args);
      return `file_info_${calls.upload.length}`;
    }),
    sendMedia: sendMedia ?? (async (args) => {
      calls.send.push(args);
      return { id: calls.send.length };
    }),
    reply: reply ?? (async (text) => {
      calls.reply.push(text);
    }),
  };
  return { deps, calls };
}

const message = (targetId, extra = {}) => ({ scene: 'group', targetId, isMention: true, content: 'x', ...extra });

/** 回话 ∈ 句库该 key 的成员(句库支持覆盖,判据钉成员关系,不钉死单串)。 */
const assertReplyIn = (calls, key) => {
  assert.equal(calls.reply.length, 1, `应该恰好回一句(实际 ${calls.reply.length} 句)`);
  const variants = MEITU_REPLIES[key];
  assert.ok(Array.isArray(variants) && variants.includes(calls.reply[0]),
    `回话要在 ${key} 的变体里:${JSON.stringify(calls.reply[0])}`);
};

// ---------------------------------------------------------------------------
// ① 群白名单
// ---------------------------------------------------------------------------

test('meitu-service:群不在白名单 → 固定回话,一次都不抓', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, groups: ['g1'] });
    const result = await handleMeituCommand({ message: message('g-other'), parsed: PARSED, deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'group_disabled');
    assertReplyIn(calls, 'groupDisabled');
    assert.equal(calls.fetch.length, 0);
  });
});

test('meitu-service:白名单为空 = 谁都不给(fail closed)', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, groups: [] });
    const result = await handleMeituCommand({ message: message('g1'), parsed: PARSED, deps });
    assert.equal(result.reason, 'group_disabled');
    assert.equal(calls.fetch.length, 0);
  });
});

// ---------------------------------------------------------------------------
// ② 冷却
// ---------------------------------------------------------------------------

test('meitu-service:同群冷却 —— 第二条只回"刚发过",不再抓图', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    let clock = 1000;
    const { deps, calls } = makeDeps({
      dir,
      files: [file],
      groups: ['g-cool'],
      cooldownMs: 30_000,
      now: () => clock,
    });
    const first = await handleMeituCommand({ message: message('g-cool'), parsed: PARSED, deps });
    assert.equal(first.ok, true);
    assert.equal(calls.fetch.length, 1);

    clock = 5000; // 只过了 4 秒,远不到 30 秒
    const second = await handleMeituCommand({ message: message('g-cool'), parsed: PARSED, deps });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'cooldown');
    assertReplyIn(calls, 'cooldown');
    assert.equal(calls.fetch.length, 1, '冷却中的那条不许再抓图');
  });
});

// ---------------------------------------------------------------------------
// ③ 别名
// ---------------------------------------------------------------------------

test('meitu-service:角色没登记别名 → 固定回话,不抓图', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, groups: ['g-alias'] });
    const result = await handleMeituCommand({
      message: message('g-alias'),
      parsed: { ...PARSED, character: '合成名甲' },
      deps,
    });
    assert.equal(result.reason, 'unregistered');
    assertReplyIn(calls, 'unregistered');
    assert.equal(calls.fetch.length, 0);
  });
});

// ---------------------------------------------------------------------------
// ④ 抓取失败
// ---------------------------------------------------------------------------

test('meitu-service:runFetch 报 no_result → 固定回话', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-noresult'],
      runFetch: async () => ({
        code: 0,
        stdout: JSON.stringify({ ok: false, reason: 'no_result', detail: '一张没有', rungs: [] }),
        stderr: '',
      }),
    });
    const result = await handleMeituCommand({ message: message('g-noresult'), parsed: PARSED, deps });
    assert.equal(result.reason, 'no_result');
    assertReplyIn(calls, 'noResult');
  });
});

test('meitu-service:runFetch 报 source_down → "图源连不上"', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-down'],
      runFetch: async () => ({
        code: 0,
        stdout: JSON.stringify({ ok: false, reason: 'source_down', detail: '连不上', rungs: [] }),
        stderr: '',
      }),
    });
    const result = await handleMeituCommand({ message: message('g-down'), parsed: PARSED, deps });
    assert.equal(result.reason, 'source_down');
    assertReplyIn(calls, 'sourceDown');
  });
});

// ---------------------------------------------------------------------------
// ⑤ 成功发送
// ---------------------------------------------------------------------------

test('meitu-service:成功发送 2 张 —— 顺序上传/发送、参数形状对', async () => {
  await withTemp(async (dir) => {
    const files = [makeImageFile(dir, 'one.png'), makeImageFile(dir, 'two.png')];
    const { deps, calls } = makeDeps({
      dir,
      files,
      groups: ['g-ok'],
      proxy: 'http://127.0.0.1:7890',
    });
    const result = await handleMeituCommand({ message: message('g-ok'), parsed: PARSED, deps });
    assert.deepEqual({ ok: result.ok, sent: result.sent, failed: result.failed }, { ok: true, sent: 2, failed: 0 });

    assert.equal(calls.upload.length, 2);
    assert.equal(calls.send.length, 2);
    assert.deepEqual(calls.reply, [], '成功后不追加固定回话');

    for (const upload of calls.upload) {
      assert.equal(upload.scene, 'group');
      assert.equal(upload.openid, 'g-ok');
      assert.equal(upload.fileType, 1);
      assert.ok(Buffer.isBuffer(upload.buffer) && upload.buffer.length > 0, '要读真文件成 buffer');
      assert.ok(['one.png', 'two.png'].includes(upload.fileName));
    }
    assert.equal(calls.send[0].scene, 'group');
    assert.equal(calls.send[0].openid, 'g-ok');
    assert.equal(calls.send[0].fileInfo, 'file_info_1');
    assert.equal(calls.send[1].fileInfo, 'file_info_2');
    assert.equal(calls.send[0].msgId, undefined, '主动消息不传 msgId');

    // spawn 参数:别名翻好的 tag、修饰、数量、目录、图源、代理注入。
    assert.equal(calls.fetch.length, 1);
    const { args, env } = calls.fetch[0];
    const at = (name) => args[args.indexOf(name) + 1];
    assert.equal(at('--char'), 'fixture_character_a');
    assert.equal(at('--tags'), 'feet');
    assert.equal(at('--count'), '1');
    assert.equal(at('--source'), 'auto');
    assert.equal(at('--max-bytes'), '10485760');
    // 1.184.3:涩图档落 `<根>\r18\<角色>`(PARSED.tier='seitu');美图档同理落 r13。
    assert.ok(at('--out').endsWith(path.join('r18', '合成角色甲')), `涩图档该落 r18:${at('--out')}`);
    assert.ok(fs.existsSync(at('--out')), '目录要真的建出来(在临时根目录下)');
    // 历史目录两个(旧结构存量 + 另一档同角色)—— 索引重建时并入它们的 md5。
    const extraDirs = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--extra-dir') extraDirs.push(args[i + 1]);
    }
    assert.deepEqual(extraDirs, [
      path.join(dir, '合成角色甲'),
      path.join(dir, 'r13', '合成角色甲'),
    ], '旧结构 + 另一档同角色都要作为历史目录传下去');
    assert.equal(at('--proxy'), 'http://127.0.0.1:7890');
    assert.equal(env.NODE_USE_ENV_PROXY, '1');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
  });
});

// ---------------------------------------------------------------------------
// ⑥ 上传失败
// ---------------------------------------------------------------------------

test('meitu-service:非 blocked 的上传失败 → 只回"图下好了但发不出去",不降档', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    let fetches = 0;
    const { deps, calls } = makeDeps({
      dir,
      files: [file],
      groups: ['g-uploadfail'],
      runFetch: async (input) => {
        fetches += 1;
        calls.fetch.push(input);
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            files: [{ path: file, source: 'danbooru', id: 1000, rating: 'questionable', url: 'u' }],
            rungs: [],
          }),
          stderr: '',
        };
      },
      uploadFile: async () => { throw new Error('平台拒了'); },
    });
    const result = await handleMeituCommand({ message: message('g-uploadfail'), parsed: PARSED, deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'upload_failed');
    assertReplyIn(calls, 'uploadFailed');
    assert.equal(calls.send.length, 0);
    assert.equal(fetches, 1, '普通上传错误不是被拦,不许触发降档');
  });
});

// ---------------------------------------------------------------------------
// ⑦ 按群串行
// ---------------------------------------------------------------------------

test('meitu-service:同群两条指令串行(第二条等第一条抓完)', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    let active = 0;
    let maxActive = 0;
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-queue'],
      cooldownMs: 0,
      runFetch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            files: [{ path: file, source: 'danbooru', id: 1, rating: 'questionable', url: 'u' }],
            rungs: [],
          }),
          stderr: '',
        };
      },
    });
    const [first, second] = await Promise.all([
      handleMeituCommand({ message: message('g-queue'), parsed: PARSED, deps }),
      handleMeituCommand({ message: message('g-queue'), parsed: PARSED, deps }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(maxActive, 1, '两条同群指令不许同时抓图');
    assert.equal(calls.upload.length, 2);
    assert.equal(calls.send.length, 2);
  });
});

// ---------------------------------------------------------------------------
// ⑧ 被内容审核拦 → 降档一次补 general 档
// ---------------------------------------------------------------------------

const BLOCKED_ERROR = new Error('发送失败: HTTP 400 code=40034006 消息内容违规');

test('meitu-service:被拦 → 降档补发 general 档成功 → 委屈道歉句,本批剩余不再发', async () => {
  await withTemp(async (dir) => {
    const fileA1 = makeImageFile(dir, 'a1.png'); // 擦边第一张:发送被拦
    const fileA2 = makeImageFile(dir, 'a2.png'); // 擦边第二张:被拦后不许再试
    const fileB1 = makeImageFile(dir, 'b1.png'); // 降档抓回来的普通图
    const fetches = [];
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-blocked'],
      proxy: 'http://127.0.0.1:7890',
      runFetch: async (input) => {
        fetches.push(input);
        const files = fetches.length === 1
          ? [
            { path: fileA1, source: 'danbooru', id: 1, rating: 'questionable', url: 'u1' },
            { path: fileA2, source: 'danbooru', id: 2, rating: 'questionable', url: 'u2' },
          ]
          : [{ path: fileB1, source: 'danbooru', id: 3, rating: 'general', url: 'u3' }];
        return { code: 0, stdout: JSON.stringify({ ok: true, files, rungs: [] }), stderr: '' };
      },
      uploadFile: async (args) => {
        calls.upload.push(args);
        if (args.fileName === 'a1.png') throw BLOCKED_ERROR;
        return `file_info_${calls.upload.length}`;
      },
    });
    const result = await handleMeituCommand({ message: message('g-blocked'), parsed: PARSED, deps });

    // 降档:第二次 runFetch = 第一次参数整体重放,--count 换成剩余差额(2 张请求、
    // 已发 0 张 → 补 1),再追加 --rating-allow general。
    assert.equal(fetches.length, 2, '被拦要再抓一次 general 档');
    assert.deepEqual(
      fetches[1].args,
      [...fetches[0].args, '--count', '1', '--rating-allow', 'general'],
      '降档参数 = 原参数 + 剩余差额 count + rating-allow',
    );
    assert.equal(fetches[1].env.NODE_USE_ENV_PROXY, '1', '降档抓取沿用同一份代理环境');
    assert.equal(fetches[1].env.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(fetches[1].args[fetches[1].args.indexOf('--proxy') + 1], 'http://127.0.0.1:7890');

    // 被拦后本批剩余(a2.png)不再发;只补发了普通图 b1.png。
    assert.deepEqual(
      calls.upload.map((u) => u.fileName),
      ['a1.png', 'b1.png'],
    );
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].fileInfo, 'file_info_2');

    // 道歉小句 ∈ blocked_apology 变体。
    assertReplyIn(calls, 'blocked_apology');

    assert.deepEqual(
      { ok: result.ok, reason: result.reason, sent: result.sent, failed: result.failed },
      { ok: true, reason: 'ok', sent: 1, failed: 1 },
    );
  });
});

test('meitu-service:被拦 + 降档没抓到图 → blocked_empty 道歉,只重试一次', async () => {
  await withTemp(async (dir) => {
    const fileA = makeImageFile(dir, 'a.png');
    const fetches = [];
    const { deps, calls } = makeDeps({
      dir,
      files: [fileA],
      groups: ['g-blocked-empty'],
      runFetch: async (input) => {
        fetches.push(input);
        if (fetches.length === 1) {
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              files: [{ path: fileA, source: 'danbooru', id: 1, rating: 'questionable', url: 'u' }],
              rungs: [],
            }),
            stderr: '',
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ ok: false, reason: 'no_result', detail: '一张没有', rungs: [] }),
          stderr: '',
        };
      },
      uploadFile: async (args) => {
        calls.upload.push(args);
        throw BLOCKED_ERROR;
      },
    });
    const result = await handleMeituCommand({ message: message('g-blocked-empty'), parsed: PARSED, deps });

    assert.equal(fetches.length, 2, '降档只试一次');
    assert.deepEqual(fetches[1].args.slice(-2), ['--rating-allow', 'general']);
    assert.equal(calls.upload.length, 1, '降档没图就不会有第二次上传');
    assertReplyIn(calls, 'blocked_empty');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'blocked');
  });
});

test('meitu-service:被拦 + 降档抓到了但发送也被拦 → 不循环,回 blocked_empty', async () => {
  await withTemp(async (dir) => {
    const fileA = makeImageFile(dir, 'a.png');
    const fileB = makeImageFile(dir, 'b.png');
    let fetches = 0;
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-blocked-loop'],
      runFetch: async (input) => {
        fetches += 1;
        calls.fetch.push(input);
        const file = fetches === 1 ? fileA : fileB;
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            files: [{ path: file, source: 'danbooru', id: fetches, rating: fetches === 1 ? 'questionable' : 'general', url: 'u' }],
            rungs: [],
          }),
          stderr: '',
        };
      },
      uploadFile: async (args) => {
        calls.upload.push(args);
        throw BLOCKED_ERROR; // 普通档也被拦(极端现场):回道歉句,不许第三次抓取
      },
    });
    const result = await handleMeituCommand({ message: message('g-blocked-loop'), parsed: PARSED, deps });

    assert.equal(fetches, 2, '只重试一次,不许死循环');
    assertReplyIn(calls, 'blocked_empty');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'blocked');
  });
});

// ---------------------------------------------------------------------------
// ⑨ 被动回复(1.181.0,修 40034105):图片带 msg_id+msg_seq,与文本回话共用序列
// ---------------------------------------------------------------------------

test('meitu-service:带 messageId 的消息 → 图片走被动回复(msgId+msgSeq 1..N)', async () => {
  await withTemp(async (dir) => {
    const files = [makeImageFile(dir, 'one.png'), makeImageFile(dir, 'two.png')];
    const { deps, calls } = makeDeps({ dir, files, groups: ['g-passive'] });
    const result = await handleMeituCommand({
      message: message('g-passive', { messageId: 'M100' }),
      parsed: PARSED,
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.send.length, 2);
    assert.equal(calls.send[0].msgId, 'M100');
    assert.equal(calls.send[0].msgSeq, 1);
    assert.equal(calls.send[1].msgId, 'M100');
    assert.equal(calls.send[1].msgSeq, 2);
  });
});

test('meitu-service:回话与图片共用被动序列 —— 文本占的槽位,图片接着数', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const replyCalls = [];
    const { deps, calls } = makeDeps({
      dir,
      files: [file],
      groups: ['g-seq'],
      // 被拦:第一张图发送被拒 → 降档补一张 → 道歉句的 startSeq 要接着图片的 seq。
      runFetch: async (input) => {
        calls.fetch.push(input);
        const list = calls.fetch.length === 1
          ? [{ path: file, source: 'danbooru', id: 1, rating: 'questionable', url: 'u' }]
          : [{ path: file, source: 'danbooru', id: 2, rating: 'general', url: 'u2' }];
        return { code: 0, stdout: JSON.stringify({ ok: true, files: list, rungs: [] }), stderr: '' };
      },
      uploadFile: async (args) => {
        calls.upload.push(args);
        if (calls.upload.length === 1) throw BLOCKED_ERROR;
        return `file_info_${calls.upload.length}`;
      },
      reply: async (text, opts) => {
        replyCalls.push({ text, opts });
        return 1;
      },
    });
    const result = await handleMeituCommand({
      message: message('g-seq', { messageId: 'M200' }),
      parsed: PARSED,
      deps,
    });
    assert.equal(result.ok, true, `降档补发成功才算过(result=${JSON.stringify(result)})`);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].msgSeq, 1, '第一张图(被拦那张)占了 seq=1');
    // 道歉句:图片用了 seq=1,文本从 startSeq=1 接着数(下一条=seq 2)。
    assert.equal(replyCalls.length, 1);
    assert.deepEqual(replyCalls[0].opts, { startSeq: 1, active: false });
  });
});

// ---------------------------------------------------------------------------
// ⑩ 冷却只记成功(1.181.0):失败不占冷却,失败者立刻再要是合法的
// ---------------------------------------------------------------------------

test('meitu-service:失败(没登记别名)不占冷却 —— 立刻再要一条正常的,不许回「刚发过」', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    let clock = 1000;
    const { deps, calls } = makeDeps({
      dir,
      files: [file],
      groups: ['g-fail-cool'],
      cooldownMs: 30_000,
      now: () => clock,
    });
    // 第一次:合成名乙没登记(2026-10-23 现场:11:21:48)。
    const first = await handleMeituCommand({
      message: message('g-fail-cool'),
      parsed: { ...PARSED, character: '合成名乙' },
      deps,
    });
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'unregistered');

    // 10 秒后换登记过的角色再来:不许被冷却拦住(现场 11:21:58 回了「冷却中还要 20s」)。
    clock += 10_000;
    const second = await handleMeituCommand({ message: message('g-fail-cool'), parsed: PARSED, deps });
    assert.equal(second.ok, true, `失败不占冷却,第二次要正常发图(实际 ${JSON.stringify(second)})`);
    assert.equal(calls.fetch.length, 1, '只有第二次真的抓了图');
  });
});

test('meitu-service:被拦且降档也没补上(blocked_empty)同样不占冷却', async () => {
  await withTemp(async (dir) => {
    const fileA = makeImageFile(dir, 'a.png');
    let clock = 1000;
    let fetches = 0;
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-blocked-cool'],
      cooldownMs: 30_000,
      now: () => clock,
      runFetch: async (input) => {
        fetches += 1;
        calls.fetch.push(input);
        if (fetches === 1) {
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              files: [{ path: fileA, source: 'danbooru', id: 1, rating: 'questionable', url: 'u' }],
              rungs: [],
            }),
            stderr: '',
          };
        }
        return { code: 0, stdout: JSON.stringify({ ok: false, reason: 'no_result', detail: 'x', rungs: [] }), stderr: '' };
      },
      uploadFile: async () => { throw BLOCKED_ERROR; },
    });
    const first = await handleMeituCommand({ message: message('g-blocked-cool'), parsed: PARSED, deps });
    assert.equal(first.reason, 'blocked');
    clock += 5_000;
    const second = await handleMeituCommand({ message: message('g-blocked-cool'), parsed: PARSED, deps });
    assert.notEqual(second.reason, 'cooldown', '一次图都没发出去的失败,不许占冷却');
  });
});

// ---------------------------------------------------------------------------
// ⑪ 残缺指令的随机角色 + 检索档位传参
// ---------------------------------------------------------------------------

test('meitu-service:random 模式从别名表随机挑角色(--char ∈ 表值)', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-random'] });
    fs.writeFileSync(
      path.join(dir, 'meitu-alias.json'),
      JSON.stringify({ 合成名乙: 'fixture_name_b_(fixture_work_b)', 合成名丙: 'fixture_name_c_(fixture_work_b)' }),
      'utf8',
    );
    const result = await handleMeituCommand({
      message: message('g-random'),
      parsed: { ...PARSED, character: '', random: true },
      deps,
    });
    assert.equal(result.ok, true);
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    const char = at('--char');
    assert.ok(
      ['fixture_name_b_(fixture_work_b)', 'fixture_name_c_(fixture_work_b)'].includes(char),
      `随机角色要从别名表里挑(实际 ${char})`,
    );
    assert.ok(at('--out').endsWith('合成名乙') || at('--out').endsWith('合成名丙'), '落盘目录用挑中的中文名');
  });
});

test('meitu-service:随机角色 + 修饰 —— --tags 照传,落盘目录仍用挑中的中文名(不是「随机」)', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-random-tags'] });
    fs.writeFileSync(
      path.join(dir, 'meitu-alias.json'),
      JSON.stringify({ 合成名乙: 'fixture_name_b_(fixture_work_b)', 合成名丙: 'fixture_name_c_(fixture_work_b)' }),
      'utf8',
    );
    const result = await handleMeituCommand({
      message: message('g-random-tags'),
      // 解析器对「来3张随机白丝双马尾美图」的真实输出形状(1.184.0)。
      parsed: { ...PARSED, character: '', random: true, tags: ['thighhighs', 'twintails'], tier: 'meitu' },
      deps,
    });
    assert.equal(result.ok, true);
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    assert.equal(at('--tags'), 'thighhighs,twintails', '随机不影响修饰传参');
    assert.equal(at('--tier'), 'meitu');
    assert.ok(
      ['fixture_name_b_(fixture_work_b)', 'fixture_name_c_(fixture_work_b)'].includes(at('--char')),
      '随机角色要从别名表挑 tag',
    );
    // 主人的口径:随机也**按角色名记库分类** —— 目录必须是被挑中那个角色的中文名。
    assert.ok(at('--out').endsWith('合成名乙') || at('--out').endsWith('合成名丙'), `落盘目录不对:${at('--out')}`);
    assert.ok(!at('--out').includes('随机'), '不许出现「随机」目录');
  });
});

// ---------------------------------------------------------------------------
// ⑪' 类目词回落(1.197.0,主人 2026-10-25 报「来点萝莉图」「来张随机萝莉图」不能识别)
// ---------------------------------------------------------------------------

test('meitu-service:类目词(「萝莉」)没登记 → 按类目随机挑角色,不回「未登记」', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-category'] });
    fs.writeFileSync(
      path.join(dir, 'meitu-alias.json'),
      JSON.stringify({ 合成名乙: 'fixture_name_b_(fixture_work_b)', 合成名丙: 'fixture_name_c_(fixture_work_b)' }),
      'utf8',
    );
    // 「来张随机萝莉图」解析层的真实输出形状:character='萝莉'、random=false 进服务层。
    const result = await handleMeituCommand({
      message: message('g-category'),
      parsed: { ...PARSED, character: '萝莉', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.ok, true, '类目词要落随机机制,不是失败');
    assert.equal(calls.fetch.length, 1, '要真去抓图');
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    const char = at('--char');
    assert.ok(
      ['fixture_name_b_(fixture_work_b)', 'fixture_name_c_(fixture_work_b)'].includes(char),
      `类目词要从别名表挑真角色(实际 ${char})`,
    );
    assert.ok(!at('--out').includes('萝莉'), '落盘目录不许是「萝莉」—— 按挑中的角色名分库');
  });
});

test('meitu-service:类目词在别名表登记过 → 具名优先,不进随机', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-category-named'] });
    fs.writeFileSync(
      path.join(dir, 'meitu-alias.json'),
      JSON.stringify({ 萝莉: 'loli_registered_by_hand', 合成名乙: 'fixture_name_b_(fixture_work_b)' }),
      'utf8',
    );
    await handleMeituCommand({
      message: message('g-category-named'),
      parsed: { ...PARSED, character: '萝莉', tags: [], tier: 'meitu' },
      deps,
    });
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    assert.equal(at('--char'), 'loli_registered_by_hand', '登记过的具名永远赢(别名表优先于类目词表)');
  });
});

test('meitu-service:类目词 + 别名表为空 → 回「未登记」话术,不抓图', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, groups: ['g-category-empty'] });
    // 不写别名文件 → loadMeituAliases 回**内置默认表**;默认表里有的角色不算空。
    // 真空表只能靠 alias 指向一个空 JSON 文件。
    fs.writeFileSync(path.join(dir, 'meitu-alias.json'), JSON.stringify({}), 'utf8');
    const result = await handleMeituCommand({
      message: message('g-category-empty'),
      parsed: { ...PARSED, character: '萝莉', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.reason, 'unregistered');
    assertReplyIn(calls, 'unregistered');
    assert.equal(calls.fetch.length, 0, '没角色可挑就不许抓图');
  });
});

test('meitu-service:R1 ASCII 类目词(NTR)同样按类目随机挑角色', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-category-ntr'] });
    fs.writeFileSync(
      path.join(dir, 'meitu-alias.json'),
      JSON.stringify({ 合成名乙: 'fixture_name_b_(fixture_work_b)', 合成名丙: 'fixture_name_c_(fixture_work_b)' }),
      'utf8',
    );
    const result = await handleMeituCommand({
      message: message('g-category-ntr'),
      parsed: { ...PARSED, character: 'NTR', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.ok, true);
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    assert.ok(
      ['fixture_name_b_(fixture_work_b)', 'fixture_name_c_(fixture_work_b)'].includes(at('--char')),
      `ASCII 类目词也要随机挑真角色(实际 ${at('--char')})`,
    );
  });
});

// ---------------------------------------------------------------------------
// ⑬ 失败请求记入本地(1.198.0 / 需求清单 R1,主人拍板)
// ---------------------------------------------------------------------------

test('meitu-service:R1 失败请求落一行 JSONL —— 时间/群/原文/解析/原因齐全', async () => {
  await withTemp(async (dir) => {
    const { deps } = makeDeps({ dir, groups: ['g-miss'] });
    const result = await handleMeituCommand({
      message: message('g-miss'),
      parsed: { ...PARSED, character: '合成名甲', tags: ['feet'], tier: 'seitu' },
      deps,
    });
    assert.equal(result.reason, 'unregistered');
    const missPath = path.join(dir, 'meitu-miss.jsonl');
    assert.ok(fs.existsSync(missPath), '失败请求必须落盘');
    const rows = fs.readFileSync(missPath, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1, '一次失败一行');
    assert.equal(rows[0].reason, 'unregistered');
    assert.equal(rows[0].character, '合成名甲');
    assert.equal(rows[0].group, 'g-miss');
    assert.deepEqual(rows[0].tags, ['feet']);
    assert.equal(rows[0].tier, 'seitu');
    assert.equal(typeof rows[0].at, 'string');
    assert.ok(typeof rows[0].text === 'string');
  });
});

test('meitu-service:R1 成功发送一条都不记', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps } = makeDeps({ dir, files: [file], groups: ['g-miss-ok'] });
    fs.writeFileSync(path.join(dir, 'meitu-alias.json'), JSON.stringify({ 合成名乙: 'fixture_name_b_(fixture_work_b)' }), 'utf8');
    const result = await handleMeituCommand({
      message: message('g-miss-ok'),
      parsed: { ...PARSED, character: '合成名乙', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(dir, 'meitu-miss.jsonl')), false, '成功请求不许进失败清单');
  });
});

test('meitu-service:R1 记录失败不拖垮主流程(坏路径照常回话)', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, groups: ['g-miss-bad'] });
    deps.config.meitu.missLog = path.join(dir, 'no', 'such', 'dir', 'miss.jsonl');
    const result = await handleMeituCommand({
      message: message('g-miss-bad'),
      parsed: { ...PARSED, character: '合成名甲', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.reason, 'unregistered');
    assertReplyIn(calls, 'unregistered');
  });
});

test('meitu-service:R3 判据(源码扫描) —— sendChunked 成功路径必须打「出站：已发」留痕', () => {
  // sendChunked 是 index.js 闭包内的函数,单测打不进去(selftest-interaction 同款处境)。
  // 判据 = 源码扫描:留痕行必须在 recordOutbound(库层留痕)之后,且是**真代码形状**
  // (模板字面+变量插值) —— 注释里写不出这个形状(1.150.92「判据被注释喂饱」的教训)。
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js'),
    'utf8',
  );
  const marker = /log\.info\(`出站：已发 \$\{chunks\.length\} 条（\$\{cleaned\.length\} 字，\$\{lastKind\}）/;
  assert.ok(marker.test(source), 'sendChunked 的「出站：已发」留痕丢了(R3)');
  const atMarker = source.search(marker);
  const atRecord = source.indexOf('stateStore.recordOutbound({');
  assert.ok(atRecord !== -1 && atMarker > atRecord, '留痕必须在 recordOutbound 之后 —— 咽喉顺序别乱');
});

test('meitu-service:NO_PROXY 判据(源码扫描) —— 代理注入必须带 Safebooru 直连豁免', () => {
  // 现场实证(2026-10-25,白云机):代理进程死了之后合成助手群聊报「图源连不上」——
  // NODE_USE_ENV_PROXY 是进程级,Safebooru 兜底被拖去撞死代理,两源全挂 → source_down。
  // 修复 = 注入代理 env 的同一块里写 NO_PROXY=safebooru.org(兜底源永远直连)。
  // 判据 = 源码扫描:真代码形状(注释里写不出这个形状 —— 1.150.92「判据被注释喂饱」教训),
  // 且必须排在 HTTPS_PROXY 注入之后(同一个 if 块,别被人挪出去)。
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'meitu-service.js'),
    'utf8',
  );
  const marker = /env\.NO_PROXY = 'safebooru\.org';/;
  assert.ok(marker.test(source), '代理注入少了 NO_PROXY=safebooru.org —— 死代理会拖死兜底源');
  const atNoProxy = source.search(marker);
  const atInject = source.indexOf('env.HTTPS_PROXY = String(meitu.proxy);');
  assert.ok(atInject !== -1 && atNoProxy > atInject, 'NO_PROXY 必须与代理 env 注入在同一块里');
});

test('meitu-service:tier 传给抓取器 —— 美图档 --tier meitu;缺省/涩图档 --tier seitu', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-tier'] });
    await handleMeituCommand({
      message: message('g-tier'),
      parsed: { ...PARSED, tier: 'meitu' },
      deps,
    });
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    assert.equal(at('--tier'), 'meitu');

    const { deps: deps2, calls: calls2 } = makeDeps({ dir, files: [file], groups: ['g-tier2'] });
    await handleMeituCommand({ message: message('g-tier2'), parsed: { ...PARSED, tier: 'seitu' }, deps: deps2 });
    const at2 = (name) => calls2.fetch[0].args[calls2.fetch[0].args.indexOf(name) + 1];
    assert.equal(at2('--tier'), 'seitu');
  });
});

// ---------------------------------------------------------------------------
// ⑫ 角色位词尾粘着修饰(1.191.0,主人:「来两张合成名戊裸足美图」被整段当角色名)
// ---------------------------------------------------------------------------

/** 写一张小别名表:一个普通名(合成名戊)+ 一个**以修饰词结尾**的名(合成雪,雪=snow)。 */
function writeGluedAlias(dir) {
  fs.writeFileSync(
    path.join(dir, 'meitu-alias.json'),
    JSON.stringify({ 合成名戊: 'fixture_name_e_(fixture:work_c)', 合成雪: 'fixture_snow_(fixture_work_d)' }),
    'utf8',
  );
}

test('meitu-service:角色位粘着修饰(合成名戊裸足)→ 按别名表剥开,char/tags/目录三处都对', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-glued'] });
    writeGluedAlias(dir);
    const result = await handleMeituCommand({
      message: message('g-glued'),
      parsed: { ...PARSED, character: '合成名戊裸足', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.ok, true);
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    assert.equal(at('--char'), 'fixture_name_e_(fixture:work_c)', '角色要剥成「合成名戊」');
    assert.equal(at('--tags'), 'barefoot', '剥出来的「裸足」要进 tags');
    assert.equal(at('--tier'), 'meitu');
    assert.ok(at('--out').endsWith('合成名戊'), `落盘目录要用剥出来的名字:${at('--out')}`);
  });
});

test('meitu-service:名字本身以修饰词结尾(合成雪)→ 原样优先,不许剥成「合成」', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-name-suffix'] });
    writeGluedAlias(dir);
    await handleMeituCommand({
      message: message('g-name-suffix'),
      parsed: { ...PARSED, character: '合成雪', tags: [], tier: 'meitu' },
      deps,
    });
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    assert.equal(at('--char'), 'fixture_snow_(fixture_work_d)');
    assert.equal(at('--tags'), '', '名字里的「雪」不许被当成 snow 修饰');
    assert.ok(at('--out').endsWith('合成雪'));
  });
});

test('meitu-service:角色位只剩修饰(裸足美图)→ 随机角色 + 该修饰', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const { deps, calls } = makeDeps({ dir, files: [file], groups: ['g-bare'] });
    writeGluedAlias(dir);
    const result = await handleMeituCommand({
      message: message('g-bare'),
      parsed: { ...PARSED, character: '裸足', tags: [], tier: 'meitu' },
      deps: { ...deps, rng: () => 0 },
    });
    assert.equal(result.ok, true);
    const at = (name) => calls.fetch[0].args[calls.fetch[0].args.indexOf(name) + 1];
    assert.equal(at('--char'), 'fixture_name_e_(fixture:work_c)', 'rng=0 → 表里第一个角色');
    assert.equal(at('--tags'), 'barefoot');
    assert.ok(at('--out').endsWith('合成名戊'));
  });
});

test('meitu-service:既没登记也剥不出角色(路人甲裸足)→ 照旧回「没登记」', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, files: [], groups: ['g-unknown'] });
    writeGluedAlias(dir);
    const result = await handleMeituCommand({
      message: message('g-unknown'),
      parsed: { ...PARSED, character: '路人甲裸足', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unregistered');
    assert.equal(calls.fetch.length, 0, '没登记就别抓');
    assertReplyIn(calls, 'unregistered');
  });
});

// ---------------------------------------------------------------------------
// ⑩ 失败兜底与结算(2026-10-27 修复:internal P1 / 已发数结算 / 补发差额 / download_failed)
// ---------------------------------------------------------------------------

test('meitu-service:runFetch 抛异常 → internal 回话 + 记失败清单,绝不 reject(P1 回归)', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-internal'],
      runFetch: async () => {
        throw new Error('spawn 炸了');
      },
    });
    const result = await handleMeituCommand({ message: message('g-internal'), parsed: PARSED, deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'internal');
    assertReplyIn(calls, 'internal');
    const rows = fs.readFileSync(path.join(dir, 'meitu-miss.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1, '兜底路径也要记进需求池');
    assert.equal(rows[0].reason, 'internal');
  });
});

test('meitu-service:部分发送成功 + 降档落空 → 已发数不丢、占冷却、回委屈道歉、不误记失败', async () => {
  await withTemp(async (dir) => {
    const file1 = makeImageFile(dir, 'one.png');
    const file2 = makeImageFile(dir, 'two.png');
    let clock = 1000;
    const fetches = [];
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-partial'],
      cooldownMs: 30_000,
      now: () => clock,
      runFetch: async (input) => {
        fetches.push(input);
        const files = fetches.length === 1
          ? [
            { path: file1, source: 'danbooru', id: 1, rating: 'questionable', url: 'u1' },
            { path: file2, source: 'danbooru', id: 2, rating: 'questionable', url: 'u2' },
          ]
          : []; // 降档抓了个寂寞
        return { code: 0, stdout: JSON.stringify({ ok: true, files, rungs: [] }), stderr: '' };
      },
      uploadFile: async (args) => {
        calls.upload.push(args);
        if (args.fileName === 'two.png') throw BLOCKED_ERROR;
        return `file_info_${calls.upload.length}`;
      },
    });
    const parsed = { ...PARSED, count: 2 };
    const first = await handleMeituCommand({ message: message('g-partial'), parsed, deps });
    assert.deepEqual(
      { ok: first.ok, reason: first.reason, sent: first.sent, failed: first.failed },
      { ok: true, reason: 'ok', sent: 1, failed: 1 },
      '已经发出去的那张必须算成功',
    );
    assertReplyIn(calls, 'blocked_apology');
    assert.equal(fs.existsSync(path.join(dir, 'meitu-miss.jsonl')), false, '给了图就不许记成失败请求');
    // --count 在补抓参数里出现两次(重放的原值 + 追加的覆盖值),CLI 按后者生效,断言取最后一次。
    const lastArg = (args, name) => args[args.lastIndexOf(name) + 1] ?? '';
    assert.equal(lastArg(fetches[1].args, '--count'), '1', '补抓数量 = 剩余差额(2 - 1)');
    assert.equal(lastArg(fetches[1].args, '--rating-allow'), 'general');
    // 同一刻再来一条 → 必须被冷却拦住(已发 > 0 就要占冷却)。
    clock = 2000;
    const second = await handleMeituCommand({ message: message('g-partial'), parsed, deps });
    assert.equal(second.reason, 'cooldown', '部分成功的请求也要占冷却');
  });
});

test('meitu-service:降档补发按剩余差额,不超发(5 张被拦 1 张只补 1 张)', async () => {
  await withTemp(async (dir) => {
    const files = Array.from({ length: 5 }, (_, i) => makeImageFile(dir, `f${i}.png`));
    const retrys = [makeImageFile(dir, 'g1.png'), makeImageFile(dir, 'g2.png'), makeImageFile(dir, 'g3.png')];
    const fetches = [];
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-cap'],
      runFetch: async (input) => {
        fetches.push(input);
        const list = fetches.length === 1
          ? files.map((file, i) => ({ path: file, source: 'danbooru', id: i + 1, rating: 'questionable', url: `u${i}` }))
          : retrys.map((file, i) => ({ path: file, source: 'danbooru', id: 100 + i, rating: 'general', url: `g${i}` }));
        return { code: 0, stdout: JSON.stringify({ ok: true, files: list, rungs: [] }), stderr: '' };
      },
      uploadFile: async (args) => {
        calls.upload.push(args);
        if (args.fileName === 'f4.png') throw BLOCKED_ERROR; // 第 5 张被拦
        return `file_info_${calls.upload.length}`;
      },
    });
    const parsed = { ...PARSED, count: 5 };
    const result = await handleMeituCommand({ message: message('g-cap'), parsed, deps });
    // --count 出现两次(重放原值 + 追加覆盖),CLI 按后者生效,断言取最后一次。
    const lastArg = (args, name) => args[args.lastIndexOf(name) + 1] ?? '';
    assert.equal(lastArg(fetches[1].args, '--count'), '1', '第一批已发 4 张,补抓只许 1 张');
    assert.equal(lastArg(fetches[1].args, '--rating-allow'), 'general');
    assert.equal(calls.send.length, 5, `总共只许发出 5 张(实际 ${calls.send.length} 张)`);
    assert.deepEqual(
      { ok: result.ok, sent: result.sent, failed: result.failed },
      { ok: true, sent: 5, failed: 1 },
    );
  });
});

test('meitu-service:download_failed 有独立回话,不再冒充「没找到新的」', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({
      dir,
      groups: ['g-dl'],
      runFetch: async () => ({
        code: 0,
        stdout: JSON.stringify({ ok: false, reason: 'download_failed', detail: '一张都没搬回来', rungs: [] }),
        stderr: '',
      }),
    });
    const result = await handleMeituCommand({ message: message('g-dl'), parsed: PARSED, deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'download_failed');
    assertReplyIn(calls, 'downloadFailed');
  });
});

test('meitu-service:按群去重 —— --group 传给抓取器、recordSent 带 group/md5;perGroup=false 回退旧口径', async () => {
  await withTemp(async (dir) => {
    const file = makeImageFile(dir);
    const fetches = [];
    const galleryCalls = [];
    const { deps } = makeDeps({
      dir,
      files: [file],
      groups: ['g-pergroup'],
      runFetch: async (input) => {
        fetches.push(input);
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            files: [{ path: file, source: 'danbooru', id: 1, rating: 'questionable', url: 'u', md5: 'a'.repeat(32) }],
            rungs: [],
          }),
          stderr: '',
        };
      },
    });
    const spy = {
      async upsertFromFetch() {},
      async recordSent(input) { galleryCalls.push(['sent', input]); },
    };
    const result = await handleMeituCommand({
      message: message('g-pergroup'),
      parsed: PARSED,
      deps: { ...deps, gallery: spy },
    });
    assert.equal(result.ok, true);
    const at = (name) => fetches[0].args[fetches[0].args.indexOf(name) + 1];
    assert.equal(at('--group'), 'g-pergroup', '抓取器要知道是哪个群的发送账');
    const sent = galleryCalls.find(([kind]) => kind === 'sent')?.[1];
    assert.equal(sent?.group, 'g-pergroup', '发送账按群记');
    assert.equal(sent?.md5, 'a'.repeat(32), '发送账按内容 md5 记(抓取器 files[] 带 md5)');

    // kill-switch:perGroup=false(QQBOT_MEITU_PER_GROUP=0)→ 不传 --group,回退全库口径。
    const fetchesOff = [];
    const off = makeDeps({
      dir,
      files: [file],
      groups: ['g-off'],
      runFetch: async (input) => {
        fetchesOff.push(input);
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            files: [{ path: file, source: 'danbooru', id: 2, rating: 'questionable', url: 'u2' }],
            rungs: [],
          }),
          stderr: '',
        };
      },
    });
    off.deps.config.meitu.perGroup = false;
    await handleMeituCommand({ message: message('g-off'), parsed: PARSED, deps: off.deps });
    assert.equal(fetchesOff[0].args.includes('--group'), false, '关掉按群去重 = 不传 --group');
  });
});

test('meitu-service:生产入口必须接上bot解释器与实际记账，不只是测试注入', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  const start = source.indexOf('void handleMeituCommand({');
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf('}).catch((err)', start));
  assert.match(block, /interpretCommand:\s*\(input\)\s*=>\s*createMeituInterpreter\(\{/u);
  assert.match(block, /llm:\s*llmSettings\.scoped\('bot'\)/u);
  assert.match(block, /requestOptions:\s*config\.engine\.requestOptions/u);
  assert.match(block, /store:\s*stateStore/u);
  assert.match(block, /key:\s*conversationKey/u);
});

// 原话→真实解析器→真实解释器/LLM客户端(假HTTP)→抓取参数→上传/发送。
// 不手造parsed保证前提，既防只修上游，也防解释器写了却没有消费。
function makeInterpretedDeps(base, content) {
  const requests = [];
  const llm = createLlmClient({
    baseUrl: 'https://example.invalid/v1', apiKey: 'test-only-key', model: 'test-model',
    log: SILENT_LOG,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({
        model: 'test-model', choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }) };
    },
  });
  return { ...base, requests, deps: {
    ...base.deps,
    interpretCommand: createMeituInterpreter({ llm, log: SILENT_LOG }),
  } };
}

test('meitu-service:合成短语甲原话未命中→模型一次→具体角色指令→搬图并被动发送', async () => {
  await withTemp(async (dir) => {
    const text = '@合成助手乙 来点合成短语甲图';
    const group = 'g-interpret-wood';
    const file = makeImageFile(dir);
    const input = makeInterpretedDeps(makeDeps({ dir, files: [file], groups: [group] }),
      JSON.stringify({ character: '合成角色甲', tags: ['large_breasts'] }));
    const parsed = parseMeituCommand(text);
    assert.equal(parsed.character, '合成短语甲', '原句确实经过别名未命中路径');
    const result = await handleMeituCommand({ message: message(group, { content: text, messageId: 'wood-1' }), parsed, deps: input.deps });
    assert.equal(result.ok, true);
    assert.equal(input.requests.length, 1);
    assert.ok(input.requests[0].messages.some((row) => row.role === 'user' && row.content.includes(text)), '原话必须到达模型');
    assert.equal(input.calls.fetch.length, 1);
    const at = (key) => input.calls.fetch[0].args[input.calls.fetch[0].args.indexOf(key) + 1];
    assert.equal(at('--char'), 'fixture_character_a');
    assert.equal(at('--tags'), 'large_breasts');
    assert.equal(at('--tier'), 'meitu');
    assert.equal(at('--count'), '1');
    assert.equal(input.calls.upload.length, 1);
    assert.equal(input.calls.send[0].msgId, 'wood-1');
    assert.equal(input.calls.reply.length, 0, '成功不先占被动图片槽位');
  });
});

test('meitu-service:合成短语甲抽象解释→已登记随机角色，原数量和档位不变', async () => {
  await withTemp(async (dir) => {
    const text = '来几张合成短语甲涩图';
    const group = 'g-interpret-abstract';
    const input = makeInterpretedDeps(makeDeps({ dir, files: [makeImageFile(dir)], groups: [group] }),
      JSON.stringify({ character: null, tags: ['large_breasts'] }));
    input.deps.rng = () => 0;
    const result = await handleMeituCommand({ message: message(group, { content: text }), parsed: parseMeituCommand(text), deps: input.deps });
    assert.equal(result.ok, true);
    assert.equal(input.requests.length, 1);
    const at = (key) => input.calls.fetch[0].args[input.calls.fetch[0].args.indexOf(key) + 1];
    assert.equal(at('--char'), 'fixture_character_a', '随机只从登记表取');
    assert.equal(at('--count'), '5');
    assert.equal(at('--tier'), 'seitu');
    assert.equal(at('--tags'), 'large_breasts');
  });
});

test('meitu-service:模型不认识/畸形/幻觉/升档指令→一次基础回复，不爬图不循环', async () => {
  for (const [i, content] of [
    'null', '这句话我也不认识', '{',
    JSON.stringify({ character: '并不存在的仙子', tags: [] }),
    JSON.stringify({ character: 'new_unregistered_tag', tags: [] }),
    JSON.stringify({ character: null, tags: ['unregistered_tag'] }),
    JSON.stringify({ character: '合成角色甲', tags: [], tier: 'seitu', count: 999 }),
  ].entries()) {
    await withTemp(async (dir) => {
      const group = `g-interpret-fail-${i}`;
      const text = '来点合成短语甲图';
      const input = makeInterpretedDeps(makeDeps({ dir, groups: [group] }), content);
      const result = await handleMeituCommand({ message: message(group, { content: text }), parsed: parseMeituCommand(text), deps: input.deps });
      assert.equal(result.reason, 'interpret_failed');
      assert.equal(input.requests.length, 1);
      assert.equal(input.calls.fetch.length, 0);
      assertReplyIn(input.calls, 'interpretFailed');
      assert.doesNotMatch(input.calls.reply[0], /登记|别名|data\\/u);
      const miss = JSON.parse(fs.readFileSync(path.join(dir, 'meitu-miss.jsonl'), 'utf8').trim());
      assert.equal(miss.text, text);
      assert.equal(miss.reason, 'interpret_failed');
    });
  }
});

test('meitu-service:模型调用抛错也有基础回复，不变internal或静默', async () => {
  await withTemp(async (dir) => {
    const group = 'g-interpret-throws';
    const input = makeDeps({ dir, groups: [group] });
    let calls = 0;
    input.deps.interpretCommand = async () => { calls += 1; throw new Error('unavailable'); };
    const result = await handleMeituCommand({ message: message(group, { content: '来点合成短语甲图' }), parsed: parseMeituCommand('来点合成短语甲图'), deps: input.deps });
    assert.equal(result.reason, 'interpret_failed');
    assert.equal(calls, 1);
    assertReplyIn(input.calls, 'interpretFailed');
    assert.equal(input.calls.fetch.length, 0);
  });
});

test('meitu-service:原巨乳指令修饰真到抓取参数，正常路径不调用模型', async () => {
  await withTemp(async (dir) => {
    const group = 'g-interpret-direct';
    const text = '@合成助手乙 再来几张熟女图，要最大的巨乳，要大大大';
    const input = makeInterpretedDeps(makeDeps({ dir, files: [makeImageFile(dir)], groups: [group] }), 'null');
    input.deps.rng = () => 0;
    const result = await handleMeituCommand({ message: message(group, { content: text }), parsed: parseMeituCommand(text), deps: input.deps });
    assert.equal(result.ok, true);
    assert.equal(input.requests.length, 0);
    const at = (key) => input.calls.fetch[0].args[input.calls.fetch[0].args.indexOf(key) + 1];
    assert.equal(at('--tags'), 'large_breasts');
    assert.equal(at('--count'), '5');
    assert.equal(at('--tier'), 'meitu');
  });
});

test('meitu-service:白名单/冷却在模型之前；已登记角色不多花一次调用', async () => {
  await withTemp(async (dir) => {
    const group = 'g-interpret-gates';
    const input = makeInterpretedDeps(makeDeps({ dir, files: [makeImageFile(dir)], groups: [group], cooldownMs: 30_000 }), 'null');
    const unknown = parseMeituCommand('来点合成短语甲图');
    const blocked = await handleMeituCommand({ message: message('g-interpret-not-allowed'), parsed: unknown, deps: input.deps });
    assert.equal(blocked.reason, 'group_disabled');
    input.calls.reply.length = 0;
    const known = await handleMeituCommand({ message: message(group), parsed: parseMeituCommand('来张合成角色甲美图'), deps: input.deps });
    assert.equal(known.ok, true);
    const cooled = await handleMeituCommand({ message: message(group), parsed: unknown, deps: input.deps });
    assert.equal(cooled.reason, 'cooldown');
    assert.equal(input.requests.length, 0, '被门禁拦住或已登记都不应调用模型');
    assert.equal(input.calls.fetch.length, 1);
  });
});

// ---------------------------------------------------------------------------
// ⑩ T2(2026-10-29):任务产物与逐张收据 —— 聊天层「她发了没/发了哪张」的可信来源
// ---------------------------------------------------------------------------

const T2_FILES = (image) => [{
  path: image, source: 'danbooru', id: 424242, rating: 's',
  url: 'https://example.invalid/x.jpg', md5: 'a'.repeat(32),
}];

test('meitu-service T2:成功发送 → task(completed/解析角色/逐张收据含出站id与md5)', async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, 'meitu-alias.json'), JSON.stringify({ 合成名己: 'fixture_name_f_(fixture_work_e)' }), 'utf8');
    const image = makeImageFile(dir);
    const { deps } = makeDeps({
      dir, files: [image], groups: ['t2-g1'],
      runFetch: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, files: T2_FILES(image) }) }),
      sendMedia: async () => ({ message_id: 'OUT-77' }),
    });
    const result = await handleMeituCommand({
      message: message('t2-g1', { content: '来1张合成名己美图' }),
      parsed: { ...PARSED, character: '合成名己', tags: [], tier: 'meitu' },
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(result.task.status, 'completed');
    assert.equal(result.task.resolved.character, '合成名己');
    assert.equal(result.task.resolved.tag, 'fixture_name_f_(fixture_work_e)');
    assert.equal(result.task.requested, 1);
    assert.deepEqual(result.task.receipts, [{
      seq: 1, source: 'danbooru', sourceId: 424242, md5: 'a'.repeat(32), rating: 's', outboundMessageId: 'OUT-77',
    }], '收据=出站消息id+图源身份;平台无id时记null,绝不编');
    assert.equal(result.task.originText, '来1张合成名己美图');
  });
});

test('meitu-service T2:部分失败 → partial;平台无id字段 → 收据id为null不编造', async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, 'meitu-alias.json'), JSON.stringify({ 合成名己: 'fixture_name_f_(fixture_work_e)' }), 'utf8');
    const files = [makeImageFile(dir, 'a.png'), makeImageFile(dir, 'b.png')];
    let n = 0;
    const { deps } = makeDeps({
      dir, files, groups: ['t2-g2'],
      runFetch: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, files: files.map((f, i) => ({ ...T2_FILES(image => image)[0], path: f, id: 500 + i })) }) }),
      sendMedia: async () => { n += 1; if (n >= 2) throw new Error('boom'); return {}; },
    });
    const result = await handleMeituCommand({
      message: message('t2-g2', { content: '来2张合成名己美图' }),
      parsed: { ...PARSED, character: '合成名己', tags: [], tier: 'meitu', count: 2 },
      deps,
    });
    assert.equal(result.task.status, 'partial');
    assert.equal(result.task.sent, 1);
    assert.equal(result.task.failed, 1);
    assert.equal(result.task.receipts.length, 1);
    assert.equal(result.task.receipts[0].outboundMessageId, null, '返回体没有id字段 → null(不编)');
  });
});

test('meitu-service T2:未登记 → task(failed/resolved=null/收据空);describeMeituTask 四态人话', async () => {
  await withTemp(async (dir) => {
    const { deps } = makeDeps({ dir, files: [], groups: ['t2-g3'] });
    const result = await handleMeituCommand({ message: message('t2-g3', { content: '来1张合成名己美图' }), parsed: PARSED, deps });
    assert.equal(result.task.status, 'failed');
    assert.deepEqual(result.task.receipts, []);
    assert.match(describeMeituTask(result.task), /搬图没成/);
    assert.match(describeMeituTask({ status: 'running', originText: '来3张合成名己美图' }), /正在找图：来3张合成名己美图/);
    assert.match(describeMeituTask({ status: 'completed', resolved: { character: '合成名己', tag: null }, sent: 2, requested: 2 }), /发出 2\/2 张/);
    assert.match(describeMeituTask({ status: 'partial', resolved: { character: '合成名己' }, sent: 1, failed: 1 }), /1 张没发出去/);
    assert.equal(describeMeituTask(null), null);
  });
});

test('meitu-service T2:接线哨兵 —— 主入口登记 running、回填真实结果、事实进主答话', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("actionLog.record(meituScope"), '接纳搬图时必须登记 running(动作观察)');
  assert.ok(source.includes('.then((result) =>'), '完成后必须回填真实结果');
  assert.ok(source.includes('const meituFact = meituActionFact(message);'), '主答话必须读取动作事实');
});

test('action-log:TTL/作用域隔离/封顶/running优先', () => {
  const log = createActionLog({ maxPerScope: 2, ttlMs: 60_000 });
  const t0 = 1_000_000;
  log.record('group:g1', { kind: 'meitu', status: 'running', text: 'a' }, t0);
  log.record('group:g1', { kind: 'meitu', status: 'completed', text: 'b' }, t0 + 1000);
  log.record('group:g2', { kind: 'meitu', status: 'completed', text: '别的群' }, t0 + 2000);
  assert.equal(log.latest('group:g1', { kind: 'meitu', now: t0 + 2000 }).text, 'b');
  assert.equal(log.running('group:g1', { kind: 'meitu', now: t0 + 2000 }), null, 'completed 覆盖后无 running');
  assert.equal(log.latest('group:g2', { now: t0 + 2000 }).text, '别的群', '作用域隔离');
  assert.equal(log.latest('group:g1', { now: t0 + 62_000 }), null, 'TTL 过期出账(61s 时 b 恰好满 60s 含边界,62s 必过期)');
  log.record('group:g3', { kind: 'x', status: 'completed', text: '1' }, t0);
  log.record('group:g3', { kind: 'x', status: 'completed', text: '2' }, t0);
  log.record('group:g3', { kind: 'x', status: 'running', text: '3' }, t0);
  assert.equal(log.all('group:g3', t0).length, 2, '每作用域封顶');
  assert.equal(log.running('group:g3', { now: t0 }).text, '3', 'running 优先(最新的在)');
});

// ---------------------------------------------------------------------------
// ⑪ T3(2026-10-29):消息↔图片资产绑定 —— 引用「你刚发的那张」能找回实际资产
// ---------------------------------------------------------------------------

test('meitu-service T3:发送绑定落真实状态库,同作用域按出站 id 查回(重启同 API 可查)', async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, 'meitu-alias.json'), JSON.stringify({ 合成名己: 'fixture_name_f_(fixture_work_e)' }), 'utf8');
    const image = makeImageFile(dir);
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    try {
      const { deps } = makeDeps({
        dir, files: [image], groups: ['t2-g1'],
        runFetch: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, files: T2_FILES(image) }) }),
        sendMedia: async () => ({ id: 'OUT-99' }),
      });
      deps.recordMediaLink = (entry) => store.recordMediaLink({
        bot: 'aris', scene: 'group', target: 't2-g1',
        outboundId: entry?.outboundId, itemSeq: entry?.itemSeq,
        md5: entry?.md5, source: entry?.source, sourceId: entry?.sourceId,
      });
      const result = await handleMeituCommand({
        message: message('t2-g1', { content: '来1张合成名己美图' }),
        parsed: { ...PARSED, character: '合成名己', tags: [], tier: 'meitu' },
        deps,
      });
      const hit = store.mediaLinksByOutbound({ bot: 'aris', scene: 'group', target: 't2-g1', outboundId: 'OUT-99' });
      assert.equal(hit.length, 1, '同作用域能查回');
      assert.equal(hit[0].md5, 'a'.repeat(32));
      assert.equal(hit[0].outboundId, 'OUT-99');
      assert.equal(hit[0].itemSeq, 1);
      assert.equal(store.mediaLinksByOutbound({ bot: 'aris', scene: 'group', target: '别群', outboundId: 'OUT-99' }).length, 0,
        '跨群不可见(作用域隔离)');
      assert.equal(result.receipts[0].outboundMessageId, 'OUT-99');
    } finally { store.close(); }
  });
});

test('qq T3:引用身份保留(replyToMessageId),嵌套引用附件不混入顶层 images', () => {
  const base = { id: 'in-1', group_openid: 'g', author: { member_openid: 'u' }, content: '这张是谁' };
  const ref = normalizeDispatch('GROUP_AT_MESSAGE_CREATE', {
    ...base,
    message_reference: { message_id: 'out-42' },
    referenced_message: { id: 'out-42', attachments: [{ content_type: 'image/png', url: 'https://example.invalid/r.png' }] },
  });
  assert.equal(ref.replyToMessageId, 'out-42', '引用 id 必须保留(解析锚点)');
  assert.equal(ref.images.length, 0, '嵌套引用附件不混入顶层 images(来源分离)');
  const direct = normalizeDispatch('GROUP_AT_MESSAGE_CREATE', {
    ...base, attachments: [{ content_type: 'image/png', url: 'https://example.invalid/r.png' }],
  });
  assert.equal(direct.replyToMessageId, null, '无引用 → null');
  assert.equal(direct.images.length, 1, '顶层附件照常提取');
});

test('meitu-service T3:接线哨兵 —— 主入口写绑定、引用解析(含像素取回)进主答话', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('recordMediaLink: (entry) => stateStore.recordMediaLink'), '发送绑定必须写状态库');
  assert.ok(source.includes('const referenceMedia = resolveReferenceMedia(message);'), '主答话必须做引用解析');
  assert.ok(source.includes('if (referenceMedia?.block) imageBlocks.push(referenceMedia.block);'),
    '绑定命中且文件可达 → 引用图像素进本轮请求(在投喂结算之后追加,不算新投喂)');
  assert.ok(source.includes('mimeForImagePath(filePath)'), '像素按实际扩展名给 MIME(不沿用默认png)');
});

export function registerMeituServiceTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerMeituServiceTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
