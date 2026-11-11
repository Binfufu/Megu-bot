/**
 * 「关于人的事实」的抽取规则(2026-10-01,见 `docs\03` D79)。
 *
 * ## 为什么要有这一层
 *
 * 用户 2026-10-01 定的四个维度:**关系 / 偏好 / 雷区 / 健康**,而且**两个入口**:
 *   ① **早期会话浓缩检测关键词**(把历史翻一遍,挖出来);
 *   ② **用户主动告知**(他说的、或者群里 @ 一次带标签)。
 *
 * 它们既不是"标签"(那是**检索用的派生数据**),也不是"某一轮说过的话"(那是 `memory.db`),
 * 而是**关于这个人的事实** —— 所以存在 `state.db` 的 `fact` 表里(和 `person` 同一套作用域)。
 *
 * ## 一条硬规矩
 *
 * 抽取**全靠代码**(词表 + 正则),不靠模型"帮忙总结"。理由是这个项目的第四条判据:
 * **词表由代码固定,模型只能提议**。挖矿脚本是"提议",用户告知是"拍板",两者都进同一张表。
 *
 * ## 三种来源(source)
 *
 * | source | 谁来 | 例子 |
 * |---|---|---|
 * | `told` | 他当场说的 | 「我胃不好,不能喝冰的」 |
 * | `declared` | 群里 @ 一次带标签 | 「@小明 这是我**朋友**」 |
 * | `mined` | 挖矿脚本从历史里挖的(**先打印给人看**) | 早期会话里的「我痔疮又犯了」 |
 *
 * ⚠️ 涉及**她本人**的关系主张(「我是你哥」「你是我老婆」)不在这里直接落库:
 * 那条要**按角色设定由她自己决定认不认**(见 `src/index.js` 的 `<accept>` 协议)。
 */

import { SERIOUS_CATEGORIES } from './serious.js';
import { ageLabel } from './time-label.js';

// 兼容旧导入:健康行/恢复提示仍在用同一个实现(D159:时间口径只写一处)。
export { ageLabel };

/** 五个维度。`relation` 关系 / `name` 名字 / `preference` 偏好 / `dislike` 雷区 / `health` 健康。 */
export const FACT_KINDS = Object.freeze(['relation', 'name', 'preference', 'dislike', 'health']);

/**
 * 亲属与关系词。
 * ⚠️ 顺序有讲究:长的排前面,否则「女朋友」会被「朋友」先吃掉。
 */
export const RELATION_WORDS = Object.freeze([
  '女朋友', '男朋友', '未婚妻', '未婚夫', '老公', '老婆', '对象', '伴侣',
  '闺蜜', '发小', '室友', '同学', '同事', '上司', '老板', '徒弟', '师父', '师傅',
  '表哥', '表姐', '表妹', '堂哥', '堂姐', '堂弟', '堂妹', '干爹', '干妈',
  '爸爸', '妈妈', '老爸', '老妈', '父亲', '母亲', '哥哥', '姐姐', '弟弟', '妹妹',
  '儿子', '女儿', '爷爷', '奶奶', '外公', '外婆', '亲戚', '家人', '朋友', '好友', '老师', '学生',
]);

/** 偏好:喜欢这一侧。 */
const LIKE_WORDS = ['喜欢', '最爱', '最喜欢', '超爱', '爱吃', '爱喝', '偏爱', '中意', '想要', '最爱吃'];
/** 雷区:讨厌这一侧(含祈使否定 —— 那是最明确的"别这么干")。 */
const DISLIKE_WORDS = ['讨厌', '不喜欢', '不吃', '不喝', '受不了', '恶心', '反感', '忌讳'];
const FORBID_WORDS = ['别叫', '不要叫', '不准叫', '别喊', '不准提', '别提', '不许提', '别问', '不许问', '别碰', '不准碰', '禁止', '别再说', '不要再'];

/**
 * 健康:三类分开放,因为**时效完全不同**(慢性病是长期事实,感冒是几天的事)。
 * `detail` 记的是 `chronic` / `short` / `mental`。
 */
export const HEALTH_WORDS = Object.freeze({
  chronic: ['胃炎', '胃病', '胃溃疡', '胃不好', '肠胃不好', '痔疮', '鼻炎', '咽炎', '哮喘', '过敏',
    '高血压', '低血压', '糖尿病', '失眠', '偏头痛', '颈椎', '腰椎', '痛风', '湿疹', '胆结石', '肾结石',
    '贫血', '心脏病', '老毛病'],
  short: ['感冒', '发烧', '发热', '咳嗽', '嗓子疼', '拉肚子', '腹泻', '肚子疼', '胃疼', '头疼', '头晕',
    '中暑', '受伤', '崴脚', '落枕', '牙疼', '上火', '阳了'],
  mental: ['焦虑', '抑郁', 'emo', '压力大', '社恐', '内耗', '崩溃', '躁郁', '强迫症', '多动', '创伤'],
});

/**
 * 「被凶/被骂」的信号词。
 *
 * 用户说「雷区可以在被骂的时候提取」—— 但**骂人的话本身不是雷区**,它只是"这一轮很不高兴"的证据。
 * 所以这里只做两件事:①把这一轮标成"被凶过"(提高它的固化分);
 * ②如果同一句里**有明确的否定**,那条否定才是雷区(走 `FORBID_WORDS` / `dislike`)。
 */
const HOSTILE_WORDS = ['傻', '蠢', '笨', '滚', '闭嘴', '烦人', '烦死', '废物', '垃圾', '贱', '妈的',
  '操你', '去死', '神经病', '有病', '讨厌死', '没用', '废物点心', '狗东西'];

/** 一句话里有没有"他很不高兴"的证据(纯函数;不判断对象,别猜)。 */
export function isHostile(text) {
  const haystack = String(text ?? '');
  return HOSTILE_WORDS.some((word) => haystack.includes(word));
}

/**
 * **"他叫什么"** —— 从一句人话里抽出"她该用的那个名字"(纯函数,2026-10-09)。
 *
 * ⚠️ 为什么单独一条(用户当天报的现场):「@某个群友让她记群友名字她也记不住(都记在我身上)」。
 *    查下来三层都缺:① 提示词只说"谁在说话",**从不写"这条 @ 了谁"**;
 *    ② `learnFactsFrom()` 里 `subject = message.senderId` —— **事实永远挂说话人头上**;
 *    ③ `extractFacts()` 里**没有"名字"这一类**(实测 `extractFacts('记住 这个人，名字叫江时光')` → `[]`)。
 *
 * ⚠️⚠️ **2026-10-09 第二次修(第一版漏了最口语的形状)**:用户真跑了一次,
 *    他在群里 `@波风水门` 然后打的是 **`记住 叫泄政章`** —— 第一版的模式要求"他/她 + 叫",
 *    于是 `extractNameTell('记住 叫泄政章')` → `null`,**名字一条都没落库**。
 *    现在补上"**只要有人明确在教她名字,句子里那个"叫/是"后面的东西就是名字**":
 *    `记住 叫X` / `他叫X` / `名字叫X` / `名字是X` / `管他叫X` / `他名字X` / `我叫X`。
 *
 * ⚠️ 仍然**不许**把问句当真名字(「他叫什么?」),而且只取"叫/是"后面那一小段,
 *    要求它**像一个名字**(1~12 字、不含标点/空格)。「叫住他」「叫了一声」不会命中。
 *
 * @param {string} text 人说的话(不要带桥自己的注入行)
 * @returns {{value: string, self: boolean}|null}
 *   `self` = 这个名字是**说话人自己**的(`我叫X`),不是第三个人的。
 */
/**
 * **不是名字**的常见说法(2026-10-09 真跑踩到):用户在群里 @ 她之后打「**叫名字**」考她,
 * 而"名字"本身被当成了一个名字存进库里(`fact: name=名字`)。同类还有:
 * 名字 / 大名 / 昵称 / 什么名字 / 啥名字 / 得用 …(最后一个是「记住 叫得用」那种半句话)。
 */
const NOT_A_NAME = /^(名字|姓名|大名|全名|昵称|网名|外号|称号|叫法|称呼|什么|啥|谁|哪个|什么名字|啥名字|什么大名|叫啥|这个|那个|一下|一句|一遍|一声|住|了|一|上|来|出|开|起|停|好|完|错|对|着|过)$/;

/** 一个候选值够不够格当"她该用的名字"(纯函数,单测钉住)。 */
export function isPlausibleName(raw) {
  const value = String(raw ?? '').trim().replace(/[的了\s\u3000]+$/, '');
  if (value === '') return false;
  if (NOT_A_NAME.test(value)) return false;
  // ⚠️ 「叫住他」「叫了一声」→ 后面接的是动词/语气词,不是名字(实测踩到)
  if (/^(住|了|一|上|来|出|开|起|醒|停|好|完|错|对|着|过|我|你|他|她|它|啥|谁|什么)/.test(value)) return false;
  if (/[吗呢吧啊哦嗯嘛]$/.test(value)) return false;
  if ([...value].length > 8) return false;
  return true;
}

/**
 * 同一个"叫"在文中的**上下文**里有没有疑问 —— 有就不是命名句。
 * 只看"叫"后面 6 个字:「叫什么名字」→ 有"什么"、「叫啥」→ 有"啥"。
 * ⚠️ **不在这里判"我"**:那是**自己那条**模式的事(`self` 由匹配到哪条模式决定),
 *    两件事混在一起会把「我叫小明」也挡掉(2026-10-09 写完立刻被单测抓到)。
 */
function nameContextIsBad(source, index) {
  const after = source.slice(index, index + 6);
  return /什么|啥|谁|哪|怎么|吗|呢|名字/.test(after);
}

/**
 * **所有**命名句(纯函数,2026-10-09 第三次修)。
 *
 * ⚠️ 为什么从"一个"改成"一串":用户真跑时一条消息里教了**两个**名字
 * (`记住 叫河蟹，\n记住 叫得用`)——旧实现只取第一个匹配,第二个**静默丢掉**。
 *
 * ⚠️ 也别把"考她"当成命名:他那句「我考考你,叫什么名字」被 `extractFacts` 的
 * `IDENTITY_QUESTION` 挡过一次,但**名字这一路**没有对应的挡法 —— 所以这里按"叫"的上下文判
 * (前后 3~6 个字里有"什么/啥/谁/吗"或"我"),而不是只看整句是不是问句。
 *
 * @returns {Array<{value: string, self: boolean}>}
 */
export function extractNameTells(text) {
  const source = String(text ?? '').trim();
  if (source === '') return [];
  const patterns = [
    // 「我(的名字)叫X」= 说话人自己(`self: true`,不走疑问上下文判据 —— "我"是主体,不是疑问)
    { re: /(?:^|[，。！？\s])(?:我)(?:的名字)?(?:就|是)?(?:叫|叫做)\s*([^\s，。！？、,.!?]{1,12})/g, self: true },
    { re: /(?:名字|大名|昵称)(?:就)?(?:是|叫|叫做)\s*([^\s，。！？、,.!?]{1,12})/g },
    { re: /(?:他|她|它|ta|TA|这个人|那家伙|这位)(?:的名字)?(?:就|是)?(?:叫|叫做)\s*([^\s，。！？、,.!?]{1,12})/g },
    { re: /管(?:他|她|它|ta|TA|这个人|那家伙)(?:的名字)?(?:叫|叫做)\s*([^\s，。！？、,.!?]{1,12})/g },
    { re: /(?:叫|叫做)\s*(?:他|她|它|ta|TA)\s*([^\s，。！？、,.!?]{1,12})/g },
    { re: /(?:叫|叫做)\s*([^\s，。！？、,.!?]{1,12})/g },
    { re: /(?:他|她|它|ta|TA|这个人|那家伙|这位)(?:的名字|名字)\s*([^\s，。！？、,.!?]{1,12})/g },
    { re: /(?:这位|这个人)(?:就)?是\s*([^\s，。！？、,.!?]{1,12})/g },
  ];
  const out = [];
  const seen = new Set();
  for (const { re, self } of patterns) {
    for (const match of source.matchAll(re)) {
      const raw = String(match[1] ?? '');
      if (!isPlausibleName(raw)) continue;
      // ⚠️ 疑问上下文只挡**非自称**那几条:「我叫小明」里的"我"是主体,不是疑问。
      const at = typeof match.index === 'number' ? match.index + match[0].lastIndexOf(match[1]) : -1;
      if (!self && at >= 0 && nameContextIsBad(source, at)) continue;
      const value = raw.trim().replace(/[的了\s\u3000]+$/, '');
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ value, self: self === true });
    }
  }
  return out;
}

/**
 * 一个命名句(向后兼容的老入口)。新代码请用 `extractNameTells()`。
 * @returns {{value: string, self: boolean}|null}
 */
export function extractNameTell(text) {
  const source = String(text ?? '').trim();
  if (source === '' || isQuestion(source)) return null;
  // 「我」开头的那一句算 self(老行为),其余算第三个人
  const selfMatch = /(?:^|[，。！？\s])(?:我)(?:的名字)?(?:就|是)?(?:叫|叫做)\s*([^\s，。！？、,.!?]{1,12})/.exec(source);
  if (selfMatch && isPlausibleName(selfMatch[1])) {
    return { value: String(selfMatch[1]).trim(), self: true };
  }
  const tell = extractNameTells(source)[0];
  return tell ? { value: tell.value, self: false } : null;
}

/**
 * **这一轮学到的名字该记在谁名下**(纯函数,2026-10-09 第三次修)。
 *
 * 为什么独立出来:第一、二次修的时候"名字挂给谁"这段判断住在 `index.js` 的 `learnFactsFrom()` 里,
 * **测不到**(那是 `main()` 的装配段)—— 于是同一个形状漏了两次。现在这段是纯函数,能用真实形状钉住。
 *
 * 规则(**宁可漏,不猜**):
 *   · `self`(「我叫X」)→ 说话人自己(私聊里主体是 `'self'`);
 *   · 群里 @ 了**别人** → 记在那个人的 openid 下;
 *   · 群里**没 @**、但话里提到了**名册里某个人的昵称**(「昵称带波风水门那个叫X」)→ 记给那个人;
 *     ⚠️ 只认**名册里已有的昵称**(那是我们观察到的,不是猜的),而且**命中多个人就不记**;
 *   · 其余 → **不记**(「他」没有指代对象 —— 这正是"记在说话人头上"那个坑)。
 *
 * @param {object} message 入站消息(`scene` / `senderId` / `mentions` / `content`)
 * @param {Array<{openid: string, display?: string|null}>} [roster] 这个群的名册(`person` 表)
 * @returns {Array<{value: string, self: boolean, subject: string, reason: string}>}
 */
export function resolveNameTeach(message = {}, roster = []) {
  const isGroup = message?.scene === 'group';
  const sender = String(message?.senderId ?? '').trim();
  if (sender === '') return [];
  const tells = extractNameTells(message?.content ?? '');
  if (tells.length === 0) return [];
  // ⚠️ **私聊里的主体一律是 `'self'`** —— 私聊的关系/偏好/健康历史上都挂这把键(库里现存 3 条),
  //    名字若另起 openid 那把键,`factsNote` 就查不到自己的名字(端到端验证抓到)。
  const subjectForSelf = isGroup ? sender : 'self';
  const mentioned = isGroup
    ? (message?.mentions ?? []).find((entry) => entry && entry.id && entry.bot !== true && entry.id !== sender)
    : null;
  // 群昵称可能是**不可见字符**(库里真有),先滤掉再拿来比对
  const visible = (raw) => {
    const text = String(raw ?? '').trim();
    return text === '' || !/[^\s\u200B-\u200D\uFEFF\u3164\uFFA0\u115F\u1160]/.test(text) ? '' : text;
  };
  /** 话里提到的**名册里的人**(exact → 昵称整串出现;否则取**最长**的那个命中,多长一样就不猜)。 */
  const byNickname = (content) => {
    const text = String(content ?? '');
    const exact = (roster ?? []).filter((row) => visible(row?.display) && visible(row.display) === text);
    if (exact.length === 1) return { openid: String(exact[0].openid), how: '昵称整句就是它' };
    const hits = (roster ?? [])
      .filter((row) => {
        const name = visible(row?.display);
        return name.length >= 2 && text.includes(name);
      })
      .sort((a, b) => visible(b.display).length - visible(a.display).length);
    if (hits.length === 0) return null;
    // ⚠️ **最长优先**并且要求它是**严格最长**:短昵称(比如有人就叫「江」)会到处乱命中 ——
    //    实测:「江和江林都叫阿光」同时命中「江」和「江林」,取长的才对;长度相同就**不猜**。
    const top = visible(hits[0].display);
    if (hits.length > 1 && visible(hits[1].display).length === top.length) return null;
    return { openid: String(hits[0].openid), how: `话里提到了昵称「${top}」` };
  };
  const out = [];
  for (const tell of tells) {
    if (tell.self) {
      out.push({ value: tell.value, self: true, subject: subjectForSelf, reason: '他自己说的名字' });
      continue;
    }
    if (!isGroup) {
      out.push({ value: tell.value, self: false, subject: 'self', reason: '私聊里"他"就是他本人' });
      continue;
    }
    if (mentioned) {
      out.push({ value: tell.value, self: false, subject: String(mentioned.id), reason: `@ 到的是 ${mentioned.username ?? '（没给昵称）'}` });
      continue;
    }
    const byName = byNickname(message?.content ?? '');
    if (byName) {
      out.push({ value: tell.value, self: false, subject: byName.openid, reason: byName.how });
      continue;
    }
    out.push({ value: tell.value, self: false, subject: '', reason: '群里没 @ 到别人、也没提到名册里的昵称，"他"没有指代对象 → 不记' });
  }
  return out;
}

/**
 * 从一段人话里抽事实。**纯函数**。
 *
 * @param {string} text 人说的话(不要带桥自己的注入行)
 * @param {{subject?: string}} [options] 这条事实关于谁(openid / `self`)
 * @returns {Array<{kind: string, value: string, detail: string|null}>}
 */
/** 问句不是陈述 —— 「你喜欢我吗」不是一条偏好,「那我算你的父亲吗」也不是关系。 */
export function isQuestion(text) {
  const source = String(text ?? '').trim();
  // ⚠️ 尾巴上允许跟一个逗号:按小句切分之后,「为什么大家都讨厌懒惰的人呢，」这一句
  //    后面接的是逗号而不是句号 —— 只认"以吗/呢结尾"会把它当成陈述(实测踩到)。
  return /[？?]/.test(source) || /[吗呢][，。！!？?…、]*$/.test(source);
}

/** 抽出来的尾巴要在**标点处断掉** —— 否则「别叫我小名，我不喜欢」会整句变成雷区的值。 */
function tailAfter(source, index, word) {
  const raw = source.slice(index + word.length).replace(/^[的了\s\u3000]+/, '');
  return raw
    .split(/[，。！？；、,.!?;\n]/)[0]
    .replace(/[…—~～\-\u3000]+$/, '')
    .replace(/^[…—~～\-\u3000]+/, '')
    .trim()
    .slice(0, 12);
}

/** 偏好/雷区的值要**像一个东西**,不是半句话(实测踩过:「被含着 → 听我说——((」这种)。 */
function looksLikeThing(value) {
  if (value.length < 2 || value.length > 12) return false;
  if (/[（(）)【】《》"'“”]/.test(value)) return false;
  if (/^(我|你|他|她|的|了吗呢啊哦嗯)$/.test(value)) return false;
  return true;
}

/**
 * 关系词要落在**领属框架**里才算数:「我弟弟」「他的朋友」「这是我朋友」。
 *
 * ⚠️ 实测踩到:「你打群怪就是**弟弟**」—— 那是骂人话(菜),不是亲属关系。
 * 只认框架能挡掉它,而且不会误伤真的陈述。
 */
function relationFramed(source, word) {
  return new RegExp(`(我|俺|他|她|你)(的)?${word}`).test(source)
    || new RegExp(`(是|就是|算|当)(我|俺)的?${word}`).test(source);
}

/**
 * 涉及**她自己**的关系主张(「我是你哥」「你是我老婆」「以后叫我主人」)。
 *
 * ⚠️ 这一族**不在这里落库**:用户 2026-10-01 定的是"**按角色设定和记忆决定同不同意**,
 * 同意就记住"。所以它交给 `src/index.js` 走 `<accept>` 协议(和 `<intake>` 同一个套路):
 * 桥把主张塞进提示词,她认了就在回复末尾带一个标记,桥解析到才写事实。
 *
 * @returns {{relation: string}|null}
 */
const CLAIM_SELF_PATTERNS = [
  /我是你的?([\u4e00-\u9fff]{1,4})/,
  // ⚠️ 中间允许插几个字:「你**以后**是我的老婆」「你**现在**就是我的人了」。
  /你[^，。！？\n]{0,6}是我的?([\u4e00-\u9fff]{1,4})/,
  /以后叫我([\u4e00-\u9fff]{1,4})/,
  /叫我([\u4e00-\u9fff]{1,4})就行/,
];

export function detectClaimAboutSelf(text) {
  const source = String(text ?? '');
  for (const pattern of CLAIM_SELF_PATTERNS) {
    const match = pattern.exec(source);
    if (!match) continue;
    return { relation: match[1] };
  }
  return null;
}

/**
 * 她认下一条关系主张时用的标记(和 `<intake>` 同一个套路)。
 *
 * 提示词里写死格式,回复里解析 —— **同意才落库**,不同意就一个字都不记。
 * 之所以要这一步:用户 2026-10-01 定的是"**按角色设定和记忆决定同不同意**",
 * 而"认不认这个人当哥"是**人格决定**,不该由桥替她拍。
 */
const ACCEPT_PATTERN = /<accept\s+relation\s*=\s*"([^"]{1,8})"\s*\/?>/;

export function extractAccept(text) {
  const source = String(text ?? '');
  const match = ACCEPT_PATTERN.exec(source);
  if (!match) return { relation: null, text: source };
  return { relation: match[1], text: source.replace(ACCEPT_PATTERN, '').replace(/[ \t]+$/gm, '').trim() };
}

// ---------------------------------------------------------------------------
// 健康语义识别(C 刀 A,2026-11-11;现场 = 2026-11-02 的"旧胃疼回流")
//
// 旧实现只做 `source.includes(word)`,于是这一层同时有四个洞:
//   ① 否定照收:「我不胃疼了」「我没有胃疼」都被记成**正在胃疼**(而且会刷新 last_seen);
//   ② 问句照收:「你胃疼吗?」「是不是胃疼」被记成他自己的病;
//   ③ 第三人照收:「他胃疼」挂在说话人自己头上(私聊里 subject 恒为 self);
//   ④ 恢复抽不出来:「我胃已经不疼了」「我没事啊」→ [],旧行永远不退役。
//
// 所以先判**这一小句**的语义,再决定记什么:
//   · polarity = active(本人自述仍在)/ resolved(本人说已经好了)/ refuted(本人否认);
//   · subject   = self(本人)/ other(你/他/她/他们)/ unknown(句子里没有指代);
//   · question  = 这一小句是不是问句。
// ⚠️ 仍然**只认词表里的症状**:这里不假装理解所有中文,认不出就不记(宁可漏,不猜)。
// ---------------------------------------------------------------------------

/** 健康事实的当前状态(存进 fact.state;NULL = 老行,按旧口径读)。 */
export const HEALTH_STATE = Object.freeze({
  ACTIVE: 'active',
  RESOLVED: 'resolved',
  REFUTED: 'refuted',
});

/** 这些是"长期背景"的健康档位 —— 不套短期有效期,但也不等于"现在正在发作"。 */
export const HEALTH_BACKGROUND_DETAILS = Object.freeze(['chronic', 'mental', 'serious']);

/** 症状词后面跟这些 = 本人说已经好了(而不是"还在疼")。 */
const HEALTH_RECOVERY_AFTER = /(已经|早就|终于)?(好了|好多了|不疼了|不痛了|没事了|没了|缓解|痊愈|治好了|过去了)/;
/** 症状词前面跟这些 = 否定(我没有胃疼 / 我不胃疼了)。 */
const HEALTH_NEGATION_BEFORE = /(不|没|没有|无|不是|不再|并不)$/;
/**
 * 身体部位 + "不疼了" 的恢复说法:句子里**没有**完整的症状词也要认出来。
 * (「我胃已经不疼了」里没有「胃疼」这两个连续字,旧的 includes 永远抽不到。)
 */
const BODY_RECOVERY = Object.freeze([
  { re: /胃(也|都|已经|现在|早就|一直)?(不|不再)(疼|痛|难受)/, value: '胃疼', detail: 'short' },
  { re: /(肚子|腹)(也|都|已经|现在|早就|一直)?(不|不再)(疼|痛|难受)/, value: '肚子疼', detail: 'short' },
  { re: /头(也|都|已经|现在|早就|一直)?(不|不再)(疼|痛)/, value: '头疼', detail: 'short' },
  { re: /嗓子(也|都|已经|现在)?(不|不再)(疼|痛)/, value: '嗓子疼', detail: 'short' },
  { re: /牙(也|都|已经|现在)?(不|不再)(疼|痛)/, value: '牙疼', detail: 'short' },
]);
/**
 * 没有症状词的「我没事 / 已经好了」。
 * ⚠️ 只认**整小句就是这句**的形状:否则「好了,走吧」也会被当成"病好了"。
 */
const GENERIC_HEALTH_CLAUSE = /^(我|俺|咱)?(现在|目前|已经|真的|确实)?(身体)?(没事|没什么事|没啥事|没不舒服|没什么不舒服|不难受|挺好|好多了|好了|没事了|不疼了|不痛了)[啊呀哈呢吧的了！!。，,\s]*$/;
/** 泛化恢复必须带一个"锚" —— 光一句「好了」太容易是「好了,走吧」。 */
const GENERIC_HEALTH_ANCHOR = /(我|俺|咱|身体|现在|已经)/;
/**
 * 泛化恢复里**真的在说身体**的证据(用于"是否顺手收尾唯一短期症状"):
 * 「我没事啊」算;「已经好了」「我好了」不算 —— 后者太容易是"游戏下载好了"。
 */
const GENERIC_HEALTH_BODY = /(身体|胃|头|肚子|嗓子|牙|疼|痛|舒服|难受|病|感冒|发烧|恢复|痊愈)/;
const GENERIC_HEALTH_DENIAL_ONLY = /^(我|俺|咱)?(现在|目前|真的|确实)?(没事|没什么事|没啥事|没不舒服|没什么不舒服|不难受)[啊呀哈呢吧的了！!。，,\s]*$/;
/**
 * A-not-A / 疑问变体(C 刀 A 复核补充):`isQuestion` 只认问号与吗/呢,
 * 但「我是不是胃疼」「感冒好了没」同样是问句 —— 不许拿来改状态。
 */
const HEALTH_QUESTION = /是不是|有没有|好了没|好没好|还(疼|痛|难受)吗|还(疼|痛)不|要不要紧/;

const PRONOUNS = /我|俺|咱|你|您|他|她|它/g;
/** 家属/宠物/朋友:说的是别人,不是说话人自己的病(旧实现会串成 self)。 */
const THIRD_PARTY_OWNER = /(我的?|我家的?)(妈|妈妈|爸|爸爸|哥|哥哥|姐|姐姐|弟|弟弟|妹|妹妹|爷爷|奶奶|外公|外婆|朋友|同事|同学|室友|猫|狗|孩子|儿子|女儿)/;

/** 一小句里,症状词前面**最近的那个代词**是谁 —— 决定这条该挂谁头上。 */
function subjectNear(clause, index) {
  const before = clause.slice(0, index);
  if (THIRD_PARTY_OWNER.test(before)) return 'other';
  let last = null;
  for (const match of before.matchAll(PRONOUNS)) last = match[0];
  if (last === null) return 'unknown';
  return /我|俺|咱/.test(last) ? 'self' : 'other';
}

/**
 * 从一句话里读出**健康语义事件**(纯函数)。
 *
 * @param {string} text 人话(不要带桥注入)
 * @returns {{events: Array<{value: string, detail: string, polarity: string,
 *   subject: 'self'|'other'|'unknown', question: boolean}>, generic: 'denial'|'recovery'|null,
 *   genericBody: boolean}}
 *   `generic` = 整句没有具体症状词、只是"我没事/已经好了";调用方用它停止**当前**的无依据患病推断。
 *   `genericBody` = 这句泛化恢复**真的在说身体**(只有它为真时才该顺手收尾唯一短期症状;
 *   「已经好了/我好了」太容易是"游戏下载好了",只写提示、不动症状)。
 */
export function extractHealthSignals(text) {
  const source = String(text ?? '').trim();
  const out = { events: [], generic: null, genericBody: false };
  if (source === '') return out;
  const clauses = source.split(/(?<=[，。！？；、\n])/).map((clause) => clause.trim()).filter(Boolean);
  const seen = new Set();
  const pushEvent = (event) => {
    const key = `${event.value}|${event.polarity}|${event.subject}|${event.question ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.events.push(event);
  };
  const categories = [
    ['serious', SERIOUS_CATEGORIES.illness],
    ['chronic', HEALTH_WORDS.chronic],
    ['short', HEALTH_WORDS.short],
    ['mental', HEALTH_WORDS.mental],
  ];
  for (const clause of clauses) {
    // A-not-A / 「好了没」也是问句:问句不改状态(不得把「我是不是胃疼」当否认)。
    const question = isQuestion(clause) || HEALTH_QUESTION.test(clause);
    let matched = false;
    for (const [detail, words] of categories) {
      for (const word of words) {
        const index = clause.indexOf(word);
        if (index < 0) continue;
        matched = true;
        const before = clause.slice(Math.max(0, index - 6), index);
        const after = clause.slice(index + word.length, index + word.length + 8);
        let polarity = HEALTH_STATE.ACTIVE;
        if (question) {
          // 问句只是"提到",不落任何状态(既不新增也不退役)。
          polarity = HEALTH_STATE.ACTIVE;
        } else if (HEALTH_NEGATION_BEFORE.test(before)) {
          // 「我不胃疼了」= 已经好了;「我没有胃疼」= 否认发生过/否认现在有。
          polarity = /了/.test(clause.slice(index + word.length)) ? HEALTH_STATE.RESOLVED : HEALTH_STATE.REFUTED;
        } else if (HEALTH_RECOVERY_AFTER.test(after)) {
          polarity = HEALTH_STATE.RESOLVED;
        }
        pushEvent({ value: word, detail, polarity, subject: subjectNear(clause, index), question });
        // ⚠️ 同一小句、同一类只取第一个:serious 词表里「癌症/化疗/确诊」是同一件事的不同说法,
        //    全收会把「我确诊了癌症」记成三条病。旧实现也是"一类只取一个",这里保持一致。
        break;
      }
    }
    if (!matched) {
      for (const entry of BODY_RECOVERY) {
        const match = entry.re.exec(clause);
        if (!match) continue;
        matched = true;
        pushEvent({
          value: entry.value,
          detail: entry.detail,
          polarity: HEALTH_STATE.RESOLVED,
          subject: subjectNear(clause, match.index),
          question,
        });
      }
    }
    if (!matched && !question && GENERIC_HEALTH_CLAUSE.test(clause) && GENERIC_HEALTH_ANCHOR.test(clause)) {
      const recovery = /(好了|好多了|不疼了|不痛了|没事了|缓解|痊愈)/.test(clause);
      out.generic = out.generic ?? (recovery ? 'recovery' : 'denial');
      if (out.genericBody === false) {
        out.genericBody = GENERIC_HEALTH_BODY.test(clause) || GENERIC_HEALTH_DENIAL_ONLY.test(clause);
      }
    }
  }
  return out;
}

export function extractFacts(text, { subject = 'self' } = {}) {
  const source = String(text ?? '').trim();
  if (source === '') return [];
  void subject;
  const out = [];
  const push = (kind, value, detail = null) => {
    if (!value) return;
    if (out.some((fact) => fact.kind === kind && fact.value === value)) return;
    out.push({ kind, value, detail });
  };

  // ① 健康:先判这一小句的语义,只把「本人自述仍在」的记成事实。
  //    康复/否认不在这里造正向事实 —— 它们由 `learnFactsFrom` 走更新路径(`extractHealthSignals`)。
  //    ⚠️ 一类只取第一条(与旧实现同口径):「我感冒了,头晕」不是两场病,先记最像主诉的那个。
  const healthSignals = extractHealthSignals(source);
  const firstOfDetail = new Map();
  for (const event of healthSignals.events) {
    if (event.question || event.subject === 'other' || event.polarity !== HEALTH_STATE.ACTIVE) continue;
    if (firstOfDetail.has(event.detail)) continue;
    firstOfDetail.set(event.detail, event);
  }
  // 旧实现按 chronic → short → mental → serious 的顺序落地,这里保持同一顺序(不重排既有输出)。
  for (const detail of ['chronic', 'short', 'mental', 'serious']) {
    const event = firstOfDetail.get(detail);
    if (event) push('health', event.value, event.detail);
  }
  // ⚠️ 问句到此为止:健康那种陈述("我感冒了")照收,但
  // 「你喜欢我吗」「那我算你的父亲吗」不是偏好、也不是关系。
  if (isQuestion(source)) return out;
  /** 命中词所在的**那一小句**是不是问句 —— 「…还是你的父亲」「…懒惰的人呢」都要挡掉。 */
  // ⚠️ 用**保留标点**的切分(`(?<=…)`):否则「…最想要什么东西？」的 `？` 会被切掉,
  //    那一句看起来就像陈述了(实测踩到过)。
  const clauseOf = (word) => source.split(/(?<=[，。！？\n])/).find((clause) => clause.includes(word)) ?? source;
  /** 疑问的两种形状:句尾带问号/吗/呢,或者句中有"还是 / 或者 / 难道"(选择疑问句)。 */
  const questionClause = (word) => {
    const clause = clauseOf(word);
    return isQuestion(clause) || /还是|或者|难道/.test(clause);
  };
  // ② 关系:必须在**领属框架**里(「我弟弟」「这是我朋友」),而且不是"关于她自己"的主张。
  for (const word of RELATION_WORDS) {
    if (!relationFramed(source, word)) continue;
    // 「我是你爸爸」不是关于他爸的事实,而是**他在认亲** —— 那条交给她按人设拍板(<accept>)。
    if (detectClaimAboutSelf(source)?.relation === word) continue;
    if (questionClause(word)) continue;
    push('relation', word, null);
    break;
  }
  // ③ 雷区:**明确的祈使否定**优先(「别叫我小明」这种是硬边界)。
  for (const word of FORBID_WORDS) {
    const index = source.indexOf(word);
    if (index < 0) continue;
    const tail = tailAfter(source, index, word);
    push('dislike', tail === '' ? word : `${word}${tail}`, 'forbid');
    break;
  }
  // ④ 偏好:喜欢这一侧。取"词 + 后面一小段"当值,**在标点处断**,而且必须"像一个东西"。
  for (const word of LIKE_WORDS) {
    const index = source.indexOf(word);
    if (index < 0) continue;
    if (isQuestion(clauseOf(word))) break;
    const tail = tailAfter(source, index, word);
    if (looksLikeThing(tail)) push('preference', tail, 'like');
    break;
  }
  // ⑤ 雷区:讨厌这一侧(和被凶分开 —— 被凶只是情绪,讨厌 X 才是雷区)。
  for (const word of DISLIKE_WORDS) {
    const index = source.indexOf(word);
    if (index < 0) continue;
    if (isQuestion(clauseOf(word))) break;
    const tail = tailAfter(source, index, word);
    if (looksLikeThing(tail)) push('dislike', tail, 'hate');
    break;
  }
  return out;
}

/** 中文维度名 ↔ 内部 kind(命令与日志共用一份,免得两处说法分叉)。 */
export const KIND_LABELS = Object.freeze({
  关系: 'relation', 偏好: 'preference', 雷区: 'dislike', 健康: 'health',
  // `记忆` 不是"关于人的事实",而是**固化记忆**(note)—— `/忘了 记忆 琪露诺` 用它。
  记忆: 'note', 回忆: 'note',
  // `摘要` 也不是事实,而是**滚动摘要**(summary,D91)。⚠️ 它**不需要值** ——
  // 一段会话只有一份,`/忘了 摘要` 就是删(见 parseForget 里那条特例)。
  摘要: 'summary', 梗概: 'summary',
  relation: 'relation', preference: 'preference', dislike: 'dislike', health: 'health',
  note: 'note', summary: 'summary',
});

/** 反查:kind → 中文(给命令回执用)。 */
export function labelOf(kind) {
  return Object.entries(KIND_LABELS).find(([, value]) => value === kind)?.[0] ?? kind;
}

/**
 * 解析撤销命令:`/忘了 [维度] [值]`。**纯函数**,可测。
 *
 * | 输入 | 含义 |
 * |---|---|
 * | `/忘了` | 列出这一段会话里记着的事实(让人照着删) |
 * | `/忘了 健康` | 列出"健康"这一维的(还是只列) |
 * | `/忘了 健康 胃炎` | 删掉值里含"胃炎"的那条 |
 * | `/忘了 全部` | 这一段会话里**关于自己**的,全删 |
 * | `/忘了 摘要` | 删掉**滚动摘要**那一份(⚠️ 它不需要值:一段会话只有一份) |
 *
 * ⚠️ 想要"删掉值里含 `胃炎` 的**任何**维度"就写 `/忘了 全部 胃炎`(`kind: null` + 有值)。
 *
 * @returns {{kind: string|null, value: string|null, all: boolean, reason: string|null, word?: string}}
 *   `reason`: `empty`(没参数 → 列出来) / `unknown-kind`(维度名不认识) / `no-value`(只给了维度 → 列那一维)
 */
export function parseForget(text) {
  const raw = String(text ?? '').trim().replace(/^\/(忘了|忘记|forget)\s*/i, '').trim();
  if (raw === '') return { kind: null, value: null, all: false, reason: 'empty' };
  const parts = raw.split(/\s+/);
  if (parts.length === 1 && /^(全部|所有|都|all)$/i.test(parts[0])) {
    return { kind: null, value: null, all: true, reason: null };
  }
  const kind = KIND_LABELS[parts[0]] ?? null;
  if (kind === null) {
    // 第一个词不是维度 → 可能是"全部 值"以外的写法:只有当它是个维度才认,否则报错让人写清楚。
    if (parts.length === 1 && /^(全部|所有)$/i.test(parts[0])) return { kind: null, value: null, all: true, reason: null };
    return { kind: null, value: null, all: false, reason: 'unknown-kind', word: parts[0] };
  }
  const value = parts.slice(1).join(' ').trim();
  // ⚠️ **唯一一个不需要值的维度**:`摘要` 一段会话只有一份,`/忘了 摘要` 就该删 ——
  //    若照别的维度那样返回 `no-value`,它会被当成"列出来看看",用户永远删不掉。
  if (kind === 'summary' && value === '') return { kind, value: null, all: false, reason: null };
  if (value === '') return { kind, value: null, all: false, reason: 'no-value' };
  return { kind, value, all: false, reason: null };
}
export function factKey({ scope, subject, kind, value }) {
  return `${scope}|${subject}|${kind}|${value}`;
}

export const SOFT_MIN_SEEN = 2;

/**
 * 这条事实现在**够不够格被当真**(注入 / 回扫落库,两处共用同一条门槛)。
 *
 * 用户 2026-10-01 说的"偏好按**最高频率**提取"落到实现上就是这个:
 * **软维度(偏好、以及"讨厌"那侧)要见过两次**;关系、健康、明确祈使否定是硬事实,一次就算。
 * ⚠️ 两处共用同一个函数 —— 否则"回扫收进来的"与"运行时肯注入的"会各有一套标准。
 *
 * **健康的时间口径(C 刀 A,2026-11-11)**:`short` 不是"永久事实",而是"最近一次自述"。
 * 传了 `now` + `healthWindowMs` 时,超过窗口的 short **不再进当前事实注入**
 * (历史仍留在库里,由历史/回忆通道处理)。慢性/心理/重病不套这个窗口 ——
 * 它们是长期背景,但也不因此等于"现在正在发作"。两个参数都不传 = 旧行为(老调用/老测试)。
 */
export function factVisible(fact, { softMinSeen = SOFT_MIN_SEEN, now = null, healthWindowMs = null } = {}) {
  if (!fact) return false;
  if (fact.kind === 'preference') return (fact.seenCount ?? 1) >= softMinSeen;
  if (fact.kind === 'dislike') return fact.detail === 'forbid' || (fact.seenCount ?? 1) >= softMinSeen;
  if (fact.kind === 'health') {
    if (fact.state === HEALTH_STATE.RESOLVED || fact.state === HEALTH_STATE.REFUTED) return false;
    // C 刀兼容:老库里 source=mined 且没有 state 的健康行,是旧回扫"猜"出来的 ——
    // 当时没有事件时间,可能被旧 bug 刷成"最近"。先降为历史记录,不再当当前状态注入
    // (本刀之后新的 mined 写入带 state=active,不受这条影响)。
    if (fact.state == null && fact.source === 'mined') return false;
    if (now === null || !healthWindowMs) return true;
    if (fact.detail !== 'short') return true;
    const at = Number(fact.lastSeen ?? fact.last_seen ?? 0);
    return at > 0 && Number(now) - at <= Number(healthWindowMs);
  }
  return true;
}

/** 给人看的一行(日志与提示词共用同一份措辞,免得两处说法分叉)。 */
export function describeFact(fact, { now = null } = {}) {
  // ⚠️ 重病那一档要**自带态度**(别当谈资) —— 它进了提示词就会影响她怎么说话。
  if (fact.kind === 'health' && fact.detail === 'serious') {
    return `健康（**严肃**:别当谈资、别追问）:${fact.value}`;
  }
  const detail = fact.detail ? `（${fact.detail}）` : '';
  switch (fact.kind) {
    case 'relation': return `关系：${fact.value}${detail}`;
    case 'name': return `名字：${fact.value}${detail}`;
    case 'preference': return `偏好：${fact.value}${detail}`;
    case 'dislike': return `雷区：${fact.value}${detail}`;
    case 'health': {
      // ⚠️ 关键:健康这一行必须让人看出**这是过去自述**,不是"现在正在疼"。
      //    旧措辞「健康：胃疼(short)」读起来就是当前病情 —— 模型据此追问完全合理。
      if (now === null) return `健康：${fact.value}${detail}`;
      const at = Number(fact.lastSeen ?? fact.last_seen ?? 0);
      const when = at > 0 ? `${ageLabel(Number(now) - at)}自述` : '';
      const suffix = HEALTH_BACKGROUND_DETAILS.includes(fact.detail)
        ? '长期背景'
        : (when ? `${when}，之后未再确认` : '之后未再确认');
      return `健康：${fact.value}（${fact.detail ? `${fact.detail}；` : ''}${suffix}）`;
    }
    default: return `${fact.kind}：${fact.value}${detail}`;
  }
}

/**
 * 把若干事实渲染成**每轮注入的一小块**(像 `stats`/`mood` 那样)。
 *
 * 预算很小(默认 160 字)而且**按维度限条** —— 事实多了会挤掉对话本身,
 * 所以只端"最该在场的":名字 → 关系 → 健康 → 雷区 → 偏好。
 *
 * ⚠️ **`currentSubject`(2026-10-09)**:库里同一段会话可能有**别人**的事实
 * (`subject` = 那个人的 openid)。以前把全作用域的都端出来、而且一律标成「关于他/他们」——
 * 于是"江时光"被当成**说话人**的代号(用户报的现场)。现在分开:
 * 当前说话人的照旧;不是他的**单独一块、写明"这是别人的"**。
 */
export function renderFacts(facts, { budgetChars = 160, perKind = 3, currentSubject = null, labelFor = null, now = null, healthWindowMs = null } = {}) {
  if (!facts || facts.length === 0) return '';
  const order = ['name', 'relation', 'health', 'dislike', 'preference'];
  // 健康这一维再兜一道:恢复/否认过的行即使被调用方漏筛,也不许进"当前事实"。
  const live = facts.filter((fact) => fact.kind !== 'health'
    || (fact.state !== HEALTH_STATE.RESOLVED && fact.state !== HEALTH_STATE.REFUTED));
  const mine = currentSubject ? live.filter((fact) => (fact.subject ?? currentSubject) === currentSubject) : live;
  const others = currentSubject ? live.filter((fact) => (fact.subject ?? currentSubject) !== currentSubject) : [];
  const picked = [];
  // ⚠️ **先按"是不是当前说话人的"分组,再按维度排**(2026-10-09):顺序错了会出现
  //    "别人的一条夹在说话人自己的事实中间",读者(模型)更容易把两者混起来 —— 那正是这次修的 bug。
  for (const group of [mine, others]) {
    for (const kind of order) {
      const bucket = group.filter((fact) => fact.kind === kind);
      // ⚠️ 重病(serious)排在同一维度的最前面 —— 它是**最重要的一条**,不该被普通健康挤掉。
      bucket.sort((a, b) => (b.detail === 'serious' ? 1 : 0) - (a.detail === 'serious' ? 1 : 0));
      picked.push(...bucket.slice(0, perKind));
    }
  }
  if (picked.length === 0) return '';
  const lines = ['关于他/他们，你知道这些（照做但别念出来，也别主动报）：'];
  // ⚠️ C 刀 A(2026-11-11):只要这一块里出现健康,**必须**同时说清"那是过去自述"——
  //    否则旧病会被当成"现在看见他脸色发白"的依据(2026-11-02 现场)。
  const hasHealth = picked.some((fact) => fact.kind === 'health');
  if (hasHealth) {
    lines.push('（健康项是他过去的自述，不代表现在；他当前说自己没事/已经好了时，以他当前的话为准。）');
  }
  let used = lines.join('\n').length;
  let otherHeaderWritten = false;
  for (const fact of picked) {
    const isOther = currentSubject ? (fact.subject ?? currentSubject) !== currentSubject : false;
    if (isOther && !otherHeaderWritten) {
      otherHeaderWritten = true;
      // ⚠️ 这一行是修 bug 的关键:不加它,"另一个人的名字"会被当成**说话人**的代号。
      const who = typeof labelFor === 'function' ? labelFor(fact.subject) : null;
      lines.push(`· （下面这些是**别人**的，不是跟你说话这个人的${who ? `，说的是「${who}」` : ''}）`);
    }
    const line = `· ${describeFact(fact, { now })}`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * 「他最近明确说过自己当前没事」的一行提示(C 刀 A)。
 *
 * 为什么需要它:用户说「我没事啊」时句子里**没有症状词**,按词表抽不出任何事实 ——
 * 旧实现于是什么都不做,旧胃疼照旧注入,她继续坚持。现在把这句话本身记成一条
 * **有时效的提示**,让"他当前的说法"压过"旧事实"。
 *
 * @param {number} denialAt 上次明确否认/说已经好了的时刻(ms)
 * @param {{now?: number, windowMs?: number}} [options] `windowMs<=0` = 关掉这条提示
 * @returns {string} 要追加到事实块末尾的一行;没有/过期返回 ''
 */
export function healthDenialLine(denialAt, { now = Date.now(), windowMs = 0 } = {}) {
  const at = Number(denialAt) || 0;
  if (at <= 0 || !(Number(windowMs) > 0)) return '';
  if (Number(now) - at > Number(windowMs) || at > Number(now)) return '';
  return `· 他${ageLabel(Number(now) - at)}明确说过自己当前没事/已经好了 —— 旧健康记录不能当成他现在不舒服的依据，他当前的说法优先。`;
}

/**
 * 把消息自带的平台时间解析成毫秒(纯函数)。
 * QQ 给的 `timestamp` 可能是 ISO 字符串、秒或毫秒;认不出返回 null(不猜)。
 */
export function parseEventTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return parseEventTime(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
