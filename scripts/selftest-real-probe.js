import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseProbeColor, probeImageCount, withoutProbeAnswers, withoutProbeImages } from './image-probe-check.mjs';

export function registerRealProbeTests({ test, assert }) {
  test('真实图片探针:橙色/非空/格式错不可当红；去答案去图保留问题，原输入不改', () => {
    assert.equal(parseProbeColor('{"color":"红色"}'), '红色');
    assert.notEqual(parseProbeColor('{"color":"橙色"}'), '红色');
    assert.notEqual(parseProbeColor('{"color":"橙红色"}'), '红色');
    for (const text of ['红色', '{"color":"红色","extra":1}', 'null', '[]', '```json\n{"color":"红色"}\n```']) assert.equal(parseProbeColor(text), undefined);
    assert.equal(parseProbeColor('{"color":null}'), null);
    const messages = [{ role: 'system', content: 'persona' }, { role: 'user', content: [{ type: 'text', text: 'color?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }] }, { role: 'assistant', content: '{"color":"红色"}' }, { role: 'user', content: 'color?' }];
    const original = structuredClone(messages);
    const answerFree = withoutProbeAnswers(messages);
    assert.equal(answerFree.some(m => m.role === 'assistant'), false);
    assert.equal(probeImageCount(answerFree), 1);
    const noImage = withoutProbeImages(answerFree);
    assert.equal(probeImageCount(noImage), 0);
    assert.deepEqual(noImage[1].content, [{ type: 'text', text: 'color?' }]);
    assert.deepEqual(messages, original);
  });
  test('真实图片探针:缺显式模型拒绝，调用不自动重试且正反对照记逐发账', () => {
    const file = new URL('./verify-llm.js', import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /model, attempts: 1/);
    assert.match(source, /parseProbeColor\(first.text\), '红色'/);
    assert.match(source, /parseProbeColor\(second.text\), '红色'/);
    assert.match(source, /externalOptions\('without-image-and-answers'\)/);
    assert.match(source, /externalOptions\('restored-image-without-answers'\)/);
    const child = spawnSync(process.execPath, [fileURLToPath(file)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /--model requires an explicit API model id/);
  });
  test('真实语义探针:缺模型值在网络前拒绝，显式模型和外部对照逐发账不丢', () => {
    const file = new URL('./probe-real-compaction.mjs', import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /model: selectedModel, attempts: 1/);
    assert.match(source, /externalOptions\('without-summary'\)/);
    assert.match(source, /externalOptions\('restored-summary'\)/);
    assert.match(source, /maxAttemptsPerCall: 1, externalAttempts/);
    const child = spawnSync(process.execPath, [fileURLToPath(file), '--model'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /--model requires an explicit API model id/);
  });
}
