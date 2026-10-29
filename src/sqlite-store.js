/**
 * SQLite 状态层 —— 取代原来的整文件 JSON 重写。
 *
 * 为什么要换:
 *
 * 1. **写放大**:`JsonStateStore` 每次改一个字段就把整个文件重写一遍。以前只有
 *    "会话代数 / 暖群计时 / 早安日期"三样,还能忍;加上主实例的身体状态(每轮都在变)
 *    之后,每秒都可能重写整个文件 —— 而且**写一半崩了就全丢**。
 * 2. **事务**:身体状态要"改数值 + 记一条流水",两件事必须一起成功或一起失败。
 * 3. **可被别的进程读**:用户打算让**另一个机器人**(日志机器人)来报数值,
 *    而那个机器人是独立进程。SQLite 支持多进程打开,配 `WAL` 还能一边写一边读 ——
 *    换成 HTTP/RPC 反而是多余的复杂度。
 * 4. **能查**:以后想算"上周暖群命中率""她这周吃了什么",SQL 一行就够。
 *
 * 用 Node 22+ **内置**的 `node:sqlite`,不引入任何依赖(仍然是零依赖项目)。
 * 表结构与迁移见 `docs/03` 的 D27。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { log } from './log.js';
import {
  CURRENCY,
  STAT_DEFAULTS,
  advanceStats,
  applyInteraction as applyInteractionRule,
  applyPotion as applyPotionRule,
  applyMeal,
  applyMoney,
  applyStory as applyStoryRule,
  createStats,
} from './stats.js';
import { advanceGrowth, createGrowth, levelForXp, progressForXp } from './growth.js';
import { approxTokens } from './dream-cards.js';

/** 当前表结构版本,写在 `PRAGMA user_version` 里。 */
export const SCHEMA_VERSION = 11;

/**
 * 状态库的表结构。
 *
 * ⚠️ 这是一段**模板字符串**:注释里**不能出现反引号**(markdown 行内代码那种写法)。
 * 犯了两次同样的错,所以现在有测试盯着(`状态库：SCHEMA 里不许出现反引号`)——
 * 它只在启动时才炸,而单测从来不执行 main()。
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation (
  key        TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warmup (
  group_id       TEXT PRIMARY KEY,
  last_warmup_at INTEGER,
  slot_key       INTEGER,
  plan           INTEGER,
  misses         INTEGER NOT NULL DEFAULT 0,
  awaiting_since INTEGER,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS morning (
  target_key TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 单行表:主实例当前的身体状态。数值不存历史,历史在 stats_event 里。
-- money(D42)与那三个不是一套刻度:0–999、能攒起来,见 src/stats.js 的 MONEY_*。
CREATE TABLE IF NOT EXISTS stats (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  satiety       REAL NOT NULL,
  health        REAL NOT NULL,
  mood          REAL NOT NULL,
  money         REAL NOT NULL DEFAULT 50,
  stamina       REAL NOT NULL DEFAULT 70,
  mana          REAL NOT NULL DEFAULT 90,
  updated_at    INTEGER NOT NULL,
  last_praise_at  INTEGER NOT NULL DEFAULT 0,
  last_poke_at    INTEGER NOT NULL DEFAULT 0,
  last_ignored_at INTEGER NOT NULL DEFAULT 0,
  last_chat_at     INTEGER NOT NULL DEFAULT 0,
  last_intimate_at INTEGER NOT NULL DEFAULT 0,
  last_explosion_at INTEGER NOT NULL DEFAULT 0
);

-- 数值变化流水:日志机器人报数、以后做报表都靠它。
CREATE TABLE IF NOT EXISTS stats_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  satiety_delta REAL NOT NULL DEFAULT 0,
  health_delta  REAL NOT NULL DEFAULT 0,
  mood_delta    REAL NOT NULL DEFAULT 0,
  money_delta   REAL NOT NULL DEFAULT 0,
  stamina_delta REAL NOT NULL DEFAULT 0,
  mana_delta    REAL NOT NULL DEFAULT 0,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_stats_event_ts ON stats_event(ts DESC);

-- 运行期的小指标,给状态面板/报表用(键值对,不设 schema)
--
-- ⚠️ 这张表只有**累计值** —— 算不出"每轮耗时的 P90",也算不出"每天多少条"。
-- 那类问题要按时间存点,见下面的 metric_point(2026-10-02,D94)。
CREATE TABLE IF NOT EXISTS metric (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- 每次"值得量一下"的事件一行(append-only)。练的就是这条:
-- **时间序列要单独一张表、要按 (key, ts) 建索引**,不然报表会全表扫。
--
-- 保留策略:pruneMetricPoints() 删 30 天前的点(指标是**可再生的观测量**,不是记忆 ——
-- 所以它可以删,这一点与 memory.db 里那些"不可再生"的轮次完全相反)。
CREATE TABLE IF NOT EXISTS metric_point (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  key   TEXT NOT NULL,          -- turn.ms / turn.reply / turn.silent / msg.in / warmup.hit …
  value REAL NOT NULL DEFAULT 1,
  scope TEXT                    -- 会话 key(群 / 私聊),null = 全局
);
CREATE INDEX IF NOT EXISTS idx_metric_point_key_ts ON metric_point(key, ts);
CREATE INDEX IF NOT EXISTS idx_metric_point_ts ON metric_point(ts DESC);

-- 杂项键值(例如"已播报的版本号"),免得为每个小需求加一张表
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 「我知道有这个群」是一条**事实**,不是缓存 —— 所以它必须落盘。
--
-- 教训:群清单原来只活在内存的 GroupContext 里(buffers / state 两个 Map),
-- 于是**每次重启就忘光**。表现是:重启后 /群列表 是空的、更新播报"没有任何可用目标",
-- 得有人再 @ 她一次才认得。而同一份代码里 warmup 表已经逐群存了排期 ——
-- 同一个概念有两份来源、一份持久一份不持久,这就是不一致的根源。
-- 热数据(消息缓冲、重放窗口、冷却时间)丢了无所谓;**事实丢了不行**。
--
-- ⚠️ 这段是**模板字符串**,注释里不要出现反引号(写命令时别用 markdown 的行内代码)。
CREATE TABLE IF NOT EXISTS known_group (
  id         TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 养成(经验值 / 等级 / 学会的概念 / 认识的人)。规则全在 src/growth.js。
--
-- 判据与 known_group 同一条:「重建之后这条信息还应该成立吗?」
-- 经验值是**发生过的事** → 落盘;而她"现在什么心情"那种手感 → 内存。
-- ---------------------------------------------------------------------------

-- 单行表:当前经验与已达成的里程碑次数。等级**不存** —— 它是经验的派生值。
CREATE TABLE IF NOT EXISTS growth (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  xp         REAL NOT NULL,
  milestones INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 成长流水:每轮一条(升级 / 学会新概念时带 detail),报表与"她怎么长大的"都靠它。
--
-- xp_total 是**那一刻的累计经验**:等级是它的派生值,有了它就能在改了曲线之后
-- 重算历史等级,而不必去猜"流水是从哪一点开始记的"。等级本身不存(见 growth 表)。
CREATE TABLE IF NOT EXISTS growth_event (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  kind     TEXT NOT NULL,          -- turn / levelup / concept / milestone
  xp_delta REAL NOT NULL DEFAULT 0,
  xp_total REAL,
  level    INTEGER,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_growth_event_ts ON growth_event(ts DESC);

-- 学会的概念:一行一个,主键保证"第一次"只算一次 —— 所以经验刷不动。
CREATE TABLE IF NOT EXISTS concept (
  id         TEXT PRIMARY KEY,     -- growth.js 的词表 id
  label      TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  source     TEXT                  -- 从哪一轮学到的(会话 key)
);

-- 认识的人:**按群(或私聊)作用域**存 —— 同一个人在不同群是不同 openid(D09)。
-- 显式记下 "显示名不是身份":改名只更新 display,不新建一行。
CREATE TABLE IF NOT EXISTS person (
  scope        TEXT NOT NULL,      -- group:<群 openid> / c2c:<机器人自己的 id>
  openid       TEXT NOT NULL,      -- member_openid / user_openid
  display      TEXT,               -- 最近一次见到的显示名(可改口)
  scene        TEXT NOT NULL,      -- group / c2c
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  turns        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, openid)
);
CREATE INDEX IF NOT EXISTS idx_person_last_seen ON person(last_seen DESC);

-- ---------------------------------------------------------------------------
-- 「关于人的事实」:关系 / 偏好 / 雷区 / 健康(2026-10-01,D79)。
--
-- 判据与 known_group / person 同一条:**重建之后这条信息还应该成立吗?**
-- 「他胃不好」「@小明 是我朋友」是**事实** → 落盘(重建不该丢);
-- 而"这一轮说了什么"那种 → memory.db(派生索引)。
--
-- ⚠️ 它不是"标签":标签是**检索用的派生数据**(可重建、词表在代码里);
-- 这里是**关于这个人的断言**,来源有三种(told 他说的 / declared 群里 @ 一次 / mined 挖矿挖的)。
--
-- ⚠️ 这段是**模板字符串**:注释里不要出现反引号(犯过两次,启动时才炸)。
CREATE TABLE IF NOT EXISTS fact (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,      -- 与 person 同一套作用域:group:<群 openid> / c2c:<机器人 appid>
  subject    TEXT NOT NULL,      -- 关于谁:那个人在群里的 openid,或 'self'(对话那个人自己)
  kind       TEXT NOT NULL,      -- relation / preference / dislike / health
  value      TEXT NOT NULL,      -- 朋友 / 美式 / 别叫小名 / 胃炎
  detail     TEXT,               -- 附加:健康分 chronic/short/mental;偏好分 like/hate/forbid
  source     TEXT NOT NULL,      -- told / declared / mined
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  -- ADD-only 软失效(P1-C,2026-10-19):旧事实**不物理删**,只打时间戳退出注入。
  -- 三列全空 = "这条现在仍成立",所以老库补列后行为一点不变(迁移见 migrate)。
  superseded_by INTEGER,         -- 取代它的新行 id(NULL = 没被取代)
  merged_into   INTEGER,         -- P1-D 近重复合并预留(本版不写)
  invalid_at    INTEGER          -- 软失效时刻毫秒;NULL = 现在仍成立
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_key ON fact(scope, subject, kind, value);
CREATE INDEX IF NOT EXISTS idx_fact_seen ON fact(last_seen DESC);

-- ---------------------------------------------------------------------------
-- 「挂起的事件钩子」(D99 阶段 3):她抛出一个**未解决**的小事件,等群友回应。
--
-- 判据与 known_group / person 同一条:**重建之后这条信息还应该成立吗?**
-- "她问过这件事、还没人答"是**事实** → 落盘(重启不该让那件事悬在半空)。
-- ⚠️ 键是**稳定键**(group:<群id> / c2c:<appid>),不是会话 key —— 会话 key 每换代就变。
-- ⚠️ 这段是**模板字符串**:注释里不要出现反引号(写这一条时又踩了一次,启动时就炸)。
CREATE TABLE IF NOT EXISTS pending_event (
  key        TEXT PRIMARY KEY,
  scene      TEXT NOT NULL,      -- c2c / group
  target_id  TEXT NOT NULL,
  event_id   TEXT NOT NULL,      -- 事件表的 id(见 src\story.js)
  setup      TEXT NOT NULL,      -- 抛出时那件"未解决的事"(事实方向)
  branches   TEXT NOT NULL,      -- 走向清单(JSON: [{id, line, effect}])
  opened_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 账号与邀请码(网页世界"第 0 步";D132)。
--
-- 判据与 known_group / person / fact 同一条:**重建之后这条信息还应该成立吗?**
-- "谁注册过、密码的哈希是什么、这枚邀请码被谁用了"是**事实** → 落盘。
-- 而"这台设备刚才登录过"那种 → 内存(见 panel.js 的 revoked 名单)。
--
-- ⚠️ 两条刻意的形状:
--   ① 密码**只存 scrypt 派生值 + 盐**,绝不存明文/可逆值(见 src\player-account.js);
--   ② 参数(alg/N/r/p)跟着每一行存 —— 将来调 scrypt 成本时,老账号照样验得过,
--      而不是"改了参数所有人登不进来"。
--
-- ⚠️ 查询代码在 src 目录的 player-account.js(账号域聚在一个文件里);**表在这儿**,
--    因为 CREATE TABLE IF NOT EXISTS 是"老库升级时自动补表"的唯一入口(见 migrate 的注释)。
--
-- ⚠️ 这段是**模板字符串**:注释里不要出现反引号(犯过多次,启动时才炸)。
CREATE TABLE IF NOT EXISTS player (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account       TEXT NOT NULL,             -- 归一化后的账号(小写、去空白、去分隔符)
  nickname      TEXT NOT NULL,
  salt          TEXT NOT NULL,             -- scrypt 的盐(十六进制)
  hash          TEXT NOT NULL,             -- scrypt 派生值(十六进制)
  params        TEXT NOT NULL,             -- JSON:{alg,N,r,p,keylen}
  question      TEXT,                      -- 密保问题(空 = 没设,找回就只能走本机管理员)
  answer_salt   TEXT,
  answer_hash   TEXT,
  answer_params TEXT,                      -- 答案的 scrypt 参数(与密码的参数各存各的:两把哈希互不牵连)
  email         TEXT,                      -- 可选,只作联系用(不做验证 —— 本机没有邮件服务)
  session_epoch INTEGER NOT NULL DEFAULT 1,-- 改密码/踢下线时 +1:旧身份票立刻作废(D132)
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  invite_code   TEXT,                      -- 注册时用的那一枚(审计:谁把谁带进来的)
  disabled      INTEGER NOT NULL DEFAULT 0 -- 封禁:1 = 能看不能进(本机管理员开关)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_account ON player(account);

-- 邀请码:面板挂在公网,**开放注册会被灌水** —— 所以注册必须带一枚有效邀请码。
-- ⚠️ 默认**一次一用**(max_uses 1):"给一个人"是默认意图,要发多人才显式加次数。
-- ⚠️ 生成时**避开易混字符**(0/O、1/I/L,见 player-account.js 的字母表)——
--    邀请码是要在聊天里念、在手机上按的,不是给机器看的。
-- room(1.112.0 / D200):这枚码把人带进**哪间群聊房**(空 = 只给身份,不指群)。
--    ⚠️ 它只活在邀请码上,**成员资格从 player.invite_code 派生**(能算的一律派生,D34)
--    —— 这里不建"成员表",换了码房就跟着换,一处事实。
-- ⚠️ **2026-10-14(D229):网页群聊房整条链路删除** —— 这一列**留着不动**(删列要重建表,
--    风险不值当),但不再用于房间绑定;新建的码一律写 NULL。
--    老值可查废弃仓库里的迁移前备份。
CREATE TABLE IF NOT EXISTS invite (
  code         TEXT PRIMARY KEY,           -- 归一化后的大写字母数字(显示时带分隔符是渲染层的事)
  note         TEXT,                       -- 给谁/为什么(只给管理员看)
  created_at   INTEGER NOT NULL,
  created_by   TEXT,                       -- 本机管理员命令行填的备注身份
  max_uses     INTEGER NOT NULL DEFAULT 1,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_used_by INTEGER,                    -- 最后使用者(player.id,审计用)
  expires_at   INTEGER,                    -- 空 = 不过期
  room         TEXT                        -- 废置(2026-10-14 / D229 起无代码读写;见上面那段注释)
);

-- ---------------------------------------------------------------------------
-- 邀请申请(D183 第二刀 / 2026-10-11):"向站长要一枚邀请码"的队列。
--
-- 为什么要有它(用户口径:「不填邀请码就是只读,可以后续再向我要邀请码进内部」):
--   只读的人**得有个地方说"我想要"**,而且这件事**不能自动通过** ——
--   面板挂在公网,自动通过 = 自动把内部权限发给陌生人(调研里 Slack 那条正是"申请→人工批准")。
--   ⚠️ 与"没有邮件服务"合起来看:这张表就是**站长的收件箱**(见 ③:让主实例在 QQ 里私聊提醒)。
--
-- 判据与 player 同一条:这是**事实**(谁在什么时候申请过、批没批) → 落盘。
-- ⚠️ 这段是**模板字符串**:注释里不要出现反引号。
CREATE TABLE IF NOT EXISTS access_request (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account    TEXT,                          -- 申请人填的账号名(可空:他可能还没注册)
  nickname   TEXT,                          -- 他怎么称呼自己
  contact    TEXT NOT NULL,                 -- **唯一的必填**:QQ/微信,站长靠它联系他
  note       TEXT,                          -- 他想说的一句话
  at         INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',-- pending / approved / rejected
  handled_at INTEGER,
  handled_by TEXT                           -- 站长用什么姿势处理的(审计)
);
CREATE INDEX IF NOT EXISTS idx_access_request_status ON access_request(status, at);

-- ---------------------------------------------------------------------------
-- 积分账本(1.115.0 / D203):**网页聊天按档限额,超出走积分**。
--
-- 口径(用户 2026-10-12 拍板,对照 DZMM):
--   · 每天免费轮数按档分:游客 10 / 注册无码 100 / 带码进来的 200 —— 数字只有一个来源
--     (src\credits.js 的 FREE_QUOTA),表里**不存**档位(派生,D34);
--   · **只有她真的回了话才算一轮**(超时/沉默不算,被闸门拦下的更不算);
--   · 超出免费额度后每轮扣 1 积分;积分只由站长发(充值入口先留空,等付款码)。
-- 两张表各管一件事,别合并:
--   credit_day = "今天用过多少轮"(每天一行,窗口展示用,可删);
--   credit_log = "积分为什么变"(永不删 —— 它就是账本,对账唯一来源)。
-- ⚠️ subject 是"账号或游客"的稳定代号:账号 = player:<id>,游客 = guest:<指纹哈希前缀>
--    (哈希在 credits.js 里算,库里**不存**原始票 —— 票会轮换,代号不能跟着换)。
-- ⚠️ 这段是**模板字符串**:注释里不要出现反引号。
CREATE TABLE IF NOT EXISTS credit_day (
  subject    TEXT NOT NULL,              -- 谁的账(player:<id> / guest:<指纹>)
  day        TEXT NOT NULL,              -- 本地日(北京时间 YYYY-MM-DD)
  turns      INTEGER NOT NULL DEFAULT 0, -- 她今天实际回了几轮(免费 + 积分都算)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject, day)
);
CREATE TABLE IF NOT EXISTS credit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,                -- 与 credit_day 同一套代号
  delta  INTEGER NOT NULL,             -- 积分变化:+发 / -扣
  kind   TEXT NOT NULL,                -- grant(站长发)/ spend(超额度扣)/ refund(冲正)
  note   TEXT,                         -- 为什么(审计)
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_log_subject ON credit_log(subject, id);

-- ---------------------------------------------------------------------------
-- 充值申报与到账核对(1.116.0 / D205):**静态收款码 + 手机到账通知 = 自动加分**。
--
-- 为什么要有它:静态码没有支付回调(个人码永远不会有),所以"到账"这件事靠
-- 手机上那个监听 APP(项目\收款监听APK)把**金额 + 来源**发到 /api/pay-notify;
-- 这张表是**申报单**:用户点"我已付款"生成一行,副实例(桥)拿通知的金额去配对。
--
-- 口径(用户 2026-10-12 拍板):
--   · 档位固定整数(¥10/20/50/100/199/499),**不用小数金额当订单号**;
--   · 所以配对靠"**金额 + 有效期 + 唯一性**":同金额只有一张单 → 自动加分;
--     多张 → 谁先认领谁得(QQ/网页确认);没有单 → 进 unmatched 等人工核;
--   · **谎报"我已付款"永远不加分** —— 没有真实到账通知就没有 grant;
--   · 10 分钟有效期:过期的申报单不再参与配对(钱到了也落人工,不丢)。
-- status:pending(刚申报)/ claimed(他说付了)/ granted(已加分)/ ambiguous(同额多单待认领)
--         / unmatched(有到账但没单)/ rejected(人工否)/ expired(超时作废)
-- ⚠️ subject 与 credits 同一套代号(player:<id> / guest:<指纹>);充值**要求账号**
--    (游客换设备就找不回自己那本账,所以申报那一层先拦)。
CREATE TABLE IF NOT EXISTS recharge_request (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  subject           TEXT,                    -- 谁的单(与 credit_log.subject 同源)
  account           TEXT,                    -- 展示用:账号名(或"游客")
  channel           TEXT,                    -- wechat / alipay(他想用哪个码付)
  price             INTEGER NOT NULL,        -- 档位金额(元)
  amount_fen        INTEGER NOT NULL,        -- 应付金额(分)—— 等于 price*100,配对用
  credits           INTEGER NOT NULL,        -- 该档到账积分
  note              TEXT,                    -- 他填的付款备注(人工核账要看)
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  claimed_at        INTEGER,                -- 点"我已付款"的时刻
  notice_at         INTEGER,                -- 收到到账通知的时刻
  notice_amount_fen INTEGER,                -- 通知里的金额(分)
  notice_channel    TEXT,                   -- 通知来自哪个 App
  handled_at        INTEGER,
  handled_by        TEXT,                   -- 'auto'(自动) / 'panel:站长名' / 'qq'
  grant_id          INTEGER                 -- credit_log.id(对账指回那一行)
);
CREATE INDEX IF NOT EXISTS idx_recharge_status ON recharge_request(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_recharge_subject ON recharge_request(subject, id);

-- ---------------------------------------------------------------------------
-- 出站留痕(1.106.3 / D175):**每一条真的发出去的正文**。
--
-- 为什么要有它(2026-10-10 的现场):transcript 脚本与 memory.db 存的都是
-- "**她写出来的**"那条 assistant 消息 —— 位置在 planSpokenLines() / sanitizeOutgoingText()
-- / chunkText() **之前**。于是"群里到底收到什么"事后**没有权威来源**
-- (那天 64 字的回复被砍成 28 字,只看 transcript 的人会以为整段都发出去了)。
--
-- 判据与 known_group / person / fact 同一条:**重建之后这条信息还应该成立吗?**
-- "她那一刻到底发了什么"是**事实**(而且正是要拿来对账的) → 落盘。
--
-- 保留策略与 metric_point 同一条纪律:出站留痕**可删**(30 天),
-- 而 memory.db 里的轮次**不可再生** —— 两件事别混。
CREATE TABLE IF NOT EXISTS outbound (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  scene  TEXT NOT NULL,                    -- group / c2c
  target TEXT NOT NULL,                    -- 群 openid / 私聊的对方 openid
  kind   TEXT,                             -- passive(带 msg_id 的回复)/ active(主动消息)
  chars  INTEGER NOT NULL,
  text   TEXT NOT NULL                     -- ⚠️ **真的发出去的那一条**(不是模型原文)
);
CREATE INDEX IF NOT EXISTS idx_outbound_at ON outbound(at);
CREATE INDEX IF NOT EXISTS idx_outbound_target ON outbound(target, at);

-- ---------------------------------------------------------------------------
-- 媒体发送绑定(T3,2026-10-29):「这条出站消息 = 这个资产的第 N 张」。
-- 作用域 = (bot, scene, target):引用解析只在同实例同群里查,绝不跨域。
-- 幂等键 (scene,target,outbound_id,item_seq);md5 指向既有图库资产身份,不存二进制。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_link (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot         TEXT NOT NULL DEFAULT '',
  scene       TEXT NOT NULL,
  target      TEXT NOT NULL,
  outbound_id TEXT NOT NULL,
  item_seq    INTEGER NOT NULL DEFAULT 1,
  kind        TEXT NOT NULL DEFAULT 'meitu',
  task_id     TEXT,
  md5         TEXT,
  source      TEXT,
  source_id   TEXT,
  at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_link_msg ON media_link(scene, target, outbound_id, item_seq);
CREATE INDEX IF NOT EXISTS idx_media_link_lookup ON media_link(bot, scene, target, outbound_id);

-- ---------------------------------------------------------------------------
-- 梦境档(1.126.0 / D227 后半;docs 21 §十):自建房的房间 / 成员 / 房内历史。
--
-- ⚠️ **分命名空间 = 切分的理由本身**(docs 21 §十四点之 2):梦是虚构、世界是真实关系。
--   梦里发生过什么只住在这三张 dream_ 表里,**绝不**进世界档的 conversation / memory 管线;
--   反过来世界档也不会往这里写一行。判据在 selftest-dream-engine.js(存储段)钉住。
-- room 卡从卡库(dream-cards)引 id,这里**不复制卡正文** —— 卡是单一真相,房间只存引用。
-- dream_msg 是房内历史的**唯一来源**(append-only):assistant 带 name(谁说的),
--   meta 里落 usage 与激活的世界书条目(先免费记账的反推依据)。
CREATE TABLE IF NOT EXISTS dream_room (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  manifest      TEXT NOT NULL,             -- JSON:世界卡/角色卡/旁白卡/锁人规则/开场(manifest 引卡库 id)
  created_by    TEXT,                      -- subject(player:<id>),null = 站长预置
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dream_member (
  room_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL,                -- 'char:<卡库id>' / '__narrator__'
  name       TEXT NOT NULL,                -- 房内显示名(锁人按它点名)
  card_id    TEXT,                         -- 旁白为 null;角色卡引卡库 id
  kind       TEXT NOT NULL DEFAULT 'char', -- char / narrator
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (room_id, member_id)
);

CREATE TABLE IF NOT EXISTS dream_msg (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  role     TEXT NOT NULL,                  -- user / assistant
  name     TEXT,                           -- assistant = 说话的角色名;user = 玩家名(可空)
  content  TEXT NOT NULL,
  meta     TEXT                            -- JSON:tokens/usage/activated(可空)
);
CREATE INDEX IF NOT EXISTS idx_dream_msg_room ON dream_msg(room_id, id);

-- ---------------------------------------------------------------------------
-- 世界档自有会话历史(1.146.1 / docs 21 §十二 刀二B;去 DSH 化:会话永生,不再有 -g 代数)。
--
-- ⚠️ **append-only**:这张表是自有引擎(docs 21 刀三A)的逐轮历史唯一来源 ——
--   只插入、不更新、不重排(前缀逐字节稳定 = DeepSeek 前缀缓存命中的前提,判据在
--   selftest-context);裁剪/收窄发生在**读取侧**(context-budget 的 splitHistory),
--   表里的原文一行都不动。保留策略等刀四再议。
-- tokens 写入时用 approxTokens 算好(dream-cards 一份,D159),读侧不再逐轮估。
-- meta 落 usage(prompt/completion/cache 命中)—— §六 g1:usage 落库,credits 与
--   成本对账吃精确值,不再读 DSH 会话文件。
-- ⚠️ 与 outbound 表分工:outbound 记"真的发出去的那条"(过完拆句),这张表记
--   "模型看见的轮"(拼前缀用的原文)—— 两个真相,别合并。
CREATE TABLE IF NOT EXISTS conversation_turn (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key      TEXT NOT NULL,                  -- conversationKey(与 conversation 表同口径)
  at       INTEGER NOT NULL,
  role     TEXT NOT NULL,                  -- user / assistant
  content  TEXT NOT NULL,
  tokens   INTEGER NOT NULL,               -- approxTokens(content),写入时算好
  meta     TEXT                            -- JSON:usage/scene 等(可空;assistant 轮带 usage)
);
CREATE INDEX IF NOT EXISTS idx_conversation_turn_key ON conversation_turn(key, id);
CREATE TABLE IF NOT EXISTS own_llm_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  usage TEXT,
  http_status INTEGER
);
CREATE TABLE IF NOT EXISTS own_llm_call (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  usage TEXT,
  error TEXT,
  model TEXT                              -- 实际用的模型名(结算完成时补写;1.168.0 / D275 报表"按模型分节"用。老行/失败行 = NULL,报表按"模型未知"如实列,不猜)
);
`;

/** 解析一列 JSON,坏了就当没有(状态库里的一列不该让整条读路径炸)。 */
function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * 打开数据库并建表;文件损坏时**挪到一边重开**,而不是让 bridge 起不来。
 *
 * 注意 SQLite 是**惰性打开**的:内容不是数据库的文件也能"打开成功",
 * 直到第一次执行 SQL 才报 `file is not a database`。所以隔离必须覆盖建表这一步,
 * 只包住构造函数是不够的(第一版就是这么写的,被测试抓出来了)。
 */
function openWithSchema(file) {
  const applySchema = (db) => {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db;
  };

  let handle = null;
  try {
    handle = new DatabaseSync(file);
    return applySchema(handle);
  } catch (err) {
    if (file === ':memory:') throw err;
    // ⚠️ 必须先关掉失败的句柄,否则 Windows 上改名会 EBUSY(挂着的句柄占着文件)。
    try {
      handle?.close();
    } catch {
      /* 已经坏了，关不掉也无所谓 */
    }
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      log.warn(`状态库损坏，已改名为 ${backup} 后重建（不影响聊天，数值从头开始）: ${err.message}`);
    } catch (renameErr) {
      log.warn(`状态库损坏且无法改名（${renameErr.message}），尝试直接重建: ${err.message}`);
    }
    return applySchema(new DatabaseSync(file));
  }
}

/**
 * 成长流水的一行 → 给人看的对象。
 *
 * **两条读取路径共用它**(`SqliteStateStore.recentGrowthEvents` 与
 * `openReadOnly.growthEvents`)。之前它们各映射各的,于是同一个东西有两种形状:
 * 一条给 `xpDelta`、另一条给 `xp_delta`,而 report 脚本按前者读 —— 显示成 `NaN`,
 * 再被 `|| 0` 悄悄变成 0。**没有报错,数字全错**,正是最难查的那种。
 */
function mapGrowthEventRow(row) {
  return {
    ts: row.ts,
    kind: row.kind,
    xpDelta: row.xp_delta,
    xpTotal: row.xp_total,
    level: row.level,
    detail: row.detail ? JSON.parse(row.detail) : null,
  };
}

/**
 * 轻量迁移:补上老库里缺的列。
 *
 * `CREATE TABLE IF NOT EXISTS` **不会**给已存在的表加列,所以新加的列必须在这里补,
 * 否则升级过的库会一直少一列,而报错要等到那条 SQL 真被执行才出现(很难查)。
 * 每条判断都读 `PRAGMA table_info`,重复执行无副作用 —— 启动路径上要能反复跑。
 */
function migrate(db) {
  // ⚠️ **必须在最前面声明**:下面补 `money` 列那段就要用它,而 `const` 有暂时性死区 ——
  //    写在后面会让整个 `migrate()` 抛 ReferenceError(真踩过:catch 在更外层,
  //    于是它被当成"库损坏"→ 改名重建,现象是**每次启动都像换了个新库**)。
  const MONEY_SCALE = 100;
  const columns = (table) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    } catch {
      return [];
    }
  };

  const growthEventColumns = columns('growth_event');
  if (growthEventColumns.length > 0 && !growthEventColumns.includes('xp_total')) {
    db.exec('ALTER TABLE growth_event ADD COLUMN xp_total REAL');
    log.info('状态库迁移：growth_event 补上 xp_total（老库的历史行留空）');
  }

  // 钱(D42):老库的 stats / stats_event 没有这两列。
  // ⚠️ 默认值必须和 `STAT_DEFAULTS.money` 一致,否则"升级上来的库"和
  // "新建的库"会从不同的起点开始 —— 而这种不一致**不会报错**。
  const statsColumns = columns('stats');
  if (statsColumns.length > 0 && !statsColumns.includes('money')) {
    // ⚠️ D99 起钱的起点是 2,000 货币单位(STAT_DEFAULTS.money),这里别再写死旧值。
    db.exec(`ALTER TABLE stats ADD COLUMN money REAL NOT NULL DEFAULT ${STAT_DEFAULTS.money}`);
    // ⚠️ **同时把刻度标记写上**:这一列的默认值**已经是新刻度**(2,000 货币单位),
    //    所以它**不该**再被下面那段 ×100 迁移乘一次(而且要幂等 —— 否则第二次启动才乘)。
    db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('money_scale', ?, ?)")
      .run(String(MONEY_SCALE), Date.now());
    log.info(`状态库迁移：stats 补上 money（D42 的经济系统，老库从 ${STAT_DEFAULTS.money} 起步）`);
  }
  const eventColumns = columns('stats_event');
  if (eventColumns.length > 0 && !eventColumns.includes('money_delta')) {
    db.exec('ALTER TABLE stats_event ADD COLUMN money_delta REAL NOT NULL DEFAULT 0');
    log.info('状态库迁移：stats_event 补上 money_delta');
  }

  // **钱的刻度**:旧刻度 → 货币单位(D99,2026-10-02)。
  //
  // 为什么要迁移而不是"从今天起按新刻度算":钱是**能攒**的数值,留着 43 那个旧刻度,
  // 在"1 货币单位 ≈ 1 日元"下连一瓶果汁都买不起 —— 世界观统一就只剩个名字。
  //
  // 三条纪律:
  //   ① **幂等**:标记写进 `meta.money_scale`,跑过就不再跑(启动路径上会反复执行这段);
  //   ② **账本一起迁**:`stats_event.money_delta` 同倍率,否则报表里的历史与余额对不上
  //      (D34「数字只能来自库」那条纪律要保住);
  //   ③ **只在老库上跑**:全新库没有历史,不用动(而且它的默认值已经是新刻度)。
  const scaleRow = (() => {
    try {
      return db.prepare("SELECT value FROM meta WHERE key = 'money_scale'").get();
    } catch {
      return null;
    }
  })();
  // ⚠️ **只迁"本来就有 money 列"的库**:没有 money 列的老库是**刚刚**被上面的 ALTER
  //    按 `STAT_DEFAULTS.money`(2,000,已经是新刻度)补出来的 —— 再 ×100 会变成 200,000。
  //    `statsColumns` 是**进这个函数时**取的,所以它正好就是"原来有没有"的判据。
  if (!scaleRow && statsColumns.includes('money')) {
    try {
      db.exec('BEGIN');
      db.prepare('UPDATE stats SET money = money * ?').run(MONEY_SCALE);
      if (eventColumns.length > 0) {
        db.prepare('UPDATE stats_event SET money_delta = money_delta * ?').run(MONEY_SCALE);
      }
      // ⚠️ `meta.updated_at` 是 **NOT NULL** —— 第一版漏了它,于是真机上
      //    `NOT NULL constraint failed: meta.updated_at`,迁移**每一次启动都失败**
      //    (而单测里那张手写的假表没有这一列,所以测试全绿)。是**真启动**抓出来的。
      db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('money_scale', ?, ?)")
        .run(String(MONEY_SCALE), Date.now());
      db.exec('COMMIT');
      log.info(
        `状态库迁移：钱的刻度 ×${MONEY_SCALE} —— 旧刻度 → **${CURRENCY.name}**(D99,1 ${CURRENCY.name} ≈ 1 日元);` +
        '余额与历史流水一起换,只跑这一次',
      );
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也只能让错误冒出去 */
      }
      log.warn(`钱刻度迁移失败（不影响启动，下次启动重试）: ${err.message}`);
    }
  }

  // 体力 / 魔力(2026-10-01,D83)。同一条规矩:**默认值必须和 STAT_DEFAULTS 一致**,
  // 否则"升级上来的库"与"新建的库"从不同起点开始,而且不会报错。
  if (statsColumns.length > 0 && !statsColumns.includes('stamina')) {
    db.exec(`ALTER TABLE stats ADD COLUMN stamina REAL NOT NULL DEFAULT ${STAT_DEFAULTS.stamina}`);
    log.info(`状态库迁移：stats 补上 stamina（体力，老库从 ${STAT_DEFAULTS.stamina} 起步）`);
  }
  if (statsColumns.length > 0 && !statsColumns.includes('mana')) {
    db.exec(`ALTER TABLE stats ADD COLUMN mana REAL NOT NULL DEFAULT ${STAT_DEFAULTS.mana}`);
    log.info(`状态库迁移：stats 补上 mana（魔力，老库从 ${STAT_DEFAULTS.mana} 起步）`);
  }
  for (const [column, kind] of [['last_chat_at', 'chat'], ['last_intimate_at', 'intimate'], ['last_explosion_at', 'explosion']]) {
    if (statsColumns.length > 0 && !statsColumns.includes(column)) {
      db.exec(`ALTER TABLE stats ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
      log.info(`状态库迁移：stats 补上 ${column}（${kind} 冷却，老库当作"从没发生过"）`);
    }
  }
  if (eventColumns.length > 0 && !eventColumns.includes('stamina_delta')) {
    db.exec('ALTER TABLE stats_event ADD COLUMN stamina_delta REAL NOT NULL DEFAULT 0');
    log.info('状态库迁移：stats_event 补上 stamina_delta');
  }
  if (eventColumns.length > 0 && !eventColumns.includes('mana_delta')) {
    db.exec('ALTER TABLE stats_event ADD COLUMN mana_delta REAL NOT NULL DEFAULT 0');
    log.info('状态库迁移：stats_event 补上 mana_delta');
  }

  // 邀请码的群组栏(1.112.0 / D200):老库的 invite 没有 room。
  // 空着 = "这枚码不指群"(老码的行为一点不变),所以补列即可,不用回填。
  // ⚠️ 2026-10-14(D229):网页群聊房下线后这一列**已废置**(没有代码读写),
  //    但迁移**保留** —— 老库的表结构要跟新库一致,否则两边 schema 分叉。
  const inviteColumns = columns('invite');
  if (inviteColumns.length > 0 && !inviteColumns.includes('room')) {
    db.exec('ALTER TABLE invite ADD COLUMN room TEXT');
    log.info('状态库迁移：invite 补上 room（D200 的邀请码指群，老码当"不指群"）');
  }

  // ADD-only 软失效(P1-C,2026-10-19):老库的 fact 没有这三列。
  // 空 = "一直有效",所以补列即可、不用回填 —— 老事实的行为一点不变。
  // ⚠️ 加**列**不加表:CREATE TABLE IF NOT EXISTS 管不到已存在的表,漏了这段就会
  //    等到 touchFact / facts 真跑时才报 "no such column"(很难查)。
  const factColumns = columns('fact');
  const factMissing = ['superseded_by', 'merged_into', 'invalid_at']
    .filter((column) => !factColumns.includes(column));
  if (factColumns.length > 0 && factMissing.length > 0) {
    for (const column of factMissing) db.exec(`ALTER TABLE fact ADD COLUMN ${column} INTEGER`);
    log.info(`状态库迁移：fact 补上 ${factMissing.join(' / ')}（ADD-only 软失效，老事实当作一直有效）`);
  }

  // own_llm_call 的模型列(1.168.0 / D275):花费报表要"按模型分节"(照 DeepSeek 官方
  // usage 页的形状),就必须每笔知道模型 —— 否则"上游换了模型名、价目表还是旧的"
  // (model-cost-accounting 七坑之⑦)在报表上永远现不了形。老行 NULL = 模型未知,
  // 报表如实单列,不按当前配置的模型猜(猜了就是把旧账按新价折,口径就脏了)。
  const callColumns = columns('own_llm_call');
  if (callColumns.length > 0 && !callColumns.includes('model')) {
    db.exec('ALTER TABLE own_llm_call ADD COLUMN model TEXT');
    log.info('状态库迁移：own_llm_call 补上 model（D275 花费报表按模型分节；老行留空 = 模型未知）');
  }

  // ⚠️ `known_group` 回填(2026-09-27 发现)。
  //
  // `known_group` 是**后来才加的表**(D35),而那时库里已经有会话记录了 ——
  // `CREATE TABLE IF NOT EXISTS` 建了张**空表**,老群一个都没进去。
  // 之后只有"又收到过消息"的群才会被补上,于是:
  //
  //     实测:conversation 4 个会话 / warmup 3 个群,而 known_group **只有 1 行**。
  //
  // 表现就是老 bug 重现:`/群列表` 只列一个群、`release-status` 的数也是错的 ——
  // 而**主实例感觉不到**(她开着暖群,排期另有一张表),所以它能一直藏着。
  // 副实例那边暖群是关的,所以她的群清单只能靠这张表。
  //
  // 回填的依据是"库里已经有的东西":`conversation` 的键就是
  // `qqbot-group-<openid>` / `qqbot-c2c-<openid>`,群 id 直接在里面。
  // (这正是 D35 说的那句的又一次应用:**同一个事实不要有两份来源**。
  //  代价是键的格式成了约定 —— 所以下面按前缀解析时**解析不出就跳过**,不猜。)
  const groupPrefix = 'qqbot-group-';
  if (columns('known_group').length > 0 && columns('conversation').includes('key')) {
    const missing = db
      .prepare(
        `SELECT c.key AS key, c.updated_at AS updated_at FROM conversation c
         WHERE c.key LIKE ? AND NOT EXISTS (SELECT 1 FROM known_group g WHERE g.id = substr(c.key, ?))`,
      )
      .all(`${groupPrefix}%`, groupPrefix.length + 1);
    if (missing.length > 0) {
      const insert = db.prepare(
        `INSERT INTO known_group (id, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
      );
      for (const row of missing) {
        const id = row.key.slice(groupPrefix.length);
        if (id === '') continue;
        insert.run(id, row.updated_at ?? Date.now(), row.updated_at ?? Date.now());
      }
      log.info(`状态库迁移：known_group 回填 ${missing.length} 个群(从会话记录推出来的,它们一直在库里)`);
    }
  }
}

export class SqliteStateStore {  #db;
  #hasStats = false;
  // **数值框架**(2026-10-28 两套):生物体/机械体。null = 旧行为(生物体)。
  #bodyRules = null;

  /**
   * @param {string} file 数据库路径(`:memory:` 可用于测试)
   * @param {{legacyJsonPath?: string}} [options] 旧的 JSON 状态文件,用于一次性迁移
   */
  constructor(file, { legacyJsonPath, bodyRules = null } = {}) {
    if (file !== ':memory:') fs.mkdirSync(file.replace(/[^\\/]+$/, '') || '.', { recursive: true });
    // 打开 + 建表;坏库会被隔离改名后重建(核心收益之一是它不会让 bridge 起不来)。
    this.#db = openWithSchema(file);
    this.#bodyRules = bodyRules;

    if (legacyJsonPath) this.#importLegacyJson(legacyJsonPath);
  }

  /** 数据库句柄,给 `scripts/` 里的报表脚本读取用。 */
  get handle() {
    return this.#db;
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* 已经关了 */
    }
  }

  // --- 一次性迁移:旧的 .qqbot-state.json -----------------------------------

  /**
   * 把旧的 JSON 状态导入 SQLite。**一个库只导一次。**
   *
   * ⚠️ 这里原来没有"导过没有"的判断,而 `set` / `setWarmup` 是**覆盖写** ——
   * 于是只要 `.qqbot-state.json` 还在(设计上就不删,它是备份),**每次启动都会
   * 把几十小时前的旧值盖回去**:会话代数被拉低、暖群排期被重置。
   * 留着一个备份文件却让它每天晚上"回滚一次状态",比直接删掉还坏。
   *
   * 判据写进 `meta`(它本身就是"一个小值一个键"),所以不依赖调用方记得传什么参数。
   * 导入失败时不会写标记,下一次启动会重试。
   */
  #importLegacyJson(file) {
    if (this.getMeta('legacy_json_imported')) return;
    let parsed = null;
    try {
      if (!fs.existsSync(file)) return;
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log.warn(`旧状态文件无法解析，跳过迁移: ${err.message}`);
      return;
    }
    const counts = {
      conversations: Object.keys(parsed?.conversations ?? {}).length,
      warmup: Object.keys(parsed?.warmup ?? {}).length,
      morning: Object.keys(parsed?.morning ?? {}).length,
    };
    if (counts.conversations + counts.warmup + counts.morning === 0) return;

    for (const [key, value] of Object.entries(parsed.conversations ?? {})) {
      this.set(key, value);
    }
    for (const [groupId, value] of Object.entries(parsed.warmup ?? {})) {
      this.setWarmup(groupId, value);
    }
    for (const [key, value] of Object.entries(parsed.morning ?? {})) {
      this.setMorning(key, value);
    }
    // 标记放在**所有写入之后**:中途抛错就不写,下次启动重试。
    this.setMeta('legacy_json_imported', new Date().toISOString());
    log.info(
      `已从 ${file} 迁移到 SQLite：会话 ${counts.conversations}、暖群 ${counts.warmup}、早安 ${counts.morning}` +
      '（旧文件保留不删，作为备份；**以后不会再导第二次**）',
    );
  }

  // --- 会话代数(接口与原 JsonStateStore 一致) ------------------------------

  get conversationCount() {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM conversation').get().n;
  }

  get(key) {
    const row = this.#db.prepare('SELECT generation, updated_at FROM conversation WHERE key = ?').get(key);
    if (!row) return undefined;
    return { generation: row.generation, updatedAt: row.updated_at };
  }

  set(key, value) {
    this.#db
      .prepare(
        `INSERT INTO conversation (key, generation, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`,
      )
      .run(key, value?.generation ?? 1, value?.updatedAt ?? Date.now());
  }

  // --- 暖群排期 -------------------------------------------------------------

  getWarmup(groupId) {
    const row = this.#db
      .prepare(
        `SELECT last_warmup_at, slot_key, plan, misses, awaiting_since
         FROM warmup WHERE group_id = ?`,
      )
      .get(groupId);
    if (!row) return undefined;
    return {
      lastWarmupAt: row.last_warmup_at,
      slotKey: row.slot_key,
      plan: row.plan,
      misses: row.misses,
      awaitingSince: row.awaiting_since,
    };
  }

  allWarmup() {
    const out = {};
    for (const row of this.#db.prepare('SELECT * FROM warmup').all()) {
      out[row.group_id] = {
        lastWarmupAt: row.last_warmup_at,
        slotKey: row.slot_key,
        plan: row.plan,
        misses: row.misses,
        awaitingSince: row.awaiting_since,
      };
    }
    return out;
  }

  setWarmup(groupId, value) {
    this.#db
      .prepare(
        `INSERT INTO warmup (group_id, last_warmup_at, slot_key, plan, misses, awaiting_since, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           last_warmup_at = excluded.last_warmup_at, slot_key = excluded.slot_key,
           plan = excluded.plan, misses = excluded.misses,
           awaiting_since = excluded.awaiting_since, updated_at = excluded.updated_at`,
      )
      .run(
        groupId,
        value?.lastWarmupAt ?? null,
        value?.slotKey ?? null,
        value?.plan ?? null,
        value?.misses ?? 0,
        value?.awaitingSince ?? null,
        Date.now(),
      );
  }

  // --- 早安 -----------------------------------------------------------------

  getMorning(key) {
    const row = this.#db.prepare('SELECT date FROM morning WHERE target_key = ?').get(key);
    return row ? { date: row.date } : undefined;
  }

  allMorning() {
    const out = {};
    for (const row of this.#db.prepare('SELECT target_key, date FROM morning').all()) {
      out[row.target_key] = { date: row.date };
    }
    return out;
  }

  setMorning(key, value) {
    this.#db
      .prepare(
        `INSERT INTO morning (target_key, date, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(target_key) DO UPDATE SET date = excluded.date, updated_at = excluded.updated_at`,
      )
      .run(key, String(value?.date ?? ''), Date.now());
  }

  // --- 身体状态 -------------------------------------------------------------

  /** 当前状态(不推进时间),没有就返回 null。 */
  peekStats() {
    const row = this.#db.prepare('SELECT * FROM stats WHERE id = 1').get();
    if (!row) return null;
    return {
      satiety: row.satiety,
      health: row.health,
      mood: row.mood,
      // 老库(迁移之前建的)这一列会是 NULL —— 用默认值兜住,别把 undefined 传下去。
      money: Number.isFinite(row.money) ? row.money : STAT_DEFAULTS.money,
      // 体力 / 魔力(D83):同 `money` 的先例 —— 老库迁移之后这两列有默认值,
      // 但万一读出 NULL(手改过库),也要用默认值兜住,别把 undefined 传下去。
      stamina: Number.isFinite(row.stamina) ? row.stamina : STAT_DEFAULTS.stamina,
      mana: Number.isFinite(row.mana) ? row.mana : STAT_DEFAULTS.mana,
      updatedAt: row.updated_at,
      lastPraiseAt: row.last_praise_at,
      lastPokeAt: row.last_poke_at,
      lastIgnoredAt: row.last_ignored_at,
      lastChatAt: row.last_chat_at ?? 0,
      lastIntimateAt: row.last_intimate_at ?? 0,
      lastExplosionAt: row.last_explosion_at ?? 0,
    };
  }

  /**
   * 结算到 `now` 并返回最新状态 —— 时间推进是**读的时候补算**的,不用定时器。
   *
   * @param {number} now
   * @param {{sleep?: object|null}} [options]
   */
  getStats(now, { sleep = null, bodyRules = this.#bodyRules } = {}) {
    const stored = this.peekStats() ?? createStats(now, bodyRules);
    const advanced = advanceStats(stored, stored.updatedAt, now, { sleep, rules: bodyRules });
    if (!this.#hasStats || advanced.updatedAt !== stored.updatedAt) this.#writeStats(advanced);
    this.#hasStats = true;
    return advanced;
  }

  /** 直接写回一份状态(进食、互动之后调用)。 */
  saveStats(stats) {
    this.#writeStats(stats);
    this.#hasStats = true;
    return stats;
  }

  #writeStats(stats) {
    this.#db
      .prepare(
        `INSERT INTO stats (id, satiety, health, mood, money, stamina, mana, updated_at,
                            last_praise_at, last_poke_at, last_ignored_at,
                            last_chat_at, last_intimate_at, last_explosion_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           satiety = excluded.satiety, health = excluded.health, mood = excluded.mood,
           money = excluded.money, stamina = excluded.stamina, mana = excluded.mana,
           updated_at = excluded.updated_at, last_praise_at = excluded.last_praise_at,
           last_poke_at = excluded.last_poke_at, last_ignored_at = excluded.last_ignored_at,
           last_chat_at = excluded.last_chat_at, last_intimate_at = excluded.last_intimate_at,
           last_explosion_at = excluded.last_explosion_at`,
      )
      .run(
        stats.satiety, stats.health, stats.mood,
        Number.isFinite(Number(stats.money)) ? Number(stats.money) : STAT_DEFAULTS.money,
        Number.isFinite(Number(stats.stamina)) ? Number(stats.stamina) : STAT_DEFAULTS.stamina,
        Number.isFinite(Number(stats.mana)) ? Number(stats.mana) : STAT_DEFAULTS.mana,
        stats.updatedAt,
        stats.lastPraiseAt ?? 0, stats.lastPokeAt ?? 0, stats.lastIgnoredAt ?? 0,
        stats.lastChatAt ?? 0, stats.lastIntimateAt ?? 0, stats.lastExplosionAt ?? 0,
      );
  }

  /** 记一条数值流水(和数值本身一起提交,见 `applyIntake`)。 */
  recordStatsEvent(event) {
    if (!event) return;
    this.#db
      .prepare(
        `INSERT INTO stats_event (ts, kind, satiety_delta, health_delta, mood_delta, money_delta,
                                  stamina_delta, mana_delta, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts,
        event.kind,
        event.satietyDelta ?? 0,
        event.healthDelta ?? 0,
        event.moodDelta ?? 0,
        event.moneyDelta ?? 0,
        event.staminaDelta ?? 0,
        event.manaDelta ?? 0,
        event.detail ? JSON.stringify(event.detail) : null,
      );
  }

  recentStatsEvents(limit = 20) {
    return this.#db
      .prepare('SELECT * FROM stats_event ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit)))
      .map((row) => ({
        ts: row.ts,
        kind: row.kind,
        satietyDelta: row.satiety_delta,
        healthDelta: row.health_delta,
        moodDelta: row.mood_delta,
        moneyDelta: row.money_delta,
        staminaDelta: row.stamina_delta ?? 0,
        manaDelta: row.mana_delta ?? 0,
        detail: row.detail ? JSON.parse(row.detail) : null,
      }));
  }

  /** 最近一次"吃了什么"(给 `/状态` 和日志机器人用)。 */
  lastMeal() {
    const row = this.#db
      .prepare("SELECT ts, detail FROM stats_event WHERE kind = 'meal' ORDER BY ts DESC LIMIT 1")
      .get();
    if (!row) return null;
    let detail = null;
    try {
      detail = row.detail ? JSON.parse(row.detail) : null;
    } catch {
      detail = null;
    }
    return { ts: row.ts, food: detail?.food ?? null, kcal: detail?.kcal ?? null };
  }

  // --- 指标(键值对 + 时间序列,2026-10-02/D94) ------------------------------

  bumpMetric(key, delta = 1) {
    this.#db
      .prepare(
        `INSERT INTO metric (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      )
      .run(key, delta);
  }

  allMetrics() {
    const out = {};
    for (const row of this.#db.prepare('SELECT key, value FROM metric').all()) out[row.key] = row.value;
    return out;
  }

  /**
   * 记**一批**指标点(一轮的耗时 / 回复还是静默 / 暖群命中…)。返回写入条数。
   *
   * ⚠️ **一个事务**:半份指标比没有更误导 —— 报表里的 P90 少了两条,而报表上看不出来。
   * ⚠️ 同时把累计计数写进 `metric` 的 `count:<key>`,于是有一条**可核对的恒等式**:
   *    `SELECT COUNT(*) FROM metric_point WHERE key='turn.ms'` 应当等于 `metric['count:turn.ms']`。
   *    两处账要是分叉了,`metric-report.js` 会当场红(`✓/✗` 那一行)——
   *    "看起来有、其实对不上"的配置比没有更坏,这条项目里已经吃过几次亏。
   */
  recordMetricPoints(points, { now = Date.now() } = {}) {
    const clean = (points ?? []).filter((point) => point && point.key);
    if (clean.length === 0) return 0;
    return this.#transaction(() => {
      const insertPoint = this.#db.prepare('INSERT INTO metric_point (ts, key, value, scope) VALUES (?, ?, ?, ?)');
      const bump = this.#db.prepare(
        `INSERT INTO metric (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      );
      for (const point of clean) {
        insertPoint.run(now, String(point.key), Number(point.value ?? 1), point.scope ?? null);
        bump.run(`count:${point.key}`, 1);
      }
      return clean.length;
    });
  }

  /**
   * 取指标点(只读消费:报表、复核)。`key` 省略 = 所有键。
   * ⚠️ `limit` 有上限(默认 5 万):这是一张**会一直长**的表,别让一条查询把内存吃光。
   */
  metricPoints({ key = null, since = 0, limit = 50000 } = {}) {
    const cap = Math.max(1, Math.min(200000, Number(limit) || 50000));
    const rows = key
      ? this.#db.prepare('SELECT ts, key, value, scope FROM metric_point WHERE key = ? AND ts >= ? ORDER BY ts DESC LIMIT ?')
        .all(String(key), since, cap)
      : this.#db.prepare('SELECT ts, key, value, scope FROM metric_point WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
        .all(since, cap);
    return rows.map((row) => ({ ts: Number(row.ts), key: String(row.key), value: Number(row.value), scope: row.scope }));
  }

  /** 按天 × key 汇总 —— **交给 SQL 做**(这正是这一版要练的那件事)。 */
  metricDaily({ since = 0 } = {}) {
    return this.#db.prepare(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, key, COUNT(*) AS n, SUM(value) AS total
         FROM metric_point
        WHERE ts >= ?
        GROUP BY day, key
        ORDER BY day DESC, key ASC`,
    ).all(since).map((row) => ({ day: String(row.day), key: String(row.key), n: Number(row.n), total: Number(row.total) }));
  }

  /** 保留策略:删掉 N 天以前的点。返回删掉的行数(指标可删,记忆不可删 —— 判据见 SCHEMA 注释)。 */
  pruneMetricPoints({ days = 30, now = Date.now() } = {}) {
    const cutoff = now - Math.max(1, days) * 24 * 3600 * 1000;
    const info = this.#db.prepare('DELETE FROM metric_point WHERE ts < ?').run(cutoff);
    return Number(info.changes ?? 0);
  }

  // --- 出站留痕(1.106.3 / D175) -------------------------------------------
  //
  // ⚠️ 写它的地方只有一个:**出站唯一咽喉** —— `src\index.js` 的 `sendChunked()`
  //    (那段注释写着"每一条回给 QQ 的消息都从这里走")。所以调用方忘了也不会漏。
  // ⚠️ 记的是**过完 `planSpokenLines()` / `sanitizeOutgoingText()` / `chunkText()` 之后**、
  //    真正交给 QQ 的那一条 —— 这正是 transcript 与 memory.db 看不见的那一段。

  /** 记一条真的发出去的正文。空文本不记(空消息本来也发不出去)。返回行 id。 */
  recordOutbound({ at = Date.now(), scene = '', target = '', kind = null, text = '' } = {}) {
    const body = String(text ?? '');
    if (body.trim() === '') return null;
    const info = this.#db
      .prepare('INSERT INTO outbound (at, scene, target, kind, chars, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Number(at) || Date.now(), String(scene ?? ''), String(target ?? ''), kind === null ? null : String(kind), body.length, body);
    return Number(info.lastInsertRowid ?? 0) || null;
  }

  /** 读最近的出站留痕(**时间正序**返回,便于和聊天记录逐条对齐)。 */
  recentOutbound({ since = 0, scene = null, target = null, limit = 200 } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT at, scene, target, kind, chars, text FROM outbound
          WHERE at >= ?
            AND (? IS NULL OR scene = ?)
            AND (? IS NULL OR target = ?)
          ORDER BY at DESC LIMIT ?`,
      )
      .all(
        Number(since) || 0,
        scene ?? null, scene ?? null,
        target ?? null, target ?? null,
        Math.max(1, Number(limit) || 200),
      );
    return rows.reverse().map((row) => ({
      at: Number(row.at),
      scene: String(row.scene),
      target: String(row.target),
      kind: row.kind === null ? null : String(row.kind),
      chars: Number(row.chars),
      text: String(row.text),
    }));
  }

  /**
   * 保留策略:删 N 天以前的出站留痕。返回删掉的行数。
   * ⚠️ 与 `pruneMetricPoints` 同一条纪律:**可再生的观测**才敢清;记忆不可删。
   */
  pruneOutbound({ days = 30, now = Date.now() } = {}) {
    const cutoff = now - Math.max(1, days) * 24 * 3600 * 1000;
    const info = this.#db.prepare('DELETE FROM outbound WHERE at < ?').run(cutoff);
    return Number(info.changes ?? 0);
  }

  // --- 媒体发送绑定(T3,2026-10-29) ------------------------------------------
  /** 记一条「这条出站消息 = 这个资产的第 N 张」。无出站消息 id 不记(null 不编);
   *  幂等:同一 (scene,target,outboundId,itemSeq) 只记一次,重复返回 null。 */
  recordMediaLink({ bot = '', scene = '', target = '', outboundId = '', itemSeq = 1, kind = 'meitu', taskId = null, md5 = null, source = null, sourceId = null, at = Date.now() } = {}) {
    const oid = String(outboundId ?? '');
    if (oid === '' || String(target ?? '') === '') return null;
    const info = this.#db.prepare(
      `INSERT OR IGNORE INTO media_link (bot, scene, target, outbound_id, item_seq, kind, task_id, md5, source, source_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(String(bot), String(scene), String(target), oid, Number(itemSeq) || 1, String(kind),
      taskId, md5, source, sourceId == null ? null : String(sourceId), Number(at) || Date.now());
    return Number(info.changes) > 0 ? Number(info.lastInsertRowid) : null;
  }

  /** 引用查找:只在同 bot/scene/target 作用域内解析,绝不跨群/跨实例。按张数正序。 */
  mediaLinksByOutbound({ bot = '', scene = '', target = '', outboundId = '' } = {}) {
    const oid = String(outboundId ?? '');
    if (oid === '' || String(target ?? '') === '') return [];
    return this.#db.prepare(
      `SELECT id, bot, scene, target, outbound_id AS outboundId, item_seq AS itemSeq, kind,
              task_id AS taskId, md5, source, source_id AS sourceId, at
         FROM media_link
        WHERE bot = ? AND scene = ? AND target = ? AND outbound_id = ?
        ORDER BY item_seq`,
    ).all(String(bot), String(scene), String(target), oid);
  }

  /**
   * 保留策略:删 N 天以前的媒体绑定。返回删掉的行数。
   * ⚠️ 90 天【暂定】——绑定是"引用能不能找回"的索引,不是记忆;太老的平台引用也早失效。
   * 没有它表会无限涨;数值要调就调这一个参数(判据在 selftest 里钉行为不钉天数)。
   */
  pruneMediaLinks({ days = 90, now = Date.now() } = {}) {
    const cutoff = now - Math.max(1, days) * 24 * 3600 * 1000;
    const info = this.#db.prepare('DELETE FROM media_link WHERE at < ?').run(cutoff);
    return Number(info.changes ?? 0);
  }

  // --- 世界档自有会话历史(1.146.1 / docs 21 §十二 刀二B) -------------------
  //
  // ⚠️ append-only:只插不改不删;裁剪在读取侧(context-budget),表里原文不动
  //    (前缀逐字节稳定判据的前提)。引擎接线在刀三A,本刀只给存储面。

  /**
   * 追加一轮(append-only)。tokens 写入时用 approxTokens 算好(dream-cards 一份,D159)。
   * meta 建议形状:{ usage: { prompt, completion, cacheHit, cacheMiss } }(assistant 轮,
   * llm.js 的真 usage;§六 g1)。空 content 不记(空轮没有前缀意义)。返回行 id。
   */
  appendConversationTurn({ key, at = Date.now(), role = 'user', content = '', meta = null } = {}) {
    const body = String(content ?? '');
    if (body.trim() === '') return null;
    const metaText = meta === null || meta === undefined ? null : JSON.stringify(meta);
    const info = this.#db
      .prepare('INSERT INTO conversation_turn (key, at, role, content, tokens, meta) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(key ?? ''), Number(at) || Date.now(), String(role ?? 'user'), body, approxTokens(body), metaText);
    return Number(info.lastInsertRowid ?? 0) || null;
  }

  /**
   * 读一个会话的逐轮历史(**时间正序**、确定性排序:key + id;引擎拼前缀的唯一读口)。
   * limit > 0 时取**最近** limit 轮(裁剪的读取侧口径);0 = 全量。
   * 同一行重复读结果逐字相等 —— 前缀稳定性判据吃的就是这一点。
   */
  conversationTurns(key, { limit = 0 } = {}) {
    const n = Math.max(0, Number(limit) || 0);
    const sql = n > 0
      ? `SELECT id, at, role, content, tokens, meta FROM conversation_turn
          WHERE key = ? ORDER BY id DESC LIMIT ?`
      : `SELECT id, at, role, content, tokens, meta FROM conversation_turn WHERE key = ? ORDER BY id`;
    const rows = n > 0 ? this.#db.prepare(sql).all(String(key ?? ''), n) : this.#db.prepare(sql).all(String(key ?? ''));
    if (n > 0) rows.reverse(); // limit 分支取的是最近 N 轮(DESC),翻回时间正序;全量分支本就 ASC
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      role: String(row.role),
      content: String(row.content),
      tokens: Number(row.tokens),
      meta: safeJson(row.meta),
    }));
  }

  startOwnLlmAttempt(callId, at = Date.now()) {
    return Number(this.#db.prepare('INSERT INTO own_llm_attempt(call_id,at) VALUES (?,?)').run(callId, at).lastInsertRowid);
  }
  finishOwnLlmAttempt(id, { status, usage = null, httpStatus = null, at = Date.now() }) {
    this.#db.prepare('UPDATE own_llm_attempt SET ended_at=?,status=?,usage=?,http_status=? WHERE id=? AND status=\'pending\'')
      .run(at, status, usage ? JSON.stringify(usage) : null, httpStatus, id);
  }
  ownLlmAttempts() {
    return this.#db.prepare('SELECT * FROM own_llm_attempt ORDER BY id').all().map(row => ({ ...row, usage: safeJson(row.usage) }));
  }
  startOwnLlmCall({ key, kind, at = Date.now() }) {
    return Number(this.#db.prepare('INSERT INTO own_llm_call(key,kind,at) VALUES (?,?,?)')
      .run(String(key), String(kind), at).lastInsertRowid);
  }
  /**
   * 结算一次模型调用(1.168.0 / D275 起带 `model`)。
   * ⚠️ model 在**结算时**才写:发起时(`startOwnLlmCall`)还不知道最终模型
   * (scoped 客户端在 chat 内部才定),而 `llm.chat` 的返回里带真实 `model`。
   * 失败/取消行没有 model → NULL,报表按"模型未知"如实列(不猜、不计零)。
   */
  finishOwnLlmCall(id, { status, usage = null, error = null, model = null, at = Date.now() }) {
    this.#db.prepare('UPDATE own_llm_call SET ended_at=?,status=?,usage=?,error=?,model=? WHERE id=? AND status=\'pending\'')
      .run(at, status, usage ? JSON.stringify(usage) : null, error, model ?? null, id);
  }
  ownLlmCalls({ since = 0 } = {}) {
    return this.#db.prepare('SELECT * FROM own_llm_call WHERE at>=? ORDER BY id').all(since)
      .map(row => ({ ...row, usage: safeJson(row.usage) }));
  }
  /**
   * 梦境线的 usage 汇总行(1.168.0 / D275;给 `usage report` 单列一节用)。
   * 梦境的账落 `dream_msg.meta.usage`(先免费记账的用户拍板),**不在** own_llm_call ——
   * 报表把两边**分开列**(不许合并,否则"免费记账期"的量会被误读成已计费)。
   * @returns {Array<{at:number, usage:object|null}>} assistant 行(usage 缺 = null,报表单列 unknown)
   */
  dreamUsageSince({ since = 0 } = {}) {
    return this.#db.prepare(
      "SELECT at, meta FROM dream_msg WHERE role='assistant' AND at>=? ORDER BY id",
    ).all(since).map((row) => {
      const meta = safeJson(row.meta);
      return { at: row.at, usage: meta?.usage ?? null };
    });
  }

  // --- 已知群聊 -------------------------------------------------------------
  //
  // 为什么单独一张表而不是塞进 `meta`:`meta` 是"一个小值一个键"
  // (已播报的版本号那种),而群清单是**一组带时间的行** ——
  // 会想按 last_seen 排序、会想数一共有几个、以后还会想给它加字段(群名?备注?)。
  // 那就是"该建表"的信号,而不是"往 KV 里塞 JSON"。

  /** 记下"我知道有这个群"。每次收到该群消息时调用,**幂等**。 */
  touchGroup(id, now = Date.now()) {
    this.#db
      .prepare(
        `INSERT INTO known_group (id, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(id, now, now);
  }

  /** 所有已知群,按最近活跃倒序。 */
  knownGroups() {
    return this.#db
      .prepare('SELECT id, first_seen, last_seen FROM known_group ORDER BY last_seen DESC')
      .all()
      .map((row) => ({ id: row.id, firstSeen: row.first_seen, lastSeen: row.last_seen }));
  }

  /**
   * 忘掉一个群(**她已经被踢出去/群解散了**)。
   *
   * ⚠️ 2026-10-02 加:原来只有 `touchGroup`/`knownGroups` —— **只进不出**。
   * 于是一个她已经不在的群会**永远留在清单里**:公告照发(平台上报
   * `40034101 机器人非群成员`)、`/群列表` 也照列。用户原话:「**群列表要每天更新**」。
   * "还在不在"只有平台知道,所以判断在调用方(`api.getGroupInfo` 失败 = 不在了)。
   */
  forgetGroup(id) {
    return this.#db.prepare('DELETE FROM known_group WHERE id = ?').run(id).changes;
  }

  // --- 养成:经验 / 等级 / 概念 / 人 ------------------------------------------
  //
  // 等级不落盘:它永远是经验值的派生值(`levelForXp`)。存两份数字就会不一致,
  // 而"不一致"正是 D35 里 `known_group` 那个 bug 的形态。

  /** 当前养成状态(没有记录就是 Lv.1 / 0 经验)。 */
  getGrowth(now = Date.now()) {
    const row = this.#db.prepare('SELECT xp, milestones, updated_at FROM growth WHERE id = 1').get();
    if (!row) return createGrowth(now);
    return { xp: row.xp, level: levelForXp(row.xp), milestones: row.milestones, updatedAt: row.updated_at };
  }

  #writeGrowth(growth) {
    this.#db
      .prepare(
        `INSERT INTO growth (id, xp, milestones, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           xp = excluded.xp, milestones = excluded.milestones, updated_at = excluded.updated_at`,
      )
      .run(Number(growth.xp) || 0, Number(growth.milestones) || 0, growth.updatedAt ?? Date.now());
  }

  /**
   * 一轮结算:**加经验 + 记流水 + 学会的概念** 一个事务。
   *
   * 幂等不靠键,靠**调用点**:桥只在"这一轮真的完成了"时调一次
   * (`index.js` 的 `recordTurn`)。归档读不回发言人(D38),所以这里不做二次核对 ——
   * 但 `concept` 表的主键保证"同一个概念只算一次经验",刷不动。
   *
   * @param {{kind: string, xp: number, conversationKey?: string, scene?: string,
   *          newConcepts?: Array<{id: string, label: string}>}} turn
   * @param {number} now
   */
  applyGrowth(turn, now = Date.now()) {
    return this.#transaction(() => {
      const before = this.getGrowth(now);
      const newConcepts = Array.isArray(turn?.newConcepts) ? turn.newConcepts : [];

      // 概念先落库:它们本身就是 `turn.xp` 里的额外经验(见 `xpForTurn`),
      // 所以这一轮的经验值在**调用方**就已经把它们算进去了。
      for (const concept of newConcepts) {
        if (!concept?.id) continue;
        this.#db
          .prepare(
            `INSERT INTO concept (id, label, first_seen, seen_count, source) VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .run(String(concept.id), String(concept.label ?? concept.id), now, turn?.conversationKey ?? null);
      }

      const { growth, gained, levelledUp, milestone } = advanceGrowth(before, turn?.xp ?? 0, now);
      this.#writeGrowth(growth);
      // 每条流水都记下**当时的累计经验** —— 这样改了曲线也能重算历史等级,
      // 不用去猜"这份流水是从哪一点开始记的"(见 growth-report.js --rebuild-curve)。
      const insertEvent = this.#db.prepare(
        'INSERT INTO growth_event (ts, kind, xp_delta, xp_total, level, detail) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insertEvent.run(
        now,
        'turn',
        gained,
        growth.xp,
        growth.level,
        JSON.stringify({ kind: turn?.kind ?? 'unknown', concepts: newConcepts.map((c) => c.id), scene: turn?.scene ?? null }),
      );
      if (levelledUp) {
        insertEvent.run(now, 'levelup', 0, growth.xp, growth.level, null);
      }
      if (milestone !== null) {
        insertEvent.run(now, 'milestone', 0, growth.xp, milestone, JSON.stringify({ milestone }));
      }

      // 概念流水单独记一条,方便回答"她是什么时候学会这个的"。
      for (const concept of newConcepts) {
        if (!concept?.id) continue;
        insertEvent.run(now, 'concept', 0, growth.xp, growth.level, JSON.stringify({ id: concept.id, label: concept.label ?? null }));
      }

      return { growth, gained, before, levelledUp, milestone, newConcepts };
    });
  }

  /** 库里已经有的概念 id 集合 —— 判定"这个是不是新学会的"用。 */
  knownConceptIds() {
    return new Set(this.#db.prepare('SELECT id FROM concept').all().map((row) => row.id));
  }

  /** 学会的概念(新→旧,最多 `limit` 条)。 */
  concepts(limit = 20) {
    return this.#db
      .prepare('SELECT id, label, first_seen, seen_count FROM concept ORDER BY first_seen DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit)))
      .map((row) => ({ id: row.id, label: row.label, firstSeen: row.first_seen, seenCount: row.seen_count }));
  }

  conceptCount() {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM concept').get().n;
  }

  /** 认识的人:总人数 + 最近几个名字。给提示词与 `/成长` 用。 */
  peopleSummary(limit = 5) {
    const total = this.#db.prepare('SELECT COUNT(*) AS n FROM person').get().n;
    const recent = this.#db
      .prepare('SELECT display, last_seen FROM person ORDER BY last_seen DESC LIMIT ?')
      .all(Math.max(1, Math.min(50, limit)))
      .map((row) => ({ display: row.display ?? null, lastSeen: row.last_seen }));
    return { total, recent };
  }

  /**
   * 记一个说话的人。
   *
   * **身份是 `openid`,显示名只是备注**(人可以随时改名,而改名不该变成"新认识的人")。
   * 作用域按群/私聊分开,因为群里的 `member_openid` 是**每群一个**的 id 空间(D09)。
   */
  touchPerson({ scope, openid, display = null, scene = 'group', turns = 0 }, now = Date.now()) {
    if (!scope || !openid) return null;
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT first_seen FROM person WHERE scope = ? AND openid = ?').get(scope, openid);
      this.#db
        .prepare(
          `INSERT INTO person (scope, openid, display, scene, first_seen, last_seen, turns)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, openid) DO UPDATE SET
             display = COALESCE(excluded.display, person.display),
             last_seen = excluded.last_seen,
             turns = person.turns + excluded.turns`,
        )
        .run(scope, openid, display, scene, now, now, turns);
      return { isNew: !existing, scope, openid, display };
    });
  }

  /** 认识的人(新→旧)。`scope` 可选,用来只看某个群。 */
  people({ scope = null, limit = 50 } = {}) {
    const sql = scope
      ? 'SELECT * FROM person WHERE scope = ? ORDER BY last_seen DESC LIMIT ?'
      : 'SELECT * FROM person ORDER BY last_seen DESC LIMIT ?';
    const rows = scope
      ? this.#db.prepare(sql).all(scope, Math.max(1, Math.min(500, limit)))
      : this.#db.prepare(sql).all(Math.max(1, Math.min(500, limit)));
    return rows.map((row) => ({
      scope: row.scope,
      openid: row.openid,
      display: row.display,
      scene: row.scene,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      turns: row.turns,
    }));
  }

  /**
   * **一个人**在哪些场合被她记过、最近一次见到叫什么(1.100.0 / D162)。
   *
   * ⚠️ 为什么单开一条(而不是 `people()` 取全部再筛):
   *    这一问发生在**绑过 QQ 的人**说话的那一轮(每轮一次)——
   *    取全表(最多 500 行)再筛是浪费,而且这一问的答案就是"该叫他什么",
   *    让 SQL 直接按 openid 取更贴。
   * ⚠️ 同一个 openid 在不同 scope 下**不是同一个 openid**(D09),但**这一条路**问的是
   *    "绑定那个 openid 在哪儿被记过" —— 所以按 openid 取、按最近见到排序**是对的**。
   *
   * @param {string} openid
   * @returns {Array<{scope:string, openid:string, display:string|null, scene:string,
   *   firstSeen:number, lastSeen:number, turns:number}>} 最近的在前(没有就是空数组)
   */
  personByOpenid(openid) {
    const who = String(openid ?? '').trim();
    if (!who) return [];
    return this.#db
      .prepare('SELECT * FROM person WHERE openid = ? ORDER BY last_seen DESC')
      .all(who)
      .map((row) => ({
        scope: row.scope,
        openid: row.openid,
        display: row.display,
        scene: row.scene,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        turns: row.turns,
      }));
  }

  /**
   * 记一条「关于人的事实」(幂等:同一作用域+对象+维度+值只一行,重复见到只更新计数)。
   *
   * **ADD-only 软失效(P1-C,2026-10-19)**:改口不再物理删旧行,而是把同
   * (scope, subject, kind) 下**值不同**的旧行打上 `invalid_at` / `superseded_by`,
   * 它从此退出注入(facts 默认只看有效的),需要审计时还能 `latestOnly:false` 翻出来。
   *
   * 两条边界(为什么这样定):
   *   ① **只有 told / declared 能改"有效/失效"状态** —— 复活与退役都只归它们。
   *      mined 是回扫猜的,既不许把他拍板说过的(told)退役掉,**也不许把被退役的旧值复活**
   *      (否则回扫一遍旧历史就会冒出"两条不同值同时有效",而真实链路上可能很久没有 told 来收敛);
   *   ② **精确行复活** —— 他改口回来("我弟弟"→"我哥哥"→"我弟弟")时,老行重新成立
   *      (invalid_at / superseded_by 清空),而不是另起一行:同一句话永远只有一行。
   *
   * @param {{scope: string, subject: string, kind: string, value: string,
   *          detail?: string|null, source?: string, now?: number}} fact
   * @returns {null | {isNew: boolean, scope: string, subject: string, kind: string,
   *          value: string, id: number, superseded: Array<{id: number, kind: string, value: string}>}}
   *   `id` = 本次命中的那一行(新的或已存在的);`superseded` = 被这次写失效的旧行(可能为空;
   *   mined 恒为空 —— 它只 upsert,不动任何行的有效性)。
   */
  touchFact({ scope, subject, kind, value, detail = null, source = 'told' }, now = Date.now()) {
    if (!scope || !subject || !kind || !value) return null;
    // ⚠️ **唯一能改"有效/失效"的来源**:他说的 / 群里声明的。mined 只做 upsert。
    const authoritative = source === 'told' || source === 'declared';
    const existing = this.#db
      .prepare('SELECT id, seen_count, invalid_at FROM fact WHERE scope = ? AND subject = ? AND kind = ? AND value = ?')
      .get(scope, subject, kind, value);
    this.#db
      .prepare(
        `INSERT INTO fact (scope, subject, kind, value, detail, source, first_seen, last_seen, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(scope, subject, kind, value) DO UPDATE SET
           last_seen = excluded.last_seen,
           seen_count = fact.seen_count + 1,
           -- 详情只在原来是空的时候补,别让后来的粗抽取覆盖掉细的
           detail = COALESCE(fact.detail, excluded.detail),
           -- ⚠️ 来源只升不降:told(他拍板说的)不该被 mined(挖矿猜的)盖掉
           source = CASE WHEN fact.source = 'told' THEN 'told' ELSE excluded.source END`,
      )
      .run(scope, subject, kind, value, detail, source, now, now);
    // ⚠️ 拿 id 要**再查一次**:ON CONFLICT 走的是 UPDATE,拿不到 last_insert_rowid。
    const row = this.#db
      .prepare('SELECT id, invalid_at FROM fact WHERE scope = ? AND subject = ? AND kind = ? AND value = ?')
      .get(scope, subject, kind, value);
    const id = row.id;

    // ① 复活(只有 told/declared):这一行以前被软失效过 → 他又说了一遍,它就重新成立。
    //    ⚠️ mined 同值再 touch(**profile-scan 回扫旧历史就会这样**)不许复活:
    //    猜的东西不许把"他后来改掉的说法"翻回来,否则会同时有效两条不同值。
    if (authoritative && row.invalid_at != null) {
      this.#db.prepare('UPDATE fact SET invalid_at = NULL, superseded_by = NULL WHERE id = ?').run(id);
    }

    // ② 冲突退役(只有 told/declared):同 scope+subject+kind、值不同、现在还成立的行
    //    → 软失效并指回本次行。⚠️ 在**同一个作用域+对象+维度**内判冲突 —— 别的群、
    //    别人的事实一条都不许动。
    const superseded = [];
    if (authoritative) {
      const victims = this.#db
        .prepare(
          `SELECT id, kind, value FROM fact
            WHERE scope = ? AND subject = ? AND kind = ? AND value <> ? AND invalid_at IS NULL`,
        )
        .all(scope, subject, kind, value);
      for (const victim of victims) {
        this.#db
          .prepare('UPDATE fact SET invalid_at = ?, superseded_by = ? WHERE id = ?')
          .run(now, id, victim.id);
        superseded.push({ id: victim.id, kind: victim.kind, value: victim.value });
      }
    }
    return { isNew: !existing, scope, subject, kind, value, id, superseded };
  }

  /**
   * 某个作用域下的事实。`subject` 省略 = 这一段会话里的**所有人**
   * (私聊只有他自己;群里则是这个群里所有人的事实)。
   *
   * `latestOnly`(默认 true,P1-C):只看**现在仍成立**的行(`invalid_at IS NULL`)——
   * 注入走的就是这条路,所以被她"改口"掉的旧事实不会再进提示词。
   * 传 false = 连软失效的旧行一起翻出来(审计/查历史用)。
   */
  facts({ scope = null, subject = null, limit = 50, latestOnly = true } = {}) {
    const where = [];
    const args = [];
    if (scope) {
      where.push('scope = ?');
      args.push(scope);
    }
    if (subject) {
      where.push('subject = ?');
      args.push(subject);
    }
    if (latestOnly) where.push('invalid_at IS NULL');
    const sql = `SELECT id, scope, subject, kind, value, detail, source, first_seen, last_seen, seen_count,
                        superseded_by, merged_into, invalid_at
                   FROM fact ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY last_seen DESC LIMIT ?`;
    return this.#db
      .prepare(sql)
      .all(...args, Math.max(1, Math.min(500, limit)))
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        subject: row.subject,
        kind: row.kind,
        value: row.value,
        detail: row.detail,
        source: row.source,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        seenCount: row.seen_count,
        supersededBy: row.superseded_by,
        mergedInto: row.merged_into,
        invalidAt: row.invalid_at,
      }));
  }

  /**
   * **历史冲突一次性回溯软失效**(P1-C 补账,2026-10-19;用户当天拍板)。
   *
   * 为什么需要它:P1-C 的 `touchFact` 只在**写的那一刻**退役旧说法;而老库里**早就并存**
   * 的冲突(例如 `relation=老婆` 与 `relation=妹妹` 各一行)不会被追溯 —— 注入时两条
   * 一起进提示词,模型只能自己挑,挑错了她就会叫错人。这个方法是一次性补账:
   * 把同一 `(scope, subject, kind)` 下多行**仍有效**的事实收敛成一行。
   *
   * 保留规则(用户口径):**最近见过的那条留** —— `last_seen` 最大;同一毫秒再比 `id`(后插入的那行)。
   * 其余行 `UPDATE fact SET invalid_at = now, superseded_by = <保留行 id>`:**只软标记,不物理删**,
   * 所以 `latestOnly:false` 仍能审计,`--dry-run` 也能先看清单再决定。
   *
   * ⚠️ 与 `touchFact` 的写时规则有一处**有意的不同**(契约如此,不是实现漂了):
   *    写时 `mined` 不许退役 `told`/`declared`;回溯**按"最近见过"收敛、不区分来源** ——
   *    用户拍板的就是"历史冲突一次性收敛"。代价:两条都成立的事实(比如两条健康)
   *    可能被误伤,所以脚本默认 dry-run、先看明细再 apply。
   *
   * ⚠️ `dryRun:true` **一个字节都不写**(只 SELECT);`--apply` 之后**幂等**(再跑 conflicts=0)。
   * ⚠️ 只在**仍有效**的行之间判冲突(`invalid_at IS NULL`):已经退役的行不参与、也不会被改写。
   *
   * @param {{now?: number, dryRun?: boolean}} [options]
   * @returns {{dryRun: boolean, groups: number, conflicts: number,
   *   kept: Array<{id: number, scope: string, subject: string, kind: string, value: string, lastSeen: number}>,
   *   invalidated: Array<{id: number, scope: string, subject: string, kind: string, value: string, supersededBy: number}>}}
   *   `groups` = 发生历史并存的组数(等于 `kept.length`),`conflicts` = 将被/已被软失效的行数。
   */
  reconcileFacts({ now = Date.now(), dryRun = false } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT id, scope, subject, kind, value, last_seen
           FROM fact WHERE invalid_at IS NULL
          ORDER BY scope, subject, kind, id`,
      )
      .all();
    // 分组键用 \u0000 分隔:scope/subject 里可能含冒号等字符,拼接键不能有歧义。
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.scope}\u0000${row.subject}\u0000${row.kind}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    const kept = [];
    const invalidated = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue; // 一行 = 没有历史冲突
      let keeper = list[0];
      for (const row of list) {
        if (
          row.last_seen > keeper.last_seen
          || (row.last_seen === keeper.last_seen && row.id > keeper.id)
        ) {
          keeper = row;
        }
      }
      kept.push({
        id: keeper.id,
        scope: keeper.scope,
        subject: keeper.subject,
        kind: keeper.kind,
        value: keeper.value,
        lastSeen: keeper.last_seen,
      });
      for (const row of list) {
        if (row.id === keeper.id) continue;
        invalidated.push({
          id: row.id,
          scope: row.scope,
          subject: row.subject,
          kind: row.kind,
          value: row.value,
          supersededBy: keeper.id,
        });
      }
    }
    if (!dryRun && invalidated.length > 0) {
      this.#transaction(() => {
        const invalidate = this.#db.prepare(
          'UPDATE fact SET invalid_at = ?, superseded_by = ? WHERE id = ? AND invalid_at IS NULL',
        );
        for (const row of invalidated) invalidate.run(now, row.supersededBy, row.id);
      });
    }
    return { dryRun, groups: kept.length, conflicts: invalidated.length, kept, invalidated };
  }

  /**
   * 事实总数 + 各维度条数(给启动横幅与报表)。
   *
   * ⚠️ P1-C 起 `total` 与各 kind **只数仍成立的行**(`invalid_at IS NULL`)——
   *    启动横幅说的是"她记得多少条",软失效的旧事实不算;`invalid` 单独给失效条数,
   *    想核账时 total + invalid = 物理行数。
   */
  factStats(scope = null) {
    const rows = scope
      ? this.#db.prepare('SELECT kind, COUNT(*) n FROM fact WHERE scope = ? AND invalid_at IS NULL GROUP BY kind').all(scope)
      : this.#db.prepare('SELECT kind, COUNT(*) n FROM fact WHERE invalid_at IS NULL GROUP BY kind').all();
    const out = { total: 0 };
    for (const row of rows) {
      out[row.kind] = row.n;
      out.total += row.n;
    }
    const invalidRow = scope
      ? this.#db.prepare('SELECT COUNT(*) AS n FROM fact WHERE scope = ? AND invalid_at IS NOT NULL').get(scope)
      : this.#db.prepare('SELECT COUNT(*) AS n FROM fact WHERE invalid_at IS NOT NULL').get();
    out.invalid = invalidRow.n;
    return out;
  }

  /**
   * **撤销**(2026-10-01,D81):删掉匹配的事实,并把**删掉的每一条**返回给调用方。
   *
   * ⚠️ 为什么必须返回删掉的明细:回执要说清"我到底忘了什么"。
   *    只回一句"删好了"是最糟的形状 —— 用户没法核对,而这是**记忆**,删错了不可逆。
   *
   * `value` 用 `LIKE %…%`(模糊):人记不住她库里存的确切措辞。
   *
   * ⚠️ **`source` 是 2026-10-02 补的**(`profile-scan --revoke` 要用):回扫猜出来的那些
   * 标的是 `source='mined'`,而"他拍板说的"是 `told`、"群里 @ 人声明的"是 `declared` ——
   * 批量撤销只该动**猜的那一批**。`source` 与 `scope` **至少要给一个**:两个都不给 = 拒绝删
   * (失败即关闭,别让一句空调用把整张表清了)。
   *
   * @param {{scope?: string|null, subject?: string|null, kind?: string|null, value?: string|null,
   *          source?: string|null}} query
   * @returns {Array<{id: number, scope: string, subject: string, kind: string, value: string,
   *          detail: string|null, source: string}>}
   */
  forgetFacts({ scope = null, subject = null, kind = null, value = null, source = null } = {}) {
    if (!scope && !source) return [];
    const where = [];
    const args = [];
    if (scope) {
      where.push('scope = ?');
      args.push(scope);
    }
    if (subject) {
      where.push('subject = ?');
      args.push(subject);
    }
    if (kind) {
      where.push('kind = ?');
      args.push(kind);
    }
    if (value) {
      where.push('value LIKE ?');
      args.push(`%${value}%`);
    }
    if (source) {
      where.push('source = ?');
      args.push(source);
    }
    const clause = where.join(' AND ');
    const rows = this.#db
      .prepare(`SELECT id, scope, subject, kind, value, detail, source FROM fact WHERE ${clause}`)
      .all(...args);
    if (rows.length > 0) this.#db.prepare(`DELETE FROM fact WHERE ${clause}`).run(...args);
    return rows;
  }

  /** 最近的成长流水(升级 / 学会概念 / 每轮)。 */
  recentGrowthEvents(limit = 20) {    return this.#db
      .prepare('SELECT ts, kind, xp_delta, xp_total, level, detail FROM growth_event ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit)))
      .map(mapGrowthEventRow);
  }

  /** 升级历史(只查 `levelup`)。 */
  levelUps(limit = 20) {
    return this.#db
      .prepare("SELECT ts, level FROM growth_event WHERE kind = 'levelup' ORDER BY ts DESC LIMIT ?")
      .all(Math.max(1, Math.min(500, limit)))
      .map((row) => ({ ts: row.ts, level: row.level }));
  }

  // --- 杂项键值 -------------------------------------------------------------

  getMeta(key) {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), Date.now());
  }

  /**
   * 一次事务里写多个键。
   *
   * 为什么需要:播报账本是"基线 + 它的历史"两条记录(D58)—— 分成两次 `setMeta`
   * 就有"基线写了、历史没写"的窗口,而那个窗口恰好让"回退"失去依据。
   */
  setMetaMany(entries = {}) {
    return this.#transaction(() => {
      for (const [key, value] of Object.entries(entries)) this.setMeta(key, value);
    });
  }

  /**
   * **删掉一个 meta 键**(真的 DELETE,不是写空串)。
   *
   * ⚠️ 2026-10-03 加:`setMeta(key, '')` **不删行** —— 键还在,
   * 于是"清掉旧钓位"那段在 tick 里**每 30 秒重复清一遍、重复打日志**,
   * 刷了半屏(现场:`钓鱼：清掉 3 条旧格式的钓位` 每 30 秒一条)。
   */
  forgetMeta(key) {
    return this.#db.prepare('DELETE FROM meta WHERE key = ?').run(key).changes;
  }

  /**
   * 按前缀列出 `meta` 行(带 `updated_at`)。
   *
   * ⚠️ 用 `substr(...)` 而不是 `LIKE '前缀%'`:前缀里带 `_`(`announced_group:`)时
   * `LIKE` 会把 `_` 当成通配符 —— 那是"查出来的东西比你以为的多"的经典写法。
   */
  listMetaKeys(prefix = '') {
    return this.#db
      .prepare('SELECT key, value, updated_at FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key')
      .all(prefix.length, prefix)
      .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  // --- 组合动作:一次事务里改数值 + 记流水 ----------------------------------

  /**
   * 吃一顿:推进时间 → 应用进食 → 写状态 + 写流水,**一个事务**。
   *
   * 这正是换 SQLite 的核心收益:两件事要么都成,要么都不成 ——
   * 不会出现"数值涨了但流水没记"或反过来。
   *
   * ⚠️ 返回里**两笔都给**(`event` = 这一顿饭、`fedEvent` = 「被投喂」那笔,可能是 null):
   * 调用方要拿 `fedEvent` 一起拼"这一轮的状态增量"那行,否则会出现
   * "钱其实是涨的,回复末尾那行 `[…]` 里却看不见"(D97 起"别人请的"才免单,这一笔更容易被漏)。
   */
  applyIntake(intake, now, { sleep = null, bodyRules = this.#bodyRules } = {}) {
    return this.#transaction(() => {
      const stored = this.peekStats() ?? createStats(now, bodyRules);
      const advanced = advanceStats(stored, stored.updatedAt, now, { sleep, rules: bodyRules });
      const { stats, event, fedEvent } = applyMeal(advanced, intake, now, bodyRules);
      this.saveStats(stats);
      // 两笔账分开记:被投喂(kind='fed')与这一顿饭(kind='meal')—— 和状态变化一一对应。
      if (fedEvent) this.recordStatsEvent(fedEvent);
      this.recordStatsEvent(event);
      return { stats, event, fedEvent };
    });
  }

  /**
   * 喝一瓶药剂(魔力药剂 / 体力药剂,2026-10-01):和进食同一个形状 ——
   * **推进时间 → 按代码里的固定数值结算 → 写状态 + 写流水,一个事务**。
   */
  applyPotion(kind, now, { sleep = null, bodyRules = this.#bodyRules } = {}) {
    return this.#transaction(() => {
      const stored = this.peekStats() ?? createStats(now, bodyRules);
      const advanced = advanceStats(stored, stored.updatedAt, now, { sleep, rules: bodyRules });
      const { stats, event } = applyPotionRule(advanced, kind, now);
      if (!event) return { stats: advanced, event: null };
      this.saveStats(stats);
      this.recordStatsEvent(event);
      return { stats, event };
    });
  }

  /** 一次互动(被夸/被戳),同样在一个事务里。 */
  applyInteraction(kind, now, { sleep = null, bodyRules = this.#bodyRules } = {}) {
    return this.#transaction(() => {
      const stored = this.peekStats() ?? createStats(now, bodyRules);
      const advanced = advanceStats(stored, stored.updatedAt, now, { sleep, rules: bodyRules });
      const { stats, event } = applyInteractionRule(advanced, kind, now);
      this.saveStats(stats);
      if (event) this.recordStatsEvent(event);
      return { stats, event };
    });
  }

  /**
   * 钱的增减(接委托、随机小事件、被请客)。
   *
   * 和进食/互动同一个形状:**推进时间 → 改钱 → 写状态 + 写流水,一个事务**。
   * 所以"她赚了 12 枚"这件事一定有一条流水对应,`/钱包` 与报表都查得到来路。
   */
  applyMoneyDelta(delta, now, detail = {}, { sleep = null, bodyRules = this.#bodyRules } = {}) {
    return this.#transaction(() => {
      const stored = this.peekStats() ?? createStats(now, bodyRules);
      const advanced = advanceStats(stored, stored.updatedAt, now, { sleep, rules: bodyRules });
      const { stats, event } = applyMoney(advanced, delta, now, detail);
      this.saveStats(stats);
      if (event) this.recordStatsEvent(event);
      return { stats, event };
    });
  }

  /**
   * **挂起的事件钩子**(D99 阶段 3):她抛出一个**未解决**的小事件,等回应。
   *
   * 为什么落盘而不是放内存:这是**一条事实**("她问过这件事,还没人答")——
   * 重启之后它还成立,和 `known_group` / `person` 同一族判据(D35)。
   * 只留内存的后果是:重启正好落在"她刚抛出去、还没人回"的那半小时里 → 那件事**永远没有结局**,
   * 而用户看到的是一条悬在半空的消息。
   *
   * ⚠️ 键用**稳定键**(`group:<群id>` / `c2c:<appid>`),**不是**会话 key ——
   * 会话 key 每换代就变(重启就换),用它当键等于每次重启都找不到。
   */
  openPendingEvent({ key, scene, targetId, eventId, setup, branches = [], openedAt, expiresAt }) {
    this.#db.prepare(
      `INSERT INTO pending_event (key, scene, target_id, event_id, setup, branches, opened_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         scene = excluded.scene, target_id = excluded.target_id, event_id = excluded.event_id,
         setup = excluded.setup, branches = excluded.branches,
         opened_at = excluded.opened_at, expires_at = excluded.expires_at`,
    ).run(key, scene, targetId, eventId, setup, JSON.stringify(branches), openedAt, expiresAt);
  }

  getPendingEvent(key) {
    const row = this.#db.prepare('SELECT * FROM pending_event WHERE key = ?').get(key);
    if (!row) return null;
    return {
      key: row.key,
      scene: row.scene,
      targetId: row.target_id,
      eventId: row.event_id,
      setup: row.setup,
      branches: safeJson(row.branches) ?? [],
      openedAt: row.opened_at,
      expiresAt: row.expires_at,
    };
  }

  clearPendingEvent(key) {
    return this.#db.prepare('DELETE FROM pending_event WHERE key = ?').run(key).changes;
  }

  /** 所有还挂着的钩子(超时那一拍要遍历它)。 */
  listPendingEvents() {
    return this.#db.prepare('SELECT * FROM pending_event ORDER BY opened_at').all().map((row) => ({
      key: row.key,
      scene: row.scene,
      targetId: row.target_id,
      eventId: row.event_id,
      setup: row.setup,
      branches: safeJson(row.branches) ?? [],
      openedAt: row.opened_at,
      expiresAt: row.expires_at,
    }));
  }

  /** 一次事件的数值结算:**推进时间 → 应用效果 → 写状态 + 写流水,一个事务**(与进食同形)。 */
  applyStoryResult(effect, now, detail = {}, { sleep = null, bodyRules = this.#bodyRules } = {}) {
    return this.#transaction(() => {
      const stored = this.peekStats() ?? createStats(now, bodyRules);
      const advanced = advanceStats(stored, stored.updatedAt, now, { sleep, rules: bodyRules });
      const { stats, event } = applyStoryRule(advanced, effect, now, detail);
      this.saveStats(stats);
      if (event) this.recordStatsEvent(event);
      return { stats, event };
    });
  }

  #transaction(fn) {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** 只读打开(给报表脚本/日志机器人用,不影响正在运行的 bridge)。 */
export function openReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    // ⚠️ 脚本跑完就退出、句柄随之释放;但**测试(和以后的长驻进程)必须能自己关** ——
    //    Windows 上没关句柄就去删那个临时目录会 EPERM(2026-10-10 单测踩到)。
    close: () => { try { db.close(); } catch { /* 已经关了 */ } },
    stats: () => db.prepare('SELECT * FROM stats WHERE id = 1').get() ?? null,
    events: (limit = 20) => db.prepare('SELECT * FROM stats_event ORDER BY ts DESC LIMIT ?').all(limit),
    lastMeal: () => db.prepare("SELECT ts, detail FROM stats_event WHERE kind = 'meal' ORDER BY ts DESC LIMIT 1").get() ?? null,
    warmups: () => db.prepare('SELECT * FROM warmup').all(),
    mornings: () => db.prepare('SELECT * FROM morning').all(),
    metrics: () => db.prepare('SELECT key, value FROM metric').all(),
    meta: (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    conversations: () => db.prepare('SELECT COUNT(*) AS n FROM conversation').get().n,
    // 养成(表可能不存在 —— 老库还没升到 SCHEMA_VERSION 3 时报表不该炸)。
    growth: () => {
      const row = db.prepare('SELECT xp, milestones, updated_at FROM growth WHERE id = 1').get() ?? null;
      return row ? { xp: row.xp, milestones: row.milestones, updatedAt: row.updated_at } : null;
    },
    concepts: (limit = 50) =>
      db.prepare('SELECT id, label, first_seen, seen_count FROM concept ORDER BY first_seen DESC LIMIT ?')
        .all(limit)
        .map((row) => ({ id: row.id, label: row.label, firstSeen: row.first_seen, seenCount: row.seen_count })),
    people: (limit = 50) =>
      db.prepare('SELECT scope, openid, display, scene, first_seen, last_seen, turns FROM person ORDER BY last_seen DESC LIMIT ?')
        .all(limit)
        .map((row) => ({
          scope: row.scope,
          openid: row.openid,
          display: row.display,
          scene: row.scene,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
          turns: row.turns,
        })),
    // ⚠️ 与 `recentGrowthEvents` **同一个映射函数** —— 两条路径形状必须一致(见它上面的注释)。
    growthEvents: (limit = 30) =>
      db.prepare('SELECT ts, kind, xp_delta, xp_total, level, detail FROM growth_event ORDER BY ts DESC LIMIT ?')
        .all(limit)
        .map(mapGrowthEventRow),
    // 出站留痕(2026-10-10,D175)。⚠️ **老库可能没有 outbound**(还没被新版 bridge 打开过)——
    // 与下面 metric_point 同一条纪律:报表如实说"这一版还没开始记",而不是抛错。
    hasOutbound: () => Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound'").get(),
    ),
    outbound: (opts = {}) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound'").get()) return [];
      const cap = Math.max(1, Math.min(5000, Number(opts.limit) || 500));
      const since = Number(opts.since) || 0;
      const scene = opts.scene ?? null;
      const target = opts.target ?? null;
      const rows = db
        .prepare(
          `SELECT at, scene, target, kind, chars, text FROM outbound
            WHERE at >= ?
              AND (? IS NULL OR scene = ?)
              AND (? IS NULL OR target LIKE ?)
            ORDER BY at DESC LIMIT ?`,
        )
        .all(since, scene, scene, target, target === null ? null : `%${target}%`, cap);
      return rows.reverse().map((row) => ({
        at: Number(row.at),
        scene: String(row.scene),
        target: String(row.target),
        kind: row.kind === null ? null : String(row.kind),
        chars: Number(row.chars),
        text: String(row.text),
      }));
    },
    // 指标(2026-10-02,D94)。⚠️ **老库可能没有 metric_point**(还没被新版 bridge 打开过):
    // 报表要如实说"这一版还没开始记",而不是抛错 —— 与上面 growth 那条同一个理由。
    hasMetricPoints: () => Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metric_point'").get(),
    ),
    metricPoints: (opts = {}) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metric_point'").get()) return [];
      const cap = Math.max(1, Math.min(200000, Number(opts.limit) || 50000));
      const since = Number(opts.since) || 0;
      const rows = opts.key
        ? db.prepare('SELECT ts, key, value, scope FROM metric_point WHERE key = ? AND ts >= ? ORDER BY ts DESC LIMIT ?')
          .all(String(opts.key), since, cap)
        : db.prepare('SELECT ts, key, value, scope FROM metric_point WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
          .all(since, cap);
      return rows.map((row) => ({ ts: Number(row.ts), key: String(row.key), value: Number(row.value), scope: row.scope }));
    },
    metricDaily: ({ since = 0 } = {}) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metric_point'").get()) return [];
      return db.prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, key, COUNT(*) AS n, SUM(value) AS total
           FROM metric_point
          WHERE ts >= ?
          GROUP BY day, key
          ORDER BY day DESC, key ASC`,
      ).all(since).map((row) => ({ day: String(row.day), key: String(row.key), n: Number(row.n), total: Number(row.total) }));
    },
    metricPointCount: () => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metric_point'").get()) return 0;
      return Number(db.prepare('SELECT COUNT(*) AS n FROM metric_point').get().n);
    },
    close: () => db.close(),
  };
}

/**
 * 读**别的实例**的状态库,取出一份给人看的快照。
 *
 * 这是"日志机器人"的核心动作:副实例(独立进程)只读打开主实例的库,
 * 于是不需要 bridge 暴露任何接口,也不需要两边同时改代码(D27)。
 *
 * `money` 一起读出来(D42):副实例的"身体数值扫描"要报**四个**数。
 * 老库(迁移之前建的)这一列是 NULL —— 用默认值兜住,别把 null 当成 0 报出去。
 *
 * @returns {{stats: object|null, lastMealAt: number|null, lastFood: string|null}}
 */
export function readStatsForReport(file) {
  const reader = openReadOnly(file);
  try {
    const row = reader.stats();
    const meal = reader.lastMeal();
    let food = null;
    try {
      food = meal?.detail ? JSON.parse(meal.detail)?.food ?? null : null;
    } catch {
      food = null;
    }
    return {
      stats: row
        ? {
          satiety: row.satiety,
          health: row.health,
          mood: row.mood,
          money: Number.isFinite(row.money) ? row.money : STAT_DEFAULTS.money,
          updatedAt: row.updated_at,
          lastPraiseAt: row.last_praise_at,
          lastPokeAt: row.last_poke_at,
          lastIgnoredAt: row.last_ignored_at,
        }
        : null,
      lastMealAt: meal?.ts ?? null,
      lastFood: food,
    };
  } finally {
    reader.close();
  }
}
