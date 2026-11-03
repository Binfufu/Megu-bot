import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFeedStore } from '../src/feed.js';
import { sourceInterval, nextDue, runFeedCycle } from './feed-watch.mjs';
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
