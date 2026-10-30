#!/usr/bin/env node
/** 独立合成夹具；唯一写入显式传入的新fixture目录，不触共享runner/真实输入。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AuditError, safeCode, normalizeFaces, parsePrivateJSON, classify, analyze, checkPaths, runAudit, txtBody, monthHeader, monthBody, main } from './chat-corpus-audit.mjs';

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let passed=0,failed=0;const checks=[];
function test(fn){try{fn();passed++;checks.push({test:checks.length+1,pass:true});}catch(e){failed++;checks.push({test:checks.length+1,pass:false,code:e instanceof AuditError?safeCode(e):'SYNTHETIC_ASSERT'});}}
function assert(ok){if(!ok)throw new Error('SYNTHETIC_ASSERT');}
function rejects(fn,code){try{fn();throw new Error('MISSING_REJECTION');}catch(e){assert(e instanceof AuditError&&e.code===code);}}
function writeJSON(p,value){fs.writeFileSync(p,JSON.stringify(value,null,2)+'\n',{flag:'wx',encoding:'utf8'});}
function fixture(root,{badPair=false,badIndexText=false,badMonth=false,badHash=false,badID=false,badTime=false,duplicateID=false,badField=false,badReceiptPath=false,oversizedServer=false,localStable=false,badJson=false,badUtf8=false,badServerType=false}={}){
 fs.mkdirSync(root,{recursive:false});fs.mkdirSync(path.join(root,'按月'));
 const conv={id:'synthetic-group@chatroom',name:'SYNTHETIC GROUP',type:'group'};
 const inputs=[
  [1,'synthetic-member-a','alpha\nline'],
  [1,'未校准发送者#7','unknown barrier'],
  [1,'synthetic-member-a','[微笑] alpha'],
  [34,'synthetic-member-b','[语音]'],
  [34,'synthetic-member-b','[微信语音转文字] synthetic transcript'],
  [244813135921,'synthetic-member-a','[引用消息] synthetic\n引用原文：[图片]'],
  [81604378673,'synthetic-member-b','[聊天记录] synthetic\n[图片]\nsynthetic forwarded'],
  [3,'synthetic-member-b','[图片]'],
  [10000,'系统','synthetic event'],
  [1,conv.id,'fallback'],
  [1,'synthetic-member-a','repeated'],
  [1,'synthetic-member-a','repeated'],
  [1,'synthetic-member-a','x'.repeat(2500)],
  [999,'未校准发送者#8','[消息类型 999]'],
 ];
 const start=Date.parse('2026-09-30T23:59:00+08:00')/1000;
 const rows=inputs.map(([type,sender_id,text],i)=>{const timestamp=start+i*10;return {id:`server:${100+i}`,timestamp,time:new Date(timestamp*1000+28800000).toISOString().slice(0,19),conversation_id:conv.id,sender_id,sender:sender_id==='系统'?'SYNTHETIC SYSTEM':'SYNTHETIC DISPLAY',is_outgoing:false,type,text,source_db:'message\\message_0.db',local_id:i+1,server_id:100+i};});
 const messages=rows.map(r=>({timestamp:r.timestamp,time:r.time,sender:r.sender,text:normalizeFaces(r.text),raw_text:normalizeFaces(r.text)===r.text?null:r.text}));
 if(badPair)messages[0].sender='SYNTHETIC TAMPER';
 if(badIndexText)rows[0].text='SYNTHETIC INDEX TEXT TAMPER';
 if(oversizedServer)rows[0].id='server:9223372036854775807';
 if(localStable){rows[0].server_id=0;rows[0].id='local:message\\message_0.db:1';}
 if(badID)rows[0].id='server:99999';
 if(duplicateID){rows[1].id=rows[0].id;rows[1].server_id=rows[0].server_id;}
 if(badTime)rows[0].time='2026-09-30T12:00:00';
 if(badField)rows[0].unexpected='SYNTHETIC SECRET MUST NOT APPEAR';
 if(badServerType)rows[0].server_id={__audit_integer:'100'};
 const doc={schema_version:1,format:'wechat_conversation_text',conversation:conv,exported_at:'2026-10-30T00:00:00+08:00',time_range:{start:null,end:null},messages};
 if(badJson)fs.writeFileSync(path.join(root,'聊天记录.json'),'{"text":"SYNTHETIC PRIVATE ERROR SENTINEL",',{flag:'wx'});
 else if(badUtf8)fs.writeFileSync(path.join(root,'聊天记录.json'),Buffer.from([0xff]),{flag:'wx'});
 else writeJSON(path.join(root,'聊天记录.json'),doc);
 const index=rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
 fs.writeFileSync(path.join(root,'消息索引.jsonl'),oversizedServer?index.replace('"server_id":100','"server_id":9223372036854775807'):index,{flag:'wx'});
 const header=`\ufeff微信聊天记录（本机只读导出）\n会话：${conv.name}\n会话标识：${conv.id}\n时间范围：最早 至 最新\n导出时间：2026-10-30 00:00:00\n说明：优先导出微信已生成的语音转文字；其他非文本消息以方括号占位；本工具不会上传聊天内容。\n${'='.repeat(64)}\n\n`;
 fs.writeFileSync(path.join(root,'聊天记录.txt'),header+messages.map(txtBody).join('')+`\n${'='.repeat(64)}\n共导出 ${rows.length} 条消息。\n`,{flag:'wx'});
 const types={},unknownTypes={},unknownIds={},monthly={};
 for(const r of rows){types[r.type]=(types[r.type]||0)+1;if(r.sender_id.startsWith('未校准发送者#')){unknownTypes[r.type]=(unknownTypes[r.type]||0)+1;unknownIds[r.sender_id]=(unknownIds[r.sender_id]||0)+1;}}
 for(const m of messages){const month=m.time.slice(0,7);monthly[month]=(monthly[month]||0)+1;}
 for(const month of Object.keys(monthly))fs.writeFileSync(path.join(root,'按月',`${month}.txt`),monthHeader(conv.name,month)+messages.filter(m=>m.time.startsWith(month)).map(monthBody).join('')+(badMonth?'SYNTHETIC EXTRA':''),{flag:'wx'});
 const names=['聊天记录.txt','聊天记录.json','消息索引.jsonl'];
 const files=names.map(name=>{const b=fs.readFileSync(path.join(root,name));return{name,bytes:b.length,sha256:sha(b)};});
 if(badHash)files[0].sha256='0'.repeat(64);
 if(badReceiptPath)files[0].name='../SYNTHETIC OUTSIDE';
 const receipt={status:'complete',self_id:'synthetic-self',conversation_id:conv.id,conversation_name:conv.name,message_count:rows.length,source_rows:rows.length+2,deduplicated_rows:2,shard_counts:{'message\\message_0.db':rows.length+2},sqlite_quick_check:{'message\\message_0.db':'ok'},first_timestamp:rows[0].timestamp,last_timestamp:rows.at(-1).timestamp,message_types:types,uncalibrated_senders:2,format_counts_verified:true,files};
 writeJSON(path.join(root,'导出校验.json'),receipt);
 writeJSON(path.join(root,'复核结果.json'),{sha256_verified:true,json_and_jsonl_count_verified:rows.length,txt_footer_verified:true,timestamps_monotonic:true,duplicate_stable_ids:0,uncalibrated_sender_message_types:unknownTypes,uncalibrated_sender_ids:unknownIds,messages_with_unicode_replacement_character:0,exported_per_source:{'message\\message_0.db':rows.length},monthly_counts:monthly});
 fs.writeFileSync(path.join(root,'README.md'),'SYNTHETIC PRIVATE README\n',{flag:'wx'});
 return {rows,messages,conv};
}
function run(base){
 assert(path.isAbsolute(base)&&!fs.existsSync(base));
 const parent=path.dirname(base);assert(fs.statSync(parent).isDirectory());checkPaths(path.dirname(fileURLToPath(import.meta.url)),base);fs.mkdirSync(base,{recursive:false});
 const source=path.join(base,'valid-input'),output=path.join(base,'valid-output');const f=fixture(source);
 test(()=>{const r=runAudit({input:source,output});assert(r.status==='AUDIT_OK'&&r.messages===14&&r.months===2&&r.confirmedSelfWritten===0&&r.reliableReplyChains===0&&r.identityUnknown===3&&r.identitySystem===1&&r.inputUnchanged);});
 test(()=>{const r=JSON.parse(fs.readFileSync(path.join(output,'audit-report.json'),'utf8'));assert(r.buckets.reduce((s,x)=>s+x.count,0)===14&&Object.values(r.identities).reduce((a,b)=>a+b,0)===14);});
 test(()=>{const r=analyze(f.rows,f.messages,f.conv.id);assert(r.denominators.authorshipUnknown===14&&r.denominators.confirmedSelfWritten===0&&r.contentRepetitionCandidates.extraOccurrences===1&&r.contentRepetitionCandidates.deleted===0);});
 test(()=>{const r=analyze(f.rows,f.messages,f.conv.id);assert(r.intervalCandidates.pairExclusions.totalAdjacentPairs===13&&r.intervalCandidates.pairExclusions.unknownOrSystemIdentity===6);});
 test(()=>{const r=analyze(f.rows,f.messages,f.conv.id),t=r.intervalCandidates.thresholds.find(x=>x.seconds===300);assert(t.plainTextAdjacentSameSenderPairs===2&&t.candidateRuns===1&&t.candidateMessages===3);});
 test(()=>{const c=classify(f.rows[4],f.conv.id);assert(c.availability==='transcript_visible'&&c.layer==='media'&&c.authorship==='unknown'&&c.tags.includes('transcript'));});
 test(()=>{const c=classify(f.rows[5],f.conv.id);assert(c.availability==='mixed_quote_or_forward_visible'&&c.tags.includes('embedded_media_label_candidate')&&c.authorship==='unknown');});
 test(()=>{assert(classify(f.rows[3],f.conv.id).availability==='placeholder_only'&&classify(f.rows[13],f.conv.id).availability==='placeholder_only');});
 test(()=>{assert(classify(f.rows[9],f.conv.id).identity==='unknown'&&classify(f.rows[1],f.conv.id).identity==='unknown');});
 test(()=>{const r=analyze(f.rows,f.messages,f.conv.id);assert(r.metrics.longTextSensitivity.find(x=>x.codepoints===2000).messagesAtOrAbove===1&&r.metrics.longTextSensitivity.every(x=>x.retained));});
 test(()=>{const r=parsePrivateJSON('{"server_id":9223372036854775807,"text":"123 \\\"server_id\\\":9223372036854775807"}');assert(r.server_id===9223372036854775807n&&typeof r.text==='string');});
 test(()=>{assert(normalizeFaces('[微笑][not-a-face]')==='🙂[not-a-face]');});
 test(()=>{rejects(()=>runAudit({input:source,output}),'AUDIT_OUTPUT_EXISTS');});
 test(()=>{rejects(()=>checkPaths(source,source),'AUDIT_PATH');});
 test(()=>{rejects(()=>checkPaths(source,path.join(source,'nested')),'AUDIT_PATH');});
 test(()=>{rejects(()=>checkPaths(source,path.dirname(source)),'AUDIT_PATH');});
 test(()=>{rejects(()=>checkPaths(source,`${base}/../escape`),'AUDIT_PATH');});
 test(()=>{rejects(()=>checkPaths(source,`${base}:ads`),'AUDIT_PATH');});
 test(()=>{rejects(()=>checkPaths(source,'\\\\synthetic-host\\share'),'AUDIT_PATH');});
 test(()=>{assert(safeCode(new Error('SYNTHETIC SECRET MUST NOT APPEAR'))==='AUDIT_IO');});
 for(const [name,opts,code] of [
  ['bad-pair',{badPair:true},'AUDIT_PAIR'],['bad-index-text',{badIndexText:true},'AUDIT_PAIR'],['bad-month',{badMonth:true},'AUDIT_MONTH'],['bad-hash',{badHash:true},'AUDIT_HASH'],['bad-id',{badID:true},'AUDIT_ID'],['duplicate-id',{duplicateID:true},'AUDIT_ID'],['bad-time',{badTime:true},'AUDIT_TIME'],['bad-field',{badField:true},'AUDIT_SCHEMA'],['bad-receipt-path',{badReceiptPath:true},'AUDIT_RECEIPT'],['bad-json',{badJson:true},'AUDIT_JSON'],['bad-utf8',{badUtf8:true},'AUDIT_UTF8'],['bad-server-type',{badServerType:true},'AUDIT_SCHEMA']]){
  test(()=>{const p=path.join(base,name);fixture(p,opts);rejects(()=>runAudit({input:p,output:path.join(base,name+'-output')}),code);assert(!fs.existsSync(path.join(base,name+'-output')));});
 }
 test(()=>{let captured='';const oldErr=process.stderr.write;process.stderr.write=x=>{captured+=x;return true;};try{assert(main(['--input',source,'--output',source])===1);}finally{process.stderr.write=oldErr;}assert(captured==='AUDIT_PATH\n'&&!captured.includes('synthetic'));});
 test(()=>{let captured='';const oldErr=process.stderr.write;process.stderr.write=x=>{captured+=x;return true;};try{assert(main(['--input',path.join(base,'bad-json'),'--output',path.join(base,'bad-json-cli-output')])===1);}finally{process.stderr.write=oldErr;}assert(captured==='AUDIT_JSON\n'&&!captured.includes('SYNTHETIC PRIVATE ERROR SENTINEL'));});
 test(()=>{const link=path.join(base,'junction-source');fs.symlinkSync(source,link,process.platform==='win32'?'junction':'dir');rejects(()=>checkPaths(link,path.join(base,'junction-source-output')),'AUDIT_PATH');});
 test(()=>{const link=path.join(base,'junction-output-parent');fs.symlinkSync(source,link,process.platform==='win32'?'junction':'dir');rejects(()=>checkPaths(source,path.join(link,'nested-output')),'AUDIT_PATH');});
 // 目录穿越 / ADS / 覆盖源先拒，之后才读取输入；不会把输入受控字符串回显到stderr。
 for(const [name,opts] of [['lossless-id',{oversizedServer:true}],['local-id',{localStable:true}]])test(()=>{const p=path.join(base,name);fixture(p,opts);assert(runAudit({input:p,output:path.join(base,name+'-output')}).messages===14);});
 test(()=>{const x=parsePrivateJSON('{"server_id":{"__audit_integer":"9223372036854775807"}}');assert(typeof x.server_id==='object'&&typeof x.server_id!=='bigint');});
 test(()=>{const event={...f.rows[0],type:266287972401};const known=classify(event,f.conv.id),unknown=classify({...event,sender_id:'未校准发送者#9'},f.conv.id);assert(known.layer==='system_event'&&known.identity==='export_named_member'&&unknown.layer==='system_event'&&unknown.identity==='unknown');});
 test(()=>{const rows=[{...f.rows[0],type:266287972401},{...f.rows[1],type:266287972401}],messages=rows.map(r=>({timestamp:r.timestamp,time:r.time,sender:r.sender,text:r.text,raw_text:null})),r=analyze(rows,messages,f.conv.id);assert(r.denominators.reliableExportIdentity===1&&r.denominators.identityUnknown===1&&r.denominators.identitySystem===0&&r.denominators.styleCandidateExportIdentity===0);});
 test(()=>{const rows=[{...f.rows[0],type:266287972401},{...f.rows[0],timestamp:f.rows[0].timestamp+1}],messages=rows.map(r=>({timestamp:r.timestamp,time:r.time,sender:r.sender,text:r.text,raw_text:null})),r=analyze(rows,messages,f.conv.id);assert(r.intervalCandidates.pairExclusions.eventLayerExcluded===1&&r.intervalCandidates.pairExclusions.reliableIdentityPairs===0);});
 const result={status:failed?'SELFTEST_FAILED':'SELFTEST_OK',passed,failed};writeJSON(path.join(base,'selftest-result.json'),{...result,checks});process.stdout.write(JSON.stringify(result)+'\n');return failed?1:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{assert(process.argv.length===3);process.exitCode=run(process.argv[2]);}catch{process.stderr.write('SELFTEST_SETUP_FAILED\n');process.exitCode=1;}
}
