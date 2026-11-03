/**
 * 机器人私有 Harness home —— 把 bot 的会话日志与桌面版**物理隔离**。
 *
 * ## 为什么要有这个文件（2026-10-08 事故的治本项）
 *
 * 桌面版和机器人的 dsh 共用同一个 `~/.dsh`。桌面版启动时会遍历
 * `$QQBOT_HOME/sessions` 下的**每一个**会话目录做身份校验（header 的 id/cwd 必须能反推出
 * 它现在所在的实际路径，且 id 要全局唯一）；**任何一条**不合规就让 workspaceRegistry
 * 整个不激活，界面表现是"工作区列表空了 / workspaceController is unavailable"。
 *
 * 机器人那边会产生大量会话日志，而且它的工作区目录搬过一次家（9/29 `<旧机器人工作区>`
 * → `<新机器人工作区>`），于是留下了 9 条 cwd 与目录不符的日志 + 1 对跨工作区
 * 重名 id。桌面版于是被这些**跟它无关**的日志拖停。
 *
 * ## 做法
 *
 * 给机器人一个自己的 `QQBOT_HOME`，里面只有 `sessions` 是**私有真实目录**。
 *
 * ```
 * <机器人 home 目录>\            ← 机器人的 QQBOT_HOME
 *   sessions\                     ← 真实目录（DSH 时代留下的会话日志在这；现已冻结不再新增）
 * ```
 *
 * ⚠️ **2026-10-16 / 1.150.87（6B 第二刀）：不再新建任何指向 `~\.dsh` 的链接。** 以前这里会把
 * 真 home 的 `profiles` / `storages` / `cache` / `attachments` / `llm-deepseek` / `dsh-runtimes`
 * 与三个点文件全部 junction 进来 —— 那是"给 DSH 子进程用的共享面"。桥不再 spawn 任何 DSH
 * 子进程之后，这些链接是**纯冗余**，而且是桥与全局 `~\.dsh` 之间唯一的硬连接。
 * **既有的链接一律不删**（保守：不碰 DSH 侧、也不动历史现场），只是不再新建 ——
 * `prepareBotHome()` 只验证私有 sessions，不再读取/校验全局 home 的其他条目。
 *
 * 为什么当初用链接而不是复制：`profiles` 里是装好的插件、`storages` 里是注册表/派生缓存、
 * 凭据改了要立刻生效 —— **复制会分叉**（改一处另一处不动，正是这个项目最怕的那种 bug）。
 * 这段历史留着，是因为它解释了"为什么私有 home 里可能还残留一些链接"。
 *
 * 为什么在 launch.js 里显式 `process.env.QQBOT_HOME = <私有 home>`：
 * Node 的 `process.loadEnvFile` **不会覆盖已经存在的环境变量**（实测），
 * 所以只往 `.env` 里写一行在"从某个 DSH 会话里启动"时会失效。显式赋值才是确定的。
 *
 * 于是 `src/index.js`（记忆归档）、`src/supervisor.js`（会话保留）这些本来就算
 * `process.env.QQBOT_HOME` 的地方**全部自动跟随**，不需要各改一遍。
 * （原先这里还列了 `src/dsh.js` 的换代判据 —— 那个模块已随 6B 退役，留档在
 *  `D:\废弃仓库\去dsh化原零件\2026-10-16-6b\`。）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 历史 Harness home（默认 `~/.dsh`）：仅作工具兜底与隔离边界，不是 own 的共享依赖。 */
export function realHarnessHome(env = process.env) {
  const explicit = env.QQBOT_HOME && env.QQBOT_HOME.trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.dsh');
}

/**
 * "真 home"是相对私有 home 而言的：如果进程的 `QQBOT_HOME` **已经**是私有 home
 * （比如 launch.js 同步过一次之后又被调用），就不能拿它当真 home —— 否则会自己链接自己。
 */
function realHomeFor(botHome) {
  const env = (process.env.QQBOT_HOME ?? '').trim();
  const fallback = path.join(os.homedir(), '.dsh');
  if (env && path.relative(path.resolve(env), path.resolve(botHome)) !== '') return path.resolve(env);
  return fallback;
}

/** 读一个 dotenv 文件里的 KEY=值（只认第一处，忽略注释行）。 */
export function readEnvFileValue(envFile, key) {
  try {
    // ⚠️ 2026-10-28(P0 能力基线):PowerShell 的 `Set-Content -Encoding utf8` 会写 **BOM**,
    //    而 `^[ \t]*KEY` 在 BOM 后面永远不匹配 —— 结果是**文件里明明有、读出来是空**,
    //    整份基线会把"配了"报成"没配"(静默失效那一族的典型形状)。
    //    去 BOM 只在这一处做(唯一的 dotenv 读取口,D159)。
    const text = fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '');
    const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*([^\\r\\n]*)`, 'm').exec(text);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

/** 桥根目录：本文件在 `src\` 下，所以上一级就是。 */
export function bridgeRootFromModule(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
}

/**
 * 从 `bots\<名字>\.env` 里找机器人私有 home（所有机器人共用同一个值）。
 * @returns {string} 绝对路径；没配置时返回 `''`。
 */
export function botHomeFromRoot(rootDir) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(rootDir, 'bots'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return '';
  }
  for (const name of names) {
    const value = readEnvFileValue(path.join(rootDir, 'bots', name, '.env'), 'QQBOT_HOME');
    if (value) return path.resolve(value);
  }
  return '';
}

/**
 * 给"手工跑的工具脚本"用的解析：优先机器人私有 home，其次进程的 `QQBOT_HOME`，最后 `~/.dsh`。
 * @param {string} from `import.meta.url`（或一个目录）。
 */
export function resolveBotHome(from) {
  let rootDir = '';
  try {
    rootDir = typeof from === 'string' && from.startsWith('file:')
      ? bridgeRootFromModule(from)
      : path.resolve(from ?? process.cwd());
  } catch {
    rootDir = process.cwd();
  }
  return botHomeFromRoot(rootDir) || realHarnessHome();
}

function linkTypeOf(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    return 'file';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error; // 访问失败不是缺失，更不能算已隔离。
  }
}

// path.relative 遵循平台路径语义（Windows 大小写不敏感），不误伤同名前缀的兄弟目录。
function sameOrNested(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * 仅确保私有 home 存在且 `sessions` 是真实目录。own 不消费全局 profiles 等共享面；
 * 其他既有实体/链接一律不检查、不删除、不修复，也不要求全局 home 存在。
 * @param {{envFile?: string, rootDir?: string, home?: string, dryRun?: boolean}} options
 * @returns {{home: string|null, created: string[], ok: string[], problems: string[]}}
 */
export function prepareBotHome({ envFile = '', rootDir = '', home = '', dryRun = false } = {}) {
  let botHome = home ? path.resolve(home) : '';
  if (!botHome && envFile) botHome = readEnvFileValue(envFile, 'QQBOT_HOME');
  if (!botHome && rootDir) botHome = botHomeFromRoot(rootDir);
  if (!botHome) return { home: null, created: [], ok: [], problems: ['没有配置 QQBOT_HOME（bots\\*\\.env）'], ready: false };
  botHome = path.resolve(botHome);

  const realHome = realHomeFor(botHome);
  const problems = [];
  const created = [];
  const ok = [];

  if (path.relative(realHome, botHome) === '') {
    return { home: botHome, created, ok, problems: ['QQBOT_HOME 与真 home 相同 —— 没有隔离，请把 .env 的 QQBOT_HOME 指到一个独立目录'], ready: false };
  }
  if (sameOrNested(realHome, botHome) || sameOrNested(botHome, realHome)) {
    return { home: botHome, created, ok, problems: ['私有 home 与真 home 互相嵌套 —— 拒绝继续（会话根没有独立隔离）'], ready: false };
  }

  const sessionsDir = path.join(botHome, 'sessions');
  try {
    if (!dryRun) fs.mkdirSync(botHome, { recursive: true });
    const kind = linkTypeOf(sessionsDir);
    if (kind === 'missing') {
      if (dryRun) created.push('sessions/（待建，真实目录）');
      else {
        fs.mkdirSync(sessionsDir, { recursive: true });
        created.push('sessions/（真实目录）');
      }
    } else if (kind === 'symlink') {
      problems.push(`sessions 竟然是链接（${fs.readlinkSync(sessionsDir)}）—— 会话日志就没隔离了`);
    } else if (kind !== 'dir') {
      problems.push('sessions 是文件，不是私有真实目录 —— 拒绝继续，请保留现场核查');
    } else {
      ok.push('sessions/');
    }
  } catch (error) {
    problems.push(`私有 sessions 无法检查或准备：${error.message}`);
  }

  return {
    home: botHome,
    created,
    ok,
    problems,
    // dryRun：created 非空 = 还没建好；sync：建完就算就绪（只看 problems）
    ready: problems.length === 0 && (!dryRun || created.length === 0),
  };
}

/** 只检查不创建（控制台 doctor 用）。 */
export function checkBotHome(options = {}) {
  return prepareBotHome({ ...options, dryRun: true });
}

/** 私有 home 是否已经建好（用于"没配就什么都不做"的分支）。 */
export function botHomeExists(rootDir) {
  const result = checkBotHome({ rootDir });
  return result.ready ? result.home : '';
}
