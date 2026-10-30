/**
 * 记忆归档 —— 把 DSH 的会话记录解析成**可查询的行**。
 *
 * ## 先纠正一个容易想当然的前提
 *
 * **机器人的"记忆"不在 bridge 的数据库里,而在 `dsh` 子进程持有的会话里。**
 * `dsh` 把每个会话连续写在
 * `~/.dsh/sessions/--E-DSH-<工作区>--/<会话id>/session.v3.jsonl.zstd`,
 * 而 bridge 每次重启会把会话**代数 +1** → 换一个新会话 id → **上一代的记忆成为孤儿**
 * (文件还在,但没有任何人再读它)。实测:主实例已经攒了 73 个这样的孤儿会话文件,副实例 17 个。
 *
 * 所以这个模块做的是**归档**,不是"让机器人记住":
 *
 * - 它把散落的孤儿会话变成一张**分类过的、可查询的表**;
 * - 它**不能**让机器人重新记起来 —— 那需要把归档内容**回灌**进提示词,是另一件事
 *   (见 TODO 的"记忆回灌"条)。把这两件事混为一谈,就会做出一份"存了但谁也没读"的档案。
 *
 * ## 为什么是"派生索引"而不是"主数据"
 *
 * 真相仍然是那些 `.jsonl.zstd` 文件。这个库**可以随时删掉重建**,重建后一模一样 ——
 * 和 `samtools index` / `.fai`、以及待办索引(D35)是同一个道理。
 * 好处很实在:不需要"每两小时存一次"这种保命式定时器,因为**没有东西会丢**;
 * 归档只是"你想查的时候有多新"的问题。幂等键是 `(会话, seq)`。
 *
 * ## 记忆分类
 *
 * 分类不靠猜:bridge 自己把**这一轮是怎么来的、用什么情绪、身体什么状态**都写进了
 * 用户消息里(`（本次表达要求，照做但不要念出来：）` 那一段),所以这些字段可以**读出来**,
 * 而不是从回复里反推。能从记录里直接得到的:
 *
 * | 维度 | 来源 |
 * |---|---|
 * | 场合 | 会话 id 里的 `group` / `c2c`,以及正文开头的 `[群聊]` / `[私聊]` |
 * | 触发方式 | 是 @、自发接话、定时暖群、戳一戳、纯表情、播报还是命令 |
 * | 情绪 | 注入行里的「本轮情绪：X」 |
 * | 长度约束 / 语气词 / 风格要求 | 同一段注入行 |
 * | 身体状态(主实例) | 注入行里的「身体状态（照做但别念出来）：…」 |
 * | 成本 | `assistant/message` 的 `usage` |
 *
 * ⚠️ **一个已知的取不到的东西:发言人**。bridge 喂给模型的正文里只有 `[群聊]` + 内容,
 * 没有发送者的 openid —— 所以归档里**认不出"谁说的"**。要补这一列得先让 bridge 把
 * 发言人写进提示词(那会改变模型看到的内容,得单独评估)。现在如实留空。
 *
 * 本文件**全是纯函数**:解析、分类、清洗。文件 I/O 与 SQLite 在
 * `scripts/memory-archive.js`,所以规则本身可以直接单测。
 */

import { stripLeakedControlMarkup } from './control-markup.js';

/** 记忆库的表结构。改了就重建(`node scripts\memory-archive.js --rebuild`)。 */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  conversation TEXT NOT NULL,   -- qqbot-group-<openid> / qqbot-c2c-<openid>
  scene       TEXT NOT NULL,    -- group / c2c
  target      TEXT,             -- 群 openid / 单聊 openid
  generation  INTEGER NOT NULL, -- 会话代数;每重启一次 +1
  created_at  INTEGER,
  cwd         TEXT,
  file        TEXT,
  turns       INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL
);

-- 一轮 = 一次「有人/时钟把它叫起来」+ 它的回复。幂等键 (session_id, seq)。
CREATE TABLE IF NOT EXISTS turn (
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,  -- 那条 user/message 的 seq
  at          INTEGER NOT NULL,
  turn_no     INTEGER,
  kind        TEXT NOT NULL,     -- mention/self/warmup/poke/face/announce/command/unknown
  topic       TEXT,              -- 暖群/自发的话题方向
  mood        TEXT,
  max_chars   INTEGER,
  max_sentences INTEGER,
  interjection TEXT,
  state_line  TEXT,              -- 当前实例的身体状态那一行
  nudge       TEXT,              -- 本轮风格要求
  user_text   TEXT,              -- 去掉注入说明后的"人说的话"
  user_chars  INTEGER NOT NULL DEFAULT 0,
  reply_at    INTEGER,
  reply_text  TEXT,
  reply_chars INTEGER NOT NULL DEFAULT 0,
  silent      INTEGER NOT NULL DEFAULT 0,  -- 她回了 [跳过]
  in_tokens   INTEGER, out_tokens INTEGER,
  cache_read_tokens INTEGER, reasoning_tokens INTEGER,
  -- P1-A(2026-10-18):关键词通道的分词列。bigram 分词后的空格分隔串,
  -- 由 bigramTokens() 生成、写进 FTS5 虚表 turn_fts。老库由 ensureFtsSchema 补列后回填。
  fts_text    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turn_at   ON turn(at);
CREATE INDEX IF NOT EXISTS idx_turn_kind ON turn(kind, at);
CREATE INDEX IF NOT EXISTS idx_turn_mood ON turn(mood, at);
CREATE INDEX IF NOT EXISTS idx_turn_sess ON turn(session_id, seq);

-- 分层记忆 v1(D75):一轮的**标签**。检索先靠它把候选收窄(SQL 换 token),
-- 再由 src\memory-tags.js 的纯函数打分排序。
--
-- ⚠️ 为什么放在这个库、而不是状态库:标签是**轮次**的派生数据,键就是 (session_id, seq)。
-- 放进状态库就得跨库 join —— 而"同一个事实两份来源"正是 known_group 那个 bug 的形状(D35)。
-- 放在这里还有一条实在的好处:memory.db 是**派生索引**,判据一改就整库重导(见 MEMORY_VERSION),
-- 而不用担心把主数据改坏。
--
-- ⚠️ 这是一段**模板字符串**:注释里不能出现反引号(犯过一次,启动时才炸)。
-- tag 只允许 TAG_VOCAB 里的内容标签(落库前过 normalizeTags,判据4)。
-- source 现在只有 'rule'(代码算的);留给 v2 的"模型提议"(那时这一列才有第二种值)。
CREATE TABLE IF NOT EXISTS memory_tag (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  tag        TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'rule',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq, tag)
);
CREATE INDEX IF NOT EXISTS idx_memory_tag_tag ON memory_tag(tag, session_id);

-- ---------------------------------------------------------------------------
-- 中期 / 长期记忆:**固化下来的"值得记住的事"**(2026-10-01,D78)
--
-- 为什么要有这张表:标签检索(**按话题命中**)只能想起"有人问到相关话题"的事。
-- 而"值得记住的事"可能**永远没人问** —— 第一次、答应过的事、"你答不上来我就再问一遍"。
-- 所以一天几次**回头**(consolidate)把最近轮次按**代码算的分数**过一遍,
-- 够分的固化成一条,分两档存:
--
--   · mid  —— 中期(情景记忆的味道):几天内的事,过了 TTL 就不再注入(不删);
--   · long —— 长期(语义记忆的味道):承诺 / 第一次 / 身份这类,**不因久远被淘汰**。
--
-- ⚠️ 这是一段**模板字符串**:注释里不能出现反引号(犯过两次,启动时才炸)。
-- reasons 存"为什么它够格"(给日志与复核用) —— 判据②要求每条都说得出为什么。
-- tags 存这条记忆的标签,读取侧靠它与当前话题求交集(中期通道用)。
-- source 是 session_id#seq,**唯一**:同一轮固化两次也只会有一条。
CREATE TABLE IF NOT EXISTS note (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation TEXT NOT NULL,
  source       TEXT NOT NULL,
  at           INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  tier         TEXT NOT NULL,        -- 'mid' | 'long'
  score        REAL NOT NULL,
  reasons      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '',
  text         TEXT NOT NULL,
  -- P1-C(2026-10-19,ADD-only 软失效):取代它的那条 note 的 id
  -- (规则版冲突:同一段会话、同 kind、不同 value)。
  -- 只增列 + 新增 ensureNoteSchema 补列,**不动 MEMORY_VERSION**(与 fts_text 同一先例:
  -- 老库补列即可,不触发一次破坏性的整库重导,见 D77)。
  superseded_by INTEGER,
  -- P1-D 预留:近重复合并的目标(P1-C 这一版**不写**;只加列,免得下次又要迁移)。
  merged_into   INTEGER,
  -- P1-C:这一条被"更新的说法"取代的时刻(毫秒)。
  -- NULL = 仍有效。⚠️ 不物理删 —— 被取代的说法以后又被说出来时,要能**重新落一条有效行**
  -- (ADD-only 语义:历史是账本,不是当前状态)。
  invalid_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_source ON note(source);
CREATE INDEX IF NOT EXISTS idx_note_tier_at ON note(tier, at DESC);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ---------------------------------------------------------------------------
-- **访问记录:这条记忆被想起过几次、最后一次是什么时候**(2026-10-01 第二批,D89)
--
-- 为什么要有它(两个真问题,都是量出来的):
--   · **同一条反复被端出来**:D75 的离线演练实测"同一条 identity 记忆在 7 次命中里出现 6 次";
--     1.32.0(D82)先上了一半(进程内 30 分钟窗口),但**跨代就没有记忆** —— 重启之后
--     又开始端同一条,而一条被端过几十次的记忆本该让让位;
--   · **recency 量错了对象**:原来看的是"这条事发生在多久以前"(turn.at 那一列),
--     与"它被端出来过几次"无关 —— 于是一条老记忆只要话题撞上就永远排第一,
--     "被反复想起"这件事永远不会让它降权。
--
-- 键是 source = 会话 id 拼 # 再拼 seq,与 note.source **同一套 id**,
-- 于是标签检索与固化记忆共用一份账(取自哪张表看那个 id 在不在 note 里)。
--
-- ⚠️ 表是**加进去**的(CREATE TABLE IF NOT EXISTS),**不动 MEMORY_VERSION**:
-- 它只增不改、老库少这张表也只是"没有访问记录",不会让任何已有行变得不对
-- (重导是破坏性的,见 D77 —— 判据能不动就不动)。
-- ⚠️ 这是一段**模板字符串**:注释里不能出现反引号(犯过三次,前两次启动时才炸)。
CREATE TABLE IF NOT EXISTS access (
  source        TEXT PRIMARY KEY,   -- 与 note.source 同一套 id:会话#seq
  conversation  TEXT NOT NULL,      -- 哪一段会话(会话级去重与清理按它算)
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_last ON access(last_used_at);
CREATE INDEX IF NOT EXISTS idx_access_conv ON access(conversation);

-- ---------------------------------------------------------------------------
-- **向量:让"相关度"从"对不对词"变成"对不对意思"**(2026-10-02,D92,第二层的 v2)
--
-- 要治的事(D74 就量出来了):标签只能覆盖**约四分之一**的轮次 ——
-- 真人聊天大半是"哦/好/嗯/哈哈",那些**本来就没有标签**,而"命不中的词等于没有"。
-- 实测(2026-10-02,本机 CPU):「今晚吃什么好」↔「说好了请你吃夜宵」余弦 **0.773**、
-- 「你能喝冷的吗」↔「我胃不好不能喝冰的」**0.796**;"字面零重合"的
-- 「你最近怎么样」↔「我昨晚做得好累」**0.663** —— 这几对标签层永远命不中。
--
-- ⚠️ **一个大坑,实测出来的**:绝对相似度**很挤** —— 不相关的一对也能到 **0.627**。
-- 所以**不能用固定阈值**当唯一闸门(0.65 会放进不相干的,0.70 会漏掉 0.663 的真命中);
-- 打分用 标签 + α·相似度,另用"**相对幅度**"(比同批其他候选高出多少)当第二道闸。
--
-- 形状:
--   · key 与 note.source / access.source 同一套(会话#seq),于是三层共用同一个 id 空间;
--   · model 与 dim 存下来:**换模型/换维度时必须能看出旧向量作废**
--     (而不是静默算出一堆乱码相似度 —— 那正是"诊断工具说谎"的形状);
--   · 向量按 **float32 小端** 存 BLOB:node:sqlite 没有向量类型,而 BLOB 比 JSON 数字省一半以上。
-- ⚠️ 它是**只增表**,不动 MEMORY_VERSION;没有向量的库行为与上一版完全一致(没有语义那一维)。
CREATE TABLE IF NOT EXISTS embedding (
  source     TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embedding_model ON embedding(model);

-- ---------------------------------------------------------------------------
-- **实体共现:让"这个人/这个概念"串起多轮**(2026-10-19,P1-F,方案 §5)
--
-- 要治的形状:「副实例最近怎么样」这种**实体类问题**,标签词表常常一个都不命中
-- (人名不是词表里的标签),语义那维又只能救"意思近"的 —— 而"哪些轮次提到过
-- 副实例"这件事,本来就是**字面共现**,不需要任何模型调用。
--
-- 形状(派生数据,**可整表重建** —— 名单变了/规则变了就 rebuild,与 meta 无关):
--   · entity:实体名册(name 唯一;kind = person 认识的人 / concept 学会的概念);
--   · entity_mention:(entity_id, source) = 这个名字出现在哪一轮(source = 会话#seq,
--     与 note.source / access.source / embedding.source **同一套 id 空间**)。
--
-- ⚠️ 三条边界:
--   · **只做共现,不做关系抽取**(方案原话):mention 只说"这轮出现过这个名字",
--     不说"这两个人是什么关系";
--   · **显示名不是身份**(D09):同名就同名 —— 换 display 只影响重建后的名单,不迁移历史行;
--   · **匹配 = 整名 includes**,不做分词 —— 「饭否」要靠完整名字串命中,
--     短名误伤(「饭」)由名单来源自己把关(person.display 是整名)。
-- ⚠️ 这是一段**模板字符串**:注释里不能出现反引号(犯过三次,前两次启动时才炸)。
CREATE TABLE IF NOT EXISTS entity (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'name'   -- person / concept
);
CREATE TABLE IF NOT EXISTS entity_mention (
  entity_id INTEGER NOT NULL,
  source    TEXT NOT NULL,            -- 会话#seq(与 note.source 同一套 id)
  PRIMARY KEY (entity_id, source)
);
CREATE INDEX IF NOT EXISTS idx_entity_mention_source ON entity_mention(source);

-- ---------------------------------------------------------------------------
-- **常驻记忆块:必须永远在场的几句话**(2026-10-19,P1-E,方案 §4;照搬 Letta memory blocks)
--
-- 要治的形状:身份/关系/约定这类"永远该在场"的事,靠检索**碰运气** ——
-- 标签不命中、语义不近,她就"忘了自己答应过什么"。常驻块 = 每代首轮**必**注入的 XML,
-- 不经过检索。四块固定:关于她(read_only,人设锚点,模型改不动)/ 关于主人 / 关系状态 / 约定。
--
-- 写入路径只有一条:**后台生成**(摘要拍,≈1 次/天,失败保留旧值)。
-- 旧值不删 → memory_block_history(回滚/审计)。read_only 块生成器**跳过**,任何写路径都拒。
-- ⚠️ 这是一段**模板字符串**:注释里不能出现反引号(犯过三次,前两次启动时才炸)。
CREATE TABLE IF NOT EXISTS memory_block (
  label       TEXT PRIMARY KEY,     -- about-her / about-owner / relation / promises
  description TEXT NOT NULL,        -- 这块管什么(给生成模型与审计看)
  value       TEXT NOT NULL DEFAULT '',
  limit_chars INTEGER NOT NULL DEFAULT 200,
  read_only   INTEGER NOT NULL DEFAULT 0,
  model       TEXT,                 -- 哪个模型写的(审计)
  updated_at  INTEGER,
  build_ms    INTEGER
);
CREATE TABLE IF NOT EXISTS memory_block_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,        -- 换下来的旧值(prev_value,回滚/审计用)
  replaced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_block_history_label ON memory_block_history(label, replaced_at DESC);

-- ---------------------------------------------------------------------------
-- **滚动摘要:很久以前的事,压成几百字**(2026-10-02,D91;这是分层记忆的**第三层**)
--
-- 为什么需要它:交接(D39)那 1400 字的预算**早就顶满了**(实测 1399),于是"更早的"那一截
-- 只能一行一轮地挤进去 —— 越久以前越挤不下,最后整段消失。摘要换的是**同一份预算里的效率**:
-- 几百字覆盖几周,而一行一轮只覆盖几轮。
--
-- 三个坑(设计时写死,见 docs 的 D91):
--   1. **不在启动路径上同步调模型** —— 交接那一刻只用**已经缓存好的**摘要;
--      过期了就在后台重算,下一次交接才用上(宁可这次用旧摘要,也不让对话卡住);
--   2. **防她背摘要** —— 提示词里写明"这是背景、不是台词",措辞与交接块一致;
--   3. **可重建** —— 它是派生数据,规则一变就重算(靠 SUMMARY_VERSION 判,与 MEMORY_VERSION 分开)。
--
-- 覆盖到哪一轮 = covers_up_to 那一列(session_id#seq),它同时是增量重算的游标。
-- ⚠️ 这是一段**模板字符串**:注释里不能出现反引号(犯过三次,前两次启动时才炸)。
CREATE TABLE IF NOT EXISTS summary (
  conversation  TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  covers_up_to  TEXT NOT NULL,   -- 覆盖到哪一轮(session_id#seq);也是增量重算的游标
  covered_turns INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  build_ms      INTEGER
);

-- ---------------------------------------------------------------------------
-- **知识库:第二个记忆来源**(2026-10-02,D95)。对话记忆是"她/你说过的话",
-- 知识库是"**她在原作里经历过的**"(用户口径:她本人经历过原作故事,所以那是她的记忆)。
--
-- ⚠️ 三条理由,解释它为什么在这张库里、又为什么**必须单独两张表**:
--   1. 它是**外部资料的索引**(和 turn 一样可再生:源文本在用户手里)→ 归 memory.db,不归 state.db;
--   2. 它**绝不能混进 turn 的候选池** —— 那是"你们之间发生过的事";混了就会开始编共同经历;
--   3. 它**永不进交接 / 摘要 / 固化 / 关于人的事实** —— 那四处是对话记忆的地盘(判据见 D95)。
--
-- 幂等键是 (slug, edition):同一部作品的不同进度是**两份**资料("动画第二季"与"小说第13卷")。
-- ⚠️ 这段是**模板字符串**:注释里不要出现反引号(犯过三次)。
CREATE TABLE IF NOT EXISTS doc (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,      -- konosuba / blue-archive
  edition     TEXT NOT NULL,      -- 动画第二季 / 小说第13卷 / 设定集
  title       TEXT,               -- 给人看的名字
  source      TEXT,               -- 从哪来(URL / 文件名 / 谁给的)
  license     TEXT,               -- 能不能再分发(原作文本只在本机,别外传)
  chars       INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(slug, edition)
);

-- 切块:检索的最小单位。带 doc_id + seq,所以"这条是从哪一段来的"永远答得出来。
CREATE TABLE IF NOT EXISTS doc_chunk (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id  INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  heading TEXT,
  text    TEXT NOT NULL,
  chars   INTEGER NOT NULL,
  UNIQUE(doc_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_doc_chunk_doc ON doc_chunk(doc_id, seq);

-- ---------------------------------------------------------------------------
-- **记忆洞察:跨多条固化记忆的模式总结**(2026-10-22,P2-A,方案 §4.4;
-- 照搬 GenAgents reflection(定期对最近的记忆做一次反思、产出少量高层结论)
-- 与 Mem0 Synthesis(结论必须带来源引用,可审计)。数字 = D250 定稿 #6:
-- 1 次/天 × 最近 30 条 note × ≤3 条 × ≤120 字。)
--
-- 与 P1-E 常驻块的分工:块管"身份/关系/约定"这几句**永远该在场**的话(可被生成改写);
-- 洞察管"**从多条记忆里看出来的模式**"(如「他最近常熬夜」「你们在冷战」)——
-- 它不是任何一条 note 的复述,复述是检索的活。
--
-- **只增不改**:没有 UPDATE / DELETE 路径,旧洞察永远留着可审计
-- (与 memory_block_history 的审计纪律同族;它**不是**派生可重建的索引,
-- 重生成一次的钱虽小但没必要,旧值留着还能对照"当时的判断")。
--
-- derived_from = 这条洞察由哪些 note.id 看出来的(JSON 数组,**必须是真实 note.id**;
-- 生成侧拒收假引用 —— 引用答不出"从哪看出来的"的洞察不许入库)。
-- ⚠️ 表是**加进去**的(CREATE TABLE IF NOT EXISTS),**不动 MEMORY_VERSION**;
--    老库下次 openMemory 自动获得,没有这张表时读写两端都降级为"没有洞察"(零影响)。
-- ⚠️ 这是一段**模板字符串**:注释里不能出现反引号(犯过三次,前两次启动时才炸)。
CREATE TABLE IF NOT EXISTS insight (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  text         TEXT NOT NULL,     -- 一条洞察(第三人称事实陈述,≤120 字)
  derived_from TEXT NOT NULL,     -- JSON 数组:真实 note.id 列表(可审计的出处)
  model        TEXT,              -- 哪个模型写的(审计)
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insight_created ON insight(created_at DESC);
`;

/**
 * 记忆库格式版本。改了表结构**或判据**(`classifyKind` / 注入行解析 / 标签规则)就 +1。
 *
 * ⚠️ **为什么判据也要进版本号**:幂等键是 `(会话, seq)`,`INSERT OR IGNORE` 只插新行、
 * **不会更新已存在的行**。所以改了分类规则却不重建,旧行会带着**旧分类永远留着** ——
 * 库看起来是好的,内容却在说谎。`archivePass` 检测到版本不一致时会**整库重导**
 * (它只是派生索引,重导没有任何风险)。
 *
 * v2 → v3(2026-09-30):加了 `memory_tag`。**这一版必须重导** —— 否则
 * `CREATE TABLE IF NOT EXISTS` 只会建出一张**空表**,老库永远没有标签,
 * 而库看起来完全正常(和 known_group 那次一模一样,见 `src\sqlite-store.js` 的迁移注释)。
 *
 * v3 → v4 / v5(2026-09-30,同一次改动里的两次收紧):桥自己写的轮次不算"人说的话"。
 * **v4 只上了第一道闸**(`NON_MEMORY_KINDS`:暖群/自发/命令/手势),离线演练当场又抓到第二条漏网的
 * —— **早安那一路的 kind 是 `mention`**(它的措辞里没有暖群那几个判据),于是
 * 「现在是早上,你可以跟大家打个招呼」照样成了"回忆";所以 v5 补上**正文首句**那道闸
 * (`isInjectedBlock`)。这正是"判据也要进版本号"的现场用例:`INSERT OR IGNORE` 不更新已有的行,
 * 不重导那 121 条**错标签会永远留着**,而库看起来完全正常(实测:v3 跑完覆盖率虚高成 45.7%
 * —— 将近一半"记忆"是桥在跟自己说话)。
 * v5 → v6(2026-10-01,见 D77):**词表收窄** —— `person` 不再含"她自己的名字"(被叫到不是内容),
 * `time` 不再含「今天/明天/昨天」(太泛)。实测:主实例 39 条 `person` 轮次里 33 条是「主实例」造成的、
 * 12 条只带 `time` 的轮次里 10 条是那三个词造成的 —— 不重导,这些噪声标签会永远留着。
 *
 * 📌 **2026-10-01(D78)起:纯"标签规则"的改动不再需要动这个号。**
 * 因为 `archivePass` 每拍都会 `retagAll()` —— 标签永远按**当前**规则与当前人名表重算。
 * 这个号现在只留给**分类/表结构**这类改了才必须重导的东西。
 */
export const MEMORY_VERSION = 6;

/**
 * **关键词通道的 FTS5 表**(P1-A,2026-10-18)。
 *
 * 为什么是独立虚表而不是 external-content 表:我们的 `turn` 主键是复合键
 * `(session_id, seq)`,FTS5 的 external content 要单列 `rowid` —— 独立表
 * 把 `session_id`/`seq` 当 UNINDEXED 列存着更直白,也免了 rowid 对齐的坑。
 *
 * ⚠️ 中文必须走 **bigram 列**(`fts_text` 存空格分隔的单字+双字):
 *    FTS5 官方文档写死 `trigram` 要求 ≥3 个字符(「小甲」「开心」2 字词一行都匹配不到),
 *    而 `unicode61` 不切连续汉字(整串当一个 token)。
 */
export const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
  session_id UNINDEXED,
  seq        UNINDEXED,
  fts_text
);
`;

/**
 * **摘要规则的版本**(2026-10-02,D91)。改了"怎么摘 / 摘什么 / 提示词"就 +1 → 下次会重算。
 *
 * ⚠️ 与 `MEMORY_VERSION` **分开**:那个管"轮次与标签怎么分类"(改了要整库重导,是破坏性的);
 * 这个只管摘要文本(重算是**纯增量**的,而且摘要本来就是派生数据)。
 * 混在一起会让"只想改摘要的措辞"变成一次危险的整库重导(D77 那 67 轮就是这么丢的)。
 *
 * v1 → v2(2026-10-02,同日):**改成第三人称事实陈述**。第一版用"她的口吻"写,
 * 实测那 8 段读起来全是台词(「开局谁管饭吾就认谁当队友…」)——
 * 而摘要每代都会进提示词,等于给她一段**现成的台词**。用户拍板改成档案式陈述。
 * ⚠️ **必须推版本号**才能生效:`summaryDue` 判的就是它(缓存不会自己失效)。
 *
 * v2 → v3(2026-10-29,T1-C):摘要任务的输入从"多来源共享的累积会话"改为**无状态任务轮**
 * (engine.runIsolatedTurn,每次自带全量材料)。旧版本生成的摘要可能吸收过跨来源材料 ——
 * 读侧版本闸停用旧摘要(交接回落原文层),summaryDue 判 due 后按新规则重建;原行保留不删。
 */
// v3 → v4 (F1)：旧 notes/rawText 可能污染输入；读闸停用 v3，按清洁归档重建，原行不删。
export const SUMMARY_VERSION = 4;

/** 摘要要写多少字(模型的软上限)。它是**行为预算**,不是技术上限:太长她就容易背摘要。 */
export const SUMMARY_TARGET_CHARS = 400;
/** 交接里分给摘要的预算。与"最近几轮"分开算,不互相挤(判据③)。 */
export const SUMMARY_BUDGET_CHARS = 480;
/**
 * 攒够这么多**新轮次**才值得重算一次摘要。
 *
 * 为什么不是"每轮都算":一次模型调用约 2 秒 + 一笔 token,而摘要的变化很慢
 * (它覆盖的是几周尺度的事)。12 轮 ≈ 一段真实对话的一两个来回。
 */
export const SUMMARY_REFRESH_TURNS = 12;

/** 模型说"这轮不发言"时的哨兵,和 group-context.js 保持一致。 */
const SILENT = '[跳过]';

/**
 * harness 自己插进来的**非用户消息**。
 *
 * 实测踩到:`dsh` 会在真实用户消息之后**再发一条 `user/message`**,内容是
 * `<system-reminder>…Instructions from: AGENTS.md…`(工作区指令;角色卡一改就会来一条),
 * 以及 `Current runtime context.…`(运行期快照)。它们不是人说的话,而且**会打断一轮**:
 * 不挡掉的话,真实那条会变成"没有回复的空壳",回复被记到 reminder 名下 ——
 * 主实例的归档里因此多了 143 条假"用户发言",内容全是英文的指令说明。
 */
const HARNESS_INJECTED = /^\s*(<system-reminder>|Current runtime context\.)/;

/**
 * 把会话 id 拆开。
 *
 * `qqbot-group-<openid>-g10` → 场合 group、目标 openid、代数 10;
 * 第一代没有 `-g` 后缀(见 `src/dsh.js` 的 `sessionIdForGeneration`)。
 */
export function parseSessionId(id) {
  const text = String(id ?? '');
  const gen = /-g(\d+)$/.exec(text);
  const generation = gen ? Number.parseInt(gen[1], 10) : 1;
  const base = gen ? text.slice(0, gen.index) : text;
  const scene = /^qqbot-(group|c2c)-/.exec(base);
  return {
    id: text,
    conversation: base,
    scene: scene ? scene[1] : 'unknown',
    target: scene ? base.slice(scene[0].length) : null,
    generation,
  };
}

/**
 * 从工作区路径推出 dsh 的会话目录名。
 *
 * ⚠️ 规则是**实测**出来的(D170,2026-10-08),不是猜的:
 *   · `:` `\` `/` → `-`;
 *   · **非 ASCII 字符** → `~` + **UTF-16 code unit** 的十六进制(大写、4 位)。
 *     证据:`<某工作区>` 的真实目录是 `--E-DSH-~5DE5~4F5C~5B66~4E60--`
 *     (工=U+5DE5 / 作=U+4F5C / 学=U+5B66 / 习=U+4E60,正好对上)。
 *
 * ⚠️ 老实现**保留中文**(算出 `--E-DSH-工作学习--`),后果是两个:
 *   ① `findSessionFiles` 找不到目录 → 退化成"扫所有工作区"(会把别的桶的会话收进来,**而且不出声**);
 *   ② `console.js doctor` 对任何**中文工作区**报**假的"身份校验不符"**,
 *      还建议你去"修/隔离"那份**根本没坏**的日志 —— 而 `docs\13` 那次事故正是动日志引起的。
 */
export function sessionDirName(workspace) {
  const body = String(workspace ?? '')
    .split('')                                   // ⚠️ 按 UTF-16 code unit 切,别用 [...str](那是码点)
    .map((ch) => (ch.charCodeAt(0) > 0x7f
      ? `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      : ch))
    .join('')
    .replace(/[:\\/]+/g, '-');
  return `--${body}--`;
}

/**
 * 把"目录名"和"工作区路径"**同一化**成一个比较键:解开 `~XXXX`、分隔符统一、去头尾、小写。
 *
 * 用途:**公式没算中时按名字找**。两边都过一遍这个函数,就能不管谁写得"更规范"地比对上
 * (老实现保留中文 vs DSH 写 `~XXXX` —— 折成同一个键就一致了)。
 */
export function workspaceKeyOf(value) {
  return String(value ?? '')
    .replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[:\\/]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// **"静默失明"的判据**(D169):会话日志换了大版本时,读取端会安静地什么都收不到
// ---------------------------------------------------------------------------

/**
 * **读取端认识的会话文件版本**。
 *
 * ⚠️ 会话日志的文件名里带着**格式版本**:`session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`。
 * 那是 DSH 自己的格式号(与 App 版本无关),换大版本时文件名跟着换。
 * 读取端如果**写死只认一个版本**,表现是:
 *   · 一个文件都找不到 → `archiveOnStartup` **直接 return,连日志都不打**(最安静的一种);
 *   · 或者只收到旧的那些、新增恒为 0 → 日志写着"本次新增 0",
 *     和"今天没人说话"**长得一模一样**。
 * 📌 现场(2026-10-08):桌面版已经写 **v4** 了,而桥只认 **v3**。机器人目前没事
 *    (它跑的 runtime 就是 v3),但**格式一动,这边不会报错、只会变空**。
 *    → 所以要有这条判据:**不认识就明说**,而不是安静地少收。
 * ⚠️ **2026-10-15 应验了**:磁盘上**已经全是 v4**(73 个 qqbot 会话文件),而这张表还是 `[3]`
 *    ⇒ `findSessionFiles` 一个文件都没返回 ⇒ `archiveOnStartup` 走了那条静默 return
 *    ⇒ `usage-compare` 的 DSH 侧**恒读 0**(它的报表上写着"全库 qqbot* 混 bot",读数是 0)。
 *    那次的教训不是"再加一条判据"(判据早就写了),而是:**文件名表与版本表必须是同一份**。
 */
export const KNOWN_SESSION_VERSIONS = Object.freeze([4, 3]);
/** 会话文件名的**唯一一份**清单(按优先级:新的在前)。`findSessionFiles` 与上面那张版本表都由它派生 ——
 *  两处各写一遍就会再次漂成"磁盘 v4 / 读取端 v3"那个样子(`scripts\selftest-session-version.js` 钉着)。 */
export const SESSION_FILE_NAMES = Object.freeze(KNOWN_SESSION_VERSIONS.map((v) => `session.v${v}.jsonl.zstd`));

/** `session.v4.jsonl.zstd` → `4`;不是会话文件 → `null`。 */
export function sessionFileVersion(name) {
  const matched = /^session\.v(\d+)\.jsonl\.zstd$/.exec(String(name ?? ''));
  return matched ? Number(matched[1]) : null;
}

/**
 * 一批文件名里**存在、但读取端不认识**的版本 → `[{ version, count }]`(按版本升序)。
 *
 * @param {string[]} names 文件名(不是路径;扫目录是调用方的事)
 * @param {{known?: number[]}} [options]
 */
export function unknownSessionVersions(names, { known = KNOWN_SESSION_VERSIONS } = {}) {
  const knownSet = new Set((known ?? []).map(Number));
  const counts = new Map();
  for (const name of names ?? []) {
    const version = sessionFileVersion(name);
    if (version === null || knownSet.has(version)) continue;
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => a.version - b.version);
}

/** 那条告警的**人话**(日志与别处共用一份措辞,别各写各的)。 */
export function describeUnknownSessions(unknown) {
  const parts = (unknown ?? []).map((u) => `${u.count} 个 v${u.version} 会话`);
  return `⚠️ 有 ${parts.join('、')}**读不了**(只认识 v${KNOWN_SESSION_VERSIONS.join('/v')})`
    + ' —— 它们会被**静默漏掉**,不是"没有新内容"。'
    + ' 修法:让读取端认识这个版本(`findSessionFiles` / `KNOWN_SESSION_VERSIONS`)。';
}

// ---------------------------------------------------------------------------
// 注入行的解析
// ---------------------------------------------------------------------------

const MOOD_NOTE = /·\s*本轮情绪：([^；\n]+)；\s*(\d+)\s*句以内、不超过\s*(\d+)\s*字(?:；语气词用「([^」]*)」)?(?:；句尾可以带\s*(\S+))?/;
const STATE_NOTE = /·\s*身体状态（照做但别念出来）：([^\n]+)/;
const TOPIC_NOTE = /这轮的话题方向：([^\n]+)/;
// 风格要求是最后那几行 `· 这次…`,排除掉上面两条已知的编号项。
const NUDGE_NOTE = /^·\s*(这次[^\n]+)$/gm;

/** 触发方式的判据。**这些短语是 bridge 自己写的**,所以能当判据 —— 但也因此,
 *  改了 `src/index.js` 里的提示词就要回来改这里(每条都有测试钉着)。
 *
 *  ⚠️ 判"纯表情/戳一戳"时不能直接在原文上锚行首:原文是 `[群聊] [大表情：x]`,
 *    行首是**场合标记**。所以先用 `stripInjectedNotes` 剥出正文再判 ——
 *    和 bridge 自己判"纯表情"的口径一致:带文字的表情**不算**纯表情。 */
const KIND_MARKERS = [
  // ⚠️ 两种播报模式都要认:verbatim 发的是 `【更新播报】…`,
  //    而 character 模式发给模型的是 `【系统】请把下面这条更新播报**用你的语气**说出去。…`
  //    —— 只认前者的话,character 模式的播报会被判成普通对话,于是
  //    ①"排除播报"失效 ②交接的预算被整篇更新日志吃光(实测踩到)。
  { kind: 'announce', test: (t) => t.includes('【更新播报】') || t.includes('这条更新播报') },
  { kind: 'poke', test: (t) => /^\[戳一戳/.test(stripInjectedNotes(t)) },
  { kind: 'face', test: (t) => /^\[(大)?表情[:：][^\]]*\]$/.test(stripInjectedNotes(t)) },
  { kind: 'warmup', test: (t) => t.includes('把气氛带起来') || t.includes('只当开场白') },
  { kind: 'self', test: (t) => t.includes('插话') || t.includes('没什么想说的') || t.includes('没必要理') },
  // ⚠️ **1.106.4(D176):她自己过日子那一路原来没有 marker** ——
  //    于是"她自己冒泡/报备/抛钩子"的提示词被判成兜底的 `mention`(="人说的话"),
  //    2026-10-10 现场:18:14 那条自发发言在归档里是 `kind=mention`。
  //    判据收在 `isSelfLifePrompt()` 一处(1.106.5 起 `src\transcript.js` 也用它)。
  { kind: 'selflife', test: (t) => isSelfLifePrompt(t) },
  // ⚠️ 这里**不能用 `\b` 结尾**:JS 的 `\w` 只认 ASCII,中文是"非单词字符",
  //    所以 `/(状态)\b/` 永远匹配不上 —— 实测 `/状态` 被判成了 mention。
  { kind: 'command', test: (t) => /^\s*\/(重置|重来|reset|状态|status|更新|播报|release|群列表|groups|群)(\s|$)/.test(t) },
];

/**
 * **这一轮是不是"她自己过日子"那一路的提示词**(纯函数,1.106.4/D176 + 1.106.5/D177)。
 *
 * ⚠️ 判据**只此一份**:归档用它判 `kind='selflife'`,`src\transcript.js` 用它把
 * "她自己开口"和"谁点了她"分开显示(现场:`transcript.js` 把桥这段提示词印成 `[点名/触发]`)。
 * 措辞来自 `src\selfcare.js` / `src\story.js` 里那几段提示词的**固定说法**:
 *   · 生活/吃饭/事件钩子开场:`…就是自己过日子的间隙…`
 *   · 到达报备:`你刚自己走了一趟，现在到了…`
 *   · 出发报备:`你正自己往别处走（不是谁叫你去的）`
 *   · 钩子收尾:`你之前提过一件事…`
 */
export function isSelfLifePrompt(text) {
  const t = String(text ?? '');
  return t.includes('自己过日子的间隙') || t.includes('你刚自己走了一趟')
    || t.includes('你正自己往别处走') || t.includes('你之前提过一件事');
}

/** 这一轮是怎么来的。 */
export function classifyKind(text) {
  const haystack = String(text ?? '');
  for (const marker of KIND_MARKERS) {
    if (marker.test(haystack)) return marker.kind;
  }
  // 定时暖群与自发接话都靠 bridge 的提示词判;都判不出来时,按"被叫到"处理 ——
  // 那是最常见的来源,而且不会把一次真实对话误标成机器自己开口。
  return 'mention';
}

/**
 * **这些轮次的正文不是"人说的话",所以不产生长期记忆**(v1,见 `docs\03` D75)。
 *
 * v1 的离线演练当场抓到的第二类"把请求当内容" —— 而且比第一类更大:
 *
 * | kind | 正文其实是 |
 * |---|---|
 * | `warmup` | 桥写的暖群提示词(`群里已经安静了一会儿。你可以主动开口说一句…`) |
 * | `self` | 桥写的自发接话提示词(`…如果没什么想说的,就只回复 [跳过]`) |
 * | `command` | 操作者的命令 |
 * | `announce` | 桥写的播报指令(D39 已把它们排除在交接之外) |
 * | `poke` / `face` | 平台给的**手势占位句**(`[戳一戳]` / `[大表情：x]`),没有人的话 |
 *
 * 实测(2026-09-30,主实例的库):被打上标签的 270 轮里有 **121 轮(45%)** 是 `self`+`warmup`
 * —— 也就是说"长期记忆"里将近一半是**桥在跟自己说话**("现在是早上,你可以跟大家打个招呼")。
 * 那不是回忆,那是排程。
 *
 * ⚠️ `self` 那 428 轮里**没有人的原话**:人说的话在正文后半段的群上下文里,
 * 而 `stripInjectedNotes` 会把它剥掉(交接也是这个口径)。所以排除它们**不会丢任何人的话**。
 * 真正有人说话的只有 `mention`(而早安那路是 mention,得靠 `isInjectedBlock` 再挡一次)。
 *
 * ⚠️ **1.106.4(D176)加 `selflife`**:她自己过日子那一路(冒泡/报备/钩子开合)也一样 ——
 * 正文是桥写的提示词,不是人说的话。用户 2026-10-10 的口径是「**鸡毛蒜皮、有重复性的日常不用记**,
 * 有特殊性的事情可以记」—— 所以:
 *   · **她自己那些话不进记忆层**(这里挡掉:不进标签、不进长期、不进"关于人的事实");
 *   · **有特殊性的那几件**(委托/生病/小事件收尾)**照旧进摘要** —— 但它们**不靠她的话**,
 *     而是从 `stats_event` 经 `chronicle.js` 派生(见 `index.js` 的 `summaryTick`)。
 *   · 编年史(面板"你不在的时候")**照旧留着**她自己过日子那些行 —— 那是观测,不是记忆。
 *
 * ⚠️ **2026-10-22 加 `residue`**(量化出处:`.archify\FTS封顶与重复归档量化-20261022.md` §二):
 * 桥注入的**残文**(「最近群里的消息（供你参考…」「（这一轮的事实…」「你之前提过一件事…」
 * 等固定形状,判据见 `RESIDUE_RULES`)原来混在 `mention` 里 —— 主实例库 609 行、副实例 64 行,
 * 是"最大的重复归档来源"。这些行的 kind 现在标成 `residue`:**账本行留着**(不物理删),
 * 只是检索(`candidatesFor` / FTS)/固化(`consolidate`)/标签/实体/向量回填/摘要取样
 * (`conversationMemory`)一路都拿不到它们 —— 和 v4 挡暖群是同一道闸的第二批客户。
 * ⚠️ `MEMORY_VERSION` **没有**动:kind 是 TEXT 列,不重导;旧行由
 * `scripts\clean-archive-residue.mjs` 清洗(默认 dry-run,--apply 前先 VACUUM INTO 备份)。
 */

/** 残文行的 kind(判据见下面的 `RESIDUE_RULES`)。在 `NON_MEMORY_KINDS` 里 ⇒ 检索/固化/标签/实体/向量回填一路自动挡。 */
export const RESIDUE_KIND = 'residue';

export const NON_MEMORY_KINDS = Object.freeze(['announce', 'warmup', 'self', 'selflife', 'command', 'poke', 'face', 'tool', RESIDUE_KIND]);

/**
 * **这段会话是不是工具/自检会话**(不是真对话)。
 *
 * ⚠️ 2026-10-06(D135)把它从 `memory-store.js` **挪到这一层**(单一口径),并让归档处直接用它
 *    标 kind。原来它只挡住**向量回填**那一条路,而工具会话的轮次被 `classifyKind` **兜底判成
 *    `mention`** —— 而 `mention` 属于"人说的话"(`NON_MEMORY_KINDS` 里没有它),于是
 *    **摘要指令本身被固化成了她的长期记忆**:实测(2026-10-06)主实例 46 条固化里 **9 条**、
 *    副实例 23 条里 **6 条**是提示词原文(「下面是一段私聊的过往对话记录…请把它压缩成…」)。
 *    这是 D75「把请求当内容」的**同一族**,当年只挡住了桥自己写的暖群/自发提示词。
 */
export const TOOL_SESSION = /qqbot-summary|qqbot-verify|card-eval/i;

/** 这段会话是不是工具/自检会话。**唯一口径** —— bridge 与脚本都从这里拿。 */
export function isToolConversation(key) {
  const text = String(key ?? '');
  if (text === '') return false;
  return TOOL_SESSION.test(text);
}

/** 这一轮里有没有"人说的话"(标签与长期记忆只从这些轮次里长出来)。 */
export function isHumanTurn(turn) {
  if (NON_MEMORY_KINDS.includes(String(turn?.kind ?? ''))) return false;
  // ⚠️ 兜底(2026-10-06,D135):**旧库里的行**是这次改判据之前写进去的,kind 还是 `mention`。
  //    不改 `MEMORY_VERSION` 就不能靠重导来治(源文件可能已被保留策略删掉,见 D77),
  //    所以这里按会话 id 再挡一次 —— 新旧行、新旧库行为一致。
  return !isToolConversation(turn?.session_id ?? turn?.conversation);
}

/**
 * 去掉注入说明,留下"人说的话"。
 *
 * 两段都要剥:
 *
 * 1. **风格/情绪注入行** —— 以 `（本次表达要求，照做但不要念出来：）` 开头
 *    (见 `src/style.js` 的 `withStyleNudge`),后面全是给模型的指令;
 * 2. **群上下文前言** —— 群聊里被 @ 时,bridge 会把缓冲的群消息拼在**人话之后**
 *    (`最近群里的消息（供你参考，不必逐条回应）：…`,见 `src/group-context.js`)。
 *    不剥的话,归档里"用户说的话"会变成 `我问你要多少分钟 最近群里的消息（供你参考…）：副实例：…`,
 *    交接时又长又莫名。
 *
 * 不剥的话统计"用户说了多少字"也会把每轮那几十字的要求算进去。
 */
export function stripInjectedNotes(text) {
  const source = String(text ?? '');
  // ⚠️ 2026-10-18(P0-2 注入卫生):`（这一轮的事实` 也必须切。
  //    它由 `src\style.js` 的 `withFacts` 贴在**消息之后**,是桥给模型的"这一轮的事实"
  //    (网页绑定/身份那句),不是人说的话。漏切的话它会被当成人话归档 ——
  //    实测主实例库 479 轮带这一块、153 条 note 把它写进了记忆正文(假记忆)。
  const cut = source.search(/（这一轮的事实|（本次表达要求|最近群里的消息（供你参考/);
  const body = cut >= 0 ? source.slice(0, cut) : source;
  return body
    .replace(/^\s*\[(群聊|私聊)\]\s*/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 这一轮的"用户消息"其实是**桥自己写的**(注入块 / 排程提示词),不是人说的话。
 *
 * 为什么要有这个判据(v1):长期记忆要给每一轮打标签,而两类桥写的正文**长得很像人话**:
 *
 * 1. **记忆交接块**(`【记忆交接】…`)—— 它本身就是"过去对话的摘要"。给它打标签会让
 *    "摘要套摘要"一轮一轮滚起来;
 * 2. **排程提示词**(暖群 / 早安 / 自发接话)—— 例如
 *    `现在是早上。你在跟一个关系很近的人说话。这次不用端着…`。
 *    ⚠️ **早安那一路会被 `classifyKind` 判成 `mention`**(它的措辞里没有暖群那几个判据),
 *    于是"桥的提示词"混进了"人说的话"里 —— 实测它成了长期层挑出来的头几条
 *    (「现在是早上，你可以跟大家打个招呼」被当成一条回忆)。
 *
 * 判据有两级,合起来才够:
 *   · **kind**(见 NON_MEMORY_KINDS)—— 暖群/自发/命令/手势那几路;
 *   · **正文的首句**(这里)—— 早安那一路 kind 判不出来,只能看正文。
 *
 * ⚠️ 首句是**代码常量**,而且有测试拿 `buildMorningPrompt` / `buildWarmupPrompt` 的
 * 真实输出反过来验它 —— 改了措辞就当场红。**不要**靠猜关键词。
 * 它**只服务记忆层**:不改 `classifyKind`,因为那个 kind 还被 D72 的打断率基线用着,
 * 改它等于偷偷挪动别人量过的尺子。
 */
const BRIDGE_PROMPT_STARTS = [
  '现在是早上',           // src\morning.js buildMorningPrompt(私聊 / 群聊两种开场)
  '群里已经安静了一会儿',   // src\warmup.js buildWarmupPrompt
  '下面是群里最近的消息',   // src\index.js 群内自发接话
  '【',                  // 桥的系统提示块:【系统】/【记忆交接】/【更新播报】/【播报账本】
];

export function isInjectedBlock(text) {
  // 存档里的正文已经剥过 `[群聊] / [私聊]`,但两个生成函数吐出来的**没剥** ——
  // 两种形态都要认(测试拿的是生成函数的原始输出)。
  const source = String(text ?? '').replace(/^\s*\[(群聊|私聊)\]\s*/, '').trimStart();
  return BRIDGE_PROMPT_STARTS.some((start) => source.startsWith(start));
}

/**
 * **注入残文闸的规则表**(2026-10-22,评测侧规则下沉 —— D159 只许有一份实现)。
 *
 * 出处:`scripts\eval-memory-recall.mjs` 的 `RESIDUE_RULES` **原样**搬进来(标签逐字未动 ——
 * 评测报告的分桶名就是这些字符串)。每一条都对应一个**在库里真见过**的形态
 * (2026-10-18 在主实例库上量的;2026-10-22 复测:主实例 609 行、副实例 64 行,全混在 `mention` 里,
 * 见 `.archify\FTS封顶与重复归档量化-20261022.md` §二)。顺序有意义:先认桥写的整块,
 * 再认块残文,最后才看长度与占位 —— 消费方一律 first-match-wins。
 *
 * ⚠️ **误伤纪律**:规则只认**桥注入的固定形状**(代码常量前缀/整句/全角括号块),
 * 不认裸关键词 —— 「这一轮的事实性发言」「群里这会儿很安静」(后面没接桥话)不许中。
 * 代价也说清楚:「旧库桥提示词」那条**不锚行首**(实测有 `群里这会儿很安静。你没在跟谁对话…`
 * 这种前面垫了一句的形态),所以**有人逐字打出桥的整句**会被误标 —— 这是评测侧 2026-10-18
 * 起就接受的取舍(「抱歉」没做成关键词是同族),闸跟着评测走,不另设一份宽严。
 *
 * 消费方:归档写路径(`extractTurns` 判 `kind=residue`)、存量清洗
 * (`scripts\clean-archive-residue.mjs`)、评测(`scripts\eval-memory-recall.mjs`)。
 */
export const RESIDUE_RULES = Object.freeze([
  {
    label: '注入块（【记忆交接】【系统】等桥提示词）',
    // 与归档层同一个判据(D135/D176):首句是代码常量,不是猜关键词。
    test: (text) => isInjectedBlock(text),
  },
  {
    label: '注入残文（这一轮的事实 / 本次表达要求 / 系统给的事实方向）',
    // 这些块被拼在**人话之后**(网页身份事实、表达要求),整条样本已经不能当"用户提问"用。
    test: (text) => /（这一轮的事实|（本次表达要求|（系统给的|（系统结算|（下面是你刚才连着的/.test(text),
  },
  {
    label: '群上下文残文（最近群里的消息）',
    test: (text) => text.includes('最近群里的消息（供你参考'),
  },
  {
    label: '旧库桥提示词（你没在跟谁对话 / 你之前提过一件事）',
    // 旧行被 `classifyKind` 兜底判成 `mention`(D135 的同族),kind 挡不住,只能认句子。
    // ⚠️ 不锚 `^`:实测有 `群里这会儿很安静。你没在跟谁对话…` 这种前面还垫了一句的形态。
    test: (text) => /你没在跟谁对话|你之前提过一件事/.test(text),
  },
  {
    label: '非语言占位（图片/表情/戳一戳/纯 @/平台标记）',
    test: (text) => /^（发来一张图片，没有文字）$|^（只 @ 了你，没有说别的）$|^\[(表情|戳一戳)[:：]|<faceType=/i.test(text),
  },
]);

/**
 * 这段正文是不是**桥注入的残文**(不能当"人说的话"进记忆)。
 *
 * 判的对象一律是**落库的 `user_text`**(剥完注入说明的那段)—— 归档、清洗、评测
 * 看的是同一段文本,三处口径才不会分叉(D159)。
 *
 * @returns {string|null} 命中时返回**规则名**(与评测报告的分桶同一个字符串),没中 null。
 */
export function isArchiveResidue(text) {
  const raw = String(text ?? '');
  for (const rule of RESIDUE_RULES) {
    if (rule.test(raw)) return rule.label;
  }
  return null;
}

/**
 * 记忆层的正文清洗(2026-10-01,D78):**把平台的 @ 标记换成可读占位**。
 *
 * 实测踩到:`turn.user_text` 里会有 `<@openid> 我是谁` 这种——
 * 于是 ①`<@id>` 被当成内容(污染注入文本)、②它把长度撑到 39 字、让"说了不少"那条加分虚高。
 * 记忆层要的是**人说的话**,不是平台 id。
 */
const MENTION_MARKUP = /<@!?[0-9A-Za-z_-]{8,}>/g;

export function cleanMemoryText(text) {
  return String(text ?? '')
    .replace(MENTION_MARKUP, '@某人')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从注入行里取出情绪/长度/语气词/身体状态/话题/风格要求。取不到就是 null,不猜。 */
export function parseInjectedNotes(text) {
  const source = String(text ?? '');
  const mood = MOOD_NOTE.exec(source);
  const state = STATE_NOTE.exec(source);
  const topic = TOPIC_NOTE.exec(source);
  const nudges = [...source.matchAll(NUDGE_NOTE)].map((m) => m[1].trim());
  return {
    mood: mood ? mood[1].trim() : null,
    maxSentences: mood ? Number.parseInt(mood[2], 10) : null,
    maxChars: mood ? Number.parseInt(mood[3], 10) : null,
    interjection: mood?.[4]?.trim() ?? null,
    stateLine: state ? state[1].trim() : null,
    topic: topic ? topic[1].trim() : null,
    nudge: nudges.length > 0 ? nudges.join('；') : null,
  };
}

// ---------------------------------------------------------------------------
// 一轮一轮地抽出来
// ---------------------------------------------------------------------------

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('\n');

/** 从一条记录里取"模型说的话"。**排除 reasoning** —— 那是草稿,不是她说过的话。 */
function assistantSay(record) {
  const content = record?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 把一份会话记录解析成"轮"。
 *
 * 一轮 = 一条 `user/message`(或 `agent/inbox/spliced`,那是暖群/自发发言的注入路径)
 *       + 紧跟其后的第一条 `assistant/message`。
 *
 * @param {string} sessionId
 * @param {Array<object>} records 已解码的记录(顺序即写入顺序)
 * @param {{importedAt?: number, file?: string}} [options]
 * @returns {{session: object, turns: Array<object>}}
 */
export function extractTurns(sessionId, records, { importedAt = Date.now(), file = null } = {}) {
  const parsed = parseSessionId(sessionId);
  const list = Array.isArray(records) ? records : [];
  const header = list.find((record) => record?.type === 'session');

  const turns = [];
  let pending = null;

  const flush = () => {
    if (!pending) return;
    turns.push(pending);
    pending = null;
  };

  for (const record of list) {
    const type = record?.type;
    const at = Number(record?.time) || 0;

    // 用户侧。
    //
    // ⚠️ **只认 `user/message`**。暖群/自发发言会先记一条 `agent/inbox/spliced`
    // (那是"把这段插进下一轮"的 SDK 动作),紧接着**同样的文本**又作为 `user/message`
    // 落盘 —— 两条都当一轮的话,每轮都会变成两条(一条有回复、一条回复为 null)。
    // 实测:主实例 2171 轮里有一半是这种空壳。所以 spliced 只是同一个事件的前半截,读它没用。
    if (type === 'user/message') {
      const injected = textOf(record?.data?.content);
      // 不是人说的话 → 不开始新的一轮(详见 HARNESS_INJECTED 的说明)
      if (HARNESS_INJECTED.test(injected)) continue;
      flush();
      const notes = parseInjectedNotes(injected);
      const userText = stripInjectedNotes(injected);
      // ⚠️ 工具会话(摘要/自检/评测)先判 —— 它们的"用户消息"是**桥写的提示词**,
      //    兜底成 `mention` 会让固化/标签把它们当成她说的话(D135)。
      // ⚠️ 注入残文闸(2026-10-22)最后判,**只收"本来会当成人话"的轮次**:classifyKind
      //    已经判进 NON_MEMORY_KINDS 的保持原 kind(别抹掉更具体的分类,D72 的打断率
      //    基线还在用)。判的是**剥完注入说明的 userText** —— 那正是落库、被评测、
      //    被清洗看的同一段文本,三处口径才不会分叉(D159)。
      let kind = isToolConversation(parsed.id) ? 'tool' : classifyKind(injected);
      if (!NON_MEMORY_KINDS.includes(kind) && isArchiveResidue(userText) !== null) kind = RESIDUE_KIND;
      pending = {
        session_id: parsed.id,
        seq: Number(record?.seq) || 0,
        at,
        turn_no: null,
        kind,
        topic: notes.topic,
        mood: notes.mood,
        max_chars: notes.maxChars,
        max_sentences: notes.maxSentences,
        interjection: notes.interjection,
        state_line: notes.stateLine,
        nudge: notes.nudge,
        user_text: userText,
        user_chars: userText.length,
        reply_at: null,
        reply_text: null,
        reply_chars: 0,
        silent: 0,
        in_tokens: null,
        out_tokens: null,
        cache_read_tokens: null,
        reasoning_tokens: null,
      };
      continue;
    }

    if (type === 'turn/start' && pending && pending.turn_no === null) {
      pending.turn_no = Number(record?.data?.turn) || null;
      continue;
    }

    if (type === 'assistant/message') {
      // 没有配对的用户消息(例如卡片改动后的一次性 reminder 之后)也**不丢**:
      // 模型的输出比"干净的一条记录"重要,记成 unknown 的空 user_text 即可。
      if (!pending) {
        pending = {
          session_id: parsed.id,
          seq: (Number(record?.seq) || 0) - 1,
          at,
          turn_no: null,
          kind: 'unknown',
          topic: null,
          mood: null,
          max_chars: null,
          max_sentences: null,
          interjection: null,
          state_line: null,
          nudge: null,
          user_text: '',
          user_chars: 0,
          reply_at: null,
          reply_text: null,
          reply_chars: 0,
          silent: 0,
          in_tokens: null,
          out_tokens: null,
          cache_read_tokens: null,
          reasoning_tokens: null,
        };
      }
      if (pending.reply_text !== null) continue;
      const said = assistantSay(record).trim();
      const usage = record?.data?.usage ?? {};
      pending.reply_at = at;
      pending.reply_text = said;
      pending.reply_chars = said.length;
      pending.silent = said === SILENT || said === '' ? 1 : 0;
      pending.in_tokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : null;
      pending.out_tokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
      pending.cache_read_tokens = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null;
      pending.reasoning_tokens = Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null;
      flush();
    }
  }
  flush();

  return {
    session: {
      id: parsed.id,
      conversation: parsed.conversation,
      scene: parsed.scene,
      target: parsed.target,
      generation: parsed.generation,
      created_at: Number(header?.createdAt) || null,
      cwd: header?.cwd ?? null,
      file,
      turns: turns.length,
      imported_at: importedAt,
    },
    turns,
  };
}

/** 一行摘要,命令行与 handoff 共用。 */
export function formatTurn(turn) {
  const when = new Date(turn.at).toLocaleString('zh-CN', { hour12: false });
  const bits = [when, turn.kind, turn.mood ?? '-'].join(' | ');
  const said = (turn.reply_text ?? '').replace(/\n/g, ' ⏎ ').slice(0, 40);
  return `${bits} → ${said || '(没回)'}`;
}

// ---------------------------------------------------------------------------
// 记忆交接（把"过去"变成一段能塞进提示词的文本）
// ---------------------------------------------------------------------------

/** 交接块的字数预算。它进的是**每一代会话的第一轮**,不是每轮 —— 但也别贪。 */
export const HANDOFF_BUDGET = 1400;
/** 最近这几轮给原文(更精确)。 */
export const HANDOFF_RECENT = 10;

/**
 * 一行一轮里"对方那半句" / "她说的那半句" / 短时间戳。
 *
 * ⚠️ **导出给滚动摘要复用**(2026-10-02,D91):摘要要摘的就是"更早的轮次",
 * 而那几行必须与交接**逐字同一种写法** —— 桥自己写的排程提示词(「现在是早上…」)
 * 在两边都得被换成短标签,否则摘要里会混进"她记得自己被排程过"(D75 那个坑)。
 */
export const shortTime = (at) => {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 模型的机器可读块要剥掉 —— 它是协议,不是她说的话(DB 里保留原文,只在交接时剥)。 */
const INTAKE_BLOCK = /\s*<intake\b[^>]*\/?>/gi;

/**
 * 一行一轮里"对方那半句"怎么写。
 *
 * 自发接话/暖群那一轮的 `user_text` 是**bridge 自己写的指令**
 * ("下面是群里最近的消息。你可以自然地接一句…"),不是人说的话 —— 直接塞进交接里
 * 既占预算又莫名其妙。所以按触发方式换成一个短标签。**回复本身仍然保留**,
 * 她想说什么、群里在聊什么,基本都在回复里。
 */
/**
 * 一行一轮里"对方那半句"怎么写。
 *
 * 自发接话/暖群那一轮的 `user_text` 是**bridge 自己写的指令**
 * ("下面是群里最近的消息。你可以自然地接一句…"),不是人说的话 —— 直接塞进交接里
 * 既占预算又莫名其妙。所以按触发方式换成一个短标签。**回复本身仍然保留**,
 * 她想说什么、群里在聊什么,基本都在回复里。
 *
 * ⚠️ 与 `whatSheSaid` 一起**导出给滚动摘要复用**(D91):两处必须逐字同一种写法。
 */
export function whatWasSaid(row) {
  const kind = row.kind;
  if (kind === 'self') return '（她自己开的口）';
  if (kind === 'warmup') return '（定时暖群）';
  if (kind === 'face') return oneLine(row.user_text, 16) || '（一个表情）';
  if (kind === 'poke') return oneLine(row.user_text, 16) || '（被戳了一下）';
  return oneLine(row.user_text, 40) || '（无文字）';
}

/** 她说的那半句。 */
export function whatSheSaid(row, max) {
  if (row.silent) return '（没回）';
  // ⚠️ 1.167.4 / D273:模型泄漏成正文的 DSML 协议标记**不许当"她说的话"进记忆**
  //    (2026-10-20 当天 memory.db 的 `turn` 里真中过一行;与出站剥除共用
  //    `control-markup.js` 那一份,不许写第二份 —— D159)。
  const said = oneLine(stripLeakedControlMarkup(row.reply_text ?? '').replace(INTAKE_BLOCK, ' '), max);
  return said || '（没回）';
}

/**
 * 把**滚动摘要**接进交接文本(2026-10-02,D91)。
 *
 * 关键口径:**摘要换的是"更早的"那一截,不是外加**。
 * 交接的预算(1400)是**行为预算**、而且早就顶满(实测 1399),如果摘要只是"加在前面",
 * 它就会把最近的原文挤掉 —— 而"最近说过什么"比"几周前的梗概"值钱得多。
 * 所以顺序是:摘要块 → 更早的(剩下的空间)→ 最近几轮(原文,最后一次调用已经保住了)。
 *
 * 三种情况都要能处理:
 *   · 只有摘要、没有"更早的" → 摘要块 + 最近几轮;
 *   · 只有历史、没有摘要 → 原样(与这一层出现之前**完全一致**);
 *   · 两个都没有 → null(调用方就当"没有记忆")。
 *
 * @param {object} options 与 `buildHandoffText` 同一套参数,外加:
 * @param {string|null} [options.summary] 已经缓存好的摘要文本
 * @param {number} [options.summaryBudget] 分给摘要的预算(默认 480 字)
 */
export function buildHandoffWithSummary({
  rows,
  aggregate,
  who = '这个会话',
  budget = HANDOFF_BUDGET,
  recent = HANDOFF_RECENT,
  summary = null,
  summaryBudget = 480,
} = {}) {
  const summaryText = String(summary ?? '').trim();
  const hasHistory = (Array.isArray(rows) ? rows : []).some((row) => row && (row.user_text || row.reply_text));
  if (!hasHistory) {
    if (summaryText === '') return null;
    // 会话文件被清过、或这一代还没归档 —— 摘要仍然有用(它是这段关系里更早的事)。
    const only = summaryText.slice(0, Math.max(0, budget - 160));
    return [
      '【记忆交接】以下是**之前**发生过的，不是现在发生的。',
      '把它当作背景：不要复述、不要说"你刚才说过"、不要提"记忆""交接"这类词。',
      '',
      `（${who}的更早以前：）`,
      only,
      '',
      '（现在开始。）',
    ].join('\n');
  }
  if (summaryText === '') return buildHandoffText({ rows, aggregate, who, budget, recent });
  // ⚠️ **先从总预算里扣掉摘要,再让原文在剩下的空间里铺** ——
  //    反过来的话(原文按满预算生成、摘要再贴前面)总量会超,而那是预算纪律不允许的。
  const room = Math.min(summaryBudget, Math.max(0, budget - 220));
  if (room < 80) return buildHandoffText({ rows, aggregate, who, budget, recent }); // 装不下就不硬塞
  const clipped = `${summaryText.slice(0, room - 1)}${summaryText.length > room ? '…' : ''}`;
  const prefix = [
    '【记忆交接】以下是**之前**发生过的，不是现在发生的。',
    '把它当作背景：不要复述、不要说"你刚才说过"、不要提"记忆""交接"这类词。',
    '',
    `（${who}的更早以前，一段梗概：）`,
    clipped,
    '',
  ].join('\n');
  const base = buildHandoffText({ rows, aggregate, who, budget: budget - prefix.length, recent });
  if (base == null) return prefix;
  return `${prefix}${base}`;
}

/**
 * 拼一段"记忆交接"。
 *
 * **为什么要它**:`dsh` 不能恢复既有会话,每一代新会话都从零开始
 * (`src/dsh.js` 的 `#resolveSession` 解释了原因)。所以"记得"这件事只能由
 * bridge 自己带上 —— 这段文本就是"带上"的形式。
 *
 * **三层,全都不需要模型调用**(免费、随时能做、不会因为摘要失败而卡住对话):
 *
 * 1. 累计事实:聊过多少轮、最早哪天;
 * 2. 更早的轮次:一行一轮压缩(`时间 对方 → 她`);
 * 3. 最近的轮次:保留更多原文。
 *
 * 三条硬要求(都写进文本里,别指望模型自己悟):
 * - 明确说"这是**之前**发生的,不是现在";
 * - 明确说"不要复述、不要说'你刚才说过'";
 * - 末尾留一句"现在开始",免得她把交接内容当成要回应的消息。
 *
 * @param {object} options
 * @param {Array<{at: number, kind: string, mood: string|null, user_text: string, reply_text: string|null, silent: number}>} options.rows 新的在前
 * @param {{turns: number, first_at: number|null, last_at: number|null}} options.aggregate
 * @param {string} [options.who] 这是在跟谁说话(`这个群` / `私聊`)
 * @param {number} [options.budget]
 * @param {number} [options.recent]
 * @returns {string|null} 没有可交接的内容时返回 null(调用方就当"没有记忆")
 */
export function buildHandoffText({ rows, aggregate, who = '这个会话', budget = HANDOFF_BUDGET, recent = HANDOFF_RECENT }) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && (row.user_text || row.reply_text)) : [];
  if (list.length === 0) return null;

  const chronological = [...list].reverse(); // 旧的在前,读起来才像时间线
  const older = chronological.slice(0, Math.max(0, chronological.length - recent));
  const latest = chronological.slice(Math.max(0, chronological.length - recent));

  const header = [
    '【记忆交接】以下是**之前**发生过的，不是现在发生的。',
    '把它当作背景：不要复述、不要说"你刚才说过"、不要提"记忆""交接"这类词。',
    '',
    `（${who}：一共聊过 ${aggregate?.turns ?? list.length} 轮` +
    `${Number.isFinite(aggregate?.first_at) ? `，最早在 ${new Date(aggregate.first_at).toLocaleDateString('zh-CN')}` : ''}）`,
  ];

  const olderLines = older.map((row) => `  ${shortTime(row.at)} ${whatWasSaid(row)} → ${whatSheSaid(row, 26)}`);
  const latestLines = latest.map((row) => `  ${shortTime(row.at)} ${whatWasSaid(row)} → ${whatSheSaid(row, 80)}`);

  // 预算:先保**最近**的(最相关),再用剩下的空间从近到远补更早的。
  const tail = ['', '（现在开始。）'];
  const fixed = [...header, ...(latestLines.length ? ['', '■ 最近几轮：', ...latestLines] : []), ...tail].join('\n');
  if (fixed.length >= budget) {
    // 连最近几轮都放不下:只保头尾,至少让她知道"之前聊过"
    return [...header, ...tail].join('\n');
  }

  const room = budget - fixed.length;
  const kept = [];
  let used = 0;
  for (let i = olderLines.length - 1; i >= 0; i -= 1) {
    const line = olderLines[i];
    if (used + line.length + 1 > room) break;
    kept.unshift(line);
    used += line.length + 1;
  }

  return [
    ...header,
    ...(kept.length ? ['', '■ 更早的（一行一轮）：', ...kept] : []),
    ...(latestLines.length ? ['', '■ 最近几轮：', ...latestLines] : []),
    ...tail,
  ].join('\n');
}
