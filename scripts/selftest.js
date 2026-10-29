/**
 * 自测分流入口：默认及 --full 始终要求完整私库，缺件必须报错。
 * 只有 --public 明确选择公开子集；公开副本也可直接运行 selftest-public.js。其余原参数原样保留。
 * 私 runner 只条件动态加载，不能在这里静态引入面板/酒馆/后台 suite。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectSelftestRunner({ argv = process.argv.slice(2), hasPrivate }) {
  let full = false;
  let publicOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    // 原 --out 的值即使恰好叫 --public，也仍是输出文件名，不是模式开关。
    if (argv[i] === '--out') { i += 1; continue; }
    if (argv[i] === '--full') full = true;
    if (argv[i] === '--public') publicOnly = true;
  }
  if (full && publicOnly) throw new Error('--full 与 --public 不能同时使用');
  // 默认调用也是全量契约，不以缺文件或环境信号猜测公开模式，防止任一旧闸门降级。
  if (!publicOnly && !hasPrivate) {
    throw new Error('全量自测需要 scripts/selftest-private.js；私套件缺失，拒绝以公开子集代替全量（公开验证请显式 --public）');
  }
  return publicOnly ? 'public' : 'full';
}

export async function runSelftest() {
  const privateUrl = new URL('./selftest-private.js', import.meta.url);
  const mode = selectSelftestRunner({ hasPrivate: existsSync(privateUrl) });
  if (mode === 'full') {
    // 不吞 import 错误：私 runner 存在但依赖损坏也必须红，绝不回退公开子集。
    await import(privateUrl.href);
  } else {
    process.stdout.write('[selftest] PUBLIC SUBSET ONLY — 非私库全量，不可作为部署全量闸门\n');
    const { runPublicSelftest } = await import('./selftest-public.js');
    await runPublicSelftest();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runSelftest();
  } catch (err) {
    process.stderr.write(`[selftest] ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  }
}
