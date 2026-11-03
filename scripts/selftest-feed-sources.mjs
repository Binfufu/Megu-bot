import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FIXED_FEED_SOURCES, parseFeedSource } from '../src/feed-sources.js';

// Representative excerpts of real HTTP samples, 2026-11-02, not invented layouts.
// --live re-fetches only the three approved URLs; no server, disk state or LLM.
const sources = Object.fromEntries(FIXED_FEED_SOURCES.map(s => [s.id, s]));
const model = { id: 'openai/gpt-6.1-terra-pro', name: 'OpenAI: GPT-6.1 Terra Pro', created: 1793038556,
  description: 'GPT-6.1 Terra Pro is the same underlying model as GPT-6.1 Terra, served with reasoning.mode set to pro for higher-quality responses on complex tasks.',
  pricing: { prompt: '0.000001', completion: '0.000005', web_search: '0.01', input_cache_read: '0.00000005', input_cache_write: '0.00000125', overrides: [{ min_prompt_tokens: 272000, prompt: '0.000002', completion: '0.0000075', input_cache_read: '0.0000001', input_cache_write: '0.0000025' }] } };
const deepBody = `<h1>Change Log</h1><hr>
<h2 class="anchor anchorWithStickyNavbar_YAqC" id="date-2026-10-17">Date: 2026-10-17<a href="#date-2026-10-17" class="hash-link">​</a></h2>
<h3 class="anchor anchorWithStickyNavbar_YAqC" id="opening-up-the-in-house-search-api">Opening up the in-house search API<a href="#opening-up-the-in-house-search-api" class="hash-link">​</a></h3>
<p>DeepSeek&#x27;s web and API search capabilities are powered by our in-house DeepSeek search engine, which reliably handles hundreds of millions of search requests from around the world every day.</p>
<h3 class="anchor anchorWithStickyNavbar_YAqC" id="deepseek-v41-flash-1017-update">DeepSeek-V4.1-Flash-1017 Update<a href="#deepseek-v41-flash-1017-update" class="hash-link">​</a></h3>
<p>DeepSeek V4.1 Flash has been upgraded to DeepSeek-V4.1-Flash-1017. The API calling method and pricing remain unchanged — simply use <code>deepseek-flash</code> to access the latest model.</p>
<hr><h2 id="date-2025-12-01">Date: 2025-12-01</h2><h3 id="deepseek-v32-speciale">DeepSeek-V3.2-Speciale</h3>
<p>Same pricing as V3.2, no tool calls, available until Dec 15th, 2025, 15:59 (UTC Time).</p>`;
const wrap = (body = deepBody, navigation = 'Home') => `<html><body><nav>${navigation}</nav><main><article><nav>Breadcrumbs ${navigation}</nav><div class="toc">On this page ${navigation}</div><div class="theme-doc-markdown markdown"><div class="row"><div class="col">${body}</div></div></div><footer>${navigation}</footer></article><aside>TOC ${navigation}</aside></main><script>${navigation}</script><style>${navigation}</style></body></html>`;
const glmBody = `> ## Documentation Index
> Fetch the complete documentation index at: https://docs.bigmodel.cn/llms.txt

# 模型与产品发布记录

## 公告通知

**2026-08-26**

GLM-5.3-Flash 原生多模态模型上线

👀 [**GLM-5.3-Flash**](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md)

* 原生融入视觉能力，使模型能够主动观察界面、渲染与交互反馈并持续迭代改进。
* 极致高效混合架构：总参 320B，激活 18B。

**2026-8-19**

GLM-5.3 新一代旗舰模型上线

💬 [**GLM-5.3**](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)

* 编程能力较 GLM-5.2 提升了 50%。

**2025-12-11**

GLM-TTS-Clone 音色克隆模型上线

* 只需录制约 3 秒清晰语音，即可生成专属音色。

**2025-12-11**

GLM-TTS 语音合成模型上线

* 首帧响应低于 400ms。

This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
`;
const parse = (kind, body) => parseFeedSource(sources[kind], body);
const or = models => parse('openrouter', JSON.stringify({ data: models }));
const fingerprint = entry => {
  const { publishedAt, ...rest } = entry;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
};
let passed = 0;
function test(name, fn) {
  fn(); passed++; console.log(`ok ${passed} - ${name}`);
}
test('exact approved source contract', () => {
  assert.equal(FIXED_FEED_SOURCES.length, 3);
  assert.deepEqual(FIXED_FEED_SOURCES.map(s => s.kind), ['openrouter', 'deepseek', 'glm']);
  assert.ok(FIXED_FEED_SOURCES.every(s => s.frequency === 'high' && s.id && s.name && s.url));
});
test('real OpenRouter model shape, full nested pricing, units and name', () => {
  const [entry] = or([model]);
  assert.equal(entry.key, model.id);
  assert.equal(entry.title, model.name);
  assert.ok(entry.summary.includes(model.name) && entry.summary.includes('USD/token') && entry.summary.includes('OpenRouter API'));
  for (const k of Object.keys(model.pricing)) assert.ok(entry.summary.includes(k));
  assert.deepEqual(entry.observed.pricing.overrides, model.pricing.overrides);
});
test('every pricing field (including unknown/nested) affects core fingerprint', () => {
  const original = fingerprint(or([model])[0]);
  for (const k of Object.keys(model.pricing)) {
    const changed = structuredClone(model);
    if (k === 'overrides') changed.pricing.overrides[0].input_cache_write = '0.123';
    else changed.pricing[k] = '0.123';
    assert.notEqual(fingerprint(or([changed])[0]), original, k);
  }
  const changed = structuredClone(model); changed.pricing.future_tariff = { band: ['0.13', '0.14'] };
  assert.notEqual(fingerprint(or([changed])[0]), original);
  delete changed.pricing.prompt;
  assert.notEqual(fingerprint(or([changed])[0]), original);
});
test('pricing object key order normalized, description bounded, time excluded', () => {
  const reordered = { ...model, pricing: Object.fromEntries(Object.entries(model.pricing).reverse()) };
  assert.equal(fingerprint(or([model])[0]), fingerprint(or([reordered])[0]));
  assert.ok(or([{ ...model, description: 'long '.repeat(5000) }])[0].summary.length <= 2400);
  assert.equal(fingerprint(or([model])[0]), fingerprint(or([{ ...model, created: 1793038557 }])[0]));
});
test('OpenRouter rejects whole snapshot for missing/invalid pricing or identity', () => {
  for (const bad of [{ ...model, pricing: null }, { ...model, pricing: [] }, { ...model, pricing: {} }, { ...model, pricing: { prompt: null } }, { ...model, pricing: { prompt: 'unknown' } }, { ...model, pricing: { prompt: '1', overrides: 'broken' } }, { ...model, pricing: { prompt: '1', overrides: [{ completion: null }] } }, { ...model, name: '' }, { ...model, pricing: { prompt: '1', huge: 'x'.repeat(4000) } }]) assert.throws(() => or([model, bad]));
});
test('real DeepSeek date + release h3 yields separate factual items', () => {
  const items = parse('deepseek', wrap());
  assert.equal(items.length, 3);
  assert.equal(items[0].publishedAt, '2026-10-17');
  assert.ok(items[0].summary.includes("DeepSeek's"));
  assert.ok(items[1].summary.includes('pricing remain unchanged'));
  assert.ok(items[1].url.endsWith('#deepseek-v41-flash-1017-update'));
  assert.notEqual(items[0].key, items[1].key);
});
test('HTML navigation/TOC/footer/script/style changes leave entries identical', () => {
  assert.deepEqual(parse('deepseek', wrap()), parse('deepseek', wrap(deepBody, '<h2>Date: 2099-01-01</h2><h3>Fake update</h3>')));
  assert.deepEqual(parse('deepseek', wrap()), parse('deepseek', wrap(deepBody.replace('<p>DeepSeek&#x27;', '<script>bad</script><style>bad</style><p>DeepSeek&#x27;'))));
});
test('DeepSeek backdated insertion not filtered and existing keys stable', () => {
  const old = parse('deepseek', wrap());
  const items = parse('deepseek', wrap(`${deepBody}<h2>Date: 2024-01-01</h2><h3 id="backdated">Backdated release</h3><p>New facts published late.</p>`));
  assert.equal(items.length, 4); assert.deepEqual(items.slice(0, 3), old);
});
test('DeepSeek bounded body and same model title on distinct dates', () => {
  const items = parse('deepseek', wrap('<h2>Date: 2026-01-01</h2><h3>deepseek-chat</h3><p>' + 'Facts '.repeat(2000) + '</p><h2>Date: 2025-01-01</h2><h3>deepseek-chat</h3><p>Previous facts</p>'));
  assert.notEqual(items[0].key, items[1].key); assert.ok(items[0].summary.length <= 2400);
});
test('DeepSeek refuses empty/incomplete/date-invalid/page shape drift', () => {
  for (const body of ['', '<h2>Date: 2026-01-01</h2>', '<h2>Date: 2026-02-30</h2><h3>Bad</h3><p>Facts</p>', '<h3>No date</h3><p>Facts</p>', '<h2>Date: 2026-01-01</h2><h3>No body</h3>']) assert.throws(() => parse('deepseek', wrap(body)));
  assert.throws(() => parse('deepseek', '<html><h2>Date: 2026-01-01</h2><h3>Wrong scope</h3><p>Facts</p></html>'));
});
test('real GLM strong-date shape, multiple same-date announcements', () => {
  const items = parse('glm', glmBody);
  assert.equal(items.length, 4); assert.equal(items[1].publishedAt, '2026-08-19');
  assert.ok(items[0].summary.includes('320B')); assert.ok(items[3].summary.includes('400ms'));
  assert.notEqual(items[2].key, items[3].key);
  assert.ok(items.every(i => !i.summary.includes('Mintlify') && !i.summary.includes('Documentation Index')));
});
test('GLM late/backdated insertion has stable keys and is returned', () => {
  const old = parse('glm', glmBody);
  const changed = parse('glm', glmBody.replace('This documentation', '**2024-01-01**\n\n补录发布\n\n* 事实：价格降低一半。\n\nThis documentation'));
  assert.equal(changed.length, 5); assert.deepEqual(changed.slice(0, 4), old);
});
test('GLM ATX dates and bounded multiline factual body', () => {
  const [item] = parse('glm', '# 模型与产品发布记录\n\n## 2026-1-2\n\n### 产品发布\n\n' + '事实。'.repeat(2000));
  assert.equal(item.title, '产品发布'); assert.equal(item.publishedAt, '2026-01-02'); assert.ok(item.summary.length <= 2400);
});
test('GLM refuses missing body, invalid date and non-Markdown response', () => {
  for (const value of ['<html>Not markdown</html>', '# 模型与产品发布记录\nNo entries', '# 模型与产品发布记录\n**2026-01-01**\n标题', '# 模型与产品发布记录\n**2026-13-01**\n标题\n事实']) assert.throws(() => parse('glm', value));
});
test('all sources reject absent body/bad format and duplicate keys', () => {
  for (const kind of Object.keys(sources)) for (const value of [null, '', '  ', '{}', 'upstream unavailable']) assert.throws(() => parse(kind, value));
  assert.throws(() => or([model, model]));
  assert.throws(() => parse('deepseek', wrap(deepBody + deepBody)));
  assert.throws(() => parse('glm', glmBody.replace(/^This documentation[\s\S]*$/m, '') + glmBody));
  assert.throws(() => parseFeedSource({ kind: 'unknown', url: 'https://example.com' }, 'body'));
});

if (process.argv.includes('--live')) {
  for (const source of FIXED_FEED_SOURCES) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200);
    const text = await response.text();
    const entries = parseFeedSource(source, text);
    assert.ok(entries.length > 0 && entries.every(e => e.key && e.title && e.summary && e.summary.length <= 2400));
    if (source.kind === 'openrouter') assert.equal(entries.length, JSON.parse(text).data.length);
    console.log(JSON.stringify({ live: source.id, sampledAt: new Date().toISOString(), status: response.status, url: response.url, contentType: response.headers.get('content-type'), bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), entries: entries.length, first: { key: entries[0].key, title: entries[0].title, publishedAt: entries[0].publishedAt } }));
    passed++;
  }
}
console.log(`feed-sources: ${passed} passed / 0 failed`);
