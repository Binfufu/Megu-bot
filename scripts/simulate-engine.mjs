/** Isolated engine lifecycle diagnostics. No QQ, no production DB writes.
 * --diagnose: deterministic probes (no API); exit 1 means acceptance defects found.
 * --run: real API probes with scaled compression budget, explicitly NOT production load benchmark.
 * --selftest: probe integrity only; does not claim engine acceptance.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { approxTokens } from '../src/dream-cards.js';
import { budgetFor } from '../src/context-budget.js';
import { createLlmClient } from '../src/llm.js';
import { readEnvFileValue } from '../src/bot-home.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACT = '本次唯一行动代号是澄月七号，目的地是旧钟楼，任务是归还蓝色钥匙。';
const QUESTION = '这次行动的代号、目的地和任务分别是什么？只依据之前说过的事实，不知道就明确说不知道，不要猜。';
// Test-only scaled budget, never loaded by production config.
const SCALED = { ...budgetFor('world'), triggerTokens: 900, keepRecentTokens: 160, summaryCapTokens: 180, hysteresisMarginTokens: 100 };
const text = messages => messages.map(m => m.content).join('\n');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function fixture(dir, name, persona = '你是一个聊天助手。只依据已给出的事实作答，不知道就明确说不知道。') {
  const location = path.join(dir, name); fs.mkdirSync(location, { recursive: true });
  const personaPath = path.join(location, 'persona.txt'); fs.writeFileSync(personaPath, persona);
  return { store: new SqliteStateStore(path.join(location, 'state.db')), personaPath, location };
}
function seed(store, key, targetTokens) {
  store.appendConversationTurn({ key, role: 'user', content: FACT });
  store.appendConversationTurn({ key, role: 'assistant', content: '记住了。' });
  let tokens = store.conversationTurns(key).reduce((n,r) => n+r.tokens, 0);
  let rows = 0;
  while (tokens < targetTokens) {
    const content = `无关闲聊第${rows}段：` + '今日微风，桌上有纸张，墙上挂着画，窗边放着水杯。'.repeat(20);
    store.appendConversationTurn({ key, role: rows % 2 ? 'assistant' : 'user', content });
    tokens += approxTokens(content); rows++;
  }
  return { tokens, rows: rows+2 };
}
function fake(summary = FACT, fail = false) {
  const calls = [];
  return { calls, async chat(messages, options) {
    const compression = messages.length === 1 && messages[0].content.startsWith('你在为一只长期扮演');
    calls.push({ compression, messages: structuredClone(messages), options });
    if (compression && fail) throw new Error('simulated summary failure');
    return { text: compression ? summary : '收到。', usage: { promptTokens: 10, completionTokens: 2, cacheHitTokens: 0 } };
  } };
}
async function withEngine(fx, llm, budget, fn, extras = {}) {
  const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, budget, log: { warn() {} }, ...extras });
  await engine.initialize();
  try { return await fn(engine); } finally { await engine.stop(); }
}
export async function diagnose(dir) {
  fs.mkdirSync(dir, { recursive: true }); const results = [];
  const add = (id, passed, evidence) => results.push({ id, passed, evidence });
  {
    const fx = fixture(dir, 'below-trigger'); const llm = fake(); const b = budgetFor('world');
    const history = seed(fx.store, 'k', b.keepRecentTokens + 3000);
    await withEngine(fx, llm, b, engine => engine.runTurn('k', QUESTION));
    const sent = llm.calls.at(-1);
    add('below-trigger-fact-preserved', text(sent.messages).includes('澄月七号'), { history, triggerTokens: b.triggerTokens,
      summaries: llm.calls.filter(c => c.compression).length, controlLatestPresent: text(sent.messages).includes('无关闲聊'), factSent: text(sent.messages).includes('澄月七号') });
    fx.store.close();
  }
  {
    const fx = fixture(dir, 'summary-failure'); const llm = fake(FACT, true); seed(fx.store, 'k', 1200);
    await withEngine(fx, llm, SCALED, engine => engine.runTurn('k', QUESTION));
    add('summary-failure-does-not-drop-fact', text(llm.calls.at(-1).messages).includes('澄月七号'), { summaryAttempted: llm.calls.some(c => c.compression), factSent: text(llm.calls.at(-1).messages).includes('澄月七号') });
    fx.store.close();
  }
  {
    const fx = fixture(dir, 'restart'); const llm = fake(); seed(fx.store, 'k', 1200);
    await withEngine(fx, llm, SCALED, engine => engine.runTurn('k', QUESTION)); fx.store.close();
    fx.store = new SqliteStateStore(path.join(fx.location, 'state.db')); const second = fake();
    await withEngine(fx, second, SCALED, engine => engine.runTurn('k', QUESTION));
    add('restart-restores-summary-without-paid-regeneration', !second.calls.some(c => c.compression), { firstSummaryCalls: llm.calls.filter(c=>c.compression).length, afterReopenSummaryCalls: second.calls.filter(c=>c.compression).length }); fx.store.close();
  }
  {
    const fx = fixture(dir, 'reset'); const llm = fake(); fx.store.appendConversationTurn({key:'k',role:'user',content:FACT});
    await withEngine(fx,llm,null,async engine => { await engine.runTurn('k','收到吗'); engine.resetConversation('k'); await engine.runTurn('k', QUESTION); });
    add('reset-isolates-old-context', !text(llm.calls.at(-1).messages).includes('澄月七号'), { oldFactSentAfterReset: text(llm.calls.at(-1).messages).includes('澄月七号') }); fx.store.close();
  }
  {
    const fx = fixture(dir, 'contributors'); const llm = fake(); let n=0;
    await withEngine(fx,llm,null,async engine => { await engine.runTurn('k','第一轮'); await engine.runTurn('k','第二轮'); },
      { turnContributors:[{ kind:'facts', render:()=>`临时指纹第${++n}轮` }] });
    // T1-A(2026-10-29):贡献者注入只活**当前轮** —— 上一轮的临时指纹从历史投影里剥离,
    // 本轮的新指纹照常送达(易变注入的语义本来就该如此)。
    add('contributor-inject-current-only',
      !text(llm.calls[1].messages).includes('临时指纹第1轮') && text(llm.calls[1].messages).includes('临时指纹第2轮'),
      { firstSent: text(llm.calls[0].messages).includes('临时指纹第1轮'), secondIncludesPrevious: text(llm.calls[1].messages).includes('临时指纹第1轮'), secondIncludesCurrent: text(llm.calls[1].messages).includes('临时指纹第2轮') }); fx.store.close();
  }
  {
    const fx=fixture(dir,'summary-cap'); const llm=fake('摘要测试。'.repeat(500)); seed(fx.store,'k',1200);
    await withEngine(fx,llm,SCALED,engine=>engine.runTurn('k',QUESTION));
    const summary=llm.calls.at(-1).messages.filter(m=>m.role==='system').slice(1).map(m=>m.content).join('');
    add('summary-cap-enforced',approxTokens(summary)<=SCALED.summaryCapTokens && text(llm.calls.at(-1).messages).includes('澄月七号'),{sentSummaryTokens:approxTokens(summary),cap:SCALED.summaryCapTokens,originalFactRetained:text(llm.calls.at(-1).messages).includes('澄月七号')}); fx.store.close();
  }
  {
    const fx=fixture(dir,'conversation-isolation'); const llm=fake(); fx.store.appendConversationTurn({key:'a',role:'user',content:FACT});
    await withEngine(fx,llm,null,engine=>engine.runTurn('b',QUESTION));
    add('conversation-keys-isolated',!text(llm.calls.at(-1).messages).includes('澄月七号'),{otherConversationFactSent:text(llm.calls.at(-1).messages).includes('澄月七号')}); fx.store.close();
  }
  fs.writeFileSync(path.join(dir,'diagnostics.json'),JSON.stringify({scope:'Deterministic consumption-side diagnostics. Scaled budgets test control flow, not production token pricing.',results},null,2));
  return results;
}
export function probeIntegrity() {
  const b=budgetFor('world'); assert.ok(b.keepRecentTokens+3000<b.triggerTokens);
  assert.ok(SCALED.keepRecentTokens<SCALED.triggerTokens);
  assert.ok(!QUESTION.includes('澄月七号') && !QUESTION.includes('旧钟楼') && !QUESTION.includes('蓝色钥匙'));
  assert.ok(FACT.includes('澄月七号')); return true;
}
async function runReal(dir) {
  const envFile=path.join(ROOT,'bots','megumin','.env');const env=key=>readEnvFileValue(envFile,key);
  const apiKey=env('QQBOT_LLM_KEY')||env('QQBOT_LLM_DREAM_KEY'); if(!apiKey) throw new Error('Missing API key');
  const client=createLlmClient({apiKey,baseUrl:env('QQBOT_LLM_BASEURL')||env('QQBOT_LLM_DREAM_BASEURL')||'https://api.deepseek.com/v1',model:env('QQBOT_LLM_MODEL')||env('QQBOT_LLM_DREAM_MODEL')||'deepseek-chat',timeoutMs:60000});
  const report={scope:'Synthetic lifecycle real API. Neutral test persona, scaled compression budget; not historical personality A/B or production load/TTL test.',runs:[]};
  const perform=async(fx,budget,label)=>{
    const calls=[];
    const llm={chat:async(messages,opts)=>{ const captured={messages:structuredClone(messages)};calls.push(captured); const start=Date.now();const r=await client.chat(messages,opts);Object.assign(captured,{ms:Date.now()-start,usage:r.usage,reply:r.text,model:r.model}); return r; }};
    try {const answer=await withEngine(fx,llm,budget,engine=>engine.runTurn('k',QUESTION)); const reply=answer.text;
      const factPassed=['澄月七号','旧钟楼','蓝色钥匙'].every(word=>reply.includes(word));
      report.runs.push({label,reply,factPassed,calls}); console.log(`${label}: facts=${factPassed} reply=${JSON.stringify(reply)} calls=${calls.length}`);
    }catch(err){report.runs.push({label,error:err.message,calls});}
    fs.writeFileSync(path.join(dir,'real.json'),JSON.stringify(report,null,2));
  };
  const first=fixture(dir,'real-below-trigger');seed(first.store,'k',budgetFor('world').keepRecentTokens+3000);
  await perform(first,budgetFor('world'),'below-production-trigger');first.store.close();
  const compact=fixture(dir,'real-compaction');seed(compact.store,'k',1200);
  await perform(compact,SCALED,'scaled-compaction');compact.store.close();
  compact.store=new SqliteStateStore(path.join(compact.location,'state.db'));
  await perform(compact,SCALED,'reopen-after-compaction');compact.store.close();
  const lines=['# 长对话与生命周期模拟','',report.scope,''];
  for(const r of report.runs) lines.push(`## ${r.label}`,`事实检查：${r.factPassed??'error'}`,r.reply||r.error,`调用次数：${r.calls.length}`,`逐次 usage：${JSON.stringify(r.calls.map(c=>({ms:c.ms,usage:c.usage,model:c.model})))}`,'');
  fs.writeFileSync(path.join(dir,'real.md'),lines.join('\n'));return report;
}
async function main(){probeIntegrity();const args=process.argv.slice(2);
  if(args.includes('--selftest')){console.log('simulate-engine: probe integrity passed (not engine acceptance)');return;}
  const dir=path.join(ROOT,'data','replay',`lifecycle-${stamp()}`);fs.mkdirSync(dir,{recursive:true});
  if(args.includes('--diagnose')){const r=await diagnose(dir);for(const x of r)console.log(`${x.passed?'PASS':'FAIL'} ${x.id} ${JSON.stringify(x.evidence)}`);if(r.some(x=>!x.passed))process.exitCode=1;}
  else if(args.includes('--run')){const r=await runReal(dir);if(r.runs.some(x=>x.error||!x.factPassed))process.exitCode=1;}
  else console.log('Use --diagnose (no API), --run (real API), --selftest (probe checks).');
  console.log(`Report directory: ${dir}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
