import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeAsyncSeams, calledIdentifiers, classifyArrowShape, classifyPromiseShape, functionBody, stripComments } from './scan-async-seams.mjs';
export function registerAsyncSeamTests({ test, assert }) {
  test('异步接缝:取函数体要跳过解构参数与字符串里的花括号(取错了扫描器就是瞎的)', () => {
    const source = [
      'async function region(a, { hasImage = null } = {}, b = 1) {',
      '  const s = "}" ;',
      '  const t = `模板 ${a} 结束`;',
      '  return s + t;',
      '}',
      'function next() { return 1; }',
    ].join('\n');
    const body = functionBody(source, 'region');
    assert.ok(body.startsWith('{') && body.endsWith('}'));
    assert.match(body, /return s \+ t;/);
    assert.doesNotMatch(body, /function next/);
    assert.equal(functionBody(source, 'nope'), null);
    // 调用名:关键字与成员调用不算。
    const names = calledIdentifiers('if (a) b(x); obj.m(y); await c(z);');
    assert.deepEqual([...names].sort(), ['b', 'c']);
  });
  test('异步接缝:Promise 形状要认三种(含没有 async 关键字那种)', () => {
    const source = [
      'async function a() { return 1; }',
      'function b(x) { return Promise.resolve(x); }',
      'function c(x) { return fetch(x).then(r => r.text()); }',
      'function d() { return 1; }',
    ].join('\n');
    assert.deepEqual(classifyPromiseShape(source, 'a').evidence, ['async 关键字']);
    assert.ok(classifyPromiseShape(source, 'b').evidence.includes('函数体里出现 Promise'));
    assert.ok(classifyPromiseShape(source, 'c').evidence.includes('函数体里出现 .then('));
    assert.equal(classifyPromiseShape(source, 'd').isPromise, false);
    assert.deepEqual(classifyPromiseShape(source, 'zzz').evidence, ['定义找不到']);
  });
  test('异步接缝:该 await 没 await 要报出来，同步助手不许误报', () => {
    const sources = [
      { file: 'region.js', text: [
        'async function region() {',
        '  const ok = await promised();',
        '  const bad = promised();',
        '  const fine = plain();',
        '}',
      ].join('\n') },
      { file: 'helpers.js', text: [
        'async function promised() { return 1; }',
        'function plain() { return 2; }',
      ].join('\n') },
    ];
    const r = analyzeAsyncSeams({ sources, region: { file: 'region.js', name: 'region' } });
    assert.deepEqual(r.offenders.map((o) => o.name), ['promised'], '没 await 的那个要报，await 过的那个不许报');
    assert.deepEqual(r.calls.find((c) => c.name === 'promised'), {
      name: 'promised', resolvedAs: 'promised', total: 2, awaitedCount: 1, unhandled: 1,
      kindBreakdown: { awaited: 1, returned: 0, voided: 0, caught: 0, deferred: 0, unhandled: 1 },
      evidence: ['async 关键字'] },
    '同一助手 await 一次、漏一次 ⇒ 必须报出 1 个漏的(只问"有没有 await"会放过它)');
    assert.equal(r.calls.some((c) => c.name === 'plain'), false, '同步助手不该进这张表');
    assert.throws(() => analyzeAsyncSeams({ sources, region: { file: 'nope.js', name: 'region' } }), /找不到区域所在文件/);
    assert.throws(() => analyzeAsyncSeams({ sources, region: { file: 'region.js', name: 'nope' } }), /找不到区域函数/);
  });
  test('异步接缝:注释/void/.catch/延迟回调都不是缺陷，只有真没管的才报', () => {
    const sources = [
      { file: 'caller.js', text: [
        'async function region() {',
        '  const a = await p();',
        '  return q();',
        '  void r();',
        '  s().catch(() => {});',
        '  const later = () => t();',
        '  // commentMention(u);',
        '  /* blockMention(v); */',
        '}',
      ].join('\n') },
      { file: 'impl.js', text: [
        'async function p() { return 1; }', 'async function q() { return 2; }',
        'async function r() { return 3; }', 'async function s() { return 4; }',
        'async function t() { return 5; }',
      ].join('\n') },
    ];
    const out = analyzeAsyncSeams({ sources, region: { file: 'caller.js', name: 'region' } });
    assert.deepEqual(out.offenders, [], `显式不管的四种写法都不许报：${JSON.stringify(out.offenders)}`);
    const by = Object.fromEntries(out.calls.map((c) => [c.name, c]));
    assert.equal(by.p.kindBreakdown.awaited, 1);
    assert.equal(by.q.kindBreakdown.returned, 1);
    assert.equal(by.r.kindBreakdown.voided, 1);
    assert.equal(by.s.kindBreakdown.caught, 1);
    assert.equal(by.t.kindBreakdown.deferred, 1, '() => t() 是延迟成回调,不算调用点');
    assert.equal(by.t.total, 0, '延迟的那种不进分母');
    assert.equal(out.calls.some((c) => /commentMention|blockMention/.test(c.name)) || out.unresolved.some((n) => /Mention/.test(n)), false,
      '注释里提到的名字根本不该出现');
  });
  test('异步接缝:注释剥离要保留长度(位置不许错位)', () => {
    const raw = 'const a = 1; // f(x)\n/* g(y) */ b(2);';
    const stripped = stripComments(raw);
    assert.equal(stripped.length, raw.length, '长度必须一致,否则后面的位置全错');
    assert.doesNotMatch(stripped, /f\(x\)|g\(y\)/);
    assert.match(stripped, /b\(2\)/);
  });
  test('异步接缝:const 箭头函数也要能解析(withTurnFacts 就是这种)', () => {
    const sources = [
      { file: 'caller.js', text: 'async function region() { const x = arrowAsync(); }' },
      { file: 'impl.js', text: [
        'async function realPromise(a) { return a; }',
        'const arrowAsync = async (a) => a;',
        'const forwards = (a) => realPromise(a);',
        'const plain = (a) => a + 1;',
      ].join('\n') },
    ];
    const out = analyzeAsyncSeams({ sources, region: { file: 'caller.js', name: 'region' } });
    assert.deepEqual(out.offenders.map((o) => o.name), ['arrowAsync'], 'async 箭头函数漏 await 要报');
    assert.deepEqual(out.unresolved, [], '解析得到的名字不许进盲区');
    assert.equal(classifyArrowShape(sources[1].text, 'forwards', new Map([['realPromise', sources[1].text]])).isPromise, true,
      '转发到 Promise 助手的壳也算 Promise 形状');
    assert.equal(classifyArrowShape(sources[1].text, 'plain').isPromise, false);
    assert.deepEqual(classifyArrowShape(sources[1].text, 'nope').evidence, ['定义找不到']);
  });
  test('异步接缝:改名导入也要认，解析不到的要列进盲区(解析不到≠干净)', () => {
    const sources = [
      { file: 'caller.js', text: [
        "import { real as aliased } from './impl.js';",
        'async function region() {',
        '  const a = aliased();',
        '  mysteryCall();',
        '}',
      ].join('\n') },
      { file: 'impl.js', text: 'export function real() { return Promise.resolve(1); }' },
    ];
    const r = analyzeAsyncSeams({ sources, region: { file: 'caller.js', name: 'region' } });
    assert.deepEqual(r.offenders.map((o) => o.name), ['aliased'], '别名指向的 Promise 助手漏 await 也要报');
    assert.equal(r.calls[0].resolvedAs, 'real', '要说出它其实是哪个定义');
    assert.deepEqual(r.unresolved, ['mysteryCall'], '解析不到的名字必须列出来当盲区,不许静默跳过');
  });
  test('异步接缝:全部提示词拼装区域(11处)都不许有漏 await 也不许有盲区', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
      .map((f) => ({ file: `src/${f}`, text: fs.readFileSync(dir + f, 'utf8') }));
    const indexText = sources.find((s) => s.file === 'src/index.js').text;
    const names = [...new Set([...indexText.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
    // 口径:凡是**自己会去拼提示词**的区域(体内调用 turnNotes),都算高风险区。
    const regions = names.filter((n) => {
      if (n === 'main') return false; // main 是整台机器,单独看没有意义
      const body = functionBody(indexText, n);
      return body !== null && /turnNotes\s*\(/.test(body);
    });
    assert.ok(regions.length >= 10, `区域数看起来不对：${regions.length}`);
    for (const name of regions) {
      const r = analyzeAsyncSeams({ sources, region: { file: 'src/index.js', name } });
      assert.deepEqual(r.offenders.map((o) => `${o.name}×${o.unhandled}`), [], `${name} 里有没管的 Promise 调用`);
      assert.deepEqual(r.unresolved, [], `${name} 还有没解析到的名字(盲区)：${r.unresolved.join(', ')}`);
    }
  });
  test('异步接缝:拿生产源码当场做红绿对照(表达要求那一栏不许再有第二个漏 await)', () => {
    // ⚠️ **喂全部 src 模块**(2026-10-15 自查):只喂 index.js+style.js 时,从别的模块 import 进来的
    //    助手一个都解析不到 —— 那时"没报错"只是"没看"。喂全 + 别名解析后盲区必须为 0。
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
      .map((f) => ({ file: `src/${f}`, text: fs.readFileSync(dir + f, 'utf8') }));
    const region = { file: 'src/index.js', name: 'turnNotes' };
    const now = analyzeAsyncSeams({ sources, region });
    assert.deepEqual(now.offenders.map((o) => o.name), [],
      `提示词拼装区里出现了没 await 的 Promise 形状调用：${now.offenders.map((o) => o.name).join(', ')}`);
    assert.deepEqual(now.unresolved, [], `还有没解析到的名字(盲区)：${now.unresolved.join(', ')}`);
    assert.deepEqual(now.calls.map((c) => `${c.name}(${c.awaitedCount}/${c.total})`), ['longTermNote(1/1)'],
      '这一区里 Promise 形状的调用只有长期记忆那一条,而且它是 await 的');
    // 反证:把那一行的 await 抹掉,扫描器必须当场报出来 —— 判据不许是"永远绿"的摆设。
    const idx = sources.findIndex((s) => s.file === 'src/index.js');
    const broken = sources[idx].text.replace('const longTerm = await longTermNote(', 'const longTerm = longTermNote(');
    assert.notEqual(broken, sources[idx].text, '反证注入点必须真的存在');
    const red = analyzeAsyncSeams({ sources: sources.map((s, i) => (i === idx ? { ...s, text: broken } : s)), region });
    assert.deepEqual(red.offenders.map((o) => o.name), ['longTermNote']);
  });
}
