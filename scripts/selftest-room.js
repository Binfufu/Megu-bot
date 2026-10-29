// D229:网页群聊已退役；QQ 群与梦境不属于此次删除范围。
import fs from 'node:fs';
import { PANEL_ROUTES, PANEL_WRITE_ROUTES, ZONE_NAV, renderPanelPage } from '../src/panel.js';

export function registerRoomTests({ test, assert }) {
  test('网页群聊退役(D229):没有模块、导航、输入框或读写路由', () => {
    assert.equal(fs.existsSync(new URL('../src/room.js', import.meta.url)), false);
    assert.equal(ZONE_NAV.some(row => row.id === 'group'), false);
    const html = renderPanelPage({});
    for (const id of ['zone-group', 'group-list', 'group-detail', 'room-text', 'room-send']) {
      assert.equal(html.includes('id="' + id + '"'), false, id);
    }
    for (const route of ['GET /api/room', 'POST /api/room']) {
      assert.equal(PANEL_ROUTES[route], undefined);
      assert.equal(PANEL_WRITE_ROUTES.includes(route), false);
    }
    assert.ok(html.includes('id="dm-detail"'));
    assert.ok(html.includes('id="zone-dream"'));
  });
}
