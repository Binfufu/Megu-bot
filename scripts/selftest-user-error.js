import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describeUserError } from '../src/user-error.js';
import { describeError } from '../src/log.js';

const source = () => fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const dirty = '<!DOCTYPE html><html><body>https://private.example/path?token=sk-secret Authorization: Bearer secret\n at request (private.js:42)</body></html>';

// 全部 describeError 消费点应留在日志，另两处是仅供内部诊断/分类的受控赋值。
// 扫描不依赖已知发送次数，未来增加新的用户错误插值也会失败。
function unsafeErrorLines(text) {
  return text.split('\n').filter((line) => /\bdescribeError\s*\(/.test(line)
    && !/\blog\.(?:warn|error|info|debug)\s*\(/.test(line)
    && !/^\s*lastError = describeError\(err\);\s*$/.test(line)
    && !/^\s*const message = describeError\(err\);\s*$/.test(line));
}

export function registerUserErrorTests({ test, assert }) {
  test('用户错误①:HTTP 413/429/5xx、超时和默认分支返回固定中文', () => {
    const cases = [
      [{ status: 413, message: dirty }, '这次内容太长了，请缩短内容或分开发送。'],
      [{ statusCode: '429', message: dirty }, '请求有点多，请稍后再试。'],
      [{ code: 503, message: dirty }, '服务暂时出了点问题，请稍后再试。'],
      [new Error('LLM HTTP 502: ' + dirty), '服务暂时出了点问题，请稍后再试。'],
      [new Error('上传失败: HTTP 413 ' + dirty), '这次内容太长了，请缩短内容或分开发送。'],
      [new Error('HTTP 429 ' + dirty), '请求有点多，请稍后再试。'],
      [new DOMException(dirty, 'TimeoutError'), '这次等待超时了，请稍后再试。'],
      [new DOMException(dirty, 'AbortError'), '这次等待超时了，请稍后再试。'],
      [new Error('LLM 请求超时或被取消 ' + dirty), '这次等待超时了，请稍后再试。'],
      [new Error('fetch failed', { cause: Object.assign(new Error(dirty), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }), '这次等待超时了，请稍后再试。'],
      [new Error('wrapper', { cause: Object.assign(new Error(dirty), { status: 413 }) }), '这次内容太长了，请缩短内容或分开发送。'],
      [new Error(dirty), '这次没能处理成功，请稍后再试。'],
      [{ status: 401, message: dirty }, '这次没能处理成功，请稍后再试。'],
      [dirty, '这次没能处理成功，请稍后再试。'],
      [null, '这次没能处理成功，请稍后再试。'],
      [undefined, '这次没能处理成功，请稍后再试。'],
    ];
    for (const [error, expected] of cases) assert.equal(describeUserError(error), expected);
    for (let status = 500; status <= 599; status += 1) {
      assert.equal(describeUserError({ status, message: dirty }), '服务暂时出了点问题，请稍后再试。');
    }
    const cyclic = new Error('wrapper');
    cyclic.cause = cyclic;
    assert.equal(describeUserError(cyclic), '这次没能处理成功，请稍后再试。');
  });

  test('用户错误②:内部 describeError 保留原因链和完整响应，外部从不透传', () => {
    const err = new Error('HTTP 502 ' + dirty, { cause: Object.assign(new Error('private cause'), { code: 'INTERNAL' }) });
    const before = describeError(err);
    assert.ok(before.includes(dirty));
    assert.ok(before.includes('private cause (INTERNAL)'));
    assert.equal(describeUserError(err), '服务暂时出了点问题，请稍后再试。');
    assert.equal(describeError(err), before, '映射不能改写原异常，日志仍要完整');
  });

  test('用户错误③:index 所有用户错误模板真求值均不含 HTML、凭证、地址或堆栈', async () => {
    const text = source();
    const templates = [...text.matchAll(/`([^`\n]*\$\{describeUserError\(err\)\}[^`\n]*)`/g)].map((match) => match[0]);
    assert.ok(templates.length >= 8, '包括主回复、连发和各个间接回执');
    const sent = [];
    for (const template of templates) {
      // 对真实源码的模板求值，经同一个 sendChunked 参数口收集；避免启动线上 main。
      const run = new Function('err', 'describeUserError', 'item', 'sendChunked', 'return sendChunked({}, ' + template + ');');
      await run(new Error('HTTP 502 ' + dirty), describeUserError, { groupId: 'group-123' }, async (_message, body) => sent.push(body));
    }
    for (const body of sent) {
      assert.ok(body.includes('服务暂时出了点问题，请稍后再试。'));
      assert.ok(!/html|https?:|token|secret|Bearer|private\.js|\bat request/i.test(body), body);
    }
    assert.match(text, /sendChunked\(message, `（处理失败：\$\{describeUserError\(err\)\}）`\)/);
    assert.match(text, /sendChunked\(merged, `（处理失败：\$\{describeUserError\(err\)\}）`\)/);
  });

  test('用户错误④:播报权限说明保留业务操作，但不得回显原始平台响应', () => {
    const match = source().match(/  function describeAnnounceError\(err\) \{[\s\S]*?\n  \}/);
    assert.ok(match, '必须找到真实播报错误格式化函数');
    const format = new Function('describeError', 'describeUserError', match[0] + '; return describeAnnounceError;')(describeError, describeUserError);
    const permission = format(new Error('40034105 主动消息失败 ' + dirty));
    assert.ok(permission.includes('在群里 @ 她 发 /更新'));
    assert.ok(!permission.includes('40034105'));
    assert.ok(!permission.includes(dirty));
    assert.equal(format(new Error('HTTP 429 ' + dirty)), '请求有点多，请稍后再试。');
  });

  test('用户错误⑤:接线扫描禁止原始错误回流，且对故意引入的泄漏真报红', () => {
    const text = source();
    assert.deepEqual(unsafeErrorLines(text), []);
    for (const leak of [
      'await sendChunked(message, describeError(err));',
      'lines.push(`失败：${describeError(err)}`);',
      'await reply(`失败：${describeError(err)}`);',
      'return describeError(err);',
    ]) assert.equal(unsafeErrorLines(text + '\n' + leak).length, 1, '扫描必须抓到模拟回归:' + leak);
    assert.match(text, /import \{ describeUserError \} from '\.\/user-error\.js'/);
    assert.match(text, /log\.warn\(`养成明细读取失败: \$\{describeError\(err\)\}`\)/);
  });
}

// 可独立运行；总测试入口由 lead 注册同一个函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: assert } = await import('node:assert/strict');
  const { test } = await import('node:test');
  registerUserErrorTests({ test, assert });
}
