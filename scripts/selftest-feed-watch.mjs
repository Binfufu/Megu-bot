import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openFeedStore } from '../src/feed.js';
import { sourceInterval, nextDue, runFeedCycle, safeError, sanitizeErrorDetail, buildStatus, sourceHealth } from './feed-watch.mjs';
const parent=fileURLToPath(new URL('../data/index/',import.meta.url));fs.mkdirSync(parent,{recursive:true});
const high={id:'test',name:'Synthetic source',frequency:'high',url:'https://openrouter.ai/api/v1/models'};
const item={key:'one',title:'Synthetic release',url:'https://example.org/release',summary:'Synthetic facts',publishedAt:null};
async function fixture(fn) {
 const root=fs.mkdtempSync(path.join(parent,'feed-watch-test-')); const store=openFeedStore(path.join(root,'feed.db'));
 try{await fn({root,store});}finally{store.close();assert.ok(root.startsWith(path.join(parent,'feed-watch-test-')));fs.rmSync(root,{recursive:true,force:true});}
}
test('high defaults 10min, low requires explicit policy',()=>{
 assert.equal(sourceInterval(high),600000);assert.equal(sourceInterval({...high,frequency:'low'}),null);
 assert.equal(sourceInterval({...high,frequency:'low',intervalMs:21600000}),21600000);
 assert.throws(()=>sourceInterval({...high,frequency:'other'}));assert.throws(()=>sourceInterval({...high,intervalMs:0}));
 assert.equal(nextDue(high,{lastCheckAt:600001,retryAt:2000000}),2000000);
});
test('real runner baseline -> new -> same -> 304 reaches local files once',()=>fixture(async({root,store})=>{
 let clock=600001;let items=[item];let status=200;let requests=0;
 const run=()=>runFeedCycle({root,store,sources:[high],now:()=>clock,fetchSource:async()=>{requests++;return {status,text:'synthetic',etag:'v1'};},parse:()=>items});
 await run();assert.equal(store.status().inboxCount,0);
 assert.equal(store.latestItems(high.id).length,1);
 const latest=JSON.parse(fs.readFileSync(path.join(root,'latest','test.json'),'utf8'));
 assert.equal(latest.items[0].summary,'Synthetic facts');
 await run();assert.equal(requests,1);
 clock=1200000;items=[item,{...item,key:'two',url:'https://example.org/two'}];await run();
 assert.equal(store.status().inboxCount,1);assert.equal(fs.readdirSync(path.join(root,'inbox')).filter(n=>n.endsWith('.json')).length,1);
 const file=path.join(root,'inbox',fs.readdirSync(path.join(root,'inbox'))[0]);assert.equal(JSON.parse(fs.readFileSync(file)).url,'https://example.org/two');
 clock=1800000;await run();assert.equal(store.status().inboxCount,1);
 clock=2400000;status=304;await run();assert.equal(store.sourceState(high.id).lastSuccessAt,clock);assert.equal(store.status().inboxCount,1);
}));
test('one failing source does not prevent another source baseline',()=>fixture(async({root,store})=>{
 const sources=[high,{...high,id:'other'}];
 const results=await runFeedCycle({root,store,sources,now:()=>600000,fetchSource:async s=>{if(s.id==='test')throw new Error('offline');return {status:200,text:'x'};},parse:()=>[item]});
 assert.deepEqual(results.map(r=>r.ok),[false,true]);assert.equal(store.sourceState('test').baseline,false);assert.equal(store.sourceState('other').baseline,true);
 assert.equal(store.sourceState('test').retryAt,1200000);
}));
test('server retry time is not bypassed by manual force or normal due',()=>fixture(async({root,store})=>{
 const error=new Error('limited');error.retryAt=99999999;let calls=0;
 const args={root,store,sources:[high],now:()=>600000,force:true,fetchSource:async()=>{calls++;throw error;}};
 await runFeedCycle(args);await runFeedCycle(args);assert.equal(calls,1);assert.equal(store.sourceState('test').retryAt,99999999);
}));
test('malformed source body cannot replace validators or baseline',()=>fixture(async({root,store})=>{
 store.applySnapshot(high,[item],{now:1,etag:'old'});
 await runFeedCycle({root,store,sources:[high],force:true,now:()=>600000,fetchSource:async()=>({status:200,text:'bad',etag:'new'}),parse:()=>{throw new Error('parse_failed');}});
 assert.equal(store.sourceState('test').etag,'old');assert.equal(store.status().inboxCount,0);
}));
test('runner passes coalesceMs: in-window jitter lands one inbox file, next window adds one',()=>fixture(async({root,store})=>{
 let clock=600001;let items=[item];const logs=[];
 const coalescing={...high,coalesceMs:3600000};
 const files=()=>fs.readdirSync(path.join(root,'inbox')).filter(name=>name.endsWith('.json'));
 const run=()=>runFeedCycle({root,store,sources:[coalescing],now:()=>clock,fetchSource:async()=>({status:200,text:'synthetic'}),parse:()=>items,log:entry=>logs.push(entry)});
 await run();assert.equal(store.status().inboxCount,0);
 clock=1200000;items=[{...item,title:'Price 1',summary:'price 1'}];await run();
 clock=1800000;items=[{...item,title:'Price 2',summary:'price 2'}];await run();
 clock=2400000;items=[{...item,title:'Price 3',summary:'price 3'}];await run();
 assert.equal(store.status().inboxCount,1);assert.equal(files().length,1);
 assert.ok(logs.some(entry=>entry.ok&&entry.result?.coalesced===1));
 const [first]=files().map(name=>JSON.parse(fs.readFileSync(path.join(root,'inbox',name),'utf8')));
 assert.deepEqual([first.title,first.detectedAt,first.type],['Price 3',1200000,'updated']);
 // The window anchored at 1200000 ends at 4800000; 5400000 is the next aligned slot.
 clock=5400000;items=[{...item,title:'Price 4',summary:'price 4'}];await run();
 assert.equal(store.status().inboxCount,2);assert.equal(files().length,2);
 const rows=files().map(name=>JSON.parse(fs.readFileSync(path.join(root,'inbox',name),'utf8'))).sort((a,b)=>a.detectedAt-b.detectedAt);
 assert.deepEqual(rows.map(row=>[row.title,row.detectedAt,row.type]),[['Price 3',1200000,'updated'],['Price 4',5400000,'updated']]);
}));
test('runner passes per-source daily cap: inbox stops at the cap, resets after Beijing midnight',()=>fixture(async({root,store})=>{
 let clock=Date.parse('2026-11-04T23:50:00+08:00');let title='V1';const logs=[];
 const capped={...high,coalesceMs:0,maxInboxPerKeyPerDay:2};
 const files=()=>fs.readdirSync(path.join(root,'inbox')).filter(name=>name.endsWith('.json'));
 // ⚠️ 2026-11-10：runFeedCycle 现在会在每轮**末尾**追加 feed_alert 日志，所以"最后一条"不再
 //    必然是本轮检查记录。这里只从**检查记录**里取最后一条（event!=='feed_alert' 的那些）。
 const cycles=()=>logs.filter(entry=>entry.event!=='feed_alert');
 const run=()=>runFeedCycle({root,store,sources:[capped],now:()=>clock,force:true,fetchSource:async()=>({status:200,text:'synthetic'}),parse:()=>[{...item,title}],log:entry=>logs.push(entry)});
 await run();assert.equal(store.status().inboxCount,0);
 clock+=60_000;title='V2';await run();assert.equal(store.status().inboxCount,1);
 clock+=60_000;title='V3';await run();assert.equal(store.status().inboxCount,2);
 clock+=60_000;title='V4';await run();// cap 2 reached: one more change today is suppressed
 assert.equal(store.status().inboxCount,2);assert.equal(files().length,2);
 assert.deepEqual([cycles().at(-1).ok,cycles().at(-1).result?.inserted,cycles().at(-1).result?.suppressed],[true,0,1],JSON.stringify(logs.slice(-2)));
 clock+=60_000;title='V5';await run();assert.equal(store.status().inboxCount,2);assert.equal(cycles().at(-1).result?.suppressed,1,JSON.stringify(logs.slice(-2)));
 // 00:00:00 +08 next day: the same source+key counts from zero again (cap 2 -> room for V6).
 clock=Date.parse('2026-11-05T00:00:00+08:00');title='V6';await run();
 assert.equal(store.status().inboxCount,3);assert.equal(files().length,3);
 assert.deepEqual([cycles().at(-1).ok,cycles().at(-1).result?.inserted,cycles().at(-1).result?.suppressed],[true,1,0],JSON.stringify(logs.slice(-2)));
 assert.equal(store.latestItems(high.id)[0].title,'V6');
}));

// --- 错误细节（2026-11-10）：错误码 + 截断脱敏消息；反证保留 SQLITE_BUSY 片段、剥路径/凭据 ---
test('safeError keeps the SQLite code and readable reason for busy/full/corrupt',()=>{
 assert.equal(safeError(new Error('SQLITE_BUSY: database is locked')),'SQLITE_BUSY: database is locked');
 const wrapped=(message,errcode,errstr=message)=>{const error=new Error(message);error.code='ERR_SQLITE_ERROR';error.errcode=errcode;error.errstr=errstr;return error;};
 assert.equal(safeError(wrapped('database is locked',5)),'SQLITE_BUSY: database is locked');
 assert.equal(safeError(wrapped('database or disk is full',13)),'SQLITE_FULL: database or disk is full');
 assert.equal(safeError(wrapped('database disk image is malformed',11)),'SQLITE_CORRUPT: database disk image is malformed');
 assert.equal(safeError(wrapped('disk I/O error',10)),'SQLITE_IOERR: disk I/O error');
 // The readable message wins over the generic errstr, and extended codes keep their suffix.
 assert.equal(safeError(wrapped('UNIQUE constraint failed: feed_inbox.id',1555,'constraint failed')),'SQLITE_CONSTRAINT_1555: UNIQUE constraint failed: feed_inbox.id');
 assert.equal(safeError(wrapped('no such table: nope',1,'SQL logic error')),'SQLITE_ERROR: no such table: nope');
 // Real node:sqlite error shape (not a synthetic object) must be readable.
 const realDb=new DatabaseSync(':memory:');
 try{realDb.exec('SELECT * FROM definitely_missing');}catch(error){assert.equal(safeError(error),'SQLITE_ERROR: no such table: definitely_missing');}finally{realDb.close();}
 // Plain machine tokens are preserved; unknown shapes still get a code.
 assert.equal(safeError(new Error('feed_monitor_already_running')),'feed_monitor_already_running');
 assert.match(safeError(Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'),{code:'ENOTFOUND'})),/^ENOTFOUND: getaddrinfo ENOTFOUND openrouter\.ai$/);
});
test('safeError redacts drive paths, file:, URL query and token/bearer values before logging',()=>{
 const leaked=new Error('SQLITE_BUSY: database is locked at E:\\secret\\path file:///E:/secret/db.sqlite token=abc Bearer eyJhbGciOi https://example.org/x?token=abc#frag');
 const safe=safeError(leaked);
 assert.match(safe,/^SQLITE_BUSY: /);
 assert.match(safe,/database is locked/);
 assert.doesNotMatch(safe,/secret|E:\\|file:|token=abc|eyJhbGciOi|frag/);
 assert.match(safe,/<path>/);
 assert.match(safe,/<redacted>/);
 assert.match(safe,/https:\/\/example\.org\/x/);
 // A ordinary URL query is removed even when its keys are not credential-shaped.
 assert.equal(sanitizeErrorDetail('fetch https://example.org/a/b?q=1&foo=bar failed'),'fetch https://example.org/a/b failed');
 // Credential-key bypass shapes found in review: prefixed key names, header values, bare keys.
 for(const message of [
   'SQLITE_BUSY: disk I/O error client_secret=SECRETLEAK',
   'SQLITE_BUSY: disk I/O error access_token=TOKLEAK',
   'SQLITE_BUSY: disk I/O error SECRET_KEY=SKLEAK',
   'SQLITE_BUSY: disk I/O error Authorization: Basic dXNlcjpwYXNz==',
   'SQLITE_BUSY: disk I/O error sk_live_51abcdefghijk',
   'SQLITE_BUSY: disk I/O error ghp_0123456789abcdefghijABCDEFGHIJ',
   'SQLITE_BUSY: disk I/O error api-key=v',
 ]){
   const out=safeError(new Error(message));
   assert.doesNotMatch(out,/SECRETLEAK|TOKLEAK|SKLEAK|dXNlcjpwYXNz|sk_live_51abcdefghijk|ghp_0123456789abcdefghijABCDEFGHIJ|api-key=v/,out);
   assert.match(out,/^SQLITE_BUSY: /);
 }
 // Secret-shaped plain messages are redacted before the plain-token shortcut kicks in.
 assert.equal(safeError(new Error('sk_live_51abcdefghijk')),'feed_error: <redacted>');
 // UNC and absolute POSIX paths are stripped too.
 const paths=safeError(new Error('SQLITE_IOERR: open \\\\fileserver\\share\\prod.env and /home/baiyun/.ssh/id_ed25519 failed'));
 assert.doesNotMatch(paths,/fileserver|share|prod\.env|home\/baiyun|id_ed25519/);
 assert.match(paths,/<path>/);
 // Non-printable / non-ASCII detail is rejected entirely: code only, never mojibake.
 assert.equal(safeError(new Error('SQLITE_BUSY: 数据库忙')),'SQLITE_BUSY');
 // Newlines collapse to one space: monitor.jsonl stays one JSON object per line.
 assert.equal(safeError(new Error('SQLITE_BUSY: bad\nnewline')),'SQLITE_BUSY: bad newline');
 // Detail is bounded; the code prefix is never truncated away.
 const long=safeError(new Error(`SQLITE_IOERR: ${'x'.repeat(500)}`));
 assert.ok(long.length<='SQLITE_IOERR: '.length+160,long.length);
 assert.equal(sanitizeErrorDetail('a E:\\x\\y b').includes('x\\y'),false);
});

// --- 停摆/连续失败告警（2026-11-10，只写日志，不接 QQ/模型）---
test('stale source logs one feed_alert per hour, with minutes and no duplicate inside the hour',()=>fixture(async({root,store})=>{
 const throttle=new Map();const logs=[];let clock=600000;
 const run=(fetchSource)=>runFeedCycle({root,store,sources:[high],now:()=>clock,force:true,throttle,log:entry=>logs.push(entry),fetchSource,parse:()=>[item]});
 const failure=async()=>{throw new Error('ENOTFOUND: getaddrinfo ENOTFOUND openrouter.ai');};
 await run(async()=>({status:200,text:'synthetic'}));
 assert.equal(store.sourceState(high.id).lastSuccessAt,600000);
 const alerts=()=>logs.filter(entry=>entry.event==='feed_alert');
 // Threshold for high = max(3x10min, 30min) = 30min; 31min after success is stale.
 clock=600000+31*60000;
 await run(failure);
 assert.deepEqual(alerts(),[{event:'feed_alert',source:'test',kind:'stale',minutes:31,at:new Date(clock).toISOString()}]);
 // The runner stores/logs the deduped code form, not a generic ERR_SQLITE_ERROR-style token.
 assert.equal(logs.find(entry=>entry.ok===false).error,'ENOTFOUND: getaddrinfo ENOTFOUND openrouter.ai');
 // Same hour, still stale: throttled (in-memory, per source).
 clock+=5*60000;await run(failure);
 assert.equal(alerts().length,1);
 // After the hour the alert is allowed again; the 5-minute retry backoff had skipped the
 // middle check, so failure count is 2 here and the source is still stale.
 clock=600000+31*60000+61*60000;await run(failure);
 assert.equal(alerts().length,2);
 assert.equal(alerts()[1].kind,'stale');
 assert.equal(alerts()[1].minutes,92);
 for(const entry of alerts())assert.deepEqual(Object.keys(entry).sort(),['at','event','kind','minutes','source']);
}));
test('a low-frequency source with 3+ consecutive failures logs kind=failing (never succeeded yet)',()=>fixture(async({root,store})=>{
 const low={...high,frequency:'low',intervalMs:21600000};
 const throttle=new Map();const logs=[];let clock=1000000;
 const failure=async()=>{throw new Error('HTTP 500: upstream unavailable');};
 const run=()=>runFeedCycle({root,store,sources:[low],now:()=>clock,force:true,throttle,log:entry=>logs.push(entry),fetchSource:failure});
 await run();clock=1700000;await run();clock=3000000;await run();
 assert.equal(store.sourceState(high.id).consecutiveFailures,3);
 const alerts=logs.filter(entry=>entry.event==='feed_alert');
 assert.deepEqual(alerts,[{event:'feed_alert',source:'test',kind:'failing',minutes:null,at:new Date(clock).toISOString()}]);
 // One more failure inside the hour stays throttled; after the hour an alert returns.
 clock+=60000;await run();assert.equal(logs.filter(entry=>entry.event==='feed_alert').length,1);
 clock+=3660000;await run();assert.equal(logs.filter(entry=>entry.event==='feed_alert').length,2);
}));

// --- status 带 stale/staleMinutes/downForMinutes（2026-11-10）---
test('status reports per-source stale/staleMinutes and top-level downForMinutes',()=>fixture(({root,store})=>{
 const clock=10000000;
 store.applySnapshot(high,[item],{now:clock-3600000});
 const status=buildStatus({store,sources:[high],root,now:clock});
 assert.equal(status.sources[0].stale,true);
 assert.equal(status.sources[0].staleMinutes,60);
 assert.equal(status.downForMinutes,60);
 assert.deepEqual(status.monitor,{running:false,pid:null});
 assert.equal(status.store.inboxCount,0);
 // A live lock without a heartbeat file is an older build (or a process still starting):
 // liveness cannot be disproven, so it stays "running" (backward compatible).
 fs.writeFileSync(path.join(root,'monitor.lock'),JSON.stringify({pid:process.pid,startedAt:'synthetic'}));
 const noHeartbeat=buildStatus({store,sources:[high],root,now:clock});
 assert.deepEqual(noHeartbeat.monitor,{running:true,pid:process.pid});
 assert.equal(noHeartbeat.downForMinutes,0);
 fs.writeFileSync(path.join(root,'monitor.heartbeat'),JSON.stringify({pid:process.pid,at:clock}));
 const live=buildStatus({store,sources:[high],root,now:clock});
 assert.deepEqual(live.monitor,{running:true,pid:process.pid});
 assert.equal(live.downForMinutes,0);
 // Stale heartbeat (hung observer or reused PID) is not treated as running.
 fs.writeFileSync(path.join(root,'monitor.heartbeat'),JSON.stringify({pid:process.pid,at:clock-31*60000}));
 const hung=buildStatus({store,sources:[high],root,now:clock});
 assert.deepEqual(hung.monitor,{running:false,pid:null});
 assert.equal(hung.downForMinutes,60);
 // Heartbeat belonging to a different PID is also stale.
 fs.writeFileSync(path.join(root,'monitor.heartbeat'),JSON.stringify({pid:process.pid+1,at:clock}));
 assert.deepEqual(buildStatus({store,sources:[high],root,now:clock}).monitor,{running:false,pid:null});
 // Fresh success flips stale off.
 store.applySnapshot(high,[{...item,title:'fresh'}],{now:clock});
 const fresh=buildStatus({store,sources:[high],root,now:clock});
 assert.equal(fresh.sources[0].stale,false);
 assert.equal(fresh.sources[0].staleMinutes,0);
 // downForMinutes uses the MOST RECENT success across sources (max timestamp -> min age),
 // so one fresh source keeps it at 0 while another source's staleMinutes still shows its own age.
 const other={...high,id:'other',name:'Other'};
 store.applySnapshot(other,[{...item,key:'other',url:'https://example.org/other'}],{now:clock-60000});
 const multi=buildStatus({store,sources:[high,other],root,now:clock});
 assert.equal(multi.downForMinutes,0);
 assert.equal(multi.sources.find(source=>source.id==='other').staleMinutes,1);
}));
test('stale threshold is strict (exact boundary is not stale) and low-frequency policy is honoured',()=>{
 const now=10000000;
 // high: max(3*10min, 30min) = 30min; exactly 30min ago is not stale, one ms later is.
 assert.equal(sourceHealth(high,{lastSuccessAt:now-1800000},now).stale,false);
 assert.equal(sourceHealth(high,{lastSuccessAt:now-1799999},now).stale,false);
 assert.equal(sourceHealth(high,{lastSuccessAt:now-1800001},now).stale,true);
 assert.equal(sourceHealth(high,{lastSuccessAt:null},now).stale,false);
 // low with an explicit 6h interval: threshold = max(18h,30min) = 18h.
 const low={...high,frequency:'low',intervalMs:21600000};
 assert.equal(sourceHealth(low,{lastSuccessAt:now-3600000},now).stale,false);
 assert.equal(sourceHealth(low,{lastSuccessAt:now-19*3600000},now).stale,true);
 // low without an explicit interval has no stale policy at all.
 assert.equal(sourceHealth({...high,frequency:'low'},{lastSuccessAt:now-10*3600000},now).stale,false);
});

// --- inbox CLI：默认旧→新，--newest 取最近 N 条（2026-11-10）---
test('inbox CLI defaults to oldest-first and --newest returns the most recent N',()=>fixture(({root,store})=>{
 const times=[2000,3000,4000,5000,6000];
 store.applySnapshot(high,[{...item,title:'V0'}],{now:1000});
 for(const [i,now] of times.entries())store.applySnapshot(high,[{...item,title:`V${i+1}`}],{now});
 const cli=fileURLToPath(new URL('./feed-watch.mjs',import.meta.url));
 const run=extra=>spawnSync(process.execPath,[cli,'inbox','--root',root,'--limit','3',...extra],{encoding:'utf8'});
 const asc=run([]);assert.equal(asc.status,0,asc.stderr);
 assert.deepEqual(JSON.parse(asc.stdout).map(row=>row.detectedAt),[2000,3000,4000]);
 const desc=run(['--newest']);assert.equal(desc.status,0,desc.stderr);
 assert.deepEqual(JSON.parse(desc.stdout).map(row=>row.detectedAt),[6000,5000,4000]);
 assert.deepEqual(JSON.parse(desc.stdout).map(row=>row.title),['V5','V4','V3']);
 assert.equal(run(['--newest','--bogus']).status,1);
 const wrong=spawnSync(process.execPath,[cli,'status','--root',root,'--newest'],{encoding:'utf8'});
 assert.equal(wrong.status,1);assert.match(wrong.stderr,/feed_argument_invalid/);
}));
