/**
 * 「发N张<角色>美图」的**服务层**(2026-10-23,代码层发图 —— 整条链路不经过 LLM)。
 *
 * 分工:
 *   · `src\meitu-command.js` 解析群消息(纯函数);
 *   · `src\meitu-alias.js` 中文名 → 图源 tag(人写的表);
 *   · `scripts\meitu-fetch-one.mjs` 子进程抓取/下载(网络都在它里面,本文件不碰网);
 *   · **本文件**串起来:群白名单 → 冷却 → 别名 → 落盘目录 → spawn 抓取 → 逐张上传/发送。
 *
 * 三条刻意的设计:
 *   ① **按群串行**(`Map<group, tail>`):同一个人连发两条时,后一条等前一条发完再抓,
 *      否则两条会同时下载、把同一批图发两遍;
 *   ② **冷却只在成功发出时记时间**(1.181.0,原来是"开始就记"):失败(没登记/没抓到/
 *      被拦补发也没成/发不出去)不占冷却 —— 2026-10-23 现场两次咬人:申鹤没登记失败后
 *      立刻再要,回的是「刚发过,等一会再要」,失败者还要被冷却再拦一次;冷却管的是
 *      "别刷屏",不是"上次成功没有";
 *   ③ 依赖全部可注入(`deps`),单测用假 runFetch / 假上传,不碰网络、不碰真 QQ、不写真 D 盘。
 *
 * **图片走被动回复**(1.181.0,修 40034105):`sendMedia` 带 `msg_id`+`msg_seq`
 * (回复用户那条指令消息)—— 不带 msg_id 的图是**主动消息**,吃逐群配额,配额一空就
 * `40034105 主动消息失败, 无权限`(2026-10-23 现场:11:24 之后全群图片都发不出去)。
 * 被动窗口 5 分钟内、每条入站消息 seq 1..5(`PASSIVE_SEQ_MAX`,与 index.js 的
 * `MAX_PASSIVE_SEQ` 同一口径);seq 用完后**文本回话转主动**(道歉句而已,发不出有 warn),
 * 图片超限也退回不带 msg_id 的旧行为(有 warn)。抓图通常几十秒,窗口足够。
 *
 * 被内容审核拦的降档(2026-10-23,主人拍板):擦边图**上传成功、发送被拒**
 * (`HTTP 400 code=40034006 消息内容违规`)时,自动**再抓一张 general 档**补进群,
 * 补上后跟一条委屈道歉的小句(`blocked_apology`);降档也没成 → 道歉小句(`blocked_empty`)。
 * **只重试一次,不循环**。固定句库在 `src\meitu-lines.js`,可被 `data\meitu-lines.json` 覆盖。
 *
 * ⚠️ 上传/发送用主循环里那**一个** `QqApi` 实例(由 `src\index.js` 注入),
 *    不在这里 new 第二个 token 管理器 —— 那会多一份 token 缓存,出问题难查。
 *
 * **展览处埋点钩子**(2026-10-23,展览处刀 1):`deps.gallery` 注入 `src\meitu-gallery.js` 的
 * 服务对象时,抓取成功后 upsert 元数据、每张图发成功 `recordSent`(热度口径 `sent_count`)、
 * 被内容审核拦 `recordBlocked`。**未注入 = 完全跳过**(旧测试与未接线的实例一笔行为都不变)。
 * 埋点失败只 warn,绝不影响"把图发出去"这件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMeituAliases, resolveCharacterTag } from './meitu-alias.js';
import { applyCharacterSlot, isCategoryRandomWord, pickCharacterSlot } from './meitu-command.js';
import { DEFAULT_LINES, loadMeituLines, pickLine } from './meitu-lines.js';
import { ensureCharDir, sanitizeCharFolder, tierDirName } from './meitu-store.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_SCRIPT = path.join(ROOT_DIR, 'scripts', 'meitu-fetch-one.mjs');

/**
 * 固定回话的**默认句库**(语义沿用 1.179.x 的 MEITU_REPLIES)。
 * ⚠️ 句库只有一份实现(D159):表本体在 `src\meitu-lines.js`,这里只是旧名字的别名
 * (运行期实际用的是 `loadMeituLines(config.meitu.lines)` 合并覆盖文件之后的那份)。
 */
export const MEITU_REPLIES = DEFAULT_LINES;

/**
 * 腾讯内容审核拦图的形状(2026-10-23 现场):**上传成功、发送被拒** ——
 * `sendMedia` 报 `HTTP 400 code=40034006 消息内容违规`。命中即判 blocked,进降档。
 */
export const BLOCKED_RE = /40034006|消息内容违规/u;

/** 没注入 log 时的静默实现(单测可以完全不传)。 */
const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

/**
 * 一条入站消息的**被动回复上限**(msg_seq 1..5)。
 * ⚠️ 与 `src\index.js` 的 `MAX_PASSIVE_SEQ` 是同一口径 —— 那边有边界契约测试
 * (`boundary-contract.js`)钉着字面量;这里不许 import index.js(会拖起整个装配),
 * 所以抄同一份字面量,改的时候两处一起改。
 */
const PASSIVE_SEQ_MAX = 5;

/** 每个群一条串行队列 + 上次开始时间。进程内有效(重启即清,冷却本来也不必持久)。 */
const GROUP_QUEUES = new Map();

function queueStateFor(groupId) {
  let state = GROUP_QUEUES.get(groupId);
  if (!state) {
    state = { tail: Promise.resolve(), lastAt: null };
    GROUP_QUEUES.set(groupId, state);
  }
  return state;
}

/** 从子进程 stdout 里取**最后一条能解析的** JSON(日志在 stderr,理论上只有一条)。 */
function lastJsonLine(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 不是 JSON 就继续往前找。
    }
  }
  return null;
}

/**
 * 默认 `runFetch`:spawn `scripts\meitu-fetch-one.mjs`,收 stdout/stderr,硬超时。
 *
 * @param {{args: string[], env: Record<string,string>, timeoutMs?: number, cwd?: string}} options
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function spawnMeituFetch({ args, env, timeoutMs = 90_000, cwd = ROOT_DIR }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: `spawn 失败:${err?.message ?? err}`, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      // 抓取器只输出一行 JSON;真出意外时别把内存吃光。
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on('error', (err) => {
      stderr = `${stderr}\n${err?.message ?? err}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

function allowGroup(groups, groupId) {
  if (groups instanceof Set) return groups.has(groupId);
  if (Array.isArray(groups)) return groups.includes(groupId);
  return false;
}

/**
 * 处理一条「发N张<角色>美图」。**不抛**:任何意外都以固定回话收场并记日志。
 *
 * deps 可覆盖:
 *   config / log / runFetch / uploadFile / sendMedia / now / reply / interpretCommand
 *   (`reply` 是发固定回话的口子,`src\index.js` 传 `sendChunked`)
 *
 * @param {{message: object, parsed: object, deps?: object}} input
 * @returns {Promise<{ok: boolean, reason?: string, sent?: number, failed?: number}>}
 */
export async function handleMeituCommand({ message, parsed, deps = {} }) {
  const config = deps.config ?? {};
  const log = deps.log ?? SILENT_LOG;
  const meitu = config.meitu ?? {};
  // 固定句库:内置默认 + `data\meitu-lines.json` 按 key 合并(缺失/坏文件都走默认,永不抛)。
  const loadedLines = loadMeituLines(meitu.lines ?? path.join(ROOT_DIR, 'data', 'meitu-lines.json'));
  if (loadedLines.error) log.warn(`美图：${loadedLines.error}(先用默认句库)`);
  const lines = loadedLines.lines;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const rawReply = typeof deps.reply === 'function'
    ? deps.reply
    : async (text) => { log.warn(`美图：没有注入 reply，这句回话被丢弃：${text}`); };
  // 回话自己失败(网络抖动)不许把整条指令变成 unhandled rejection ——
  // `src\index.js` 用 `void` 起它,漏一个 rejection 就能把进程带下去。
  //
  // **被动槽位记账**(1.181.0):文本回话与图片共用同一个 msg_seq 序列(都回复用户那条
  // 指令消息)。`rawReply` 拿到 `{ startSeq, active }`(index.js 把它透传给 `sendChunked`
  // —— `startSeq` 接着数,名额用完 `active: true` 转主动),返回"发出去了几条";
  // 旧签名的假 reply(单测)不收第二参、返回 undefined → 视为没动 seq。
  const passiveId = message?.messageId ?? null;
  let seq = 0;
  const reply = async (text) => {
    const startSeq = seq;
    const active = passiveId !== null && startSeq >= PASSIVE_SEQ_MAX;
    try {
      const used = Number(await rawReply(text, { startSeq, active }));
      if (!active && Number.isFinite(used) && used > 0) seq += used;
    } catch (err) {
      log.warn(`美图：回话没发出去（${text}）：${err?.message ?? err}`);
    }
  };
  const uploadFile = typeof deps.uploadFile === 'function' ? deps.uploadFile : null;
  const sendMedia = typeof deps.sendMedia === 'function' ? deps.sendMedia : null;
  const runFetch = typeof deps.runFetch === 'function' ? deps.runFetch : spawnMeituFetch;
  // T2(2026-10-29):逐张发送收据 —— sendMedia 的平台返回体不再丢弃。
  // outboundMessageId 只从已知字段提取(id/message_id),提取不到记 null,**不编 ID**;
  // 这是「消息↔图片资产」绑定(T3)的原料,也是聊天层「发了哪张、发到哪条」的可信来源。
  const receipts = [];
  // 展览处数据层埋点(可选;未注入 = 全程跳过)。
  const gallery = deps.gallery && typeof deps.gallery === 'object' ? deps.gallery : null;
  const noteGallery = async (method, payload) => {
    const fn = gallery ? gallery[method] : null;
    if (typeof fn !== 'function') return;
    try {
      await fn.call(gallery, payload);
    } catch (err) {
      log.warn(`美图：gallery 埋点失败（${method}）：${err?.message ?? err}`);
    }
  };

  /**
   * 对一组落盘文件逐张 upload+send。一张非 blocked 失败接着发下一张;
   * **一旦命中 blocked(内容审核拦图)就停**:同一批(同角色同档)大概率张张被拦,
   * 一张张撞墙只会把人拉黑得更快 —— 直接交给降档流程补 general 档。
   *
   * 图片**走被动回复**(带 msg_id+msg_seq,回复用户那条指令)—— 不带 msg_id 的图是
   * 主动消息,吃逐群配额,配额空了就是 40034105「主动消息失败,无权限」。被动名额
   * (seq 1..5)用完后退回不带 msg_id 的旧行为并记 warn(图大概率发不出去,但日志看得见)。
   *
   * @param {Array<{path: string}>} list
   * @returns {Promise<{sent: number, failed: number, blocked: boolean}>}
   */
  const sendFiles = async (list) => {
    let sent = 0;
    let failed = 0;
    let blocked = false;
    for (const file of list ?? []) {
      try {
        const filePath = String(file?.path ?? '');
        if (!filePath) throw new Error('结果里没有文件路径');
        const buffer = await fs.promises.readFile(filePath);
        const fileName = path.basename(filePath);
        const fileInfo = await uploadFile({
          scene: 'group',
          openid: groupId,
          fileName,
          buffer,
          fileType: 1,
        });
        seq += 1;
        const usePassive = passiveId !== null && seq <= PASSIVE_SEQ_MAX;
        if (!usePassive && passiveId !== null) {
          log.warn(`美图：被动回复名额(seq 1..${PASSIVE_SEQ_MAX})已用完,这张图退回主动消息(吃配额,可能被拒)`);
        }
        const sendBody = await sendMedia(usePassive
          ? { scene: 'group', openid: groupId, fileInfo, msgId: passiveId, msgSeq: seq }
          : { scene: 'group', openid: groupId, fileInfo });
        sent += 1;
        receipts.push({
          seq,
          source: file?.source ?? null,
          sourceId: file?.id ?? null,
          md5: file?.md5 ?? null,
          rating: file?.rating ?? null,
          outboundMessageId: sendBody?.id ?? sendBody?.message_id ?? null,
        });
        // T3:持久绑定「出站消息 ↔ 资产身份」(存储由 index 注入;失败只 warn,不影响已发出的图)。
        if (typeof deps.recordMediaLink === 'function') {
          try {
            await deps.recordMediaLink({
              outboundId: sendBody?.id ?? sendBody?.message_id ?? null,
              itemSeq: seq, md5: file?.md5 ?? null,
              source: file?.source ?? null, sourceId: file?.id ?? null,
            });
          } catch (linkErr) {
            log.warn(`美图：媒体绑定没写上（不影响已发出的图）：${linkErr?.message ?? linkErr}`);
          }
        }
        // 展览处热度口径:每成功发出一次 +1(未注入 gallery 时这行是空操作)。
        await noteGallery('recordSent', {
          source: file?.source,
          sourceId: file?.id,
          atMs: Number(now()),
          // 按群去重(2026-10-28):发送**成功**才记这个群的账;md5 来自抓取器的 files[]。
          group: groupId,
          md5: file?.md5,
        });
        log.info(
          `美图：已发 ${sent}/${list.length}（${file?.source ?? '?'}:${file?.id ?? '?'}`
          + ` rating=${file?.rating ?? '?'} ${Math.round(buffer.length / 1024)}KB）`,
        );
      } catch (err) {
        failed += 1;
        const detail = err?.message ?? err;
        if (BLOCKED_RE.test(String(detail))) {
          blocked = true;
          await noteGallery('recordBlocked', { source: file?.source, sourceId: file?.id });
          log.warn(`美图：这张被内容审核拦了（${file?.path ?? '?'}）：${detail}`);
          break;
        }
        log.warn(`美图：有一张没发出去（${file?.path ?? '?'}）：${detail}`);
      }
    }
    return { sent, failed, blocked };
  };

  if (!message || message.scene !== 'group') {
    log.warn('美图：不是群消息，忽略');
    return { ok: false, reason: 'not_group' };
  }
  const groupId = String(message.targetId ?? '');
  if (!groupId) {
    log.warn('美图：群消息没有 targetId，忽略');
    return { ok: false, reason: 'no_target' };
  }

  // 失败请求记入本地(1.198.0 / 需求清单 R1):没给上图(ok=false 且 sent=0)的请求逐行
  // 追加到 `data\meitu-miss.jsonl` —— 群友的真实需求池,补别名/抓错拼全靠它。
  // cooldown / 群白名单这类"不算请求失败"的出口不经过 finish,天然不记。
  // ⚠️ **声明必须在 job 的 try 之外**(2026-10-27 P1 修复):原来它定义在 try 内,
  //     而下面 catch 的收尾也调用它 —— 不在词法作用域,任何 try 内异常都会让兜底自己
  //     抛 `appendMissLog is not defined`,internal 回话发不出去,还会经 index.js 的
  //     void 入口变成 unhandledRejection 把整个 bot 带崩(crash-log → exit(1))。
  //     函数作用域声明,try 主路径与 catch 兜底共用同一份。
  const missLogFile = String(meitu.missLog ?? '').trim() || path.join(ROOT_DIR, 'data', 'meitu-miss.jsonl');
  const appendMissLog = ({ group, text, reason }) => {
    try {
      const row = {
        at: new Date(Number(now())).toISOString(),
        group: String(group ?? ''),
        text: String(text ?? '').slice(0, 200),
        character: parsed.character ?? '',
        tags: parsed.tags ?? [],
        tier: parsed.tier ?? 'meitu',
        random: Boolean(parsed.random),
        count: parsed.count ?? 0,
        ignored: parsed.ignored ?? [],
        reason: String(reason ?? 'unknown'),
      };
      fs.appendFileSync(missLogFile, `${JSON.stringify(row)}\n`, 'utf8');
      log.info(`美图：失败请求已记入 ${missLogFile}（reason=${row.reason} character=${row.character || '(无)'}）`);
    } catch (err) {
      log.warn(`美图：失败请求没记下来（${missLogFile}）：${err?.message ?? err}`);
    }
  };

  // ① 群白名单(fail closed:空名单 / 不在名单 → 都不发)。
  if (!allowGroup(meitu.groups, groupId)) {
    log.warn(`美图：群 ${groupId.slice(0, 8)}… 没开这个指令（QQBOT_MEITU_GROUPS）`);
    await reply(pickLine('groupDisabled', lines));
    return { ok: false, reason: 'group_disabled' };
  }

  if (!parsed?.ok) {
    log.warn('美图：服务层收到没解析成功的命令（不应发生）');
    return { ok: false, reason: 'parse' };
  }

  // ② 按群串行:后一条等前一条彻底结束再开始。
  const state = queueStateFor(groupId);
  const job = state.tail.then(async () => {
    try {
      // ③ 冷却:**只在成功发出时记时间**(1.181.0)。失败(unregistered/no_result/
      //    blocked_empty/…)不占冷却 —— 失败者再要一遍是合法的,不该被「刚发过」拦住。
      const cooldownMs = Number.isFinite(Number(meitu.cooldownMs)) ? Number(meitu.cooldownMs) : 0;
      const startedAt = Number(now());
      if (state.lastAt !== null && startedAt - state.lastAt < cooldownMs) {
        const wait = Math.ceil((cooldownMs - (startedAt - state.lastAt)) / 1000);
        log.info(`美图：群 ${groupId.slice(0, 8)}… 冷却中（还要 ${wait}s）`);
        await reply(pickLine('cooldown', lines));
        return { ok: false, reason: 'cooldown' };
      }
      // 所有出口统一走这里:发出过 ≥1 张(含降档补发)才算"发过",才占冷却。
      // T2:每个出口都挂**任务级产物**(status/receipts/解析结果)——聊天层观察
      // 「正在/已经搬图」的唯一可信来源;ok/sent/failed 既有口径不变。
      const finish = (result) => {
        if ((result?.sent ?? 0) > 0) state.lastAt = startedAt;
        if (result?.ok !== true && (result?.sent ?? 0) === 0) {
          appendMissLog({ group: groupId, text: message.content, reason: result?.reason });
        }
        const sentCount = result?.sent ?? 0;
        const failedCount = result?.failed ?? 0;
        const status = sentCount === 0 ? 'failed' : failedCount > 0 ? 'partial' : 'completed';
        const task = {
          kind: 'meitu',
          taskId: `meitu-${groupId}-${startedAt}`,
          originMessageId: message?.messageId ?? null,
          originText: String(message?.content ?? '').slice(0, 40),
          requested: parsed?.count ?? 0,
          resolved: selected ? {
            character: selected.characterName ?? null,
            tag: selected.resolved?.tag ?? null,
            tier: selected.tier ?? parsed?.tier ?? null,
            tags: selected.tags ?? [],
            random: Boolean(selected.random),
          } : null,
          status,
          reason: result?.reason ?? null,
          sent: sentCount,
          failed: failedCount,
          receipts,
        };
        // receipts 同时挂顶层(收据是发送侧事实,不只在 task 里)。
        return { ...result, receipts, task };
      };

      // ④ 别名表 → tag。
      const aliasPath = meitu.alias
        ? String(meitu.alias)
        : path.join(ROOT_DIR, 'data', 'meitu-alias.json');
      const { aliases, error } = loadMeituAliases(aliasPath);
      if (error) log.warn(`美图：${error}(先用默认别名表)`);

      // 同一套角色选择供确定性解析和单次模型恢复共用；不递归调用服务，避免重复冷却/调用模型。
      const selectRequest = (request) => {
        let name = request.character;
        const slot = !request.random && name
          ? pickCharacterSlot(name, (value) => resolveCharacterTag(value, aliases).ok)
          : null;
        if (slot) name = slot.character;
        const modifiers = applyCharacterSlot(request, slot);
        const resolved = resolveCharacterTag(name, aliases);
        // 具名优先；类目和纯修饰仍走原有随机机制，不发明新的类目 tag。
        const random = Boolean(request.random || slot?.random || !name
          || (!resolved.ok && isCategoryRandomWord(name)));
        return { characterName: name, ...modifiers, resolved, random };
      };
      let selected = selectRequest(parsed);
      if (!selected.random && !selected.resolved.ok && typeof deps.interpretCommand === 'function') {
        // 主人 2026-10-28：未命中别名先让模型理解一次，再回既有搬图链路。
        // 解释器产物经过严格 schema/角色/tag 校验；不执行它的自由文本、不落别名、不循环猜测。
        let recovered;
        try {
          recovered = await deps.interpretCommand({ text: message.content, parsed, aliases });
        } catch {
          log.warn('美图：模型理解调用失败（未执行抓取）');
        }
        if (!recovered?.ok || !recovered.parsed?.ok) {
          log.warn(`美图：模型未能恢复可执行指令（${recovered?.reason ?? 'unavailable'}）`);
          await reply(pickLine('interpretFailed', lines));
          return finish({ ok: false, reason: 'interpret_failed' });
        }
        // 数量/档位只信原指令，不允许模型扩大数量或升档。
        selected = selectRequest({ ...recovered.parsed, count: parsed.count, tier: parsed.tier });
        // resolveCharacterTag 允许用户直写英文 tag，但模型不能借这条路创造新角色。
        const registeredTags = new Set(Object.values(aliases));
        if (!selected.random && (!selected.resolved.ok || !registeredTags.has(selected.resolved.tag))) {
          await reply(pickLine('interpretFailed', lines));
          return finish({ ok: false, reason: 'interpret_failed' });
        }
        log.info(`美图：单次模型理解已恢复指令（角色=${selected.random ? '(随机)' : selected.characterName}`
          + ` tags=${selected.tags.join(',') || '(无)'} tier=${selected.tier} count=${parsed.count}）`);
      }

      let { characterName, resolved } = selected;
      const { tags: finalTags, tier: finalTier } = selected;
      if (selected.random) {
        const keys = Object.keys(aliases);
        if (keys.length === 0) {
          log.warn('美图：随机模式但别名表一个角色都没有');
          await reply(pickLine('unregistered', lines));
          return finish({ ok: false, reason: 'unregistered' });
        }
        const rng = typeof deps.rng === 'function' ? deps.rng : Math.random;
        characterName = keys[Math.min(keys.length - 1, Math.max(0, Math.floor(rng() * keys.length)))];
        resolved = resolveCharacterTag(characterName, aliases);
        // T2:随机选角结果回写 selected —— finish 的 task.resolved 才能拿到真实角色。
        Object.assign(selected, { characterName, resolved, random: true });
        log.info(`美图：模糊请求 → 随机挑了「${characterName}」(${resolved.tag ?? '?'})`);
      }
      if (!resolved.ok) {
        log.warn(`美图：角色「${characterName}」没有登记别名(${aliasPath})`);
        await reply(pickLine('unregistered', lines));
        return finish({ ok: false, reason: 'unregistered' });
      }

      // ⑤ 落盘目录(按**档位**分类:`<根>\r13\<角色>` 美图 / `<根>\r18\<角色>` 涩图;
      //    角色名消毒在 meitu-store 里。1.184.3 起新图按此存,旧结构存量图不动)。
      if (!meitu.root) {
        log.error('美图：没有配置 QQBOT_MEITU_ROOT，无法落盘');
        await reply(pickLine('internal', lines));
        return finish({ ok: false, reason: 'no_root' });
      }
      const target = await ensureCharDir(meitu.root, characterName, { tier: finalTier });
      log.info(
        `美图：${characterName}(${resolved.tag}) × ${parsed.count} tier=${finalTier}`
        + ` tags=${finalTags.join(',') || '(无)'} → ${target.dir}`,
      );

      // ⑤' 历史目录(1.184.3):旧结构存量 `<根>\<角色>` + 另一档同角色目录 ——
      //     重建索引时并入它们的 md5,存量图与跨档同图不会被重复下载。
      const storeRoot = path.resolve(String(meitu.root));
      const charFolder = sanitizeCharFolder(characterName);
      const otherTier = finalTier === 'meitu' ? 'seitu' : 'meitu';
      const extraDirs = [
        path.join(storeRoot, charFolder),
        path.join(storeRoot, tierDirName(otherTier), charFolder),
      ];

      // ⑥ spawn 抓取器(代理只走环境变量:Node 24 的 fetch 认 NODE_USE_ENV_PROXY)。
      const args = [
        FETCH_SCRIPT,
        '--char', resolved.tag,
        '--tags', finalTags.join(','),
        '--count', String(parsed.count),
        '--out', target.dir,
        '--source', String(meitu.source ?? 'auto'),
        '--max-bytes', String(meitu.maxBytes ?? 10_485_760),
        // 检索档位:meitu=全年龄唯美(g/s);seitu=擦边(s/q)。解析层定,这里只传话。
        '--tier', finalTier === 'meitu' ? 'meitu' : 'seitu',
      ];
      // 按群去重(2026-10-28 主人拍板):把群 id 传给抓取器 —— 发送账里"这个群看过的"
      // 不再出,库里已有文件的直接复用,不重复下载。`perGroup:false`(env QQBOT_MEITU_PER_GROUP=0)
      // 回退旧全库口径。抓取器侧库打不开时会自行退回全库口径并 warn(宁少给,不重发)。
      if (meitu.perGroup !== false) args.push('--group', groupId);
      // 展览处元数据落库:库跟本实例状态库同级(`data\aris\state.db` → `data\aris\meitu.db`);
      // 显式配置优先。抓取子进程按这个路径 upsert meitu_meta(展览处刀 1)。
      // 推不出来就不传 —— 抓取器自己也会从 env 推,推不出就跳过落库。
      // ⚠️ 刀 2 修正:刀 1 这里读的是 `config.stats`(不存在;状态库在 `config.policy.stats`),
      //    生产一直靠 fetch-one 的 env 兜底才没出事 —— 现在配置里有 `meitu.db`,以它为准。
      const metaDbPath = (() => {
        if (meitu.db) return path.resolve(String(meitu.db));
        const stateDb = config.policy?.stats?.dbFile ?? config.stats?.dbFile;
        return stateDb ? path.join(path.dirname(String(stateDb)), 'meitu.db') : '';
      })();
      if (metaDbPath) args.push('--db', metaDbPath);
      // 历史目录(1.184.3):旧结构存量 + 另一档同角色 —— 抓取器重建索引时并入其 md5。
      for (const dir of extraDirs) args.push('--extra-dir', dir);
      const env = { ...process.env };
      if (meitu.proxy) {
        args.push('--proxy', String(meitu.proxy));
        env.NODE_USE_ENV_PROXY = '1';
        env.HTTPS_PROXY = String(meitu.proxy);
        env.HTTP_PROXY = String(meitu.proxy);
        // 1.199.0(2026-10-25 现场,白云机 21:37 重启后代理进程没了 →「图源连不上」):
        // NODE_USE_ENV_PROXY 是**进程级**的 —— 代理一死,Safebooru 的直连兜底也被拖去撞
        // 死代理,两个源一起挂 → `source_down`(三组对照实测:加 NO_PROXY 后 Safebooru
        // 直连 100 条过筛 97,代理活着时 Danbooru 照旧优先)。Safebooru 本来就不需要代理。
        env.NO_PROXY = 'safebooru.org';
      }
      // 第一次抓取与降档补抓共用同一个硬超时。
      const fetchTimeoutMs = Number.isFinite(Number(meitu.timeoutMs)) ? Number(meitu.timeoutMs) : 90_000;

      const fetched = await runFetch({
        args,
        env,
        timeoutMs: fetchTimeoutMs,
        cwd: ROOT_DIR,
      });
      if (fetched?.timedOut) log.warn('美图：抓取器超时被杀');
      if (fetched?.stderr) {
        const tail = String(fetched.stderr).trim().split(/\r?\n/u).slice(-3).join(' / ');
        if (tail) log.debug(`美图抓取日志：${tail}`);
      }

      const payload = lastJsonLine(fetched?.stdout);
      if (!payload || payload.ok !== true) {
        const reason = payload?.reason ?? 'source_down';
        const detail = payload?.detail ?? (fetched?.code ? `抓取器退出码 ${fetched.code}` : '没有可读的抓取结果');
        log.warn(`美图：抓取失败（${reason}）：${detail}`);
        // 2026-10-27:download_failed 有自己的回话 —— 原来它和"真没图"共用一句
        // 「没找到符合条件的新图」,把"图源问题/下载问题"伪装成"没图",排查全靠猜。
        if (reason === 'source_down') await reply(pickLine('sourceDown', lines));
        else if (reason === 'no_character') await reply(pickLine('unregistered', lines));
        else if (reason === 'download_failed') await reply(pickLine('downloadFailed', lines));
        else await reply(pickLine('noResult', lines));
        return finish({ ok: false, reason });
      }

      const files = Array.isArray(payload.files) ? payload.files : [];
      if (files.length === 0) {
        log.info('美图：抓取成功但一张都没有（都下过了？）');
        await reply(pickLine('noResult', lines));
        return finish({ ok: false, reason: 'no_result' });
      }

      // 展览处埋点:按现返回形状把这一批落进 meitu_meta(fetch-one 落盘时已写过,这里幂等兜一层;
      // 未注入 gallery 时是空操作)。
      for (const file of files) {
        await noteGallery('upsertFromFetch', {
          source: file?.source,
          sourceId: file?.id,
          filePath: file?.path,
          rating: file?.rating,
          fetchedAt: Number(now()),
        });
      }

      // ⑦ 顺序发送:一张失败接着发下一张(全失败才回固定话)。
      if (!uploadFile || !sendMedia) {
        log.error('美图：uploadFile/sendMedia 没有注入（src/index.js 应传入 api 的出口）');
        await reply(pickLine('uploadFailed', lines));
        return finish({ ok: false, reason: 'upload_failed' });
      }

      const first = await sendFiles(files);

      // ⑧ 被内容审核拦了(上传成功、发送被 40034006/「消息内容违规」拒):
      //    **降档一次** —— 再抓 general 档补进群,别让用户扑空。只重试一次,不循环。
      if (first.blocked) {
        // 补抓数量 = **剩余差额**(2026-10-27 修超发):原来沿用原 count,五张请求被拦一张
        // 会再抓五张,一轮最多发出九张,还把被动回复槽位挤成主动消息。
        const remaining = Math.max(1, parsed.count - first.sent);
        const retry = await runFetch({
          args: [...args, '--count', String(remaining), '--rating-allow', 'general'],
          env,
          timeoutMs: fetchTimeoutMs,
          cwd: ROOT_DIR,
        });
        if (retry?.timedOut) log.warn('美图：降档抓取超时被杀');
        const retryPayload = lastJsonLine(retry?.stdout);
        const retryFiles = retryPayload?.ok === true && Array.isArray(retryPayload.files)
          ? retryPayload.files.slice(0, remaining)
          : [];
        if (retryFiles.length === 0) {
          log.warn('美图：降档也没抓到图，普通档一张都没补上');
          // 2026-10-27 修结算:原来这里丢掉 first.sent —— 已经发出去的图被当零成功,
          // 不占冷却、还被记成失败请求。现在按真实已发数收口。
          await reply(pickLine(first.sent > 0 ? 'blocked_apology' : 'blocked_empty', lines));
          return finish(first.sent > 0
            ? { ok: true, reason: 'ok', sent: first.sent, failed: first.failed }
            : { ok: false, reason: 'blocked' });
        }
        const second = await sendFiles(retryFiles);
        const sent = first.sent + second.sent;
        const failed = first.failed + second.failed;
        log.warn(
          `美图：擦边被拦，已降档补发 general 档（第二批 sent=${second.sent} failed=${second.failed}）`,
        );
        // 第二批再被拦也不再循环:没补上就老老实实道歉。道歉句按**总数**挑 ——
        // 原来按 second.sent 挑,首批已发出、补发落空时会误说「一张都没发出去」。
        await reply(pickLine(sent > 0 ? 'blocked_apology' : 'blocked_empty', lines));
        return finish({ ok: sent > 0, reason: sent > 0 ? 'ok' : 'blocked', sent, failed });
      }

      if (first.sent === 0) {
        await reply(pickLine('uploadFailed', lines));
        return finish({ ok: false, reason: 'upload_failed', sent: first.sent, failed: first.failed });
      }
      return finish({ ok: true, sent: first.sent, failed: first.failed });
    } catch (err) {
      log.error('美图：处理失败', err);
      // internal 出口不走 finish(catch 在 finish 作用域之外的收尾),也要记进失败清单。
      appendMissLog({ group: groupId, text: message.content, reason: 'internal' });
      await reply(pickLine('internal', lines));
      // T2:catch 出口也带任务产物(startedAt 在 try 内,taskId 不可知 → 如实 null)。
      return {
        ok: false, reason: 'internal',
        task: {
          kind: 'meitu', taskId: null, originMessageId: message?.messageId ?? null,
          originText: String(message?.content ?? '').slice(0, 40),
          requested: parsed?.count ?? 0, resolved: null,
          status: 'failed', reason: 'internal', sent: 0, failed: 0, receipts,
        },
      };
    }
  });

  // 队列尾巴只用来衔接,失败不能把后一条堵死。
  state.tail = job.then(() => {}, () => {});
  return job;
}

/**
 * **任务产物 → 一句人话事实**(T2,2026-10-29)。
 *
 * 给聊天层的事实通道用:她该能看着这句话答「发了没/发给谁了」,而不是靠模型猜。
 * 纯函数、无副作用;running(进行中)/completed/partial/failed 四态各有措辞,
 * 没有解析结果(还没走到选角色)就如实说,不编角色。
 *
 * @param {{status?: string, originText?: string, resolved?: {character: string|null,
 *          tag: string|null}|null, sent?: number, failed?: number, requested?: number,
 *          reason?: string|null}|null} task
 * @returns {string|null} null = 没有可说的事实
 */
export function describeMeituTask(task) {
  if (!task || typeof task !== 'object') return null;
  const who = task.resolved?.character
    ? `${task.resolved.character}${task.resolved.tag ? `(${task.resolved.tag})` : ''}`
    : null;
  const asked = typeof task.originText === 'string' && task.originText.trim() !== ''
    ? `应「${task.originText.trim()}」` : '';
  if (task.status === 'running') return `正在找图${asked ? `：${task.originText.trim()}` : ''}`;
  if (task.status === 'partial') {
    return `刚搬图${who ? `（${who}）` : ''}：发出 ${task.sent ?? 0} 张，有 ${task.failed ?? 0} 张没发出去`;
  }
  if (task.status === 'completed') {
    return `刚搬图${who ? `（${who}）` : ''}：发出 ${task.sent ?? 0}/${task.requested ?? task.sent ?? 0} 张`;
  }
  if (task.status === 'failed') {
    return `搬图没成${who ? `（${who}）` : ''}${task.reason ? `（${task.reason}）` : ''}`;
  }
  return null;
}
