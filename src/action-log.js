/**
 * **动作观察账**(T2,2026-10-29)——「她正在/刚刚做了什么」的通用事实源。
 *
 * ## 为什么要有它(通用框架归属)
 *
 * 桥内执行的副作用动作(搬图是第一个接入者)以前做完就完了:图库记了账、日志留了痕,
 * 但**聊天层不知道**——她答「发了没」只能靠模型瞎猜。本模块给所有这类动作一个统一的
 * 进程内观察位:动作接纳时登记 running,收尾时用真实结果覆盖;聊天轮按作用域读取,
 * 经既有事实通道(`[[bridge-inject facts]]`)进入本轮提示词。
 *
 * ## 边界(刻意保持小)
 *
 * · **进程内 Map,不落库**——它是"最近几分钟的动作快照",不是审计账;持久收据归各自
 *   功能(搬图的逐张收据在服务返回值/后续存储),这里只服务"聊天观察"这一个消费者。
 * · **按作用域隔离**——scope 形如 `group:<targetId>` / `c2c:<openid>`;别的群看不见。
 * · **TTL + 每作用域封顶**——过期动作自动出账,不为凑事实硬塞旧闻。
 * · **不认识具体业务**——条目的 text 由动作方(或其 describe 函数)渲染好再登记;
 *   本模块只管 存/取/过期/封顶,不解析 kind、不渲染文案(D159:一个职责一个文件)。
 */
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PER_SCOPE = 5;

export function createActionLog({ maxPerScope = DEFAULT_MAX_PER_SCOPE, ttlMs = DEFAULT_TTL_MS } = {}) {
  const cap = Math.max(1, Number(maxPerScope) || DEFAULT_MAX_PER_SCOPE);
  const ttl = Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS);
  const byScope = new Map();

  function prune(scope, now) {
    const list = byScope.get(scope);
    if (!list) return [];
    const alive = list.filter((entry) => now - entry.at <= ttl);
    if (alive.length === 0) byScope.delete(scope);
    else byScope.set(scope, alive.slice(-cap));
    return alive;
  }

  return {
    /** 登记一条动作(接纳时 status:'running';收尾用同 taskId 的新条目覆盖语义——最新为准)。 */
    record(scope, entry, now = Date.now()) {
      const key = String(scope ?? '');
      if (!key || !entry || typeof entry !== 'object') return null;
      const record = {
        kind: String(entry.kind ?? 'unknown'),
        taskId: entry.taskId ?? null,
        status: String(entry.status ?? 'unknown'),
        text: typeof entry.text === 'string' ? entry.text : '',
        at: Number(now) || Date.now(),
        ...Object.fromEntries(Object.entries(entry).filter(([k]) => !['kind', 'taskId', 'status', 'text', 'at'].includes(k))),
      };
      const list = prune(key, now);
      list.push(record);
      byScope.set(key, list.slice(-cap));
      return record;
    },
    /** 某作用域内仍有效的动作(旧→新);过期自动出账。 */
    all(scope, now = Date.now()) {
      return prune(String(scope ?? ''), Number(now) || Date.now());
    },
    /** 最近一条(可选按 kind 过滤);没有= null(调用方据此不注入事实)。 */
    latest(scope, { kind = null, now = Date.now() } = {}) {
      const list = prune(String(scope ?? ''), Number(now) || Date.now());
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (kind === null || list[i].kind === kind) return list[i];
      }
      return null;
    },
    /** 进行中的动作 = **最新一条**且其状态为 running(搬图按作用域串行,同域同时只有一个任务;
     *  完成回填后旧的 pending 自然失效,不翻旧账)。没有 = null。 */
    running(scope, { kind = null, now = Date.now() } = {}) {
      const list = prune(String(scope ?? ''), Number(now) || Date.now());
      const latest = list.at(-1);
      if (!latest || latest.status !== 'running') return null;
      return kind === null || latest.kind === kind ? latest : null;
    },
  };
}
