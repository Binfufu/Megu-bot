/** Local feed observer regression, isolated from bot state and real network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SUITES=['selftest-feed.mjs','selftest-feed-fetch.mjs','selftest-feed-sources.mjs','selftest-feed-watch.mjs','selftest-feed-review.mjs'];
export function registerFeedGateTests({test}) {
 test('盯梢回归：全部离线套件均已登记',()=>{
  assert.deepEqual(fs.readdirSync(path.join(ROOT,'scripts')).filter(n=>/^selftest-feed.*\.mjs$/.test(n)).sort(),[...SUITES,'selftest-feed-gates.mjs'].sort());
 });
 for(const suite of SUITES) test(`盯梢离线隔离回归 ${suite}`,()=>{
  const result=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(ROOT,'scripts',suite)],{cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  assert.ifError(result.error);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/# pass [1-9]\d*/);assert.match(result.stdout,/# fail 0/);
 });
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const cases=[];registerFeedGateTests({test:(name,run)=>cases.push([name,run])});let failed=0;
 for(const [name,run] of cases){try{await run();console.log('PASS '+name);}catch(error){failed++;console.error(error.stack);}}
 console.log(JSON.stringify({passed:cases.length-failed,failed}));process.exitCode=failed?1:0;
}
