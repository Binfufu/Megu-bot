/**
 * **钓鱼回路**(D101 形态三;2026-10-02 用户实测后重做)。
 *
 * ⚠️ **2026-10-03(D105 第①步)**:判定与状态迁移**已经搬进 `src\play\fishing.js`**
 * (内核),这里**只留"为适配器服务"的那一半**:
 *   ① **给模型写台词的提示词 + 兜底**(`buildFishingFlavorPrompt` / `describeCatch`);
 *   ② **每轮注入给她的情景**(`describeFishingScene`);
 *   ③ **"人那句话算不算在提库外的饵"的判据**(`looksLikeBaitSuggestion` / `extractBaitName` /
 *      `judgeCustomBait`)—— ⚠️ 其中 `judgeCustomBait` **带概率**,它接受注入的 `random`,
 *      但适配器现在没传(走默认 `Math.random`)。
 *   ④ **对外的旧路径**:把内核那一批原样**转出去**,这样既有调用方与既有测试一字不用改
 *      (D105 的判据是"QQ 行为一字不变",少改一处就少一处回归面)。
 *
 * 新的代码请直接 import `src\play\` —— 那是两个前端(QQ 桥 / 小网站)共用的内核。
 * ⚠️ **第②③步要留意的两件事**(1.65.1 复核指出):库外饵那套判定**不在内核里**,
 *    所以小网站要么自己重写一份(会分叉),要么把它也搬进内核;**而它带随机数** ——
 *    搬的时候必须让 `random` 从 `ctx` 进来,否则"同一动作两次结果一样"就断了。
 *
 * 用户实测报的五条(这一版就是照它们改的):
 *   ① 「有个群友 @ 了两个 bot 都不回」→ **任何消息都不许被无声吃掉**:
 *      "选饵"那一步只认**像回答的话**(1/2/3、饵名、随便),别的原样放过去走正常对话;
 *   ② 「让她接着钓她不知道自己在钓鱼的情景里,要给角色提示词**固定写情景**」→
 *      `describeFishingScene()` **每轮**注入提示词;
 *   ③ 「**@ 用户好像是无效的**」→ 不再用 `<@!id>`,改成**在正文里点名**;
 *   ④ 「钓上了不同档位的东西要配套不同的处理方法,而且要**收杆之后**再结算询问处理方法」;
 *   ⑤ 「钓上第一次之后好像就断了……改成**过长时间不互动自动收杆**回家吃鱼」。
 *
 * 状态机(存在 `meta`,键 `fishing:<scene>:<targetId>:<userId>` —— **按人**,一个群可以多人同钓):
 *
 *     (无) --触发--> bait --选饵/超时--> waiting --到点--> (收一条,重新 waiting) …
 *                       ↑ 立刻给水域+钓点+饵                          │
 *                       └──────────── 说"收杆" / 太久没互动 ────────┘
 *                                              ↓
 *                                          choosing --选处置--> (无)
 */
import { FISHING_SPOTS } from './company.js';
import { TIER_LABELS } from './play/fishing.js';
import { CURRENCY } from './stats.js';

export {
  FISH_BAIT_TIMEOUT_MS,
  FISH_IDLE_TIMEOUT_MS,
  FISH_KEEP_TIMEOUT_MS,
  TIER_LABELS,
  addCatch,
  castLine,
  catchDue,
  describeFishingState,
  detectFishing,
  detectHandling,
  detectReelIn,
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
  pickBait,
  reelIn,
  rollCatch,
  settleBasket,
  settleBasketPlan,
  shouldAutoReel,
  startFishing,
  summarizeBasket,
  waitMs,
} from './play/fishing.js';

import { startFishing } from './play/fishing.js';

// ⚠️ 库外饵那三件(`judgeCustomBait` / `looksLikeBaitSuggestion` / `extractBaitName`)
//    **已经搬进内核** `src\play\fishing.js`(D109)。它们在下面 `export { ... }` 里转出,
//    这样旧调用方(与旧测试)一行都不用改,而第二个前端也能拿到**同一份判定**。

/**
 * **钓鱼各类播报的台词,交给模型写**(用户 2026-10-02:
 * 「每条播报的**内容要随机性更强,交给 llm 写**,比如等待计时结束卖鱼结算**不能每次都是一样的台词**,
 *   **烤鱼吃**等等都太简单了,让 llm 写点**简短的过程和感受**出来」)。
 *
 * ⚠️ 三条纪律不变:
 *   ① **数值仍然由代码给**(提示词里明说"不要报数字"),模型只写过程与感受;
 *   ② 每一类的提示词里要**换着花样**(随机给几个角度);
 *   ③ 兜底台词必须**能单独成立** —— 模型挂了也不会出现空消息。
 *
 * @param {'catch'|'continue'|'reel'|'settle'|'auto_reel'|'bait_accept'|'bait_refuse'} kind
 * @param {object} ctx 事实(catch/water/spot/basket/summary/handling…)
 * @param {() => number} [random]
 * @returns {{prompt: string, fallback: string}}
 */
export function buildFishingFlavorPrompt(kind, ctx = {}, random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length)] ?? list[0];
  const where = `${ctx.water ?? '河边'}${ctx.spot ? `的${ctx.spot}` : ''}`;
  // ⚠️ 用户 2026-10-02:「互动过程可以**经常有类似（主实例一边晃腿一边等你做决定）的
  //    简短带括号的旁白互动**」—— 所以**每一类**都要求带一个括号里的动作/神态。
  //    而且措辞**不许写死某个角色的口癖**(副实例那次串台就是"吾"进了她的嘴)。
  const scene = [
    '【系统】你现在在水边钓鱼,写**一两句**话发出去。',
    '要求:',
    '1. 用**你自己角色**的语气（不要用别的角色的口癖）；',
    '2. **带一个括号里的短旁白**,写你此刻的动作或神态,例如「（一边晃腿一边等着）」「（把鱼篓往脚边挪了挪）」；',
    '3. 不要报数字、不要提"系统/数值/概率";不要解释;不要提问求回应。',
  ].join('\n');

  if (kind === 'catch') {
    const angle = pick(['拉上来的过程', '手感和重量', '看到是什么东西时的反应', '差点跑掉的那一下']);
    return {
      prompt: [
        scene,
        `事实:你在${where}钓上来 **${ctx.name}**（${ctx.tierLabel ?? ctx.tier}）。`,
        `重点写**${angle}** —— 一到两句,别写成作文。`,
      ].join('\n'),
      fallback: describeCatch(ctx, {}),
    };
  }
  if (kind === 'continue') {
    return {
      prompt: [
        scene,
        `事实:你刚把${ctx.name}收进鱼篓,鱼篓里现在 ${ctx.count} 条。你**又甩了一竿**接着钓。`,
        pick([
          '写你把饵重新甩出去、继续等的样子,一到两句。',
          '写你换了换姿势、盯着浮标,一到两句。',
          '写你顺手把鱼篓挪了挪、又坐回去,一到两句。',
        ]),
      ].join('\n'),
      fallback: '（把饵又甩了出去）接着钓。',
    };
  }
  if (kind === 'reel') {
    const list = (ctx.basket ?? []).map((row) => row.name).join('、');
    return {
      prompt: [
        scene,
        `事实:你收杆了。今天钓到:${list}（一共 ${ctx.summary?.count ?? 0} 件，大概值 ${ctx.summary?.total ?? 0} ${CURRENCY.name}）。`,
        '写你把家伙收拾起来、拎着鱼篓的样子,一两句;然后**顺便说一句怎么处理**（吃什么/卖/带回家）。' +
        '不要报钱数。',
      ].join('\n'),
      fallback: `收杆了。鱼篓里：${list}。`,
    };
  }
  if (kind === 'settle') {
    return {
      prompt: [
        scene,
        `事实:你决定了——**${ctx.handlingLabel}**（${(ctx.basket ?? []).map((row) => row.name).join('、')}）。`,
        '写这一小段的过程和感受(比如架火、下锅、拎去市场、挂起来风干),一到两句。' +
        '**不要**报数字、不要总结成"完成了"。',
      ].join('\n'),
      fallback: `${ctx.handlingLabel}，回去了。`,
    };
  }
  if (kind === 'bait_accept' || kind === 'bait_refuse') {
    const yes = kind === 'bait_accept';
    return {
      prompt: [
        scene,
        `事实:对方提议**用「${ctx.customBait}」当鱼饵**。你${yes ? '**答应了**' : '**不太想用**'}。`,
        yes
          ? '写你答应下来、顺手把那个东西挂上钩的样子,一到两句。'
          : '写你不乐意的样子、并且顺手改成自己挑的饵,一到两句 —— **别翻脸**,可以嘴硬。',
        '**不要**提"概率""亲疏""好感"这类词。',
      ].join('\n'),
      fallback: yes ? '（把饵挂上钩）行吧，就试试你这个。' : '（挑了自己的饵）换一个吧，不太信这个。',
    };
  }
  // auto_reel:太久没人理,自己收杆回家
  return {
    prompt: [
      scene,
      `事实:半天没人说话,你自己收杆了。鱼篓里 ${ctx.summary?.count ?? 0} 件。`,
      '写你收杆回家、准备吃鱼的样子,一到两句。可以带一点没人陪的嘀咕。',
    ].join('\n'),
    fallback: '（收起竿）没人搭话，收杆回去了——回家吃鱼。',
  };
}

/**
 * 上钩那一条要说的话(**兜底台词**;正常情况下由模型写,见 `buildFishingFlavorPrompt`)。
 * **@ 已砍掉** —— 要不要点名由调用方用 `namePrefix()` 加在正文前。
 */
export function describeCatch(catchRow) {
  const head = catchRow.kind === 'junk'
    ? `上钩了……结果是${catchRow.name}。`
    : catchRow.kind === 'legend'
      ? `竿子差点被拽进水里——是**${catchRow.name}**！`
      : catchRow.kind === 'treasure'
        ? `这一竿沉得吓人——**${catchRow.name}**！`
        : catchRow.kind === 'rare'
          ? `上钩了！${catchRow.name}，居然不是鱼。`
          : `上钩了！${catchRow.name}${'，还挺大'}`;
  const worth = catchRow.money > 0 ? `（大概值 ${catchRow.money} ${CURRENCY.name}）` : `（一文不值）`;
  return `${head}${worth}`;
}

/**
 * **给角色提示词的情景**（用户②:「要给角色提示词**固定写情景**,至少有知道现在在哪里的意识」）。
 *
 * 这是"她知道自己正在钓鱼"的唯一来源 —— 每一轮都注入,所以哪怕中间聊了别的,
 * 她也**始终**知道自己在哪个水边、还有多久有动静、鱼篓里有几条。
 */
export function describeFishingScene(state, now = Date.now()) {
  if (!state) return null;
  const caught = (state.basket ?? []).length;
  const where = `你正在**${state.water}**的**${state.spot}**钓鱼`;
  if (state.phase === 'bait') {
    return `${where}（刚找好地方，鱼饵还没挂上：${state.baits.map((row) => row.label).join(' / ')}）—— ` +
      '有人问起就说你在钓鱼;别自顾自开始报账。';
  }
  if (state.phase === 'waiting') {
    const left = Math.max(1, Math.round(((state.dueAt ?? now) - now) / 60_000));
    const basket = caught > 0 ? `，鱼篓里已经有 ${caught} 条` : '';
    return `${where}，用的是${state.baitLabel}，**浮标还没动静**（大概还要 ${left} 分钟）${basket}。` +
      '你人在水边、手上拿着竿 —— 这一轮无论聊什么，都**先是个在钓鱼的人**（可以一边聊一边盯着浮标）。';
  }
  if (state.phase === 'choosing') {
    const list = (state.basket ?? []).map((row) => row.name).join('、');
    return `你刚收杆，鱼篓里是：${list}。正等着对方说怎么处理（吃/卖/带回家）。`;
  }
  return null;
}

/** 给"小网站/报表"用的一句话现状(和内核那份同一套口径,只是多带地点明细)。 */
export function fishingSpotLabel(state) {
  const spot = FISHING_SPOTS.find((row) => row.water === state?.water && row.spot === state?.spot);
  return spot ? `${spot.water}的${spot.spot}` : (state ? `${state.water}的${state.spot}` : '');
}
