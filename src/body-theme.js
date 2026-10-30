import { LOCAL_MOOD_BODY_CONTENT } from './local-mood-body-content.js';
/** Local display content is separate from the unchanged runtime policy. */

/** 两个内部值名(和数据库列名一致)。 */
export const VALUE_KEYS = ['satiety', 'health', 'mood', 'stamina', 'mana'];

/** Local display content is separate from the unchanged runtime policy. */
const BODY_VALUE_LIMITS = {"satiety":[10,20,40,70,90,101],"health":[20,40,70,101],"mood":[30,50,70,85,101],"stamina":[15,35,60,85,101],"mana":[10,30,60,90,101]};
const NEUTRAL_BODY_TEXT = {
  "label": "中性身体状态",
  "values": {
    "satiety": {
      "short": "饱食",
      "long": "饱食度",
      "states": [
        "需要及时进食",
        "饥饿",
        "有些饿",
        "适中",
        "吃饱了",
        "有些撑"
      ]
    },
    "health": {
      "short": "健康",
      "long": "健康状态",
      "states": [
        "需要休养",
        "不太舒服",
        "一般",
        "良好"
      ]
    },
    "mood": {
      "short": "心情",
      "long": "心情状态",
      "states": [
        "低落",
        "有些闷",
        "平静",
        "愉快",
        "很开心"
      ]
    },
    "stamina": {
      "short": "体力",
      "long": "体力值",
      "states": [
        "需要休息",
        "疲惫",
        "有些累",
        "尚可",
        "充足"
      ]
    },
    "mana": {
      "short": "精力",
      "long": "精力储备",
      "states": [
        "接近耗尽",
        "偏低",
        "一般",
        "充足",
        "充沛"
      ]
    }
  },
  "action": {
    "verb": "进食",
    "short": "进食",
    "prompt": "补充了食物或饮水",
    "tag": "进食"
  },
  "growth": {
    "knownAs": "认识的人",
    "conceptAs": "学会的概念",
    "personRecorded": "已记住这位联系人",
    "conceptRecorded": "已学会这个概念"
  }
};
function localBodyTheme(id) {
  const text = LOCAL_MOOD_BODY_CONTENT?.body?.[id] ?? NEUTRAL_BODY_TEXT;
  return { id, label: text.label, values: Object.fromEntries(VALUE_KEYS.map((key) => [key, {
    short: text.values[key].short, long: text.values[key].long,
    states: BODY_VALUE_LIMITS[key].map((limit, index) => [limit, text.values[key].states[index]]),
  }])), action: { ...text.action }, growth: { ...text.growth } };
}
export const MEGUMIN_BODY = localBodyTheme('megumin');
export const ARIS_BODY = localBodyTheme('aris');

/** 公开示例：中性身体标签，档位边界沿用既有生物体框架，不引入新数值。 */
export const DEMO_BODY = {
  id: 'demo',
  label: '示例助手(生物体:饱食 / 健康 / 心情 / 体力 / 精力)',
  values: {
    satiety: {
      short: '饱食',
      long: '饱食度',
      states: [
        [10, '需要及时进食'],
        [20, '饥饿'],
        [40, '有些饿'],
        [70, '适中'],
        [90, '吃饱了'],
        [101, '有些撑'],
      ],
    },
    health: {
      short: '健康',
      long: '健康状态',
      states: [
        [20, '需要休养'],
        [40, '不太舒服'],
        [70, '一般'],
        [101, '良好'],
      ],
    },
    mood: {
      short: '心情',
      long: '心情状态',
      states: [
        [30, '低落'],
        [50, '有些闷'],
        [70, '平静'],
        [85, '愉快'],
        [101, '很开心'],
      ],
    },
    stamina: {
      short: '体力',
      long: '体力值',
      states: [
        [15, '需要休息'],
        [35, '疲惫'],
        [60, '有些累'],
        [85, '尚可'],
        [101, '充足'],
      ],
    },
    mana: {
      short: '精力',
      long: '精力储备',
      states: [
        [10, '接近耗尽'],
        [30, '偏低'],
        [60, '一般'],
        [90, '充足'],
        [101, '充沛'],
      ],
    },
  },
  action: { verb: '进食', short: '进食', prompt: '补充了食物或饮水', tag: '进食' },
  growth: { knownAs: '认识的人', conceptAs: '学会的概念', personRecorded: '已记住这位联系人', conceptRecorded: '已学会这个概念' },
};

export const BODY_THEMES = { megumin: MEGUMIN_BODY, aris: ARIS_BODY, demo: DEMO_BODY };

/** 主题名清单,给配置校验用(拼错必须报错,见 D20)。 */
export const BODY_THEME_NAMES = Object.keys(BODY_THEMES);

/** Local display content is separate from the unchanged runtime policy. */
export function getBodyTheme(name) {
  if (name === undefined || name === null || String(name).trim() === '') return MEGUMIN_BODY;
  const theme = BODY_THEMES[name];
  if (!theme) {
    throw new Error(`未知身体主题:${JSON.stringify(name)}(只认 ${BODY_THEME_NAMES.join(' / ')})`);
  }
  return theme;
}

/** 某个值的档位描述。表里最后一个区间是"以上"。 */
export function describeValue(key, value, theme = MEGUMIN_BODY) {
  const spec = theme.values[key];
  if (!spec) return '';
  const number = Number(value) || 0;
  for (const [limit, text] of spec.states) {
    if (number < limit) return text;
  }
  return spec.states[spec.states.length - 1][1];
}

/** 短名(`饱食` / `电量`)—— 给人看的报表行里用。 */
export function labelFor(key, theme = MEGUMIN_BODY) {
  return theme.values[key]?.short ?? key;
}

/** 长名(`饱食度` / `电量`)—— 注入提示词那行用。 */
export function longLabelFor(key, theme = MEGUMIN_BODY) {
  return theme.values[key]?.long ?? key;
}
