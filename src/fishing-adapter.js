/**
 * **钓鱼适配器**(D108:把原来长在 `src\index.js` 的 `main()` 闭包里的那一层抽出来)。
 *
 * 为什么要抽(D106 第三节留下的那笔账):1.65.0 的两处真回归 ——
 * **"先落盘再问模型"的顺序**、**自动收杆丢了一条消息** —— 都在这一层里,而那一层当时
 * 是 `main()` 里的闭包,**单测碰不到**。结果它们不是被测试抓住的,是被复核者逐行读 diff 抓住的。
 *
 * 现在这一层的形状是"**依赖注入的工厂**":
 *
 *     const fishing = createFishingAdapter({
 *       store: { getMeta, setMeta, listMetaKeys, applyStoryResult },  // 端口
 *       send: (message, text) => sendChunked(message, text),         // 端口(发消息)
 *       flavor: (kind, ctx, message) => …,                           // 端口(让模型写台词)
 *       config: { appId, currency, sleep },
 *       log: console,
 *     });
 *     if (await fishing.handleMessage(message)) return;   // 这一句被钓鱼接管了
 *
 * ⚠️ **每条顺序都是有意的,改之前先看注释**:
 *   ① 收杆 / 结算**先落盘、再问模型**(模型那拍最长 40 秒,期间状态必须已经变);
 *   ② 两种收杆都用 `'reel'` 那档提示词(与 1.64.0 一致);
 *   ③ 自动收杆走**同一个** `reelIn()`(它自己会落盘、会发"台词 + 事实"一整段);
 *   ④ 库外饵那条路也要刷新 `lastTouchAt`。
 *
 * 这些现在是**测试钉住的**:见 `scripts\selftest-fishing-adapter.js`。
 */

import {
  alreadyFishingLine,
  applyAction,
  castMessage,
  describeFishingState,
  detectFishing,
  detectReelIn,
  emptyReelText,
  extractBaitName,
  fishingKey,
  handlingFor,
  judgeCustomBait,
  looksLikeBaitAnswer,
  looksLikeBaitSuggestion,
  looksLikeHandlingTalk,
  namePrefix,
  parseFishingKey,
  parseHandlingPlan,
  reelSummaryLine,
  unparsedHandlingLine,
} from './play/index.js';
// 只剩"给模型写台词的提示词/兜底"这一件还在适配器那边(内核不需要它)
import { describeCatch } from './fishing.js';
import { CURRENCY } from './stats.js';

/** 把 `describeError(err)` 的活留给调用方;这里只要求 `err.message` 存在。 */
const errText = (err) => err?.message ?? String(err);

/**
 * "带回家"那笔账的 `meta` 键(**全局一份** —— 东西是她的,不分会话)。
 * ⚠️ 与钓位那种"按人"的键不同:这是**她的**存货。
 */
export const HOME_ITEM_KEY = 'home_item';

/**
 * 按内核给的 `kind` 决定这一笔结算**记成哪种流水**(D102 的绑定表是 fail closed 的:
 * 记错 kind,数值会被**整个丢掉**)。
 *
 * 吃 → `meal`(只有它准动饱食);卖 → `fish`;风干/留着/扔 → `home`。
 */
export function fishingEventKind(runs = []) {
  if (runs.some((run) => ['grill', 'boil', 'fry'].includes(run.handling))) return 'meal';
  if (runs.some((run) => ['sell', 'sell_precious'].includes(run.handling))) return 'fish';
  return 'home';
}

/**
 * @param {object} deps
 * @param {object} deps.store `{ getMeta, setMeta, listMetaKeys, applyStoryResult }`
 * @param {(message: object, text: string) => Promise<void>} deps.send 发一条(内部自己分块)
 * @param {(kind: string, ctx: object, message: object) => Promise<string>} deps.flavor 让模型写台词
 * @param {object} deps.config `{ appId, currency, sleep, readAffinityScore?, affinityTier? }`
 * @param {object} [deps.log] `{ info, warn }`
 */
export function createFishingAdapter({ store, send, flavor, config = {}, log = console }) {
  const appId = config.appId ?? '';
  const currency = config.currency ?? CURRENCY.name;
  const sleep = config.sleep ?? null;
  /** 这个人多少好感分(端口;读不出来就当 0)。 */
  const readAffinityScore = typeof config.readAffinityScore === 'function' ? config.readAffinityScore : () => 0;
  /** 分数 → 档位(端口;没给就按"眼熟"这一档,也就是**最保守**的 10%)。 */
  const affinityTier = typeof config.affinityTier === 'function' ? config.affinityTier : () => ({ id: 'stranger', label: '眼熟' });

  /** 钓位的存储键:`fishing:<scene>:<targetId>:<userId>`(按**人**,一个群可以多人同钓)。 */
  function keyFor(message) {
    return fishingKey({
      scene: message.scene,
      targetId: message.targetId,
      userId: message.senderId,
      appId,
    });
  }

  function read(message) {
    try {
      const raw = store.getMeta(keyFor(message));
      // 空串 = 已清掉(存储层没有 clearMeta,见 `write`)
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.phase ? parsed : null;
    } catch (err) {
      log.warn(`读钓鱼状态失败: ${errText(err)}`);
      return null;
    }
  }

  function write(message, state) {
    try {
      store.setMeta(keyFor(message), state === null ? '' : JSON.stringify(state));
    } catch (err) {
      log.warn(`写钓鱼状态失败: ${errText(err)}`);
    }
  }

  /**
   * **"带回家的东西"单独记一笔**(key `home_item`)。
   *
   * 为什么单独记:`dry` / `keep_*` 那两档的 `effect.homeItem` **不是数值**,
   * 绑定表(D102)按 `ALL_STATS` 过滤 → `applyStoryResult` 会把它丢掉,
   * 所以"带回家风干"以前**账上什么都不多**。真正的落点(家园/典当铺)是 D100 那一批,
   * 在那之前至少让它**看得见、可查**(面板 + 以后的 `/家`)。
   * ⚠️ 只增不改:同一件东西再带回来就累加件数。
   */
  function writeHomeItems(homeItems) {
    if (!Array.isArray(homeItems) || homeItems.length === 0) return;
    try {
      const raw = store.getMeta(HOME_ITEM_KEY);
      const ledger = raw ? JSON.parse(raw) : { items: [], updatedAt: 0 };
      const items = Array.isArray(ledger?.items) ? [...ledger.items] : [];
      for (const row of homeItems) {
        const found = items.find((item) => item.key === row.key);
        if (found) {
          found.count = (Number(found.count) || 0) + (Number(row.count) || 0);
          found.available = false;
        } else {
          items.push({ key: row.key, count: Number(row.count) || 0, available: false, firstAt: Date.now() });
        }
      }
      store.setMeta(HOME_ITEM_KEY, JSON.stringify({ items, updatedAt: Date.now() }));
      log.info(`钓鱼：带回家（还没地方放）${homeItems.map((row) => `${row.key}×${row.count}`).join('、')}`);
    } catch (err) {
      log.warn(`记"带回家的东西"失败（不影响结算）: ${errText(err)}`);
    }
  }

  /** 把一次动作交给内核(端口只有"喂 ctx");返回值原样透出给调用方用。 */
  function act(kind, state, action, message, extra = {}) {
    return applyAction(kind, state, action, {
      now: extra.now ?? Date.now(),
      random: extra.random ?? Math.random,
      // ⚠️ 两个前端喂的是**同一套字段**:QQ 是 `senderId/senderName`,小网站是 `userId/userName`。
      // ⚠️ 而且**要回落到 state 里的那一份**:群里是别人替她下饵/收杆时,`message.senderId` 是
      //    **说话的人**,而"这竿是谁的"写在 state 的 `userId` 上 —— 1.64.0 的写法正是
      //    `message.senderId ?? state.userId`(别把它简化成只认 message)。
      userId: extra.userId ?? message?.senderId ?? state?.userId ?? null,
      userName: extra.userName ?? message?.senderName ?? state?.userName ?? null,
      scene: message?.scene ?? 'c2c',
      targetId: message?.targetId ?? '',
      appId,
    });
  }

  /** 开始钓鱼:立刻报水域+钓点+鱼饵(**不过模型**)。 */
  async function begin(message) {
    const { state, lines } = act('fishing.begin', null, {}, message);
    write(message, state);
    await send(message, lines.join('\n'));
    log.info(`钓鱼：${describeFishingState(state)}（等她选饵）`);
  }

  /** 选饵 → 下饵,从这一刻起计时。 */
  /**
   * 选饵 → 下饵,从这一刻起计时。
   *
   * ⚠️ 两个前端走的是**同一段代码**,只是"怎么表达选了哪一个饵"不同:
   *    · QQ:人说的话(`text`)—— 内核用 `pickBait()` 从话里认;
   *    · 面板:结构化动作给的 **`baitId`**(D110)—— 直接点到那个饵上。
   *    所以参数写成 `choice`(字符串或 `{baitId}`),两条路都会落到同一个 `applyAction`。
   */
  async function cast(message, state, choice) {
    const isStructured = choice && typeof choice === 'object';
    const { state: next, events, lines } = isStructured
      ? act('fishing.cast', state, { baitId: choice.baitId ?? null }, message)
      : act('fishing.cast', state, { text: choice }, message);
    if (!events.some((row) => row.type === 'fishing_cast')) {
      // 今天走不到(两个调用点都先确认了 phase === 'bait'),但**不许静默丢消息**:
      // 落一次盘(刷新互动时刻)并把这件事记进日志。
      write(message, next ?? state);
      log.warn(`钓鱼：下饵被拒（${events.map((row) => row.reason ?? row.type).join('/')}）`);
      return;
    }
    write(message, next);
    await send(message, lines.join('\n'));
    log.info(`钓鱼：下饵（${next.baitLabel}）→ ${describeFishingState(next)}`);
  }

  /** 收杆:只有这一步才结算并问"怎么处理"。⚠️ 先落盘、再问模型(见文件头 ①)。 */
  async function reelIn(message, state, { auto = false } = {}) {
    const { state: next, events } = act('fishing.reel_in', state, { auto }, message);
    write(message, next);
    const empty = events.some((row) => row.type === 'fishing_reel_empty');
    const summary = events.find((row) => row.type === 'fishing_reeled')?.summary ?? null;
    if (empty) {
      // 空鱼篓那一条是**代码写死**的,不值得为它等一次模型
      await send(message, emptyReelText({ auto }));
      log.info('钓鱼：收杆（空）');
      return;
    }
    // ⚠️ 两种收杆都用 `'reel'` —— 与 1.64.0 一致(`auto_reel` 那个提示词分支至今是死代码)
    const text = await flavor('reel', {
      basket: summary?.basket ?? state.basket ?? [],
      summary,
      water: state.water,
      spot: state.spot,
    }, message);
    await send(message, [text, reelSummaryLine(state, summary)].filter((line) => line !== undefined && line !== '').join('\n'));
    log.info(`钓鱼：收杆 ${summary.count} 条，总值 ${summary.total} ${currency} → 等她选处置`);
  }

  /** 处置结算:数值由内核给,落账前**先落盘**(见文件头 ①)。 */
  async function settle(message, state, planOrHandling, { auto = false } = {}) {
    const plan = Array.isArray(planOrHandling)
      ? planOrHandling
      : [{ handling: planOrHandling, kinds: ['all'] }];
    const { state: next, events } = act('fishing.settle', state, { plan, auto }, message);
    const settled = events.find((row) => row.type === 'fishing_settled');
    write(message, next);
    if (!settled) {
      log.warn(`钓获处置没有结算（${events.map((row) => row.reason ?? row.type).join('/')}）`);
      return;
    }
    // ⚠️ "带回家风干"这类东西**现在还没地方放**(家园/典当铺是 D100 那一批的事)——
    //    内核如实列了出来,这里把它落成一笔**看得见的账**(`home_item`),别让它悄悄消失。
    //    面板与以后的 `/家` 都读它;`available:false` 就是"选是选了,箱子还没买"。
    writeHomeItems(settled.homeItems);
    const text = await flavor(
      'settle',
      {
        handlingLabel: settled.runs.map((run) => `${run.label}：${run.names}`).join('；'),
        basket: settled.summary.basket,
        water: state.water,
        spot: state.spot,
      },
      message,
    );
    try {
      const { event } = store.applyStoryResult(settled.effect, Date.now(), settled.detail, { sleep });
      log.info(
        `钓鱼：处置 ${settled.runs.map((run) => `${run.handling}(${run.count})`).join('+')} → ` +
        `钱 ${event.moneyDelta >= 0 ? '+' : ''}${event.moneyDelta}、饱食 ${event.satietyDelta >= 0 ? '+' : ''}${event.satietyDelta}（鱼篓 ${settled.summary.count} 条，值 ${settled.summary.total}）`,
      );
    } catch (err) {
      log.warn(`钓获处置失败: ${errText(err)}`);
    }
    await send(message, text);
  }

  /**
   * **到点那一拍**(tick 里跑,不看聊天):自己收杆 / 替她挑饵 / 上钩一条并接着钓 / 超时全卖。
   */
  async function tick() {
    let keys = [];
    try {
      // ⚠️ `listMetaKeys()` 返回对象数组(`{key,value,updatedAt}`)—— 取 `.key`
      keys = (store.listMetaKeys('fishing:') ?? []).map((row) => row.key);
    } catch (err) {
      log.warn(`列钓鱼状态失败: ${errText(err)}`);
      return;
    }
    for (const key of keys) {
      let state = null;
      try {
        const raw = store.getMeta(key);
        state = raw ? JSON.parse(raw) : null;
      } catch { state = null; }
      if (!state || !state.phase) continue;
      const parsedKey = parseFishingKey(key);
      const target = {
        scene: parsedKey.scene,
        targetId: parsedKey.targetId,
        senderId: parsedKey.userId,
        senderName: state.userName ?? null,
        messageId: undefined,
        content: '',
      };
      const { state: next, events } = act('fishing.tick', state, {}, target);
      const event = events[0] ?? { type: 'fishing_noop' };

      // ① 太久没人理 → 自己收杆回家。⚠️ 走**同一个** `reelIn`(它会落盘、会问模型、会发两句)
      if (event.type === 'fishing_reel_empty' || event.type === 'fishing_reeled') {
        await reelIn(target, state, { auto: true });
        continue;
      }
      // ② 还没选饵又过太久 → 替她挑一个(不能卡在第一步)
      if (event.type === 'fishing_cast') {
        write(target, next);
        await send(target, castMessage(next));
        log.info(`钓鱼：下饵（${next.baitLabel}）→ ${describeFishingState(next)}`);
        continue;
      }
      // ③ 到点 → 上钩一条,放鱼篓后**接着钓**(第一条 = 上钩,第二条 = 接着钓)
      if (event.type === 'fishing_caught') {
        write(target, next);
        const caught = await flavor(
          'catch',
          { ...event.catch, tierLabel: event.tierLabel, water: state.water, spot: state.spot },
          target,
        );
        await send(target, `${namePrefix({ userName: state.userName })}${caught ?? describeCatch(event.catch)}`);
        const keep = await flavor(
          'continue',
          { name: event.catch.name, count: next.basket.length, water: state.water, spot: state.spot },
          target,
        );
        await send(target, `${keep}（鱼篓 ${next.basket.length} 条 —— 说"收杆"吾就收拾东西。）`);
        log.info(`钓鱼：上钩 ${event.catch.tier}/${event.catch.name}（值 ${event.catch.money}）→ 接着钓`);
        continue;
      }
      // ④ 分鱼没回话 → 默认全卖(钱不会凭空消失)
      if (event.type === 'fishing_settled') {
        await settle(target, state, 'sell', { auto: true });
      }
    }
  }

  /**
   * **一句话进来时该不该由钓鱼接管**。返回 `true` = 已经处理掉了(调用方直接 return)。
   *
   * ⚠️ 判据口径(用户实测第 1 条:群友 @ 了两个 bot 都不回):**任何消息都不许被无声吃掉** ——
   *    每一步只在"这句话真的像那一步的回答"时才拦下,别的话**原样放过去走正常对话**。
   */
  async function handleMessage(message, { extra = {} } = {}) {
    const fishing = read(message);
    const text = message?.content ?? '';
    if (fishing) {
      // ⚠️ 每一句人话都刷新"最后互动时刻"(自动收杆看的就是它)
      const touched = { ...fishing, lastTouchAt: Date.now() };
      // ① 收杆(已经在分鱼了就不再收一次 —— 否则同一份鱼篓会被反复播报)
      if (detectReelIn(text)) {
        if (fishing.phase === 'choosing') {
          const options = handlingFor(fishing).map((row) => row.label).join(' / ');
          await send(message, `（已经收杆了，鱼篓还在脚边。${options} —— 说一声吾就处理。）`);
          log.info('钓鱼：已经在分鱼了，收到"收杆"就不再重复收(只提醒一次)');
          return true;
        }
        await reelIn(message, touched, extra);
        return true;
      }
      // ② 分鱼:一句话可以同时说好几类("鱼烤了、杂物扔了、值钱的留着");听不懂就**反问**
      if (fishing.phase === 'choosing') {
        const plan = parseHandlingPlan(text, handlingFor(fishing));
        if (plan) {
          await settle(message, fishing, plan, extra);
          return true;
        }
        if (looksLikeHandlingTalk(text)) {
          await send(message, unparsedHandlingLine(fishing));
          log.info(`钓鱼：没听懂处置「${String(text).slice(0, 20)}」，已反问`);
          return true;
        }
      }
      // ③ 选饵:只认"像回答的话"
      if (fishing.phase === 'bait' && looksLikeBaitAnswer(fishing, text)) {
        await cast(message, fishing, text);
        return true;
      }
      // ③b 库外的饵:看好感度答不答应(台词交给模型按自己角色的口吻写)
      if (fishing.phase === 'bait' && looksLikeBaitSuggestion(text)) {
        const name = extractBaitName(text);
        // ⚠️ 好感度是**另一个模块**的事(端口注入,别在这里 import 出第二份口径):
        //    默认"眼熟"= 最保守的 10% 概率,免得漏接端口时变成"谁都能钓"
        const tier = affinityTier(readAffinityScore(message));
        const judged = judgeCustomBait({ name: name ?? '', tierId: tier.id, random: extra.random ?? Math.random });        const line = await flavor(
          judged.accept ? 'bait_accept' : 'bait_refuse',
          { customBait: name ?? '那个东西', water: touched.water, spot: touched.spot, chance: judged.chance },
          message,
        );
        if (judged.accept) {
          const custom = { ...touched, baits: [judged.bait, ...touched.baits] };
          write(message, custom);
          await send(message, line);
          await cast(message, custom, judged.bait.label);
        } else {
          write(message, touched);
          await send(message, line);
          log.info(`钓鱼：不肯用「${name ?? '?'}」当饵（亲疏 ${tier.label}，概率 ${judged.chance}）`);
        }
        return true;
      }
      // ④ 其余情况:只刷新互动时刻(她的情景由提示词注入)
      write(message, touched);
    }
    if (detectFishing(text)) {
      if (fishing && fishing.phase !== 'choosing') {
        await send(message, alreadyFishingLine(fishing));
        return true;
      }
      await begin(message);
      return true;
    }
    return false;
  }

  return {
    begin, cast, reelIn, settle, tick, handleMessage,
    // 公开出来给测试与"她此刻在做什么"(提示词注入)用 —— 别再各写一份
    read, write, keyFor,
  };
}
