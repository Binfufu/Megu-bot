/**
 * 「连发合并」与「打字抖动」——两件让回复节奏像人的事(2026-09-30)。
 *
 * 为什么单独一个模块、而且是**纯函数**:这个项目的老规矩 —— 能变成纯逻辑的就
 * 别留在 `index.js` 的装配代码里(那个盲区真实咬过人,见 `docs\04` §6.4)。
 * "几秒内算连发""抖多久""提示词里怎么写这几条"全部可测;
 * 真正的计时器和 map 留在 `index.js` 里,它们只是这段规则的外壳。
 *
 * 起因是用户 2026-09-30 的现场感受:「私聊连发消息没有抖动,发多少回多少」。
 * 实测(`data\<bot>\memory.db` 的 `turn` 表):
 *
 * | | 轮数 | 上一条 10 秒内又来一条 | 她的回复延迟 中位 |
 * |---|---|---|---|
 * | 主实例 私聊 | 220 | **74/191 相邻对 = 38.7%** | **1.1s** |
 * | 主实例 群聊 | 772 | 6.7% | 1.3s |
 * | 副实例 私聊 | 69 | 15.2% | 1.6s |
 * | 副实例 群聊 | 305 | 3.1% | 1.5s |
 *
 * 也就是说:他发三句,她三句都秒回 —— 因为**私聊这条路既没有合并、也没有抖动**
 * (原来的 `QQBOT_KEYWORD_JITTER_MS` 只管群聊"被叫到名字"那一条路)。
 *
 * 两件的分工:
 *   · **连发合并**治"发三句回三次":等一小段安静期,把这几条**合成一轮**;
 *   · **打字抖动**治"秒回":模型答完先停一下再发出去(模拟打字要时间)。
 * 前者只在私聊做(群聊本来就有 `QQBOT_GROUP_DEBOUNCE_MS`,见 `docs\03` D53);
 * 后者私聊与群 @ 都做(被 @ 秒回同样是"不像人"的样子)。
 */

/**
 * 私聊「连发合并」窗口的默认值(毫秒,`QQBOT_C2C_DEBOUNCE_MS`)。
 *
 * 3000 是量出来的,不是拍的:同一份数据上按窗口模拟"本来各占一轮的条数会少多少" ——
 * 3 秒 → 主实例私聊少 22 轮(-10.0%);4 秒 → 少 27 轮(-12.3%);6 秒 → 少 36 轮(-16.4%);
 * 10 秒 → 少 74 轮(-33.6%)。**10 秒那档不能要**:它的代价是"每一条单发消息都晚 10 秒"。
 * 而 0~10 秒那 38.7% 的"连发"里,有相当一部分其实是**她回得太快**造成的
 * (间隔把回复也算了进去),所以合并窗口不该照着 38.7% 去设计。
 * 3 秒只吃掉"打字速度级别"的连发,单发消息只晚 3 秒。
 */
export const DEFAULT_C2C_DEBOUNCE_MS = 3000;

/**
 * 「打字抖动」的默认区间(毫秒,`QQBOT_REPLY_JITTER_MS`)。
 *
 * 判据是**观察到的总延迟**,不是这个区间本身:总延迟 = 模型时间 + 合并窗口 + 抖动。
 * 实测模型那段约 1.9s(中位,从日志的"收到消息 → 已回复"量出来),所以
 * 2~6 秒抖动 → 中位约 1.9 + 3 + 4 ≈ 8.9s。TWO 两只各自在 `.env` 里写得更细:
 * 主实例是人手打(慢一点),副实例是机器(快一点)。
 */
export const DEFAULT_REPLY_JITTER_RANGE = { minMs: 2000, maxMs: 6000 };

/** 提示词里给"连发的第 N 条"标注的时间跨度:只标到整数秒就够,别写成毫秒。 */
function formatSeconds(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return seconds.toFixed(1);
  return String(Math.round(seconds));
}

/**
 * 把同一段连发的几条消息,渲染成一个提示词块。
 *
 * 为什么要标时间:合并之后模型看到的是几行连着的话,它**默认会当成一个人一口气说的**,
 * 于是回答会把几句混在一起。标上「+3.2 秒」之后,"这是连着补的几句"是它看得见的事实
 * —— 这属于"事实由代码提供"那条分工(和情绪、数值同一个道理,见 `docs\03` D22/D28)。
 *
 * 单条时不加任何标注:那是绝大多数情况,不该为它多花一个 token。
 *
 * @param {Array<{text: string, at: number}>} items 按到达顺序;`at` 是毫秒时间戳
 * @param {string} [introduction] 拼在开头的一句说明(见 `mergeInstruction`)
 * @param {{maxChars?: number}} [options] 整体字数上限(保险丝,防病态长连发)
 * @returns {string} 提示词里的这段正文
 */
export function renderBurst(items, introduction = '', { maxChars = 1200 } = {}) {
  const list = (items ?? []).filter((item) => typeof item?.text === 'string' && item.text !== '');
  if (list.length === 0) return '';
  const first = Number.isFinite(list[0].at) ? list[0].at : 0;
  let body = list
    .map((item, index) => {
      if (index === 0) return item.text;
      const delta = (Number.isFinite(item.at) ? item.at : first) - first;
      return `（+${formatSeconds(delta)} 秒）${item.text}`;
    })
    .join('\n');
  if (body.length > maxChars) {
    // 只截尾巴:开头那几句往往是话题本身,截掉它比截掉补充说明更糟。
    body = `${body.slice(0, maxChars)}…（连发太长，后文已省略）`;
  }
  return introduction ? `${introduction}\n${body}` : body;
}

/**
 * 什么时候要在提示词里说明"这是几条连发的消息"。
 *
 * 单条 = 不说明(旧行为,一个字不多花)。这是纯函数,所以"合并了才说明"
 * 这条规则有测试盯着,不会在装配里被写错。
 */
export function mergeInstruction(count) {
  if (!(count > 1)) return '';
  return `（下面是你刚才连着的 ${count} 条消息，按时间顺序；回复当作一次说完，不要逐条答。）`;
}

/**
 * 这条消息该不该进「连发合并」的等待队列。
 *
 * 三条判据,合起来就是"这是一句要对她说的话":
 *   1. **私聊才有**(群聊的节奏由 `QQBOT_GROUP_DEBOUNCE_MS` 与抖动负责);
 *   2. **不是手势**(戳一戳/纯表情是反射,不是对话,它们有自己的路且不该被拖 3 秒);
 *   3. **不是命令**(`/…`)—— 命令要立刻执行:操作者打 `/撤回` 时等 3 秒没有道理,
 *      而且一条没被识别的 `/xxx` 也不值得为它冒"命令被合并进对话"的险。
 *
 * ⚠️ 判据用"以 / 开头"而不是"在命令表里":命令表在 `index.js` 里,而这份判断
 * 必须能在没有装配的情况下被测。代价是**未来新增的 `/查` 这类命令也自动秒走** ——
 * 那正是想要的方向。
 *
 * @param {{scene?: string, isPoke?: boolean, isFace?: boolean, content?: string}} message
 */
export function isMergeable(message) {
  if (message?.scene !== 'c2c') return false;
  if (message?.isPoke || message?.isFace) return false;
  return !String(message?.content ?? '').trim().startsWith('/');
}

/**
 * 从一次「打字抖动」的区间里掷一个毫秒数。
 *
 * `maxMs <= 0` = 关掉抖动(旧的秒回行为,留给"我要快"的场合)。
 * 上下界是**闭区间**(和 `parseJitterRange` 的语义一致),所以 `3000-3000` 是固定 3 秒。
 *
 * @param {{minMs: number, maxMs: number}} range
 * @param {() => number} [random] 注入随机源,便于测试取边界
 */
export function rollTypingDelay(range, random = Math.random) {
  const minMs = Math.max(0, Math.floor(range?.minMs ?? 0));
  const maxMs = Math.max(0, Math.floor(range?.maxMs ?? 0));
  if (maxMs <= 0) return 0;
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}

/**
 * 抖动期间来了新消息时,下一次尝试的退避时间。
 *
 * 为什么需要它:合并窗口到点时,同一个会话**可能正有一轮在跑**(用户刚发完她就答上了,
 * 紧接着又是一条)。这时既不能丢掉攒着的消息,也不能原地死循环重试 —— 所以按
 * 10s / 30s / 60s 退避,并给一个上限。上限存在的理由和"别硬撑"同一条:
 * 一条被反复推迟的消息,不如老实排一次队。
 *
 * @param {number} attempt 已经推迟过几次(从 0 开始)
 */
export function nextRecheckDelay(attempt) {
  const ladder = [10_000, 30_000, 60_000];
  return ladder[Math.min(Math.max(0, attempt), ladder.length - 1)];
}
