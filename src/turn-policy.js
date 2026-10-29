/**
 * **本轮任务策略**(P1,2026-10-28)—— 回答"这一轮该按什么口径交付"。
 *
 * ## 为什么要有这一层
 *
 * 现状是:角色卡写死"两句话/不列点",情绪层再压"25~45 字",随机风格还会塞
 * "只回一个很短的句子,别补第二句""先问清楚再回答""照字面理解,给个游戏式解释"。
 * 这些**合在一起**把"办事"挤没了:排错、对比、讲原理这类请求天然需要步骤与结构。
 *
 * 而且现有唯一的"任务例外"是**知识库命中才触发**的科普模式 —— 没命中资料的现实
 * 技术问题反而没有豁免,这是错的方向:知识库负责**供事实**,不该负责**准不准许把话说完**。
 *
 * ## 设计原则(两条,决定了它不会变成第二个 serious.js)
 *
 * 1. **只给权限,不下命令**:task/knowledge 的意思不是"必须长篇",而是"不受短句限制"。
 *    误判成 task 的代价 = 她可以多说两句;误判成 chat 的代价 = 又答不全。
 *    所以检测宁可保守,**失败的默认是 chat(维持现状)**,而不是强行改口吻。
 * 2. **平台无关**:纯文本输入、纯对象输出,不认识 QQ/网页/任何通道。
 *    通道只在**交付**时消费 `preserveFormatting`(P2),不参与判定。
 *
 * ## 与 serious.js 的分工
 *
 * `serious.js` 管**情绪安全**(重病/丧亲/灾难 → 收起花活);
 * 本模块管**交付形状**。两者正交:`解释一下癌症筛查原理` 是 **knowledge**,
 * 该按知识答,而不是被推成"短而真诚地安慰"。
 */

/** 三种口径。`chat` = 维持现状(闲聊)。 */
export const TURN_MODES = Object.freeze(['chat', 'task', 'knowledge']);

/**
 * 强知识词:**单独出现就够**(它们本身就指向"求解释/求事实")。
 * 「混合起来是什么」「解释一下癌症筛查原理」「有什么区别」都落在这里。
 */
const KNOWLEDGE_STRONG_RE = /是什么|什么意思|啥意思|什么原理|的原理|区别在|有什么区别|解释(一下|下)?|介绍(一下|下)?|科普|定义|概念|机制|工作原理|流程是/;

/** 弱知识词:**要配疑问形状**(「为什么你又这样说」是闲聊,不是求知)。 */
const KNOWLEDGE_WEAK_RE = /为什么|为啥|如何|怎么|有何|有哪些|多久|多少钱|几个|哪种|哪个/;

/** 办事:动作动词。命中即按 task 给权限(仍然只是"可以说完")。 */
const TASK_RE = /帮我|帮忙|给我|替我|列出|列举|罗列|写一(个|段|份|遍|下)|做个|做一(个|份)|分析|排查|修理|修复|解决|步骤|方案|代码|报错|异常|配置|对比|比较|总结|整理|翻译|计算|推导|设计|实现|优化|重构|调试|部署|规划|评估|检查|核对|梳理|拆解|给出|说明白|讲清楚/;

/** 结构信号:出现了这些,几乎不可能是随口闲聊 —— 直接 task(且要保真)。 */
const STRUCTURE_RE = /```|`[^`\n]+`|https?:\/\/|\{\s*"|\|.*\|.*\||^\s*(?:[-*·]|\d+[.、])\s/m;
const STRUCTURE_KEYWORDS = /JSON|json|正则|命令行|脚本|接口|API|SQL|sql|HTML|CSS|TypeScript|Python|函数|变量|堆栈|日志|报错码|环境变量/;

/** 追问:承接上一轮口径,别刚讲完三步就被拉回闲聊。 */
const FOLLOW_UP_RE = /^(?:第[一二三四五六七八九十\d]+[步条点项]|然后呢|然后|接着|继续|还有呢|再呢|那呢|说下去|往下说|详细点|具体点|展开)/;

/** 疑问形状:问号或句末语气词(把「为什么」这类泛词锁在有疑问形状的句子里)。 */
const QUESTION_SHAPE = /[？?]|(?:吗|呢|么|嘛)\s*$/;

/**
 * 这一轮属于哪种口径。**纯函数**;认不出 = `chat`(维持现状,不冒险)。
 *
 * @param {string} text 本轮**真实用户正文**(不含桥注入)
 * @param {{previous?: 'chat'|'task'|'knowledge'}} [options]
 *   `previous` = 同一会话上一轮的口径(用于追问继承)
 * @returns {{mode: string, reason: string, followUp: boolean, structural: boolean}}
 */
export function detectTurnMode(text, { previous = 'chat' } = {}) {
  const raw = String(text ?? '');
  const source = raw.trim();
  const prev = TURN_MODES.includes(previous) ? previous : 'chat';
  if (source === '') return { mode: 'chat', reason: 'empty', followUp: false, structural: false };

  const structural = STRUCTURE_RE.test(source) || STRUCTURE_KEYWORDS.test(source);
  if (structural && source.length >= 8) {
    // 带结构信号(代码块/URL/报错码/JSON 键值……)且不是一句寒暄 → 当成要办事。
    return { mode: 'task', reason: 'structural', followUp: false, structural: true };
  }
  if (TASK_RE.test(source)) {
    return { mode: 'task', reason: 'action-verb', followUp: false, structural };
  }
  const questionish = QUESTION_SHAPE.test(source);
  if (KNOWLEDGE_STRONG_RE.test(source) || (questionish && KNOWLEDGE_WEAK_RE.test(source))) {
    return { mode: 'knowledge', reason: 'knowledge-question', followUp: false, structural };
  }
  if (FOLLOW_UP_RE.test(source) && prev !== 'chat') {
    return { mode: prev, reason: 'follow-up', followUp: true, structural };
  }
  return { mode: 'chat', reason: 'default', followUp: false, structural };
}

/**
 * 各口径**允许**什么。注意全是 `allow*`,没有 `must*`。
 * @param {string} mode
 */
export function outputPolicyFor(mode) {
  const which = TURN_MODES.includes(mode) ? mode : 'chat';
  if (which === 'chat') {
    return Object.freeze({
      mode: 'chat',
      allowMoodLength: true,
      allowRandomNudges: true,
      allowStandingNotes: true,
      allowBehaviorNudges: true,
      preserveFormatting: false,
      allowEmoji: true,
      allowStructured: false,
    });
  }
  return Object.freeze({
    mode: which,
    // 办事/讲明白:短句与字数上限一律不注入(否则与技术内容天然冲突)。
    allowMoodLength: false,
    // 随机风格里有「只回很短」「先问清楚」「游戏式解释」——那些会**改答案**,不是改文风。
    allowRandomNudges: false,
    // 固定口语要求(短句/不用标点/不总结)也不注入:它们会把步骤写成碎句。
    allowStandingNotes: false,
    allowBehaviorNudges: false,
    // 交付不许做口语清理(P2 消费):代码缩进、JSON 冒号、命令分号都必须留着。
    preserveFormatting: true,
    allowEmoji: false,
    allowStructured: true,
  });
}

/**
 * 给这一轮的口径说明(会作为"表达要求"注入)。**chat 返回 null**(一个字都不加)。
 *
 * ⚠️ 措辞纪律:只说"允许/不受限",**不写字数、不写句数、不要求必须列点** ——
 *    一旦写成指标,就会变成新的模板(D22 同一族的教训:指标会被当成任务)。
 *
 * @param {string} mode
 * @returns {string|null}
 */
export function composeModeNote(mode) {
  if (mode === 'task') {
    return [
      '（本轮口径，照做但不要念出来：这是一次要把事办成/办完整的请求。）',
      '· 先直接回应他真正要的东西，再补必要的细节；不确定的地方如实说不确定，不要编。',
      '· 这一轮不受角色卡里「不超过两句话」「不列点」「不写小作文」的限制 ——',
      '  需要分步、列表、代码块、对比、链接时照用；格式跟着内容需要走。',
      '· 仍然是你的口吻与自称，但不要为了人设故意装不懂、也不要先反问再回答。',
    ].join('\n');
  }
  if (mode === 'knowledge') {
    return [
      '（本轮口径，照做但不要念出来：他在求一个解释/事实。）',
      '· 先一句话给结论，再补关键细节；资料不足或没有依据时直接说不知道，不要编。',
      '· 这一轮不受角色卡里「不超过两句话」「不列点」的限制；需要分点讲清楚时分点讲。',
      '· 你有现实世界的常识（技术、机器、电脑、网络这些你都懂），不要拿"资料里没有记载"挡正常问题。',
      '· 语气仍然是你的，但别用「先问清楚再回答」拖过整轮 —— 他问的是这个，就先答这个。',
    ].join('\n');
  }
  return null;
}

/**
 * **任务轮交付分组**(P2,2026-10-28)—— 保真交付时把长答案按**整行**预分组。
 *
 * ## 为什么必须在这一层分组,而不是直接整条扔给出站咽喉
 *
 * 出站 `chunkText` 固然优先换行边界,但 `sendSpokenLines` 的**被动槽位预算**(D289)
 * 是按 `planSpokenLines` 返回的**条数**算的:整条扔下去、咽喉切出 6 块,
 * msg_seq 就会到 6 —— 平台直接 40034128(fatal,整段丢)。
 * 所以按与 `chunkText` **同一个上限**(`config.policy.maxChars`)在这里预分组:
 * 每条 ≤ 上限、边界只会落在原本的换行上,条数交给既有"超限转主动"逻辑兜底。
 *
 * ## 保真判据(可测)
 *
 * `groups.join('\n') === 原文` —— 分组只**搬运**换行两侧的文本,不删、不改、不重排;
 * 超长单行(> 上限)单独成组不硬切(那是平台硬限制,由出站兜底,不属于本层职责)。
 *
 * @param {string} text 模型原始输出
 * @param {number} maxChars 与出站 `chunkText` 同一个上限
 * @returns {string[]} 每组一条消息;空输入 = []
 */
export function groupLinesForDelivery(text, maxChars) {
  const source = String(text ?? '');
  if (source.trim() === '') return [];
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 0;
  if (limit <= 0) return [source];
  const groups = [];
  let current = '';
  for (const line of source.split('\n')) {
    if (line.length > limit) {
      // 超长单行:先收掉攒着的组,再让它独占一条(不在这一层硬切)。
      if (current.trim() !== '') { groups.push(current); current = ''; }
      groups.push(line);
      continue;
    }
    if (current !== '' && current.length + 1 + line.length > limit) {
      groups.push(current);
      current = line;
    } else {
      current = current === '' ? line : `${current}\n${line}`;
    }
  }
  if (current.trim() !== '') groups.push(current);
  return groups;
}

/**
 * 几段注入到底要不要出现。**纯函数**,让"该关的关掉了"可测(不用把 index.js 切进 vm)。
 *
 * @param {string} mode
 * @param {{suppressMood?: boolean, suppressNudges?: boolean, note?: string|null}} seriousPolicy
 *   `turnPolicyFor()` 的返回(情绪安全那一层)
 */
export function noteGatesFor(mode, seriousPolicy = {}) {
  const out = outputPolicyFor(mode);
  return {
    includeMoodLength: out.allowMoodLength && seriousPolicy?.suppressMood !== true,
    includeRandomNudges: out.allowRandomNudges && seriousPolicy?.suppressNudges !== true,
    // 严肃场合的"短而真诚、别追问"是**安慰策略**;办事/讲知识那一轮不能用它顶替答案
    // (「解释一下癌症筛查原理」是知识请求,不是丧亲场面)。
    includeSeriousComfort: Boolean(seriousPolicy?.note) && mode === 'chat',
    includeModeNote: mode !== 'chat',
  };
}
