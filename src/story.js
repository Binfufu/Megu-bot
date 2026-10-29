import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/**
 * 「随机事件钩子」—— 她抛出**未解决**的小事件,等群友回应;没人回应就自己决定走向(D99 阶段 3)。
 *
 * 行为契约:先提出未解决事件,允许互动回应或超时自决;结果由代码结算,
 * 文本可以由角色发挥,收尾必须明确结束当前活动。具体角色事件来自可选本地内容。
 *
 * 五条口径,一条都不许省:
 *   ① **未解决**:开场的提示词只给"发生了什么"的方向,**不给结局**;
 *   ② **可互动**:有人回应 → 按回应的意思定走向(她演,数字由代码给);
 *   ③ **超时自决**:一段时间没人理 → 她自己决定走向(不是把事件丢掉);
 *   ④ **一定要有结果**:每一次收尾都**落一笔数值**(`kind='story'`),不许只说说就完;
 *   ⑤ **休闲收尾**:结束时她要说到"去休息/洗澡/睡觉"这类动作 —— 那是"这段互动结束"的标志。
 *
 * ⚠️ 本文件**全是纯函数**(随机源注入):状态机住在这里,持久化与编排在调用方 ——
 * 于是"什么时候该收尾、走向怎么选、数值给多少"都能直接单测(`main()` 里的装配测不到)。
 *
 * ⚠️ 事件表**不写台词**,只写**事实方向**(和 `economy.js` 的委托表同一条规矩):
 * 具体怎么说由角色卡决定。`setup` 是"她抛出去的那件事",`branch.line` 是"这件事的结局"。
 */

/** 一个事件最多挂多久等回应;过了就她自己决定走向。 */
export const STORY_TTL_MS = 30 * 60_000;

/**
 * 事件表。`branch.effect` 是**这一档的数值结果**(代码给,模型不许改):
 * `money` 货币 / `mood` / `stamina` / `satiety` / `health`(都可省)。
 *
 * `branch.keywords` 是**兜底用的口语特征词** —— 模型有时候**忘了补标记**
 * (2026-10-02 离线真跑两次:一次补了 `<story outcome=help>`,一次没补),
 * 那时要能从她**已经说出来的话**里认出她走的是哪一档,而不是瞎掷一档
 * (掷错的话:她嘴上说"去帮人干活抵账",账上却是"溜了" —— 数字和台词打架)。
 *
 * 本地内容决定具体叙事风格;无内容时只保留中性示例,不隐式代入其他角色。
 */
export const STORY_EVENTS = LOCAL_STORY_WORLD?.storyEvents ?? [
  {
    "id": "explosion_practice",
    "setup": "示例日常事件1需要处理",
    "branches": [
      {
        "id": "flee",
        "weight": 3,
        "line": "按方案1完成处理",
        "keywords": [
          "示例线索1_1_1",
          "示例线索1_1_2",
          "示例线索1_1_3",
          "示例线索1_1_4"
        ],
        "effect": {
          "mood": -4
        }
      },
      {
        "id": "compensate",
        "weight": 4,
        "line": "按方案2完成处理",
        "keywords": [
          "示例线索1_2_1",
          "示例线索1_2_2",
          "示例线索1_2_3",
          "示例线索1_2_4",
          "示例线索1_2_5",
          "示例线索1_2_6"
        ],
        "effect": {
          "money": -6000,
          "mood": -2
        }
      },
      {
        "id": "help",
        "weight": 3,
        "line": "按方案3完成处理",
        "keywords": [
          "示例线索1_3_1",
          "示例线索1_3_2",
          "示例线索1_3_3",
          "示例线索1_3_4",
          "示例线索1_3_5",
          "示例线索1_3_6",
          "示例线索1_3_7",
          "示例线索1_3_8"
        ],
        "effect": {
          "stamina": -15,
          "mood": 2,
          "money": -800
        }
      }
    ]
  },
  {
    "id": "guild_board",
    "setup": "示例日常事件2需要处理",
    "branches": [
      {
        "id": "take",
        "weight": 4,
        "line": "按方案1完成处理",
        "keywords": [
          "示例线索2_1_1",
          "示例线索2_1_2",
          "示例线索2_1_3",
          "示例线索2_1_4"
        ],
        "effect": {
          "money": 12000,
          "stamina": -12
        }
      },
      {
        "id": "refuse",
        "weight": 3,
        "line": "按方案2完成处理",
        "keywords": [
          "示例线索2_2_1",
          "示例线索2_2_2",
          "示例线索2_2_3"
        ],
        "effect": {
          "mood": 1
        }
      },
      {
        "id": "scam",
        "weight": 3,
        "line": "按方案3完成处理",
        "keywords": [
          "示例线索2_3_1",
          "示例线索2_3_2",
          "示例线索2_3_3",
          "示例线索2_3_4"
        ],
        "effect": {
          "stamina": -8,
          "mood": -5
        }
      }
    ]
  },
  {
    "id": "weird_purchase",
    "setup": "示例日常事件3需要处理",
    "branches": [
      {
        "id": "buy",
        "weight": 5,
        "line": "按方案1完成处理",
        "keywords": [
          "示例线索3_1_1",
          "示例线索3_1_2",
          "示例线索3_1_3",
          "示例线索3_1_4"
        ],
        "effect": {
          "money": -3500,
          "mood": 6
        }
      },
      {
        "id": "bargain",
        "weight": 3,
        "line": "按方案2完成处理",
        "keywords": [
          "示例线索3_2_1",
          "示例线索3_2_2",
          "示例线索3_2_3",
          "示例线索3_2_4"
        ],
        "effect": {
          "money": -1500,
          "mood": 3
        }
      },
      {
        "id": "leave",
        "weight": 2,
        "line": "按方案3完成处理",
        "keywords": [
          "示例线索3_3_1",
          "示例线索3_3_2",
          "示例线索3_3_3"
        ],
        "effect": {
          "mood": -2
        }
      }
    ]
  },
  {
    "id": "aqua_church",
    "setup": "示例日常事件4需要处理",
    "branches": [
      {
        "id": "argue",
        "weight": 4,
        "line": "按方案1完成处理",
        "keywords": [
          "示例线索4_1_1",
          "示例线索4_1_2",
          "示例线索4_1_3",
          "示例线索4_1_4"
        ],
        "effect": {
          "mood": -3,
          "stamina": -3
        }
      },
      {
        "id": "donate",
        "weight": 2,
        "line": "按方案2完成处理",
        "keywords": [
          "示例线索4_2_1",
          "示例线索4_2_2",
          "示例线索4_2_3",
          "示例线索4_2_4"
        ],
        "effect": {
          "money": -2000,
          "mood": -1
        }
      },
      {
        "id": "flee",
        "weight": 4,
        "line": "按方案3完成处理",
        "keywords": [
          "示例线索4_3_1",
          "示例线索4_3_2",
          "示例线索4_3_3",
          "示例线索4_3_4"
        ],
        "effect": {
          "mood": 1
        }
      }
    ]
  },
  {
    "id": "kazuma_debt",
    "setup": "示例日常事件5需要处理",
    "branches": [
      {
        "id": "lend",
        "weight": 2,
        "line": "按方案1完成处理",
        "keywords": [
          "示例线索5_1_1",
          "示例线索5_1_2",
          "示例线索5_1_3"
        ],
        "effect": {
          "money": -5000,
          "mood": 4
        }
      },
      {
        "id": "refuse",
        "weight": 5,
        "line": "按方案2完成处理",
        "keywords": [
          "示例线索5_2_1",
          "示例线索5_2_2",
          "示例线索5_2_3",
          "示例线索5_2_4"
        ],
        "effect": {
          "mood": 2,
          "stamina": -2
        }
      },
      {
        "id": "deal",
        "weight": 3,
        "line": "按方案3完成处理",
        "keywords": [
          "示例线索5_3_1",
          "示例线索5_3_2",
          "示例线索5_3_3",
          "示例线索5_3_4"
        ],
        "effect": {
          "mood": 5,
          "satiety": 8
        }
      }
    ]
  },
  {
    "id": "leftovers",
    "setup": "示例日常事件6需要处理",
    "branches": [
      {
        "id": "eat",
        "weight": 4,
        "line": "按方案1完成处理",
        "keywords": [
          "示例线索6_1_1",
          "示例线索6_1_2",
          "示例线索6_1_3"
        ],
        "effect": {
          "satiety": 25,
          "mood": 5,
          "money": -400
        }
      },
      {
        "id": "pack",
        "weight": 3,
        "line": "按方案2完成处理",
        "keywords": [
          "示例线索6_2_1",
          "示例线索6_2_2",
          "示例线索6_2_3"
        ],
        "effect": {
          "satiety": 12,
          "money": -400,
          "mood": 2
        }
      },
      {
        "id": "proud",
        "weight": 3,
        "line": "按方案3完成处理",
        "keywords": [
          "示例线索6_3_1",
          "示例线索6_3_2",
          "示例线索6_3_3"
        ],
        "effect": {
          "mood": -4,
          "satiety": -2
        }
      }
    ]
  }
];

/**
 * 按权重抽一项(和 `mood.js` / `economy.js` 同一个做法)。
 *
 * ⚠️ **1.106.0 修掉一个把六个事件压成一个的 bug**(D172):这个函数有**两个调用方** ——
 *    `pickSelfDecidedBranch()` 抽的是 `branches`(每一档**真的有 `weight`**),
 *    而 `openStory()` 抽的是 `STORY_EVENTS`(**事件表只有 `id`/`setup`/`branches`,没有 `weight`**)。
 *    于是 `0 + undefined` = **NaN** → `total <= 0` 为假 → 循环里 `roll -= undefined` 恒为 NaN →
 *    循环走完 → **永远兜底返回最后一条**。
 *    现场(2026-10-10 查日志):`事件钩子：抛出` **197 次,197 次都是 `leftovers`(公会食堂)**
 *    —— 这就是用户说的「她每天只会私聊我关于公会饭堂的话题」。
 *
 * 所以判据改成**两种模式,二选一**(不许"一部分有权重、一部分没有"这种半吊子):
 *   · 每一行都有**正数**权重 → 按权重抽(老行为,branches 那条路一字不变);
 *   · 否则 → **均匀抽**,并且**保证每一行都可能被抽到**(按索引取,不再靠"roll 落空"兜底)。
 */
function pickWeighted(rows, random) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const weights = rows.map((row) => Number(row?.weight));
  const allWeighted = weights.every((value) => Number.isFinite(value) && value > 0);
  if (!allWeighted) {
    // 均匀:随机数按索引取整 —— `Math.random()` 返回 [0,1),取 1 时也要落在表内
    const index = Math.min(rows.length - 1, Math.max(0, Math.floor(random() * rows.length)));
    return rows[index];
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = random() * total;
  for (let i = 0; i < rows.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return rows[i];
  }
  return rows[rows.length - 1];
}

/**
 * 抛出一个**未解决**的小事件(纯函数)。
 *
 * `events` = **内容包**(P4,2026-10-28):机制留在这里、内容按角色换。
 * 不传 = 默认角色那张角色内容事件表(旧行为一字不变);传进来的是**该角色自己的**事件表
 * (见 `src\story-content.js`)。没有内容包的角色调用方**根本不进这个函数** ——
 * 不套用别人的事件(机械体演"本地组织"是串味,不是丰富)。
 *
 * @param {{now?: number, random?: () => number, ttlMs?: number, events?: Array<object>}} [ctx]
 * @returns {{event: object, openedAt: number, expiresAt: number}}
 */
export function openStory({ now = Date.now(), random = Math.random, ttlMs = STORY_TTL_MS, events = STORY_EVENTS } = {}) {
  const table = Array.isArray(events) && events.length > 0 ? events : STORY_EVENTS;
  const event = pickWeighted(table, random) ?? table[0];
  return { event, openedAt: now, expiresAt: now + ttlMs };
}

/** 这个钩子是不是等太久了(该她自己决定走向了)。 */
export function storyExpired({ now = Date.now(), expiresAt = 0 } = {}) {
  return Boolean(expiresAt) && now >= expiresAt;
}

/** 按 id 找一档走向;找不到返回 null。 */
export function findBranch(event, branchId) {
  if (!event || !Array.isArray(event.branches)) return null;
  return event.branches.find((branch) => branch.id === branchId) ?? null;
}

/** 没人回应时,她自己决定走向(按权重掷骰)。 */
export function pickSelfDecidedBranch(event, random = Math.random) {
  return pickWeighted(event?.branches ?? [], random);
}

/**
 * **从她已经说出来的话里认出她走的是哪一档**(纯函数,兜底用)。
 *
 * 为什么要它:模型有时候**忘了补标记**(2026-10-02 离线真跑两次,一次补了一次没补)。
 * 那时代码只有两条路 —— 瞎掷一档(她嘴上说"去帮人干活抵账",账上却是"溜了":**数字和台词打架**),
 * 或者干脆不结算(违反用户那条"一定要有结果")。都不好。
 *
 * 判据很朴素:每一档带一组口语特征词(见 `STORY_EVENTS` 的 `keywords`),
 * **命中最多**的那一档胜出;一条都没命中(或并列)就返回 null,交给掷骰。
 * 命中数相同时**不猜**(宁可掷骰 + 日志写明"代码掷的",也不要装作读懂了)。
 *
 * @returns {object|null} 命中的那一档
 */
export function inferBranch(event, text) {
  const source = String(text ?? '');
  if (!source || !Array.isArray(event?.branches)) return null;
  let best = null;
  let bestHits = 0;
  let tie = false;
  for (const branch of event.branches) {
    const hits = (branch.keywords ?? []).filter((word) => word && source.includes(word)).length;
    if (hits > bestHits) {
      best = branch;
      bestHits = hits;
      tie = false;
    } else if (hits === bestHits && hits > 0) {
      tie = true;
    }
  }
  if (!best || bestHits === 0 || tie) return null;
  return best;
}

/**
 * 从她的回复里取出走向标记,并把那段**从要发出去的文字里去掉**(协议不许发到 QQ)。
 *
 * 形状与 `<intake …/>` / `<accept relation=…/>` 同一族:`<story outcome="compensate"/>`。
 *
 * ⚠️ **引号必须可选**(2026-10-02 真跑抓到):那次她写的是 `<story outcome=help>`
 * —— **没有引号、也没有自闭合斜杠**。严格版本会把她的选择整个丢掉,
 * 于是代码掷一档,用户看到的走向就**不是她挑的那一档**(而且日志会写"代码掷的",查起来莫名其妙)。
 * 所以这里宽松解析:`"help"` / `help` / `'help'` 都认,斜杠可有可无。
 *
 * @returns {{outcome: string|null, text: string}}
 */
export function extractStoryOutcome(text) {
  const source = String(text ?? '');
  // ⚠️ 载荷**故意不限制成 ASCII**:2026-10-02 离线真跑里她两次写出不同形状 ——
  //    `<story outcome=help>`(无引号)与 `<story outcome=默认角色认下了……就此了结。>`(整句话)。
  //    严格的正则会把这两种都丢掉,于是"她挑的那一档"被无视、代码另掷一档。
  //    宽容取值,再由 `matchOutcome()` 去同伴实的 id 对上。
  const match = /<\s*story\s+outcome\s*=\s*["']?([^>"']*)["']?\s*\/?\s*>/i.exec(source);
  if (!match) return { outcome: null, text: source };
  const rest = source.replace(match[0], '').replace(/[ \t]+$/gm, '').trim();
  return { outcome: match[1].trim(), text: rest };
}

/**
 * 把标记里的载荷**对到真实的走向 id 上**(纯函数)。
 *
 * 三级:① 完全相等(忽略大小写、去空格)→ ② 载荷里**包含**某个 id(她写成了整句话时用这条)
 * → ③ 对不上就 null(交给 `inferBranch` / 掷骰)。
 *
 * ⚠️ 这条是 2026-10-02 离线真跑逼出来的:她第二次写的是
 * `<story outcome=默认角色认下了城外炸田的责任,提出以每日一发的招牌技能为农户开垦新田来抵债……就比了结。>`
 * —— 整句话塞在载荷里。只认"完全相等"的话,用户看到的走向就不是她挑的那一档。
 */
export function matchOutcome(event, payload) {
  const value = String(payload ?? '').trim().toLowerCase();
  if (!value || !Array.isArray(event?.branches)) return null;
  const exact = event.branches.find((branch) => branch.id.toLowerCase() === value);
  if (exact) return exact;
  // 整句话里带上 id 的情况;id 长的优先(避免 `take` 命中 `take_it` 这种前缀巧合)
  const contained = event.branches
    .filter((branch) => value.includes(branch.id.toLowerCase()))
    .sort((a, b) => b.id.length - a.id.length);
  return contained[0] ?? null;
}

/**
 * 「收尾的休闲动作」的特征词(判据用,不是给她看的台词)。
 *
 * 用户把它当成"**互动事件结束**"的标志,所以它**要被量**(缺了记 warn),而不是只在提示词里许愿。
 * 2026-10-02 用户追加:「最后用'去休息/洗澡/睡觉'收尾 —— 这个**还可以再加**」,于是按
 * **收束感**扩了一轮(说出口就表示"这一段到此为止",而且不改数值):
 *   睡觉族 / 清洁族 / 吃与收拾 / 收尾型外出 / 安静族。
 * ⚠️ **不许**把"去接委托/去钓鱼"塞进来 —— 那是**下一件事的开始**,不是收尾(见 D101 第二节)。
 */
export const CLOSING_ACTION_WORDS = LOCAL_STORY_WORLD?.storyClosingWords ?? ['休息', '睡', '整理', '到此为止'];

/**
 * 收尾动作的**示例清单**(给提示词用)。
 *
 * 为什么给例子而不是一个词:用户 2026-10-02 说"还可以再加" —— 与其替他定死,
 * 不如把**收束感**这件事说清 + 给几种口味,让她自己挑(角色卡负责口气)。
 */
export const CLOSING_ACTION_EXAMPLES = LOCAL_STORY_WORLD?.storyClosingExamples ?? ['先去休息。', '整理完就结束今天的活动。'];

/**
 * 她这句话里有没有"收尾动作"(纯函数)。
 *
 * ⚠️ 用户把这一句当成"**互动事件结束**"的标志,所以它**要被量**(缺了记一条 warn)——
 * 2026-10-02 离线真跑四次里两次没带这句。
 */
export function hasClosingAction(text) {
  const source = String(text ?? '');
  return CLOSING_ACTION_WORDS.some((word) => source.includes(word));
}

/** 收尾那一段提示词(三段共用一份,免得三处各写一遍而慢慢分叉)。 */
export function closingActionHint() {
  return '**最后**用一句话交代你接下来去干什么，表示"这件事到此为止"（下面这些口味随你挑，'
    + '不必照抄）：' + CLOSING_ACTION_EXAMPLES.map((line) => `「${line}」`).join('')
    + ' ——这一句不能省。';
}

// ---------------------------------------------------------------------------
// 提示词:三段(开场 / 有人回应 / 自己决定) + 收尾口径
// ---------------------------------------------------------------------------

/** 走向清单:只给**编号与结局方向**,不给数值(数值是代码的事)。 */
function branchList(event) {
  return event.branches
    .map((branch) => `· outcome="${branch.id}" —— ${branch.line}`)
    .join('\n');
}

/**
 * **开场**:抛出那件事,**不许说结局**。
 *
 * @param {{scene: 'c2c'|'group', event: object, silentToken?: string}} ctx
 */
export function buildStoryOpenPrompt({ scene, event, silentToken = '[跳过]' }) {
  const framing = scene === 'c2c'
    ? '[私聊] 你没在跟谁对话,是自己过日子的间隙,顺手跟关系很近的人说一句。'
    : '[群聊] 群里这会儿很安静。你没在跟谁对话,是自己过日子的间隙被大家撞见了。';
  return [
    framing,
    '',
    `刚刚发生的事（系统给的**事实方向**，台词你自己说）：${event.setup}。`,
    '',
    '要求：',
    '1. **只讲这件事本身，不要讲结果** —— 结果还没发生,要等别人的反应;',
    '2. 一到两句，像随口一说，别写成小作文、别提问、别点名；',
    '3. **不要**报钱数、不要提"系统""数值"这种词；',
    '4. 如果你想不出怎么说，就只回复 ' + silentToken + '。',
  ].join('\n');
}

/**
 * **有人回应了** → 按他们的意思把走向定下来。
 *
 * ⚠️ 走向由**她**从清单里挑(因为"他们那句话是什么意思"只有她读得懂),
 * 但**数值由代码给** —— 所以她必须把挑中的那档**用标记报回来**。
 *
 * @param {{scene: 'c2c'|'group', event: object, reply: string, silentToken?: string}} ctx
 */
export function buildStoryRespondPrompt({ scene, event, reply, silentToken = '[跳过]' }) {
  return [
    scene === 'c2c' ? '[私聊]' : '[群聊]',
    '',
    `你刚才提过一件事（系统给的**事实方向**）：${event.setup}。`,
    `现在有人说：${String(reply ?? '').slice(0, 200)}`,
    '',
    '要求：',
    '1. **先把这件事结掉**，然后在回复的**最末尾**补一行 <story outcome="id"/>：' +
    '**引号里只写那一个英文 id、不要写句子**（id 就是下面列的那几个英文词）——' +
    '这一行必须补上：忘了补或写错，系统只能照你说的话去猜，猜错的话她嘴上说的和账上记的就对不上了；',
    '2. 结果从下面这三条里挑一条最合适的，别自己编第四条：',
    branchList(event),
    '3. 用你自己的语气把结果说一两句；',
    LOCAL_STORY_WORLD?.storyRespondClosing ?? '4. **最后**用一句话交代接下来去干什么，表示这件事到此为止；',
    '5. **不要**报钱数。',
  ].join('\n');
}

/**
 * **没人回应** → 她自己决定走向(提示词不给她清单,免得像在自问自答写选项)。
 *
 * @param {{scene: 'c2c'|'group', event: object, silentToken?: string}} ctx
 */
export function buildStorySettlePrompt({ scene, event, silentToken = '[跳过]' }) {
  return [
    scene === 'c2c' ? '[私聊]' : '[群聊]',
    '',
    `你之前提过一件事：${event.setup}。到现在也没人搭话。`,
    '',
    '要求：',
    '1. **你自己把这件事往下走完**（结果是什么由你定，别停在半路）；',
    '2. 一到两句，像自言自语；',
    LOCAL_STORY_WORLD?.storySettleClosing ?? '3. **最后一句必须交代接下来去做什么**，表示这件事到此为止；',
    '4. **不要**报钱数。',
  ].join('\n');
}

/** 收尾那一句的**必须项**(给测试与文档看的判据,不是给模型的)。 */
export const STORY_CLOSING_HINT = '去休息/洗澡/睡觉';
