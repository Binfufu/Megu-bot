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
 * 见下面 `prepareBotHome()` 里那个 `linkTypeOf(...) === 'missing' → continue`。
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

/** 真 home（默认 `~/.dsh`）：`sessions` 之外的一切都还要从这里共享。 */
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
  if (env && path.resolve(env) !== path.resolve(botHome)) return path.resolve(env);
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

/** 这些条目不进链接：`sessions` 本身，以及紧挨着它的备份/隔离目录（那是给我们排查用的）。 */
function shouldSkip(name) {
  return name === 'sessions' || /^sessions[-.]/i.test(name);
}

/** junction 的 readlink 有时带 `\\?\` 前缀，比较前去掉。 */
function normalizeLink(target) {
  return path.resolve(String(target).replace(/^\\\\\?\\/, ''));
}

function linkTypeOf(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    return 'file';
  } catch {
    return 'missing';
  }
}

function createLink(source, target, isDirectory) {
  if (isDirectory) {
    fs.symlinkSync(source, target, 'junction');
    return 'junction';
  }
  try {
    fs.symlinkSync(source, target, 'file');
    return 'symlink';
  } catch {
    fs.linkSync(source, target); // 同卷兜底：硬链接（跨卷会抛，交给上层报错）
    return 'hardlink';
  }
}

/**
 * 确保私有 home 存在、`sessions` 是真实目录、其余条目都链到真 home。
 * @param {{envFile?: string, rootDir?: string, home?: string}} options
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

  if (path.resolve(realHome) === botHome) {
    return { home: botHome, created, ok, problems: ['QQBOT_HOME 与真 home 相同 —— 没有隔离，请把 .env 的 QQBOT_HOME 指到一个独立目录'], ready: false };
  }
  if (botHome.startsWith(`${realHome}${path.sep}`) || realHome.startsWith(`${botHome}${path.sep}`)) {
    return { home: botHome, created, ok, problems: ['私有 home 与真 home 互相嵌套 —— 拒绝继续（会链接成环）'], ready: false };
  }

  if (!dryRun) fs.mkdirSync(botHome, { recursive: true });
  const sessionsDir = path.join(botHome, 'sessions');
  if (linkTypeOf(sessionsDir) === 'missing') {
    if (dryRun) created.push('sessions/（待建，真实目录）');
    else {
      fs.mkdirSync(sessionsDir, { recursive: true });
      created.push('sessions/（真实目录）');
    }
  } else if (linkTypeOf(sessionsDir) === 'symlink') {
    problems.push(`sessions 竟然是链接（${fs.readlinkSync(sessionsDir)}）—— 会话日志就没隔离了`);
  } else {
    ok.push('sessions/');
  }

  let entries = [];
  try {
    entries = fs.readdirSync(realHome, { withFileTypes: true });
  } catch (error) {
    problems.push(`读不到真 home ${realHome}：${error.message}`);
    return { home: botHome, created, ok, problems, ready: false };
  }

  for (const entry of entries) {
    const name = entry.name;
    if (shouldSkip(name)) continue;
    // ⚠️ 2026-10-16(1.150.87,6B 第二刀):**own 模式不再新建共享链接**。
    //    以前这里会把真 home 的 profiles/storages/skills/dsh-runtimes/cache/attachments/
    //    llm-deepseek 与三个点文件全部 junction 进私有 home —— 那是"给 DSH 子进程用的共享面"。
    //    现在桥不spawn任何 DSH 子进程了 ⇒ 这些链接是纯冗余（而且是桥与全局 `~\.dsh` 之间
    //    唯一的硬连接）。**已存在的链接一律不删**（保守：不碰 DSH 侧、也不动历史现场），
    //    只是不再新建；真要清掉请手工确认后删（docs\22 退役清单里有说明）。
    if (linkTypeOf(path.join(botHome, name)) === 'missing') continue;
    const source = path.join(realHome, name);
    const target = path.join(botHome, name);
    const isDirectory = entry.isDirectory();
    const kind = linkTypeOf(target);

    if (kind === 'missing') {
      if (dryRun) {
        created.push(`${name}（待建链接）`);
        continue;
      }
      try {
        const made = createLink(source, target, isDirectory);
        created.push(`${name}（${made === 'junction' ? 'junction' : made}）`);
      } catch (error) {
        problems.push(`${name} 链接失败：${error.message}`);
      }
      continue;
    }
    if (kind === 'symlink') {
      let linked = '';
      try {
        linked = normalizeLink(fs.readlinkSync(target));
      } catch {
        linked = '';
      }
      if (linked === path.resolve(source)) {
        ok.push(name);
      } else {
        problems.push(`${name} 链接指向 ${linked}，应为 ${path.resolve(source)}`);
      }
      continue;
    }
    problems.push(`${name} 在私有 home 里是真实 ${kind}（不是链接）—— 两边会分叉，建议手工确认后删除它再跑一次`);
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
  const home = botHomeFromRoot(rootDir);
  if (!home) return '';
  return fs.existsSync(path.join(home, 'sessions')) ? home : '';
}
