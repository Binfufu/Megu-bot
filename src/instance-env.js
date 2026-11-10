/**
 * 可部署的「实例运行时覆盖」。
 *
 * 为什么需要它：生产两只 bot 共用同一个仓库根与 `content/`，靠 `bots/<id>/.env` 区分实例。
 * 但 deploy 通道**硬拒任何以 `.env` 结尾的文件名**，且 `bots/**` 只写 `bots/<id>/run.cmd`
 * （其余 bots 文件按 workflow 跳过）—— 所以"给某一只 bot 开一个运行时参数"没法走 .env。
 * 唯一可部署的通道是 C 区 `content/local/`（deploy 的 C 区白名单允许 `content/**`），
 * 于是覆盖文件固定为 `content/local/instance.json`，**内容按 botId 分区**，只对当前实例生效。
 *
 * 为什么"先写 process.env"就等于"优先于 .env"：`src/params.js` 的固定层次是
 * default < world-pack < content-pack < config-file < env-file < env(process)，而
 * `process.loadEnvFile` **不覆盖已存在的 process.env**（launch.js 注释里有实测记录）。
 * 所以启动器在 .env 加载之前写进 process.env 的键，会盖住 .env 里同名的值。
 * 反过来说：process.env 里**已经存在**的键（supervisor/父进程显式给的）必须保留原值 ——
 * 父进程显式环境 > 本文件 > .env。
 *
 * 严格失败（fail closed）：文件一旦存在，任何结构/键/值类型问题都抛错，由启动器响亮 bail；
 * **绝不**"跳过坏项、应用好项"，也绝不把值写进日志/错误信息（只允许键名与数量）。
 * 文件不存在 / envFile 不在 `bots/<id>/` 下 → 直接跳过，公开与旧安装行为完全不变。
 *
 * 零依赖（只用 Node 内置与仓内参数目录），IO 与目标 env、日志全部可注入，便于判据。
 */
import fs from 'node:fs';
import { CONFIG_PARAM_DEFINITIONS } from './config.js';

/** 覆盖文件在仓库里的固定相对路径；绝对路径由调用方用 ROOT_DIR 拼出来。 */
export const INSTANCE_OVERRIDE_PATH = 'content/local/instance.json';
export const INSTANCE_OVERRIDE_SCHEMA_VERSION = 1;

/** botId 的严格形状（与 `bots/<id>/` 目录名同义）。 */
const BOT_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** 日志/错误里允许原样出现的键名形状：挡住控制字符与超长注入。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

const safeName = (key) => (ENV_NAME.test(key) ? key : '非法参数名');

/** 允许被实例覆盖的参数白名单：运行时参数、且非敏感。凭据/路径/身份类（deployment）一律不在内。 */
const OVERRIDABLE = new Map();
for (const def of CONFIG_PARAM_DEFINITIONS) {
  if (def.scope !== 'runtime' || def.sensitive === true) continue;
  for (const name of def.env) OVERRIDABLE.set(name, def);
}

/** 覆盖文件问题一律这个错误（消息里不含值、不含原始文件内容）。 */
export class InstanceOverrideError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstanceOverrideError';
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * 从 envFile 路径里**严格**取 `/bots/<id>/` 的 id。
 *
 * 取不到就返回 null（调用方直接跳过）——**绝不默认成 megumin**：旧布局的根 `.env` 属于
 * 哪只 bot 是启动器的 `PRIMARY_BOT` 决定的，一个实例覆盖模块不该替它猜。
 *
 * @param {string|undefined|null} envFile
 * @returns {string|null}
 */
export function botIdFromEnvFile(envFile) {
  const match = /(?:^|[\\/])bots[\\/]([^\\/]+)[\\/][^\\/]*$/.exec(String(envFile ?? ''));
  if (!match || !BOT_ID.test(match[1])) return null;
  return match[1];
}

/** 值只接受 string/number/boolean，统一转成写进 env 的字符串（boolean → '1'/'0'）。 */
function toEnvString(key, value) {
  const label = safeName(key);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    // JSON.parse('1e999') 会得到 Infinity；进程环境里没有这种值，拒绝。
    if (!Number.isFinite(value)) throw new InstanceOverrideError(`实例覆盖文件的参数值不是有限数字：${label}`);
    return String(value);
  }
  throw new InstanceOverrideError(`实例覆盖文件的参数值类型不允许（只接受字符串/数字/布尔）：${label}`);
}

/**
 * 解析并校验整个文件（所有 bot 分区都校验，问题即整份作废）——先校验完，再允许写入。
 * @returns {Map<string, Map<string, string>>}
 */
function parseOverrideDocument(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstanceOverrideError('实例覆盖文件不是合法 JSON');
  }
  if (!isPlainObject(data)) throw new InstanceOverrideError('实例覆盖文件根节点必须是对象');
  for (const key of Object.keys(data)) {
    if (key !== 'schemaVersion' && key !== 'bots') {
      throw new InstanceOverrideError(`实例覆盖文件含未知顶层字段：${safeName(key)}`);
    }
  }
  if (data.schemaVersion !== INSTANCE_OVERRIDE_SCHEMA_VERSION) {
    throw new InstanceOverrideError(`实例覆盖文件 schemaVersion 必须是 ${INSTANCE_OVERRIDE_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(data.bots)) throw new InstanceOverrideError('实例覆盖文件 bots 必须是对象');

  const perBot = new Map();
  for (const [botId, section] of Object.entries(data.bots)) {
    if (!BOT_ID.test(botId)) throw new InstanceOverrideError('实例覆盖文件含非法 botId');
    if (!isPlainObject(section)) throw new InstanceOverrideError(`实例覆盖文件 bots.${botId} 必须是对象`);
    const entries = new Map();
    for (const [key, value] of Object.entries(section)) {
      const def = OVERRIDABLE.get(key);
      if (!def) {
        throw new InstanceOverrideError(`实例覆盖文件含未登记或不允许实例覆盖的参数：${safeName(key)}`);
      }
      entries.set(key, toEnvString(key, value));
    }
    perBot.set(botId, entries);
  }
  return perBot;
}

const defaultRead = (file) => fs.readFileSync(file, 'utf8');
const noopLog = () => {};

/**
 * 应用当前实例的运行时覆盖。
 *
 * @param {object} options
 * @param {string} options.file       覆盖文件绝对路径（调用方给；模块不自己猜根目录）
 * @param {string} [options.envFile]  启动器解析出的 .env 路径，只用来严格取 `bots/<id>/`
 * @param {Record<string,string|undefined>} [options.env] 目标环境，默认 process.env
 * @param {(file: string) => string} [options.read] 文件读取（注入；判据用）
 * @param {(line: string) => void} [options.log] 日志（只打键名与数量）
 * @returns {{botId: string|null, applied: string[], kept: string[], reason: string}}
 *   reason: 'missing'（无文件）/ 'no-bot-id'（envFile 不在 bots/<id>/）/
 *           'no-bot-section'（文件里没有本实例分区）/ 'empty'（分区为空）/
 *           'applied'（已写入）/ 'kept'（本实例的键都已在 process.env 里，全部保留原值）
 * @throws {InstanceOverrideError} 文件存在但任何结构/键/值问题（整份 fail closed，不写任何键）
 */
export function applyInstanceOverrides({
  file, envFile, env = process.env, read = defaultRead, log = noopLog,
} = {}) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new InstanceOverrideError('实例覆盖文件路径未提供');
  }
  if (typeof read !== 'function' || typeof log !== 'function') {
    throw new InstanceOverrideError('实例覆盖的 read/log 注入无效');
  }
  if (!env || (typeof env !== 'object' && typeof env !== 'function')) {
    throw new InstanceOverrideError('实例覆盖的目标 env 无效');
  }

  // ① 认实例：只认 `bots/<id>/`，认不出就整步跳过（公开/旧布局不变）。
  const botId = botIdFromEnvFile(envFile);
  if (!botId) return { botId: null, applied: [], kept: [], reason: 'no-bot-id' };

  // ② 文件不存在 = 无覆盖（公开/旧安装行为不变）。
  let text;
  try {
    text = read(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { botId, applied: [], kept: [], reason: 'missing' };
    throw new InstanceOverrideError('实例覆盖文件读取失败');
  }
  if (typeof text !== 'string') throw new InstanceOverrideError('实例覆盖文件读取结果不是文本');

  // ③ 全文件校验通过之后才开始写；缺这个实例的分区 = 无覆盖。
  const perBot = parseOverrideDocument(text);
  const section = perBot.get(botId);
  if (!section) return { botId, applied: [], kept: [], reason: 'no-bot-section' };

  const applied = [];
  const kept = [];
  for (const [key, value] of section) {
    // ④ 父进程/守护显式给的环境优先：已有的键一个都不覆盖。
    if (Object.hasOwn(env, key)) {
      kept.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  if (applied.length > 0) log(`实例覆盖：已应用 ${applied.length} 项（${applied.join(', ')}）`);
  if (kept.length > 0) log(`实例覆盖：${kept.length} 项已由进程环境提供，保留原值（${kept.join(', ')}）`);
  if (applied.length === 0 && kept.length === 0) return { botId, applied, kept, reason: 'empty' };
  return { botId, applied, kept, reason: applied.length > 0 ? 'applied' : 'kept' };
}
