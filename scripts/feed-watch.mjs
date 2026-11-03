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
function safeError(error) {
  const message = String(error?.message || 'feed_error');
  return /^[a-zA-Z0-9_:-]{1,100}$/.test(message) ? message : String(error?.code || 'feed_request_or_parse_failed');
}
function exportLatest(store, root, sources) {
  const directory=path.join(root,'latest');fs.mkdirSync(directory,{recursive:true});
  for(const source of sources) {
    if(!/^[a-z0-9-]+$/.test(source.id)) throw new Error('feed_source_id_invalid');
    const destination=path.join(directory,source.id+'.json');
    const temporary=path.join(directory,'.'+source.id+'.'+randomUUID()+'.tmp');
    try {
      fs.writeFileSync(temporary,JSON.stringify({sourceId:source.id,sourceName:source.name,url:source.url,state:store.sourceState(source.id),items:store.latestItems(source.id)},null,2)+'\n',{flag:'wx',encoding:'utf8'});
      fs.renameSync(temporary,destination);
    } finally { if(fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
export async function runFeedCycle({ store, root, sources = FIXED_FEED_SOURCES, now = () => Date.now(), fetchSource = fetchFeedSource, parse = parseFeedSource, force = false, log = () => {} }) {
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
        applied = store.applySnapshot(source,items,{now:checkedAt,coalesceMs:source.coalesceMs,etag:response.etag,lastModified:response.lastModified});
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
      throw new Error('feed_monitor_already_running');
    }
  }
  throw new Error('feed_lock_unavailable');
}
export async function main(argv=process.argv.slice(2)) {
  const command=argv[0];
  if (!['once','watch','status','inbox'].includes(command)) throw new Error('usage: feed-watch.mjs once|watch|status|inbox [--root path] [--limit 1..200]');
  let root=fileURLToPath(new URL('../data/feed-watch/',import.meta.url));
  let limit=100;
  for (let i=1;i<argv.length;i++) {
    if (argv[i]==='--root' && argv[i+1]) root=argv[++i];
    else if (argv[i]==='--limit' && argv[i+1]) { limit=Number(argv[++i]); if (!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error('feed_limit_invalid'); }
    else throw new Error('feed_argument_invalid');
  }
  root=path.resolve(root);
  fs.mkdirSync(root,{recursive:true});
  const unlock=['once','watch'].includes(command) ? acquireLock(root) : () => {};
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
      console.log(JSON.stringify({root,timezone:'Asia/Shanghai',sources:FIXED_FEED_SOURCES.map(source=>({id:source.id,frequency:source.frequency,intervalMs:sourceInterval(source),state:store.sourceState(source.id),nextDue:nextDue(source,store.sourceState(source.id))})),store:store.status()},null,2)); return;
    }
    if(command==='inbox') {console.log(JSON.stringify(store.listInbox({limit}),null,2));return;}
    if(command==='once') {
      const results=await runFeedCycle({store,root,force:true,log});
      if(results.some(item=>!item.ok)) process.exitCode=1;
      return;
    }
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    log({event:'monitor_started',pid:process.pid,root,frequency:'high',intervalMinutes:10,timezone:'Asia/Shanghai',slots:'00,10,20,30,40,50',sources:FIXED_FEED_SOURCES.map(s=>s.id),at:new Date().toISOString()});
    while(!stopping) {
      await runFeedCycle({store,root,log});
      if(stopping) break;
      const dueTimes=FIXED_FEED_SOURCES.map(source=>nextDue(source,store.sourceState(source.id))).filter(value=>value!==null);
      const until=Math.max(250,Math.min(...dueTimes)-Date.now());
      await new Promise(resolve=>{ const timer=setTimeout(resolve,Math.min(until,2_147_483_647));wake=()=>{clearTimeout(timer);resolve();}; });
    }
    log({event:'monitor_stopped',at:new Date().toISOString()});
  } finally {
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    store?.close();unlock();
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(safeError(error));process.exitCode=1;});
