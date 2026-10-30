/** 测试端口助手自己的判据（2026-10-30）：blocked port 必须被识别并换掉，不许静默重试成假绿。 */
import http from 'node:http';
import { isFetchablePort, listenLoopback, pickLoopbackPort } from './test-local-port.mjs';

export function registerTestLocalPortTests({ test, assert }) {
  test('测试端口助手：Fetch 规范 blocked port 判为不可 fetch，普通临时端口判为可 fetch', () => {
    for (const port of [1, 4045, 5060, 6000, 6665, 6667, 10080]) {
      assert.equal(isFetchablePort(port), false, `blocked port ${port} 必须判 false`);
    }
    for (const port of [8080, 15000, 20000, 65535]) {
      assert.equal(isFetchablePort(port), true, `普通端口 ${port} 必须判 true`);
    }
    for (const bad of [0, -1, 65536, 1.5, NaN, 'x']) {
      assert.equal(isFetchablePort(bad), false, `非法端口 ${bad} 必须判 false`);
    }
  });

  test('测试端口助手：监听拿到的端口一定能被 fetch 连上（真起服务真连一次）', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    const port = await listenLoopback(server);
    try {
      assert.equal(isFetchablePort(port), true);
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('测试端口助手：pickLoopbackPort 还回来的端口是空的、可绑可 fetch', async () => {
    const port = await pickLoopbackPort();
    assert.equal(isFetchablePort(port), true);
    const server = http.createServer((req, res) => { res.writeHead(204); res.end(); });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 204);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('测试端口助手：反证 —— 判定逻辑对合成反例真的会咬（不是恒真）', () => {
    // 拿走"排除表"的效果：如果实现退化成恒 true，上面 first case 会红；这里再钉一次方向。
    assert.throws(() => {
      const fake = 6666;
      assert.equal(isFetchablePort(fake), true, '把 blocked port 当可 fetch 必须在这里爆');
    }, /必须在这里爆/);
  });
}
