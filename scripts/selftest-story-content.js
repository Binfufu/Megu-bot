/**
 * **故事活动内容包**(P4,2026-10-28)回归。
 *
 * 机制(story.js)通用;**内容是角色自己的**。判据钉三件事:
 *   ① 有包的角色拿到的是**自己的**事件表(旧默认角色 = 旧默认事件表,同一份引用,不复制);
 *   ② 没包的角色(fail closed)→ 不开放这类玩法(返回 null,不套用别人的内容);
 *   ③ 装配真的按包走:index 只在有包时抛钩子、并把**包内事件表**交给 openStory。
 */
import fs from 'node:fs';
import path from 'node:path';
import { STORY_CONTENT_PACKS, storyPackFor, storyPackStatus } from '../src/story-content.js';
import { STORY_EVENTS, STORY_TTL_MS, openStory } from '../src/story.js';

const FIXTURE_EVENTS = [
  { id: 'fix_a', setup: '只有这一条(测试用 A)', branches: [{ id: 'x', weight: 1, line: 'A 的结局', effect: { mood: 1 } }] },
  { id: 'fix_b', setup: '只有这一条(测试用 B)', branches: [{ id: 'y', weight: 1, line: 'B 的结局', effect: { mood: -1 } }] },
];

export function registerStoryContentTests({ test, assert: a }) {
  test('内容包查找:旧默认角色有包且就是旧默认事件那张表;没有包的角色一律 null(fail closed)', () => {
    const megumin = storyPackFor('megumin');
    a.ok(megumin, '旧默认角色必须有内容包');
    a.equal(megumin.events, STORY_EVENTS, '包里的表就是 story.js 那张(一份实现,不复制)');
    a.equal(megumin.id, 'megumin');
    // ⚠️ 2026-10-28 主人拍板:机械体角色现在**有**自己的包(原内容约定设定),不再是 null。
    //    这里钉的是"没登记的角色 fail closed",机械体角色的包在 selftest-body-rules 里单独判。
    a.ok(storyPackFor('aris'), '机械体角色必须有包(主人拍板:她的故事事件表按原内容约定)');
    for (const role of ['bogus', '', null, undefined, '  ']) {
      a.equal(storyPackFor(role), null, `${JSON.stringify(role)} 不许拿到内容包`);
    }
    // 冻结:运行期不许偷偷加包(注册 = 改代码 + 判据)。
    a.equal(Object.isFrozen(STORY_CONTENT_PACKS), true);
  });

  test('状态描述:有包说有包(含事件数)，没包说"只报备、不抛钩子"(日志人话)', () => {
    const on = storyPackStatus('megumin');
    a.equal(on.enabled, true);
    a.equal(on.packId, 'megumin');
    a.match(on.reason, /内容包=megumin/);
    a.match(on.reason, new RegExp(`${STORY_EVENTS.length} 个事件`));
    const off = storyPackStatus('bogus');
    a.equal(off.enabled, false);
    a.equal(off.packId, null);
    a.match(off.reason, /只报备/, '日志要写清"不抛钩子",不能静默');
  });

  test('openStory 尊重传入的事件表;不传时行为一字不变(旧调用零改动)', () => {
    // 传自定义表:只可能抽到表内事件(均匀抽,random 决定索引)。
    for (const roll of [0, 0.4, 0.99]) {
      const opened = openStory({ now: 1000, random: () => roll, events: FIXTURE_EVENTS });
      a.ok(FIXTURE_EVENTS.includes(opened.event), '只能抽到传入表里的事件');
      a.equal(opened.openedAt, 1000);
      a.equal(opened.expiresAt, 1000 + STORY_TTL_MS);
    }
    // 不传 = 旧默认事件表(旧行为)。
    const legacy = openStory({ now: 0, random: () => 0.5 });
    a.ok(STORY_EVENTS.includes(legacy.event));
    // 空表/非法表 → 退回旧默认事件表(不崩,也不"没有事件"地抛空)。
    a.ok(STORY_EVENTS.includes(openStory({ random: () => 0.5, events: [] }).event));
    a.ok(STORY_EVENTS.includes(openStory({ random: () => 0.5, events: null }).event));
  });

  test('wiring:index 按包装配(有包才抛钩子、传包内事件表、启动日志说清)', () => {
    const indexSource = fs.readFileSync(path.resolve('src', 'index.js'), 'utf8');
    a.match(indexSource, /import \{ storyPackFor, storyPackStatus \} from '\.\/story-content\.js'/);
    a.match(indexSource, /const storyPack = storyPackFor\(config\.policy\.mood\?\.theme\)/, '按角色 id 取包');
    a.match(indexSource, /\[事件钩子\][^\n]*storyPackStatus\(/, '启动日志要说明有没有包');
    const gate = indexSource.match(/else if \(isStoryActivity\(decision\.activity\) && storyPack\)/);
    a.ok(gate, '没有包的角色不许进"抛钩子"这一支');
    a.match(indexSource, /story = openStory\(\{ now, events: storyPack\.events \}\)/, '抛钩子必须用包内事件表');
    // 配置默认仍是 megumin → 旧默认角色行为不变。
    const configSource = fs.readFileSync(path.resolve('src', 'config.js'), 'utf8');
    a.match(configSource, /mood: \{/);
  });
}
