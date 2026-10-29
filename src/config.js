import { LOCAL_MOOD_BODY_CONTENT } from './local-mood-body-content.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { resolveParams } from './params.js';
import { CONFIG_DEFAULTS, CONFIG_DERIVED_DEFAULTS, CONFIG_KNOWN_ENV, createConfigParamDefinitions } from './config-params.js';
import { packParamsForTheme } from './content-pack.js';
import { validatePackParams } from './pack-params.js';
import { DEFAULT_MEAL_WINDOWS, WARMUP_MODES, parseMealWindows, parseSleepWindow } from './warmup.js';
import { parseMorningTime } from './morning.js';
import { MOOD_THEME_NAMES } from './mood.js';
import { BODY_THEME_NAMES } from './body-theme.js';
import { DEFAULT_C2C_DEBOUNCE_MS, DEFAULT_REPLY_JITTER_RANGE } from './burst.js';
import { DEFAULT_STRAND_GAP_MS } from './social.js';
// 采样参数的**唯一校验口**(D159):配置读进来的值与引擎发出去的 body 必须同一套口径。
import { validateLlmRequestOptions } from './llm.js';
// 美图库的路径派生只有一份(`state.db` 同级 = `meitu.db`,见展览处刀 1 / D306)。
import { meituDbPathFromStateDb } from './meitu-gallery.js';

/** QQ intent bit for group-@ and direct (C2C) messages. */
export const INTENT_GROUP_AND_C2C = 1 << 25;
/** QQ intent bit for public guild channel messages. */
export const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;

/** Supported sender-access policies, in ascending order of openness. */
export const ACCESS_MODES = ['allowlist', 'blocklist', 'open'];

/** Local display content is separate from the unchanged runtime policy. */
export const DEFAULT_GROUP_KEYWORDS = LOCAL_MOOD_BODY_CONTENT?.config.groupKeywords ?? ['示例助手', 'demo'];

/** Parse a comma-separated keyword list; an empty value disables the trigger. */
function parseKeywords(value) {
  if (value === undefined) return [...DEFAULT_GROUP_KEYWORDS];
  if (value.trim() === '') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Re-exported so config consumers do not need a second import. */
export { parseSleepWindow } from './warmup.js';

const DEFAULTS = CONFIG_DEFAULTS;
// A synchronous build-local adapter; never write params/packParams into process.env.
let activeParams = null;
// Provenance for the existing index.js preload as well as repeated loadConfig calls.
// Values stay private, never enter config diagnostics or serialized output.
const dotenvOrigins = new Map();

function typed(name, fallback) {
  if (activeParams) return activeParams.values[name] ?? fallback;
  const def = CONFIG_PARAM_DEFINITIONS.find((entry) => entry.id === name);
  if (!def) throw new Error('配置参数未注册');
  return resolveParams([def], { env: { [name]: process.env[name] } }).values[name] ?? fallback;
}

function raw(name) {
  const value = activeParams ? activeParams.inputs[name] : process.env[name];
  return value === undefined || value === '' ? undefined : String(value);
}

function asInt(name, fallback) {
  return typed(name, fallback);
}

function asBool(name, fallback) {
  return typed(name, fallback);
}

/** A ratio in `[0, 1]`, for probabilities. Zero is meaningful, so it is allowed. */
function asRatio(name, fallback) {
  return typed(name, fallback);
}

/** Like `asInt`, but zero is allowed because it means "disabled". */
function asNonNegativeInt(name, fallback) {
  return typed(name, fallback);
}

/** 更新播报的模式:照念 / 用角色的语气说。拼错 fail closed。 */
export const ANNOUNCE_MODES = ['verbatim', 'character'];
/** 播报发给谁。 */
export const ANNOUNCE_TARGETS = ['c2c', 'groups', 'both'];

/** Local display content is separate from the unchanged runtime policy. */
function parseMoodTheme(value) {
  if (value === undefined) return 'megumin';
  const theme = value.trim().toLowerCase();
  if (!MOOD_THEME_NAMES.includes(theme)) {
    throw new Error(`QQBOT_MOOD_THEME 只能是 ${MOOD_THEME_NAMES.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return theme;
}

/** Local display content is separate from the unchanged runtime policy. */
function parseBodyTheme(value, moodTheme) {
  if (value === undefined) return moodTheme;
  const theme = value.trim().toLowerCase();
  if (!BODY_THEME_NAMES.includes(theme)) {
    throw new Error(`QQBOT_BODY_THEME 只能是 ${BODY_THEME_NAMES.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  if (theme !== moodTheme) {
    throw new Error(
      `QQBOT_BODY_THEME（${theme}）与 QQBOT_MOOD_THEME（${moodTheme}）不一致 —— ` +
      (LOCAL_MOOD_BODY_CONTENT?.config.bodyMismatchNote ?? '身体口径必须与情绪主题一致，避免不同实例的口径混用'),
    );
  }
  return theme;
}

/**
 * 播报什么时候发(D50):
 *
 *   `confirm` **问一句再发**:还有没播报的内容时,私聊问操作者一次;
 *            他回 `/发` 才发(`/发 私聊` / `/发 群 N` 可以选范围)。**这是默认。**
 *   `auto`    不问就发(启动 + 定时,受睡眠闸门)—— 老行为,留着给"完全不想管"的用法。
 *   `manual`  只在你手动打 `/更新` 时发。
 *
 * 拼错 fail closed。默认值从 `auto` 改成 `confirm`,因为"发到群里"这件事
 * **发出去就收不回来**,而用户明确要求"我确认了再发"。
 */
export const ANNOUNCE_TRIGGERS = ['confirm', 'auto', 'manual'];

/**
 * 升级播报发到哪儿(D40)。
 *
 *   `both`  里程碑发**群**里那句 + 每一级都发**私聊账单**给你(默认)
 *   `c2c`   只发私聊账单(群里一点动静都没有)
 *   `group` 只发群里那句(里程碑才有;普通升级不告诉你)
 *   `off`   完全不发(升级只体现在她的状态栏与注入里)
 *
 * 为什么要分两条通道:群里被"她升级了"刷屏是最烦的一种机器人行为,
 * 但运维者应该看得见进度 —— 所以普通升级走**私聊**,群里只留里程碑那几句。
 */
export const GROWTH_ANNOUNCE_CHANNELS = ['both', 'c2c', 'group', 'off'];

function parseGrowthAnnounce(value) {
  if (value === undefined) return 'both';
  const channel = value.trim().toLowerCase();
  if (!GROWTH_ANNOUNCE_CHANNELS.includes(channel)) {
    throw new Error(`QQBOT_GROWTH_ANNOUNCE 只能是 ${GROWTH_ANNOUNCE_CHANNELS.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return channel;
}

/**
 * 「像人在打字」的抖动范围(D53):`9000-20000`(毫秒)。
 *
 *   `off` / `0` / 空  → 关掉抖动(秒回,旧行为)
 *   `8000`           → 固定 8 秒
 *   `9000-20000`     → 这之间随机
 *
 * 拼错 **fail closed**(D20):写错就必须报错,不能悄悄退回"秒回" ——
 * 那正是这次要治的东西,安静地失效等于没修。
 *
 * 两个配置项共用这一段解析:群聊"被叫到名字"的 `QQBOT_KEYWORD_JITTER_MS`(D53),
 * 与通用回复的 `QQBOT_REPLY_JITTER_MS`(2026-09-30)。所以**报错信息要带上是哪一项**
 * —— 否则写错了 `REPLY_JITTER`,错误里却念 `KEYWORD_JITTER`,人会去改错文件。
 *
 * @param {string|undefined} value 原始配置值
 * @param {string} [name] 报错时报出的配置项名
 * @returns {{minMs: number, maxMs: number}}
 */
export function parseJitterRange(value, name = 'QQBOT_KEYWORD_JITTER_MS') {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '' || text === 'off' || text === '0') return { minMs: 0, maxMs: 0 };
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`${name} 只能是「最小-最大」毫秒、单个毫秒数,或 off，收到 ${JSON.stringify(value)}`);
  }
  const minMs = Number(match[1]);
  const maxMs = match[2] === undefined ? minMs : Number(match[2]);
  if (!Number.isSafeInteger(minMs) || !Number.isSafeInteger(maxMs) || maxMs < minMs) {
    throw new Error(`${name} 的范围不合法(最大不能小于最小)：${JSON.stringify(value)}`);
  }
  return { minMs, maxMs };
}

/**
 * 私聊「连发合并」窗口(毫秒,`QQBOT_C2C_DEBOUNCE_MS`)。
 *
 * 0 = 关掉(回到"来一条回一条");正数 = 等群里/私聊安静这么久再开口。
 * 上限 30 秒是**防手滑**的:写个 300000 就等于"她不回话了",那不是配置,
 * 那是关掉了这个功能却看起来还在工作。
 */
function parseC2cDebounce() {
  const ms = asNonNegativeInt('QQBOT_C2C_DEBOUNCE_MS', DEFAULT_C2C_DEBOUNCE_MS);
  if (ms > 30_000) {
    throw new Error(`QQBOT_C2C_DEBOUNCE_MS 最多 30000（30 秒）—— 再长就不是"合并连发"，是"她不回话"了：${ms}`);
  }
  return ms;
}

function parseAnnounceTrigger(value) {
  if (value === undefined) return 'confirm';
  const trigger = value.trim().toLowerCase();
  // 「问我一声」的另一种写法:写 `ask` 也认,免得有人写了然后以为生效了 —— 只认这一个别名。
  if (trigger === 'ask') return 'confirm';
  if (!ANNOUNCE_TRIGGERS.includes(trigger)) {
    throw new Error(`QQBOT_ANNOUNCE_TRIGGER 只能是 ${ANNOUNCE_TRIGGERS.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return trigger;
}

function parseAnnounceMode(value) {
  if (value === undefined) return 'character';
  const mode = value.trim().toLowerCase();
  if (!ANNOUNCE_MODES.includes(mode)) {
    throw new Error(`QQBOT_ANNOUNCE_MODE 只能是 ${ANNOUNCE_MODES.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return mode;
}

function parseAnnounceTargets(value) {
  if (value === undefined) return 'c2c';
  const targets = value.trim().toLowerCase();
  if (!ANNOUNCE_TARGETS.includes(targets)) {
    throw new Error(`QQBOT_ANNOUNCE_TARGETS 只能是 ${ANNOUNCE_TARGETS.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return targets;
}

/**
 * Warm-up scheduling mode. An unknown value is an error rather than a silent
 * fallback: "how often does it talk on its own" is not something a typo should
 * decide (D20).
 */
function parseWarmupMode(value) {
  if (value === undefined) return 'random';
  const mode = value.trim().toLowerCase();
  if (!WARMUP_MODES.includes(mode)) {
    throw new Error(`QQBOT_WARMUP_MODE 只能是 ${WARMUP_MODES.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return mode;
}

/**
 * 主机器人 = 不带 `QQBOT_ENV_FILE` 时默认操作哪一只。
 *
 * 这是**唯一**一处"偏袒某一只机器人"的地方,而且只在"没人告诉我该用哪份配置"时生效。
 * 排第一只是因为它是最早部署的那只,不是因为它更特殊(D37)。
 */
export const PRIMARY_BOT = 'megumin';

/**
 * 找到要读哪份配置文件。
 *
 * 顺序(先命中先用):
 *   1. `QQBOT_ENV_FILE` —— 显式指定,启动器就是这么干的(`bots\<bot>\run.cmd`);
 *   2. `<root>\.env` —— **旧布局**,留着是为了"迁移到一半也能跑";
 *   3. `<root>\bots\<PRIMARY_BOT>\.env` —— 新布局的默认那一只。
 *
 * 找不到时返回第 3 条那个路径:报错信息里因此会**指出期望的位置**,
 * 而不是抛一句"缺少 QQ_APP_ID"让人去猜配置文件在哪。
 */
export function resolveEnvFile(rootDir) {
  // `.trim()` 不是洁癖:cmd 里写 `set QQBOT_ENV_FILE=bots\x\.env && node …` 时,
  // `set` 会把 `&&` **前面那个空格**一起塞进变量值,于是路径尾巴上多了个空格、
  // 文件"找不到"。实测踩过 —— 报错是"未找到 <路径>"而文件明明在那儿。
  // 启动器里用 `set "VAR=值"` 可以避免,但配置解析不该指望调用方记得这件事。
  const explicit = raw('QQBOT_ENV_FILE');
  if (explicit) return path.resolve(rootDir, explicit.trim());
  const candidates = [
    path.join(rootDir, '.env'),
    path.join(rootDir, 'bots', PRIMARY_BOT, '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

/**
 * Load a dotenv file into process.env if it exists. Uses Node's built-in parser
 * so the bridge stays dependency-free.
 */
function loadEnvFileData(file) {
  if (!fs.existsSync(file)) return { loaded: false, inputs: {} };
  try {
    const before = { ...process.env };
    const inputs = parseEnv(fs.readFileSync(file, 'utf8'));
    process.loadEnvFile(file);
    for (const name of Object.keys(inputs)) {
      if (!Object.hasOwn(before, name) && process.env[name] !== undefined) {
        dotenvOrigins.set(name, { value: process.env[name] });
      }
    }
    return { loaded: true, inputs };
  } catch { throw new Error('配置环境文件读取失败'); }
}

export function loadEnvFile(file) {
  return loadEnvFileData(file).loaded;
}

/**
 * The directory the agent works in, kept OUTSIDE the bridge directory on purpose.
 *
 * `dsh` loads a `.env` from its own working directory, and that file's values
 * become part of the agent's environment. Keeping the agent away from the
 * bridge directory means the QQ ClientSecret in `qqbot-bridge/.env` never
 * reaches the agent.
 */
export function defaultWorkspaceFor(rootDir) {
  return path.resolve(rootDir, '..', 'qqbot-workspace');
}

/**
 * **私有 home / 工作区的配置外壳**（原名 `buildDshConfig`，2026-10-17 / D236 加了这段说明）。
 *
 * ⚠️ **它已经不是"DSH 的配置"了** —— 6B 去 DSH 化之后，桥不再 spawn `dsh` 子进程。
 * 现在这里**只有 `cwd`（= 工作区，角色卡从哪读）还在被真消费**，其余字段是历史遗留：
 *
 * | 字段 | 现状 |
 * |---|---|
 * | `cwd` | ✅ 活的 —— `src\index.js` 三处（记忆归档 / 梗库 / 人设路径）都读它 |
 * | `profile` | ⚠️ 只剩展示（`scripts\handoff.js` 报退役键时用一下）；启动横幅已不再报 |
 * | `command` / `optional` / `provider` / `model` / `reasoningEffort` / `maxTokens` | ❌ **零消费者** |
 *
 * 保留字段是**刻意的**（主人 2026-10-16 定界："只退接口不删东西"）：它们让"配了已退役的键"
 * 这件事**有地方被发现并 warn**，而不是静默消失。真要删得先改 `.env.example` 与这里那一节说明。
 *
 * Every name is `QQBOT_`-prefixed（历史原因记在这里）：`dsh` 曾拒绝启动任何在它发现的 `.env` 里
 * 设置 `DSH_*` 变量的配置（`BOOTSTRAP_PREFIXES`），所以这些值当年必须走 `QQBOT_` 前缀。
 */
export function buildDshConfig(defaultWorkspace, rootDir = null) {
  const profile = parseDshProfile(raw('QQBOT_DSH_PROFILE') ?? DEFAULTS.profile);

  return {
    // ⚠️ 这三个字段(`command` / `optional`)已**零消费者**(6B 去 DSH 化后桥不再起子进程):
    //    留着只为让"配了已退役的键"能被 `scripts\handoff.js` 认出来提醒一句。见上面那张表。
    command: raw('QQBOT_DSH_COMMAND') ?? DEFAULTS.command,
    profile,
    // 离线开关(2026-10-08):当年 DSH 只负责"叫模型",其余(QQ/命令/面板/世界/记忆)都在桥这边。
    // 置 true 时,DshRunner 起不来不再让整个桥起不来,而是换一个"离线运行时"(永远静默)。
    // —— 那个运行时已随连接段退役;本项现在也没人读(同上)。
    optional: asBool('QQBOT_DSH_OPTIONAL', false),
    cwd: (() => {
      const workspace = raw('QQBOT_WORKSPACE');
      if (!workspace) return defaultWorkspace;
      // 相对路径按 bridge 目录解析,这样第二只机器人可以写
      // `QQBOT_WORKSPACE=..\qqbot-workspace-aris`,不必把绝对路径写死。
      // Local display content is separate from runtime policy.
      // Local display content is separate from runtime policy.
      return rootDir ? path.resolve(rootDir, workspace) : workspace;
    })(),
    provider: raw('QQBOT_DSH_PROVIDER') ?? DEFAULTS.provider,
    model: raw('QQBOT_DSH_MODEL') ?? DEFAULTS.model,
    reasoningEffort: raw('QQBOT_DSH_REASONING_EFFORT'),
    maxTokens: raw('QQBOT_DSH_MAX_TOKENS') ? asInt('QQBOT_DSH_MAX_TOKENS', undefined) : undefined,
  };
}

/**
 * 引擎选择与直连 LLM 配置(2026-10-14,docs\21 §十二 刀三B)。
 *
 * · `QQBOT_ENGINE`:`dsh`(默认,旧路)| `own`(自有引擎刀三A)| `shadow`(旧路照跑,
 *   自有引擎**只 dump 不发** —— 影子对账:看得见两边各发了什么)。
 * · 直连 key:世界档用 `QQBOT_LLM_*`(§十拍板之 2:两条路径分 key);
 *   没配时**回落** `QQBOT_LLM_DREAM_*`(梦境的 key)—— 只填 key 不分家也能跑,
 *   要运营隔离那天把 `QQBOT_LLM_KEY` 配上即分。own/shadow 模式没 key 当场大声失败,
 *   不静默降级(静默退化是这个项目最忌讳的东西)。
 * · 推理档位与输出上限(2026-10-15,并行审查 F5):`QQBOT_DSH_*` 那两项**只喂 DSH 的
 *   initialize**,own/shadow 路原来一个字都不读、也不报错 ⇒ 操作员从 dsh 切到 own 时
 *   这两项**静默失效**(配置静默丢弃族)。现在给直连路一对自己的变量:
 *   `QQBOT_LLM_REASONING_EFFORT` / `QQBOT_LLM_MAX_TOKENS`,与 key/model/baseUrl
 *   同一套回落(`DREAM` 那一对 → 通用那对)。
 *   ⚠️ **绝不从 `QQBOT_DSH_*` 回落** —— 那会让 own 路悄悄继承一份没人给它定的采样参数;
 *   "DSH 那边配了、own 这边没配"走的是**显式 warn**(见 `describeDshOnlyRequestOptions`)。
 */

/**
 * 读 own/shadow 路的采样配置:`{reasoningEffort?, maxTokens?}`(没配就不放这个键 —— 与旧行为逐字一致)。
 *
 * 校验**借 `llm.js` 那一个口**(D159:必须一致的东西只有一份),所以这里第一版读成
 * 别的字面量、或 `maxTokens` 读成小数/0/负数,都会在**网络之前**当场抛。
 *
 * @param {(name: string) => string|undefined} read 读环境变量的口(默认 `raw`)
 * @param {{validate?: Function}} [deps] 测试注入用
 */
export function buildEngineRequestOptions(read = raw, deps = {}) {
  const { validate = validateLlmRequestOptions } = deps;
  const effort = read('QQBOT_LLM_REASONING_EFFORT') ?? read('QQBOT_LLM_DREAM_REASONING_EFFORT');
  const maxRaw = read('QQBOT_LLM_MAX_TOKENS') ?? read('QQBOT_LLM_DREAM_MAX_TOKENS');
  const options = {};
  if (effort !== undefined) options.reasoningEffort = String(effort).trim().toLowerCase();
  if (maxRaw !== undefined) {
    const parsed = Number(maxRaw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error('QQBOT_LLM_MAX_TOKENS 必须是正安全整数（留空 = 不设上限）');
    }
    options.maxTokens = parsed;
  }
  validate(options);
  return options;
}

/**
 * own/shadow 模式下**配了却不生效**的 DSH 专用项(`docs\21 §六 g3` 说"全部走各 bot .env",
 * 实际上这两项在直连路没走通)。调用点在装配段 —— 那里才知道当前是哪个模式。
 *
 * ⚠️ 只报**名字**,不报值:值可能来自 .env,而日志是要贴出去的。
 *
 * @param {(name: string) => string|undefined} read
 * @returns {string[]} 没配就是空数组(不 warn —— 不制造狼来了)
 */
export function describeDshOnlyRequestOptions(read = raw) {
  return ['QQBOT_DSH_REASONING_EFFORT', 'QQBOT_DSH_MAX_TOKENS'].filter((name) => read(name) !== undefined);
}

export function buildEngineConfig() {
  // ⚠️ 默认值是 `own`（2026-10-17 / D236 改的）。原来是 `'dsh'`，那是"不配置 = 与从前一致"的
  //    年代留下的 —— 可 6B 之后**桥只跑 own**，留 `'dsh'` 当默认值的后果是：
  //    一台**没配 QQBOT_ENGINE 的新部署**会看到「QQBOT_ENGINE=dsh 已退役」这条它从没配过的 warn
  //    （`src\index.js` 的装配段），而 schema 又在暗示 dsh 是个正常选项。
  //    "空 = 用唯一那个引擎"才是诚实的默认值；显式配了别的值仍然照旧大声 warn。
  const mode = parseEngineMode(raw('QQBOT_ENGINE') ?? 'own');
  const limitRaw = raw('QQBOT_OWN_INPUT_TOKEN_LIMIT');
  const inputTokenLimit = limitRaw == null ? null : parseInputTokenLimit(limitRaw);
  return {
    mode,
    inputTokenLimit,
    requestOptions: buildEngineRequestOptions(),
    dshOnlyRequestOptions: describeDshOnlyRequestOptions(),
    llm: {
      baseUrl: raw('QQBOT_LLM_BASEURL') ?? raw('QQBOT_LLM_DREAM_BASEURL') ?? 'https://api.deepseek.com/v1',
      apiKey: raw('QQBOT_LLM_KEY') ?? raw('QQBOT_LLM_DREAM_KEY') ?? '',
      model: raw('QQBOT_LLM_MODEL') ?? raw('QQBOT_LLM_DREAM_MODEL') ?? 'deepseek-chat',
    },
  };
}

const ENGINE_MODES = ['dsh', 'own', 'shadow'];
const MEITU_SOURCES = ['auto', 'danbooru', 'safebooru'];

function parseDshProfile(value) {
  // The historical profile must not carry shell whitespace/metacharacters.
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('QQBOT_DSH_PROFILE 只能包含字母、数字、点、下划线和连字符');
  }
  return value;
}

function parseEngineMode(value) {
  const mode = String(value).trim().toLowerCase();
  if (!ENGINE_MODES.includes(mode)) throw new Error('QQBOT_ENGINE 只能是 dsh / own / shadow');
  return mode;
}

function parseInputTokenLimit(value) {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(parsed)) {
    throw new Error('QQBOT_OWN_INPUT_TOKEN_LIMIT 必须是正安全整数或留空（不设置上限）');
  }
  return parsed;
}

function parseMeituSource(value) {
  const source = String(value).trim().toLowerCase();
  if (!MEITU_SOURCES.includes(source)) throw new Error('QQBOT_MEITU_SOURCE 只能是 auto / danbooru / safebooru');
  return source;
}

function parseAccessMode(value) {
  const mode = String(value).toLowerCase();
  if (!ACCESS_MODES.includes(mode)) throw new Error('QQBOT_ACCESS_MODE 参数无效');
  return mode;
}

export const CONFIG_PARAM_DEFINITIONS = createConfigParamDefinitions({
  enums: {
    QQBOT_ENGINE: ENGINE_MODES, QQBOT_MEITU_SOURCE: MEITU_SOURCES, QQBOT_ACCESS_MODE: ACCESS_MODES,
    QQBOT_MOOD_THEME: MOOD_THEME_NAMES, QQBOT_BODY_THEME: BODY_THEME_NAMES, QQBOT_WARMUP_MODE: WARMUP_MODES,
    QQBOT_ANNOUNCE_MODE: ANNOUNCE_MODES, QQBOT_ANNOUNCE_TARGETS: ANNOUNCE_TARGETS,
    QQBOT_ANNOUNCE_TRIGGER: ANNOUNCE_TRIGGERS, QQBOT_GROWTH_ANNOUNCE: GROWTH_ANNOUNCE_CHANNELS,
    QQBOT_SELFCARE_LIFE_TO: ['c2c', 'group'],
  },
  profile: parseDshProfile, engine: parseEngineMode, inputTokenLimit: parseInputTokenLimit,
  meituSource: parseMeituSource, accessMode: parseAccessMode,
  moodTheme: parseMoodTheme, bodyTheme: (value) => parseBodyTheme(value, String(value).trim().toLowerCase()),
  warmupMode: parseWarmupMode, announceMode: parseAnnounceMode, announceTargets: parseAnnounceTargets,
  announceTrigger: parseAnnounceTrigger, growthAnnounce: parseGrowthAnnounce,
  groupMode: (value) => String(value).toLowerCase(),
  reasoningEffort: (value) => buildEngineRequestOptions((name) => name === 'QQBOT_LLM_REASONING_EFFORT' ? value : undefined).reasoningEffort,
  maxTokens: (value) => { validateLlmRequestOptions({ maxTokens: value }); return true; },
  keywordJitter: (value) => parseJitterRange(value),
  replyJitter: (value) => parseJitterRange(value, 'QQBOT_REPLY_JITTER_MS'),
  // These existing parsers deliberately retain their legacy tolerant grammar.
  sleep: parseSleepWindow, morning: parseMorningTime,
  mealWindows: (value) => {
    if (!Array.isArray(value)) return parseMealWindows(value);
    for (const entry of value) {
      if (!entry || typeof entry.label !== 'string'
        || !Number.isInteger(entry.start) || !Number.isInteger(entry.end)
        || parseMealWindows(`${entry.start}-${entry.end}`).length !== 1) throw new Error('invalid meal window');
    }
    return value;
  },
  keywords: (value) => {
    if (!Array.isArray(value)) return parseKeywords(value);
    if (value.some((entry) => typeof entry !== 'string')) throw new Error('invalid keywords');
    return parseKeywords(value.join(','));
  },
});

/**
 * Build the validated runtime configuration. Throws one aggregated error listing
 * every problem, so a misconfigured start fails loudly instead of half-working.
 */
export function loadConfig({ rootDir, params = {}, packParams } = {}) {
  const previous = activeParams;
  activeParams = null;
  try {
    const env = { ...process.env };
    const inheritedFileInputs = {};
    for (const [name, origin] of dotenvOrigins) {
      if (Object.hasOwn(env, name) && env[name] === origin.value) {
        inheritedFileInputs[name] = env[name];
        delete env[name];
      }
    }
    const envFile = resolveEnvFile(rootDir);
    let fileInputs = {};
    let loadedEnvFile;
    try {
      const loaded = loadEnvFileData(envFile);
      fileInputs = loaded.inputs;
      loadedEnvFile = loaded.loaded;
    } catch { throw new Error('配置环境文件读取失败'); }
    // Node dotenv never overwrites an existing process key, even an empty one.
    // Still validate every file input before omitting keys masked by empty env.
    resolveParams(CONFIG_PARAM_DEFINITIONS, { envFile: fileInputs });
    const effectiveFileInputs = Object.fromEntries(Object.entries({ ...fileInputs, ...inheritedFileInputs })
      .filter(([name]) => env[name] !== ''));
    let jsonParams = {};
    if (raw('QQBOT_PARAMS_FILE')) {
      try { jsonParams = JSON.parse(fs.readFileSync(path.resolve(rootDir, raw('QQBOT_PARAMS_FILE')), 'utf8')); }
      catch { throw new Error('QQBOT_PARAMS_FILE 配置数据读取失败'); }
      resolveParams(CONFIG_PARAM_DEFINITIONS, { configFile: jsonParams });
    }
    // Validate before spreading: never invoke accessors in injected data.
    resolveParams(CONFIG_PARAM_DEFINITIONS, { configFile: params });
    const configFile = { ...jsonParams, ...params };
    const layers = { configFile, envFile: effectiveFileInputs, env, knownEnv: CONFIG_KNOWN_ENV };
    const withoutPack = resolveParams(CONFIG_PARAM_DEFINITIONS, layers);
    const contentPack = packParams === undefined
      ? packParamsForTheme(withoutPack.values.QQBOT_MOOD_THEME) : packParams;
    validatePackParams(contentPack);
    const resolved = resolveParams(CONFIG_PARAM_DEFINITIONS, { ...layers, contentPack });
    activeParams = resolved;
    let config;
    try { config = buildRuntimeConfig({ rootDir, envFile, loadedEnvFile }); }
    catch (error) {
      // Legacy parsers include raw input and paths in errors. Never forward them.
      // Missing credentials keep the historical two-line shape (tests and operators
      // both recognise it), without the absolute env-file path.
      const problems = [];
      if (!raw('QQ_APP_ID')) problems.push('缺少 QQ_APP_ID（QQ 开放平台 -> 开发设置）');
      if (!raw('QQ_CLIENT_SECRET')) problems.push('缺少 QQ_CLIENT_SECRET（QQ 开放平台 -> 开发设置）');
      if (problems.length) throw new Error(`配置无效：\n  - ${problems.join('\n  - ')}`);
      if (resolved.values.QQBOT_BODY_THEME !== undefined
        && resolved.values.QQBOT_BODY_THEME !== resolved.values.QQBOT_MOOD_THEME) {
        throw new Error('配置无效：QQBOT_BODY_THEME 与 QQBOT_MOOD_THEME 不一致');
      }
      throw new Error('配置无效：参数校验失败');
    }
    const registry = CONFIG_PARAM_DEFINITIONS.map((definition) => Object.freeze({
      id: definition.id, type: definition.type, scope: definition.scope,
      sensitive: definition.sensitive, env: definition.env,
      min: definition.min, max: definition.max, values: definition.values,
      nullable: definition.nullable, emptyAsUnset: definition.emptyAsUnset,
      default: definition.sensitive ? undefined : definition.default,
      ...(CONFIG_DERIVED_DEFAULTS[definition.id] ? { derivedDefault: CONFIG_DERIVED_DEFAULTS[definition.id] } : {}),
    }));
    for (const [id, derivedDefault] of Object.entries(CONFIG_DERIVED_DEFAULTS)) {
      if (resolved.sources[id]?.source === 'default') resolved.sources[id].derivedDefault = derivedDefault;
    }
    const inheritSource = (id, upstream, applies) => {
      if (!applies || resolved.sources[id].source !== 'default') return;
      const origin = resolved.sources[upstream];
      resolved.sources[id] = {
        ...resolved.sources[id], source: origin.source,
        chain: [...origin.chain.map((entry) => ({ ...entry })), { source: 'derived' }],
        derivedFrom: upstream,
      };
    };
    inheritSource('QQBOT_BODY_THEME', 'QQBOT_MOOD_THEME', raw('QQBOT_BODY_THEME') === undefined);
    inheritSource('QQBOT_MEMORY_DB', 'QQBOT_MOOD_THEME', raw('QQBOT_MEMORY_DB') === undefined);
    for (const suffix of ['BASEURL', 'KEY', 'MODEL', 'REASONING_EFFORT', 'MAX_TOKENS']) {
      inheritSource(`QQBOT_LLM_${suffix}`, `QQBOT_LLM_DREAM_${suffix}`,
        raw(`QQBOT_LLM_${suffix}`) === undefined && raw(`QQBOT_LLM_DREAM_${suffix}`) !== undefined);
    }
    inheritSource('QQBOT_SELFCARE_C2C', 'QQBOT_MORNING_C2C',
      raw('QQBOT_SELFCARE_C2C') === undefined && raw('QQBOT_MORNING_C2C') !== undefined);
    inheritSource('QQBOT_IDS', 'QQBOT_ALLOWLIST', raw('QQBOT_IDS') === undefined
      && raw('QQBOT_ACCESS_MODE') === undefined && raw('QQBOT_ALLOWLIST') !== undefined);
    inheritSource('QQBOT_MEITU_DB', 'QQBOT_STATE_DB',
      raw('QQBOT_MEITU_DB') === undefined && raw('QQBOT_STATE_DB') !== undefined);
    Object.defineProperties(config, {
      paramSources: { value: resolved.sources },
      paramWarnings: { value: resolved.warnings },
      paramRegistry: { value: Object.freeze(registry) },
    });
    return config;
  } finally { activeParams = previous; }
}

function buildRuntimeConfig({ rootDir, envFile, loadedEnvFile }) {
  const problems = [];
  const appId = raw('QQ_APP_ID');
  const clientSecret = raw('QQ_CLIENT_SECRET');
  if (!appId) problems.push('缺少 QQ_APP_ID（QQ 开放平台 -> 开发设置）');
  if (!clientSecret) problems.push('缺少 QQ_CLIENT_SECRET（QQ 开放平台 -> 开发设置）');

  // Local display content is separate from runtime policy.
  // 所以这些都不能写死 —— 各自在自己的 .env 里指到不同文件。
  const lockFile = raw('QQBOT_LOCK_FILE')
    ? path.resolve(rootDir, raw('QQBOT_LOCK_FILE'))
    : path.join(rootDir, '.qqbot.lock');
  // 旧的 JSON 状态:默认自动导入一次。写成空值 = 不导入（第二只机器人用）。
  // 这里不能走 raw()：它把空串统一当成"没配"，而空串在本项里恰恰是有意义的
  // Local display content is separate from runtime policy.
  const legacyStateEnv = activeParams
    ? activeParams.inputs.QQBOT_LEGACY_STATE_FILE : process.env.QQBOT_LEGACY_STATE_FILE;
  const legacyStateFile = legacyStateEnv === undefined
    ? path.join(rootDir, '.qqbot-state.json')
    : (legacyStateEnv.trim() ? path.resolve(rootDir, legacyStateEnv) : null);

  // Access control. Three modes, because "who may talk to the bot" is a policy
  // the operator should state explicitly rather than infer from a variable name.
  //
  //   allowlist  only listed openids may talk           (fail closed)
  //   blocklist  everyone except listed openids may     (fail open)
  //   open       anyone may talk
  //
  // `QQBOT_ALLOWLIST` is the pre-0.2 spelling and is still honoured, so an
  // existing deployment cannot silently change who can reach the bot.
  const legacyAllowlist = raw('QQBOT_ALLOWLIST');
  const modeRaw = raw('QQBOT_ACCESS_MODE');
  const idsRaw = raw('QQBOT_IDS');

  // The legacy variable applies only when nothing newer configures access.
  // Otherwise an empty `QQBOT_IDS=` would read as "unset" and let an old
  // allowlist entry silently become a *blocked* id under blocklist mode.
  const useLegacy = legacyAllowlist !== undefined && modeRaw === undefined && idsRaw === undefined;

  // 默认 **fail closed**：没写 `QQBOT_ACCESS_MODE` 时按 allowlist 走，而空名单 = 谁都不回。
  // README 与 .env.example 一直是这么写的，代码原先却默认 `open`（谁都能跟她说话）——
  // 2026-10-08 开源前审计把这条不一致揪出来了，改成和文档一致。
  const accessMode = parseAccessMode(modeRaw ?? 'allowlist');

  const listRaw = idsRaw ?? (useLegacy ? legacyAllowlist : '');
  let accessIds = null;
  if (listRaw.trim() !== '' && listRaw.trim() !== '*') {
    const entries = listRaw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 0) accessIds = new Set(entries);
  }

  let config = null;
  // 两只机器人的"身份"从这里定:情绪谱 + 身体口径(必须同一只,见 parseBodyTheme)。
  const moodTheme = parseMoodTheme(raw('QQBOT_MOOD_THEME'));
  const bodyTheme = parseBodyTheme(raw('QQBOT_BODY_THEME'), moodTheme);
  try {
    config = {
      // Local display content is separate from runtime policy.
      lockFile,
      legacyStateFile,
      qq: {
        appId: appId ?? '',
        clientSecret: clientSecret ?? '',
        apiBase: (raw('QQ_API_BASE') ?? DEFAULTS.apiBase).replace(/\/+$/, ''),
        intents: asInt('QQBOT_INTENTS', DEFAULTS.intents),
        sandbox: asBool('QQBOT_SANDBOX', false),
        // Group-scoped openids that mean "this bot". A group mention carries the
        // bot's *group* openid, which never equals the global id from READY
        // (D09), so without this list an @ of the bot can only be recognised
        // through the `bot` flag — which answers to another bot when the group
        // has two. Comma-separated; empty disables the extra matching.
        selfGroupIds: (raw('QQBOT_SELF_GROUP_IDS') ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      },
      dsh: buildDshConfig(defaultWorkspaceFor(rootDir), rootDir),
      engine: buildEngineConfig(),
      /**
       * **代码层发美图**(2026-10-23):「发N张<角色>美图」—— 整条链路不经过模型。
       *
       * 字段:
       *   · `enabled`    总开关(默认 **false**:没配的机器人/群不会突然开始发图);
       *   · `groups`     群白名单(**空 = 谁都不给**,fail closed);群 openid 逗号分隔;
       *   · `max`        一次最多几张(超出夹到它);
       *   · `cooldownMs` 同群两条指令的最小间隔(在**开始**时记时间);
       *   · `proxy`      抓 Danbooru 用的本机代理(注入 NODE_USE_ENV_PROXY/HTTPS_PROXY);
       *   · `root`       落盘根目录(按角色名建子目录;D 盘,不进 C 盘);
       *   · `alias`      别名表(角色名 → 图源 tag);
       *   · `lines`      固定句库覆盖文件(按 key 合并进内置默认表;缺失=用默认);
       *   · `source`     auto / danbooru / safebooru;
       *   · `maxBytes`   单张上限;
       *   · `timeoutMs`  抓取子进程硬超时;
       *   · `db`         元数据库(`data\<bot>\meitu.db`;展览处刀 1 / D306,可删库重灌);
       *   · `thumbs`     两档缩略图缓存根(`data\meitu\`,里面 `thumbs\` + `thumbs-128\`);
       *   · `gallery`    展览处只读 API 总闸(**QQBOT_GALLERY=0 → 三条路由 503**,刀 2 回滚用)。
       *
       * ⚠️ **数字全是【暂定】**(2026-10-23),主人可调;改 env 不改代码。
       */
      meitu: (() => {
        const source = parseMeituSource(raw('QQBOT_MEITU_SOURCE') ?? 'auto');
        return {
          enabled: asBool('QQBOT_MEITU', false),
          groups: (raw('QQBOT_MEITU_GROUPS') ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          max: asInt('QQBOT_MEITU_MAX', 5), // 【暂定】
          cooldownMs: asNonNegativeInt('QQBOT_MEITU_COOLDOWN_MS', 30_000), // 【暂定】
          // 按群去重(2026-10-28 主人拍板):同群不重发,不同群可复用库里的同一份文件。
          // 默认开;`QQBOT_MEITU_PER_GROUP=0` 回退旧的全库口径(收过就不再给任何群)。
          perGroup: raw('QQBOT_MEITU_PER_GROUP') !== '0',
          proxy: raw('QQBOT_MEITU_PROXY') ?? '',
          root: path.resolve(rootDir, raw('QQBOT_MEITU_ROOT') ?? 'data/meitu-images'),
          alias: path.resolve(rootDir, raw('QQBOT_MEITU_ALIAS') ?? 'data/meitu-alias.json'),
          lines: path.resolve(rootDir, raw('QQBOT_MEITU_LINES') ?? 'data/meitu-lines.json'),
          source,
          maxBytes: asInt('QQBOT_MEITU_MAX_BYTES', 10_485_760), // 【暂定】10MB
          timeoutMs: asInt('QQBOT_MEITU_TIMEOUT_MS', 90_000), // 【暂定】90s
          // 元数据库:显式 env 优先,否则跟**本实例状态库同级**(aris → data\aris\meitu.db)。
          db: (() => {
            const explicit = raw('QQBOT_MEITU_DB');
            if (explicit) return path.resolve(rootDir, explicit);
            const stateDb = raw('QQBOT_STATE_DB');
            if (stateDb) return meituDbPathFromStateDb(path.resolve(rootDir, stateDb));
            return path.join(rootDir, 'data', 'meitu.db');
          })(),
          thumbs: path.resolve(rootDir, raw('QQBOT_MEITU_THUMBS') ?? 'data/meitu'),
          gallery: asBool('QQBOT_GALLERY', true),
        };
      })(),
      policy: {
        // 主题在 policy 之外先算一次:身体口径要**跟情绪谱对齐**(见 parseBodyTheme),
        // 两个都由 QQBOT_MOOD_THEME 决定,只是身体那项可以显式写出来做二次确认。
        access: { mode: accessMode, ids: accessIds },
        // The model has no idea which conversation it is in, so the scene tag
        // is the only thing telling a group reply from a private one.
        promptContext: asBool('QQBOT_PROMPT_CONTEXT', true),
        // Bound per message: each retained image costs provider vision tokens.
        maxImages: asInt('QQBOT_MAX_IMAGES', 3),
        group: {
          // mention — reply only when addressed (buffered context still used)
          // auto    — may also speak up on its own, subject to the gates below
          mode: (raw('QQBOT_GROUP_MODE') ?? 'mention').toLowerCase(),
          contextSize: asInt('QQBOT_GROUP_CONTEXT', 15),
          // How long a buffered message stays eligible as context. In a quiet
          // group messages may be half an hour apart, and a short window would
          // leave the bot with no idea what was being discussed.
          contextMinutes: asInt('QQBOT_GROUP_CONTEXT_MINUTES', 10),
          // Wait for the group to fall quiet before speaking up, so a burst of
          // chatter becomes one reply instead of several.
          debounceMs: asInt('QQBOT_GROUP_DEBOUNCE_MS', 6000),
          // Self-initiated replies cannot use a passive reply, so they are
          // charged against the active-message quota (20/qpm per group).
          // This is the *unsolicited* gap; being talked to uses the engaged one.
          cooldownMs: asInt('QQBOT_GROUP_COOLDOWN_MS', 120_000),
          // Gap while someone is actually talking to the bot. Two minutes here
          // would kill the conversation after a single exchange.
          engagedCooldownMs: asInt('QQBOT_GROUP_ENGAGED_COOLDOWN_MS', 15_000),
          minMessages: asInt('QQBOT_GROUP_MIN_MESSAGES', 2),
          // After the bot speaks, this long counts as "still in the conversation":
          // follow-ups containing 你/妳/您/汝 are treated as aimed at it even
          // without the character's name. Every reply refreshes the window.
          windowMs: asInt('QQBOT_GROUP_WINDOW_MS', 90_000),
          addressMarkers: (raw('QQBOT_GROUP_ADDRESS_MARKERS') ?? '你,妳,您,汝')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          // A message naming the character is a direct signal, so it skips the
          // debounce and the message-count gate (the cooldown still applies).
          keywords: parseKeywords(raw('QQBOT_GROUP_KEYWORDS')),
          // 「像人在打字」的抖动(D53):被叫到名字时不再**秒回**,而是等一小会儿。
          //
          // 起因是实测:同一个群里两只机器人 + 群友互相提到名字时,两边都在**几秒内**
          // 回话,于是看起来像"左脚踩右脚聊了一大堆"。真人打字要时间 —— 而且这两只
          // Local display content is separate from runtime policy.
          // 形如 `9000-20000`(毫秒);`off` = 保持旧的秒回行为。
          keywordJitterMs: parseJitterRange(raw('QQBOT_KEYWORD_JITTER_MS')),
          // 「别的机器人发的消息」要不要当成**背景噪音**(D54,默认**要**)。
          //
          // 关掉的后果实测过:同一个群里两只机器人互相看得见对方的话 ——
          // A 说一句,重排 B 的防抖;那句里再带上对方名字,B 立刻回;
          // 于是 30~60 秒一轮、彼此续话题,看起来就是"左脚踩右脚聊了一大堆"。
          // 打开 = 机器人发的消息**不计入条数、不重排防抖、不刷新对话窗口、也不算点名**;
          // 想留作玩法(让它们互相逗)就设 false。
          ignoreBots: asBool('QQBOT_GROUP_IGNORE_BOTS', true),
          // 平台**不告诉我们**有些"机器人"是机器人(D54 实测):晴天/晴月这类
          // 第三方框架或**个人号**机器人,在 mention entry 里是 `bot:false` +
          // Local display content is separate from runtime policy.
          //
          // ⚠️ 两只机器人看到的 openid **不同**(D09),所以这份名单要**各自配**。
          // ⚠️ 列错了就是把一个**真人**也按机器处理(她说话两只都不理),所以默认空。
          ignoreIds: new Set(
            (raw('QQBOT_GROUP_IGNORE_IDS') ?? '')
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
          // 「读空气」:别人还在连着说话时**别插话**(2026-09-30,D72)。
          //
          // 起因是用户最早的抱怨「自顾自地说话并且**打断正常聊天**」,而实测坐实了它:
          // Local display content is separate from runtime policy.
          // Local display content is separate from runtime policy.
          //
          // 默认值取真人基准线的 **P75 相邻消息间隔 = 26 秒**:超过四分之一的相邻间隔比它长,
          // 所以以它为界能把"还在聊"和"这串断了"分开。**要改先重跑 `rhythm-report.js`。**
          // 0 = 关掉这道闸(回到"防抖完就开口"的旧行为)。
          gapMs: asNonNegativeInt('QQBOT_GROUP_GAP_MS', DEFAULT_STRAND_GAP_MS),
          gapMaxWaitMs: asInt('QQBOT_GROUP_GAP_MAX_WAIT_MS', 300_000),
        // **自发重查的上限**(D90):同群两次"串似乎断了,再看一眼"之间至少隔这么久。
        // ⚠️ 只管**没人点名时**的自发重查;被 @ / 关键词 / 戳一戳不受影响。
        // 0 = 关掉上限(回到"串看着断了就再排一次"的老行为)。
        recheckMs: asNonNegativeInt('QQBOT_RECHECK_MINUTES', 10) * 60_000,
        },
        warmup: {
          // Off by default: this is the only clock-driven model call in the
          // bridge, so it is opt-in rather than something a restart silently starts.
          enabled: asBool('QQBOT_WARMUP', false),
          // `interval` = the original "every N minutes" schedule.
          // `random`   = slot-based, probabilistic, unpredictable timing (D21).
          mode: parseWarmupMode(raw('QQBOT_WARMUP_MODE')),
          // interval mode: gap between warm-ups for one group.
          intervalMs: asInt('QQBOT_WARMUP_INTERVAL_MS', 3_600_000),
          // random mode: length of a scheduling slot. Slots are aligned to local
          // midnight, so 2 hours puts the boundaries on even local hours.
          slotMs: (() => {
            const slotMs = asInt('QQBOT_WARMUP_SLOT_MS', 7_200_000);
            if (slotMs < 300_000 || slotMs > 43_200_000) {
              throw new Error(`QQBOT_WARMUP_SLOT_MS 必须在 5 分钟到 12 小时之间，收到 ${slotMs}`);
            }
            return slotMs;
          })(),
          // random mode: how often a slot actually produces a warm-up.
          chance: asRatio('QQBOT_WARMUP_CHANCE', 0.5),
          // random mode: floor for the "nobody answered" halving, so a group
          // where nobody ever replies goes quiet without going silent forever.
          minChance: asRatio('QQBOT_WARMUP_MIN_CHANCE', 0.1),
          // random mode: a group message this soon after a warm-up counts as an
          // answer to it, which resets the decay.
          engageWindowMs: asInt('QQBOT_WARMUP_ENGAGE_WINDOW_MS', 600_000),
          // Both modes: never warm a group this soon after the bot spoke in it.
          // Two bot messages back to back read as a glitch — this is what keeps
          // a warm-up from landing on top of the daily greeting (§6.2 #1).
          gapMs: asNonNegativeInt('QQBOT_WARMUP_GAP_MS', 1_800_000),
          // Local wall-clock hours when the bot keeps quiet, `HH:MM-HH:MM`.
          // Empty disables the sleep window entirely.
          sleep: parseSleepWindow(raw('QQBOT_WARMUP_SLEEP')),
          // Only warm a group that has actually gone quiet; interrupting an
          // active chat is both pointless and annoying.
          quietMs: asInt('QQBOT_WARMUP_QUIET_MS', 300_000),
          // Local hours when food talk is allowed, `H-H,H-H`. Empty removes the
          // restriction; unset keeps the defaults.
          mealWindows: raw('QQBOT_WARMUP_MEAL_HOURS') === undefined
            ? DEFAULT_MEAL_WINDOWS
            : (activeParams ? activeParams.values.QQBOT_WARMUP_MEAL_HOURS : parseMealWindows(raw('QQBOT_WARMUP_MEAL_HOURS'))),
          // How often to check whether any group is due. Also the granularity of
          // a random plan, so a shorter tick makes the timing look less rounded.
          tickMs: asInt('QQBOT_WARMUP_TICK_MS', 30_000),
        },
        morning: {
          // Local `HH:MM`. Empty disables the greeting.
          time: parseMorningTime(raw('QQBOT_MORNING') ?? ''),
          // Private-chat target: the user_openid of the person to greet.
          c2cTarget: raw('QQBOT_MORNING_C2C') ?? '',
          // How late a greeting may still be sent. Without this, a bridge that
          // happened to be starting up at the appointed minute would skip a day.
          graceMs: asInt('QQBOT_MORNING_GRACE_MS', 3_600_000),
        },
        // 「她自己的生活在转」(D99 阶段 2,用户 2026-10-02 要的):
        // 静默够久 + 饿了 → 去吃饭(真花钱、真涨饱食)**并报备**;不饿时偶尔冒个泡。
        // ⚠️ 它和暖群**共用那套主动消息配额** —— 用户选的是"由它接替暖群"
        //    (`bots\demo\.env` 里把 `QQBOT_WARMUP` 关掉),回退就把暖群开回来。
        selfcare: {
          // ⚠️ **默认改成 false**(2026-10-03):原来默认 `true`,于是**没写这一行的机器人**
  // Local display content is separate from runtime policy.
  //    报备自己吃了什么,群里看到的就是"一大堆莫名其妙的话"(实测凌晨 22 条自发消息)。
  //    "她有自己的生活"是**角色设定**,不是平台功能:要开就**显式**在 `.env` 里开
  // Local display content is separate from runtime policy.
  enabled: asBool('QQBOT_SELFCARE', false),
          // 别人刚说过话就不算"没人互动"。
          quietMs: asInt('QQBOT_SELFCARE_QUIET_MS', 40 * 60_000),
          // 饱食低于此值 → 自己去吃饭。这是**行动**门槛(与 DECAY.starvingBelow 那个分开)。
          hungryBelow: asInt('QQBOT_SELFCARE_HUNGRY', 25),
          // 两条主动消息之间的配额闸门。
          gapMs: asInt('QQBOT_SELFCARE_GAP_MS', 45 * 60_000),
          // 不饿那一档("她在忙什么")的最短间隔与命中概率。
          lifeEveryMs: asInt('QQBOT_SELFCARE_LIFE_EVERY_MS', 3 * 60 * 60_000),
          lifeChance: asRatio('QQBOT_SELFCARE_LIFE_CHANCE', 0.5),
          // 报备发去哪:**私聊操作者 + 已知群**(用户选 A),措辞按场合分。
          c2cTarget: raw('QQBOT_SELFCARE_C2C') ?? raw('QQBOT_MORNING_C2C') ?? '',
          // ⚠️ **1.106.0(D172):生活那一档的"自发发言"发去哪** ——
          //    `group`(默认)= 已知安静群优先、没有就回落私聊;
          //    `c2c` = 回到 1.105.x 的老行为(所有主动消息都走私聊)。
          //    用户 2026-10-10 的原话是「接上**私聊报备/群聊自发发言**」,所以默认按这条分工走。
          lifeTo: raw('QQBOT_SELFCARE_LIFE_TO')?.trim().toLowerCase() === 'c2c' ? 'c2c' : 'group',
          // ⚠️ **1.106.1(D173):把"她自己的自言自语"钉在哪个群** —— 群 openid,留空 = 自动挑。
          //    有两条用处:① 用户 2026-10-10 要的"在那个(只有机器人的)测试群里测";
          //    ② 自动挑的规则是"最近还活跃过的安静群优先",而他可能就是想固定一个群。
          //    ⚠️ 指定的这个群**不需要**在 `knownGroups()` 里(`knownGroups()` 只认
          //    "本次进程收到过消息"的群,重启就重置 —— 纯机器人的测试群可能永远不满足)。
          //    ⚠️ 它正热闹时**不硬插**(`quietMs` 一样管它),那时照旧自动挑。
          group: raw('QQBOT_SELFCARE_GROUP') ?? '',
        },
        // Local display content is separate from runtime policy.
        // Local display content is separate from runtime policy.
        announce: {
          enabled: asBool('QQBOT_ANNOUNCE', false),
          mode: parseAnnounceMode(raw('QQBOT_ANNOUNCE_MODE')),
          targets: parseAnnounceTargets(raw('QQBOT_ANNOUNCE_TARGETS')),
          c2cTarget: raw('QQBOT_ANNOUNCE_C2C') ?? '',
          // 自动 = 启动时 + 每个 tick(受睡眠与去重闸门);manual = 只认 `/更新`。
          // "什么时候发由我说了算"就是 manual。
          trigger: parseAnnounceTrigger(raw('QQBOT_ANNOUNCE_TRIGGER')),
        },
        // 谁能打控制指令(播报等)。留空 = 回落到播报/早安的私聊目标;
        // 三者都没有 = 谁都不能(fail closed)。
        admin: {
          ids: (() => {
            const list = (raw('QQBOT_ADMIN_IDS') ?? '')
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean);
            return list.length > 0 ? new Set(list) : null;
          })(),
        },
        // 报数值时去读**别的实例**的状态库(只读)。留空 = 读自己的。
        reportStatsDb: raw('QQBOT_REPORT_STATS_DB')
          ? path.resolve(rootDir, raw('QQBOT_REPORT_STATS_DB'))
          : null,
        // **报数目标口径**(2026-10-28 / P4):报数那只读的是**别人的库**,
        // 播报里的名字与身体措辞必须跟着**目标**走,不能跟着报数者自己。
        // Local display content is separate from runtime policy.
        reportTargetName: raw('QQBOT_REPORT_TARGET_NAME') ?? LOCAL_MOOD_BODY_CONTENT?.config.reportTargetName ?? '示例助手',
        reportTargetTheme: raw('QQBOT_REPORT_TARGET_THEME') ?? 'megumin',
        // Local display content is separate from runtime policy.
        stats: {
          enabled: asBool('QQBOT_STATS', true),
          // 回复末尾那一行状态增量(`[魔力+45 体力+5]`,D87)。用户要的:
          // "每次都 @ /状态 有点繁琐" → 让回复自己带涨跌。
          deltaLine: asBool('QQBOT_STAT_DELTA_LINE', true),
          // 身体口径(megumin = 饱食/健康/心情;aris = 电量/机能/温度)。
          theme: bodyTheme,
          // Local display content is separate from runtime policy.
          // 没有货币概念的实例(机械体)整行不给,否则会照着"手头不紧,别装穷"演。
          // 默认开 = 旧行为不变;`QQBOT_STATS_MONEY=0` 关掉这行。
          money: asBool('QQBOT_STATS_MONEY', true),
          // **会不会生病**(P4,2026-10-28):病程是"人类身体"的玩法;机械体实例置 0 关掉
          // (含随机生病/坏食物/委托劳累),不写"机械体得感冒"这种串味。默认开 = 旧行为不变。
          illness: asBool('QQBOT_STATS_ILLNESS', true),
          // SQLite 状态库。旧的 .qqbot-state.json 会在首次启动时自动导入(不删)。
          dbFile: raw('QQBOT_STATE_DB')
            ? path.resolve(rootDir, raw('QQBOT_STATE_DB'))
            : path.join(rootDir, '.qqbot.db'),
        },
        // **严肃话题收敛**(D80):重病 / 去世 / 灾难(911、大地震)这类场合,        // 关掉"每轮花活"(随机风格提示 + 情绪调味),并交代一句态度 ——
        // 具体怎么说仍由角色卡决定(用户 2026-10-01 要的是"按角色设定判断")。
        seriousGuard: asBool('QQBOT_SERIOUS_GUARD', true),
        // **公共工具执行链**(P3,2026-10-28):让模型能调 web_search/web_fetch 这类只读能力。
        // ⚠️ **默认全关** —— 关 = 行为一字不变(判据钉着);开 = 三样全齐才真的发工具:
        //   ① `QQBOT_TOOLS=1`(实例总闸);
        //   ② `QQBOT_TOOLS_MODEL_FN=1`(**主人已验证**当前模型支持 function tools ——
        //      没验证过就是 unknown,不许赌,与能力基线 `functionToolsSupport` 同一口径);
        //   ③ `QQBOT_TOOLS_ALLOW=web_search,web_fetch`(实例授权清单,fail closed,空=一个不给)。
        // `QQBOT_TOOLS_MAX_ROUNDS`【暂定】= 工具循环预算(一轮里最多几次"调工具→回结果");
        // 耗尽给显式"没能完成",不拿中间文本装答案。
        // 搜索凭据:显式配 `QQBOT_SEARCH_BASEURL`/`QQBOT_SEARCH_KEY`(可填与模型同一个值,
        // 但**必须显式写**——搜索凭据是自己的配置项,不许从模型客户端顺手拿)。不配 = 不注册搜索能力。
        tools: {
          enabled: asBool('QQBOT_TOOLS', false),
          modelFunctionTools: asBool('QQBOT_TOOLS_MODEL_FN', false),
          allow: (raw('QQBOT_TOOLS_ALLOW') ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          maxRounds: asNonNegativeInt('QQBOT_TOOLS_MAX_ROUNDS', 3),
          // **搜索凭据**(2026-10-28 主人拍板:**与 bot 模型同一份 key**)—— 缺省回落 bot slot,
          // env 显式配置仍可覆盖(比如以后给搜索单开 key)。
          searchBaseUrl: raw('QQBOT_SEARCH_BASEURL') ?? '',
          searchKey: raw('QQBOT_SEARCH_KEY') ?? '',
          searchTimeoutMs: asNonNegativeInt('QQBOT_SEARCH_TIMEOUT_SECONDS', 20) * 1000,
          // **日额度闸**(2026-10-28 主人拍板:**1¥/日**)—— 只记成功调用(官方失败不计费,
          // 闸门口径与账单口径一致);按本地自然日重置;state.db meta 记账,重启累计不丢。
          searchDailyLimitCny: asNonNegativeInt('QQBOT_SEARCH_DAILY_LIMIT_CNY', 1),
          // 每次成功调用估算成本(¥)【暂定换算】:官方 $0.75/1000 次成功请求,
          // 按 7.2 汇率 ≈ ¥0.0054/次。主人拍板的是"1¥/日"这道闸,这个换算系数只是刻度,可调。
          searchPerCallCny: (() => {
            const value = Number(raw('QQBOT_SEARCH_PER_CALL_CNY'));
            return Number.isFinite(value) && value > 0 ? value : 0.0054;
          })(),
          // **web_fetch 域名白名单**(2026-10-28 主人拍板"按推荐来"):留空 = 公网可抓
          // (私网/本机/元数据地址永远硬挡,不可配置放开);配了 = 只许这些域(含子域)。
          webFetchAllow: (raw('QQBOT_WEBFETCH_ALLOW') ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
        // Local display content is separate from runtime policy.
        // Local display content is separate from runtime policy.
        // ⚠️ 这道题**故意让模型随便编**(当量、炸到哪、损失),所以旁白不进任何库。
        narration: {
          enabled: asBool('QQBOT_NARRATION', false),
          cooldownMs: asNonNegativeInt('QQBOT_NARRATION_COOLDOWN_SECONDS', 20) * 1000,
          timeoutMs: asNonNegativeInt('QQBOT_NARRATION_TIMEOUT_SECONDS', 45) * 1000,
        },
        // Local display content is separate from runtime policy.
        // Local display content is separate from runtime policy.
        // Local display content is separate from runtime policy.
        explosion: {
          enabled: asBool('QQBOT_EXPLOSION', false),
          cooldownMs: asNonNegativeInt('QQBOT_EXPLOSION_COOLDOWN_SECONDS', 90) * 1000,
          // **每一句之间**的间隔(毫秒)。用户 2026-10-01 要的"分别间隔一秒发送"。
          delayMs: asNonNegativeInt('QQBOT_EXPLOSION_DELAY_MS', 1000),
          // 咏唱分几句(节拍)。⚠️ 被动回复上限 5 条、最后一条留给结束词 → 咏唱最多 4 句。
          beatsMax: asNonNegativeInt('QQBOT_EXPLOSION_BEATS_MAX', 4),
        },
        // **普通发言拟人化**(1.171.0 / D288):所有"普通角色发言"(答话 / 合并 / 早安 / 自发 /
        // 生活报备 / 网页聊天)统一过 `planSpokenLines()` 分条 + 口语标点清理 + 段间自然间隔。
        // ⚠️ 数值全部【暂定】(2026-10-21):上线后按真实回复样本调;`enabled` 就是回滚开关。
        spoken: {
          // 总开关:`QQBOT_SPOKEN_SPLIT=0` → 回到旧行为(只有主动发言分条,答话整条)。
          enabled: asBool('QQBOT_SPOKEN_SPLIT', true),
          // 没有情绪决策(mood)时的**每段字数上限**;有决策时用决策里的 `maxChars`。
          maxChars: asNonNegativeInt('QQBOT_SPOKEN_MAX_CHARS', 60),
          // 段间等待 = baseDelayMs + **待发那条**字数 × perCharDelayMs,再 ±15% 抖动,
          // 夹在 [minDelayMs, maxDelayMs]。首条不等待(首响口径不变)。
          baseDelayMs: asNonNegativeInt('QQBOT_SPOKEN_BASE_DELAY_MS', 500),
          perCharDelayMs: asNonNegativeInt('QQBOT_SPOKEN_PER_CHAR_MS', 40),
          minDelayMs: asNonNegativeInt('QQBOT_SPOKEN_MIN_DELAY_MS', 400),
          maxDelayMs: asNonNegativeInt('QQBOT_SPOKEN_MAX_DELAY_MS', 4000),
          // **emoji 单发概率**(每轮一次掷骰;1.171.2 / D290,用户拍板走代码档):
          // 命中就在段间插一条 emoji 单发。0 = 关。【暂定】
          emojiChance: asRatio('QQBOT_SPOKEN_EMOJI_CHANCE', 0.12),
        },
        // 记忆(D39)。**这是"重启不失忆"的关键**:`dsh` 不能恢复既有会话,
        // 每代新会话都从零开始,所以记忆必须由 bridge 自己带上。
        memory: {          enabled: asBool('QQBOT_MEMORY', true),
          // 记忆库。留空 = **跟状态库放同一目录**(`data\<bot>\memory.db`)——
          // 这样它自动跟着每只机器人的目录走,不用再多一项要记得改的配置。
          dbFile: null, // 见下面 resolveMemoryDb
          // 交接文本的字数预算。它进的是"每代会话的第一轮",不是每轮,所以别贪。
          budget: asInt('QQBOT_MEMORY_BUDGET', 1400),
          // 交接里保留"原文"的最近轮数(更早的压缩成一行一轮)。
          recent: asInt('QQBOT_MEMORY_RECENT', 10),
          // 分层记忆 v1(D75):**每轮**拼一小块的长期层。
          //
          // ⚠️ **预算刻意另算,不从上面那 1400 里抢**:交接的 1400 字实测已经顶满(1399),
          // 从那里面挪就等于少带一段最近的原文。两层各管一件事,各花各的预算(判据 3)。
          // 它只在"这句话与某条记忆有标签交集"时才花 token —— 覆盖率约三成,
          // 命不中的轮次一个字都不注入(判据 1)。
          longTerm: {
            enabled: asBool('QQBOT_MEMORY_LONGTERM', true),
            // 300 字 ≈ 150 token/轮,而且只有命中的轮次才花。
            budget: asInt('QQBOT_MEMORY_LONGTERM_BUDGET', 300),
            // 最多挑几条。**故意的下限**:宁可少说,也别把不相干的当"回忆"(v0 决定二)。
            limit: asInt('QQBOT_MEMORY_LONGTERM_LIMIT', 3),
          },
          // **补归档的拍子**(2026-10-01,D77)。
          //
          // 归档原来只在**启动时**跑一次,而 `dsh` 是把每一轮连续写在会话文件里的 ——
          // 于是一段跑了一整天的会话,当天说的话**根本没进 memory.db**,
          // 长期层(每轮检索)只能看到"上次重启之前"的内容(实测:手动跑之前快照是 872 分钟前的)。
          // 所以"每天分几次回头看看"这件事的前置,就是**定期把新轮次收进来**。
          // 默认 15 分钟;0 = 关掉(回到"只在启动/手动归档")。
          archiveEveryMs: asNonNegativeInt('QQBOT_MEMORY_ARCHIVE_MINUTES', 15) * 60_000,
          // **"回头"那一拍**(2026-10-01,D78):把最近轮次按代码算的分过一遍,
          // 够分的固化成中期/长期记忆。默认 6 小时 = 每天 4 次(用户说的"每天分几次")。
          consolidateEveryMs: asNonNegativeInt('QQBOT_MEMORY_CONSOLIDATE_MINUTES', 360) * 60_000,
          // 中期记忆的寿命(天):过了就不再注入(**不删** —— 它还留着,只是不再占用预算)。
          // 参考真人:情景记忆能撑几天,之后就靠"巩固"变成语义记忆(长期)。
          noteTtlMs: asInt('QQBOT_MEMORY_NOTE_TTL_DAYS', 3) * 24 * 3600 * 1000,
          // "回头"最多往回看多久(天)—— 第一次跑时别把全库翻一遍。
          consolidateWindowMs: asInt('QQBOT_MEMORY_CONSOLIDATE_WINDOW_DAYS', 3) * 24 * 3600 * 1000,
          // **软失效的读时过滤**(P1-C,2026-10-19,见 docs\03 D263):旧的"说法"不再冒充现状。
          //
          // 它**同时管两处读路径**:每轮注入的"关于人的事实"(state.db 的 fact)与
          // 固化记忆(note 里的长期/中期) —— 所以放在 memory 这一层,不塞进 longTerm 子块
          // (那两个是两种不同的存储,但同一条"只端最新说法"的纪律)。
          // 冲突是**规则版**:同 subject+kind 且新值不同 → 旧行 `invalid_at`(只软标记,不物理删)。
          // ⚠️ 规则一定会误伤(「我感冒了」可能被后来的「我胃不好」顶掉) —— 所以留这个旋钮:
          //    `QQBOT_MEMORY_LATEST_ONLY=0` = 不过滤、行为回到 P1-B(旧说法照旧端出来),
          //    **数据一条不丢**(失效行只是不再注入,仍可审计;这是本块的回滚开关)。
          latestOnly: asBool('QQBOT_MEMORY_LATEST_ONLY', true),
          // **实体共现 boost**(P1-F,2026-10-19,方案 §5):query 里出现"认识的人/学会的概念"
          // 的名字时,mention 过这些名字的轮次在检索里加分(权重 <1,盖不过标签命中)。
          // ⚠️ `boost` 是【暂定 0.3】(与语义权重同量级),上线后按固定集 v2 的实体分组
          //    recall 与 sweep 现量再定稿(数字他定);`QQBOT_MEMORY_ENTITY=0` = 整块关掉,
          //    行为一字不变回到 P1-E(这是本块的回滚开关)。
          entity: {
            enabled: asBool('QQBOT_MEMORY_ENTITY', true),
            boost: asRatio('QQBOT_MEMORY_ENTITY_BOOST', 0.3),
          },
          // **常驻记忆块**(P1-E,2026-10-19,方案 §4):身份/关系/约定这类"必须永远在场"的事,
          // 每代首轮必含 XML(挂交接层,不经过检索);后台生成挂摘要拍、**≈1 次/天**(20h 限频),
          // 失败保留旧值;旧值进 history 可回滚。`QQBOT_MEMORY_BLOCKS=0` = 注入与生成全关(回滚开关)。
          blocks: {
            enabled: asBool('QQBOT_MEMORY_BLOCKS', true),
            // 每块字数上限(方案 §4 定稿 200)。
            limitChars: asNonNegativeInt('QQBOT_MEMORY_BLOCKS_CHARS', 200),
            // 生成限频:距上次不足这个间隔就跳过(默认 20h ≈ 每天 1 次,成本现算见 D266)。
            everyMs: asNonNegativeInt('QQBOT_MEMORY_BLOCKS_HOURS', 20) * 3600_000,
            timeoutMs: asNonNegativeInt('QQBOT_MEMORY_BLOCKS_TIMEOUT_SECONDS', 45) * 1000,
          },
          // **记忆洞察**(P2-A,2026-10-22,方案 §4.4 / D250 定稿 #6):跨多条固化记忆的
          // "模式总结"(如「他最近常熬夜」),不是复述任何一条 —— 复述是检索的活。
          // 生成挂摘要拍之后、走 summarizer 同一条子会话线(绝不在交接/对话路径上调模型,D91);
          // 只增不改(追加式,旧洞察留着可审计);注入 = 最新 ≤3 条独立小块,预算独立
          // (maxPerRun × limitChars = 360 字),过 wrapInject('insight') 自报家门(D177)。
          // `QQBOT_MEMORY_INSIGHTS=0` = 注入与生成全关,行为一字不变(回滚开关)。
          insights: {
            enabled: asBool('QQBOT_MEMORY_INSIGHTS', true),
            // 生成限频:距上一条洞察不足这个间隔就不生成(默认 20h ≈ 1 次/天,D250 #6)。
            everyMs: asNonNegativeInt('QQBOT_MEMORY_INSIGHTS_EVERY_HOURS', 20) * 3600_000,
            // 输入 = 最近多少条固化笔记(方案定稿 30)。
            inputNotes: asNonNegativeInt('QQBOT_MEMORY_INSIGHTS_INPUT_NOTES', 30),
            // 一次最多写几条(方案定稿 ≤3)。
            maxPerRun: asNonNegativeInt('QQBOT_MEMORY_INSIGHTS_MAX_PER_RUN', 3),
            // 每条洞察的字数上限(方案定稿 ≤120)。
            limitChars: asNonNegativeInt('QQBOT_MEMORY_INSIGHTS_CHARS', 120),
            timeoutMs: asNonNegativeInt('QQBOT_MEMORY_INSIGHTS_TIMEOUT_SECONDS', 45) * 1000,
          },
          // **滚动摘要**(2026-10-02,D91,分层记忆第三层):把"很久以前"压成几百字,
          // 接在交接里(它**换掉**更早那一截,不是外加 —— 那 1400 字的预算早就顶满了)。
          //
          // ⚠️ **它不在交接路径上算**:交接是 `runTurn` 内部 await 的,模型调用也是同一个 runner,
          //    在那儿再发请求就是同一个子进程套第二个请求(死锁)。所以重算挂在"补归档"那一拍上,
          //    交接只读**已经缓存好的**那份 —— 慢了也没关系,这一代先用旧的。
          summary: {
            enabled: asBool('QQBOT_MEMORY_SUMMARY', true),
            // 摘要目标长度(字)。⚠️ 是**行为预算**:太长她就容易"背摘要"。
            target: asInt('QQBOT_MEMORY_SUMMARY_CHARS', 400),
            // 交接里分给摘要的预算(字)。与"最近几轮"分开算。
            budget: asInt('QQBOT_MEMORY_SUMMARY_BUDGET', 480),
            // 一次模型调用的超时。摘要是后台活,超时就下次再来,不阻塞任何对话。
            timeoutMs: asNonNegativeInt('QQBOT_MEMORY_SUMMARY_TIMEOUT_SECONDS', 45) * 1000,
            // **最小重算间隔(分钟)**(2026-10-06,D135)。默认 3 小时。
            // ⚠️ 为什么必须有它:"攒够 N 轮新记录"那条判据实测**恒为真**(见 memory-store 的
            //    SUMMARY_MIN_INTERVAL_MS),没有这道闸就是"每 15 分钟白算一次",
            //    两只机器人 98.4% 的 token 花在这上面(实测 384 次调用/天/只)。
            //    调小 = 摘要更新更勤、更贵;调大 = 更省、梗概更旧(最近的话永远由交接给原文)。
            minIntervalMs: asNonNegativeInt('QQBOT_MEMORY_SUMMARY_MIN_INTERVAL_MINUTES', 180) * 60 * 1000,
            // **摘要子会话每 N 次调用轮换一次**(2026-10-06,D135)。默认 20 次。
            // ⚠️ 原来所有摘要共用一个固定子会话,前缀**每次调用 +2048 token**一路涨到 79 万
            //    (1M 的 78%)才被压回 —— 那一条会话就是账单的大头。摘要任务本身**无状态**
            //    (每次都把要摘的材料整份发过去),所以换代不丢信息,只是不再为旧前缀付钱。
            //    20 次 × ~2k = 前缀封顶约 4 万。
            sessionCalls: asInt('QQBOT_MEMORY_SUMMARY_SESSION_CALLS', 20),
          },
          // **向量检索**(2026-10-02,D92,第二层的 v2):让"相关度"从"对不对词"变成"对不对意思"。
          //
          // 实测依据(本机 CPU、bge-small-zh 量化):「今晚吃什么好」↔「说好了请你吃夜宵」0.773、
          // 「你最近怎么样」↔「我昨晚做得好累」0.663(字面零重合,标签层永远命不中)。
          // ⚠️ 但绝对相似度很挤(不相关的也有 0.627)——所以打分是"标签 + 权重×相似度",
          //    另用"相对幅度"当第二道闸(见 `src\memory-tags.js` 的文件头)。
          //
          // ⚠️ **默认关**:它需要一个跑在本机的 embedding 服务(见 `scripts\embed-backfill.js`),
          //    而"没有服务"这件事必须表现为"退回标签那套",不是报错。
          embedding: {
            enabled: asBool('QQBOT_MEMORY_EMBEDDING', false),
            // 本机服务地址(OpenAI 兼容的 /v1/embeddings)。**只打本机**。
            url: raw('QQBOT_MEMORY_EMBEDDING_URL') ?? '',
            // 模型名:① 拿去算查询向量;② 与库里存的向量**对齐校验**(换模型旧向量作废)。
            model: raw('QQBOT_MEMORY_EMBEDDING_MODEL') ?? '',
            // 超时要短:这一笔延迟加在**每轮**上,而它只是个"锦上添花"的维度。
            timeoutMs: asNonNegativeInt('QQBOT_MEMORY_EMBEDDING_TIMEOUT_MS', 800),
            // **增量回填**(2026-10-18,P0-3):每隔"补归档"那一拍顺手补一小批向量。
            //
            // 为什么必须有它:回填以前只有 `scripts\embed-backfill.js` **手动**跑,
            // 于是 678 条向量全是 10-02/03 的旧数据,own 时代 3,400+ 轮一条没有 ——
            // 语义通道静默失效(查询算得出来,候选里没向量)。
            // 默认开(只在 `QQBOT_MEMORY_EMBEDDING=true` 且配了本机 URL 时生效)。
            backfill: {
              enabled: asBool('QQBOT_MEMORY_EMBED_BACKFILL', true),
              // 一拍补多少条【暂定】:64 条约等于本机 bge-small 几百毫秒;
              // 漏下的下一拍接着补(按 at DESC,先补最近的)。
              limit: asInt('QQBOT_MEMORY_EMBED_BACKFILL_LIMIT', 64),
            },
          },
          // **关键词通道**(P1-A,2026-10-18):FTS5 + bigram 分词 + RRF 融合。
          //
          // 为什么要有它:标签只覆盖约 15% 的人话轮次,语义通道又会漏掉"字面精确"的查询
          // (人名、专有名词)—— 关键词通道补的就是这一块。数字见 `docs\03` D250:
          //   · 分词 = bigram(FTS5 的 trigram 要求 ≥3 字符,2 字词查不到;unicode61 不切中文);
          //   · 融合 = RRF k=1(照 Graphiti 源码;k=60 是 ES 惯例,我们候选池只有几十条);
          //   · 每路取多少 = 50。
          fts: {
            enabled: asBool('QQBOT_MEMORY_FTS', true),
            limit: asInt('QQBOT_MEMORY_FTS_LIMIT', 50),
          },
          // **知识库检索接线**(W3 / P2-B,2026-10-22):doc/doc_chunk 里"她在原作经历过"的
          // 资料(D95 建好的两张表,此前一直是空库)在 QQ 消息路上作为**独立来源块**注入 ——
          // 新 kind `kb` 进 INJECT_KINDS,预算独立 ≤300 字,**没命中一个字不加**(判据 1)。
          // 检索本体照搬 memory-store 的 makeKnowledgeProvider(D95 就位的那只,同一套
          // recallDecision:标签 + 语义 + 关键词),这里只给开关与预算。
          // ⚠️ **默认关**:知识库还没内容,默认开 = 每轮空转一遍检索;主人灌第一份文档
          // (node scripts\kb-import.js --write)时自己开。`QQBOT_MEMORY_KB=0` = 行为一字不变
          // (回滚开关,与 FTS / ENTITY / INSIGHTS 同一族)。
          kb: {
            enabled: asBool('QQBOT_MEMORY_KB', false),
            // 注入预算(字)。**独立账**,不与长期层 300 / 洞察 360 互抢(判据 3 的落点)。
            // 600 = D95 §八 用户口径「预算照长期记忆那样处理」——首版误发 300,2026-10-22
            // 灌料实测抓到:头行口径占 ~91 字,300 装不下任何 ≥210 字的块(renderKnowledge
            // 对装不下的块是 break 不是跳过→个人线平均 359 字/块三问全 0 注入;D297)。
            budgetChars: asNonNegativeInt('QQBOT_MEMORY_KB_BUDGET_CHARS', 600),
            // 一轮最多端几条(与长期层 limit=2 同档【暂定】)。
            maxChunks: asNonNegativeInt('QQBOT_MEMORY_KB_MAX_CHUNKS', 2),
            // 百科模式(D297):「细说/为什么/是什么」类问题命中知识库时,块内附约 100 字
            // 说明的措辞要求(不走聊天短句)。套在 kb.enabled 总闸里,这里给独立回滚开关。
            ency: asBool('QQBOT_MEMORY_KB_ENCY', true),
          },
          // **衰减治理两旋钮**(W1,2026-10-22;诊断见 .archify\检索衰减诊断报告-20261022.md):
          // 池增长下 top3 被"新同话题轮次 + note 通道占满"挤占,recency 是挤位主引擎。
          retrieval: {
            // note 通道一轮最多端几条(诊断:2 note 占满 top3 挤掉原文通道 ⇒ 限 1)。
            noteLimit: asInt('QQBOT_MEMORY_NOTE_LIMIT', 1),
            // recency 权重:legacy 乘在衰减项上,normalized 乘在归一化之后。
            // 0.5 起步【暂定】(诊断预演 ①+0.5 = 双 bot 同益零误伤);归零是大招,观察后再说。
            recencyWeight: asInt('QQBOT_MEMORY_RECENCY_WEIGHT_X10', 5) / 10,
          },
        },
        style: {
          // Extra names to strip as a leading `【…】` label, on top of the bot's
          // own nickname, which the gateway learns from READY.
          nameLabels: (raw('QQBOT_STRIP_NAME_LABELS') ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          // Display columns a kaomoji may still share with the line before it.
          // Past this, the kaomoji is moved onto its own line so QQ's own
          // wrapping cannot slice it in half. 0 = always on its own line.
          kaomojiBreakWidth: asNonNegativeInt('QQBOT_KAOMOJI_BREAK_WIDTH', 32),
          // How many per-turn style instructions to draw. 0 disables the feature,
          // so this one accepts zero where the other numeric settings do not.
          nudgeCount: (() => {
            const value = raw('QQBOT_STYLE_NUDGES');
            if (value === undefined) return 1;
            const parsed = Number.parseInt(value, 10);
            if (!Number.isSafeInteger(parsed) || parsed < 0) {
              throw new Error(`QQBOT_STYLE_NUDGES 必须是非负整数，收到 ${JSON.stringify(value)}`);
            }
            return parsed;
          })(),
        },
        // Small gestures aimed at the bot — a poke (double-tap on its avatar) or
        // a bare 表情. Both deserve a reaction *sometimes*: a human does not
        // answer every one. The platform does not say who a gesture was aimed at,
        // so a low rate doubles as the safety valve (see D25).
        interaction: {
          pokeEnabled: asBool('QQBOT_POKE', true),
          // A poke is a direct "I'm poking you": answered at the same level as an
          // @ (主人 2026-10-28 拍板「戳一戳跟 @ 一样高」)。每群冷却(下)仍防连戳刷屏。
          pokeChance: asRatio('QQBOT_POKE_REPLY_CHANCE', 1),
          faceEnabled: asBool('QQBOT_FACE', true),
          // A bare emoji is a much weaker signal — usually just a reaction.
          faceChance: asRatio('QQBOT_FACE_REPLY_CHANCE', 0.15),
          // While a conversation window is open a gesture is more likely aimed at
          // the bot (and a human answers a friend more readily).
          windowMultiplier: Number(raw('QQBOT_INTERACTION_WINDOW_MULTIPLIER') ?? 2) || 2,
          // At most one reaction per group in this long, whatever lands.
          cooldownMs: asNonNegativeInt('QQBOT_INTERACTION_COOLDOWN_MS', 180_000),
        },
        mood: {          // On by default, unlike warm-up: this one costs a couple of dozen
          // tokens per turn and fixes a measured problem (D22).
          enabled: asBool('QQBOT_MOOD', true),
          // How long one mood lasts. Every reply refreshes it, so an ongoing
          // conversation keeps its tone instead of flickering per message.
          ttlMs: asInt('QQBOT_MOOD_TTL_MS', 600_000),
          // Chance of a kaomoji on a turn whose mood allows one. The card's
          // "every three or four replies" is roughly this.
          kaomojiChance: asRatio('QQBOT_MOOD_KAOMOJI_CHANCE', 0.3),
          // Cut self-initiated messages down to the mood's length limit. Off =
          // the limit is only a prompt hint.
          hardTruncate: asBool('QQBOT_MOOD_HARD_TRUNCATE', true),
          // Local display content is separate from runtime policy.
          theme: moodTheme,
        },
        // 经济(D42):钱会花掉、也能赚回来。"一直说穷"不是靠提示词压住的 ——
        // 走的是 D28 治"一直说饿"的同一条路:真数值 + 有后果。
        economy: {
          enabled: asBool('QQBOT_ECONOMY', true),
          // 公会委托:她自己提("去公会看看有没有委托"是她的口头禅,这里把它变成机制)。
          tasks: asBool('QQBOT_ECONOMY_TASKS', true),
          // 随机小事件:可正可负。关掉的话只剩"被投喂/被夸"与委托两种进项。
          events: asBool('QQBOT_ECONOMY_EVENTS', true),
        },
        // 养成(经验/等级/学会的概念/认识的人)。规则在 `src/growth.js`,见 D40。
        growth: {
          enabled: asBool('QQBOT_GROWTH', true),
          // 里程碑(群里那句)发不发;普通升级永远只走私聊。四档见 GROWTH_ANNOUNCE_CHANNELS。
          announce: parseGrowthAnnounce(raw('QQBOT_GROWTH_ANNOUNCE')),
          // 升级账单的私聊对象。留空 = 回落到播报/早安的私聊目标;
          // 三者都没有 = 只发群里那句,不私聊。
          announceC2c: raw('QQBOT_GROWTH_C2C') ?? '',
          // 概念词表开关(第一次遇到某个概念 → 额外经验 + 记一行)。
          concepts: asBool('QQBOT_GROWTH_CONCEPTS', true),
        },
        // **只读面板**(D106 第②步):两个前端共用同一份状态的第一步 ——
        // 一个 HTTP + `/api/state` + 一页移动优先的静态页,**只读**(没有任何写路径)。
        //
        // ⚠️ 三条刻意的默认值:
        //   ① **默认关**:它是第二个前端,不该在谁都没要的时候自己开一个监听端口;
        //   ② **只听 127.0.0.1**:状态里有钱、有她跟谁亲 —— 默认不对外暴露
        //      (手机要用的话,自己写 `QQBOT_PANEL_HOST=0.0.0.0` 并配 token,风险自负);
        //   ③ **token 留空 = 只认本机**:填了就必须带 `?token=`(`Authorization: Bearer` 也认)。
        panel: {
          enabled: asBool('QQBOT_PANEL', false),
          host: raw('QQBOT_PANEL_HOST') ?? '127.0.0.1',
          port: asInt('QQBOT_PANEL_PORT', 8799),
          token: raw('QQBOT_PANEL_TOKEN') ?? '',
          /**
           * **六位口令码**(D119;`QQBOT_PANEL_CODE`)。
           *
           * 为什么要有它:32 位十六进制票在手机上**没法手输**(用户原话:"六位数的口令码,
           * 输入之后成功登录网站,进入即记住设备码")。六位码是给人念/给人按的。
           *
           * ⚠️ **代价必须写在代码旁边**:六位纯数字只有 100 万种,`failGate` 是它唯一的防线
           *    (错 `maxFails` 次锁 `lockMs`),所以:**别把它当密码**,只当"门禁码"。
           *    要更强的,就留着下面那个长 `token`(两者都可以用,输哪个都行)。
           * ⚠️ 留着 `token` 一起用是**故意**的:将来轮换/作废只需要换 `code`,长票还能兜底。
           */
          code: raw('QQBOT_PANEL_CODE') ?? '',
          /** 口令码允许的位数(默认 6);`token` 与 `code` 都为空 = 只认本机。 */
          codeLength: asInt('QQBOT_PANEL_CODE_LENGTH', 6),
          // 面板只读,**但状态会随时间衰减** —— 所以每次请求现算(不缓存)。
          // 这一项只是给页面自动刷新用的建议间隔(毫秒),不改服务端行为。
          refreshMs: asInt('QQBOT_PANEL_REFRESH_MS', 5000),
          /**
           * **给别人看的地址**(D111 第④步):QQ 里那句"详情看面板"要念的就是它。
           * ⚠️ 单独一项,不拿 `host:port` 拼 —— 因为从手机打开的那个地址
           *    (局域网 IP / 反代域名)和 bridge 自己监听的那个地址**根本不是一回事**。
           * 留空 = 不提这件事(提一个打不开的地址比不提更糟)。
           */
          publicUrl: raw('QQBOT_PANEL_PUBLIC_URL') ?? '',
          /**
           * **额外允许的 Host 头**(逗号分隔;D113)。
           *
           * 面板默认只认 `127.0.0.1/localhost` —— 那是防 **DNS rebinding**
           * (浏览器里 `evil.com` 也能解析到 127.0.0.1,然后拿着"本机"的身份读面板)。
           * 但要给别人从局域网打开时,请求带的 Host 就是你用的那个地址,所以它必须**显式**列出来。
           * ⚠️ 列进来 = 承认"这个名字可以访问面板";别把公网域名随手写进来。
           */
          allowedHosts: (raw('QQBOT_PANEL_ALLOWED_HOSTS') ?? '')
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean),
        },
        /**
         * **账号系统**(网页世界"第 0 步";决策 D132)。
         *
         * 为什么默认**开着**:它自己不制造任何入口 —— 注册**要邀请码**,而邀请码只有
         * 操作者在机器上跑 `node scripts\account.js invite-new` 才会有。所以"开着"的
         * 实际含义只是"/account 这页能打开",不改任何现有行为。
         *
         * ⚠️ 三个开关各自的意思(别混):
         *   · `openRegistration` —— **不带邀请码也能注册**。默认 **false**(fail closed):
         *     面板挂在公网,忘了配就开放注册才是真事故;
         *   · `requireForActions` —— **互动要不要账号**。默认 **false**:这一版只有钓鱼
         *     这一种互动,而它是用户现在的日常玩法 —— 一上来就要求账号,等于"今天点不了钓鱼"
         *     (而且此刻一个账号都还没有)。要拧的时候把它改成 true(见 TODO 的"第 0.5 步")。
         */
        accounts: {
          enabled: asBool('QQBOT_ACCOUNTS', true),
          openRegistration: asBool('QQBOT_ACCOUNTS_OPEN', false),
          requireForActions: asBool('QQBOT_ACCOUNTS_REQUIRE_FOR_ACTIONS', false),
          /**
           * **站长名单**(D183 第二刀):逗号分隔的**账号名**,这些账号算 `staff` 档。
           *
           * ⚠️ 为什么要它:口令码那道墙撤掉之后,"站长"这个身份得有个**明确的来源**。
           *    名单为空 = **没有站长**(fail closed):本地/长票那条应急通道照旧可用,
           *    但页面上不会有人被算成 staff。
           * ⚠️ 档位的另外两档是**派生**的(见 `player-account.js` 的 `tierFor`):
           *    带邀请码进来的 = `member`;开放注册自己进来的 = `readonly`。
           */
          staff: (raw('QQBOT_ACCOUNTS_STAFF') ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
        replyTimeoutMs: asInt('QQBOT_REPLY_TIMEOUT_MS', DEFAULTS.replyTimeoutMs),
        maxChars: asInt('QQBOT_MAX_CHARS', DEFAULTS.maxChars),
        maxConcurrency: asInt('QQBOT_MAX_CONCURRENCY', DEFAULTS.maxConcurrency),
        // 「连发合并」:私聊里连着来的几条**合成一轮**(2026-09-30)。
        // 起因是实测:私聊 220 轮里 38.7% 的相邻对是"上一条 10 秒内又来一条",
        // 而她的回复延迟中位只有 1.1 秒 —— 他发三句,她三句都秒回。
        // 0 = 关掉;上限 30 秒(见 parseC2cDebounce)。规则在 `src\burst.js`。
        c2cDebounceMs: parseC2cDebounce(),
        // 「打字抖动」:模型答完之后**先停一下再发**(2026-09-30)。
        // 和 `QQBOT_KEYWORD_JITTER_MS` 是两件事:那个只管群聊"被叫到名字"那一条路,
        // 这个管**所有**回复(私聊 + 群 @)。两只机器人的区间各自写在 .env 里。
        replyJitterMs: parseJitterRange(
          raw('QQBOT_REPLY_JITTER_MS') ?? `${DEFAULT_REPLY_JITTER_RANGE.minMs}-${DEFAULT_REPLY_JITTER_RANGE.maxMs}`,
          'QQBOT_REPLY_JITTER_MS',
        ),
      },
      logLevel: raw('QQBOT_LOG_LEVEL') ?? DEFAULTS.logLevel,
      // Empty means "stderr only"; set it when the bridge runs unattended.
      // A relative path resolves against the bridge directory, not the cwd.
      logFile: raw('QQBOT_LOG_FILE') ? path.resolve(rootDir, raw('QQBOT_LOG_FILE')) : undefined,
      envFile,
      loadedEnvFile,
    };
  } catch (err) {
    problems.push(err.message);
  }

  if (problems.length > 0) {
    const hint = loadedEnvFile
      ? `已读取 ${envFile}`
      : `未找到 ${envFile}，请复制 .env.example 为 .env`;
    throw new Error(`配置无效（${hint}）：\n  - ${problems.join('\n  - ')}`);
  }

  // 记忆库放在 `data\<机器人>\memory.db`,和状态库、日志同一个目录(D36/D37)。
  //
  // Local display content is separate from runtime policy.
  // 根目录下的 `memory.db` —— 又往根目录丢一个文件,正是 D37 要消掉的东西。
  // 用 `QQBOT_MOOD_THEME` 当目录名是刻意的:它和 `bots\<bot>\` / `data\<bot>\` 是同一个标识符
  // (`megumin` / `aris`),所以三处永远对得上,也不受"状态库搬没搬"影响。
  config.policy.memory.dbFile = raw('QQBOT_MEMORY_DB')
    ? path.resolve(rootDir, raw('QQBOT_MEMORY_DB'))
    : path.join(rootDir, 'data', config.policy.mood.theme, 'memory.db');

  return config;
}
