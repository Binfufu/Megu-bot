/**
 * **能力基线采集**(P0,2026-10-28)—— 把"两只 bot 到底有什么能力"变成可对照的一份事实。
 *
 * ## 为什么需要它
 *
 * 用户体感是"协作角色不如当前角色强"。可是"弱"至少有四种来源,混在一起就永远查不清:
 *
 *   A. **部署不同**:版本 / 角色卡 / 模型 / 协议不同;
 *   B. **模型不同**:视觉、工具、推理档位的能力真不一样;
 *   C. **代码没接**:能力在代码里存在,但没接到主轮(例如工具循环还没实现);
 *   D. **提示词压住**:能力都在,但每轮的字数/风格要求把它挤没了。
 *
 * 这份脚本只回答 A 与"代码侧配置",并把 B 明确标成 **unknown**(没真发请求就不算证据)。
 * C/D 由代码判据与真实组装器取证,不在这份脚本里。
 *
 * ## 纪律
 *
 * · **绝不打印密钥**:只输出"配了没有"(boolean)与 baseUrl 的 host;
 * · **不联网**、不启动 bot、不打开状态库、不发 QQ;
 * · **不猜**:模型是否支持视觉/工具 → `unknown`,除非将来另接显式探针;
 * · 输出可存档 JSON(`--out`),两份并排 diff 就是"基线"。
 *
 * ## 用法(白云生产机,不在这台开发机)
 *
 *   node scripts\capability-baseline.mjs --env-file bots\demo\.env --persona ..\<你的工作区>\AGENTS.md --out data\index\capability-example.json
 *   node scripts\capability-baseline.mjs --env-file bots\demo\.env --persona ..\<你的工作区>\AGENTS.md --out data\index\capability-example.json
 *
 * 然后对比两份 JSON 的 `env` / `persona` / `model` 三节:
 * 差异出现在 `env` 或 `persona` ⇒ 是配置/角色卡;出现在 `model` ⇒ 是模型选型;
 * 两边完全一样却体感不同 ⇒ 去查 C/D(代码接线与提示词),别再怪模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readEnvFileValue } from '../src/bot-home.js';
import { isResponsesApi } from '../src/llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

/** 只报"有没有",绝不回显值 —— 密钥类一律走这里。 */
const presence = (value) => (typeof value === 'string' && value.trim() !== '' ? 'set' : 'unset');

/** baseUrl 只留 host + 路径尾段形态(判断协议用),把可能带 token 的 query/片段丢掉。 */
function baseUrlShape(raw) {
  if (!raw) return { configured: 'unset', host: null, looksResponses: null };
  try {
    const url = new URL(raw);
    return {
      configured: 'set',
      host: url.host,
      // 协议形态是"代码会怎么发"的事实,不是密钥;query/fragment 一律不输出。
      pathTail: url.pathname.replace(/\/+$/, '') || '/',
      looksResponses: isResponsesApi(raw),
    };
  } catch {
    return { configured: 'set', host: null, pathTail: null, malformed: true, looksResponses: null };
  }
}

/** 角色卡指纹:比内容更安全的是**只比指纹**,这样两份基线能看出"卡不一样",又不把卡复制进日志。 */
function personaFacts(personaPath) {
  if (!personaPath) return { provided: false };
  const resolved = path.resolve(personaPath);
  if (!fs.existsSync(resolved)) return { provided: true, exists: false, path: resolved };
  const text = fs.readFileSync(resolved, 'utf8');
  const heading = text.split('\n').find((line) => line.startsWith('# ')) ?? null;
  return {
    provided: true,
    exists: true,
    path: resolved,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text.split('\n').length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    heading,
  };
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** 布尔开关的**生效值**(空/未设 → 用代码默认;"0/false/off/no" 才是关)。 */
function switchOf(env, name, codeDefault) {
  const raw = env(name);
  if (raw === undefined || String(raw).trim() === '') return { value: codeDefault, source: 'code-default' };
  const text = String(raw).trim().toLowerCase();
  return { value: !['0', 'false', 'off', 'no'].includes(text), source: 'env' };
}

export function collectBaseline({ envFile, personaPath }) {
  if (!envFile) throw new Error('缺 --env-file(用哪个实例的 .env 决定读哪一份)');
  const resolvedEnv = path.resolve(envFile);
  if (!fs.existsSync(resolvedEnv)) throw new Error(`env 文件不存在:${resolvedEnv}`);
  const env = (name) => readEnvFileValue(resolvedEnv, name);
  const orNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const model = orNull(env('QQBOT_LLM_MODEL')) ?? orNull(env('QQBOT_LLM_DREAM_MODEL'));
  const baseUrl = orNull(env('QQBOT_LLM_BASEURL')) ?? orNull(env('QQBOT_LLM_DREAM_BASEURL'));
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    bridgeVersion: packageVersion(),
    envFile: resolvedEnv,
    // ① 身份与角色:两份基线最该先比的一节。
    persona: personaFacts(personaPath ?? (orNull(env('QQBOT_DSH_WORKSPACE')) ? path.join(orNull(env('QQBOT_DSH_WORKSPACE')), 'AGENTS.md') : null)),
    // ② 模型与协议:只给形状,不给凭据。
    model: {
      name: model,
      key: presence(env('QQBOT_LLM_KEY') ?? env('QQBOT_LLM_DREAM_KEY')),
      baseUrl: baseUrlShape(baseUrl),
      // ⚠️ 这两个是"代码会发什么",不是"模型支持什么"。
      reasoningEffort: orNull(env('QQBOT_LLM_REASONING_EFFORT')),
      maxTokens: orNull(env('QQBOT_LLM_MAX_TOKENS')),
      // 以下三项**没真发请求就是未知**,不许因为"名字里有 vision"就填 true。
      visionSupport: 'unknown',
      functionToolsSupport: 'unknown',
      builtinWebSearchSupport: 'unknown',
    },
    // ③ 生效开关:同一份代码、不同实例可能完全不同 —— 这是"功能不对称"的最常见来源。
    switches: {
      stats: switchOf(env, 'QQBOT_STATS', true),
      moodTheme: { value: orNull(env('QQBOT_MOOD_THEME')), source: env('QQBOT_MOOD_THEME') ? 'env' : 'code-default(megumin)' },
      groupMode: { value: orNull(env('QQBOT_GROUP_MODE')), source: env('QQBOT_GROUP_MODE') ? 'env' : 'code-default(mention)' },
      spokenSplit: switchOf(env, 'QQBOT_SPOKEN_SPLIT', true),
      knowledgeBase: switchOf(env, 'QQBOT_MEMORY_KB', false),
      memoryBlocks: switchOf(env, 'QQBOT_MEMORY_BLOCKS', true),
      memoryInsights: switchOf(env, 'QQBOT_MEMORY_INSIGHTS', true),
      meitu: switchOf(env, 'QQBOT_MEITU', false),
      engineMode: { value: orNull(env('QQBOT_ENGINE')), note: '只有 own 会真跑,其它值启动时 warn 后忽略' },
    },
    // ④ 边界类计数:只报个数,不报内容。
    scopes: {
      adminIdsCount: (env('QQBOT_ADMIN_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean).length,
      meituGroupCount: (env('QQBOT_MEITU_GROUPS') ?? '').split(',').map((s) => s.trim()).filter(Boolean).length,
      maxImages: orNull(env('QQBOT_MAX_IMAGES')),
      // 记忆作用域(P0):没配 admin 名单 ⇒ 私聊一律放行(见 src\memory-scope.js 已知残余 1)。
      memoryScopeStrictness: (env('QQBOT_ADMIN_IDS') ?? '').trim() === '' ? 'legacy-c2c-open' : 'owner-listed',
    },
    // ⑤ 明确写出这份基线**证明不了**的东西,防止自己被自己的输出骗。
    notProven: [
      '模型是否支持视觉 / 函数工具 / 内置联网:本脚本不发请求 → unknown',
      '主轮是否真的接了工具循环:由代码判据回答,不由本脚本回答',
      '提示词是否压住了能力:由真实组装器捕获回答,不由本脚本回答',
      '生产进程实际加载的版本:看 bridge-status.json 的 loadedVersion,不看仓库 package.json',
    ],
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    const baseline = collectBaseline({ envFile: argValue('--env-file'), personaPath: argValue('--persona') });
    const text = `${JSON.stringify(baseline, null, 2)}\n`;
    const out = argValue('--out');
    if (out) {
      const target = path.resolve(out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
      process.stdout.write(`能力基线已写入:${target}\n`);
    } else {
      process.stdout.write(text);
    }
  } catch (err) {
    process.stdout.write(`能力基线采集失败:${err?.message ?? err}\n`);
    process.exit(1);
  }
}
