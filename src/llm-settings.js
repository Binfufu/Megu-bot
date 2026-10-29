/**
 * **模型接入 · 可热替换的两套 client**(2026-10-18 / 1.153.0)。
 *
 * ## 它解决的现场
 *
 * 用户 2026-10-18 拍板:
 *  · Bot 后端只有**一套**模型配置(所有前端共用);
 *  · 梦境是独立玩法,**另一套**;
 *  · 面板上填/换 key 后**不重启**,下一轮生效;
 *  · key 输入即锁定:页面永不给读回,只能重新覆盖;
 *  · 盘上不放明文:Win32 DPAPI 封存(见 `secret-box.js`)。
 *
 * ## 形状
 *
 * `createLlmSettings({file, env, secretBox})`
 *   → `{ load, reload, watch, close, scoped, save, reset, test, info, isConfigured, problem, get }`
 *      (`reload/watch/close` = 2026-10-18 文件热加载:下一轮生效、不重启、坏文件不动现状)
 *
 * `scoped('bot')` / `scoped('dream')` 返回一个**永远指向当前 client** 的薄壳:
 * runner / dream-service 拿着它,热替换只改 registry 里的引用,不重建引擎、不碰记忆。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLlmClient } from './llm.js';
import {
  MODEL_SLOTS,
  PROVIDERS,
  defaultsFromEnv,
  mergeSlot,
  validateSlotInput,
  publicSlotView,
  keyFingerprint,
  maskKey,
} from './model-slots.js';

export const MODEL_SLOTS_FILE = 'model-slots.json';

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, error: `read_failed:${err?.code ?? 'unknown'}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'bad_json' };
  }
}

function atomicWriteJson(file, value) {
  ensureDir(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: chmod 只影响只读位,忽略 */ }
  try {
    fs.copyFileSync(file, `${file}.bak`);
  } catch { /* 第一次保存没有旧文件,正常 */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 同上 */ }
}

function redact(message, secrets) {
  let text = String(message ?? '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('***');
  }
  return text.slice(0, 300);
}

function slotOf(value) {
  const text = String(value ?? '').trim();
  return MODEL_SLOTS.includes(text) ? text : null;
}

/**
 * @param {{file: string, env?: object, createClient?: Function, secretBox?: object,
 *          log?: Console, now?: () => number, clientOptions?: object}} options
 */
export function createLlmSettings(options = {}) {
  const file = String(options.file ?? '').trim();
  if (file === '') throw new Error('createLlmSettings: file 必填');
  const env = options.env ?? process.env;
  const createClient = options.createClient ?? createLlmClient;
  const secretBox = options.secretBox ?? null;
  const log = options.log ?? console;
  const now = options.now ?? Date.now;
  const clientOptions = { log, ...(options.clientOptions ?? {}) };

  let store = { version: 1, slots: {}, profiles: [] };
  let loadError = '';
  // ⚠️ 这三个 registry(`clients`/`effective`/`problems`)必须能**整份换掉**:
  //    热加载 reload() 先在暂存对象里解封/校验/建 client,全过才一次性替换;
  //    任何一步失败就丢弃暂存,正在跑的引用一个都不动(2026-10-18 热加载)。
  let clients = Object.create(null);
  let effective = Object.create(null);
  let problems = Object.create(null);
  // 可复用模型档案(2026-10-19 / D261):同一份文件里的 profiles;client 同样整份换。
  let profileClients = Object.create(null);
  let profileEffective = Object.create(null);

  function slotStore() {
    return store && typeof store === 'object' && store.slots && typeof store.slots === 'object'
      ? store.slots
      : {};
  }

  function profileStore() {
    return Array.isArray(store?.profiles) ? store.profiles : [];
  }

  /**
   * 解析一条模型档案(2026-10-19 / D261):解封 → 校验 → 建 client。
   * 档案是"可复用的一组 provider/baseUrl/model/key/reasoning",不占 bot/dream slot。
   */
  function resolveProfile(raw, { strict = false } = {}) {
    if (!raw || typeof raw !== 'object' || !raw.id) return { ok: false, error: 'bad_profile' };
    let apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
    if (typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc !== '') {
      if (!secretBox?.available) return { ok: false, error: 'secret_unavailable' };
      try {
        apiKey = secretBox.unseal(raw.apiKeyEnc);
      } catch (err) {
        return { ok: false, error: `unseal_failed:${redact(err?.message, [raw.apiKeyEnc])}` };
      }
    }
    const checked = validateSlotInput({
      slot: 'dream', provider: raw.provider, baseUrl: raw.baseUrl, model: raw.model,
      apiKey, reasoning: raw.reasoning,
    });
    if (!checked.ok) return { ok: false, error: `invalid:${checked.error}` };
    if (!checked.value.apiKey) return { ok: false, error: 'key_required' };
    const config = {
      ...checked.value,
      id: String(raw.id),
      label: String(raw.label ?? `${checked.value.provider}/${checked.value.model}`).slice(0, 80),
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    };
    let client;
    try {
      client = createClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        reasoning: config.reasoning,
        ...clientOptions,
      });
    } catch (err) {
      return { ok: false, error: `client_failed:${redact(err?.message, [config.apiKey])}` };
    }
    return { ok: true, config, client, raw };
  }

  function profileView(config) {
    return {
      id: config.id,
      label: config.label,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      reasoning: config.reasoning ?? 'auto',
      keyMasked: maskKey(config.apiKey),
      hasKey: Boolean(config.apiKey),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  function buildProfileRegistry(list, { strict = false } = {}) {
    const nextClients = Object.create(null);
    const nextEffective = Object.create(null);
    const nextRaw = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const resolved = resolveProfile(raw, { strict });
      if (!resolved.ok) {
        if (strict) return { ok: false, error: `profile:${resolved.error}` };
        log.warn?.(`[模型] 档案 ${raw?.id ?? '?'} 不可用(${resolved.error}),跳过`);
        continue;
      }
      nextEffective[resolved.config.id] = resolved.config;
      nextClients[resolved.config.id] = resolved.client;
      nextRaw.push(raw);
    }
    return { ok: true, clients: nextClients, effective: nextEffective, raw: nextRaw };
  }

  /**
   * 纯解析:env 默认值 + 覆盖 → 解封 → 合并 → 校验。**只报告,不改 registry**。
   *
   * 为什么要有这一层(2026-10-18 热加载):启动 load() 与热加载 reload() 的失败语义**不同** ——
   *  · load()(既有语义,保留):坏了就回退环境变量,并把这个事实写进 `problems`;
   *  · reload()(见下):坏了**整份保留旧配置**,绝不回退(回退 env 会把"面板填错了"
   *    伪装成"当前就是 env",用户更难看出自己填坏了)。
   * 所以这里只返回 `{ok:false, error, warn, fallback}`,由两个调用方各自决定怎么办。
   *
   * `strict=true`(热加载)对"文件里写了覆盖却不成形状"也判失败 —— 文件写坏了就整份不生效,
   * 不搞"部分 slot 生效"这种半吊子状态;但"本来就未配置"(如梦没 env、文件也没覆盖)不算坏。
   */
  function resolveSlot(slots, slot, { strict = false } = {}) {
    const defaults = defaultsFromEnv(env)[slot];
    const override = slots[slot];
    let over = null;
    if (override && typeof override === 'object') {
      over = { ...override };
      // 新格式:apiKeyEnc;旧格式/测试夹具:apiKey(明文,读得到;下一次保存会转密文)。
      if (typeof override.apiKeyEnc === 'string' && override.apiKeyEnc !== '') {
        if (!secretBox?.available) {
          return {
            ok: false,
            error: 'secret_unavailable',
            warn: `[模型] ${slot} 的配置需要 DPAPI 解封,但当前环境不可用 —— 不回退环境变量`,
            fallback: { ...defaults, apiKey: '', configured: false, source: 'panel(密钥无法解封)', keyError: true },
          };
        }
        try {
          over.apiKey = secretBox.unseal(override.apiKeyEnc);
        } catch (err) {
          const detail = redact(err?.message, [override.apiKeyEnc]);
          return {
            ok: false,
            error: `unseal_failed:${detail}`,
            warn: `[模型] ${slot} 的 key 解封失败(换用户/换机器?): ${detail}`,
            fallback: { ...defaults, apiKey: '', configured: false, source: 'panel(密钥无法解封)', keyError: true },
          };
        }
      }
      delete over.apiKeyEnc;
    }

    let merged = mergeSlot(defaults, over);
    // 合并后的形状再校验一次;写坏的 JSON 不许把启动带下水 —— 启动路径回退环境变量并标出来。
    // ⚠️ `strict`(热加载)只把"**文件里真的写了覆盖**还是不合形状"判失败:
    //    梦境没 env、文件也没覆盖时 `empty_base_url` 是**正常的未配置**,不是坏文件。
    const hasOverride = over !== null && Object.keys(over).length > 0;
    const checked = validateSlotInput({
      slot,
      provider: merged.provider,
      baseUrl: merged.baseUrl,
      model: merged.model,
      apiKey: merged.apiKey,
      reasoning: merged.reasoning,
    });
    if (!checked.ok) {
      if (merged.configured || (strict && hasOverride)) {
        return {
          ok: false,
          error: `invalid:${checked.error}`,
          warn: strict
            ? `[模型] ${slot} 的配置无效(${checked.error})`
            : `[模型] ${slot} 的面板配置无效(${checked.error}),回退环境变量`,
          fallback: { ...defaults, source: 'env(面板配置无效)' },
        };
      }
    } else {
      merged = {
        ...merged,
        provider: checked.value.provider,
        baseUrl: checked.value.baseUrl,
        model: checked.value.model,
        reasoning: checked.value.reasoning,
      };
    }
    merged.configured = Boolean(merged.apiKey && merged.baseUrl && merged.model);
    return { ok: true, config: merged };
  }

  /** 启动路径的既有语义:解析失败就回退 env,并把原因挂在 `problems` 上。 */
  function buildEffective(slot) {
    const resolved = resolveSlot(slotStore(), slot);
    if (resolved.ok) return resolved.config;
    problems[slot] = resolved.error;
    log.warn?.(resolved.warn);
    return resolved.fallback;
  }

  function makeClient(slot, config) {
    if (!config?.configured) {
      problems[slot] = problems[slot] || 'not_configured';
      return null;
    }
    try {
      const client = createClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        reasoning: config.reasoning,
        ...clientOptions,
      });
      delete problems[slot];
      return client;
    } catch (err) {
      problems[slot] = `client_failed:${redact(err?.message, [config.apiKey])}`;
      log.warn?.(`[模型] ${slot} 建 client 失败: ${redact(err?.message, [config.apiKey])}`);
      return null;
    }
  }

  function refreshSlot(slot) {
    const config = buildEffective(slot);
    effective[slot] = config;
    clients[slot] = makeClient(slot, config);
    return config;
  }

  function load() {
    const read = readJson(file);
    if (!read.ok) {
      loadError = read.error;
      store = { version: 1, slots: {}, profiles: [] };
      log.warn?.(`[模型] 覆盖文件读取失败(${read.error}),全部回退环境变量: ${file}`);
    } else if (read.value && typeof read.value === 'object' && read.value.slots && typeof read.value.slots === 'object') {
      store = {
        version: 1,
        slots: { ...read.value.slots },
        profiles: Array.isArray(read.value.profiles) ? read.value.profiles : [],
      };
    } else if (read.value !== null) {
      loadError = 'bad_shape';
      store = { version: 1, slots: {}, profiles: [] };
      log.warn?.(`[模型] 覆盖文件形状不对,全部回退环境变量: ${file}`);
    }
    for (const slot of MODEL_SLOTS) refreshSlot(slot);
    const profiles = buildProfileRegistry(store.profiles, { strict: false });
    if (profiles.ok) {
      profileClients = profiles.clients;
      profileEffective = profiles.effective;
    }
    return info();
  }

  /**
   * **热加载(2026-10-18)**:CLI / 桌面控制台改写 `model-slots.json` 后,
   * 下一轮生效、不重启;坏文件一个字节都不许影响正在跑的配置。
   *
   * 与启动 `load()` 的三条硬区别(**别合并回去**):
   *  1. 失败**不回退 env** —— 回退只留给启动路径的既有语义;
   *  2. 失败**整份不动** —— 先在暂存 registry 里解封/校验/建 client,全过才一次性替换;
   *  3. **绝不抛** —— 它会被 fs.watch 的定时器调用,抛出去就是进程级事故。
   *
   * 语义边界:只换 registry 里的 client 引用,人设/记忆/会话/在途调用一概不动
   * (`scoped()` 每轮现取 `clients[slot]`,在这一层天然满足)。
   *
   * @returns {{ok: true, changed: boolean} | {ok: false, error: string}}
   */
  function reload() {
    try {
      const read = readJson(file);
      if (!read.ok) return reloadFailed(read.error);
      // 文件被外部删掉:保留旧配置 —— 不偷偷回退 env(理由同"失败不回退")。
      if (read.value === null) return reloadFailed('file_missing');
      if (!read.value || typeof read.value !== 'object'
        || !read.value.slots || typeof read.value.slots !== 'object' || Array.isArray(read.value.slots)) {
        return reloadFailed('bad_shape');
      }

      const nextStore = {
        version: 1,
        slots: { ...read.value.slots },
        profiles: Array.isArray(read.value.profiles) ? read.value.profiles : [],
      };
      const nextEffective = Object.create(null);
      const nextClients = Object.create(null);
      const nextProblems = Object.create(null);
      for (const slot of MODEL_SLOTS) {
        const resolved = resolveSlot(nextStore.slots, slot, { strict: true });
        if (!resolved.ok) return reloadFailed(resolved.error);
        nextEffective[slot] = resolved.config;
        if (!resolved.config.configured) {
          // 没配好不是"坏文件"(面板 reset 过也是这个形状):如实生效为未配置。
          nextClients[slot] = null;
          nextProblems[slot] = 'not_configured';
          continue;
        }
        try {
          nextClients[slot] = createClient({
            baseUrl: resolved.config.baseUrl,
            apiKey: resolved.config.apiKey,
            model: resolved.config.model,
            reasoning: resolved.config.reasoning,
            ...clientOptions,
          });
        } catch (err) {
          return reloadFailed(`client_failed:${redact(err?.message, [resolved.config.apiKey])}`);
        }
      }
      const nextProfiles = buildProfileRegistry(nextStore.profiles, { strict: true });
      if (!nextProfiles.ok) return reloadFailed(nextProfiles.error);

      const changed = registrySignature(effective) !== registrySignature(nextEffective)
        || profileSignature(profileEffective) !== profileSignature(nextProfiles.effective);
      // 一次换掉四格:JS 单线程,这一小段中间插不进别的调用(同步、无 await)。
      store = nextStore;
      effective = nextEffective;
      clients = nextClients;
      problems = nextProblems;
      profileClients = nextProfiles.clients;
      profileEffective = nextProfiles.effective;
      loadError = '';
      if (changed) {
        // 只报 provider/model/source —— 永远不带 key(判据里有特征 key 串)
        log.info?.(`[模型] 热加载生效: bot=${describeSlot(effective.bot)} | dream=${describeSlot(effective.dream)}`);
      }
      return { ok: true, changed };
    } catch (err) {
      // 兜底:连 readJson 之外的东西炸了也不许把 watcher/进程带下去。
      return reloadFailed(`reload_failed:${redact(err?.message, [])}`);
    }
  }

  /** 失败统一走这里:一行 warn 带错误码、不带 key,返回 `{ok:false,error}`。 */
  function reloadFailed(error) {
    log.warn?.(`[模型] 热加载失败(${error}),继续用当前配置: ${path.basename(file)}`);
    return { ok: false, error };
  }

  /** 日志/变更判据用的"生效值指纹";apiKey 只进内存在比较,永不打印。 */
  function registrySignature(map) {
    return MODEL_SLOTS.map((slot) => {
      const one = map[slot];
      if (!one) return `${slot}:none`;
      return [slot, one.configured ? 1 : 0, one.provider, one.baseUrl, one.model, one.reasoning ?? 'auto', one.apiKey, one.source].join('|');
    }).join('\n');
  }

  function describeSlot(one) {
    if (!one?.configured) return '未配置';
    return `${one.provider}/${one.model} source=${one.source}`;
  }

  function profileSignature(map) {
    return Object.keys(map).sort().map((id) => {
      const one = map[id];
      return [id, one.label, one.provider, one.baseUrl, one.model, one.reasoning ?? 'auto'].join('|');
    }).join('\n');
  }

  const WATCH_DEBOUNCE_MS = 200;
  let watcher = null;
  let watcherTimer = null;

  /** 防抖:原子写会连发多次事件(`.tmp-*` 建、`.bak` 复制、rename),合并成一次 reload。 */
  function scheduleReload() {
    if (watcherTimer) clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => {
      watcherTimer = null;
      reload();
    }, WATCH_DEBOUNCE_MS);
    // 待触发的防抖定时器不该把进程钉住(退出路径/测试尤其重要)。
    watcherTimer.unref?.();
  }

  /**
   * 监听 `path.dirname(file)`,只认 `path.basename(file)` 精确匹配。
   *
   * ⚠️ 为什么盯**目录**而不是文件本身:`atomicWriteJson` 是
   *    写 `.tmp-*` → `copyFileSync` 出 `.bak` → `renameSync` 覆盖主文件。
   *    Windows 上 rename 会把"盯文件本身"的 watcher 断掉(之后静默不工作),
   *    盯目录则继续收事件;同目录里 `.bak`/`.tmp-*`/`.audit.log` 靠名字精确过滤掉。
   *
   * 幂等:重复调用只开一个 watcher,返回同一个 close。
   * 返回 close 函数(也可以调 `close()`),watcher 自身 error 只 warn,绝不让进程陪葬。
   */
  function watch() {
    if (watcher) return close;
    const dir = path.dirname(file);
    const base = path.basename(file);
    try {
      ensureDir(file);
      watcher = fs.watch(dir, { persistent: false }, (eventType, name) => {
        // ⚠️ `name` 在个别平台组合下可能是 null —— 认不出就当没发生:
        //    宁可漏一次(下次改文件还会再触发),也不拿"任意未知事件"去重读配置。
        const hit = name === null || name === undefined ? '' : String(name);
        if (hit === '') return;
        const same = process.platform === 'win32'
          ? hit.toLowerCase() === base.toLowerCase()
          : hit === base;
        if (same) scheduleReload();
      });
    } catch (err) {
      watcher = null;
      log.warn?.(`[模型] 热加载监听开不起来(${err?.code ?? err?.message ?? err}),改文件后需重启才生效: ${dir}`);
      return close;
    }
    watcher.on('error', (err) => {
      log.warn?.(`[模型] 热加载监听出错(继续用当前配置): ${err?.message ?? err}`);
    });
    return close;
  }

  /** 关 watcher(测试与进程退出用);之后再调 watch() 会重新开一个。 */
  function close() {
    if (watcherTimer) {
      clearTimeout(watcherTimer);
      watcherTimer = null;
    }
    if (watcher) {
      const one = watcher;
      watcher = null;
      try { one.close(); } catch { /* 已关闭/平台异常:退出路径忽略 */ }
    }
  }

  function get(slot) {
    const key = slotOf(slot);
    if (key === null) throw new Error(`未知模型 slot: ${slot}`);
    return effective[key] ?? refreshSlot(key);
  }

  function isConfigured(slot) {
    const key = slotOf(slot);
    if (key === null) return false;
    if (!effective[key]) refreshSlot(key);
    return Boolean(clients[key]);
  }

  function problem(slot) {
    const key = slotOf(slot);
    if (key === null) return 'bad_slot';
    if (!effective[key]) refreshSlot(key);
    return problems[key] ?? null;
  }

  function scoped(slot) {
    const key = slotOf(slot);
    if (key === null) throw new Error(`未知模型 slot: ${slot}`);
    const current = () => {
      const client = clients[key];
      if (!client) {
        const err = new Error(`模型 ${key} 还没配好(${problem(key) ?? 'not_configured'})`);
        err.code = 'llm_unconfigured';
        err.slot = key;
        throw err;
      }
      return client;
    };
    return {
      slot: key,
      isConfigured: () => Boolean(clients[key]),
      problem: () => problem(key),
      chat: (messages, callOptions = {}) => current().chat(messages, callOptions),
      chatStream: (messages, callOptions = {}, onDelta = null) => current().chatStream(messages, callOptions, onDelta),
      /**
       * **整轮快照**(P3-b,2026-10-28):把**此刻**的 client 绑定成一份固定引用。
       * 为什么需要:`chat()` 每次**现取** client —— 工具循环一轮里有多次子调用,
       * 中途热换模型会让同一轮的后半段换协议/换模型(半轮跨协议,账与协议状态都说不清)。
       * 快照后本轮所有子调用钉死同一个 client;热换只影响**下一轮**。
       * 没配好时当场抛(与 chat 同一条 fail-fast)。
       */
      snapshot: () => {
        const client = current();
        return {
          slot: key,
          chat: (messages, callOptions = {}) => client.chat(messages, callOptions),
        };
      },
    };
  }

  function appendAudit(row) {
    try {
      ensureDir(file);
      fs.appendFileSync(`${file}.audit.log`, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      log.warn?.(`[模型] 审计写入失败: ${err?.message ?? err}`);
    }
  }

  function auditRow(action, slot, { by = null, provider = null, model = null, key = '', ok = true, error = null } = {}) {
    return {
      at: now(),
      action,
      slot,
      by: by ?? null,
      provider: provider ?? null,
      model: model ?? null,
      keyFingerprint: key ? keyFingerprint(key) : null,
      ok: ok === true,
      error: error ?? null,
    };
  }

  function readAudit(limit = 12) {
    try {
      const text = fs.readFileSync(`${file}.audit.log`, 'utf8');
      const rows = text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Number(limit) || 12));
      return rows.map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean).reverse();
    } catch {
      return [];
    }
  }

  /** 16 token ping(测试 slot 与保存档案共用一份;别写第二份)。 */
  async function testConfig(checked, slot = null) {
    let client;
    try {
      client = createClient({
        baseUrl: checked.baseUrl,
        apiKey: checked.apiKey,
        model: checked.model,
        reasoning: checked.reasoning,
        ...clientOptions,
        timeoutMs: Math.min(Number(clientOptions.timeoutMs) || 15_000, 15_000),
        attempts: 1,
      });
    } catch (err) {
      return { ok: false, error: redact(err?.message, [checked.apiKey]), slot };
    }
    const startedAt = now();
    try {
      const result = await client.chat(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 16, temperature: 0 },
      );
      return {
        ok: true,
        slot,
        model: result?.model ?? checked.model,
        latencyMs: Math.max(0, now() - startedAt),
        usage: result?.usage ?? null,
      };
    } catch (err) {
      return {
        ok: false,
        slot,
        model: checked.model,
        latencyMs: Math.max(0, now() - startedAt),
        status: Number.isInteger(err?.status) ? err.status : null,
        error: redact(err?.message, [checked.apiKey]),
      };
    }
  }

  async function test(slot, candidate = null) {
    const key = slotOf(slot);
    if (key === null) return { ok: false, error: 'bad_slot' };
    const current = get(key);
    const checked = validateSlotInput({
      slot: key,
      provider: candidate?.provider ?? current.provider,
      baseUrl: candidate?.baseUrl ?? current.baseUrl,
      model: candidate?.model ?? current.model,
      apiKey: candidate?.apiKey || current.apiKey,
      reasoning: candidate?.reasoning ?? current.reasoning,
    });
    if (!checked.ok) return { ok: false, error: checked.error };
    if (!checked.value.apiKey) return { ok: false, error: 'key_required' };
    return testConfig(checked.value, key);
  }

  function writeState(slots, profiles) {
    atomicWriteJson(file, { version: 1, slots, profiles });
  }

  /**
   * 保存一条可复用模型档案(2026-10-19 / D261):不占 slot,web 梦境可实时选。
   * key 仍只在 stdin / 内存 / DPAPI 密文里;查重按 id 覆盖,不按 key。
   */
  async function saveProfile(input = {}, { by = null, testFirst = true } = {}) {
    const current = input.id ? profileEffective[input.id] : null;
    const checked = validateSlotInput({
      slot: 'dream',
      provider: input.provider ?? current?.provider,
      baseUrl: input.baseUrl ?? current?.baseUrl,
      model: input.model ?? current?.model,
      apiKey: input.apiKey || current?.apiKey,
      reasoning: input.reasoning ?? current?.reasoning,
    });
    if (!checked.ok) return { ok: false, error: checked.error };
    if (!checked.value.apiKey) return { ok: false, error: 'key_required' };

    if (testFirst !== false) {
      const tested = await testConfig(checked.value);
      if (!tested.ok) return { ok: false, error: 'test_failed', test: tested };
    }
    if (!secretBox?.available) {
      return { ok: false, error: 'secret_unavailable', note: 'DPAPI 不可用;拒绝明文落盘。' };
    }
    let apiKeyEnc;
    try {
      apiKeyEnc = secretBox.seal(checked.value.apiKey);
      if (secretBox.unseal(apiKeyEnc) !== checked.value.apiKey) {
        return { ok: false, error: 'secret_roundtrip_failed' };
      }
    } catch (err) {
      return { ok: false, error: redact(err?.message, [checked.value.apiKey]) };
    }

    const duplicate = Object.values(profileEffective).find((one) => (
      one.provider === checked.value.provider
      && one.baseUrl === checked.value.baseUrl
      && one.model === checked.value.model
      && one.apiKey === checked.value.apiKey
    ));
    const id = current?.id ?? duplicate?.id ?? `mp_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const raw = {
      id,
      label: String(input.label ?? current?.label ?? `${checked.value.provider}/${checked.value.model}`).trim().slice(0, 80),
      provider: checked.value.provider,
      baseUrl: checked.value.baseUrl,
      model: checked.value.model,
      reasoning: checked.value.reasoning,
      apiKeyEnc,
      createdAt: current?.createdAt ?? now(),
      updatedAt: now(),
    };
    const nextProfiles = profileStore().filter((one) => one?.id !== id);
    nextProfiles.push(raw);
    try {
      writeState(slotStore(), nextProfiles);
    } catch (err) {
      return { ok: false, error: `write_failed:${err?.code ?? 'unknown'}` };
    }
    store = { ...store, profiles: nextProfiles };
    const resolved = resolveProfile(raw);
    if (resolved.ok) {
      profileEffective[id] = resolved.config;
      profileClients[id] = resolved.client;
    }
    appendAudit(auditRow('profile_save', id, {
      by, provider: checked.value.provider, model: checked.value.model, key: checked.value.apiKey,
    }));
    return { ok: true, profile: resolved.ok ? profileView(resolved.config) : null };
  }

  function deleteProfile(id, { by = null } = {}) {
    const key = String(id ?? '');
    if (!key || (!profileEffective[key] && !profileStore().some((one) => one?.id === key))) {
      return { ok: false, error: 'bad_profile' };
    }
    const nextProfiles = profileStore().filter((one) => one?.id !== key);
    try {
      writeState(slotStore(), nextProfiles);
    } catch (err) {
      return { ok: false, error: `write_failed:${err?.code ?? 'unknown'}` };
    }
    store = { ...store, profiles: nextProfiles };
    delete profileClients[key];
    delete profileEffective[key];
    appendAudit(auditRow('profile_delete', key, { by }));
    return { ok: true, id: key };
  }

  function profiles() {
    return Object.keys(profileEffective).map((id) => profileView(profileEffective[id]));
  }

  function clientForProfile(id) {
    return profileClients[String(id ?? '')] ?? null;
  }

  function profileConfig(id) {
    return profileEffective[String(id ?? '')] ?? null;
  }

  async function save(slot, input = {}, { by = null, testFirst = true } = {}) {
    const key = slotOf(slot);
    if (key === null) return { ok: false, error: 'bad_slot' };
    const current = get(key);
    const checked = validateSlotInput({
      slot: key,
      provider: input.provider ?? current.provider,
      baseUrl: input.baseUrl ?? current.baseUrl,
      model: input.model ?? current.model,
      apiKey: input.apiKey || current.apiKey,
      reasoning: input.reasoning ?? current.reasoning,
    });
    if (!checked.ok) return { ok: false, error: checked.error };
    if (!checked.value.apiKey) return { ok: false, error: 'key_required' };

    if (testFirst !== false) {
      const tested = await test(key, checked.value);
      if (!tested.ok) return { ok: false, error: 'test_failed', test: tested };
    }

    let client;
    try {
      client = createClient({
        baseUrl: checked.value.baseUrl,
        apiKey: checked.value.apiKey,
        model: checked.value.model,
        reasoning: checked.value.reasoning,
        ...clientOptions,
      });
    } catch (err) {
      return { ok: false, error: redact(err?.message, [checked.value.apiKey]) };
    }

    if (!secretBox?.available) {
      return { ok: false, error: 'secret_unavailable', note: 'DPAPI 不可用;拒绝明文落盘,请检查 Windows 用户环境。' };
    }
    let apiKeyEnc;
    try {
      apiKeyEnc = secretBox.seal(checked.value.apiKey);
      const back = secretBox.unseal(apiKeyEnc);
      if (back !== checked.value.apiKey) return { ok: false, error: 'secret_roundtrip_failed' };
    } catch (err) {
      return { ok: false, error: redact(err?.message, [checked.value.apiKey]) };
    }

    const next = {
      provider: checked.value.provider,
      baseUrl: checked.value.baseUrl,
      model: checked.value.model,
      reasoning: checked.value.reasoning,
      apiKeyEnc,
      updatedAt: now(),
      updatedBy: by ?? null,
    };
    const nextSlots = { ...slotStore(), [key]: next };
    try {
      writeState(nextSlots, profileStore());
    } catch (err) {
      return { ok: false, error: `write_failed:${err?.code ?? 'unknown'}` };
    }
    store.slots = nextSlots;
    clients[key] = client;
    effective[key] = { ...buildEffective(key), source: 'panel', updatedAt: next.updatedAt, updatedBy: next.updatedBy };
    delete problems[key];
    appendAudit(auditRow('save', key, {
      by, provider: checked.value.provider, model: checked.value.model, key: checked.value.apiKey,
    }));
    return { ok: true, slot: key, view: publicSlotView(effective[key]) };
  }

  async function reset(slot, { by = null } = {}) {
    const key = slotOf(slot);
    if (key === null) return { ok: false, error: 'bad_slot' };
    const slots = { ...slotStore() };
    delete slots[key];
    try {
      writeState(slots, profileStore());
    } catch (err) {
      return { ok: false, error: `write_failed:${err?.code ?? 'unknown'}` };
    }
    store.slots = slots;
    refreshSlot(key);
    appendAudit(auditRow('reset', key, { by }));
    return { ok: true, slot: key, view: publicSlotView(effective[key]) };
  }

  function info() {
    return {
      file,
      loadError,
      secretAvailable: Boolean(secretBox?.available),
      slots: Object.fromEntries(MODEL_SLOTS.map((slot) => [slot, publicSlotView(get(slot))])),
      profiles: profiles(),
      providers: PROVIDERS,
      audit: readAudit(12),
      problems: Object.fromEntries(MODEL_SLOTS.map((slot) => [slot, problem(slot)]).filter(([, value]) => value)),
    };
  }

  return {
    load, reload, watch, close, scoped, save, reset, test, info, isConfigured, problem, get,
    saveProfile, deleteProfile, profiles, clientForProfile, profileConfig,
  };
}
