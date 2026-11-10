#!/usr/bin/env node
/** Independent local monitor v0.1.0. No bot imports, .env, QQ or model calls.
 * Run: node scripts/feed-watch.mjs once|watch|status|inbox [--root E:/...]
 * Normal high-frequency checks align to 00/10/20/30/40/50 Asia/Shanghai.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openFeedStore, nextAlignedCheck } from '../src/feed.js';
import { FIXED_FEED_SOURCES, parseFeedSource } from '../src/feed-sources.js';
import { fetchFeedSource } from '../src/feed-fetch.js';

export function sourceInterval(source) {
  if (!['high','low'].includes(source.frequency)) throw new Error('feed_frequency_invalid');
  const interval = source.intervalMs ?? (source.frequency === 'high' ? 600_000 : null);
  // Low-frequency sources require an explicit policy; do not invent shopping intervals.
  if (interval === null) return null;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error('feed_interval_invalid');
  return interval;
}
export function nextDue(source, state) {
  const interval = sourceInterval(source);
  if (interval === null) return null;
  if (!state?.lastCheckAt) return 0;
  return Math.max(nextAlignedCheck(state.lastCheckAt, interval), state.retryAt || 0);
}
// SQLite extended result code -> canonical name. node:sqlite reports the generic
// `code: 'ERR_SQLITE_ERROR'` and keeps the real reason in errcode/errstr; without this
// map a busy/full/corrupt database would all log the same opaque code.
const SQLITE_CODES = new Map([
  [1, 'SQLITE_ERROR'], [2, 'SQLITE_INTERNAL'], [3, 'SQLITE_PERM'], [4, 'SQLITE_ABORT'],
  [5, 'SQLITE_BUSY'], [6, 'SQLITE_LOCKED'], [7, 'SQLITE_NOMEM'], [8, 'SQLITE_READONLY'],
  [9, 'SQLITE_INTERRUPT'], [10, 'SQLITE_IOERR'], [11, 'SQLITE_CORRUPT'], [13, 'SQLITE_FULL'],
  [14, 'SQLITE_CANTOPEN'], [15, 'SQLITE_PROTOCOL'], [17, 'SQLITE_SCHEMA'], [18, 'SQLITE_TOOBIG'],
  [19, 'SQLITE_CONSTRAINT'], [20, 'SQLITE_MISMATCH'], [21, 'SQLITE_MISUSE'], [22, 'SQLITE_NOLFS'],
  [23, 'SQLITE_AUTH'], [24, 'SQLITE_FORMAT'], [25, 'SQLITE_RANGE'], [26, 'SQLITE_NOTADB'],
  [27, 'SQLITE_NOTICE'], [28, 'SQLITE_WARNING'],
]);
// Detail is bounded and must stay printable ASCII: monitor.jsonl is a log, never a data
// exfiltration path. Credentials, drive paths, file: URIs and URL query strings are
// removed BEFORE the whitelist check; anything else unusual degrades to the code alone.
const ERROR_DETAIL_LIMIT = 160;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
export function sanitizeErrorDetail(detail) {
  let text = String(detail ?? '');
  text = text.replace(/file:\/\/[^\s"'<>]*/gi, '<path>');
  text = text.replace(/\\\\[^\s"'<>]+/g, '<path>'); // UNC \\server\share\...
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, url => {
    try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
    catch { return '<url>'; }
  });
  // A drive path is letter+":"+slash NOT preceded by an alphanumeric/scheme character,
  // so the "s://" inside "https://..." is not mistaken for a drive.
  text = text.replace(/(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s"'<>]*/g, '<path>');
  // Absolute POSIX path (2+ segments, not preceded by a scheme/host character). URLs were
  // already normalized to scheme//host/pathname above, so their host segment is excluded.
  text = text.replace(/(?<![A-Za-z0-9:/])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, '<path>');
  text = text.replace(/\b(bearer)\s+[^\s,;]+/gi, '$1 <redacted>');
  // Whole Authorization-style header: value may be "Basic <base64>" / "Bearer <jwt>".
  text = text.replace(/\b(authorization|auth(?:entication)?)\s*[:=]\s*[^\r\n,;]+/gi, '$1=<redacted>');
  // Key=value / key: value for any credential-ish key name, including client_secret,
  // access_token, SECRET_KEY and friends (no word boundary: '_' is a word character, so
  // "client_secret" would otherwise slip past a \b-anchored keyword list).
  text = text.replace(/(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|credential|api[-_]?key|private[-_]?key|access[-_]?key|session[-_]?key)[A-Za-z0-9_.-]*)\s*[=:]\s*([^\s,;]+)/gi, '$1=<redacted>');
  text = text.replace(/\b(sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}/g, '<redacted>');
  text = text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '<redacted>');
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<redacted>');
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted>');
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted>'); // JWT
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, ERROR_DETAIL_LIMIT);
}
/** 'CODE: bounded redacted reason' for monitor.jsonl; never raw paths/secrets/URL queries. */
export function safeError(error) {
  const raw = String(error?.message ?? '').trim();
  let code = '';
  let detail = raw;
  // "SHOUTING_CODE: reason" (SQLITE_BUSY, ENOTFOUND, HTTP_500_WRAPPER, ...) keeps the code.
  const prefixed = raw.match(/^([A-Z][A-Z0-9_]{2,40})\s*:\s*([\s\S]*)$/);
  if (prefixed) { code = prefixed[1]; detail = prefixed[2]; }
  else if (Number.isSafeInteger(error?.errcode)) {
    // node:sqlite reports extended codes (1555 = SQLITE_CONSTRAINT_UNIQUE, ...). Keep the
    // primary verb from the low byte and the readable message; errstr is only a fallback.
    const primary = error.errcode & 0xff;
    code = SQLITE_CODES.get(primary) ?? `SQLITE_ERRCODE_${primary}`;
    if (error.errcode !== primary) code = `${code}_${error.errcode}`;
    detail = typeof error?.errstr === 'string' && error.errstr.trim() ? error.errstr : raw;
    if (typeof error?.message === 'string' && error.message.trim()) detail = error.message;
  }
  // Redaction runs BEFORE the plain-token shortcut: a message that is only a secret shape
  // (sk_live_..., ghp_..., a JWT) must never be echoed verbatim as a "machine token".
  const clean = sanitizeErrorDetail(detail);
  if (!code && clean === raw && /^[A-Za-z][A-Za-z0-9_:-]{2,99}$/.test(raw)) return raw;
  if (!code) code = String(error?.code ?? '').trim() || 'feed_error';
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{1,99}$/.test(code)) code = 'feed_error';
  if (!clean || !PRINTABLE_ASCII.test(clean)) return code;
  return `${code}: ${clean}`;
}
// Stale = now - lastSuccessAt > max(3 x interval, 30 min); the 30 min floor keeps a
// single missed high-frequency slot from crying wolf. A source that never succeeded has
// no lastSuccessAt yet, so stale stays false and continuous failure is what surfaces it.
const STALE_FLOOR_MS = 1_800_000;
export function staleThreshold(source) {
  const interval = sourceInterval(source);
  return interval === null ? null : Math.max(3 * interval, STALE_FLOOR_MS);
}
export function sourceHealth(source, state, now) {
  const threshold = staleThreshold(source);
  const lastSuccessAt = state?.lastSuccessAt ?? null;
  const staleMinutes = lastSuccessAt ? Math.max(0, Math.floor((now - lastSuccessAt) / 60_000)) : null;
  return { stale: threshold !== null && lastSuccessAt !== null && now - lastSuccessAt > threshold, staleMinutes };
}
// Per-source alert throttle: in memory on purpose (no extra state file); a process
// restart may repeat at most one alert sooner. Rate limit is per source, not per kind,
// so one source never emits more than one feed_alert per hour.
const ALERT_THROTTLE_MS = 3_600_000;
const defaultAlertThrottle = new Map();
export function alertFeedHealth({ store, sources, now, log, throttle = defaultAlertThrottle }) {
  for (const source of sources) {
    const state = store.sourceState(source.id);
    const health = sourceHealth(source, state, now);
    const kind = health.stale ? 'stale' : ((state?.consecutiveFailures ?? 0) >= 3 ? 'failing' : null);
    if (!kind) continue;
    const previous = throttle.get(source.id);
    if (previous !== undefined && now - previous < ALERT_THROTTLE_MS) continue;
    // Log first, throttle second: a failed append must not consume the hourly slot.
    log({ event: 'feed_alert', source: source.id, kind, minutes: health.staleMinutes, at: new Date(now).toISOString() });
    throttle.set(source.id, now);
  }
}
// Heartbeat: the single-instance lock alone cannot tell "our observer" from a reused PID.
// The watch loop rewrites this file at least every 5 minutes; a lock whose heartbeat is
// older than 30 minutes is treated as a hung/reused process and may be reclaimed (and the
// watchdog stops+restarts the task). Missing heartbeat = older build: never called dead.
const HEARTBEAT_FILE = 'monitor.heartbeat';
const HEARTBEAT_MAX_AGE_MS = 30 * 60_000;
function writeHeartbeat(root, now = Date.now()) {
  try { fs.writeFileSync(path.join(root, HEARTBEAT_FILE), JSON.stringify({ pid: process.pid, at: now })); }
  catch { /* heartbeat is advisory status, never the authoritative lock */ }
}
function heartbeatState(root, pid, now) {
  let heartbeat;
  try { heartbeat = JSON.parse(fs.readFileSync(path.join(root, HEARTBEAT_FILE), 'utf8')); }
  catch (error) { return error?.code === 'ENOENT' ? 'missing' : 'invalid'; }
  if (!Number.isSafeInteger(heartbeat?.at) || !Number.isSafeInteger(heartbeat?.pid)) return 'invalid';
  if (heartbeat.pid !== pid) return 'stale';
  return now - heartbeat.at > HEARTBEAT_MAX_AGE_MS ? 'stale' : 'fresh';
}
/** Current monitor pid from the single-instance lock, or null when not running/hung/dead. */
export function readMonitorPid(root, now = Date.now()) {
  let prior;
  try { prior = JSON.parse(fs.readFileSync(path.join(root, 'monitor.lock'), 'utf8')); }
  catch { return null; }
  if (!Number.isSafeInteger(prior?.pid) || prior.pid <= 0) return null;
  try { process.kill(prior.pid, 0); } catch { return null; }
  return heartbeatState(root, prior.pid, now) === 'stale' ? null : prior.pid;
}
export function buildStatus({ store, sources = FIXED_FEED_SOURCES, root, now = Date.now() }) {
  const pid = readMonitorPid(root, now);
  const lastSuccess = Math.max(0, ...sources.map(source => store.sourceState(source.id)?.lastSuccessAt ?? 0));
  return {
    root,
    timezone: 'Asia/Shanghai',
    monitor: { running: pid !== null, pid },
    // When the observer process is gone this is the observable silence duration; it is
    // measured from the most recent successful check so it does not count planned idleness.
    downForMinutes: pid !== null ? 0 : (lastSuccess ? Math.max(0, Math.floor((now - lastSuccess) / 60_000)) : null),
    sources: sources.map(source => {
      const state = store.sourceState(source.id);
      return { id: source.id, frequency: source.frequency, intervalMs: sourceInterval(source), state, nextDue: nextDue(source, state), ...sourceHealth(source, state, now) };
    }),
    store: store.status(),
  };
}
function exportLatest(store, root, sources) {
  const directory=path.join(root,'latest');fs.mkdirSync(directory,{recursive:true});
  for(const source of sources) {
    if(!/^[a-z0-9-]+$/.test(source.id)) throw new Error('feed_source_id_invalid');
    const destination=path.join(directory,source.id+'.json');
    const temporary=path.join(directory,'.'+source.id+'.'+randomUUID()+'.tmp');
    try {
      fs.writeFileSync(temporary,JSON.stringify({sourceId:source.id,sourceName:source.name,url:source.url,state:store.sourceState(source.id),items:store.latestItems(source.id)},null,2)+'\n',{flag:'wx',encoding:'utf8'});
      // Windows 上杀软/索引器会在写入后短暂锁住新文件，rename 偶发 EPERM/EBUSY/EACCES
      // （2026-11-11 公仓发布闸门实测：全量里 selftest-feed-watch 的「每日额度」用例因此偶发红，
      // 单独连跑 5 次 4 绿 1 红，错误原文是 EPERM rename）。同一份字节重试即成功，不改语义。
      let renamed=false;let lastError;
      for(let attempt=0;attempt<6 && !renamed;attempt+=1){
        try{ fs.renameSync(temporary,destination); renamed=true; }
        catch(error){
          lastError=error;
          if(!['EPERM','EBUSY','EACCES'].includes(error?.code) || attempt===5) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40*(attempt+1));
        }
      }
      if(!renamed) throw lastError;
    } finally { if(fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
export async function runFeedCycle({ store, root, sources = FIXED_FEED_SOURCES, now = () => Date.now(), fetchSource = fetchFeedSource, parse = parseFeedSource, force = false, log = () => {}, throttle = defaultAlertThrottle }) {
  const results = [];
  // Export pending inbox first: recover a previous crash between DB commit and file delivery.
  store.exportInbox(path.join(root,'inbox'));
  exportLatest(store,root,sources);
  for (const source of sources) {
    const before = store.sourceState(source.id);
    const due = nextDue(source,before);
    if (due === null || (!force && due > now())) continue;
    // Even an explicit manual check must not bypass a server Retry-After.
    if (before?.retryAt > now()) continue;
    const checkedAt = now();
    try {
      const response = await fetchSource(source,store.latestItems(source.id).length ? (before || {}) : {},{now:checkedAt});
      let applied;
      if (response.status === 304) {
        applied = store.recordNotModified(source,{now:checkedAt,etag:response.etag || before?.etag,lastModified:response.lastModified || before?.lastModified});
      } else {
        const items = parse(source,response.text);
        applied = store.applySnapshot(source,items,{now:checkedAt,coalesceMs:source.coalesceMs,maxPerKeyPerDay:source.maxInboxPerKeyPerDay,etag:response.etag,lastModified:response.lastModified});
      }
      store.exportInbox(path.join(root,'inbox'));
      exportLatest(store,root,[source]);
      const result = {source:source.id,at:new Date(checkedAt).toISOString(),ok:true,http:response.status,result:applied ?? null};
      results.push(result); log(result);
    } catch (error) {
      const failures = (before?.consecutiveFailures || 0) + 1;
      // Provisional operational cap: normal 10-minute period, exponential failure backoff up to 6h.
      // Server Retry-After always takes precedence, including values beyond that cap.
      const retryAt = Math.max(Number(error?.retryAt) || 0, checkedAt + Math.min(21_600_000,600_000 * 2 ** Math.min(failures-1,6)));
      store.recordFailure(source,{now:checkedAt,error:safeError(error),retryAt});
      exportLatest(store,root,[source]);
      const result = {source:source.id,at:new Date(checkedAt).toISOString(),ok:false,error:safeError(error),retryAt:new Date(retryAt).toISOString()};
      results.push(result); log(result);
    }
  }
  // End-of-cycle health projection: log only (no QQ, no model call); stale/failing are
  // derived from persisted state so a skipped or failed check still surfaces.
  alertFeedHealth({ store, sources, now: now(), log, throttle });
  return results;
}
function acquireLock(root) {
  const target = path.join(root,'monitor.lock');
  const owner = JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()});
  for (let attempt=0;attempt<2;attempt++) {
    try { fs.writeFileSync(target,owner,{flag:'wx'}); return () => { if (fs.existsSync(target) && fs.readFileSync(target,'utf8')===owner) fs.unlinkSync(target); }; }
    catch (error) {
      if (error.code!=='EEXIST') throw error;
      const prior=JSON.parse(fs.readFileSync(target,'utf8'));
      if (!Number.isSafeInteger(prior.pid) || prior.pid<=0) throw new Error('feed_lock_invalid_manual_review');
      try { process.kill(prior.pid,0); } catch (probe) {
        if (probe.code==='ESRCH') { fs.unlinkSync(target); continue; }
        throw new Error('feed_lock_owner_unknown');
      }
      // Live PID but stale heartbeat = hung observer or a reused PID from some other
      // process; reclaim the residual lock so the watchdog's restart can proceed.
      if (heartbeatState(root, prior.pid, Date.now()) === 'stale') { fs.unlinkSync(target); continue; }
      throw new Error('feed_monitor_already_running');
    }
  }
  throw new Error('feed_lock_unavailable');
}
export async function main(argv=process.argv.slice(2)) {
  const command=argv[0];
  if (!['once','watch','status','inbox'].includes(command)) throw new Error('usage: feed-watch.mjs once|watch|status|inbox [--root path] [--limit 1..200] [--newest]');
  let root=fileURLToPath(new URL('../data/feed-watch/',import.meta.url));
  let limit=100;
  let newest=false;
  for (let i=1;i<argv.length;i++) {
    if (argv[i]==='--root' && argv[i+1]) root=argv[++i];
    else if (argv[i]==='--limit' && argv[i+1]) { limit=Number(argv[++i]); if (!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error('feed_limit_invalid'); }
    else if (argv[i]==='--newest') newest=true;
    else throw new Error('feed_argument_invalid');
  }
  // --newest only changes the read view of inbox; exporting keeps its stable ascending IDs.
  if (newest && command!=='inbox') throw new Error('feed_argument_invalid');
  root=path.resolve(root);
  fs.mkdirSync(root,{recursive:true});
  const unlock=['once','watch'].includes(command) ? acquireLock(root) : () => {};
  // Both one-shot and long-running observers are "the observer" for lock/liveness checks;
  // write the heartbeat immediately so a second process never mistakes a live `once` for a
  // hung/reused PID.
  if(['once','watch'].includes(command)) writeHeartbeat(root);
  let store;
  let stopping=false;
  let wake=()=>{};
  const stop=()=>{stopping=true;wake();};
  const log=(entry)=>{
    const line=JSON.stringify(entry);
    fs.appendFileSync(path.join(root,'monitor.jsonl'),line+'\n','utf8');
    console.log(line);
  };
  try {
    store=openFeedStore(path.join(root,'feed.db'));
    if(command==='status') {
      console.log(JSON.stringify(buildStatus({store,sources:FIXED_FEED_SOURCES,root}),null,2)); return;
    }
    if(command==='inbox') {console.log(JSON.stringify(store.listInbox({limit, order:newest?'desc':'asc'}),null,2));return;}
    if(command==='once') {
      const results=await runFeedCycle({store,root,force:true,log});
      if(results.some(item=>!item.ok)) process.exitCode=1;
      return;
    }
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    log({event:'monitor_started',pid:process.pid,root,frequency:'high',intervalMinutes:10,timezone:'Asia/Shanghai',slots:'00,10,20,30,40,50',sources:FIXED_FEED_SOURCES.map(s=>s.id),at:new Date().toISOString()});
    writeHeartbeat(root);
    while(!stopping) {
      await runFeedCycle({store,root,log});
      writeHeartbeat(root);
      if(stopping) break;
      const dueTimes=FIXED_FEED_SOURCES.map(source=>nextDue(source,store.sourceState(source.id))).filter(value=>value!==null);
      const dueAt=Math.min(...dueTimes);
      // Wake at least every 5 minutes so the heartbeat stays fresh even for long
      // low-frequency gaps; the actual check still happens exactly at the due grid.
      while(!stopping) {
        const remaining=dueAt-Date.now();
        if(!(remaining>0)) break;
        writeHeartbeat(root);
        await new Promise(resolve=>{ const timer=setTimeout(resolve,Math.min(remaining,300_000));wake=()=>{clearTimeout(timer);resolve();}; });
      }
    }
    log({event:'monitor_stopped',at:new Date().toISOString()});
  } finally {
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    store?.close();unlock();
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(safeError(error));process.exitCode=1;});
