import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile, resolveEnvFile } from './config.js';
import { HEALER_PATTERNS, INFRA_CONTENT, infraText } from './local-infra-content.js';
import { buildAnnounceDigest, latestRelease, listVersions } from './changelog.js';
import {
  ANNOUNCE_USAGE,
  BASELINE_HISTORY_KEY,
  announceBaselineKey,
  announceDigestOptions,
  announceOfferKey,
  appendBaselineHistory,
  buildAnnounceQuestion,
  describeAnnounceTrigger,
  describeBaselineLedger,
  describeDigestMiss,
  describeRollback,
  hasAnnounceContent,
  isKnownVersion,
  parseAnnounceCommandArgs,
  parseAnnounceReply,
  parseBaselineHistory,
  planBaselineRollback,
  shouldRecordAnnounce,
} from './announce-flow.js';
import { describeTurnEnd, sanitizeSessionId } from './runner-contract.js';
import { createOwnEngine } from './engine.js';
import { COPYPASTA_FILE, copypastaTurn, loadCopypastaCorpus } from './copypasta.js';
// P4 故事活动内容包(2026-10-28):机制通用、内容按角色;没有包 = 这类玩法入口关闭。
import { storyPackFor, storyPackStatus } from './story-content.js';
import { hasLeakedControlMarkup, stripLeakedControlMarkup } from './control-markup.js';
import { QqApi, QqGateway, TokenManager, parseForeignBotIds, sanitizeOutgoingText } from './qq.js';
import { fetchImageBlocks, localImageBlock } from './images.js';
import { GroupContext, SILENT_TOKEN, isSilentReply, looksAddressedToBot, matchesKeywords } from './group-context.js';
import { arrivalFreshnessMs, buildArrivalReportPrompt, buildSelfCarePrompt, buildTravelReportPrompt, decideArrivalReport, decideSelfCare, isStoryActivity, LIFE_ACTIVITIES, orderSelfCareGroups, pickReportScene, whereaboutsTtlMs } from './selfcare.js';
import { WORLD_HER_KEY, herWhereabouts, placeById, settleTravel, whereaboutsFromAction, whereaboutsFromDecision } from './world.js';
import { bodyCheckReply, catchDisease, detectBodyCheck, seekAqua } from './condition.js';
import { DISEASE_CAUSES } from './condition.js';
import { applyAffinity, affinityTier, describeAffinity, describeAffinityList } from './affinity.js';
// ⚠️ 钓鱼那一层(D105 内核 / D108 适配器)的实现**不在这里**了:
//    内核 = `src\play\`,适配器 = `src\fishing-adapter.js`。这里只 import 它**端口**上需要的东西。
import { buildFishingFlavorPrompt, describeFishingScene } from './fishing.js';
import { createFishingAdapter } from './fishing-adapter.js';
import { createAccountService } from './player-account.js';
// 桥进程的生命体征(1.168.0 / D275):「连着 ≠ 收得到」的探活 —— 盯最后一条真实
// 入站事件的年龄(Icinga freshness check 形状),不盯连接心跳。
import { createBridgeVitals, judgeStaleness, shouldWarnVitalsFailure, writeStatusAtomic } from './bridge-vitals.js';
// 群参与状态机(1.170.0 / D277):观望/试探/活跃/退场 —— 只调制自发开口与戳一戳/
// 表反应的概率;被叫/私聊/关键词永远不走它(D72 铁律)。数值全在
// SOCIAL_STATE_DEFAULTS 一张表里【暂定】。
import { createSocialStateMachine } from './social-state.js';
// ⚠️ `createRoomService`(网页群聊房,1.101.0 / D164)已于 2026-10-14(D229)整条下线 ——
//    这一栏让用户互相看见/说话,与"公开站只做一对一对话工具"的定位冲突(见 panel.js 的 ZONE_NAV)。
import { createCredits } from './credits.js';
// createPayService(import)已于 2026-10-23 随充值退役删除 —— pay.js 整份退场。
// **梦境**(docs\21 §十 / D227):直连 LLM 客户端(刀一)+ 自建房存储(刀二后半)。
import { createLlmSettings, MODEL_SLOTS_FILE } from './llm-settings.js';
import { createDpapiSecretBox } from './secret-box.js';
import { createDreamStore } from './dream-store.js';
import { createCharacters, describeSheet } from './character.js';
import { createIdentityLinks, buildIdentityNote, looksLikeBindCode } from './identity-link.js';
import { createPlayerWorld } from './player-world.js';
import { nameIsInvisible } from './people.js';
import { dynamicAllowedHosts, readTunnelState } from './tunnel-state.js';
import { companyNote, detectCompany } from './company.js';
import {
  STORY_TTL_MS,
  buildStoryOpenPrompt,
  buildStoryRespondPrompt,
  buildStorySettlePrompt,
  extractStoryOutcome,
  hasClosingAction,
  inferBranch,
  matchOutcome,
  openStory,
  pickSelfDecidedBranch,
  storyExpired,
} from './story.js';
import { breakBeforeKaomoji, DIRECT_RESPONSE_NOTES, pickNudges, rememberNudges, SPOKEN_STANDING_NOTES, withFacts, withStyleNudge } from './style.js';
import { getMoodTheme, buildMoodNote, decideMood, maybeSpokenEmoji, splitSpokenLines } from './mood.js';
import {
  buildChronicle,
  pickSpecialEntries,
  renderSpecialLine,
  SPECIAL_WINDOW_MS,
} from './chronicle.js';
import { daysToday, renderDayLine } from './character-days.js';
import { getBodyTheme, longLabelFor } from './body-theme.js';
// 两套数值框架(2026-10-28 主人拍板):生物体/机械体。
import { bodyRulesForTheme } from './body-rules.js';
import {
  CONCEPT_BONUS,
  CONCEPT_WORDS,
  MILESTONE_LEVELS,
  XP_RULES,
  conceptLabel,
  describeForPrompt as describeGrowthForPrompt,
  describeForUser as describeGrowthForUser,
  describeTurnKind,
  levelUpReport,
  matchConcepts,
  milestoneNote,
  nextMilestoneAfter,
  xpForTurn,
} from './growth.js';
import {
  buildWarmupPrompt,
  effectiveChance,
  isWithinSleepWindow,
  normalizeWarmupEntry,
  pickWarmupTopic,
  rememberWarmupTopics,
  settleWarmupEngagement,
  warmupDecision,
  warmupSlot,
} from './warmup.js';
import { buildMorningPrompt, localDateKey, morningStatus } from './morning.js';
import { SqliteStateStore, readStatsForReport } from './sqlite-store.js';
import {
  CURRENCY,
  ERIS_PER_KCAL,
  EXPLOSION_MANA_COST,
  INTERACTIONS,
  MONEY_DECAY,
  MONEY_POOR,
  createStats,
  detectPotion,
  describeForPrompt,
  describeForUser,
  describeWallet,
  extractIntake,
  feedingNote,
  isIntimate,
  looksLikeEating,
  mealCost,
  mentionsEating,
  narrateMeal,
  renderStatDeltas,
  rejectsIntake,
  resolveIntake,
} from './stats.js';
import { describeLedgerForPrompt, formatQuestBoard, mentionsAmount, moneyMood, rollEvent, rollQuestBoard, rollTask, walletPrompt } from './economy.js';
// 接委托的判定与结账(1.86.0):QQ 的 `/接 N` 与网页上的「接取」按钮**共用这一份**(D141)
import { applyQuestTake, describeQuestTake, pickQuestTake } from './quest-take.js';
import { acquireLock, botDirFromEnvFile, requestRestart, restartMarkerPath } from './lock.js';
import { resolveBotHome } from './bot-home.js';
import { helpText } from './commands.js';
import { checkGroupIdentity, formatGroupList } from './group-identity.js';
import { RELAY_FILE_PREFIX, classifyChatRecord, decideTextFallback, describeRelayAutoForward, describeRelayBusy, describeRelayImageFailure, describeRelayRefusal, formatRelayTextFallback, isChatRecord, parseChatRecord, parseRelayCommand, parseRelayConfig, relayFileNames } from './relay.js';
import { buildPdf, normalizeImages, renderTextPages } from './relay-pack.js';
import { downloadQqImage } from './safe-download.js';
import { parseSummarySessionMeta, pickSummarySession, summarySessionKey, SUMMARY_SESSION_META_KEY } from './summary-session.js';
// `/重置` 忙/失败时回哪一句(F7):措辞只有一份,判据也引用这里。
import { planReset } from './reset-reply.js';
// 代码层发美图(2026-10-23):「发N张<角色>美图」——解析与发送都不经过模型。
import { looksLikeMeituAttempt, parseMeituCommand } from './meitu-command.js';
import { handleMeituCommand, describeMeituTask } from './meitu-service.js';
import { createMeituInterpreter } from './meitu-interpret.js';
// 美图展览处(2026-10-23 / 展览处刀 1 数据层 + 刀 2 只读 API):
// 元数据库 `data\<bot>\meitu.db` 与两档缩略图都由这里打开一次、注入服务层与面板。
import { mimeForImagePath, openMeituGallery } from './meitu-gallery.js';
import { describeError, log, openLogFile } from './log.js';
import { describeUserError } from './user-error.js';
import { isMergeable, mergeInstruction, renderBurst, rollTypingDelay } from './burst.js';
import { createBurstQueue } from './burst-queue.js';
import { createConversationImageCarry } from './image-carry.js';
// T2(2026-10-29):动作观察账 —— 通用「她正在/刚做了什么」事实源(搬图首个接入者)。
import { createActionLog } from './action-log.js';
import { installCrashLogging } from './crash-log.js';
import { wrapInject } from './inject-mark.js';
import { detectEncyclopedia, ENCYCLOPEDIA_NOTE } from './kb.js';
import { decideRecheck, decideSpeakUp } from './social.js';
import { archiveOwnHistory } from './own-memory-archive.js';
import { createMemoryArchiveTick, startMemoryArchive } from './memory-archive-tick.js';
import { activeConversations, archiveDue, archiveOnStartup, backfillEmbeddings, buildMemoryBlocks, applyBlockUpdates, consolidate, embeddingCoverage, ensureBlockSchema, ensureFtsSchema, ensureNoteSchema, entityStats, fetchQueryVector, forgetNotes, forgetSummary, getSummary, getMemoryBlocks, indexTurnFts, knowledgeStats, makeHandoffFromConfig, makeKnowledgeProvider, makeLongTermProvider, memoryBlockStats, memorySummary, noteStats, notesOf, openMemory, recentNotesText, rebuildEntities, renderMemoryBlocks, saveSummary, summarizeConversation, summaryPlan, tagCoverage } from './memory-store.js';
// P2-A:记忆洞察(2026-10-22,方案 §4.4)—— 生成/落库/渲染都在这一个模块里(memory 层零 HTTP)。
import { INSIGHT_MIN_NOTES, appendInsights, buildInsights, insightsDue, latestInsightCreatedAt, latestInsights, recentInsightNotes, renderInsights } from './memory-insights.js';
// P0 记忆作用域(2026-10-28):常驻块/洞察只在允许的会话里出现(口径一份,纯函数)。
import { filterBlocksForAccess, filterInsightsForAccess, memoryAccessFor } from './memory-scope.js';
// P1 任务口径(2026-10-28):闲聊/办事/求知三态,平台无关;**只给权限不下命令**。
import { composeModeNote, detectTurnMode, groupLinesForDelivery, noteGatesFor, outputPolicyFor } from './turn-policy.js';
// P3-b 工具装配(2026-10-28):能力注册/授权判据在 capabilities 层,这里只做实例装配。
import { advertisedTools, defineCapability, turnContextFor, withBudget } from './capabilities.js';
import { createWebSearchProvider } from './web-search-provider.js';
import { createToolBudget } from './tool-budget.js';
import { isResponsesApi } from './llm.js';
// W4 记忆检修台(P2-C,2026-10-22):API 逻辑全在 memory-console.js —— index.js 只把两个库的现有连接递给面板。
import { createMemoryConsole } from './memory-console.js';
import { RELATION_WORDS, describeFact, detectClaimAboutSelf, extractAccept, extractFacts, factVisible, labelOf, parseForget, renderFacts, resolveNameTeach } from './profile.js';
import { buildExplosion, isExplosionRequest } from './explosion.js';
import { buildNarrationPrompt, isExplosionFinisher, resolveCasterName } from './narration.js';
import { retryAsync } from './retry.js';
import { turnPolicyFor } from './serious.js';
// **旅伴**(2026-10-11 第四轮 / D190):面板那一栏要"看到别的 AI 角色"——
// 它们各自跑在自己那只 bot 上、各自一个 state.db,所以这里**只读**地摸一下另一只的库。
import { COMPANIONS, companionSkinState, readCompanionFacts } from './companions.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


/**
 * 「请重启」标记的路径(D45)。它由 `data\<bot>\` 决定,而那个目录名来自
 * `QQBOT_ENV_FILE` —— 所以**必须在 `loadConfig` 之前**就把环境变量读进来,
 * 否则这里会按默认的主实例去算,两只机器人会共用一个标记。
 */
const restartMarkerFile = (() => {
  loadEnvFile(resolveEnvFile(ROOT_DIR));
  return restartMarkerPath(ROOT_DIR, botDirFromEnvFile(resolveEnvFile(ROOT_DIR)));
})();

/** The version this code claims, from `package.json`. */
function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The newest entry in `CHANGELOG.md`, or null when it cannot be read. */
function readLatestRelease() {
  try {
    return latestRelease(fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 这次要播报的正文 —— **自上次播报以来的全部改动**,不只是最新一版(D49)。
 *
 * 用户的反馈:「播报更新日志逻辑有问题,应该包含之前的未发布大更新内容梗概
 * (记忆和金币系统等等),简要提到小更新内容」。所以这里不再是
 * `latestRelease().sections['播报']`,而是 `buildAnnounceDigest()`:
 * 补课梗概 + 大更新各取几条 + 小更新合成一行。
 *
 * ⚠️ **`null` 有两种完全不同的意思,别混**(2026-10-11 现场):
 *   ① `CHANGELOG.md` 真的缺失 / 读不动;
 *   ② 文件好好的,只是**按当前口径没有可播的正文**(`buildAnnounceDigest` 在"最新一版
 *      不是大更新"时返回 null —— 那是**自动**那条路的口径)。
 *   所以这里**不**在 null 上写死任何文案;叫的人拿 `describeDigestMiss()` 去分。
 *
 * @param {string|null} sinceVersion 上次播报过的版本(`meta.announced_version`)
 * @param {{majorOnly?: boolean}} [options] 口径 —— 只由 `announceDigestOptions()` 决定
 * @returns {{version: string, mode: string, versions: string[], text: string}|null}
 */
function readAnnounceDigest(sinceVersion, { majorOnly = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  } catch (err) {
    // ① 真的读不到 —— 只有这一种情况才配说"读不到 CHANGELOG.md"。
    log.warn(`读不到 CHANGELOG.md: ${describeError(err)}`);
    return null;
  }
  try {
    return buildAnnounceDigest(text, { sinceVersion, majorOnly });
  } catch (err) {
    log.warn(`拼播报正文失败（退回"只念最新一版"）: ${describeError(err)}`);
    const release = latestRelease(text);
    if (!release) return null;
    return {
      version: release.version.replace(/^v/, ''),
      mode: 'since',
      versions: [release.version],
      text: String(release.sections?.['播报'] ?? '').trim(),
    };
  }
}

/**
 * Split a reply into QQ-sized pieces, preferring newline then space boundaries
 * so code blocks and sentences survive mostly intact.
 */
export function chunkText(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [text];
  const chunks = [];
  let rest = text;

  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim() !== '') chunks.push(rest);
  return chunks;
}

/** Durable, restart-safe SDK session id derived from the QQ conversation. */
export function sessionIdFor(message) {
  return sanitizeSessionId(`qqbot-${message.scene}-${message.targetId}`);
}

/**
 * Whether a sender may drive the agent.
 *
 * `null` means the operator deliberately left the bridge open (startup logs a
 * loud warning). Any concrete set — including an empty one — admits only its
 * members, so a malformed or emptied list fails closed rather than open.
 */
/**
 * Whether a sender may drive the agent, per the configured access mode.
 *
 *   allowlist — only listed openids pass; an empty list admits nobody (fail closed)
 *   blocklist — everyone except listed openids passes
 *   open      — everyone passes
 *
 * An unrecognised mode denies rather than widens: a typo in configuration must
 * never be the reason a bot unexpectedly answers strangers.
 */
export function isAllowed(senderId, access) {
  const listed = access.ids?.has(senderId) ?? false;
  switch (access.mode) {
    case 'allowlist':
      return listed;
    case 'blocklist':
      return !listed;
    case 'open':
      return true;
    default:
      return false;
  }
}

/**
 * Prefix a message with its scene.
 *
 * Sessions are per-conversation, so the SDK prompt carries no identity at all:
 * without this the model cannot tell a group @ from a private message, and there
 * is no other channel to tell it. A few tokens is a cheap price for that.
 */
export function withSceneTag(message, enabled, groupContext) {
  // A photo with no caption is ordinary; give the text block something to say so
  // the model is not handed an empty prompt alongside the image. The same goes
  // for a bare @, which arrives with nothing at all after the mention is
  // stripped — that is somebody calling her over, not an empty message.
  const placeholder = message.images?.length > 0 ? '（发来一张图片，没有文字）' : '（只 @ 了你，没有说别的）';
  const body = message.content || placeholder;
  // ⚠️ **群聊里必须写上"这是谁说的"**(2026-10-01,D78)。
  //
  // 用户当场问的那句话:「难道接收了这么久的群消息都分不出来谁发的吗,那不就相当于群里
  // 都是同一个真人发信息」。实测确实是这个形状:发送者的 openid 与昵称**都记着**
  // (`person` 表,每群一人一条),**群上下文里也带昵称**,但**这一条触发消息**只喂
  // `[群聊] 正文` —— 于是她是在"对一个匿名的人"说话,而且归档里也认不出谁说的
  // (D38 早就把这条记成已知缺口)。
  const speaker = message.scene === 'group' && typeof message.senderName === 'string' && message.senderName.trim() !== ''
    ? `${message.senderName.trim()}：`
    : '';
  const parts = [
    enabled && !message.mergedBurst
      ? `${message.scene === 'group' ? '[群聊]' : '[私聊]'} ${speaker}${body}`
      : `${speaker}${body}`,
  ];

  // A group @ arrives with no knowledge of what the group was just talking
  // about; the buffered messages supply it.
  if (groupContext && message.scene === 'group') {
    const context = groupContext.render(message.targetId);
    if (context) parts.push(context);
  }
  return parts.filter(Boolean).join('\n');
}

/** Commands handled by the bridge itself instead of being sent to the agent. */
const RESET_COMMANDS = new Set(['/重置', '/重来', '/reset']);/** `/状态` —— 卡片 §12 里列过这个命令,现在它读的是真实数值。 */
const STATUS_COMMANDS = new Set(['/状态', '/status']);
/** `/更新` —— 让日志机器人重播一次更新播报(不用等重启)。 */
const ANNOUNCE_COMMANDS = new Set(['/更新', '/播报', '/release']);
/**
 * 「问你一声」的答复命令(D50)。
 *
 * 单独列一个集合、而且在参数解析**之前**处理:`/不发` 如果落到那套解析里,
 * 会被当成"没带参数" → 于是正好相反,把播报发出去了。
 */
const ANNOUNCE_REPLY_COMMANDS = new Set(['/发', '/发布', '/不发', '/预览', '/send', '/skip']);
/** `/群列表` —— 播报只能发给"她收到过消息的群",所以要把编号列出来给人挑。 */
const GROUP_LIST_COMMANDS = new Set(['/群列表', '/groups', '/群']);
/** `/成长` —— 养成进度的精确值(等级/经验/学会的概念/认识的人)。和 `/状态` 同一个道理。 */
const GROWTH_COMMANDS = new Set(['/成长', '/growth', '/等级']);
/** `/钱包` —— 经济状况(D42)。钱平时只进提示词,这是唯一能问出精确值的办法。 */
const WALLET_COMMANDS = new Set(['/钱包', '/钱', '/money']);
/**
 * **委托面板**(D101 形态二):`/委托` 看板上的活,`/接 N` 挑一条。
 *
 * 为什么要有"面板"这一层:掷骰是她**自己**接活(被动),面板是**人**看着挑 ——
 * 挑之前就知道报酬与风险,那才是"用户在玩"。面板由代码掷(D44:数字只能来自库)。
 */
const QUEST_COMMANDS = new Set(['/委托', '/看板', '/委托面板']);
/** `/接 1` · `/接 2` —— 也认 `/接委托 1`。 */
const QUEST_TAKE_RE = /^\/接(?:委托)?\s*(\d+)$/;
/** `/help` —— 列出这边可用的指令(D45)。正文从 `src/commands.js` 生成,不手写第二份。 */
const HELP_COMMANDS = new Set(['/help', '/帮助', '/指令', '/菜单', '/？', '/?']);
/**
 * `/发图` —— **她自己发一张图**(2026-10-09)。只给操作者:那是"往群里发东西"的口子,
 * 开给所有人就等于任何人一句话能让她刷图。图由 `scripts\sprite-draw.py` 用代码画(不依赖外部素材)。
 */
const SEND_IMAGE_COMMANDS = new Set(['/发图', '/出图', '/sendimage']);
/**
 * `/restart` —— 重启这只机器人(D45)。**只在私聊、且只给操作者**:
 * 它是一次真实的进程重启(代价:这一代会话结束),不该让群里任何人打一句就能触发。
 * 真正干活的是「写下标记 + 让自己退出」—— 窗口那边的 run.cmd 看到标记会原地重开。
 */
const RESTART_COMMANDS = new Set(['/重启', '/restart']);

/**
 * 搬运打包出来的 PDF,发到群里时**叫什么名字**(D65)。
 *
 * 用户 2026-09-29 要求采用内容侧命名前缀吸引读者——
 * 下载时/文件卡片上显示的就是它,所以这算**给群友看的文案**,不是内部记号
 * (以前叫 `聊天记录-<毫秒>.pdf`,一眼就是流水线产物)。
 *
 * 名字里的后缀与长度上限在 `relayFileNames()` 里(纯函数,有测试):
 * 后缀保证"同一个 PDF 发多个群"不重名,上限保证长名字不会撑爆平台。
 */
// RELAY_FILE_PREFIX is exported by relay.js; do not define a second display default here.

/**
 * Do not greet a group that the bot spoke in very recently — "早上好" landing
 * seconds after a normal reply reads as a malfunction rather than a greeting.
 */
const MORNING_QUIET_AFTER_REPLY_MS = 10 * 60_000;

/** Bound concurrent DSH turns while leaving same-session ordering to the runner. */
class Semaphore {
  #limit;
  #active = 0;
  #waiters = [];

  constructor(limit) {
    this.#limit = Math.max(1, limit);
  }

  async acquire() {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
  }

  release() {
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (next) next();
  }
}

/** 网页关闭时不解析网页依赖；显式开启时缺件/坏件必须让启动失败。 */
export async function loadPanelModules(config) {
  if (!config.policy?.panel?.enabled) return null;
  try {
    const [panel, actions, chat, notify] = await Promise.all([
      import('./panel.js'),
      import('./panel-actions.js'),
      import('./webchat.js'),
      import('./panel-notify.js'),
    ]);
    const modules = {
      PANEL_META_PREFIXES: panel.PANEL_META_PREFIXES,
      buildSnapshot: panel.buildSnapshot,
      startPanel: panel.startPanel,
      createActionExec: actions.createActionExec,
      createWebChat: chat.createWebChat,
      panelNoticesToLines: notify.panelNoticesToLines,
      readPanelNotices: notify.readPanelNotices,
    };
    // 动态 import 不像静态命名 import 会检查导出，须在装配前补回这道闸。
    for (const [name, value] of Object.entries(modules)) {
      if (name === 'PANEL_META_PREFIXES' ? !Array.isArray(value) : typeof value !== 'function') {
        throw new Error(`网页模块导出无效: ${name}`);
      }
    }
    return modules;
  } catch (cause) {
    throw new Error('QQBOT_PANEL 已启用，但网页模块加载失败；请恢复完整网页文件或显式关闭 QQBOT_PANEL', { cause });
  }
}

/** 旧 DSH 会话归档专用；own 直接读自己的历史，不依赖私有脚本。 */
export async function loadLegacySessionReader(config) {
  if (!config.policy?.memory?.enabled || config.engine?.mode === 'own') return null;
  try {
    const { readSessionRecords } = await import('../scripts/session-log.js');
    if (typeof readSessionRecords !== 'function') {
      throw new Error('session-log.js 缺少 readSessionRecords 导出');
    }
    return readSessionRecords;
  } catch (cause) {
    throw new Error('旧 DSH 记忆归档需要 session-log.js，但加载失败；请恢复该文件或使用 own 引擎', { cause });
  }
}

export async function main() {
  const config = loadConfig({ rootDir: ROOT_DIR });
  log.setLevel(config.logLevel);

  // Attach the file sink before anything else logs, so an unattended start is
  // still diagnosable after the console window is gone.
  if (config.logFile) {
    if (openLogFile(config.logFile)) log.info(`日志同时写入 ${config.logFile}`);
    else log.warn(`日志文件无法写入，仅输出到 stderr：${config.logFile}`);
  }

  // ⚠️ 崩溃钩子(2026-10-16,1.150.81):own 进程曾静默死亡一次且零痕迹 ——
  //    uncaughtException / unhandledRejection 的默认死法**一个字都不说**。
  //    这两只钩子把完整栈写进桥日志再 exit(1)(语义与默认一致,守护负责拉回);
  //    必须在文件 sink 挂好**之后**装 —— 崩了也要留档在文件里,不只控制台窗口。
  installCrashLogging(log);

  // 必须在模型 watcher、单实例锁与 QQ 连接之前完成，不能被后面的面板运行时 warn 吃掉。
  const {
    PANEL_META_PREFIXES, buildSnapshot, startPanel, createActionExec,
    createWebChat, panelNoticesToLines, readPanelNotices,
  } = await loadPanelModules(config) ?? {};
  const readSessionRecords = await loadLegacySessionReader(config);

  /**
   * **两套模型配置(2026-10-18 / 1.153.0)**:
   *  · `bot`  = 所有前端共用的唯一一套(QQ / 世界 / 以后的企业微信);
   *  · `dream`= 仿酒馆玩法,独立一套。
   *
   * 先读盘上的覆盖(`data\<bot>\model-slots.json`;key 是 DPAPI 密文),
   * 缺失/坏了就回退环境变量。**不在这里重启/重建引擎** —— client 的引用在下面注入,
   * 面板热替换只换 registry 里的那一格。
   * ⚠️ 放在崩溃钩子**之后**读盘/解封:DPAPI 走 PowerShell,万一出意外也要有栈可查。
   */
  const modelDataDir = path.dirname(String(config.policy?.stats?.dbFile ?? path.join(ROOT_DIR, 'data', 'state.db')));
  const llmSettings = createLlmSettings({
    file: path.join(modelDataDir, MODEL_SLOTS_FILE),
    env: process.env,
    secretBox: createDpapiSecretBox(),
    log,
  });
  llmSettings.load();
  // **文件热加载(2026-10-18)**:CLI / 桌面控制台改写 `data\<bot>\model-slots.json` 后
  //  下一轮生效、不重启;坏文件只 warn 一行、继续用当前配置(见 llm-settings.js 的 reload())。
  //  ⚠️ 盯的是**目录**,原子 rename 在 Windows 上会把盯文件本身的 watcher 断掉。
  llmSettings.watch();

  // Refuse to run alongside another live bridge (see src/lock.js). The path is
  // configurable so a second bot (副实例) can run from this same checkout.
  // ⚠️ 传 log:死锁("锁在、进程死了")会被**自动接管**并记一行 —— 那是 D191 那次
  //    "面板整段时间起不来"的关键线索,不记下来下一次又要从头查。
  const lock = acquireLock(config.lockFile, { log: (line) => log.warn(line) });
  process.on('exit', () => lock.release());
  // 退出路径统一关热加载 watcher(测试/restart 会在同一 data 目录反复起进程)。不许抛。
  process.on('exit', () => {
    try { llmSettings.close(); } catch { /* 退出路径不许抛 */ }
  });

  // The version the running code claims, plus a drift check against the
  // changelog. The changelog is the only version history this project has (no
  // git), and a future narrator bot will announce the newest entry — so a
  // mismatch between the two is worth shouting about at startup rather than
  // discovering it from a wrong announcement.
  const version = readPackageVersion();
  const latest = readLatestRelease();
  if (latest && latest.version.replace(/^v/, '') !== version.replace(/^v/, '')) {
    log.warn(`版本不一致：package.json=${version}，CHANGELOG 最新=${latest.version} —— 播报会用错版本`);
  }

  // ⚠️ **横幅只报生效值**(2026-10-17 / D236)。这一行曾经报 `profile=`/`provider/model=` ——
  //    那三项全是已退役 DSH 连接段的配置(`config.dsh.command/profile/optional/provider/model`
  //    在 own 单一引擎后**一个消费者都没有**),而**真的答 QQ 的那个模型**是
  //    `config.engine.llm.model`。症状:同一次启动横幅报 `deepseek-official/deepseek-flash`、
  //    24 行后 `[引擎] own 路生效值` 报 `deepseek-chat` —— 两条都在同一份日志里打架。
  //    而横幅是**唯一被写进判据的启动证据**(docs\05:判据 = 横幅 `version=x.y.z`)⇒
  //    它报一个不生效的模型名,等于把"验过了"变成验了个假的。
  {
    const modelInfo = llmSettings.info();
    const llm = modelInfo.slots.bot;
    log.info(`bridge 启动：version=${version} cwd=${config.dsh.cwd} model=${llm.model}`);
    log.info(`[模型] bot=${llm.provider}/${llm.model} source=${llm.source}`
      + ` | dream=${modelInfo.slots.dream.configured ? `${modelInfo.slots.dream.provider}/${modelInfo.slots.dream.model}` : '未配置'}`
      + ` (${modelInfo.file})`);
    // 判据:这一行证明热加载监听真的开了(改文件后下一轮生效,不用重启)。
    log.info(`[模型] 热加载监听已开: ${modelInfo.file}`);
  }
  if (config.qq.sandbox) log.info('沙箱模式：只有沙箱白名单成员能触发机器人');

  const { mode, ids } = config.policy.access;
  const count = ids?.size ?? 0;
  if (mode === 'allowlist') {
    log.info(count > 0
      ? `发送者白名单：仅 ${count} 个 openid 可以对话`
      : '发送者白名单为空 —— 不会回应任何人（fail closed）。要对话就把你的 openid 填进 QQBOT_IDS');
  } else if (mode === 'blocklist') {
    log.info(`发送者黑名单：${count} 个 openid 被屏蔽，其他人均可对话`);
    if (count === 0) log.warn('黑名单为空 —— 等同于对所有人开放');
  } else {
    log.warn('QQBOT_ACCESS_MODE=open：任何能给机器人发消息的 QQ 用户都可以对话，并消耗你的 token');
  }

  if (config.policy.group.mode === 'auto') {
    log.info(
      `群聊自发发言：开启（安静 ${config.policy.group.debounceMs}ms 后考虑，` +
      `至少 ${config.policy.group.minMessages} 条新消息，` +
      `无人搭话冷却 ${Math.round(config.policy.group.cooldownMs / 1000)}s，` +
      `被搭话冷却 ${Math.round(config.policy.group.engagedCooldownMs / 1000)}s，` +
      `对话窗口 ${Math.round(config.policy.group.windowMs / 1000)}s）`,
    );
    if (config.policy.group.keywords.length > 0) {
      log.info(`关键词立刻回复：${config.policy.group.keywords.join('、')}（跳过防抖与条数门槛，仍受冷却限制）`);
    } else {
      log.info('关键词立刻回复：已关闭');
    }
    log.warn('自发发言无法用被动回复，会计入主动消息配额（单群 20/qpm、每天 1000 条）');
    // 读空气这道闸要**在横幅里说出来**:否则事后看日志只会觉得"她怎么突然不接话了"。
    log.info(
      config.policy.group.gapMs > 0
        ? `读空气：开启（别人还在连着说话时不插话 —— 要等群安静 ${Math.round(config.policy.group.gapMs / 1000)}s；` +
          `被 @ / 关键词 / 第二人称不受影响；保险丝 ${Math.round(config.policy.group.gapMaxWaitMs / 60000)} 分钟）`
        : '读空气：关闭（QQBOT_GROUP_GAP_MS=0）—— 防抖一过就可能插在别人对话中间',
    );
  } else {
    log.info('群聊模式：只在被 @ 时回复；非 @ 消息只缓冲为上下文，不产生模型调用');
  }
  if (config.policy.group.mode === 'auto') {
    // The switch is NOT in the developer console — see the README.
    log.info('要收到非 @ 的群消息，需由群主在 QQ 群设置里把「机器人可获取的群聊消息范围」设为「获取群内全部消息」（每个群单独设置）');
  }

  const warmup = config.policy.warmup;
  if (warmup.enabled) {
    const sleepText = warmup.sleep
      ? `${String(warmup.sleep.start).padStart(2, '0')}:00-${String(warmup.sleep.end).padStart(2, '0')}:00`
      : '未设置（全天可暖群）';
    const percent = (value) => `${Math.round(value * 100)}%`;
    const schedule = warmup.mode === 'random'
      ? `模式=随机槽，每 ${Math.round(warmup.slotMs / 60_000)} 分钟一个槽，` +
        `槽内命中概率 ${percent(warmup.chance)}（连续没人接话减半，最低 ${percent(warmup.minChance)}）`
      : `模式=固定间隔，每 ${Math.round(warmup.intervalMs / 60_000)} 分钟一次`;
    log.info(
      `暖群：开启（${schedule}，` +
      `群安静 ${Math.round(warmup.quietMs / 60_000)} 分钟后才暖，` +
      `自己发言后 ${Math.round(warmup.gapMs / 60_000)} 分钟内不暖，睡眠时段 ${sleepText}）`,
    );
    if (!warmup.sleep) log.warn('未设置 QQBOT_WARMUP_SLEEP，机器人会在深夜也主动发言');
    if (warmup.mealWindows.length === 0) {
      log.info('暖群吃饭话题：不限制时段（QQBOT_WARMUP_MEAL_HOURS 为空）');
    } else {
      log.info(`暖群吃饭话题限定时段：${warmup.mealWindows.map((w) => `${w.start}-${w.end} 点`).join('、')}`);
    }
  } else {
    log.info('暖群：关闭（QQBOT_WARMUP=false）');
  }

  // 「她自己的生活在转」(D99 阶段 2)。它在启动横幅里必须有一行 ——
  // 否则"她今天怎么一句话都没自己说"只能靠翻代码判断是关了还是没触发。
  // ⚠️ **别用上面暖群那段的 `percent`**:那是那个 `if` 块里的局部名,这里引用会
  //    `ReferenceError: percent is not defined` —— 而它**发生在锁之后、横幅之前**,
  //    于是单实例锁那条"安全启动"永远看不到它(2026-10-02 真启动抓到,重启直接把主实例弄下线了)。
  const selfcare = config.policy.selfcare;
  if (selfcare?.enabled) {
    log.info(
      `她自己的生活：开启（安静 ${Math.round(selfcare.quietMs / 60_000)} 分钟后轮到她；` +
      `饱食 <${selfcare.hungryBelow} 就自己去吃饭（花自己的钱）；` +
      `不饿时每 ${Math.round(selfcare.lifeEveryMs / 60_000)} 分钟里 ${Math.round(selfcare.lifeChance * 100)}% 概率冒个泡；` +
      `（同一道闸门也管"她自己走去别处"——活动不在她现在待的地方时先走一趟，到了再补一句）` +
      `两条主动消息至少隔 ${Math.round(selfcare.gapMs / 60_000)} 分钟；` +
      `不饿时抛的**事件钩子**等回应 ${Math.round(STORY_TTL_MS / 60_000)} 分钟、过点她自己收尾；` +
      `报备（吃饭/到了）发往 ${selfcare.c2cTarget ? '私聊操作者' : '已知群'}；` +
      `自发发言（${LIFE_ACTIVITIES.length} 条活动，其中 ${LIFE_ACTIVITIES.filter((row) => isStoryActivity(row)).length} 条抛钩子）` +
      `发往 ${selfcare.lifeTo === 'c2c' ? '私聊操作者（QQBOT_SELFCARE_LIFE_TO=c2c）' : '已知安静群（最近活跃过的优先），没有就回落私聊'}` +
      `；指定群 ${selfcare.group ? `${selfcare.group.slice(0, 8)}…（QQBOT_SELFCARE_GROUP）` : '未指定'}）`,
    );
  } else {
    log.info('她自己的生活：关闭（QQBOT_SELFCARE=false）');
  }

  const mood = config.policy.mood;
  // 这一轮"情绪怎么起伏"用哪只角色的谱。副实例用的是 `aris` 主题 ——
  // 她那套里没有懒散、没有中二、没有讨饭,理由见 `src/mood.js` 的说明与 D31。
  const moodTheme = getMoodTheme(mood.theme);
  if (mood.enabled) {
    const share = Object.entries(moodTheme.basePool)
      .filter(([id]) => moodTheme.chunibyouShareMoods.includes(id))
      .reduce((sum, [, weight]) => sum + weight, 0);
    const flavor = moodTheme.chunibyouShareMoods.length > 0 ? `，中二类合计 ${share}%` : '，无中二/无低能量情绪';
    log.info(
      `情绪：开启（主题 ${mood.theme}·${moodTheme.label}；每轮掷骰，` +
      `${Object.keys(moodTheme.basePool).length} 种日常情绪${flavor}；` +
      `一个情绪持续 ${Math.round(mood.ttlMs / 60_000)} 分钟；颜文字概率 ${Math.round(mood.kaomojiChance * 100)}%；` +
      // ⚠️ 1.106.2(D174):这里**不再是"截断"** —— 发言改成按上限**分条发**(一个字不丢)。
      //    ⚠️ 1.171.0(D288):普通发言**统一**分条(答话不再例外);开关 = QQBOT_SPOKEN_SPLIT。
      `发言${config.policy.spoken.enabled ? '按短句分条发（口语标点清理+段间自然间隔）' : '不分条（QQBOT_SPOKEN_SPLIT=0）'}）`,
    );
  } else {
    log.info('情绪：关闭（QQBOT_MOOD=false）—— 语气完全由角色卡决定');
  }

  const morning = config.policy.morning;  if (morning.time) {
    const at = `${String(morning.time.hour).padStart(2, '0')}:${String(morning.time.minute).padStart(2, '0')}`;
    const targets = [morning.c2cTarget ? '私聊 1 个' : null, '所有已知群聊'].filter(Boolean).join(' + ');
    log.info(`早安问候：每天 ${at}（宽限 ${Math.round(morning.graceMs / 60_000)} 分钟，发往 ${targets}）`);
    if (!morning.c2cTarget) log.info('早安问候：未设置 QQBOT_MORNING_C2C，不会有私聊问候');
  } else {
    log.info('早安问候：关闭（QQBOT_MORNING 为空）');
  }

  // 注意顺序:**状态库与这几行诊断在鉴权之前**。
  //
  // 它们只依赖本地配置与状态库,和 QQ 连接没有任何关系;而"副本 + 假凭据跑一次
  // 启动前缀"这套烟测(§6.4)正是靠它们来覆盖 main() 的装配 —— 放在 tokens.get()
  // 之后的话,假凭据会在第 10004 号错误上停下,这几行永远不会被执行,
  // 于是"测试全绿、一启动就崩"的老毛病又回来了。
  const tokens = new TokenManager(config.qq);
  // **数值框架**(2026-10-28 主人拍板:生物体/机械体两套)—— 按身体主题注入到 store,
  // 于是所有 getStats/applyIntake/互动/事件结算都自动用本角色那一套;
  // 未配置/主实例 = 生物体(旧行为一字不变),认不出的主题当场抛(body-rules 纪律)。
  const bodyRules = bodyRulesForTheme(config.policy.stats.theme);
  const stateStore = new SqliteStateStore(config.policy.stats.dbFile, {
    legacyJsonPath: config.legacyStateFile,
    bodyRules,
  });
  log.info(`[数值] 框架=${bodyRules.kind}（${bodyRules.label}）`);

  // 这个横幅曾经放在 stateStore 之前,结果是个 TDZ 崩溃。**诊断行不许拖垮启动**,所以包一层。
  try {
    if (config.policy.stats.enabled) {
      const stats = stateStore.getStats(Date.now(), { sleep: config.policy.warmup.sleep });
      const body = getBodyTheme(config.policy.stats.theme);
      log.info(
        `身体状态：开启（${body.values.satiety.short} ${Math.round(stats.satiety)}/100、` +
        `${body.values.health.short} ${Math.round(stats.health)}/100、` +
        `${body.values.mood.short} ${Math.round(stats.mood)}/100、` +
        `${CURRENCY.name} ${Math.round(stats.money ?? 0)}；口径=${body.id}；库=${config.policy.stats.dbFile}；` +
        '数值只进提示词，群友看不到 —— `/状态` 可查，报数留给以后的日志机器人）',
      );
      const eco = config.policy.economy ?? {};
      if (eco.enabled) {
        log.info(
          `经济：开启（${CURRENCY.name}会随时间花掉：清醒 ${MONEY_DECAY.perHourAwake}/小时、` +
          `睡觉 ${MONEY_DECAY.perHourAsleep}/小时 —— 住宿·杂用·魔杖保养油；` +
          `吃东西按热量扣 ${ERIS_PER_KCAL} ${CURRENCY.name}/kcal（**别人请的免单**）；` +
          // ⚠️ **被投喂那 +8 已在 D99 整条拿掉**(用户原话:「正常投喂不应该加钱」)——
          //    钱只从她的世界来(委托),也只回她的世界去(商店/餐厅)。被夸那 +3 是 D96 拿掉的。
          `进项只有**公会委托**（${eco.tasks ? '开' : '关'}）与随机小事件（${eco.events ? '开' : '关'}）；` +
          `穷的线是 ${MONEY_POOR} ${CURRENCY.name} —— 高于它就不该提穷；\`/钱包\` 她会自己说一句(数字说了会核对)）`,
        );
      } else {
        log.info('经济：关闭（QQBOT_ECONOMY=false）—— 钱不进出，她也就没有"穷"的依据');
      }
    } else {
      log.info('身体状态：关闭（QQBOT_STATS=false）');
    }
    if (config.policy.growth.enabled) {
      const growth = stateStore.getGrowth(Date.now());
      log.info(
        `养成：开启（${describeGrowthForUser(growth)}；经验 ` +
        `${Object.entries(XP_RULES).map(([kind, xp]) => `${describeTurnKind(kind)}=${xp}`).join(' ')}；` +
        `新概念 +${CONCEPT_BONUS}（词表 ${CONCEPT_WORDS.length} 个）；` +
        `库=${config.policy.stats.dbFile}）`,
      );
      const channelText = {
        both: '里程碑发群里那句 + 每级私聊账单',
        c2c: '只发私聊账单（群里不打扰）',
        group: '只发群里那句（普通升级不通知）',
        off: '完全不发（只进她的状态栏）',
      }[config.policy.growth.announce];
      log.info(
        `养成：升级播报=${config.policy.growth.announce}（${channelText}）；` +
        `里程碑在 Lv.${MILESTONE_LEVELS.join(' / ')}；下一个是 ` +
        `${nextMilestoneAfter(growth.level) ?? '（已到最后一个）'}`,
      );
    } else {
      log.info('养成：关闭（QQBOT_GROWTH=false）');
    }
    if (config.policy.reportStatsDb) {
      log.info(`状态汇报：读别的实例的库（只读）${config.policy.reportStatsDb}`);
    }
    if (config.policy.announce.enabled) {
      const release = readLatestRelease();
      const cfg = config.policy.announce;
      // ⚠️ 触发方式的人话由 `describeAnnounceTrigger()` 出 —— 这里曾经把 `confirm`
      //    (D50 之后的默认)打成「自动（启动 + 定时）」,用户 2026-09-28 看到基线
      //    自己动了,第一反应就是"是不是她自动发的"。诊断工具不许说谎。
      log.info(
        `更新播报：开启（模式 ${cfg.mode}，目标 ${cfg.targets}，触发 ${describeAnnounceTrigger(cfg.trigger)}；` +
        `最新版本 ${release?.version ?? '读不到'}，已播报 ${stateStore.getMeta('announced_version') || '无'}）`,
      );
      if (cfg.trigger === 'confirm') {
        log.info(
          '更新播报：**不会自己发** —— 有没播报的内容时她会私聊问你一声；' +
          '回 `/发`（私聊+全部群）/ `/发 私聊` / `/发 群 2` / `/不发`。' +
          '改完 CHANGELOG 但还不想发就打 `/不发`。',
        );
      }
      if (cfg.trigger === 'manual') {
        const operators = [...operatorIds()];
        if (operators.length === 0) {
          log.warn(
            '更新播报：手动模式，但**没有操作者** —— 配 QQBOT_ADMIN_IDS，' +
            '或填 QQBOT_ANNOUNCE_C2C / QQBOT_MORNING_C2C。否则 `/更新` 谁打都没用',
          );
        } else {
          log.info(`更新播报：操作者 ${operators.length} 个（私聊 /更新 才生效；` +
            '`/群列表` 看群编号，`/更新 2` 只发那个群，`/更新 预览` 只发私聊）');
        }
      }
    }
  } catch (err) {
    log.warn(`身体状态初始化失败（不影响聊天）: ${describeError(err)}`);
  }

  // ---------------------------------------------------------------------------
  // 记忆(D39):**"重启不失忆"就靠这一段。**
  //
  // `dsh` 不能恢复既有会话 —— 每代新会话都从零开始(见 `src/dsh.js` 的 `#resolveSession`)。
  // 所以记忆必须由 bridge 自己带上:
  //   1. 启动时把散落的孤儿会话收进 memory.db(增量、幂等);
  //   2. 每代会话的**第一轮**,把"这个会话之前聊过什么"注入提示词。
  //
  // 全部尽力而为:记忆出任何问题都只记一条警告,**绝不能让对话起不来**。
  // ---------------------------------------------------------------------------
  const memoryCfg = config.policy.memory;
  let memoryDb = null;
  let archiveRunner = null; // 给"定期补归档"那一拍用(见下面的 memoryArchiveTick)
  const handoffSuppressed = new Set(); // `/重置` 之后那一轮不交接(否则重置就等于没重置)

  /**
   * **认识的人的名字**(2026-10-01,D78):给标签层"先把昵称遮住、再当人"用。
   *
   * 现场:群友昵称「**饭否**」出现在「用白丝脚踩饭否」里,而词表有「饭」→ 这一轮被打上 `food`。
   * 昵称不是"她吃了什么",是"**她认识的人**"。所以人名表要**每轮现读**(它是边聊边学的:
   * 今天才认识的人,昨天的那些话也要跟着改过来 —— 那由 `retagAll` 负责)。
   */
  function knownPeopleNames() {
    try {
      return stateStore.people({ limit: 500 }).map((person) => person.display).filter(Boolean);
    } catch (err) {
      log.warn(`读"认识的人"失败（只影响昵称识别，不影响对话）: ${describeError(err)}`);
      return [];
    }
  }

  /**
   * **实体名单**(P1-F,2026-10-19):检索时"query 里出现了这些名字"就给 mention 过
   * 这些名字的轮次加分。来源 = 认识的人(person.display)+ 学会的概念(concept.label)。
   * 与人名表同一套纪律:**每轮现读**(边聊边学,今天学会的概念今天的召回就要认);
   * 读失败只影响实体那一维,不影响对话(与 knownPeopleNames 同族)。
   */
  function entityNamesForRecall() {
    const names = knownPeopleNames().map((name) => ({ name, kind: 'person' }));
    try {
      for (const concept of stateStore.concepts(200)) {
        if (concept?.label) names.push({ name: String(concept.label), kind: 'concept' });
      }
    } catch (err) {
      log.warn(`读"学会的概念"失败（只影响实体共现，不影响对话）: ${describeError(err)}`);
    }
    return names;
  }

  /**
   * **本机出图的那一步:用 `scripts\sprite-draw.py` 画一张她的像素图**(2026-10-09)。
   *
   * ⚠️ **Pillow 不是本仓库的依赖**(python 脚本里写着"先 pip install Pillow"),所以这里要
   *    **自己找解释器**,而且找错时报清楚:
   *    · `QQBOT_PYTHON` 指哪个就用哪个(最高优先);
   *    · 其次是 **DSH 自带的那个 python**(`~\.dsh\dsh-runtimes\*\dependencies\python\python.exe`)——
   *      实测它**自带 Pillow 12.3.0**,所以在这台机器上开箱可用;
   *    · 最后回落 PATH 上的 `python`(用户自己装的 3.14 没有 Pillow,会走到报错那条)。
   *
   * @returns {Promise<{ok: boolean, path?: string, python?: string, error?: string}>}
   */
  async function drawSprite(outPath) {
    const candidates = [];
    if (process.env.QQBOT_PYTHON) candidates.push(process.env.QQBOT_PYTHON);
    // ⚠️ DSH 自带的运行时**可能**在机器人私有 home 下,也可能在全局 `~\.dsh` 下(两台机器人的
    //    home 是隔离的,而运行时是共享的)—— 两个都找一遍,不写死一条路径。
    const runtimeRoots = [];
    try {
      const botHome = resolveBotHome(import.meta.url);
      if (botHome) runtimeRoots.push(botHome);
    } catch { /* 解析不出来就跳过 */ }
    try {
      runtimeRoots.push(path.join(os.homedir(), '.dsh'));
    } catch { /* 同上 */ }
    for (const root of new Set(runtimeRoots)) {
      const deps = path.join(root, 'dsh-runtimes');
      try {
        for (const entry of fs.readdirSync(deps, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(deps, entry.name, 'dependencies', 'python', 'python.exe');
          if (fs.existsSync(candidate)) candidates.push(candidate);
        }
      } catch { /* 没有那个目录就换下一个 */ }
    }
    candidates.push('python', 'python3');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let lastError = '';
    const tried = [];
    for (const python of candidates) {
      try {
        await new Promise((resolve, reject) => {
          execFile(python, [path.join(ROOT_DIR, 'scripts', 'sprite-draw.py'), '--out', outPath], {
            timeout: 60_000,
            windowsHide: true,
          }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}${stderr ? ` / ${String(stderr).slice(0, 200)}` : ''}`));
            else resolve(String(stdout ?? ''));
          });
        });
      } catch (err) {
        lastError = describeError(err);
        tried.push(`${python}: ${lastError.slice(0, 120)}`);
        continue;
      }
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return { ok: true, path: outPath, python };
      lastError = '脚本跑完了但没有产出图';
      tried.push(`${python}: 没有产出图`);
    }
    return { ok: false, error: tried.join(' ｜ ') || lastError };
  }

  /**
   * `/发图` —— **她自己发一张图出去**(2026-10-09,用户点名"试一下发图")。
   *
   * 为什么选"她的像素形象"当第一张:素材是**代码画出来的**(`sprite-draw.py`,D129 的
   * "画 → 看 → 改"工作流),不依赖任何外部素材,也不会踩版权。
   *
   * ⚠️ **只给操作者**(和 `/认人` 同一条口径):这是"她往群里发东西",口子不能开给所有人
   * —— 否则任何人一句话就能让她刷图。
   * ⚠️ 发出去之后**还要把这张图喂回她这一轮**(`localImageBlock`),否则她发了什么自己都不知道。
   */
  async function handleSendImage(message) {
    if (!isOperator(message)) {
      log.warn(`忽略非操作者的 /发图（sender=${message.senderId ?? '?'}）`);
      await sendChunked(message, '（`/发图` 只给操作者用。）');
      return true;
    }
    const outPath = path.join(ROOT_DIR, 'data', 'index', 'ref', `she-${Date.now()}.png`);
    const drawn = await drawSprite(outPath);
    if (!drawn.ok) {
      log.warn(`/发图：出图失败（${drawn.error}）`);
      await sendChunked(
        message,
        '（图没画出来：本机 python 少了 Pillow，或者 `QQBOT_PYTHON` 指错了。\n' +
        '临时办法：在 `.env` 里写 `QQBOT_PYTHON=<能跑 python scripts\\sprite-draw.py 的那个解释器>`。）',
      );
      return true;
    }
    try {
      const buffer = fs.readFileSync(outPath);
      const fileInfo = await api.uploadFile({
        scene: message.scene === 'c2c' ? 'user' : 'group',
        openid: message.targetId,
        fileName: `${INFRA_CONTENT.primaryName}-${path.basename(outPath)}`,
        buffer,
        fileType: 1,
      });
      await api.sendMedia({
        scene: message.scene === 'c2c' ? 'user' : 'group',
        openid: message.targetId,
        fileInfo,
      });
      log.info(`/发图：已发出（${Math.round(buffer.length / 1024)}KB，用 ${drawn.python} 画）`);
      // 发完**让她自己看一眼** —— 不然她不知道自己刚才发了什么,接话会脱节。
      let imageBlocks = [];
      try {
        imageBlocks = [localImageBlock({ path: outPath, mimeType: 'image/png' })];
      } catch (err) {
        log.warn(`/发图：把图喂回模型失败（不影响已发出的图）: ${describeError(err)}`);
      }
      const conversationKey = sessionIdFor(message);
      const mood = moodFor(conversationKey, message.content);
      const result = await runner.runTurn(
        conversationKey,
        `${withSceneTag(message, config.policy.promptContext, groupContext)}\n\n` +
        '（上面那张图是**你刚刚发出去的** —— 你自己画的像素形象。用一句话说说它，别解释来源。）',
        config.policy.replyTimeoutMs,
        imageBlocks,
      );
      const body = composeReply(result, message, { hasImage: false });
      await sendChunked(message, body, { typing: true });
      log.info(`/发图：她补了一句（${body.length} 字）`);
    } catch (err) {
      log.error('/发图 失败', err);
      await sendChunked(message, `（图发不出去：${describeUserError(err)}）`).catch(() => {});
    } finally {
      try { fs.rmSync(outPath, { force: true }); } catch { /* 删不掉不影响主流程 */ }
    }
    return true;
  }

  /**
   * `/认人 [@某人 名字] …` —— **手工补"认识的人"**(2026-10-01,见 `docs\03` D78)。
   *
   * 为什么需要:平台**没有群成员名单**,昵称只随消息给 —— 没说过话的人她永远不认识
   * (现场:群友「饭否」被提到,而她库里没有他)。所以给操作者一条补名单的路:
   * 名字可以从 @ 的元数据里取(有则用),也可以显式给;一条消息 @ 多个人就按顺序给名字。
   *
   * ⚠️ 只在**群里** + 只给**操作者**:它写的是"这个群里谁是谁"的事实(按群作用域,见 D09)。
   */
  async function handleLearnPerson(message) {
    if (message.scene !== 'group') {
      await sendChunked(message, '（`/认人` 只在群里用 —— 认识的人按**群**分开记，私聊里没有"群成员"这回事。）');
      return true;
    }
    if (!isOperator(message)) {
      log.warn(`忽略非操作者的 /认人（sender=${message.senderId ?? '?'}）`);
      await sendChunked(message, '（`/认人` 只给操作者用。）');
      return true;
    }
    const scope = `group:${message.targetId}`;
    const mentions = (message.mentions ?? []).filter((entry) => entry.bot !== true && entry.id);
    const words = String(message.content)
      .replace(/^\/认人|^\/知人/, ' ')
      .replace(/<@!?[^>]*>/g, ' ')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word !== '');

    if (mentions.length === 0) {
      const people = stateStore.people({ scope, limit: 50 });
      const names = people.map((person) => person.display || '(无名)').join('、');
      await sendChunked(
        message,
        `（这个群我认识 ${people.length} 个人：${names || '还没有记下任何人'}）\n` +
        '用法：`/认人 @某人 名字`（名字可以省 —— 我从 @ 的元数据里取；@ 多个人就按顺序给名字）',
      );
      return true;
    }
    if (words.length > 0 && words.length !== mentions.length) {
      await sendChunked(
        message,
        `（@ 了 ${mentions.length} 个人，但给了 ${words.length} 个名字 —— 数量要对上；或者不写名字，我从元数据里取。）`,
      );
      return true;
    }
    const learned = [];
    for (const [index, mention] of mentions.entries()) {
      const display = words[index] ?? mention.username ?? null;
      if (!display) {
        learned.push(`${String(mention.id).slice(0, 8)}…（没有名字，补一个：/认人 @他 名字）`);
        continue;
      }
      const saved = stateStore.touchPerson({ scope, openid: mention.id, display, scene: 'group' });
      learned.push(`${display}${saved?.isNew ? '（新）' : '（已记过）'}`);
    }
    log.info(`/认人：${learned.join('、')}（群 ${String(message.targetId).slice(0, 8)}…）`);
    await sendChunked(
      message,
      `（记下了：${learned.join('、')}。以后提到这些名字我就当是**人**，不会把名字里的字当成别的东西。）`,
    );
    return true;
  }

  // ---------------------------------------------------------------------------
  // 关于人的事实:关系 / 偏好 / 雷区 / 健康(2026-10-01,见 `docs\03` D79)
  //
  // 用户定的四个维度 + **两个入口**:①他当场说的(这里);②历史回扫(`profile-scan.js`)。
  // 它们存 `state.db` 的 `fact` 表 —— 判据和 `person` 一样:**重建之后还该成立的是事实**。
  // ---------------------------------------------------------------------------

  /** 咏唱技能(D82):每段会话各自的冷却与"最近放过哪一版"(进程内即可)。 */
  const explosionCooldown = new Map();
  const explosionRecentChants = new Map();
  const explosionRecentFinishers = new Map();
  /**
   * QQ 的被动回复(`msg_id` + `msg_seq`)一条入站消息**最多 5 条**(序号 1–5)。
   * 所以"咏唱分句 + 结束词"总数不能超过它 —— 见 `explosionBeatsMax`。
   */
  const MAX_PASSIVE_SEQ = 5;

  /**
   * 滚动摘要那一拍往回扫多少条 `stats_event`(1.106.4 / D176)。
   *
   * ⚠️ 这是**扫描上限**,不是"记忆深度":真正决定"记哪几件"的是
   * `pickSpecialEntries()` 的 24 小时窗口 + 分量门槛。200 条足够盖住一天
   * (实测她一天几十条流水),不够只会少挑,不会挑错。
   */
  const SPECIAL_SCAN_EVENTS = 200;

  /** 旁白的每群冷却(D88):同一群连续两发咏唱技能,别把旁白也刷成两条。 */
  const narrationLastAt = new Map();

  /**
   * 自发重查(D90):每群"上次重查的时刻"与"连续跳过几次"。
   * 跳过一次就退避一档(2× → 3× → 4×),一开口立刻归零 —— 看了不想说,就说明这时候不该多嘴。
   */
  const lastSocialRecheckAt = new Map();
  const socialRecheckSkips = new Map();

  /**
   * **咏唱技能旁白**(2026-10-01,D88):副实例看见主实例的结束词就写一段播报。
   *
   * ⚠️ 三条边界:
   *   · **不记账**:不算"被搭话"、不动副实例的数值(那条消息不是真人说的);
   *   · **不落库**:旁白是表演,不记 fact/note、不进任何记忆;
   *   · **失败无害**:出错了只记一条警告,群里什么都不发(宁可没有旁白,也不许发半句)。
   */
  async function narrateExplosion(message, { force = false } = {}) {
    // ⚠️ **整个函数不许抛**(2026-10-01 现场:里面抛了个 ReferenceError,变成未处理的 Promise
    //    拒绝 —— "失败无害"那一句当时是空话)。所有路径都在这个 try 里。
    try {
      if (!config.policy.narration.enabled) return;
      const key = message.targetId;
      const now = Date.now();
      if (!force && now - (narrationLastAt.get(key) ?? 0) < config.policy.narration.cooldownMs) {
        log.info('旁白：冷却中，这次不写');
        return;
      }
      narrationLastAt.set(key, now);
      const caster = resolveCasterName(stateStore.getMeta('foreign_bot_ids'), message.senderId);
      const prompt = buildNarrationPrompt({
        finisher: message.content,
        botName: gateway.botName,
        // ⚠️ 名字从**状态库现读**(`knownBots` 那个变量在别的块作用域里,不能用 —— 见 D88 的复盘)。
        caster,
      });
      // ⚠️ **生成与发送分两步记日志**(2026-10-01 现场:一个群成功、另一个群失败 ——
      //    原来是"发送"撞上 api.bot.qq.com 连接超时,但日志只写了一句笼统的"旁白失败")。
      let spoken = '';
      try {
        const turn = await runner.runTurn(conversationKeyFor(message), prompt, config.policy.narration.timeoutMs);
        spoken = sanitizeOutgoingText(turn?.text ?? '', { names: outgoingNameLabels() }).trim();
      } catch (err) {
        log.warn(`旁白：**生成**那一步失败，这次没有旁白: ${describeError(err)}`);
        return;
      }
      if (spoken === '') {
        log.warn('旁白：模型没写出东西，这次跳过');
        return;
      }
      // 发送:**瞬时故障要重试**(连接超时那种,重试一次基本就过)。
      await retryAsync(
        () => sendChunked(message, spoken),
        {
          attempts: 3,
          delayMs: 1500,
          onError: (error, attempt) => log.warn(`旁白：发送第 ${attempt}/3 次失败: ${describeError(error)}`),
        },
      ).then(
        () => log.info(`旁白：给 ${caster} 那发${INFRA_CONTENT.skillName}写了 ${spoken.length} 字 → 群 ${String(message.targetId).slice(0, 8)}…`),
        (error) => log.warn(`旁白：**发送**三次都没成功，这段丢弃（它是玩笑，不值得再排队）: ${describeError(error)}`),
      );
    } catch (err) {
      log.warn(`旁白失败（群里不发任何东西）: ${describeError(err)}`);
    }
  }

  /**
   * `/忘了 [维度] [值]` —— **撤销**记错的事实(2026-10-01,D81)。
   *
   * 权限(2026-10-01 定的规矩):**只能删"你自己"那一条**。
   * 私聊里 subject 就是 `self`,所以操作者能删自己的;
   * 群里 subject 是发言人的 `member_openid` —— 而**操作者名单是私聊的 id 空间**
   * (每个群的 member_openid 还不一样),在群里天然对不上,所以群里谁也不能删别人的。
   * 别人的记错了 → 在后台用 `state.db` 改(这条路写在 docs\04)。
   *
   * ⚠️ 回执必须**列出删掉了什么**:这是记忆,删错了不可逆,一句"删好了"没法核对。
   */
  async function handleForget(message) {
    const isGroup = message.scene === 'group';
    const scope = isGroup ? `group:${message.targetId}` : `c2c:${config.qq.appId}`;
    const subject = isGroup ? message.senderId : 'self';
    const parsed = parseForget(message.content);
    const mine = stateStore.facts({ scope, subject, limit: 50 });
    // 固化记忆(note)是**按会话**存的,不是按人 —— 所以只能在私聊里让人删:
    // 群里那一段是大家共用的上下文(而且群里认不出操作者身份),让任何群员清空不合适。
    const conversation = conversationKeyFor(message);
    const notes = !isGroup && memoryDb && parsed.kind === 'note' ? notesOf(memoryDb, { conversation, limit: 20 }) : [];

    // 只给维度 / 没给参数 → 列出来让人照着删(不猜他要删哪条)。
    if (parsed.reason === 'empty' || parsed.reason === 'no-value' || parsed.reason === 'unknown-kind') {
      const pool = parsed.kind ? mine.filter((fact) => fact.kind === parsed.kind) : mine;
      const head = parsed.reason === 'unknown-kind'
        ? `（「${parsed.word}」不是一个维度。能删的是：关系 / 偏好 / 雷区 / 健康 / 记忆 / 摘要。）`
        : '';
      const listText = pool.length > 0
        ? pool.map((fact) => `· ${describeFact(fact)}`).join('\n')
        : '（关于你的事实，我什么都没记）';
      const notesText = !isGroup && memoryDb
        ? `\n她记着的事（${notesOf(memoryDb, { conversation, limit: 10 }).length} 条里最近的）：\n` +
          (notesOf(memoryDb, { conversation, limit: 10 }).map((note) => `· [${note.tier}] ${String(note.text).slice(0, 30)}`).join('\n') || '（没有）')
        : '（群里的记忆只有后台能改）';
      // 第三层(滚动摘要,D91)也要**看得见、删得掉** —— 与 note 同一条纪律。
      const summaryNow = !isGroup && memoryDb ? getSummary(memoryDb, conversation) : null;
      const summaryText = !isGroup && memoryDb
        ? `\n滚动摘要：${summaryNow
          ? `${summaryNow.text.length} 字、覆盖到 ${summaryNow.coveredTurns} 轮、规则 v${summaryNow.version}`
          : '还没有（攒够轮次才回算）'}　要删：\`/忘了 摘要\``
        : '';
      await sendChunked(
        message,
        `${head}${head ? '\n' : ''}我记得的（关于你）：\n${listText}${notesText}${summaryText}\n` +
        '要删哪条：`/忘了 健康 胃炎`、`/忘了 记忆 琪露诺`、`/忘了 摘要`（`/忘了 全部` 清空关于你的事实）',
      );
      return true;
    }

    // `摘要` 这一维删的是**滚动摘要**(summary,D91 的小尾巴)。
    // 与 note 同一条规矩:它是**按会话**算的(群里那一段是大家共用的上下文,而且群里认不出操作者),
    // 所以只能在私聊里删。
    if (parsed.kind === 'summary') {
      if (isGroup || !memoryDb) {
        await sendChunked(message, '（滚动摘要是按会话整段算的，群里改不了 —— 要改请在后台处理，见 docs\\04。）');
        return true;
      }
      if (parsed.value) {
        await sendChunked(message, '（摘要只有一份，直接发 `/忘了 摘要` 就行。）');
        return true;
      }
      const removed = forgetSummary(memoryDb, conversation);
      if (!removed) {
        await sendChunked(message, '（这一段还没有摘要 —— 攒够轮次才会回算，用 `/忘了` 能看它现在的状况。）');
        return true;
      }
      log.info(
        `/忘了 摘要：删掉一份（${conversation}，${removed.text.length} 字 / 覆盖 ${removed.coveredTurns} 轮）`,
      );
      await sendChunked(
        message,
        `（忘了这一段摘要：${removed.text.length} 字、覆盖到 ${removed.coveredTurns} 轮。\n` +
        '⚠️ 删掉不等于失忆：它是**可重建**的，下一拍会按当前规则重算；在那之前，\n' +
        '更早的那一段暂时回到"最近几轮原文"这一层。）',
      );
      return true;
    }

    // `记忆` 这一维删的是**固化记忆**(note),其余删的是事实(fact)。
    if (parsed.kind === 'note') {
      if (isGroup || !memoryDb) {
        await sendChunked(message, '（固化记忆是按会话整段记的，群里改不了 —— 要改请在后台处理，见 docs\\04。）');
        return true;
      }
      const removed = forgetNotes(memoryDb, { conversation, value: parsed.value });
      if (removed.length === 0) {
        await sendChunked(message, `（她记着的事里没有含「${parsed.value}」的 —— 用 \`/忘了\` 先看看她都记了什么。）`);
        return true;
      }
      log.info(`/忘了 记忆：删掉 ${removed.length} 条（${conversation}）→ ${removed.map((note) => String(note.text).slice(0, 20)).join('、')}`);
      await sendChunked(
        message,
        `（忘了 ${removed.length} 条她记着的事：\n${removed.map((note) => `· [${note.tier}] ${String(note.text).slice(0, 40)}`).join('\n')}\n` +
        '以后不会再提这些了。）',
      );
      return true;
    }

    // ⚠️ 永远带 `subject` —— 所以 `/忘了 全部` 也只清"你自己"的,删不到别人的。
    const removed = stateStore.forgetFacts({
      scope,
      subject,
      kind: parsed.kind,
      value: parsed.value,
    });
    if (removed.length === 0) {
      const target = parsed.all
        ? '全部'
        : `${labelOf(parsed.kind)}${parsed.value ? ` 里的「${parsed.value}」` : ''}`;
      await sendChunked(
        message,
        `（没找到「${target}」这一条 —— 我记着的是这些：${mine.map((fact) => describeFact(fact)).join('、') || '（空的）'}）`,
      );
      return true;
    }
    log.info(
      `/忘了：删掉 ${removed.length} 条（${scope} subject=${String(subject).slice(0, 8)}…）→ ` +
      removed.map((row) => describeFact(row)).join('、'),
    );
    await sendChunked(
      message,
      `（忘了 ${removed.length} 条：\n${removed.map((row) => `· ${describeFact(row)}`).join('\n')}\n` +
      '以后不会再拿这些说话了。）',
    );
    return true;
  }

/** 「这句看起来在教名字」的信号词 —— 只用来在**没认出命名句**时给一行诊断日志(不回显正文)。 */
const NAMING_HINT = /叫|名字|大名|称呼/;

/**
 * **她这句里有没有"在吃"的迹象** —— 实现搬到 `src\stats.js` 的 `mentionsEating()`(纯函数、可单测)。
 */

  /**
   * 从这一轮的人话里学事实。
   *
   * ⚠️ **群里只认"声明式"的**:@ 了人 + 说了关系词/命名句 ——
   * 群里随口一句「我弟弟今天来我家」不该变成她的事实,否则别人的家常会塞满她的提示词。
   * 私聊那条照记(他说了他自己的事,她当然该记住)。
   * 涉及**她自己**的主张(「我是你哥」)不走这里 —— 那条由她按人设拍板(见 `claimNote`)。
   *
   * ⚠️ **2026-10-09 修的两个 bug(用户报:「@某个群友让她记群友名字她也记不住,都记在我身上」)**:
   *   ① **`subject` 不再无脑等于说话人** —— @ 了**别人**时,这条事实是**关于那个人的**。
   *      现场:2026-10-08 19:07 `酸音盐777:记住 这个人,名字叫江时光` —— 名字挂在了酸音盐777 头上。
   *   ② 新增**命名句**这一类事实(`名字`);旧实现里 `extractFacts('记住 这个人，名字叫江时光')` → `[]`,
   *      所以"记住名字"这件事**根本没有落地的地方**。
   */
  function learnFactsFrom(message) {
    if (!config.policy.growth.enabled) return [];
    const isGroup = message.scene === 'group';
    const scope = isGroup ? `group:${message.targetId}` : `c2c:${config.qq.appId}`;
    if (!scope || !message.senderId) return [];
    const declared = isGroup && Array.isArray(message.mentions) && message.mentions.length > 0;
    if (isGroup && !declared) return []; // 群里只收声明式的
    const text = String(message.content ?? '').trim();
    if (text === '') return [];
    // ⚠️ **"名字挂给谁"由纯函数决定**(`resolveNameTeach`)—— 这段逻辑前两版住在下面几行里,
    //    `main()` 的装配段单测覆盖不到,于是同一个形状漏了两次(用户真跑 `记住 叫泄政章`、
    //    以及"一条消息教两个名字"只认第一个)。
    //    名册(`roster`)传进去,`昵称带波风水门那个叫X` 这种**没 @ 也能对上**的说法才认得出。
    const mentioned = isGroup
      ? (message.mentions ?? []).find((entry) => entry && entry.id && entry.bot !== true && entry.id !== message.senderId)
      : null;
    const roster = isGroup ? stateStore.people({ scope, limit: 300 }) : [];
    const teaches = isGroup || message.scene === 'c2c' ? resolveNameTeach(message, roster) : [];
    const tells = teaches.filter((row) => row.subject !== '');
    const nameSubject = tells.length === 1 ? tells[0].subject : null;
    const subject = nameSubject ?? message.senderId;
    // ⚠️ **诊断不许说谎**(两次修的教训):@了人、这句像在教名字,但**没认出命名句**时要说出来 ——
    //    只报长度与原因,不回显正文。
    if (mentioned && tells.length === 0 && NAMING_HINT.test(text)) {
      log.info(`他 @ 了别人(${String(mentioned.username ?? mentioned.id).slice(0, 12)})像是在教名字，但这句没认出命名句（${text.length} 字）—— 名字没落库`);
    }
    for (const row of teaches) {
      if (row.subject) log.info(`记名字：${row.reason}，记下的名字是「${row.value}」`);
      else if (NAMING_HINT.test(text)) log.info(`看到命名句「${row.value}」但${row.reason}`);
    }
    const facts = extractFacts(text, { subject })
      .filter((fact) => !isGroup || (fact.kind === 'relation' && RELATION_WORDS.includes(fact.value)));
    for (const row of tells) {
      facts.push({ kind: 'name', value: row.value, detail: row.self ? 'self' : null, nameSubject: row.subject });
    }
    const saved = [];
    for (const fact of facts) {
      // 名字事实跟着"这条名字讲的是谁"(每条各自带 `nameSubject`);其余事实仍是说话人自己的
      const factSubject = fact.kind === 'name' ? fact.nameSubject : (isGroup ? message.senderId : 'self');
      if (!factSubject) continue;
      try {
        const result = stateStore.touchFact({
          scope,
          subject: factSubject,
          kind: fact.kind,
          value: fact.value,
          detail: fact.detail,
          source: declared ? 'declared' : 'told',
        });
        if (result) saved.push({ ...fact, isNew: result.isNew, subject: factSubject });
        // P1-C(2026-10-19):他改口了 —— 旧说法只软失效(不物理删),日志要说清"退役了哪几条"。
        if (result?.superseded?.length) {
          log.info(
            `事实更新：${describeFact(fact)}（旧说法 ${result.superseded.map((row) => row.value).join('、')} ` +
            `已软失效、行仍保留可审计）`,
          );
        }
      } catch (err) {
        log.warn(`记"关于人的事实"失败（不影响对话）: ${describeError(err)}`);
      }
    }
    for (const fact of saved) {
      // 名字那一条要说清"这是谁的名字" —— 它就是这次修的 bug,日志里必须看得见
      const who = fact.kind === 'name' && fact.subject !== message.senderId
        ? `（记在 ${String(fact.subject).slice(0, 8)}… 名下，不是说话人）`
        : '';
      log.info(
        `事实（${declared ? '群里声明' : '他说的'}）：${describeFact(fact)}${who}` +
        `（${fact.isNew ? '新记下' : '又见到一次'}）`,
      );
    }
    return saved;
  }

  /** 她**认下**一条关系主张时才落库;不同意就一个字都不记,标记也会被剥掉。 */
  function applyAcceptedRelation(text, message) {
    const { relation, text: cleaned } = extractAccept(text);
    if (!relation) return text;
    const isGroup = message?.scene === 'group';
    const scope = isGroup ? `group:${message?.targetId}` : `c2c:${config.qq.appId}`;
    const subject = isGroup ? message?.senderId : 'self';
    try {
      stateStore.touchFact({ scope, subject, kind: 'relation', value: relation, detail: 'accepted', source: 'told' });
      log.info(`关系主张被认下：${relation}（${isGroup ? '群' : '私聊'}）`);
    } catch (err) {
      log.warn(`关系主张落库失败（不影响这轮回复）: ${describeError(err)}`);
    }
    return cleaned;
  }

  /**
   * 这一轮要注入的"关于他/他们的事实"(160 字预算,顺序 关系→健康→雷区→偏好)。
   *
   * ⚠️ **软维度要"见过两次"才算数**(用户 2026-10-01 说的"偏好按最高频率提取"):
   * 偏好/雷区(hate)只出现一次时很容易是随口一句;关系(声明/认下)与健康是硬事实,立即生效;
   * 明确祈使否定(`forbid`,比如"别叫我小名")是**硬边界**,也立即生效。
   */
  function factsNote(message) {
    if (!config.policy.growth.enabled || !message) return null;
    try {
      const scope = message.scene === 'group' ? `group:${message.targetId}` : `c2c:${config.qq.appId}`;
      // ⚠️ `currentSubject`(2026-10-09):同一段会话里可能有**别人**的事实(见 `learnFactsFrom`)。
      //    传进去之后,渲染会把它单独标成"这是别人的" —— 不加的话"江时光"会被当成说话人的代号。
      const currentSubject = message.scene === 'group' ? message.senderId : 'self';
      // ⚠️ **私聊里两把键都要看**(2026-10-09):私聊的事实历史上都挂 `subject='self'`(库里现存 3 条),
      //    而"有人教的名字"如果按 openid 记,就会**永远端不出来**。
      //    两侧都收(不搬动旧数据),`currentSubject='self'` 保证旧的那些仍算"他自己的",不会被误标成"别人的"。
      // P1-C(2026-10-19):默认只看**仍成立**的事实 —— 被他改口掉的旧说法不进提示词
      // (旧行还在库里、只标了 invalid_at;`QQBOT_MEMORY_LATEST_ONLY=0` 可回 P1-B 行为)。
      const all = stateStore.facts({ scope, limit: 30, latestOnly: memoryCfg.latestOnly }).filter((fact) => factVisible(fact));
      const facts = message.scene === 'group'
        ? all
        : all.filter((fact) => fact.subject === 'self' || fact.subject === message.senderId);
      const nameOf = (subjectId) => {
        if (!subjectId || subjectId === 'self') return null;
        try {
          const row = stateStore.people({ scope, limit: 200 }).find((entry) => entry.openid === subjectId);
          const display = String(row?.display ?? '').trim();
          return display === '' ? null : display;
        } catch {
          return null;
        }
      };
      const rendered = renderFacts(facts, { budgetChars: 160, currentSubject, labelFor: nameOf });
      return rendered === '' ? null : rendered;
    } catch (err) {
      log.warn(`读"关于人的事实"失败（不影响对话）: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * 他提了一个**关于她**的关系主张 → 把球踢给她(认不认由设定与记忆决定)。
   * 只在私聊做:群里那句话是公开声明,而且群里已经按"声明式关系"直接记了。
   */
  function claimNote(message) {
    if (!message || message.scene !== 'c2c') return null;
    const claim = detectClaimAboutSelf(message.content);
    if (!claim) return null;
    return (
      `他说他是你的「${claim.relation}」。**认不认由你自己决定**（照你的设定、也照你记得的事）：\n` +
      `· 认 → 在回复的最末尾补一行 <accept relation="${claim.relation}"/>` +
      '（给系统读的标记，不要念出来、不要解释）；\n' +
      '· 不认 → 什么都别加，照你平时的态度回他就行。'
    );
  }

  if (memoryCfg.enabled) {
    try {
      memoryDb = openMemory(memoryCfg.dbFile);
      // P1-A:关键词通道的 schema(虚表 + 老库补 fts_text 列)。失败只是"没有关键词通道"。
      const ftsSchema = ensureFtsSchema(memoryDb);
      if (!ftsSchema.ok) log.warn(`关键词通道不可用（退回标签+语义）: ${ftsSchema.error}`);
      // P1-C(2026-10-19):note 的软失效三列(superseded_by / merged_into / invalid_at)。
      // 只增列、老库启动时自动补;失败只是"读路径不过滤",不挡启动(与 FTS 那条同一个降级纪律)。
      const noteSchema = ensureNoteSchema(memoryDb);
      if (!noteSchema.ok) log.warn(`记忆软失效：note 三列补不上（读路径退回不过滤，不影响对话）: ${noteSchema.error}`);
      log.info(
        `记忆软失效：读过滤 ${memoryCfg.latestOnly ? '开' : '关'}（旧说法只标 invalid_at、**不物理删**；` +
        '关掉 = QQBOT_MEMORY_LATEST_ONLY=0，回到 P1-B 的"旧说法照旧端出来"，数据一条不丢）' +
        (noteSchema.ok && noteSchema.added.length > 0 ? ` ｜ note 补列 ${noteSchema.added.join(' / ')}` : ''),
      );
      const dshHome = process.env.QQBOT_HOME ?? path.join(os.homedir(), '.dsh');
      /**
       * 收一次新轮次(启动时一次 + 之后每 N 分钟一次)。
       * **抽成闭包是为了让"补归档"用同一份参数** —— 两处各写一遍,dshHome / workspace
       * 迟早会分叉,而分叉的症状是"归档看着成功、其实收错了工作区"。
       */
      const runArchive = (quiet = false) => {
        let result;
        if (config.engine?.mode === 'own') {
          result = archiveOwnHistory({ db: memoryDb, stateFile: config.policy.stats.dbFile,
            workspace: config.dsh.cwd, peopleNames: knownPeopleNames() });
          if (!quiet || result.changed) log.info(`own记忆归档：${result.changed}轮新增/补全，跳过${result.skipped}行非own来源`);
        } else {
          result = archiveOnStartup({
            db: memoryDb,
            dshHome,
            workspace: config.dsh.cwd,
            readRecords: readSessionRecords,
            rootDir: ROOT_DIR,
            quiet,
            // 重导是**破坏性**的(源文件会被会话保留策略删掉),所以要给备份留一条路(见 D77)。
            dbFile: memoryCfg.dbFile,
            peopleNames: knownPeopleNames(),
          });
        }
        // P1-A:归档之后顺手把**新轮次**写进关键词索引(增量、一拍一批、失败不影响归档)。
        if (memoryCfg.fts?.enabled) {
          try {
            const fts = indexTurnFts(memoryDb, { limit: 5000 });
            if (fts.indexed > 0 && !quiet) log.info(`关键词索引：新增 ${fts.indexed} 轮（bigram 分词）`);
          } catch (err) {
            log.warn(`关键词索引失败（不影响对话）: ${describeError(err)}`);
          }
        }
        // P1-F:归档之后顺手重建实体名册(派生数据;第一次启动表从无到有,之后每拍重扫)。
        if (memoryCfg.entity?.enabled) {
          try {
            const built = rebuildEntities(memoryDb, { names: entityNamesForRecall() });
            if (!quiet) log.info(`实体共现：名册 ${built.entities} 个（认识的人/学会的概念），mention ${built.mentions} 轮（扫 ${built.turns} 轮）`);
          } catch (err) {
            log.warn(`实体共现重建失败（沿用旧名册或空，不影响对话）: ${describeError(err)}`);
          }
        }
        // P1-E:常驻块初始化(四块默认行,幂等;about-her 的静态锚点用配置定的名字标签,
        // 不用 gateway.botName —— 那是 READY 后才学到的,初始化段还没 ready)。
        // 之后每次启动都跑一遍 —— INSERT OR IGNORE,已存在的块(连同内容)一动不动。
        if (memoryCfg.blocks?.enabled) {
          try {
            const herName = config.policy?.style?.nameLabels?.[0] ?? '她';
            ensureBlockSchema(memoryDb, {
              aboutHerValue: `她是${herName}。身份与人设以角色卡为准 —— 本块只是防遗忘的锚点。`,
            });
            if (!quiet) {
              const stats = memoryBlockStats(memoryDb);
              log.info(`常驻记忆块：${stats.blocks} 块就位（已填 ${stats.filled}，历史 ${stats.history} 条）`);
            }
          } catch (err) {
            log.warn(`常驻记忆块初始化失败（不影响对话）: ${describeError(err)}`);
          }
        }
        return result;
      };
      archiveRunner = startMemoryArchive(runArchive,
        error => log.warn(`启动归档失败，保留记忆库并等待定期重试: ${describeError(error)}`));
      const summary = memorySummary(memoryDb);
      log.info(
        `记忆：开启（库=${path.relative(ROOT_DIR, memoryCfg.dbFile)}，${summary.sessions} 会话 / ${summary.turns} 轮；` +
        `交接预算 ${memoryCfg.budget} 字、保留最近 ${memoryCfg.recent} 轮原文）` +
        '—— 每代新会话的第一轮注入，所以**重启不再失忆**',
      );
      // 分层记忆 v1(D75):交接**只在换代第一轮**,所以长期事实还需要**每轮**那一小块。
      // 两层预算分开念出来 —— 事后看日志才知道"她为什么突然多了一段回忆"。
      if (memoryCfg.longTerm.enabled) {
        log.info(
          `长期记忆：每轮注入 ≤${memoryCfg.longTerm.budget} 字 / 最多 ${memoryCfg.longTerm.limit} 条` +
          `（**与交接的 ${memoryCfg.budget} 字分开算**；只有标签命中的轮次才注入，理由会打进日志）`,
        );
      } else {
        log.info('长期记忆：关闭（QQBOT_MEMORY_LONGTERM=false）—— 每轮不再拼接长期层');
      }
      log.info(
        memoryCfg.archiveEveryMs > 0
          // 这一拍是"每天分几次回头看看"的**前置**:没有新数据,回头也看不到。
          ? `记忆归档：每 ${Math.round(memoryCfg.archiveEveryMs / 60_000)} 分钟补收一次新轮次（否则当天说的话要等下次重启才进库）`
          : '记忆归档：只在启动时收一次（QQBOT_MEMORY_ARCHIVE_MINUTES=0）—— 当天新说的话要等重启才进库',
      );
      const notesNow = noteStats(memoryDb, Date.now(), { midTtlMs: memoryCfg.noteTtlMs });
      log.info(
        memoryCfg.consolidateEveryMs > 0
          ? `记忆固化：每 ${Math.round(memoryCfg.consolidateEveryMs / 3600_000)} 小时回头一次（每天 ${Math.round(24 / Math.max(1, memoryCfg.consolidateEveryMs / 3600_000))} 次）；` +
            `现在 长期 ${notesNow.long} 条 ｜ 中期 ${notesNow.midAlive} 条在有效期内（另有 ${notesNow.midAll - notesNow.midAlive} 条过期不再注入，但没删）；` +
            // access(D89):让"她是不是老端同一条"在启动横幅上就能看出来。
            `被端出来过 ${notesNow.recalled} 条 / 共 ${notesNow.uses} 次；` +
            // P1-C(D263):被新说法取代的旧说法 —— 报数、不删行。
            `已软失效 ${notesNow.invalid} 条（被更新说法取代，只标时间戳）`
          : '记忆固化：关闭（QQBOT_MEMORY_CONSOLIDATE_MINUTES=0）—— 只靠标签检索，不再"回头"',
      );
      if (config.policy.growth.enabled) {
        const factStats = stateStore.factStats();
        log.info(
          `关于人的事实：名字 ${factStats.name ?? 0} ｜ 关系 ${factStats.relation ?? 0} ｜ 偏好 ${factStats.preference ?? 0} ｜ ` +
          `雷区 ${factStats.dislike ?? 0} ｜ 健康 ${factStats.health ?? 0} ｜ 已被新说法取代 ${factStats.invalid ?? 0} 条` +
          '（每轮注入 ≤160 字；软失效读过滤=' + (memoryCfg.latestOnly ? '开' : '关') +
          '；历史回扫：node scripts\\profile-scan.js）',
        );
      }
      // ⚠️ 2026-10-18(P0-3/P0-5):**覆盖率进横幅** —— 这次的静默失效(向量全停在旧数据、
      //    标签只覆盖 16%)病根就是"没人现算这个数"。以后每只 bot 启动都能一眼看出掉没掉。
      try {
        const vecCov = embeddingCoverage(memoryDb, { model: memoryCfg.embedding.model || null });
        log.info(
          `向量检索：${memoryCfg.embedding.enabled ? '开' : '关'} ｜ 覆盖率 ${vecCov.withVec}/${vecCov.eligible}（${(vecCov.ratio * 100).toFixed(1)}%）` +
          (memoryCfg.embedding.enabled && vecCov.ratio < 1
            ? `（每 ${Math.round(memoryCfg.archiveEveryMs / 60_000)} 分钟那拍自动补一批，一次 ${memoryCfg.embedding.backfill.limit} 条）`
            : ''),
        );
        const tagCov = tagCoverage(memoryDb);
        log.info(
          `标签覆盖：${tagCov.tagged}/${tagCov.human} 人类轮次（${(tagCov.ratio * 100).toFixed(1)}%）` +
          '—— 标签是检索第一路，覆盖率就是召回上限',
        );
        // P1-A:关键词通道的体量(现算;索引是派生的,重建一次只花几秒)。
        let ftsRows = 0;
        try { ftsRows = memoryDb.prepare('SELECT COUNT(*) AS c FROM turn_fts').get()?.c ?? 0; } catch { ftsRows = 0; }
        log.info(
          `关键词通道：${memoryCfg.fts?.enabled ? '开' : '关'} ｜ 已索引 ${ftsRows} 轮` +
          (memoryCfg.fts?.enabled ? `（每路取 ${memoryCfg.fts.limit} 条，RRF k=1）` : ''),
        );
        // W3 知识库接线(P2-B,2026-10-22):状态进横幅 —— **默认关**(库还没内容,开着=空转);
        // 开了的时候要把"库里有没有货"一起念出来,不然"开了但 0 块"是看不见的静默空转。
        const kbStats = knowledgeStats(memoryDb);
        log.info(
          `知识库：${memoryCfg.kb?.enabled ? '开' : '关'} ｜ 资料 ${kbStats.docs} 份 / 块 ${kbStats.chunks} 个` +
          (memoryCfg.kb?.enabled
            ? `（命中才注入，每轮 ≤${memoryCfg.kb.budgetChars} 字 / 最多 ${memoryCfg.kb.maxChunks} 条，预算独立）`
            : '（默认关——灌第一份文档时自己开：node scripts\\kb-import.js + QQBOT_MEMORY_KB=1）'),
        );
      } catch (err) {
        log.warn(`记忆覆盖率统计失败（不影响对话）: ${describeError(err)}`);
      }
    } catch (err) {
      log.warn(`记忆库打不开，本轮起不会交接记忆（不影响对话）: ${describeError(err)}`);
      memoryDb = null;
    }
  } else {
    log.info('记忆：关闭（QQBOT_MEMORY=false）—— 重启即失忆（每代会话从零开始）');
  }

  /** 某个会话的记忆交接提供者(`/重置` 的抑制逻辑在下面的 `handoffFor` 里)。 */
  // ⚠️ 2026-10-18(P0-1):**摘要在生产里从来没被读过** —— `makeHandoffProvider` 的
  //    `summary` 默认 `false`,这里原来只传了 db/budget/recent。于是每 3 小时一次、
  //    约 ¥0.09/天/只算出来的 `summary` 表,只有 `/忘了 摘要` 会读它,交接从没用上。
  //    现在接线抽到 `makeHandoffFromConfig`(可被单测直接钉),关掉摘要时行为与以前一样。
  const handoffProvider = memoryDb
    ? makeHandoffFromConfig({ db: memoryDb, memoryCfg })
    : null;

  /**
   * 长期层提供者(2026-09-30,见 `docs\03` D75):**每一轮**拼一小块。
   *
   * 与交接共用同一个库,**但预算各算各的**(交接 1400 / 长期层 300)——
   * 交接那 1400 字实测已经顶满(1399),从里面挪就等于少带一段最近的原文。
   *
   * 它同步、只读、且内部兜住了所有异常:因为它在**每一轮**的提示词装配路径上,
   * "记忆坏了"只该变成"这轮没有长期记忆",绝不该让一句话回不出去。
   */
  const longTermProvider = memoryDb && memoryCfg.longTerm.enabled
    ? makeLongTermProvider({
      db: memoryDb,
      budget: memoryCfg.longTerm.budget,
      limit: memoryCfg.longTerm.limit,
      midTtlMs: memoryCfg.noteTtlMs,
      // P1-A:关键词通道(FTS5 + RRF k=1)。关掉 `QQBOT_MEMORY_FTS` 就退回标签+语义。
      fts: memoryCfg.fts,
      // P1-C:软失效读路径(默认开;`QQBOT_MEMORY_LATEST_ONLY=0` = 回 P1-B 行为)。
      latestOnly: memoryCfg.latestOnly,
      // W1 衰减治理(2026-10-22):note 限 1 条 + recency 权重 0.5【暂定】(诊断预演双 bot 同益)。
      noteLimit: memoryCfg.retrieval.noteLimit,
      recencyWeight: memoryCfg.retrieval.recencyWeight,
      // P1-F:实体共现。名单每轮现读(longTermNote 里传),这里只给开关与权重;
      // `QQBOT_MEMORY_ENTITY=0` 或权重 0 = 整块关掉,行为回到 P1-E(回滚开关)。
      entityNames: memoryCfg.entity.enabled ? entityNamesForRecall() : [],
      entityBoost: memoryCfg.entity.enabled ? memoryCfg.entity.boost : 0,
    })
    : null;

  /**
   * 知识库提供者(W3 知识库接线 P2-B,2026-10-22):doc/doc_chunk 里的原作资料
   * (**第二个记忆来源**,D95)第一次被接进 QQ 消息路。
   *
   * 照搬优先:D95 当年就把检索这只做完了(`makeKnowledgeProvider`,与长期层同一套
   * recallDecision:标签 + 语义 + 关键词),但**它自己一本账** —— 不记 access、预算独立
   * (memory.kb.budgetChars)、30 分钟重复抑制在 provider 进程内。这里只是把开关接上。
   *
   * ⚠️ **默认关**(memory.kb.enabled ← QQBOT_MEMORY_KB):知识库还没内容,默认开 =
   * 每轮白跑一趟检索。这里为 null 时消息路径整条短路 —— enabled=0 行为一字不变(回滚开关)。
   */
  const kbProvider = memoryDb && memoryCfg.kb?.enabled
    ? makeKnowledgeProvider({
      db: memoryDb,
      budget: memoryCfg.kb.budgetChars,
      limit: memoryCfg.kb.maxChunks,
    })
    : null;

  /**
   * **这一轮的查询向量备忘**(W3,一条就够):长期层(longTermNote)取回的向量记在这里,
   * 知识库那一路(kbNote)**同步**读 —— 同一句话不该问 embedding 服务两次,而 turnNotes 区
   * 里 Promise 形状的调用被 selftest-async-seams 钉死只有 longTermNote 那一条(不可新增)。
   * 只做 query 全等比对,一轮一覆盖;对不上(长期层关着/没取到)→ 知识库退回标签检索,不发请求。
   */
  const kbVectorMemo = { query: null, vector: null };

  /**
   * **"回头"那一拍**(2026-10-01,见 `docs\03` D78)。
   *
   * 用户原话:「每天分几次回头记录熵值高的信息」。它跟"标签检索"是两条路:
   * 标签检索是**被动**的(有人问到相关话题才想起来),而这条是**主动**的 ——
   * 把最近一段的轮次按代码算的分过一遍,够分的固化成中期/长期记忆。
   *
   * 判据②:每一条固化都留"为什么够格"(`note.reasons`),而且启动横幅会报两档各有多少条。
   */
  let lastConsolidateAt = Date.now();
  function memoryConsolidateTick() {
    if (!memoryDb || !config.policy.memory.longTerm.enabled) return;
    const now = Date.now();
    if (!archiveDue(lastConsolidateAt, now, memoryCfg.consolidateEveryMs)) return;
    lastConsolidateAt = now;
    try {
      const result = consolidate(memoryDb, {
        now,
        windowMs: memoryCfg.consolidateWindowMs,
        peopleNames: knownPeopleNames(),
      });
      if (result.mid + result.long > 0) {
        log.info(`记忆固化：看了 ${result.scanned} 轮，新增 中期 ${result.mid} 条 / 长期 ${result.long} 条`);
        for (const sample of result.samples) log.info(`记忆固化：为什么它够格 —— ${sample}`);
      }
      // P1-C:新旧说法冲突(规则版,零模型调用)—— 旧说法只软失效,不物理删。
      if (Number(result.superseded) > 0) {
        log.info(
          `记忆软失效：${result.superseded} 条旧说法被更新的说法取代（invalid_at 非空，行仍在库里可审计）`,
        );
      }
      // P1-F:实体名册与 mention 重建(派生数据,可整表重建;挂在固化同一拍,
      // 名单 = 认识的人 + 学会的概念 —— 每拍名单都可能变,干脆全量重扫)。
      // 失败只 warn:mention 旧一拍不影响对话(与这一层其他纪律一致)。
      if (memoryCfg.entity.enabled) {
        try {
          const built = rebuildEntities(memoryDb, { names: entityNamesForRecall() });
          log.info(`实体共现：名册 ${built.entities} 个（认识的人/学会的概念），mention ${built.mentions} 轮（扫 ${built.turns} 轮）`);
        } catch (err) {
          log.warn(`实体共现重建失败（沿用上一拍的名册，不影响对话）: ${describeError(err)}`);
        }
      }
    } catch (err) {
      log.warn(`记忆固化失败（不影响对话）: ${describeError(err)}`);
    }
  }

  /**
   * **增量补向量**(2026-10-18,P0-3;挂在"补归档"那一拍之后)。
   *
   * 现场:向量 678 条**全是 10-02/03 的旧数据**,own 时代 3,400+ 轮一条没有 ——
   * 而 `QQBOT_MEMORY_EMBEDDING=true` 一直开着,所以"语义检索"看起来在工作:
   * 查询向量算得出来,日志里也可能出现"含语义检索",但候选池里没向量可比。
   * 只跑手动脚本治不了"以后每个新轮次也要有向量",所以把增量补进拍子:
   *
   *   · 一拍只补一小批(`backfill.limit`,默认 64【暂定】),漏下的下一拍接着补;
   *   · 失败只 warn,绝不影响归档/摘要/对话(与这一层其他纪律一致);
   *   · 服务不在/没配 URL → 一个请求都不发(配置检查在函数内也有)。
   */
  async function embedBackfillTick() {
    if (!memoryDb) return null;
    const cfg = memoryCfg.embedding;
    if (!cfg?.enabled || !cfg.url || !cfg.backfill?.enabled) return null;
    try {
      const result = await backfillEmbeddings({
        db: memoryDb,
        url: cfg.url,
        model: cfg.model || null,
        limit: cfg.backfill.limit,
      });
      if (result.error) {
        log.warn(`向量回填：${result.error}（这一拍跳过；服务没起时每拍只红一行）`);
        return result;
      }
      if (result.written > 0) {
        log.info(`向量回填：补 ${result.written}/${result.todo} 条（模型 ${cfg.model || '-'}，维度 ${result.dim ?? '-'}）`);
      }
      return result;
    } catch (err) {
      log.warn(`向量回填失败（不影响对话）: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * **定期补归档**(2026-10-01,见 `docs\03` D77)。
   *
   * 归档原来**只在 bridge 启动时跑一次**,而 `dsh` 是把每一轮连续写在会话文件里的 ——
   * 于是一段跑了一整天的会话,它当天说过的话**根本没进 `memory.db`**:
   * 长期层只能看到"上次重启之前"的内容。实测(2026-10-01):手动补归档之前,
   * 主实例的库是 **872 分钟前**的快照,而那天早上刚聊过一大段。
   *
   * 所以这一拍是"**每天分几次回头看看**"的**前置**:没有新数据,回头也看不到。
   * 它同步、便宜(比对两个数字 + 几个文件),而且 `archiveOnStartup` 内部已经兜住异常 ——
   * "补归档失败"绝不该让对话出问题。
   */
  const memoryArchiveTick = createMemoryArchiveTick({
    getRunner: () => archiveRunner,
    everyMs: memoryCfg.archiveEveryMs,
    afterArchive: async () => {
      // ⚠️ 顺序:先补向量(P0-3),再算摘要 —— 两者互不依赖,但都依赖"刚归档进来的新轮次"。
      await embedBackfillTick();
      await summaryTick();
    },
    onArchiveError: error => log.warn(`补归档失败，下次重试: ${describeError(error)}`),
    onSummaryError: error => log.warn(`滚动摘要失败（不影响对话）: ${describeError(error)}`),
  });

  /**
   * **指标点的保留策略**(2026-10-02,D94):留 **30 天**,与会话保留同一个口径。
   *
   * ⚠️ 它可以删 —— 指标是**可再生的观测量**;而 `memory.db` 里那些轮次**不可再生**
   * (源文件会被保留策略删掉)。两件事别混为一谈,这也是这张表敢无脑清的原因。
   * ⚠️ 用 `meta` 记"今天清过没有":这个 tick 每 30 秒醒一次,不该每次都去 DELETE。
   */
  function metricsTick() {
    if (typeof stateStore.pruneMetricPoints !== 'function') return;
    const now = Date.now();
    const today = localDateKey(new Date(now));
    if (stateStore.getMeta('metric_pruned_day') === today) return;
    try {
      const removed = stateStore.pruneMetricPoints({ days: 30, now });
      // ⚠️ 1.106.3(D175):出站留痕与指标同一档 —— **可删的观测**,同一个保留口径(30 天)。
      const outboundRemoved = typeof stateStore.pruneOutbound === 'function'
        ? stateStore.pruneOutbound({ days: 30, now })
        : 0;
      stateStore.setMeta('metric_pruned_day', today);
      if (removed > 0) log.info(`指标：清掉 ${removed} 条 30 天以前的点`);
      if (outboundRemoved > 0) log.info(`出站留痕：清掉 ${outboundRemoved} 条 30 天以前的`);
    } catch (err) {
      log.warn(`指标清理失败（不影响对话）: ${describeError(err)}`);
    }
  }

  /**
   * **滚动摘要的重算**(2026-10-02,见 `docs\03` D91;分层记忆第三层)。
   *
   * 三条边界,与 D91 写死的那三条一一对应:
   *   1. **不在交接路径上算** —— 交接是 `runTurn` 内部 await 的,而模型调用也要走同一个 `runner`,
   *      在那儿再发一个请求就是**同一个子进程套第二个请求**(死锁)。所以这里(拍子)算,交接只读缓存;
   *   2. **防她背摘要** —— 提示词里写着"这是背景不是台词"(与交接块同一套措辞);
   *   3. **可重建** —— `SUMMARY_VERSION` 变了就重算,不动 `MEMORY_VERSION`(不触发危险重导)。
   *
   * 只对"**有资格被摘要**"的会话动手:先挑最近活跃的那几段,而且必须攒够 `SUMMARY_REFRESH_TURNS` 轮。
   * 一段会话算一次就够(算完游标前移,下次要再攒够 12 轮)。
   */
  async function summaryTick() {
    if (!memoryCfg.summary.enabled || !memoryDb || !summarizerReady()) return;
    const conversations = activeConversations(memoryDb, 8);
    if (conversations.length === 0) return;
    // ⚠️ **1.106.4(D176):她自己的经历** —— 用户 2026-10-10 的口径是
    //    「鸡毛蒜皮、有重复性的日常不用记,有特殊性的事情可以记(接委托受伤、生病、生日…),
    //      这种**算会话摘要里面**」。
    //    所以摘要多带一段**代码给的事实**(不是从她的自言自语里读的):
    //      · 特殊流水(`pickSpecialEntries`,门槛 = 编年史那套 weight ≥ 8,暂定)
    //      · 今天是她的日子(生日;出处见 `src\character-days.js`)
    //    ⚠️ 算**一次**就够(它与"哪个会话"无关),别放进下面的循环里重复算。
    let specialFacts = '';
    let specialCount = 0;
    let specialDay = '';
    try {
      const entries = buildChronicle({ events: stateStore.recentStatsEvents(SPECIAL_SCAN_EVENTS), metas: [] });
      const picked = pickSpecialEntries(entries, { since: Date.now() - SPECIAL_WINDOW_MS });
      specialDay = renderDayLine(daysToday(moodTheme.id));
      specialCount = picked.length;
      specialFacts = [renderSpecialLine(picked), specialDay].filter(Boolean).join('；');
    } catch (err) {
      log.warn(`拼"她自己的经历"失败（这一轮摘要照旧）: ${describeError(err)}`);
      specialFacts = '';
      specialCount = 0;
    }
    // ⚠️ **日志打在"真的算完一段"之后**(1.106.4 现场抓到):原来那一行在循环**之前**打,
    //    于是"这一段没到间隔、一段都没算"的那一拍也会印 `带上"她自己的经历" 2 条`,
    //    看起来像真算了 —— 而库里一个字没变(2026-10-10 12:26 现场)。
    let recomputed = 0;
    for (const conversation of conversations) {
      const plan = summaryPlan(memoryDb, {
        conversation,
        budgetChars: memoryCfg.summary.budget,
        // ⚠️ 最小重算间隔(D135):没有它,"攒够新轮次"那条判据恒为真 → 每 15 分钟白算一次。
        minIntervalMs: memoryCfg.summary.minIntervalMs,
      });
      if (!plan.due) continue;
      const startedAt = Date.now();
      // ⚠️ 会话 id 用 `<会话>#summary`:它是**另一个子会话**,所以摘要请求不会挤进她的对话上下文,
      //    也不会被当成"她说过的话"归档(`classifyKind` 只认 `qqbot-` 开头的真会话)。
      const text = await summarizeConversation({
        history: plan.input.text,
        who: conversation.includes('-group-') ? '这个群' : '私聊',
        budgetChars: memoryCfg.summary.target,
        summarize: summarizer,
        // ⚠️ 1.106.4(D176):代码给的那几件"有特殊性的事"(见上面那段注释)。
        facts: specialFacts,
      });
      if (!text) {
        log.warn(`滚动摘要：${conversation} 模型没写出东西，这次跳过`);
        continue;
      }
      saveSummary(memoryDb, {
        conversation,
        text,
        coversUpTo: plan.input.coversUpTo,
        coveredTurns: plan.input.turns,
        buildMs: Date.now() - startedAt,
      });
      recomputed += 1;
      log.info(
        `滚动摘要：${conversation} 重算完 ${text.length} 字（覆盖 ${plan.input.turns} 轮，` +
        `用 ${Date.now() - startedAt}ms）—— ${plan.reason}`,
      );
    }
    // 真的算完至少一段,才把"她自己的经历"这一行打出来(判据与日志必须对得上)。
    if (recomputed > 0 && specialFacts !== '') {
      log.info(
        `滚动摘要：${recomputed} 段带上"她自己的经历" ${specialCount} 条` +
        `${specialDay ? ' + 今天是她生日' : ''}`,
      );
    }
    // P1-E:常驻块生成挂同一拍(摘要跑通 = runner 在线)。**≈1 次/天限频**(everyMs,默认 20h),
    // 失败保留旧值(方案 §4 硬要求);生成调用走与摘要同一条子会话线(summarizer,轮换/上限现成)。
    if (memoryCfg.blocks?.enabled && memoryDb && summarizerReady()) {
      try {
        const nowMs = Date.now();
        const blocks = getMemoryBlocks(memoryDb);
        const due = blocks.some((block) =>
          !block.readOnly
          && (block.value.trim() === '' || block.updatedAt == null
            || nowMs - block.updatedAt >= memoryCfg.blocks.everyMs));
        if (due) {
          const startedAt = Date.now();
          const result = await buildMemoryBlocks({
            current: blocks,
            notesText: recentNotesText(memoryDb, { limit: 30 }),
            generate: (prompt) => summarizer(prompt),
          });
          if (result.error) {
            log.warn(`常驻块生成：${result.error}（旧值保留，下次拍子再试）`);
          } else {
            const applied = applyBlockUpdates(memoryDb, result.updates, { model: 'blocks', now: startedAt });
            log.info(
              `常驻块生成：更新 ${applied.written} 块`
              + `${applied.skippedReadOnly > 0 ? `（跳过 read_only ${applied.skippedReadOnly}）` : ''}`
              + `（用 ${Date.now() - startedAt}ms）`,
            );
          }
        }
      } catch (err) {
        log.warn(`常驻块生成失败（旧值保留，不影响对话）: ${describeError(err)}`);
      }
    }
    // P2-A:记忆洞察生成挂同一拍(在常驻块之后;摘要跑通 = runner 在线)。限频 everyMs(默认 20h,
    // D250 定稿 #6 的"1 次/天";判据 = 库里最新一条洞察的 created_at,一条都没有 = 首拍就写)。
    // 输入 = 最近 30 条固化笔记(带真实 note.id)+ 已有洞察;输出 ≤3 条、每条 ≤120 字、必带 derived_from;
    // 坏 JSON/空输出/缺字段/假引用 → 整批不写(只增表,不存在"半写")。生成调用走与摘要同一条
    // 子会话线(summarizer,轮换/上限现成)—— 绝不在交接/对话路径上调模型(D91 死锁纪律)。
    if (memoryCfg.insights?.enabled && memoryDb && summarizerReady()) {
      try {
        const nowMs = Date.now();
        if (insightsDue(latestInsightCreatedAt(memoryDb), { everyMs: memoryCfg.insights.everyMs, now: nowMs })) {
          const notes = recentInsightNotes(memoryDb, { limit: memoryCfg.insights.inputNotes });
          // 没攒够可引用的笔记 = 没有可反思的材料,这是常态不是故障:安静跳过,不刷日志。
          if (notes.length >= INSIGHT_MIN_NOTES) {
            const startedAt = Date.now();
            const result = await withTimeout(
              buildInsights({
                notes,
                existing: latestInsights(memoryDb, { limit: 10 }),
                generate: (prompt) => summarizer(prompt),
                maxPerRun: memoryCfg.insights.maxPerRun,
                limitChars: memoryCfg.insights.limitChars,
              }),
              memoryCfg.insights.timeoutMs,
              { insights: [], error: '生成超时（旧值保留）', raw: null },
            );
            if (result.error) {
              log.warn(`记忆洞察：${result.error}（这次不写入，下个拍子再试）`);
            } else {
              const applied = appendInsights(memoryDb, result.insights, { model: 'insights', now: startedAt });
              log.info(
                applied.written > 0
                  ? `记忆洞察：新增 ${applied.written} 条（引用 ${applied.refs} 条笔记，用 ${Date.now() - startedAt}ms）`
                  : '记忆洞察：模型没给出新模式（这次不写入）',
              );
            }
          }
        }
      } catch (err) {
        log.warn(`记忆洞察生成失败（不影响对话）: ${describeError(err)}`);
      }
    }
  }

  /**
   * 摘要那一步"叫模型"的接口 —— **只在真正要算的时候**才需要 runner。
   *
   * ⚠️ 用一个**可变的引用**而不是直接闭包 `runner`:记忆那套(含拍子)在 runner 之前就装好了,
   * 而"谁调模型"这件事必须等 runner 建好才有答案(见下面 `runnerRef.runTurn = ...`)。
   */
  const runnerRef = { runTurn: null };
  function summarizerReady() {
    return typeof runnerRef.runTurn === 'function';
  }

  /**
   * 摘要子会话的**代次**与**本代已用次数**(2026-10-06,D135;理由见下面 `summarizer`)。
   * ⚠️ 2026-10-15:这两个数**不再只活在进程里** —— 承接哪一代由**盘上的 user 轮数**决定
   *    (见 `src/summary-session.js` 顶部):重启归零会让它又回到已经攒满的旧会话。
   */
  let summarySessionGen = 0;
  let summarySessionCalls = 0;
  let summarySessionSeeded = false;
  /**
   * 摘要轮的对话历史落在**哪个**库:6B 之后 own 是唯一引擎 ⇒ 就是桥的状态库。
   * （历史上影子模式读的是隔离库;影子随 DSH 连接段一起退役,见 CHANGELOG 1.150.84。）
   */
  const summaryHistoryStore = () => stateStore;
  /** 盘上这一代已经用掉几次(一次调用 = 一条 user 轮)。读不出来当 0 = 退回旧行为。 */
  const summaryCallsOnDisk = (gen) => {
    try {
      return summaryHistoryStore().conversationTurns(summarySessionKey(gen)).filter((row) => row.role === 'user').length;
    } catch (err) {
      log.warn(`摘要子会话：读不出第 ${gen} 代的用盘量(当 0 处理): ${err?.message ?? err}`);
      return 0;
    }
  };
  /** 把当前代次落盘 —— DSH 模式下我们没有它的会话库,只能靠这个跨重启记住。 */
  const rememberSummarySession = () => {
    try {
      stateStore.setMeta(SUMMARY_SESSION_META_KEY, JSON.stringify({ gen: summarySessionGen, calls: summarySessionCalls }));
    } catch (err) {
      log.warn(`摘要子会话：代次没记上盘(不影响这一次摘要): ${err?.message ?? err}`);
    }
  };

  async function summarizer(prompt) {
    // ⚠️ **摘要子会话必须有上限**(2026-10-06,D135)。原来所有摘要共用一个固定子会话,
    //    实测它连跑 832 次、**每次调用 +2048 token**,前缀一路涨到 79 万(1M 的 78%)才被压回,
    //    而那一条会话吃掉了两只机器人 **98.4%** 的账单。
    //    ⚠️ 换代**不丢信息**:摘要任务是无状态的 —— 每次都把要摘的材料(`plan.input.text`)
    //    整份发过去,它从来不依赖自己上一轮的输出。换的只是"这通电话走哪条线"。
    //    ⚠️ 2026-10-15:代次与用量**按盘上事实**决定(盘上用量 + 持久化计数取更靠前者),
    //    重启不再回到已经攒满的旧会话。
    const maxCalls = Math.max(1, Number(memoryCfg.summary.sessionCalls) || 1);
    if (!summarySessionSeeded) {
      summarySessionSeeded = true;
      const plan = pickSummarySession({ maxCalls, callsOnDisk: summaryCallsOnDisk,
        persisted: parseSummarySessionMeta(stateStore.getMeta(SUMMARY_SESSION_META_KEY)) });
      summarySessionGen = plan.gen; summarySessionCalls = plan.calls;
      if (plan.gen > 0 || plan.calls > 0) {
        log.info(`摘要子会话：从第 ${plan.gen} 代接着走（依据=${plan.from}，这一代已用 ${plan.calls}/${maxCalls} 次）—— 重启不回到用满的旧会话`);
      }
      rememberSummarySession();
    }
    if (summarySessionCalls >= maxCalls) {
      summarySessionGen += 1;
      // 新一代**不一定**是空的(旧进程可能已经用过它)—— 承接盘上真实用量,前缀口径才是可解释的。
      summarySessionCalls = summaryCallsOnDisk(summarySessionGen);
      log.info(`摘要子会话轮换：第 ${summarySessionGen} 代（上一代用满 ${maxCalls} 次 —— 前缀不再无界增长；这一代盘上已用 ${summarySessionCalls} 次）`);
      rememberSummarySession();
    }
    const key = summarySessionKey(summarySessionGen);
    summarySessionCalls += 1;
    rememberSummarySession();
    // T1-B(2026-10-29):摘要走**无状态任务轮** —— 每次自带全量材料,不再借 qqbot-summary*
    // 的共享会话历史,跨群/私聊的摘要材料从此不可能同处一个请求。key 仅作账本归属;
    // 上面的 D135 代次轮换保留为成本报表口径,"前缀累积"这件事本身已不存在。
    const turn = await runnerRef.runIsolatedTurn(prompt, { key, kind: 'summary', timeoutMs: memoryCfg.summary.timeoutMs });
    const text = String(turn?.text ?? '').trim();
    return text === '' ? null : text;
  }

  /** 记忆交接:返回要前置到提示词的文本,或 null(=这轮没有记忆)。 */
  async function handoffFor(conversationKey) {
    if (!handoffProvider) return null;
    // `/重置` 明确要求"清空重来",那就**不要**把记忆塞回去 —— 否则重置等于没重置。
    if (handoffSuppressed.delete(conversationKey)) {
      log.info(`记忆交接：${conversationKey} 刚被 /重置，本轮不交接`);
      return null;
    }
    const block = await handoffProvider(conversationKey);
    // P1-E:常驻记忆块**挂交接层** —— 换代首轮必含 XML(方案 §4 判据),不经过检索:
    // 身份/关系/约定这类"永远该在场"的事不靠碰运气。块全空 → 一字不加。
    // 失败只 warn(记忆坏了 = 这轮没块,不该影响交接)。
    let blocksText = '';
    if (memoryCfg.blocks?.enabled && memoryDb) {
      try {
        // **作用域守卫**(P0,2026-10-28):块是"全库一份",但**群聊不该看见私聊的派生内容**。
        // 口径只在 `src\memory-scope.js`(纯函数);这里只负责把过滤后的块交给渲染。
        const access = memoryAccessFor(conversationKey, { ownerIds: config.policy.admin?.ids ?? null });
        const visible = filterBlocksForAccess(getMemoryBlocks(memoryDb), access);
        blocksText = renderMemoryBlocks(memoryDb, { blocks: visible });
        if (visible.length === 0) {
          log.info(`记忆作用域：${conversationKey} 不给私有常驻块（${access.reason}）`);
        }
      } catch (err) {
        log.warn(`常驻记忆块渲染失败（这轮没块）: ${describeError(err)}`);
      }
    }
    // ⚠️ 2026-10-18(P0-2):交接块也**自报家门**了(D177 的标记约定)。
    //    以前它靠 `stripInjectedBlocks` 认 `【记忆交接】…（现在开始。）` 的字面 ——
    //    措辞一改就静默漏剥(存档里 320 轮就是这么进去的)。现在剥壳只认标记。
    //    P1-E 的块段**跟着同一份标记走**(剥壳口径只有一份,不许出现第二份必须一致的实现)。
    const combined = [blocksText, block].filter(Boolean).join('\n');
    return combined ? wrapInject('handoff', combined) : null;
  }

  // Fail fast on bad credentials rather than after connecting the gateway.
  await tokens.get();

  // 生命体征(1.168.0 / D275):QQ 收发两侧共用一份 ——
  //   · 入站:gateway 的 dispatch 层记"见过消息事件吗"(判据);
  //   · 出站:api 的两个消息出口记"发得出吗"。
  // 30 秒心跳原子写 `data\<bot>\bridge-status.json`(与 supervisor 的心跳同拍),
  // /api/ping(内部身份或长票)也带出快照;一期只记录/暴露,人工查看,无自动告警消费者。
  const vitals = createBridgeVitals();

  const api = new QqApi({ tokens, apiBase: config.qq.apiBase, vitals });
  // 引擎:**own 是唯一引擎**(2026-10-16,6B 去 DSH 化 —— DSH 连接段已拆,
  //    原件留档 D:\废弃仓库\去dsh化原零件\2026-10-16-6b\)。
  //    ⚠️ 没配直连 key 当场大声失败:不许静默降级、不许"假装她还在说话"。
  let runner;
  let serverInfo;
  // **复制粘贴梗库**(2026-10-14,用户委派):库是**卡库侧的内容**(`<工作区>\梗库-复制粘贴.json`),
  //   桥只负责「读 + 按判据注入」——判据全在 `src\copypasta.js`(纯函数,单测钉着)。
  //   ⚠️ 读不到/坏了**不许影响启动**:主实例的工作区里根本没有这个文件,那就是空库、不念梗。
  const copypasta = loadCopypastaCorpus(path.join(config.dsh.cwd, COPYPASTA_FILE), { log });
  if (copypasta.entries.length > 0) {
    log.info(`[梗库] 复制粘贴梗 ${copypasta.entries.length} 条(${copypasta.file})`);
  }
  // **故事活动内容包**(P4,2026-10-28):机制在 `story.js`,内容是**角色自己的**。
  // 没有内容包的角色 → story 类活动只报备"在干嘛",不抛钩子(不套用别人的事件表)。
  // 默认(不配/主实例)= 旧行为一字不变;副实例故意没配(见 `src\story-content.js` 头注释)。
  const storyPack = storyPackFor(config.policy.mood?.theme);
  log.info(`[事件钩子] ${storyPackStatus(config.policy.mood?.theme).reason}`);
  // 引擎:**own 是唯一引擎**(2026-10-16,6B 去 DSH 化 —— 连接段已拆,原件留档
  //    D:\废弃仓库\去dsh化原零件\2026-10-16-6b\)。
  //    ⚠️ 没配直连 key 当场大声失败:不静默降级、不许"假装她还在说话"。
  if (!llmSettings.isConfigured('bot')) {
    throw new Error(`own 引擎需要可用的 bot 模型配置(环境变量 QQBOT_LLM_KEY/QQBOT_LLM_BASEURL/QQBOT_LLM_MODEL,或面板保存的 bot slot)—— 当前:${llmSettings.problem('bot') ?? 'not_configured'}。没配就大声失败,不静默降级`);
  }
  if (config.engine.mode && config.engine.mode !== 'own') {
    log.warn(`[引擎] QQBOT_ENGINE=${config.engine.mode} 已退役(6B 去 DSH 化):桥只跑 own,该项被忽略。`);
  }
  if (config.engine.dshOnlyRequestOptions?.length) {
    log.warn(`[引擎] 下列配置属于已退役的 DSH 路,不再消费:${config.engine.dshOnlyRequestOptions.join(' / ')}`
      + ';直连路用 QQBOT_LLM_REASONING_EFFORT / QQBOT_LLM_MAX_TOKENS,没配就是不设档位、不设输出上限。');
  }
  /** 引擎这行的**生效值**(实际请求用的模型/端点/采样)。 */
  function logEngineModelLine() {
    const { requestOptions } = config.engine;
    const llm = llmSettings.get('bot');
    const sampling = [
      requestOptions?.reasoningEffort !== undefined ? `reasoning_effort=${requestOptions.reasoningEffort}` : null,
      requestOptions?.maxTokens !== undefined ? `max_tokens=${requestOptions.maxTokens}` : null,
    ].filter(Boolean).join(' ');
    return `[引擎] own 路生效值：model=${llm.model} @ ${llm.baseUrl}`
      + `（采样：${sampling || '未设档位/未设输出上限'}）`;
  }
  {
    const personaPath = path.join(config.dsh.cwd, 'AGENTS.md');
    runner = createOwnEngine({
      llm: llmSettings.scoped('bot'),
      inputTokenLimit: config.engine.inputTokenLimit,
      // 采样参数(推理档位/输出上限)是**真实发出去的 body** —— 从配置到这里一段不落(F5)。
      requestOptions: config.engine.requestOptions,
      handoff: memoryCfg.enabled ? handoffFor : undefined,
      store: stateStore,
      personaPath,
      log,
    });
    serverInfo = await runner.initialize();
    log.info(logEngineModelLine());
    log.info(`[引擎] own 自有引擎已就绪(人设=${personaPath})`);
  }
  // ---------------------------------------------------------------------------
  // **P3-b 工具装配**(2026-10-28):能力等式在这里落地成本实例的事实。
  // 四样全齐才真的发工具:总闸 + 模型已验证 + 授权清单 + 能力可用。
  // **默认全关 = 行为一字不变**(回滚 = 不配/删 env,不 revert 代码)。
  // **凭据**(2026-10-28 主人拍板:搜索与 bot 用**同一份 key**)—— 缺省回落 bot slot,
  // env(QQBOT_SEARCH_BASEURL/KEY)显式配置仍可覆盖。
  // **日额度**(同日拍板:**1¥/日**,全部群开放)—— 只记成功调用,超限当日静默关闭、次日自愈。
  const toolRegistry = [];
  let toolBudget = null;
  {
    const toolsCfg = config.policy.tools ?? {};
    let searchBase = toolsCfg.searchBaseUrl ?? '';
    let searchKey = toolsCfg.searchKey ?? '';
    if (searchBase === '' || searchKey === '') {
      try {
        const bot = llmSettings.get('bot');
        if (searchBase === '') searchBase = bot?.baseUrl ?? '';
        if (searchKey === '') searchKey = bot?.apiKey ?? '';
      } catch {
        // bot slot 没配好 → 搜索不注册(启动主流程自己的 fail fast 会管模型)。
      }
    }
    if (searchBase !== '' && searchKey !== '') {
      const provider = createWebSearchProvider({
        baseUrl: searchBase,
        apiKey: searchKey,
        timeoutMs: toolsCfg.searchTimeoutMs,
        // **抓取域名白名单**(2026-10-28 主人拍板"按推荐来"):
        // 留空 = 公网可抓,私网/本机/元数据地址永远硬挡;配了就只许这些域(含子域)。
        allowedHosts: toolsCfg.webFetchAllow,
      });
      toolBudget = createToolBudget({
        store: stateStore,
        dailyLimitCny: toolsCfg.searchDailyLimitCny,
        perCallCny: toolsCfg.searchPerCallCny,
      });
      // costCny = 日预算的计费刻度【暂定换算,见 config 注释】;withBudget 负责"成功才记账"。
      const withCost = (spec) => withBudget(defineCapability({ ...spec, costCny: toolsCfg.searchPerCallCny }), toolBudget);
      toolRegistry.push(withCost({
        id: 'web_search',
        description: '搜索公开网页,返回标题/链接/摘要。遇到时效性问题、不确定的事实时用;一次一个问题。',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' } }, required: ['query'] },
        effect: 'read-only',
        execute: (args, ctx) => provider.search(String(args.query ?? ''), { count: args.count, signal: ctx.signal }),
      }));
      toolRegistry.push(withCost({
        id: 'web_fetch',
        description: '读取一个网页的正文(Markdown)。手头有具体链接且需要内容时才用。',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        effect: 'read-only',
        execute: (args, ctx) => provider.fetchPage(String(args.url ?? ''), { signal: ctx.signal }),
      }));
      log.info(
        `[工具] 已注册能力:${toolRegistry.map((cap) => cap.id).join('、')}` +
        `(凭据=bot slot 同源,授权清单=${(toolsCfg.allow ?? []).join('、') || '空'},` +
        `日额度=${toolsCfg.searchDailyLimitCny}¥,今日已用=${toolBudget.spentCny()}¥)`,
      );
    } else {
      log.info('[工具] 搜索凭据不可用(bot slot 未配好且未显式配置),web_search/web_fetch 不注册');
    }
  }
  const toolGrant = { allowToolIds: new Set(config.policy.tools?.allow ?? []) };
  /**
   * 这一轮的工具上下文(engine 第 5 参)。**关闭/不可用 = null,引擎行为一字不变**。
   * ⚠️ 判据顺序 = 能力等式的实例侧落地:总闸 → 模型已验证 → 协议兼容 → 有能力可给 → 授权后非空。
   */
  function buildToolContext(message, conversationKey) {
    const toolsCfg = config.policy.tools ?? {};
    if (!toolsCfg.enabled) return null;
    if (toolsCfg.modelFunctionTools !== true) return null;
    if (toolRegistry.length === 0) return null;
    // **日额度闸**(1¥/日,2026-10-28 主人拍板):花完当日不给(省 token,模型也不问),
    // execute 里还有第二道(防竞态);次日自愈。
    if (toolBudget && !toolBudget.canSpend()) return null;
    // 协议闸:Responses 路当前不发工具(适配器未实现,发了会 400 —— 见 llm.js)。
    try {
      if (isResponsesApi(llmSettings.get('bot')?.baseUrl ?? '')) return null;
    } catch {
      return null; // 模型没配好 → 没有工具(主流程自己的 fail fast 会管)
    }
    const turnContext = turnContextFor({
      botId: gateway.botName || 'bot',
      actorId: message?.senderId ?? null,
      scene: message?.scene ?? '',
      conversationKey,
      purpose: 'chat',
    });
    const tools = advertisedTools({
      capabilities: toolRegistry,
      turnContext,
      grant: toolGrant,
      modelCaps: { functionTools: true },
    });
    if (tools.length === 0) return null;
    return { tools, capabilities: toolRegistry, grant: toolGrant, turnContext, maxRounds: toolsCfg.maxRounds };
  }
  // 记忆那套(含摘要拍子)比 runner 早装好 —— 这里把"叫模型"那条线接上(见 `runnerRef` 的说明)。
  //
  // 指标(2026-10-02,D94)。
  // ⚠️ **2026-10-15 更正(并行审查 F9):原来这里写"只在跑模型这一个汇流点采",那句话不成立** ——
  //    `recordTurnMetrics` 实际只在**两个**地方被调用:下面这个 `runnerRef.runTurn`(记忆摘要那条路)
  //    与主回复路径(`composeReply` 那边)。暖群 / 早安 / 旁白 / 自发重查 / 事件钩子这些轮次
  //    **不进 `turn.*` 指标**(它们各有自己的调用点,不经这个 wrapper)。
  //    所以"漏采的永远补不回来"这个担心是真的 —— 只是**现在就已经漏着**,不是将来会漏。
  //    D94 时代的旧账,不属于去 DSH 化引入;要不要把其余调用点补齐由主人定(不影响切换)。
  //    另外:影子观测**不受**此限 —— `createShadowRunner` 包的是 runner 本体,19 个调用点全覆盖。
  runnerRef.runTurn = async (key, prompt, timeoutMs) => {
    const startedAt = Date.now();
    // 影子观察已包装 runner 本体，覆盖所有调用方，不只这个记忆摘要入口。
    try {
      const turn = await runner.runTurn(key, prompt, timeoutMs);
      recordTurnMetrics({ key, ms: Date.now() - startedAt, text: turn?.text ?? '', timedOut: turn?.timedOut === true });
      return turn;
    } catch (err) {
      recordTurnMetrics({ key, ms: Date.now() - startedAt, text: '', failed: true });
      throw err;
    }
  };
  // T1-B:无状态任务轮的转发 + 指标(与 runTurn 同一 recordTurnMetrics 口径,best-effort)。
  runnerRef.runIsolatedTurn = async (text, opts = {}) => {
    const startedAt = Date.now();
    try {
      const turn = await runner.runIsolatedTurn(text, opts);
      recordTurnMetrics({ key: opts.key ?? '', ms: Date.now() - startedAt, text: turn?.text ?? '', timedOut: false });
      return turn;
    } catch (err) {
      recordTurnMetrics({ key: opts.key ?? '', ms: Date.now() - startedAt, text: '', failed: true });
      throw err;
    }
  };
  /**
   * 记几个指标点(2026-10-02,见 `docs\03` D94)。
   *
   * ⚠️ **best-effort**:指标写不进去绝不许影响对话 —— 与 D89 那条
   * "落账失败不许带走回忆"、D91 那条"摘要失败不影响对话"是同一条纪律。
   * ⚠️ 一批一个事务:一轮的指标要么都落、要么都不落(半份指标在报表上看起来完全正常)。
   */
  function recordMetrics(points) {
    try {
      stateStore.recordMetricPoints(points);
    } catch (err) {
      log.warn(`指标没记上（不影响对话）: ${describeError(err)}`);
    }
  }

  /** 一轮的指标:耗时 + 结局(开口了 / 静默 / 超时 / 失败 / 摘要子会话)。 */
  function recordTurnMetrics({ key, ms, text, timedOut = false, failed = false }) {
    const kind = failed ? 'failed'
      : timedOut ? 'timeout'
        : String(key).startsWith('qqbot-summary') ? 'summary'
          : isSilentReply(text) ? 'silent' : 'reply';
    recordMetrics([
      { key: 'turn.ms', value: ms, scope: key },
      { key: `turn.${kind}`, value: 1, scope: key },
      { key: 'turn.total', value: 1, scope: key },
    ]);
  }

  // 启动横幅:own 是唯一引擎(6B 之后没有"DSH 运行时"这一行可报了)。
  if (serverInfo) {
    log.info(`[引擎] own 引擎已就绪：${serverInfo.name ?? 'own'} ${serverInfo.version ?? ''}`.trim());
  }

  const gateway = new QqGateway({
    tokens,
    apiBase: config.qq.apiBase,
    intents: config.qq.intents,
    selfIds: config.qq.selfGroupIds,
    vitals,
    // 学到的"别的机器人"要**落盘**(D54):它原来只在内存里,重启即忘 ——
    // 于是每次重启后的头几条对方机器人的消息又会被当成真人。
    onForeignBot: (id, name) => {
      const known = parseForeignBotIds(stateStore.getMeta('foreign_bot_ids'));
      if (known.some((entry) => entry.id === id)) return;
      known.push({ id, name: name ?? null });
      stateStore.setMeta('foreign_bot_ids', JSON.stringify(known));
      log.info(`已知别的机器人写入状态库：${id}${name ? `（${name}）` : ''}（重启不会再忘）`);
    },
  });
  const semaphore = new Semaphore(config.policy.maxConcurrency);

  // 群参与状态机(1.170.0 / D277):每群一档(观望/试探/活跃/退场)。内存态,
  // 重启全回观望(保守方向)。转移在这里统一落日志与 metric —— 前后对照的地基。
  const socialState = createSocialStateMachine({ onTransition: noteSocialTransition });
  // 双审 Y2:每个群「全静已喊过」的退场期标记(since);重启即清,与状态机同寿命。
  const retreatLoggedSince = new Map();
  function noteSocialTransition(groupId, transition) {
    if (!transition) return;
    try {
      log.info(`[参与状态] 群 ${groupId.slice(0, 8)}…：${transition.from} → ${transition.to}（${transition.reason}）`);
      recordMetrics([{ key: `social.state.${transition.to}`, value: 1, scope: groupId }]);
    } catch (err) {
      log.warn(`参与状态没记上（不影响对话）: ${describeError(err)}`);
    }
  }

  // 生命体征心跳(D275):30 秒原子写一次(与 supervisor 的 status.json 心跳同拍)。
  // 判定阈值在文件里一并给出(verdict/reason)—— 读的人不用再算。
  // ⚠️ best-effort:写失败只 warn —— 观测不许把机器人带崩(D89 同一条纪律)。
  // ⚠️ 文件里的时刻全是**本机毫秒**;读到陈旧文件的人按 `capturedAt` 自己算年龄。
  const vitalsFile = path.join(path.dirname(String(config.policy.stats.dbFile)), 'bridge-status.json');
  // 写失败计数(双审 Y16):30 秒一拍,不节流就是每天 2880 条 warn;成功一次就归零并在恢复时喊一句。
  let vitalsWriteFailures = 0;
  const writeVitalsSnapshot = () => {
    try {
      const snap = vitals.snapshot();
      writeStatusAtomic(vitalsFile, {
        ...snap,
        ...judgeStaleness(snap, { now: Date.now() }),
        bot: path.basename(path.dirname(String(config.policy.stats.dbFile))),
        pid: process.pid,
      });
      if (vitalsWriteFailures > 0) {
        log.info(`生命体征写回来了（此前连续失败 ${vitalsWriteFailures} 次）`);
        vitalsWriteFailures = 0;
      }
    } catch (err) {
      vitalsWriteFailures += 1;
      if (shouldWarnVitalsFailure(vitalsWriteFailures)) {
        log.warn(`生命体征没写上（不影响对话）: ${err?.message ?? err}（连续第 ${vitalsWriteFailures} 次）`);
      }
    }
  };
  writeVitalsSnapshot();
  const vitalsTimer = setInterval(writeVitalsSnapshot, 30_000);
  vitalsTimer.unref?.();
  // 重启后先把"已知别的机器人"装回去(D54):学到的 id 现在落盘了,
  // 所以重启不再有"头几条把对方当真人"的漏网。
  {
    const knownBots = parseForeignBotIds(stateStore.getMeta('foreign_bot_ids'));
    for (const entry of knownBots) gateway.foreignBotIds.add(entry.id);
    if (knownBots.length > 0) {
      log.info(
        `已知别的机器人 ${knownBots.length} 个（从状态库恢复，重启不会忘）：` +
        knownBots.map((entry) => `${entry.id.slice(0, 8)}…${entry.name ? `(${entry.name})` : ''}`).join(' '),
      );
    }
  }
  const groupContext = new GroupContext({
    maxEntries: config.policy.group.contextSize,
    maxAgeMs: config.policy.group.contextMinutes * 60_000,
    cooldownMs: config.policy.group.cooldownMs,
    engagedCooldownMs: config.policy.group.engagedCooldownMs,
    minMessages: config.policy.group.minMessages,
    windowMs: config.policy.group.windowMs,
  });
  const groupTimers = new Map();
  // 「连发合并」的等待队列(2026-09-30,私聊专用)。
  // 规则在 `src\burst.js`(纯函数),**计时状态机在 `src\burst-queue.js`**(可测)——
  // 这里只把它接到真正的"跑一轮"上。`onReady` 要等 `runBurstTurn` 定义好才能引用,
  // 所以用箭头函数延后绑定(它只在计时器到点时才被调用)。
  const burstQueue = createBurstQueue({
    intervalMs: config.policy.c2cDebounceMs,
    isBusy: (conversationKey) => runner.isBusy(conversationKey),
    onReady: (conversationKey, bursts, message, imageMessage) => {
      // 「没点名」的那一路(群聊里被文字/图片触发、@ 之后的连发合并之外的自动回复)
      // 才做"窗内补图";被 @ / 私聊仍然只喂触发那一条(见 `conversationImageCarry`)。
      const autoTargets = message?.scene === 'group' && !message.isMention ? [message.targetId] : [];
      void runBurstTurn(conversationKey, bursts, message, { autoTargets, imageMessage });
    },
    onInfo: (line) => log.info(line),
  });
  // The newest message per group, so a debounce-triggered reply can still see the
  // image that prompted it — the timer itself carries no message.
  const lastGroupMessage = new Map();
  /**
   * **这个会话最近几分钟出现过的图**(群:2026-10-02 修"识图时有时无";私聊:2026-10-16 修"追问轮盲")。
   *
   * 群聊的病根是结构性的:群聊里**非 @ 的图**走的是防抖 + 条数门槛那条路,不当场进模型;
   * 而回复时只取"触发那一条消息"的图 —— 于是"几个人连着发、图夹在中间"时,
   * 她回的是最后那条文字,**那些图根本没上桌**(用户现场感受:「两个机器人识图时有时无,特别是副实例」)。
   *
   * 私聊的病根(2026-10-16 现场):「发一张图(红) → 隔 6 秒问"这是什么颜色"」——
   * 带图那一轮看得见,**追问那条是纯文字,图不在桌上**,模型拿历史旧图 pattern-match
   * (答了"白的",实际是红)。隔离两发对照:带图答"红色"、不带图老实说看不到 ⇒ 缺的是追问轮带图。
   *
   * 规则与判据在 `src\image-carry.js`(纯逻辑,有测试);群与私聊**同一个实例**——
   * `targetId`(群 id / 私聊 openid)天然不撞。
   * ⚠️ 日志要写清**取了几张、来自几条消息** —— 否则"时有时无"永远查不出是路径问题还是模型问题。
   */
  const conversationImageCarry = createConversationImageCarry();
  // T2:动作观察账(进程内快照,TTL/封顶见模块)——聊天轮经事实通道读取,别的群看不见。
  const actionLog = createActionLog();
  /** 同群最近/进行中的搬图任务 → 一行事实(没有=null,不硬塞)。 */
  const meituActionFact = (message) => {
    if (message.scene !== 'group') return null;
    const scope = `group:${message.targetId}`;
    const running = actionLog.running(scope, { kind: 'meitu' });
    if (running) return describeMeituTask(running);
    const latest = actionLog.latest(scope, { kind: 'meitu' });
    return latest ? describeMeituTask(latest) : null;
  };
  /** 引用解析(T3/T4):入站引用 id → 同 bot/同群发送绑定 → 事实行 + (图库可达且文件在时)像素块。
   *  像素取回失败/文件丢失 → 只保留事实行,**不换图、不编内容**。 */
  const resolveReferenceMedia = (message) => {
    const refId = message.replyToMessageId ?? null;
    if (!refId || message.scene !== 'group') return null;
    let links = [];
    try {
      links = stateStore.mediaLinksByOutbound({
        bot: gateway.botName || 'bot', scene: 'group',
        target: message.targetId, outboundId: String(refId),
      });
    } catch (err) {
      log.warn(`媒体引用查找失败（不影响回话）: ${err?.message ?? err}`);
      return null;
    }
    if (links.length === 0) return null;
    const first = links[0];
    const fact = `你引用的消息是她发的图（第 ${first.itemSeq} 张` +
      `${first.md5 ? `，内容指纹 ${String(first.md5).slice(0, 8)}…` : ''}）—— 谈论图片内容时以这张为准`;
    let block = null;
    if (first.md5 && meituGallery) {
      try {
        const row = meituGallery.findByMd5(String(first.md5));
        const filePath = row?.file_path ?? row?.filePath ?? null;
        if (filePath && fs.existsSync(filePath)) {
          block = localImageBlock({ path: filePath, mimeType: mimeForImagePath(filePath) });
        }
      } catch (err) {
        log.warn(`引用图像素取回失败（只保留事实行）: ${err?.message ?? err}`);
      }
    }
    return { fact, block };
  };
  function rememberConversationImages(key, message) {
    conversationImageCarry.remember(key, message);
  }
  /** 没点名/追问时,把时间窗内**其他**消息的图也带上(触发那条已经在首位了)。 */
  function carriedConversationSources(key, triggerMessage) {
    return conversationImageCarry.sources(key, triggerMessage);
  }
  // When each group last saw any message. Tracked separately from the context
  // buffer because a reply clears that buffer, and the warmer must still know
  // how long the group has really been quiet.
  const lastGroupActivity = new Map();
  // 每个群**最后一条真人消息**的时刻 —— 「读空气」的判据(D72)。
  // ⚠️ 与 `lastGroupActivity` 分开:那个连机器人自己的噪音也算(防抖要用),
  // 而"别人还在不在你一句一句"只该看**真人**。见 `src\social.js`。
  const lastGroupHumanAt = new Map();
  // When the bot last actually spoke in each group — a reply, a greeting or an
  // earlier warm-up. Two bot messages in a row read as a glitch, so a warm-up
  // refuses to land within `gapMs` of one. Recorded centrally in sendChunked so
  // a future send path cannot forget to.
  const lastBotUtteranceAt = new Map();
  // Per-group warm-up scheduling state; a group with no entry has not been seen
  // before. Values are objects — see `normalizeWarmupEntry` for the shape.
  const warmupState = new Map();
  // Per-conversation mood (see mood.js). In memory only: a mood is a property of
  // the live exchange, and the TTL is minutes, so persisting it would only
  // resurrect a stale tone after a restart.
  const moodState = new Map();
  // Deferred morning greetings already reported, so one retry loop does not fill
  // the log with the same line every tick.
  const morningSkipsLogged = new Set();
  // When the bot last reacted to a gesture (poke / bare 表情), per group.
  const lastInteractionAt = new Map();
  let recentWarmupTopics = [];
  let warmupTimer = null;
  /** 只读面板(D106 第②步)的句柄:关的时候要关端口。 */
  let panelServer = null;
  // 经济(D42)的两个冷却:只存内存。重启就忘 = 重启后可能立刻又接一次委托,
  // 而"钱"本身是落盘的,所以最坏情况只是多赚一次小额 —— 不值得为它动库结构。
  // ⚠️ 这两个冷却**不再放内存**:重启会归零,而重启后第一轮必定掷中一次委托
  //    (用户 2026-10-02 报的"问认不认识我,钱怎么多了")。现在存 `meta`,见 `readEconomyClock`。

  const setWarmupEntry = (groupId, entry) => {
    warmupState.set(groupId, entry);
    stateStore.setWarmup(groupId, entry);
  };

  /** `HH:MM:SS` in local time, for the log lines that talk about plans. */
  const clockOf = (ms) => new Date(ms).toTimeString().slice(0, 8);

  // Restore the schedule from disk, so a restart does not push every warm-up a
  // full period into the future — which, across a day of restarts, meant none.
  // An entry whose warm-up is still *pending* has no fresh `lastWarmupAt`, so
  // `slotKey` counts too: otherwise a restart would re-roll the slot and hand
  // the group an extra chance every time the bridge came back.
  const restoredWarmups = Object.entries(stateStore.allWarmup())
    .filter(([, entry]) => Number.isSafeInteger(entry?.lastWarmupAt) || Number.isSafeInteger(entry?.slotKey));
  for (const [groupId, entry] of restoredWarmups) {
    warmupState.set(groupId, normalizeWarmupEntry(entry));
  }
  if (restoredWarmups.length > 0 && config.policy.warmup.enabled) {
    const warmupConfig = config.policy.warmup;
    if (warmupConfig.mode === 'random') {
      const plans = [...warmupState.values()]
        .map((entry) => entry.plan)
        .filter((plan) => Number.isSafeInteger(plan));
      const note = plans.length > 0
        ? `最近一次计划在 ${clockOf(Math.min(...plans))}`
        : '当前槽均无发言计划';
      log.info(`暖群：从状态文件恢复 ${restoredWarmups.length} 个群的排期（${note}）`);
    } else {
      const nextDue = Math.min(
        ...[...warmupState.values()].map((entry) => (entry.lastWarmupAt ?? Date.now()) + warmupConfig.intervalMs),
      );
      const minutes = Math.max(0, Math.ceil((nextDue - Date.now()) / 60_000));
      log.info(`暖群：从状态文件恢复 ${restoredWarmups.length} 个群的计时，最近一个约 ${minutes} 分钟后到期`);
    }
  }
  // Nudges used on recent turns, so the same instruction does not repeat twice
  // in a row. Tracked globally: every conversation benefits from the variety.
  let recentNudges = [];
  // **emoji 单发的"最近用过"**(1.171.2 / D290):小环,给 pickAvoiding 防连发同款。
  let recentSpokenEmoji = [];
  let shuttingDown = false;

  /** Whether the group has been quiet long enough to be worth warming. */
  function quietEnough(groupId, now) {
    const lastActivity = lastGroupActivity.get(groupId) ?? 0;
    return now - lastActivity >= config.policy.warmup.quietMs;
  }

  /** Whether enough time has passed since the bot last spoke in this group. */
  function gapElapsed(groupId, now) {
    const gapMs = config.policy.warmup.gapMs;
    if (gapMs <= 0) return true;
    const spokeAt = lastBotUtteranceAt.get(groupId);
    return spokeAt === undefined || now - spokeAt >= gapMs;
  }

  const WAIT_REASONS = {
    busy: '这个会话正在跑别的回合',
    noisy: '群里还有人说话',
    'just-spoke': '自己刚在这个群说过话',
  };

  /**
   * Check every known group and warm up whichever is due.
   *
   * Besides the schedule, a warm-up needs the group to be quiet, the bot not to
   * have just spoken there, and no turn already running on that conversation.
   * Warming a group mid-conversation would be both pointless and intrusive.
   */
  async function warmupTick() {
    const warmupConfig = config.policy.warmup;
    if (!warmupConfig.enabled) return;

    const now = Date.now();
    const hour = new Date(now).getHours();
    if (isWithinSleepWindow(hour, warmupConfig.sleep)) {
      log.debug(`暖群：当前 ${hour} 点落在睡眠时段，跳过`);
      return;
    }

    // Groups restored from disk count even if they have been silent since start-up.
    const groups = new Set([...groupContext.knownGroups(), ...warmupState.keys()]);
    if (groups.size === 0) {
      log.debug('暖群：还不认识任何群，等第一条消息');
      return;
    }

    if (warmupConfig.mode === 'random') await warmupTickRandom(now, groups);
    else await warmupTickInterval(now, groups);
  }

  /**
   * The original schedule: warm every group whose interval has elapsed.
   *
   * Kept as a selectable mode so the new schedule can be rolled back with an
   * `.env` edit instead of a code revert (D21).
   */
  async function warmupTickInterval(now, groups) {
    const warmupConfig = config.policy.warmup;

    for (const groupId of groups) {
      // First sighting: begin the clock rather than firing now, so a fresh
      // install does not open with a burst of warm-ups.
      const entry = warmupState.get(groupId);
      if (!entry) {
        setWarmupEntry(groupId, normalizeWarmupEntry({ lastWarmupAt: now }));
        log.info(`暖群：首次记录群 ${groupId}，${Math.round(warmupConfig.intervalMs / 60_000)} 分钟后到期`);
        continue;
      }

      const dueInMs = warmupConfig.intervalMs - (now - (entry.lastWarmupAt ?? now));
      if (dueInMs > 0) {
        log.debug(`暖群：群 ${groupId} 距到期还有 ${Math.ceil(dueInMs / 60_000)} 分钟`);
        continue;
      }
      if (!quietEnough(groupId, now)) {
        log.debug(`暖群：群 ${groupId} 刚还有人说话，等它安静`);
        continue;
      }
      if (!gapElapsed(groupId, now)) {
        log.debug(`暖群：群 ${groupId} 自己刚说过话，再等等`);
        continue;
      }
      if (runner.isBusy(sessionIdFor({ scene: 'group', targetId: groupId }))) {
        log.debug(`暖群：群 ${groupId} 有会话在进行，跳过`);
        continue;
      }

      // The clock advances whether or not the model ends up speaking, exactly as
      // it did before this mode became selectable.
      setWarmupEntry(groupId, { ...entry, lastWarmupAt: now });
      await warmUpGroup(groupId);
    }
  }

  /**
   * The slot schedule: each group gets at most one *chance* per slot, takes it
   * about half the time, and the moment is drawn fresh for every group — which
   * is what stops two groups from warming in lockstep every hour (D21).
   */
  async function warmupTickRandom(now, groups) {
    const warmupConfig = config.policy.warmup;
    const slot = warmupSlot(now, { slotMs: warmupConfig.slotMs, sleep: warmupConfig.sleep });
    if (!slot) {
      log.debug('暖群：当前槽整段落睡眠时段，跳过');
      return;
    }
    const slotLabel = `${clockOf(slot.start)}-${clockOf(slot.end)}`;

    for (const groupId of groups) {
      const entry = warmupState.get(groupId);
      const decision = warmupDecision(entry, {
        now,
        slot,
        baseChance: warmupConfig.chance,
        minChance: warmupConfig.minChance,
        engageWindowMs: warmupConfig.engageWindowMs,
        roll: Math.random(),
        offset: Math.random(),
        quietOk: quietEnough(groupId, now),
        gapOk: gapElapsed(groupId, now),
        busy: runner.isBusy(sessionIdFor({ scene: 'group', targetId: groupId })),
      });

      if (decision.action === 'idle') {
        if (Number.isSafeInteger(entry?.plan)) {
          log.debug(`暖群：群 ${groupId} 计划 ${clockOf(entry.plan)} 发言，还没到点`);
        }
        continue;
      }
      if (decision.action === 'wait') {
        const why = WAIT_REASONS[decision.reason] ?? decision.reason;
        log.debug(`暖群：群 ${groupId} 计划时刻到了，但${why} —— 等到槽末再看`);
        continue;
      }
      if (decision.action === 'first-sighting') {
        setWarmupEntry(groupId, decision.entry);
        log.info(`暖群：首次记录群 ${groupId}，本槽（${slotLabel}）不发言，下个槽开始掷骰`);
        continue;
      }
      if (decision.action === 'rolled-miss' || decision.action === 'rolled-hit') {
        setWarmupEntry(groupId, decision.entry);
        const percent = Math.round(decision.chance * 100);
        const misses = decision.entry.misses;
        const decay = misses > 0 ? `，连续 ${misses} 次没人接话` : '';
        if (decision.abandoned) {
          log.info(`暖群：群 ${groupId} 上一槽的计划作废（槽已结束，不补发）`);
        }
        if (decision.action === 'rolled-miss') {
          recordMetrics([{ key: 'warmup.miss', value: 1, scope: groupId }]);
          log.info(`暖群：群 ${groupId} 槽 ${slotLabel} 未命中（概率 ${percent}%${decay}）—— 本槽不发言`);
        } else {
          recordMetrics([{ key: 'warmup.hit', value: 1, scope: groupId }]);
          log.info(`暖群：群 ${groupId} 槽 ${slotLabel} 命中（概率 ${percent}%${decay}）→ 计划 ${clockOf(decision.entry.plan)} 发言`);
        }
        continue;
      }
      if (decision.action === 'drop') {
        setWarmupEntry(groupId, decision.entry);
        log.info(`暖群：群 ${groupId} 计划 ${clockOf(entry.plan)} 一直没能开口，槽已结束 —— 本槽放弃，不补发`);
        continue;
      }

      // `fire`: consume the plan first, so a crash or restart mid-turn cannot
      // replay it.
      setWarmupEntry(groupId, decision.entry);
      const sent = await warmUpGroup(groupId);
      if (sent) {
        // 命中 ≠ 真开口(可能被睡眠/闸门/空回复挡下)—— 这两个数分开记,命中率才不骗人。
        recordMetrics([{ key: 'warmup.speak', value: 1, scope: groupId }]);
        const spokeAt = Date.now();
        setWarmupEntry(groupId, { ...warmupState.get(groupId), lastWarmupAt: spokeAt, awaitingSince: spokeAt });
      }
    }
  }

  /**
   * Send the daily greeting to every configured target, at most once a day each.
   *
   * Fires inside a grace window rather than at an exact minute, so a bridge that
   * was starting up when the clock struck still greets a little later.
   */
  /**
   * 「她自己的生活在转」(D99 阶段 2,用户 2026-10-02 要的)。
   *
   * 用户原话:「在没有互动时主实例**饱食度过低会自己去吃饭并且报备出来**(感觉可以代替暖群)」。
   *
   * 这一拍做三件事,顺序**刻意**是这样:
   *   ① `decideSelfCare()`(**纯函数**,可测)判"现在轮到她过日子了吗";
   *   ② **先把事实结算掉**(吃饭真的花钱、真的涨饱食 —— 钱只和她的世界的商店/餐厅绑定);
   *   ③ 再把这件事交给她**用自己的话说出来**(报备)。
   *
   * ⚠️ 三条纪律:主动消息配额(所以有 `gapMs` 与"一次只对一个目标开口")、
   * 睡眠时段不开口、别人刚说完话不插嘴。都在 `src\selfcare.js` 里,那里是纯函数。
   */
  let lastSelfCareAt = null;
  /** 最后一次**真人**说话的时刻(群/私聊都算)—— "没人互动"的判据就是它。 */
  let lastHumanAtAll = null;
  /**
   * 这一轮要收尾的**挂起事件**(D99 阶段 3):她在上面抛过一件"未解决的事",
   * 现在有人回了 → 这一轮把它结掉(数值由代码给)。
   * ⚠️ 与 `turnStatDeltas` 同一族的"每轮记账"闭包变量:进来时重设、`composeReply` 里消费掉。
   */
  let pendingStory = null;
  /** 这一轮"你俩在做什么"(D101 形态一);和 `pendingStory` 同一族的每轮变量。 */
  let pendingCompany = null;
  /** 定时器那一拍的状态:用来发现"上一拍还没跑完"(说明某个 await 挂住了)。 */
  let tickBusy = false;
  let tickStartedAt = 0;

  /** 事件钩子的**稳定键** —— 不能用会话 key(它每换代就变,重启就找不到)。 */
  function storyKeyFor(message) {
    return message.scene === 'group' ? `group:${message.targetId}` : `c2c:${config.qq.appId}`;
  }

  /**
   * 这一轮**该不该**用那条挂起事件。
   *
   * ⚠️ **必须按会话核对**:`pendingStory` 是一个全局闭包变量,而**群里的非 @ 消息只进缓冲、
   * 当场不跑模型** —— 那条消息会把钩子挂上却不消费它。要是下一条触发的是**另一个群**的回复,
   * 不核对就会把 A 群的事拿到 B 群去收尾(而且 A 群那条还留在库里)。
   */
  function pendingStoryFor(message) {
    if (!pendingStory || !message) return null;
    return pendingStory.pending.key === storyKeyFor(message) ? pendingStory : null;
  }

  async function selfCareTick() {
    const cfg = config.policy.selfcare;
    if (!cfg?.enabled) return;
    const now = Date.now();

    // ⚠️ **优先级 0(1.92.1)**:她刚自己走到某个地方 —— 那一句"报备"要**先于**吃饭/抛事件。
    //    理由:它是最新鲜、最便宜的一件事(不改数值、不开钩子),而且"她刚出门回来"是最想让人知道的事。
    //    ⚠️ 它同样要过**主动消息间隔**(1.95.2 复核抓到:出发那句 + 到达那句可能只隔 3~7 分钟,
    //       和"两条主动消息至少隔 gapMs"直接冲突)。⚠️ 被间隔挡住时**不盖"报过了"的戳** ——
    //       等间隔过去她再补报这一趟(那一趟在 30 分钟内都还算新鲜)。
    const arrived = decideArrivalReport(readWorldHer(), {
      now,
      // ⚠️ 1.106.0(D172):新鲜窗口不能比配额闸门还短 —— 否则"到了再补一句"永远轮不到
      //    (出发那句已经占掉 gapMs;窗口写死 30 分钟、而主实例的 gapMs 是 45 分钟)。
      withinMs: arrivalFreshnessMs({ gapMs: cfg.gapMs }),
    });
    const arrivalReady = arrived
      && (lastSelfCareAt === null || now - lastSelfCareAt >= cfg.gapMs);
    if (arrivalReady) {
      // 到达=**报备**(她自己走的一趟有结果了)→ 私聊操作者优先。
      const target = pickSelfCareTarget(cfg, now, 'arrive');
      if (target) {
        // ⚠️ **先标记"报过了"再发**:模型沉默/超时也不重复报(和"配额算用掉"同一条纪律)。
        markArrivalReported(now);
        await sendSelfCare(target, { action: 'arrive', arrival: arrived }, now);
        return;
      }
    }

    const decision = decideSelfCare({
      now,
      stats: currentStats(now),
      lastHumanAt: lastHumanAtAll,
      lastProactiveAt: lastSelfCareAt,
      sleep: config.policy.warmup.sleep,
      // ⚠️ 她此刻在哪儿(1.95.1):她挑中的活动不在那儿时,`decideSelfCare` 会给 `travel` ——
      //    先出门、到点落地、落地后自己说一句(D149 那条报备就是给这一趟用的)。
      currentPlace: herWhereabouts({ metas: [{ key: WORLD_HER_KEY, value: stateStore.getMeta(WORLD_HER_KEY) ?? '' }] }).placeId,
      options: {
        quietMs: cfg.quietMs,
        hungryBelow: cfg.hungryBelow,
        gapMs: cfg.gapMs,
        lifeEveryMs: cfg.lifeEveryMs,
        lifeChance: cfg.lifeChance,
      },
    });
    if (!decision) return;

    // ⚠️ 1.106.0(D172):**按"这一句是什么"选渠道** ——
    //    报备(eat/arrive)走**私聊操作者**;生活那一档的自发发言走**已知安静群**
    //    (一个安静的群都没有时回落私聊)。纯函数在 `selfcare.js` 的 `pickReportScene()`。
    const target = pickSelfCareTarget(cfg, now, decision.action);
    if (!target) return;
    if (decision.action === 'travel') {
      // ⚠️ **她自己出门**那一趟:位置事实带 `to` / `arriveAt` / `why='self'`
      //    (面板上那排「去XX」是 `player`,不由她报备 —— 两件事在这里分开)。
      await sendSelfCareTravel(target, decision, now);
      return;
    }
    await sendSelfCare(target, decision, now);
  }

  /** 读 `world:her` 那条事实(坏了/没有都给 null)。 */
  function readWorldHer() {
    try {
      const raw = stateStore.getMeta(WORLD_HER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /** 给"这一次到达"盖一个"报过了"的戳(只改 `world:her` 一个键)。 */
  function markArrivalReported(now) {
    try {
      const fact = readWorldHer();
      if (!fact) return;
      stateStore.setMeta(WORLD_HER_KEY, JSON.stringify({ ...fact, reportedAt: now }));
    } catch (err) {
      log.warn(`标记"到达已报备"失败（会导致下一次再报一遍）: ${describeError(err)}`);
    }
  }

  /**
   * **她自己出门那一趟**(1.95.1 / D151):写一条"在途"事实(`to` / `arriveAt` / `why='self'`),
   * 然后(可选地)说一句"我出门了"。到点落地、落地后报备 —— 那两步分别由 `travelTick` 与
   * `decideArrivalReport` 负责。
   *
   * ⚠️ 三条口径:
   *   ① **出门本身不动数值**(和面板那条路一致:位置不是数值);它也不开事件钩子;
   *   ② 台词是**可选**的:模型沉默/超时就当她安静地走了(不重试);
   *   ③ 写失败**不影响**任何东西(位置是"看得见"那一层)。
   */
  async function sendSelfCareTravel(target, decision, now) {
    const activity = decision.activity ?? {};
    const to = activity.place ? placeById(activity.place) : null;
    if (!to) return;
    try {
      const current = readWorldHer();
      const next = whereaboutsFromAction({
        kind: 'move.to', target: to.id, now, why: 'self', current,
      });
      if (!next) return;
      stateStore.setMeta(WORLD_HER_KEY, JSON.stringify(next));
      log.info(`她自己出门：往${to.name}走（${activity.id ?? ''}），到点 ${new Date(next.arriveAt).toTimeString().slice(0, 5)}`);
    } catch (err) {
      log.warn(`她自己出门：位置没写下去（不影响别的）: ${describeError(err)}`);
      return;
    }

    const conversationKey = sessionIdFor({ scene: target.scene, targetId: target.id });
    if (runner.isBusy(conversationKey)) return;
    if (target.scene === 'group') {
      const lastReplyAt = groupContext.stats(target.id).lastReplyAt;
      if (lastReplyAt !== null && now - lastReplyAt < config.policy.warmup.gapMs) return;
    }
    await semaphore.acquire();
    try {
      const mood = moodFor(conversationKey);
      const prompt = buildTravelReportPrompt({
        scene: target.scene,
        activity,
        placeName: activity.placeName ?? to.name,
        silentToken: SILENT_TOKEN,
      });
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(prompt, await turnNotes(mood, null, [], { conversation: conversationKey, query: activity.line ?? to.name })),
        config.policy.replyTimeoutMs,
      );
      lastSelfCareAt = now;
      if (result.timedOut || isSilentReply(result.text)) {
        log.info('她自己出门：模型认为不用开口，安静地走了');
        return;
      }
      // ⚠️ 1.106.2(D174):主动发言**一条条短句发**(不再砍尾巴)。
      const lines = planSpokenLines(composeReply(result), mood, { label: '她自己出门' });
      const synthetic = { scene: target.scene, targetId: target.id, messageId: undefined, content: '' };
      await sendSpokenLines(synthetic, lines, { typing: target.scene === 'c2c' });
      recordTurn('selfcare', { conversationKey, scene: target.scene, userText: activity.line ?? '', replyText: lines.join('\n') });
    } catch (err) {
      log.warn(`她自己出门：那一句没发出去（位置已经写了）: ${describeError(err)}`);
    } finally {
      semaphore.release();
    }
  }

  /**
   * 报备/自发发言发去哪(**1.106.0 / D172 起分渠道**):
   *   · **报备**(`eat` / `arrive`)→ 私聊操作者(那边只有操作者,不打扰别人);
   *   · **自发发言**(`life`:活动报备与事件钩子)→ **已知安静群**(她自己过日子被大家撞见),
   *     一个安静的群都没有时回落私聊(`QQBOT_SELFCARE_LIFE_TO=c2c` 可以整体退回老行为)。
   * ⚠️ "发去哪"这个判断本身是纯函数(`selfcare.js` 的 `pickReportScene`),这里只做取数。
   * ⚠️ **哪一个群**(1.106.1 / D173):排队规则也是纯函数(`orderSelfCareGroups`)——
   *    **最近还活跃过的安静群优先**(老规则是"最久没说话的优先",那正是死群),
   *    而 `QQBOT_SELFCARE_GROUP` 指定的群**钉在最前面**(测试用;它不需要在已知群清单里)。
   *    📌 现场(2026-10-10 18:14):`knownGroups()` 只认**本次进程收到过消息**的群(重启就重置),
   *    所以重启后如果只在一个群说过话,她就只会挑那一个 —— "有的群从来没被暖过"有一半是这个原因。
   */
  function pickSelfCareTarget(cfg, now, action = 'life') {
    const ranked = orderSelfCareGroups({
      groups: groupContext.knownGroups().map((groupId) => ({
        id: groupId,
        lastHumanAt: lastGroupHumanAt.get(groupId) ?? 0,
      })),
      quietMs: cfg.quietMs,
      now,
      preferred: cfg.group,
    });
    const c2c = cfg.c2cTarget ? { scene: 'c2c', id: cfg.c2cTarget, key: `c2c:${cfg.c2cTarget}` } : null;
    const scene = pickReportScene({
      action,
      hasC2c: Boolean(c2c),
      quietGroups: ranked,
      spontaneousTo: cfg.lifeTo,
    });
    if (scene === 'c2c') return c2c;
    if (scene === 'group') return { scene: 'group', id: ranked[0], key: `group:${ranked[0]}` };
    return null;
  }

  /** 把"她刚刚自己做了什么"结算掉,再让她说一句(报备)。 */
  async function sendSelfCare(target, decision, now) {
    const conversationKey = sessionIdFor({ scene: target.scene, targetId: target.id });
    if (runner.isBusy(conversationKey)) return;
    // 群里还要守住"别在别人刚说完话时插嘴"(和暖群同一条纪律)。
    if (target.scene === 'group') {
      const lastReplyAt = groupContext.stats(target.id).lastReplyAt;
      if (lastReplyAt !== null && now - lastReplyAt < config.policy.warmup.gapMs) return;
    }

    // ② **事实先结算**:吃饭真的花钱、真的涨饱食(免单只对"别人请的"生效,这一顿是她自己掏钱)。
    //    `life` 那一档**不结算数值** —— 它要么开"事件钩子"(事情抛出去了,结果要等回应,
    //    那一步才落账,D99 阶段 3),要么只是"她在干嘛"的一句报备(1.106.0 / D172)。
    let story = null;
    if (decision.action === 'arrive') {
      // ⚠️ **不结算任何数值、也不开事件钩子**(1.92.1):"她走到了"只值一句话 ——
      //    位置事实在 travelTick 里已经落好了;这一轮唯一的产出就是那句报备。
      log.info(`她到了 ${decision.arrival.placeName}（自己走的一趟）—— 报备一句`);
    } else if (decision.action === 'eat') {
      try {
        const { stats } = stateStore.applyIntake(
          { food: decision.eatery.food, kcal: decision.eatery.kcal, paidBy: 'self', source: 'selfcare' },
          now,
          { sleep: config.policy.warmup.sleep },
        );
        log.info(
          `她自己吃饭：${decision.eatery.place} · ${decision.eatery.food} ${decision.eatery.kcal}kcal · ` +
          `花 ${mealCost(decision.eatery.kcal)} ${CURRENCY.name} → 饱食 ${Math.round(stats.satiety)}、` +
          `${CURRENCY.name} ${Math.round(stats.money)}`,
        );
      } catch (err) {
        log.warn(`她自己吃饭结算失败（不影响这一轮对话）: ${describeError(err)}`);
      }
    } else if (isStoryActivity(decision.activity) && storyPack) {
      // ⚠️ **只有标了 `story` 的活动才抛钩子**(1.106.0 / D172;纯函数 `isStoryActivity`)。
      //    P4:`storyPack` 是**本角色自己的**事件表;没有包的角色走下面"只报备"那一支。
      //    抛一个**未解决**的小事件,落盘等回应(超时那一拍会来收尾)。
      story = openStory({ now, events: storyPack.events });
      try {
        stateStore.openPendingEvent({
          key: target.key,
          scene: target.scene,
          targetId: target.id,
          eventId: story.event.id,
          setup: story.event.setup,
          branches: story.event.branches,
          openedAt: story.openedAt,
          expiresAt: story.expiresAt,
        });
        log.info(
          `事件钩子：抛出「${story.event.id}」（活动 ${decision.activity?.id ?? ''}）—— ${story.event.setup}（等回应到 ` +
          `${new Date(story.expiresAt).toTimeString().slice(0, 5)}）`,
        );
      } catch (err) {
        log.warn(`事件钩子落盘失败（这一轮照常开口，只是超时收不了尾）: ${describeError(err)}`);
      }
    } else {
      // ⚠️ **1.106.0 / D172:其余 11 条活动就是"她在干嘛"** —— 不抛钩子、不开状态机,
      //    台词走 `buildSelfCarePrompt({action:'life'})`(那条路 1.99.0 就写好了,却一直没人调用:
      //    13 条多场景活动**从来没有进过她的嘴**,只写进了"她在哪"的事实 —— 用户说的
      //    「[多场景自由活动]能不能接上私聊报备/群聊自发发言」缺的就是这一段)。
      log.info(
        `她自己过日子：${decision.activity?.id ?? ''}（${decision.activity?.placeName ?? ''}）` +
        `—— 只报一句在干嘛，不抛钩子`,
      );
    }

    // ⚠️ **休闲结算**与"抛不抛钩子"无关:原来它长在"一定是钩子"那个分支里,
    //    1.106.0 拆开两条路之后要**单独放在外面**,否则那 11 条活动会静默少掉
    //    `INTERACTIONS.rest`(+3 心情 / +6 体力)—— 那是没人要求的行为变化。
    if (decision.action === 'life') {
      try {
        stateStore.applyInteraction('rest', now, { sleep: config.policy.warmup.sleep });
      } catch (err) {
        log.warn(`她自己休息的结算失败（不影响这一轮对话）: ${describeError(err)}`);
      }
    }

    // ③ **写一条"她此刻在哪"的事实**(1.85.0 / D140)。
    //    ⚠️ 事实由**代码**写、**带过期时间**:页面与 QQ 报幕读的都是这一条(`herWhereabouts`),
    //    所以"她自己动起来"这件事**两端同时生效**,不需要各自改一遍。
    //    ⚠️ 写失败**不影响这一轮说话**(她该报备还是要报备,只是页面会显示"不知道她在哪")。
    //    ⚠️ **`arrive` 那一档不写这里**:她走到地方时,`travelTick` 已经把那条事实落好了 ——
    //       这里再写一遍会把它踩掉(连 `arrivedAt` / `reportedAt` 一起丢)。
    try {
      const where = decision.action === 'arrive'
        ? null
        : whereaboutsFromDecision(decision, {
          now,
          // ⚠️ 1.106.0(D172):`life` 那一档的事实要**撑到下一次轮到她**(`lifeEveryMs`),
          //    否则 30 分钟就过期、而两次生活之间至少 3 小时 → `currentPlace` 永远是"不知道",
          //    "她挑中的活动不在她现在这个地方就先走一趟"这条路**永远进不去**
          //    (现场:`她自己出门` 0 次、`她走到了` 0 次)。派生规则见 `whereaboutsTtlMs()`。
          ttlMs: whereaboutsTtlMs({
            action: decision.action,
            whereTtlMs: Number(config.policy.selfcare?.whereaboutsTtlMs) || 30 * 60_000,
            // ⚠️ 这一句在 `sendSelfCare()` 里,`cfg`(那是个 tick 里的局部名)**在这里不存在** ——
            //    1.106.0 第一版写了 `cfg.lifeEveryMs`,于是 2026-10-10 18:14 的现场是
            //    `ReferenceError: cfg is not defined`(被 try 兜住:位置没写下去,页面说"不知道她在哪")。
            //    这正是 `scripts\handoff.js` 那句"单测覆盖不到 main() 的装配段"的形状 —— 从 config 取。
            lifeEveryMs: config.policy.selfcare?.lifeEveryMs,
          }),
        });
      if (where) {
        stateStore.setMeta(WORLD_HER_KEY, JSON.stringify(where));
        log.info(`她的位置：${where.placeName}${where.where ? `（${where.where}）` : ''} · ${where.doing}`);
      }
    } catch (err) {
      log.warn(`写"她此刻在哪"失败（页面会显示不知道她在哪，不影响这一轮）: ${describeError(err)}`);
    }

    await semaphore.acquire();
    try {
      const mood = moodFor(conversationKey);
      let prompt;
      let query;
      if (decision.action === 'arrive') {
        prompt = buildArrivalReportPrompt({
          scene: target.scene,
          arrival: decision.arrival,
          silentToken: SILENT_TOKEN,
        });
        query = decision.arrival.line;
      } else if (decision.action === 'eat') {
        prompt = buildSelfCarePrompt({
          scene: target.scene,
          action: decision.action,
          eatery: decision.eatery,
          currency: CURRENCY.name,
          silentToken: SILENT_TOKEN,
        });
        query = decision.eatery.line;
      } else if (story) {
        prompt = buildStoryOpenPrompt({ scene: target.scene, event: story.event, silentToken: SILENT_TOKEN });
        query = story.event.setup;
      } else {
        // ⚠️ 1.106.0(D172):生活那一档的**普通活动报备** —— 就是"她在干嘛",
        //    事实由代码给(活动那一行 `line` 里已经有地点),台词仍然是她的。
        prompt = buildSelfCarePrompt({
          scene: target.scene,
          action: 'life',
          activity: decision.activity,
          currency: CURRENCY.name,
          silentToken: SILENT_TOKEN,
        });
        query = decision.activity?.line ?? '';
      }
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(prompt, await turnNotes(mood, null, [], { conversation: conversationKey, query })),
        config.policy.replyTimeoutMs,
      );

      // ⚠️ 不管她说不说,这一拍的配额都算用掉了 —— 否则模型一沉默,下一拍立刻再来一遍。
      lastSelfCareAt = now;
      if (result.timedOut || isSilentReply(result.text)) {
        log.info(`她自己过日子（${decision.action}）：模型认为不适合开口，跳过`);
        return;
      }

      // ⚠️ 1.106.2(D174):她自己冒泡那两句,原来被砍到只剩第一句(现场 64 → 28 字)——
      //    现在按短句分条发,一个字不丢。日志写"几条 / 共多少字",不再只写一条的长度。
      const lines = planSpokenLines(composeReply(result), mood, { label: '她自己过日子' });
      const synthetic = { scene: target.scene, targetId: target.id, messageId: undefined, content: '' };
      await sendSpokenLines(synthetic, lines, { typing: target.scene === 'c2c' });
      log.info(
        `她自己过日子：${decision.action}${story ? '（事件钩子）' : ''} 已开口 → ${target.key}` +
        ` ${lines.length} 条 / 共 ${lines.reduce((sum, one) => sum + one.length, 0)} 字（主动消息）`,
      );
      recordTurn('selfcare', { conversationKey, scene: target.scene, userText: query, replyText: lines.join('\n') });
    } catch (err) {
      log.error(`她自己过日子失败 ${target.key}`, err);
      lastSelfCareAt = now;
    } finally {
      semaphore.release();
    }
  }

  /**
   * **超时自决**(D99 阶段 3):她抛出去的那件事没人答 → 她自己决定走向,把这件事结掉。
   *
   * 用户原话:「如果没有互动则在一段时间后**自己决定走向**」+「最后说主实例去休息/洗澡/睡觉等等
   * 休闲行为(互动事件结束)」。所以这里**必须**:① 落一笔数值(事件要有结果);
   * ② 让她把收尾那句说出来(模型沉默也照样落账,只是没人听见 —— 总比"没有结果"强)。
   */
  async function storyTimeoutTick() {
    if (!config.policy.selfcare?.enabled) return;
    let pendingList = [];
    try {
      pendingList = stateStore.listPendingEvents();
    } catch (err) {
      log.warn(`读挂起事件列表失败: ${describeError(err)}`);
      return;
    }
    const now = Date.now();
    for (const pending of pendingList) {
      if (!storyExpired({ now, expiresAt: pending.expiresAt })) continue;
      await closeStoryBySelf(pending, now);
    }
  }

  async function closeStoryBySelf(pending, now) {
    const conversationKey = sessionIdFor({ scene: pending.scene, targetId: pending.targetId });
    const event = { setup: pending.setup, branches: pending.branches };
    // ⚠️ **先结算、再说话**:哪怕模型超时/不说话,这件事也**一定有结果**(用户点名的)。
    const branch = pickSelfDecidedBranch(event, Math.random);
    try {
      const { stats, event: row } = stateStore.applyStoryResult(
        branch.effect ?? {},
        now,
        { eventId: pending.eventId, branch: branch.id, line: branch.line, pickedBy: 'timeout' },
        { sleep: config.policy.warmup.sleep },
      );
      stateStore.clearPendingEvent(pending.key);
      log.info(
        `事件钩子超时自决：「${pending.eventId}」→ ${branch.id}｜${branch.line}｜` +
        `钱 ${Math.round(stats.money)}、心情 ${Math.round(stats.mood)}`,
      );
      void row;
    } catch (err) {
      log.warn(`事件钩子超时结算失败: ${describeError(err)}`);
      return;
    }

    if (runner.isBusy(conversationKey)) {
      log.info(`事件钩子：${pending.key} 的会话正忙，这一拍只落了账，收尾那句等下一拍`);
      return;
    }
    await semaphore.acquire();
    try {
      const mood = moodFor(conversationKey);
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(
          buildStorySettlePrompt({ scene: pending.scene, event, silentToken: SILENT_TOKEN }),
          await turnNotes(mood, null, [], { conversation: conversationKey, query: pending.setup }),
        ),
        config.policy.replyTimeoutMs,
      );
      if (result.timedOut || isSilentReply(result.text)) {
        log.info(`事件钩子：${pending.eventId} 已落账，模型选择不开口`);
        return;
      }
      const lines = planSpokenLines(composeReply(result), mood, { label: `事件钩子收尾(${pending.eventId})` });
      const synthetic = { scene: pending.scene, targetId: pending.targetId, messageId: undefined, content: '' };
      await sendSpokenLines(synthetic, lines, { typing: pending.scene === 'c2c' });
      log.info(
        `事件钩子：${pending.eventId} 的收尾已发出 → ${pending.key}` +
        ` ${lines.length} 条 / 共 ${lines.reduce((sum, one) => sum + one.length, 0)} 字（主动消息）`,
      );
      recordTurn('selfcare', {
        conversationKey,
        scene: pending.scene,
        userText: pending.setup,
        replyText: lines.join('\n'),
      });
    } catch (err) {
      log.error(`事件钩子收尾失败 ${pending.key}`, err);
    } finally {
      semaphore.release();
    }
  }

  /**
   * **群列表每天更新一次**(用户 2026-10-02:「群列表要每天更新」)。
   *
   * 为什么要它:`known_group` 只进不出 —— 她已经不在的群会**永远留在清单里**,
   * 于是一到播报就发失败(平台报 `40034101 机器人非群成员`)、`/群列表` 也照列。
   *
   * "还在不在"**只有平台知道**,所以判据是**逐个问平台**(`api.getGroupInfo`);
   * 问不到(报错)= 不在了 → 从清单里摘掉。**一天只做一次**(`meta` 记时刻),
   * 免得每 30 秒去敲一遍平台接口。
   */
  const GROUP_AUDIT_INTERVAL_MS = 24 * 3_600_000;
  async function groupAuditTick() {
    const last = Number(stateStore.getMeta('groups:audited_at')) || 0;
    if (Date.now() - last < GROUP_AUDIT_INTERVAL_MS) return;
    stateStore.setMeta('groups:audited_at', String(Date.now()));
    let rows = [];
    try {
      rows = stateStore.knownGroups();
    } catch (err) {
      log.warn(`群清单审计:读不出来: ${describeError(err)}`);
      return;
    }
    let dropped = 0;
    for (const row of rows) {
      try {
        await api.getGroupInfo(row.id);
      } catch (err) {
        try {
          stateStore.forgetGroup(row.id);
          dropped += 1;
          log.info(`群清单审计：摘掉 ${row.id.slice(0, 8)}…（${describeError(err)}）`);
        } catch (inner) {
          log.warn(`群清单审计:摘不掉 ${row.id.slice(0, 8)}…: ${describeError(inner)}`);
        }
      }
    }
    log.info(`群清单审计：${rows.length} 个已知群，摘掉 ${dropped} 个（每天一次）`);
  }

  /**
   * 清掉**旧键格式**的钓鱼记录(一次性)。
   *
   * 1.57 之前钓位按会话存(`fishing:group:<群id>`,没有发起人那一段);改成按人之后,
   * 那些旧键还在库里,而且它们**照样会到点收网** —— 用户会莫名其妙收到几条"上钩了"。
   * 判据:键必须是**四段**(`fishing:<scene>:<targetId>:<userId>`),不足四段的删掉。
   */
  function cleanupLegacyFishing() {
    try {
      // ⚠️ `listMetaKeys()` 返回的是**对象数组**(`{key, value, updatedAt}`),不是字符串数组 ——
      //    第一版当成字符串用(`key.split(':')`),于是这里每一次都抛 TypeError 被 catch 吞掉,
      //    表现就是"清理从来没生效"。**同一个错在"列钓位那一拍"里也在**
      //    (现在它在 `src\fishing-adapter.js` 的 `tick()` 里 —— D108 把那层抽走了)。
      const rows = stateStore.listMetaKeys('fishing:') ?? [];
      let removed = 0;
      for (const row of rows) {
        if (String(row.key).split(':').length < 4) {
          // ⚠️ **必须真的删**(不是写空串):写空串的话键还在,这段就会每 30 秒重跑一遍。
          stateStore.forgetMeta(row.key);
          removed += 1;
        }
      }
      if (removed > 0) log.info(`钓鱼：清掉 ${removed} 条旧格式的钓位（1.57 之前按会话存的）`);
    } catch (err) {
      log.warn(`清理旧钓位失败: ${describeError(err)}`);
    }
  }

  async function morningTick() {
    const cfg = config.policy.morning;
    if (!cfg.time) return;

    const now = new Date();
    const date = localDateKey(now);

    const targets = [];
    if (cfg.c2cTarget) targets.push({ scene: 'c2c', id: cfg.c2cTarget, key: `c2c:${cfg.c2cTarget}` });
    for (const groupId of groupContext.knownGroups()) {
      targets.push({ scene: 'group', id: groupId, key: `group:${groupId}` });
    }
    if (targets.length === 0) return;

    for (const target of targets) {
      const status = morningStatus({
        now,
        time: cfg.time,
        graceMs: cfg.graceMs,
        lastDate: stateStore.getMorning(target.key)?.date,
      });
      if (status === 'early') return; // Not yet today, so nothing else can be due.
      if (status !== 'due') continue;

      await sendMorning(target, date);
    }
  }

  /**
   * One greeting, to one conversation.
   *
   * @param {{scene: string, id: string, key: string}} target
   * @param {string} date local `YYYY-MM-DD`, marked once the greeting is really
   *   under way.
   */
  async function sendMorning(target, date) {
    const conversationKey = sessionIdFor({ scene: target.scene, targetId: target.id });

    // A deferred greeting is retried on every tick, which at a 30s tick means
    // twenty identical lines over ten minutes. Say it once at info, then only
    // at debug: the retry is normal, the repetition is not worth logging.
    const noteSkip = (why) => {
      const key = `${date}|${target.key}|${why}`;
      const line = `早安问候跳过 ${target.key}：${why}`;
      if (morningSkipsLogged.has(key)) log.debug(line);
      else {
        morningSkipsLogged.add(key);
        log.info(`${line}（稍后自动重试）`);
      }
    };

    if (runner.isBusy(conversationKey)) {
      noteSkip('该会话正在进行');
      return;
    }

    // Greeting a group seconds after chatting in it would read as a glitch.
    if (target.scene === 'group') {
      const lastReplyAt = groupContext.stats(target.id).lastReplyAt;
      if (lastReplyAt !== null && Date.now() - lastReplyAt < MORNING_QUIET_AFTER_REPLY_MS) {
        noteSkip(`${Math.round((Date.now() - lastReplyAt) / 60_000)} 分钟前刚说过话`);
        return;
      }
    }

    // Recorded before sending, so a target that fails is attempted once a day
    // rather than on every tick across the whole grace window. Both gates above
    // sit *before* this line on purpose: "busy" and "just spoke" are reasons to
    // try again in a few minutes, not to write the day off. Marking the date
    // first is what used to let a warm-up erase a group's greeting entirely
    // (§6.2 #1).
    stateStore.setMorning(target.key, { date });

    await semaphore.acquire();
    try {
      const prompt = buildMorningPrompt({
        scene: target.scene,
        context: target.scene === 'group' ? groupContext.render(target.id) : '',
        silentToken: SILENT_TOKEN,
      });

      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(prompt, nextNudges()),
        config.policy.replyTimeoutMs,
      );

      if (target.scene === 'group') {
        groupContext.noteReply(target.id);
        groupContext.clear(target.id);
      }

      if (result.timedOut) {
        log.warn(`早安问候超时，跳过（${target.key}）`);
        return;
      }
      if (isSilentReply(result.text)) {
        log.info(`早安问候被模型跳过（${target.key}）`);
        return;
      }

      const body = composeReply(result);
      // No `messageId`: a greeting is proactive, so it is an active message.
      // 1.171.0 / D288:早安也是普通发言 —— 走同一份分条规划(没有情绪决策,给 null)。
      const replyLines = planSpokenLines(body, null, { label: '早安问候' });
      await sendSpokenLines(
        { scene: target.scene, targetId: target.id, messageId: undefined, content: '' },
        replyLines,
      );
      log.info(`早安问候 ${target.key} 长度=${body.length}（主动消息）`);
      // 早安是一次真实的互动(而且是她主动开口),算满额经验。
      recordTurn('self', { conversationKey, scene: target.scene, userText: '早安问候', replyText: body });
      // No warm-up clock to push here any more: `sendChunked` records the
      // utterance, and the warm-up gap gate reads that record. One mechanism
      // instead of a special case that only ever covered this one caller.
    } catch (err) {
      // A private greeting fails outright when the recipient has turned off
      // proactive messages; surface that rather than looking like a bug.
      log.error(`早安问候失败 ${target.key}`, err);
    } finally {
      semaphore.release();
    }
  }

  /**
   * Open a conversation in a quiet group.
   *
   * @returns {Promise<boolean>} whether a message was actually sent. The "nobody
   *   answered" decay must only count warm-ups the group could have answered.
   */
  async function warmUpGroup(groupId) {
    const conversationKey = sessionIdFor({ scene: 'group', targetId: groupId });

    if (runner.isBusy(conversationKey)) {
      log.debug(`群 ${groupId} 有会话在进行，跳过暖群`);
      return false;
    }

    const topic = pickWarmupTopic(recentWarmupTopics, {
      hour: new Date().getHours(),
      mealWindows: config.policy.warmup.mealWindows,
      // 钱影响话题(D42):穷时只聊"怎么赚钱/省着花",宽裕时才聊请客买东西。
      moneyMood: config.policy.economy?.enabled && config.policy.stats.enabled
        ? moneyMood({ money: currentStats().money, lastTaskAt: readEconomyClock('economy:last_task_at'), now: Date.now() })
        : 'comfortable',
    });
    recentWarmupTopics = rememberWarmupTopics(recentWarmupTopics, topic);

    await semaphore.acquire();
    try {
      const prompt = buildWarmupPrompt(topic, {
        context: groupContext.render(groupId),
        silentToken: SILENT_TOKEN,
      });

      const mood = moodFor(conversationKey);
      // 暖群也要掷:她"自己找话"时顺带提一句刚办的委托,是最像人的开场方式。
      // ⚠️ 这一类是**她自己主动开口**(`proactive: true`)—— 所以那条收支**该**进话里;
      //    而"被问到别的事"时不该塞(见 `rollEconomy` 的注释)。
      const ledger = rollEconomy({ scene: 'group', proactive: true });
      const result = await runner.runTurn(
        conversationKey,
        // 暖群没有"触发它的那句话",但**话题方向**就是这一轮的由头 ——
        // 把它当长期记忆的 query,否则主动开口永远看不到她答应过的事。
        withStyleNudge(prompt, await turnNotes(mood, null, ledger, { conversation: conversationKey, query: topic })),
        config.policy.replyTimeoutMs,
      );

      groupContext.noteReply(groupId);
      groupContext.clear(groupId);

      if (result.timedOut) {
        log.warn(`暖群超时，跳过（群 ${groupId}）`);
        return false;
      }
      if (isSilentReply(result.text)) {
        log.info(`群 ${groupId}：模型认为不适合开口，暖群跳过（话题：${topic}）`);
        return false;
      }

      // Nobody asked for this one, so the mood's length limit applies ——
      // ⚠️ 1.106.2(D174)起是"**按上限分条发**"而不是"砍到上限"(见 `planSpokenLines`)。
      const lines = planSpokenLines(composeReply(result), mood, { label: '暖群发言' });
      await sendSpokenLines({ scene: 'group', targetId: groupId, messageId: undefined, content: '' }, lines);
      log.info(
        `暖群发言 群=${groupId} ${lines.length} 条 / 共 ${lines.reduce((sum, one) => sum + one.length, 0)} 字` +
        `（话题：${topic}）（主动消息）`,
      );
      // 暖群是她自己找话,不是别人来找她 —— 经验折半(见 `growth.js` 的 XP_RULES)。
      recordTurn('warmup', { conversationKey, scene: 'group', userText: topic, replyText: lines.join('\n') });
      return true;
    } catch (err) {
      log.error(`暖群失败 群=${groupId}`, err);
      return false;
    } finally {
      semaphore.release();
    }
  }

  /**
   * **美图展览处的元数据库连接**(2026-10-23 / 展览处刀 2):进程内一份,服务层埋点
   * (`recordSent`)与面板的三条只读路由共用。null = 没开美图线 / `QQBOT_GALLERY=0` /
   * 库打不开 —— 三条路由 503,QQ 那条美图指令照旧能用(失败只 warn,不影响 QQ)。
   * ⚠️ 用 `let` 而不是 `const`:shutdown() 定义在前面,关闭路径要能安全读到它(TDZ 不是玩笑)。
   */
  let meituGallery = null;

  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('正在关闭 bridge…');
    for (const entry of groupTimers.values()) clearTimeout(entry.timer ?? entry);
    groupTimers.clear();
    // 攒着还没发出去的连发消息:不 flush(在关闭路径上再多做一次模型调用,
    // 只会把一次干净退出变成一个可能卡住的退出)。只如实报数,别让它静默消失。
    burstQueue.stop();
    if (warmupTimer) clearInterval(warmupTimer);
    // 只读面板(D106 第②步):**关端口**再退,别让下一次启动撞"地址已占用"。
    if (panelServer) { try { await panelServer.close(); } catch { /* 关闭路径上不抛 */ } }
    // 美图库:关连接(派生数据,不关也能下次重开;但关了不留 WAL 尾巴)。
    if (meituGallery) { try { meituGallery.close(); } catch { /* 关闭路径上不抛 */ } }
    gateway.stop();
    await runner.stop();
    process.exit(code);
  }

  /**
   * Names whose leading `【…】` speaker label must never reach QQ.
   *
   * ⚠️ 2026-10-01(D78)起也包含**群里认识的人**:提示词里现在写成 `饭否：正文`
   * (让她知道这句话是谁说的),万一她照着格式回一句 `饭否：…`,那行前缀要能剥掉。
   * 只剥**带冒号**的那种(`stripNameLabels` 的第三种写法),所以"饭否,你好"不受影响。
   */
  const outgoingNameLabels = () =>
    [gateway.botName, ...config.policy.style.nameLabels, ...knownPeopleNames()].filter(
      (name) => typeof name === 'string' && name !== '',
    );

  // ---------------------------------------------------------------------------
  // **P1 任务口径的状态**(2026-10-28):只记"这个会话上一轮是什么口径",给追问继承用。
  // 上限 200 个会话(超出丢最老的),避免长跑进程里这张表无限长。
  const lastTurnMode = new Map();
  const LAST_TURN_MODE_MAX = 200;
  function rememberTurnMode(conversationKey, mode) {
    const key = String(conversationKey ?? '');
    if (key === '') return;
    if (mode === 'chat' && !lastTurnMode.has(key)) return; // 闲聊不占位
    lastTurnMode.delete(key);
    lastTurnMode.set(key, mode);
    while (lastTurnMode.size > LAST_TURN_MODE_MAX) {
      const oldest = lastTurnMode.keys().next().value;
      lastTurnMode.delete(oldest);
    }
  }
  /**
   * 这一轮的口径(给**交付**用:要不要保真、要不要压口语清理)。
   * ⚠️ 与 `turnNotes` 里那次判定**共用同一份纯函数与同一份上一轮状态**(D159:判定只有一份)。
   */
  function turnModeFor(message) {
    const key = message ? conversationKeyFor(message) : '';
    return detectTurnMode(message?.content ?? '', { previous: lastTurnMode.get(key) ?? 'chat' }).mode;
  }

  /** Draw this turn's style instructions, and remember them to avoid repeats. */
  function nextNudges() {
    // **固定表达要求**(1.171.0 / D288):普通发言的底层口径(短句/不带标点/不总结)
    // 每轮都带,不进"别重复"的去重池(它本来就是每轮都在的)。
    // ⚠️ 严肃话题那一轮 `turnNotes` 会把**整组** nudge 压掉(`suppressNudges`),
    //    固定要求也跟着一起闭嘴 —— 不需要这里再写一份"严肃"判断(D159)。
    if (config.policy.style.nudgeCount === 0) return [...SPOKEN_STANDING_NOTES];
    // 用**这套主题**的提示词表:主实例那张里有「抱怨一下饿或者穷」「嫌弃队友」,
    // 发给副实例她就会开始喊饿(实测过)。
    const picked = pickNudges(config.policy.style.nudgeCount, recentNudges, moodTheme.styleNudges);
    recentNudges = rememberNudges(recentNudges, picked);
    return [...SPOKEN_STANDING_NOTES, ...picked];
  }

  /**
   * Roll (or continue) this conversation's mood, and return the note to inject
   * plus the length limit that goes with it.
   *
   * Per conversation, not global: a mood is part of the exchange with a
   * particular group, and one group having two chuunibyou turns in a row must
   * not push a different group into a low-energy mood.
   *
   * @param {string} conversationKey
   * @param {string} [text] the triggering message; empty for self-initiated ones.
   * @returns {object|null} the decision, or null when the feature is off.
   */
  function moodFor(conversationKey, text = '') {
    if (!config.policy.mood.enabled) return null;
    const stats = config.policy.stats.enabled ? currentStats() : null;
    const decision = decideMood(moodState.get(conversationKey) ?? null, {
      now: Date.now(),
      text,
      ttlMs: config.policy.mood.ttlMs,
      kaomojiChance: config.policy.mood.kaomojiChance,
      stats,
      theme: moodTheme,
    });
    moodState.set(conversationKey, decision.state);
    if (decision.changed) {
      log.info(
        `情绪：${conversationKey} → ${decision.label ?? decision.mood}` +
        `（${decision.reason}${decision.penalised ? '，强制低能量' : ''}，上限 ${decision.maxChars} 字）`,
      );
    }
    // 被夸会真的让她高兴 —— 复用已有的话题分类,不额外加判断(带冷却,刷不动)。
    if (config.policy.stats.enabled && decision.state.topicId === 'praise') {
      try {
        const { stats: next, event } = stateStore.applyInteraction('praise', Date.now(), {
          sleep: config.policy.warmup.sleep,
        });
        recordStatDeltas(event);
        if (event) log.info(`心情：被夸 +${event.moodDelta} → ${Math.round(next.mood)}`);
      } catch (err) {
        log.warn(`心情结算失败: ${describeError(err)}`);
      }
    }
    return decision;
  }

  /** The per-turn note: mood first, then the surface-form nudges. */
  function moodNotes(decision) {
    return decision ? [buildMoodNote(decision)] : [];
  }

  /**
   * 取当前身体状态(按经过时间结算)。
   *
   * **绝不允许抛**:数值只是角色玩法,不该因为状态库出问题就让整轮对话失败。
   * 出错时退回默认值并记一次警告。
   */
  function currentStats(now = Date.now()) {
    try {
      return stateStore.getStats(now, { sleep: config.policy.warmup.sleep });
    } catch (err) {
      log.warn(`读取身体状态失败，本轮按默认值处理: ${describeError(err)}`);
      return createStats(now);
    }
  }

  /**
   * **每轮互动对体力/魔力的影响**(2026-10-01,D83)。用户原话:
   * 「体力和魔力的数值也要加上(这两个数值也要能被互动和亲密互动影响)」。
   *
   * · `chat`(每轮被搭话,60 秒冷却):魔力 +2、体力 −1 —— 聊天让她回魔,但也会累;
   * · `intimate`(亲密的那些话,5 分钟冷却):**体力 +10、魔力 +12、心情 +8**。
   *   ⚠️ **数值改过一版**(1.36.0,D82 五):D83 当时是 体力 −6/魔力 +5,后来按用户口径
   *   ("亲密互动可以补充体力和魔力 —— **汲取人类精血**")翻成了正的,于是它成了放完咏唱技能
   *   之后的主要回魔途径。**改数值改的是 `src\stats.js` 的 `INTERACTIONS`,别信注释里的旧数。**
   *
   * ⚠️ 冷却**就在这里**(由 `INTERACTIONS` 的 `cooldownMs` 决定),所以刷一句话刷不出数值。
   */
  function settleInteraction(message) {
    if (!config.policy.stats.enabled || !message) return;
    try {
      const kinds = isIntimate(message.content) ? ['chat', 'intimate'] : ['chat'];
      for (const kind of kinds) {
        const { stats: next, event } = stateStore.applyInteraction(kind, Date.now(), {
          sleep: config.policy.warmup.sleep,
        });
        if (event) {
          log.info(
            `数值：${event.detail?.label ?? kind} ` +
            `体力${event.staminaDelta >= 0 ? '+' : ''}${event.staminaDelta} → ${Math.round(next.stamina)}、` +
            `魔力${event.manaDelta >= 0 ? '+' : ''}${event.manaDelta} → ${Math.round(next.mana)}` +
            (event.moodDelta ? `、心情${event.moodDelta >= 0 ? '+' : ''}${event.moodDelta}` : ''),
          );
        }
      }
    } catch (err) {
      log.warn(`互动数值结算失败（不影响对话）: ${describeError(err)}`);
    }
  }

  /**
   * 这一轮状态变了多少 —— 收在 `turnStatDeltas` 里,回复末尾拼成 `[魔力+45 体力+5]`(D87)。
   *
   * ⚠️ **只在有变化时打**,而且**由代码拼**:数值不许交给模型自己编
   *    (`describeForPrompt` 注入的数字仍然写着"不要念出来")。
   * ⚠️ 每轮开头清空、回复时消费掉,免得串到下一轮去。
   */
  let turnStatDeltas = [];
  function recordStatDeltas(event) {
    if (event) turnStatDeltas.push(event);
  }
  /** 这一轮的状态增量那一行(没有变化就是空串)。 */
  function statDeltaLine() {
    if (!config.policy.stats.enabled || config.policy.stats.deltaLine === false) return '';
    // ⚠️ P4(2026-10-28):必须传**本实例的身体主题** —— 不传就用 megumin 默认,
    //    副实例的涨跌行会显示"魔力/体力"(判据钉着)。
    return renderStatDeltas(turnStatDeltas, { theme: getBodyTheme(config.policy.stats.theme) });
  }

  /**
   * **喝药剂**(2026-10-01 用户要的:「喝魔力药剂这种也能补体力/补魔」)。
   *
   * 认出「魔力药剂 / 蓝药 / 能量饮料」这类话就按 `POTIONS` 里的固定数值结算。
   * ⚠️ 与吃饭同一套规矩:**效果与价格在代码里**,模型说了不算。
   */
  function settlePotion(message) {
    if (!config.policy.stats.enabled || !message) return;
    const kind = detectPotion(message.content);
    if (!kind) return;
    try {
      const { stats, event } = stateStore.applyPotion(kind, Date.now(), {
        sleep: config.policy.warmup.sleep,
      });
      recordStatDeltas(event);
      if (event) {
        log.info(
          `药剂：${event.detail.label}（${event.detail.cost} ${CURRENCY.name}）→ ` +
          `体力${event.staminaDelta >= 0 ? '+' : ''}${event.staminaDelta} → ${Math.round(stats.stamina)}、` +
          `魔力${event.manaDelta >= 0 ? '+' : ''}${event.manaDelta} → ${Math.round(stats.mana)}`,
        );
      }
    } catch (err) {
      log.warn(`药剂结算失败（不影响对话）: ${describeError(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 养成(经验 / 等级 / 概念 / 人)。规则在 `src/growth.js`,这里只负责装配。
  //
  // 三条设计约束(和 `held` 那类"手感"状态刻意相反):
  //   · **失败绝不影响对话** —— 整段包在 try/catch 里,出错只记一条警告;
  //   · **幂等靠调用点** —— `recordTurn` 每个回合只调一次,不靠猜;
  //   · **等级不存库** —— 它是经验值的派生值,存两份就会不一致。
  // ---------------------------------------------------------------------------

  /** 当前养成状态(读不出来就当 Lv.1 / 0 经验,绝不让它拖垮这一轮)。 */
  function currentGrowth(now = Date.now()) {
    try {
      return stateStore.getGrowth(now);
    } catch (err) {
      log.warn(`读取养成状态失败，本轮按 Lv.1 处理: ${describeError(err)}`);
      return { xp: 0, level: 1, milestones: 0, updatedAt: now };
    }
  }

  /**
   * 这一轮的成长结算。**五个调用点**(被叫到 / 自己接话 / 暖群 / 早安 / 播报)汇流到这里。
   *
   * 概念是从**用户正文 + 她的回复**两边一起扫的:两边都可能出现新词,
   * 而"她学会了一个词"这件事关心的是"这个词在这一轮出现过"。
   * 已经在库里的不算新的(`concept` 表的主键也会再挡一次)。
   *
   * @param {string} kind `XP_RULES` 的键
   * @param {{conversationKey?: string, scene?: string, userText?: string,
   *          replyText?: string, inTokens?: number, outTokens?: number}} turn
   * @returns {object|null} 结算结果(给日志与里程碑用),关闭或失败时返回 null
   */
  function recordTurn(kind, turn = {}) {
    if (!config.policy.growth.enabled) return null;
    // 表里没有的种类 = 我们还没决定它值多少经验 —— 记一条,别当成 0 混过去。
    if (!(kind in XP_RULES)) log.warn(`养成：未知的回合种类 ${JSON.stringify(kind)}，按 0 经验处理`);
    try {
      const known = config.policy.growth.concepts ? stateStore.knownConceptIds() : new Set();
      const newConcepts = config.policy.growth.concepts
        ? matchConcepts(`${turn.userText ?? ''}\n${turn.replyText ?? ''}`)
          .filter((id) => !known.has(id))
          .map((id) => ({ id, label: conceptLabel(id) }))
        : [];

      const xp = xpForTurn(kind, { concepts: newConcepts.length });
      const result = stateStore.applyGrowth({
        kind,
        xp,
        conversationKey: turn.conversationKey ?? null,
        scene: turn.scene ?? null,
        newConcepts,
      }, Date.now());

      const progress = result.growth;
      const parts = [
        `经验 +${xp}（${describeTurnKind(kind)}）`,
        `Lv.${progress.level}（${Math.floor(progress.xp)} 点）`,
      ];
      if (newConcepts.length > 0) parts.push(`学会 ${newConcepts.map((c) => c.label).join('/')}`);
      if (result.levelledUp) parts.push('**升级**');
      if (result.milestone !== null) parts.push(`里程碑 Lv.${result.milestone}`);
      log.info(`养成：${parts.join('，')}`);

      // 里程碑播报是**独立的一轮主动发言**,不能等在这个回合里(这一轮已经发出去了)。
      // 两条通道(见 D40):里程碑 → 群里的那句(她自己的说法);
      // 普通升级 → 私聊账单(群里不刷屏,但运维者看得见)。
      if (result.milestone !== null) {
        void announceGrowth('milestone', {
          level: result.milestone,
          groupConversationKey: turn.scene === 'group' ? turn.conversationKey : null,
        }).catch((err) => log.warn(`里程碑播报失败: ${describeError(err)}`));
      } else if (result.levelledUp) {
        void announceGrowth('levelup', { level: progress.level })
          .catch((err) => log.warn(`升级账单失败: ${describeError(err)}`));
      }
      return result;
    } catch (err) {
      log.warn(`养成结算失败（不影响这轮对话）: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * 升级的两条通道(D40)。
   *
   * - `'milestone'`:**群里那句** —— 只在她刚跨过里程碑时发,用她自己的说法;
   *   同时给操作者一条账单。
   * - `'levelup'`:**只给操作者**的账单 —— 群里一句话都不发。一只每小时都在群里
   *   冒泡的机器人,每升一级都开口就是刷屏;但进度是运维者关心的事。
   *
   * ⚠️ 这一轮自己**不再计入养成**(`recordTurn` 只由五个真实回合路径调用),
   * 否则升级播报会触发新的升级。
   *
   * @param {'milestone'|'levelup'} channel
   * @param {{level: number, groupConversationKey?: string|null}} options
   */
  async function announceGrowth(channel, { level, groupConversationKey = null } = {}) {
    const cfg = config.policy.growth;
    if (!cfg.enabled || cfg.announce === 'off') return;
    const progress = currentGrowth();

    // 私聊账单:里程碑和普通升级都发(除非配成 group)。
    if (cfg.announce !== 'group') {
      const operator = cfg.announceC2c || config.policy.announce.c2cTarget || config.policy.morning.c2cTarget;
      if (operator) {
        const text = channel === 'milestone'
          ? `【养成】里程碑 Lv.${level}：${describeGrowthForUser(progress)}`
          : levelUpReport(level, progress, nextMilestoneAfter(level));
        try {
          // 用 `sendDirect`(不是 `sendChunked`)——同 `reportToOperator` 的写法:
          // 这是给运维者看的账单,不需要出站清洗那一套。
          await api.sendDirect(operator, { content: text });
          log.info(`养成：${channel === 'milestone' ? '里程碑' : '升级'}账单已私聊操作者（Lv.${level}）`);
        } catch (err) {
          log.warn(`养成账单私聊失败（不影响升级本身）: ${describeError(err)}`);
        }
      }
    }

    // 群里那句:只有里程碑才有。
    if (channel !== 'milestone' || cfg.announce === 'c2c') return;
    if (!groupConversationKey) {
      log.info(`养成：里程碑 Lv.${level} 是在私聊里达成的，群里不打扰`);
      return;
    }
    const groupId = groupConversationKey.replace(/^qqbot-group-/, '');
    if (!groupId || groupId === groupConversationKey) return;

    const note = milestoneNote(level);
    const prompt = [
      '【系统】你的养成进度到了一个里程碑,需要在群里说一句。',
      '要求：',
      '1. 用你自己的说法说一句你变强了/机能提升了，两三句以内；',
      '2. **不要报数字、不要提"经验值""等级""Lv"这类词**，也不要解释这是什么系统消息；',
      '3. 不要提问、不要@任何人。',
    ].join('\n');
    try {
      const turn = await runner.runTurn(groupConversationKey, `${prompt}\n\n${note}`, config.policy.replyTimeoutMs);
      if (turn.timedOut || isSilentReply(turn.text)) {
        log.warn(`养成：里程碑 Lv.${level} 的群播报没有产出内容，跳过`);
        return;
      }
      await sendChunked({ scene: 'group', targetId: groupId, messageId: undefined, content: '' }, composeReply(turn));
      log.info(`养成：里程碑 Lv.${level} 已在群 ${groupId.slice(0, 8)}… 播报（主动消息）`);
    } catch (err) {
      log.warn(`养成：里程碑群播报失败（不影响升级本身）: ${describeError(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 经济(D42)。规则在 `src/economy.js`,这里只负责"什么时候掷骰"和落账。
  //
  // 用户的要求是「参考上次解决一直说饿的做法」—— 那条路的要点是**真数值 + 有后果**,
  // 所以这里的关键不是"少提穷",而是:**钱真的会少,也真的能赚回来**。
  // ---------------------------------------------------------------------------

  /**
   * 掷"接到委托 / 随机小事件"的那**两个冷却时刻**。
   *
   * ⚠️ **必须落盘**(2026-10-02 用户报的那次):
   * 它们原本只是内存里的两个变量(`let lastTaskAt = 0`),而**每次重启都会归零** ——
   * 于是"重启后的第一轮"必定掷中一次委托,钱就凭空多出来。用户那次问「认不认识我」,
   * 正好撞在重启后的第一轮上,账本里就多了一条 `kind=task +5178 货币单位`(现场条 330)。
   * 现在存进 `meta`,重启不丢。
   */
  function readEconomyClock(key, fallback = 0) {
    try {
      const raw = stateStore.getMeta(key);
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch { return fallback; }
  }

  function writeEconomyClock(key, value) {
    try {
      stateStore.setMeta(key, String(value));
    } catch (err) {
      log.warn(`写经济冷却失败（重启后可能多掷一次）: ${describeError(err)}`);
    }
  }

  /**
   * 这一轮的收支:掷"接到委托"与"随机小事件",把结果落账并返回能进提示词的一段。
   *
   * 掷骰放在**这一轮开始之前**(而不是之后),是为了让结果能进**这一轮**的提示词 ——
   * 她能当场把"刚接了个委托"讲出来,而不是事后再补一句(那会很假)。
   *
   * ⚠️ 落账与"她这一轮说了什么"无关:钱的变化是**事实**,不是她的台词。
   * 讲不讲由提示词引导,讲错了也不影响账目。
   *
   * ⚠️ **但"讲不讲"要看场合**(2026-10-02 用户:"我问主实例认不认识我,主实例为什么加钱了,
   *   是把随机事件加钱的表达顺便带在会话里了还是 bug")—— 委托与随机事件是**背景生活**,
   *   在问"你认不认识我"的时候把它**塞进这一轮的话题**就是答非所问。
   *   所以只有**这一轮真的在聊钱/工作**,或者**她自己主动开口**时,那条才进提示词;
   *   其余情况照样落账(账目不能省),但**不进**这一轮的话。
   *
   * @param {{scene?: string, text?: string, proactive?: boolean}} [turn]
   * @returns {Array<{line: string, delta: number, kind: string}>}
   */
  function rollEconomy(turn = {}) {
    const cfg = config.policy.economy ?? { enabled: true, tasks: true, events: true };
    if (!cfg.enabled || !config.policy.stats.enabled) return [];
    const entries = [];
    try {
      const now = Date.now();
      const stats = currentStats(now);
      // ⚠️ 冷却从**库里**读(重启不丢)。**没有键就先补种成"现在"** ——
      //    不然"键不存在 = 0 = 早就过了冷却"会让**重启后的第一轮**又白掷一次
      //    (用户报的那次就是这么来的:一重启就多一笔 +5178)。补种之后,
      //    第一次掷骰要等满一个冷却周期。
      for (const key of ['economy:last_task_at', 'economy:last_event_at']) {
        if (!(Number(stateStore.getMeta(key)) > 0)) writeEconomyClock(key, now);
      }
      let lastTaskAt = readEconomyClock('economy:last_task_at');
      let lastEventAt = readEconomyClock('economy:last_event_at');
      // "这一轮要不要把它讲出来":只有**在聊钱/工作**或**她自己主动开口**时才讲。
      const text = String(turn.text ?? '');
      const relevant = turn.proactive === true
        || new RegExp(`(钱|${RegExp.escape(CURRENCY.name)}|委托|任务|接活|赚|攒|穷|借钱|还钱|工资|报酬)`).test(text);
      /** 落账后要不要进这一轮的话。 */
      const narrate = (entry) => {
        if (relevant) entries.push(entry);
        else {
          log.info(
            `经济：${entry.kind} ${entry.delta >= 0 ? '+' : ''}${entry.delta} ${CURRENCY.name}` +
            `（这一轮在聊别的,只落账不塞进话里）`,
          );
        }
      };

      if (cfg.tasks) {
      const task = rollTask({ now, money: stats.money, lastTaskAt });
        if (task) {
          lastTaskAt = now;
          writeEconomyClock('economy:last_task_at', now);
          const { stats: after, event } = stateStore.applyMoneyDelta(task.delta, now, {
            kind: 'task',
            label: task.tier,
            food: null,
          }, { sleep: config.policy.warmup.sleep });
          recordStatDeltas(event);
          if (event) {
            narrate({ line: task.line, delta: event.moneyDelta, kind: 'task' });
            log.info(`经济：接委托（${task.tier}）${event.moneyDelta >= 0 ? '+' : ''}${event.moneyDelta} ${CURRENCY.name} → ${Math.round(after.money)} ${CURRENCY.name}`);
          }
        }
      }

      if (cfg.events) {
        const rolled = rollEvent({ now, lastEventAt });
        if (rolled) {
          lastEventAt = now;
          writeEconomyClock('economy:last_event_at', now);
          const { stats: after, event } = stateStore.applyMoneyDelta(rolled.delta, now, {
            kind: 'event',
            label: rolled.id,
          }, { sleep: config.policy.warmup.sleep });
          recordStatDeltas(event);
          if (event) {
            narrate({ line: rolled.line, delta: event.moneyDelta, kind: 'event' });
            log.info(`经济：小事件（${rolled.id}）${event.moneyDelta >= 0 ? '+' : ''}${event.moneyDelta} ${CURRENCY.name} → ${Math.round(after.money)} ${CURRENCY.name}`);
          }
        }
      }
    } catch (err) {
      // 经济只是玩法,绝不该让这一轮对话失败。
      log.warn(`经济结算失败（不影响这轮对话）: ${describeError(err)}`);
      return [];
    }
    return entries;
  }

  /** 记下"这一轮是谁在说话" —— 身份是 openid,显示名只是备注(见 store 里那段注释)。 */
  function touchSender(message) {
    if (!config.policy.growth.enabled) return;
    try {
      const scene = message.scene === 'c2c' ? 'c2c' : 'group';
      const scope = scene === 'group' ? `group:${message.targetId}` : `c2c:${config.qq.appId}`;
      const known = stateStore.touchPerson({
        scope,
        openid: message.senderId,
        display: message.senderName ?? null,
        scene,
        turns: 1,
      });
      if (known?.isNew) {
        log.info(`养成：认识了一个新的人（${scene}，显示名「${message.senderName ?? '未知'}」）`);
      }    } catch (err) {
      log.warn(`记录发言人失败（不影响这轮对话）: ${describeError(err)}`);
    }
  }

  /**
   * 更新播报 —— **这是"日志机器人"(副实例)的职责**,主实例那边关着。
   *
   * 数据来源就是仓库里的 `CHANGELOG.md`:读最新一条的「播报」小节,发出去,
   * 并把版本号写进状态库(`meta.announced_version`),所以重启不会重发。
   *
   * @param {object} [options]
   * @param {boolean} [options.manual] **手动触发**(操作者打 `/更新`)。
   *   手动 = 明确要求"现在就发",所以:
   *     · **跳过睡眠闸门** —— 凌晨让你手动发一次,却因为"现在是睡眠时段"什么都不做,
   *       那是最气人的一种"成功";
   *     · **跳过"已播报过"的去重**;
   *     · 把每个目标的结果**回报给操作者**(日志之外,他得知道自己那一下有没有生效)。
   * @param {'configured'|'all'|'c2c'|'group'} [options.scope]
   *   `configured` = 按 `.env` 的 targets(自动播报用);`all` = 私聊 + 所有已知群。
   * @param {string|null} [options.groupId] `scope: 'group'` 时发给哪一个。
   * @param {string|null} [options.sinceVersion] **只为这一次**假设的"上次播报到哪一版"
   *   (`/更新 预览 1.22.0`)。不写库、不影响任何基线 —— 基线等于最新版时的出路(D58)。
   * @returns {Promise<{version: string|null, sent: number, failed: number, notes: string[]}>}
   */
  async function announceOnce({
    manual = false,
    scope = 'configured',
    groupId = null,
    passiveMessageId = null,
    preview = false,
    sinceVersion = null,
  } = {}) {
    const cfg = config.policy.announce;
    const result = { version: null, sent: 0, failed: 0, notes: [] };
    if (!cfg.enabled) {
      result.notes.push('这台不是日志机器人（QQBOT_ANNOUNCE=false）');
      return result;
    }

    // 正文 = **自上次播报以来**的全部改动(补课梗概 + 大更新 + 小更新一行),见 D49。
    //
    // ⚠️ 基线是**按目标**取的(D50):私聊用全局,群用 `announced_group:<id>`。
    //    原来只用全局那一个 —— 私聊发成功之后基线就变成最新版,于是群播报算出
    //    "没有新内容",正文只剩标题,发出去是一条空消息(2026-09-27 现场)。
    const baselineKey = announceBaselineKey({ scope, groupId });
    const announcedVersion = stateStore.getMeta(baselineKey);
    // 口径**只有一个来源**(`announceDigestOptions`):手动那条路不卡"极简",自动那条路卡。
    // ⚠️ 2026-10-11 现场:最新一版(`x.y.0` 但只有「变更/修复」、没有「新增」)不算大更新,
    //    于是这条闸门把手动 `/更新` 也一起挡死,还报成"读不到 CHANGELOG.md"。
    const digestOptions = announceDigestOptions({ manual });
    // `sinceVersion` = 这一次预演用的假起点(只在 `预览 <版本>` 那条路上传进来)。
    const digest = readAnnounceDigest(sinceVersion ?? announcedVersion, digestOptions);
    if (!digest) {
      // ⚠️ 两种原因**分开说**:真读不到文件,和"按口径跳过"根本不是一回事。
      const latestVersion = readLatestRelease()?.version ?? null;
      result.notes.push(describeDigestMiss({ latestVersion, majorOnly: digestOptions.majorOnly }));
      // 自动那条路每拍都会走到这里,记日志就是刷屏;手动那一下是人问的,留一条痕。
      if (manual) {
        log.warn(
          `更新播报：手动这一下没有可播的正文（最新 ${latestVersion ?? '读不到'}，` +
          `majorOnly=${digestOptions.majorOnly}）`,
        );
      }
      return result;
    }
    const version = digest.version;
    result.version = version;

    if (!manual && announcedVersion === version) return result;

    // 群里的那条路是幂等的:同一个群、同一个版本只发一次。
    // 这是"群成员也能 @ 她触发"这件事的**安全阀** —— 它让这条路不可能被拿来刷屏,
    // 所以不需要先做 id 校验也能放开(见 D33)。
    if (groupId && (scope === 'thisGroup' || scope === 'group')) {
      if (stateStore.getMeta(`announced_group:${groupId}`) === version) {
        result.notes.push(`这个群已经播报过 ${version} 了`);
        log.info(`更新播报：群 ${groupId} 已经发过 ${version}，跳过（幂等）`);
        return result;
      }
    }

    const body = digest.text.trim();
    if (body === '') {
      result.notes.push(`CHANGELOG 里 ${version} 没有「播报」正文，跳过（补上小节后重启即可）`);
      log.warn(`更新播报：CHANGELOG 里 ${version} 没有「播报」正文，跳过`);
      return result;
    }

    // ⚠️ **没有新内容就不要发**(D50)。
    // 这里以前会照发:正文只剩「主实例 x.y.z / 本次更新内容:」两行,模型无从下笔,
    // 群里收到的是一条**空消息** —— 用户看到的就是"`/更新` 输出是空白"。
    // 空壳比不发更糟:它花了模型调用、占了主动消息配额,还什么都没说。
    if (!hasAnnounceContent(digest)) {
      const detail = sinceVersion
        ? `（假设的上次播报版本 ${sinceVersion} 之后没有内容）`
        : `（基线 ${baselineKey}=${announcedVersion ?? '无'}，已经是最新 ${version}）`;
      result.notes.push(`没有新内容可播报 ${detail}；想重看文案就 \`/更新 预览 <更早的版本>\``);
      log.info(
        `更新播报：跳过 —— 没有新内容（基线 ${baselineKey}=${announcedVersion ?? '无'}，最新 ${version}；` +
        `重发要先清基线，或 /更新 预览 <版本> 只为看文案）`,
      );
      return result;
    }
    log.info(
      `更新播报：正文覆盖 ${digest.versions.length} 个版本（${digest.mode === 'first' ? '首次播报,含补课梗概' : `自 ${announcedVersion}`}），` +
      `${digest.lines.length} 条大纲`,
    );

    if (!manual) {
      const hour = new Date().getHours();
      if (isWithinSleepWindow(hour, config.policy.warmup.sleep)) {
        result.notes.push(`现在是睡眠时段（${hour} 点），推迟`);
        log.info(`更新播报：${version} 待发，但现在是睡眠时段（${hour} 点），推迟`);
        return result;
      }
    }

    const targets = announceTargets(scope, groupId, passiveMessageId);
    if (targets.length === 0) {
      result.notes.push(describeNoTargets(scope));
      log.warn(`更新播报：没有任何可用目标（scope=${scope}）`);
      return result;
    }

    for (const target of targets) {
      try {
        const to = { scene: target.scene, targetId: target.id, messageId: target.messageId, content: '' };
        if (cfg.mode === 'verbatim') {
          // 正文第一行已经是「主实例 x.y.z」,所以这里不再重复版本号 ——
          // 只加一个「这是播报,不是她随口说的话」的标记。
          await sendChunked(to, `【更新播报】\n${body}`);
        } else {
          // 用她自己的语气说 —— 但事实（版本号与条目）必须原样保留。
          //
          // 格式要求照**应用商店的「本次更新」**:版本号 + 更新内容大纲,逐条列。
          // 这里**不能**限制成"三句以内":大纲是要一条条报出来的,
          // 压成三句就等于把更新内容吃掉(用户明确要求过这一点)。
          //
          // ⚠️ 第 2/3 条从"`·` 开头的行"改成了"**正文里每一行**"(D57):小改动那一节
          //    现在是一条一行、带 `1. 2. 3.` 编号,只盯 `·` 的话模型有理由把它压回一行。
          const conversationKey = sessionIdFor({ scene: target.scene, targetId: target.id });
          const prompt = [
            '【系统】请把下面这条更新播报**用你的语气**说出去。格式像应用商店的「本次更新」。',
            '要求：',
            infraText(INFRA_CONTENT.announceTitleInstruction),
            '2. **正文里的每一行都要逐条保留** —— 不要合并、不要省略、不要改写行首的符号或编号、不要自己加没看到的内容；',
            '3. 行首的「·」与「1. 2. 3.」照原样用，一条一行；可以用你自己的系统播报句（如「已确认到版本更新情报」）开场或收尾；',
            '4. 不要写成一大段，不要提问、不要加题外话。',
            '',
            `版本：${version}`,
            body,
          ].join('\n');
          const turn = await runner.runTurn(conversationKey, prompt, config.policy.replyTimeoutMs);
          if (turn.timedOut || isSilentReply(turn.text)) {
            result.failed += 1;
            result.notes.push(`${target.key}：模型没有产出可用内容`);
            log.warn(`更新播报：模型没有产出可用内容（${target.key}），跳过`);
            continue;
          }
          await sendChunked(to, composeReply(turn));
          // 播报**不是对话**(D39 已经把它排除在记忆交接之外),所以它给 0 经验;
          // 记这一笔是为了让流水的种类分布诚实 —— "她这周的发言里有多少是播报"能查。
          recordTurn('announce', {
            conversationKey,
            scene: target.scene,
            userText: `更新播报 ${version}`,
            replyText: turn.text ?? '',
          });
        }
        result.sent += 1;
        log.info(
          `更新播报：已发送 ${version} → ${target.key}（模式 ${cfg.mode}` +
          `${target.messageId ? '，被动回复' : '，主动消息'}）`,
        );
      } catch (err) {
        result.failed += 1;
        result.notes.push(`${target.key}：${describeAnnounceError(err)}`);
        log.error(`更新播报失败（${target.key}）`, err);
        // 自动播报失败就不记版本号,下个 tick 会重试;手动那次由操作者决定要不要再来。
        if (!manual) return result;
      }
    }
    // 手动播报也记版本号 —— 它是"已经发布过什么"的记录,不是"还能不能发"的锁。
    // ⚠️ 但**预览不算发布**(D55):`/更新 预览` 只发私聊看一眼,不该推进基线 ——
    //    不然紧接着的 `/更新` 会报"没有新内容"(用户实测踩到过)。
    if (shouldRecordAnnounce({ sent: result.sent, preview })) {
      // 账本是"现值 + 历史"两条记录,一次事务写(D58)。历史是 `/更新 回退` 的依据。
      writeBaseline(baselineKey, version);
      // 群里的那次路径是幂等的,所以要**逐群**记一笔(scope='group' 也算,见 D50)。
      if (groupId && (scope === 'thisGroup' || scope === 'group') && baselineKey !== `announced_group:${groupId}`) {
        writeBaseline(`announced_group:${groupId}`, version);
      }
    } else if (preview && result.sent > 0) {
      log.info('更新播报：预览模式 —— 不改基线（正式发的时候还会再念一遍）');
    }
    return result;
  }

  /**
   * 写一个播报基线键,**顺手把它写进了历史**(D58)。
   *
   * 为什么要历史:2026-09-28 用户问「为什么基线又变了,要不加一个基线回退功能」——
   * 而账本原来只有**现值**,没有"上一版",于是"发错了一版"这件事无法撤销。
   * 现在每次改动留一条 `{key, value, at}`,回退 = 逐键回到上一条**不同的**值。
   *
   * 两条记录**一个事务**(`setMetaMany`):基线写了、历史没写的话,回退就没了依据。
   */
  function writeBaseline(key, value) {
    const history = appendBaselineHistory(
      stateStore.getMeta(BASELINE_HISTORY_KEY),
      { key, value, at: Date.now() },
    );
    stateStore.setMetaMany({ [key]: value, [BASELINE_HISTORY_KEY]: history });
  }

  /** 现在所有播报基线键(私聊 + 逐群),给账本/回退用。 */
  function baselineRows() {
    return stateStore
      .listMetaKeys('announced_')
      .filter((row) => row.key === 'announced_version' || row.key.startsWith('announced_group:'));
  }

  /** 自动路径:受睡眠与去重闸门约束,不回报。 */
  async function announceTick() {
    // `confirm` 模式**不问就不发**(D50):自动那一拍只负责"问一句"。
    if (config.policy.announce.trigger === 'confirm') {
      await offerAnnounce();
      return;
    }
    await announceOnce({ manual: false, scope: 'configured' });
  }

  // ---------------------------------------------------------------------------
  // 「问你一声再发」(D50)
  // ---------------------------------------------------------------------------

  /**
   * 现在有没有**待确认**的播报。
   *
   * 两边都要看:私聊有全局基线,群是逐群基线 —— 私聊早就播报过、而某个群从没播报过
   * 是完全正常的(就是此刻的状态)。
   */
  function pendingAnnounce() {
    const cfg = config.policy.announce;
    if (!cfg.enabled) return null;
    const groups = knownGroupIds();
    const globalVersion = stateStore.getMeta('announced_version');
    const own = readAnnounceDigest(globalVersion);
    if (!own) return null;
    const version = own.version;
    const freshGroups = groups.filter((id) => stateStore.getMeta(`announced_group:${id}`) !== version);
    const ownFresh = hasAnnounceContent(own);
    const forGroups = freshGroups.length > 0 ? readAnnounceDigest(null) : null;
    const digest = ownFresh ? own : forGroups;
    if (!digest) return null;
    return { version, digest, groups, freshGroups, ownFresh };
  }

  /** 播报账本相关的临时状态(睡眠时段"只说一次"的那句话用)。 */
  const deferredAnnounceWarned = new Set();

  /** 问一次:私聊告诉操作者"写好了、要发吗、发哪里"。同一版本只问一次。 */
  async function offerAnnounce() {
    const cfg = config.policy.announce;
    if (cfg.trigger !== 'confirm') return;
    const pending = pendingAnnounce();
    if (!pending) return;
    // 问过就不再问 —— 否则每个 tick 都来一条,那是骚扰。
    if (stateStore.getMeta(announceOfferKey(pending.version))) return;
    // 睡眠时段那"等醒来再问"的一句话**一个版本只说一次**(见下面的用法)。
    // 它是个闭包内的 Set,重启清空 —— 那正好,重启后可以说一次"还是待确认"。

    const hour = new Date().getHours();
    if (isWithinSleepWindow(hour, config.policy.warmup.sleep)) {
      // ⚠️ 一个版本只说**一次**:这句话原来每个 tick 都打(30 秒一行,一晚约 2880 行 ——
      //    实测把日志刷了几百行),而它想说的其实只有一句"等醒来再问"。
      if (!deferredAnnounceWarned.has(pending.version)) {
        deferredAnnounceWarned.add(pending.version);
        log.info(`更新播报：${pending.version} 待确认，但现在是睡眠时段（${hour} 点），醒来再问（这条只说一次）`);
      }
      return;
    }
    const to = cfg.c2cTarget || config.policy.morning.c2cTarget;
    if (!to) {
      log.warn('更新播报：没有私聊目标，问不出去（配 QQBOT_ANNOUNCE_C2C）');
      return;
    }
    const question = buildAnnounceQuestion({
      digest: pending.digest,
      groups: pending.groups.map((id) => ({ id })),
      freshGroups: pending.freshGroups,
    });
    try {
      await sendChunked({ scene: 'c2c', targetId: to, messageId: undefined, content: '' }, question);
    } catch (err) {
      log.warn(`更新播报：问一句失败，下个 tick 再试: ${describeError(err)}`);
      return;
    }
    stateStore.setMeta(announceOfferKey(pending.version), String(Date.now()));
    log.info(
      `更新播报：已问操作者 —— ${pending.version} 要发吗` +
      `（私聊${pending.ownFresh ? '有新内容' : '没有新内容'}，${pending.freshGroups.length} 个群从没播报过）`,
    );
  }

  /** 现在的播报状态,一句话 —— 没有待确认的东西时告诉他为什么。 */
  function describeAnnounceState() {
    const cfg = config.policy.announce;
    if (!cfg.enabled) return '这台不是日志机器人（QQBOT_ANNOUNCE=false）';
    const version = readLatestRelease()?.version?.replace(/^v/, '') ?? '?';
    const globalVersion = stateStore.getMeta('announced_version') ?? '无';
    const fresh = knownGroupIds().filter((id) => stateStore.getMeta(`announced_group:${id}`) !== version);
    return `最新 ${version}，私聊已播报 ${globalVersion}，${fresh.length} 个群还没播报过`;
  }

  // ---------------------------------------------------------------------------
  // 账本:看它、回退它、把它拨到某一版(D58)
  // ---------------------------------------------------------------------------

  /** `/更新 账本` —— 私聊与每个群现在记到哪一版、上一条是什么。 */
  function ledgerText() {
    const latest = readLatestRelease()?.version?.replace(/^v/, '') ?? null;
    return describeBaselineLedger({
      latest,
      baselines: baselineRows(),
      groups: knownGroupIds(),
      entries: parseBaselineHistory(stateStore.getMeta(BASELINE_HISTORY_KEY)),
    });
  }

  /**
   * `/更新 回退` —— **逐键**回到上一次不同的值。
   *
   * 和终端 `announce-reset --set` 的区别就在这里:那个会把"从没播报过的群"也写成
   * 已播报(它按"补齐"的语义设计),而回退只动**有历史**的键 —— 一个从没收到过播报的群
   * 不该因为"我退了一版"就再也拿不到补课梗概。
   */
  async function rollbackBaselines() {
    const groups = knownGroupIds();
    const baselines = Object.fromEntries(baselineRows().map((row) => [row.key, row.value ?? null]));
    const raw = stateStore.getMeta(BASELINE_HISTORY_KEY);
    const entries = parseBaselineHistory(raw);
    const plan = planBaselineRollback({ entries, baselines });
    if (plan.changes.length > 0) {
      stateStore.setMetaMany(Object.fromEntries(plan.changes.map((change) => [change.key, change.to ?? ''])));
      // 回退本身也留一条历史 —— 账本是 append-only 的,"我又改回来了"也是事实。
      let history = raw;
      for (const change of plan.changes) {
        history = appendBaselineHistory(history, { key: change.key, value: change.to, at: Date.now() });
      }
      stateStore.setMeta(BASELINE_HISTORY_KEY, history);
      log.info(
        `更新播报：账本回退 ${plan.changes.length} 个键 —— ` +
        plan.changes.map((change) => `${change.key}: ${change.from ?? '(空)'} → ${change.to ?? '(空)'}`).join('；'),
      );
    } else {
      log.info('更新播报：账本回退 —— 没有可回退的记录');
    }
    return describeRollback(plan, { groups });
  }

  // ---------------------------------------------------------------------------
  // 群身份:群名 / 人数(D59)
  // ---------------------------------------------------------------------------

  /**
   * 群名与人数的**带缓存**查询。
   *
   * 为什么要缓存:平台那个接口是 30 QPM,而 `/群列表` 是手动命令、一次要查 N 个群
   * (`/群列表` 是给人看的,不是热路径)。10 分钟内的重复查询直接用缓存;
   * 查不到就记 `null` 并**照旧列 openid** —— 名字查不到不该让这条命令不可用。
   */
  const groupInfoCache = new Map(); // id → { at, info }
  async function groupInfos(ids) {
    const out = {};
    for (const id of ids) {
      const hit = groupInfoCache.get(id);
      if (hit && Date.now() - hit.at < 600_000) {
        out[id] = hit.info;
        continue;
      }
      let info = null;
      try {
        const body = await api.getGroupInfo(id);
        info = {
          name: body?.group_name ?? null,
          memberNum: Number.isFinite(Number(body?.group_member_num)) ? Number(body.group_member_num) : null,
        };
        log.debug(`群信息：${id.slice(0, 8)}… = 「${info.name ?? '?'}」${info.memberNum ?? '?'} 人`);
      } catch (err) {
        // 常见原因:11253 无接口权限 / 网络。**说清是哪一种**,别让"名字查不到"变成谜。
        log.warn(`查群信息失败（${id.slice(0, 8)}…）: ${describeError(err)}`);
      }
      groupInfoCache.set(id, { at: Date.now(), info });
      out[id] = info;
    }
    return out;
  }

  /**
   * `/更新 基线 <版本>` —— 下次只播报这一版**之后**的改动。
   *
   * 只动**已经有基线**的键(不像终端 `--set` 那样给没播报过的群补一条):
   * 补了就等于宣布"那个群已经收到过 1.23.4",而它其实什么都没收到。
   */
  async function setBaselinesTo(version) {
    let known = [];
    try {
      known = listVersions(fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8'));
    } catch (err) {
      log.warn(`更新播报：读 CHANGELOG 失败（${describeError(err)}）`);
    }
    if (!isKnownVersion(known, version)) {
      return `（CHANGELOG.md 里没有版本 ${version} —— 不许把基线拨到一个不存在的版本。\n` +
        `已知版本（由新到旧）：${known.slice(0, 6).join(' / ')}…）`;
    }
    const wanted = String(version).replace(/^v/, '').trim();
    const rows = baselineRows();
    if (rows.length === 0) {
      return `（账本里一条基线都没有 —— 没有可拨的键。先发一次或看 \`/更新 账本\`。）`;
    }
    const next = {};
    for (const row of rows) next[row.key] = wanted;
    stateStore.setMetaMany(next);
    let history = stateStore.getMeta(BASELINE_HISTORY_KEY);
    for (const row of rows) {
      history = appendBaselineHistory(history, { key: row.key, value: wanted, at: Date.now() });
    }
    stateStore.setMeta(BASELINE_HISTORY_KEY, history);
    const untouchedGroups = knownGroupIds().filter((id) => !rows.some((row) => row.key === `announced_group:${id}`));
    log.info(`更新播报：账本基线已拨到 ${wanted}（${rows.length} 个键）`);
    const lines = [`（已把 ${rows.length} 个基线键拨到 ${wanted} —— 下次只播报它之后的改动。）`];
    if (untouchedGroups.length > 0) {
      lines.push(
        `· 没动的群：${untouchedGroups.length} 个（从没播报过）—— 它们下次仍会拿到补课梗概。` +
        '想让它们也从这一版之后开始，用终端的 `announce-reset.js --set`。',
      );
    }
    return lines.join('\n');
  }

  /**
   * 操作者回话了 —— 照办。
   *
   * 只在"确实问过、还在等他回话"时才认(所以口语「发」「不发」不会误伤日常聊天);
   * 认不出来就返回 false,那条消息照常交给模型。
   *
   * @returns {Promise<boolean>} 是否已经处理掉
   */
  async function handleAnnounceReply(message) {
    const pending = pendingAnnounce();
    if (!pending) return false;
    if (!stateStore.getMeta(announceOfferKey(pending.version))) return false; // 没问过 = 不是在回答
    const reply = parseAnnounceReply(message.content);
    if (reply.action === null) return false;

    if (reply.action === 'skip') {
      log.info(`更新播报：操作者选择不发（${pending.version}）`);
      await sendChunked(message, `（好，${pending.version} 这次不发。等你编下一个版本我再问。）`);
      return true;
    }

    const scope = reply.scope ?? 'all';
    let groupId = null;
    if (scope === 'group') {
      const index = reply.groupIndex;
      if (!index || index < 1 || index > pending.groups.length) {
        await sendChunked(message, `（没有编号 ${reply.groupIndex} 的群。\n\n${await describeKnownGroups()}）`);
        return true;
      }
      groupId = pending.groups[index - 1];
    }
    log.info(`播报确认：scope=${scope}${groupId ? ` group=${groupId}` : ''}（来自操作者的回话）`);
    // `/预览` 也是"只看看" —— 一样不推进基线(D55)。
    const result = await announceOnce({ manual: true, scope, groupId, preview: reply.action === 'preview' });
    await sendChunked(message, describeAnnounceResult(result, scope));
    return true;
  }

  /**
   * 播报失败的报错要能**直接告诉人怎么办**。
   *
   * `40034105 主动消息失败, 无权限` 是平台侧的权限问题,不是代码错了 ——
   * 实测:主实例(同一份代码、同一台机器)的主动群消息一直在成功,而副实例全部失败,
   * 所以差别在那只机器人自己的平台权限/状态。这种错误如果把原始 code 丢给用户,
   * 他既看不懂也不知道下一步做什么。见 D33。
   */
  function describeAnnounceError(err) {
    const message = describeError(err);
    if (/40034105|主动消息/.test(message)) {
      return '平台不让这只机器人主动发群消息；' +
        '改用「在群里 @ 她 发 /更新」（那是被动回复，不受这个限制）';
    }
    return describeUserError(err);
  }

  /**
   * 谁是操作者 —— 能打播报控制指令的人。
   *
   * **两道闸门缺一不可**:必须是私聊,且发送者必须在名单里。
   * 名单来源:`QQBOT_ADMIN_IDS`;没配就回落到播报/早安用的那个私聊目标
   * (那本来就是运维自己的 openid)。两者都没有 = 谁都不能 —— fail closed,
   * 和访问控制一个道理(D20):配置没写全时,不能让"控制权"默认落到所有人手上。
   */
  function isOperator(message) {
    if (message.scene !== 'c2c') return false;
    const allowed = operatorIds();
    return allowed.size > 0 && allowed.has(message.targetId);
  }

  function operatorIds() {
    if (config.policy.admin.ids) return config.policy.admin.ids;
    return new Set(
      [config.policy.announce.c2cTarget, config.policy.morning.c2cTarget].filter(Boolean),
    );
  }

  /** 是不是播报控制指令(`/更新` 系列 + `/群列表` + D50 的答复命令)。 */
  function isAnnounceCommand(text) {
    const head = String(text ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    return ANNOUNCE_COMMANDS.has(head) || GROUP_LIST_COMMANDS.has(head) || ANNOUNCE_REPLY_COMMANDS.has(head);
  }

  /**
   * 已知群的编号清单 —— 让操作者能挑一个群发(`/更新 2`)。
   *
   * ⚠️ **带群名与人数**(D59):以前只有 `A1000000…` 这种前缀,于是"哪个 id 是哪个群"
   * 只能靠猜 —— 用户要"屏蔽万紫千红"时,这一点直接卡住了整件事。
   * 群名来自平台的群信息接口(`api.getGroupInfo`),查不到就照旧只显示 openid。
   */
  async function describeKnownGroups() {
    const groups = knownGroupIds().map((id) => ({
      id,
      lastSeen: lastSeenAt(id),
      announced: stateStore.getMeta(`announced_group:${id}`),
    }));
    const infos = groups.length > 0 ? await groupInfos(groups.map((group) => group.id)) : {};
    const latest = readLatestRelease()?.version?.replace(/^v/, '') ?? null;
    return formatGroupList({ groups, infos, latest });
  }

  /**
   * `/更新` 的各个形态。**只做操作者明确要求的那一下,不猜。**
   *
   *   /群列表          看有哪些群、编号是多少
   *   /更新 预览       只发私聊(先看文案效果,群里的人不知道)
   *   /更新            私聊 + 所有已知群
   *   /更新 2          只发编号 2 的群
   */
  /**
   * `/更新` 的各个形态。**只做明确要求的那一下,不猜。**
   *
   *   私聊(操作者):/群列表、/更新 预览、/更新、/更新 2
   *   群里(任何人,幂等):/更新 → 作为**被动回复**发本群
   *
   * @returns {Promise<boolean>} 是否已经处理掉了。`false` = 交给模型当普通消息
   *   (非操作者在私聊发的、或群里发的是 `/群列表` 这种对本群没意义的词)。
   */
  async function handleAnnounceCommand(message, text) {
    const [head, ...rest] = text.split(/\s+/);
    const headLower = head.toLowerCase();

    // ---- 群里触发的分支:把播报**作为被动回复**发到本群 ----
    //
    // 为什么必须走被动回复:平台不让这只机器人主动发群消息
    // (`40034105 主动消息失败, 无权限`)。而"回复一条刚刚 @ 我的消息"是**被动消息**,
    // 不受那个限制 —— 所以「在群里 @ 她说 /更新」是唯一可靠地把播报送进群的通道。
    //
    // 这条路**幂等**(同群同版本只发一次),所以它对任何人都开放也不会变成刷屏入口;
    // 想收紧就配 `QQBOT_ADMIN_IDS`,那时群里也只有名单里的人能触发。
    if (message.scene === 'group') {
      if (!ANNOUNCE_COMMANDS.has(headLower)) return false; // `/群列表` 之类在群里没意义
      if (!config.policy.announce.enabled) return false;
      if (!isGroupController(message)) {
        log.info(
          `群里有人发 /更新 但不在名单里，已忽略：member_openid=${message.senderId ?? '?'}` +
          `（要允许他，把这个值加进 QQBOT_ADMIN_IDS）`,
        );
        return true; // 已处理(就是"不理"),不要交给模型
      }
      log.info(`群内播报：group=${message.targetId} 触发者=${message.senderId ?? '?'}`);
      const result = await announceOnce({
        manual: true,
        scope: 'thisGroup',
        groupId: message.targetId,
        passiveMessageId: message.messageId,
      });
      // 播报本身已经是给群里的回复了,所以**账目走私聊**,不往群里再贴一行"成功 1"。
      if (result.sent === 0) await reportToOperator(describeAnnounceResult(result, 'thisGroup'));
      else await reportToOperator(`（${result.version} 已作为回复发到群 ${message.targetId.slice(0, 8)}…）`);
      return true;
    }

    // ---- 私聊分支:必须是操作者 ----
    if (!isOperator(message)) {
      log.info(`忽略非操作者的播报指令：sender=${message.targetId}`);
      return false;
    }

    // `/发` `/不发` `/预览` —— 对"问你一声"的回答(D50)。
    // ⚠️ 必须**先**处理它们:`/不发` 落到下面那套参数解析里会被当成"没带参数" →
    //    于是正好相反 —— 把播报发出去了。
    if (ANNOUNCE_REPLY_COMMANDS.has(headLower)) {
      if (await handleAnnounceReply(message)) return true;
      await sendChunked(message, `（现在没有等你确认的播报：${describeAnnounceState()}。想直接发就 /更新。）`);
      return true;
    }

    if (GROUP_LIST_COMMANDS.has(headLower)) {
      await sendChunked(message, await describeKnownGroups());
      return true;
    }

    if (!config.policy.announce.enabled) {
      await sendChunked(message, '（这台不是日志机器人：QQBOT_ANNOUNCE=false）');
      return true;
    }

    // 参数解析是**纯函数**(`parseAnnounceCommandArgs`):每种写法、每条错误都在单测里。
    const parsed = parseAnnounceCommandArgs(rest, { groupCount: knownGroupIds().length });
    if (parsed.action === 'error') {
      const extra = parsed.message.includes('编号')
        ? `\n\n${await describeKnownGroups()}`
        : `\n用法：\n${ANNOUNCE_USAGE}`;
      await sendChunked(message, `${parsed.message}${extra}`);
      return true;
    }
    if (parsed.action === 'ledger') {
      await sendChunked(message, ledgerText());
      return true;
    }
    if (parsed.action === 'rollback') {
      await sendChunked(message, await rollbackBaselines());
      return true;
    }
    if (parsed.action === 'baseline') {
      await sendChunked(message, await setBaselinesTo(parsed.version));
      return true;
    }

    // `/更新 预览 [版本]` = **只看看**:发私聊、而且**不推进基线**(D55)。
    // 带版本号时只为这一次假设备份起点(基线等于最新版时的出路,D58)。
    const preview = parsed.action === 'preview';
    const scope = preview ? 'c2c' : parsed.scope;
    const groupId = scope === 'group' ? knownGroupIds()[parsed.groupIndex - 1] : null;

    log.info(
      `手动播报：scope=${scope}${groupId ? ` group=${groupId}` : ''}` +
      `${preview ? '（预览：不改基线）' : ''}${parsed.version ? `（假设上次发到 ${parsed.version}）` : ''}`,
    );
    const result = await announceOnce({
      manual: true,
      scope,
      groupId,
      preview,
      sinceVersion: preview ? parsed.version : null,
    });
    await sendChunked(message, describeAnnounceResult(result, scope, { preview, sinceVersion: parsed.version }));
    return true;
  }

  /**
   * 群里的控制权。
   *
   * ⚠️ 私聊那套名单用的是 **c2c 的 user_openid**,而群消息的发送者是 **member_openid** ——
   * 两者是**不同的 id 空间**(每个群还不一样,见 D09),所以私聊名单在群里天然对不上。
   * 于是:
   *   · 显式配了 `QQBOT_ADMIN_IDS` → 群里也校验(那名单里要放**群内的** openid);
   *   · 没配 → 允许,因为这条路径幂等且只影响本群,不是刷屏入口。
   * 日志里始终打出发送者的 openid,方便之后收紧。
   */
  function isGroupController(message) {
    const explicit = config.policy.admin.ids;
    if (!explicit) return true;
    return explicit.has(message.senderId);
  }

  /** 把结果发到操作者的私聊(账目走私聊,群里只留播报本身)。 */
  async function reportToOperator(text) {
    const to = config.policy.announce.c2cTarget || config.policy.morning.c2cTarget;
    if (!to) return;
    try {
      await sendChunked({ scene: 'c2c', targetId: to, messageId: undefined, content: '' }, text);
    } catch (err) {
      log.warn(`播报账目没能发到私聊: ${describeError(err)}`);
    }
  }

  /** 把播报结果说成人话 —— 手动那一下必须让人知道到底发出去没有。 */
  function describeAnnounceResult(result, scope, { preview = false, sinceVersion = null } = {}) {
    if (result.version === null) {
      return `（没发出去：${result.notes[0] ?? '读不到 CHANGELOG'}）`;
    }
    const where = scope === 'c2c'
      ? '私聊'
      : scope === 'group' ? '指定群' : scope === 'thisGroup' ? '本群（被动回复）' : '私聊 + 已知群';
    if (result.sent > 0 && result.failed === 0 && scope === 'thisGroup') {
      return `（${result.version} 已作为回复发到本群）`;
    }
    const lines = [`（${result.version} → ${where}：成功 ${result.sent}，失败 ${result.failed}）`];
    if (preview) {
      lines.push(
        sinceVersion
          ? `· 预览：假设上次发到 ${sinceVersion}，**账本没动**（正式发还会再念一遍）`
          : '· 预览：账本没动（正式发还会再念一遍）',
      );
    }
    if (result.notes.length > 0) lines.push(...result.notes.map((note) => `· ${note}`));
    if (result.sent === 0) {
      lines.push('一条都没发出去 —— 上面是原因。');
      if (scope !== 'thisGroup') {
        lines.push('想发到群里：**在那个群里 @ 她 发 `/更新`** —— 那是被动回复，不受主动消息权限限制。');
      }
    }
    return lines.join('\n');
  }

  /**
   * 播报目标怎么组。
   *
   * `configured` 用 `.env` 的 targets(自动播报);`all` 是私聊 + 所有已知群(手动 `/更新`,
   * 也就是"我按了,就都发");`thisGroup` 只发**当前这个群**,而且带 `messageId`
   * —— 那是**被动回复**,不受主动消息权限限制(见 D33)。
   */
  function announceTargets(scope = 'configured', groupId = null, passiveMessageId = null) {
    const cfg = config.policy.announce;
    const targets = [];
    const pushC2C = () => {
      if (cfg.c2cTarget) targets.push({ scene: 'c2c', id: cfg.c2cTarget, key: '私聊' });
    };
    const pushGroup = (id, index = null, messageId = null) => {
      targets.push({
        scene: 'group',
        id,
        messageId,
        key: index === null ? `群 ${id.slice(0, 8)}…` : `群 ${index}`,
      });
    };

    if (scope === 'c2c') {
      pushC2C();
      return targets;
    }
    if (scope === 'group') {
      if (groupId) pushGroup(groupId);
      return targets;
    }
    if (scope === 'thisGroup') {
      if (groupId) pushGroup(groupId, null, passiveMessageId);
      return targets;
    }
    if (scope === 'all') {
      pushC2C();
      knownGroupIds().forEach((id, index) => pushGroup(id, index + 1));
      return targets;
    }
    if (cfg.targets === 'c2c' || cfg.targets === 'both') pushC2C();
    if (cfg.targets === 'groups' || cfg.targets === 'both') {
      knownGroupIds().forEach((id) => pushGroup(id));
    }
    return targets;
  }

  /**
   * 已知群聊 = 她至少收到过一条消息的群。
   *
   * **两个来源取并集**:内存里的(`GroupContext`,有最新的活跃时间)与**落盘的**
   * (`known_group` 表,跨重启活着)。只取内存的话,每次重启后就"一个群都不认识"了 ——
   * 这条踩过好几次。见 D35。
   *
   * QQ 的群消息事件里**没有群名**,所以列表只能给出 openid;新拉的群要先 @ 她一次。
   */
  function knownGroupIds() {
    const ids = new Set(groupContext.knownGroups());
    try {
      for (const row of stateStore.knownGroups()) ids.add(row.id);
    } catch (err) {
      log.warn(`读群清单失败（只用内存里的）: ${describeError(err)}`);
    }
    return [...ids];
  }

  /** 某个群最后一次活跃的时刻(内存优先,回落落盘那份)。 */
  function lastSeenAt(groupId) {
    const memory = lastGroupActivity.get(groupId);
    if (Number.isFinite(memory)) return memory;
    try {
      return stateStore.knownGroups().find((row) => row.id === groupId)?.lastSeen ?? null;
    } catch {
      return null;
    }
  }

  function describeNoTargets(scope) {
    if (scope === 'c2c') return '没配 QQBOT_ANNOUNCE_C2C（私聊目标）';
    if (scope === 'group') return '那个编号的群不存在 —— 先发 `/群列表` 看看';
    return '还没有已知群聊 —— 先在那个群里 @ 她一次（她收到过消息才认得那个群）';
  }

  /**
   * 取值日问候 / 更新播报用的身体状态。
   *
   * 配了 `QQBOT_REPORT_STATS_DB` 时读的是**别的实例**的库(只读)——
   * 副实例就是这样汇报主实例的数值的,不需要主实例暴露接口。
   */
  function reportStats() {
    const file = config.policy.reportStatsDb;
    if (!file) return { stats: currentStats(), lastMealAt: null, lastFood: null };
    return readStatsForReport(file);
  }

  /**
   * 这一台是不是"报数的那只"(配了 `QQBOT_REPORT_STATS_DB` = 读别人的库)。
   *
   * 分界点在这里而不是角色名上:**谁读别人的库,谁就是报数的那只** ——
   * 于是这套逻辑不写死"副实例",以后再挂一只旁白也能用。
   */
  function isReporter() {
    return Boolean(config.policy.reportStatsDb);
  }

  /**
   * 「身体数值扫描」—— 播报**主实例的**数值,用她自己的机械播报口吻说出来(D42)。
   *
   * 三条要求写进提示词,每条都对应一个真实风险:
   *   1. **数字必须照抄** —— 数值由桥从主实例的库里读出来,她只负责念;编一个数字就是
   *      "诊断工具说谎",而且群里没人能核对。
   *   2. **别复述库的存在** —— 提示词里会提到"状态库/另一台机器人",那是给她的说明,
   *      不是台词(和 `身体状态（照做但别念出来）` 同一个待遇)。
   *   3. **短** —— 扫描播报是系统消息,不该变成一段小作文。
   *
   * @param {object} message 触发它的那条消息(被动回复要用它的 msg_id)
   * @param {{stats: object, lastMealAt: number|null, lastFood: string|null}} snapshot
   */
  async function sendScanReport(message, snapshot) {
    const stats = snapshot.stats;
    // ⚠️ **P4(2026-10-28):报数口径跟着"目标"走,不跟报数者自己走。**
    //    以前这里写死「主实例」+ 饱食/健康/心情/货币单位,而失败兜底又用**报数者自己**的
    //    身体主题 —— 于是副实例报主实例时,名号是主实例、措辞却是"电量/机能",两头不对。
    const targetTheme = getBodyTheme(config.policy.reportTargetTheme);
    const targetName = config.policy.reportTargetName;
    const facts = [
      `${longLabelFor('satiety', targetTheme)} ${Math.round(stats.satiety)}/100`,
      `${longLabelFor('health', targetTheme)} ${Math.round(stats.health)}/100`,
      `${longLabelFor('mood', targetTheme)} ${Math.round(stats.mood)}/100`,
      `${CURRENCY.name} ${Math.round(stats.money ?? 0)}`,
    ].join('、');
    const lastMeal = Number.isFinite(snapshot.lastMealAt)
      ? `她最近一次进食：${new Date(snapshot.lastMealAt).toTimeString().slice(0, 5)}` +
        `${snapshot.lastFood ? ` ${snapshot.lastFood}` : ''}`
      : '没有进食记录';
    const prompt = [
      `【系统】你要对「${targetName}」做一次身体数值扫描并播报结果。`,
      '数据如下（**照抄，不许改、不许编、不许四舍五入到整数以外的说法**）：',
      `  ${facts}`,
      `  ${lastMeal}`,
      '要求：',
      '1. 用你自己的系统播报口吻说出去 —— 开头像「身体数值扫描…」、结尾像「…扫描完毕」这样；',
      '2. 四个数字**一个都不能错、一个都不能漏**；',
      '3. 不要解释这些数据从哪来、不要提"状态库""另一台机器人""系统提示"；',
      '4. 四五句以内，不要提问、不要加表情之外的装饰。',
    ].join('\n');

    const mood = moodFor(conversationKeyFor(message));
    try {
      const result = await runner.runTurn(
        conversationKeyFor(message),
        withStyleNudge(prompt, await turnNotes(mood, null, [])),
        config.policy.replyTimeoutMs,
      );
      if (result.timedOut || isSilentReply(result.text)) {
        // 模型没产出就退回确定性一行 —— 报数是功能,不该因为模型摆烂而消失。
        // ⚠️ P4:兜底也必须用**目标**的身体主题(以前用报数者自己的 → 副实例报主实例,
        //    兜底写成"电量/机能",名实不符)。
        log.warn('数值扫描：模型没有产出内容，回退到确定性格式');
        await sendChunked(message, describeForUser(stats, {
          lastMealAt: snapshot.lastMealAt,
          lastFood: snapshot.lastFood,
          theme: targetTheme,
        }));
        return;
      }
      const body = composeReply(result);
      await sendChunked(message, body);
      log.info(`数值扫描：已播报（长度 ${body.length}）`);
    } catch (err) {
      log.error('数值扫描失败，回退到确定性格式', err);
      await sendChunked(message, describeForUser(stats, {
        lastMealAt: snapshot.lastMealAt,
        lastFood: snapshot.lastFood,
        theme: targetTheme,
      }));
    }
  }

  /** 一条入站消息对应的会话 key(`/状态` 那类桥内命令要用它记账/掷情绪)。 */
  function conversationKeyFor(message) {
    return sessionIdFor({ scene: message.scene, targetId: message.targetId });
  }

  /**
   * 「钱包」:让她**用自己的口吻**说一句自己还有多少钱(D44)。
   *
   * 用户的要求是「不要像机器人一样，只要说自己有多少钱就行，报详细数值的工作交给副实例」——
   * 所以这里刻意**不给她任何规格**:不提"枚"、不给三围、不给开销速率、不许列账单,
   * 那些都是副实例的活(D28/D42 的分工)。
   *
   * ⚠️ **数字必须校验。** 她读不到库,数字是桥给的 —— 而模型完全可能把 49 说成 50。
   * 所以说完用 `mentionsAmount` 核对:没说出那个数(或者说错了)就退回确定性的一行。
   * 这条和副实例的数值扫描是同一条规矩:**数字只能来自库**。
   *
   * @param {object} message 触发它的那条消息(被动回复要用它的 msg_id)
   * @param {number} amount 桥读出来的真实金额
   */
  async function sendWalletLine(message, amount) {
    const fallback = () => sendChunked(
      message,
      amount < MONEY_POOR
        ? `（我这会儿身上就 ${amount} ${CURRENCY.name}了……）`
        : `（我还有 ${amount} ${CURRENCY.name}。）`,
    );
    const conversationKey = conversationKeyFor(message);
    const mood = moodFor(conversationKey);
    try {
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(walletPrompt(amount), await turnNotes(mood, null, [])),
        config.policy.replyTimeoutMs,
      );
      if (result.timedOut || isSilentReply(result.text)) {
        log.warn('钱包：模型没有产出内容，回退到确定性一行');
        await fallback();
        return;
      }
      if (!mentionsAmount(result.text, amount)) {
        // 没说那个数 —— 可能改成了别的数字,也可能绕开了。两种都不行(那是"报数说谎")。
        log.warn(`钱包：模型没说出真实金额(${amount})，回退到确定性一行；它说的是「${result.text.slice(0, 60)}」`);
        await fallback();
        return;
      }
      const body = composeReply(result);
      await sendChunked(message, body);
      log.info(`钱包：已回话（${CURRENCY.name} ${amount}，长度 ${body.length}）`);
    } catch (err) {
      log.error('钱包回话失败，回退到确定性一行', err);
      await fallback();
    }
  }

  /**
   * 这一段会话里**已经端过**的记忆 id(2026-10-01 第二批,D89)。
   *
   * 与 provider 自己那本"30 分钟窗口"的账分工不同:
   *   · 那本是**进程级**的(它管"刚端过的别连着端",窗口一到就放行);
   *   · 这本是**会话级**的(它管"这一段会话里端过的就别再端",没有窗口)——
   *     因为"同一段活上下文里把同一句回忆塞两遍"没有任何价值,而换一代就是全新的上下文。
   *
   * 上限 200 条,满了丢最老的。**换代自然清空**(它就是个进程内 Map)。
   */
  const shownLongTerm = new Map();
  function markLongTermShown(conversation, ids) {
    if (!conversation || !Array.isArray(ids) || ids.length === 0) return;
    if (!shownLongTerm.has(conversation)) shownLongTerm.set(conversation, new Set());
    const bucket = shownLongTerm.get(conversation);
    for (const id of ids) bucket.add(String(id));
    if (bucket.size > 200) {
      for (const id of bucket) {
        if (bucket.size <= 200) break;
        bucket.delete(id);
      }
    }
  }

  /**
   * 长期记忆那一小块(2026-09-30,见 `docs\03` D75)。
   *
   * **为什么是"每轮"而不是只走交接**:交接只在**换代第一轮**注入 ——
   * 一个跑了一周没重启的会话**永远看不到**它。而"第一次见面 / 答应过的事"
   * 恰恰是那种不该等到下次重启才想起来的长期事实(v0 的 IMPORTANCE_BONUS 就是这条)。
   *
   * 判据 2 落在日志上:每条被选中的记忆都要说得出"为什么是它"(命中哪些标签 /
   * 重要性 / 约多少天前 / **被想起过几次**)。**理由进日志,原文不进** —— 库里是真人原话,而日志是要被贴的。
   *
   * @param {{conversation?: string, query?: string}|null} recall 这段记忆属于哪个会话、由哪句话触发
   * @returns {string|null} 要拼进提示词的一小段,或 null(=这轮没有长期记忆)
   */
  function longTermNote(recall = null) {
    if (!longTermProvider || !recall) return Promise.resolve(null);
    const conversation = recall.conversation ?? null;
    const query = String(recall.query ?? '').trim();
    // 向量检索(D92):先问本机那个 embedding 服务"这句话像什么",
    // 拿到向量就交给检索算语义那一维;**拿不到就退回标签那套**(一次失败不该影响对话)。
    return withQueryVector(query).then((vector) => {
      // W3:同一句话的查询向量**记下来给知识库用**(kbVectorMemo) —— turnNotes 区里
      // Promise 形状的调用被 selftest-async-seams 钉死只有 longTermNote 一条,知识库
      // 那一路必须同步;顺便省掉对 embedding 服务的第二次一模一样的请求。
      kbVectorMemo.query = query;
      kbVectorMemo.vector = vector;
      const result = longTermProvider({
        conversation,
        query,
        // 人名表每轮现读:新认识的人马上就能被当成"人",而不是把他昵称里的字当成内容。
        peopleNames: knownPeopleNames(),
        // P1-F:实体名单也每轮现读(认识的人 + 学会的概念);权重走工厂级(config)。
        entityNames: entityNamesForRecall(),
        // 这一段会话里已经端过的:provider 会**换一条次好的**,而不是"挑中最好的再丢掉"。
        excludeIds: shownLongTerm.get(conversation) ?? null,
        // 语义那一维(没向量时 null → 老的纯标签行为,一字不差)。
        semantic: vector ? { vector, model: memoryCfg.embedding.model } : null,
      });
      if (result.text) {
        log.info(
          `长期记忆：注入 ${result.picked.length + result.notes.length} 条（用 ${result.text.length}/${memoryCfg.longTerm.budget} 字，` +
          `与交接的 ${memoryCfg.budget} 字分开算）` +
          (result.notes.length > 0 ? `｜其中固化记忆 ${result.notes.length} 条` : '') +
          (vector ? '｜含语义检索' : ''),
        );
      // 固化记忆(中期/长期)先说:它是"回头"挑出来的,理由里带通道与固化分。
      for (const note of result.notes) {
        log.info(`长期记忆：为什么选中它 —— ${note.id} ｜ ${note.why.join(' ｜ ')}`);
      }
      for (const memory of result.picked) {
        log.info(`长期记忆：为什么选中它 —— ${memory.id} ｜ ${memory.why.join(' ｜ ')}`);
      }
      // 记账(D89):这一段会话里端过的记下来;落盘那笔由 provider 自己写(跨代也认)。
      markLongTermShown(conversation, [
        ...result.notes.map((note) => note.id),
        ...result.picked.map((memory) => memory.id),
      ]);
      // ⚠️ 2026-10-18(P0-2):长期记忆块也自报家门(D177)。它现在被拼进「本次表达要求」
      //    那个大块里 —— 那道块本身就剥了,但**剥的是措辞不是来源**:哪天这行挪出
      //    `withStyleNudge`,它就会静默变成"人说的话"。标记让它不依赖位置。
      return wrapInject('recall', result.text);
    }
    // ⚠️ 普通"这句话没有标签"**不记**(每轮一条会把日志淹掉);
    //    只有"她在考记忆却没回忆"与真正的失败才留痕 —— 前者正是 v1 修掉的那个坑,
    //    事后必须能看出"这是我们有意的,不是漏了"。
    if (result.trigger) log.info(`长期记忆：不注入 —— ${result.reason}`);
    else if (/失败/.test(result.reason ?? '')) log.warn(`长期记忆：不注入 —— ${result.reason}`);
    return null;
    });
  }

  /**
   * 知识库那一小块(W3 知识库接线 P2-B,2026-10-22):query 在 doc/doc_chunk 里命中
   * **她在原作经历过**的块时,把命中内容作为**独立来源块**注入。
   *
   * · 没命中 / 配置关 → 返回 null,**一个字都不加**(判据 1:命中才注入;renderKnowledge
   *   对空 picked 返回空串,这里原样转成 null,调用方不拼)。
   * · 口径照 kb.js 头一行(D95 用户定的):「那是她的记忆,不是你们之间的经历」——
   *   它挡的正是最糟的那件事:把原作里的伙伴说成你们之间的人(C 档:错了不报错)。
   * · 理由进日志、原文不进(与长期层同一条纪律);`doc:<id>#<seq>` 说得出是哪份资料哪一段。
   *
   * ⚠️ **刻意同步**(没有 async):turnNotes 区里 Promise 形状的调用被
   * selftest-async-seams 钉死只有 longTermNote 一条;语义那一维走 kbVectorMemo
   * (长期层这一轮已经为同一句话取回的向量),不额外发请求。
   */
  function kbNote(recall = null) {
    if (!kbProvider || !recall) return null;
    const query = String(recall.query ?? '').trim();
    if (query === '') return null;
    // 语义那一维:长期层这一轮为同一句话取回的向量(kbVectorMemo);对不上 → null → 退回标签。
    const memoVector = kbVectorMemo.query === query ? kbVectorMemo.vector : null;
    const result = kbProvider({
      conversation: recall.conversation ?? null,
      query,
      semantic: memoVector ? { vector: memoVector, model: memoryCfg.embedding.model } : null,
    });
    if (result.text) {
      // 百科模式(D297,2026-10-22 主人拍板):「细说/为什么/是什么」类问题 → 资料块尾部
      // 附一句措辞要求(约 100 字说明、先给结论),她这轮用说明式回答而不是聊天短句。
      // ⚠️ 指令写在 kb 块**内部**:归档剥壳随块消失,不会漏进她的记忆(剥壳判据管着);
      //    没命中/开关关 = 照常按角色卡说话,行为一字不变。
      const ency = memoryCfg.kb?.ency !== false && detectEncyclopedia(query);
      log.info(
        `知识库：注入 ${result.picked.length} 条（用 ${result.text.length}/${memoryCfg.kb.budgetChars} 字，预算独立）` +
        (memoVector ? '｜含语义检索' : '') + (ency ? '｜百科模式' : ''),
      );
      for (const picked of result.picked) {
        log.info(`知识库：为什么选中它 —— ${picked.id} ｜ ${(picked.why ?? []).join(' ｜ ')}`);
      }
      // 自报家门(D177):归档读路径剥壳后一字不剩(判据 4)。
      return wrapInject('kb', ency ? `${result.text}\n${ENCYCLOPEDIA_NOTE}` : result.text);
    }
    // 命不中**不记**日志(每轮一条会把日志淹掉);只有 provider 真失败才留痕。
    if (/失败/.test(result.reason ?? '')) log.warn(`知识库：不注入 —— ${result.reason}`);
    return null;
  }

  /**
   * 问本机那个 embedding 服务要一个查询向量(D92)。**bridge 里唯一一处 HTTP。**
   *
   * 三条边界(与"落账失败不许带走回忆"同族):
   *   · 配置关着 / 没给 URL → **一个请求都不发**;
   *   · 失败/超时 → 返回 null,这一轮就当"没有语义那一维",退回标签;
   *   · 只打本机(URL 由配置给),所以不依赖任何外部服务。
   */
  function withQueryVector(text) {
    const cfg = memoryCfg.embedding;
    if (!cfg?.enabled || !cfg.url || !String(text ?? '').trim()) return Promise.resolve(null);
    return fetchQueryVector(text, { url: cfg.url, model: cfg.model, timeoutMs: cfg.timeoutMs })
      .catch(() => null);
  }

  /**
   * 组装本轮注入的私有提示:身体状态 + 情绪 + 表面形式 + 长期记忆。
   *
   * @param {object} moodDecision
   * @param {object|null} [message] 触发这一轮的消息(正文与场合都在里面)
   * @param {Array} [ledger]
   * @param {{conversation?: string, query?: string}|null} [recall]
   *   **只有**在没有 `message` 可推的场合才需要显式传(暖群:那一轮没有"人说的话",
   *   但话题方向可以当检索的 query)。默认从 `message` 推。
   * @param {{hasImage?: boolean|null, backgroundImages?: boolean}} [options]
   *   `hasImage` = 这一轮**真的喂进模型的图**(`imageBlocks.length > 0`)。传 null/不传就按
   *   `message.images` 推。⚠️ 为什么要显式传:"窗内补图"(前几条消息里的图被一起喂进去)时
   *   `message.images` 是空的,但图确实上桌了 —— 不传就等于又漏掉一类投喂。
   *   `backgroundImages` = 这些图**不是**触发那条消息自带的(是窗内补进来的)。
   *   ⚠️ 它决不只是措辞问题:不标出来她就会**把旧图当成这一口**
   *   (现场:`[投喂 宿舍的零食]` → 她答"这**盘肉**看着还算有点诚意",肉来自三天前那张图)。
   */
  async function turnNotes(
    moodDecision, message = null, ledger = [], recall = null,
    { hasImage = null, backgroundImages = false } = {},
  ) {
    // 直接回应不属于口语花活：任务/知识、严肃场景和随机风格关闭时也必须到达。
    const notes = [...DIRECT_RESPONSE_NOTES];
    if (config.policy.stats.enabled) {
      const bodyTheme = getBodyTheme(config.policy.stats.theme);
      notes.push(
        // **病态进提示词**(D103 接线):病着的时候她自己得知道 —— 状态行里会写
      // 「**正在生病：感冒**（…还要 N 小时,可以求治疗者帮忙）」。
      // ⚠️ P4(2026-10-28):爆裂与"钱"两条约束按**本实例开没开对应玩法**给,
      //    机械体不再收到"魔力不够放爆裂""别装穷"这类串味要求。
      `身体状态（照做但别念出来）：${describeForPrompt(currentStats(), bodyTheme, {
        condition: readCondition(),
        explosionEnabled: config.policy.explosion.enabled,
        moneyEnabled: config.policy.stats.money,
      })}`,
      );
      // 只在"这一轮可能涉及吃喝"时才教它回报格式 —— 免得每轮都占 token,
      // 也免得它在没吃东西的时候乱写。
      const imagesPresent = hasImage ?? (message?.images?.length ?? 0) > 0;
      if (looksLikeEating(message?.content ?? '', { hasImage: imagesPresent })) {
        notes.push(
          '如果这一轮你确实吃了或喝了东西，就在回复的最末尾补一行：' +
          '<intake food="食物名" kcal="热量数字" health="±数字" mood="±数字"/>' +
          '（给系统读的标记，不要念出来、不要解释、不要用别的格式；' +
          '**对方发来的图片里明显是食物或饮料，才算你这一轮吃了/喝了**，那就要补上这一行）',
        );
      }
      // 「被投喂」怎么演(D98):**光有格式要求不够** —— 她照字面把图当图,
      // 于是出现"图不能吃""填不饱肚子"这种把互动演死的回复(用户 2026-10-02 报的尴尬现场)。
      const feedNote = feedingNote({
        text: message?.content ?? '',
        hasImage: imagesPresent,
        backgroundImages,
        theme: bodyTheme,
      });
      if (feedNote) notes.push(feedNote);
    }
    // **事件钩子**(D99 阶段 3):这一轮有人在回她抛出去的那件事 → 教她把走向定下来。
    //    ⚠️ 走向由**她**从清单里挑(只有她读得懂"他们那句话是什么意思"),
    //    但**数值由代码给** —— 所以她必须把挑中的那档用 `<story outcome="…"/>` 报回来。
    if (pendingStoryFor(message)) {
      const story = pendingStoryFor(message);
      notes.push(buildStoryRespondPrompt({
        scene: story.scene,
        event: { setup: story.pending.setup, branches: story.pending.branches },
        reply: story.reply,
        silentToken: SILENT_TOKEN,
      }));
    }
    // **用户主动的互动事件**(D101 形态一):这一轮有人拉着她做某件事 → 教她演出来。
    const companyNoteText = companyTurnNote();
    if (companyNoteText) notes.push(companyNoteText);
    // **好感度**(D104):对**说话的这个人**的亲疏 —— 同一个群里她该分人说话。
    const affinityText = affinityNote(message);
    if (affinityText) notes.push(affinityText);
    // ⚠️⚠️ **身份那句不在这里**(1.100.1 / D163):它以前跟好感、身体状态一起被塞进
    //    `withStyleNudge` 那个**「（本次表达要求，照做但不要念出来：）」**的块里 ——
    //    而那一条是"**怎么说话**"的块,不是"**这是谁**"的块。用户实测就是
    //    「绑定完没什么用,我在网站上说了我是防火门,到 QQ 就不知道了」:
    //    一句"这一轮跟你说话的人是网页上的某某"被当成措辞要求,她自然不会拿它回话。
    //    → 现在它由 `turnFacts()` 走**事实**那条路(贴在消息旁边,见调用处)。
    // **钓鱼的情景**(用户实测第 2 条:「要给角色提示词**固定写情景**,
    //   至少有知道**现在在哪里的意识**」)—— 每一轮都注入,所以她**始终**知道自己在水边。
    if (message) {
      const scene = describeFishingScene(readFishing(message));
      if (scene) notes.push(scene);
    }
    // **面板那一句**(D111 第④步):QQ 是轻量渠道,细节在网页上。
    //    ⚠️ 只在**真的有用**时注入(她在钓,或者面板上刚做过什么)—— 不要变成每轮都念的广告。
    const panelNoteText = panelPromptNote(message);
    if (panelNoteText) notes.push(panelNoteText);
    // 经济(D42):这一轮刚发生的收支。**只在这一轮**注入,而且不许念数字 ——
    // 它是"刚发生的事",不是可以反复拿出来说的谈资。
    const ledgerNote = describeLedgerForPrompt(ledger);
    if (ledgerNote) notes.push(ledgerNote);
    // 养成:等级与进度**每轮**都进提示词(她会照着自己的"实力"说话),
    // 但措辞要求明确"这是背景,不是台词" —— 报出来就变成刷屏的数值机器了。
    if (config.policy.growth.enabled) {
      notes.push(
        `成长状态（照做但别念出来、不要主动报数字）：${describeGrowthForPrompt(currentGrowth())}`,
      );
    }
    // 长期记忆(D75):像 stats/mood 那样**每轮**拼一小块,而不是只在换代时。
    // query 默认就是"这一轮触发它的那句话" —— 没有那句话就没有检索的由头(判据 1)。
    // (W3 起 recallFor 三个通道共用:长期层 / 洞察 / 知识库,提出来只算一次。)
    const recallFor = recall ?? (message ? { conversation: conversationKeyFor(message), query: message.content } : null);
    const longTerm = await longTermNote(recallFor);
    if (longTerm) notes.push(longTerm);
    // P2-A:记忆洞察(2026-10-22,方案 §4.4):最新 ≤3 条作为**独立小块**,预算独立
    // (maxPerRun × limitChars = 360 字,不与长期层那 300 字互抢),过 wrapInject('insight')
    // 自报家门(D177;kind 已在 INJECT_KINDS 登记)。配置关/表空 = 一字不加(回滚开关)。
    // ⚠️ 判据必须写成 typeof:本函数会被 selftest-longterm-consumption 整段切片进 vm 沙箱
    // (那里只给固定的桩,memoryCfg/memoryDb 不在其中),直接引用会在沙箱里 ReferenceError;
    // 生产里两者恒在,typeof 只是给切片留活路,不是运行时开关。
    if (typeof memoryCfg !== 'undefined' && memoryCfg.insights?.enabled && memoryDb) {
      try {
        // **作用域守卫**(P0,2026-10-28):洞察是"跨多条私聊笔记看出的模式",群聊一律不给。
        // ⚠️ typeof 守卫的理由与上面 memoryCfg 同一条:本函数会被切片进 vm 沙箱跑。
        const access = typeof memoryAccessFor === 'function'
          ? memoryAccessFor(recallFor?.conversation ?? '', { ownerIds: config.policy.admin?.ids ?? null })
          : { insights: true };
        const insightText = renderInsights(memoryDb, {
          limit: memoryCfg.insights.maxPerRun,
          budgetChars: memoryCfg.insights.maxPerRun * memoryCfg.insights.limitChars,
          rows: typeof latestInsights === 'function' && typeof filterInsightsForAccess === 'function'
            ? filterInsightsForAccess(latestInsights(memoryDb, { limit: memoryCfg.insights.maxPerRun }), access)
            : null,
        });
        if (insightText) notes.push(wrapInject('insight', insightText));
      } catch (err) {
        log.warn(`记忆洞察渲染失败（这轮没洞察，不影响对话）: ${describeError(err)}`);
      }
    }
    // W3 知识库(P2-B,2026-10-22):doc/doc_chunk 里她在原作的经历,命中才作为**独立来源块**
    // 注入(预算独立 ≤300 字,不与长期层 300 / 洞察 360 互抢),过 wrapInject('kb') 自报家门
    // (D177;kind 已在 INJECT_KINDS 登记)。配置关/没命中 = 一字不加(回滚开关 QQBOT_MEMORY_KB)。
    // ⚠️ typeof 守卫与上面 insight 同一条纪律:本函数会被 selftest-longterm-consumption
    // 整段切片进 vm 沙箱(kbNote/memoryCfg/memoryDb 不在桩里),typeof 只是给切片留活路,
    // 不是运行时开关。
    if (typeof memoryCfg !== 'undefined' && memoryCfg.kb?.enabled && memoryDb && typeof kbNote === 'function') {
      const kbBlock = kbNote(recallFor); // 同步(见 kbNote 头注释)—— 检索/渲染都不发网络请求
      if (kbBlock) notes.push(kbBlock);
    }
    // ⚠️ **「关于人的事实」不在这里**(2026-10-09 挪走):它原先被拼进这一块,
    //    而这一块是"**表达要求,照做但别念出来**"—— 事实与要求同居一栏正是 D163 那条教训
    //    (`turnFacts` 的注释里写着用户实测的现场)。现在它跟着 `turnFacts()` 走事实那一栏。
    //    端在这里的话还会**重复注入两份**(2026-10-09 加 @ 那句话时顺手抓到的)。
    // 他提了"关于她"的关系主张 → 把决定权交给她(她认了才落库)。
    const claim = claimNote(message);
    if (claim) notes.push(claim);
    // ⚠️ **严肃话题要收敛**(D80):重病/去世/灾难这类场合,把每轮的花活关掉。
    //    用户 2026-10-01:「涉及严肃话题的时候也要按角色设定判断(如 911,大地震等等)」——
    //    注意这条**不写台词**,只关花活 + 交代态度;具体怎么说仍然是角色卡的活。
    const policy = turnPolicyFor(message?.content ?? '', { enabled: config.policy.seriousGuard });
    // **P1 任务口径**(2026-10-28):平台无关的纯函数判定 —— chat 维持现状,task/knowledge
    //   松开短句与字数限制并压掉"改答案"的随机风格。追问继承上一轮(别讲完三步又被拉回闲聊)。
    // ⚠️ typeof 守卫同 memoryCfg 那条:本函数会被切片进 vm 沙箱(那里没有这个模块)。
    const conversationId = recallFor?.conversation ?? (message ? conversationKeyFor(message) : '');
    const turnMode = typeof detectTurnMode === 'function'
      ? detectTurnMode(message?.content ?? '', { previous: lastTurnMode.get(conversationId) ?? 'chat' })
      : { mode: 'chat', reason: 'policy-module-missing' };
    // ⚠️ 下面三样在 vm 切片沙箱里都不存在(typeof 守卫与 memoryCfg 同一条纪律)。
    if (turnMode.mode !== 'chat' && typeof log !== 'undefined' && typeof log.info === 'function') {
      log.info(`本轮口径：${turnMode.mode}（${turnMode.reason}）会话=${conversationId || '-'}`);
    }
    if (typeof rememberTurnMode === 'function') rememberTurnMode(conversationId, turnMode.mode);
    const gates = typeof noteGatesFor === 'function'
      ? noteGatesFor(turnMode.mode, policy)
      : {
        includeMoodLength: !policy.suppressMood,
        includeRandomNudges: !policy.suppressNudges,
        includeSeriousComfort: Boolean(policy.note),
        includeModeNote: false,
      };
    if (gates.includeSeriousComfort && policy.note) notes.push(policy.note);
    if (gates.includeModeNote) {
      const modeNote = composeModeNote(turnMode.mode);
      if (modeNote) notes.push(modeNote);
    }
    if (gates.includeMoodLength) notes.push(...moodNotes(moodDecision));
    if (gates.includeRandomNudges) notes.push(...nextNudges());
    return notes;
  }

  /**
   * **这一轮说话的人在世界里的角色是谁**(1.104.0 / D168)。
   *
   * ⚠️ 与身份那句(D158/D163)是**两件事**,别混:
   *   · 身份 = "网页上的你 = QQ 里的你"(**谁**是同一个人);
   *   · 这句 = "这个人在世界里的角色叫什么、会什么"(**他演的是谁**)。
   * 所以它也是**事实**(走 `turnFacts` 那条路),不是措辞要求。
   *
   * ⚠️ 两种场合分别取值(与身份那句同一条口径):
   *   · 网页私聊 / 房间:`senderId` 就是 `playerId`;
   *   · QQ:先按 openid 找绑定,再拿 `playerId`。
   */
  function characterNoteFor(message) {
    if (!message || !characters) return null;
    try {
      let playerId = null;
      if (message.scene === 'web') {
        playerId = Number(String(message.senderId ?? message.targetId ?? '').replace(/^web:/, ''));
      } else {
        const openid = String(message.senderId ?? '').trim();
        const binding = openid ? identityLinks.byOpenid(openid) : null;
        playerId = binding?.playerId ?? null;
      }
      if (!Number.isInteger(playerId) || playerId <= 0) return null;
      const sheet = characters.get(playerId);
      if (!sheet) return null;
      return `他在世界里的角色：${describeSheet(sheet)}`
        + '（数字是世界算的，你**不用**念出来，也别改它 —— 该怎么称呼他、他擅长什么，照这个来。）';
    } catch (err) {
      log.warn(`角色提示注入失败（这一轮照常聊）: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * **这一轮 @ 了谁**(2026-10-09,修用户报的"名字记到说话人头上")。
   *
   * ⚠️ 现场:2026-10-08 19:07 `酸音盐777:记住 这个人,名字叫江时光` —— 她收到的提示词里
   *    **一个字都没提"这条 @ 了谁"**,只有"跟你说话的人是防火门"。于是模型只能把名字
   *    挂到唯一那个人身上(她还反问过"防火门、江时光,同一个凡人挂两个名号")。
   *    `cleanInboundText()` 会把 `<@!openid>` **剥掉**,所以正文里连痕迹都没有 ——
   *    这一句是**唯一**能把"这条 @ 的是别人"告诉她的地方。
   *
   * 口径:只报**昵称与"不是你"这一个事实**,不报 openid(与 `buildIdentityNote` 同一条规矩:
   * openid 是内部标识,不进提示词)。@ 到机器人自己、或没昵称时给一句"有人被 @ 了"。
   */
  function mentionNoteFor(message) {
    if (!message || (message.scene !== 'group' && message.scene !== 'room')) return null;
    const others = (message.mentions ?? []).filter((entry) => entry && entry.id && entry.bot !== true);
    if (others.length === 0) return null;
    // ⚠️ @ 里**不含机器人自己**时才算"别人被 @ 了"(@ 她只是叫她听)
    const named = others
      .map((entry) => String(entry.username ?? '').trim())
      .filter((name) => name !== '');
    const prefix = '这一轮他 @ 的不是你，是别人';
    return named.length > 0
      ? `${prefix}（${named.map((name) => `「${name}」`).join('、')}）—— 别把"他"说成跟你说话的那个人。`
      : `${prefix} —— 别把"他"说成跟你说话的那个人。`;
  }

  /**
   * **@ 到的那个人,我们知道些什么**(2026-10-09 第二次修,用户点的第二半)。
   *
   * > 用户原话:「**或者能不能让她直接记看到的群聊发言人昵称**」。
   *
   * 能 —— 而且这个数据**已经在库里了**:`person` 表每见一个人说一次话就更新 `display`(D78),
   * 所以这一条不是新建名册,而是**把已有的名册端到提示词里**:
   *   ① **我们观察到的群昵称**(QQ 每条群消息都会给 `author.username`);
   *   ② **有人教过她的名字**(`fact` 的 `name` 维度 —— 人可能改口)。
   * 两者都报,并说清"有人教过就用教过的"。
   *
   * ⚠️ 与 `mentionNoteFor()` 分开的原因:那一条说的是"**别把他说成说话人**"(指代问题),
   *    这一条说的是"**这个人叫什么**"(名册问题)。合成一句在日志与测试里都看不清是哪一条出了问题。
   *
   * @returns {string|null} 一句事实;那条消息没 @ 别的真人时返回 null
   */
  function mentionedRosterNote(message) {
    if (!message || message.scene !== 'group') return null;
    const other = (message.mentions ?? []).find((entry) => entry && entry.id && entry.bot !== true && entry.id !== message.senderId);
    if (!other) return null;
    const id = String(other.id);
    const scope = `group:${message.targetId}`;
    let observed = String(other.username ?? '').trim();
    let taught = '';
    try {
      const row = stateStore.people({ scope, limit: 200 }).find((entry) => entry.openid === id);
      const display = String(row?.display ?? '').trim();
      if (display !== '') observed = display;
      taught = String(stateStore.facts({ scope, subject: id, limit: 20 }).find((fact) => fact.kind === 'name')?.value ?? '').trim();
    } catch (err) {
      log.warn(`读"@ 到的人我们认识吗"失败（不影响对话）: ${describeError(err)}`);
    }
    // "整条都是不可见字符"的昵称不要端出去(库里有这种:`ㅤ`、`（）`)
    if (nameIsInvisible(observed)) observed = '';
    const label = taught || observed;
    if (!label) return null;
    const parts = [`这一轮被 @ 的那个人，我们知道的名字是「${label}」`];
    if (taught && observed && taught !== observed) {
      parts.push(`（他的群昵称是「${observed}」，有人教过叫「${taught}」—— 用教过的那个）`);
    } else if (!taught) {
      parts.push('（这是**我们看到过的群昵称**；如果这条消息里有人教了新名字，那就用新教的）');
    }
    parts.push('—— 而跟你说话的是另一个人。');
    return parts.join('');
  }

  /**
   * **这一轮的"事实"**(1.100.1 / D163):与"表达要求"(`turnNotes`)**分开**的两类东西。
   *
   * ⚠️ 为什么必须分开(用户实测的现场):
   *   「绑定完没什么用,我在网站上说了我是防火门,到 QQ 就不知道了」。
   *   查下来:身份那句**生成是对的**(日志与活库都对得上),但它跟身体状态、好感一起
   *   被塞进了 `withStyleNudge` 那个**「（本次表达要求，照做但不要念出来：）」**的块里 ——
   *   而那一条是"**怎么说话**"的块。于是"这一轮跟你说话的人是网页上的某某"
   *   被当成一条**措辞要求**处理,她自然不会拿它回话。
   *
   * 📌 教训:**事实与要求不能同居一栏**。要求是"照做别说",事实是"知道、要用就用" ——
   *    两句话的语气与位置都不一样,混在一起时,模型只会听**块标题**那句。
   *
   * @param {object|null} message 这一轮的入站消息(要 `scene` 与 `senderId`/`targetId`)
   * @returns {string[]} 事实(没有就是空数组)
   */
  function turnFacts(message) {
    const facts = [];
    const identity = identityNoteFor(message);
    if (identity) facts.push(identity);
    // ⚠️ 角色那句与身份那句**都在事实里**:一句说"你是谁",一句说"你演的是谁"
    const character = characterNoteFor(message);
    if (character) facts.push(character);
    // 这一轮 @ 了谁(不在转述里,所以必须显式说)
    const mention = mentionNoteFor(message);
    if (mention) facts.push(mention);
    // @ 到的那个人叫什么(名册:现成的 `person.display` + 有人教过的 `name` 事实)
    const roster = mentionedRosterNote(message);
    if (roster) facts.push(roster);
    // 「关于人的事实」(名字/关系/偏好……)也走事实那一栏 —— 它们是"知道就行",不是"怎么说话"
    const known = factsNote(message);
    if (known) facts.push(known);
    return facts;
  }

  /**
   * 把事实贴在**消息旁边**(不是贴在"表达要求"里)。
   * ⚠️ 实现搬到了 `src\style.js` 的 `withFacts()` —— 那里是**能单测的纯函数**
   *    (它有一条判据钉着"事实必须在表达要求**之外**",见 D163)。
   */
  const withTurnFacts = (text, facts) => withFacts(text, facts);

  /**
   * **这一轮要不要念复制粘贴梗**(2026-10-14,用户委派)。
   *
   * 判据/挑梗/两块文案全在 `src\copypasta.js`(纯函数,`scripts\selftest-copypasta.js` 钉着)——
   * 这里只做两件事:把这一轮的原话喂进去、命中时留一行日志(真跑验证靠它)。
   *
   * ⚠️ 两块必须分栏(D163):**原文进"事实"、要求进"表达要求"** ——
   *    原文塞进「照做但不要念出来」那一栏是自相矛盾(她就真不念了)。
   *
   * @param {object|null} message 这一轮的入站消息
   * @returns {{entry: object, fact: string, note: string}|null}
   */
  function copypastaFor(message) {
    // 严肃话题(重病/去世/灾难,D80)一律不念梗 —— 花活收敛那一条同样管这里。
    const policy = turnPolicyFor(message?.content ?? '', { enabled: config.policy.seriousGuard });
    if (policy.suppressMood) return null;
    const hit = copypastaTurn(copypasta, message?.content ?? '');
    if (hit) log.info(`[梗库] 这一轮念梗：${hit.entry.id}（${hit.entry.chars} 字·${hit.entry.title}）`);
    return hit;
  }

  /**
   * **硬超时**(2026-10-03):给任何"可能挂住"的 await 套一层。
   *
   * 现场:tick 里的模型调用/发消息**卡住过一次** —— 日志整整 13 分钟没有新行,
   * 而进程还活着(pid 在,`/收杆` 也做不下去)。setInterval 会继续触发,
   * 但那一拍永远不结束,钓鱼状态就停在那儿("**收杆卡住**")。
   * 所以凡是 tick 里要等的对外调用,都用它包一层:到点就放行,拿兜底值继续。
   * ⚠️ 底层 Promise 不会因此取消(它可能还在网络栈里),但**不再拖住这一拍**。
   */
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      Promise.resolve(promise).catch((err) => {
        log.warn(`超时包装里的调用失败（用兜底）: ${describeError(err)}`);
        return fallback;
      }),
      new Promise((resolve) => setTimeout(() => {
        log.warn(`一次对外调用超过 ${Math.round(ms / 1000)} 秒还没回来，先放行（用兜底）`);
        resolve(fallback);
      }, ms).unref?.()),
    ]);
  }

  /**
   * **让模型写钓鱼的台词**(用户 2026-10-02:「每条播报的内容要**随机性更强,交给 llm 写**……
   * 「卖鱼结算不能每次都是一样的台词」「烤鱼吃等等太简单了,写点简短的过程和感受」)。
   *
   * ⚠️ 模型只写**过程与感受**,数值仍由代码给(提示词里明说不要报数字);
   *    模型超时/沉默就退回**兜底台词**(`buildFishingFlavorPrompt` 里的 `fallback`),
   *    所以这条链路挂掉时她也不会说空话。
   * ⚠️ 而且**整段都套了硬超时**(见 `withTimeout`)—— tick 里绝不允许被它拖死。
   */
  async function fishingFlavor(kind, ctx, message) {
    const { prompt, fallback } = buildFishingFlavorPrompt(kind, ctx);
    const text = await withTimeout((async () => {
      const conversationKey = sessionIdFor({ scene: message.scene, targetId: message.targetId });
      const turn = await runner.runTurn(conversationKey, prompt, Math.min(config.policy.replyTimeoutMs, 30_000));
      const composed = composeReply(turn, null, { hasImage: false });
      if (turn.timedOut || isSilentReply(composed) || composed === '') return fallback;
      return composed.slice(0, 300);
    })(), 40_000, fallback);
    return text ?? fallback;
  }

  /**
   * **钓鱼适配器**(D108)。实现搬到了 `src\fishing-adapter.js`(依赖注入的工厂),
   * 这里只负责**把端口接上** —— 库(`stateStore`)、发消息(`sendChunked`)、
   * 让模型写台词(`fishingFlavor`)、好感度(`readAffinity`/`affinityTier`)。
   *
   * ⚠️ 钓位键仍然是"**按人**"的:`fishing:<scene>:<targetId>:<userId>`
   *    (第一版按**会话**存,于是一个群只有**一个**钓位 —— 两个人同时钓,第二个人会把第一个人的竿顶掉)。
   *
   * ⚠️ 为什么值得抽这一层:1.65.0 的两处真回归(**先落盘再问模型**、自动收杆丢了一条消息)
   *    都在这里,而当时它是 `main()` 里的闭包 —— 单测碰不到,是靠复核者读 diff 抓到的。
   *    现在这些顺序由 `scripts\selftest-fishing-adapter.js` 用假端口钉住。
   */
  const fishing = createFishingAdapter({
    store: stateStore,
    config: {
      appId: config.qq.appId,
      currency: CURRENCY.name,
      sleep: config.policy.warmup.sleep,
      readAffinityScore: (message) => readAffinity(message)?.score ?? 0,
      affinityTier,
    },
    log,
    send: (message, text) => sendChunked(message, text),
    flavor: (kind, ctx, message) => fishingFlavor(kind, ctx, message),
  });

  /** 读她的钓位(提示词注入"她知道自己在水边"要用)。 */
  function readFishing(message) {
    return fishing.read(message);
  }

  /**
   * **面板那一句**(D111 第④步):QQ 是轻量渠道 —— 有人问进度时,她该说"详情看面板"。
   *
   * ⚠️ 三条刻意:
   *   ① **面板没开就不提**(`QQBOT_PANEL=false` 时提一个打不开的地址是骗人);
   *   ② **只在有用时注入**(她在钓 / 面板上刚做过事)—— 每轮都念就成广告了;
   *   ③ **不许她念 URL 之外的东西**:这里给的是"往哪个方向说",不是台词。
   */
  function panelPromptNote(message) {
    if (!config.policy.panel?.enabled) return null;
    // ⚠️ **现读隧道状态**(D121):临时隧道换了网址,她念出来的那一句要跟着走 ——
    //    否则她会把一个已经打不开的地址告诉群里(那比不提更糟)。
    const url = readTunnelState(ROOT_DIR)?.url ?? config.policy.panel.publicUrl;
    if (!url) return null;
    const lines = [];
    const state = message ? readFishing(message) : null;
    if (state) {
      lines.push(`（她这一局钓鱼的**详情**在一个网页面板上：${url} —— 有人问"钓到几条了/还要等多久"之类的，就让他去那儿看一眼，别自己报数字。）`);
    }
    // ⚠️ 通知**按时间过期**(而不是"读一次就清"):同一条最多在这 10 分钟里被提到,
    //    之后自己消失 —— 不需要"谁读过了"的标记,也就不会因为重启而漏报或重复报。
    const notices = message ? readPanelNotices(stateStore, fishing.keyFor(message)) : [];
    const said = panelNoticesToLines(notices, { limit: 2, now: Date.now() });
    if (said.length > 0) {
      lines.push(`（她**刚在面板上**做过这些：${said.join('；')} —— 有人问起就照实说。）`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  // -------------------------------------------------------------------------
  // 好感度(D104 第①批)+ 疾病接线(D103 的后续)
  // -------------------------------------------------------------------------

  /** 好感按**人**存(私聊/群聊都用对方的 openid 当键)。 */
  function affinityKeyFor(message) {
    return `affinity:${message.senderId ?? 'unknown'}`;
  }

  function readAffinity(message) {
    try {
      const raw = stateStore.getMeta(affinityKeyFor(message));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /**
   * 给"这个人"加一笔好感。**每人每天有上限**(`AFFINITY_DAILY_CAP`)——
   * 刷屏刷不出"交心",这是用户最反感的那种数值(见 D104)。
   */
  function bumpAffinity(message, kind, detail = '') {
    if (!message?.senderId) return null;
    try {
      const before = readAffinity(message);
      const { record, delta, tier, promoted } = applyAffinity(before, { kind, now: Date.now(), detail });
      const stored = { ...record, name: message.senderName ?? before?.name ?? null };
      stateStore.setMeta(affinityKeyFor(message), JSON.stringify(stored));
      if (promoted) {
        log.info(`好感度：${stored.name ?? message.senderId} → ${tier.label}（${kind}${detail ? `/${detail}` : ''}）`);
      }
      return { record: stored, delta, tier, promoted };
    } catch (err) {
      log.warn(`好感度记账失败（不影响这一轮）: ${describeError(err)}`);
      return null;
    }
  }

  /** 这一轮对**说话的人**的好感档位(进提示词;只说档位不说分)。 */
  function affinityNote(message) {
    if (!message?.senderId) return null;
    const record = readAffinity(message);
    if (!record) return null;
    return describeAffinity(record, message.senderName ?? '对方');
  }

  // ---- 疾病 ----

  /** 她的病**是全局一份**(不是每个会话一份):她只有一具身体。 */
  const CONDITION_KEY = 'condition:active';

  function readCondition() {
    try {
      const raw = stateStore.getMeta(CONDITION_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.id ? parsed : null;
    } catch { return null; }
  }

  function writeCondition(condition) {
    try {
      stateStore.setMeta(CONDITION_KEY, condition ? JSON.stringify(condition) : '');
    } catch (err) {
      log.warn(`写病态失败: ${describeError(err)}`);
    }
  }

  /** 各种病因**得病的概率** —— 不是"一淋雨就感冒",是"淋了雨有几率"。 */
  const ILLNESS_CHANCE = {
    commission: 0.25,
    food: 0.35,
    explosion: 0.1,
    adventure: 0.15,
    weather: 0.08,
    random: 0.02,
  };

  /** **按病因掷一次"会不会病"**。已经有病就不叠加(一次一个病)。 */
  function tryCatchIllness(cause, note = '') {
    // ⚠️ P4(2026-10-28):病程是"人类身体"的玩法,机械体实例关掉
    //    (QQBOT_STATS_ILLNESS=0)—— 单点闸在这里,随机/坏食物/委托三条路一起管住。
    if (config.policy.stats.illness === false) return null;
    if (readCondition()) return null;
    const chance = ILLNESS_CHANCE[cause] ?? 0.05;
    if (Math.random() >= chance) return null;
    const condition = catchDisease({ cause, now: Date.now() });
    writeCondition(condition);
    log.info(
      `染病：${condition.name}（${DISEASE_CAUSES[cause] ?? cause}${note ? `/${note}` : ''}）` +
      `→ 大概 ${Math.round((condition.endsAt - Date.now()) / 3_600_000)} 小时`,
    );
    return condition;
  }

  /** 请求治疗的**诊金**(沿用用户样板里的 10000 货币单位)。 */
  const AQUA_FEE = 10_000;

  /** 本地内容所用的治疗者称呼触发语。 */
  const AQUA_PATTERNS = HEALER_PATTERNS;

  /** **请求治疗**:收诊金、成败按病种掷,失败是"帮倒忙"(心情掉)。 */
  async function seekAquaCure(message, condition) {
    const result = seekAqua(condition, Math.random);
    try {
      stateStore.applyStoryResult(
        { money: -AQUA_FEE, mood: result.moodDelta },
        Date.now(),
        { kind: 'heal', disease: condition.name, ok: result.ok },
        { sleep: config.policy.warmup.sleep },
      );
    } catch (err) {
      log.warn(`${INFRA_CONTENT.healerName}治疗的结算失败: ${describeError(err)}`);
    }
    if (result.ok) writeCondition({ ...condition, treated: true });
    const feeLine = `（诊金 ${AQUA_FEE} ${CURRENCY.name}）`;
    await sendChunked(message, `${result.line}${feeLine}`);
    log.info(`求${INFRA_CONTENT.healerName}：${condition.name} → ${result.ok ? '治好' : '帮倒忙'}${feeLine}`);
    return true;
  }

  /** 病程与自愈(挂在 30 秒那一拍上):病着的时候**健康按时往下掉**。 */
  async function illnessTick() {
    // ⚠️ P4:关掉病程的实例(机械体)连"到期病好"都不用跑 —— 没有病可走。
    if (config.policy.stats.illness === false) return;
    const condition = readCondition();
    if (!condition) return;
    const now = Date.now();
    const last = Number(condition.lastTickAt) || condition.startedAt;
    const hours = Math.max(0, (now - last) / 3_600_000);
    if (hours > 0.01) {
      const drain = Math.round(condition.drainPerHour * hours * 10) / 10;
      try {
        stateStore.applyStoryResult(
          { health: -drain },
          now,
          { kind: 'illness', disease: condition.name },
          { sleep: config.policy.warmup.sleep },
        );
      } catch (err) {
        log.warn(`病程扣健康失败: ${describeError(err)}`);
      }
      writeCondition({ ...condition, lastTickAt: now });
    }
    if (condition.treated || now >= condition.endsAt) {
      writeCondition(null);
      log.info(`病好了：${condition.name}（${condition.treated ? `${INFRA_CONTENT.healerName}治的` : '自己扛过来的'}）`);
      return;
    }
    // 随机生病(很小):"自己也说不清为什么"
    if (hours >= 0.5) tryCatchIllness('random');
  }

  /**
   * 「**喂了不能吃的东西**」的判据(D103 用户点名的第二种人为病因)。
   * 判在**物品名字**上,不判在"谁喂的"上 —— 喂正常东西不该闹肚子。
   */
  const BAD_FOOD_RE = /(发霉|过期|变质|馊|奇怪|不明|来路不明|黑暗料理|生的|半生|不能吃|毒|臭|剩了好几天)/;

  /** 面板存在 `meta` 里 —— 键要**按会话**分(免得 A 群挑的活算到 B 群头上)。 */
  function questBoardKeyFor(message) {
    return `quest_board:${storyKeyFor(message)}`;
  }

  /**
   * `/接 N`:把面板上第 N 条**真的接下来** —— 报酬进钱、体力往下掉,并记一笔 `kind='quest'`。
   *
   * ⚠️ 三条边界:① 面板过期(6 小时)就说清"看板换了",不猜;② 序号不存在就说清;
   * ③ 结算走 `applyStoryResult`(有封顶、有流水),**不是**直接把数字写进回复。
   */
  async function takeQuest(message, index) {
    if (!config.policy.economy?.enabled) {
      await sendChunked(message, '（经济系统关闭中）');
      return;
    }
    const key = questBoardKeyFor(message);
    let parsed = null;
    try {
      const saved = stateStore.getMeta(key);
      parsed = saved ? (() => { try { return JSON.parse(saved); } catch { return null; } })() : null;
    } catch (err) {
      log.warn(`读委托面板失败: ${describeError(err)}`);
    }
    let todayRows = [];
    try {
      todayRows = stateStore.recentStatsEvents(200);
    } catch (err) {
      log.warn(`读"今天接过几条委托"失败（按没接过处理）: ${describeError(err)}`);
    }

    // ⚠️ **判定与结账都在 `src\quest-take.js`**(1.86.0):网页上那个「接取」按钮调的是**同一份** ——
    //    否则"网页上能刷、QQ 里不能"这种偏差不会报错,只会让人以为其中一边坏了(D141)。
    //    这里只负责**把话说得像 QQ**:同一件事,两个渠道的提示语各自合口味。
    const pick = pickQuestTake({ board: parsed?.board, at: parsed?.at, index, todayRows, now: Date.now() });
    if (!pick.ok) {
      const body = {
        board_empty: '（看板上没有正在挑的活 —— 先回 `/委托` 看一眼？）',
        board_stale: '（那块看板已经撤了（超过 6 小时）—— 回 `/委托` 再看一眼。）',
        bad_index: `（看板上只有 ${pick.total} 条 —— 回 1 到 ${pick.total} 之间的数。）`,
        quest_cooldown: `（刚接过一条 —— 先歇 ${Math.ceil((pick.leftMs ?? 0) / 60_000)} 分钟，腿还酸着呢。）`,
        quest_daily_cap: `（今天已经接过 ${pick.count} 条了 —— 公会也没那么多活，明天再来。）`,
      }[pick.reason] ?? '（这条活没接成。）';
      await sendChunked(message, body);
      return;
    }

    try {
      const applied = applyQuestTake({
        store: stateStore,
        key,
        board: parsed.board,
        at: parsed.at,
        index,
        now: Date.now(),
        sleep: config.policy.warmup.sleep,
      });
      const delta = renderStatDeltas([applied.event], { theme: getBodyTheme(config.policy.stats.theme) });
      // 回执由**代码**拼(挑活是操作,不是闲聊):报的是"实际"变化,不是面板上那个数。
      await sendChunked(
        message,
        describeQuestTake({
          row: applied.row,
          paid: applied.paid,
          staminaDelta: applied.staminaDelta,
          currency: CURRENCY.name,
        }) + (delta ? `\n${delta}` : ''),
      );
      log.info(
        `委托面板：接了第 ${applied.row.index} 条（${applied.row.tier}）→ ${CURRENCY.name} ${Math.round(applied.stats.money)}、` +
        `体力 ${Math.round(applied.stats.stamina)}`,
      );
      // **做委托会淋雨吹风**(D103 接线,用户点名的第一种人为病因:「做委托感冒了」):
      // 危险委托/看着不对劲的活更容易病。⚠️ 面板那条路走的是**同一段**(见 createActionExec 的 onQuestTaken)。
      tryCatchIllness('commission', applied.row.tier);
    } catch (err) {
      log.warn(`接委托结算失败: ${describeError(err)}`);
      await sendChunked(message, '（这条活没接成 —— 状态库出问题了，下一轮再说。）');
    }
  }

  /**
   * **用户主动的互动事件**(D101 形态一):「陪我去逛街」「一起睡」这类邀约。
   *
   * 与"被投喂"同一条规矩:**关键词判据在代码里**(要稳定复现的行为不许靠提示词许愿),
   * 数值也在这里(每档带冷却)。这一轮"你俩在做什么"由 `turnNotes` 注入 ——
   * 光加数值不够,还得让她**演出来**。
   *
   * ⚠️ **一起吃饭故意不在这张表里**:那条已经有更强的实现(`detectFeeding` + 免单 + 饱食/体力),
   *    这里再写一遍就会双重结算。
   * ⚠️ 冷却用**内存里的 Map**(和"戳一戳"那道冷却同一个待遇):重启会忘。
   *    可以接受 —— 它防的是"同一句话连发刷数值",而不是账本准确性。
   */
  const lastCompanyAt = new Map();
  function settleCompany(message) {
    const activity = detectCompany(message?.content ?? '');
    if (!activity) return;
    if (!config.policy.stats.enabled) return;
    const now = Date.now();
    const since = lastCompanyAt.get(activity.id) ?? 0;
    if (now - since < activity.cooldownMs) {
      log.info(
        `陪她做事：${activity.label} 还在冷却（还差 ${Math.ceil((activity.cooldownMs - (now - since)) / 60_000)} 分钟），这次不加数值`,
      );
      return;
    }
    lastCompanyAt.set(activity.id, now);
    try {
      const { stats, event } = stateStore.applyStoryResult(
        activity.effect,
        now,
        { kind: 'company', activityId: activity.id, label: activity.label, line: activity.line },
        { sleep: config.policy.warmup.sleep },
      );
      recordStatDeltas(event);
      log.info(
        `陪她做事：${activity.label} → ${CURRENCY.name} ${Math.round(stats.money)}、` +
        `心情 ${Math.round(stats.mood)}、体力 ${Math.round(stats.stamina)}`,
      );
    } catch (err) {
      log.warn(`陪她做事的结算失败（不影响这一轮对话）: ${describeError(err)}`);
    }
    pendingCompany = activity;
  }

  /**
   * 这一轮"你俩在做什么"要注入的提示(D101)。和 `feedingNote` 同一族:
   * **点破这一轮在干什么 + 给演的方向**,数值不归她管。
   */
  function companyTurnNote() {
    return pendingCompany ? companyNote({ activity: pendingCompany }) : null;
  }

  /**
   * 从模型回复里取出进食信息,结算数值,并把那段标记**从要发出去的正文里去掉**。
   *
   * ⚠️ **2026-10-02(D96)重写过判据** —— 用户报「被投喂/请吃饭经常不加饱食度」,
   * 量出来的现场是 **79 个带图回合只有 8 个(10.1%)结算了数值**。旧写法把判据押在模型身上
   * (只有模型自己写 `<intake>` 或用户那句话命中食物名词表才结算),于是"我请你吃饭""给你点了外卖"
   * 和"只发一张图不说话"这两类最常见的投喂**一条都对不上**。
   *
   * 现在**三件事分开**:
   *   ① 选哪份进食数据 = `resolveIntake()`(**纯函数、单测覆盖**)——
   *      模型给了有效热量就用它的(它真看过图),否则由代码按
   *      食物名词 / 投喂说法 / 带图 兜底一顿 —— **这一条保证投喂 100% 有数值**;
   *   ② 这里只负责"落库 + 记增量 + 打日志";
   *   ③ `hasImage` 由调用方传**这一轮真的喂进模型的图**(不是"触发那条消息带没带图"),
   *      所以"窗内补图"那条路也算投喂。
   *
   * @param {string} rawText 模型这一轮的原始回复(可能带 `<intake …/>`)
   * @param {object|null} message 触发这一轮的消息(正文用于判投喂)
   * @param {{hasImage?: boolean}} [options]
   */
  function settleIntake(rawText, message, { hasImage = null } = {}) {
    if (!config.policy.stats.enabled) return rawText;
    const { intake, text: strippedText } = extractIntake(rawText);
    let text = strippedText;
    // ⚠️ 模型明确写 `<intake reject/>` = "图里不是吃的"(2026-10-09,见 `resolveIntake`)。
    const modelSaysNotFood = rejectsIntake(rawText);
    const imagesPresent = hasImage ?? (message?.images?.length ?? 0) > 0;
    const resolved = resolveIntake({
      modelIntake: intake,
      text: message?.content ?? '',
      hasImage: imagesPresent,
      modelSaysNotFood,
      theme: getBodyTheme(config.policy.stats.theme),
    });
    if (!resolved) {
      // 模型写了进食块但这一轮不像吃喝 —— 标记已经在 `extractIntake` 里剥掉了,
      // 这里只留一行 warn,免得"她说了吃了但数值没动"事后查不出来。
      if (intake) log.warn(`提到了进食数据但这一轮不像在吃东西（图片=${imagesPresent}），已忽略并剥离`);
      // 否决那一笔单独说清楚:否则事后查"为什么这次没加饱食"看不到原因。
      if (modelSaysNotFood && imagesPresent) log.info('带图回合被模型否决：这一轮不当成投喂（判定：图里不是吃的）');
      return text;
    }

    const effective = resolved.intake;
    const source = resolved.source;
    try {
      const { stats, event, fedEvent } = stateStore.applyIntake({ ...effective, source }, Date.now(), {
        sleep: config.policy.warmup.sleep,
      });
      // ⚠️ **两笔都要记进"这一轮的增量"**:`event` 是这一顿饭本身,`fedEvent` 是"被投喂"那笔
      //    (心情/体力, **D99 起不含钱**)。只记前者的话,那一轮的回复末尾会少一截 ——
      //    而用户看的正是那行 `[…]`(D87/D97)。
      //    ⚠️ 同时也要看得见**饭钱**(自己吃的那顿是负的) —— 两笔合起来才是这一轮的全貌。
      recordStatDeltas(event);
      recordStatDeltas(fedEvent);
      log.info(
        `进食：${effective.food ?? '未知'} ${effective.kcal ?? '?'}kcal` +
        `（${source}${effective.paidBy === 'other' ? '，别人请的：免单' : '，她自己付钱'}）→ ` +
        `饱食 ${Math.round(stats.satiety)}（+${event.satietyDelta.toFixed(1)}）、` +
        `健康 ${Math.round(stats.health)}、心情 ${Math.round(stats.mood)}`,
      );
      // **喂了不能吃的东西会闹肚子**(D103 接线,用户点名的第二种人为病因)。
      // 判据在**物品名字**上:发霉/过期/奇怪/不明/黑暗料理/生的/变质 之类。
      const fedName = String(effective.food ?? rawText ?? '');
      if (effective.paidBy === 'other' && BAD_FOOD_RE.test(fedName)) {
        tryCatchIllness('food', fedName.slice(0, 12));
      }
      // **被投喂**算一笔好感(比普通说话重)
      if (effective.paidBy === 'other') bumpAffinity(message, 'fed', '投喂');
      // ⚠️⚠️ **2026-10-09 用户报的现场**:`22:43:38 meal 饱食+12` / `22:43:58 meal 饱食+12`
      //    (自发接话那两轮,窗内补进的图被当成投喂)—— 而她那两轮**一个字都没说吃**,
      //    于是用户在群里问:「**饱食度？你哪儿来的饭——说清楚**」。
      //    当时的规矩是"数值动了,话里就得看得见";**2026-10-23 主人拍板收窄**:
      //    只在认得出有名有姓的食物时补一行(判据在纯函数 `narrateMeal()` 里,可单测),
      //    万能句"嘴里还在嚼东西"退役 —— 数值可见性闲置期由 `/状态` 与网页面板兜底。
      const told = narrateMeal(text, { food: effective.food, satietyDelta: event?.satietyDelta });
      if (told !== text) {
        text = told;
        log.info(`她没说吃，替她补了一句动作行（${effective.food ?? '未知'}，饱食 +${Number(event?.satietyDelta ?? 0).toFixed(1)}）`);
      }
    } catch (err) {
      log.error('进食结算失败', err);
    }
    return text;
  }

  /**
   * **普通发言该发几条短句**(1.106.2 / D174 起家;1.171.0 / D288 起**普及到所有普通口头发言**)。
   *
   * 用户 2026-10-10 的现场:她自己冒泡写了两句(64 字),`truncateForMood()` 按情绪上限
   * 砍到 28 字 —— 群里只看到第一句「刚才在街上,又被某个组织的人拦下来说"入教就送面包"。」,
   * 后面那句**根本没发出去**。用户的要求是「**形式跟咏唱咏唱技能一样分别一条条发**」。
   *
   * ⚠️ **2026-10-21(D288)口径变更:答话不再整条**。旧注释里"答话不分段"(D171/D174)
   *    的理由是"说一半"事故 —— 但那笔账是**截断**欠的,分段本身一个字不丢;
   *    现在 `splitSpokenLines()` 有链接保护/防碎段/口语标点清理,答话、合并回答、
   *    早安、自发、网页聊天**全走这一份规划**,不再按"有没有人跟她说话"分叉
   *    (旧 `addressed` 参数退役 —— 判断只剩一处,就是 `config.policy.spoken.enabled`)。
   *
   * 每段不超过 `decision.maxChars`(没有决策用 `spoken.maxChars`;切不动就整句照发,
   * **一个字不丢**),段数上限借用平台那个"一条入站消息最多 5 条"(`MAX_PASSIVE_SEQ`)。
   *
   * @param {string} text
   * @param {object|null} decision 情绪决策(`maxChars` 在这里面;可空)
   * @param {{label?: string, preserveFormatting?: boolean}} [options]
   *   `label` = 日志前缀;`preserveFormatting` = **任务/知识口径(P1)**:整条原样交付,
   *   不做口语分句与标点清理 —— 代码缩进、JSON 冒号、命令分号必须留着
   *   (长文由 `sendChunked` 按平台上限切块,那是传输,不改语法)。
   * @returns {string[]} 每一段单独发一条消息
   */
  function planSpokenLines(text, decision, { label = '发言', preserveFormatting = false } = {}) {
    if (!config.policy.spoken.enabled) return [text];
    if (preserveFormatting) {
      // **P2 任务轮交付**:按**整行**预分组(与出站 chunkText 同一个上限,D159)——
      // 边界只落在原本的换行上,代码缩进/JSON/命令一个字符不动;
      // 条数超被动槽由 sendSpokenLines 既有的"超限转主动"(D289)兜底。
      const whole = String(text ?? '');
      const groups = groupLinesForDelivery(whole, config.policy.maxChars);
      if (groups.length > 1 || whole.length > config.policy.spoken.maxChars) {
        log.info(`${label}：任务口径，整行分组保真交付（${whole.length} 字 → ${groups.length} 条，每条上限 ${config.policy.maxChars}）`);
      }
      return groups;
    }
    const maxChars = Number(decision?.maxChars) > 0 ? Number(decision.maxChars) : config.policy.spoken.maxChars;
    const lines = splitSpokenLines(text, {
      maxChars,
      maxLines: MAX_PASSIVE_SEQ,
    });
    if (lines.length > 1) {
      log.info(
        `${label}：按短句分 ${lines.length} 条发（${text.length} 字 → ` +
        `${lines.map((one) => one.length).join('+')}，每段上限 ${maxChars}）`,
      );
    } else if (text.length > maxChars) {
      log.info(
        `${label}：只有一句、切不动（${text.length} 字 > 每段上限 ${maxChars}）` +
        '—— 整句照发，不砍尾巴',
      );
    }
    // **emoji 单发**(1.171.2 / D290,用户拍板代码档):每轮一次掷骰,命中就在
    // 段间插一条 emoji(不在第一条之前 —— 真人节奏是"先说话再甩表情");
    // 与 kaomoji 各掷各的。概率【暂定】`QQBOT_SPOKEN_EMOJI_CHANCE`(默认 0.12),0 = 关。
    const emoji = maybeSpokenEmoji({
      chance: config.policy.spoken.emojiChance,
      recent: recentSpokenEmoji,
    });
    if (emoji !== null && lines.length > 0) {
      recentSpokenEmoji = [emoji, ...recentSpokenEmoji].slice(0, 3);
      const at = Math.min(1 + Math.floor(Math.random() * lines.length), lines.length);
      lines.splice(at, 0, emoji);
      log.info(`${label}：插一条 emoji 单发（第 ${at + 1}/${lines.length} 条）`);
    }
    return lines;
  }

  /**
   * **段间的自然间隔**(1.171.0 / D288):基础 + **待发那条**的字数项,±15% 抖动,
   * 夹在 [`spoken.minDelayMs`, `spoken.maxDelayMs`]。数值全部【暂定】。
   * 首条不等待(首响口径不变);只在 ≥2 条时被 `sendSpokenLines` 调用。
   */
  async function spokenLineGap(upcomingLine) {
    const spoken = config.policy.spoken;
    if (!(spoken.maxDelayMs > 0)) return;
    const raw = (spoken.baseDelayMs + spoken.perCharDelayMs * String(upcomingLine ?? '').length)
      * (0.85 + Math.random() * 0.3);
    // ⚠️ min/max 谁大谁小不较真(D289 复核):夹在 [min(min,max), max(min,max)] ——
    // 配反了也不炸,行为退化为"夹在同一个数附近"。
    const lo = Math.min(spoken.minDelayMs, spoken.maxDelayMs);
    const hi = Math.max(spoken.minDelayMs, spoken.maxDelayMs);
    const delay = Math.min(hi, Math.max(lo, raw));
    if (delay <= 0) return;
    await new Promise((resolve) => { setTimeout(resolve, delay); });
  }

  /**
   * 把 `planSpokenLines()` 的每段**一条条发出去**(1.106.2 / D174;1.171.0 / D288 重写;
   * 1.171.1 / D289 按对抗复核收口:被动预算封顶 + 逐段 try + 空段不占槽)。
   *
   * ⚠️ **被动回复的 `msg_seq` 要接着数**(D288 修的暗雷):以前每段都各调一次
   *    `sendChunked` 且不带 `startSeq`,于是每段的 `msgSeq` 都从 1 开始 ——
   *    主动消息不带 msg_id 感觉不到;答话接进来之后不接续就是全部撞在 seq=1 上。
   * ⚠️ **被动名额封顶 = `MAX_PASSIVE_SEQ`**(D289 复核抓到的边界):一段长文被
   *    `chunkText` 再切时总块数可能超过 5,seq=6 平台直接回 40034128(fatal,整段丢)。
   *    处理沿用咏唱技能的口径(D82/D86):**超出的块转主动消息**(吃配额,记 warn)——
   *    "六句全发"是用户定过的方向,发不全比吃配额更糟。
   * ⚠️ **逐段单独 try**(咏唱技能同一条纪律):一段失败不许拖垮后面的段;
   *    结尾有失败就记一条汇总 warn —— 不静默当成功,也不重发已成功的段。
   * ⚠️ 节拍:`spokenLineGap`(按待发那条长度算);`typing` 只抖**第一条**。
   * @returns {Promise<number>} 发出去几条
   */
  async function sendSpokenLines(message, lines, { typing = false } = {}) {
    const passive = message?.messageId !== undefined && message?.messageId !== null;
    let passiveSeq = 0;
    let sent = 0;
    let failed = 0;
    let warnedOverflow = false;
    for (const [index, line] of (lines ?? []).entries()) {
      if (index > 0) await spokenLineGap(line);
      // 被动名额用完 → 剩下的段转主动(咏唱技能 D86"六句全发"同款);首溢出记一次 warn
      const active = passive && passiveSeq >= MAX_PASSIVE_SEQ;
      if (active && !warnedOverflow) {
        warnedOverflow = true;
        log.warn(`发言分条超出被动回复上限（${MAX_PASSIVE_SEQ} 条），余下的改走主动消息（吃配额）`);
      }
      try {
        const used = await sendChunked(message, line, { typing: typing && index === 0, startSeq: passiveSeq, active });
        if (passive && !active) {
          // 整段被剥空时 `sendChunked` 返回 undefined —— 什么都没发,**不占** seq 槽位
          if (used !== undefined) passiveSeq += used;
        }
        sent += 1;
      } catch (err) {
        failed += 1;
        log.warn(`发言分条：第 ${index + 1}/${lines?.length ?? '?'} 段发送失败（继续发下一段）: ${describeError(err)}`);
      }
    }
    if (failed > 0) {
      log.warn(`发言分条：${failed}/${lines?.length ?? '?'} 段没发出去（已发的段不重发）`);
    }
    return sent;
  }

  /**
   * 「打字抖动」(2026-09-30):回复发出之前,先停一个随机时长。
   *
   * 为什么要它:实测她私聊的回复延迟中位只有 **1.1 秒**(群聊 1.3 秒)—— 用户的原话是
   * 「发多少回多少」。以前只有群聊"被叫到名字"那一条路有抖动(`QQBOT_KEYWORD_JITTER_MS`,
   * D53),`@` 与私聊都没有。这一版把它做成**所有回复**都过的一道闸。
   *
   * 参数是 `QQBOT_REPLY_JITTER_MS`(形如 `2000-6000`),两只各自写在 `.env` 里:
   * 主实例是手打的(慢一点),副实例是机器(快一点)。`off` = 回到秒回。
   *
   * ⚠️ 延迟会**叠加**在合并窗口与模型时间之上 —— 这是"像人"与"效率"之间
   * 用户明确选了前者的那一笔账(TODO 里那条:判据是先定目标区间,建议中位 3~6 秒)。
   *
   * @param {number} [length] 这条回复的字数(现在只写进日志,便于事后核对手感)
   */
  async function applyTypingJitter(length = 0) {
    const delay = rollTypingDelay(config.policy.replyJitterMs);
    if (delay <= 0) return;
    log.info(`打字抖动：${(delay / 1000).toFixed(1)}s 后发出（回复 ${length} 字）`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      // 不 unref:这一段是"等它"本身,不是可以随事件循环空掉的后台计时器 ——
      // unref 会让它在没有别的活时被跳过,于是抖动**随机地不生效**(那是静默失效)。
      void timer;
    });
  }

  /**
   * 出站**唯一的咽喉** —— 每一条回给 QQ 的消息都从这里走。
   *
   * @param {object} message
   * @param {string} text
   * @param {{typing?: boolean}} [options]
   *   `typing: true` = 这是一次**回复**(而不是即时通知),发出之前先掷一段"打字抖动"
   *   (2026-09-30)。见下面 `applyTypingJitter` 的理由。
   */
  async function sendChunked(message, text, { typing = false, startSeq = 0, active = false } = {}) {
    // Strip mentions and speaker labels before measuring, so an "@某人" prefix
    // cannot push a chunk over the limit or ping someone, and so a model-written
    // `【主实例】` never reaches QQ.
    // ⚠️ 这里**没有任何例外**(2026-10-02 实测:群消息里的 `<@!openid>` 不会变成提及)。
    // ⚠️ 1.167.4 / D273:模型偶尔把原生工具协议标记当正文吐出来(`<｜｜DSML｜｜…>`),
    //    `sanitizeOutgoingText()` 会剥掉它;这里额外**留一条 warn** —— 只剥不记的话,
    //    下一次群里再出现乱码,日志里查无可查(与 1.167.3「挡住时不记」同族)。
    const before = String(text ?? '');
    const leaked = hasLeakedControlMarkup(before);
    if (leaked) {
      const after = stripLeakedControlMarkup(before);
      log.warn(
        `出站剥掉了模型泄漏的协议标记（${before.length} → ${after.length} 字）` +
        '—— 整条只剩标记时这一条不发',
      );
    }
    const sanitized = sanitizeOutgoingText(before, { names: outgoingNameLabels() });
    // Then give a trailing kaomoji its own line when the current one is wide
    // enough that QQ would wrap it in half (see `breakBeforeKaomoji`).
    const cleaned = breakBeforeKaomoji(sanitized, { maxWidth: config.policy.style.kaomojiBreakWidth });
    if (cleaned === '') {
      log.warn('回复在剥离 @ / 名字前缀 / 泄漏的协议标记之后为空，已跳过发送');
      return;
    }

    const chunks = chunkText(cleaned, config.policy.maxChars);
    if (chunks.length > 5) log.warn(`回复被切成 ${chunks.length} 条，考虑调大 QQBOT_MAX_CHARS`);

    // 「打字抖动」放在**这里**(而不是模型调用之前)是有判据的:模型那段实测本来就
    // 要 1.9s(中位),等它答完再按消息长度抖,才是"人在打字"的形状 ——
    // 在模型之前抖,总延迟一样,但"抖完立刻吐出一整段"反而不像人。
    // 只抖一次(整条回复的头一块),不按分段累加:切成 3 条还各抖一次会明显发木。
    if (typing) await applyTypingJitter(cleaned.length);

    let lastKind = 'active'; // 最后一条实际发出的形态(passiveExpired 会中途转 active)
    for (const [index, chunk] of chunks.entries()) {
      const send = message.scene === 'c2c'
        ? (target, payload) => api.sendDirect(target, payload)
        : (target, payload) => api.sendGroup(target, payload);
      // ⚠️ 1.106.3(D175):**出站留痕**就挂在这个唯一咽喉上 —— 记的是"真的发出去的"那一条,
      //    因为 transcript 与 memory.db 存的都是 `planSpokenLines()` 之前的模型原文
      //    (2026-10-10 现场:64 字被砍成 28 字,只看 transcript 的人会以为整段都发了)。
      let sentKind = active || message.messageId === undefined ? 'active' : 'passive';
      try {
        // A passive reply (msg_id + msg_seq) is exempt from active-message quotas.
        // `startSeq` 让"一句话分几条发"能接着数下去 —— 咏唱技能的"咏唱 + 结束词
        // 分多条消息"就是靠它(D82):同一个 msg_id 下 msg_seq 1..5 是允许的。
        // ⚠️ `active: true` = **不带 msg_id 的主动消息**(吃每月配额):只在
        //    被动回复的 5 条用完之后才用(D86:"六句全发")。
        await send(message.targetId, active
          ? { content: chunk }
          : { content: chunk, msgId: message.messageId, msgSeq: startSeq + index + 1 });
      } catch (err) {
        if (err.passiveExpired) {
          log.warn(`被动回复窗口已失效（code=${err.code}），改用主动消息`);
          sentKind = 'active';
          await send(message.targetId, { content: chunk });
        } else {
          throw err;
        }
      }
      lastKind = sentKind;
      try {
        stateStore.recordOutbound({
          at: Date.now(),
          scene: message.scene,
          target: message.targetId,
          kind: sentKind,
          text: chunk,
        });
      } catch (err) {
        // 留痕失败**不许影响发送** —— 它是"看得见"那一层,和位置事实同一条纪律。
        log.warn(`出站留痕失败（不影响这条消息）: ${describeError(err)}`);
      }
    }

    // Recorded here, at the single choke point every outbound message passes
    // through, so a caller cannot forget it. The warm-up gap gate reads it.
    if (message.scene === 'group') lastBotUtteranceAt.set(message.targetId, Date.now());
    // R3(1.198.0,主人拍板):**成功发送也要在日志里看得见** —— recordOutbound 只进库不打
    // console,排查「回话到底发没发出去」时缺指纹(1.197.0 现场:「没登记」回话有没有发出去
    // 只能靠对照项推断)。一行咽喉留痕;答话路径的「已回复会话」是业务语义,二者不冲突。
    log.info(`出站：已发 ${chunks.length} 条（${cleaned.length} 字，${lastKind}）→ ${String(message.targetId ?? '').slice(0, 8)}`);
    // 发出去了几条 —— 调用方要接着数 `msgSeq`(咏唱技能:咏唱之后那条"Explosion！！！",D82)。
    return chunks.length;
  }

  /**
   * **释放咏唱技能**(2026-10-01,见 `docs\03` D82)。
   *
   * 形状就是用户要的那个节拍:
   *   ① 先发**咏唱词**(从固定库里挑一版,长短不同 —— 绝不让模型即兴改词);
   *   ② 隔一小会儿,**再发一条新消息**:`Explosion！！！`(结束词也带几种写法/颜文字)。
   *
   * 冷却、去重(不连着放同一版)都在这里管;**不开模型** —— 这是桥的固定节目。
   */
  async function releaseExplosion(message) {
    const key = conversationKeyFor(message);
    const now = Date.now();
    const last = explosionCooldown.get(key) ?? 0;
    if (now - last < config.policy.explosion.cooldownMs) {
      const wait = Math.ceil((config.policy.explosion.cooldownMs - (now - last)) / 1000);
      log.info(`${INFRA_CONTENT.skillName}：冷却中（还差 ${wait} 秒），这轮不放`);
      await sendChunked(message, `（……魔力还没回来。让我缓 ${wait} 秒,就 ${wait} 秒。）`);
      return true;
    }
    // ⚠️ **魔力不够就放不出来**(D83):这是"数值真的管用"的地方 ——
    // 否则"魔力 8/100"照样喊 Explosion,那两个数就只是摆设。
    const before = currentStats(now);
    if (Number(before.mana) < EXPLOSION_MANA_COST) {
      log.info(`${INFRA_CONTENT.skillName}：魔力不足（${Math.round(before.mana)}/${EXPLOSION_MANA_COST}），这轮不放`);
      await sendChunked(
        message,
        `（……魔力只剩下 ${Math.round(before.mana)}，一发要 ${EXPLOSION_MANA_COST}。` +
        '让我歇会儿——魔力和体力都是要还的。）',
      );
      return true;
    }
    const plan = buildExplosion({
      recentChants: explosionRecentChants.get(key) ?? [],
      recentFinishers: explosionRecentFinishers.get(key) ?? [],
      // ⚠️ 节拍数受**平台限制**:被动回复一条入站消息最多 5 条(`msg_seq` 1–5),
      //    而最后一条要留给"Explosion！！！" —— 所以咏唱最多 4 句。
      maxBeats: explosionBeatsMax(),
    });
    explosionCooldown.set(key, now);
    const remember = (map, value, keep = 3) => {
      const list = [value, ...(map.get(key) ?? [])].slice(0, keep);
      map.set(key, list);
    };
    remember(explosionRecentChants, plan.chantId);
    remember(explosionRecentFinishers, plan.finisher, 4);

    log.info(
      `${INFRA_CONTENT.skillName}：${message.scene === 'group' ? '群' : '私聊'} ${String(message.targetId).slice(0, 8)}… ｜ ` +
      `咏唱版本=${plan.chantId}（${plan.chantSource},${plan.length}）｜ ${plan.beats.length} 句 ｜ ` +
      `结束词=${plan.finisher.split('\n')[0]}`,
    );
    // 放完**真的掉数值**(体力 −20、魔力 −55):这就是"咏唱技能一天放不出第二发"的机制。
    // ⚠️ **数值先结算、再发送**:结束词后面要挂这一发的代价(`[体力-20 魔力-55]`)。
    // ⚠️ 先清空收集:这一轮前面还有"被搭话 +2 魔力",但那对读者没意义(D87)。
    turnStatDeltas = [];
    try {
      const { stats: after, event } = stateStore.applyInteraction('explosion', Date.now(), {
        sleep: config.policy.warmup.sleep,
      });
      recordStatDeltas(event);
      if (event) {
        log.info(
          `${INFRA_CONTENT.skillName}的代价：体力${event.staminaDelta} → ${Math.round(after.stamina)}、` +
          `魔力${event.manaDelta} → ${Math.round(after.mana)}（自然回复 5/小时）`,
        );
      }
    } catch (err) {
      log.warn(`${INFRA_CONTENT.skillName}的数值结算失败（不影响这次释放）: ${describeError(err)}`);
    }
    // 结束词后面挂上**这一发的代价**(`[体力-20 魔力-55]`)—— 也是用户要的那行(D87)。
    // ⚠️ 取值必须在**发送之前**:下面那串分段一旦开始发,增量就被消费掉了。
    const costLine = statDeltaLine();
    turnStatDeltas = [];
    // ⚠️ **一句一条消息,间隔 1 秒**(用户 2026-10-01 要的仪式感)。
    //
    // ⚠️ **被动回复的名额要留给结束词**(2026-10-01 现场,用户问"为啥有一次没放出来"):
    //    被动回复(`msg_id` + `msg_seq`)一条入站消息**最多 5 条**(序号 1–5)。
    //    之前的写法是"按顺序数下去",于是六句咏唱时**第 6 条用了 msg_seq=6** ——
    //    平台回 `40034128 回复消息失败,被动回复时间或者次数超过限制`,
    //    **那条结束词(整个包袱)就没了**,而且异常还成了未处理的 Promise 拒绝。
    //    现在:前 4 条咏唱走被动,**结束词固定占第 5 个被动名额**(它最要紧、也最省);
    //    咏唱多出来的句子走主动消息(吃配额)。**每一段单独 try**,一段失败不影响下一段。
    const interval = config.policy.explosion.delayMs;
    const beatsMaxPassive = Math.max(0, MAX_PASSIVE_SEQ - 1);
    const finisherText = [plan.finisher, costLine].filter(Boolean).join('\n');
    const segments = [
      ...plan.beats.map((beat, index) => ({ text: beat, active: index >= beatsMaxPassive })),
      ...(finisherText ? [{ text: finisherText, active: false }] : []),
    ];
    let passiveSeq = 0;
    let activeUsed = 0;
    for (const [index, segment] of segments.entries()) {
      if (index > 0) await new Promise((resolve) => { setTimeout(resolve, interval); });
      try {
        const sent = await sendChunked(message, segment.text, { startSeq: passiveSeq, active: segment.active });
        if (segment.active) activeUsed += 1;
        else passiveSeq += sent ?? 1;
      } catch (err) {
        // ⚠️ **一段失败不许拖垮后面的段**:尤其是结束词 —— 那才是读者等着的那一下。
        log.warn(`${INFRA_CONTENT.skillName}：第 ${index + 1}/${segments.length} 段发送失败（继续发下一段）: ${describeError(err)}`);
      }
    }
    if (activeUsed > 0) {
      log.warn(
        `${INFRA_CONTENT.skillName}：有 ${activeUsed} 段超出被动回复上限（${MAX_PASSIVE_SEQ} 条），` +
        '已改用主动消息（**吃每月主动消息配额**；嫌费就把 QQBOT_EXPLOSION_BEATS_MAX 调回 4）',
      );
    }
    return true;
  }

  /**
   * 这一次要发几句咏唱。
   *
   * ⚠️ **平台限制**:被动回复(`msg_id` + `msg_seq`)一条入站消息**最多 5 条**,序号 1–5。
   * 用超的部分会改成**主动消息**(吃每月配额,见 `releaseExplosion` 的日志)。
   * 用户要"六句全发",所以主实例那只把 `QQBOT_EXPLOSION_BEATS_MAX` 设成 **6**。
   */
  function explosionBeatsMax() {
    return Math.max(1, config.policy.explosion.beatsMax);
  }

  /**
   * Settle the "did anyone answer the last warm-up?" verdict.
   *
   * Any group message counts as an answer — the point of warming a group is to
   * get it talking again, not to be addressed. Only groups with a warm-up still
   * awaiting a verdict do any work here.
   */
  function noteGroupEngagement(groupId) {
    const entry = warmupState.get(groupId);
    if (!entry || entry.awaitingSince === null || entry.awaitingSince === undefined) return;
    const settled = settleWarmupEngagement(entry, Date.now(), config.policy.warmup.engageWindowMs, { engaged: true });
    setWarmupEntry(groupId, settled);
    if ((entry.misses ?? 0) > 0) {
      const percent = Math.round(effectiveChance(config.policy.warmup.chance, 0, config.policy.warmup.minChance) * 100);
      log.info(`暖群：群 ${groupId} 有人接话了，命中概率恢复到 ${percent}%`);
    }
  }

  // ---------------------------------------------------------------------------
  // 搬运:私聊里收到的「聊天记录」→ 一个 PDF → 发白名单群(D60)
  // ---------------------------------------------------------------------------

  /** 配置只在第一次用到时解析一次;写错就 fail closed(什么都不搬)并留一条 error。 */
  let relayPolicy = null;
  let relayPolicyFailed = false;

  /**
   * 待确认的搬运(confirm 模式)+ 已发出的消息账本(撤回用)。
   *
   * ⚠️ 只在内存里:重启就丢(重启后 `/搬` 会说"没有待确认的搬运")—— 这是刻意的,
   * 打包好的 PDF 是**内容**,不往磁盘上落第二份副本。
   */
  let pendingRelay = null; // { seq, pdf, imageCount, textLines, text, targets, header, at }
  /**
   * 待确认的**编号**与"操作者最后看到的那条编号"。
   *
   * ⚠️ 为什么要编号(2026-09-29 现场):用户连发两条记录时,两条都会往操作者私聊发
   *    "待确认"的 PDF,而槽只有一个。带上编号之后,私聊里那两句话就能区分开 ——
   *    否则操作者手上拿着一份 PDF、回 `/搬`,却不知道会发出哪一条(现场真的分叉过)。
   */
  let relaySeq = 0;
  let relayShownSeq = null;
  const relaySent = []; // { groupId, messageId, at } —— `/撤回` 用,平台只给 2 分钟

  /** 搬运的控制命令(私聊、操作者):`/搬` `/不搬` `/撤回`。 */
  async function handleRelayCommand(message, relay, action) {
    if (!isOperator(message)) {
      log.info(`忽略非操作者的搬运指令：sender=${message.targetId}`);
      return;
    }
    const say = (text) => sendChunked(message, text).catch((err) => log.warn(`搬运：回复失败 ${describeError(err)}`));

    if (action === 'drop') {
      if (!pendingRelay) return say('（现在没有待确认的搬运。）');
      log.info(`搬运：操作者选择不发 #${pendingRelay.seq ?? '?'}（${pendingRelay.imageCount} 图）`);
      pendingRelay = null;
      relayShownSeq = null;
      return say('（好，这条不搬了。）');
    }

    if (action === 'recall') {
      const now = Date.now();
      const usable = relaySent.filter((item) => now - item.at < 120_000);
      if (usable.length === 0) {
        // ⚠️ 这条也要记:不然"点晚了"和"根本没发过"在日志里长得一模一样。
        //    撤回本身是**平台动作**,日志是它唯一的本地痕迹。
        if (relaySent.length > 0) {
          log.warn(`搬运：没有可撤回的 —— 已发出的 ${relaySent.length} 条都超过了平台的 120 秒撤回窗口（最早 ${Math.round((now - relaySent[0].at) / 1000)} 秒前）`);
        } else {
          log.warn('搬运：没有可撤回的 —— 本代会话还没有发过任何搬运（发出后 120 秒内才收得回）');
        }
        return say(
          `（没有可撤回的搬运 —— 平台规定发出超过 2 分钟不可撤回` +
          `${relaySent.length > 0 ? '，上一条已经超时' : ''}。）`,
        );
      }
      const done = [];
      for (const item of usable) {
        const seconds = Math.round((now - item.at) / 1000);
        try {
          await api.recallGroupMessage(item.groupId, item.messageId);
          // ⚠️ 成功**必须**留一行日志(2026-09-29 补):以前只有失败才写日志,于是
          //    "已验证撤回成功"这句话除了操作者私聊里那句会过期的话之外**没有凭据** ——
          //    这违反本项目"诊断工具不许说谎"那条(要能复核,不能只有结论)。
          //    这里只加可观测性,不改行为:撤回窗口(120 秒)与调用顺序都和以前一样。
          log.info(`搬运：已撤回 → 群 ${item.groupId.slice(0, 8)}…（发出后 ${seconds} 秒，平台窗口 120 秒）`);
          done.push(`群 ${item.groupId.slice(0, 8)}…（${seconds} 秒前）`);
        } catch (err) {
          log.error('搬运：撤回失败', err);
          done.push(`群 ${item.groupId.slice(0, 8)}… 撤回失败：${describeUserError(err)}`);
        }
      }
      return say(`（已撤回 ${done.length} 条：${done.join('；')}。）`);
    }

    // action === 'send'
    if (!pendingRelay) return say('（现在没有待确认的搬运。）');
    const task = pendingRelay;
    pendingRelay = null;
    relayShownSeq = null;
    log.info(`搬运：操作者确认 #${task.seq ?? '?'}（${task.imageCount} 图 / 目标 ${task.targets.length} 群）`);
    let sent = 0;
    // 文件名是**给群里的人看的**(下载时/文件卡片上就显示它)—— 用户 2026-09-29 定的名字。
    // 逐个目标群各取一个:一次搬运可能发好几个群,而上传接口按 file_name 认文件(D65)。
    const fileNames = relayFileNames(RELAY_FILE_PREFIX, Date.now(), task.targets.length);
    for (const [index, id] of task.targets.entries()) {
      try {
        const fileInfo = await api.uploadFile({
          scene: 'group',
          openid: id,
          fileName: fileNames[index],
          buffer: task.pdf,
          fileType: 4,
        });
        const sentBody = await api.sendMedia({ scene: 'group', openid: id, fileInfo });
        // 记下 message id —— 这是"漏网之后"唯一的补救凭据(平台只给 2 分钟)
        if (sentBody?.id) relaySent.push({ groupId: id, messageId: sentBody.id, at: Date.now() });
        sent += 1;
        log.info(`搬运：已发送 ${(task.pdf.length / 1024 / 1024).toFixed(2)}MB → 群 ${id.slice(0, 8)}…（操作者确认 #${task.seq ?? '?'}）`);
      } catch (err) {
        log.error(`搬运失败（群 ${id.slice(0, 8)}…）`, err);
      }
    }
    if (sent > 0 && task.text && task.text.length > 0) {
      const body = formatRelayTextFallback(task.text);
      for (const id of task.targets) {
        try {
          await sendChunked({ scene: 'group', targetId: id, messageId: undefined, content: '' }, body);
          log.info(`搬运：文字另发 → 群 ${id.slice(0, 8)}…（${task.text.length} 行，渲染失败时的兜底）`);
        } catch (err) {
          log.warn(`搬运：文字补发失败（群 ${id.slice(0, 8)}…）: ${describeError(err)}`);
        }
      }
    }
    await say(`（已搬到 ${sent}/${task.targets.length} 个群：${task.imageCount} 张图${task.textLines > 0 ? `、${task.textLines} 行文字` : ''}。发现不对就 2 分钟内发 \`/撤回\`。）`);
  }

  function relayConfig() {
    if (relayPolicy || relayPolicyFailed) return relayPolicy;
    try {
      relayPolicy = parseRelayConfig(process.env);
      if (relayPolicy.enabled) {
        // ⚠️ `confirm` 的状态**必须**印在横幅里(2026-09-29):它是"发出去之前有没有人过目"
        //    这一层的开关,而关掉之后日志里就再也看不出"这次为什么没人确认"了。
        //    用户当天把它关成了自动转发(方案 B),理由与代价见 D69。
        log.info(
          `搬运：开启（白名单 ${relayPolicy.to.length} 个群 / denylist ${relayPolicy.deny.length} 个 / ` +
          `群名核对=${relayPolicy.verifyNames ? '开' : '关'}；触发=${relayPolicy.confirm ? '问你一声（/搬 才发）' : '自动转发（打包完直接发，发完给你回执）'}；` +
          '只搬"纯图 + 文字"的记录）',
        );
        if (relayPolicy.to.length === 0) {
          log.warn('搬运：QQBOT_RELAY=true 但 QQBOT_RELAY_TO 是空的 —— 不会搬任何东西（fail closed）');
        }
      }
    } catch (err) {
      relayPolicyFailed = true;
      log.error('搬运：配置写错 —— 不搬任何东西（fail closed）', err);
    }
    return relayPolicy;
  }

  /** 一条「聊天记录」的完整处理:闸门 → 下载 → 打包成 PDF → 上传 → 发白名单群。 */
  async function handleRelayRecord(message, relay) {
    // 来源是群时**不要往那个群里贴回复**(群友会觉得莫名其妙)—— 账目走私聊给操作者。
    const reply = (text) => (message.scene === 'group'
      ? reportToOperator(text)
      : sendChunked(message, text)).catch((err) => log.warn(`搬运：回复失败 ${describeError(err)}`));
    const parsed = parseChatRecord(message.content);
    const verdict = classifyChatRecord(parsed);
    log.info(
      `搬运：「${parsed.header ?? '?'}」${verdict.stats.messages} 块 / ${verdict.stats.images} 图 / ` +
      `${verdict.stats.emptyBlocks} 空块 / ${verdict.stats.textLines} 行文字 → ${verdict.ok ? '放行' : '拒绝'}（${verdict.reason}）`,
    );
    if (!verdict.ok) {
      await reply(describeRelayRefusal(verdict));
      return;
    }

    // 目标群:白名单 ∩ 非黑名单,而且**按群名核对** —— 挡的是"openid 抄错一个字符"
    const targets = [];
    for (const id of relay.to) {
      if (relay.deny.includes(id)) {
        log.warn(`搬运：${id.slice(0, 8)}… 同时在 DENY 里，跳过`);
        continue;
      }
      if (relay.verifyNames) {
        // ⚠️ **fail closed**:开着群名核对时,`TO` 里的群**必须**在 EXPECT_NAMES 里有名字 ——
        //    否则"没写期望名"会被 checkGroupIdentity 当成"跳过核对"直接放行,
        //    那道保险就等于没有(而这正是"发错群"最可能进来的口子)。
        if (!relay.expect.has(id)) {
          log.warn(`搬运：群 ${id.slice(0, 8)}… 没有配群名（QQBOT_RELAY_EXPECT_NAMES），拒发 —— 加了名字才会发`);
          continue;
        }
        const infos = await groupInfos([id]);
        const check = checkGroupIdentity({ expected: relay.expect.get(id), actual: infos[id]?.name ?? null });
        if (!check.ok) {
          log.warn(`搬运：群名核对没过 ${id.slice(0, 8)}… —— ${check.reason}`);
          continue;
        }
      }
      targets.push(id);
    }
    if (targets.length === 0) {
      await reply('（这条没搬：没有通过核对的目标群 —— 看日志里「搬运：」那几行。）');
      return;
    }

    const urls = parsed.messages
      .flatMap((item) => item.attachments)
      .filter((attachment) => attachment.kind === '图片' && attachment.url)
      .map((attachment) => attachment.url);
    const buffers = [];
    let failedDownloads = 0;
    for (let i = 0; i < urls.length; i += 4) {
      const batch = await Promise.all(urls.slice(i, i + 4).map(async (url) => {
        // ⚠️ 图片 CDN 是**会超时**的(2026-09-28 实测:一张图 ConnectTimeout 就把整个搬运炸了,
        //    而且是 unhandled rejection —— 群友看不到东西、操作者也没收到回复)。
        //    所以每张图自己重试一次,失败的**跳过并记账**,绝不拖垮整条记录。
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            return await downloadQqImage(url);
          } catch (err) {
            if (attempt >= 2) {
              log.warn(`搬运：图片下载失败（第 ${i + 1} 批）: ${describeError(err)}`);
              return null;
            }
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
        return null;
      }));
      for (const buffer of batch) {
        if (buffer) buffers.push(buffer);
        else failedDownloads += 1;
      }
    }
    if (buffers.length === 0) {
      await reply(`（这条没搬：${urls.length} 张图一张都没下下来 —— 看日志里「搬运：图片下载失败」。）`);
      return;
    }
    const textLines = parsed.messages.flatMap((item) => item.texts.map((line) => `${item.sender ?? '?'}：${line}`));
    // ---- 图片那一半 ----
    // ⚠️ **不能把下载回来的字节直接当 JPEG 嵌**(2026-09-29 真踩了):`buildPdf()` 会把每张图
    //    声明成 `/Filter /DCTDecode`,而 PNG/WebP 塞进去阅读器解不出来 —— 症状是
    //    "PDF 能打开、点开**看图不见了**"(微信里那张 PNG 就是这么丢的)。
    //    `normalizeImages()` 只放行**基线 JPEG**(0.2% 开销那条路),其余走 GDI+ 重编码;
    //    重编码失败就**整条不发**并说明 —— 绝不发一份"点开少几张图"的。
    const normalized = await normalizeImages(buffers);
    if (normalized.failed.length > 0) {
      log.warn(`搬运：${normalized.failed.length}/${buffers.length} 张图重编码失败 → 整条不发（${normalized.failed.map((item) => `第${item.index}张:${item.reason}`).join('；')}）`);
      await reply(describeRelayImageFailure(normalized.failed));
      return;
    }
    const images = normalized.buffers;
    // ---- 文字那一半 ----
    // `renderTextPages()`(GDI+ 把文字画成图)失败、或者不在 Windows 上时返回**空数组**。
    // 那意味着文字进不了 PDF —— 这时必须"另发一条文字消息",**绝不静默丢字**。
    // 判据收在 `decideTextFallback()`(纯函数,有测试)一处出,两条路都走它。
    // ⚠️ 记进 `pendingRelay.text` 是必须的:文字只能在**操作者 /搬 那一刻**才发得出去
    //    —— 待确认期间**一条消息都不能发**(那等于先斩后奏)。
    const textPages = await renderTextPages(textLines);
    const text = decideTextFallback({ lines: textLines, pages: textPages.length });
    const pdf = buildPdf([...textPages.map((buffer) => ({ buffer })), ...images.map((buffer) => ({ buffer }))]);
    log.info(
      `搬运：打包 ${(pdf.length / 1024 / 1024).toFixed(2)}MB（${images.length} 图` +
      `${normalized.tags.some((tag) => tag !== 'jpeg') ? `（${normalized.tags.join('、')}）` : ''}` +
      `${textPages.length > 0 ? ` + ${textPages.length} 页文字` : text.needed ? '，文字另发' : ''}）`,
    );

    // confirm 模式(**默认**):把打好的 PDF 先发到操作者私聊,回 `/搬` 才发群。
    // 代码只做结构性过滤,内容安全必须由人过目 —— 也因此**没有**"失败就不发"的静默路径:
    // 要么发到你私聊等你确认,要么明确拒绝。
    if (relay.confirm) {
      const operator = operatorIds().values().next().value ?? null;
      if (!operator) {
        await reply('（这条没搬：confirm 模式下没有操作者私聊目标 —— 配 QQBOT_ADMIN_IDS 或 QQBOT_ANNOUNCE_C2C。）');
        return;
      }
      // ⚠️ **不覆盖**:已经有待确认的一条时,fail closed(2026-09-29 现场)。
      //    以前这里是无条件赋值 —— 连发两条记录时,后打包完的会把前一条**顶掉**,
      //    于是"操作者确认的那条提示"和"真发出去的内容"可能是两条不同的记录。
      //    判据与文案收在 `describeRelayBusy()`(纯函数,有测试)一处出。
      //    ⚠️ 已知的一个并发窗口:两条记录**同时在打包**时,上面这个 `pendingRelay` 检查
      //    可能都还没看到对方,于是两条都过了这一关 —— 依然会后覆盖前。这类"同一时刻处理
      //    两份记录"需要打包互斥,单独一次做(记在 TODO),这里先保证"已经明摆着有一条
      //    待确认"这种最常见的情形是 fail closed 的。
      if (pendingRelay) {
        const busyText = describeRelayBusy(pendingRelay, relayShownSeq);
        log.warn(
          `搬运：已有待确认 #${pendingRelay.seq ?? '?'} → 这条(${images.length} 图)不覆盖也不发` +
          `（操作者最后看到的是 #${relayShownSeq ?? '无'}）`,
        );
        await reply(busyText);
        return;
      }
      const seq = relaySeq + 1;
      try {
        const fileInfo = await api.uploadFile({
          scene: 'user',
          openid: operator,
          fileName: `待确认-聊天记录-${Date.now()}.pdf`,
          buffer: pdf,
          fileType: 4,
        });
        await api.sendMedia({ scene: 'user', openid: operator, fileInfo });
      } catch (err) {
        log.error('搬运：待确认的 PDF 没能发到操作者私聊', err);
        await reply(`（这条没搬：待确认的 PDF 发不到你私聊 —— ${describeUserError(err)}）`);
        return;
      }
      relaySeq = seq;
      // 只有**真的把待确认的 PDF 发到操作者私聊**之后,才更新"操作者看到的是哪一条"
      relayShownSeq = seq;
      pendingRelay = {
        seq,
        pdf,
        imageCount: images.length,
        textLines: textLines.length,
        // ⚠️ 待确认的**不只是 PDF**:渲染失败时那批文字也要带着走,否则 `/搬` 之后它就没地方去了
        text: text.needed ? text.lines : null,
        targets,
        header: parsed.header,
        at: Date.now(),
      };
      log.info(`搬运：待确认 #${seq}（${images.length} 图 / ${(pdf.length / 1024 / 1024).toFixed(2)}MB，目标 ${targets.length} 群）—— 等操作者 /搬`);
      await reply(`（上面那份 PDF（#${seq}）就是这条聊天记录。**要看一眼再决定**：回 \`/搬\` 发到目标群，\`/不搬\` 丢弃。发出后 2 分钟内还可以 \`/撤回\`。）`);
      return;
    }

    let sent = 0;
    const sentIds = [];
    const fileNames = relayFileNames(RELAY_FILE_PREFIX, Date.now(), targets.length);
    for (const [index, id] of targets.entries()) {
      try {
        const fileInfo = await api.uploadFile({
          scene: 'group',
          openid: id,
          fileName: fileNames[index],
          buffer: pdf,
          fileType: 4,
        });
        const sentBody = await api.sendMedia({ scene: 'group', openid: id, fileInfo });
        if (sentBody?.id) relaySent.push({ groupId: id, messageId: sentBody.id, at: Date.now() });
        sent += 1;
        sentIds.push(id);
        // ⚠️ 自动转发模式(QQBOT_RELAY_CONFIRM=false)下这行要**自己说明身份** ——
        //    否则事后看日志会以为"没人确认怎么就发了"(2026-09-29 用户改的,见 D69)。
        log.info(`搬运：已发送 → 群 ${id.slice(0, 8)}…（${relay.confirm ? '操作者确认' : '自动转发'}）`);
      } catch (err) {
        log.error(`搬运失败（群 ${id.slice(0, 8)}…）`, err);
      }
    }
    if (sent > 0 && text.needed) {
      const body = formatRelayTextFallback(text.lines);
      for (const id of targets) {
        try {
          await sendChunked({ scene: 'group', targetId: id, messageId: undefined, content: '' }, body);
          log.info(`搬运：文字另发 → 群 ${id.slice(0, 8)}…（${text.lines.length} 行，渲染失败时的兜底）`);
        } catch (err) {
          log.warn(`搬运：文字补发失败（群 ${id.slice(0, 8)}…）: ${describeError(err)}`);
        }
      }
    }
    await reply(`（已搬到 ${sent}/${targets.length} 个群：${images.length} 张图${textLines.length > 0 ? `、${textLines.length} 行文字` : ''}。）`);
    // 自动转发模式:没有"问一声"这一步了,所以**必须**补一条回执 ——
    // 平台的撤回窗口只有 2 分钟,而它只有在"你知道刚发了什么"时才有用(D69 / 方案 B)。
    if (!relay.confirm) {
      const names = await groupDisplayNames(sentIds);
      await reportToOperator(describeRelayAutoForward({
        sent,
        total: targets.length,
        groupNames: names,
        imageCount: images.length,
        textLines: textLines.length,
        textFallback: text.needed,
      }));
    }
  }

  /**
   * 群 id → 能给人看的名字:平台的群信息接口优先,查不到就退回 id 前缀。
   *
   * ⚠️ 只用于**回执文案**;任何闸门/核对都不许用它(名字可能过时,见 D59 那条"派生索引
   * 不能当平台事实"的教训)。查名字失败**绝不能**让回执消失 —— 所以整段包在 try 里。
   */
  async function groupDisplayNames(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    let infos = {};
    try {
      infos = await groupInfos(ids);
    } catch (err) {
      log.warn(`搬运：回执里查群名失败（不影响搬运）: ${describeError(err)}`);
    }
    return ids.map((id) => infos?.[id]?.group_name ?? `${id.slice(0, 8)}…`);
  }

  /**
   * **网页上的一轮**(1.96.0 / D 第一刀):和 QQ 那条路**共用同一个内核**。
   *
   * ⚠️ 三件刻意的事:
   *   ① **同一套 `turnNotes`**:身体状态、投喂、好感、钓鱼情景、事件钩子全都照旧生效 ——
   *      于是"她在网页上和在群里是同一个人"不是靠约定,是靠**同一段代码**;
   *   ② **同一份记忆**:`recordTurn` 与 QQ 走同一个函数(`memory.db` + 养成),所以
   *      "你在网页上说过的话她记得"自动成立;
   *   ③ **不回 QQ**:这一路只把回复交给面板 —— 往群里播报是另一件事(docs/08 一)。
   *
   * @returns {Promise<{text: string, segments: string[]}>} 她的回复与**分条结果**
   *   (空文本 = 这一轮她没说话;`segments` 与 QQ 同一份规划,1.171.0 / D288)
   */
  async function runWebChatTurn(message) {
    const conversationKey = sessionIdFor(message);
    // D229:网页群聊已退役，此入口只处理按玩家隔离的网页私聊。
    const label = '网页聊天';
    const startedAt = Date.now();
    await semaphore.acquire();
    try {
      const mood = moodFor(conversationKey, message.content);
      // 网页聊天/房间这条路也吃梗库(同一个人换了个入口问同一句话,不该两副面孔)。
      const copypastaHit = copypastaFor(message);
      const turnFactList = turnFacts(message);
      const turnNoteList = await turnNotes(mood, message, [], null, {});
      if (copypastaHit) {
        turnFactList.push(copypastaHit.fact);
        turnNoteList.push(copypastaHit.note);
      }
      const prompt = withStyleNudge(
        // ⚠️ 网页这条线也走**事实**那条路(D163):这里**不用** `withSceneTag`
        //    (它会给网页消息拼上"[私聊]/[群聊]",而网页那一侧本来就不是 QQ 的场合)。
        withTurnFacts(message.content, turnFactList),
        turnNoteList,
      );
      // **P3-b**:网页私聊也是 chat 用途(通道不决定能力),同样按实例装配带工具。
      const result = await runner.runTurn(conversationKey, prompt, config.policy.replyTimeoutMs, null, buildToolContext(message, conversationKey));
      recordTurnMetrics({ key: conversationKey, ms: Date.now() - startedAt, text: result.text, timedOut: result.timedOut });
      if (result.timedOut) {
        log.info(`${label}：这一轮超时（她没说话）会话=${conversationKey}`);
        return { text: '', segments: [] };
      }
      const body = String(result.text ?? '').trim();
      if (body !== '') {
        log.info(`${label}：已回复会话=${conversationKey} dsh=${runner.sessionIdFor(conversationKey)} 长度=${body.length}`);
        // 与 QQ 走**同一个** recordTurn:记忆、成长、概念都在这一句里
        recordTurn('mention', {
          conversationKey,
          scene: message.scene,
          userText: message.content,
          replyText: body,
        });
      }
      // 1.171.0 / D288:网页聊天与 QQ **同一份**分条规划 —— 面板按段一泡一条地存。
      // P1:网页也走同一份口径(通道不决定能力,只决定怎么显示)。
      const segments = planSpokenLines(body, mood, {
        label,
        preserveFormatting: outputPolicyFor(turnModeFor(message)).preserveFormatting,
      });
      return { text: body, segments };
    } catch (err) {
      log.error(`${label}：这一轮失败会话=${conversationKey}`, err);
      throw err;
    } finally {
      semaphore.release();
    }
  }

  // ---------------------------------------------------------------------------
  // **身份绑定**(D / 1.97.0 / D158):把"网页上的账号"和"QQ 里的这个人"对成同一个人
  //
  // 用户原话:「最好能让网页登录完的玩家能绑定自己 qq 昵称,这样在 qq 又能认出来是谁」。
  // 网页那边点「绑定 QQ」拿到一枚**一次性口令**,把它发到**私聊** → 这里核销。
  //
  // ⚠️ 三条刻意的口径:
  //   ① **只认私聊**:群里任何人都能打一句 `HH-…` —— 那等于把别人的账号抢走;
  //   ② **核销不改数值、不改档位**:它只回答"这两条身份是同一个人"(好感那本账不动);
  //   ③ **回执走模板、不花模型**:这是一种"系统操作",不该编成她的台词
  //      (编了反而看不清到底成没成)。
  // ---------------------------------------------------------------------------
  const identityLinks = createIdentityLinks({ store: stateStore, log });

  // **角色卡**(1.104.0 / D168):一人一键(`character:<playerId>`)——
  // ⚠️ 它同时被三处用到:面板(捏人)、提示词(她知道你演的是谁)、跑团(判定修正)。
  const characters = createCharacters({ store: stateStore, log });

  /**
   * **这一轮说话的人是谁**(D158 的"最后一米")。
   *
   * ⚠️ 两个方向都要给:
   *   · QQ 那一轮:`message.senderId` 是 openid → 查它绑到了哪个账号;
   *   · 网页那一轮:`message.targetId` 是 playerId(见 `webchat.js` 的 `web:<playerId>`)→ 反查。
   * ⚠️ 账号昵称也过一遍"看得见吗"(`nameIsInvisible` 在 `people.js` 里,**那里是第二份** ——
   *    这里直接复用导出的那个函数,不再抄第三份)。
   */
  function identityNoteFor(message) {
    if (!message || (message.scene !== 'c2c' && message.scene !== 'group' && message.scene !== 'web')) return null;
    try {
      // ⚠️ **网页这条线**(`web` 私聊 / `room` 群聊)说的是同一件事:说话的人是**网页上那个玩家**
      //    (`senderId` 是 `playerId`,见 `runWebChatTurn` 的入参形状)。
      if (message.scene === 'web') {
        const raw = String(message.senderId ?? message.targetId ?? '');
        const playerId = Number(raw.replace(/^web:/, ''));
        const binding = Number.isInteger(playerId) && playerId > 0 ? identityLinks.byPlayer(playerId) : null;
        // ⚠️ 反向也要带上"她被告知的名字"(`person` 表)—— 与 QQ 方向同一条口径(1.100.0)
        const told = binding?.openid ? toldNameOf(binding.openid) : null;
        return buildIdentityNote({ scene: 'web', binding, toldName: told, nameIsInvisible });
      }
      const openid = String(message.senderId ?? '').trim();
      if (!openid) return null;
      const binding = identityLinks.byOpenid(openid);
      if (!binding) return null; // 没绑 → 不说（`buildIdentityNote` 里那句"没账号"会每轮都念，太吵）
      // ⚠️ 这里**直接读 `player` 表**,不经面板那套服务 —— 绑定与面板开关无关
      //    (面板关掉时她也该认得出这个人)。
      const player = playerRowById(binding.playerId);
      // ⚠️ **账号行被删了**(绑定还在)→ 一句都不说(1.99.1 复核):
      //    不然 `buildIdentityNote` 会拿 `player: null` 去说"这个人网页上**没有账号**" ——
      //    那与她"绑过"这件事**直接矛盾**,是比沉默更糟的错话。
      if (!player) return null;
      return buildIdentityNote({ scene: 'qq', player, binding, toldName: toldNameOf(openid), nameIsInvisible });
    } catch (err) {
      log.warn(`身份提示注入失败（这一轮照常聊）: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * **她被告知该用的名字**(第三套身份:`person` 表里 `/认人` 记下的那个)。
   *
   * ⚠️ 只在"这个人已经绑过 QQ"时才问(调用方就是这么用的)——
   *    每轮都查全表没必要,而绑过的人很少(D162)。
   */
  function toldNameOf(openid) {
    try {
      const rows = stateStore.personByOpenid(openid) ?? [];
      // 最近见到的那个非空显示名(`personByOpenid` 已按 last_seen 降序)
      for (const row of rows) {
        const name = String(row?.display ?? '').replace(/[\s\u200B-\u200D\uFEFF]/g, '').trim();
        if (name && !nameIsInvisible(row.display)) return String(row.display).trim();
      }
      return null;
    } catch (err) {
      log.warn(`读"她被告知的名字"失败（这一轮照常聊）: ${describeError(err)}`);
      return null;
    }
  }

  /** 按 id 读一行账号(读不到给 null —— 不猜)。 */
  function playerRowById(playerId) {
    const id = Number(playerId);
    if (!Number.isInteger(id) || id <= 0) return null;
    try {
      return stateStore.handle.prepare('SELECT id, account, nickname, disabled FROM player WHERE id = ?').get(id) ?? null;
    } catch (err) {
      log.warn(`读账号行失败（身份提示这一轮跳过）: ${describeError(err)}`);
      return null;
    }
  }
  /** 一句话里是不是在说"绑定"这件事(口令形状见 `identity-link.js`)。 */
  function isBindAttempt(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed.startsWith('/绑定') || trimmed.startsWith('/bind')) return true;
    return looksLikeBindCode(trimmed);
  }
  async function handleBindCommand(message) {
    if (message.scene !== 'c2c') {
      await sendChunked(message, '（绑定要在**私聊**里做 —— 群里发口令的话，谁看见都能把那个账号绑走。）');
      return true;
    }
    const openid = String(message.senderId ?? '').trim();
    const result = identityLinks.redeem({
      text: message.content,
      openid,
      displayName: message.senderName ?? null,
    });
    if (result.ok) {
      log.info(`身份绑定：QQ ${openid.slice(0, 8)}… 绑上了账号 #${result.playerId}`);
      await sendChunked(message, `（好，绑上了 —— 以后你在网页上和在 QQ 里，我就当是同一个人。）`);
      return true;
    }
    if (result.error === 'not_a_code') {
      await sendChunked(message, '（在网页上点「绑定 QQ」会给你一串 `HH-…` 的口令，把那串发到这里就行。）');
      return true;
    }
    if (result.error === 'unknown_code' || result.error === 'expired_code') {
      await sendChunked(message, '（这串口令我这儿没有（或者已经过期了）—— 回网页上重新点一次「绑定 QQ」。）');
      return true;
    }
    log.warn(`身份绑定：核销失败（${result.error}）sender=${openid || '?'}`);
    await sendChunked(message, '（这串口令没能用上 —— 回网页上重新点一次「绑定 QQ」。）');
    return true;
  }

  async function handleMessage(message) {
    const who = message.scene === 'c2c' ? '单聊' : '群聊';
    const conversationKey = sessionIdFor(message);
    const mention = message.isMention ? '@' : '非@';
    // 消息 id 也打出来(2026-09-30):它是**判"平台是不是重复推送"的唯一凭据** ——
    // 同一条被推两次时 id 相同,而"用户真的连发两条"时 id 不同。少了它,
    // "她为什么回了四次"就只能靠猜(那天现场正是栽在这里)。
    log.info(
      `收到${who}消息(${mention}) 会话=${conversationKey} 文字=${message.content.length} ` +
      `图片=${message.images.length} id=${message.messageId ?? '?'}`,
    );
    // 搬运(D60):**来源群(QQBOT_RELAY_FROM,即"火星试验田")里出现的「聊天记录」** →
    // 拦在模型之前(它不是对话),打包成一个 PDF 发到白名单群。
    // ⚠️ 用户 2026-09-28 明确:入口是**群里自己发现的**,不是私聊转发的。
    {
      const relay = relayConfig();
      if (relay?.enabled && message.scene === 'c2c') {
        const action = parseRelayCommand(message.content);
        if (action) {
          handleRelayCommand(message, relay, action).catch((err) => log.error('搬运：控制命令失败', err));
          return;
        }
      }
      if (
        relay?.enabled
        && message.scene === 'group'
        && message.targetId === relay.from
        && isChatRecord(message.content)
      ) {
        // ⚠️ 必须 `.catch`:async 函数用 `void` 调,**异常会变成 unhandled rejection**
        //    —— 2026-09-28 实测就是这样:一张图超时,整条搬运静默消失(群里什么都没有、操作者也没被告知)。
        handleRelayRecord(message, relay).catch((err) => {
          log.error('搬运：处理这条记录时出错', err);
          void reportToOperator(`（搬运失败：${describeUserError(err)}）`).catch(() => {});
        });
        return;
      }
    }
    if (message.scene === 'group') {
      // ---- 别的机器人说的话,当背景噪音(D54) ----
      //
      // 判据是**学到的** `foreignBotIds`(它被谁 @ 到过就学到谁,见 qq.js)。
      // 打开开关时:那条消息**不记账、不重排防抖、不刷新对话窗口、也不算点名** ——
      // 于是"两只互相续话题"这条环被剪断;真人说的话一切照旧。
      // 两类:①**学到的**别的机器人(`foreignBotIds`,来自它被 @ 到过的流量);
      //       ②**手工列的**(`QQBOT_GROUP_IGNORE_IDS`)—— 给那些平台标成 `bot:false`
      //          的"机器人"(第三方框架/个人号),它们学不到,只能人配(D54)。
      const fromOtherBot = Boolean(message.senderId)
        && (gateway.foreignBotIds.has(message.senderId) || config.policy.group.ignoreIds.has(message.senderId));
      // ⚠️ **但别人的咏唱技能要播报**(2026-10-01,D88):副实例看见主实例那条 `Explosion！！！`
      //    就写一段旁白 —— 这是**唯一**一处"故意让别的机器人的消息触发动作",所以放在忽略之前,
      //    而且只认结束词那一条(咏唱的分句不触发,免得念一句就来一条旁白)。
      if (fromOtherBot && isExplosionFinisher(message.content)) {
        await narrateExplosion(message);
        return;
      }
      if (fromOtherBot && config.policy.group.ignoreBots) {
        log.info(
          `忽略别的机器人 ${String(message.senderId).slice(0, 8)}… 的群消息（不记账、不触发；` +
          `QQBOT_GROUP_IGNORE_BOTS=false 可以关掉这个行为）`,
        );
        return;
      }
      lastGroupActivity.set(message.targetId, Date.now());
      // 「我知道有这个群」要落盘 —— 它是**事实**,不是热数据。
      // 只放在内存里的后果:重启后 `/群列表` 空的、播报"没有任何可用目标",
      // 得有人再 @ 她一次才认得(实测踩过好几次)。见 D35。
      try {
        stateStore.touchGroup(message.targetId, Date.now());
      } catch (err) {
        log.warn(`群清单落盘失败（不影响这轮对话）: ${describeError(err)}`);
      }
      noteGroupEngagement(message.targetId);
    }

    if (!isAllowed(message.senderId, config.policy.access)) {
      log.warn(`忽略未授权发送者 ${message.senderId}（当前模式 ${config.policy.access.mode}）`);
      return;
    }

    // 指标(2026-10-02,D94):**过了闸门的消息**才算"她收到的" ——
    // 被黑名单/模式挡下的不算(否则"每分钟多少条"会被攻击流量灌水)。
    recordMetrics([{ key: 'msg.in', value: 1, scope: conversationKeyFor(message) }]);

    // 「认识的人」= 见过面的 openid。放在准入闸门**之后**:被黑名单挡住的人
    // 不该出现在她的记忆里。见 `growth.js` / D40。
    touchSender(message);
    // 「关于人的事实」(D79):私聊里他说的照记;群里只认"@ 了人 + 关系词"的声明式关系。
    learnFactsFrom(message);
    // 体力 / 魔力:每轮被搭话回一点魔力、耗一点体力;亲密的话另算(D83)。
    // ⚠️ 每轮**清空**增量收集:回复末尾那行 `[魔力+45]` 只报这一轮的变化(D87)。
    turnStatDeltas = [];
    settleInteraction(message);
    // 喝魔力药剂 / 体力药剂(同一天,D86):按代码里的固定数值补。
    settlePotion(message);
    // **用户主动的互动事件**(D101 形态一):「陪我去逛街」「一起睡」这类邀约 ——
    // 认出来就按代码里那一档结算(每条有冷却,不然就是刷数值的入口),
    // 并且把"这一轮你俩在做什么"注入提示词(note 在 `turnNotes` 里取)。
    settleCompany(message);

    // 真人刚说过话 —— 「读空气」看的就是这个时刻(D72)。
    // ⚠️ **D99 阶段 2 起它还有一个用处**:"她自己的生活在转"那一拍判"没人互动"用的就是这个时刻
    //    (群和私聊都算,所以这里再记一份全局的)。
    lastHumanAtAll = Date.now();
    // 每轮重置"你俩在做什么"(D101):它由 `settleCompany()` 在下面那一小段里设。
    pendingCompany = null;
    // **好感度**(D104):说话本身就算数,但很慢(+1);每天有上限。
    bumpAffinity(message, 'chat');
    // **求治疗者治病**(D103 接线):病着的时候说一句就能求她 —— 收诊金、有成败。
    if (!isReporter()) {
      const currentCondition = readCondition();
      if (currentCondition && AQUA_PATTERNS.some((re) => re.test(message.content))) {
        await seekAquaCure(message, currentCondition);
        return;
      }
    }
    // **事件钩子**(D99 阶段 3):这个会话挂着她抛出去、还没人答的事 —— 现在有人说话了,
    // 这一轮就把它结掉(走向按他说的意思挑,数值由代码给)。人已经过完准入闸门了。
    pendingStory = null;
    try {
      const pending = stateStore.getPendingEvent(storyKeyFor(message));
      if (pending) {
        pendingStory = { pending, reply: message.content, scene: message.scene };
        log.info(`事件钩子：这一轮的回应会被用来收尾「${pending.eventId}」（挂于 ${Math.round((Date.now() - pending.openedAt) / 60_000)} 分钟前）`);
      }
    } catch (err) {
      log.warn(`读挂起事件失败（不影响这一轮对话）: ${describeError(err)}`);
    }
    // ⚠️ 放在这里(过完"别的机器人"与准入两道闸之后)是刻意的:
    //   别的机器人的消息不该让她的"串"看起来还在继续(它们连记账都不算,D54)。
    if (message.scene === 'group') {
      lastGroupHumanAt.set(message.targetId, Date.now());
      // 参与状态机(D277):@ = "有人找过她"(观望/试探抬档);普通群消息 = 可能是
      // 对她自发开口的回应(回应窗口内算 answered,状态机自己判)。
      if (message.isMention) {
        socialState.noteAddressed(message.targetId);
      }
      // 拍板 4A(观察期仪器,2026-10-21):answered→active 的转移按触发消息是 @ 还是普通
      // 消息分开计数 —— 观察期收口时用它回答「宽口径有没有把八竿子打不着的消息当成回应」。
      // 只数转移(answered 且状态真的抬到 active),不是每条消息;纯观测,零行为变化。
      const answeredTransition = socialState.noteGroupMessage(message.targetId);
      if (answeredTransition) {
        recordMetrics([{
          key: message.isMention ? 'social.answered.byMention' : 'social.answered.byPlain',
          value: 1,
          scope: message.targetId,
        }]);
      }
    }
    // 带图的消息要进"窗内补图"那本账 —— ⚠️ **放在 @ 分支之外**:
    // 被 @ 的那一轮自己带的图也要能被后面几轮看到(现场:图在 @ 之前 12 秒到,而 @ 那条没有图)。
    // ⚠️ 2026-10-16:私聊也记(同一本账) —— 「发图 → 隔几秒追问颜色」现场,追问轮不该盲。
    rememberConversationImages(message.targetId, message);

    // Group messages the bot was not addressed in are buffered, never answered
    // directly: buffering is free, and an @ later carries them as context. They
    // are also *only* buffered — folding them into the session now would cost a
    // model call per group message.
    if (message.scene === 'group' && !message.isMention) {
      groupContext.record(message.targetId, {
        sender: message.senderName,
        content: message.content,
        hasImage: message.images.length > 0,
      });
      lastGroupMessage.set(message.targetId, message);
      // 图另外记一份:被**文字**触发的那一轮也要能看到它(见 `conversationImageCarry` 的说明)。
      rememberConversationImages(message.targetId, message);

      // A gesture gets its own path: it is a reflex, not a conversation, and it
      // must not also be answered by the debounced self-reply below (that would
      // be two replies to one gesture). It stays in the buffer either way, so a
      // later reply still knows it happened.
      if (message.isPoke || message.isFace) {
        const kind = message.isPoke ? 'poke' : 'face';
        log.info(`收到${kind === 'poke' ? '戳一戳' : '表情'} 群=${message.targetId}（${message.content}）`);
        // 被戳一下会有点烦 —— 不管她这次理不理,心情都掉一点点(带 60 秒冷却)。
        if (kind === 'poke' && config.policy.stats.enabled) {
          try {
            const { stats, event } = stateStore.applyInteraction('poked', Date.now(), {
              sleep: config.policy.warmup.sleep,
            });
            recordStatDeltas(event);
            if (event) log.info(`心情：被戳 ${event.moodDelta} → ${Math.round(stats.mood)}`);
          } catch (err) {
            log.warn(`心情结算失败: ${describeError(err)}`);
          }
        }
        await maybeInteractionReply(message.targetId, message, kind);
        return;
      }

      // **让贤**(1.172.0 / D291 起;1.196.0 / D322 扩到**任何人**):这条消息 @ 了
      // 别人(别的已知 bot,或**任何普通用户**——主人 2026-10-24 现场:「@其他用户时
      // 主实例又当成在跟她说话」)而没 @ 我 → 答话/读空气/对话窗口三路全不接。
      // 消息本体照旧进群上下文(上面 record 过):她看得见这一条,只是不接话。
      // 业界完整口径 = OpenClaw `ignoreOtherMentions`("another bot **or user**")。
      // ⚠️ 双叫且我排第一个的情形在 qq.js 判定层已仲裁过(isMention 保持 true),
      // 走不到这里;会走到这里的都是"这条在叫别人"的。
      if (message.mentionsForeignBot || message.mentionsOthers) {
        // **顺手摘掉挂着的自发计时器**(1.172.1 / D291 复核):让贤前 ≤6s 武装的
        // debounce/social-wait 照常 fire 会拿这条让贤消息当最新上下文开口 ——
        // 与"三路全不接"差半拍。jitter 保留:那是上一条 @ 我的消息正在打的字,
        // 这条让贤不该打断它。
        const pending = groupTimers.get(message.targetId);
        if (pending && pending.kind !== 'jitter') {
          clearTimeout(pending.timer ?? pending);
          groupTimers.delete(message.targetId);
          log.info('让贤：摘掉挂着的自发计时器（这条不参与读空气）');
        }
        const firstBot = (message.mentions ?? []).find((entry) => entry?.bot && entry?.username);
        const firstNamed = (message.mentions ?? []).find((entry) => entry?.username);
        const called = firstBot?.username ?? firstNamed?.username ?? '别人';
        log.info(`让贤：这条在叫「${called}」，不接话（${message.senderName ?? '群友'} 说的）`);
        return;
      }

      // Someone naming the character is talking *to* it, not around it.
      const keyword = matchesKeywords(message.content, config.policy.group.keywords);
      // So is a follow-up inside the conversation window that says "你" — people
      // stop repeating the name once a conversation is underway, which is
      // exactly when the bot must not fall silent.
      const addressed =
        keyword === null &&
        groupContext.isWindowOpen(message.targetId) &&
        looksAddressedToBot(message.content, config.policy.group.addressMarkers);

      if (keyword !== null || addressed) {
        const reason = keyword !== null ? `提到了「${keyword}」` : '对话中直接对你说话';
        const queued = groupTimers.get(message.targetId);
        // ⚠️ 已经在"打字"的那一次不重复排队:连续被叫名字时,只回一次
        // (否则每来一句就往后推,永远开不了口 —— 那也是另一种不像人)。
        if (queued?.kind === 'jitter') {
          log.info(`已经在打字了，不再排队（${reason}）`);
          return;
        }
        if (queued) {
          clearTimeout(queued.timer);
          groupTimers.delete(message.targetId);
        }
        log.info(`判定为对${INFRA_CONTENT.primaryName}说话（${reason}），立刻考虑回复`);
        // 「像人在打字」的抖动(D53):被叫到名字不秒回,而是等一小会儿再开口。
        // 真人打字要时间;主实例(手打)比副实例(机器)更久,见各自的 .env。
        const jitter = config.policy.group.keywordJitterMs;
        const delay = jitter.maxMs <= 0
          ? 0
          : jitter.minMs + Math.floor(Math.random() * (jitter.maxMs - jitter.minMs + 1));
        if (delay <= 0) {
          void maybeGroupReply(message.targetId, { addressed: true, reason, message });
          return;
        }
        log.info(`打字中：${(delay / 1000).toFixed(1)}s 后开口（${reason}）`);
        const timer = setTimeout(() => {
          groupTimers.delete(message.targetId);
          void maybeGroupReply(message.targetId, { addressed: true, reason, message });
        }, delay);
        timer.unref?.();
        groupTimers.set(message.targetId, { timer, kind: 'jitter' });
        return;
      }

      scheduleGroupReply(message.targetId);
      return;
    }

    // An @ outranks any queued self-reply: drop it, otherwise it could start
    // first and hold the shared session queue, delaying the answer that was
    // actually asked for.
    if (message.scene === 'group') {
      const pending = groupTimers.get(message.targetId);
      if (pending) {
        clearTimeout(pending.timer ?? pending);
        groupTimers.delete(message.targetId);
        log.debug(`取消群 ${message.targetId} 的待发自发发言（被 @ 打断）`);
      }
    }

    // 「发N张<角色>美图/涩图」—— 确定性解析/找图/发送优先；仅角色未命中单次模型理解。
    // 只认群里的 @;解析失败但确实像这条指令时回一句格式提示(别让她当成闲聊去接)。
    // 1.181.0:美图/涩图分档(检索路径两条)、动词加「搬」、「来3张随便的」残缺指令直接接走。
    if (message.scene === 'group' && message.isMention && config.meitu?.enabled) {
      const parsedMeitu = parseMeituCommand(message.content, { max: config.meitu.max });
      if (parsedMeitu.ok) {
        // T2:动作观察 —— 接纳即登记 running;完成后用真实 task 覆盖(失败也如实)。
        const meituScope = `group:${message.targetId}`;
        actionLog.record(meituScope, {
          kind: 'meitu', taskId: null, status: 'running',
          text: describeMeituTask({ status: 'running', originText: String(message.content ?? '') }),
        });
        void handleMeituCommand({
          message,
          parsed: parsedMeitu,
          deps: {
            config,
            log,
            // 上传/发送复用主循环里那一个 QqApi 实例;回话复用现成的 sendChunked。
            // ⚠️ reply 透传 `{startSeq, active}`:服务层把文本回话与图片排在**同一条**
            //    被动回复序列里(seq 1..5),图片超限才转主动(40034105 的教训)。
            uploadFile: (args) => api.uploadFile(args),
            sendMedia: (args) => api.sendMedia(args),
            reply: (text, opts) => sendChunked(message, text, opts),
            // 展览处埋点(2026-10-23 / 刀 2):发成功 recordSent、被拦 recordBlocked。
            // null(没开美图线 / QQBOT_GALLERY=0 / 库打不开)→ 服务层全程跳过,不影响发图。
            gallery: meituGallery,
            // T3:媒体发送绑定(出站消息↔资产身份)写状态库;引用解析同作用域查这张表。
            recordMediaLink: (entry) => stateStore.recordMediaLink({
              bot: gateway.botName || 'bot', scene: 'group', target: message.targetId,
              outboundId: entry?.outboundId, itemSeq: entry?.itemSeq, kind: 'meitu',
              md5: entry?.md5, source: entry?.source, sourceId: entry?.sourceId,
            }),
            // 仅别名/角色解析未命中才使用一次 bot 模型；正常指令仍不花模型调用。
            interpretCommand: (input) => createMeituInterpreter({
              llm: llmSettings.scoped('bot'),
              requestOptions: config.engine.requestOptions,
              store: stateStore,
              key: conversationKey,
              log,
            })(input),
          },
        }).then((result) => {
          // T2:真实任务产物回填动作观察账(成功/部分/失败三态都覆盖 pending)。
          const task = result?.task ?? null;
          actionLog.record(meituScope, {
            kind: 'meitu', taskId: task?.taskId ?? null, status: task?.status ?? 'failed',
            originText: task?.originText ?? String(message.content ?? '').slice(0, 40),
            resolved: task?.resolved ?? null, requested: task?.requested ?? null,
            sent: task?.sent ?? 0, failed: task?.failed ?? 0, reason: task?.reason ?? null,
            text: describeMeituTask(task) ?? `搬图结束（${result?.reason ?? 'unknown'}）`,
          });
        }).catch((err) => {
          // 2026-10-27 P1 兜底:处理管道意外 reject 时大声落日志,不许走
          // unhandledRejection 把整个进程带崩(crash-log 是 unhandledRejection→exit(1))。
          // 正常失败路径在 handleMeituCommand 内部已经 try/catch 收口,这里只防装配层意外。
          log.error('美图：处理管道意外失败', err);
        });
        return;
      }
      if (looksLikeMeituAttempt(message.content)) {
        await sendChunked(message, '格式：<发/来/找><N>张<角色名或「随机」><美图/涩图>，要<足控/胸控/单人/多人等>的');
        return;
      }
      // 没匹配上也要留痕(1.179.1):@ 消息进了 hook 但解析失败 —— 下次现场日志能直接看到正文形状。
      log.debug(`美图：@ 消息未匹配指令（正文=${JSON.stringify(String(message.content ?? '')).slice(0, 80)}）`);
    }

    // Bridge-level commands are handled here and never reach the agent.
    if (RESET_COMMANDS.has(message.content.trim())) {
      // ⚠️ 2026-10-15(并行审查 F7):own 引擎在**有在途回合**时拒绝重置(抛错),
      //    而 DSH 的 `resetConversation` 永不抛 —— 同一条命令两路两副面孔:
      //    own 路那一刻被外层"处理消息失败"接住,用户**啥都收不到**(连"重置不了"都没有)。
      //    现在 `planReset` 一次算清(提前问 isBusy + 兜住竞态抛错),措辞在 `src\reset-reply.js`。
      const reset = planReset(runner, conversationKey);
      if (!reset.ok) {
        log.warn(`/重置 没做成（${reset.reason}，状态一个字没改）: ${reset.error?.message ?? '还有在途回合'}`);
        await sendChunked(message, reset.reply);
        return;
      }
      // 记忆交接要**让路**:`/重置` 的语义就是"清空重来"。
      // (新会话本来就会触发交接,不挡的话重置等于没重置。)
      // ⚠️ 顺序纪律:这句必须**在重置成功之后**加 —— 重置失败还抑制交接的话,
      //    下一次真开口就白白丢一次旧记忆(那是"看起来成功了"的静默副作用)。
      handoffSuppressed.add(conversationKey);
      // T1-D(2026-10-29):重置一致地清**短期旁路** —— 补图账、群背景缓冲、待发合并、待自发口令。
      // 长期记忆不删:/重置 = 清空短期上下文,不是遗忘她;后续检索仍按需给。
      conversationImageCarry.clear(message.targetId);
      groupContext.clear(message.targetId);
      const droppedBursts = burstQueue.drop(conversationKey);
      const pendingSelf = groupTimers.get(message.targetId);
      if (pendingSelf) {
        clearTimeout(pendingSelf.timer ?? pendingSelf);
        groupTimers.delete(message.targetId);
      }
      log.info(`手动重置会话 → ${reset.sessionId}（本轮不交接记忆;短期旁路已清,待发合并丢弃 ${droppedBursts} 条）`);
      await sendChunked(message, '（会话已重置，角色卡已重新加载）');
      return;
    }

    // `/状态` 读的是真实数值(卡片 §12 早就列了这个命令)。配了
    // `QQBOT_REPORT_STATS_DB` 时读的是**别的实例**的库 —— 日志机器人就是这么报数的。
    if (STATUS_COMMANDS.has(message.content.trim())) {
      if (!config.policy.stats.enabled && !config.policy.reportStatsDb) {
        await sendChunked(message, '（数值系统关闭中：QQBOT_STATS=false）');
        return;
      }
      const snapshot = reportStats();
      if (!snapshot.stats) {
        await sendChunked(message, '（那边还没有身体状态记录 —— 状态库是空的？）');
        return;
      }
      log.info(
        `查询状态 → 饱食 ${Math.round(snapshot.stats.satiety)} ` +
        `健康 ${Math.round(snapshot.stats.health)} 心情 ${Math.round(snapshot.stats.mood)} ` +
        `${CURRENCY.name} ${Math.round(snapshot.stats.money ?? 0)}`,
      );

      // 报数的那只(配了 QQBOT_REPORT_STATS_DB)= **让模型用自己的播报口吻念出来**
      // (D42)。数据仍然是桥读出来的**事实**,它只负责措辞 —— 不接受它自己编数字。
      // 不报数的那只走原来的确定性一行,免得白花一次模型调用。
      if (isReporter()) {
        await sendScanReport(message, snapshot);
        return;
      }

      await sendChunked(message, describeForUser(snapshot.stats, {
        lastMealAt: snapshot.lastMealAt,
        lastFood: snapshot.lastFood,
        theme: getBodyTheme(config.policy.stats.theme),
      }));
      return;
    }

    // `/成长` —— 养成进度的精确值。**平时数值只进提示词**,所以这条命令是
    // 唯一能问出"她现在几级、学会了什么、认识几个人"的办法(要报数问副实例)。
    if (GROWTH_COMMANDS.has(message.content.trim())) {
      if (!config.policy.growth.enabled) {
        await sendChunked(message, '（养成系统关闭中：QQBOT_GROWTH=false）');
        return;
      }
      const growth = currentGrowth();
      const lines = [`【养成】${describeGrowthForUser(growth)}`];
      try {
        const concepts = stateStore.concepts(8);
        const people = stateStore.peopleSummary(5);
        if (concepts.length > 0) {
          lines.push(`学会的概念（共 ${stateStore.conceptCount()} 个，最近）：${concepts.map((c) => c.label).join('、')}`);
        }
        lines.push(`认识的人：${people.total} 个${people.recent.length > 0 ? `（最近：${people.recent.map((p) => p.display ?? '无名').join('、')}）` : ''}`);
      } catch (err) {
        log.warn(`养成明细读取失败: ${describeError(err)}`);
        lines.push(`（明细读不出来：${describeUserError(err)}）`);
      }
      log.info(`查询养成 → ${describeGrowthForUser(growth)}`);
      await sendChunked(message, lines.join('\n'));
      return;
    }

    // **委托面板**(D101 形态二):`/委托` 掷一块看板并落盘(短 TTL),`/接 N` 挑一条结算。
    // ⚠️ 面板是**确定性文本**、不过模型 —— 挑活是操作,不是闲聊(和 `/状态` 同一个待遇)。
    if (QUEST_COMMANDS.has(message.content.trim())) {
      const board = rollQuestBoard({});
      try {
        stateStore.setMeta(questBoardKeyFor(message), JSON.stringify({ at: Date.now(), board }));
      } catch (err) {
        log.warn(`委托面板落盘失败（不影响这一条回执）: ${describeError(err)}`);
      }
      await sendChunked(message, formatQuestBoard(board, { unit: CURRENCY.name }));
      log.info(`委托面板：${board.map((row) => `${row.index}=${row.tier}/${row.reward}`).join(' ')}`);
      return;
    }
    const questTake = QUEST_TAKE_RE.exec(message.content.trim());
    if (questTake) {
      await takeQuest(message, Number(questTake[1]));
      return;
    }

    // ⚠️ `/提及测试` **已经删掉**(2026-10-02 实测结论:群消息里 `<@!openid>` 不会被解析成提及 ——
    //    用户打了测试命令,没收到任何 @ 提醒)。要叫某个人就**在正文里写名字**(`namePrefix()`)。
    //    结论记在 `src\qq.js` 的 `sanitizeOutgoingText` 与 `docs\01-平台对抗手册-QQ.md`。

    // **`/熟人`**(D104 第①批):她认识的人各是什么档位 —— 只说档位不说分。
    if (message.content.trim() === '/熟人' || message.content.trim() === '/认识的人') {
      let entries = [];
      try {
        // ⚠️ 同样是"对象数组"那件事:`listMetaKeys()` 给的是 `{key, value, updatedAt}`。
        entries = (stateStore.listMetaKeys('affinity:') ?? [])
          .map((row) => {
            try { return JSON.parse(row.value ?? stateStore.getMeta(row.key)); } catch { return null; }
          })
          .filter(Boolean);
      } catch (err) {
        log.warn(`列熟人失败: ${describeError(err)}`);
      }
      await sendChunked(message, describeAffinityList(entries));
      return;
    }

    // **钓鱼回路**(D101 形态三,D104 实现)。用户点名"推进快速、别磨蹭":
    //   ① 触发 → **立刻**报水域+钓点+鱼饵(不过模型);
    //   ② 选饵 → 下饵,**从这一刻开始计时**(此后聊什么都不改它);
    //   ③ 到点 → tick 收网(先落账、再 @人、再问怎么处理);
    //   ④ 吃/卖/风干 → 结算,状态清空。
    // ⚠️ **两个 bot 都有钓位**(用户 2026-10-02:「同样的功能**给副实例加个钓鱼位**吧」)。
    //    ⚠️ 而且"**任何消息都不许被无声吃掉**"(用户实测第 1 条:群友 @ 了两个 bot 都不回)——
    //    所以每一步都只在"这句话真的像那一步的回答"时才拦下,否则**原样放过去走正常对话**。
    {
      // 整个"钓鱼回路"由适配器接管(D108):它自己读钓位、认这一步该不该拦、落盘、发消息。
      // ⚠️ 返回 true = 这条消息已经处理掉了(`return`);false = **原样放过去走正常对话**
      //    —— 这正是"任何消息都不许被无声吃掉"那条判据的落地形状。
      if (await fishing.handleMessage(message)) return;
    }

    // **身体检查**(D103):把 `/状态` 融进对话 —— 模糊问("最近身体怎么样")她随机报几项状态,
    // 具体问("病好了吗")只答那一件。**不走模型**:这是状态事实,和她演不演无关。
    // 用户给的两个样板就是判据(见 `condition.js` 的 `bodyCheckReply`)。
    if (config.policy.stats.enabled && !isReporter()) {
      const check = detectBodyCheck(message.content);
      if (check) {
        const current = stateStore.getStats(Date.now(), { sleep: config.policy.warmup.sleep });
        const line = bodyCheckReply({
          stats: current,
          condition: readCondition(),
          now: Date.now(),
          question: check,
        });
        await sendChunked(message, line);
        log.info(`身体检查：${check.vague ? '模糊' : '具体'}问（${check.topic}）→ ${line}`);
        return;
      }
    }

    // `/钱包` —— 经济状况(D42/D44)。**她自己那句话**(不像报数据),账单留给别人:
    // "报详细数值"是副实例的活(D28 的分工:报数与角色分开)。
    if (WALLET_COMMANDS.has(message.content.trim())) {
      if (!config.policy.stats.enabled || !config.policy.economy?.enabled) {
        await sendChunked(message, '（经济系统关闭中）');
        return;
      }
      const wallet = reportStats();
      if (!wallet.stats) {
        await sendChunked(message, '（那边还没有状态记录 —— 状态库是空的？）');
        return;
      }
      const amount = Math.round(Number(wallet.stats.money) || 0);
      // 报数的那只(副实例)没有"自己的钱包"这回事,给她确定性的一行;
      // 角色本人走"用自己的口吻说一个数"。
      if (isReporter()) {
        await sendChunked(message, describeWallet(wallet.stats));
        return;
      }
      await sendWalletLine(message, amount);
      return;
    }

    // 专用技能命令 —— 让她释放已配置的咏唱技能(D82):@ 她(或私聊里)点名时释放。
    // 咏唱词从**固定库**里挑(不让模型编),结束词另发一条新消息 —— 见 releaseExplosion。
    if (
      config.policy.explosion.enabled
      && (message.scene === 'c2c' || message.isMention)
      && isExplosionRequest(message.content)
    ) {
      const handled = await releaseExplosion(message);
      if (handled) return;
    }

    // `/旁白测试` —— 立刻让副实例给"刚才那一发"写一段旁白(D88 的诊断入口)。
    // 为什么要它:旁白只由**别人的咏唱技能**触发,没法自己按;有这条命令就能随时验一遍
    // (2026-10-01 就是这么发现"旁白一条都没发出去"的 —— 当时只能靠翻日志)。
    if (message.content.trim() === '/旁白测试' || message.content.trim() === '/旁白') {
      if (message.scene !== 'group') {
        await sendChunked(message, '（`/旁白测试` 要在群里用 —— 旁白是写给旁边的人听的。）');
        return;
      }
      log.info(`旁白测试：由 ${String(message.senderId).slice(0, 8)}… 在群里触发`);
      await narrateExplosion({ ...message, content: 'Explosion！！！', senderId: null }, { force: true });
      return;
    }

    // `/忘了` —— 撤销记错的事实(D81)。只能删"你自己"那一条(理由见处理函数)。
    if (/^\/(忘了|忘记|forget)(\s|$)/i.test(message.content.trim())) {
      const handled = await handleForget(message);
      if (handled) return;
    }

    // `/发图` —— **她自己发一张图出去**(2026-10-09,用户点名"试一下发图")。
    // 图是 `sprite-draw.py` 用代码画的她的像素形象;只给操作者;发完还喂回她这一轮让她看见。
    if (SEND_IMAGE_COMMANDS.has(message.content.trim().split(/\s+/)[0])) {
      const handled = await handleSendImage(message);
      if (handled) return;
    }

    // `/认人` —— 手工把"@ 到的这个人"和他的**名字**对起来(D78)。
    //
    // 为什么需要它:平台**没有群成员名单**,昵称只随消息给 ——
    // **没说过话的人她永远不认识**(现场:群友「饭否」被提到,但她不认识他)。
    // 所以给操作者一条补名单的路:`/认人 @饭否`(名字从 @ 的元数据里取,有则用)
    // 或 `/认人 @饭否 饭否`(显式给名字);一条消息可以 @ 多个人、按顺序给名字。
    if (message.content.trim().startsWith('/认人') || message.content.trim().startsWith('/知人')) {
      const handled = await handleLearnPerson(message);
      if (handled) return;
    }

    // `/绑定 HH-XXXXXX` —— 把网页账号和这个 QQ 对成同一个人(D / 1.97.0 / D158)。
    // ⚠️ 位置在**模型之前**:这是一件系统操作(核销口令),不该花一轮对话、也不该被编成台词。
    //    判据只认"口令形状 / `/绑定`"这两种,随手说一句普通的话不会被它吃掉。
    if (isBindAttempt(message.content)) {
      const handled = await handleBindCommand(message);
      if (handled) return;
    }

    // `/help` —— 列出这边可用的指令(D45)。正文由 `src/commands.js` 生成:
    // 那是"命令"这件事的唯一来源,手写第二份一定会腐烂(D34 的教训)。
    if (HELP_COMMANDS.has(message.content.trim())) {
      const operator = message.scene === 'c2c' && isOperator(message);
      const text = helpText({ scope: message.scene, isOperator: operator, botName: gateway.botName });
      log.info(`查询指令列表 → ${message.scene}（${operator ? '操作者' : '普通'}视角）`);
      await sendChunked(message, text);
      return;
    }

    // `/restart` —— 重启这只机器人(D45)。只认私聊 + 操作者,理由见命令定义处。
    if (RESTART_COMMANDS.has(message.content.trim())) {
      if (message.scene !== 'c2c' || !isOperator(message)) {
        log.warn(`忽略非操作者/群里的 /restart（sender=${message.senderId ?? '?'}）`);
        await sendChunked(message, '（重启只认私聊，而且是操作者才行 —— 它会让这只机器人整个重启一次）');
        return;
      }
      // ① 先写标记,② 再让自己退出 —— 顺序不能反(见 scripts\restart.js 的注释)。
      try {
        requestRestart(restartMarkerFile, `聊天里的 /restart（sender=${message.senderId}）`);
        log.info(`/restart：已写下重启标记，准备退出让 run.cmd 原地重开`);
        await sendChunked(message, '（好，这就重启一下。几秒钟后见 —— 我会记得我们聊过什么。）');
      } catch (err) {
        log.error('/restart 写标记失败', err);
        await sendChunked(message, `（重启失败：${describeUserError(err)}）`);
        return;
      }
      await shutdown(3010);
      return;
    }

    // 播报控制指令。怎么处理由 `handleAnnounceCommand` 决定(它要知道场合):
    //   · 私聊 —— 必须是操作者(名单校验),否则当普通消息交给模型;
    //   · 群里 —— 走**被动回复**发本群,幂等;名单配了才校验发送者。
    //
    // 为什么私聊那边必须卡权限:私聊的 `/更新` 会主动发往**所有已知群**。
    // 群里任何人打一句就能广播 —— 那不是功能,那是被人拿去刷屏的入口。
    // 群里那条之所以能对任何人开放,是因为它**只影响本群、且同版本只发一次**(见 D33)。
    // 「问你一声」的答复:私聊 + 操作者 + 有一个待确认的播报(D50)。
    // 放在命令分派与模型之前 —— 他回「发」的时候不该再花一轮对话。
    if (message.scene === 'c2c' && isOperator(message) && (await handleAnnounceReply(message))) return;

    const announceCommand = message.content.trim();
    if (isAnnounceCommand(announceCommand)) {
      const handled = await handleAnnounceCommand(message, announceCommand);
      if (handled) return;
    }

    // ---- 私聊「连发合并」(2026-09-30) ----
    //
    // ⚠️ **位置是刻意的,必须是这里、不能更早**:上面那些 return 全是命令与控制指令
    //   (搬运 `/搬` `/撤回`、重置、状态、钱包、`/重启`、播报的 `/发` `/不发`),
    //   它们要**立刻**执行 —— 操作者打 `/撤回` 时在 3 秒窗口里等,是纯粹的坏事。
    //   而 `isMergeable()` 又只放行"不是命令、不是手势的私聊消息",两道闸互相印证。
    //
    // 攒起来的消息由 `src\burst-queue.js` 在窗口到点时合成**一轮**
    // (实测依据见 `src\burst.js`:私聊 38.7% 的相邻消息是"上一条 10 秒内又来一条",
    //  而她的回复延迟中位只有 1.1 秒)。
    if (config.policy.c2cDebounceMs > 0 && isMergeable(message)) {
      // 取证日志(2026-09-30 现场):**同一次连发里既出现过合并路径、又出现过旧路径**,
      // 而"进没进窗口"光看有没有回复是分辨不出来的(两条路都会回复)。
      // 所以把判据本身打出来 —— 消息 id、是不是手势、以及这一条为什么不进窗口。
      // 诊断工具不许说谎:少一行 `连发合并：… 进窗口` 就等于"它没进窗口",一眼可查。
      burstQueue.push(message, conversationKey);
      log.info(
        `连发合并：进窗口（会话 ${conversationKey} id=${message.messageId ?? '?'} ` +
        `窗口 ${config.policy.c2cDebounceMs}ms）`,
      );
      return;
    }
    if (message.scene === 'c2c') {
      // 私聊里"本来会被当成戳一戳"的那些(互动表情 / 实体表情)现在会走到这里。
      // 打一行带**正文**的日志:以前这种消息在日志里只留一个长度数字,
      // 于是"她为什么没理这条"根本没法事后判断(2026-09-30 现场)。
      // ⚠️ 只在**这类**消息上打,普通私聊内容不进日志(隐私面越小越好)。
      if (message.isFace || /^\[/.test(String(message.content))) {
        log.info(`私聊里的一条表情/占位消息：${JSON.stringify(String(message.content).slice(0, 40))}（不是戳一戳 —— 私聊没有头像可双击）`);
      }
      log.info(
        `连发合并：这条不进窗口（会话 ${conversationKey} id=${message.messageId ?? '?'} ` +
        `窗口=${config.policy.c2cDebounceMs}ms 手势=${message.isPoke ? '戳' : message.isFace ? '表情' : '不是'} ` +
        `正文=${JSON.stringify(String(message.content).slice(0, 12))}）—— 立刻走旧路`,
      );
    }

    await semaphore.acquire();
    let groupReplied = false;
    try {
      // 走到这里说明**这是一条命令或控制指令** —— 它要立刻执行,不能等窗口。
      // 所以先把同一个会话里攒着的连发消息放出去:否则"她攒了三条话"和
      // "操作者的命令"会分两轮走,顺序还可能反(命令先答、攒的话后答)。
      burstQueue.flush(conversationKey);

      // Images are fetched here because the provider refuses external URLs.
      // ⚠️ 2026-10-02(第二次修):**被 @ 这条路也要带上"窗内补图"**。
      //    现场:`08:35:41` 有人发了一张图(非 @,当场不进模型),`08:35:53` 另一句话 @ 了她 ——
      //    而这条路原来只取"@ 那一条"的图(那条没有图),于是那 12 秒前的图**根本没上桌**,
      //    她又回了一句不搭界的话。上一轮只改了「连发合并」与「自发接话」两条路,漏了这条 ——
      //    而**被 @ 恰恰是最常走的那条**。
      // ⚠️ 2026-10-16:私聊同权(追问颜色现场)—— 群与私聊同一个会话账本。
      const mentionCarried = carriedConversationSources(message.targetId, message);
      const mentionSources = [message, ...mentionCarried].filter((entry) => entry?.images?.length);
      const imageBlocks = await fetchImageBlocks(mentionSources.flatMap((entry) => entry.images), {
        maxImages: config.policy.maxImages,
        onSkip: (image, err) => log.warn(`跳过图片 ${image?.filename ?? '(无文件名)'}：${describeError(err)}`),
      });
      if (imageBlocks.length > 0) {
        log.info(
          `附带 ${imageBlocks.length} 张图片` +
          (mentionSources.length > 1 ? `（来自 ${mentionSources.length} 条消息，窗内补图）` : ''),
        );
      }

      // A question was asked, so the mood sets the tone but the length limit is
      // only a hint: truncating an answer would drop what the asker wanted.
      const mood = moodFor(conversationKey, message.content);
      // 经济(D42):先掷这一轮的收支,再拼提示词 —— 这样"刚接了个委托"能当场说出来。
      // ⚠️ 把**这一轮的原话**一起给它:在聊钱/工作才讲,问别的事时只落账(用户 2026-10-02 报的那次)。
      const ledger = rollEconomy({ scene: message.scene, text: message.content });
      // ⚠️ **这一轮真的喂进模型的图**(含"窗内补图")要一路传到提示词与结算:
      //    投喂识别靠它,`message.images` 只在"触发那条自己带图"时才够用(见 D96)。
      //    `turnHasBackgroundImages` = 这些图**不是**触发那条自带的 —— 那一轮必须跟她说清
      //    "图是背景,你这一轮吃的是当前这条消息里的东西"(见 D98)。
      //    ⚠️⚠️ **注入与结算同口径**(2026-10-23):结算侧(composeReply)2026-10-09 起就
      //    排掉了窗内背景图,注入侧却还传含背景图的 `turnHasImage` —— 背景图回合照样被灌
      //    "图=投喂"教学,她嘴上反复声明"这个图不是吃的"。
      //    消费端有闸 ≠ 生产侧有闸(D295 同族教训):注入侧改用**同一个**判据。
      const turnHasImage = imageBlocks.length > 0;
      const turnHasBackgroundImages = mentionCarried.length > 0;
      // **复制粘贴梗**(2026-10-14,用户委派):命中时原文进"事实"、要求进"表达要求" ——
      //   两块分开是 D163 的硬规矩(原文塞进「照做但不要念出来」那一栏就自相矛盾了)。
      const copypastaHit = copypastaFor(message);
      const turnFactList = turnFacts(message);
      // T2:动作观察事实 —— 同群进行中/刚完成的搬图任务贴在消息旁(她答「发了没」有据可依)。
      const meituFact = meituActionFact(message);
      if (meituFact) turnFactList.push(meituFact);
      // T3:引用解析事实 —— 引用的是不是她发的图?只在同 bot/同群发送绑定里查,查不到不猜。
      // T4 尾巴:绑定命中且图库文件可达 → 把那张图的像素也带上(实际 MIME;不换图不编内容)。
      //   像素在 turnHasImage 结算**之后**追加:引用她自己发的旧图不是用户新投喂。
      const referenceMedia = resolveReferenceMedia(message);
      if (referenceMedia?.block) imageBlocks.push(referenceMedia.block);
      if (referenceMedia?.fact) turnFactList.push(referenceMedia.fact);
      const turnNoteList = await turnNotes(mood, message, ledger, null, {
        hasImage: turnHasImage && !turnHasBackgroundImages,
        backgroundImages: turnHasBackgroundImages,
      });
      if (copypastaHit) {
        turnFactList.push(copypastaHit.fact);
        turnNoteList.push(copypastaHit.note);
      }
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(
          // ⚠️ **事实贴在消息旁边**(`withTurnFacts`),表达要求(`turnNotes`)另起一块 ——
          //    顺序是刻意的:消息 → 事实 → 表达要求(D163)。
          withTurnFacts(
            withSceneTag(message, config.policy.promptContext, groupContext),
            turnFactList,
          ),
          turnNoteList,
        ),
        config.policy.replyTimeoutMs,
        imageBlocks,
        // **P3-b**:主答话 = chat 用途,按实例装配决定是否带工具(默认 null = 行为一字不变)。
        buildToolContext(message, conversationKey),
      );

      const body = composeReply(result, message, {
        // ⚠️ 窗内补进来的旧图**只作背景**:他 @ 她那一轮里"图 + 一句骂人话"不该变成一顿饭
        // (用户 2026-10-08 的蟑螂现场就是这一类);真要投喂,发图那条自己会带图。
        hasImage: turnHasImage && !turnHasBackgroundImages,
      });
      // 1.171.0 / D288:答话也是普通发言 —— 按短句分条(`sendSpokenLines` 里接 `msg_seq`),
      // 判据仍是"除标点/空白外一个字不丢"(D171 那笔账是截断欠的,分段不欠)。
      const replyLines = planSpokenLines(body, mood, {
        label: '答话',
        // P1:任务/知识口径整条保真交付(代码缩进、JSON 冒号、命令分号都不许被口语清理改掉)。
        preserveFormatting: outputPolicyFor(turnModeFor(message)).preserveFormatting,
      });
      await sendSpokenLines(message, replyLines, { typing: true });
      groupReplied = message.scene === 'group';
      // 参与状态机(D277):被叫后回了话 = 她在场说了话(连击清零;自发开口才计数)。
      if (message.scene === 'group') socialState.noteSpoke(message.targetId, { selfInitiated: false });
      // 带上**回的是哪一条**(见上面入站日志的理由):一条入站对应一条回复,对不上就是 bug。
      log.info(
        `已回复会话=${conversationKey} id=${message.messageId ?? '?'} ` +
        `dsh=${runner.sessionIdFor(conversationKey)} 长度=${body.length}`,
      );
      // 被叫到 = 最直接的一次成长。放在**发出之后**:没发出去的回复不算成长。
      recordTurn('mention', {
        conversationKey,
        scene: message.scene,
        userText: message.content,
        replyText: body,
      });
    } catch (err) {
      log.error(`处理消息失败会话=${conversationKey}`, err);
      try {
        await sendChunked(message, `（处理失败：${describeUserError(err)}）`);
      } catch (sendErr) {
        log.error('错误提示也发送失败', sendErr);
      }
    } finally {
      // A group reply consumes the buffer (those messages are now in the
      // session) and resets the self-reply gates: the bot just spoke, so it
      // should not immediately speak again on its own.
      if (groupReplied) {
        groupContext.clear(message.targetId);
        groupContext.noteReply(message.targetId);
      }
      semaphore.release();
    }
  }

  /**
   * 把攒着的几条私聊消息**合成一轮**发出去(连发合并,2026-09-30)。
   *
   * "什么时候该开口"由 `src\burst-queue.js` 决定(它在计时器到点时回调 `onReady`);
   * 这里只负责**真的跑一轮**:合并后的正文已经自带时间标注(见 `renderBurst`),
   * 所以这里不再让 `withSceneTag` 拼一遍场合标记。
   *
   * @param {string} conversationKey
   * @param {Array<{text: string, at: number}>} bursts 按到达顺序
   * @param {object} message **最后一条**原始消息(被动回复要用它的 msg_id,图片也取它的)
   * @param {{autoTargets?: string[], imageMessage?: object|null}} [options]
   *   `autoTargets` = 这一轮是**没点名**触发的,于是把这个群时间窗内**其他**消息的图也带上
   *   (修"识图时有时无",见 `conversationImageCarry`)。
   *   `imageMessage` = **这一串连发里最后一条带图的**消息(`src\burst-queue.js` 给的)——
   *   有了它,"先发图、再补一句话"那种连发才不会把图丢掉(见 D96)。
   */
  async function runBurstTurn(conversationKey, bursts, message, { autoTargets = [], imageMessage = null } = {}) {
    const merged = { ...message };
    merged.content = renderBurst(bursts, mergeInstruction(bursts.length));
    // 合并后的正文已经自带场合标记与时间标注(见 `renderBurst`),所以这里**不再**
    // 让 `withSceneTag` 拼一遍 —— 那份带合并说明的正文就是这一轮要说的话。
    merged.mergedBurst = true;

    await semaphore.acquire();
    let groupReplied = false;
    try {
      // 图片:点名那一路只喂触发那条;没点名的兜底把窗内的图一起喂(去重、封顶)。
      // ⚠️ 连发合并时图取 `imageMessage`(这一串里**最后一条带图的**),不是 `message` ——
      //    "先发图、再补一句话"那种连发里 newest 没有图,取它就把图丢了(见 D96)。
      // ⚠️ 2026-10-16:私聊追问同权 —— autoTargets 是"没点名触发的群",私聊走会话账本
      //    (「发图 → 隔几秒问颜色」现场,追问轮不该盲)。
      const extraSources = (message.scene === 'group'
        ? autoTargets.flatMap((groupId) => carriedConversationSources(groupId, message))
        : carriedConversationSources(message.targetId, message))
        .filter((entry, index, all) => all.indexOf(entry) === index);
      const imageSources = [imageMessage ?? message, ...extraSources]
        .filter((entry, index, all) => all.indexOf(entry) === index)
        .filter((entry) => entry?.images?.length);
      const imageBlocks = await fetchImageBlocks(
        imageSources.flatMap((entry) => entry.images),
        {
          maxImages: config.policy.maxImages,
          onSkip: (image, err) => log.warn(`跳过图片 ${image?.filename ?? '(无文件名)'}：${describeError(err)}`),
        },
      );
      if (imageBlocks.length > 0) {
        log.info(
          `附带 ${imageBlocks.length} 张图片` +
          (imageSources.length > 1 ? `（来自 ${imageSources.length} 条消息，窗内补图）` : ''),
        );
      }

      const mood = moodFor(conversationKey, merged.content);
      const ledger = rollEconomy({ scene: message.scene, text: merged.content });
      const turnHasImage = imageBlocks.length > 0;
      const turnHasBackgroundImages = extraSources.length > 0;
      // 连发合并这条路同样吃梗库(有人一句话分三段发,"我已经坐好了"常常在最后一段)。
      const copypastaHit = copypastaFor(merged);
      const turnFactList = turnFacts(merged);
      const turnNoteList = await turnNotes(mood, merged, ledger, null, {
        // 注入与结算同口径(2026-10-23,同答话路):窗内旧图只作背景,不灌"图=投喂"教学。
        hasImage: turnHasImage && !turnHasBackgroundImages,
        backgroundImages: turnHasBackgroundImages,
      });
      if (copypastaHit) {
        turnFactList.push(copypastaHit.fact);
        turnNoteList.push(copypastaHit.note);
      }
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(
          // ⚠️ 连发合并这条路同样要有**事实**那一块(D163):`merged` 保留了 `senderId`,
          //    所以身份照样认得出(第一版就是这里最容易漏)。
          withTurnFacts(
            withSceneTag(merged, config.policy.promptContext, groupContext),
            turnFactList,
          ),
          turnNoteList,
        ),
        config.policy.replyTimeoutMs,
        imageBlocks,
        // **P3-b**:合并答话同主答话口径(merged 带 senderId,身份可信)。
        buildToolContext(merged, conversationKey),
      );

      const body = composeReply(result, merged, {
        // 连发合并同理:窗内补进来的旧图只作背景,不算"有人喂她"(见自发发言那处的注释)
        hasImage: turnHasImage && !turnHasBackgroundImages,
      });
      // 1.171.0 / D288:合并回答同答话口径 —— 同一份分条规划。
      const replyLines = planSpokenLines(body, mood, {
        label: `合并答话(${bursts.length}条)`,
        // P1:同答话口径(合并的是同一批请求,口径跟着触发它的正文走)。
        preserveFormatting: outputPolicyFor(turnModeFor(merged)).preserveFormatting,
      });
      await sendSpokenLines(merged, replyLines, { typing: true });
      groupReplied = merged.scene === 'group';
      // 参与状态机(D277):合并路径也是被叫后的回复(同上,连击清零)。
      if (merged.scene === 'group') socialState.noteSpoke(merged.targetId, { selfInitiated: false });
      log.info(
        `已回复(合并 ${bursts.length} 条)会话=${conversationKey} ` +
        `dsh=${runner.sessionIdFor(conversationKey)} 长度=${body.length}`,
      );
      recordTurn('mention', {
        conversationKey,
        scene: merged.scene,
        userText: merged.content,
        replyText: body,
      });
    } catch (err) {
      log.error(`处理连发消息失败会话=${conversationKey}`, err);
      try {
        await sendChunked(merged, `（处理失败：${describeUserError(err)}）`);
      } catch (sendErr) {
        log.error('错误提示也发送失败', sendErr);
      }
    } finally {
      if (groupReplied) {
        groupContext.clear(merged.targetId);
        groupContext.noteReply(merged.targetId);
      }
      semaphore.release();
    }
  }

  /**
   * **事件钩子的收尾**(D99 阶段 3)。用户原话:「事件**一定要有结果**(可改变数值)」——
   * 所以这里做两件必须的事:
   *   ① 从她的回复里取出 `<story outcome="…"/>`(那段标记**不许发到 QQ**,和 `<intake>` 同一族);
   *   ② 走到向表里挑一档、把 `effect` 落成数值(`kind='story'` 流水),然后清掉挂起记录。
   *
   * ⚠️ **模型没报标记(或报了个不存在的 id)时,代码自己掷一档** —— 绝不"没有结果"。
   *    掷出来的是**哪一档**会打进日志,这样"结果不对劲"时能一眼看出是模型挑的还是代码掷的。
   */
  function settleStory(text, message = null) {
    const usable = pendingStoryFor(message);
    if (!usable) return text;
    const { pending } = usable;
    const { outcome, text: cleaned } = extractStoryOutcome(text);
    const event = { setup: pending.setup, branches: pending.branches };
    // 谁挑的这一档,三档优先:模型报的标记 → **她自己说出来的话**里认 → 掷骰。
    // ⚠️ 中间那档要把**标记载荷也一起喂进去**:真跑里她两次把整句话塞在载荷里
    //    (`<story outcome=……开垦新田来抵债……>`),而载荷已经被 `extractStoryOutcome` 从正文剥掉了 ——
    //    只拿正文去认,那句话就白写了。
    const byModel = matchOutcome(event, outcome);
    const byWords = byModel ? null : inferBranch(event, `${cleaned} ${outcome ?? ''}`);
    const branch = byModel ?? byWords ?? pickSelfDecidedBranch(event, Math.random);
    const pickedBy = byModel ? 'model' : byWords ? 'words' : 'code';
    pendingStory = null;
    try {
      const { stats, event: row } = stateStore.applyStoryResult(
        branch.effect ?? {},
        Date.now(),
        { eventId: pending.eventId, branch: branch.id, line: branch.line, pickedBy },
        { sleep: config.policy.warmup.sleep },
      );
      recordStatDeltas(row);
      stateStore.clearPendingEvent(pending.key);
      const how = pickedBy === 'model' ? '按那句回应挑的' : pickedBy === 'words' ? '按她自己说的话认出来的' : '没人说清，代码掷的';
      log.info(
        `事件钩子收尾：「${pending.eventId}」→ ${branch.id}（${how}）` +
        `｜${branch.line}｜钱 ${Math.round(stats.money)}、心情 ${Math.round(stats.mood)}`,
      );
      // ⚠️ **收尾的休闲动作要能量**:用户把它当成"互动事件结束"的标志,而它**只在提示词里** ——
      //    2026-10-02 离线真跑两次都没带上。缺了就记一条 warn,不然"她到底有没有收尾"查不出来。
      if (!hasClosingAction(cleaned)) {
        log.warn(`事件钩子收尾没带休闲动作（用户要的"去休息/洗澡/睡觉"那句）：「${cleaned.slice(0, 40)}」`);
      }
    } catch (err) {
      log.warn(`事件钩子结算失败（不影响这一轮回复）: ${describeError(err)}`);
    }
    return cleaned;
  }

  /**
   * Turn a completed turn into the text to send back.
   *
   * @param {object} result
   * @param {object|null} [message] the triggering message — needed to settle any
   *   `<intake>` block the model attached (and to strip it from what gets sent).
   * @param {{hasImage?: boolean}} [options] `hasImage` = **这一轮真的喂进模型的图**
   *   (见 `settleIntake` 的说明:不是"触发那条消息带没带图")。
   */
  function composeReply(result, message = null, { hasImage = null } = {}) {
    if (result.timedOut) {
      return `（等待超时：本轮超过 ${Math.round(config.policy.replyTimeoutMs / 1000)} 秒仍未结束，已放弃等待）`;
    }
    // 三个协议标记依次剥掉,顺序无所谓,但**都必须剥干净**才发给 QQ:
    // 进食回执 → 关系主张的认下标记 → 事件钩子的走向标记。
    const stripped = settleStory(
      applyAcceptedRelation(settleIntake(result.text ?? '', message, { hasImage }), message),
      message,
    );
    const spoken = stripped;
    const note = describeTurnEnd(result.reason);
    // ⚠️ **这一轮的状态增量**(D87):她要报数不用等 `@ /状态` —— 回复末尾自己带 `[魔力+45]`。
    //    顺序:她的话 → 状态增量 → 收尾说明。取完就清空,免得串到下一轮。
    const delta = statDeltaLine();
    turnStatDeltas = [];
    const body = [spoken, delta, note].filter(Boolean).join('\n');
    return body || '（本轮没有产生可发送的输出）';
  }

  /**
   * React to a small gesture — a 戳一戳 or a bare 表情 — sometimes, and never
   * twice in a row.
   *
   * QQ does not tell us *who* a gesture was aimed at: a poke carries the poker
   * and a custom action text, and the target is replaced by a placeholder
   * (verified against a real payload — `msg_elements` is null). So this is
   * deliberately probabilistic. A human does not answer every poke either, and a
   * low rate means a gesture aimed at somebody else only occasionally wakes her.
   *
   * @param {string} groupId
   * @param {object} message the triggering message, for its mood text.
   * @param {'poke'|'face'} kind
   * @returns {Promise<boolean>} whether a reaction was sent.
   */
  async function maybeInteractionReply(groupId, message, kind) {
    const cfg = config.policy.interaction;
    const label = kind === 'poke' ? '戳一戳' : '表情';
    const enabled = kind === 'poke' ? cfg.pokeEnabled : cfg.faceEnabled;
    if (!enabled) return false;

    const now = Date.now();
    const cooldownLeft = cfg.cooldownMs - (now - (lastInteractionAt.get(groupId) ?? 0));
    if (cooldownLeft > 0) {
      log.info(`${label}：群 ${groupId} 刚反应过（还差 ${Math.ceil(cooldownLeft / 1000)} 秒），这次不理`);
      return false;
    }

    const inWindow = groupContext.isWindowOpen(groupId);
    const base = kind === 'poke' ? cfg.pokeChance : cfg.faceChance;
    // 参与状态机(D277):互动反应的概率按状态档打折(退场=0 全静;活跃=1 现状)。
    // ⚠️ 戳一戳例外(主人 2026-10-28 拍板「戳一戳跟 @ 一样高」):它是明确的"碰了她",
    //    与 @ 同级,不吃状态档打折 —— 概率只由 pokeChance 与冷却管;纯表情照旧打折。
    const social = socialState.modulationFor(groupId);
    const socialFactor = kind === 'poke' ? 1 : social.interact;
    const chance = Math.min(1, (inWindow ? base * cfg.windowMultiplier : base) * socialFactor);
    if (Math.random() >= chance) {
      log.info(`${label}：群 ${groupId} 没中（概率 ${Math.round(chance * 100)}%${inWindow ? '，对话窗口开' : ''}${kind === 'face' && social.state !== 'active' ? `，状态 ${social.state}` : ''}），这次不理`);
      return false;
    }

    const conversationKey = sessionIdFor({ scene: 'group', targetId: groupId });
    if (runner.isBusy(conversationKey)) {
      log.info(`${label}：群 ${groupId} 有会话在跑，这次不理`);
      return false;
    }

    await semaphore.acquire();
    try {
      const mood = moodFor(conversationKey, message.content);
      const prompt = kind === 'poke'
        ? [
          '[群聊] 有人戳了你一下（戳一戳）。',
          '这是随手撩你一下，不是提问。反应要短 —— 一两句以内，像被人从背后戳了一下的第一反应。',
          '别问"有什么事"，也别写成长句子。',
        ].join('\n')
        : [
          '[群聊] 有人只发了一个表情，没有文字。',
          '可能是在逗你，也可能只是随手一发。你可以接一句话，也可以当没看见。',
          '要接就短 —— 一两句，别把表情描述一遍。',
        ].join('\n');

      // 经济也要跟着这轮走:不然"刚丢了钱"和"刚赚到钱"都不会影响这一句反应。
      // 这一条是**被动回复**(对某条消息的反应),所以把原话给它 —— 问别的事时不硬塞。
      // ⚠️ 1.195.0:这里原来读的是本函数里**不存在**的 `source`(正确来源是触发消息 `message`)
      //    → 每次掷中概率就在这里 ReferenceError、被外层 catch 吞成「反应失败」日志 ——
      //    戳一戳/表情反应从 1.58.0 起长期哑火(TODO ★★☆,1.195.0 修)。
      const ledger = rollEconomy({ scene: 'group', text: message?.content ?? '' });
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(
          `${prompt}\n\n如果觉得没必要理，就只回复 ${SILENT_TOKEN}。`,
          await turnNotes(mood, message, ledger),
        ),
        config.policy.replyTimeoutMs,
      );

      groupContext.noteReply(groupId);
      groupContext.clear(groupId);

      if (result.timedOut) {
        log.warn(`${label}：群 ${groupId} 超时，跳过`);
        return false;
      }
      if (isSilentReply(result.text)) {
        log.info(`${label}：群 ${groupId} 模型选择不理`);
        return false;
      }

      const lines = planSpokenLines(composeReply(result, message), mood, { label: `${label}反应` });
      await sendSpokenLines({ scene: 'group', targetId: groupId, messageId: undefined, content: '' }, lines);
      // 有人戳/发表情在先 = 对方发起,不算"她找话"(连击只数自发开口,D277)。
      socialState.noteSpoke(groupId, { selfInitiated: false });
      lastInteractionAt.set(groupId, Date.now());
      log.info(
        `${label}反应 群=${groupId} ${lines.length} 条 / 共 ${lines.reduce((sum, one) => sum + one.length, 0)} 字（主动消息）`,
      );
      // 被戳 / 被发表情也是一次互动,只是信息量比一句话少(见 XP_RULES)。
      recordTurn(kind, { conversationKey, scene: 'group', userText: message.content, replyText: lines.join('\n') });
      return true;
    } catch (err) {
      log.error(`${label}反应失败 群=${groupId}`, err);
      return false;
    } finally {
      semaphore.release();
    }
  }

  /**
   * Debounce a possible self-initiated reply.
   *
   * Restarting the timer on every message means a burst of chatter produces at
   * most one model call, once the group falls quiet.
   */
  function scheduleGroupReply(groupId) {
    if (config.policy.group.mode !== 'auto') return;
    const existing = groupTimers.get(groupId);
    // 已经在"打字"的那次不要被防抖顶掉:它比防抖更"有人味",而且马上就开口了。
    if (existing?.kind === 'jitter') return;
    if (existing) clearTimeout(existing.timer ?? existing);
    groupTimers.set(
      groupId,
      {
        kind: 'debounce',
        timer: setTimeout(() => {
          groupTimers.delete(groupId);
          // Judged when the timer fires, not when it was set: the window may have
          // opened or lapsed during the debounce.
          const inWindow = groupContext.isWindowOpen(groupId);
          void maybeGroupReply(groupId, inWindow ? { reason: '对话窗口内' } : {});
        }, config.policy.group.debounceMs),
      },
    );
  }

  /**
   * Speak up in a group, if the gates allow it.
   *
   * @param {string} groupId
   * @param {{addressed?: boolean, reason?: string, message?: object}} [options]
   *   `addressed` marks a message aimed straight at the bot (keyword or
   *   second-person follow-up): it ignores the message-count gate. `message` is
   *   the triggering message, whose images are fetched for the model.
   */
  async function maybeGroupReply(groupId, { addressed = false, reason, message } = {}) {
    const conversationKey = sessionIdFor({ scene: 'group', targetId: groupId });

    // Never start a reply on top of a turn that is already running: the two
    // share one session queue, so the unrequested turn would delay a real one.
    if (runner.isBusy(conversationKey)) {
      log.debug(`群 ${groupId} 有会话正在进行，推迟回复`);
      return;
    }

    const inWindow = groupContext.isWindowOpen(groupId);
    const cooldownMs = addressed || inWindow
      ? config.policy.group.engagedCooldownMs
      : config.policy.group.cooldownMs;

    if (!groupContext.shouldSelfReply(groupId, Date.now(), { skipMinMessages: addressed, cooldownMs })) {
      const stats = groupContext.stats(groupId);
      log.info(
        `群 ${groupId} 暂不回复（待处理 ${stats.pending} 条，需 ${config.policy.group.minMessages} 条；` +
        `冷却 ${cooldownMs}ms${inWindow ? '，对话窗口开' : ''}）`,
      );
      return;
    }

    // ---- 「读空气」:别人还在连着说话时**别插话**(2026-09-30,D72) ----
    //
    // 这道闸补的是既有闸门**看不见的那一半**:防抖管"消息安静了几秒",
    // 冷却管"我上次开口多久了",**没有一个在看"别人是不是还在你一句我一句"**。
    // 实测的后果就是主动开口 451 次里 382 次落在串中间(见 `social-observer.js`)。
    //
    // ⚠️ 只作用于**主动开口**这条路:被 @ / 关键词 / 第二人称(`addressed`)在
    //    上面就返回了,不受影响 —— 真人被点名不会"读空气"读到不回答。
    if (!addressed && config.policy.group.gapMs > 0) {
      const nowMs = Date.now();
      const lastHumanAt = lastGroupHumanAt.get(groupId) ?? null;
      const decision = decideSpeakUp(
        {
          now: nowMs,
          lastHumanAt,
          ownMessageAt: lastBotUtteranceAt.get(groupId) ?? null,
          pending: groupContext.stats(groupId).pending,
        },
        { gapMs: config.policy.group.gapMs, maxWaitMs: config.policy.group.gapMaxWaitMs },
      );
      if (decision.verdict !== 'speak') {
        // 判据进日志(诊断工具不许说谎):为什么没开口,一行说完。
        log.info(`群 ${groupId} 读空气：${decision.verdict === 'wait' ? '先等等' : '不开口'} —— ${decision.reason}`);
        if (decision.verdict === 'wait') {
          // **等串断掉再重试**,而不是把这条消息丢掉:真人也是这样,等别人说完了再接。
          // 只排一次(复用防抖那个槽),而且 unref —— 它不该独自撑住事件循环。
          //
          // ⚠️ **但自发重查必须有上限**(D90,2026-10-01 现场):实测一个群 15 分钟重查了 **8 次**
          //    —— 因为有人在连发消息,"串"反复看起来是断的;每次重查都是一次**可能发言**的机会,
          //    群里看到的就成了"她也跟着刷"。这跟"想发多少看模型心情"是同一类病:没有上限。
          //    上限只作用于**这条路**(没人点名时的自发重查);被 @ / 关键词 / 戳一戳在上面就返回了。
          const recheck = decideRecheck({
            lastRecheckAt: lastSocialRecheckAt.get(groupId) ?? null,
            now: nowMs,
            minMs: config.policy.group.recheckMs,
            skips: socialRecheckSkips.get(groupId) ?? 0,
          });
          const waitMs = Math.max(1000, Math.min(
            config.policy.group.gapMs - (nowMs - (lastHumanAt ?? nowMs)),
            30_000,
          ));
          if (!recheck.allowed) {
            log.info(`群 ${groupId} 读空气：不自发重查 —— ${recheck.reason}`);
          } else if (!groupTimers.get(groupId)) {
            lastSocialRecheckAt.set(groupId, nowMs);
            const timer = setTimeout(() => {
              groupTimers.delete(groupId);
              // ⚠️ **`addressed` 必须一起带过去**(2026-10-09 修的):读空气只是"等串断掉再开口",
              //    它**没有改变**"这一轮是有人在跟她说话"这个事实。丢了它,重试那次就变成
              //    "纯主动发言" → 答话被情绪上限砍掉(现场就在这条路上)。
              void maybeGroupReply(groupId, { reason: '串似乎断了，再看一眼', addressed });
            }, waitMs);
            timer.unref?.();
            groupTimers.set(groupId, { timer, kind: 'social-wait' });
            log.info(`群 ${groupId} 读空气：${Math.round(waitMs / 1000)} 秒后自发重查一次（${recheck.reason}）`);
          }
        }
        return;
      }
      log.info(`群 ${groupId} 读空气：可以开口 —— ${decision.reason}`);
    }

    // ---- 参与状态机(1.170.0 / D277):自发开口按「观望/试探/活跃/退场」档调制 ----
    // ⚠️ 铁律:只拦**自发**。`addressed`(关键词/第二人称)是有人提到她 = 被叫族,
    //    不拦;真正的 @ 事件在 handleMessage 里另走一条,根本不经过这里。
    //    退场档 = 全静一个冷却期,把话语权还给群;观望/试探 = 概率打折,不是失联。
    // ⚠️ 摆在读空气**之后**(双审 Y3,回到 D277 原顺序):先判"该不该插话",
    //    再掷参与档 —— 被读空气挡住的轮次不该先消耗一次状态骰、刷一遍状态日志。
    if (!addressed) {
      const social = socialState.modulationFor(groupId);
      if (social.self <= 0) {
        // 双审 Y2:30 秒一拍的群,一次退场期能把这条 info 刷几十遍。按退场期
        // (`snapshotOf().since`,同一次退场内不变)去重 —— 换了新退场期自然再喊;
        // 转移日志与 debug 不受影响,没有新增阈值参数。
        const snap = socialState.snapshotOf(groupId);
        if (retreatLoggedSince.get(groupId) !== snap.since) {
          retreatLoggedSince.set(groupId, snap.since);
          log.info(`群 ${groupId} 参与状态 ${social.state}：自发开口全静（退场冷却中），这次不出门`);
        }
        return;
      }
      if (social.self < 1 && Math.random() >= social.self) {
        log.info(`群 ${groupId} 参与状态 ${social.state}：没中自发档（×${social.self}），这次不出门`);
        return;
      }
    }

    await semaphore.acquire();
    try {
      const context = groupContext.render(groupId);
      const prompt = [
        '[群聊] 下面是群里最近的消息。你可以自然地接一句，也可以选择不发言。',
        '场合是群聊：别把私聊的内容带进来，也别逐条点评。',
        ...(reason ? ['', `注意：${reason} —— 这是在说你，接话是自然的。`] : []),
        '',
        context,
        '',
        `如果没什么想说的、或者插话会显得突兀，就只回复 ${SILENT_TOKEN}。`,
      ].join('\n');

      // A debounce-triggered reply has no triggering message of its own, so it
      // uses the newest one — otherwise a meme would reach the model as a bare
      // "[图片]" placeholder and it could not react to it at all.
      // ⚠️ 2026-10-02 起还要把**时间窗内其他消息的图**一起带上:自发接话本来就是
      //    "接群里刚才那几句",而那几句里的图只喂最后一条的话,照样会漏(见 `conversationImageCarry`)。
      const source = message ?? lastGroupMessage.get(groupId);
      const selfCarried = carriedConversationSources(groupId, source);
      const selfSources = [source, ...selfCarried].filter((entry) => entry?.images?.length);
      const imageBlocks = selfSources.length > 0
        ? await fetchImageBlocks(selfSources.flatMap((entry) => entry.images), {
            maxImages: config.policy.maxImages,
            onSkip: (image, err) => log.warn(`跳过图片 ${image?.filename ?? '(无文件名)'}：${describeError(err)}`),
          })
        : [];
      if (imageBlocks.length > 0) {
        log.info(
          `自发回复附带 ${imageBlocks.length} 张图片` +
          (selfSources.length > 1 ? `（来自 ${selfSources.length} 条消息，窗内补图）` : ''),
        );
      }

      // Self-initiated: the mood may come from a topic in the buffered chatter,
      // so the newest message is offered to the mood detector too.
      const mood = moodFor(conversationKey, source?.content ?? '');
      // 自己接话也要掷:她主动开口时"顺嘴提一句刚接的委托"最自然。
      const ledger = rollEconomy({ scene: 'group', proactive: true });
      const turnHasImage = imageBlocks.length > 0;
      const turnHasBackgroundImages = selfCarried.length > 0;
      const result = await runner.runTurn(
        conversationKey,
        withStyleNudge(prompt, await turnNotes(mood, source, ledger, null, {
          // 注入与结算同口径(2026-10-23,同答话路):窗内旧图只作背景,不灌"图=投喂"教学。
          hasImage: turnHasImage && !turnHasBackgroundImages,
          backgroundImages: turnHasBackgroundImages,
        })),
        config.policy.replyTimeoutMs,
        imageBlocks,
      );

      // The model call happened either way, so the gates reset either way —
      // otherwise a silent decision would be re-asked on the very next message.
      groupContext.noteReply(groupId);
      groupContext.clear(groupId);

      if (result.timedOut) {
        log.warn(`自发发言超时，跳过（群 ${groupId}）`);
        return;
      }
      if (isSilentReply(result.text)) {
        // 看了但不想说 → 下次自发重查的间隔拉长一档(D90)。
        socialRecheckSkips.set(groupId, (socialRecheckSkips.get(groupId) ?? 0) + 1);
        log.info(`群 ${groupId}：模型选择不发言（连续 ${socialRecheckSkips.get(groupId)} 次，自发重查会退避）`);
        return;
      }
      // 真开口了 → 退避清零:她愿意说,说明这个节奏是对的。
      socialRecheckSkips.delete(groupId);

      // ⚠️ **这一轮是不是"有人跟她说话"**(2026-10-09):`addressed` 是排这条回复时就带来的
      //    (@ / 关键词 / 第二人称 / 读空气重试——见下面 `maybeGroupReply` 的注释);
      //    这里再兜一层第二人称判据,**复用同一个** `looksAddressedToBot`(不许写第二份判断)。
      const answering = addressed || looksAddressedToBot(source?.content ?? '', config.policy.group.addressMarkers);
      // ⚠️ 1.106.2(D174):**答话(answering)原样一条**,纯主动发言按短句分条发 ——
      //    判断只此一处(`planSpokenLines` 里的 `addressed`),与 D171 那条"答话不截"同源。
      const lines = planSpokenLines(
        composeReply(result, source, {
          // ⚠️⚠️ **2026-10-09 修的用户现场**:自发接话那条路,`imageBlocks` 里装的往往是
          //    **时间窗内别人的图**(`selfCarried`,背景图)——那图**根本不是发给她的**。
          //    旧写法把 `hasImage: turnHasImage` 一概传下去,于是「窗内补图 = 有人投喂她」
          //    → 静默 +12 饱食。现场:`22:43:38 meal 饱食+12` / `22:43:58 meal 饱食+12`,
          //    她那两轮一个字没说吃,用户在群里问「**饱食度？你哪儿来的饭——说清楚**」。
          //    现在的口径:**自发接话时,只有她这一轮真正"收到的"图才算投喂**;
          //    窗内补进来的旧图只作背景看(她能评论,但不当饭)。
          hasImage: turnHasImage && !turnHasBackgroundImages,
        }),
        mood,
        // 1.171.0 / D288:`addressed` 选项退役 —— 答话与纯主动**同一份**分条规划;
        // `answering` 只留给下面的日志与状态机分类。
        { label: '自发发言' },
      );
      const synthetic = { scene: 'group', targetId: groupId, messageId: undefined, content: '' };
      await sendSpokenLines(synthetic, lines, { typing: true });
      // 参与状态机(D277):这轮算不算"她找话"——判据只用本轮**真实被叫**(`addressed`:
      // @ / 关键词 / 私聊 / 读空气重试),不拿 `answering`(它还含"正文像在对她说"的宽判据,
      // 那是**排版**用的)。拿 answering 当分类会把"没人叫、她自己凑上去"记成答话,
      // 于是那几次永远不建立 ignored 窗口、永远数不到退场(双审 Y6)。
      // 纯主动 = 自发开口,回应窗口过后没人接就喂 noteIgnored(定时器 unref,不撑循环;
      // 若窗口内有人接,noteGroupMessage 已把 lastSelfSpokeAt 清掉,noteIgnored 自己会认出
      // "这次已经被接过了"而直接不数)。
      const spokeAt = Date.now();
      socialState.noteSpoke(groupId, { selfInitiated: !addressed }, spokeAt);
      if (!addressed) {
        const ignoredTimer = setTimeout(() => {
          socialState.noteIgnored(groupId, Date.now(), { spokeAt });
        }, socialState.config.answeredWindowMs + 1_000);
        ignoredTimer.unref?.();
      }
      log.info(
        `自发发言 群=${groupId} ${lines.length} 条 / 共 ${lines.reduce((sum, one) => sum + one.length, 0)} 字` +
        `${answering ? '（答话）' : '（主动）'}${reason ? `（${reason}）` : ''}（主动消息）`,
      );
      recordTurn('self', {
        conversationKey,
        scene: 'group',
        userText: source?.content ?? reason ?? '',
        replyText: lines.join('\n'),
      });
    } catch (err) {
      log.error(`自发发言失败 群=${groupId}`, err);
    } finally {
      semaphore.release();
    }
  }

  gateway.on('message', (message) => {
    void handleMessage(message);
  });
  // 有人入群 → 收进名册(2026-10-09)。⚠️ 这是**内邀白名单之外唯一**能让"还没开口的人"有名字的入口
  // (官方 `GET /v2/groups/{id}/members` 存在但要白名单,错误码 11253;见 `qq.js` 那段注释)。
  // 用 `touchPerson` 而不是自己写一遍写库逻辑 —— `person` 表的显示名规则只留一处(D159)。
  gateway.on('memberJoined', ({ groupId, memberId, username } = {}) => {
    try {
      // ⚠️ 昵称可能是空的(官方 schema 没承诺它一定非空)—— 空名照记(人先挂上),别写空串覆盖已有的。
      stateStore.touchPerson({
        scope: `group:${groupId}`,
        openid: String(memberId),
        display: username ? String(username) : null,
        scene: 'group',
      });
      if (!username) log.info(`群里来了新人（这一轮没给昵称），先记下 openid ${String(memberId).slice(0, 8)}… —— 等他开口再补名字`);
    } catch (err) {
      log.warn(`把新人收进名册失败（不影响对话）: ${describeError(err)}`);
    }
  });
  gateway.on('ready', (data) => {
    log.info(`机器人已就绪：${data?.user?.username ?? 'unknown'}`);
    // 上线之后才有机器人昵称(出站清洗要用),所以播报挂在这里而不是 main() 末尾。
    // 手动模式下**不发** —— "什么时候播报由我说了算"就是这个意思。
    if (config.policy.announce.trigger !== 'manual') void announceTick();
  });
  gateway.on('fatal', (err) => {
    log.error('网关发生致命错误', err);
    void shutdown(1);
  });

  runner.on('exit', (code, signal) => {
    // A child exit during our own teardown is expected, not a failure.
    if (shuttingDown) return;
    // ⚠️ 2026-09-27:两只机器人都在 `DSH 运行时已就绪` 之后**约 1 秒**没了,
    // 日志里一个 error 都没有 —— 而这一行是唯一能说明"DSH 子进程是怎么死的"的地方。
    // 所以把 code / signal 也打出来:它们能区分
    //   ① 子进程自己正常退出(code 0)→ 运行时内部认为该结束了
    //   ② 被信号杀死(signal 非空)→ 外部有人动了它
    //   ③ 带着非零 code 崩了 → 它自己的错
    log.error(
      `DSH 进程意外退出，bridge 无法继续工作（code=${code ?? 'null'} signal=${signal ?? 'null'}）`,
    );
    void shutdown(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log.info(`收到 ${signal}`);
      void shutdown(0);
    });
  }

  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', reason instanceof Error ? reason : new Error(String(reason)));
  });

  /**
   * 面板要读的 `meta` 行(钓位 / 看板 / 熟人 / 病态)。
   * ⚠️ 一律走 `PANEL_META_PREFIXES`,别在这里手抄一份前缀 —— 抄的那份一定会腐烂
   *    (1.65.1 复核就抓到过"面板读错了键,于是永远看不到她生病")。
   */
  function readPanelMetas() {
    const rows = [];
    for (const prefix of PANEL_META_PREFIXES) {
      try {
        for (const row of (stateStore.listMetaKeys(prefix) ?? [])) {
          rows.push({ key: row.key, value: row.value });
        }
      } catch (err) {
        log.warn(`面板列 meta 失败（${prefix}）: ${describeError(err)}`);
      }
    }
    return rows;
  }

  /**
   * **别的旅伴的事实**(2026-10-11 第四轮 / D190)——给面板的「旅伴」那一栏用。
   *
   * ⚠️ 三条刻意:
   *   ① **只读**:`readCompanionFacts` 用 `node:sqlite` 的 `readOnly: true` 打开另一只的
   *      `state.db`(实测 WAL 也能读)。**一个字节都不写** —— 两只 bot 各自是唯一写者(D143)。
   *   ② **这一只自己不走这里**:它的数值/位置由 `buildSnapshot` 从**同一个** stateStore 现算,
   *      再摸一次自己的库等于把同一件事读两遍(还可能跨过时间边界,变成"两个她")。
   *   ③ **读不到不是错误**:另一只没在跑 / 库在建 → 面板上如实标"没在跑",绝不猜、绝不补假事实。
   */
  function readOtherCompanions() {
    const out = {};
    const mine = String(config.policy?.mood?.theme ?? '');
    const dataRoot = path.dirname(String(config.state?.file ?? path.join(ROOT_DIR, 'data', 'state.db')));
    for (const one of COMPANIONS) {
      if (one.theme === mine) continue;
      try {
        out[one.id] = readCompanionFacts(one.stateDir, dataRoot, { now: Date.now(), log: (line) => log.warn(line) });
      } catch (err) {
        out[one.id] = { live: false, note: '没在跑（读不到它的状态库）' };
        log.warn(`旅伴：读 ${one.id} 的库失败（不影响这一只）: ${describeError(err)}`);
      }
    }
    return out;
  }

  // **美图展览处**(2026-10-23 / 展览处刀 2):元数据库在本进程只开**一份**。
  // 三种运行角色(写入方与面板读取方可以是不同实例):
  //   · 开了美图线的那只(现 = 副实例):**写连接** —— 抓图落库 / recordSent / 回填都用它;
  //   · 只开面板那只(现 = 主实例):**只读连接**展览同一份元数据库
  //     (双进程"一写多读"打开同一个 SQLite 是安全的;单写者的归属口径见 D306);
  //   · 回滚总闸 `QQBOT_GALLERY=0`:**哪只都认**(面板那只也停,三条路由 503)。
  // 打不开只 warn —— 不影响 QQ(写那只美图指令照旧出图,只是不记热度)。
  const meituWantsWrite = config.meitu?.enabled === true;
  const meituWantsPanel = config.policy?.panel?.enabled === true;
  if (config.meitu?.gallery !== false && (meituWantsWrite || meituWantsPanel)) {
    try {
      meituGallery = openMeituGallery({ dbPath: config.meitu.db, readOnly: !meituWantsWrite });
      log.info(
        `美图展览处：元数据库就绪 ${config.meitu.db}`
        + `（${meituWantsWrite ? '写连接' : '只读连接'}${meituWantsPanel ? ' + 面板展览' : ''}）`,
      );
    } catch (err) {
      meituGallery = null;
      log.warn(`美图展览处：元数据库打不开，展览处 API 关着（不影响 QQ）: ${describeError(err)}`);
    }
  } else if (config.meitu?.gallery === false) {
    log.info('美图展览处：QQBOT_GALLERY=0 —— 只读 API 关着（回滚总闸）');
  }

  gateway.start();
  log.info('bridge 已启动，等待 QQ 消息…');

  // **面板**(D107 第②步只读 → D110 第③步加动作):默认关、只听本机。
  // ⚠️ 面板**自己不推进任何状态**:
  //    · 读 —— 把 `state.db` 里的事实渲染给第二个前端;
  //    · 写 —— 唯一一条 `POST /api/actions`,交给 `createActionExec()`,
  //      它走内核 `applyAction()` + **同一个钓鱼适配器**(于是 QQ 与面板共用同一份判定),
  //      而结账仍然过绑定表(D102)、同一个 nonce 只执行一次(D110)。
  // ⚠️ 已通过入口依赖检查后的运行时失败仍不影响 QQ；缺件/坏件已在启动前大声拒绝。
  //    这里的装配包在 try 里，`startPanel()` 自己也会接 `error` 事件。
  if (config.policy.panel?.enabled) {
    try {
      const actionExec = createActionExec({
        store: stateStore,
        appId: config.qq.appId,
        sleep: config.policy.warmup.sleep,
        log,
        // ⚠️ **网页上接委托也要淋雨吹风**:和 QQ 那条路走**同一段副作用**(D141)。
        //    不注入的话,两条渠道的规则就不一样了 —— 那种偏差不会报错,只会让人以为一边坏了。
        onQuestTaken: ({ row }) => tryCatchIllness('commission', row?.tier),
      });
      // **账号系统**(第 0 步 / D132):表在 `state.db`(见 sqlite-store.js 的 SCHEMA),
      // 登记/登录/找回全在 `src\player-account.js`;面板只负责把那几条接口接上。
      // ⚠️ 它自己**不制造入口**:注册要邀请码,而邀请码得在机器上跑
      //    `node scripts\account.js invite-new` 才有 —— 所以默认开着是安全的。
      const accounts = config.policy.accounts?.enabled === false
        ? null
        : createAccountService({
          store: stateStore,
          openRegistration: config.policy.accounts?.openRegistration === true,
          // ⚠️ D183 第二刀:站长名单 —— 档位是**派生**的(见 player-account.js 的 tierFor)。
          //    开放注册之后,"不填邀请码"进来的账号 = `readonly`(能看不能动手)。
          staff: config.policy.accounts?.staff ?? [],
          log: (line) => log.info(line),
        });
      // ⚠️ **身份绑定**(D / 1.97.0 / D158):网页账号 ↔ QQ 的那个人。
      //    面板(发口令)与 QQ(核销口令)是**同一份东西** ——
      //    上面那个 `identityLinks` 在 `main()` 里建过一次,这里共用。
      // —— 积分账本(1.115.0 / D203)——
      // ⚠️ 充值服务 payService / 到账密钥 QQBOT_PAY_NOTIFY_SECRET / onPayNotice 私聊提醒
      //     已于 2026-10-23 随「充值退役转公益站」删除:公益站没有代码层交易,
      //     `createPayService` 不再装配(申报单/到账配对/人工核账整条链路退役)。
      const creditsService = createCredits({ store: stateStore, log });
      /**
       * **梦境档的 client**(1.127.0 / D227;1.153.0 改成可热替换薄壳)。
       * ⚠️ 没配 = `isConfigured('dream')` 为 false —— /api/dream 全部 503
       *    `dream_unconfigured`,页面如实说“梦境还没配 key”;key 本身不进日志、不出网。
       * ⚠️ 它**不**从 bot slot 回退:用户拍板“梦境没配就 503,不偷偷花 bot 的钱”。
       */
      const dreamLlmClient = llmSettings.scoped('dream');
      panelServer = startPanel({
        config,
        actionExec,
        accounts,
        identityLinks,
        // 生命体征(1.168.0 / D275):/api/ping 带票时带出快照(只有计数与时刻) ——
        // 一期只记录/暴露供人工查看,不接自动告警;无票200裸ok/at,不带vitals(D183)。
        bridgeVitals: () => {
          const snap = vitals.snapshot();
          return { ...snap, ...judgeStaleness(snap, { now: Date.now() }) };
        },
        // ⚠️ **玩家在世界里的位置**(D 收尾 / 1.99.0):一条与"她"同构的事实
        //    (`world:player:<id>`);`herFact` 让"你们是不是在同一处"这一眼成立。
        playerWorld: createPlayerWorld({
          store: stateStore,
          log,
          herFact: () => herWhereabouts({ metas: [{ key: WORLD_HER_KEY, value: stateStore.getMeta(WORLD_HER_KEY) ?? '' }] }),
        }),
        requireAccountForActions: config.policy.accounts?.requireForActions === true,
        log: (line) => log.info(line),
        /**
         * **有人给站长留言 → 私聊提醒操作者**(原 D183 第三件;D250 起是**信息反馈**入口)。
         *
         * 为什么走这条路:本机**没有邮件服务**,而 `/feedback` 那张页是给陌生人填的 ——
         * 没有这条提醒,留言就只是躺在库里(站长永远不知道)。
         * ⚠️ 尽力而为:发不出去只记日志,不影响留言人那一侧(他已经看到"已收到")。
         */
        onAccessRequest: async (row) => {
          const operator = operatorIds().values().next().value ?? null;
          if (!operator) {
            log.info(`反馈 #${row?.id ?? '?'}：没有可用的操作者私聊 —— 通知没发出去（留言已入库）`);
            return;
          }
          const lines = [
            `收到一条反馈（#${row?.id ?? '?'}）`,
            row?.nickname ? `他自称：${row.nickname}` : null,
            row?.account ? `账号：${row.account}` : null,
            `联系方式：${row?.contact || '(没留)'}`,
            row?.note ? `他说：${row.note}` : null,
            '→ 后台「反馈收件箱」里处理',
          ].filter(Boolean);
          await api.sendDirect(operator, { content: lines.join('\n') });
          log.info(`邀请申请 #${row?.id ?? '?'}：已私聊提醒操作者`);
        },
        // ⚠️ **D 那一刀:网页聊天**(1.96.0)—— 和 QQ 那条路走**同一个内核**:
        //    同一个 runner、同一张角色卡、同一套 `turnNotes`(身体/投喂/好感/钓鱼情景/事件钩子)、
        //    同一份 `memory.db`(recordTurn 与 QQ 走同一个函数)。
        //    于是"她在网页上记得你"这件事**自动成立**,而不是另写一套。
        // ⚠️ **群聊房间**(1.101.0 / D164):她也在房间里说话 —— 走的是**同一段内核**
        //    (`runWebChatTurn`),只是会话键换成 `room:<roomId>`
        //    (⚠️ 于是**整间房共用一段记忆**,与 QQ 群同一个形状)。
        // ⚠️ **角色卡**(1.104.0 / D168):捏人是**写路径**,要账号(与私聊/房间同一条理由)
        characters,
        // ⚠️ **积分账本**(1.115.0 / D203):网页聊天按档限额,超出扣积分 ——
        //    与账号同一家状态库(subject 按账号/游客分本,严禁串台),面板只管闸门与展示。
        credits: creditsService,
        // 充值 pay / paySecret 两项注入已随充值退役删除(2026-10-23)。
        // **梦境**(1.127.0 / D227 追加二):存储(buildSnapshot 无关,单独一份表)
        // + 模型客户端(薄壳;没配时 isConfigured=false —— 面板按 503 dream_unconfigured 如实说)。
        dreams: createDreamStore({ store: stateStore }),
        dreamLlm: dreamLlmClient,
        // **模型接入**(1.153.0):两套配置的读写/测试/热替换都在这份服务里;
        // 面板只调它,不自己碰文件、不碰 DPAPI。
        llmSettings,
        // W4 记忆检修台(P2-C)挂载 —— 全文只有这一行:两个库的**现有连接**原样递过去
        // (memoryDb 可能因初始化失败是 null,服务自己会按"检修台关着"降级);逻辑在 src\memory-console.js。
        memoryConsole: createMemoryConsole({ memoryDb, store: stateStore, log: (line) => log.info(line) }),
        // **美图展览处**(2026-10-23 / 刀 2):三条只读路由(`/api/meitu/list|item|file`)。
        // null(没开美图线 / QQBOT_GALLERY=0 / 库打不开)→ 三条一律 503(回滚总闸)。
        meituGallery,
        meituThumbsDir: config.meitu?.thumbs ?? null,
        // onPayNotice(到账/无主到账私聊操作者)已随充值退役删除(2026-10-23);
        // 以后有人转账赞助,靠桌面控制台「反馈收件箱」与主人自己的到账通知人工致谢。
        // ⚠️ **`rooms` 与 `roster` 两项注入已删除**(2026-10-14 / D229):它们只服务网页群聊房
        //    (`createRoomService` + 面板的"成员名单")—— 那一栏下线后这两项没有任何消费者了。
        //    面板那一侧不再接受这两个参数(见 panel.js 的 startPanel 参数表)。
        chat: createWebChat({
          store: stateStore,
          // ⚠️ 一次只能说一句:她忙的时候直接拒(服务端不当队列 —— 队列会让"她同时在两个世界说话")
          runTurn: async ({ conversationKey, text, name }) => {
            if (runner.isBusy(conversationKey)) {
              return { text: '', timedOut: true, busy: true };
            }
            const message = { scene: 'web', targetId: String(conversationKey).slice(4), senderId: String(conversationKey).slice(4), senderName: name || null, content: text, source: 'web' };
            const reply = await runWebChatTurn(message);
            // 1.171.0 / D288:`segments` 带给存储层 —— 每段一行,网页上一泡一条。
            return { text: reply.text, segments: reply.segments, timedOut: !String(reply.text ?? '').trim() };
          },
          log,
        }),
        // ⚠️ **每次请求现读隧道状态**(D121):临时隧道换了网址,面板不用重启也跟着认。
        //    这两项合起来把"重启电脑后要人工改 .env + 重启 bot"那一步消掉了。
        dynamicHosts: () => dynamicAllowedHosts({ base: config.policy.panel?.allowedHosts ?? [], rootDir: ROOT_DIR }),
        dynamicPublicUrl: () => readTunnelState(ROOT_DIR)?.url ?? null,
        // ⚠️ 立绘(MC 皮肤)放哪儿:**桥的根目录**,不是 cwd(见 `startPanel` 那段注释)。
        assetsDir: ROOT_DIR,
        // **头像目录**(2026-10-13 / D228):`data/<bot>/avatars` —— bot 头像与群头像
        // 就是操作者往这儿放文件;用户上传由面板写进 user/ 子目录。
        // ⚠️ 键是 `config.policy.stats.dbFile`(状态库的绝对路径,见启动横幅"库=…")——
        //    用它的 dirname 现算"这一只的 data 目录"。
        avatarDir: path.join(path.dirname(String(config.policy?.stats?.dbFile ?? path.join(ROOT_DIR, 'data', 'state.db'))), 'avatars'),
        snapshot: () => {
          const now = Date.now();
          let current = null;
          try { current = stateStore.getStats(now, { sleep: config.policy.warmup.sleep }); } catch (err) {
            log.warn(`面板读数值失败: ${describeError(err)}`);
          }
          let condition = null;
          try { condition = readCondition(); } catch { condition = null; }
          // 编年史要**流水**(`stats_event`)—— 它是"发生了什么"的唯一来源(纯派生,不新开存储)
          let events = [];
          try { events = stateStore.recentStatsEvents(60); } catch (err) {
            log.warn(`面板读流水失败（编年史会空着）: ${describeError(err)}`);
          }
          return buildSnapshot({
            config,
            stats: current,
            condition,
            metas: readPanelMetas(),
            events,
            now,
            companionFacts: readOtherCompanions(),
            // ⚠️ 立绘在不在 + **内容版本号** —— 由装配层读磁盘(纯函数那一层不认识文件系统)。
            //    版本号进立绘 URL 的 `?v=`:换皮 = 换地址,浏览器/公网缓存当场失效(D218)。
            //    ⚠️ **整个展开**:助手返回的两个键名就是 buildSnapshot 的参数名 ——
            //    1.120.5 我把它们塞成一个 `{exists, tags}` 大对象传下去,下游按 id 取到 undefined,
            //    两张卡都写「立绘还没放进来」(1.121.1 才被用户当场抓到)。形状不再由人手拼。
            ...companionSkinState(ROOT_DIR),
          });
        },
      });
      // ⚠️ 这一行是**账号系统的启动横幅**:它在 `startPanel()` 之后、同一个 try 里 ——
      //    引用的是这个块里的局部名,所以"真启动能打出这一行"同时证明了
      //    "服务建起来了"与"账号那套装配没炸"(单测不跑 main(),看不到这一段)。
      if (accounts) {
        log.info(
          `账号：登记入口 /account 就绪（玩家 ${accounts.countPlayers()}，邀请码 ${accounts.countInvites()}；`
          + `注册${config.policy.accounts?.openRegistration === true ? '**不用**邀请码' : '要邀请码'}；`
          + `互动${config.policy.accounts?.requireForActions === true ? '要' : '不要求'}账号）`,
        );
      }
    } catch (err) {
      log.warn(`面板没起来（不影响 QQ）: ${describeError(err)}`);
    }
  }

  // 启动时的一次性清理:**1.57 之前按会话存的旧钓位**(`fishing:group:<群id>`)。
  // ⚠️ 放在**启动时**而不是 tick 里:那些旧的到点会自己收网(用户会莫名收到"上钩了"),
  //    而 tick 要等一个周期才跑 —— 启动就清掉,窗口最小。
  cleanupLegacyFishing();

  /**
   * **她走到地方了**(1.92.0 / D148):路上那一段的收尾。
   *
   * ⚠️ 为什么要有这一拍:位置事实是"**到点就变**"的那种 —— 出发时写的是"正往公会走
   *    (arriveAt=…)",到点之后得有**一个人**把它落成"她在公会"。这个人就是 tick
   *    (页面与聊天都不该负责改事实:它们只读)。
   * ⚠️ 只动 `world:her` 一个键;写失败**不影响任何别的 tick**(位置是"看得见"那一层)。
   */
  function travelTick() {
    try {
      const raw = stateStore.getMeta(WORLD_HER_KEY);
      if (!raw) return;
      let current = null;
      try { current = JSON.parse(raw); } catch { return; }
      const next = settleTravel(current, { now: Date.now() });
      if (!next) return;
      // ⚠️ 1.92.1:落地那一刻要记下**两件事**(它们让"到了"能被报备一次):
      //    `arrivedAt` = 到达时刻;`why` = 这一趟是**谁**让她走的(`self` = 她自己走的一趟)。
      //    两个字段都长在同一条事实里(一个写者一次写)。
      stateStore.setMeta(WORLD_HER_KEY, JSON.stringify({
        ...next,
        arrivedAt: Number(next.since) || Date.now(),
        why: current.why ?? null,
      }));
      // ⚠️ **不动挂起的钩子**:那个"等她回话"的小事件有它自己的 `expiresAt`,
      //    到点由 `storyTimeoutTick()` 按"她自己决定走向"收尾 —— 在这里顺手清掉
      //    等于把"她可能已经处理过这件事"的账抹了(那是"有没有结局"的问题,不是位置问题)。
      log.info(`她走到了：${next.placeName}（${next.doing}）`);
    } catch (err) {
      log.warn(`在途收尾失败（不影响别的 tick）: ${describeError(err)}`);
    }
  }

  // 手动播报不占定时器:她只在 `/更新` 时才发,没必要每 30 秒醒一次去确认"还是不发"。
  const autoAnnounce = config.policy.announce.enabled && config.policy.announce.trigger !== 'manual';
  // ⚠️ 记忆那一拍也算一个理由:D77 起"补归档"挂在这个 tick 上,
  // 所以哪怕暖群/早安/自动播报全关,只要记忆开着,这个定时器就得存在。
  // ⚠️ D99 阶段 2 起 **「她自己的生活在转」也是这个 tick 的理由**(用户选的正是它接替暖群):
  //    它默认开着,所以"暖群关了就没定时器"这件事不能发生。
  if (
    config.policy.warmup.enabled || config.policy.morning.time || autoAnnounce
    || archiveRunner || config.policy.selfcare?.enabled
  ) {
    warmupTimer = setInterval(() => {
      // ⚠️ **卡住告警**(2026-10-03):上一拍还没跑完就又进来一次 = 有 await 挂住了。
      //    现场见过一次:tick 卡住 13 分钟、日志一行不写、钓鱼"收杆"做不下去,而进程还活着。
      //    所以这里既报出来,也**不让新的那一拍叠上去**(否则会同时有几个 tick 抢 semaphore)。
      if (tickBusy) {
        log.warn(`定时器：上一拍还没跑完（已 ${Math.round((Date.now() - tickStartedAt) / 1000)} 秒）—— 有对外调用挂住了`);
        return;
      }
      tickBusy = true;
      tickStartedAt = Date.now();
      void (async () => {
        try {
          await morningTick();
        await warmupTick();
        // 「她自己的生活在转」:饿了自己去吃饭并报备(D99 阶段 2)。
        await selfCareTick();
        // **她走到地方了**(1.92.0):在途那一份位置事实到点落地 —— 这一步纯本地,不碰网。
        travelTick();
        // 事件钩子的**超时自决**(D99 阶段 3):抛出去没人答的,过点由她自己收尾。
        await storyTimeoutTick();
        // **钓鱼收网**(D101 形态三):**只看钟** —— 等待期间聊什么都不影响它。
        await fishing.tick();
        // **病程**(D103 接线):病着的时候健康按时往下掉,到点/治好了就收尾。
        await illnessTick();
        // **群清单每天更新一次**:她已经不在的群要摘掉(否则播报会一直发失败)。
        await groupAuditTick();
        // 睡眠时段挡下的播报会在这里补发。
        if (autoAnnounce) await announceTick();
        // 让"今天说过的话"当天就能进长期层(否则要等下次重启)。
        memoryArchiveTick();
        // "回头":把最近值得记的事固化成中期/长期记忆(每 N 小时一次)。
        memoryConsolidateTick();
        // 指标点的保留策略(一天最多动一次,见 metricsTick)。
        metricsTick();
        } finally {
          tickBusy = false;
        }
      })();
    }, config.policy.warmup.tickMs);
    // Do not let the schedule alone keep the process alive.
    warmupTimer.unref?.();
  }
}

const IS_MAIN = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  main().catch((err) => {
    log.error('bridge 启动失败', err);
    process.exit(1);
  });
}

