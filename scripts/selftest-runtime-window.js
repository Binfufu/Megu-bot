import { analyzeRuntimeWindow, parseRuntimeWindowArgs } from './observe-runtime-window.mjs';
export function registerRuntimeWindowTests({ test, assert }) {
  test('运行窗口:最新启动不可借旧就绪，精确时间边界及合并回复不漏', () => {
    const at = Date.parse('2026-10-15T12:00:00.000Z');
    const line = (offset, text) => new Date(at + offset).toISOString() + ' [info] ' + text;
    const text = [line(-1, 'bridge 启动：version=old-outside'), line(0, 'bridge 启动：version=old'), line(1, 'DSH 运行时已就绪：old'), line(2, '机器人已就绪：old'), line(3, '收到单聊消息'), line(4, '已回复(合并 1 条)会话=k'), line(5, 'bridge 启动：version=new'), line(6, '收到群聊消息'), line(7, '已回复会话=k'), line(8, 'DSH 运行时已就绪：new'), line(9, '机器人已就绪：new'), line(10, 'bridge 启动：version=future')].join('\n');
    const pending = analyzeRuntimeWindow(text, { since: at, until: at + 7 });
    assert.ok(pending.startup.line.includes('version=new'));
    assert.equal(pending.launchReady, false);
    assert.equal(pending.ready, null);
    assert.equal(pending.runtime, null);
    assert.equal(pending.naturalInbound, 2);
    assert.equal(pending.replyLogs, 2);
    assert.equal(pending.currentLaunchInbound, 1);
    const ready = analyzeRuntimeWindow(text, { since: at + 5, until: at + 9 });
    assert.equal(ready.launchReady, true);
    assert.ok(ready.ready.line.endsWith('：new'));
    assert.equal(ready.launches, 1);
    const noLaunch = analyzeRuntimeWindow(text, { since: at + 8, until: at + 9 });
    assert.equal(noLaunch.launchReady, false);
    assert.equal(noLaunch.startup, null);
    const sameTime = analyzeRuntimeWindow([line(0, '机器人已就绪：old'), line(0, 'bridge 启动：version=new')].join('\n'), { since: at, until: at });
    assert.equal(sameTime.ready, null);
    assert.throws(() => analyzeRuntimeWindow('', { since: at, until: at - 1 }));
  });
  test('运行窗口CLI:缺界限/倒置/重复/未知参数拒绝，无隐式当前时间', () => {
    assert.throws(() => parseRuntimeWindowArgs([]));
    assert.throws(() => parseRuntimeWindowArgs(['--since', 'bad', '--until', 'bad', '--out', 'x']));
    assert.throws(() => parseRuntimeWindowArgs(['--since', '2026-10-16Z', '--until', '2026-10-15Z', '--out', 'x']));
    assert.throws(() => parseRuntimeWindowArgs(['--since', '2026-10-15Z', '--until', '2026-10-16Z', '--out', 'x', '--foo', 'y']));
    assert.throws(() => parseRuntimeWindowArgs(['--since', '2026-10-15Z', '--since', '2026-10-16Z', '--out', 'x']));
    assert.ok(parseRuntimeWindowArgs(['--since', '2026-10-15T00:00:00Z', '--until', '2026-10-15T00:00:00Z', '--out', 'new-evidence.json']).out.endsWith('new-evidence.json'));
  });
}
