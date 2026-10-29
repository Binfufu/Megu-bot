/** Targeted local-content checks; --freeze-report is explicit private baseline capture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const names = ['story', 'story-content', 'world', 'companions', 'character-tuning', 'character-days', 'chronicle', 'commands'];
const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function snapshot(base = new URL('../src/', import.meta.url)) {
  const mods = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await import(new URL(`${name}.js`, base))])));
  const [s, p, w, c, tuning, d, h, commands] = names.map((name) => mods[name]);
  const exports = Object.fromEntries(names.map((name) => [name, Object.fromEntries(Object.entries(mods[name]).filter(([, value]) => typeof value !== 'function'))]));
  const rows = [];
  const record = (...row) => rows.push(row);
  record('reference-contracts', Object.isFrozen(c.COMPANIONS), c.COMPANIONS.map(Object.isFrozen),
    c.COMPANIONS.map((one) => c.companionById(one.id) === one), Object.isFrozen(p.STORY_CONTENT_PACKS),
    p.STORY_CONTENT_PACKS.megumin?.events === s.STORY_EVENTS, Object.isFrozen(w.PLACES), Object.isFrozen(tuning.MODULE_TUNING),
    Object.isFrozen(d.CHARACTER_DAYS), Object.values(d.CHARACTER_DAYS).map((days) => [Object.isFrozen(days), days.map(Object.isFrozen)]));
  for (const theme of ['megumin', 'aris', 'demo', '', undefined, 'unknown']) record('pack', theme, p.storyPackFor(theme), p.storyPackStatus(theme));
  for (const [packId, events] of [['default', s.STORY_EVENTS], ...Object.entries(p.STORY_CONTENT_PACKS).map(([id, pack]) => [id, pack.events])]) {
    for (let i = 0; i < events.length; i += 1) {
      let draws = 0;
      const opened = s.openStory({ now: 1700000000000, random: () => { draws += 1; return (i + 0.5) / events.length; }, ...(packId === 'default' ? {} : { events }) });
      record('open', packId, i, opened, draws);
      const event = events[i];
      for (const scene of ['c2c', 'group']) record('prompts', packId, event.id, scene,
        s.buildStoryOpenPrompt({ scene, event }), s.buildStoryRespondPrompt({ scene, event, reply: '合成回复' }), s.buildStorySettlePrompt({ scene, event }));
      const total = event.branches.reduce((sum, row) => sum + row.weight, 0);
      let start = 0;
      for (const branch of event.branches) {
        record('branch', packId, event.id, branch.id, s.findBranch(event, branch.id), s.matchOutcome(event, `prefix ${branch.id.toUpperCase()} suffix`),
          s.inferBranch(event, branch.keywords?.[0]), s.pickSelfDecidedBranch(event, () => (start + branch.weight / 2) / total));
        start += branch.weight;
      }
    }
  }
  record('closing', s.closingActionHint(), [...s.CLOSING_ACTION_WORDS, '合成未知'].map((word) => [word, s.hasClosingAction(word)]));
  for (const text of ['<story outcome=help>', '<story outcome="help"/> 后续', '无标记']) record('outcome', text, s.extractStoryOutcome(text));
  for (const id of [...w.PLACES.map((one) => one.id), 'unknown']) {
    record('place', id, w.placeById(id), w.routesFrom(id), w.travelMsTo(id));
    record('move', id, w.whereaboutsFromAction({ kind: 'move.to', target: id, current: { placeId: 'home' }, now: 1000000 }));
    record('settle', id, w.settleTravel({ place: 'home', to: id, arriveAt: 1000000 }, { now: 1000000 }));
  }
  for (const kind of ['fishing.begin', 'fishing.settle', 'quest.accept', 'home.put', 'home.take', 'unknown']) {
    for (const detail of [null, { label: '合成委托', itemKey: '合成物品' }]) record('action', kind, detail, w.whereaboutsFromAction({ kind, detail, now: 1000000 }));
  }
  for (const decision of [{ action: 'eat' }, { action: 'eat', eatery: { food: '合成食物', place: '合成地点' } }, { action: 'life', activity: { place: 'market', line: '合成活动' } }, null]) {
    record('decision', decision, w.whereaboutsFromDecision(decision, { now: 1000000 }));
  }
  for (const input of [{}, { gallery: false }, { scenes: [{ kind: 'fishing', phase: 'waiting', phaseLabel: '等待', basketSummary: { count: 2, total: 300 } }] },
    { stats: { satiety: 50 }, questBoard: { rows: [{ index: 1, label: '合成委托', reward: 100, unit: '合成币' }] }, homeItems: [{ key: '合成物品', count: 3, placed: 1, slot: 'unknown' }] },
    { metas: [{ key: 'world:her', value: JSON.stringify({ place: 'home', to: 'guild', since: 999000, arriveAt: 1100000 }) }] }]) {
    const view = w.describeWorld({ ...input, now: 1000000 });
    record('world', input, view, w.describeWhereabouts(view.her));
  }
  for (const id of ['megumin', 'aris', 'demo', 'unknown', '']) record('companion', id, c.companionById(id), c.skinPathFor('/synthetic-root', id));
  for (const input of [{}, { skins: {} }, { self: { id: 'megumin', values: [], money: 3, live: true }, others: { aris: { live: false } }, skinTags: { megumin: 'synthetic' } }]) record('companions', input, c.describeCompanions(input));
  for (const theme of ['megumin', 'aris', 'demo']) record('companion-values', theme, c.valuesFromStats({ satiety: 9, health: 39, mood: 84, stamina: 34, mana: 29 }, theme));
  for (const theme of ['megumin', 'aris', 'demo', 'unknown']) {
    record('days', theme, d.daysFor(theme));
    for (let day = 0; day < 365; day += 1) {
      const now = Date.UTC(2026, 0, 1 + day, 15, 59);
      const today = d.daysToday(theme, { now });
      record('day', theme, day, today, d.renderDayLine(today));
    }
  }
  const events = [];
  for (const kind of [...Object.keys(h.CHRONICLE_KINDS), 'unknown']) {
    for (const detail of [null, { label: '合成标签', food: '合成食物', disease: '合成病名', ok: false }, { label: 'bought_staff', grade: 'ok' }, { label: 'donated' }]) {
      const event = { ts: 1700000000000 + events.length, kind, satietyDelta: 1, healthDelta: -2, moodDelta: 3, staminaDelta: -4, manaDelta: 5, moneyDelta: -6, detail };
      events.push(event);
      record('chronicle', event, h.describeChronicleEntry(event));
    }
  }
  const entries = h.buildChronicle({ events, limit: 100 });
  record('chronicle-aggregate', entries, h.pickSpecialEntries(entries), h.pickAwayHighlights(entries), h.renderSpecialLine(h.pickSpecialEntries(entries)), h.summarizeAway({ entries, lastSeenAt: 1700000000001, now: 1700000001000 }));
  for (const fact of [{ placeName: '合成住所', toName: '合成目标', to: 'guild', since: 1000000, arriveAt: 1100000 }, { placeName: '合成目标', arrivedAt: 1100000 }]) record('chronicle-world', h.buildChronicle({ metas: [{ key: 'world:her', value: JSON.stringify(fact) }] }));
  for (const scope of ['c2c', 'group']) for (const isOperator of [false, true]) for (const botName of [null, '示例助手']) record('help', scope, isOperator, botName, commands.helpText({ scope, isOperator, botName }));
  return { exports, rows };
}

function publicChild(options) {
  return `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { createHash } from 'node:crypto';
    const options = ${JSON.stringify(options)};
    const names = ${JSON.stringify(names)};
    let count = 0, reads = 0;
    const check = (run) => { run(); count += 1; };
    const nativeRead = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (file instanceof URL && file.href === options.contentURL) {
        reads += 1;
        if (options.fault) { const error = new Error('SENSITIVE_MARKER E:/private-content-path'); error.code = options.fault; throw error; }
      }
      return nativeRead.call(this, file, ...args);
    };
    let mods;
    try { mods = await Promise.all(names.map((name) => import(new URL(name + '.js', options.base)))); }
    catch (error) {
      if (!options.error) throw error;
      check(() => assert.equal(error.message, options.error));
      check(() => assert.equal(error.cause, undefined));
      check(() => assert.ok(!String(error.stack).includes('SENSITIVE_MARKER')));
      check(() => assert.ok(!String(error.stack).includes('private-content-path')));
      check(() => assert.ok(!String(error.stack).includes(options.contentURL)));
      check(() => assert.ok(!String(error.stack).includes(options.contentPath)));
      console.log(JSON.stringify({ count })); process.exit(0);
    }
    assert.ok(!options.error, 'malformed content must fail startup');
    const [s,p,w,c,t,d,h,cmd] = mods;
    check(() => assert.equal(reads, 1, 'one module-relative content read across all consumers'));
    if (options.synthetic) {
      check(() => assert.equal(s.STORY_EVENTS[0].setup, '合成事件开场'));
      check(() => assert.equal(p.storyPackFor('megumin').events, s.STORY_EVENTS));
      check(() => assert.equal(p.storyPackFor('aris').label, '合成机械故事'));
      check(() => assert.equal(s.CLOSING_ACTION_EXAMPLES[0], '合成收尾。'));
      check(() => assert.ok(s.buildStoryRespondPrompt({ scene:'group', event:s.STORY_EVENTS[0], reply:'合成回复' }).includes('合成回应收尾')));
      check(() => assert.ok(s.buildStorySettlePrompt({ scene:'group', event:s.STORY_EVENTS[0] }).includes('合成自决收尾')));
      check(() => assert.equal(w.placeById('guild').name, '合成任务地点'));
      check(() => assert.equal(w.whereaboutsFromAction({kind:'quest.accept',detail:{label:'甲'},now:1000}).doing, '合成接取「甲」'));
      check(() => assert.equal(c.companionById('megumin'), c.COMPANIONS[0]));
      check(() => assert.ok(Object.isFrozen(c.COMPANIONS) && c.COMPANIONS.every(Object.isFrozen)));
      check(() => assert.equal(c.describeCompanions()[0].name, '合成伙伴甲'));
      check(() => assert.equal(t.MODULE_TUNING[0].name, '合成能力0'));
      check(() => assert.equal(d.daysToday('megumin',{now:Date.UTC(2026,0,2)})[0].source, '原创合成来源'));
      check(() => assert.ok(h.describeDeltas({moneyDelta:-5}).includes('合成货币')));
      check(() => assert.equal(h.describeChronicleEntry({kind:'heal',detail:{ok:false}}).text, '合成治疗失败'));
      check(() => assert.equal(h.EVENT_LABEL.donated, '合成捐赠'));
      check(() => assert.ok(cmd.helpText().includes('合成命令说明')));
      check(() => assert.equal(cmd.KEYWORD_GROUPS[0].words[0], '合成关键词'));
      check(() => assert.equal(cmd.ARIS_PHRASES[0].phrase, '合成播报'));
      check(() => assert.equal(cmd.CARD_CLAIMS[0].note, '合成能力说明'));
      check(() => assert.equal(cmd.OPS_SCRIPTS[0].effect, '合成运维说明'));
      console.log(JSON.stringify({ count })); process.exit(0);
    }
    check(() => assert.deepEqual(c.COMPANIONS, []));
    check(() => assert.ok(Object.isFrozen(c.COMPANIONS)));
    for (const id of ['megumin','aris','demo','unknown','']) {
      check(() => assert.equal(c.companionById(id), null));
      check(() => assert.equal(c.skinPathFor(options.root,id), null));
      check(() => assert.equal(c.readSkin(options.root,id), null));
    }
    check(() => assert.deepEqual(c.companionSkinState(options.root), {companionSkins:{},companionSkinTags:{}}));
    check(() => assert.deepEqual(c.describeCompanions({self:{id:'demo',live:true},others:{megumin:{live:true}},skins:{}}), []));
    check(() => assert.equal(c.readOtherBotState(options.root+'/absent/state.db'), null));
    check(() => assert.deepEqual(c.readOtherBotEvents(options.root+'/absent/state.db'), []));
    check(() => assert.deepEqual(c.readCompanionFacts('unknown',options.root,{now:1000}), {live:false,note:'没在跑（读不到它的状态库）'}));
    check(() => assert.deepEqual(p.STORY_CONTENT_PACKS, {}));
    for (const id of ['megumin','aris','demo','unknown']) {
      check(() => assert.equal(p.storyPackFor(id), null));
      check(() => assert.equal(p.storyPackStatus(id).enabled, false));
      check(() => assert.deepEqual(d.daysFor(id), []));
      check(() => assert.deepEqual(d.daysToday(id,{now:Date.UTC(2026,0,2)}), []));
    }
    check(() => assert.deepEqual(d.CHARACTER_DAYS, {}));
    check(() => assert.equal(d.renderDayLine([{month:1,day:2,label:'合成纪念日',source:'原创来源'}]),'今天是她合成纪念日（1月2日，出处：原创来源）'));
    check(() => assert.deepEqual(w.PLACES.map(row=>row.name), ['住所','垂钓区','任务中心','餐厅','交易区','图片展区']));
    check(() => assert.deepEqual(w.PLACES.map(row=>row.travelMs), [180000,360000,300000,300000,420000,240000]));
    check(() => assert.equal(w.placesFor(), w.PLACES));
    check(() => assert.equal(w.placesFor({gallery:false}).length,5));
    check(() => assert.equal(w.placeById('unknown'),null));
    check(() => assert.deepEqual(w.routesFrom('unknown'),[]));
    check(() => assert.equal(w.herWhereabouts({now:1000}).placeId,null));
    check(() => assert.equal(w.describeWorld({now:1000}).places.length,6));
    check(() => assert.equal(w.whereaboutsFromAction({kind:'move.to',target:'guild',current:{placeId:'home'},now:1000}).arriveAt,301000));
    check(() => assert.equal(w.whereaboutsFromAction({kind:'quest.accept',detail:{label:'甲'},now:1000}).doing,'在任务中心接下了「甲」'));
    check(() => assert.equal(w.settleTravel({to:'guild',arriveAt:301000},{now:301000}).doing,'到了任务中心'));
    check(() => assert.deepEqual(t.MODULE_TUNING.map(({id,cost,mods})=>[id,cost,mods.lawful,mods.tricky]),[
      ['burst',14,3,0],['sword',10,2,0],['scout',9,0,3],['talk',8,1,2],['cook',6,0,1],['fish',6,0,2],['slow',-7,-1,-2],['weak',-7,-2,0],['clumsy',-5,-1,-1],['nosy',-4,0,-1]]));
    check(() => assert.equal(t.CHARACTER_BUDGET,50));
    check(() => assert.deepEqual(s.STORY_EVENTS.map(row=>row.id),['explosion_practice','guild_board','weird_purchase','aqua_church','kazuma_debt','leftovers']));
    const numericEvents=s.STORY_EVENTS.map(({id,branches})=>[id,branches.map(({id,weight,effect})=>[id,weight,effect])]);
    // Frozen numeric/id-only signature; contains no private prose or fixture text.
    check(() => assert.equal(createHash('sha256').update(JSON.stringify(numericEvents)).digest('hex'),'aa031c0b715489076a61282677c47ae245e0c3decfb88fb7a19388b0baf846fb'));
    for (let i=0;i<s.STORY_EVENTS.length;i++) {
      let draws=0;const opened=s.openStory({now:1000,random:()=>{draws++;return(i+0.5)/s.STORY_EVENTS.length;}});
      check(()=>assert.equal(opened.event,s.STORY_EVENTS[i]));
      check(()=>assert.equal(opened.expiresAt,1801000));
      check(()=>assert.equal(draws,1));
    }
    const event={id:'synthetic',setup:'合成开场',branches:[{id:'a',weight:1,line:'方案甲',keywords:['线索甲'],effect:{mood:2}},{id:'b',weight:3,line:'方案乙',keywords:['线索乙'],effect:{stamina:-2}}]};
    check(()=>assert.equal(s.openStory({events:[event],now:1000,random:()=>0}).event,event));
    check(()=>assert.equal(s.pickSelfDecidedBranch(event,()=>0.5),event.branches[1]));
    check(()=>assert.equal(s.inferBranch(event,'线索甲'),event.branches[0]));
    check(()=>assert.equal(s.matchOutcome(event,'B'),event.branches[1]));
    check(()=>assert.equal(h.describeDeltas({moneyDelta:-5,manaDelta:1}),'精力+1，花掉 5 货币'));
    check(()=>assert.equal(h.describeChronicleEntry({kind:'heal',detail:{ok:false}}).text,'这次治疗未成功'));
    check(()=>assert.equal(h.describeChronicleEntry({kind:'event',detail:{label:'donated'}}).text,'进行了捐赠'));
    check(()=>assert.deepEqual(cmd.KEYWORD_GROUPS,[]));
    check(()=>assert.deepEqual(cmd.ARIS_PHRASES,[]));
    check(()=>assert.ok(cmd.helpText({botName:'示例助手'}).includes('示例助手')));
    check(()=>assert.equal(cmd.BRIDGE_COMMANDS.length,24));
    const fixture={schemaVersion:1,storyEvents:[event],storyPacks:{megumin:{id:'megumin',label:'合成默认故事'},aris:{id:'aris',label:'合成机械故事',events:[event]}},
      storyClosingWords:['合成收尾'],storyClosingExamples:['合成收尾。'],storyRespondClosing:'合成回应收尾',storySettleClosing:'合成自决收尾',
      places:w.PLACES.map(row=>({...row,name:row.id==='guild'?'合成任务地点':'合成地点'+row.id,blurb:'合成场所说明'})),
      worldText:{currency:'合成货币',questAcceptPrefix:'合成接取「',questAcceptSuffix:'」',questAcceptPlain:'合成接取'},
      companions:['megumin','aris'].map((id,index)=>({id,name:index===0?'合成伙伴甲':'合成伙伴乙',fullName:'合成完整名称'+index,theme:id,bot:id,stateDir:id,art:'synthetic_'+index+'.png',blurb:'合成伙伴说明'})),
      moduleText:Object.fromEntries(t.MODULE_TUNING.map((row,index)=>[row.id,{name:'合成能力'+index,...(row.note===undefined?{}:{note:'合成说明'})}])),
      characterDays:{megumin:[{month:1,day:2,label:'合成日',source:'原创合成来源'}],aris:[]},
      chronicleKinds:{...h.CHRONICLE_KINDS},eventLabels:{...h.EVENT_LABEL,donated:'合成捐赠'},chronicleText:{currency:'合成货币',manaLabel:'合成精力',healFailed:'合成治疗失败'},
      commandEffects:Object.fromEntries(cmd.BRIDGE_COMMANDS.map(row=>[row.name,'合成命令说明'])),cardClaimNotes:Object.fromEntries(cmd.CARD_CLAIMS.map(row=>[row.claim,'合成能力说明'])),
      keywordGroups:[{label:'合成分组',words:['合成关键词']}],arisPhrases:[{phrase:'合成播报',note:'合成说明'}],opsEffects:Object.fromEntries(cmd.OPS_SCRIPTS.map(row=>[row.name,'合成运维说明']))};
    fixture.storyEvents[0].setup='合成事件开场';
    console.log(JSON.stringify({count,fixture}));
  `;
}

function runPublic() {
  const parent = path.dirname(ROOT);
  const temp = fs.mkdtempSync(path.join(parent, '.story-world-public-'));
  const content = path.join(temp, 'content', 'local', 'story-world.json');
  const cwd = path.join(temp, 'unrelated-cwd');
  let passed = 0, processes = 0;
  try {
    assert.equal(path.parse(temp).root.toLowerCase(),path.parse(ROOT).root.toLowerCase());
    const copied = new Set();
    function copy(relative) {
      const source = path.resolve(ROOT,relative);
      assert.ok(source.startsWith(path.resolve(ROOT,'src')+path.sep));
      if(copied.has(source))return;
      copied.add(source);
      const text=fs.readFileSync(source,'utf8'); // Missing dependencies fail; never skip.
      const target=path.join(temp,path.relative(ROOT,source));
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);
      for(const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)) {
        copy(path.relative(ROOT,path.resolve(path.dirname(source),match[1])));
      }
    }
    for(const name of names)copy(`src/${name}.js`);
    fs.mkdirSync(path.join(cwd,'content','local'),{recursive:true});
    fs.writeFileSync(path.join(cwd,'content','local','story-world.json'),'{}');
    for(const name of ['.env','data','resources','content'])assert.equal(fs.existsSync(path.join(temp,name)),false);
    function run(label,extra={}) {
      const options={base:pathToFileURL(path.join(temp,'src')+path.sep).href,root:temp,contentURL:pathToFileURL(content).href,contentPath:content,...extra};
      const child=spawnSync(process.execPath,['--input-type=module','--eval',publicChild(options)],{cwd,encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:8*1024*1024});
      assert.ifError(child.error);assert.equal(child.status,0,`${label}: ${child.stdout}\n${child.stderr}`);
      const result=JSON.parse(child.stdout.trim());passed+=result.count;processes++;console.log(`PASS ${label}: ${result.count}`);return result;
    }
    const {fixture}=run('real same-volume pruned no-C; empty companions and neutral consumers');
    for(const name of ['.env','data','resources','unknown'])assert.equal(fs.existsSync(path.join(temp,name)),false);
    fs.mkdirSync(path.dirname(content),{recursive:true});fs.writeFileSync(content,JSON.stringify(fixture));
    run('all synthetic C consumer sentinels; one shared synchronous load',{synthetic:true});
    for(const raw of ['{SENSITIVE_MARKER','\uFEFF{}','//SENSITIVE_MARKER\n{}']) {
      fs.writeFileSync(content,raw);run('bad strict JSON is loud/sanitized',{error:'本地故事世界内容不是合法 JSON'});
    }
    const invalid=[null,[],{}, {...fixture,schemaVersion:2}, {...fixture,storyEvents:[]}, {...fixture,companions:[]}, {...fixture,moduleText:{}}, {...fixture,commandEffects:{}}, {...fixture,characterDays:{megumin:[]}}, {...fixture,chronicleText:{currency:42}}, {...fixture,places:[]}];
    for(const mutate of [
      value=>{value.extra='SENSITIVE_MARKER';}, value=>{value.storyEvents[0].branches[0].effect.mood='SENSITIVE_MARKER';},
      value=>{delete value.moduleText.burst.note;}, value=>{value.companions[0].art='../SENSITIVE_MARKER.png';},
      value=>{value.characterDays.megumin[0].month=13;}, value=>{value.commandEffects={unknown:'SENSITIVE_MARKER'};},
    ]) { const value=JSON.parse(JSON.stringify(fixture)); mutate(value); invalid.push(value); }
    for(const value of invalid){fs.writeFileSync(content,JSON.stringify(value));run('bad fixed schema is loud/sanitized',{error:'本地故事世界内容结构无效'});}
    for(const fault of ['EACCES','EIO','EISDIR'])run('non-ENOENT '+fault,{fault,error:'本地故事世界内容读取失败'});
    run('ENOENT alone is neutral',{fault:'ENOENT'});
    console.log(`story-world public: ${passed} passed / 0 failed; ${processes} fresh processes; ${copied.size} source dependencies; no real C/data/resources`);
  } finally {
    const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(parent));assert.ok(path.basename(resolved).startsWith('.story-world-public-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

if (arg('--freeze-report')) {
  const result = await snapshot();
  const report = arg('--freeze-report');
  assert.ok(path.isAbsolute(report) && !path.resolve(report).startsWith(path.resolve(ROOT) + path.sep));
  assert.equal(fs.existsSync(report), false, 'never overwrite an existing frozen golden');
  fs.writeFileSync(report, `# Story/world 内容最小外提（私有，节点 A 未发布）\n\n## 施工前冻结\n\nHEAD aa795d1d19894ac333b6d50a96b8ac526311bb28，干净工作树开工。以下真实导出/输出仅存仓外，禁止作为公开 fixture。\n\n${result.rows.length} 条决定性记录；SHA256 ${hash(result)}。\n\n<!-- PRIVATE-GOLDEN-START -->\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n<!-- PRIVATE-GOLDEN-END -->\n\n实现与新旧比较待补；不提交/联网/全量/生产。\n`, 'utf8');
  console.log(`frozen: ${result.rows.length} records; sha256=${hash(result)}`);
} else if (arg('--private-report')) {
  const report = fs.readFileSync(arg('--private-report'), 'utf8');
  const expected = JSON.parse(/<!-- PRIVATE-GOLDEN-START -->\n```json\n([^]*?)\n```/.exec(report)[1]);
  const actual = JSON.parse(JSON.stringify(await snapshot()));
  // The frozen contract is serialized exports/outputs; undefined array slots serialize as null.
  assert.equal(hash(actual), hash(expected), 'serialized golden mismatch (including property ordering)');
  console.log(`private story/world golden: ${actual.rows.length}/${expected.rows.length} unchanged; sha256=${hash(actual)}`);
} else if (process.argv.includes('--snapshot')) {
  console.log(JSON.stringify(await snapshot()));
} else {
  runPublic();
}
