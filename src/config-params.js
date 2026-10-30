import { defineParam } from './params.js';
import { PACK_PARAM_SPECS } from './pack-params.js';
import { normalizeBaseUrl, normalizeModel, normalizeApiKey } from './model-slots.js';
import { DEFAULT_C2C_DEBOUNCE_MS, DEFAULT_REPLY_JITTER_RANGE } from './burst.js';
import { DEFAULT_STRAND_GAP_MS } from './social.js';
import { DEFAULT_MEAL_WINDOWS } from './warmup.js';
import { LOCAL_MOOD_BODY_CONTENT } from './local-mood-body-content.js';

export const CONFIG_DEFAULTS = Object.freeze({
  apiBase: 'https://api.bot.qq.com', intents: 1 << 25, profile: 'qqbot', command: 'dsh',
  provider: 'deepseek-official', model: 'deepseek-flash', replyTimeoutMs: 240_000,
  maxChars: 1500, maxConcurrency: 2, logLevel: 'info',
});

/** Undefined defaults below are intentionally derived by the existing config builder.
 * Inputs, not resolved defaults, feed raw(): inserting defaults there would break
 * DREAM/legacy fallbacks. Paths are deployment-only, resolved relative to rootDir.
 * Explicit params/packParams are runtime policy only; credentials/paths require env.
 */
// Legitimate environment owned by other modules/tools, not typo fixtures.
// QQBOT_WORLD belongs to the optional world-pack loader (active world selection),
// not to the config catalogue: it never becomes a config field.
export const CONFIG_KNOWN_ENV = Object.freeze([
  'QQBOT_HOME', 'QQBOT_QQBOT_HOME', 'QQBOT_PYTHON', 'QQBOT_EMBED_PORT',
  'QQBOT_EMBED_CHECK_MS', 'QQBOT_REPAIR_TOOLS', 'QQBOT_APP_ID', 'QQBOT_SELFTEST_SKIP',
  'QQBOT_RELAY', 'QQBOT_RELAY_CONFIRM', 'QQBOT_RELAY_DENY', 'QQBOT_RELAY_EXPECT_NAMES',
  'QQBOT_RELAY_FROM', 'QQBOT_RELAY_TO', 'QQBOT_RELAY_VERIFY_NAMES', 'QQBOT_WORLD',
]);

export const CONFIG_DERIVED_DEFAULTS = Object.freeze({
  QQBOT_OWN_INPUT_TOKEN_LIMIT: 'null: no input token limit',
  QQBOT_SEARCH_BASEURL: 'empty: assembly may later use bot slot',
  QQBOT_MEMORY_EMBEDDING_URL: 'empty: embedding endpoint disabled',
  QQBOT_PANEL_PUBLIC_URL: 'empty: no public address announced',
  QQBOT_ENV_FILE: 'resolveEnvFile(rootDir): legacy .env, then bots/megumin/.env',
  QQBOT_PARAMS_FILE: 'disabled unless explicitly selected through environment',
  QQBOT_WORKSPACE: 'defaultWorkspaceFor(rootDir)',
  QQBOT_BODY_THEME: 'QQBOT_MOOD_THEME',
  QQBOT_LLM_BASEURL: 'QQBOT_LLM_DREAM_BASEURL, then https://api.deepseek.com/v1',
  QQBOT_LLM_KEY: 'QQBOT_LLM_DREAM_KEY, then empty',
  QQBOT_LLM_MODEL: 'QQBOT_LLM_DREAM_MODEL, then deepseek-chat',
  QQBOT_LLM_REASONING_EFFORT: 'QQBOT_LLM_DREAM_REASONING_EFFORT, then absent',
  QQBOT_LLM_MAX_TOKENS: 'QQBOT_LLM_DREAM_MAX_TOKENS, then absent',
  QQBOT_LOCK_FILE: 'rootDir/.qqbot.lock',
  QQBOT_LEGACY_STATE_FILE: 'rootDir/.qqbot-state.json; explicit empty disables import',
  QQBOT_MEITU_DB: 'sibling meitu.db of explicit QQBOT_STATE_DB, otherwise rootDir/data/meitu.db',
  QQBOT_MEMORY_DB: 'rootDir/data/<QQBOT_MOOD_THEME>/memory.db (not STATE_DB sibling)',
  QQBOT_STATE_DB: 'rootDir/.qqbot.db',
  QQBOT_SELFCARE_C2C: 'QQBOT_MORNING_C2C, then empty',
  QQBOT_IDS: 'QQBOT_ALLOWLIST only when ACCESS_MODE and IDS are unset, otherwise empty',
});

/** Existing complex parsers are injected from config.js: one rule, no circular import. */
export function createConfigParamDefinitions(parsers) {
  const defs = [];
  const add = (id, type, fallback, options = {}) => {
    const parse = options.parse;
    const numericParse = parse && ['number', 'int'].includes(type) ? (value) => {
      if (!['string', 'number'].includes(typeof value)) throw new Error('numeric input required');
      return parse(value);
    } : parse;
    defs.push(defineParam({
      id, type, default: fallback, env: id,
      scope: /^(?:QQBOT_ACCOUNTS|QQBOT_PANEL)(?:_|$)/.test(id) ? 'deployment' : 'runtime',
      ...options, ...(parse ? { parse: numericParse } : {}), ...PACK_PARAM_SPECS[id],
    }));
  };
  const unitMax = (id) => {
    const multiplier = /_SECONDS$/.test(id) ? 1000
      : /_MINUTES$/.test(id) && id !== 'QQBOT_GROUP_CONTEXT_MINUTES' ? 60_000
        : /_HOURS$/.test(id) && id !== 'QQBOT_WARMUP_MEAL_HOURS' ? 3_600_000
          : /_DAYS$/.test(id) ? 86_400_000 : 1;
    return Math.floor(Number.MAX_SAFE_INTEGER / multiplier);
  };
  const positive = (id, fallback, options) => add(id, 'int', fallback, { min: 1, max: unitMax(id), ...options });
  const nonnegative = (id, fallback, options) => add(id, 'int', fallback, { min: 0, max: unitMax(id), ...options });
  const boolean = (id, fallback) => add(id, 'boolean', fallback);
  const ratio = (id, fallback) => add(id, 'number', fallback, { min: 0, max: 1, parse: Number });
  const text = (id, fallback, options) => add(id, 'string', fallback, options);
  const deployment = (id, type, fallback, options) => add(id, type, fallback, { scope: 'deployment', ...options });
  const complex = (id, fallback, parse, options) => {
    const enumValues = parsers.enums[id];
    const type = enumValues ? 'enum'
      : ['QQBOT_KEYWORD_JITTER_MS', 'QQBOT_REPLY_JITTER_MS', 'QQBOT_WARMUP_SLEEP', 'QQBOT_MORNING'].includes(id) ? 'object'
        : Array.isArray(fallback) || id === 'QQBOT_IDS' ? 'array'
          : id === 'QQBOT_MEITU_PER_GROUP' ? 'boolean' : 'string';
    add(id, type, fallback, { parse: (value) => {
      if (typeof value !== 'string'
        && !(Array.isArray(fallback) && Array.isArray(value))
        && !(typeof fallback === 'boolean' && typeof value === 'boolean')) throw new Error('invalid input type');
      return parse(value);
    }, ...(enumValues ? { values: enumValues } : {}), ...options });
  };
  const DEFAULTS = CONFIG_DEFAULTS;
  // Numeric defaults are in their original env units (minutes/days/seconds where named).
  nonnegative('QQBOT_C2C_DEBOUNCE_MS', DEFAULT_C2C_DEBOUNCE_MS, { max: 30_000 });
  boolean('QQBOT_DSH_OPTIONAL', false);
  positive('QQBOT_DSH_MAX_TOKENS', undefined);
  positive('QQBOT_INTENTS', DEFAULTS.intents);
  boolean('QQBOT_SANDBOX', false);
  boolean('QQBOT_MEITU', false);
  positive('QQBOT_MEITU_MAX', 5);
  nonnegative('QQBOT_MEITU_COOLDOWN_MS', 30_000);
  positive('QQBOT_MEITU_MAX_BYTES', 10_485_760);
  positive('QQBOT_MEITU_TIMEOUT_MS', 90_000);
  boolean('QQBOT_GALLERY', true);
  boolean('QQBOT_PROMPT_CONTEXT', true);
  positive('QQBOT_MAX_IMAGES', 3);
  positive('QQBOT_GROUP_CONTEXT', 15);
  positive('QQBOT_GROUP_CONTEXT_MINUTES', 10);
  positive('QQBOT_GROUP_DEBOUNCE_MS', 6000);
  positive('QQBOT_GROUP_COOLDOWN_MS', 120_000);
  positive('QQBOT_GROUP_ENGAGED_COOLDOWN_MS', 15_000);
  positive('QQBOT_GROUP_MIN_MESSAGES', 2);
  positive('QQBOT_GROUP_WINDOW_MS', 90_000);
  boolean('QQBOT_GROUP_IGNORE_BOTS', true);
  nonnegative('QQBOT_GROUP_GAP_MS', DEFAULT_STRAND_GAP_MS);
  positive('QQBOT_GROUP_GAP_MAX_WAIT_MS', 300_000);
  nonnegative('QQBOT_RECHECK_MINUTES', 10);
  boolean('QQBOT_WARMUP', false);
  positive('QQBOT_WARMUP_INTERVAL_MS', 3_600_000);
  positive('QQBOT_WARMUP_SLOT_MS', 7_200_000, { min: 300_000, max: 43_200_000 });
  ratio('QQBOT_WARMUP_CHANCE', 0.5);
  ratio('QQBOT_WARMUP_MIN_CHANCE', 0.1);
  positive('QQBOT_WARMUP_ENGAGE_WINDOW_MS', 600_000);
  nonnegative('QQBOT_WARMUP_GAP_MS', 1_800_000);
  positive('QQBOT_WARMUP_QUIET_MS', 300_000);
  positive('QQBOT_WARMUP_TICK_MS', 30_000);
  positive('QQBOT_MORNING_GRACE_MS', 3_600_000);
  boolean('QQBOT_SELFCARE', false);
  positive('QQBOT_SELFCARE_QUIET_MS', 40 * 60_000);
  positive('QQBOT_SELFCARE_HUNGRY', 25);
  positive('QQBOT_SELFCARE_GAP_MS', 45 * 60_000);
  positive('QQBOT_SELFCARE_LIFE_EVERY_MS', 3 * 60 * 60_000);
  ratio('QQBOT_SELFCARE_LIFE_CHANCE', 0.5);
  boolean('QQBOT_ANNOUNCE', false);
  boolean('QQBOT_STATS', true);
  boolean('QQBOT_STAT_DELTA_LINE', true);
  boolean('QQBOT_STATS_MONEY', true);
  boolean('QQBOT_STATS_ILLNESS', true);
  boolean('QQBOT_SERIOUS_GUARD', true);
  boolean('QQBOT_TOOLS', false);
  boolean('QQBOT_TOOLS_MODEL_FN', false);
  nonnegative('QQBOT_TOOLS_MAX_ROUNDS', 3);
  nonnegative('QQBOT_SEARCH_TIMEOUT_SECONDS', 20);
  nonnegative('QQBOT_SEARCH_DAILY_LIMIT_CNY', 1);
  boolean('QQBOT_NARRATION', false);
  nonnegative('QQBOT_NARRATION_COOLDOWN_SECONDS', 20);
  nonnegative('QQBOT_NARRATION_TIMEOUT_SECONDS', 45);
  boolean('QQBOT_EXPLOSION', false);
  nonnegative('QQBOT_EXPLOSION_COOLDOWN_SECONDS', 90);
  nonnegative('QQBOT_EXPLOSION_DELAY_MS', 1000);
  nonnegative('QQBOT_EXPLOSION_BEATS_MAX', 4);
  boolean('QQBOT_SPOKEN_SPLIT', true);
  nonnegative('QQBOT_SPOKEN_MAX_CHARS', 60);
  nonnegative('QQBOT_SPOKEN_BASE_DELAY_MS', 500);
  nonnegative('QQBOT_SPOKEN_PER_CHAR_MS', 40);
  nonnegative('QQBOT_SPOKEN_MIN_DELAY_MS', 400);
  nonnegative('QQBOT_SPOKEN_MAX_DELAY_MS', 4000);
  ratio('QQBOT_SPOKEN_EMOJI_CHANCE', 0.12);
  boolean('QQBOT_MEMORY', true);
  positive('QQBOT_MEMORY_BUDGET', 1400);
  positive('QQBOT_MEMORY_RECENT', 10);
  boolean('QQBOT_MEMORY_LONGTERM', true);
  positive('QQBOT_MEMORY_LONGTERM_BUDGET', 300);
  positive('QQBOT_MEMORY_LONGTERM_LIMIT', 3);
  nonnegative('QQBOT_MEMORY_ARCHIVE_MINUTES', 15);
  nonnegative('QQBOT_MEMORY_CONSOLIDATE_MINUTES', 360);
  positive('QQBOT_MEMORY_NOTE_TTL_DAYS', 3);
  positive('QQBOT_MEMORY_CONSOLIDATE_WINDOW_DAYS', 3);
  boolean('QQBOT_MEMORY_LATEST_ONLY', true);
  boolean('QQBOT_MEMORY_ENTITY', true);
  ratio('QQBOT_MEMORY_ENTITY_BOOST', 0.3);
  boolean('QQBOT_MEMORY_BLOCKS', true);
  nonnegative('QQBOT_MEMORY_BLOCKS_CHARS', 200);
  nonnegative('QQBOT_MEMORY_BLOCKS_HOURS', 20);
  nonnegative('QQBOT_MEMORY_BLOCKS_TIMEOUT_SECONDS', 45);
  boolean('QQBOT_MEMORY_INSIGHTS', true);
  nonnegative('QQBOT_MEMORY_INSIGHTS_EVERY_HOURS', 20);
  nonnegative('QQBOT_MEMORY_INSIGHTS_INPUT_NOTES', 30);
  nonnegative('QQBOT_MEMORY_INSIGHTS_MAX_PER_RUN', 3);
  nonnegative('QQBOT_MEMORY_INSIGHTS_CHARS', 120);
  nonnegative('QQBOT_MEMORY_INSIGHTS_TIMEOUT_SECONDS', 45);
  boolean('QQBOT_MEMORY_SUMMARY', true);
  positive('QQBOT_MEMORY_SUMMARY_CHARS', 400);
  positive('QQBOT_MEMORY_SUMMARY_BUDGET', 480);
  nonnegative('QQBOT_MEMORY_SUMMARY_TIMEOUT_SECONDS', 45);
  nonnegative('QQBOT_MEMORY_SUMMARY_MIN_INTERVAL_MINUTES', 180);
  positive('QQBOT_MEMORY_SUMMARY_SESSION_CALLS', 20);
  boolean('QQBOT_MEMORY_EMBEDDING', false);
  nonnegative('QQBOT_MEMORY_EMBEDDING_TIMEOUT_MS', 800);
  boolean('QQBOT_MEMORY_EMBED_BACKFILL', true);
  positive('QQBOT_MEMORY_EMBED_BACKFILL_LIMIT', 64);
  boolean('QQBOT_MEMORY_FTS', true);
  positive('QQBOT_MEMORY_FTS_LIMIT', 50);
  boolean('QQBOT_MEMORY_KB', false);
  nonnegative('QQBOT_MEMORY_KB_BUDGET_CHARS', 600);
  nonnegative('QQBOT_MEMORY_KB_MAX_CHUNKS', 2);
  // 实例级"百科说明"授权(F2):只关 kb 事实块尾部那一段措辞;knowledge 授权由每轮
  // decision 决定 —— 关掉它不装傻、不禁常识/角色 KB 事实,显式 task 也不会因此变 chat。
  boolean('QQBOT_MEMORY_KB_ENCY', true);
  positive('QQBOT_MEMORY_NOTE_LIMIT', 1);
  positive('QQBOT_MEMORY_RECENCY_WEIGHT_X10', 5);
  nonnegative('QQBOT_KAOMOJI_BREAK_WIDTH', 32);
  boolean('QQBOT_POKE', true);
  ratio('QQBOT_POKE_REPLY_CHANCE', 1);
  boolean('QQBOT_FACE', true);
  ratio('QQBOT_FACE_REPLY_CHANCE', 0.15);
  nonnegative('QQBOT_INTERACTION_COOLDOWN_MS', 180_000);
  boolean('QQBOT_MOOD', true);
  positive('QQBOT_MOOD_TTL_MS', 600_000);
  ratio('QQBOT_MOOD_KAOMOJI_CHANCE', 0.3);
  boolean('QQBOT_MOOD_HARD_TRUNCATE', true);
  boolean('QQBOT_ECONOMY', true);
  boolean('QQBOT_ECONOMY_TASKS', true);
  boolean('QQBOT_ECONOMY_EVENTS', true);
  boolean('QQBOT_GROWTH', true);
  boolean('QQBOT_GROWTH_CONCEPTS', true);
  boolean('QQBOT_PANEL', false);
  positive('QQBOT_PANEL_PORT', 8799);
  positive('QQBOT_PANEL_CODE_LENGTH', 6);
  positive('QQBOT_PANEL_REFRESH_MS', 5000);
  boolean('QQBOT_ACCOUNTS', true);
  boolean('QQBOT_ACCOUNTS_OPEN', false);
  boolean('QQBOT_ACCOUNTS_REQUIRE_FOR_ACTIONS', false);
  positive('QQBOT_REPLY_TIMEOUT_MS', DEFAULTS.replyTimeoutMs);
  positive('QQBOT_MAX_CHARS', DEFAULTS.maxChars);
  positive('QQBOT_MAX_CONCURRENCY', DEFAULTS.maxConcurrency);
  // Remaining non-helper inputs, including old aliases and deliberately special switches.
  deployment('QQ_APP_ID', 'string', '', { sensitive: true });
  deployment('QQ_CLIENT_SECRET', 'string', '', { sensitive: true });
  deployment('QQ_API_BASE', 'url', DEFAULTS.apiBase);
  deployment('QQBOT_ENV_FILE', 'path', undefined);
  deployment('QQBOT_PARAMS_FILE', 'path', undefined);
  deployment('QQBOT_WORKSPACE', 'path', undefined);
  for (const [id, fallback] of Object.entries({
    QQBOT_LOCK_FILE: undefined, QQBOT_LEGACY_STATE_FILE: undefined,
    QQBOT_STATE_DB: undefined, QQBOT_MEMORY_DB: undefined, QQBOT_REPORT_STATS_DB: undefined,
    QQBOT_MEITU_DB: undefined, QQBOT_LOG_FILE: undefined,
    QQBOT_MEITU_ROOT: 'data/meitu-images', QQBOT_MEITU_ALIAS: 'data/meitu-alias.json',
    QQBOT_MEITU_LINES: 'data/meitu-lines.json', QQBOT_MEITU_THUMBS: 'data/meitu',
  })) deployment(id, 'path', fallback, id === 'QQBOT_LEGACY_STATE_FILE' ? { emptyAsUnset: false } : {});
  text('QQBOT_DSH_PROFILE', DEFAULTS.profile, { validate: (value) => { parsers.profile(value); return true; } });
  text('QQBOT_DSH_COMMAND', DEFAULTS.command);
  text('QQBOT_DSH_PROVIDER', DEFAULTS.provider);
  text('QQBOT_DSH_MODEL', DEFAULTS.model);
  text('QQBOT_DSH_REASONING_EFFORT', undefined);
  complex('QQBOT_ENGINE', 'own', parsers.engine);
  positive('QQBOT_OWN_INPUT_TOKEN_LIMIT', undefined, { parse: parsers.inputTokenLimit });
  for (const id of ['QQBOT_LLM_KEY', 'QQBOT_LLM_DREAM_KEY', 'QQBOT_SEARCH_KEY', 'QQBOT_PANEL_TOKEN', 'QQBOT_PANEL_CODE']) {
    deployment(id, 'string', id === 'QQBOT_LLM_KEY' ? undefined : '', {
      sensitive: true,
      ...(id.startsWith('QQBOT_LLM_') ? { validate: (value) => normalizeApiKey(value).ok } : {}),
    });
  }
  // Validation only: retain original raw strings in inputs and the legacy output.
  // The model-slot normalizers remain the single rules for endpoint/model/key.
  deployment('QQBOT_LLM_BASEURL', 'url', undefined, { validate: (value) => normalizeBaseUrl(value).ok });
  deployment('QQBOT_LLM_DREAM_BASEURL', 'url', 'https://api.deepseek.com/v1', { validate: (value) => normalizeBaseUrl(value).ok });
  deployment('QQBOT_SEARCH_BASEURL', 'url', undefined);
  deployment('QQBOT_MEMORY_EMBEDDING_URL', 'url', undefined);
  deployment('QQBOT_PANEL_PUBLIC_URL', 'url', undefined);
  deployment('QQBOT_LLM_MODEL', 'string', undefined, { validate: (value) => normalizeModel(value).ok });
  deployment('QQBOT_LLM_DREAM_MODEL', 'string', 'deepseek-chat', { validate: (value) => normalizeModel(value).ok });
  text('QQBOT_MEMORY_EMBEDDING_MODEL', '');
  for (const id of ['QQBOT_LLM_REASONING_EFFORT', 'QQBOT_LLM_DREAM_REASONING_EFFORT']) complex(id, undefined, parsers.reasoningEffort);
  for (const id of ['QQBOT_LLM_MAX_TOKENS', 'QQBOT_LLM_DREAM_MAX_TOKENS']) positive(id, undefined, { parse: Number, validate: parsers.maxTokens });
  complex('QQBOT_ACCESS_MODE', 'allowlist', parsers.accessMode, { scope: 'deployment' });
  complex('QQBOT_MOOD_THEME', 'megumin', parsers.moodTheme);
  complex('QQBOT_BODY_THEME', undefined, parsers.bodyTheme);
  // 实例级**媒介表现**参数(S1 风格包接线):只选风格包 id,功能/授权/工具/预算都不在这里。
  // 合法值来自 `content/styles/*` 目录发现(见 config.js 的 enums);未知 id 在参数层
  // 就 fail closed(PARAM_VALUE),不落进任何内容包/world 包的数据白名单。
  complex('QQBOT_STYLE_PACK', 'legacy-online', parsers.stylePack);
  complex('QQBOT_WARMUP_MODE', 'random', parsers.warmupMode);
  complex('QQBOT_ANNOUNCE_MODE', 'character', parsers.announceMode);
  complex('QQBOT_ANNOUNCE_TARGETS', 'c2c', parsers.announceTargets);
  complex('QQBOT_ANNOUNCE_TRIGGER', 'confirm', parsers.announceTrigger);
  complex('QQBOT_GROWTH_ANNOUNCE', 'both', parsers.growthAnnounce);
  complex('QQBOT_MEITU_SOURCE', 'auto', parsers.meituSource);
  complex('QQBOT_GROUP_MODE', 'mention', parsers.groupMode);
  // Not a boolean env: only literal '0' disables it, even 'false' is on.
  complex('QQBOT_MEITU_PER_GROUP', true, (value) => String(value) !== '0');
  complex('QQBOT_SELFCARE_LIFE_TO', 'group', (value) => String(value).trim().toLowerCase() === 'c2c' ? 'c2c' : 'group');
  complex('QQBOT_KEYWORD_JITTER_MS', 'off', parsers.keywordJitter);
  complex('QQBOT_REPLY_JITTER_MS', `${DEFAULT_REPLY_JITTER_RANGE.minMs}-${DEFAULT_REPLY_JITTER_RANGE.maxMs}`, parsers.replyJitter);
  complex('QQBOT_WARMUP_SLEEP', null, parsers.sleep, { nullable: true });
  complex('QQBOT_WARMUP_MEAL_HOURS', DEFAULT_MEAL_WINDOWS, parsers.mealWindows);
  complex('QQBOT_MORNING', null, parsers.morning, { nullable: true });
  complex('QQBOT_GROUP_KEYWORDS', LOCAL_MOOD_BODY_CONTENT?.config.groupKeywords ?? ['示例助手', 'demo'], parsers.keywords);
  const csv = (value) => {
    if (Array.isArray(value)) {
      if (value.some((entry) => typeof entry !== 'string')) throw new Error('string list required');
      return value.join(',').split(',').map((entry) => entry.trim()).filter(Boolean);
    }
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  };
  for (const id of ['QQBOT_ALLOWLIST', 'QQBOT_IDS', 'QQBOT_SELF_GROUP_IDS', 'QQBOT_MEITU_GROUPS',
    'QQBOT_GROUP_IGNORE_IDS', 'QQBOT_ADMIN_IDS', 'QQBOT_TOOLS_ALLOW', 'QQBOT_WEBFETCH_ALLOW',
    'QQBOT_STRIP_NAME_LABELS', 'QQBOT_PANEL_ALLOWED_HOSTS', 'QQBOT_ACCOUNTS_STAFF']) {
    complex(id, id === 'QQBOT_IDS' ? undefined : [], csv, {
      scope: ['QQBOT_ALLOWLIST', 'QQBOT_IDS', 'QQBOT_SELF_GROUP_IDS', 'QQBOT_ADMIN_IDS', 'QQBOT_PANEL_ALLOWED_HOSTS', 'QQBOT_ACCOUNTS_STAFF'].includes(id) ? 'deployment' : 'runtime',
    });
  }
  complex('QQBOT_GROUP_ADDRESS_MARKERS', ['你', '妳', '您', '汝'], csv);
  deployment('QQBOT_MEITU_PROXY', 'string', '');
  deployment('QQBOT_PANEL_HOST', 'string', '127.0.0.1');
  for (const id of ['QQBOT_MORNING_C2C', 'QQBOT_ANNOUNCE_C2C', 'QQBOT_GROWTH_C2C', 'QQBOT_SELFCARE_GROUP']) deployment(id, 'string', '');
  deployment('QQBOT_SELFCARE_C2C', 'string', undefined);
  text('QQBOT_REPORT_TARGET_NAME', LOCAL_MOOD_BODY_CONTENT?.config.reportTargetName ?? '示例助手');
  text('QQBOT_REPORT_TARGET_THEME', 'megumin');
  text('QQBOT_LOG_LEVEL', DEFAULTS.logLevel);
  nonnegative('QQBOT_STYLE_NUDGES', 1);
  add('QQBOT_SEARCH_PER_CALL_CNY', 'number', 0.0054, { parse: Number, validate: (value) => value > 0 });
  add('QQBOT_INTERACTION_WINDOW_MULTIPLIER', 'number', 2, { parse: (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error('invalid multiplier');
    return parsed || 2;
  } });
  return Object.freeze(defs);
}
